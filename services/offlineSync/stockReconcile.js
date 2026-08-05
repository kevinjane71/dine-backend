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

module.exports = { reconcileDeduction, listOpenOversells, resolveOversell };
