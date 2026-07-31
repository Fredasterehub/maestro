'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'src', 'gate.js');
const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-gate-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

const BRIEF = {
  outcome: 'o',
  scope: 's',
  anchors: ['a.js'],
  acceptance: 'a',
  freshness: 'f',
  tier: 't',
  return_format: 'r',
  stop_condition: 'sc',
};

// gates need a real mission behind them
assert.strictEqual(
  run(MISSION, ['open', root], { mission_id: 'm1', title: 'Gate testbed', brief: BRIEF }).status,
  0
);

function ledgerOf() {
  return readRecords(path.join(root, 'ledger.jsonl'));
}

// --- help --------------------------------------------------------------------
{
  const r = run(GATE, ['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /gate\.js — maestro gate runner/);
}

// --- run-gate: passing command -----------------------------------------------
{
  const r = run(GATE, ['run-gate', root, 'm1', 'tests', '--', 'sh', '-c', 'echo hello; echo world']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 0);
  assert.deepStrictEqual(out.cmd, ['sh', '-c', 'echo hello; echo world']);

  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'gate');
  assert.strictEqual(rec.gate_id, 'tests');
  assert.strictEqual(rec.mission_id, 'm1');
  assert.strictEqual(rec.exit_code, 0);
  assert.strictEqual(rec.seq, out.ledger_seq);
  assert.strictEqual(rec.correlation_id, 'm1');

  const log = fs.readFileSync(out.log, 'utf8');
  assert.strictEqual(out.log, path.join(root, 'missions', 'm1', 'artifacts', 'gate-tests.log'));
  assert.match(log, /exit_code: 0/);
  assert.match(log, /hello\nworld/);
}

// --- run-gate: only the last 20 output lines are kept ------------------------
{
  const r = run(GATE, ['run-gate', root, 'm1', 'noisy', '--', 'sh', '-c', 'seq 1 50']);
  assert.strictEqual(r.status, 0, r.stderr);
  const log = fs.readFileSync(JSON.parse(r.stdout).log, 'utf8');
  assert.doesNotMatch(log, /^30$/m, 'line 30 must be truncated away');
  assert.match(log, /^31$/m, 'line 31 is the first kept line');
  assert.match(log, /^50$/m);
}

// --- run-gate: failing command recorded honestly, CLI still exits 0 ----------
{
  const r = run(GATE, ['run-gate', root, 'm1', 'lint', '--', 'sh', '-c', 'echo broken >&2; exit 3']);
  assert.strictEqual(r.status, 0, 'recording a failure is itself a success');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 3);

  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.gate_id, 'lint');
  assert.strictEqual(rec.exit_code, 3);
  assert.match(fs.readFileSync(out.log, 'utf8'), /broken/);
}

// --- run-gate: spawn failure recorded as exit 1, never a silent pass ---------
{
  const r = run(GATE, ['run-gate', root, 'm1', 'ghostbin', '--', 'no-such-binary-xyz']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 1);
  assert.match(fs.readFileSync(out.log, 'utf8'), /spawn_error/);
}

// --- run-gate: refusals ------------------------------------------------------
{
  // unknown mission — nothing recorded
  const before = ledgerOf().records.length;
  let r = run(GATE, ['run-gate', root, 'ghost', 'tests', '--', 'true']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no such mission/);
  assert.strictEqual(ledgerOf().records.length, before);

  // missing -- separator
  r = run(GATE, ['run-gate', root, 'm1', 'tests', 'true']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--/);

  // empty command after --
  r = run(GATE, ['run-gate', root, 'm1', 'tests', '--']);
  assert.strictEqual(r.status, 1);

  // unsafe gateId
  r = run(GATE, ['run-gate', root, 'm1', '../gate', '--', 'true']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /gateId/);
}

