'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, webContents, nativeTheme, Menu, clipboard, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---- persisted prefs (read before app-ready so we can set Chromium flags) ----
const PREFS_PATH = path.join(process.env.APPDATA || process.env.HOME || '.', 'materia-browser', 'prefs.json');
function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (_) { return {}; } }
function writePrefs(p) { try { fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true }); fs.writeFileSync(PREFS_PATH, JSON.stringify(p)); } catch (_) {} }
const prefs = readPrefs();
// preferred page language — overrides the system/location locale so sites stop defaulting
// to the local language (e.g. Thai). Applied as a Chromium flag + Accept-Language header.
let acceptLang = prefs.language || 'en-US';
app.commandLine.appendSwitch('lang', acceptLang);   // navigator.language / UI locale (takes effect at launch)
function acceptLangHeader() {
  const l = acceptLang || 'en-US'; const base = l.split('-')[0]; const parts = [l];
  if (base !== l) parts.push(base + ';q=0.9');
  if (base !== 'en') parts.push('en;q=0.6');
  return parts.join(',');
}
// modest, safe speed win: chunked parallel downloads for faster large fetches
try { app.commandLine.appendSwitch('enable-features', 'ParallelDownloading'); } catch (_) {}
// Only one Materia instance may use the user-data folder at a time — a second launch
// just focuses the existing window instead of fighting over the disk cache (the cause
// of the "Unable to move/create cache · Access is denied" errors).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { try { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } } catch (_) {} });
}

// Persistent partition -> cookies/storage survive restarts, so LOGINS persist.
const configured = new Set(); // partitions whose privacy config is already attached
let blocker = null;           // @ghostery/adblocker engine (ads + trackers + cookie banners + pop-ups)
let blockerStatus = 'loading'; let blockedCount = 0;
const blockedSessions = new Set();

// ---- privacy: built-in tracker blocklist (toggleable from Settings) ----
let blockTrackers = true;
let blockAds = true;
const TRACKERS = [
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'adservice.google.', 'pagead2.googlesyndication', '/pagead/',
  'connect.facebook.net', 'facebook.com/tr', 'scorecardresearch.com', 'quantserve.com',
  'adnxs.com', 'criteo.', 'taboola.com', 'outbrain.com', 'hotjar.com', 'mixpanel.com',
  'segment.com', 'segment.io', 'amplitude.com', 'branch.io', 'bat.bing.com', 'ads-twitter.com',
  'analytics.tiktok.com', 'fullstory.com', 'mouseflow.com', 'clarity.ms', 'yandex.ru/clck',
  'app.link', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com', 'casalemedia.com',
  // classic pop-up / pop-under ad networks
  'popads.net', 'popcash.net', 'propellerads.com', 'propu.sh', 'adcash.com', 'adsterra.com',
  'onclickads', 'popunder', 'exoclick.com', 'juicyads.com', 'hilltopads.net', 'clickadu.com'
];
function isTracker(url) {
  const u = url.toLowerCase();
  return TRACKERS.some(t => u.includes(t));
}
// OAuth / "sign in with…" flows open via window.open and need a REAL popup window — one
// with window.opener so the provider can postMessage the result back. Routing them to a
// tab (no opener) breaks login (e.g. X). Detect them so they open even with pop-ups blocked.
function isAuthPopup(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com', 'facebook.com', 'x.com', 'twitter.com', 'api.twitter.com', 'discord.com', 'github.com', 'gitlab.com', 'linkedin.com', 'login.yahoo.com', 'okta.com', 'auth0.com'];
    if (AUTH_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
    // generic OAuth: an authorize endpoint that actually carries OAuth params (ad/spam URLs won't).
    // NOTE: deliberately NOT matching bare /login or /signin — that let ad pop-unders through.
    const p = u.pathname.toLowerCase(), q = u.searchParams;
    const oauthPath = /\/(oauth2?|authorize|connect\/authorize|o\/oauth2|saml2?|sso\/saml)(\/|$)/.test(p);
    const oauthParams = q.has('client_id') && (q.has('response_type') || q.has('redirect_uri') || q.has('scope'));
    return oauthPath && oauthParams;
  } catch (_) { return false; }
}
// would the ad/tracker engine block this URL? (used to vet pop-ups / new tabs, not just network requests)
function adWouldBlock(url, sourceUrl) {
  try {
    if (!blocker || !blockAds || !/^https?:/i.test(url)) return false;
    const { Request } = require('@ghostery/adblocker');
    const res = blocker.match(Request.fromRawDetails({ type: 'document', url: url, sourceUrl: sourceUrl || url }));
    return !!(res && res.match);
  } catch (_) { return false; }
}

