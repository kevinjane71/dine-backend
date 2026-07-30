/**
 * DineOpen Server — a self-contained desktop app that runs the REAL dine-backend +
 * an embedded PostgreSQL, so a restaurant can install ONE app (no Node, no Postgres,
 * no command line) and every terminal on the LAN connects to it for offline use.
 *
 * Electron bundles its own Node runtime, so `fork()` here executes the backend with
 * Electron-as-Node. The embedded Postgres binary is bundled via electron-builder
 * extraResources (the whole backend, incl. node_modules/@embedded-postgres/<os>).
 *
 * Build installers (on the target OS):
 *   cd desktop-server && npm install && npm run dist:win   # → DineOpen Server Setup.exe
 *                                        npm run dist:mac   # → DineOpen Server.dmg
 */
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

// Auto-updater (electron-updater). Guarded so the app still runs if the dep or a
// release feed isn't configured — the update button then reports "not configured".
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { autoUpdater = null; }

let win = null;
let pgInstance = null;
let backendProc = null;
let isInstalling = false;
let manualUpdateCheck = false; // true only while an admin-initiated check is in flight
const logs = [];

function backendDir() {
  // Packaged: resources/backend ; Dev: the repo root (one level up).
  return app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(__dirname, '..');
}

function pushLog(line) {
  const s = String(line).replace(/\s+$/, '');
  if (!s) return;
  logs.push(s);
  if (logs.length > 500) logs.shift();
  if (win && !win.isDestroyed()) win.webContents.send('log', s);
}

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function loadEmbeddedPostgres() {
  // embedded-postgres is ESM-only ("type":"module"). Electron's Node can't require() ESM,
  // so load it via dynamic import() from its absolute entry (file:// URL for Windows too).
  const { pathToFileURL } = require('url');
  const entry = path.join(backendDir(), 'node_modules', 'embedded-postgres', 'dist', 'index.js');
  const M = await import(pathToFileURL(entry).href);
  return M.default || M;
}

