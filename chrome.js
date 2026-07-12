'use strict';

const THEMES = ['materia', 'crimson', 'cobalt', 'amethyst', 'obsidian'];
let currentTheme = localStorage.getItem('materia-theme') || 'materia';
let forceRightClick = localStorage.getItem('materia-rightclick') !== '0';
function newtabUrl() { const rel = 'newtab.html?t=' + currentTheme; try { return new URL(rel, location.href).href; } catch (_) { return rel; } }
const NT_PRELOAD = (function () { try { return new URL('mm-nt-preload.js', location.href).href; } catch (_) { return ''; } })();
const OMNI_ICONS = {
  search: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.4v.1"/></svg>'
};
// Unblock copy/right-click/select WITHOUT breaking the page's own drag-and-drop. We deliberately do NOT
// stopImmediatePropagation on 'dragstart' — doing so fired before the page's dragstart handler and killed
// legit in-page DnD (dragging an image into a drop box never populated dataTransfer). Instead we defeat the
// common image-drag blocks passively: null document.ondragstart (property-handler blocks) + force img
// -webkit-user-drag:auto (CSS blocks). Listener-based dragstart blockers are left alone (rare, not worth
// breaking every web app's drag-and-drop for).
const UNBLOCK_JS = "(function(){if(window.__mmu)return;window.__mmu=1;function a(e){e.stopImmediatePropagation();}['contextmenu','selectstart','copy','cut'].forEach(function(t){window.addEventListener(t,a,true);document.addEventListener(t,a,true);});try{document.oncontextmenu=null;document.onselectstart=null;document.oncopy=null;document.ondragstart=null;}catch(_){}var s=document.createElement('style');s.textContent='*{-webkit-user-select:text!important;user-select:text!important;-webkit-touch-callout:default!important}img{-webkit-user-drag:auto!important}';(document.head||document.documentElement).appendChild(s);})();";

// Prefill an AI chat's input box with the start-page query, once the page renders.
function aiPrefillJS(query) {
  return '(function(){var Q=' + JSON.stringify(query) + ';var n=0;var iv=setInterval(function(){n++;'
    + 'var el=document.querySelector(\'div.ProseMirror[contenteditable="true"], rich-textarea div[contenteditable="true"], textarea, div[contenteditable="true"], input[type="text"]\');'
    + 'if(el&&(el.offsetParent!==null||el.getClientRects().length)){clearInterval(iv);try{el.focus();'
    + 'if(el.isContentEditable){el.textContent=Q;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:Q}));}'
    + 'else{var pr=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var st=Object.getOwnPropertyDescriptor(pr,"value").set;st.call(el,Q);el.dispatchEvent(new Event("input",{bubbles:true}));}'
    + '}catch(e){}}if(n>40){clearInterval(iv);}},250);})();';
}
function injectAIPrefill(view, query) { try { view.executeJavaScript(aiPrefillJS(query), true); } catch (_) {} }

const $ = (id) => document.getElementById(id);
const viewsEl = $('views');
const tabsEl = $('tabs');

// AI assistant: a docked panel on the right. layoutViews() reserves its width.
const AI_PANEL_WIDTH = 400;
let aiOpen = false;
async function toggleAi(force) {
  try { aiOpen = await window.materia.aiToggle(force); } catch (_) { aiOpen = false; }
  const b = $('nav-ai'); if (b) b.classList.toggle('active', aiOpen);
  try { layoutViews(); } catch (_) {}
}
try { const b = $('nav-ai'); if (b) b.addEventListener('click', () => toggleAi()); } catch (_) {}
const omni = $('omnibox');
// focusing the address bar must also pull OS keyboard focus to the chrome view (else it sits on the page view)
function focusOmni() { try { omni.focus(); } catch (_) {} try { window.materia.focusChrome(); } catch (_) {} }

/* ---------- workspaces (each has its own login partition) ---------- */
let workspaces = [];        // [{id, name}]
let activeWsId = null;
let IS_SECONDARY = false;   // a torn-off window: opens one URL, never persists its tab session
let tabs = [];              // [{id, wsId, view, title, url, favicon, loading}]
let activeId = null;        // currently shown tab (always inside activeWsId)
let splitId = null;         // second pane in split view (null = single pane)
let activeTabByWs = {};     // remembers each workspace's last-active tab
let pendingByWs = {};       // restored-but-not-yet-loaded tabs, per workspace (lazy)
let seq = 0;
let closedTabs = [];        // recently closed (url+wsId) for Ctrl+Shift+T
let dragTabId = null;       // tab being drag-reordered
let dragWsId = null;        // workspace being drag-reordered
const THEME_ACCENT = { materia: '#f1cb53', crimson: '#e1554d', cobalt: '#4f93f2', amethyst: '#a96ff2', obsidian: '#c2ced3' };
const MAX_WS = THEMES.length;  // one workspace per built-in theme (5)
const MUTE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const COPY_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
function wsIndex(id) { const i = workspaces.findIndex(w => w.id === id); return i < 0 ? 0 : Math.min(MAX_WS - 1, i); }
function wsTheme(id) { const w = workspaces.find(x => x.id === id); return (w && THEMES.includes(w.theme)) ? w.theme : THEMES[wsIndex(id)]; }
function wsColor(id) { return THEME_ACCENT[wsTheme(id)] || '#f1cb53'; }
function freeTheme() { const used = new Set(workspaces.map(w => w.theme).filter(t => THEMES.includes(t))); return THEMES.find(t => !used.has(t)) || THEMES[0]; }
function normalizeWsThemes() { const used = new Set(); workspaces.forEach(w => { if (!THEMES.includes(w.theme) || used.has(w.theme)) w.theme = THEMES.find(t => !used.has(t)) || THEMES[0]; used.add(w.theme); }); }

function wsPartition(wsId) { return 'persist:ws-' + wsId; }
function activeTab() { return tabs.find(t => t.id === activeId); }
function chromeInputFocused() { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); }
function activeWs() { return workspaces.find(w => w.id === activeWsId); }
function wsTabs() { return tabs.filter(t => t.wsId === activeWsId); }
function ensureWs(wsId) { try { window.materia.ensurePartition(wsPartition(wsId)); } catch (_) {} }

function loadWorkspaces() {
  try { workspaces = JSON.parse(localStorage.getItem('materia-workspaces')) || []; } catch (_) { workspaces = []; }
  if (!workspaces.length) workspaces = [{ id: 'default', name: 'Personal' }];
  activeWsId = localStorage.getItem('materia-active-ws');
  if (!workspaces.some(w => w.id === activeWsId)) activeWsId = workspaces[0].id;
  normalizeWsThemes();   // ensure each workspace has a unique color from the 5-theme pool
}
function saveWorkspaces() {
  localStorage.setItem('materia-workspaces', JSON.stringify(workspaces));
  localStorage.setItem('materia-active-ws', activeWsId);
}
let _saveTimer = null;
function saveSession() { if (IS_SECONDARY) return; clearTimeout(_saveTimer); _saveTimer = setTimeout(_doSave, 400); }
function _doSave() {
  const live = tabs.map(t => ({ wsId: t.wsId, url: isNewtab(t.url) ? '' : t.url, active: activeTabByWs[t.wsId] === t.id, pinned: !!t.pinned }));
  const pend = [];
  Object.keys(pendingByWs).forEach(ws => pendingByWs[ws].forEach(s => pend.push({ wsId: ws, url: s.url, active: s.active, pinned: s.pinned })));
  try { localStorage.setItem('materia-tabs', JSON.stringify(live.concat(pend))); } catch (_) {}
}
function restoreSession() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('materia-tabs')) || []; } catch (_) {}
  if (!saved.length) return false;
  const byWs = {};
  saved.forEach(s => { if (workspaces.some(w => w.id === s.wsId)) (byWs[s.wsId] = byWs[s.wsId] || []).push(s); });
  let activeTabId = null;
  (byWs[activeWsId] || []).forEach(s => { const t = makeTab(activeWsId, s.url, s.pinned); if (s.active) activeTabId = t.id; });
  delete byWs[activeWsId];
  pendingByWs = byWs;
  const mine = tabs.filter(t => t.wsId === activeWsId);
  if (!mine.length) return false;
  activateTab((activeTabId && mine.some(t => t.id === activeTabId)) ? activeTabId : mine[mine.length - 1].id);
  renderTabs();
  return true;
}

/* ---------- URL helpers ---------- */
function isNewtab(url) { return !url || url.includes('newtab.html') || url === 'about:blank'; }
function prettyUrl(url) { return isNewtab(url) ? '' : url; }

/* ---------- tabs ---------- */
// ---- WebContentsView proxy: a tab's `view` looks like the old <webview> but drives a main-owned view over IPC ----
const viewState = {};   // vid -> { url, canBack, canForward } (cached so canGoBack/getURL stay synchronous)
function makeViewProxy(vid) {
  const L = {};   // event name -> [listeners]
  return {
    _vid: vid, _L: L,
    addEventListener: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); },
    _emit: (ev, payload) => { (L[ev] || []).forEach(fn => { try { fn(payload); } catch (_) {} }); },
    loadURL: (u) => window.materia.viewNav({ vid: vid, action: 'load', url: u }),
    reload: () => window.materia.viewNav({ vid: vid, action: 'reload' }),
    goBack: () => window.materia.viewNav({ vid: vid, action: 'back' }),
    goForward: () => window.materia.viewNav({ vid: vid, action: 'forward' }),
    canGoBack: () => !!(viewState[vid] && viewState[vid].canBack),
    canGoForward: () => !!(viewState[vid] && viewState[vid].canForward),
    getURL: () => (viewState[vid] ? viewState[vid].url : ''),
    setZoomFactor: (f) => window.materia.viewZoom({ vid: vid, factor: f }),
    setAudioMuted: (m) => window.materia.viewMute({ vid: vid, muted: m }),
    findInPage: (t, o) => window.materia.viewFind({ vid: vid, action: 'find', text: t, opts: o }),
    stopFindInPage: (a) => window.materia.viewFind({ vid: vid, action: 'stop', arg: a }),
    print: () => window.materia.viewPrint({ vid: vid }),
    insertCSS: (css) => { window.materia.viewCss({ vid: vid, css: css }); return Promise.resolve(); },
    executeJavaScript: (js, ug) => window.materia.viewExec({ vid: vid, js: js, userGesture: ug }).catch(() => null),
    blur: () => {},
    remove: () => { window.materia.viewDestroy({ vid: vid }); delete viewState[vid]; }
  };
}
window.materia.onViewEvent((d) => {
  const tab = tabs.find(t => t.id === d.vid); if (!tab || !tab.view || !tab.view._emit) return;
  const p = d.payload || {};
  if (d.event === 'did-navigate' || d.event === 'did-navigate-in-page') {
    viewState[d.vid] = viewState[d.vid] || {};
    viewState[d.vid].url = p.url; viewState[d.vid].canBack = p.canBack; viewState[d.vid].canForward = p.canForward;
    tab.view._emit(d.event, {});
  } else if (d.event === 'page-title-updated') tab.view._emit(d.event, { title: p.title });
  else if (d.event === 'page-favicon-updated') tab.view._emit(d.event, { favicons: p.favicons });
  else if (d.event === 'found-in-page') tab.view._emit(d.event, { result: p.result });
  else tab.view._emit(d.event, {});
});
function makeTab(wsId, url, pinned) {
  const target = url || newtabUrl();
  ensureWs(wsId);
  const id = ++seq;
  const tab = { id, wsId, title: 'New Tab', url: target, favicon: null, loading: false, pinned: !!pinned };
  viewState[id] = { url: target, canBack: false, canForward: false };
  tab.view = makeViewProxy(id);
  window.materia.viewCreate({ vid: id, wsId: wsId, partition: wsPartition(wsId), url: target });
  tabs.push(tab);
  wireView(tab);
  return tab;
}
function createTab(url) {
  const t = makeTab(activeWsId, url);
  if (isNewtab(t.url)) t.focusOnReady = true;   // land the cursor in the address bar
  renderTabs();
  activateTab(t.id);
  return t;
}

function activateTab(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  activeId = id;
  activeTabByWs[t.wsId] = id;
  if (splitId === id) splitId = null;   // a tab can't be both panes
  layoutViews();
  renderTabs();
  omni.value = prettyUrl(t.url);
  updateChrome(t);
  if (!splitId && isNewtab(t.url)) focusOmni();   // new tab → cursor in the address bar
  saveSession();
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i === -1) return;
  const ct = tabs[i]; const wsId = ct.wsId;
  if (!isNewtab(ct.url)) { closedTabs.push({ url: ct.url, wsId: ct.wsId, pinned: !!ct.pinned }); if (closedTabs.length > 25) closedTabs.shift(); }
  ct.view.remove();
  tabs.splice(i, 1);
  if (id === splitId) { splitId = null; layoutViews(); }
  if (activeId !== id) { renderTabs(); saveSession(); return; }
  const siblings = tabs.filter(x => x.wsId === wsId);
  if (siblings.length) activateTab(siblings[siblings.length - 1].id);
  else createTab();
  saveSession();
}

function newXfer() { return 'xf_' + Date.now() + '_' + Math.floor(Math.random() * 1e6); }
// remove a tab from THIS window WITHOUT destroying its view — the live view is being moved to another window
function detachTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i === -1) return;
  const ct = tabs[i]; const wsId = ct.wsId;
  delete viewState[id];
  tabs.splice(i, 1);
  if (id === splitId) { splitId = null; layoutViews(); }
  if (activeId === id) {
    const siblings = tabs.filter(x => x.wsId === wsId);
    if (siblings.length) activateTab(siblings[siblings.length - 1].id);
    else if (IS_SECONDARY) { try { window.materia.winClose(); } catch (_) {} return; }   // emptied a torn window → close it
    else createTab();
  }
  renderTabs(); saveSession();
}
// build a tab around a view that is ALREADY alive in main (moved from another window) — no viewCreate, no reload
function adoptTab(o) {
  o = o || {};
  const wsId = activeWsId;   // land it in the window's current workspace so it's visible (new windows already set activeWsId to the source's)
  ensureWs(wsId);
  const id = ++seq; const url = o.url || '';
  const tab = { id, wsId, title: o.title || 'Tab', url: url, favicon: null, loading: false, pinned: false };
  viewState[id] = { url: url, canBack: false, canForward: false };
  tab.view = makeViewProxy(id);
  tabs.push(tab);
  wireView(tab);
  window.materia.viewAdopt({ xfer: o.xfer, vid: id });   // main re-parents the live WebContentsView under this vid
  renderTabs(); activateTab(id); saveSession();
  return tab;
}

