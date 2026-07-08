// Providers shown in the picker. kind matches the apiKeys / apiModels
// entries in settings (anthropic / google / openai).
const PROVIDERS = [
  { id: 'claude', label: 'Claude', kind: 'anthropic', domain: 'claude.ai' },
  { id: 'gemini', label: 'Gemini', kind: 'google', domain: 'gemini.google.com' },
  { id: 'openai', label: 'ChatGPT', kind: 'openai', domain: 'chatgpt.com' },
];

const $ = (id) => document.getElementById(id);

// A provider logo (favicon from the local cache), falling back to the spark.
function providerLogo(p) {
  const img = document.createElement('img');
  img.className = 'pk-logo';
  img.alt = '';
  const fallback = () => {
    const sp = document.createElement('span');
    sp.className = 'spark';
    sp.textContent = '✦';
    img.replaceWith(sp);
  };
  const firstParty = 'https://' + String(p.domain || '').replace(/^www\./, '') + '/favicon.ico';
  img.addEventListener('error', fallback, { once: true });
  window.ai
    .favicon(p.domain)
    .then((d) => {
      img.src = d || firstParty;
    })
    .catch(() => {
      img.src = firstParty;
    });
  return img;
}
const input = $('input');
const thread = $('thread');

// This same UI runs as the docked sidebar and as the full-screen slash://ai
// page (loaded with #full). The mode changes layout + which expand/dock
// button is shown.
const FULL = location.hash === '#full';

let settings = null;
let selection = { provider: 'claude', variant: 'cli' };
const conversationId = 'c' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
let transcript = [];
let current = null; // { el, buf } for the streaming assistant bubble
let busy = false; // a send is in flight (guards re-entry; flips send -> stop)

function providerLabel(id) {
  return (PROVIDERS.find((p) => p.id === id) || PROVIDERS[0]).label;
}

function updatePickerLabel() {
  $('picker-label').textContent =
    providerLabel(selection.provider) + ' · ' + selection.variant.toUpperCase();
  input.placeholder = 'Message ' + providerLabel(selection.provider);
  const p = PROVIDERS.find((x) => x.id === selection.provider) || PROVIDERS[0];
  const logo = $('picker-logo');
  if (logo) {
    const firstParty = 'https://' + String(p.domain || '').replace(/^www\./, '') + '/favicon.ico';
    window.ai
      .favicon(p.domain)
      .then((d) => {
        logo.src = d || firstParty;
      })
      .catch(() => {
        logo.src = firstParty;
      });
  }
}

async function loadSettings() {
  settings = await window.ai.getSettings();
  if (settings.selection) selection = settings.selection;
  updatePickerLabel();
  renderStarters();
}

// --- Conversation starters (empty-state quick prompts) ---
// A fixed default set the user can extend or trim. Stored app-level so the
// sidebar and the full slash://ai page share the same list. Clicking one fills
// the composer and sends. Defaults lean page-aware: "Summarize this page" makes
// the model read the active tab via the read_current_page tool, which prompts
// for your consent (the page-content consent bar) before any text is sent.
const DEFAULT_STARTERS = ['Summarize this page', 'Explain the selected text', 'Find the key takeaways'];

function getStarters() {
  return settings && Array.isArray(settings.chatStarters) ? settings.chatStarters : DEFAULT_STARTERS.slice();
}
function persistStarters(list) {
  if (!settings) settings = {};
  settings.chatStarters = list;
  window.ai.saveSettings({ chatStarters: list });
}
function renderStarters() {
  const box = $('starters');
  if (!box) return;
  box.innerHTML = '';
  for (const text of getStarters()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'starter-chip';
    const label = document.createElement('span');
    label.className = 'sc-label';
    label.textContent = text;
    chip.appendChild(label);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sc-del';
    del.textContent = '×';
    del.title = 'Remove starter';
    del.setAttribute('aria-label', 'Remove starter ' + text);
    const removeStarter = (e) => {
      e.stopPropagation();
      persistStarters(getStarters().filter((s) => s !== text));
      renderStarters();
    };
    del.addEventListener('click', removeStarter);
    del.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        removeStarter(e);
      }
    });
    chip.appendChild(del);
    chip.addEventListener('click', () => {
      input.value = text;
      sendAI();
    });
    box.appendChild(chip);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'starter-add';
  add.textContent = '+';
  add.title = 'Add a starter';
  add.addEventListener('click', () => openStarterInput(box, add));
  box.appendChild(add);
}
function openStarterInput(box, add) {
  if (box.querySelector('.sc-input')) return;
  add.classList.add('hidden');
  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'sc-input';
  field.placeholder = 'New starter...';
  field.maxLength = 120;
  box.appendChild(field);
  field.focus();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = field.value.trim();
    if (v && !getStarters().includes(v)) persistStarters(getStarters().concat([v]));
    renderStarters();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done = true;
      renderStarters();
    }
  });
  field.addEventListener('blur', commit);
}

