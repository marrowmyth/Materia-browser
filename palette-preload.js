const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the command palette (Ctrl+K).
contextBridge.exposeInMainWorld('palette', {
  query: (text) => ipcRenderer.invoke('palette:query', text),
  exec: (item) => ipcRenderer.send('palette:exec', item),
  close: () => ipcRenderer.send('palette:close'),
  onShow: (cb) => ipcRenderer.on('palette:show', () => cb()),
});