function renderTabs() {
  tabsEl.innerHTML = '';
  const list = wsTabs().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  list.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.id === splitId ? ' split-mate' : '') + (t.pinned ? ' pinned' : '');
    el.title = t.title;
    const fav = document.createElement('img');
    fav.className = 'tab-fav' + (t.favicon ? '' : ' placeholder');
    if (t.favicon) fav.src = t.favicon;
    el.appendChild(fav);
    if (t.muted) { const mu = document.createElement('span'); mu.className = 'tab-mute'; mu.innerHTML = MUTE_SVG; el.appendChild(mu); }
    if (!t.pinned) {
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = t.loading ? 'Loading…' : (t.title || 'New Tab');
      const close = document.createElement('button');
      close.className = 'tab-close'; close.textContent = '✕';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      el.append(title, close);
    }
    el.draggable = true;
    el.addEventListener('click', () => activateTab(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(t.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showTabMenu(t, e.clientX, e.clientY); });
    el.addEventListener('dragstart', (e) => { dragTabId = t.id; el.classList.add('dragging'); document.body.classList.add('tab-dragging'); applyChrome(); try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {} });
    el.addEventListener('dragend', (e) => {
      el.classList.remove('dragging'); document.body.classList.remove('tab-dragging'); const torn = dragTabId; dragTabId = null; applyChrome();
      // dropped outside this window's bounds → tear the tab into its own window
      if (torn === t.id && (e.screenX || e.screenY)) {
        const out = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
        if (out) { try { window.materia.tabMoveOut({ vid: t.id, xfer: newXfer(), url: t.url, title: t.title, wsId: t.wsId, x: e.screenX, y: e.screenY }); } catch (_) {} detachTab(t.id); }
      }
    });
    el.addEventListener('dragover', (e) => { if (dragTabId && dragTabId !== t.id) { e.preventDefault(); el.classList.add('tab-drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('tab-drop'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('tab-drop'); if (dragTabId && dragTabId !== t.id) reorderTab(dragTabId, t.id); dragTabId = null; });
    tabsEl.appendChild(el);
  });
}

/* ---------- split view (two panes side by side in the same window) ---------- */
// The chrome is a transparent view sitting OVER the live page. Normally it's sized to just the toolbar strip,
// so the page below stays fully interactive. When any overlay/menu/dropdown opens we tell main to expand the
// chrome to the full window, so panels and menus float over the live page (which keeps playing) and nothing
// gets clipped — then shrink back to the strip when they close.
function isEditable(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)); }
function anyOverlayOpen() {
  const shown = (id) => { const e = $(id); return !!(e && !e.classList.contains('hidden')); };
  if (shown('settings') || shown('notes-panel') || shown('list-panel') || shown('findbar') || shown('ws-menu') || shown('palette') || shown('reader')) return true;
  if (document.querySelector('.omni-suggest.open, .folder-pop.open, .soc-overflow.open, #ctx-menu, .confirm-ov')) return true;
  if (isEditable(document.activeElement)) return true;   // a chrome field (address bar, settings) is focused — chrome must be the top, focusable layer
  return false;
}
function stripHeight() { try { return Math.max(1, Math.ceil(viewsEl.getBoundingClientRect().top)) || 92; } catch (_) { return 92; } }
let _chromeFull = null;
let _lastY = 9999;   // last pointer Y inside the chrome; start in the content region so the chrome begins BEHIND the page
// The chrome floats ABOVE the page while the pointer is over the toolbar strip OR an overlay is open (so the
// address bar, menus and dropdowns are interactive and render over the page); it tucks BEHIND the page while
// the pointer is over the content (so the page is clickable). Because every menu/dropdown opens from a toolbar
// click, the chrome is already on top when it appears — no reorder mid-open, which would blur and dismiss it.
// While a tab is being dragged, keep the chrome on top across the whole window so its document-level
// dragover (which marks the window a valid move-target) suppresses the OS "no-drop" cursor everywhere —
// otherwise the cursor sits over the page view, which rejects the drag, and shows 🚫 even though releasing docks fine.
function desiredTop() { return dragTabId != null || anyOverlayOpen() || _lastY < stripHeight(); }
function applyChrome() {
  const top = desiredTop();
  if (top === _chromeFull) return;
  _chromeFull = top;
  try { window.materia.chromeBounds({ full: top }); } catch (_) {}
}
document.addEventListener('mousemove', (e) => { _lastY = e.clientY; applyChrome(); }, true);
function layoutViews() {
  if (splitId && !tabs.some(t => t.id === splitId && t.wsId === activeWsId && t.id !== activeId)) splitId = null;
  const on = !!splitId;
  const r = viewsEl.getBoundingClientRect();
  const X = r.left, Y = r.top, H = r.height;
  const aiW = aiOpen ? Math.min(AI_PANEL_WIDTH, Math.floor(r.width * 0.5)) : 0;
  const W = r.width - aiW; // shrink the content area when the AI panel is docked
  const halfW = Math.round(W / 2);
  tabs.forEach(t => {
    const left = t.id === activeId, right = on && t.id === splitId;
    if (on && left) window.materia.viewBounds({ vid: t.id, x: X, y: Y, width: halfW, height: H });
    else if (right) window.materia.viewBounds({ vid: t.id, x: X + halfW, y: Y, width: W - halfW, height: H });
    else if (!on && left) window.materia.viewBounds({ vid: t.id, x: X, y: Y, width: W, height: H });
    else window.materia.viewHide({ vid: t.id });
  });
  if (aiW) window.materia.aiPanelBounds({ x: X + W, y: Y, width: aiW, height: H });
  else window.materia.aiPanelHide();
  try { window.materia.aiActiveTab(activeId); } catch (_) {}   // keep main's active-tab pointer in sync for the AI
  try { document.documentElement.style.setProperty('--mm-ai-dock', aiW + 'px'); } catch (_) {}   // overlays reserve the dock
  applyChrome();
}
window.addEventListener('resize', () => { try { layoutViews(); } catch (_) {} });
{ let _vt = null; const obs = new MutationObserver(() => { clearTimeout(_vt); _vt = setTimeout(() => { try { applyChrome(); } catch (_) {} }, 16); }); obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] }); }
// focusing a chrome field must float the chrome above the page AND grab OS keyboard focus, or typing goes to the page
document.addEventListener('focusin', (e) => { try { applyChrome(); } catch (_) {} if (isEditable(e.target)) { try { window.materia.focusChrome(); } catch (_) {} } });
document.addEventListener('focusout', () => { setTimeout(() => { try { applyChrome(); } catch (_) {} }, 0); });
function openInSplit(id) {
  if (id === activeId || !tabs.some(t => t.id === id && t.wsId === activeWsId)) {
    const t = makeTab(activeWsId, null);   // spawn a fresh tab for the second pane
    splitId = t.id;
  } else {
    splitId = id;
  }
  layoutViews(); renderTabs(); saveSession();
}
function exitSplit() { splitId = null; layoutViews(); renderTabs(); }

/* ---------- tab pinning + generic right-click menu ---------- */
function togglePin(t) { t.pinned = !t.pinned; renderTabs(); saveSession(); }
function closeCtxMenu() { const e = $('ctx-menu'); if (e) e.remove(); }
function showMenu(items, x, y) {
  closeCtxMenu();
  const m = document.createElement('div'); m.className = 'ctx-menu'; m.id = 'ctx-menu';
  items.forEach((it) => { const b = document.createElement('button'); b.className = 'ctx-item'; b.textContent = it.label; b.addEventListener('click', () => { closeCtxMenu(); it.fn(); }); m.appendChild(b); });
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 30 - items.length * 36) + 'px';
}
function showTabMenu(t, x, y) {
  const items = [
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', fn: () => togglePin(t) },
    { label: t.muted ? 'Unmute tab' : 'Mute tab', fn: () => toggleMute(t) },
    { label: splitId ? 'Open in split (replace pane)' : 'Open in split view', fn: () => openInSplit(t.id) }
  ];
  if (splitId) items.push({ label: 'Exit split view', fn: exitSplit });
  items.push(
    { label: 'New tab', fn: () => createTab() },
    { label: 'Duplicate tab', fn: () => createTab(t.url) },
    { label: 'Move to new window', fn: () => { try { window.materia.tabMoveOut({ vid: t.id, xfer: newXfer(), url: t.url, title: t.title, wsId: t.wsId }); } catch (_) {} detachTab(t.id); } },
    { label: 'Reload', fn: () => { try { t.view.reload(); } catch (_) {} } },
    { label: 'Close tab', fn: () => closeTab(t.id) },
    { label: 'Close other tabs', fn: () => { wsTabs().filter(x => x.id !== t.id && !x.pinned).map(x => x.id).forEach(closeTab); } }
  );
  showMenu(items, x, y);
}

/* ---------- per-tab webview events ---------- */
function wireView(tab) {
  const v = tab.view;
  v.addEventListener('page-title-updated', (e) => { tab.title = e.title; renderTabs(); });
  v.addEventListener('page-favicon-updated', (e) => { tab.favicon = (e.favicons && e.favicons[0]) || null; renderTabs(); });
  v.addEventListener('did-start-loading', () => { tab.loading = true; renderTabs(); if (tab.id === activeId) setLoad(true); });
  v.addEventListener('did-stop-loading', () => { tab.loading = false; renderTabs(); if (tab.id === activeId) setLoad(false); addHistory(tab.url, tab.title); if (tab._pendingAI != null) { const q = tab._pendingAI; tab._pendingAI = null; if (q) injectAIPrefill(v, q); } });
  const onNav = () => {
    tab.url = v.getURL();
    if (tab.id === activeId) { omni.value = prettyUrl(tab.url); updateChrome(tab); }
    saveSession();
  };
  v.addEventListener('did-navigate', onNav);
  v.addEventListener('did-navigate-in-page', onNav);
  v.addEventListener('found-in-page', (e) => {
    if (tab.id !== activeId) return;
    const r = e.result || {}; const c = $('find-count');
    if (c) c.textContent = r.matches ? (r.activeMatchOrdinal + ' / ' + r.matches) : 'No matches';
  });
  v.addEventListener('dom-ready', () => {
    try { v.setZoomFactor(effectiveZoom()); } catch (_) {}
    if (isNewtab(tab.url)) { try { v.executeJavaScript('window.__setTheme&&window.__setTheme(' + JSON.stringify(currentTheme) + ')', true); } catch (_) {} }
    if (tab.focusOnReady) { tab.focusOnReady = false; focusOmni(); }   // new tab → cursor in the address bar
    if (forceRightClick) { try { v.executeJavaScript(UNBLOCK_JS, true); } catch (_) {} }
    if (!isNewtab(tab.url)) { try { window.materia.getCosmetics(tab.url).then(css => { if (css) v.insertCSS(css).catch(() => {}); }).catch(() => {}); } catch (_) {} }
  });
}

function updateChrome(tab) {
  const v = tab.view;
  try { $('nav-back').disabled = !v.canGoBack(); $('nav-fwd').disabled = !v.canGoForward(); } catch (_) {}
  const secure = /^https:/.test(tab.url || '');
  const lk = $('omni-lock');
  if (isNewtab(tab.url)) { lk.innerHTML = OMNI_ICONS.search; lk.style.color = ''; }
  else if (secure) { lk.innerHTML = OMNI_ICONS.lock; lk.style.color = ''; }
  else { lk.innerHTML = OMNI_ICONS.warn; lk.style.color = '#e8a13a'; }
  updateStar();
}

function setLoad(on) {
  const bar = $('loadbar');
  if (on) { bar.classList.add('on'); bar.style.width = '12%'; setTimeout(() => { if (bar.classList.contains('on')) bar.style.width = '78%'; }, 220); }
  else { bar.style.width = '100%'; setTimeout(() => { bar.classList.remove('on'); bar.style.width = '0'; }, 280); }
}

/* ---------- navigation / omnibox ---------- */
const OMNI_PROVIDERS = {
  ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s&kp=-2' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s' },
  brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/?q=%s' },
  claude: { name: 'Claude', url: 'https://claude.ai/new?q=%s' },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app?q=%s' },
  grok: { name: 'Grok', url: 'https://grok.com/?q=%s' },
  perplexity: { name: 'Perplexity', url: 'https://www.perplexity.ai/search?q=%s' }
};
const OMNI_BANGS = {
  g: 'https://www.google.com/search?q=%s', ddg: 'https://duckduckgo.com/?q=%s', bing: 'https://www.bing.com/search?q=%s',
  yt: 'https://www.youtube.com/results?search_query=%s', w: 'https://en.wikipedia.org/wiki/Special:Search?search=%s',
  gh: 'https://github.com/search?q=%s&type=repositories', r: 'https://www.reddit.com/search/?q=%s',
  x: 'https://x.com/search?q=%s', tw: 'https://x.com/search?q=%s', a: 'https://www.amazon.com/s?k=%s',
  maps: 'https://www.google.com/maps/search/%s', so: 'https://stackoverflow.com/search?q=%s',
  npm: 'https://www.npmjs.com/search?q=%s', imdb: 'https://www.imdb.com/find/?q=%s',
  img: 'https://duckduckgo.com/?q=%s&iax=images&ia=images', tr: 'https://translate.google.com/?sl=auto&tl=en&text=%s'
};
function omniProviderName() { let pid = 'ddg'; try { pid = window.materia.getProvider() || 'ddg'; } catch (_) {} return (OMNI_PROVIDERS[pid] || OMNI_PROVIDERS.ddg).name; }
function resolveQuery(text) {
  text = (text || '').trim(); if (!text) return null;
  if (text.charAt(0) === '!') { const sp = text.indexOf(' '); const bang = (sp < 0 ? text.slice(1) : text.slice(1, sp)).toLowerCase(); const rest = sp < 0 ? '' : text.slice(sp + 1).trim(); if (OMNI_BANGS[bang]) return OMNI_BANGS[bang].replace('%s', encodeURIComponent(rest)); }
  if (/^(https?|file|about|data|view-source):/i.test(text)) return text;
  if (!/\s/.test(text) && /^[^\s.]+\.[^\s.]{2,}/.test(text)) return 'https://' + text;
  let pid = 'ddg'; try { pid = window.materia.getProvider() || 'ddg'; } catch (_) {}
  return (OMNI_PROVIDERS[pid] || OMNI_PROVIDERS.ddg).url.replace('%s', encodeURIComponent(text));
}
function calcResult(text) {
  const s = (text || '').trim();
  if (s.length > 40 || !/^[-+/*().\d\s]+$/.test(s) || !/[-+*/]/.test(s)) return null;
  try { const v = Function('"use strict";return (' + s + ')')(); if (typeof v === 'number' && isFinite(v)) return Math.round(v * 1e6) / 1e6; } catch (_) {}
  return null;
}
function omniNavigate(text) { const url = resolveQuery(text); if (!url) return; const t = activeTab(); if (t) t.view.loadURL(url); else createTab(url); }
let suggItems = []; let suggSel = -1; let _suggTimer = null;
function hideSugg() { const b = $('omni-suggest'); if (b) { b.classList.remove('open'); b.innerHTML = ''; } suggItems = []; suggSel = -1; }
function renderSugg() {
  const b = $('omni-suggest'); if (!b) return;
  if (!suggItems.length) { hideSugg(); return; }
  b.innerHTML = '';
  suggItems.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'sg-row' + (i === suggSel ? ' sel' : '');
    const ic = document.createElement('span'); ic.className = 'sg-ic'; ic.textContent = it.type === 'calc' ? '=' : (it.type === 'go' ? '↵' : '\u{1F50E}');
    const tx = document.createElement('span'); tx.className = 'sg-tx'; tx.textContent = it.label;
    row.append(ic, tx);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); useSugg(i); });
    b.appendChild(row);
  });
  b.classList.add('open');
}
function useSugg(i) {
  const it = suggItems[i]; if (!it) return;
  if (it.type === 'calc') { try { window.materia.copyText(String(it.value)); } catch (_) {} showMini('Copied  ' + it.value); hideSugg(); return; }
  omni.value = it.value; hideSugg(); omniNavigate(it.value); omni.blur();
}
function updateSugg() {
  const text = omni.value;
  if (!text.trim()) { hideSugg(); return; }
  const items = [];
  const c = calcResult(text); if (c !== null) items.push({ type: 'calc', label: text + '   =   ' + c, value: c });
  const isUrl = /^(https?|file|about|data):/i.test(text) || (!/\s/.test(text) && /^[^\s.]+\.[^\s.]{2,}/.test(text));
  const isBang = text.charAt(0) === '!';
  items.push({ type: 'go', label: isUrl ? ('Go to ' + text) : (isBang ? ('Bang  ·  ' + text) : (omniProviderName() + '  ·  ' + text)), value: text });
  suggItems = items; suggSel = -1; renderSugg();
  if (isUrl || isBang) return;
  const q = text;
  window.materia.suggest(q).then(list => {
    if (omni.value !== q) return;
    (list || []).forEach(s => { if (s && s !== q && suggItems.length < 9) suggItems.push({ type: 'sugg', label: s, value: s }); });
    renderSugg();
  }).catch(() => {});
}
omni.addEventListener('input', () => { clearTimeout(_suggTimer); _suggTimer = setTimeout(updateSugg, 120); });
omni.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (suggItems.length) { suggSel = (suggSel + 1) % suggItems.length; renderSugg(); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (suggItems.length) { suggSel = (suggSel - 1 + suggItems.length) % suggItems.length; renderSugg(); } }
  else if (e.key === 'Enter') { e.preventDefault(); if (suggSel >= 0) useSugg(suggSel); else { hideSugg(); omniNavigate(omni.value); omni.blur(); } }
  else if (e.key === 'Escape') { hideSugg(); omni.blur(); }
});
{ const wrap = $('omnibox-wrap'); if (wrap) wrap.addEventListener('mousedown', (e) => { if (e.target === wrap || e.target === $('omni-lock')) { e.preventDefault(); omni.focus(); } }); }
omni.addEventListener('focus', () => { $('omnibox-wrap').classList.add('focus'); omni.select(); });
// Any chrome form field that gains focus reclaims the keyboard from a focused <webview>
// (a guest page holding focus is what made the address bar refuse to type).
document.addEventListener('focusin', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const t = activeTab(); if (t && t.view) { try { t.view.blur(); } catch (_) {} }   // release the guest page's keyboard hold
    try { window.materia.focusChrome(); } catch (_) {}
  }
});
omni.addEventListener('blur', () => { $('omnibox-wrap').classList.remove('focus'); setTimeout(hideSugg, 150); const t = activeTab(); if (t) omni.value = prettyUrl(t.url); });

