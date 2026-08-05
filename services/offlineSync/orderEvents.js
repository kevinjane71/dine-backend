/**
 * Order event log for the unified offline/online POS (event-sourcing).
 * An order's state = the projection of its events. Emitting an event writes to
 * `order_events` (append-only, dedup by event_id) AND queues it in `sync_outbox`
 * for the sync engine — atomically. Idempotent everywhere (safe to replay).
 *
 * ADDITIVE: order endpoints are NOT yet wired to this (that's the dual-write step
 * in Milestone 3). This service is the reusable primitive.
 *
 * Event types: order.created, item.added, item.voided, item.updated,
 *   discount.applied, payment.added, order.settled, order.cancelled, stock.deducted
 */
const crypto = require('crypto');
const { query, getClient } = require('../../repos/pgClient');

function newId() {
  return crypto.randomUUID();
}

/**
 * Emit one event: append to order_events + enqueue in sync_outbox (one transaction).
 * @returns { eventId }
 */
async function emitEvent({ restaurantId, orderId, type, payload = {}, deviceId = null, deviceSeq = null, target = 'hub', eventId = null }) {
  if (!restaurantId || !orderId || !type) throw new Error('restaurantId, orderId, type required');
  const eid = eventId || newId();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO order_events (event_id, restaurant_id, order_id, device_id, device_seq, type, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eid, restaurantId, orderId, deviceId, deviceSeq, type, JSON.stringify(payload)]
    );
    // Only enqueue for sync if it was actually newly inserted (idempotent).
    if (inserted.rows.length) {
      await client.query(
        `INSERT INTO sync_outbox (restaurant_id, device_id, event_id, target, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [restaurantId, deviceId, eid, target,
         JSON.stringify({ event_id: eid, restaurant_id: restaurantId, order_id: orderId, type, payload, device_id: deviceId, device_seq: deviceSeq })]
      );
    }
    await client.query('COMMIT');
    return { eventId: eid, isNew: inserted.rows.length > 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Ingest a batch of events RECEIVED from a peer (Terminal→Hub, or Cloud→Hub).
 * Idempotent by event_id (dedup). Returns how many were newly applied.
 * The Hub's BIGSERIAL hub_seq assigns the canonical order automatically.
 */
async function ingestEvents(events = []) {
  if (!events.length) return { inserted: 0 };
  const client = await getClient();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const e of events) {
      if (!e || !e.event_id || !e.order_id || !e.type || !e.restaurant_id) continue;
      const r = await client.query(
        `INSERT INTO order_events (event_id, restaurant_id, order_id, device_id, device_seq, type, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [e.event_id, e.restaurant_id, e.order_id, e.device_id || null, e.device_seq || null, e.type, JSON.stringify(e.payload || {})]
      );
      if (r.rows.length) inserted++;
    }
    await client.query('COMMIT');
    return { inserted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Project an order = replay its events in hub_seq order into a state object.
 * Pure function of the event log → deterministic, conflict-free. Used to build/
 * refresh the materialized order (Milestone 3 wires this to the orders table).
 */
async function projectOrder(restaurantId, orderId) {
  const r = await query(
    `SELECT type, payload, device_id, hub_seq, created_at
       FROM order_events WHERE restaurant_id = $1 AND order_id = $2 ORDER BY hub_seq ASC`,
    [restaurantId, orderId]
  );
  const state = { orderId, restaurantId, items: [], discounts: [], payments: [], status: 'open', totals: {} };
  for (const ev of r.rows) {
    const p = ev.payload || {};
    switch (ev.type) {
      case 'order.created':   Object.assign(state, p.order || {}, { status: 'open' }); break;
      case 'item.added':      state.items.push(p.item || p); break;
      case 'item.voided':     state.items = state.items.filter(i => i.id !== (p.itemId || p.id)); break;
      case 'item.updated':    state.items = state.items.map(i => i.id === (p.itemId || p.id) ? { ...i, ...p.changes } : i); break;
      case 'discount.applied': state.discounts.push(p); break;
      case 'payment.added':   state.payments.push(p); break;
      case 'order.settled':   state.status = 'completed'; if (p.totals) state.totals = p.totals; break;
      case 'order.cancelled': state.status = 'cancelled'; break;
      default: break; // unknown/newer event types ignored (forward-compat)
    }
  }
  return { state, eventCount: r.rows.length };
}

module.exports = { newId, emitEvent, ingestEvents, projectOrder };