function dlCategory(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg'].indexOf(ext) >= 0) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'heic', 'avif', 'ico'].indexOf(ext) >= 0) return 'image';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'aiff'].indexOf(ext) >= 0) return 'audio';
  return 'other';
}

const TRACK_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader', 'utm_social', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'igsh', 'twclid', 'yclid', '_openstat', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'wickedid', 'rb_clickid', 's_cid', 'ttclid', '_hsenc', '_hsmi', 'mkt_tok', 'spm', 'scm'];
function stripTrackingParams(url) {
  try {
    const u = new URL(url); let changed = false;
    TRACK_PARAMS.forEach(p => { if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; } });
    return changed ? u.toString() : url;
  } catch (_) { return url; }
}

// ---- Safe Browsing: known phishing/malware host blocklists (free, no key) ----
const SAFE_HOSTS = new Set();
const safeAllow = new Set();   // hosts the user chose to "proceed anyway" this session
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } }
async function initSafeBrowsing() {
  const lists = [
    'https://phishing.army/download/phishing_army_blocklist.txt',
    'https://urlhaus.abuse.ch/downloads/hostfile/'
  ];
  for (const url of lists) {
    try {
      const res = await fetch(url); const txt = await res.text();
      txt.split('\n').forEach(line => {
        line = line.trim(); if (!line || line[0] === '#') return;
        let host = /\s/.test(line) ? line.split(/\s+/).pop() : line;
        host = host.toLowerCase().replace(/^\*?\.?/, '').replace(/^www\./, '');
        if (host && host.indexOf('.') > 0 && host !== 'localhost' && host !== '0.0.0.0') SAFE_HOSTS.add(host);
      });
    } catch (_) {}
  }
}
function safeBlockPage(blockedUrl) {
  const host = hostOf(blockedUrl); const u = JSON.stringify(blockedUrl);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><style>'
    + 'html,body{height:100%;margin:0}body{background:#0a0d0f;color:#dae7ec;font-family:Segoe UI,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}'
    + '.card{max-width:520px;padding:40px;text-align:center}.ic{color:#e0a93a}h1{font-size:22px;margin:18px 0 8px}p{color:#9fb2b6;line-height:1.55;font-size:14px}'
    + '.host{color:#e1554d;font-family:Consolas,monospace;word-break:break-all}.row{margin-top:26px;display:flex;gap:12px;justify-content:center}'
    + 'button{padding:11px 20px;border-radius:9px;border:1px solid;cursor:pointer;font-size:13px;font-family:inherit}'
    + '#back{background:#33d1bd;color:#04221d;border-color:#33d1bd}#go{background:transparent;color:#7d8d90;border-color:#2a3437}</style></head><body><div class="card">'
    + '<svg class="ic" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    + '<h1>Dangerous site blocked</h1><p>Materia stopped you from visiting <span class="host">' + host + '</span> — it appears on a known <b>phishing / malware</b> blocklist.</p>'
    + '<div class="row"><button id="back">Back to safety</button><button id="go">Proceed anyway</button></div></div>'
    + '<script>var U=' + u + ';document.getElementById("back").onclick=function(){if(history.length>1)history.back();else location.href="about:blank"};'
    + 'document.getElementById("go").onclick=function(){location.href="https://mm.safe.proceed/?u="+encodeURIComponent(U)};</script></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function configurePartition(partition) {
  if (configured.has(partition)) return session.fromPartition(partition);
  configured.add(partition);
  const ses = session.fromPartition(partition);

  // Block trackers + hyperlink-auditing pings; strip click-tracking params; Safe Browsing.
  ses.webRequest.onBeforeRequest((details, cb) => {
    // "Proceed anyway" from the Safe Browsing interstitial → allowlist the host, then go.
    if (details.url.indexOf('https://mm.safe.proceed/') === 0) {
      try { const u = new URL(details.url).searchParams.get('u'); if (u) { safeAllow.add(hostOf(u)); return cb({ redirectURL: u }); } } catch (_) {}
      return cb({ cancel: true });
    }
    if (details.resourceType === 'ping') return cb({ cancel: true });
    // Safe Browsing: block navigations to known phishing/malware hosts.
    if (SAFE_HOSTS.size && details.resourceType === 'mainFrame' && /^https?:/.test(details.url)) {
      const h = hostOf(details.url);
      if (h && SAFE_HOSTS.has(h) && !safeAllow.has(h)) return cb({ redirectURL: safeBlockPage(details.url) });
    }
    if (blockTrackers && /^https?:/.test(details.url) && isTracker(details.url)) {
      return cb({ cancel: true });
    }
    if (details.resourceType === 'mainFrame' && details.url.indexOf('?') >= 0) {
      const clean = stripTrackingParams(details.url);
      if (clean !== details.url) return cb({ redirectURL: clean });
    }
    cb({});
  });

  // Privacy signals on every request; strip Chrome's identifying header.
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders || {};
    h['DNT'] = '1'; h['Sec-GPC'] = '1';
    h['Accept-Language'] = acceptLangHeader();   // override location-based language
    delete h['X-Client-Data']; delete h['x-client-data'];
    cb({ requestHeaders: h });
  });

  // Deny intrusive permissions by default; allow only harmless ones.
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    const allow = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock'];
    cb(allow.includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    const allow = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock'];
    return allow.includes(permission);
  });

  // downloads → save to the OS Downloads folder, report progress to the renderer
  ses.on('will-download', (e, item) => {
    const name = item.getFilename();
    let dir = (prefs.dlDirs && prefs.dlDirs[dlCategory(name)]) || app.getPath('downloads');
    try { if (!fs.existsSync(dir)) dir = app.getPath('downloads'); } catch (_) { dir = app.getPath('downloads'); }
    const savePath = path.join(dir, name);
    try { item.setSavePath(savePath); } catch (_) {}
    const id = 'd' + Date.now() + Math.floor(Math.random() * 1000);
    const url = item.getURL();
    const send = (state) => { if (win) win.webContents.send('download', { id, name: item.getFilename(), url, path: savePath, state, received: item.getReceivedBytes(), total: item.getTotalBytes() }); };
    send('progress');
    item.on('updated', (ev, st) => send(st === 'interrupted' ? 'interrupted' : 'progress'));
    item.once('done', (ev, st) => send(st));
  });

  enableBlockerOn(partition);
  return ses;
}