$('nav-back').addEventListener('click', () => { const t = activeTab(); if (t && t.view.canGoBack()) t.view.goBack(); });
$('nav-fwd').addEventListener('click', () => { const t = activeTab(); if (t && t.view.canGoForward()) t.view.goForward(); });
$('nav-reload').addEventListener('click', () => { const t = activeTab(); if (t) t.view.reload(); });
$('nav-home').addEventListener('click', () => { const t = activeTab(); if (t) t.view.loadURL(newtabUrl()); });
{ const b = $('nav-update'); if (b) b.addEventListener('click', async () => {
  const page = b._url || 'https://github.com/marrowmyth/Materia-browser/releases/latest';
  if (!window.materia.downloadUpdate) { createTab(page); return; }
  const ok = await confirmModal('Download and install Slash ' + (b._ver ? 'v' + b._ver + ' ' : '') + 'now? It downloads here, then the installer opens to finish.', 'Update');
  if (!ok) return;
  showMini('Downloading update… 0%');
  const r = await window.materia.downloadUpdate({});
  if (!r || !r.ok) { showMini('Download failed — opening release page'); createTab(page); }
}); }
if (window.materia.onUpdateProgress) window.materia.onUpdateProgress((d) => {
  if (!d) return;
  if (d.done) showMini('Update downloaded — opening installer…');
  else showMini('Downloading update… ' + (d.pct || 0) + '%');
});
if (window.materia.onUpdateAvailable) window.materia.onUpdateAvailable((d) => { const b = $('nav-update'); if (!b) return; b._url = (d && d.url) || 'https://github.com/marrowmyth/Materia-browser/releases/latest'; b._ver = (d && d.version) || ''; b.title = 'Update available — v' + ((d && d.version) || '') + ' · click to install'; b.classList.remove('hidden'); });
$('newtab').addEventListener('click', () => createTab());

/* ---------- video downloader (yt-dlp) ---------- */
function vdDownload(url, quality) {
  url = (url || '').trim(); if (!/^https?:/i.test(url)) { showMini('Enter a valid video URL'); return; }
  showMini('Starting video download…');
  const st = $('vd-status'); if (st) st.textContent = 'Starting…';
  window.materia.ytdlpDownload(url, quality || 'best').then(r => { if (!r || !r.ok) { showMini('yt-dlp: ' + ((r && r.error) || 'failed')); if (st) st.textContent = (r && r.error) || 'Failed'; } });
}
{ const b = $('vd-go'); if (b) b.addEventListener('click', () => vdDownload($('vd-url').value, ($('vd-quality') || {}).value || 'best')); }
{ const i = $('vd-url'); if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') vdDownload(i.value, ($('vd-quality') || {}).value || 'best'); }); }
window.materia.onYtdlp((d) => { if (d) vdDownload(d.url, d.quality); });
window.materia.onYtdlpProgress((p) => {
  const st = $('vd-status');
  const fid = 'yt-' + (p.id || 'v');
  if (p.done) {
    const fail = p.error || 'Failed — check the link';
    if (st) st.textContent = p.ok ? '✓ Saved to your Videos folder' : fail;
    if (window._dlShelf) window._dlShelf.update(fid, { name: 'Video download', state: p.ok ? 'done' : 'failed', pct: p.ok ? 100 : undefined });
  } else {
    if (st) st.textContent = p.line || 'Downloading…';
    const patch = { name: 'Video download', state: 'progress' };
    if (p.pct != null) patch.pct = p.pct;
    if (window._dlShelf) window._dlShelf.update(fid, patch);
  }
});

/* ---------- download shelf (small footer showing progress for file + video downloads) ---------- */
(function () {
  const bar = $('dl-footer'); if (!bar) return;
  const items = new Map();   // id -> { name, pct, state:'progress'|'done'|'failed', path, openable }
  const visible = () => !bar.classList.contains('hidden');
  function render() {
    const was = visible();
    bar.textContent = '';
    if (!items.size) { bar.classList.add('hidden'); if (was) try { layoutViews(); } catch (_) {} return; }
    items.forEach((it, id) => {
      const row = document.createElement('div');
      row.className = 'dl-row' + (it.state === 'done' ? ' done' : it.state === 'failed' ? ' failed' : '');
      const ico = document.createElement('span'); ico.className = 'dl-ico';
      ico.textContent = it.state === 'done' ? '✓' : it.state === 'failed' ? '✕' : '↓'; row.appendChild(ico);
      const name = document.createElement('span'); name.className = 'dl-name'; name.textContent = it.name || 'Download'; name.title = it.name || ''; row.appendChild(name);
      const bw = document.createElement('span'); bw.className = 'dl-bar';
      if (it.state === 'progress') { const i = document.createElement('i'); i.style.width = (it.pct != null ? Math.max(2, Math.min(100, it.pct)) : 4) + '%'; bw.appendChild(i); }
      else bw.style.visibility = 'hidden';
      row.appendChild(bw);
      const pc = document.createElement('span'); pc.className = 'dl-pct';
      if (it.state === 'progress') pc.textContent = it.pct != null ? Math.round(it.pct) + '%' : '…';
      else if (it.state === 'failed') pc.textContent = 'Failed';
      else if (it.openable) {
        const o = document.createElement('span'); o.className = 'dl-act'; o.textContent = 'Open'; o.onclick = () => { try { window.materia.openPath(it.path); } catch (_) {} }; pc.appendChild(o);
        const f = document.createElement('span'); f.className = 'dl-act'; f.textContent = 'Folder'; f.onclick = () => { try { window.materia.showItem(it.path); } catch (_) {} }; pc.appendChild(f);
      } else pc.textContent = '✓ Done';
      row.appendChild(pc);
      const x = document.createElement('span'); x.className = 'dl-x'; x.textContent = '×'; x.title = 'Dismiss'; x.onclick = () => { items.delete(id); render(); }; row.appendChild(x);
      bar.appendChild(row);
    });
    bar.classList.remove('hidden');
    if (!was) try { layoutViews(); } catch (_) {}
  }
  function autoClear(id, ms) { setTimeout(() => { const it = items.get(id); if (it && it.state !== 'progress') { items.delete(id); render(); } }, ms || 14000); }
  // regular browser file downloads
  window.materia.onDownload((d) => {
    if (!d || !d.id) return;
    const it = items.get(d.id) || {};
    it.name = d.name || it.name || 'Download';
    if (d.total > 0) it.pct = d.received / d.total * 100;
    if (d.path) it.path = d.path;
    if (d.state === 'completed') { it.state = 'done'; it.pct = 100; it.openable = !!it.path; }
    else if (d.state === 'interrupted' || d.state === 'cancelled' || d.state === 'failed') it.state = 'failed';
    else it.state = 'progress';
    items.set(d.id, it);
    render();
    if (it.state !== 'progress') autoClear(d.id);
  });
  // the yt-dlp handler pushes video progress into the same shelf
  window._dlShelf = {
    update(id, patch) {
      const it = items.get(id) || { name: 'Video download' };
      if (patch.name != null) it.name = patch.name;
      if (patch.pct != null) it.pct = patch.pct;
      if (patch.state != null) it.state = patch.state;
      if (patch.openable != null) it.openable = patch.openable;
      items.set(id, it);
      render();
      if (it.state !== 'progress') autoClear(id);
    }
  };
})();

/* ---------- window controls ---------- */
$('w-min').addEventListener('click', () => window.materia.winMin());
$('w-max').addEventListener('click', () => window.materia.winMax());
$('w-close').addEventListener('click', () => window.materia.winClose());

/* ---------- workspace switcher ---------- */
function renderWsSwitcher() {
  const w = activeWs();
  const cur = $('ws-current'); if (cur) cur.title = 'Workspaces — current: ' + (w ? w.name : '—');
  const orb = document.querySelector('#ws-current .ws-orb');
  if (orb) { const c = wsColor(activeWsId); orb.style.background = c; orb.style.boxShadow = '0 0 9px ' + c + ', 0 0 3px ' + c; }
  const menu = $('ws-menu');
  menu.querySelectorAll('.ws-item').forEach(n => n.remove());
  workspaces.forEach(ws => {
    const item = document.createElement('button');
    item.className = 'ws-item' + (ws.id === activeWsId ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'ws-dot';
    const c = wsColor(ws.id); dot.style.background = c; dot.style.boxShadow = '0 0 6px ' + c;
    const nm = document.createElement('span'); nm.className = 'ws-item-name'; nm.textContent = ws.name; nm.title = ws.name + ' — drag to reorder';
    item.append(dot, nm);
    item.addEventListener('click', (e) => { e.stopPropagation(); switchWorkspace(ws.id); $('ws-menu').classList.add('hidden'); });
    const edit = document.createElement('span'); edit.className = 'ws-edit'; edit.title = 'Rename'; edit.innerHTML = PENCIL_SVG;
    edit.addEventListener('click', (e) => { e.stopPropagation(); startRenameWs(ws, nm); });
    item.appendChild(edit);
    const cp = document.createElement('span'); cp.className = 'ws-copy'; cp.title = 'Copy bookmarks & logins to another workspace'; cp.innerHTML = COPY_SVG;
    cp.addEventListener('click', (e) => { e.stopPropagation(); showCopyWsMenu(ws, e.clientX, e.clientY); });
    item.appendChild(cp);
    item.draggable = true;
    item.addEventListener('dragstart', (e) => { dragWsId = ws.id; item.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {} });
    item.addEventListener('dragend', () => { dragWsId = null; item.classList.remove('dragging'); });
    item.addEventListener('dragover', (e) => { if (dragWsId && dragWsId !== ws.id) { e.preventDefault(); item.classList.add('ws-drop'); } });
    item.addEventListener('dragleave', () => item.classList.remove('ws-drop'));
    item.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); item.classList.remove('ws-drop'); if (dragWsId && dragWsId !== ws.id) reorderWs(dragWsId, ws.id); dragWsId = null; });
    if (workspaces.length > 1) {
      const del = document.createElement('span'); del.className = 'ws-del'; del.textContent = '✕'; del.title = 'Remove workspace';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeWorkspace(ws.id); });
      item.appendChild(del);
    }
    menu.insertBefore(item, $('ws-new-input'));
  });
  const nw = $('ws-new'); if (nw) nw.style.display = workspaces.length >= MAX_WS ? 'none' : '';
}
// copy a workspace's bookmarks + logins into another workspace as an independent copy
function copyWorkspaceData(fromId, toId) {
  if (fromId === toId) return;
  const target = workspaces.find(w => w.id === toId); if (!target) return;
  const clone = JSON.parse(JSON.stringify(bookmarks[fromId] || []));   // deep clone → standalone
  bookmarks[toId] = (bookmarks[toId] || []).concat(clone);
  saveBookmarks(); if (toId === activeWsId) renderBookmarks();
  showMini('Copying bookmarks & logins to “' + target.name + '”…');
  ensureWs(toId);
  window.materia.copyWorkspaceCookies(wsPartition(fromId), wsPartition(toId))
    .then(r => showMini(r && r.ok ? ('Copied to “' + target.name + '” — now standalone') : 'Bookmarks copied; logins didn’t transfer'))
    .catch(() => showMini('Bookmarks copied; logins didn’t transfer'));
}
function showCopyWsMenu(srcWs, x, y) {
  const others = workspaces.filter(w => w.id !== srcWs.id);
  if (!others.length) { showMini('Create another workspace to copy into'); return; }
  showMenu(others.map(w => ({ label: 'Copy to “' + w.name + '”', fn: () => copyWorkspaceData(srcWs.id, w.id) })), x, y);
}
function switchWorkspace(id) {
  if (!workspaces.some(w => w.id === id)) return;
  activeWsId = id;
  ensureWs(id);
  saveWorkspaces();
  applyTheme(wsTheme(id));   // set theme BEFORE any tab is created so its start page is tinted correctly
  if (pendingByWs[id]) {
    const list = pendingByWs[id]; delete pendingByWs[id];
    let act = null;
    list.forEach(s => { const t = makeTab(id, s.url, s.pinned); if (s.active) act = t.id; });
    if (act) activeTabByWs[id] = act;
  }
  const mine = tabs.filter(t => t.wsId === id);
  if (mine.length) {
    const remembered = activeTabByWs[id];
    activateTab((remembered && mine.some(t => t.id === remembered)) ? remembered : mine[mine.length - 1].id);
  } else {
    createTab();
  }
  renderWsSwitcher();
  renderBookmarks();
  saveSession();
}
function doCreateWorkspace(name) {
  if (workspaces.length >= MAX_WS) { showMini('Up to ' + MAX_WS + ' workspaces'); hideNewInput(); $('ws-menu').classList.add('hidden'); return; }
  const id = 'ws' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  workspaces.push({ id, name: name, theme: freeTheme() });   // claim the first free color
  saveWorkspaces();
  hideNewInput();
  $('ws-menu').classList.add('hidden');
  switchWorkspace(id);
}
function confirmModal(message, okLabel) {
  return new Promise((resolve) => {
    closeCtxMenu();
    const ov = document.createElement('div'); ov.className = 'confirm-ov';
    const card = document.createElement('div'); card.className = 'confirm-card';
    const msg = document.createElement('p'); msg.className = 'confirm-msg'; msg.textContent = message; card.appendChild(msg);
    const row = document.createElement('div'); row.className = 'confirm-row';
    const cancel = document.createElement('button'); cancel.className = 'action-btn'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.className = 'action-btn' + (okLabel ? '' : ' action-danger'); ok.textContent = okLabel || 'Remove';
    row.append(cancel, ok); card.appendChild(row); ov.appendChild(card); document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
  });
}
async function removeWorkspace(id) {
  if (workspaces.length <= 1) return;
  if (!(await confirmModal('Remove this workspace? Its open tabs close, but its saved logins stay on disk and return if you recreate it.'))) return;
  tabs.filter(t => t.wsId === id).forEach(t => t.view.remove());
  tabs = tabs.filter(t => t.wsId !== id);
  delete activeTabByWs[id];
  workspaces = workspaces.filter(w => w.id !== id);
  if (activeWsId === id) { activeWsId = workspaces[0].id; saveWorkspaces(); switchWorkspace(workspaces[0].id); }
  else { saveWorkspaces(); renderWsSwitcher(); }
  saveSession();
}
function showNewInput() { const i = $('ws-new-input'); i.classList.remove('hidden'); $('ws-new').classList.add('hidden'); i.value = ''; setTimeout(() => i.focus(), 0); }
function hideNewInput() { $('ws-new-input').classList.add('hidden'); $('ws-new').classList.remove('hidden'); }
function reorderWs(fromId, toId) {
  const from = workspaces.findIndex(w => w.id === fromId); if (from < 0) return;
  const moved = workspaces.splice(from, 1)[0];
  let to = workspaces.findIndex(w => w.id === toId); if (to < 0) to = workspaces.length;
  workspaces.splice(to, 0, moved);
  saveWorkspaces(); renderWsSwitcher();
}
function startRenameWs(ws, nmEl) {
  const inp = document.createElement('input'); inp.className = 'ws-rename'; inp.value = ws.name; inp.maxLength = 24; inp.spellcheck = false;
  nmEl.replaceWith(inp); setTimeout(() => { inp.focus(); inp.select(); }, 0);
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) { ws.name = v; saveWorkspaces(); } renderWsSwitcher(); };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderWsSwitcher(); } });
  inp.addEventListener('blur', commit);
  inp.addEventListener('click', (e) => e.stopPropagation());
}

