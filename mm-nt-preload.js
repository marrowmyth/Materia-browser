'use strict';
// Tiny bridge so the new-tab page shares its search-provider choice with the chrome
// (via main prefs), keeping the address bar and the start page in sync.
try {
  const { contextBridge, ipcRenderer } = require('electron');
  // contextIsolation is on for the new-tab view, so a plain `window.__x =` in the preload
  // never reaches the page's world — these must be bridged across with contextBridge.
  contextBridge.exposeInMainWorld('__mmProv', {
    get: () => { try { return ipcRenderer.sendSync('mm-get-provider'); } catch (_) { return null; } },
    set: (id) => { try { ipcRenderer.invoke('set-provider', id); } catch (_) {} }
  });
  // start-page AI query: hand the text to the chrome, which opens the AI and prefills its box
  contextBridge.exposeInMainWorld('__mmAI', {
    send: (url, query) => { try { ipcRenderer.send('mm-ai-query', { url: url, query: query }); } catch (_) {} }
  });
  // running app version, for the start-page footer
  contextBridge.exposeInMainWorld('__mmVer', (function () { try { return ipcRenderer.sendSync('mm-get-version'); } catch (_) { return ''; } })());
} catch (_) {}