async function initBlocker() {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const cachePath = path.join(app.getPath('userData'), 'adblocker-engine-v2.bin');  // v2 = expanded list set (rebuild once)
  const caching = {
    path: cachePath,
    read: async (p) => { try { return await fs.promises.readFile(p); } catch (_) { return undefined; } },
    write: async (p, buf) => { try { await fs.promises.writeFile(p, buf); } catch (_) {} }
  };
  try {
    blocker = await ElectronBlocker.fromLists(fetch, [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
      'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
      'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext'
    ], {}, caching);
  } catch (e) {
    console.error('adblocker fromLists failed, trying prebuilt:', e && e.message);
    try { blocker = await ElectronBlocker.fromPrefetchedAdsAndTracking(fetch, {}, caching); } catch (e2) { console.error('adblocker prebuilt failed:', e2 && e2.message); }
  }
  if (!blocker) { blockerStatus = 'failed'; return; }
  try { blocker.on('request-blocked', () => { blockedCount++; }); } catch (_) {}
  blockerStatus = 'active';
  if (blockAds) configured.forEach(enableBlockerOn);
}
function enableBlockerOn(partition) {
  if (!blocker || !blockAds || blockedSessions.has(partition)) return;
  try { blocker.enableBlockingInSession(session.fromPartition(partition)); blockedSessions.add(partition); } catch (_) {}
}
function disableBlockerOn(partition) {
  if (!blocker || !blockedSessions.has(partition)) return;
  try { blocker.disableBlockingInSession(session.fromPartition(partition)); blockedSessions.delete(partition); } catch (_) {}
}
let win = null;   // tracks the most-recently-focused window (default target for renderer messages)
function createWindow(opts) {
  opts = opts || {};
  const w = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 480,
    frame: false,
    backgroundColor: '#061215',
    title: 'Materia Browser',
    icon: path.join(__dirname, 'assets', 'icon-white.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: true,
      sandbox: true
    }
  });
  win = w;
  // a torn-off tab/window opens fresh in its workspace; that window is ephemeral (skips session save/restore)
  if (opts.url || opts.torn) {
    const q = {}; if (opts.url) q.u = opts.url; if (opts.wsId) q.ws = opts.wsId; if (opts.torn) q.nw = '1';
    w.loadFile('index.html', { query: q });
  } else w.loadFile('index.html');
  // right-click menu for the chrome's own inputs (address bar, settings fields)
  w.webContents.on('context-menu', (e, params) => {
    const it = [];
    if (params.isEditable) {
      it.push({ role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' }, { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' });
    } else if (params.selectionText) { it.push({ role: 'copy' }); }
    if (it.length) { try { Menu.buildFromTemplate(it).popup(); } catch (_) {} }
  });
  w.on('focus', () => { win = w; });   // messages follow the window you're actually using
  w.on('maximize', () => w.webContents.send('win-state', true));
  w.on('unmaximize', () => w.webContents.send('win-state', false));
  w.on('enter-full-screen', () => w.webContents.send('fullscreen', true));
  w.on('leave-full-screen', () => w.webContents.send('fullscreen', false));
  w.on('closed', () => { if (win === w) win = null; });
  // mouse side buttons (X1/X2) → page back / forward
  w.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') { e.preventDefault(); w.webContents.send('shortcut', 'back'); }
    else if (cmd === 'browser-forward') { e.preventDefault(); w.webContents.send('shortcut', 'forward'); }
  });
  return w;
}