$('ws-current').addEventListener('click', (e) => { e.stopPropagation(); $('ws-menu').classList.toggle('hidden'); });
$('ws-menu').addEventListener('click', (e) => e.stopPropagation());
$('ws-new').addEventListener('click', (e) => { e.stopPropagation(); showNewInput(); });
$('ws-new-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCreateWorkspace((e.target.value.trim()) || ('Workspace ' + (workspaces.length + 1)));
  else if (e.key === 'Escape') hideNewInput();
});

/* ---------- settings ---------- */
const settings = $('settings');
$('nav-settings').addEventListener('click', () => { settings.classList.remove('hidden'); collapseAllBlocks(); renderProviderSetting(); renderAdblockStatus(); renderTrusted(); renderDefaultBrowser(); renderAiSettings(); renderImport(); });
function renderDefaultBrowser() {
  const st = $('default-browser-status'); if (!st || !window.materia.defaultBrowserStatus) return;
  window.materia.defaultBrowserStatus().then(s => {
    if (!s || !s.supported) { st.textContent = 'Available on Windows.'; st.style.color = 'var(--ink-faint)'; return; }
    if (!s.packaged) { st.textContent = 'Available in the installed app (not in dev mode).'; st.style.color = 'var(--ink-faint)'; return; }
    st.textContent = s.isDefault ? '● Slash is your default browser.' : '○ Not currently the default.';
    st.style.color = s.isDefault ? 'var(--teal)' : 'var(--ink-faint)';
  }).catch(() => {});
}
{ const b = $('set-default-browser'); if (b) b.addEventListener('click', () => {
  if (!window.materia.setDefaultBrowser) return;
  window.materia.setDefaultBrowser().then(r => {
    if (r && r.reason === 'dev') showMini('Works in the installed app — not in dev');
    else if (r && r.reason === 'win-only') showMini('Windows only');
    else showMini('In Default apps, pick “Slash Browser” for Web browser');
    setTimeout(renderDefaultBrowser, 2000);
  }).catch(() => {});
}); }
function renderTrusted() {
  const list = $('trust-list'); if (!list || !window.materia.getTrusted) return;
  window.materia.getTrusted().then(hosts => {
    list.innerHTML = '';
    if (!hosts.length) { const e = document.createElement('p'); e.className = 'set-note'; e.style.margin = '0'; e.textContent = 'No trusted sites yet.'; list.appendChild(e); return; }
    hosts.sort().forEach(h => {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;background:var(--bg);border:1px solid var(--line);border-radius:7px';
      const name = document.createElement('span'); name.textContent = h; name.style.cssText = 'font-size:12.5px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      const rm = document.createElement('button'); rm.className = 'iconbtn'; rm.textContent = '✕'; rm.title = 'Remove from trusted'; rm.style.flex = 'none';
      rm.addEventListener('click', () => { window.materia.removeTrusted(h).then(renderTrusted); });
      row.appendChild(name); row.appendChild(rm); list.appendChild(row);
    });
  });
}
function addTrustedFromInput() { const i = $('trust-input'); if (!i) return; const v = i.value.trim(); if (!v) return; window.materia.addTrusted(v).then(() => { i.value = ''; renderTrusted(); }); }
{ const b = $('trust-add'); if (b) b.addEventListener('click', addTrustedFromInput); const i = $('trust-input'); if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTrustedFromInput(); } }); }
function renderAdblockStatus() {
  const el = $('adblock-status'); if (!el || !window.materia.adblockStatus) return;
  window.materia.adblockStatus().then(s => {
    if (!s) return;
    const map = { active: 'Active', loading: 'Loading filter lists…', failed: 'Failed to load lists — built-in tracker list still active' };
    el.textContent = '● Adblocker: ' + (map[s.status] || s.status) + (s.status === 'active' ? '  ·  ' + (s.blocked || 0) + ' blocked this session' : '');
    el.style.color = s.status === 'active' ? 'var(--teal)' : (s.status === 'failed' ? '#e8a13a' : 'var(--ink-faint)');
  }).catch(() => {});
}
function renderProviderSetting() {
  const sel = $('provider-select'); if (!sel) return;
  let cur = 'ddg'; try { cur = window.materia.getProvider() || 'ddg'; } catch (_) {}
  sel.innerHTML = '';
  [['Search', ['ddg', 'startpage', 'brave', 'google', 'bing']], ['AI', ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity']]].forEach(g => {
    const og = document.createElement('optgroup'); og.label = g[0];
    g[1].forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = (OMNI_PROVIDERS[id] || {}).name || id; if (id === cur) o.selected = true; og.appendChild(o); });
    sel.appendChild(og);
  });
}
{ const s = $('provider-select'); if (s) s.addEventListener('change', (e) => { try { window.materia.setProvider(e.target.value); } catch (_) {} }); }
$('settings-close').addEventListener('click', () => settings.classList.add('hidden'));
settings.addEventListener('click', (e) => { if (e.target === settings) settings.classList.add('hidden'); });
document.addEventListener('click', () => { $('ws-menu').classList.add('hidden'); hideNewInput(); closeCtxMenu(); if ($('soc-overflow')) $('soc-overflow').classList.remove('open'); if ($('folder-pop')) $('folder-pop').classList.remove('open'); if ($('folder-pop-2')) $('folder-pop-2').classList.remove('open'); });
// while a tab is being dragged, mark the whole window a valid move-target so the OS "no-drop" cursor never shows
document.addEventListener('dragover', (e) => { if (dragTabId != null) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} } });
// clicking into a page blurs the chrome (webview clicks don't bubble here) — close transient menus then too
window.addEventListener('blur', () => { closeCtxMenu(); $('ws-menu').classList.add('hidden'); if ($('soc-overflow')) $('soc-overflow').classList.remove('open'); if ($('folder-pop')) $('folder-pop').classList.remove('open'); if ($('folder-pop-2')) $('folder-pop-2').classList.remove('open'); });

window.materia.getSettings().then(s => {
  $('toggle-trackers').checked = !!s.blockTrackers; updateShield(s.blockTrackers);
  if ($('lang-select')) $('lang-select').value = s.language || 'en-US';
});
{ const ls = $('lang-select'); if (ls) ls.addEventListener('change', (e) => { window.materia.setLanguage(e.target.value); showMini('Language set — new pages will use it (restart to apply everywhere)'); }); }
$('toggle-trackers').addEventListener('change', (e) => { window.materia.setBlockTrackers(e.target.checked).then(updateShield); });
function updateShield(on) {
  const s = $('omni-shield'); if (!s) return;
  s.classList.remove('hidden'); s.classList.toggle('off', !on);
  s.title = on ? 'Ad & tracker blocking ON — click to turn off' : 'Ad & tracker blocking OFF — click to turn on';
}
$('omni-shield').addEventListener('click', (e) => { e.stopPropagation(); const next = !$('toggle-trackers').checked; window.materia.setBlockTrackers(next).then(v => { $('toggle-trackers').checked = v; updateShield(v); }); });

/* color schemes */
function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'materia';
  currentTheme = name;
  if (name === 'materia') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  const w = activeWs(); if (w) { w.theme = name; saveWorkspaces(); }   // theme is per-workspace
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.t === name));
  renderWsSwitcher();   // re-tint the orb to this workspace's accent
  tabs.forEach(t => { if (isNewtab(t.url)) { try { t.view.executeJavaScript('window.__setTheme && window.__setTheme(' + JSON.stringify(name) + ')', true); } catch (_) {} } });
}
$('theme-swatches').addEventListener('click', (e) => { const sw = e.target.closest('.swatch'); if (sw) applyTheme(sw.dataset.t); });

/* force right-click */
$('toggle-rightclick').checked = forceRightClick;
$('toggle-rightclick').addEventListener('change', (e) => {
  forceRightClick = e.target.checked;
  localStorage.setItem('materia-rightclick', forceRightClick ? '1' : '0');
});

/* clear data — targets the ACTIVE workspace's partition */
function flashStatus(msg) { const s = $('clear-status'); s.textContent = msg; s.classList.add('show'); setTimeout(() => s.classList.remove('show'), 2600); }
$('clear-keep').addEventListener('click', async () => { await window.materia.clearData(wsPartition(activeWsId), true); flashStatus('✓ Cleared — your logins in this workspace are intact.'); });
$('clear-all').addEventListener('click', async () => { await window.materia.clearData(wsPartition(activeWsId), false); flashStatus('✓ Everything cleared. Signed out of this workspace.'); });

/* ---------- popups & new-tab links ---------- */
// a link the user clicked: open a tab (foreground unless it was a ctrl/background click)
window.materia.onOpenTab((data) => {
  const url = data && data.url;
  if (data && data.background) { makeTab(activeWsId, url); renderTabs(); saveSession(); }   // ctrl/middle-click or right-click "open in new tab" → stay put
  else { createTab(url); }   // a link/button that opened a tab → switch to it
});
// another window dropped a LIVE tab onto this one → adopt its view (no reload)
window.materia.onAdoptTab((d) => { try { adoptTab(d); } catch (_) {} });
// start page sent a query to an AI: open it in the current tab and prefill once loaded
window.materia.onAIQuery((d) => { const t = activeTab(); if (!t || !d || !d.url) return; t._pendingAI = (d.query || ''); t.view.loadURL(d.url); });
// the AI assistant asked to bookmark a page (its bookmark_page tool)
if (window.materia.onAiBookmark) window.materia.onAiBookmark((d) => { try { if (d && d.url) addBookmark({ url: d.url, title: d.title || d.url }); } catch (_) {} });
// a scripted pop-up: ask non-intrusively, in case it was intentional (OAuth, share…)
window.materia.onPopupBlocked((url) => showPopupToast(url));
function showPopupToast(url) {
  const bar = $('popup-toast'); if (!bar) return;
  let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
  $('popup-toast-host').textContent = host;
  showPopupToast._open = url;
  bar.classList.add('show');
  clearTimeout(showPopupToast._t);
  showPopupToast._t = setTimeout(() => bar.classList.remove('show'), 12000);
}
$('popup-toast-open').addEventListener('click', () => { const u = showPopupToast._open; $('popup-toast').classList.remove('show'); if (u) createTab(u); });
$('popup-toast-dismiss').addEventListener('click', () => $('popup-toast').classList.remove('show'));

