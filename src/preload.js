const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vectoria', {
  // El preload corre en sandbox y no puede leer package.json, asi que la
  // version se pide al proceso principal.
  getVersion: () => ipcRenderer.invoke('app-version'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  traceVtracer: (payload) => ipcRenderer.invoke('trace-vtracer', payload),
  saveSvg: (payload) => ipcRenderer.invoke('save-svg', payload),
  savePdf: (payload) => ipcRenderer.invoke('save-pdf', payload),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
});
