/**
 * Sync engine for the unified offline/online POS.
 *
 * Two sides:
 *   RECEIVER (Hub or Cloud): applyPush() ingests a batch idempotently and returns
 *     acks + high-water mark; pullSince() serves events after a cursor (down direction).
 *   SENDER (Terminal or Hub): drain() reads pending sync_outbox rows, ships them via an
 *     INJECTED transport, and marks ONLY the acked ones synced (partial-failure safe).
 *
 * Transport is injected (a `send(events)` fn) so the core logic is unit-testable without
 * a running peer. Everything is idempotent (dedup by event_id) and cursor-based (resumable).
 * ADDITIVE — no existing code depends on this.
 */
const { query } = require('../../repos/pgClient');
const { ingestEvents } = require('./orderEvents');

// ── RECEIVER (Hub / Cloud) ────────────────────────────────────────────────────

/** Apply a pushed batch idempotently. Returns acked event_ids + how many new + hwm. */
async function applyPush(events = []) {
  const { inserted } = await ingestEvents(events); // idempotent (ON CONFLICT DO NOTHING)
  // Every well-formed event is "acked" — applying twice is a no-op, so the sender can
  // safely mark them synced even if some were already present.
  const acked = events.map(e => e && e.event_id).filter(Boolean);
  const hwm = await query('SELECT COALESCE(max(hub_seq),0)::bigint AS hwm FROM order_events');
  return { acked, inserted, hwm: String(hwm.rows[0].hwm) };
}

/** Serve events with hub_seq > since (down direction). Returns events + next cursor. */
async function pullSince(restaurantId, since = 0, limit = 200) {
  const lim = Math.min(Math.max(parseInt(limit) || 200, 1), 500);
  const r = await query(
    `SELECT event_id, restaurant_id, order_id, device_id, device_seq, type, payload, hub_seq
       FROM order_events
      WHERE restaurant_id = $1 AND hub_seq > $2
      ORDER BY hub_seq ASC
      LIMIT $3`,
    [restaurantId, since, lim]
  );
  const events = r.rows.map(row => ({
    event_id: row.event_id, restaurant_id: row.restaurant_id, order_id: row.order_id,
    device_id: row.device_id, device_seq: row.device_seq, type: row.type, payload: row.payload,
  }));
  const cursor = r.rows.length ? String(r.rows[r.rows.length - 1].hub_seq) : String(since);
  return { events, cursor };
}

// ── SENDER (Terminal / Hub) ───────────────────────────────────────────────────

async function getPendingOutbox(target, limit = 200) {
  const r = await query(
    `SELECT id, event_id, payload FROM sync_outbox
      WHERE target = $1 AND synced_at IS NULL ORDER BY id ASC LIMIT $2`,
    [target, limit]
  );
  return r.rows;
}

async function markSynced(eventIds = []) {
  if (!eventIds.length) return 0;
  const r = await query(
    'UPDATE sync_outbox SET synced_at = now() WHERE event_id = ANY($1) AND synced_at IS NULL',
    [eventIds]
  );
  return r.rowCount;
}

async function markAttempt(ids = [], error = '') {
  if (!ids.length) return;
  await query(
    'UPDATE sync_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1)',
    [ids, String(error).slice(0, 300)]
  );
}

/**
 * Drain pending outbox for `target` in batches via injected `send(events)`.
 * `send` must return { acked: [event_id, ...] }. Only acked rows are marked synced;
 * on transport error we record the attempt and stop (retry next cycle). Idempotent.
 */
async function drain({ target = 'hub', send, batchSize = 200, maxBatches = 100 }) {
  if (typeof send !== 'function') throw new Error('send(events) transport required');
  let sent = 0, batches = 0;
  for (;;) {
    if (batches++ >= maxBatches) break; // safety cap
    const rows = await getPendingOutbox(target, batchSize);
    if (!rows.length) break;
    const events = rows.map(r => r.payload);
    let acked;
    try {
      const resp = await send(events);
      acked = (resp && Array.isArray(resp.acked)) ? resp.acked : [];
    } catch (e) {
      await markAttempt(rows.map(r => r.id), e.message);
      throw e; // stop; caller retries on next tick
    }
    sent += await markSynced(acked);
    if (rows.length < batchSize) break; // fully drained
  }
  return { sent };
}

// ── Cursors (down direction) ──────────────────────────────────────────────────

async function getCursor(restaurantId, peer, stream) {
  const r = await query(
    'SELECT cursor FROM sync_cursors WHERE restaurant_id = $1 AND peer = $2 AND stream = $3',
    [restaurantId, peer, stream]
  );
  return r.rows.length ? String(r.rows[0].cursor) : '0';
}

async function setCursor(restaurantId, peer, stream, cursor) {
  await query(
    `INSERT INTO sync_cursors (restaurant_id, peer, stream, cursor, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (restaurant_id, peer, stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [restaurantId, peer, stream, cursor]
  );
}

module.exports = {
  applyPush, pullSince,
  getPendingOutbox, markSynced, markAttempt, drain,
  getCursor, setCursor,
};