/* ---------- bookmarks (pinned socials are global; saved bookmarks are per-workspace) ---------- */
let bookmarks = {}; // { wsId: [ item ] } — item = bookmark {url,title,favicon} OR folder {folder:true,name,items:[]}
let dragBm = null;  // bookmark being dragged
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5a2 2 0 0 1 2-2h3.2l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FOLDER_PLUS_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5a2 2 0 0 1 2-2h3.2l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="9.5" y1="13.5" x2="14.5" y2="13.5"/></svg>';
function loadBookmarks() { try { bookmarks = JSON.parse(localStorage.getItem('materia-bookmarks')) || {}; } catch (_) { bookmarks = {}; } }
function saveBookmarks() { try { localStorage.setItem('materia-bookmarks', JSON.stringify(bookmarks)); } catch (_) {} }
function wsBookmarks() { return bookmarks[activeWsId] || (bookmarks[activeWsId] = []); }
function removeBmAnywhere(b) {
  const a = wsBookmarks(); let i = a.indexOf(b); if (i >= 0) { a.splice(i, 1); return; }
  for (let k = 0; k < a.length; k++) {
    if (!a[k].folder) continue;
    const arr = a[k].items || []; const j = arr.indexOf(b); if (j >= 0) { arr.splice(j, 1); return; }
    for (let m = 0; m < arr.length; m++) { if (arr[m].folder) { const sub = arr[m].items || []; const s = sub.indexOf(b); if (s >= 0) { sub.splice(s, 1); return; } } }   // one level deeper
  }
}
function bmInItems(items, url) { return (items || []).some(b => b.folder ? (b.items || []).some(x => x.url === url) : b.url === url); }
function isBookmarked(url) { return !!url && bmInItems(wsBookmarks(), url); }
function addBookmark(tab) {
  if (!tab || isNewtab(tab.url) || isBookmarked(tab.url)) return;
  wsBookmarks().push({ url: tab.url, title: tab.title || tab.url, favicon: tab.favicon || null });
  saveBookmarks(); renderBookmarks(); updateStar();
}
function removeBookmark(url) {
  const arr = wsBookmarks();
  for (let i = arr.length - 1; i >= 0; i--) { const it = arr[i]; if (it.folder) { it.items = (it.items || []).filter(b => { if (b.folder) { b.items = (b.items || []).filter(x => x.url !== url); return true; } return b.url !== url; }); } else if (it.url === url) { arr.splice(i, 1); } }
  saveBookmarks(); renderBookmarks(); updateStar();
}
function toggleBookmark() { const t = activeTab(); if (!t || isNewtab(t.url)) return; isBookmarked(t.url) ? removeBookmark(t.url) : addBookmark(t); }
function openBookmark(url, newTab) { if (newTab) { makeTab(activeWsId, url); renderTabs(); saveSession(); } else { const t = activeTab(); t ? t.view.loadURL(url) : createTab(url); } }
// open a URL the way the MarrowMyth button does: reuse a blank new-tab page if you're on one, otherwise spawn a fresh tab
function openInNewTab(url) { const t = activeTab(); if (t && isNewtab(t.url)) t.view.loadURL(url); else createTab(url); }
function bmFav(b) { if (b.favicon) { const img = document.createElement('img'); img.src = b.favicon; img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'bm-fav-ph' })); return img; } return Object.assign(document.createElement('span'), { className: 'bm-fav-ph' }); }
function makeBookmarkEl(b) {
  const el = document.createElement('button'); el.className = 'bm-item'; el.title = b.url; el.draggable = true;
  el.appendChild(bmFav(b));
  const tt = document.createElement('span'); tt.className = 'bm-title'; tt.textContent = b.title; el.appendChild(tt);
  const x = document.createElement('span'); x.className = 'bm-x'; x.textContent = '✕'; x.title = 'Remove';
  x.addEventListener('click', (e) => { e.stopPropagation(); const a = wsBookmarks(); const i = a.indexOf(b); if (i >= 0) a.splice(i, 1); saveBookmarks(); renderBookmarks(); updateStar(); });
  el.appendChild(x);
  el.addEventListener('click', () => openBookmark(b.url, false));
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openBookmark(b.url, true); } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); startRenameItem(b, el); });
  el.addEventListener('dragstart', (e) => { dragBm = b; el.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.url); } catch (_) {} });
  el.addEventListener('dragend', () => { dragBm = null; el.classList.remove('dragging'); });
  el.addEventListener('dragover', (e) => { if (dragBm && dragBm !== b) { e.preventDefault(); el.classList.add('drop-before'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
  el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-before'); if (dragBm && dragBm !== b) { removeBmAnywhere(dragBm); const a = wsBookmarks(); let idx = a.indexOf(b); if (idx < 0) idx = a.length; a.splice(idx, 0, dragBm); saveBookmarks(); renderBookmarks(); if ($('folder-pop')) $('folder-pop').classList.remove('open'); } dragBm = null; });
  return el;
}
function makeFolderChip(f) {
  if (!f.items) f.items = [];
  const el = document.createElement('button'); el.className = 'bm-folder'; el.title = f.name + ' (' + f.items.length + ')';
  const ic = document.createElement('span'); ic.className = 'bm-folder-ic'; ic.innerHTML = FOLDER_SVG; el.appendChild(ic);
  const tt = document.createElement('span'); tt.className = 'bm-title'; tt.textContent = f.name; el.appendChild(tt);
  el.addEventListener('click', (e) => { e.stopPropagation(); openFolder(f, el); });
  el.addEventListener('mouseenter', () => { const p = $('folder-pop'); if (p && p.classList.contains('open') && p._f !== f) openFolder(f, el); });   // once a folder is open, hovering another switches to it
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showFolderMenu(f, el, e.clientX, e.clientY); });
  el.draggable = true;
  el.addEventListener('dragstart', (e) => { dragBm = f; el.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', f.name); } catch (_) {} });
  el.addEventListener('dragend', () => { dragBm = null; el.classList.remove('dragging'); });
  el.addEventListener('dragover', (e) => { if (dragBm && dragBm !== f) { e.preventDefault(); el.classList.add('drop-hover'); } });   // drop ONTO a folder = file / nest into it
  el.addEventListener('dragleave', () => { el.classList.remove('drop-hover'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-hover');
    if (dragBm && dragBm !== f) {
      if (dragBm.folder) {
        if ((dragBm.items || []).some(x => x.folder)) showMini('That folder has subfolders — can’t nest (one level max)');
        else { removeBmAnywhere(dragBm); f.items.push(dragBm); }   // nest as a subfolder
      } else { removeBmAnywhere(dragBm); f.items.push(dragBm); }   // file bookmark into folder
      saveBookmarks(); renderBookmarks(); closeFolderPops();
    }
    dragBm = null;
  });
  return el;
}
// a bookmark row inside a folder/sub-folder popup. ownerItems = the array it lives in; refresh() re-renders that popup.
function makeFpBookmarkRow(b, ownerItems, refresh) {
  const row = document.createElement('button'); row.className = 'fp-item'; row.title = b.url;
  row.appendChild(bmFav(b));
  const tt = document.createElement('span'); tt.className = 'bm-title'; tt.textContent = b.title; row.appendChild(tt);
  const x = document.createElement('span'); x.className = 'bm-x'; x.textContent = '✕'; x.title = 'Remove';
  x.addEventListener('click', (e) => { e.stopPropagation(); const i = ownerItems.indexOf(b); if (i >= 0) ownerItems.splice(i, 1); saveBookmarks(); renderBookmarks(); refresh(); });
  row.appendChild(x);
  row.addEventListener('click', () => { closeFolderPops(); openBookmark(b.url, false); });
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { dragBm = b; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.url); } catch (_) {} });
  row.addEventListener('dragend', () => { dragBm = null; });
  row.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeFolderPops(); openBookmark(b.url, true); } });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); startRenameItem(b, row, refresh); });
  row.addEventListener('dragover', (e) => { if (dragBm && dragBm !== b && !dragBm.folder) { e.preventDefault(); row.classList.add('drop-before'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
  row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-before'); if (dragBm && dragBm !== b && !dragBm.folder) { removeBmAnywhere(dragBm); let idx = ownerItems.indexOf(b); if (idx < 0) idx = ownerItems.length; ownerItems.splice(idx, 0, dragBm); saveBookmarks(); renderBookmarks(); refresh(); } dragBm = null; });
  return row;
}
// a sub-folder row inside a top-level folder's popup. Click → second pop-out; drop a bookmark → file into it.
function makeFpSubfolderRow(sf, parent, pop) {
  if (!sf.items) sf.items = [];
  const row = document.createElement('button'); row.className = 'fp-item fp-folder'; row.title = sf.name + ' (' + sf.items.length + ')';
  const ic = document.createElement('span'); ic.className = 'bm-folder-ic'; ic.innerHTML = FOLDER_SVG; row.appendChild(ic);
  const tt = document.createElement('span'); tt.className = 'bm-title'; tt.textContent = sf.name; row.appendChild(tt);
  const car = document.createElement('span'); car.className = 'fp-caret'; car.textContent = '›'; row.appendChild(car);
  row.addEventListener('click', (e) => { e.stopPropagation(); openSubFolder(sf, row); });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showSubfolderMenu(sf, parent, row, pop, e.clientX, e.clientY); });
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { dragBm = sf; try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {} });
  row.addEventListener('dragend', () => { dragBm = null; });
  row.addEventListener('dragover', (e) => { if (dragBm && dragBm !== sf && !dragBm.folder) { e.preventDefault(); row.classList.add('drop-hover'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop-hover'));
  row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-hover'); if (dragBm && !dragBm.folder) { removeBmAnywhere(dragBm); sf.items.push(dragBm); saveBookmarks(); renderBookmarks(); fillFolderPop(pop, parent); } dragBm = null; });
  return row;
}
function showSubfolderMenu(sf, parent, row, pop, x, y) {
  showMenu([
    { label: 'Rename folder', fn: () => startRenameItem(sf, row, () => fillFolderPop(pop, parent)) },
    { label: 'Move out to bar', fn: () => { const i = parent.items.indexOf(sf); if (i >= 0) parent.items.splice(i, 1); wsBookmarks().push(sf); saveBookmarks(); renderBookmarks(); fillFolderPop(pop, parent); closeSubPop(); } },
    { label: 'Empty into this folder', fn: () => { const i = parent.items.indexOf(sf); if (i >= 0) parent.items.splice.apply(parent.items, [i, 1].concat(sf.items || [])); saveBookmarks(); renderBookmarks(); fillFolderPop(pop, parent); closeSubPop(); } },
    { label: 'Delete folder', fn: () => { const i = parent.items.indexOf(sf); if (i >= 0) parent.items.splice(i, 1); saveBookmarks(); renderBookmarks(); fillFolderPop(pop, parent); closeSubPop(); } }
  ], x, y);
}
function fillFolderPop(pop, f) {
  pop.innerHTML = ''; closeSubPop();
  if (!f.items.length) { const e = document.createElement('div'); e.className = 'fp-empty'; e.textContent = 'Empty — drag bookmarks or a folder here'; pop.appendChild(e); return; }
  f.items.forEach(it => {
    if (it.folder) pop.appendChild(makeFpSubfolderRow(it, f, pop));
    else pop.appendChild(makeFpBookmarkRow(it, f.items, () => fillFolderPop(pop, f)));
  });
}
function fillSubFolderPop(pop2, sf) {
  pop2.innerHTML = ''; if (!sf.items) sf.items = [];
  if (!sf.items.length) { const e = document.createElement('div'); e.className = 'fp-empty'; e.textContent = 'Empty — drag bookmarks here'; pop2.appendChild(e); return; }
  sf.items.forEach(b => pop2.appendChild(makeFpBookmarkRow(b, sf.items, () => fillSubFolderPop(pop2, sf))));
}
function closeSubPop() { const p = $('folder-pop-2'); if (p) p.classList.remove('open'); }
function closeFolderPops() { const a = $('folder-pop'), b = $('folder-pop-2'); if (a) a.classList.remove('open'); if (b) b.classList.remove('open'); }
function openSubFolder(sf, anchorRow) {
  let pop2 = $('folder-pop-2');
  if (!pop2) {
    pop2 = document.createElement('div'); pop2.id = 'folder-pop-2'; pop2.className = 'folder-pop'; document.body.appendChild(pop2);
    pop2.addEventListener('click', (e) => e.stopPropagation());
    pop2.addEventListener('dragover', (e) => { if (dragBm && !dragBm.folder) { e.preventDefault(); pop2.classList.add('fp-drop'); } });
    pop2.addEventListener('dragleave', () => pop2.classList.remove('fp-drop'));
    pop2.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); pop2.classList.remove('fp-drop'); const sf2 = pop2._sf; if (dragBm && !dragBm.folder && sf2) { removeBmAnywhere(dragBm); (sf2.items || (sf2.items = [])).push(dragBm); saveBookmarks(); renderBookmarks(); fillSubFolderPop(pop2, sf2); } dragBm = null; });
  }
  if (pop2.classList.contains('open') && pop2._sf === sf) { pop2.classList.remove('open'); return; }
  pop2._sf = sf; fillSubFolderPop(pop2, sf);
  const r = anchorRow.getBoundingClientRect();
  let left = r.right + 3; if (left > window.innerWidth - 244) left = Math.max(8, r.left - 244);
  pop2.style.left = left + 'px'; pop2.style.top = Math.min(r.top, window.innerHeight - 220) + 'px';
  pop2.classList.add('open');
}
function openFolder(f, anchor) {
  let pop = $('folder-pop');
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'folder-pop'; pop.className = 'folder-pop'; document.body.appendChild(pop);
    pop.addEventListener('click', (e) => e.stopPropagation());
    // drop a bookmark anywhere in the open popup → file it into this folder
    pop.addEventListener('dragover', (e) => { if (dragBm && !dragBm.folder) { e.preventDefault(); pop.classList.add('fp-drop'); } });
    pop.addEventListener('dragleave', () => pop.classList.remove('fp-drop'));
    pop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); pop.classList.remove('fp-drop'); const f = pop._f; if (dragBm && !dragBm.folder && f) { removeBmAnywhere(dragBm); f.items.push(dragBm); saveBookmarks(); renderBookmarks(); fillFolderPop(pop, f); } dragBm = null; });
  }
  if (pop.classList.contains('open') && pop._f === f) { pop.classList.remove('open'); closeSubPop(); return; }
  pop._f = f; fillFolderPop(pop, f);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 256)) + 'px';
  pop.style.top = (r.bottom + 5) + 'px';
  pop.classList.add('open');
}
function addFolder() {
  const f = { folder: true, name: 'New Folder', items: [] };
  wsBookmarks().push(f); saveBookmarks(); renderBookmarks();
  const chips = $('bm-list').querySelectorAll('.bm-folder');
  if (chips.length) startRenameItem(f, chips[chips.length - 1]);
}
function showFolderMenu(f, el, x, y) {
  showMenu([
    { label: 'Rename folder', fn: () => startRenameItem(f, el) },
    { label: 'Empty onto bar', fn: () => { const a = wsBookmarks(); const i = a.indexOf(f); if (i >= 0) a.splice.apply(a, [i, 1].concat(f.items)); saveBookmarks(); renderBookmarks(); } },
    { label: 'Delete folder', fn: () => { const a = wsBookmarks(); const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); saveBookmarks(); renderBookmarks(); } }
  ], x, y);
}
function showAddMenu(x, y) {
  showMenu([
    { label: 'Add bookmark (this page)', fn: () => { const t = activeTab(); if (t && !isNewtab(t.url)) addBookmark(t); else showMini('Open a page to bookmark it'); } },
    { label: 'Add folder', fn: () => addFolder() }
  ], x, y);
}
function renderBookmarks() {
  const list = $('bm-list'); if (!list) return;
  list.innerHTML = '';
  const items = wsBookmarks();
  if (!items.length) { const e = document.createElement('span'); e.className = 'bm-empty'; e.textContent = 'Right-click the bar to add a bookmark or folder'; list.appendChild(e); return; }
  items.forEach(it => { list.appendChild(it.folder ? makeFolderChip(it) : makeBookmarkEl(it)); });
}
function startRenameItem(item, el, onAfter) {
  const tt = el.querySelector('.bm-title'); if (!tt) return;
  const inp = document.createElement('input'); inp.className = 'bm-rename'; inp.value = item.folder ? item.name : item.title; inp.spellcheck = false;
  tt.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const refresh = () => { renderBookmarks(); if (onAfter) { try { onAfter(); } catch (_) {} } };   // onAfter re-fills the folder popup so renames there show immediately
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) { if (item.folder) item.name = v; else item.title = v; saveBookmarks(); } refresh(); };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; refresh(); } });
  inp.addEventListener('blur', commit);
  inp.addEventListener('click', (e) => e.stopPropagation());
}
function updateStar() {
  const s = $('bm-star'); if (!s) return;
  const t = activeTab(); const on = !!(t && !isNewtab(t.url) && isBookmarked(t.url));
  s.textContent = on ? '★' : '☆';
  s.classList.toggle('active', on);
}
$('bm-star').addEventListener('click', toggleBookmark);
$('bm-list').addEventListener('contextmenu', (e) => { e.preventDefault(); showAddMenu(e.clientX, e.clientY); });
$('bm-list').addEventListener('dragover', (e) => { if (dragBm) e.preventDefault(); });
$('bm-list').addEventListener('drop', (e) => { e.preventDefault(); if (dragBm) { removeBmAnywhere(dragBm); wsBookmarks().push(dragBm); saveBookmarks(); renderBookmarks(); if ($('folder-pop')) $('folder-pop').classList.remove('open'); } dragBm = null; });

