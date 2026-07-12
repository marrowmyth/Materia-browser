'use strict';
// Materia AI module (ported from the Slash browser, same author).
// A docked AI chat panel with a CLI (Squire) path and a BYOK API path, plus
// browser tools so the assistant can act: search the web, read the current page
// or any URL, open tabs, and bookmark pages. The free subscription CLIs get the
// tools through a local MCP server; the BYOK API path gets them directly.
const { app, ipcMain, WebContentsView, BrowserWindow, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { runAnthropicAgent, runOpenAiAgent, runGoogleAgent } = require('./lib/api');
const { startMcpServer } = require('./lib/mcp-server');

const AI_PANEL_WIDTH = 400;
const ENC_PREFIX = 'enc:v1:';
const MCP_SERVER_NAME = 'materia';

// Injected by main.js so the tools can reach Materia's renderer-owned tabs and
// bookmarks, and read the active tab's content. See init(ctx).
let ctx = { chromeWC: () => null, activeGuestWC: () => null };

const PROVIDERS = {
  claude: {
    label: 'Claude',
    domain: 'claude.ai',
    cli: { binary: 'claude', adapter: 'claude-code', args: ['-p', '--output-format', 'stream-json', '--verbose'] },
    api: { kind: 'anthropic' },
  },
  gemini: {
    label: 'Gemini',
    domain: 'gemini.google.com',
    cli: { binary: 'gemini', adapter: 'gemini-cli', args: ['-m', 'gemini-2.5-flash'] },
    api: { kind: 'google' },
  },
  openai: {
    label: 'ChatGPT',
    domain: 'chatgpt.com',
    cli: { binary: 'codex', adapter: 'text-stream', args: ['exec'] },
    api: { kind: 'openai' },
  },
};

const AGENT_SYSTEM =
  'You are the assistant built into the Materia web browser. You can search the ' +
  'web, read the current page or any URL, open tabs, and bookmark pages. Use a ' +
  'tool when it helps answer or carry out the request; otherwise answer directly. ' +
  'After using tools, give a clear, concise answer. Do not invent page contents, read them.';

// --- Settings (BYOK keys encrypted at rest with safeStorage) ---
const DEFAULTS = {
  selection: { provider: 'claude', variant: 'cli' },
  apiKeys: { anthropic: '', google: '', openai: '' },
  apiModels: { anthropic: 'claude-sonnet-4-6', google: 'gemini-2.5-flash', openai: 'gpt-4o' },
  chatStarters: ['Summarize this page', 'Explain the selected text', 'Find the key takeaways'],
  accent: '#f1cb53',
};
function settingsPath() { return path.join(app.getPath('userData'), 'mm-ai-settings.json'); }
function canEncrypt() { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } }
function encKey(plain) {
  if (!plain) return '';
  if (!canEncrypt()) return plain;
  try { return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64'); } catch (_) { return plain; }
}
function decKey(stored) {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  if (!canEncrypt()) return '';
  try { return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')); } catch (_) { return ''; }
}
function readRaw() { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (_) { return {}; } }
function loadSettings() {
  const raw = readRaw();
  const apiKeys = { ...DEFAULTS.apiKeys, ...(raw.apiKeys || {}) };
  for (const k of Object.keys(apiKeys)) apiKeys[k] = decKey(apiKeys[k]); // plaintext for use
  return {
    selection: { ...DEFAULTS.selection, ...(raw.selection || {}) },
    apiKeys,
    apiModels: { ...DEFAULTS.apiModels, ...(raw.apiModels || {}) },
    chatStarters: Array.isArray(raw.chatStarters) ? raw.chatStarters : DEFAULTS.chatStarters.slice(),
    accent: raw.accent || DEFAULTS.accent,
  };
}
function saveSettings(patch) {
  const cur = loadSettings();
  const next = {
    selection: { ...cur.selection, ...(patch.selection || {}) },
    apiKeys: { ...cur.apiKeys, ...(patch.apiKeys || {}) },
    apiModels: { ...cur.apiModels, ...(patch.apiModels || {}) },
    chatStarters: Array.isArray(patch.chatStarters) ? patch.chatStarters : cur.chatStarters,
    accent: patch.accent || cur.accent,
  };
  const onDisk = { ...next, apiKeys: {} };
  for (const k of Object.keys(next.apiKeys)) onDisk.apiKeys[k] = encKey(next.apiKeys[k]);
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(onDisk, null, 2), 'utf8');
  } catch (_) {}
  return next; // plaintext for the caller
}

