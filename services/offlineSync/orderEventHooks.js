/**
 * Dual-write hook — lets order endpoints ALSO record events for the offline sync layer,
 * WITHOUT any risk to the existing order flow.
 *
 * Safety contract (why this can be dropped into money-path code safely):
 *   1. FLAG-GATED: does nothing unless OFFLINE_SYNC_EVENTS==='true'. Default OFF → the
 *      function returns immediately, zero DB work, zero latency, zero behavior change.
 *   2. FIRE-AND-FORGET + GUARDED: even when ON, it never awaits in the caller and never
 *      throws — a sync-table hiccup can NOT affect order creation/settlement.
 *
 * So the existing order path is byte-for-byte unchanged with the flag off, and cannot be
 * broken by this hook with the flag on. Turn the flag on only where the offline app runs.
 */
const orderEvents = require('./orderEvents');

function offlineEventsEnabled() {
  return process.env.OFFLINE_SYNC_EVENTS === 'true';
}

function emitOrderEventSafe(restaurantId, orderId, type, payload) {
  if (!offlineEventsEnabled()) return;              // default OFF → instant no-op
  if (!restaurantId || !orderId || !type) return;
  // Fire-and-forget; fully guarded — never blocks or throws into the order flow.
  Promise.resolve()
    .then(() => orderEvents.emitEvent({ restaurantId, orderId, type, payload: payload || {} }))
    .catch((err) => { try { console.warn('offline event emit failed (non-blocking):', err.message); } catch (_) {} });
}

module.exports = { emitOrderEventSafe, offlineEventsEnabled };
