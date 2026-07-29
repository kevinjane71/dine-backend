const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('server', {
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onInfo: (cb) => ipcRenderer.on('info', (_e, info) => cb(info)),
  getInfo: () => ipcRenderer.invoke('get-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
