'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, webContents, nativeTheme, Menu, clipboard, dialog, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// executeJavaScript / insertCSS against a page view can reject if the view navigates or is torn off mid-call.
// Those are benign races; swallow just those messages so they don't spam the console, surface anything else.
process.on('unhandledRejection', (reason) => {
  const m = (reason && reason.message) ? String(reason.message) : String(reason);
  if (/Script failed to execute|Object has been destroyed|been disposed|render frame was disposed|webContents was destroyed/i.test(m)) return;
  console.warn('Unhandled rejection:', m);
});

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
// a URL handed to us when Windows launches Materia as the default browser
function urlFromArgv(argv) { try { const u = (argv || []).find(a => /^https?:\/\//i.test(a)); return u || null; } catch (_) { return null; } }
let pendingLaunchUrl = process.platform === 'win32' ? urlFromArgv(process.argv) : null;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    try {
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      const u = urlFromArgv(argv); const w = win || BrowserWindow.getAllWindows()[0];
      if (u && w) csend(w, 'open-tab', { url: u });   // default-browser invocation while already running → open a tab
    } catch (_) {}
  });
}

// Persistent partition -> cookies/storage survive restarts, so LOGINS persist.
const configured = new Set(); // partitions whose privacy config is already attached
let blocker = null;           // @ghostery/adblocker engine (ads + trackers + cookie banners + pop-ups)
let blockerStatus = 'loading'; let blockedCount = 0;

