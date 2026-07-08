// The full-screen slash://ai conversation. Mind-style layout, driven by the
// same AI bridge (window.ai) as the docked sidebar. Conversations live in
// localStorage so the chat list persists.

const $ = (id) => document.getElementById(id);

const PROVIDERS = [
  { id: 'claude', label: 'Claude', kind: 'anthropic', domain: 'claude.ai' },
  { id: 'gemini', label: 'Gemini', kind: 'google', domain: 'gemini.google.com' },
  { id: 'openai', label: 'ChatGPT', kind: 'openai', domain: 'chatgpt.com' },
];
const providerById = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
// Provider logo from the local favicon cache (a data URL), falling back to the
// provider's own first-party favicon. No third-party icon service (the docked
// sidebar does the same), so opening this page does not leak the provider set.
function setProviderLogo(img, p) {
  const firstParty = 'https://' + String(p.domain || '').replace(/^www\./, '') + '/favicon.ico';
  window.ai
    .favicon(p.domain)
    .then((d) => {
      img.src = d || firstParty;
    })
    .catch(() => {
      img.src = firstParty;
    });
}

const MSG_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const USER_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
const EXT_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
const STOP_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function openProviderWeb(id) {
  const p = providerById(id);
  window.ai.openWeb('https://' + p.domain);
}

const CHATS_KEY = 'slash.ai.chats';
const COLLAPSE_KEY = 'slash.ai.sidebar.collapsed';

let settings = null;
let selection = { provider: 'claude', variant: 'cli' };
let chats = [];
let activeId = null;
let streaming = null; // { convId, wrap, mdEl, buf, chatId, err }
let collapsed = false;

const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const activeChat = () => chats.find((c) => c.id === activeId) || null;

function loadChats() {
  try {
    const v = JSON.parse(localStorage.getItem(CHATS_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveChats() {
  localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
}

// --- Minimal, safe markdown (escapes first, then formats) ---
function escapeHtml(s) {
  // Escape quotes too: link hrefs are interpolated into href="..." below, and an
  // unescaped " in AI output would break out of the attribute (XSS).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function renderMarkdown(src) {
  const blocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    // The sentinel wrapping the index below is a private-use char (U+E000, shown
    // invisibly): it never occurs in real text and is untouched by the escape /
    // format passes, so a fenced block re-inserts by index without colliding
    // with a plain numeric line of content.
    return '' + (blocks.length - 1) + '';
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  const lines = text.split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      html += '<p>' + para.join('<br>') + '</p>';
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html += '</' + list + '>';
      list = null;
    }
  };
  for (const line of lines) {
    const ph = line.match(/^(\d+)$/);
    if (ph && blocks[+ph[1]] != null) {
      flushPara();
      flushList();
      html += blocks[+ph[1]];
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara();
      flushList();
      const l = m[1].length;
      html += '<h' + l + '>' + m[2] + '</h' + l + '>';
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') {
        flushList();
        html += '<ul>';
        list = 'ul';
      }
      html += '<li>' + m[1] + '</li>';
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') {
        flushList();
        html += '<ol>';
        list = 'ol';
      }
      html += '<li>' + m[1] + '</li>';
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html;
}

// --- Rendering ---
function scrollBottom() {
  const t = $('thread');
  t.scrollTop = t.scrollHeight;
}

function renderList() {
  const list = $('chat-list');
  list.innerHTML = '';
  if (!chats.length) {
    list.innerHTML = '<div class="sb-empty">No chats yet.</div>';
    return;
  }
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === activeId ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.setAttribute('aria-label', 'Open chat ' + c.name);
    const icon = document.createElement('span');
    icon.className = 'ci-icon';
    icon.innerHTML = MSG_ICON;
    item.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'ci-name';
    name.textContent = c.name;
    item.appendChild(name);
    const del = document.createElement('button');
    del.className = 'ci-del';
    del.type = 'button';
    del.innerHTML = '&#10005;';
    del.title = 'Delete chat';
    del.setAttribute('aria-label', 'Delete chat ' + c.name);
    const removeChat = (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    };
    del.addEventListener('click', removeChat);
    del.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        removeChat(e);
      }
    });
    item.appendChild(del);
    item.addEventListener('click', () => selectChat(c.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectChat(c.id);
      }
    });
    list.appendChild(item);
  }
}

