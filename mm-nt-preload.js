'use strict';
// Tiny bridge so the new-tab page shares its search-provider choice with the chrome
// (via main prefs), keeping the address bar and the start page in sync.
try {
  const { ipcRenderer } = require('electron');
  window.__mmProv = {
    get: () => { try { return ipcRenderer.sendSync('mm-get-provider'); } catch (_) { return null; } },
    set: (id) => { try { ipcRenderer.invoke('set-provider', id); } catch (_) {} }
  };
  // start-page AI query: hand the text to the chrome, which opens the AI and prefills its box
  window.__mmAI = { send: (url, query) => { try { ipcRenderer.send('mm-ai-query', { url: url, query: query }); } catch (_) {} } };
} catch (_) {}
