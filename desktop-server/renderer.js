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
window.server.getInfo().then(renderAddrs).catch(() => {});
window.server.onLog((line) => {
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
});
