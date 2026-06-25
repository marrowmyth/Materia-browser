'use strict';
// One-off generator: bakes the brand-logo path + color for the socials we support into
// socials-data.js (window.SOCIALS_DATA), so the app needs no runtime icon dependency.
// Regenerate after `npm install simple-icons`, then `node build-socials.js`.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'node_modules', 'simple-icons', 'icons');

// [slug, display name, brand hex] — slug matches simple-icons' file name.
const want = [
  ['x', 'X', '#111111'], ['instagram', 'Instagram', '#E4405F'], ['facebook', 'Facebook', '#1877F2'],
  ['youtube', 'YouTube', '#FF0000'], ['tiktok', 'TikTok', '#111111'], ['reddit', 'Reddit', '#FF4500'],
  ['linkedin', 'LinkedIn', '#0A66C2'], ['pinterest', 'Pinterest', '#BD081C'], ['snapchat', 'Snapchat', '#FFFC00'],
  ['threads', 'Threads', '#111111'], ['tumblr', 'Tumblr', '#36465D'], ['twitch', 'Twitch', '#9146FF'],
  ['whatsapp', 'WhatsApp', '#25D366'], ['telegram', 'Telegram', '#26A5E4'], ['discord', 'Discord', '#5865F2'],
  ['mastodon', 'Mastodon', '#6364FF'], ['bluesky', 'Bluesky', '#0285FF'], ['deviantart', 'DeviantArt', '#05CC47'],
  ['artstation', 'ArtStation', '#13AFF0'], ['patreon', 'Patreon', '#F96854'], ['behance', 'Behance', '#1769FF'],
  ['pixiv', 'Pixiv', '#0096FA'], ['kofi', 'Ko-fi', '#FF5E5B'], ['soundcloud', 'SoundCloud', '#FF5500'],
  ['spotify', 'Spotify', '#1DB954'], ['github', 'GitHub', '#E8EEF0']
];

const out = [], missing = [];
for (const [slug, name, hex] of want) {
  const f = path.join(dir, slug + '.svg');
  if (!fs.existsSync(f)) { missing.push(slug); continue; }
  const m = fs.readFileSync(f, 'utf8').match(/ d="([^"]+)"/);
  if (!m) { missing.push(slug); continue; }
  out.push({ name, key: slug, hex, path: m[1] });
}
// LinkedIn was removed from simple-icons (trademark request) — supply it manually.
out.push({ name: 'LinkedIn', key: 'linkedin', hex: '#0A66C2', path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z' });
// three user "Website" slots with a plain white globe (line-art, so it carries a full svg not a fill path)
const globe = "<svg viewBox='0 0 24 24' width='__SIZE__' height='__SIZE__' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M3 12h18'/><path d='M12 3c2.4 2.5 3.6 5.6 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.6-3.6-9s1.2-6.5 3.6-9z'/></svg>";
out.push({ name: 'Website', key: 'website1', hex: '#9fb3b7', path: '', svg: globe });
out.push({ name: 'Website 2', key: 'website2', hex: '#9fb3b7', path: '', svg: globe });
out.push({ name: 'Website 3', key: 'website3', hex: '#9fb3b7', path: '', svg: globe });
fs.writeFileSync(path.join(__dirname, 'socials-data.js'), 'window.SOCIALS_DATA = ' + JSON.stringify(out) + ';\n');
console.log('wrote socials-data.js with', out.length, 'icons; missing:', missing.join(',') || 'none');