/* ---------- your socials (filled in Settings → Your Socials; shown on the bar's right) ---------- */
let socialLinks = {};
function loadSocialLinks() { try { socialLinks = JSON.parse(localStorage.getItem('materia-socials')) || {}; } catch (_) { socialLinks = {}; } }
function saveSocialLinks() { try { localStorage.setItem('materia-socials', JSON.stringify(socialLinks)); } catch (_) {} }
function socIconSVG(s, size) { if (s.svg) return s.svg.replace(/__SIZE__/g, size); return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor"><path d="' + s.path + '"/></svg>'; }
function socNormUrl(u) { return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, ''); }
function makeSocBtn(s) {
  const url = (socialLinks[s.key] || '').trim();
  const b = document.createElement('button'); b.className = 'bm-soc'; b.title = s.name + ' — ' + url;
  b.innerHTML = socIconSVG(s, 18);
  b.addEventListener('click', () => openInNewTab(socNormUrl(url)));
  b.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openInNewTab(socNormUrl(url)); } });
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); window.materia.copyText(socNormUrl(url)); showMini('Copied ' + s.name + ' link'); });
  return b;
}
function renderSocialBar() {
  const bar = $('bm-socials'); if (!bar) return;
  bar.innerHTML = '';
  const populated = (window.SOCIALS_DATA || []).filter(s => (socialLinks[s.key] || '').trim());
  populated.slice(0, 10).forEach(s => bar.appendChild(makeSocBtn(s)));
  const overflow = populated.slice(10);
  if (overflow.length) {
    const more = document.createElement('button'); more.className = 'bm-soc bm-soc-more'; more.title = overflow.length + ' more';
    more.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    more.addEventListener('click', (e) => { e.stopPropagation(); toggleSocOverflow(overflow, more); });
    bar.appendChild(more);
  }
}
function toggleSocOverflow(list, anchor) {
  let pop = $('soc-overflow');
  if (!pop) { pop = document.createElement('div'); pop.id = 'soc-overflow'; pop.className = 'soc-overflow'; document.body.appendChild(pop); pop.addEventListener('click', (e) => e.stopPropagation()); }
  if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
  pop.innerHTML = '';
  list.forEach(s => {
    const url = (socialLinks[s.key] || '').trim();
    const row = document.createElement('button'); row.className = 'soc-ov-item'; row.title = s.name + ' — ' + url;
    const ic = document.createElement('span'); ic.className = 'soc-ov-ic'; ic.innerHTML = socIconSVG(s, 16);
    const nm = document.createElement('span'); nm.textContent = s.name;
    row.append(ic, nm);
    row.addEventListener('click', () => { pop.classList.remove('open'); openInNewTab(socNormUrl(url)); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); window.materia.copyText(socNormUrl(url)); showMini('Copied ' + s.name + ' link'); });
    pop.appendChild(row);
  });
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - 100, window.innerWidth - 230)) + 'px';
  pop.style.top = (r.bottom + 5) + 'px';
  pop.classList.add('open');
}
function renderSocialsSettings() {
  const box = $('socials-settings'); if (!box) return;
  box.innerHTML = '';
  (window.SOCIALS_DATA || []).forEach(s => {
    const row = document.createElement('div'); row.className = 'soc-row';
    const ic = document.createElement('span'); ic.className = 'soc-row-ic'; ic.innerHTML = socIconSVG(s, 19); row.appendChild(ic);
    const nm = document.createElement('span'); nm.className = 'soc-row-nm'; nm.textContent = s.name; row.appendChild(nm);
    const inp = document.createElement('input'); inp.className = 'soc-row-input'; inp.type = 'text'; inp.spellcheck = false;
    inp.placeholder = 'Paste your ' + s.name + ' link';
    inp.value = socialLinks[s.key] || '';
    inp.addEventListener('input', () => { const v = inp.value.trim(); if (v) socialLinks[s.key] = v; else delete socialLinks[s.key]; saveSocialLinks(); renderSocialBar(); });
    row.appendChild(inp);
    box.appendChild(row);
  });
}

/* ---------- zoom (manual + scale-with-window) ---------- */
let pageZoom = parseFloat(localStorage.getItem('materia-zoom')) || 1;
let scaleWithWindow = localStorage.getItem('materia-scalewin') === '1';
function windowScale() { return scaleWithWindow ? Math.max(0.6, Math.min(1.6, window.innerWidth / 1366)) : 1; }
function effectiveZoom() { return Math.round(pageZoom * windowScale() * 100) / 100; }
function applyZoom() { const z = effectiveZoom(); tabs.forEach(t => { try { t.view.setZoomFactor(z); } catch (_) {} }); }
function setZoom(z) { pageZoom = Math.max(0.3, Math.min(3, Math.round(z * 100) / 100)); localStorage.setItem('materia-zoom', String(pageZoom)); applyZoom(); showMini('Zoom ' + Math.round(pageZoom * 100) + '%'); }
let _zrt = null;
window.addEventListener('resize', () => { clearTimeout(_zrt); _zrt = setTimeout(applyZoom, 120); });
window.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(pageZoom + (e.deltaY < 0 ? 0.1 : -0.1)); } }, { passive: false });
$('toggle-scale').checked = scaleWithWindow;
$('toggle-scale').addEventListener('change', (e) => { scaleWithWindow = e.target.checked; localStorage.setItem('materia-scalewin', scaleWithWindow ? '1' : '0'); applyZoom(); });

let _miniTmr = null;
function showMini(msg) { const m = $('mini-toast'); if (!m) return; m.textContent = msg; m.classList.add('show'); clearTimeout(_miniTmr); _miniTmr = setTimeout(() => m.classList.remove('show'), 1400); }

/* ---------- collapsible settings sections (always start collapsed each open) ---------- */
function collapseAllBlocks() { document.querySelectorAll('#settings .set-block').forEach(blk => { if (blk.querySelector('.set-heading')) blk.classList.add('collapsed'); }); }
(function () {
  document.querySelectorAll('#settings .set-block').forEach(blk => {
    const h = blk.querySelector('.set-heading'); if (!h) return;
    h.addEventListener('click', () => blk.classList.toggle('collapsed'));
  });
  collapseAllBlocks();
})();

/* ---------- tab reorder / switch / reopen / mute ---------- */
function reorderTab(fromId, toId) {
  const from = tabs.findIndex(t => t.id === fromId); if (from < 0) return;
  const dragged = tabs.splice(from, 1)[0];
  let to = tabs.findIndex(t => t.id === toId); if (to < 0) to = tabs.length;
  tabs.splice(to, 0, dragged);
  renderTabs(); saveSession();
}
function visibleTabs() { return wsTabs().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); }
function jumpToTab(n) { const v = visibleTabs(); const t = (n >= 9) ? v[v.length - 1] : v[n - 1]; if (t) activateTab(t.id); }
function cycleTab() { const v = visibleTabs(); if (!v.length) return; const i = v.findIndex(t => t.id === activeId); activateTab(v[(i + 1) % v.length].id); }
function reopenClosed() { if (closedTabs.length) reopenSpecificClosed(closedTabs[closedTabs.length - 1]); }
function reopenSpecificClosed(c) {
  const i = closedTabs.lastIndexOf(c); if (i >= 0) closedTabs.splice(i, 1);
  if (c.wsId && c.wsId !== activeWsId && workspaces.some(w => w.id === c.wsId)) switchWorkspace(c.wsId);
  const t = createTab(c.url);
  if (c.pinned) { t.pinned = true; renderTabs(); saveSession(); }
}
function toggleMute(t) { t.muted = !t.muted; try { t.view.setAudioMuted(t.muted); } catch (_) {} renderTabs(); showMini(t.muted ? 'Tab muted' : 'Tab unmuted'); }

/* ---------- find in page ---------- */
function showFind() { const fb = $('findbar'); if (!fb) return; fb.classList.remove('hidden'); try { layoutViews(); } catch (_) {} const i = $('find-input'); i.focus(); i.select(); if (i.value.trim()) doFind(i.value); }
function hideFind() { const fb = $('findbar'); if (fb) fb.classList.add('hidden'); try { layoutViews(); } catch (_) {} const t = activeTab(); if (t) { try { t.view.stopFindInPage('clearSelection'); } catch (_) {} } const c = $('find-count'); if (c) c.textContent = ''; }
function doFind(text) { const t = activeTab(); const c = $('find-count'); if (!t || !text.trim()) { if (c) c.textContent = ''; try { t && t.view.stopFindInPage('clearSelection'); } catch (_) {} return; } try { t.view.findInPage(text); } catch (_) {} }
function findNext(forward) { const t = activeTab(); const text = ($('find-input') || {}).value || ''; if (!t || !text.trim()) return; try { t.view.findInPage(text, { findNext: true, forward: forward }); } catch (_) {} }
{ const i = $('find-input'); if (i) { i.addEventListener('input', () => doFind(i.value)); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(!e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); hideFind(); } }); } }
{ const b = $('find-next'); if (b) b.addEventListener('click', () => findNext(true)); }
{ const b = $('find-prev'); if (b) b.addEventListener('click', () => findNext(false)); }
{ const b = $('find-close'); if (b) b.addEventListener('click', hideFind); }

/* ---------- keyboard / global shortcuts (also fire while a page is focused, via main) ---------- */
function handleShortcut(cmd) {
  if (cmd === 'newtab') createTab();
  else if (cmd === 'closetab') { if (activeId) closeTab(activeId); }
  else if (cmd === 'focusomni') focusOmni();
  else if (cmd === 'reload') { const t = activeTab(); if (t) t.view.reload(); }
  else if (cmd === 'find') showFind();
  else if (cmd === 'ai') toggleAi();
  else if (cmd === 'reopentab') reopenClosed();
  else if (cmd === 'fullscreen') { try { window.materia.toggleFullscreen(); } catch (_) {} }
  else if (cmd === 'nexttab') cycleTab();
  else if (/^tab[1-9]$/.test(cmd)) jumpToTab(parseInt(cmd.slice(3), 10));
  else if (cmd === 'zoomin') setZoom(pageZoom + 0.1);
  else if (cmd === 'zoomout') setZoom(pageZoom - 0.1);
  else if (cmd === 'zoomreset') setZoom(1);
  else if (cmd === 'back') { const t = activeTab(); if (t) { try { t.view.goBack(); } catch (_) {} } }
  else if (cmd === 'forward') { const t = activeTab(); if (t) { try { t.view.goForward(); } catch (_) {} } }
  else if (cmd === 'bookmark') toggleBookmark();
  else if (cmd === 'print') { const t = activeTab(); if (t && !isNewtab(t.url)) { try { t.view.print(); } catch (_) {} } }
}

/* ---------- command palette (Ctrl+K): a native overlay over Materia's own commands ---------- */
const palEl = $('palette'), palInput = $('pal-input'), palList = $('pal-list');
let palItems = [], palSel = 0;
function isPalOpen() { return !!(palEl && !palEl.classList.contains('hidden')); }
function palHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url || ''; } }
function palCommands() {
  const out = [];
  out.push({ ico: '+', title: 'New tab', sub: 'Ctrl+T', run: () => createTab() });
  out.push({ ico: '↻', title: 'Reload page', sub: 'Ctrl+R', run: () => { const t = activeTab(); if (t) t.view.reload(); } });
  out.push({ ico: '★', title: 'Bookmark this page', sub: 'Ctrl+D', run: () => toggleBookmark() });
  out.push({ ico: '/', title: 'Toggle AI assistant', sub: 'Ctrl+J', run: () => { try { toggleAi(); } catch (_) {} } });
  if (typeof toggleReader === 'function') out.push({ ico: '☷', title: 'Reader mode', sub: 'F9', run: () => toggleReader() });
  out.push({ ico: '⚙', title: 'Settings', run: () => { settings.classList.remove('hidden'); try { collapseAllBlocks(); renderProviderSetting(); renderAdblockStatus(); renderTrusted(); renderDefaultBrowser(); renderAiSettings(); renderImport(); } catch (_) {} } });
  out.push({ ico: '✕', title: 'Close current tab', sub: 'Ctrl+W', run: () => { if (activeId) closeTab(activeId); } });
  wsTabs().forEach(t => { if (t.id !== activeId && !isNewtab(t.url)) out.push({ ico: '▢', title: t.title || palHost(t.url), sub: palHost(t.url), run: () => activateTab(t.id) }); });
  (workspaces || []).forEach(w => { if (w.id !== activeWsId) out.push({ ico: '◧', title: 'Go to workspace: ' + w.name, run: () => switchWorkspace(w.id) }); });
  (wsBookmarks() || []).forEach(b => { if (b && !b.folder) out.push({ ico: '★', title: b.title || b.url, sub: palHost(b.url), run: () => openInNewTab(b.url) }); });
  return out;
}
function palFilter(q) {
  q = (q || '').trim();
  let items = palCommands();
  if (q) {
    const lq = q.toLowerCase();
    items = items.filter(c => ((c.title || '') + ' ' + (c.sub || '')).toLowerCase().indexOf(lq) !== -1);
    if (/^https?:\/\/|^[\w-]+(\.[\w-]+)+(\/|$)/i.test(q)) items.push({ ico: '↗', title: 'Open ' + q, run: () => { let u = q; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; createTab(u); } });
    items.push({ ico: '⌕', title: 'Search the web for "' + q + '"', run: () => { const u = resolveQuery(q); if (u) createTab(u); } });
  }
  return items;
}
function renderPal() {
  palList.innerHTML = '';
  if (!palItems.length) { const e = document.createElement('div'); e.className = 'pal-empty'; e.textContent = 'No matches'; palList.appendChild(e); return; }
  palItems.forEach((c, i) => {
    const el = document.createElement('div'); el.className = 'pal-item' + (i === palSel ? ' sel' : ''); el.setAttribute('role', 'option');
    const ico = document.createElement('span'); ico.className = 'pal-ico'; ico.textContent = c.ico || ''; el.appendChild(ico);
    const ti = document.createElement('span'); ti.className = 'pal-title'; ti.textContent = c.title; el.appendChild(ti);
    if (c.sub) { const s = document.createElement('span'); s.className = 'pal-sub'; s.textContent = c.sub; el.appendChild(s); }
    el.addEventListener('mousemove', () => { if (palSel !== i) { palSel = i; syncPalSel(); } });
    el.addEventListener('click', () => runPal(i));
    palList.appendChild(el);
  });
  const sel = palList.children[palSel]; if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}
function syncPalSel() { Array.from(palList.children).forEach((el, i) => el.classList.toggle('sel', i === palSel)); }
function openPalette() {
  if (!palEl) return;
  palEl.classList.remove('hidden'); palInput.value = ''; palItems = palFilter(''); palSel = 0; renderPal(); applyChrome();
  setTimeout(() => { try { palInput.focus(); } catch (_) {} try { window.materia.focusChrome(); } catch (_) {} }, 0);
}
function closePalette() { if (!palEl) return; palEl.classList.add('hidden'); applyChrome(); }
function runPal(i) { const c = palItems[i]; closePalette(); if (c && c.run) try { c.run(); } catch (_) {} }
if (palInput) {
  palInput.addEventListener('input', () => { palItems = palFilter(palInput.value); palSel = 0; renderPal(); });
  palInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); renderPal(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
}
if (palEl) palEl.addEventListener('mousedown', (e) => { if (e.target === palEl) closePalette(); });