function renderMessage(role, text, opts) {
  const inner = $('thread-inner');
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role + (opts && opts.thinking ? ' thinking' : '');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (role === 'assistant') {
    const img = document.createElement('img');
    setProviderLogo(img, providerById(selection.provider));
    img.alt = '';
    img.addEventListener('error', () => {
      img.replaceWith(document.createTextNode('AI'));
    });
    avatar.appendChild(img);
  } else {
    avatar.innerHTML = USER_ICON;
  }
  wrap.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'body';
  const author = document.createElement('div');
  author.className = 'author';
  author.textContent = role === 'assistant' ? providerById(selection.provider).label : 'You';
  body.appendChild(author);
  const tools = document.createElement('div');
  tools.className = 'tools';
  body.appendChild(tools);
  const md = document.createElement('div');
  md.className = 'md';
  if (text) md.innerHTML = renderMarkdown(text);
  body.appendChild(md);
  wrap.appendChild(body);

  inner.appendChild(wrap);
  return wrap;
}

function ensureChatView() {
  $('landing').classList.add('hidden');
  $('chat').classList.remove('hidden');
}

function renderActive() {
  const c = activeChat();
  if (!c || !c.messages.length) {
    $('landing').classList.remove('hidden');
    $('chat').classList.add('hidden');
    setTimeout(() => $('landing-input').focus(), 0);
    return;
  }
  ensureChatView();
  $('thread-inner').innerHTML = '';
  for (const m of c.messages) renderMessage(m.role, m.text);
  scrollBottom();
  setTimeout(() => $('chat-input').focus(), 0);
}

// --- Chat lifecycle ---
// Leaving the current view (new chat, switch, delete) rebuilds the thread DOM,
// which would orphan an in-flight stream: deltas would write to a detached node
// and the composer would stay stuck on Stop. Finalize the stream first, keeping
// whatever was streamed so far on its own chat.
function abandonStream() {
  if (!streaming) return;
  try {
    window.ai.stop(streaming.convId);
  } catch {
    /* ignore */
  }
  const c = chats.find((x) => x.id === streaming.chatId);
  if (c && streaming.buf) {
    c.messages.push({ role: 'assistant', text: streaming.buf });
    saveChats();
  }
  streaming = null;
  setComposerStreaming(false);
}
function newChatSurface() {
  abandonStream();
  activeId = null;
  renderList();
  renderActive();
}
function selectChat(id) {
  abandonStream();
  activeId = id;
  renderList();
  renderActive();
}
function deleteChat(id) {
  abandonStream();
  chats = chats.filter((c) => c.id !== id);
  if (activeId === id) activeId = null;
  saveChats();
  renderList();
  renderActive();
}

function send(raw) {
  const text = (raw || '').trim();
  if (!text || streaming) return;
  let c = activeChat();
  if (!c) {
    c = { id: uid(), name: 'New chat', messages: [], createdAt: Date.now() };
    chats.unshift(c);
    activeId = c.id;
  }
  if (!c.messages.length) c.name = text.slice(0, 44);
  c.messages.push({ role: 'user', text });
  saveChats();

  ensureChatView();
  $('thread-inner').innerHTML = '';
  for (const m of c.messages) renderMessage(m.role, m.text);

  const wrap = renderMessage('assistant', '', { thinking: true });
  const mdEl = wrap.querySelector('.md');
  mdEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  const convId = 'conv' + Date.now() + Math.random().toString(36).slice(2);
  streaming = { convId, wrap, mdEl, buf: '', chatId: c.id, err: null, toolsEl: wrap.querySelector('.tools') };

  renderList();
  scrollBottom();
  $('landing-input').value = '';
  $('chat-input').value = '';
  $('chat-input').style.height = 'auto';
  setComposerStreaming(true);

  window.ai.send({
    conversationId: convId,
    provider: selection.provider,
    variant: selection.variant,
    transcript: c.messages,
  });
}

// The composer send button doubles as a stop button while a turn streams.
function setComposerStreaming(on) {
  for (const id of ['landing-send', 'chat-send']) {
    const b = $(id);
    if (!b) continue;
    if (on) {
      if (!b.dataset.sendHtml) b.dataset.sendHtml = b.innerHTML;
      b.innerHTML = STOP_SVG;
      b.title = 'Stop';
      b.setAttribute('aria-label', 'Stop');
      b.classList.add('stopping');
    } else {
      if (b.dataset.sendHtml) b.innerHTML = b.dataset.sendHtml;
      b.title = 'Send';
      b.setAttribute('aria-label', 'Send');
      b.classList.remove('stopping');
    }
  }
}
function stopStream() {
  if (streaming) window.ai.stop(streaming.convId);
}

window.ai.onDelta((d) => {
  if (!streaming || d.conversationId !== streaming.convId) return;
  if (streaming.wrap.classList.contains('thinking')) {
    streaming.wrap.classList.remove('thinking');
    streaming.mdEl.textContent = '';
  }
  streaming.buf += d.delta;
  streaming.mdEl.textContent = streaming.buf;
  scrollBottom();
});
window.ai.onError((d) => {
  if (!streaming || d.conversationId !== streaming.convId) return;
  streaming.err = d.message;
});