// --- Per-window AI panel view ---
const panels = new Map(); // BrowserWindow -> WebContentsView
function winOf(e) { try { return BrowserWindow.fromWebContents(e.sender) || null; } catch (_) { return null; } }
// The panel is a child WebContentsView, so map its webContents back to its window.
function windowForSender(sender) {
  for (const [win, v] of panels) {
    try { if (!v.webContents.isDestroyed() && v.webContents.id === sender.id) return win; } catch (_) {}
  }
  try { return BrowserWindow.fromWebContents(sender) || null; } catch (_) { return null; }
}
function ensurePanel(win) {
  if (!win || win.isDestroyed()) return null;
  let v = panels.get(win);
  if (v && !v.webContents.isDestroyed()) return v;
  v = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'ai-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  try { v.setBackgroundColor('#0c0c0e'); } catch (_) {}   // neutral dark bg, avoids a flash
  win.contentView.addChildView(v);
  v.setVisible(false);
  v.webContents.loadFile(path.join(__dirname, 'ai.html'));
  v.webContents.on('will-navigate', (e) => e.preventDefault());
  v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panels.set(win, v);
  win.on('closed', () => panels.delete(win));
  return v;
}

// --- Browser tools (the assistant can act) ---
const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web and get back result titles and URLs.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
  },
  {
    name: 'read_url',
    description: 'Load a URL in the background and return the readable text of the page.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The full URL to read' } }, required: ['url'] },
  },
  {
    name: 'read_current_page',
    description: "Return the readable text of the page in the user's active browser tab.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_tab',
    description: 'Open a URL in a new visible browser tab for the user to see.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'bookmark_page',
    description: 'Bookmark a page. Uses the active tab if no url is given.',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } } },
  },
];

// A reusable offscreen view that renders a page so read_url gets JS-rendered
// content. Calls are serialized through fetcherChain.
let fetcherView = null;
let fetcherChain = Promise.resolve();
function fetcherParentWin() { try { return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null; } catch (_) { return null; } }
function ensureFetcher() {
  try { if (fetcherView && !fetcherView.webContents.isDestroyed()) return fetcherView; } catch (_) {}
  fetcherView = null;
  const parent = fetcherParentWin();
  if (!parent) return null;
  fetcherView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  parent.contentView.addChildView(fetcherView);
  fetcherView.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
  fetcherView.setVisible(false);
  return fetcherView;
}
function fetchPageText(url) {
  const job = () => doFetchPageText(url);
  fetcherChain = fetcherChain.then(job, job);
  return fetcherChain;
}
async function doFetchPageText(url) {
  const v = ensureFetcher();
  if (!v) return { title: '', text: '' };
  const wc = v.webContents;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(to); wc.off('did-finish-load', finish); wc.off('did-fail-load', finish); resolve(); };
    const to = setTimeout(finish, 15000);
    wc.on('did-finish-load', finish);
    wc.on('did-fail-load', finish);
    wc.loadURL(url).catch(finish);
  });
  try {
    const raw = await wc.executeJavaScript('JSON.stringify({title:document.title||"",text:document.body?document.body.innerText:""})');
    return JSON.parse(raw);
  } catch (_) { return { title: '', text: '' }; }
}

async function toolWebSearch(query) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Materia' },
  });
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (title && /^https?:/i.test(url)) out.push({ title, url });
  }
  if (!out.length) return 'No results found.';
  return out.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n');
}

