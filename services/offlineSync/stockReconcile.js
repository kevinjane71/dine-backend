/**
 * Stock reconciliation for the unified offline/online POS.
 *
 * You cannot real-time-lock stock across offline devices (no distributed POS can — Toast
 * doesn't either). So:
 *   - Terminals deduct optimistically in their local store.
 *   - On the Hub, deductions apply in event order to the authoritative stock.
 *   - If it would go negative (two offline devices sold the last unit), we ACCEPT the
 *     completed sale (never reverse a real sale) and FLAG an oversell for the manager.
 *
 * This service owns the reconcile decision + oversell log. The actual stock column update
 * stays in the existing inventory code; callers pass the current stock and get the new
 * value + oversold flag back. ADDITIVE, isolated. Uses stock_oversell_log.
 */
const { query } = require('../../repos/pgClient');

/**
 * Reconcile one deduction. Pure decision + oversell logging (does NOT itself write stock).
 * @returns { newStock, oversold, deducted }
 */
async function reconcileDeduction({ restaurantId, itemId, orderId = null, deviceId = null, currentStock, qty }) {
  const cur = Number(currentStock);
  const q = Number(qty);
  if (!restaurantId || !itemId || !Number.isFinite(cur) || !Number.isFinite(q)) {
    throw new Error('restaurantId, itemId, currentStock, qty required');
  }
  const newStock = cur - q;
  const oversold = newStock < 0;
  if (oversold) {
    // Accept the sale; flag it. Never block or reverse.
    await query(
      `INSERT INTO stock_oversell_log (restaurant_id, item_id, order_id, device_id, qty, resulting_stock)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [restaurantId, itemId, orderId, deviceId, q, newStock]
    );
  }
  return { newStock, oversold, deducted: q };
}

/**
 * Sweep for silently-negative stock and FLAG it (Phase 4.1). After a sync cycle, two writers (this
 * terminal + the web, or a 2nd terminal) can have each sold into the same units so the reconciled
 * current_stock goes below zero. We never reverse the sale — we surface it: log ONE open oversell per
 * item that is currently negative and does not already have an unresolved entry. Idempotent (the NOT
 * EXISTS guard) so calling it every cycle won't spam duplicates. Additive, isolated — does not touch
 * stock values. Runs on whatever DB pgClient points at (local PG on the terminal, cloud PG on the hub).
 * @returns { flagged } number of new oversell rows written.
 */
async function flagNegativeStock(restaurantId) {
  if (!restaurantId) return { flagged: 0 };
  const r = await query(
    `INSERT INTO stock_oversell_log (restaurant_id, item_id, order_id, device_id, qty, resulting_stock)
       SELECT i.restaurant_id, i.id, NULL, NULL, (-i.current_stock), i.current_stock
         FROM inventory i
        WHERE i.restaurant_id = $1 AND i.current_stock < 0
          AND NOT EXISTS (
            SELECT 1 FROM stock_oversell_log o
             WHERE o.restaurant_id = i.restaurant_id AND o.item_id = i.id AND o.resolved = false)
      RETURNING id`,
    [restaurantId]
  );
  return { flagged: r.rowCount || 0 };
}

async function listOpenOversells(restaurantId) {
  const r = await query(
    `SELECT * FROM stock_oversell_log WHERE restaurant_id = $1 AND resolved = false ORDER BY created_at DESC`,
    [restaurantId]
  );
  return r.rows;
}

async function resolveOversell(id) {
  await query('UPDATE stock_oversell_log SET resolved = true WHERE id = $1', [id]);
}

module.exports = { reconcileDeduction, flagNegativeStock, listOpenOversells, resolveOversell };