function isNewerVer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0), pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}
async function checkForUpdate() {
  try {
    const res = await fetch('https://api.github.com/repos/marrowmyth/Materia-browser/releases/latest', { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Materia-Browser' } });
    if (!res.ok) return;
    const data = await res.json();
    const tag = (data.tag_name || '').replace(/^v/i, '');
    if (tag && isNewerVer(tag, app.getVersion())) {
      const url = data.html_url || 'https://github.com/marrowmyth/Materia-browser/releases/latest';
      BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('update-available', { version: tag, url: url }); } catch (_) {} });
    }
  } catch (_) {}
}
app.whenReady().then(() => {
  // "VPN-grade" baseline: encrypted DNS so your ISP can't see your lookups.
  try {
    app.configureHostResolver({
      secureDnsMode: 'secure',
      secureDnsServers: ['https://dns.quad9.net/dns-query', 'https://cloudflare-dns.com/dns-query']
    });
  } catch (_) {}
  configurePartition('persist:ws-default');
  initBlocker();
  initSafeBrowsing();
  createWindow();
  setTimeout(checkForUpdate, 8000); setInterval(checkForUpdate, 6 * 3600 * 1000);   // notify when a newer release is published
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- window controls (frameless) ----
function senderWin(e) { try { return BrowserWindow.fromWebContents(e.sender) || win; } catch (_) { return win; } }
ipcMain.on('win-min', (e) => { const w = senderWin(e); if (w) w.minimize(); });
ipcMain.on('win-max', (e) => { const w = senderWin(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
ipcMain.on('win-close', (e) => { const w = senderWin(e); if (w) w.close(); });
ipcMain.handle('toggle-fullscreen', (e) => { const w = senderWin(e); if (w) w.setFullScreen(!w.isFullScreen()); return true; });
ipcMain.handle('copy-text', (e, t) => { try { clipboard.writeText(String(t || '')); } catch (_) {} return true; });
// Reclaim keyboard focus to the chrome (address bar) when a <webview> is holding it.
ipcMain.on('focus-chrome', (e) => { const w = senderWin(e); if (w) try { w.webContents.focus(); } catch (_) {} });
ipcMain.on('mm-ai-query', (e, data) => { const w = senderWin(e); if (w) w.webContents.send('ai-query', data); });
ipcMain.on('open-in-new-window', (e, data) => { try { createWindow({ url: data && data.url, wsId: data && data.wsId, torn: true }); } catch (_) {} });
// a tab dragged out of its window: dock into the window under the cursor, else tear into a new one
ipcMain.on('tab-dropped-out', (e, data) => {
  try {
    const src = BrowserWindow.fromWebContents(e.sender);
    const x = Math.round((data && data.x) || 0), y = Math.round((data && data.y) || 0);
    const target = BrowserWindow.getAllWindows().find(w => {
      if (w === src || w.isDestroyed() || !w.isVisible()) return false;
      const b = w.getBounds(); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
    });
    if (target) target.webContents.send('open-tab', { url: (data && data.url) || '', background: false });
    else createWindow({ url: data && data.url, wsId: data && data.wsId, torn: true });
  } catch (_) {}
});
// copy logins (cookies) from one workspace partition to another — independent copy afterward
ipcMain.handle('copy-workspace-cookies', async (e, fromPartition, toPartition) => {
  try {
    if (!fromPartition || !toPartition || fromPartition === toPartition) return { ok: false };
    configurePartition(toPartition);
    const from = session.fromPartition(fromPartition), to = session.fromPartition(toPartition);
    const cookies = await from.cookies.get({});
    let n = 0;
    for (const c of cookies) {
      try {
        const host = (c.domain || '').replace(/^\./, ''); if (!host) continue;
        const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
        const set = { url: url, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
        if (c.expirationDate) set.expirationDate = c.expirationDate;
        if (c.sameSite) set.sameSite = c.sameSite;
        if (c.domain && c.domain[0] === '.') set.domain = c.domain;   // domain cookie vs host-only
        await to.cookies.set(set); n++;
      } catch (_) {}
    }
    return { ok: true, count: n };
  } catch (e2) { return { ok: false, error: e2 && e2.message }; }
});
ipcMain.handle('open-external', (e, url) => shell.openExternal(url));
ipcMain.on('notify', (e, data) => { try { if (Notification.isSupported()) new Notification({ title: (data && data.title) || 'Materia', body: (data && data.body) || '' }).show(); } catch (_) {} });

// ---- native right-click context menu (Electron provides NONE by default) ----
// On-demand killer for blocking overlays / "turn off your ad blocker" walls: removes
// full-viewport fixed/absolute high-z-index layers and restores page scrolling.
const OVERLAY_REMOVER_JS = "(function(){try{var d=document,vw=innerWidth,vh=innerHeight,n=0;"
  + "[d.documentElement,d.body].forEach(function(el){if(el){el.style.setProperty('overflow','auto','important');el.style.setProperty('position','static','important');['no-scroll','noscroll','modal-open','overflow-hidden','fixed','locked','is-locked'].forEach(function(c){el.classList.remove(c);});}});"
  + "Array.prototype.slice.call(d.querySelectorAll('body *')).forEach(function(el){try{var s=getComputedStyle(el);if(s.position==='fixed'||s.position==='absolute'){var r=el.getBoundingClientRect();var z=parseInt(s.zIndex,10)||0;var coversW=r.width>=vw*0.9,coversH=r.height>=vh*0.7;var dim=(s.backgroundColor||'').indexOf('rgba(')===0||parseFloat(s.opacity)<1||(s.backdropFilter&&s.backdropFilter!=='none');if(coversW&&coversH&&(z>=1000||(dim&&z>=100))){el.remove();n++;}}}catch(e){}});"
  + "return n;}catch(e){return 0;}})();";
// "Force dark mode": drive Chromium's native auto-dark engine (the one behind
// chrome://flags/#enable-force-dark) per-tab via the page debugger. It darkens the
// page intelligently and leaves photos/media intact — NOT a blanket CSS invert — and
// it respects sites that already declare their own dark theme. Remembered per-origin.
const darkSites = new Set(prefs.darkSites || []);   // origins the user forced dark — persisted across restarts
const darkAttached = new Set();   // wc.id where WE attached the debugger to drive dark mode
function originOf(url) { try { return new URL(url).origin; } catch (_) { return null; } }
function setAutoDark(wc, on) {
  try {
    if (on) {
      if (!wc.debugger.isAttached()) { try { wc.debugger.attach('1.3'); } catch (_) { return; } darkAttached.add(wc.id); }
      if (darkAttached.has(wc.id)) wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', { enabled: true }).catch(() => {});
    } else if (darkAttached.has(wc.id)) {
      try { wc.debugger.detach(); } catch (_) {}   // detaching reverts the auto-dark override
      darkAttached.delete(wc.id);
    }
  } catch (_) {}
}
// reconcile one tab to its current origin's remembered preference
function applyDark(wc) { try { setAutoDark(wc, darkSites.has(originOf(wc.getURL()))); } catch (_) {} }
function popupContextMenu(wc, params) {
  const send = (url, background) => { if (win) win.webContents.send('open-tab', { url, background: !!background }); };
  const items = [];
  if (params.linkURL) {
    items.push({ label: 'Open link in new tab', click: () => send(params.linkURL, true) });   // explicit → background, don't steal focus
    items.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    items.push({ label: 'Save link target…', click: () => { try { wc.downloadURL(params.linkURL); } catch (_) {} } });
    items.push({ type: 'separator' });
  }
  if (params.hasImageContents) {
    items.push({ label: 'Copy image', click: () => { try { wc.copyImageAt(params.x, params.y); } catch (_) {} } });
    if (params.srcURL) { items.push({ label: 'Open image in new tab', click: () => send(params.srcURL, true) }); items.push({ label: 'Save image…', click: () => { try { wc.downloadURL(params.srcURL); } catch (_) {} } }); }
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'cut', enabled: params.editFlags.canCut });
    items.push({ role: 'copy', enabled: params.editFlags.canCopy });
    items.push({ role: 'paste', enabled: params.editFlags.canPaste });
    items.push({ role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (params.selectionText && params.selectionText.trim()) {
    const sel = params.selectionText.trim();
    items.push({ role: 'copy' });
    items.push({ label: 'Search the web for “' + (sel.length > 26 ? sel.slice(0, 26) + '…' : sel) + '”', click: () => send('https://duckduckgo.com/?q=' + encodeURIComponent(sel) + '&kp=-2', false) });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
  items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
  items.push({ label: 'Reload', click: () => wc.reload() });
  items.push({ label: 'Remove page overlays', click: () => { try { wc.executeJavaScript(OVERLAY_REMOVER_JS).catch(function(){}); } catch (_) {} } });
  const darkOrigin = originOf(wc.getURL());
  items.push({ label: (darkOrigin && darkSites.has(darkOrigin)) ? 'Disable dark mode (this site)' : 'Force dark mode (this site)', enabled: !!darkOrigin, click: () => {
    if (!darkOrigin) return;
    if (darkSites.has(darkOrigin)) darkSites.delete(darkOrigin); else darkSites.add(darkOrigin);
    prefs.darkSites = [...darkSites]; writePrefs(prefs);   // remember across tabs + restarts
    applyDark(wc);
  } });
  items.push({ type: 'separator' });
  items.push({ label: 'Download video (yt-dlp)', submenu: [
    { label: 'Best quality', click: () => { if (win) win.webContents.send('ytdlp', { url: wc.getURL(), quality: 'best' }); } },
    { label: '1080p', click: () => { if (win) win.webContents.send('ytdlp', { url: wc.getURL(), quality: '1080' }); } },
    { label: '720p', click: () => { if (win) win.webContents.send('ytdlp', { url: wc.getURL(), quality: '720' }); } },
    { label: '480p', click: () => { if (win) win.webContents.send('ytdlp', { url: wc.getURL(), quality: '480' }); } },
    { label: 'Audio only (m4a)', click: () => { if (win) win.webContents.send('ytdlp', { url: wc.getURL(), quality: 'audio' }); } }
  ] });
  items.push({ label: 'Copy page address', click: () => { try { clipboard.writeText(wc.getURL()); } catch (_) {} } });
  items.push({ label: 'Select all', click: () => { try { wc.selectAll(); } catch (_) {} } });
  items.push({ label: 'View page source', click: () => send('view-source:' + wc.getURL(), false) });
  items.push({ label: 'Print…', click: () => { try { wc.print(); } catch (_) {} } });
  items.push({ type: 'separator' });
  items.push({ label: 'Inspect element', click: () => {
    if (darkAttached.has(wc.id)) { try { wc.debugger.detach(); } catch (_) {} darkAttached.delete(wc.id); }   // free the shared protocol channel for DevTools
    try { wc.inspectElement(params.x, params.y); } catch (_) {}
  } });
  try { Menu.buildFromTemplate(items).popup(); } catch (_) {}
}

// ---- route popups / window.open into new tabs + right-click menu ----
// per-guest wiring (privacy, pop-up handling, right-click menu, shortcuts, dark mode).
// ownerWin = the window that hosts this page, so messages reach the right renderer.
function wireGuest(wc, ownerWin) {
  if (!wc || wc.__mmReg) return;
  wc.__mmReg = true;
  try { wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); } catch (_) {}
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url) && (isTracker(url) || adWouldBlock(url, wc.getURL()))) return { action: 'deny' };
    if (isAuthPopup(url)) return { action: 'allow' };
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      if (ownerWin) ownerWin.webContents.send('open-tab', { url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    }
    if (ownerWin) ownerWin.webContents.send('popup-blocked', url);
    return { action: 'deny' };
  });
  wc.on('context-menu', (e2, params) => popupContextMenu(wc, params));
  wc.once('destroyed', () => darkAttached.delete(wc.id));
  wc.on('did-navigate', () => applyDark(wc));
  wc.on('devtools-opened', () => { if (darkAttached.has(wc.id)) { try { wc.debugger.detach(); } catch (_) {} darkAttached.delete(wc.id); } });
  wc.on('devtools-closed', () => applyDark(wc));
  applyDark(wc);
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta; const k = input.key || '';
    let cmd = null;
    if (k === 'F11') cmd = 'fullscreen';
    else if (ctrl && input.shift && k.toLowerCase() === 't') cmd = 'reopentab';
    else if (ctrl && k === 'Tab') cmd = 'nexttab';
    else if (ctrl && /^[1-9]$/.test(k)) cmd = 'tab' + k;
    else if (ctrl) { const m = { t: 'newtab', w: 'closetab', l: 'focusomni', r: 'reload', f: 'find', d: 'bookmark', p: 'print', '=': 'zoomin', '+': 'zoomin', '-': 'zoomout', '0': 'zoomreset' }; cmd = m[k.toLowerCase()]; }
    if (cmd) { event.preventDefault(); if (ownerWin) ownerWin.webContents.send('shortcut', cmd); }
  });
  wc.on('zoom-changed', (e3, dir) => { if (ownerWin) ownerWin.webContents.send('zoom-wheel', dir); });
}
// legacy path (old <webview> guests register their wc id); unused once tabs are WebContentsViews
ipcMain.on('register-view', (e, wcId) => { const wc = webContents.fromId(wcId); if (wc) wireGuest(wc, BrowserWindow.fromWebContents(e.sender) || win); });

// ---- WebContentsView tab engine (each tab is a main-owned view; survives moving between windows) ----
const guestViews = new Map();   // `${windowWcId}:${vid}` -> WebContentsView
function gKey(winWcId, vid) { return winWcId + ':' + vid; }
function gResolve(e, vid) { const w = BrowserWindow.fromWebContents(e.sender); return w ? (guestViews.get(gKey(w.webContents.id, vid)) || null) : null; }
ipcMain.on('view-create', (e, o) => {
  try {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return;
    try { configurePartition(o.partition); } catch (_) {}
    const view = new WebContentsView({ webPreferences: { partition: o.partition, preload: path.join(__dirname, 'mm-nt-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true } });
    try { view.setBackgroundColor('#061215'); } catch (_) {}
    w.contentView.addChildView(view);
    view.setVisible(false);
    guestViews.set(gKey(w.webContents.id, o.vid), view);
    const wc = view.webContents;
    try { wc.setMaxListeners(40); } catch (_) {}   // we attach ~15 listeners across events per view
    wireGuest(wc, w);
    const send = (event, payload) => { try { if (!w.isDestroyed()) w.webContents.send('view-event', { vid: o.vid, event: event, payload: payload }); } catch (_) {} };
    wc.on('page-title-updated', (e2, title) => send('page-title-updated', { title: title }));
    wc.on('page-favicon-updated', (e2, favicons) => send('page-favicon-updated', { favicons: favicons }));
    wc.on('did-start-loading', () => send('did-start-loading', {}));
    wc.on('did-stop-loading', () => send('did-stop-loading', {}));
    wc.on('dom-ready', () => send('dom-ready', {}));
    wc.on('did-navigate', () => send('did-navigate', { url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }));
    wc.on('did-navigate-in-page', (e2, url, isMain) => { if (isMain) send('did-navigate-in-page', { url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }); });
    wc.on('found-in-page', (e2, result) => send('found-in-page', { result: result }));
    if (o.url) try { wc.loadURL(o.url); } catch (_) {}
  } catch (_) {}
});
ipcMain.on('view-bounds', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.setBounds({ x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) }); v.setVisible(true); } catch (_) {} });
ipcMain.on('view-hide', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.setVisible(false); } catch (_) {} });
ipcMain.on('view-destroy', (e, d) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; const k = gKey(w.webContents.id, d.vid); const v = guestViews.get(k); if (v) { try { w.contentView.removeChildView(v); } catch (_) {} try { v.webContents.destroy(); } catch (_) {} guestViews.delete(k); } });
ipcMain.on('view-nav', (e, d) => { const v = gResolve(e, d.vid); if (!v) return; const wc = v.webContents; try { if (d.action === 'load') wc.loadURL(d.url); else if (d.action === 'reload') wc.reload(); else if (d.action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); } else if (d.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); } } catch (_) {} });
ipcMain.on('view-zoom', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.setZoomFactor(d.factor); } catch (_) {} });
ipcMain.on('view-mute', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.setAudioMuted(!!d.muted); } catch (_) {} });
ipcMain.on('view-find', (e, d) => { const v = gResolve(e, d.vid); if (v) try { if (d.action === 'find') v.webContents.findInPage(d.text, d.opts || {}); else v.webContents.stopFindInPage(d.arg || 'clearSelection'); } catch (_) {} });
ipcMain.on('view-print', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.print(); } catch (_) {} });
ipcMain.on('view-css', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.insertCSS(d.css); } catch (_) {} });
ipcMain.handle('view-exec', async (e, d) => { const v = gResolve(e, d.vid); if (!v) return null; try { return await v.webContents.executeJavaScript(d.js, !!d.userGesture); } catch (_) { return null; } });

