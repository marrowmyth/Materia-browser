'use strict';
// Materia AI module (ported from the Slash browser, same author).
// Slice 1: a docked AI chat panel with a CLI (Squire) path and a BYOK API path.
// Browser tools + page-consent + the full-screen page come in later slices.
const { app, ipcMain, WebContentsView, BrowserWindow, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { runAnthropicAgent, runOpenAiAgent, runGoogleAgent } = require('./lib/api');

const AI_PANEL_WIDTH = 400;
const ENC_PREFIX = 'enc:v1:';

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

const SYSTEM =
  'You are the assistant built into the Materia web browser. Answer ' +
  'conversationally and concisely. Do not use file, terminal, or code-editing tools.';
const AGENT_SYSTEM = SYSTEM;

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
function ensurePanel(win) {
  if (!win || win.isDestroyed()) return null;
  let v = panels.get(win);
  if (v && !v.webContents.isDestroyed()) return v;
  v = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'ai-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  try { v.setBackgroundColor('#1c1c1f'); } catch (_) {}
  win.contentView.addChildView(v);
  v.setVisible(false);
  v.webContents.loadFile(path.join(__dirname, 'ai.html'));
  v.webContents.on('will-navigate', (e) => e.preventDefault());
  v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panels.set(win, v);
  win.on('closed', () => panels.delete(win));
  return v;
}

// --- AI turns ---
const AI_CWD = (() => { const d = path.join(app.getPath('userData'), 'ai-cwd'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; })();
const activeStreams = new Map(); // conversationId -> abort()
function buildCliPrompt(transcript) {
  const lines = (transcript || []).map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text);
  return SYSTEM + '\n\n' + lines.join('\n') + '\nAssistant:';
}
async function runCliAI({ conversationId, provider, transcript }, sender) {
  const cfg = (PROVIDERS[provider] || PROVIDERS.claude).cli;
  let Squire;
  try { ({ Squire } = await import('@pythonluvr/squire')); }
  catch (err) {
    sender.send('ai:error', { conversationId, message: 'Squire failed to load: ' + err.message });
    sender.send('ai:done', { conversationId, code: 1 });
    return;
  }
  const squire = new Squire({ binary: cfg.binary, args: cfg.args, adapter: cfg.adapter, cwd: AI_CWD, timeoutMs: 90000 });
  activeStreams.set(conversationId, () => { try { squire.stop().catch(() => {}); } catch (_) {} });
  squire.on('event', (ev) => {
    if (ev.type === 'text_delta') sender.send('ai:delta', { conversationId, delta: ev.delta });
    else if (ev.type === 'error') sender.send('ai:error', { conversationId, message: (ev.error && ev.error.message) || 'AI error' });
  });
  squire.on('exit', (code) => { activeStreams.delete(conversationId); sender.send('ai:done', { conversationId, code }); });
  try { await squire.start(buildCliPrompt(transcript)); }
  catch (err) {
    activeStreams.delete(conversationId);
    sender.send('ai:error', { conversationId, message: err.message });
    sender.send('ai:done', { conversationId, code: 1 });
  }
}
async function runApiAI({ conversationId, provider, transcript }, sender) {
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
      tools: [], // Slice 1: chat only; browser tools land in the next slice
      onDelta: (delta) => sender.send('ai:delta', { conversationId, delta }),
      onTool: () => {},
      executeTool: async () => '',
      signal: ac.signal,
    });
    sender.send('ai:done', { conversationId, code: 0 });
  } catch (err) {
    if (!ac.signal.aborted) sender.send('ai:error', { conversationId, message: err.message });
    sender.send('ai:done', { conversationId, code: ac.signal.aborted ? 0 : 1 });
  } finally {
    activeStreams.delete(conversationId);
  }
}
function runAI(payload, sender) {
  if (payload && payload.variant === 'api') return runApiAI(payload, sender);
  return runCliAI(payload, sender);
}

// --- IPC ---
let wired = false;
function init() {
  if (wired) return;
  wired = true;

  // Settings bridge used by the AI panel (Slash channel names; distinct from
  // Materia's own 'get-settings').
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch || {}));
  ipcMain.handle('favicon:get', () => ''); // stub: the panel falls back to the site's own favicon

  ipcMain.on('ai:send', (e, payload) => runAI(payload, e.sender));
  ipcMain.on('ai:stop', (_e, conversationId) => { const stop = activeStreams.get(conversationId); if (stop) stop(); });
  ipcMain.on('ai:consent-reply', () => {}); // consent flow arrives with the browser tools
  ipcMain.on('ai:to-page', () => {});
  ipcMain.on('ai:to-sidebar', () => {});
  ipcMain.on('ai:open-web', () => {});

  // Toggle the docked panel for the sender's window. Returns the new open state
  // so the chrome renderer can reflow its content view.
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
