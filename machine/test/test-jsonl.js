'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'jsonl.js');
const {
  LINE_CEILING,
  LOCK_SUFFIX,
  LOCK_TIMEOUT_CODE,
  ISO_8601_UTC_RE,
  withLock,
  readRecords,
  appendRecord,
} = require(SRC);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-jsonl-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function file(name) {
  return path.join(tmp, name);
}

// --- header stamping + seq allocation ---------------------------------------
{
  const f = file('basic.jsonl');
  const first = appendRecord(f, { kind: 'gate', payload: { exit_code: 0 } });
  const second = appendRecord(f, { kind: 'stop', correlation_id: 'mission-1' });

  assert.strictEqual(first.schema_version, 1);
  assert.strictEqual(first.seq, 0);
  assert.strictEqual(first.kind, 'gate');
  assert.strictEqual(first.exit_code, 0);
  assert.strictEqual(first.correlation_id, null, 'correlation_id defaults to null, always stamped');
  assert.ok(ISO_8601_UTC_RE.test(first.ts), 'ts must be ISO-8601 UTC Z');
  assert.strictEqual(second.seq, 1);
  assert.strictEqual(second.correlation_id, 'mission-1');

  const { records, errors } = readRecords(f);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(records.map((r) => r.seq), [0, 1]);
  assert.ok(!fs.existsSync(f + LOCK_SUFFIX), 'lockfile released after append');
}

// --- reserved header keys never overwritable by payload ---------------------
{
  const f = file('reserved.jsonl');
  for (const reserved of ['schema_version', 'seq', 'kind', 'ts', 'correlation_id']) {
    assert.throws(
      () => appendRecord(f, { kind: 'x', payload: { [reserved]: 'forged' } }),
      /reserved header field/,
      `payload key "${reserved}" must be refused`
    );
  }
  assert.throws(() => appendRecord(f, { kind: '' }), /kind must be a non-empty string/);
  assert.throws(() => appendRecord(f, { kind: 'x', payload: [] }), /plain object/);
  assert.throws(() => appendRecord(f, { kind: 'x', correlation_id: 7 }), /correlation_id/);
  assert.ok(!fs.existsSync(f), 'refused appends write nothing');
}

// --- 8192-byte line ceiling, exact boundary ---------------------------------
{
  // seq is 0 on a fresh file and ts is always 24 chars, so the full line
  // length is deterministic given the pad length.
  const overhead = Buffer.byteLength(
    JSON.stringify({
      schema_version: 1,
      seq: 0,
      kind: 'k',
      ts: '2026-01-01T00:00:00.000Z',
      correlation_id: null,
      pad: '',
    }) + '\n',
    'utf8'
  );

  const exact = file('ceiling-ok.jsonl');
  appendRecord(exact, { kind: 'k', payload: { pad: 'x'.repeat(LINE_CEILING - overhead) } });
  const written = fs.readFileSync(exact, 'utf8');
  assert.strictEqual(Buffer.byteLength(written, 'utf8'), LINE_CEILING, 'line lands exactly at the ceiling');

  const over = file('ceiling-over.jsonl');
  assert.throws(
    () => appendRecord(over, { kind: 'k', payload: { pad: 'x'.repeat(LINE_CEILING - overhead + 1) } }),
    /exceeding the 8192-byte ceiling/
  );
  assert.ok(!fs.existsSync(over), 'an over-ceiling record writes nothing');
  assert.ok(!fs.existsSync(over + LOCK_SUFFIX), 'lock released after a refused append');
}

// --- torn final line tolerance ----------------------------------------------
{
  const f = file('torn.jsonl');
  appendRecord(f, { kind: 'a' });
  fs.appendFileSync(f, '{"kind":"b","seq":9,"tor'); // writer died mid-append

  const torn = readRecords(f);
  assert.strictEqual(torn.records.length, 1, 'readable prefix survives');
  assert.strictEqual(torn.errors.length, 1);
  assert.strictEqual(torn.errors[0].torn, true, 'final unterminated line is flagged torn');

  // Appending after a torn line must isolate the fragment, not fuse with it,
  // and seq continues from the readable records only (the torn seq:9 never parsed).
  const next = appendRecord(f, { kind: 'c' });
  assert.strictEqual(next.seq, 1);
  const after = readRecords(f);
  assert.strictEqual(after.records.length, 2);
  assert.deepStrictEqual(after.records.map((r) => r.kind), ['a', 'c']);
  assert.strictEqual(after.errors.length, 1, 'torn fragment stays isolated as one bad line');
  assert.strictEqual(after.errors[0].torn, false, 'fragment is now newline-terminated mid-file');
}

// --- interior malformed line does not sink the stream -----------------------
{
  const f = file('interior.jsonl');
  appendRecord(f, { kind: 'a' });
  fs.appendFileSync(f, 'not json at all\n');
  appendRecord(f, { kind: 'b' });
  const { records, errors } = readRecords(f);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].line, 2);
  assert.strictEqual(errors[0].torn, false);
}

// --- missing file reads as empty --------------------------------------------
assert.deepStrictEqual(readRecords(file('nope.jsonl')), { records: [], errors: [] });

// --- stale lock reclaim ------------------------------------------------------
{
  const f = file('stale.jsonl');
  const lock = f + LOCK_SUFFIX;
  fs.writeFileSync(lock, '');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(lock, old, old);
  const rec = appendRecord(f, { kind: 'reclaimed' });
  assert.strictEqual(rec.seq, 0, 'a 60s-old lock is reclaimed, not waited on');
}

// --- ELOCKTIMEOUT on a live contended lock ----------------------------------
{
  const f = file('timeout.jsonl');
  fs.writeFileSync(f + LOCK_SUFFIX, '');
  const started = Date.now();
  assert.throws(
    () => withLock(f, () => {}),
    (err) => err.code === LOCK_TIMEOUT_CODE,
    'a fresh foreign lock must time out with ELOCKTIMEOUT'
  );
  const waited = Date.now() - started;
  assert.ok(waited >= 4900, `timed out after ${waited}ms; expected ~5000ms`);
  fs.rmSync(f + LOCK_SUFFIX);
}

// --- lock contention: two concurrent appenders, unique seqs ------------------
{
  const f = file('contended.jsonl');
  const perWriter = 25;
  const script = `
    const { appendRecord } = require(${JSON.stringify(SRC)});
    for (let i = 0; i < ${perWriter}; i++) {
      appendRecord(${JSON.stringify(f)}, { kind: 'w' + process.argv[1], payload: { i } });
    }
  `;
  const children = ['1', '2'].map(
    (id) =>
      new Promise((resolve, reject) => {
        const { execFile } = require('node:child_process');
        execFile(process.execPath, ['-e', script, id], (err) => (err ? reject(err) : resolve()));
      })
  );
  Promise.all(children)
    .then(() => {
      const { records, errors } = readRecords(f);
      assert.strictEqual(errors.length, 0, 'no torn lines under contention');
      assert.strictEqual(records.length, perWriter * 2);
      const seqs = new Set(records.map((r) => r.seq));
      assert.strictEqual(seqs.size, perWriter * 2, 'every seq unique');
      for (let i = 0; i < perWriter * 2; i++) {
        assert.ok(seqs.has(i), `seq ${i} allocated with no gap`);
      }
      assert.ok(!fs.existsSync(f + LOCK_SUFFIX), 'no lockfile left behind');
      console.log('test-jsonl: OK');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

// --- --help self-documentation ----------------------------------------------
{
  const out = execFileSync(process.execPath, [SRC, '--help'], { encoding: 'utf8' });
  assert.ok(out.includes('withLock'), '--help names the exports');
}