const TOOL_LABELS = {
  web_search: 'Searching the web',
  read_url: 'Reading page',
  read_current_page: 'Reading this page',
  open_tab: 'Opening tab',
  bookmark_page: 'Bookmarking',
  add_to_homepage: 'Adding to start page',
};
window.ai.onTool((ev) => {
  if (!streaming || ev.conversationId !== streaming.convId) return;
  if (ev.phase === 'start') {
    if (streaming.wrap.classList.contains('thinking')) {
      streaming.wrap.classList.remove('thinking');
      streaming.mdEl.textContent = '';
    }
    const chip = document.createElement('div');
    chip.className = 'tool-chip running';
    const label = TOOL_LABELS[ev.name] || ev.name;
    const arg = ev.input && (ev.input.query || ev.input.url || ev.input.name);
    chip.innerHTML = '<span class="tc-dot"></span>' + escapeHtml(label + (arg ? ' · ' + arg : ''));
    streaming.toolsEl.appendChild(chip);
    streaming.lastChip = chip;
    scrollBottom();
  } else if (ev.phase === 'end' && streaming.lastChip) {
    streaming.lastChip.classList.remove('running');
    streaming.lastChip.classList.add('done');
  }
});
window.ai.onDone((d) => {
  if (!streaming || d.conversationId !== streaming.convId) return;
  consentReqP = null;
  setComposerStreaming(false);
  streaming.wrap.classList.remove('thinking');
  if (streaming.err) {
    streaming.wrap.classList.add('error');
    streaming.mdEl.textContent =
      (streaming.buf ? streaming.buf + '\n\n' : '') + '[error] ' + streaming.err;
  } else {
    const buf = streaming.buf || '[no response]';
    streaming.mdEl.innerHTML = renderMarkdown(buf);
    const c = chats.find((x) => x.id === streaming.chatId);
    if (c) {
      c.messages.push({ role: 'assistant', text: buf });
      saveChats();
    }
  }
  streaming = null;
  scrollBottom();
});

// --- Page-content consent (item 14) ---
// Main pauses before any page text is sent and asks here. The bar takes over
// the pending assistant message; "Send page" approves for this turn only, "Not
// now" continues without the page. "View" reveals exactly what would be sent.
let consentReqP = null;
function hostOfP(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
function showConsentPage(d) {
  if (!streaming) return;
  consentReqP = d;
  streaming.wrap.classList.remove('thinking');
  const md = streaming.mdEl;
  md.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'consent-card';
  const q = document.createElement('div');
  q.className = 'consent-q';
  q.textContent = 'Send this page to ' + providerById(selection.provider).label + '?';
  card.appendChild(q);
  const meta = document.createElement('div');
  meta.className = 'consent-meta';
  meta.textContent = (hostOfP(d.url) || 'this page') + (d.chars ? ' · ' + d.chars.toLocaleString() + ' chars' : '');
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
  no.addEventListener('click', () => replyConsentPage(false));
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'consent-btn primary';
  yes.textContent = 'Send page';
  yes.addEventListener('click', () => replyConsentPage(true));
  actions.appendChild(view);
  actions.appendChild(no);
  actions.appendChild(yes);
  card.appendChild(actions);
  card.appendChild(prev);
  md.appendChild(card);
  scrollBottom();
}
function replyConsentPage(allow) {
  if (!consentReqP) return;
  window.ai.consentReply({ requestId: consentReqP.requestId, allow });
  consentReqP = null;
  if (streaming) {
    streaming.wrap.classList.add('thinking');
    streaming.mdEl.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  }
}
window.ai.onConsent((d) => {
  if (streaming && d.conversationId === streaming.convId) showConsentPage(d);
});

// --- Composer ---
function wireComposer(inputId, sendId) {
  const ta = $(inputId);
  const btn = $(sendId);
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(ta.value);
    }
  });
  btn.addEventListener('click', () => (streaming ? stopStream() : send(ta.value)));
}
wireComposer('landing-input', 'landing-send');
wireComposer('chat-input', 'chat-send');
$('new-chat').addEventListener('click', newChatSurface);

