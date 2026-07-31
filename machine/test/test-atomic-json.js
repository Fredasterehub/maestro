'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'atomic-json.js');
const { readJson, writeJson, updateJson } = require(SRC);
const { LOCK_SUFFIX } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-atomic-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function file(name) {
  return path.join(tmp, name);
}

function tempFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
}

// --- roundtrip + fallback ----------------------------------------------------
{
  const f = file('state.json');
  assert.strictEqual(readJson(f, undefined), undefined, 'missing file yields the fallback');
  assert.deepStrictEqual(readJson(f, { seeded: true }), { seeded: true });

  writeJson(f, { missions: {}, active_mission: null });
  assert.deepStrictEqual(readJson(f, null), { missions: {}, active_mission: null });
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'), 'written file is newline-terminated');
  assert.strictEqual(tempFilesIn(tmp).length, 0, 'no temp files left after write');
}

// --- atomic replacement ------------------------------------------------------
{
  const f = file('replace.json');
  writeJson(f, { generation: 1 });
  writeJson(f, { generation: 2 });
  assert.deepStrictEqual(readJson(f, null), { generation: 2 });
  assert.strictEqual(tempFilesIn(tmp).length, 0, 'replacement leaves no temp residue');
}

// --- unserializable value leaves the original intact -------------------------
{
  const f = file('intact.json');
  writeJson(f, { safe: true });
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJson(f, circular), /cannot serialize/);
  assert.throws(() => writeJson(f, undefined), /serializes to undefined|cannot serialize/);
  assert.deepStrictEqual(readJson(f, null), { safe: true }, 'failed write changed nothing');
  assert.strictEqual(tempFilesIn(tmp).length, 0, 'failed write leaves no temp residue');
}

// --- corrupt file throws (never silently returns the fallback) ---------------
{
  const f = file('corrupt.json');
  fs.writeFileSync(f, '{ torn');
  assert.throws(() => readJson(f, { fallback: true }), /failed to parse JSON/);
}

// --- updateJson: locked read-modify-write ------------------------------------
{
  const f = file('counter.json');
  const result = updateJson(f, (cur) => ({ n: cur.n + 1 }), { n: 0 });
  assert.deepStrictEqual(result, { n: 1 }, 'updateJson returns the persisted value');
  updateJson(f, (cur) => ({ n: cur.n + 1 }), { n: 0 });
  assert.deepStrictEqual(readJson(f, null), { n: 2 });
  assert.ok(!fs.existsSync(f + LOCK_SUFFIX), 'lock released after update');
  assert.throws(() => updateJson(f, 'not a function'), /updater function/);
}

// --- updater throw aborts the transaction and releases the lock --------------
{
  const f = file('abort.json');
  writeJson(f, { committed: 1 });
  assert.throws(
    () =>
      updateJson(f, () => {
        throw new Error('precondition failed');
      }),
    /precondition failed/
  );
  assert.deepStrictEqual(readJson(f, null), { committed: 1 }, 'aborted update changed nothing');
  // Lock must be free: an immediate follow-up update succeeds without waiting.
  const started = Date.now();
  updateJson(f, (cur) => ({ committed: cur.committed + 1 }), null);
  assert.ok(Date.now() - started < 1000, 'lock was released by the aborted update');
  assert.deepStrictEqual(readJson(f, null), { committed: 2 });
}

// --- contention: two concurrent updaters lose no increments ------------------
{
  const f = file('contended.json');
  writeJson(f, { n: 0 });
  const perWriter = 25;
  const script = `
    const { updateJson } = require(${JSON.stringify(SRC)});
    for (let i = 0; i < ${perWriter}; i++) {
      updateJson(${JSON.stringify(f)}, (cur) => ({ n: cur.n + 1 }));
    }
  `;
  const { execFile } = require('node:child_process');
  const children = [0, 1].map(
    () =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', script], (err) => (err ? reject(err) : resolve()));
      })
  );
  Promise.all(children)
    .then(() => {
      assert.deepStrictEqual(readJson(f, null), { n: perWriter * 2 }, 'no update lost under contention');
      assert.ok(!fs.existsSync(f + LOCK_SUFFIX), 'no lockfile left behind');
      console.log('test-atomic-json: OK');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

// --- --help self-documentation ----------------------------------------------
{
  const out = execFileSync(process.execPath, [SRC, '--help'], { encoding: 'utf8' });
  assert.ok(out.includes('updateJson'), '--help names the exports');
}