// ---- privacy: built-in tracker blocklist (toggleable from Settings) ----
let blockTrackers = true;
let blockAds = true;
let AdReq = null;   // @ghostery/adblocker Request ctor — for matching each request manually (so the allowlist can override it)
let trustedHosts = new Set(Array.isArray(prefs.trustedHosts) ? prefs.trustedHosts : []);   // user allowlist: these sites load FULLY unblocked
function isTrustedHost(h) { if (!h) return false; for (const t of trustedHosts) { if (h === t || h.endsWith('.' + t)) return true; } return false; }
function rType(t) { return ({ mainFrame: 'main_frame', subFrame: 'sub_frame', xhr: 'xmlhttprequest', cspReport: 'csp_report', webSocket: 'websocket' })[t] || t; }
function reqTopUrl(details) { if (details.resourceType === 'mainFrame') return details.url; try { if (details.webContentsId) { const wc = webContents.fromId(details.webContentsId); if (wc && !wc.isDestroyed()) return wc.getURL(); } } catch (_) {} return details.url; }
function normTrustHost(s) { s = String(s || '').trim().toLowerCase(); if (!s) return ''; return hostOf(/:\/\//.test(s) ? s : 'http://' + s); }
function persistTrusted() { try { prefs.trustedHosts = Array.from(trustedHosts); writePrefs(prefs); } catch (_) {} }
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
    // Safe Browsing: block navigations to known phishing/malware hosts (always on — even for trusted sites).
    if (SAFE_HOSTS.size && details.resourceType === 'mainFrame' && /^https?:/.test(details.url)) {
      const h = hostOf(details.url);
      if (h && SAFE_HOSTS.has(h) && !safeAllow.has(h)) return cb({ redirectURL: safeBlockPage(details.url) });
    }
    // Trusted site (user allowlist) → load everything, no ad/tracker blocking or param stripping.
    const top = reqTopUrl(details);
    if (isTrustedHost(hostOf(top))) return cb({});
    if (details.resourceType === 'ping') return cb({ cancel: true });
    if (blockTrackers && /^https?:/.test(details.url) && isTracker(details.url)) return cb({ cancel: true });
    if (blockAds && blocker && AdReq && /^https?:/.test(details.url)) {
      try { const r = blocker.match(AdReq.fromRawDetails({ type: rType(details.resourceType), url: details.url, sourceUrl: top || details.url })); if (r && r.match) { blockedCount++; return cb({ cancel: true }); } } catch (_) {}
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
    const send = (state) => { if (win) csend(win, 'download', { id, name: item.getFilename(), url, path: savePath, state, received: item.getReceivedBytes(), total: item.getTotalBytes() }); };
    send('progress');
    item.on('updated', (ev, st) => send(st === 'interrupted' ? 'interrupted' : 'progress'));
    item.once('done', (ev, st) => send(st));
  });

  return ses;   // ad/tracker blocking is applied manually in onBeforeRequest (above) so the trusted-site allowlist can override it
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
  try { AdReq = require('@ghostery/adblocker').Request; } catch (_) {}   // used to match each request manually
  blockerStatus = 'active';
}
let win = null;   // tracks the most-recently-focused window (default target for renderer messages)
const chromeViews = new Map();   // BrowserWindow -> chrome WebContentsView (the UI layer, sits ON TOP of the page views)
const winOfChrome = new Map();   // chrome webContents id -> BrowserWindow  (so IPC from the chrome resolves its window)
function chromeWC(w) { const v = chromeViews.get(w); return (v && !v.webContents.isDestroyed()) ? v.webContents : null; }
function csend(w, ch, data) { const c = chromeWC(w); if (c) try { c.send(ch, data); } catch (_) {} }
function applyChromeBounds(w) {
  const v = chromeViews.get(w); if (!v) return;
  const b = w.getContentBounds();
  try { v.setBounds({ x: 0, y: 0, width: b.width, height: b.height }); } catch (_) {}   // ALWAYS full-window so the chrome page lays out correctly; we control overlap via z-order, not size
}
// chrome stays full-window; float it ABOVE the page (overlay/menu open) or tuck it BEHIND it (browsing). When
// behind, the page view covers only the content area, so the toolbar strip still shows and stays clickable.
function chromeToTop(w) { const v = chromeViews.get(w); if (v) try { w.contentView.removeChildView(v); w.contentView.addChildView(v); } catch (_) {} }
function chromeToBottom(w) { const v = chromeViews.get(w); if (v) try { w.contentView.removeChildView(v); w.contentView.addChildView(v, 0); } catch (_) {} }
function createWindow(opts) {
  opts = opts || {};
  // a torn-off window opens with its tab strip under the cursor where you dropped it
  const px = opts.x ? Math.round(opts.x) - 140 : undefined;
  const py = opts.y ? Math.round(opts.y) - 14 : undefined;
  const w = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 480, x: px, y: py,
    frame: false, backgroundColor: '#061215', title: 'Materia Browser',
    icon: path.join(__dirname, 'assets', 'icon-white.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win = w;
  try { w.webContents.loadURL('data:text/html,<body style="margin:0;background:%23061215"></body>'); } catch (_) {}   // inert base; all UI lives in the chrome view
  // the chrome UI (toolbar/bookmarks/panels/menus) is a transparent view ABOVE the page views
  const chrome = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try { chrome.setBackgroundColor('#00000000'); } catch (_) {}
  chromeViews.set(w, chrome);
  winOfChrome.set(chrome.webContents.id, w);
  w._chromeFull = false;   // browsing state: chrome tucked behind the page; flips true when an overlay opens
  w.contentView.addChildView(chrome);
  applyChromeBounds(w);
  const q = {}; if (opts.url) q.u = opts.url; if (opts.wsId) q.ws = opts.wsId; if (opts.torn) q.nw = '1'; if (opts.adopt) q.ad = opts.adopt;
  chrome.webContents.loadFile('index.html', Object.keys(q).length ? { query: q } : undefined);
  // right-click menu for the chrome's own inputs (address bar, settings fields)
  chrome.webContents.on('context-menu', (e, params) => {
    const it = [];
    if (params.isEditable) { it.push({ role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' }, { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }); }
    else if (params.selectionText) { it.push({ role: 'copy' }); }
    if (it.length) { try { Menu.buildFromTemplate(it).popup(); } catch (_) {} }
  });
  chrome.webContents.on('did-finish-load', () => { if (pendingLaunchUrl) { const u = pendingLaunchUrl; pendingLaunchUrl = null; try { csend(w, 'open-tab', { url: u }); } catch (_) {} } });   // launched as default browser with a URL
  w.on('focus', () => { win = w; });
  w.on('resize', () => applyChromeBounds(w));
  w.on('close', () => { try { const cv = chromeViews.get(w); const pre = (cv ? cv.webContents.id : -1) + ':'; for (const [key, vv] of guestViews) { if (key.indexOf(pre) === 0) { try { vv.webContents.setAudioMuted(true); } catch (_) {} try { vv.webContents.loadURL('about:blank').catch(() => {}); } catch (_) {} try { if (!vv.webContents.isDestroyed()) vv.webContents.close({ waitForBeforeUnload: false }); } catch (_) {} guestViews.delete(key); } } } catch (_) {} });
  w.on('maximize', () => csend(w, 'win-state', true));
  w.on('unmaximize', () => csend(w, 'win-state', false));
  w.on('enter-full-screen', () => csend(w, 'fullscreen', true));
  w.on('leave-full-screen', () => csend(w, 'fullscreen', false));
  w.on('closed', () => { const cv = chromeViews.get(w); if (cv) winOfChrome.delete(cv.webContents.id); chromeViews.delete(w); if (win === w) win = null; });
  w.on('app-command', (e, cmd) => { if (cmd === 'browser-backward') { e.preventDefault(); csend(w, 'shortcut', 'back'); } else if (cmd === 'browser-forward') { e.preventDefault(); csend(w, 'shortcut', 'forward'); } });
  return w;
}
// the renderer reports its toolbar-strip height + whether an overlay is up; main sizes the chrome view to match
ipcMain.on('chrome-bounds', (e, d) => { const w = winOfChrome.get(e.sender.id); if (!w) return; const full = !!(d && d.full); if (full === w._chromeFull) return; w._chromeFull = full; if (full) chromeToTop(w); else chromeToBottom(w); });

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
      BrowserWindow.getAllWindows().forEach(w => { try { csend(w, 'update-available', { version: tag, url: url }); } catch (_) {} });
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
  registerAsBrowser();   // keep Materia listed as a browser candidate in Windows Default Apps (no-op in dev)
  initSafeBrowsing();
  createWindow();
  setTimeout(checkForUpdate, 8000); setInterval(checkForUpdate, 6 * 3600 * 1000);   // notify when a newer release is published
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- window controls (frameless) ----
function senderWin(e) { try { return winOfChrome.get(e.sender.id) || BrowserWindow.fromWebContents(e.sender) || win; } catch (_) { return win; } }
ipcMain.on('win-min', (e) => { const w = senderWin(e); if (w) w.minimize(); });
ipcMain.on('win-max', (e) => { const w = senderWin(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
ipcMain.on('win-close', (e) => { const w = senderWin(e); if (w) w.close(); });
ipcMain.handle('toggle-fullscreen', (e) => { const w = senderWin(e); if (w) w.setFullScreen(!w.isFullScreen()); return true; });
ipcMain.handle('copy-text', (e, t) => { try { clipboard.writeText(String(t || '')); } catch (_) {} return true; });
// Reclaim keyboard focus to the chrome (address bar) when a <webview> is holding it.
ipcMain.on('focus-chrome', (e) => { const w = senderWin(e); const c = w && chromeWC(w); if (c) try { c.focus(); } catch (_) {} });
ipcMain.on('mm-ai-query', (e, data) => { const w = senderWin(e); if (w) csend(w, 'ai-query', data); });
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
  const send = (url, background) => { if (win) csend(win, 'open-tab', { url, background: !!background }); };
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
  const trustHost = hostOf(wc.getURL());
  if (trustHost) {
    const isT = isTrustedHost(trustHost);
    items.push({ label: isT ? ('Stop trusting ' + trustHost) : ('Trust ' + trustHost + ' (don’t block here)'), click: () => { if (isT) trustedHosts.delete(trustHost); else trustedHosts.add(trustHost); persistTrusted(); try { wc.reload(); } catch (_) {} } });
  }
  const darkOrigin = originOf(wc.getURL());
  items.push({ label: (darkOrigin && darkSites.has(darkOrigin)) ? 'Disable dark mode (this site)' : 'Force dark mode (this site)', enabled: !!darkOrigin, click: () => {
    if (!darkOrigin) return;
    if (darkSites.has(darkOrigin)) darkSites.delete(darkOrigin); else darkSites.add(darkOrigin);
    prefs.darkSites = [...darkSites]; writePrefs(prefs);   // remember across tabs + restarts
    applyDark(wc);
  } });
  items.push({ type: 'separator' });
  items.push({ label: 'Download video (yt-dlp)', submenu: [
    { label: 'Best quality', click: () => { if (win) csend(win, 'ytdlp', { url: wc.getURL(), quality: 'best' }); } },
    { label: '1080p', click: () => { if (win) csend(win, 'ytdlp', { url: wc.getURL(), quality: '1080' }); } },
    { label: '720p', click: () => { if (win) csend(win, 'ytdlp', { url: wc.getURL(), quality: '720' }); } },
    { label: '480p', click: () => { if (win) csend(win, 'ytdlp', { url: wc.getURL(), quality: '480' }); } },
    { label: 'Audio only (m4a)', click: () => { if (win) csend(win, 'ytdlp', { url: wc.getURL(), quality: 'audio' }); } }
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
  const owner = () => { const m = viewMeta.get(wc.id); return m ? m.win : ownerWin; };   // current host window (follows a moved tab)
  try { wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); } catch (_) {}
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url) && (isTracker(url) || adWouldBlock(url, wc.getURL()))) return { action: 'deny' };
    if (isAuthPopup(url)) return { action: 'allow' };
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      const ow = owner(); if (ow) csend(ow, 'open-tab', { url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    }
    const ow = owner(); if (ow) csend(ow, 'popup-blocked', url);
    return { action: 'deny' };
  });
  wc.on('context-menu', (e2, params) => popupContextMenu(wc, params));
  wc.once('destroyed', () => { darkAttached.delete(wc.id); viewMeta.delete(wc.id); });
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
    if (cmd) { event.preventDefault(); const ow = owner(); if (ow) csend(ow, 'shortcut', cmd); }
  });
  wc.on('zoom-changed', (e3, dir) => { const ow = owner(); if (ow) csend(ow, 'zoom-wheel', dir); });
}

// ---- WebContentsView tab engine (each tab is a main-owned view; survives moving between windows) ----
const guestViews = new Map();   // `${chromeWcId}:${vid}` -> WebContentsView  (keyed by the chrome view that owns the tab)
const viewMeta = new Map();     // page-view wc id -> { win, vid }  (kept current so events/owner follow a tab moved between windows)
const limbo = new Map();        // xfer id -> detached WebContentsView, alive and awaiting adoption by another window
function gKey(chromeWcId, vid) { return chromeWcId + ':' + vid; }
function gResolve(e, vid) { return guestViews.get(gKey(e.sender.id, vid)) || null; }
ipcMain.on('view-create', (e, o) => {
  try {
    const w = senderWin(e); if (!w) return;
    try { configurePartition(o.partition); } catch (_) {}
    const view = new WebContentsView({ webPreferences: { partition: o.partition, preload: path.join(__dirname, 'mm-nt-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true } });
    try { view.setBackgroundColor('#061215'); } catch (_) {}
    w.contentView.addChildView(view);
    if (w._chromeFull) chromeToTop(w); else chromeToBottom(w);   // restore correct z-order after inserting the page view
    view.setVisible(false);
    guestViews.set(gKey(e.sender.id, o.vid), view);
    const wc = view.webContents;
    try { wc.setMaxListeners(40); } catch (_) {}   // we attach ~15 listeners across events per view
    viewMeta.set(wc.id, { win: w, vid: o.vid });
    wireGuest(wc, w);
    const send = (event, payload) => { try { const m = viewMeta.get(wc.id); if (m) csend(m.win, 'view-event', { vid: m.vid, event: event, payload: payload }); } catch (_) {} };
    wc.on('page-title-updated', (e2, title) => send('page-title-updated', { title: title }));
    wc.on('page-favicon-updated', (e2, favicons) => send('page-favicon-updated', { favicons: favicons }));
    wc.on('did-start-loading', () => send('did-start-loading', {}));
    wc.on('did-stop-loading', () => send('did-stop-loading', {}));
    wc.on('dom-ready', () => send('dom-ready', {}));
    wc.on('did-navigate', () => send('did-navigate', { url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }));
    wc.on('did-navigate-in-page', (e2, url, isMain) => { if (isMain) send('did-navigate-in-page', { url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() }); });
    wc.on('found-in-page', (e2, result) => send('found-in-page', { result: result }));
    if (o.url) try { wc.loadURL(o.url).catch(() => {}); } catch (_) {}
  } catch (_) {}
});
ipcMain.on('view-bounds', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.setBounds({ x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) }); v.setVisible(true); } catch (_) {} });
ipcMain.on('view-hide', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.setVisible(false); } catch (_) {} });
ipcMain.on('view-destroy', (e, d) => {
  const w = senderWin(e); if (!w) return;
  const k = gKey(e.sender.id, d.vid); const v = guestViews.get(k); if (!v) return;
  guestViews.delete(k);
  const wc = v.webContents;
  try { viewMeta.delete(wc.id); } catch (_) {}
  try { wc.setAudioMuted(true); } catch (_) {}
  try { wc.loadURL('about:blank').catch(() => {}); } catch (_) {}   // navigate away — reliably stops video/audio
  try { w.contentView.removeChildView(v); } catch (_) {}
  try { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); } catch (_) {}
});
// ---- moving a LIVE tab between windows (no reload): detach the view into limbo, then re-parent it ----
ipcMain.on('tab-move-out', (e, d) => {
  try {
    const src = senderWin(e); if (!src) return;
    const v = guestViews.get(gKey(e.sender.id, d.vid)); if (!v) return;
    guestViews.delete(gKey(e.sender.id, d.vid));
    try { v.setVisible(false); } catch (_) {}
    try { src.contentView.removeChildView(v); } catch (_) {}
    limbo.set(d.xfer, v);
    let pt = { x: Math.round(d.x || 0), y: Math.round(d.y || 0) };
    try { pt = screen.getCursorScreenPoint(); } catch (_) {}   // reliable drop point (HTML5 dragend coords are flaky)
    const target = BrowserWindow.getAllWindows().find(w => { if (w === src || w.isDestroyed() || !w.isVisible()) return false; const b = w.getBounds(); return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height; });
    if (target) csend(target, 'adopt-tab', { xfer: d.xfer, url: d.url, title: d.title, wsId: d.wsId });
    else createWindow({ adopt: d.xfer, url: d.url, wsId: d.wsId, x: pt.x, y: pt.y });
    setTimeout(() => { const lv = limbo.get(d.xfer); if (lv) { limbo.delete(d.xfer); try { if (!lv.webContents.isDestroyed()) lv.webContents.close({ waitForBeforeUnload: false }); } catch (_) {} } }, 20000);   // never adopted → don't leak
  } catch (_) {}
});
ipcMain.on('view-adopt', (e, d) => {
  try {
    const w = senderWin(e); if (!w) return;
    const v = limbo.get(d.xfer); if (!v) return;
    limbo.delete(d.xfer);
    w.contentView.addChildView(v);
    if (w._chromeFull) chromeToTop(w); else chromeToBottom(w);   // keep the chrome layered correctly over the adopted view
    try { v.setVisible(false); } catch (_) {}
    guestViews.set(gKey(e.sender.id, d.vid), v);
    viewMeta.set(v.webContents.id, { win: w, vid: d.vid });   // events + popups + shortcuts now route to the new window/vid
    const wc = v.webContents;   // the moved view won't re-fire these, so push its current state to the adopting tab
    try { csend(w, 'view-event', { vid: d.vid, event: 'did-navigate', payload: { url: wc.getURL(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() } }); } catch (_) {}
    try { const ti = wc.getTitle(); if (ti) csend(w, 'view-event', { vid: d.vid, event: 'page-title-updated', payload: { title: ti } }); } catch (_) {}
  } catch (_) {}
});
ipcMain.on('view-nav', (e, d) => { const v = gResolve(e, d.vid); if (!v) return; const wc = v.webContents; try { if (d.action === 'load') wc.loadURL(d.url).catch(() => {}); else if (d.action === 'reload') wc.reload(); else if (d.action === 'back') { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); } else if (d.action === 'forward') { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); } } catch (_) {} });
ipcMain.on('view-zoom', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.setZoomFactor(d.factor); } catch (_) {} });
ipcMain.on('view-mute', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.setAudioMuted(!!d.muted); } catch (_) {} });
ipcMain.on('view-find', (e, d) => { const v = gResolve(e, d.vid); if (v) try { if (d.action === 'find') v.webContents.findInPage(d.text, d.opts || {}); else v.webContents.stopFindInPage(d.arg || 'clearSelection'); } catch (_) {} });
ipcMain.on('view-print', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.print(); } catch (_) {} });
ipcMain.on('view-css', (e, d) => { const v = gResolve(e, d.vid); if (v) try { v.webContents.insertCSS(d.css).catch(() => {}); } catch (_) {} });
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

