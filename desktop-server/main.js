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
const { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { fork } = require('child_process');

const PG_PORT = 5433;
const PG_USER = 'dine_app';
const PG_PASSWORD = 'dineopen_local';

// ── Stable data location ─────────────────────────────────────────────────────
// The database lives OUTSIDE the app so uninstalling/deleting the app never wipes
// the restaurant's data. Default: ~/DineOpenServer (survives uninstall & reinstall).
// Override with DINEOPEN_DATA_DIR (e.g. an external/second drive).
function dataRoot() {
  const custom = (process.env.DINEOPEN_DATA_DIR || '').trim();
  const root = custom || path.join(os.homedir(), 'DineOpenServer');
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return root;
}
function autoBackupDir() { const d = path.join(dataRoot(), 'backups'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; }
function configFile() { return path.join(dataRoot(), 'server-config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } }
function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  try { fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2)); } catch (_) {}
  return cfg;
}

// Resolve the pgdata dir ONCE, migrating an old in-app location to the safe one.
let RESOLVED_PGDATA = null;
function pgDataDir() {
  if (RESOLVED_PGDATA) return RESOLVED_PGDATA;
  const newDir = path.join(dataRoot(), 'pgdata');
  const oldDir = path.join(app.getPath('userData'), 'pgdata');
  if (fs.existsSync(newDir)) { RESOLVED_PGDATA = newDir; return newDir; }
  if (fs.existsSync(oldDir)) {
    // One-time relocation of an existing install's data to the uninstall-safe folder.
    try {
      pushLog('📦 Moving the database to a safe folder that survives app uninstall…');
      try { fs.renameSync(oldDir, newDir); }
      catch { fs.cpSync(oldDir, newDir, { recursive: true }); fs.rmSync(oldDir, { recursive: true, force: true }); }
      const ov = path.join(app.getPath('userData'), 'app-version.json');
      const nv = path.join(dataRoot(), 'app-version.json');
      if (fs.existsSync(ov) && !fs.existsSync(nv)) { try { fs.renameSync(ov, nv); } catch (_) {} }
      pushLog(`📦 Database now at: ${newDir}`);
      RESOLVED_PGDATA = newDir; return newDir;
    } catch (e) {
      pushLog(`⚠️ Could not relocate database (${e.message}); keeping the current location.`);
      RESOLVED_PGDATA = oldDir; return oldDir;
    }
  }
  RESOLVED_PGDATA = newDir; return newDir; // fresh install → safe folder
}
function versionFile() { return path.join(path.dirname(pgDataDir()), 'app-version.json'); }

// Auto-updater (electron-updater). Guarded so the app still runs if the dep or a
// release feed isn't configured — the update button then reports "not configured".
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { autoUpdater = null; }

let win = null;
let tray = null;
let pgInstance = null;
let backendProc = null;
let isInstalling = false;
let isRestarting = false;        // intentional backend restart in progress (don't double-respawn)
let quitting = false;            // real quit requested (don't auto-respawn)
let manualUpdateCheck = false;   // true only while an admin-initiated check is in flight
let lastDbUrl = null;            // remembered so we can respawn the backend on crash
let backendRestarts = 0;         // consecutive crash count → exponential backoff
let backendUpTimer = null;       // resets the crash count after a stable run
let watchdogTimer = null;
let watchdogFails = 0;
const logs = [];

function backendDir() {
  // Packaged: resources/backend ; Dev: the repo root (one level up).
  return app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(__dirname, '..');
}

function logFilePath() { const d = path.join(dataRoot(), 'logs'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return path.join(d, 'server.log'); }
function appendLogFile(line) {
  try {
    const f = logFilePath();
    // Rotate at ~2 MB so the log can't grow without bound.
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch (_) {}
    fs.appendFileSync(f, new Date().toISOString() + '  ' + line + '\n');
  } catch (_) {}
}
function pushLog(line) {
  const s = String(line).replace(/\s+$/, '');
  if (!s) return;
  logs.push(s);
  if (logs.length > 500) logs.shift();
  appendLogFile(s);
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

// Keep only the newest N `dineopen-backup-*` folders in a directory.
function pruneBackupsIn(dir, keep = 7) {
  try {
    const backups = fs.readdirSync(dir)
      .filter((d) => d.startsWith('dineopen-backup-'))
      .map((d) => ({ d, t: fs.statSync(path.join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of backups.slice(keep)) {
      try { fs.rmSync(path.join(dir, old.d), { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

// Before applying a new version's migrations, snapshot the database if the app was
// just upgraded. Postgres is NOT started yet here, so a plain recursive copy of the
// data dir is a safe cold backup — a bad migration is always recoverable.
function backupIfUpgraded() {
  const dataDir = pgDataDir();
  const verFile = versionFile();
  const cur = app.getVersion();
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(verFile, 'utf8')).version; } catch (_) {}

  if (prev && prev !== cur && fs.existsSync(dataDir)) {
    const dest = path.join(autoBackupDir(), `dineopen-backup-preupdate-${prev}-${Date.now()}`);
    try {
      pushLog(`🗄️  Updating ${prev} → ${cur}. Backing up the database first…`);
      fs.cpSync(dataDir, dest, { recursive: true });
      pruneBackupsIn(autoBackupDir(), 7);
      pushLog(`🗄️  Database backup saved (${path.basename(dest)}).`);
    } catch (e) {
      pushLog(`⚠️ Backup failed (continuing): ${e.message}`);
    }
  }
  try { fs.writeFileSync(verFile, JSON.stringify({ version: cur })); } catch (_) {}
}

async function startPostgres() {
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const dataDir = pgDataDir();
  const port = PG_PORT, user = PG_USER, password = PG_PASSWORD;
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
    // Store uploaded images in the stable data folder (~/DineOpenServer/uploads — survives
    // app uninstall), served over the LAN at /uploads.
    LOCAL_UPLOAD_DIR: P('LOCAL_UPLOAD_DIR', path.join(dataRoot(), 'uploads')),
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
  lastDbUrl = databaseUrl;
  backendProc = fork(entry, [], { cwd: backendDir(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backendProc.stdout.on('data', (d) => pushLog(d));
  backendProc.stderr.on('data', (d) => pushLog(d));

  // Reset the crash counter once the process has run stably for a while.
  if (backendUpTimer) clearTimeout(backendUpTimer);
  backendUpTimer = setTimeout(() => { backendRestarts = 0; }, 60000);

  backendProc.on('exit', (code) => {
    backendProc = null;
    if (quitting || isInstalling || isRestarting) return; // intentional stop — don't respawn
    // Self-heal: respawn with exponential backoff so a crash doesn't take the store down.
    const delay = Math.min(30000, 2000 * Math.pow(2, backendRestarts));
    backendRestarts++;
    pushLog(`❌ Backend exited (${code}). ↻ Auto-restarting in ${Math.round(delay / 1000)}s (attempt ${backendRestarts})…`);
    setTimeout(() => { if (!quitting && lastDbUrl) startBackend(lastDbUrl); }, delay);
  });
  pushLog('🚀 Backend started on port 3003.');
  updateTray();
}

// ── Watchdog ─────────────────────────────────────────────────────────────────
// Poll the backend's health endpoint. A few misses → bounce the backend process
// (respawns via the exit handler). Persistent failure → full app relaunch, which
// also recovers a wedged Postgres. Runs only while the server should be up.
function pingHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3003, path: '/api/health', timeout: 4000 }, (res) => {
      res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogFails = 0;
  watchdogTimer = setInterval(async () => {
    if (quitting || isInstalling || isRestarting || backupBusy) return;
    if (!backendProc) return; // exit handler is already respawning
    const ok = await pingHealth();
    if (ok) { watchdogFails = 0; return; }
    watchdogFails++;
    pushLog(`🩺 Health check failed (${watchdogFails}).`);
    if (watchdogFails === 3) {
      pushLog('🩺 Backend unresponsive — restarting it…');
      try { isRestarting = true; backendProc.kill(); } catch (_) {}
      setTimeout(() => { isRestarting = false; if (!backendProc && lastDbUrl && !quitting) startBackend(lastDbUrl); }, 2000);
    } else if (watchdogFails >= 8) {
      pushLog('🩺 Still unresponsive — relaunching the app to recover…');
      watchdogFails = 0;
      await relaunchApp();
    }
  }, 20000);
}

// ── Backup / Restore ─────────────────────────────────────────────────────────
// A backup is a consistent, byte-exact copy of the data dir. Postgres is stopped
// for the copy (a live copy can be inconsistent) then restarted; the backend's pool
// reconnects, so terminals see only a brief pause. Do it after service. The target
// is chosen by the admin — typically an EXTERNAL drive/USB or a network folder, so
// if the machine's data is ever lost the backup is elsewhere and can be restored.
let backupBusy = false;

// A valid Postgres data dir has these; used to verify a backup is complete/restorable.
function isValidPgDataDir(dir) {
  return fs.existsSync(path.join(dir, 'PG_VERSION'))
    && fs.existsSync(path.join(dir, 'base'))
    && fs.existsSync(path.join(dir, 'global'));
}
function pgMajorOf(dir) { try { return fs.readFileSync(path.join(dir, 'PG_VERSION'), 'utf8').trim(); } catch { return null; } }

async function runBackup(targetDir, { prune = 0 } = {}) {
  if (backupBusy) throw new Error('A backup is already running.');
  const src = pgDataDir();
  if (!fs.existsSync(src)) throw new Error('No database to back up yet.');
  if (!targetDir) throw new Error('No backup folder chosen.');
  backupBusy = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dest = path.join(targetDir, `dineopen-backup-${stamp}`);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    pushLog(`🗄️  Backing up database → ${dest}`);
    const wasRunning = !!pgInstance;
    try { if (pgInstance) await pgInstance.stop(); } catch (_) {}
    try {
      fs.cpSync(src, dest, { recursive: true });
    } finally {
      if (wasRunning) { try { await pgInstance.start(); } catch (e) { pushLog(`⚠️ DB restart after backup: ${e.message}`); } }
    }
    // Verify the copy is a complete, restorable data dir — a backup you can't restore
    // is worse than none. Remove and fail loudly if the copy looks incomplete.
    if (!isValidPgDataDir(dest)) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
      throw new Error('Backup verification failed — the copy looks incomplete. Not saved.');
    }
    if (prune > 0) pruneBackupsIn(targetDir, prune);
    writeConfig({ lastBackupAt: Date.now(), lastBackupPath: dest });
    pushLog('✅ Backup complete and verified.');
    return dest;
  } finally {
    backupBusy = false;
  }
}

async function restoreBackup(backupDir) {
  if (!backupDir || !isValidPgDataDir(backupDir)) {
    throw new Error('That folder is not a valid database backup.');
  }
  const target = pgDataDir();
  // Block cross-major-version restores (e.g. a PG 16 backup into a PG 18 app) — these
  // fail cryptically at startup; surface a clear message instead.
  const backupVer = pgMajorOf(backupDir);
  const curVer = pgMajorOf(target);
  if (backupVer && curVer && backupVer !== curVer) {
    throw new Error(`This backup is from PostgreSQL ${backupVer}, but this app uses PostgreSQL ${curVer}. It can't be restored across major versions.`);
  }
  pushLog('♻️  Restoring database — the app will restart…');
  // Fully stop backend + Postgres, then swap the data dir and RELAUNCH the app. A fresh
  // process boots cleanly on the restored data (the normal startup path) — far more
  // reliable than swapping the data dir under a live embedded-Postgres instance.
  try { if (backendProc) { backendProc.kill(); backendProc = null; } } catch (_) {}
  try { if (pgInstance) { await pgInstance.stop(); pgInstance = null; } } catch (_) {}

  // Keep the current data aside so a failed restore is reversible; cleaned up next boot.
  const aside = `${target}.pre-restore-${Date.now()}`;
  try { if (fs.existsSync(target)) fs.renameSync(target, aside); }
  catch (e) { throw new Error(`Could not set current data aside: ${e.message}`); }
  try {
    fs.cpSync(backupDir, target, { recursive: true });
  } catch (e) {
    try { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(aside, target); } catch (_) {}
    throw new Error(`Restore failed: ${e.message} (original data kept).`);
  }

  writeConfig({ pendingRestoreCleanup: aside });
  pushLog('♻️  Data restored — restarting now…');
  isInstalling = true;            // reuse the before-quit bypass for a clean exit
  app.relaunch();
  setTimeout(() => app.exit(0), 400);
}

let backupTimer = null;
function scheduleAutoBackup() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  const ab = readConfig().autoBackup;
  if (!ab || !ab.enabled) return;
  const hours = Math.max(1, Number(ab.everyHours) || 24);
  const target = ab.target || autoBackupDir();
  const keep = Math.max(1, Number(ab.keep) || 7);
  pushLog(`⏱️  Auto-backup on: every ${hours}h → ${target} (keep ${keep}).`);
  backupTimer = setInterval(async () => {
    try { await runBackup(target, { prune: keep }); }
    catch (e) { pushLog(`⚠️ Scheduled backup failed: ${e.message}`); }
  }, hours * 3600 * 1000);
}

// If auto-backup is on but the last one is overdue (the machine was off at the
// scheduled time), run one shortly after launch so a gap doesn't go unbacked.
function maybeCatchUpBackup() {
  const ab = readConfig().autoBackup;
  if (!ab || !ab.enabled) return;
  const hours = Math.max(1, Number(ab.everyHours) || 24);
  const target = ab.target || autoBackupDir();
  const keep = Math.max(1, Number(ab.keep) || 7);
  const last = readConfig().lastBackupAt || 0;
  if (Date.now() - last >= hours * 3600 * 1000) {
    pushLog('⏱️  A scheduled backup was missed (machine was off?) — running one shortly…');
    setTimeout(() => { runBackup(target, { prune: keep }).catch((e) => pushLog(`⚠️ Catch-up backup: ${e.message}`)); }, 45000);
  }
}

// ── System tray (so the server isn't lost / accidentally quit) ───────────────
function showWindow() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else createWindow();
}
function trayIcon() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
    if (!img.isEmpty()) return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
  } catch (_) {}
  return nativeImage.createEmpty();
}
function updateTray() {
  if (!tray) return;
  const running = !!backendProc;
  tray.setToolTip(`DineOpen Server — ${running ? 'running' : 'starting…'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `DineOpen Server — ${running ? 'running' : 'starting…'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: showWindow },
    { label: 'Back up now…', click: async () => { try { await triggerBackupDialog(); } catch (_) {} } },
    { type: 'separator' },
    { label: 'Quit server', click: quitServer },
  ]));
}
function setupTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTray();
  } catch (e) { pushLog(`Tray unavailable: ${e.message}`); }
}

// ── Auto-launch on machine boot (survives power cuts) ────────────────────────
function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
    writeConfig({ autoLaunch: !!enabled });
  } catch (e) { pushLog(`Auto-launch setting failed: ${e.message}`); }
}
function applyAutoLaunchDefault() {
  const cfg = readConfig();
  const enabled = cfg.autoLaunch === undefined ? true : !!cfg.autoLaunch; // default ON
  setAutoLaunch(enabled);
}