// --- Picker menu (provider rows + CLI/API toggle) ---
function buildPickerMenu() {
  const menu = $('picker-menu');
  menu.innerHTML = '';
  for (const p of PROVIDERS) {
    const row = document.createElement('div');
    row.className = 'pk-row';

    const name = document.createElement('span');
    name.className = 'pk-name';
    name.appendChild(providerLogo(p));
    const nameLabel = document.createElement('span');
    nameLabel.textContent = p.label;
    name.appendChild(nameLabel);
    row.appendChild(name);

    const toggle = document.createElement('div');
    toggle.className = 'pk-toggle';
    const hasKey = !!(settings && settings.apiKeys && settings.apiKeys[p.kind]);

    for (const v of ['cli', 'api']) {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'pk-seg';
      seg.textContent = v.toUpperCase();
      const isActive = selection.provider === p.id && selection.variant === v;
      seg.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      seg.setAttribute('aria-label', p.label + ' ' + v.toUpperCase());
      if (isActive) seg.classList.add('active');
      if (v === 'api' && !hasKey) seg.classList.add('needs-key');
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        // API with no key set: jump straight to Settings instead of failing.
        if (v === 'api' && !hasKey) {
          openSettings();
          closePicker();
          return;
        }
        selection = { provider: p.id, variant: v };
        window.ai.saveSettings({ selection });
        updatePickerLabel();
        buildPickerMenu();
        closePicker();
      });
      toggle.appendChild(seg);
    }
    row.appendChild(toggle);
    menu.appendChild(row);
  }
}

function openPicker() {
  buildPickerMenu();
  $('picker-menu').classList.remove('hidden');
  $('picker').setAttribute('aria-expanded', 'true');
}
function closePicker() {
  $('picker-menu').classList.add('hidden');
  $('picker').setAttribute('aria-expanded', 'false');
}
$('picker').addEventListener('click', (e) => {
  e.stopPropagation();
  $('picker-menu').classList.contains('hidden') ? openPicker() : closePicker();
});
document.addEventListener('click', closePicker);

// --- Settings view (BYOK keys + editable model ids) ---
const ACCENT_PRESETS = ['#e8232e', '#d11f3a', '#f5a623', '#4f8cff', '#41c08a', '#a06cff'];

function applyAccentLive(hex) {
  settings.accent = hex;
  window.ai.saveSettings({ accent: hex });
}

