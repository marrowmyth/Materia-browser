const titleEl = document.getElementById('rd-title');
const bylineEl = document.getElementById('rd-byline');
const content = document.getElementById('rd-content');

// Build the article from structured text blocks. Everything is textContent (or a
// validated https image src), so page content can never inject markup here.
function build(a) {
  titleEl.textContent = (a && a.title) || 'Untitled';
  bylineEl.textContent = (a && a.byline) || '';
  content.textContent = '';
  let ul = null;
  for (const b of (a && a.blocks) || []) {
    if (b.t === 'li') {
      if (!ul) {
        ul = document.createElement('ul');
        content.appendChild(ul);
      }
      const li = document.createElement('li');
      li.textContent = b.text;
      ul.appendChild(li);
      continue;
    }
    ul = null;
    if (b.t === 'img') {
      if (typeof b.src === 'string' && /^https:\/\//i.test(b.src)) {
        const img = document.createElement('img');
        img.src = b.src;
        img.alt = '';
        img.addEventListener('error', () => img.remove());
        content.appendChild(img);
      }
      continue;
    }
    const tag = /^h[1-6]$/.test(b.t) ? b.t : b.t === 'quote' ? 'blockquote' : b.t === 'pre' ? 'pre' : 'p';
    const el = document.createElement(tag);
    el.textContent = b.text;
    content.appendChild(el);
  }
  document.getElementById('reader').scrollTop = 0;
}

window.reader.onArticle(build);
document.getElementById('rd-close').addEventListener('click', () => window.reader.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.reader.close();
});