// ── Windows Firewall: allow inbound 3003 so terminals can connect ────────────
// Best-effort at runtime (the NSIS installer also adds it, elevated — see
// build/installer.nsh). Silently no-ops if not permitted or not Windows.
function ensureFirewallRule() {
  if (process.platform !== 'win32') return;
  if (readConfig().firewallDone) return;
  const args = ['advfirewall', 'firewall', 'add', 'rule', 'name=DineOpen Server',
    'dir=in', 'action=allow', 'protocol=TCP', 'localport=3003'];
  execFile('netsh', args, (err) => {
    if (err) { pushLog('ℹ️ Could not add a firewall rule automatically — if terminals cannot connect, allow port 3003 in Windows Firewall.'); }
    else { pushLog('🛡️  Firewall rule added for port 3003.'); writeConfig({ firewallDone: true }); }
  });
}

function quitServer() {
  const choice = dialog.showMessageBoxSync(win || null, {
    type: 'warning', buttons: ['Cancel', 'Quit server'], defaultId: 0, cancelId: 0,
    message: 'Quit the DineOpen Server?',
    detail: 'All terminals will lose their connection until you open it again.',
  });
  if (choice !== 1) return;
  quitting = true;
  app.quit();
}

function createWindow() {
  win = new BrowserWindow({
    width: 640, height: 560, resizable: true,
    title: 'DineOpen Server',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('info', { ips: lanIPs(), port: 3003, version: app.getVersion(), dataDir: pgDataDir(), config: readConfig(), stableHost: 'dineopen-server.local' });
    logs.forEach((l) => win.webContents.send('log', l));
  });
}

