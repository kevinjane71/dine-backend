/**
 * lanDiscovery.js — zero-config LAN presence for the on-prem local server.
 *
 * So restaurant terminals NEVER have to type an IP address, the local server
 * announces itself on the LAN two ways (both over multicast DNS / Bonjour — the
 * same tech AirPrint and Chromecast use, no router config, no internet):
 *
 *   1. A STABLE HOSTNAME  →  `dineopen-server.local`
 *      Every terminal can just use `http://dineopen-server.local:3003` forever.
 *      Resolves natively on iOS, macOS and Windows even when the server's IP
 *      changes (new Wi-Fi, reboot, DHCP lease). This is the "fixed URL".
 *
 *   2. A DISCOVERABLE SERVICE  →  `_dineopen._tcp`
 *      Apps that browse for it (e.g. the dine-app via react-native-zeroconf,
 *      reliable on Android where `.local` name resolution is spotty) find the
 *      server automatically and read its current IP + port from the record.
 *
 * Fully additive + LOCAL-SERVER-ONLY: this is started only when the process is the
 * on-prem server (LOCAL_SERVER_MODE=true). On cloud (Vercel / Cloud Run) it is never
 * called, so nothing is advertised. If bonjour isn't installed or mDNS fails, it is a
 * silent no-op and the server runs exactly as before (terminals can still use the IP).
 */

// A stable, human-free address the terminals can hardcode. `.local` is resolved by
// the OS mDNS resolver on the LAN — no DNS server, no router setup.
const os = require('os');
const STABLE_HOST = 'dineopen-server.local';
const SERVICE_TYPE = 'dineopen'; // advertised as _dineopen._tcp

let bonjour = null;
let service = null;
let ipWatchTimer = null;
let lastIPs = '';

// Sorted, comma-joined list of this machine's non-internal IPv4 addresses.
function currentLanIPs() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips.sort().join(',');
}

function publish(port, opts) {
  const { Bonjour } = require('bonjour-service');
  bonjour = new Bonjour();
  service = bonjour.publish({
    name: opts.name || 'DineOpen Server',
    type: SERVICE_TYPE,
    protocol: 'tcp',
    port: Number(port) || 3003,
    // Announce A records for this fixed hostname → `dineopen-server.local` resolves
    // to whatever IP this machine currently has. This is the terminals' fixed URL.
    host: STABLE_HOST,
    txt: {
      name: opts.name || 'DineOpen Server',
      restaurantId: opts.restaurantId || '',
      version: opts.version || '',
      path: '/api/health',
    },
  });
  service.on && service.on('error', (e) => console.warn('📡 mDNS service error:', e && e.message));
}

function unpublish() {
  try { if (service && service.stop) service.stop(); } catch (_) {}
  try { if (bonjour && bonjour.destroy) bonjour.destroy(); } catch (_) {}
  service = null;
  bonjour = null;
}

/**
 * Start announcing this server on the LAN.
 * @param {number} port  the port the backend listens on (e.g. 3003)
 * @param {object} [opts] { restaurantId, version, name }
 * @returns {boolean} true if advertising started
 */
function startDiscovery(port, opts = {}) {
  if (service) return true; // already advertising
  try {
    publish(port, opts);
    lastIPs = currentLanIPs();
    console.log(`📡 LAN discovery on — terminals can use http://${STABLE_HOST}:${port} (also browsable as _${SERVICE_TYPE}._tcp)`);

    // Re-advertise when the machine's IP changes (new Wi-Fi / DHCP lease / reboot),
    // so `dineopen-server.local` always resolves to the CURRENT IP — without this,
    // a single IP change leaves the hostname pointing at a dead address.
    if (ipWatchTimer) clearInterval(ipWatchTimer);
    ipWatchTimer = setInterval(() => {
      const now = currentLanIPs();
      if (now !== lastIPs) {
        lastIPs = now;
        console.log(`📡 LAN IP changed → re-advertising mDNS (now ${now || 'none'})`);
        unpublish();
        try { publish(port, opts); } catch (e) { console.warn('📡 re-advertise failed:', e && e.message); }
      }
    }, 15000);
    if (ipWatchTimer.unref) ipWatchTimer.unref();
    return true;
  } catch (err) {
    // Non-fatal: the server still works via its IP address.
    console.warn('📡 LAN discovery skipped:', err && err.message);
    bonjour = null;
    service = null;
    return false;
  }
}

/** Stop advertising (best-effort; called on shutdown). */
function stopDiscovery() {
  if (ipWatchTimer) { clearInterval(ipWatchTimer); ipWatchTimer = null; }
  unpublish();
}

module.exports = { startDiscovery, stopDiscovery, STABLE_HOST, SERVICE_TYPE };
