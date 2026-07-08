const input = document.getElementById('pal-input');
const resultsEl = document.getElementById('pal-results');
let items = [];
let sel = 0;
let debounce;

// Simple monochrome glyphs per result kind (no icon fonts, no network).
const ICONS = { tab: '▢', nav: '↗', history: '◷', star: '★', action: '⌘', search: '⌕', ai: '/' };

function paint() {
  [...resultsEl.children].forEach((r, i) => {
    const on = i === sel;
    r.classList.toggle('sel', on);
    r.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const cur = resultsEl.children[sel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function render() {
  resultsEl.innerHTML = '';
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'pal-empty';
    e.textContent = 'No matches';
    resultsEl.appendChild(e);
    return;
  }
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'pal-row' + (i === sel ? ' sel' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === sel ? 'true' : 'false');

    const ico = document.createElement('span');
    ico.className = 'pal-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = ICONS[it.icon] || ICONS[it.type] || '•';
    row.appendChild(ico);

    const text = document.createElement('div');
    text.className = 'pal-text';
    const t = document.createElement('div');
    t.className = 'pal-title';
    t.textContent = it.title;
    text.appendChild(t);
    if (it.subtitle) {
      const s = document.createElement('div');
      s.className = 'pal-sub';
      s.textContent = it.subtitle;
      text.appendChild(s);
    }
    row.appendChild(text);

    if (it.kind) {
      const k = document.createElement('span');
      k.className = 'pal-kind';
      k.textContent = it.kind;
      row.appendChild(k);
    }

    row.addEventListener('mousemove', () => {
      if (sel !== i) {
        sel = i;
        paint();
      }
    });
    row.addEventListener('click', () => exec(i));
    resultsEl.appendChild(row);
  });
}

async function runQuery() {
  const r = await window.palette.query(input.value);
  items = Array.isArray(r) ? r : [];
  sel = 0;
  render();
}

function exec(i) {
  const it = items[i];
  if (it) window.palette.exec(it);
}

input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(runQuery, 70);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length) {
      sel = (sel + 1) % items.length;
      paint();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) {
      sel = (sel - 1 + items.length) % items.length;
      paint();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    exec(sel);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    window.palette.close();
  }
});

// Each open resets the input and refreshes.
window.palette.onShow(() => {
  input.value = '';
  sel = 0;
  runQuery();
  setTimeout(() => input.focus(), 0);
});

runQuery();
input.focus();
