/* Renderer for the DineOpen Server status window. */
const logEl = document.getElementById('log');
const addrsEl = document.getElementById('addrs');

function renderAddrs(info) {
  const ips = (info && info.ips) || [];
  const port = (info && info.port) || 3003;
  addrsEl.innerHTML = '';
  if (!ips.length) {
    addrsEl.innerHTML = '<div class="sub">No LAN address found — connect this machine to the restaurant Wi-Fi/ethernet.</div>';
    return;
  }
  ips.forEach((ip) => {
    const url = `http://${ip}:${port}`;
    const row = document.createElement('div');
    row.className = 'addr';
    const span = document.createElement('span');
    span.textContent = url;
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    btn.onclick = () => { navigator.clipboard.writeText(url); btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200); };
    row.appendChild(span);
    row.appendChild(btn);
    addrsEl.appendChild(row);
  });
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function applyInfo(info) {
  renderAddrs(info);
  if (!info) return;
  if (info.version) document.getElementById('ver').textContent = 'v' + info.version;
  if (info.dataDir) document.getElementById('datadir').textContent = info.dataDir;
  applyBackupConfig(info.config || {});
}

window.server.onInfo(applyInfo);
window.server.getInfo().then(applyInfo).catch(() => {});
window.server.onLog((line) => {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
});

// ── Software update ──
const ustat = document.getElementById('ustat');
const ucheck = document.getElementById('ucheck');
const udownload = document.getElementById('udownload');
const uinstall = document.getElementById('uinstall');
const ubar = document.getElementById('ubar');
const ubarFill = ubar.querySelector('div');

function setStatus(text, good) { ustat.textContent = text; ustat.className = 'ustat' + (good ? ' good' : ''); }
function show(el, on) { el.style.display = on ? '' : 'none'; }

ucheck.onclick = async () => {
  setStatus('Checking…'); ucheck.disabled = true;
  const r = await window.server.checkUpdate();
  ucheck.disabled = false;
  if (!r.ok) setStatus(r.reason || 'Could not check for updates.');
};
udownload.onclick = async () => {
  show(udownload, false); ubar.style.display = 'block'; setStatus('Downloading…');
  const r = await window.server.downloadUpdate();
  if (!r.ok) { setStatus(r.reason || 'Download failed.'); ubar.style.display = 'none'; show(udownload, true); }
};
uinstall.onclick = () => { setStatus('Installing…'); window.server.installUpdate(); };

window.server.onUpdateStatus((s) => {
  switch (s.state) {
    case 'checking': setStatus('Checking…'); break;
    case 'none': setStatus('Up to date.', true); show(udownload, false); show(uinstall, false); break;
    case 'available':
      setStatus('Update available: v' + s.version);
      show(ucheck, false); show(udownload, true); break;
    case 'downloading':
      ubar.style.display = 'block'; ubarFill.style.width = (s.percent || 0) + '%';
      setStatus('Downloading… ' + (s.percent || 0) + '%'); break;
    case 'downloaded':
      ubar.style.display = 'none'; show(udownload, false); show(uinstall, true);
      setStatus('Update v' + s.version + ' ready to install.', true); break;
    case 'unsupported': setStatus('Updates are not configured for this build.'); ucheck.disabled = true; break;
    case 'error': setStatus(s.message || 'Update error.'); show(ucheck, true); break;
  }
});

// ── Backup / restore ──
const bstat = document.getElementById('bstat');
const bnow = document.getElementById('bnow');
const brestore = document.getElementById('brestore');
const bauto = document.getElementById('bauto');
const bhours = document.getElementById('bhours');
const bfolder = document.getElementById('bfolder');
const bfolderlbl = document.getElementById('bfolderlbl');
document.getElementById('opendata').onclick = () => window.server.openDataFolder();

function setBStat(t, good) { bstat.textContent = t; bstat.className = 'ustat' + (good ? ' good' : ''); }

function applyBackupConfig(cfg) {
  const ab = cfg.autoBackup || {};
  bauto.checked = !!ab.enabled;
  if (ab.everyHours) bhours.value = ab.everyHours;
  bfolderlbl.dataset.target = ab.target || '';
  if (ab.target) bfolderlbl.innerHTML = 'Auto-backup folder: <span class="mono">' + ab.target + '</span>';
  if (cfg.lastBackupAt) setBStat('Last backup: ' + timeAgo(cfg.lastBackupAt) + '.', true);
}

async function saveAutoBackup() {
  const cfg = await window.server.setBackupConfig({
    enabled: bauto.checked,
    everyHours: Math.max(1, parseInt(bhours.value) || 24),
    target: bfolderlbl.dataset.target || '',
    keep: 7,
  });
  applyBackupConfig(cfg);
}

bnow.onclick = async () => {
  bnow.disabled = true; setBStat('Backing up… (the server pauses briefly)');
  const r = await window.server.backupNow();
  bnow.disabled = false;
  if (r.ok) setBStat('Last backup: just now.', true);
  else if (!r.canceled) setBStat(r.reason || 'Backup failed.');
  else setBStat('Backup canceled.');
};
brestore.onclick = async () => {
  brestore.disabled = true; setBStat('Restoring…');
  const r = await window.server.restoreBackup();
  brestore.disabled = false;
  if (r.ok) setBStat('Restore complete.', true);
  else if (!r.canceled) setBStat(r.reason || 'Restore failed.');
  else setBStat('Restore canceled.');
};
bfolder.onclick = async () => {
  const dir = await window.server.chooseFolder('Choose the auto-backup folder (external drive / USB recommended)');
  if (dir) { bfolderlbl.dataset.target = dir; bfolderlbl.innerHTML = 'Auto-backup folder: <span class="mono">' + dir + '</span>'; await saveAutoBackup(); }
};
bauto.onchange = saveAutoBackup;
bhours.onchange = saveAutoBackup;
