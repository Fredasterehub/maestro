'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'roster.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-roster-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function run(args, stdin) {
  return spawnSync(process.execPath, [SRC, ...args], {
    encoding: 'utf8',
    input: stdin === undefined ? undefined : stdin,
  });
}

function readRoster(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'roster.json'), 'utf8'));
}

function registration(overrides) {
  return {
    seat: 'executor-sol',
    task_id: 't-1',
    family: 'gpt',
    codex_session: 'sess-abc',
    mission_id: 'm-1',
    ...overrides,
  };
}

// --- register happy path -----------------------------------------------------
{
  const root = freshTree('happy');
  const r = run(['register', root], JSON.stringify(registration()));
  assert.strictEqual(r.status, 0, r.stderr);
  const entry = JSON.parse(r.stdout);
  assert.strictEqual(entry.seat, 'executor-sol');
  assert.strictEqual(entry.task_id, 't-1');
  assert.strictEqual(entry.family, 'gpt');
  assert.strictEqual(entry.codex_session, 'sess-abc');
  assert.strictEqual(entry.status, 'alive');
  assert.ok(!Number.isNaN(Date.parse(entry.spawned_ts)), 'spawned_ts is a timestamp');
  assert.strictEqual(entry.spawned_ts, entry.last_seen, 'freshly spawned entry has last_seen = spawned_ts');

  const roster = readRoster(root);
  assert.strictEqual(roster.schema_version, 1);
  assert.strictEqual(roster.entries.length, 1);
}

// --- double-register refusal: same seat while alive --------------------------
{
  const root = freshTree('double');
  assert.strictEqual(run(['register', root], JSON.stringify(registration())).status, 0);
  const dup = run(['register', root], JSON.stringify(registration({ task_id: 't-2' })));
  assert.strictEqual(dup.status, 1, 'live-seat double register must be refused');
  assert.match(dup.stderr, /never double a name/);
  assert.strictEqual(readRoster(root).entries.length, 1, 'refused registration wrote nothing');

  // Same task_id refused regardless of seat.
  const dupTask = run(['register', root], JSON.stringify(registration({ seat: 'scout', family: 'claude' })));
  assert.strictEqual(dupTask.status, 1);
  assert.match(dupTask.stderr, /task_id "t-1" is already registered/);

  // Once the live entry is finished, the seat name is reusable.
  assert.strictEqual(run(['mark', root, 't-1', 'finished']).status, 0);
  const reuse = run(['register', root], JSON.stringify(registration({ task_id: 't-2' })));
  assert.strictEqual(reuse.status, 0, reuse.stderr);
  assert.strictEqual(readRoster(root).entries.length, 2);
}

// --- register input validation ----------------------------------------------
{
  const root = freshTree('validate');
  const noFamily = run(['register', root], JSON.stringify({ seat: 's', task_id: 't' }));
  assert.strictEqual(noFamily.status, 1);
  assert.match(noFamily.stderr, /"family" must be a non-empty string/);

  const badFamily = run(['register', root], JSON.stringify(registration({ family: 'mistral' })));
  assert.strictEqual(badFamily.status, 1);
  assert.match(badFamily.stderr, /"family" must be one of claude, gpt, gemini/);

  const extraKey = run(['register', root], JSON.stringify(registration({ sneaky: true })));
  assert.strictEqual(extraKey.status, 1);
  assert.match(extraKey.stderr, /unexpected extra key "sneaky"/);

  const badJson = run(['register', root], '{ torn');
  assert.strictEqual(badJson.status, 1);
  assert.match(badJson.stderr, /stdin did not carry valid JSON/);

  const noTree = run(['register', path.join(tmp, 'missing-tree')], JSON.stringify(registration()));
  assert.strictEqual(noTree.status, 1);
  assert.match(noTree.stderr, /tree root does not exist/);
}

// --- heartbeat ---------------------------------------------------------------
{
  const root = freshTree('heartbeat');
  run(['register', root], JSON.stringify(registration()));
  const before = readRoster(root).entries[0].last_seen;
  // A heartbeat strictly later than registration must move last_seen.
  const wait = Date.now() + 5;
  while (Date.now() < wait);
  const hb = run(['heartbeat', root, 't-1']);
  assert.strictEqual(hb.status, 0, hb.stderr);
  const after = JSON.parse(hb.stdout).last_seen;
  assert.ok(Date.parse(after) > Date.parse(before), 'heartbeat advanced last_seen');

  const unknown = run(['heartbeat', root, 'nope']);
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /no roster entry for task_id "nope"/);

  run(['mark', root, 't-1', 'zombie']);
  const zombieHb = run(['heartbeat', root, 't-1']);
  assert.strictEqual(zombieHb.status, 1, 'heartbeat on a non-alive entry is refused');
  assert.match(zombieHb.stderr, /is zombie, not alive/);
}