/* ---------- reader mode (F9): extract the article as SAFE STRUCTURED TEXT (never page HTML) ---------- */
const READER_EXTRACT_JS = `(() => {
  try {
    const doc = document;
    const metaTitle = doc.querySelector('meta[property="og:title"]');
    const title = (metaTitle && metaTitle.content) || doc.title || '';
    const scoreOf = (el) => {
      let s = 0;
      el.querySelectorAll('p').forEach((p) => { const len = ((p.innerText) || '').trim().length; if (len > 25) s += Math.min(3, len / 100) + 1; });
      return s;
    };
    let best = null, bestScore = 0;
    const cands = [].slice.call(doc.querySelectorAll('article, main, [role=main], .post, .article, .entry-content, .post-content, #content, .content'));
    for (const el of cands) { const s = scoreOf(el); if (s > bestScore) { bestScore = s; best = el; } }
    if (!best || bestScore < 3) { const all = [].slice.call(doc.querySelectorAll('div, section')); for (const el of all) { const s = scoreOf(el); if (s > bestScore) { bestScore = s; best = el; } } }
    if (!best) best = doc.body;
    const SKIP = /^(nav|aside|footer|header|form|button|script|style|noscript|svg|iframe|figcaption)$/i;
    const blocks = [];
    const pushText = (t, txt) => { txt = (txt || '').replace(/\\s+/g, ' ').trim(); if (txt) blocks.push({ t: t, text: txt }); };
    const walk = (el, depth) => {
      if (depth > 12) return;
      for (const node of el.children) {
        const tag = node.tagName.toLowerCase();
        if (SKIP.test(tag)) continue;
        let cs; try { cs = getComputedStyle(node); } catch (e) { cs = null; }
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        if (/^h[1-6]$/.test(tag)) pushText(tag, node.innerText);
        else if (tag === 'p') pushText('p', node.innerText);
        else if (tag === 'blockquote') pushText('quote', node.innerText);
        else if (tag === 'pre') { const t = node.innerText; if (t && t.trim()) blocks.push({ t: 'pre', text: t }); }
        else if (tag === 'ul' || tag === 'ol') { for (const li of node.querySelectorAll(':scope > li')) pushText('li', li.innerText); }
        else if (tag === 'img' || tag === 'figure') { const img = tag === 'img' ? node : node.querySelector('img'); const src = img && (img.currentSrc || img.src); if (src && /^https:/i.test(src) && ((img.naturalWidth || 300) > 200)) blocks.push({ t: 'img', src: src }); }
        else if (node.children.length) walk(node, depth + 1);
        else pushText('p', node.innerText);
      }
    };
    walk(best, 0);
    const out = [];
    for (const b of blocks) { if (out.length && out[out.length - 1].text && out[out.length - 1].text === b.text) continue; out.push(b); if (out.length > 400) break; }
    if (out.filter((b) => b.t === 'p').length < 2) return null;
    const authorMeta = doc.querySelector('meta[name=author]');
    const byline = (authorMeta && authorMeta.content) || '';
    return { title: title, byline: (byline || '').trim().slice(0, 120), url: location.href, blocks: out };
  } catch (e) { return null; }
})()`;
function isReaderOpen() { const r = $('reader'); return !!(r && !r.classList.contains('hidden')); }
function closeReader() { const r = $('reader'); if (r) r.classList.add('hidden'); applyChrome(); }
function renderReader(article) {
  const body = $('reader-body'); if (!body) return;
  body.innerHTML = '';
  const h = document.createElement('h1'); h.className = 'rd-title'; h.textContent = article.title || 'Reader'; body.appendChild(h);
  if (article.byline) { const by = document.createElement('div'); by.className = 'rd-byline'; by.textContent = article.byline; body.appendChild(by); }
  if (article.url) { const s = document.createElement('div'); s.className = 'rd-src'; s.textContent = palHost(article.url); body.appendChild(s); }
  (article.blocks || []).forEach((b) => {
    if (b.t === 'img') { if (b.src) { const im = document.createElement('img'); im.className = 'rd-img'; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = b.src; body.appendChild(im); } return; }
    let el;
    if (/^h[1-6]$/.test(b.t)) el = document.createElement(b.t);
    else if (b.t === 'quote') el = document.createElement('blockquote');
    else if (b.t === 'pre') el = document.createElement('pre');
    else if (b.t === 'li') { el = document.createElement('div'); el.className = 'rd-li'; }
    else el = document.createElement('p');
    el.textContent = b.text || '';
    body.appendChild(el);
  });
}
async function toggleReader() {
  if (isReaderOpen()) return closeReader();
  const t = activeTab();
  if (!t || isNewtab(t.url)) { showMini('Open a page to read it'); return; }
  let article = null;
  try { article = await t.view.executeJavaScript(READER_EXTRACT_JS, true); } catch (_) {}
  if (!article || !article.blocks || !article.blocks.length) { showMini('No readable article found'); return; }
  renderReader(article);
  const r = $('reader'); if (r) r.classList.remove('hidden');
  const sc = $('reader-scroll'); if (sc) sc.scrollTop = 0;
  applyChrome();
}
{ const rc = $('reader-close'); if (rc) rc.addEventListener('click', () => closeReader()); }

/* ---------- AI settings block inside Materia's Settings panel (same store as the AI panel gear) ---------- */
async function renderAiSettings() {
  let s = null;
  try { s = await window.materia.aiSettingsGet(); } catch (_) {}
  if (!s) return;
  const prov = (s.selection && s.selection.provider) || 'claude';
  const variant = (s.selection && s.selection.variant) || 'cli';
  document.querySelectorAll('#ai-set-provider .ai-seg-btn').forEach(b => b.classList.toggle('on', b.dataset.p === prov));
  document.querySelectorAll('#ai-set-variant .ai-seg-btn').forEach(b => b.classList.toggle('on', b.dataset.v === variant));
  const keys = s.apiKeys || {};
  const put = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  put('ai-key-anthropic', keys.anthropic); put('ai-key-google', keys.google); put('ai-key-openai', keys.openai);
  const st = $('ai-set-status'); if (st) st.textContent = '';
}
(function wireAiSettings() {
  const seg = (sel) => document.querySelectorAll(sel + ' .ai-seg-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll(sel + ' .ai-seg-btn').forEach(x => x.classList.remove('on')); b.classList.add('on');
  }));
  seg('#ai-set-provider'); seg('#ai-set-variant');
  const save = $('ai-set-save');
  if (save) save.addEventListener('click', async () => {
    const provBtn = document.querySelector('#ai-set-provider .ai-seg-btn.on');
    const varBtn = document.querySelector('#ai-set-variant .ai-seg-btn.on');
    const patch = {
      selection: { provider: (provBtn && provBtn.dataset.p) || 'claude', variant: (varBtn && varBtn.dataset.v) || 'cli' },
      apiKeys: {
        anthropic: (($('ai-key-anthropic') || {}).value || '').trim(),
        google: (($('ai-key-google') || {}).value || '').trim(),
        openai: (($('ai-key-openai') || {}).value || '').trim(),
      },
    };
    const st = $('ai-set-status');
    try { await window.materia.aiSettingsSet(patch); if (st) st.textContent = '✓ Saved'; }
    catch (_) { if (st) st.textContent = 'Could not save'; }
    setTimeout(() => { if (st) st.textContent = ''; }, 2500);
  });
})();

/* ---------- import bookmarks from another browser (Settings) ---------- */
async function renderImport() {
  const box = $('import-sources'); if (!box) return;
  box.innerHTML = '<p class="import-empty">Looking for other browsers…</p>';
  let sources = [];
  try { sources = await window.materia.importSources(); } catch (_) {}
  if (!sources || !sources.length) { box.innerHTML = '<p class="import-empty">No other browsers with bookmarks were found.</p>'; return; }
  box.innerHTML = '';
  sources.forEach((s) => {
    const row = document.createElement('div'); row.className = 'import-row';
    const label = document.createElement('span'); label.className = 'import-label';
    const b = document.createElement('b'); b.textContent = s.name + (s.profile && s.profile !== 'Default' ? ' (' + s.profile + ')' : '');
    label.appendChild(b);
    label.appendChild(document.createTextNode(' · ' + s.count + ' bookmark' + (s.count === 1 ? '' : 's')));
    const btn = document.createElement('button'); btn.className = 'set-btn'; btn.type = 'button'; btn.textContent = 'Import';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Importing…';
      let marks = [];
      try { marks = await window.materia.importBookmarks(s.id); } catch (_) {}
      const added = importBookmarksIntoWs(marks, s.name);
      btn.textContent = added > 0 ? ('Added ' + added) : 'Nothing new';
      setTimeout(() => { btn.textContent = 'Import'; btn.disabled = false; }, 2200);
    });
    row.appendChild(label); row.appendChild(btn); box.appendChild(row);
  });
}
function importBookmarksIntoWs(marks, browserName) {
  if (!Array.isArray(marks) || !marks.length) return 0;
  const arr = wsBookmarks();
  const folderName = 'Imported from ' + browserName;
  let folder = arr.find((x) => x.folder && x.name === folderName);
  if (!folder) { folder = { folder: true, name: folderName, items: [] }; arr.push(folder); }
  const existing = new Set(folder.items.map((i) => i.url));
  let added = 0;
  for (const m of marks) {
    if (!m || !m.url || existing.has(m.url)) continue;
    folder.items.push({ url: m.url, title: m.title || m.url, favicon: null });
    existing.add(m.url); added++;
  }
  if (added) { saveBookmarks(); renderBookmarks(); if (typeof updateStar === 'function') updateStar(); }
  return added;
}

window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey; const k = e.key;
  if (k === 'F11') { e.preventDefault(); handleShortcut('fullscreen'); }
  else if (k === 'F9') { e.preventDefault(); toggleReader(); }
  else if (ctrl && e.shiftKey && k.toLowerCase() === 't') { e.preventDefault(); handleShortcut('reopentab'); }
  else if (ctrl && k === 'Tab') { e.preventDefault(); handleShortcut('nexttab'); }
  else if (ctrl && /^[1-9]$/.test(k)) { e.preventDefault(); handleShortcut('tab' + k); }
  else if (ctrl && k.toLowerCase() === 't') { e.preventDefault(); handleShortcut('newtab'); }
  else if (ctrl && k.toLowerCase() === 'w') { e.preventDefault(); handleShortcut('closetab'); }
  else if (ctrl && k.toLowerCase() === 'l') { e.preventDefault(); handleShortcut('focusomni'); }
  else if (ctrl && k.toLowerCase() === 'r') { e.preventDefault(); handleShortcut('reload'); }
  else if (ctrl && k.toLowerCase() === 'f') { e.preventDefault(); handleShortcut('find'); }
  else if (ctrl && k.toLowerCase() === 'k') { e.preventDefault(); isPalOpen() ? closePalette() : openPalette(); }
  else if (ctrl && k.toLowerCase() === 'd') { e.preventDefault(); handleShortcut('bookmark'); }
  else if (ctrl && k.toLowerCase() === 'p') { e.preventDefault(); handleShortcut('print'); }
  else if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); handleShortcut('zoomin'); }
  else if (ctrl && k === '-') { e.preventDefault(); handleShortcut('zoomout'); }
  else if (ctrl && k === '0') { e.preventDefault(); handleShortcut('zoomreset'); }
  else if (k === 'Escape' && isReaderOpen()) { e.preventDefault(); closeReader(); }
  else if (k === 'Escape') { closeCtxMenu(); if (document.body.classList.contains('fullscreen')) { try { window.materia.toggleFullscreen(); } catch (_) {} } else if ($('findbar') && !$('findbar').classList.contains('hidden')) hideFind(); else { settings.classList.add('hidden'); if ($('list-panel')) $('list-panel').classList.add('hidden'); if ($('notes-panel')) $('notes-panel').classList.add('hidden'); } }
});
window.materia.onShortcut(handleShortcut);
// right-click the empty area of the tab strip → reopen recently closed tabs (Ctrl+Shift+T still works)
tabsEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const items = [{ label: 'New tab', fn: () => createTab() }];
  const recent = closedTabs.slice(-8).reverse();
  if (recent.length) {
    items.push({ label: 'Reopen closed tab', fn: () => reopenClosed() });
    recent.forEach((c) => { let h = c.url; try { h = new URL(c.url).hostname.replace(/^www\./, ''); } catch (_) {} items.push({ label: '↺ ' + (h.length > 32 ? h.slice(0, 32) + '…' : h), fn: () => reopenSpecificClosed(c) }); });
  } else {
    items.push({ label: 'No recently closed tabs', fn: () => {} });
  }
  showMenu(items, e.clientX, e.clientY);
});
window.materia.onZoomWheel((dir) => setZoom(pageZoom + (dir === 'in' ? 0.1 : -0.1)));
window.materia.onWinState(() => {});
window.materia.onFullscreen((on) => { document.body.classList.toggle('fullscreen', !!on); try { layoutViews(); } catch (_) {} });

/* ---------- history + downloads ---------- */
let history = [];
function loadHistory() { try { history = JSON.parse(localStorage.getItem('materia-history')) || []; } catch (_) { history = []; } }
function saveHistory() { try { localStorage.setItem('materia-history', JSON.stringify(history.slice(0, 600))); } catch (_) {} }
function histHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } }
function addHistory(url, title) {
  if (!url || isNewtab(url) || /^(view-source|about|data):/i.test(url)) return;
  if (history.length && history[0].url === url) { history[0].time = Date.now(); if (title) history[0].title = title; saveHistory(); return; }
  history.unshift({ url: url, title: title || url, time: Date.now() });
  if (history.length > 600) history.length = 600;
  saveHistory(); renderHistory();
}
function clearHistory() { history = []; saveHistory(); renderHistory(); }
function renderHistory() {
  const box = $('history-list'); if (!box) return;
  box.innerHTML = '';
  if (!history.length) { box.innerHTML = '<p class="list-empty">No history yet.</p>'; return; }
  history.slice(0, 200).forEach(h => {
    const row = document.createElement('button'); row.className = 'list-row'; row.title = h.url;
    const tt = document.createElement('span'); tt.className = 'list-title'; tt.textContent = h.title || h.url;
    const sub = document.createElement('span'); sub.className = 'list-sub'; sub.textContent = histHost(h.url);
    row.append(tt, sub);
    row.addEventListener('click', () => { settings.classList.add('hidden'); createTab(h.url); });
    box.appendChild(row);
  });
}
let downloads = [];
function loadDownloads() { try { downloads = JSON.parse(localStorage.getItem('materia-downloads')) || []; } catch (_) { downloads = []; } }
function saveDownloads() { try { localStorage.setItem('materia-downloads', JSON.stringify(downloads.slice(0, 100))); } catch (_) {} }
function clearDownloads() { downloads = []; saveDownloads(); renderDownloads(); }
function onDownloadEvent(d) {
  const i = downloads.findIndex(x => x.id === d.id);
  if (i >= 0) downloads[i] = d; else downloads.unshift(d);
  saveDownloads(); renderDownloads();
  if (d.state === 'completed') showMini('✓ Downloaded ' + d.name);
  else if (d.state === 'interrupted' || d.state === 'cancelled') showMini('Download failed — ' + d.name);
}
function renderDownloads() {
  const box = $('downloads-list'); if (!box) return;
  box.innerHTML = '';
  if (!downloads.length) { box.innerHTML = '<p class="list-empty">No downloads yet.</p>'; return; }
  downloads.slice(0, 80).forEach(d => {
    const row = document.createElement('div'); row.className = 'list-row dl-row';
    const tt = document.createElement('span'); tt.className = 'list-title'; tt.textContent = d.name;
    const sub = document.createElement('span'); sub.className = 'list-sub';
    if (d.state === 'completed') sub.textContent = 'Done';
    else if (d.state === 'progress') sub.textContent = d.total ? Math.round(d.received / d.total * 100) + '%' : 'Downloading…';
    else sub.textContent = d.state || '';
    row.append(tt, sub);
    if (d.state === 'completed') { row.classList.add('done'); row.title = 'Open · right-click to show in folder'; row.addEventListener('click', () => window.materia.openPath(d.path)); row.addEventListener('contextmenu', (e) => { e.preventDefault(); window.materia.showItem(d.path); }); }
    box.appendChild(row);
  });
}
async function renderDlDirs() {
  const box = $('dl-dirs'); if (!box || !window.materia.getDlDirs) return;
  let dirs; try { dirs = await window.materia.getDlDirs(); } catch (_) { return; }
  box.innerHTML = '';
  [['video', 'Videos'], ['image', 'Images'], ['audio', 'Audio'], ['other', 'Other files']].forEach(pair => {
    const k = pair[0];
    const row = document.createElement('div'); row.className = 'dl-dir';
    const nm = document.createElement('span'); nm.className = 'dl-dir-label'; nm.textContent = pair[1];
    const p = document.createElement('span'); p.className = 'dl-dir-path'; p.textContent = dirs[k]; p.title = dirs[k];
    const ch = document.createElement('button'); ch.className = 'dl-dir-btn'; ch.textContent = 'Change';
    ch.addEventListener('click', async () => { const np = await window.materia.pickDlDir(k); if (np) renderDlDirs(); });
    const rs = document.createElement('button'); rs.className = 'dl-dir-btn'; rs.textContent = 'Reset'; rs.title = 'Reset to Downloads';
    rs.addEventListener('click', async () => { await window.materia.resetDlDir(k); renderDlDirs(); });
    row.append(nm, p, ch, rs);
    box.appendChild(row);
  });
}
window.materia.onDownload(onDownloadEvent);
let listClearKind = 'history';
function openList(kind) {
  settings.classList.add('hidden');
  listClearKind = kind;
  if ($('list-title')) $('list-title').textContent = kind === 'history' ? 'Browsing history' : 'Downloads';
  const ht = $('history-list'), dt = $('downloads-list');
  if (ht) ht.style.display = kind === 'history' ? '' : 'none';
  if (dt) dt.style.display = kind === 'downloads' ? '' : 'none';
  (kind === 'history' ? renderHistory : renderDownloads)();
  $('list-panel').classList.remove('hidden');
}
{ const b = $('open-history'); if (b) b.addEventListener('click', () => openList('history')); }
{ const b = $('open-downloads'); if (b) b.addEventListener('click', () => openList('downloads')); }
{ const b = $('list-close'); if (b) b.addEventListener('click', () => $('list-panel').classList.add('hidden')); }
{ const b = $('list-clear'); if (b) b.addEventListener('click', () => { (listClearKind === 'history' ? clearHistory : clearDownloads)(); }); }
{ const lp = $('list-panel'); if (lp) lp.addEventListener('click', (e) => { if (e.target === lp) lp.classList.add('hidden'); }); }
{ const b = $('info-report'); if (b) b.addEventListener('click', () => { settings.classList.add('hidden'); try { window.materia.openExternal('mailto:PoweredbyMateria@gmail.com?subject=' + encodeURIComponent('Slash Browser — Bug Report') + '&body=' + encodeURIComponent('\n\n—\nSlash Browser v' + ((window.materia && window.materia.appVersion) || ''))); } catch (_) {} }); }
{ const v = (window.materia && window.materia.appVersion) || ''; if (v) document.querySelectorAll('.ver').forEach((el) => { el.textContent = 'v' + v; }); }   // keep the info-panel version label in sync with the running build

