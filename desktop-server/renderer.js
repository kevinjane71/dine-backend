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

window.server.onInfo(renderAddrs);
window.server.getInfo().then((info) => {
  renderAddrs(info);
  if (info && info.version) document.getElementById('ver').textContent = 'v' + info.version;
}).catch(() => {});
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