// --- mark --------------------------------------------------------------------
{
  const root = freshTree('mark');
  run(['register', root], JSON.stringify(registration()));
  const bad = run(['mark', root, 't-1', 'sleeping']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /status must be one of alive, zombie, dead, finished/);

  const ok = run(['mark', root, 't-1', 'zombie']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).status, 'zombie');
  assert.strictEqual(readRoster(root).entries[0].status, 'zombie');

  // mark can bring a zombie back to alive.
  assert.strictEqual(run(['mark', root, 't-1', 'alive']).status, 0);
  assert.strictEqual(readRoster(root).entries[0].status, 'alive');
}

// --- reconcile marks dead ----------------------------------------------------
{
  const root = freshTree('reconcile');
  run(['register', root], JSON.stringify(registration({ seat: 'scout', task_id: 't-1', family: 'claude' })));
  run(['register', root], JSON.stringify(registration({ seat: 'executor-sol', task_id: 't-2' })));
  run(['register', root], JSON.stringify(registration({ seat: 'researcher', task_id: 't-3', family: 'claude' })));
  run(['mark', root, 't-3', 'finished']);

  const r = run(['reconcile', root], JSON.stringify(['t-2']));
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  const summary = lines[lines.length - 1];
  assert.match(summary, /^reconcile: 3 entries — 1 alive, 0 zombie, 1 dead \(1 newly marked\), 1 finished$/);
  const roster = JSON.parse(lines.slice(0, -1).join('\n'));
  const byId = Object.fromEntries(roster.entries.map((e) => [e.task_id, e.status]));
  assert.strictEqual(byId['t-1'], 'dead', 'alive entry missing from the live list becomes dead');
  assert.strictEqual(byId['t-2'], 'alive');
  assert.strictEqual(byId['t-3'], 'finished', 'finished entry is untouched by reconcile');
  assert.deepStrictEqual(readRoster(root).entries.map((e) => e.status).sort(), ['alive', 'dead', 'finished']);

  const notArray = run(['reconcile', root], JSON.stringify({ live: [] }));
  assert.strictEqual(notArray.status, 1);
  assert.match(notArray.stderr, /JSON array of non-empty task-id strings/);
}

// --- retire ------------------------------------------------------------------
{
  const root = freshTree('retire');
  run(['register', root], JSON.stringify(registration()));
  const aliveRetire = run(['retire', root, 't-1']);
  assert.strictEqual(aliveRetire.status, 1, 'an alive entry never retires');
  assert.match(aliveRetire.stderr, /only finished or dead entries retire/);

  run(['mark', root, 't-1', 'finished']);
  const r = run(['retire', root, 't-1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readRoster(root).entries.length, 0, 'retired entry left the roster');

  const { records, errors } = readRecords(path.join(root, 'roster-archive.jsonl'));
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(records.length, 1);
  const rec = records[0];
  assert.strictEqual(rec.kind, 'roster_retire');
  assert.strictEqual(rec.schema_version, 1);
  assert.strictEqual(rec.seq, 0);
  assert.strictEqual(rec.correlation_id, 'm-1', 'mission_id rides as correlation_id');
  assert.strictEqual(rec.seat, 'executor-sol');
  assert.strictEqual(rec.task_id, 't-1');
  assert.strictEqual(rec.status, 'finished');
  assert.ok(!Number.isNaN(Date.parse(rec.retired_ts)));

  const gone = run(['retire', root, 't-1']);
  assert.strictEqual(gone.status, 1);
  assert.match(gone.stderr, /no roster entry/);
}

// --- CLI hygiene -------------------------------------------------------------
{
  const help = run(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /never double a name/);

  const unknownCmd = run(['obliterate', tmp]);
  assert.strictEqual(unknownCmd.status, 1);
  assert.match(unknownCmd.stderr, /unknown command "obliterate"/);

  const extraArg = run(['heartbeat', tmp, 't-1', 'surplus']);
  assert.strictEqual(extraArg.status, 1);
  assert.match(extraArg.stderr, /unexpected extra argument/);
}

console.log('test-roster: OK');