function buildSettingsForm() {
  const body = $('settings-body');
  body.innerHTML = '';

  // Appearance: themeable accent
  const appear = document.createElement('div');
  appear.className = 'set-block';
  const aTitle = document.createElement('div');
  aTitle.className = 'set-title';
  aTitle.textContent = 'Appearance';
  appear.appendChild(aTitle);

  const aField = document.createElement('div');
  aField.className = 'set-field';
  const aLabel = document.createElement('span');
  aLabel.textContent = 'accent color';
  aField.appendChild(aLabel);

  const row = document.createElement('div');
  row.className = 'accent-row';
  const color = document.createElement('input');
  color.type = 'color';
  color.value = settings.accent || '#e8232e';
  color.addEventListener('change', () => applyAccentLive(color.value));
  row.appendChild(color);
  for (const p of ACCENT_PRESETS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.style.background = p;
    sw.setAttribute('aria-label', 'Accent ' + p);
    sw.addEventListener('click', () => {
      color.value = p;
      applyAccentLive(p);
    });
    row.appendChild(sw);
  }
  aField.appendChild(row);
  appear.appendChild(aField);
  body.appendChild(appear);

  for (const p of PROVIDERS) {
    const block = document.createElement('div');
    block.className = 'set-block';

    const title = document.createElement('div');
    title.className = 'set-title';
    title.appendChild(providerLogo(p));
    const titleLabel = document.createElement('span');
    titleLabel.textContent = p.label;
    title.appendChild(titleLabel);
    block.appendChild(title);

    const keyField = document.createElement('label');
    keyField.className = 'set-field';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = p.kind + ' API key';
    const key = document.createElement('input');
    key.type = 'password';
    key.placeholder = 'paste your key';
    key.value = settings.apiKeys[p.kind] || '';
    key.dataset.kind = p.kind;
    key.className = 'set-key';
    keyField.appendChild(keyLabel);
    keyField.appendChild(key);
    block.appendChild(keyField);

    const modelField = document.createElement('label');
    modelField.className = 'set-field';
    const modelLabel = document.createElement('span');
    modelLabel.textContent = 'API model';
    const model = document.createElement('input');
    model.type = 'text';
    model.value = settings.apiModels[p.kind] || '';
    model.dataset.kind = p.kind;
    model.className = 'set-model';
    modelField.appendChild(modelLabel);
    modelField.appendChild(model);
    block.appendChild(modelField);

    body.appendChild(block);
  }
}

function openSettings() {
  buildSettingsForm();
  $('chat').classList.add('hidden');
  $('settings').classList.remove('hidden');
}
function closeSettings() {
  $('settings').classList.add('hidden');
  $('chat').classList.remove('hidden');
}
$('gear').addEventListener('click', openSettings);
$('settings-back').addEventListener('click', closeSettings);
$('settings-save').addEventListener('click', async () => {
  const apiKeys = {};
  const apiModels = {};
  for (const el of document.querySelectorAll('.set-key')) apiKeys[el.dataset.kind] = el.value.trim();
  for (const el of document.querySelectorAll('.set-model')) apiModels[el.dataset.kind] = el.value.trim();
  settings = await window.ai.saveSettings({ apiKeys, apiModels });
  buildPickerMenu();
  closeSettings();
});

// --- Chat ---
function appendMessage(role, text) {
  $('empty').classList.add('hidden');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

function sendAI() {
  const text = input.value.trim();
  if (!text || busy) return;
  appendMessage('user', text);
  transcript.push({ role: 'user', text });
  input.value = '';
  autoGrow();

  const el = appendMessage('assistant', '');
  el.classList.add('thinking');
  el.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  current = { el, buf: '' };
  busy = true;
  setSendMode(true);

  window.ai.send({
    conversationId,
    provider: selection.provider,
    variant: selection.variant,
    transcript,
  });
}

// The send button doubles as a stop button while a turn is in flight.
function setSendMode(streaming) {
  const b = $('send');
  if (!b) return;
  b.textContent = streaming ? '■' : '↑';
  b.title = streaming ? 'Stop' : 'Send';
  b.setAttribute('aria-label', streaming ? 'Stop' : 'Send');
  b.classList.toggle('stopping', streaming);
}
function stopAI() {
  window.ai.stop(conversationId);
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAI();
  }
});
$('send').addEventListener('click', () => (busy ? stopAI() : sendAI()));

// --- Stream wiring ---
window.ai.onDelta((d) => {
  if (d.conversationId !== conversationId || !current) return;
  if (current.el.classList.contains('thinking')) {
    current.el.classList.remove('thinking');
    current.el.textContent = '';
  }
  current.buf += d.delta;
  current.el.textContent = current.buf;
  thread.scrollTop = thread.scrollHeight;
});
window.ai.onError((d) => {
  if (d.conversationId !== conversationId || !current) return;
  consentReq = null;
  current.el.classList.remove('thinking', 'consent');
  current.el.classList.add('error');
  current.el.textContent = (current.buf ? current.buf + '\n\n' : '') + '[error] ' + d.message;
});
window.ai.onDone((d) => {
  if (d.conversationId !== conversationId || !current) return;
  consentReq = null;
  busy = false;
  setSendMode(false);
  if (current.el.classList.contains('thinking') || current.el.classList.contains('consent')) {
    current.el.classList.remove('thinking', 'consent');
    current.el.textContent = '[no response]';
  }
  transcript.push({ role: 'assistant', text: current.buf });
  current = null;
});

