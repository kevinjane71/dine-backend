/**
 * LAN Real-time transport (socket.io) — the offline sibling of firebaseRealtimeService.
 *
 * Firebase RTDB is a CLOUD service: when the restaurant has no internet, none of the
 * live events (new order → kitchen, KOT/bill print triggers, table-status) reach the
 * other terminals. This module runs a socket.io server ON the local backend so that,
 * on a purely-local LAN with 10–20 terminals and one machine acting as the server,
 * every terminal still receives those events instantly.
 *
 * Design:
 *   - One socket.io server attached to the SAME http.Server as Express (no extra port).
 *   - Terminals connect and `join` a room named by restaurantId.
 *   - `firebaseRealtimeService.pushEvent()` calls emit() here in addition to the RTDB
 *     push, so ALL existing notify* calls fan out over the LAN with zero call-site edits.
 *   - Events are non-sensitive (ids + status), mirroring the RTDB `.read:true` model,
 *     so no auth is required to receive them — a terminal only needs to be on the LAN.
 *
 * Fully additive: if socket.io fails to init (or isn't installed), emit() is a no-op and
 * the cloud RTDB path is completely unaffected.
 */

let io = null;
let connectionCount = 0;

// Per-room ring buffer of recent events so a terminal that briefly drops its socket (a Wi-Fi
// blip) can REPLAY what it missed on reconnect — closing the one gap vs cloud RTDB, which
// replays buffered events automatically. Each event carries a monotonic `seq`; on `join` a
// terminal passes the last seq it saw and we resend anything newer. Bounded memory: last
// MAX_BUFFER events per restaurant room.
const roomBuffers = new Map();  // restaurantId -> Array<event with .seq>
let seqCounter = 0;
const MAX_BUFFER = 300;

/**
 * Attach a socket.io server to an existing http.Server. Call once, after app.listen().
 * @param {import('http').Server} httpServer
 * @returns {object|null} the socket.io Server, or null on failure
 */
function initLanRealtime(httpServer) {
  if (io) return io;
  try {
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
      // Any LAN origin (Electron file://, http://<lan-ip>:3002, etc.). Events are non-sensitive.
      cors: { origin: '*', methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
      pingInterval: 25000,
      pingTimeout: 20000,
      // Keep memory flat on a POS server that may run for weeks.
      maxHttpBufferSize: 1e6,
    });

    io.on('connection', (socket) => {
      connectionCount++;
      // A terminal announces which restaurant it belongs to (string or { restaurantId, sinceSeq }).
      socket.on('join', (payload) => {
        const rid = typeof payload === 'string' ? payload : payload && payload.restaurantId;
        if (!rid) return;
        socket.join(String(rid));
        socket.data.restaurantId = String(rid);
        // Reconnect catch-up: replay any events this terminal missed while its socket was down.
        const sinceSeq = (payload && typeof payload === 'object' && Number.isFinite(payload.sinceSeq))
          ? payload.sinceSeq : null;
        if (sinceSeq != null) {
          const buf = roomBuffers.get(String(rid)) || [];
          for (const evt of buf) { if (evt.seq > sinceSeq) socket.emit('event', evt); }
        }
        socket.emit('joined', { restaurantId: String(rid), ts: Date.now(), seq: seqCounter });
      });
      socket.on('leave', (rid) => { if (rid) socket.leave(String(rid)); });
      socket.on('disconnect', () => { connectionCount = Math.max(0, connectionCount - 1); });
    });

    console.log('📶 LAN real-time (socket.io) ready — terminals get live events over the local network');
    return io;
  } catch (err) {
    console.warn('📶 LAN real-time init skipped:', err && err.message);
    io = null;
    return null;
  }
}

/**
 * Fan an event out to every terminal in a restaurant's room. Instant + non-blocking.
 * Mirrors the RTDB payload shape: { category, type, ...data, ts } so the frontend can
 * treat a LAN event identically to an RTDB event.
 */
function emit(restaurantId, category, eventType, data) {
  if (!io || !restaurantId) return;
  try {
    const rid = String(restaurantId);
    const evt = { category, type: eventType, ...data, ts: Date.now(), seq: ++seqCounter };
    // Buffer for reconnect replay (bounded ring per room).
    let buf = roomBuffers.get(rid);
    if (!buf) { buf = []; roomBuffers.set(rid, buf); }
    buf.push(evt);
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    io.to(rid).emit('event', evt);
  } catch (err) {
    // Never let a realtime failure affect the request that triggered it.
    console.warn('📶 LAN emit error:', err && err.message);
  }
}

function isReady() { return !!io; }
function getStats() { return { ready: !!io, connections: connectionCount }; }

module.exports = { initLanRealtime, emit, isReady, getStats };
