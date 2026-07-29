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

let win = null;
let pgInstance = null;
let backendProc = null;
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

async function startPostgres() {
  const M = require(path.join(backendDir(), 'node_modules', 'embedded-postgres'));
  const EmbeddedPostgres = M.default || M;
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
        await c.query(fs.readFileSync(schemaFile, 'utf8'));
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
  // Merge the operator's .env.local if present (JWT_SECRET, SYNC_MODE, cloud creds…).
  const env = { ...process.env, DATABASE_URL: databaseUrl, PORT: '3003', NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1' };
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

ipcMain.handle('get-info', () => ({ ips: lanIPs(), port: 3003, running: !!backendProc }));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

app.whenReady().then(async () => {
  createWindow();
  try {
    const dbUrl = await startPostgres();
    startBackend(dbUrl);
  } catch (e) {
    pushLog(`❌ Startup failed: ${e.message}`);
  }
});

async function shutdown() {
  try { if (backendProc) backendProc.kill(); } catch (_) {}
  try { if (pgInstance) await pgInstance.stop(); } catch (_) {}
}
app.on('before-quit', (e) => { e.preventDefault(); shutdown().finally(() => app.exit(0)); });
app.on('window-all-closed', () => { /* keep the server running in the tray/background */ });