/* ---------- Notes & reminders ---------- */
let notesData = { tabs: [], notes: [], activeTab: null, showBtn: true };
let editingNoteId = null;
let notesTimer = null;
const NOTE_CLOCK = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>';
function loadNotes() {
  try { const d = JSON.parse(localStorage.getItem('materia-notes')); if (d && typeof d === 'object') notesData = Object.assign(notesData, d); } catch (_) {}
  if (!Array.isArray(notesData.tabs) || !notesData.tabs.length) notesData.tabs = [{ id: 'general', name: 'General' }];
  if (!Array.isArray(notesData.notes)) notesData.notes = [];
  if (typeof notesData.showBtn !== 'boolean') notesData.showBtn = true;
  if (!notesData.tabs.some(t => t.id === notesData.activeTab)) notesData.activeTab = notesData.tabs[0].id;
}
function saveNotes() { try { localStorage.setItem('materia-notes', JSON.stringify(notesData)); } catch (_) {} }
function noteId() { return 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36); }
function noteOverdue(n) { return !!(n.due && Date.now() >= n.due); }
function anyOverdue() { return notesData.notes.some(noteOverdue); }
function dueLabel(ms) { try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } }
function toLocalInput(ms) { if (!ms) return ''; const d = new Date(ms), p = x => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function fromLocalInput(v) { if (!v) return null; const t = new Date(v).getTime(); return isNaN(t) ? null : t; }
function updateNotesGlow() {
  const nb = $('nav-notes'), gear = $('nav-settings');
  [nb, gear].forEach(b => b && b.classList.remove('glow'));
  if (!anyOverdue()) return;
  const target = notesData.showBtn ? nb : gear;   // hidden Notes button → glow the gear instead
  if (target) target.classList.add('glow');
}
function checkReminders() {
  let changed = false; const now = Date.now();
  notesData.notes.forEach(n => {
    if (!n.due || now < n.due || n.notified) return;
    // fire the OS notification ONCE per occurrence (catches up if it came due while the browser was closed);
    // the persistent GLOW then carries the reminder until you open Notes — so nothing is missed by being closed.
    n.notified = true; changed = true;
    try { window.materia.notify({ title: n.title || 'Reminder', body: n.body || (n.repeat === 'daily' ? 'Daily reminder.' : 'A Slash note reminder is due.') }); } catch (_) {}
  });
  if (changed) { saveNotes(); if (!$('notes-panel').classList.contains('hidden')) renderNotesGrid(); }
  updateNotesGlow();
}
// opening Notes = "I've seen them": daily reminders roll to their next occurrence so the glow clears (one-time
// notes keep glowing until you delete them — they're real undone tasks). Skips days missed while closed.
function acknowledgeReminders() {
  let changed = false; const now = Date.now();
  notesData.notes.forEach(n => {
    if (n.repeat === 'daily' && n.due && now >= n.due) { let d = n.due; while (d <= now) d += 86400000; n.due = d; n.notified = false; changed = true; }
  });
  if (changed) saveNotes();
  updateNotesGlow();
}
function startNotesTimer() { if (notesTimer) clearInterval(notesTimer); checkReminders(); notesTimer = setInterval(checkReminders, 20000); }
function applyNotesBtnVisibility() { const nb = $('nav-notes'); if (nb) nb.style.display = notesData.showBtn ? '' : 'none'; updateNotesGlow(); }
function renameNotesTab(tab, el) {
  const inp = document.createElement('input'); inp.className = 'notes-tab-rename'; inp.value = tab.name; inp.spellcheck = false;
  el.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) tab.name = v; saveNotes(); renderNotes(); };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderNotes(); } });
  inp.addEventListener('blur', commit);
}
function showNotesTabMenu(tab, x, y) {
  const items = [{ label: 'Rename tab', fn: () => { const el = [...$('notes-tabs').children].find(c => c._tab === tab); if (el) renameNotesTab(tab, el); } }];
  if (notesData.tabs.length > 1) items.push({ label: 'Delete tab (and its notes)', fn: async () => {
    if (!(await confirmModal('Delete “' + tab.name + '” and all notes inside it?'))) return;
    notesData.notes = notesData.notes.filter(n => n.tab !== tab.id);
    notesData.tabs = notesData.tabs.filter(t => t.id !== tab.id);
    if (notesData.activeTab === tab.id) notesData.activeTab = notesData.tabs[0].id;
    saveNotes(); renderNotes(); updateNotesGlow();
  } });
  showMenu(items, x, y);
}
function renderNotesTabs() {
  const wrap = $('notes-tabs'); if (!wrap) return; wrap.innerHTML = '';
  notesData.tabs.forEach(tab => {
    const b = document.createElement('button'); b.className = 'notes-tab' + (tab.id === notesData.activeTab ? ' active' : ''); b.textContent = tab.name; b._tab = tab;
    b.addEventListener('click', () => { notesData.activeTab = tab.id; saveNotes(); renderNotes(); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showNotesTabMenu(tab, e.clientX, e.clientY); });
    wrap.appendChild(b);
  });
  const add = document.createElement('button'); add.className = 'notes-tab notes-tab-add'; add.textContent = '+'; add.title = 'New tab';
  add.addEventListener('click', () => { const t = { id: noteId(), name: 'New Tab' }; notesData.tabs.push(t); notesData.activeTab = t.id; saveNotes(); renderNotes(); const el = [...$('notes-tabs').children].find(c => c._tab === t); if (el) renameNotesTab(t, el); });
  wrap.appendChild(add);
}
function notePrio(n) { return n.priority == null ? 1 : n.priority; }   // default Normal
function renderNotesGrid() {
  const grid = $('notes-grid'); if (!grid) return; grid.innerHTML = '';
  const list = notesData.notes.filter(n => n.tab === notesData.activeTab)
    .map((n, i) => [n, i]).sort((a, b) => (notePrio(b[0]) - notePrio(a[0])) || (a[1] - b[1])).map(p => p[0]);   // higher priority first, stable otherwise
  if (!list.length) { const e = document.createElement('div'); e.className = 'notes-empty'; e.textContent = 'No notes here yet — hit “+ New note”.'; grid.appendChild(e); return; }
  list.forEach(n => {
    const chip = document.createElement('div'); chip.className = 'note-chip' + (noteOverdue(n) ? ' overdue' : '') + (n.priority === 2 ? ' prio-high' : n.priority === 0 ? ' prio-low' : '');
    const h = document.createElement('div'); h.className = 'note-chip-title'; h.textContent = n.title || '(untitled)'; chip.appendChild(h);
    if (n.body) { const bd = document.createElement('div'); bd.className = 'note-chip-body'; bd.textContent = n.body; chip.appendChild(bd); }
    if (n.due) {
      const d = document.createElement('div'); d.className = 'note-chip-due' + (noteOverdue(n) ? ' due' : ''); const sp = document.createElement('span');
      if (n.repeat === 'daily') sp.textContent = 'Daily · ' + new Date(n.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      else sp.textContent = (noteOverdue(n) ? 'Due ' : '') + dueLabel(n.due);
      d.innerHTML = NOTE_CLOCK; d.appendChild(sp); chip.appendChild(d);
    }
    const x = document.createElement('button'); x.className = 'note-chip-x'; x.textContent = '✕'; x.title = 'Delete';
    x.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });
    chip.appendChild(x);
    chip.addEventListener('click', () => openNoteEditor(n));
    grid.appendChild(chip);
  });
}
function renderNotes() { renderNotesTabs(); renderNotesGrid(); }
let _editRepeat = null;
function quickDue(when) {
  const d = new Date(); d.setSeconds(0, 0); d.setMilliseconds(0);
  if (when === 'today') { if (d.getHours() < 17) d.setHours(17, 0, 0, 0); else d.setTime(d.getTime() + 3600000); }   // later today
  else if (when === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (when === 'nextday') { d.setDate(d.getDate() + 2); d.setHours(9, 0, 0, 0); }
  else if (when === 'daily') { d.setHours(9, 0, 0, 0); }   // today's 9am — if already past, it's due NOW (glows until you open Notes), then rolls to tomorrow
  return d.getTime();
}
function refreshQuickBtns() { const q = $('note-quick'); if (q) [...q.children].forEach(b => b.classList.toggle('active', b.getAttribute('data-when') === 'daily' && _editRepeat === 'daily')); }
function openNoteEditor(note) {
  editingNoteId = note ? note.id : null;
  $('notes-tabs').classList.add('hidden'); $('notes-grid').classList.add('hidden'); $('notes-add').classList.add('hidden');
  $('notes-editor').classList.remove('hidden');
  $('note-title').value = note ? (note.title || '') : '';
  $('note-body').value = note ? (note.body || '') : '';
  $('note-due').value = note ? toLocalInput(note.due) : '';
  _editRepeat = note && note.repeat ? note.repeat : null;
  if ($('note-prio')) $('note-prio').value = String(note && note.priority != null ? note.priority : 1);
  refreshQuickBtns();
  $('note-delete').style.display = note ? '' : 'none';
  $('note-title').focus();
}
function closeNoteEditor() {
  editingNoteId = null;
  $('notes-editor').classList.add('hidden');
  $('notes-tabs').classList.remove('hidden'); $('notes-grid').classList.remove('hidden'); $('notes-add').classList.remove('hidden');
}
function saveNoteFromEditor() {
  const title = $('note-title').value.trim(), body = $('note-body').value.trim(), due = fromLocalInput($('note-due').value);
  const prio = $('note-prio') ? (parseInt($('note-prio').value, 10) || 0) : 1;
  const repeat = due ? _editRepeat : null;   // repeat only applies when there's a reminder time
  if (!title && !body) { closeNoteEditor(); renderNotes(); return; }
  let n = notesData.notes.find(x => x.id === editingNoteId);
  if (n) { n.title = title; n.body = body; n.due = due; n.priority = prio; n.repeat = repeat; }
  else { n = { id: noteId(), tab: notesData.activeTab, title: title, body: body, due: due, priority: prio, repeat: repeat }; notesData.notes.push(n); }
  n.notified = !!(due && due <= Date.now());   // a reminder set for a time already passed → glows now, but no instant pop-up (you just made it)
  saveNotes(); closeNoteEditor(); renderNotes(); updateNotesGlow();
}
function deleteNote(id) { notesData.notes = notesData.notes.filter(n => n.id !== id); saveNotes(); closeNoteEditor(); renderNotes(); updateNotesGlow(); }
function openNotesPanel() { settings.classList.add('hidden'); if ($('list-panel')) $('list-panel').classList.add('hidden'); closeNoteEditor(); $('notes-panel').classList.remove('hidden'); renderNotes(); acknowledgeReminders(); }
$('nav-notes').addEventListener('click', openNotesPanel);
$('notes-close').addEventListener('click', () => $('notes-panel').classList.add('hidden'));
$('notes-panel').addEventListener('click', (e) => { if (e.target === $('notes-panel')) $('notes-panel').classList.add('hidden'); });
$('notes-add').addEventListener('click', () => openNoteEditor(null));
$('note-save').addEventListener('click', saveNoteFromEditor);
$('note-cancel').addEventListener('click', () => closeNoteEditor());
$('note-delete').addEventListener('click', () => { if (editingNoteId) deleteNote(editingNoteId); });
$('note-due-clear').addEventListener('click', () => { $('note-due').value = ''; _editRepeat = null; refreshQuickBtns(); });
{ const q = $('note-quick'); if (q) q.addEventListener('click', (e) => { const b = e.target.closest('.note-quick-btn'); if (!b) return; const when = b.getAttribute('data-when'); $('note-due').value = toLocalInput(quickDue(when)); _editRepeat = (when === 'daily') ? 'daily' : null; refreshQuickBtns(); }); }
{ const b = $('open-notes-here'); if (b) b.addEventListener('click', openNotesPanel); }
{ const t = $('toggle-notes-btn'); if (t) t.addEventListener('change', (e) => { notesData.showBtn = e.target.checked; saveNotes(); applyNotesBtnVisibility(); }); }

/* ---------- boot ---------- */
loadWorkspaces();
const _mmQ = new URLSearchParams(location.search); const _mmTornUrl = _mmQ.get('u'); const _mmNew = _mmQ.get('nw'); const _mmAdopt = _mmQ.get('ad');   // torn-off / new window (nw = blank) / ad = adopt a live moved tab
if (_mmTornUrl || _mmNew || _mmAdopt) { IS_SECONDARY = true; const ws = _mmQ.get('ws'); if (ws && workspaces.some(w => w.id === ws)) activeWsId = ws; }
loadBookmarks();
loadSocialLinks();
loadHistory();
loadDownloads();
ensureWs(activeWsId);
applyTheme(wsTheme(activeWsId));
renderWsSwitcher();
renderBookmarks();
renderSocialBar();
renderSocialsSettings();
renderHistory();
renderDownloads();
renderDlDirs();
renderProviderSetting();
renderAdblockStatus();
loadNotes();
{ const t = $('toggle-notes-btn'); if (t) t.checked = notesData.showBtn; }
applyNotesBtnVisibility();
startNotesTimer();
if (_mmAdopt) adoptTab({ xfer: _mmAdopt, url: _mmTornUrl || '', wsId: _mmQ.get('ws') });
else if (_mmTornUrl) createTab(_mmTornUrl); else if (_mmNew) createTab(); else if (!restoreSession()) createTab();