// --- AI page-content consent ---
// Page text never reaches a provider in the background. Whenever a turn would
// send the active tab's contents, the panel shows a just-in-time consent bar and
// the read waits for the user's yes. Approval is scoped to the single in-flight
// turn (turn.gate), never persisted.
let aiTurn = null; // { sender, conversationId, gate:{decided}, win } for the live turn
const pendingConsent = new Map(); // requestId -> finish(boolean)
let consentSeq = 0;
function requestPageConsent(sender, conversationId, detail) {
  return new Promise((resolve) => {
    const requestId = 'pc' + ++consentSeq;
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; pendingConsent.delete(requestId); resolve(!!v); };
    pendingConsent.set(requestId, { finish, conversationId });
    try { sender.send('ai:consent', { conversationId, requestId, ...detail }); } catch (_) { return finish(false); }
    setTimeout(() => finish(false), 120000); // panel never answered => treat as no
  });
}
function isNoPageUrl(url) { return !url || /^about:/i.test(url) || url.indexOf('newtab.html') !== -1; }
async function readActiveTabPage(win) {
  const wc = ctx.activeGuestWC(win);
  if (!wc) return null;
  let url = '';
  try { url = wc.getURL(); } catch (_) {}
  if (isNoPageUrl(url)) return null;
  try {
    const raw = await wc.executeJavaScript('JSON.stringify({title:document.title||"",text:document.body?document.body.innerText:""})');
    const p = JSON.parse(raw);
    return { title: p.title || '', url, text: p.text || '' };
  } catch (_) { return null; }
}
// 'none' = no page open; 'denied' = the user said no; else { title, url, text }.
async function gatedActivePage(turn) {
  const win = (turn && turn.win) || fetcherParentWin();
  const page = await readActiveTabPage(win);
  if (!page) return 'none';
  const gate = turn && turn.gate;
  if (!gate) return page; // out-of-band call, no turn to prompt on
  if (gate.decided === false) return 'denied';
  if (gate.decided !== true) {
    gate.decided = await requestPageConsent(turn.sender, turn.conversationId, {
      url: page.url, title: page.title, chars: page.text.length, preview: page.text.slice(0, 2000),
    });
    if (!gate.decided) return 'denied';
  }
  return page;
}

const PAGE_HINT = /\b(this page|the page|current page|this article|this site|this tab|selected text|selection|summari[sz]e|key takeaways|tl;?dr)\b/i;
async function maybePageContext(transcript, turn) {
  const last = (transcript || []).filter((m) => m.role === 'user').pop();
  if (!last || !PAGE_HINT.test(last.text || '')) return null;
  const gated = await gatedActivePage(turn);
  if (!gated || gated === 'none' || gated === 'denied') return null;
  return `The user is looking at this page:\n# ${gated.title}\n${gated.url}\n\n${(gated.text || '').slice(0, 6000)}`;
}

async function executeTool(name, input, turn) {
  input = input || {};
  const win = (turn && turn.win) || fetcherParentWin();
  switch (name) {
    case 'web_search':
      return toolWebSearch(String(input.query || ''));
    case 'read_url': {
      let url = String(input.url || '');
      if (!url) return 'No URL given.';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const p = await fetchPageText(url);
      return `# ${p.title}\n${url}\n\n${(p.text || '').slice(0, 6000)}`;
    }
    case 'read_current_page': {
      const gated = await gatedActivePage(turn);
      if (gated === 'none') return 'No web page is open in the active tab.';
      if (gated === 'denied') return 'The user declined to share the current page. Do not retry; ask them how they would like to proceed.';
      return `# ${gated.title}\n${gated.url}\n\n${(gated.text || '').slice(0, 6000)}`;
    }
    case 'open_tab': {
      let url = String(input.url || '');
      if (!url) return 'No URL given.';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const cw = ctx.chromeWC(win);
      if (!cw) return 'No browser window is open.';
      try { cw.send('open-tab', { url }); } catch (_) { return 'Could not open the tab.'; }
      return 'Opened ' + url + ' in a new tab.';
    }
    case 'bookmark_page': {
      let url = String(input.url || '');
      let title = input.title || '';
      if (!url) {
        const page = await readActiveTabPage(win); // no consent bar: this reads url/title only, not sent to a provider
        if (page) { url = page.url; title = title || page.title; }
      }
      if (!url) return 'No URL to bookmark.';
      const cw = ctx.chromeWC(win);
      if (!cw) return 'No browser window is open.';
      try { cw.send('mm-ai:bookmark', { url, title: title || url }); } catch (_) { return 'Could not bookmark the page.'; }
      return 'Bookmarked ' + url;
    }
    default:
      return 'Unknown tool: ' + name;
  }
}