// --- Model picker ---
function updateModelBtn() {
  const p = providerById(selection.provider);
  setProviderLogo($('model-logo'), p);
  $('model-label').textContent = p.label + ' · ' + selection.variant.toUpperCase();
  $('open-web').title = 'Open ' + p.label + ' on the web';
}
function buildModelMenu() {
  const menu = $('model-menu');
  menu.innerHTML = '';
  for (const p of PROVIDERS) {
    const row = document.createElement('div');
    row.className = 'mm-row';
    const img = document.createElement('img');
    setProviderLogo(img, p);
    img.alt = '';
    img.addEventListener('error', () => {
      img.style.visibility = 'hidden';
    });
    row.appendChild(img);
    const name = document.createElement('span');
    name.className = 'mm-name';
    name.textContent = p.label;
    row.appendChild(name);
    const tog = document.createElement('div');
    tog.className = 'mm-toggle';
    for (const v of ['cli', 'api']) {
      const seg = document.createElement('button');
      seg.type = 'button';
      const isActive = selection.provider === p.id && selection.variant === v;
      seg.className = 'mm-seg' + (isActive ? ' active' : '');
      seg.textContent = v.toUpperCase();
      seg.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      seg.setAttribute('aria-label', p.label + ' ' + v.toUpperCase());
      seg.addEventListener('click', (e) => {
        e.stopPropagation();
        selection = { provider: p.id, variant: v };
        window.ai.saveSettings({ selection });
        updateModelBtn();
        buildModelMenu();
        closeModelMenu();
      });
      tog.appendChild(seg);
    }
    row.appendChild(tog);
    const open = document.createElement('button');
    open.className = 'mm-open';
    open.type = 'button';
    open.title = 'Open ' + p.label + ' on the web';
    open.innerHTML = EXT_ICON;
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openProviderWeb(p.id);
      closeModelMenu();
    });
    row.appendChild(open);
    menu.appendChild(row);
  }
}
function openModelMenu() {
  buildModelMenu();
  $('model-menu').classList.remove('hidden');
  $('model-btn').setAttribute('aria-expanded', 'true');
}
function closeModelMenu() {
  $('model-menu').classList.add('hidden');
  $('model-btn').setAttribute('aria-expanded', 'false');
}
$('model-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('model-menu').classList.contains('hidden') ? openModelMenu() : closeModelMenu();
});
document.addEventListener('click', closeModelMenu);
$('open-web').addEventListener('click', () => openProviderWeb(selection.provider));

// --- Sidebar collapse ---
function applyCollapse() {
  $('sidebar').classList.toggle('collapsed', collapsed);
  $('expand').classList.toggle('hidden', !collapsed);
}
$('collapse').addEventListener('click', () => {
  collapsed = !collapsed;
  localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  applyCollapse();
});
$('expand').addEventListener('click', () => {
  collapsed = false;
  localStorage.setItem(COLLAPSE_KEY, 'false');
  applyCollapse();
});

// --- Dock back to the sidebar, carrying the active chat ---
$('dock').addEventListener('click', () => {
  const c = activeChat();
  window.ai.toSidebar({ transcript: c ? c.messages.slice() : [], selection });
});

// Handoff from the sidebar's expand button: import as a new chat.
window.ai.onLoad((data) => {
  if (data && data.selection) {
    selection = data.selection;
    window.ai.saveSettings({ selection });
    updateModelBtn();
  }
  const msgs = data && Array.isArray(data.transcript) ? data.transcript : [];
  if (msgs.length) {
    const first = msgs.find((m) => m.role === 'user');
    const c = {
      id: uid(),
      name: (first ? first.text : 'Chat').slice(0, 44),
      messages: msgs.slice(),
      createdAt: Date.now(),
    };
    chats.unshift(c);
    activeId = c.id;
    saveChats();
    renderList();
    renderActive();
  } else {
    newChatSurface();
  }
});

// A prompt handed over from the hero's Ask AI mode: fresh chat, then send.
window.ai.onPrompt((payload) => {
  const text = typeof payload === 'string' ? payload : payload && payload.text;
  const provider = payload && typeof payload === 'object' ? payload.provider : null;
  if (provider && PROVIDERS.find((p) => p.id === provider)) {
    selection = { provider, variant: selection.variant };
    window.ai.saveSettings({ selection });
    updateModelBtn();
  }
  activeId = null;
  renderActive();
  if (text) send(text);
});

// --- Conversation starters (landing quick prompts) ---
// Shared app-level list with the docked sidebar; clicking one starts a chat.
// Defaults lean page-aware: reading the active tab (read_current_page) prompts
// for consent via the page-content consent bar before any text is sent.
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
  const box = $('landing-starters');
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
    chip.addEventListener('click', () => send(text));
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

// --- Init ---
async function init() {
  settings = await window.ai.getSettings();
  if (settings && settings.selection) selection = settings.selection;
  chats = loadChats();
  collapsed = localStorage.getItem(COLLAPSE_KEY) === 'true';
  applyCollapse();
  updateModelBtn();
  renderStarters();
  renderList();
  renderActive();
}
init();