ipcMain.handle('get-info', () => ({
  ips: lanIPs(), port: 3003, running: !!backendProc, version: app.getVersion(),
  dataDir: pgDataDir(), config: readConfig(), stableHost: 'dineopen-server.local',
}));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('open-data-folder', () => shell.openPath(dataRoot()));

// ── Backup / Restore IPC ─────────────────────────────────────────────────────
ipcMain.handle('choose-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});
async function triggerBackupDialog() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a backup location (an external drive / USB is safest)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const dest = await runBackup(r.filePaths[0]);
  return { ok: true, path: dest, at: Date.now() };
}
ipcMain.handle('backup-now', async () => {
  try { return await triggerBackupDialog(); }
  catch (e) { pushLog(`⚠️ Backup: ${e.message}`); return { ok: false, reason: e.message }; }
});
ipcMain.handle('set-auto-launch', (_e, enabled) => { setAutoLaunch(enabled); return readConfig(); });
ipcMain.handle('export-diagnostics', async () => {
  try {
    const cfg = readConfig();  // server-config.json holds no secrets (those live in .env.local)
    const report = [
      'DineOpen Server — diagnostics',
      'Generated: ' + new Date().toISOString(),
      'App version: ' + app.getVersion(),
      'Platform: ' + process.platform + ' ' + process.arch + ' (' + os.release() + ')',
      'Data dir: ' + pgDataDir(),
      'LAN IPs: ' + lanIPs().join(', '),
      'Stable host: dineopen-server.local:3003',
      'Backend running: ' + (!!backendProc),
      'Backend restarts (session): ' + backendRestarts,
      'Auto-launch: ' + (cfg.autoLaunch !== false),
      'Auto-backup: ' + JSON.stringify(cfg.autoBackup || { enabled: false }),
      'Last backup: ' + (cfg.lastBackupAt ? new Date(cfg.lastBackupAt).toISOString() : 'never') + (cfg.lastBackupPath ? ' → ' + cfg.lastBackupPath : ''),
      '',
      '── Recent activity ──',
      ...logs.slice(-300),
    ].join('\n');
    const r = await dialog.showSaveDialog(win, { title: 'Save diagnostics', defaultPath: `dineopen-diagnostics-${Date.now()}.txt` });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, report);
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, reason: e.message }; }
});
ipcMain.handle('restore-backup', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select a backup folder to restore (this replaces current data)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Restore'], defaultId: 0, cancelId: 0,
      message: 'Restore this backup?',
      detail: 'The current data will be replaced with the backup. The server will restart. Your current data is set aside first, so this is reversible if something goes wrong.',
    });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    await restoreBackup(r.filePaths[0]);
    return { ok: true };
  } catch (e) { pushLog(`⚠️ Restore: ${e.message}`); return { ok: false, reason: e.message }; }
});
ipcMain.handle('get-backup-config', () => readConfig());
ipcMain.handle('set-backup-config', (_e, autoBackup) => {
  const cfg = writeConfig({ autoBackup });
  scheduleAutoBackup();
  return cfg;
});