ipcMain.handle('set-block-trackers', (e, val) => { blockTrackers = !!val; blockAds = !!val; return blockTrackers; });   // blocking reads these flags live in onBeforeRequest
// ---- trusted sites (allowlist): these load fully unblocked ----
ipcMain.handle('get-trusted', () => Array.from(trustedHosts));
ipcMain.handle('add-trusted', (e, host) => { const h = normTrustHost(host); if (h) { trustedHosts.add(h); persistTrusted(); } return Array.from(trustedHosts); });
ipcMain.handle('remove-trusted', (e, host) => { trustedHosts.delete(String(host || '').toLowerCase()); persistTrusted(); return Array.from(trustedHosts); });
ipcMain.handle('is-trusted', (e, url) => isTrustedHost(hostOf(String(url || ''))));
ipcMain.handle('get-settings', () => ({ blockTrackers, language: acceptLang }));
ipcMain.handle('set-language', (e, v) => { acceptLang = String(v || 'en-US'); prefs.language = acceptLang; writePrefs(prefs); return acceptLang; });
ipcMain.handle('adblock-status', () => ({ status: blockerStatus, blocked: blockedCount }));
ipcMain.on('mm-get-provider', (e) => { e.returnValue = prefs.searchProvider || 'ddg'; });
ipcMain.on('mm-get-version', (e) => { e.returnValue = app.getVersion(); });   // start page shows the running version
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
// ---- default browser (Windows): register as a real browser candidate, then open Default Apps so the user picks it ----
function regEsc(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }   // escape a string for a .reg value
function buildBrowserReg(exe) {
  const e = regEsc(exe), p = 'MateriaBrowser.Html', K = 'HKEY_CURRENT_USER\\Software', SMI = K + '\\Clients\\StartMenuInternet\\MateriaBrowser';
  return [
    'Windows Registry Editor Version 5.00', '',
    '[' + K + '\\Classes\\' + p + ']', '@="Materia Browser HTML Document"', '',
    '[' + K + '\\Classes\\' + p + '\\DefaultIcon]', '@="' + e + ',0"', '',
    '[' + K + '\\Classes\\' + p + '\\shell\\open\\command]', '@="\\"' + e + '\\" \\"%1\\""', '',
    '[' + SMI + ']', '@="Materia Browser"', '',
    '[' + SMI + '\\DefaultIcon]', '@="' + e + ',0"', '',
    '[' + SMI + '\\shell\\open\\command]', '@="\\"' + e + '\\""', '',
    '[' + SMI + '\\Capabilities]',
    '"ApplicationName"="Materia Browser"',
    '"ApplicationDescription"="A private, distraction-killing browser by MarrowMyth."',
    '"ApplicationIcon"="' + e + ',0"', '',
    '[' + SMI + '\\Capabilities\\URLAssociations]', '"http"="' + p + '"', '"https"="' + p + '"', '',
    '[' + SMI + '\\Capabilities\\FileAssociations]', '".htm"="' + p + '"', '".html"="' + p + '"', '',
    '[' + SMI + '\\Capabilities\\StartMenu]', '"StartMenuInternet"="MateriaBrowser"', '',
    '[' + K + '\\RegisteredApplications]',
    '"MateriaBrowser"="Software\\\\Clients\\\\StartMenuInternet\\\\MateriaBrowser\\\\Capabilities"', ''
  ].join('\r\n');
}
// Register as a real browser candidate so Windows lists Materia in Default Apps (incl. HTTP/HTTPS).
// Uses a .reg import — reliable escaping for install paths with spaces, unlike quoted `reg add` args.
async function registerAsBrowser() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;   // execPath is electron.exe in dev — only register the real installed build
  try {
    const file = path.join(app.getPath('temp'), 'materia-browser-register.reg');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(buildBrowserReg(process.execPath) + '\r\n', 'utf16le')]));
    await new Promise(res => { try { execFile('reg', ['import', file], { windowsHide: true }, () => res()); } catch (_) { res(); } });
    try { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); } catch (_) {}
    return true;
  } catch (_) { return false; }
}
function isDefaultBrowser() { try { return process.platform === 'win32' && app.isDefaultProtocolClient('http'); } catch (_) { return false; } }
ipcMain.handle('default-browser-status', () => ({ supported: process.platform === 'win32', packaged: app.isPackaged, isDefault: isDefaultBrowser() }));
// download the latest installer ourselves (with progress) and launch it — no GitHub trip
ipcMain.handle('download-update', async (e, info) => {
  const url = (info && info.url) || 'https://github.com/marrowmyth/Materia-browser/releases/latest/download/Materia-Browser-Setup.exe';
  const dest = path.join(app.getPath('temp'), 'Materia-Browser-Setup-update.exe');
  const w = senderWin(e);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader(); let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; out.write(Buffer.from(value)); if (total && w) csend(w, 'update-progress', { pct: Math.round(got / total * 100) }); }
    await new Promise((r, j) => out.end(err => err ? j(err) : r()));
    if (w) csend(w, 'update-progress', { done: true });
    setTimeout(() => { try { shell.openPath(dest); } catch (_) {} }, 300);   // SmartScreen prompt + the assisted installer take it from here
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle('set-default-browser', async () => {
  if (process.platform !== 'win32') return { ok: false, reason: 'win-only' };
  if (!app.isPackaged) return { ok: false, reason: 'dev' };   // process.execPath is electron.exe in dev — only register the real installed build
  await registerAsBrowser();
  try { await shell.openExternal('ms-settings:defaultapps'); } catch (_) {}
  return { ok: true, isDefault: isDefaultBrowser() };
});
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
      if (win) csend(win, 'ytdlp-progress', { id, line: 'Fetching the yt-dlp engine (first use)…' });
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
  const onData = (d) => { const s = d.toString(); const m = s.match(/([\d.]+)%/); if (m) lastPct = parseFloat(m[1]); if (win) csend(win, 'ytdlp-progress', { id, pct: lastPct, line: s.trim().slice(0, 160) }); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => { if (win) csend(win, 'ytdlp-progress', { id, done: true, ok: false }); });
  child.on('close', (code) => { if (win) csend(win, 'ytdlp-progress', { id, pct: code === 0 ? 100 : lastPct, done: true, ok: code === 0 }); });
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
