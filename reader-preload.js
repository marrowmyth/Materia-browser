const { contextBridge, ipcRenderer } = require('electron');

// Bridge for reader mode. The article arrives as structured text blocks (never
// raw page HTML), so the renderer builds the DOM with textContent and cannot be
// XSS'd by page content.
contextBridge.exposeInMainWorld('reader', {
  onArticle: (cb) => ipcRenderer.on('reader:article', (_e, a) => cb(a)),
  close: () => ipcRenderer.send('reader:close'),
});