// --- run-gate: a closed mission's evidence stream is immutable ---------------
{
  assert.strictEqual(
    run(MISSION, ['open', root], { mission_id: 'm2', title: 'Closable', brief: BRIEF }).status,
    0
  );
  const pass = run(GATE, ['run-gate', root, 'm2', 'tests', '--', 'true']);
  assert.strictEqual(pass.status, 0, pass.stderr);
  const closed = run(MISSION, ['close', root, 'm2'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: JSON.parse(pass.stdout).ledger_seq,
  });
  assert.strictEqual(closed.status, 0, closed.stderr);

  const before = ledgerOf().records.length;
  const r = run(GATE, ['run-gate', root, 'm2', 'postclose', '--', 'true']);
  assert.strictEqual(r.status, 1, 'run-gate must refuse a done mission');
  assert.match(r.stderr, /status "done"/);
  assert.strictEqual(ledgerOf().records.length, before, 'no gate record on a closed mission');
  assert.ok(
    !fs.existsSync(path.join(root, 'missions', 'm2', 'artifacts', 'gate-postclose.log')),
    'no gate log on a closed mission'
  );
}

// --- run-gate: symlinked artifacts/ cannot aim the log out of the tree -------
{
  assert.strictEqual(
    run(MISSION, ['open', root], { mission_id: 'm3', title: 'Escape testbed', brief: BRIEF }).status,
    0
  );
  const outside = path.join(tmp, 'outside-artifacts');
  fs.mkdirSync(outside);
  const artifactsDir = path.join(root, 'missions', 'm3', 'artifacts');
  fs.rmdirSync(artifactsDir);
  fs.symlinkSync(outside, artifactsDir);

  const before = ledgerOf().records.length;
  const r = run(GATE, ['run-gate', root, 'm3', 'escape', '--', 'true']);
  assert.strictEqual(r.status, 1, 'run-gate must refuse a log path escaping the tree');
  assert.match(r.stderr, /outside treeRoot|symlink/);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'no log escaped the tree');
  assert.strictEqual(ledgerOf().records.length, before, 'refused gate records nothing');
}

// --- check-honesty -----------------------------------------------------------
{
  // passing gate: honest
  let r = run(GATE, ['check-honesty', root, 'm1', 'tests']);
  assert.strictEqual(r.status, 0, r.stderr);
  let verdict = JSON.parse(r.stdout);
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.exit_code, 0);

  // failing gate: dishonest
  r = run(GATE, ['check-honesty', root, 'm1', 'lint']);
  assert.strictEqual(r.status, 1);
  verdict = JSON.parse(r.stdout);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.exit_code, 3);

  // no record at all
  r = run(GATE, ['check-honesty', root, 'm1', 'never-ran']);
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout).reason, /no gate record/);

  // latest-by-seq: a later failure invalidates an earlier pass
  assert.strictEqual(run(GATE, ['run-gate', root, 'm1', 'tests', '--', 'false']).status, 0);
  r = run(GATE, ['check-honesty', root, 'm1', 'tests']);
  assert.strictEqual(r.status, 1, 'stale success must not paper over a later failure');
  assert.strictEqual(JSON.parse(r.stdout).ok, false);

  // ...and a later pass restores honesty
  assert.strictEqual(run(GATE, ['run-gate', root, 'm1', 'tests', '--', 'true']).status, 0);
  r = run(GATE, ['check-honesty', root, 'm1', 'tests']);
  assert.strictEqual(r.status, 0);

  // wrong arity fails closed
  r = run(GATE, ['check-honesty', root, 'm1']);
  assert.strictEqual(r.status, 1);

  // malformed ledger line fails closed
  fs.appendFileSync(path.join(root, 'ledger.jsonl'), '{torn\n');
  r = run(GATE, ['check-honesty', root, 'm1', 'tests']);
  assert.strictEqual(r.status, 1);
  assert.match(JSON.parse(r.stdout).reason, /malformed/);
}

// --- unknown command ---------------------------------------------------------
{
  const r = run(GATE, ['frobnicate']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown command/);
}

console.log('test-gate: OK');
