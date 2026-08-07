'use strict';

// maestro machine layer — atomic JSON file library.
//
// writeJson replaces a file via temp-in-same-dir + fsync + rename so a
// reader never observes a torn file. updateJson serializes read-modify-write
// through jsonl.js's withLock — the ONE lock mechanism for the whole
// .maestro/ tree — so two CLI invocations can never clobber each other's
// updates.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { withLock } = require('./jsonl.js');

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return fallback;
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`atomic-json: failed to parse JSON at ${file}: ${err.message}`);
  }
}

function writeJson(file, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (err) {
    throw new TypeError(`atomic-json: cannot serialize value for ${file}: ${err.message}`);
  }
  if (typeof serialized !== 'string') {
    throw new TypeError(`atomic-json: value for ${file} serializes to undefined`);
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  // Unpredictable temp name opened 'wx': a fixed "<file>.tmp" is guessable
  // (a pre-planted symlink there would redirect a plain 'w' open), and a
  // pid-only suffix collides across threads sharing a pid. Random suffix
  // plus O_CREAT|O_EXCL closes both.
  const tmpFile = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const fd = fs.openSync(tmpFile, 'wx');
  const payload = serialized + '\n';
  const expected = Buffer.byteLength(payload);
  try {
    // A short write is a partial file, and fsync+rename would publish it as
    // a complete one — every later reader, including the digest a caller
    // takes by re-reading this path, would then certify truncated bytes as
    // authoritative. Refuse before the rename, while the only casualty is
    // the temp file this writer already cleans up.
    const written = fs.writeSync(fd, payload);
    if (written !== expected) {
      throw new Error(
        `atomic-json: short write for ${file} — ${written} of ${expected} bytes written; nothing was published`
      );
    }
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(tmpFile, file);
  } catch (err) {
    // The temp file is still exclusively ours (unpredictable name), so a
    // best-effort unlink on the throw path never races another writer and
    // never leaves orphans behind a failed rename.
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
}

// Locked read-modify-write over one JSON file. fn(current) runs INSIDE the
// lock against a read taken under that same lock — never a stale pre-lock
// value — and returns the value to persist. fn may throw to abort the whole
// transaction: nothing on disk changes and the lock still releases. A caller
// that must also append a ledger record as part of the same transaction does
// so FROM INSIDE fn, so both writes are decided against the same locked read.
function updateJson(file, fn, fallback) {
  if (typeof fn !== 'function') {
    throw new TypeError('atomic-json: updateJson requires an updater function');
  }
  return withLock(file, () => {
    const current = readJson(file, fallback);
    const next = fn(current);
    writeJson(file, next);
    return next;
  });
}

const HELP = `atomic-json.js — maestro atomic JSON library (not a CLI)

Require it from another machine-layer script:

  const { readJson, writeJson, updateJson } = require('./atomic-json.js');

  readJson(file, fallback)    parsed JSON; fallback when the file is absent;
                              a file that exists but does not parse throws
  writeJson(file, value)      atomic replacement: temp file in the same
                              directory + fsync + rename
  updateJson(file, fn, fallback)
                              locked read-modify-write via jsonl.js withLock
                              (the tree's single lock mechanism); fn(current)
                              returns the value to persist, and may throw to
                              abort with nothing written
`;

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  process.stderr.write('atomic-json.js is a library, not a CLI. Run with --help for its exports.\n');
  process.exit(1);
}

module.exports = { readJson, writeJson, updateJson };