// ── Auto-update (admin-triggered) ────────────────────────────────────────────
function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', payload);
}

function initUpdater() {
  if (!autoUpdater) { sendUpdate({ state: 'unsupported' }); return; }
  autoUpdater.autoDownload = false;            // admin decides when to download
  autoUpdater.autoInstallOnAppQuit = true;
  // Quiet logger: the 'error' handler below logs a clean one-liner, so don't let
  // electron-updater dump the full HttpError object + headers + stack into the log
  // (an offline server 404s the feed on every check — that must not spam the log).
  autoUpdater.logger = { info: pushLog, warn: pushLog, error: () => {}, debug: () => {} };
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

// Single-instance lock: a second copy would fight over port 3003 and the same data
// dir (corruption risk). Refuse to start twice; focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    setupTray();
    createWindow();
    try {
      applyAutoLaunchDefault();         // start on machine boot (default on)
      ensureFirewallRule();             // Windows: allow inbound 3003
      pgDataDir();                      // resolve/relocate data dir to the safe folder
      // Clean up a previous restore's set-aside data once the app is back up.
      try {
        const pend = readConfig().pendingRestoreCleanup;
        if (pend && fs.existsSync(pend)) { fs.rmSync(pend, { recursive: true, force: true }); }
        if (pend) writeConfig({ pendingRestoreCleanup: null });
      } catch (_) {}
      backupIfUpgraded();               // snapshot DB if the app was just updated
      const dbUrl = await startPostgres();
      startBackend(dbUrl);              // forked backend runs schema migrations on boot
      setTimeout(startWatchdog, 30000); // health-poll → self-heal (grace for first boot)
      initUpdater();
      scheduleAutoBackup();             // start the scheduled external backup, if enabled
      maybeCatchUpBackup();             // run a missed backup if the machine was off
      // Silent check on launch so the admin sees a badge without hunting for it — but
      // ONLY when the machine actually has internet. An offline restaurant can never reach
      // the update feed, so trying just 404s and logs noise every boot. Probe first.
      if (autoUpdater) setTimeout(async () => {
        try {
          const dns = require('dns').promises;
          await Promise.race([
            dns.lookup('updates.dineopen.com'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('offline')), 2500)),
          ]);
        } catch (_) {
          pushLog('🌐 Offline — skipping update check (server keeps running normally).');
          return;
        }
        autoUpdater.checkForUpdates().catch(() => {});
      }, 8000);
    } catch (e) {
      pushLog(`❌ Startup failed: ${e.message}`);
    }
  });
}

async function shutdown() {
  quitting = true;
  try { if (watchdogTimer) clearInterval(watchdogTimer); } catch (_) {}
  try { if (backupTimer) clearInterval(backupTimer); } catch (_) {}
  try { if (backendProc) backendProc.kill(); } catch (_) {}
  try { if (pgInstance) await pgInstance.stop(); } catch (_) {}
}

// Clean stop (release port 3003 + 5433) then relaunch a fresh process.
async function relaunchApp() {
  isInstalling = true;                // bypass the before-quit shutdown; we do it here
  try { await shutdown(); } catch (_) {}
  app.relaunch();
  setTimeout(() => app.exit(0), 400);
}
app.on('before-quit', (e) => {
  if (isInstalling) return;           // let the updater relaunch the installer
  quitting = true;
  e.preventDefault();
  shutdown().finally(() => app.exit(0));
});
app.on('window-all-closed', () => { /* keep the server running in the tray/background */ });