// Keep only the newest N database backups (each is a full pgdata copy).
function pruneBackups(keep = 2) {
  try {
    const base = app.getPath('userData');
    const backups = fs.readdirSync(base)
      .filter((d) => d.startsWith('pgdata-backup-'))
      .map((d) => ({ d, t: fs.statSync(path.join(base, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of backups.slice(keep)) {
      try { fs.rmSync(path.join(base, old.d), { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

// Before applying a new version's migrations, snapshot the database if the app was
// just upgraded. Postgres is NOT started yet here, so a plain recursive copy of the
// data dir is a safe cold backup — a bad migration is always recoverable.
function backupIfUpgraded() {
  const base = app.getPath('userData');
  const dataDir = path.join(base, 'pgdata');
  const verFile = path.join(base, 'app-version.json');
  const cur = app.getVersion();
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(verFile, 'utf8')).version; } catch (_) {}

  if (prev && prev !== cur && fs.existsSync(dataDir)) {
    const dest = path.join(base, `pgdata-backup-${prev}-${Date.now()}`);
    try {
      pushLog(`🗄️  Updating ${prev} → ${cur}. Backing up the database first…`);
      fs.cpSync(dataDir, dest, { recursive: true });
      pruneBackups(2);
      pushLog(`🗄️  Database backup saved (${path.basename(dest)}).`);
    } catch (e) {
      pushLog(`⚠️ Backup failed (continuing): ${e.message}`);
    }
  }
  try { fs.writeFileSync(verFile, JSON.stringify({ version: cur })); } catch (_) {}
}

async function startPostgres() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const dataDir = path.join(app.getPath('userData'), 'pgdata');
  const port = 5433;
  const user = 'dine_app';
  const password = 'dineopen_local';
  const first = !fs.existsSync(dataDir);

  pushLog(`🐘 Starting database (${first ? 'first-time setup' : 'existing data'})…`);
  pgInstance = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port, persistent: true });
  if (first) await pgInstance.initialise();
  await pgInstance.start();
  try { await pgInstance.createDatabase('dine'); } catch (_) {}

  const connString = `postgresql://${user}:${password}@127.0.0.1:${port}/dine`;

  // Load schema on first init if a clone is bundled at backend/scripts/offline-schema.sql.
  if (first) {
    const schemaFile = path.join(backendDir(), 'scripts', 'offline-schema.sql');
    if (fs.existsSync(schemaFile)) {
      try {
        const { Client } = require(path.join(backendDir(), 'node_modules', 'pg'));
        const c = new Client({ connectionString: connString });
        await c.connect();
        // Strip psql meta-commands (\restrict/\unrestrict/\connect) — node-postgres
        // can't parse backslash commands emitted by newer pg_dump.
        const sql = fs.readFileSync(schemaFile, 'utf8').split('\n').filter((l) => !/^\s*\\/.test(l)).join('\n');
        await c.query(sql);
        await c.end();
        pushLog('📐 Database schema loaded.');
      } catch (e) { pushLog(`⚠️ Schema load: ${e.message}`); }
    } else {
      pushLog('ℹ️ No bundled schema — tables will be created lazily / seed while online.');
    }
  }
  pushLog('🐘 Database ready.');
  return connString;
}

function startBackend(databaseUrl) {
  const entry = path.join(backendDir(), 'index.js');

  // Load the operator's optional config from userData/.env.local (JWT_SECRET, SYNC_MODE,
  // CLOUD_DATABASE_URL, real API keys…). Anything set there overrides the placeholders below.
  try {
    const dotenv = require(path.join(backendDir(), 'node_modules', 'dotenv'));
    const cfg = path.join(app.getPath('userData'), '.env.local');
    if (fs.existsSync(cfg)) { dotenv.config({ path: cfg }); pushLog('⚙️  Loaded .env.local'); }
  } catch (_) {}

  const P = (k, v) => (process.env[k] && process.env[k].length ? process.env[k] : v);
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    PORT: '3003',
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    // Marks this as the on-prem local server: enables the LAN socket + the provisioning
    // endpoints (both HARD-DISABLED on cloud deployments that don't set this).
    LOCAL_SERVER_MODE: 'true',
    // Consistent local JWT secret so staff can log in offline (override in .env.local
    // with your production secret to make cloud tokens interchangeable).
    JWT_SECRET: P('JWT_SECRET', 'dineopen-offline-local-secret'),
    // Offline placeholders so eager-init external SDKs (OpenAI, email, Razorpay, Pinecone,
    // Twilio) don't crash the server at startup. These features simply no-op offline;
    // real values from .env.local win.
    OPENAI_API_KEY: P('OPENAI_API_KEY', 'sk-offline-placeholder'),
    GODADY_EMAIL: P('GODADY_EMAIL', 'offline@example.com'),
    GODADY_PA: P('GODADY_PA', 'offline'),
    RAZORPAY_KEY_ID: P('RAZORPAY_KEY_ID', 'rzp_offline'),
    RAZORPAY_KEY_SECRET: P('RAZORPAY_KEY_SECRET', 'offline'),
    PINECONE_API_KEY: P('PINECONE_API_KEY', 'offline'),
    TWILIO_ACCOUNT_SID: P('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000'),
    TWILIO_AUTH_TOKEN: P('TWILIO_AUTH_TOKEN', 'offline'),
  };
  backendProc = fork(entry, [], { cwd: backendDir(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backendProc.stdout.on('data', (d) => pushLog(d));
  backendProc.stderr.on('data', (d) => pushLog(d));
  backendProc.on('exit', (code) => pushLog(`❌ Backend exited (${code}). Restart the app.`));
  pushLog('🚀 Backend started on port 3003.');
}

function createWindow() {
  win = new BrowserWindow({
    width: 640, height: 560, resizable: true,
    title: 'DineOpen Server',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('info', { ips: lanIPs(), port: 3003 });
    logs.forEach((l) => win.webContents.send('log', l));
  });
}

ipcMain.handle('get-info', () => ({ ips: lanIPs(), port: 3003, running: !!backendProc, version: app.getVersion() }));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

// ── Auto-update (admin-triggered) ────────────────────────────────────────────
function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', payload);
}

function initUpdater() {
  if (!autoUpdater) { sendUpdate({ state: 'unsupported' }); return; }
  autoUpdater.autoDownload = false;            // admin decides when to download
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: pushLog, warn: pushLog, error: pushLog, debug: () => {} };
  // Optional override of the release feed for on-prem/self-hosted distribution.
  if (process.env.UPDATE_FEED_URL) {
    try { autoUpdater.setFeedURL({ provider: 'generic', url: process.env.UPDATE_FEED_URL }); } catch (_) {}
  }
  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => { manualUpdateCheck = false; pushLog(`⬆️  Update available: v${i.version}`); sendUpdate({ state: 'available', version: i.version }); });
  autoUpdater.on('update-not-available', () => { manualUpdateCheck = false; sendUpdate({ state: 'none', version: app.getVersion() }); });
  // Offline servers can't reach the feed — that's normal, so only surface the error
  // in the UI when the admin explicitly clicked Check. Always log it either way.
  autoUpdater.on('error', (e) => {
    pushLog(`⚠️ Update check: ${e.message}`);
    if (manualUpdateCheck) sendUpdate({ state: 'error', message: e.message });
    manualUpdateCheck = false;
  });
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { pushLog(`✅ Update v${i.version} downloaded — ready to install.`); sendUpdate({ state: 'downloaded', version: i.version }); });
}

ipcMain.handle('check-update', async () => {
  if (!autoUpdater) return { ok: false, reason: 'Updates are not configured for this build.' };
  manualUpdateCheck = true; // user-initiated → surface errors in the UI
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
});
ipcMain.handle('download-update', async () => {
  if (!autoUpdater) return { ok: false };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { sendUpdate({ state: 'error', message: e.message }); return { ok: false, reason: e.message }; }
});
ipcMain.handle('install-update', async () => {
  if (!autoUpdater) return { ok: false };
  isInstalling = true;
  pushLog('⤴️  Installing update — stopping the server, then relaunching…');
  await shutdown();
  // Relaunch after install so the restaurant is back up without a manual open.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
});

app.whenReady().then(async () => {
  createWindow();
  try {
    backupIfUpgraded();               // snapshot DB if the app was just updated
    const dbUrl = await startPostgres();
    startBackend(dbUrl);              // forked backend runs schema migrations on boot
    initUpdater();
    // Silent check on launch so the admin sees a badge without hunting for it.
    if (autoUpdater) setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 8000);
  } catch (e) {
    pushLog(`❌ Startup failed: ${e.message}`);
  }
});

async function shutdown() {
  try { if (backendProc) backendProc.kill(); } catch (_) {}
  try { if (pgInstance) await pgInstance.stop(); } catch (_) {}
}
app.on('before-quit', (e) => {
  if (isInstalling) return;           // let the updater relaunch the installer
  e.preventDefault();
  shutdown().finally(() => app.exit(0));
});
app.on('window-all-closed', () => { /* keep the server running in the tray/background */ });
