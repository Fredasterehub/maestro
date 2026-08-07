'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'src', 'gate.js');
const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { artifactIdentity } = require(GATE);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-gate-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');

// Every run happens in tmp, which is no git worktree, so these tests never
// depend on the ambient repository; the identity blocks below name a real one.
function run(script, args, stdin, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
    cwd: cwd === undefined ? tmp : cwd,
  });
}

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let repoCounter = 0;
function newRepo() {
  repoCounter += 1;
  const repo = path.join(tmp, `worktree${repoCounter}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@maestro.invalid');
  git(repo, 'config', 'user.name', 'maestro test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'work');
  return repo;
}

const BRIEF = {
  outcome: 'o',
  scope: 's',
  anchors: ['a.js'],
  acceptance: 'a',
  freshness: 'f',
  tier: 'standard',
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

// --- run-gate: outside a git worktree, the missing identity is recorded ------
{
  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.artifact_identity, null, 'no git context yields no identity');
  assert.strictEqual(rec.identity_check.verified, null, 'nothing was verified, and it does not claim to be');
  assert.match(rec.identity_check.error, /not a git worktree/);
  assert.deepStrictEqual(rec.identity_check.changed, null);
}

// --- run-gate: records the identity it actually tested -----------------------
{
  const repo = newRepo();
  const expected = artifactIdentity(repo);

  const r = run(GATE, ['run-gate', '--worktree', repo, root, 'm1', 'identity', '--', 'sh', '-c', 'cat a.txt'], undefined);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 0);
  assert.deepStrictEqual(out.artifact_identity, expected, 'the gate names the identity of the tree it ran in');

  const rec = ledgerOf().records[ledgerOf().records.length - 1];
  assert.deepStrictEqual(rec.artifact_identity, expected, 'the record carries it too');
  assert.strictEqual(rec.identity_check.verified, true, 'the tree was unchanged across the gate');
  assert.deepStrictEqual(rec.identity_check.changed, []);
  assert.strictEqual(rec.identity_check.error, null);

  const log = fs.readFileSync(out.log, 'utf8');
  assert.match(log, new RegExp(`source_head: ${expected.source_head}`));
  assert.match(log, /one\ntwo/, 'the command really ran in the worktree');

  // and the pass is honest evidence
  assert.strictEqual(run(GATE, ['check-honesty', root, 'm1', 'identity']).status, 0);
}

// --- run-gate: a gate that mutates the tree it tested is a recorded defect ---
{
  const repo = newRepo();
  const before = artifactIdentity(repo);

  const r = run(GATE, [
    'run-gate', '--worktree', repo, root, 'm1', 'mutating', '--',
    'sh', '-c', 'echo three >> a.txt',
  ]);
  assert.strictEqual(r.status, 0, 'recording the defect is itself a success');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 0, 'the command really did exit 0 — that is recorded honestly');

  const rec = ledgerOf().records[ledgerOf().records.length - 1];
  assert.deepStrictEqual(rec.artifact_identity, before, 'the identity recorded is the one that was tested');
  assert.strictEqual(rec.identity_check.verified, false);
  assert.deepStrictEqual(
    rec.identity_check.changed,
    [{ field: 'dirty', before: false, after: true }],
    'the mutation is named field by field'
  );
  assert.match(fs.readFileSync(out.log, 'utf8'), /identity_mutation: .*dirty/);

  // A pass produced by a gate that changed the tree under it is not evidence.
  const honesty = run(GATE, ['check-honesty', root, 'm1', 'mutating']);
  assert.strictEqual(honesty.status, 1, 'a tree-mutating gate cannot back a pass');
  const verdict = JSON.parse(honesty.stdout);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /mutated the tree it tested.*dirty/);

  assert.strictEqual(artifactIdentity(repo).dirty, true, 'the mutation is left in place, not tidied away');
}

// --- run-gate: --worktree must name a real git worktree ----------------------
{
  const before = ledgerOf().records.length;
  const r = run(GATE, ['run-gate', '--worktree', path.join(tmp, 'nowhere'), root, 'm1', 'ghosttree', '--', 'true']);
  assert.strictEqual(r.status, 1, 'an explicitly named worktree that does not exist is a refusal');
  assert.match(r.stderr, /no such worktree/);
  assert.strictEqual(ledgerOf().records.length, before, 'refused gate records nothing');
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