// --- MCP bridge: lets the free CLIs drive the browser via the local server ---
let mcpServer = null;
let mcpConfigPath = null;
async function startMcp() {
  if (mcpServer) return;
  try {
    const mcp = await startMcpServer({ name: MCP_SERVER_NAME, tools: TOOLS, executeTool: (n, i) => executeTool(n, i, aiTurn) });
    mcpServer = mcp;
    const cfg = { mcpServers: { [mcp.name]: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer ' + mcp.token } } } };
    const p = path.join(app.getPath('userData'), 'mm-ai-mcp.json');
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    mcpConfigPath = p;
  } catch (_) { mcpConfigPath = null; }
}
// Build CLI args, injecting the MCP browser tools (and native web tools) for Claude.
function cliArgsFor(provider) {
  if (provider === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', 'WebSearch,WebFetch'];
    const allowed = ['WebSearch', 'WebFetch'];
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
      for (const t of TOOLS) allowed.push(`mcp__${MCP_SERVER_NAME}__${t.name}`);
    }
    args.push('--allowedTools', allowed.join(','));
    return args;
  }
  return (PROVIDERS[provider] || PROVIDERS.claude).cli.args;
}

// --- AI turns ---
const AI_CWD = (() => { const d = path.join(app.getPath('userData'), 'ai-cwd'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; })();
const activeStreams = new Map(); // conversationId -> abort()
function buildCliPrompt(transcript) {
  const lines = (transcript || []).map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text);
  return AGENT_SYSTEM + '\n\n' + lines.join('\n') + '\nAssistant:';
}
async function runCliAI({ conversationId, provider, transcript }, sender, win) {
  const cfg = (PROVIDERS[provider] || PROVIDERS.claude).cli;
  const turn = { sender, conversationId, gate: { decided: null }, win };
  aiTurn = turn;
  // For CLIs without MCP tools (Gemini/Codex), offer page context via the hint fallback.
  const pageCtx = provider !== 'claude' ? await maybePageContext(transcript, turn) : null;
  let Squire;
  try { ({ Squire } = await import('@pythonluvr/squire')); }
  catch (err) {
    if (aiTurn === turn) aiTurn = null;
    sender.send('ai:error', { conversationId, message: 'Squire failed to load: ' + err.message });
    sender.send('ai:done', { conversationId, code: 1 });
    return;
  }
  const squire = new Squire({ binary: cfg.binary, args: cliArgsFor(provider), adapter: cfg.adapter, cwd: AI_CWD, timeoutMs: 90000 });
  activeStreams.set(conversationId, () => { try { squire.stop().catch(() => {}); } catch (_) {} });
  squire.on('event', (ev) => {
    if (ev.type === 'text_delta') sender.send('ai:delta', { conversationId, delta: ev.delta });
    else if (ev.type === 'error') sender.send('ai:error', { conversationId, message: (ev.error && ev.error.message) || 'AI error' });
  });
  squire.on('exit', (code) => { if (aiTurn === turn) aiTurn = null; activeStreams.delete(conversationId); sender.send('ai:done', { conversationId, code }); });
  try {
    let prompt = buildCliPrompt(transcript);
    if (pageCtx) prompt = pageCtx + '\n\n' + prompt;
    await squire.start(prompt);
  } catch (err) {
    if (aiTurn === turn) aiTurn = null;
    activeStreams.delete(conversationId);
    sender.send('ai:error', { conversationId, message: err.message });
    sender.send('ai:done', { conversationId, code: 1 });
  }
}
async function runApiAI({ conversationId, provider, transcript }, sender, win) {
  const prov = PROVIDERS[provider] || PROVIDERS.claude;
  const kind = prov.api.kind;
  const settings = loadSettings();
  const apiKey = settings.apiKeys[kind];
  const model = settings.apiModels[kind];
  if (!apiKey) {
    sender.send('ai:error', { conversationId, message: 'No ' + kind + ' API key set. Add one in AI settings (the gear in the panel).' });
    sender.send('ai:done', { conversationId, code: 1 });
    return;
  }
  const turn = { sender, conversationId, gate: { decided: null }, win };
  aiTurn = turn;
  const ac = new AbortController();
  activeStreams.set(conversationId, () => ac.abort());
  try {
    const AGENTS = { anthropic: runAnthropicAgent, openai: runOpenAiAgent, google: runGoogleAgent };
    const runAgent = AGENTS[kind] || runAnthropicAgent;
    await runAgent({
      apiKey,
      model,
      system: AGENT_SYSTEM,
      messages: (transcript || []).map((m) => ({ role: m.role, content: m.text })),
      tools: TOOLS,
      onDelta: (delta) => sender.send('ai:delta', { conversationId, delta }),
      onTool: (ev) => sender.send('ai:tool', { conversationId, ...ev }),
      executeTool: (n, i) => executeTool(n, i, turn),
      signal: ac.signal,
    });
    sender.send('ai:done', { conversationId, code: 0 });
  } catch (err) {
    if (!ac.signal.aborted) sender.send('ai:error', { conversationId, message: err.message });
    sender.send('ai:done', { conversationId, code: ac.signal.aborted ? 0 : 1 });
  } finally {
    activeStreams.delete(conversationId);
    if (aiTurn === turn) aiTurn = null;
  }
}
function runAI(payload, sender) {
  const win = windowForSender(sender);
  if (payload && payload.variant === 'api') return runApiAI(payload, sender, win);
  return runCliAI(payload, sender, win);
}

// --- IPC ---
let wired = false;
function init(context) {
  if (context) ctx = { chromeWC: () => null, activeGuestWC: () => null, ...context };
  if (wired) return;
  wired = true;

  startMcp(); // start the local MCP server so the default CLI path gets the tools

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch || {}));
  ipcMain.handle('favicon:get', () => ''); // stub: the panel falls back to the site's own favicon

  ipcMain.on('ai:send', (e, payload) => runAI(payload, e.sender));
  ipcMain.on('ai:stop', (_e, conversationId) => { const stop = activeStreams.get(conversationId); if (stop) stop(); });
  ipcMain.on('ai:consent-reply', (_e, d) => {
    if (!d) return;
    const p = pendingConsent.get(d.requestId);
    if (p) p.finish(!!d.allow);
  });
  ipcMain.on('ai:to-page', () => {});    // the full-screen AI page lands in a later slice
  ipcMain.on('ai:to-sidebar', () => {});
  ipcMain.on('ai:open-web', () => {});

  // Toggle the docked panel for the sender's window. Returns the new open state.
  ipcMain.handle('mm-ai:toggle', (e, force) => {
    const win = winOf(e);
    if (!win) return false;
    const v = ensurePanel(win);
    if (!v) return false;
    const open = typeof force === 'boolean' ? force : !v.getVisible();
    v.setVisible(open);
    if (open) { try { win.contentView.removeChildView(v); win.contentView.addChildView(v); } catch (_) {} }
    return open;
  });
  ipcMain.on('mm-ai:panel-bounds', (e, d) => {
    const win = winOf(e);
    const v = win && panels.get(win);
    if (v) try { v.setBounds({ x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) }); v.setVisible(true); } catch (_) {}
  });
  ipcMain.on('mm-ai:panel-hide', (e) => {
    const win = winOf(e);
    const v = win && panels.get(win);
    if (v) try { v.setVisible(false); } catch (_) {}
  });
}

module.exports = { init, AI_PANEL_WIDTH, PROVIDERS };
