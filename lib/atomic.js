// Durable, crash-safe file writes for the local stores (settings, bookmarks /
// history, password vault). The stores read back as empty on any parse failure,
// so a half-finished write is not just a corrupt file, it is silent data loss.
// writeFileAtomic renders to a temp file in the same directory, fsyncs it, keeps
// a .bak of the previous good copy, then atomically renames over the target.
// readJsonWithBackup recovers from the .bak when the primary is missing or
// corrupt. Pure Node fs, no deps.

const fs = require('fs');
const path = require('path');

let seq = 0;

function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Unique temp name (pid + counter) so concurrent writers never collide.
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.tmp-' + process.pid + '-' + ++seq);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // flush to disk before we swap it in
  } finally {
    fs.closeSync(fd);
  }
  // Snapshot the last good file as .bak before replacing it (best effort).
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
  } catch {
    /* backup is best effort; the atomic rename below is the real guarantee */
  }
  // Atomic on POSIX; on Windows libuv uses MoveFileEx(REPLACE_EXISTING), also atomic.
  fs.renameSync(tmp, filePath);
}

// Parse filePath as JSON, falling back to its .bak if the primary is missing or
// unparseable. Returns the parsed value, or null when nothing readable exists.
function readJsonWithBackup(filePath) {
  for (const p of [filePath, filePath + '.bak']) {
    let txt;
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch {
      continue; // missing; try the backup
    }
    try {
      return JSON.parse(txt);
    } catch {
      /* corrupt; try the backup */
    }
  }
  return null;
}

module.exports = { writeFileAtomic, readJsonWithBackup };
