const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('server', {
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
  onInfo: (cb) => ipcRenderer.on('info', (_e, info) => cb(info)),
  getInfo: () => ipcRenderer.invoke('get-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Updates
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Backup / Restore
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  chooseFolder: (title) => ipcRenderer.invoke('choose-folder', title),
  backupNow: () => ipcRenderer.invoke('backup-now'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  getBackupConfig: () => ipcRenderer.invoke('get-backup-config'),
  setBackupConfig: (cfg) => ipcRenderer.invoke('set-backup-config', cfg),
  setAutoLaunch: (on) => ipcRenderer.invoke('set-auto-launch', on),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
});
