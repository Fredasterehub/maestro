'use strict';

// maestro machine layer — JSONL stream library.
//
// One lock mechanism for the whole .maestro/ tree: withLock() here is the
// single per-file serialization primitive; atomic-json.js reuses it rather
// than inventing a second locking layer for JSON files.
//
// Every stream record carries the common header
//   { schema_version: 1, seq, kind, ts, correlation_id }
// stamped by appendRecord and never writable by a caller's payload.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

// Ceiling for one serialized line INCLUDING the trailing newline: 8192 bytes
// is the bound under which POSIX O_APPEND writes stay atomic on the target
// filesystems, so a larger record is refused rather than risk interleaving.
const LINE_CEILING = 8192;

// Header fields owned by appendRecord; a payload may never redefine them.
const RESERVED_KEYS = Object.freeze(['schema_version', 'seq', 'kind', 'ts', 'correlation_id']);

// UTC 'Z' suffix only. A numeric offset (+02:00) is valid ISO-8601 but lets
// two producers disagree on wall-clock ordering while both "look" ISO.
const ISO_8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const LOCK_SUFFIX = '.lock';
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_TIMEOUT_MS = 5000;
// A lockfile older than this belongs to a dead holder and is reclaimed
// instead of blocking every future writer forever.
const LOCK_STALE_MS = 30000;
const LOCK_TIMEOUT_CODE = 'ELOCKTIMEOUT';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Node has no synchronous sleep; Atomics.wait on a private SharedArrayBuffer
// is the zero-dependency way to block for a short bounded backoff.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serializes fn() behind an exclusive-create lockfile at <file>.lock.
// Retry every 5ms up to 5s, then throw with code ELOCKTIMEOUT; a lock whose
// mtime is older than 30s is treated as abandoned and reclaimed.
function withLock(file, fn) {
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('jsonl: withLock requires a non-empty file path');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('jsonl: withLock requires a function');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = file + LOCK_SUFFIX;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue; // holder released between the failed open and the stat; retry now
      }
      if (Date.now() >= deadline) {
        const timedOut = new Error(`jsonl: timed out waiting for the lock on ${file}`);
        timedOut.code = LOCK_TIMEOUT_CODE;
        throw timedOut;
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

// Reads every line of a JSONL file. Missing file reads as empty. A line that
// does not parse — including a torn final line left by a writer that died
// mid-append — is collected into errors, never thrown: the readable prefix
// of a stream is always recoverable.
function readRecords(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { records: [], errors: [] };
    }
    throw err;
  }

  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  const records = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      errors.push({
        line: i + 1,
        reason: err.message,
        torn: !endsWithNewline && i === lines.length - 1,
      });
    }
  }
  return { records, errors };
}

// Appends one stream record: { kind, payload?, correlation_id? }.
// Under the per-file lock it allocates seq = (max seq on file) + 1, stamps
// the common header, enforces the 8192-byte line ceiling, and appends.
// Returns the exact record written.
function appendRecord(file, record) {
  if (!isPlainObject(record)) {
    throw new TypeError('jsonl: appendRecord requires a record object');
  }
  const { kind, payload, correlation_id } = record;
  if (typeof kind !== 'string' || kind === '') {
    throw new TypeError('jsonl: record.kind must be a non-empty string');
  }
  if (payload !== undefined && !isPlainObject(payload)) {
    throw new TypeError('jsonl: record.payload must be a plain object when provided');
  }
  if (
    correlation_id !== undefined &&
    correlation_id !== null &&
    (typeof correlation_id !== 'string' || correlation_id === '')
  ) {
    throw new TypeError('jsonl: record.correlation_id must be a non-empty string or null');
  }
  const body = payload || {};
  for (const reserved of RESERVED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, reserved)) {
      throw new TypeError(`jsonl: payload must not redefine reserved header field "${reserved}"`);
    }
  }

  return withLock(file, () => {
    const { records } = readRecords(file);
    let maxSeq = -1;
    for (const rec of records) {
      if (isPlainObject(rec) && Number.isSafeInteger(rec.seq) && rec.seq > maxSeq) {
        maxSeq = rec.seq;
      }
    }

    const stamped = {
      schema_version: SCHEMA_VERSION,
      seq: maxSeq + 1,
      kind,
      ts: new Date().toISOString(),
      // Always stamped, defaulting to null — never simply omitted when the
      // caller has no correlator to attach.
      correlation_id: correlation_id !== undefined ? correlation_id : null,
      ...body,
    };

    let json;
    try {
      json = JSON.stringify(stamped);
    } catch (err) {
      throw new TypeError(`jsonl: record is not JSON-serializable: ${err.message}`);
    }
    const line = json + '\n';
    const byteLength = Buffer.byteLength(line, 'utf8');
    if (byteLength > LINE_CEILING) {
      throw new RangeError(
        `jsonl: serialized line is ${byteLength} bytes, exceeding the ${LINE_CEILING}-byte ceiling`
      );
    }

    // A torn final line (no trailing newline) must not swallow this record:
    // appending straight after it would fuse both into one unreadable line.
    // A leading newline isolates the torn fragment on its own line instead.
    let needsLeadingNewline = false;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fd = null;
    }
    if (fd !== null) {
      try {
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const lastByte = Buffer.alloc(1);
          fs.readSync(fd, lastByte, 0, 1, size - 1);
          needsLeadingNewline = lastByte[0] !== 0x0a;
        }
      } finally {
        fs.closeSync(fd);
      }
    }

    fs.appendFileSync(file, needsLeadingNewline ? '\n' + line : line);
    return stamped;
  });
}

const HELP = `jsonl.js — maestro JSONL stream library (not a CLI)

Require it from another machine-layer script:

  const { withLock, appendRecord, readRecords } = require('./jsonl.js');

  withLock(file, fn)        run fn() holding <file>.lock (exclusive create,
                            5ms retry, 5s timeout code ELOCKTIMEOUT,
                            30s stale-lock reclaim)
  appendRecord(file, rec)   rec = { kind, payload?, correlation_id? };
                            allocates seq under the lock, stamps the common
                            header { schema_version: 1, seq, kind, ts,
                            correlation_id }, refuses a serialized line over
                            ${LINE_CEILING} bytes (newline included)
  readRecords(file)         { records, errors } — malformed lines, including
                            a torn final line, are reported, never thrown
`;

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  process.stderr.write('jsonl.js is a library, not a CLI. Run with --help for its exports.\n');
  process.exit(1);
}

module.exports = {
  SCHEMA_VERSION,
  LINE_CEILING,
  RESERVED_KEYS,
  ISO_8601_UTC_RE,
  LOCK_SUFFIX,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  LOCK_TIMEOUT_CODE,
  withLock,
  readRecords,
  appendRecord,
};