// --- Page-content consent (item 14) ---
// Main pauses before any page text is sent and asks here. The bar takes over
// the pending assistant bubble; "Send page" approves for this turn only, "Not
// now" continues without the page. "View" reveals exactly what would be sent.
let consentReq = null;
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
function showConsent(d) {
  if (!current) return;
  consentReq = d;
  const el = current.el;
  el.classList.remove('thinking');
  el.classList.add('consent');
  el.textContent = '';
  const card = document.createElement('div');
  card.className = 'consent-card';
  const q = document.createElement('div');
  q.className = 'consent-q';
  q.textContent = 'Send this page to ' + providerLabel(selection.provider) + '?';
  card.appendChild(q);
  const meta = document.createElement('div');
  meta.className = 'consent-meta';
  meta.textContent = (hostOf(d.url) || 'this page') + (d.chars ? ' · ' + d.chars.toLocaleString() + ' chars' : '');
  card.appendChild(meta);
  const prev = document.createElement('pre');
  prev.className = 'consent-preview hidden';
  prev.textContent = d.preview || '';
  const actions = document.createElement('div');
  actions.className = 'consent-actions';
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'consent-btn ghost';
  view.textContent = 'View';
  view.addEventListener('click', () => prev.classList.toggle('hidden'));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'consent-btn ghost';
  no.textContent = 'Not now';
  no.addEventListener('click', () => replyConsent(false));
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'consent-btn primary';
  yes.textContent = 'Send page';
  yes.addEventListener('click', () => replyConsent(true));
  actions.appendChild(view);
  actions.appendChild(no);
  actions.appendChild(yes);
  card.appendChild(actions);
  card.appendChild(prev);
  el.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
}
function replyConsent(allow) {
  if (!consentReq) return;
  window.ai.consentReply({ requestId: consentReq.requestId, allow });
  consentReq = null;
  if (current) {
    current.el.classList.remove('consent');
    current.el.classList.add('thinking');
    current.el.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  }
}
window.ai.onConsent((d) => {
  if (d.conversationId === conversationId) showConsent(d);
});

window.ai.onOpenSettings(() => openSettings());

// --- Sidebar <-> full-screen handoff ---
function snapshot() {
  return { transcript, selection };
}
function loadConversation(data) {
  if (data && data.selection) {
    selection = data.selection;
    window.ai.saveSettings({ selection });
    updatePickerLabel();
  }
  transcript = data && Array.isArray(data.transcript) ? data.transcript.slice() : [];
  thread.innerHTML = '';
  if (transcript.length) {
    $('empty').classList.add('hidden');
    for (const m of transcript) appendMessage(m.role, m.text);
  } else {
    $('empty').classList.remove('hidden');
  }
}
window.ai.onLoad(loadConversation);

// Expand (docked -> full page) and dock (full page -> sidebar), carrying the
// conversation across so it stays continuous.
if (FULL) {
  document.body.classList.add('full');
  $('expand').classList.add('hidden');
  $('dock').classList.remove('hidden');
}
$('expand').addEventListener('click', () => window.ai.toPage(snapshot()));
$('dock').addEventListener('click', () => window.ai.toSidebar(snapshot()));

// A prompt handed over from the hero's Ask AI mode: set the chosen model,
// drop the text in, and send.
window.ai.onPrompt((payload) => {
  const text = typeof payload === 'string' ? payload : payload.text;
  const provider = payload && typeof payload === 'object' ? payload.provider : null;
  closeSettings();
  if (provider && PROVIDERS.find((p) => p.id === provider)) {
    selection = { provider, variant: selection.variant };
    window.ai.saveSettings({ selection });
    updatePickerLabel();
  }
  if (text) {
    input.value = text;
    sendAI();
  }
});

loadSettings();
input.focus();