// ---- the one-press clear button ----
//  keepLogins=true  -> wipe caches + service workers, KEEP cookies + localStorage (you stay logged in)
//  keepLogins=false -> wipe absolutely everything (signs you out everywhere)
ipcMain.handle('ensure-partition', (e, partition) => { configurePartition(partition); return true; });
ipcMain.handle('clear-data', async (e, partition, keepLogins) => {
  const ses = session.fromPartition(partition);
  await ses.clearCache();
  if (keepLogins) {
    await ses.clearStorageData({
      storages: ['serviceworkers', 'cachestorage', 'shadercache', 'websql', 'filesystem']
    });
  } else {
    await ses.clearStorageData(); // includes cookies + localStorage + indexeddb
  }
  return true;
});

ipcMain.handle('set-block-trackers', (e, val) => {
  blockTrackers = !!val; blockAds = !!val;
  if (blockAds) configured.forEach(enableBlockerOn);
  else Array.from(blockedSessions).forEach(disableBlockerOn);
  return blockTrackers;
});
ipcMain.handle('get-settings', () => ({ blockTrackers, language: acceptLang }));
ipcMain.handle('set-language', (e, v) => { acceptLang = String(v || 'en-US'); prefs.language = acceptLang; writePrefs(prefs); return acceptLang; });
ipcMain.handle('adblock-status', () => ({ status: blockerStatus, blocked: blockedCount, sessions: blockedSessions.size }));
ipcMain.on('mm-get-provider', (e) => { e.returnValue = prefs.searchProvider || 'ddg'; });
ipcMain.handle('set-provider', (e, id) => { prefs.searchProvider = String(id || 'ddg'); writePrefs(prefs); return true; });
ipcMain.handle('suggest', async (e, q) => {
  q = String(q || '').trim(); if (!q) return [];
  try {
    const r = await fetch('https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list');
    const j = await r.json();
    if (Array.isArray(j) && Array.isArray(j[1])) return j[1].slice(0, 8);
    if (Array.isArray(j)) return j.map(x => (x && x.phrase) || '').filter(Boolean).slice(0, 8);
    return [];
  } catch (_) { return []; }
});
ipcMain.handle('open-path', (e, p) => shell.openPath(p));
ipcMain.handle('show-item', (e, p) => { try { shell.showItemInFolder(p); } catch (_) {} return true; });
ipcMain.handle('get-dl-dirs', () => { const dl = app.getPath('downloads'); const d = prefs.dlDirs || {}; return { def: dl, video: d.video || dl, image: d.image || dl, audio: d.audio || dl, other: d.other || dl }; });
ipcMain.handle('pick-dl-dir', async (e, cat) => { const r = await dialog.showOpenDialog(win, { title: 'Choose save folder', properties: ['openDirectory', 'createDirectory'] }); if (r.canceled || !r.filePaths.length) return null; prefs.dlDirs = prefs.dlDirs || {}; prefs.dlDirs[cat] = r.filePaths[0]; writePrefs(prefs); return r.filePaths[0]; });
ipcMain.handle('reset-dl-dir', (e, cat) => { if (prefs.dlDirs) delete prefs.dlDirs[cat]; writePrefs(prefs); return app.getPath('downloads'); });
// ---- video downloader (yt-dlp) ----
const QUALITY_FMT = {
  best: 'best[ext=mp4]/best',
  '1080': 'best[height<=1080][ext=mp4]/best[height<=1080]/best',
  '720': 'best[height<=720][ext=mp4]/best[height<=720]/best',
  '480': 'best[height<=480][ext=mp4]/best[height<=480]/best',
  audio: 'bestaudio[ext=m4a]/bestaudio'
};
function ytDlpPath() { return path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe'); }
let _vdSeq = 0;
ipcMain.handle('ytdlp-download', async (e, url, quality) => {
  url = String(url || '').trim(); if (!/^https?:/i.test(url)) return { ok: false, error: 'Enter a valid URL' };
  const id = 'v' + (++_vdSeq);
  const bin = ytDlpPath();
  try {
    if (!fs.existsSync(bin)) {
      if (win) win.webContents.send('ytdlp-progress', { id, line: 'Fetching the yt-dlp engine (first use)…' });
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
      if (!r.ok) throw 0;
      fs.writeFileSync(bin, Buffer.from(await r.arrayBuffer()));
    }
  } catch (_) { return { ok: false, error: 'Could not download yt-dlp' }; }
  let dir = (prefs.dlDirs && prefs.dlDirs.video) || app.getPath('downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const fmt = QUALITY_FMT[quality] || QUALITY_FMT.best;
  const child = spawn(bin, ['-f', fmt, '-o', path.join(dir, '%(title).80s [%(id)s].%(ext)s'), '--no-playlist', '--no-mtime', '--newline', url]);
  let lastPct = 0;
  const onData = (d) => { const s = d.toString(); const m = s.match(/([\d.]+)%/); if (m) lastPct = parseFloat(m[1]); if (win) win.webContents.send('ytdlp-progress', { id, pct: lastPct, line: s.trim().slice(0, 160) }); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => { if (win) win.webContents.send('ytdlp-progress', { id, done: true, ok: false }); });
  child.on('close', (code) => { if (win) win.webContents.send('ytdlp-progress', { id, pct: code === 0 ? 100 : lastPct, done: true, ok: code === 0 }); });
  return { ok: true, id };
});
// sync read for the webview preload's anti-flash dark background (runs at document-start)
// element-hiding CSS for a page — collapses the empty boxes left behind where ads were
ipcMain.handle('get-cosmetics', (e, url) => {
  if (!blocker || !blockAds || !/^https?:/i.test(url || '')) return '';
  try {
    let hostname = '', domain = '';
    try { const u = new URL(url); hostname = u.hostname; domain = hostname.split('.').slice(-2).join('.'); } catch (_) {}
    try { const { parse } = require('tldts'); const r = parse(url); hostname = r.hostname || hostname; domain = r.domain || domain; } catch (_) {}
    const { styles } = blocker.getCosmeticsFilters({
      url, hostname, domain,
      getBaseRules: true, getRulesFromHostname: true, getRulesFromDOM: false,
      getInjectionRules: false, getExtendedRules: false
    });
    return styles || '';
  } catch (_) { return ''; }
});
