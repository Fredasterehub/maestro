'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const GATE = path.join(__dirname, '..', 'src', 'gate.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { readJson } = require(path.join(__dirname, '..', 'src', 'atomic-json.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mission-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

function mission(args, stdin) {
  return run(MISSION, args, stdin);
}

const VALID_BRIEF = {
  outcome: 'ship the widget',
  scope: 'src/widget only',
  anchors: ['src/widget.js'],
  acceptance: 'tests pass',
  freshness: 'repo state as of today',
  tier: 'standard',
  return_format: 'six-field envelope',
  stop_condition: 'acceptance met or blocked',
};

function stateOf() {
  return readJson(path.join(root, 'state.json'), undefined);
}

function ledgerOf() {
  return readRecords(path.join(root, 'ledger.jsonl'));
}

// --- help --------------------------------------------------------------------
{
  const r = mission(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mission\.js — maestro mission lifecycle/);
}

// --- open: happy path --------------------------------------------------------
{
  const r = mission(['open', root], { mission_id: 'm1', title: 'First mission', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.mission_id, 'm1');

  const dir = path.join(root, 'missions', 'm1');
  for (const sub of ['mailbox', 'envelopes', 'artifacts']) {
    assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), `${sub}/ must exist`);
  }
  assert.deepStrictEqual(readJson(path.join(dir, 'brief.json')), VALID_BRIEF);

  const progress = readRecords(path.join(dir, 'progress.jsonl'));
  assert.strictEqual(progress.errors.length, 0);
  assert.strictEqual(progress.records.length, 1);
  assert.strictEqual(progress.records[0].kind, 'genesis', 'progress stream is genesis-seeded');

  const { records } = ledgerOf();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].kind, 'mission-open');
  assert.strictEqual(records[0].mission_id, 'm1');
  assert.strictEqual(records[0].title, 'First mission');
  assert.strictEqual(records[0].correlation_id, 'm1');

  const state = stateOf();
  assert.deepStrictEqual(state.missions.m1, {
    status: 'open',
    next_action: 'dispatch a worker against brief.json',
  });
}

// --- open: refusals ----------------------------------------------------------
{
  // duplicate id
  let r = mission(['open', root], { mission_id: 'm1', title: 'again', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /already exists/);

  // invalid brief refused, nothing created
  r = mission(['open', root], { mission_id: 'm-bad', title: 'x', brief: { outcome: 'only this' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid brief/);
  assert.ok(!fs.existsSync(path.join(root, 'missions', 'm-bad')), 'refused open writes nothing');
  assert.strictEqual(stateOf().missions['m-bad'], undefined);

  // unsafe mission_id refused
  r = mission(['open', root], { mission_id: '../evil', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /mission_id/);

  // extra key refused
  r = mission(['open', root], { mission_id: 'm2', title: 'x', brief: VALID_BRIEF, sneaky: 1 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /extra key "sneaky"/);

  // custom next_action honored
  r = mission(['open', root], { mission_id: 'm2', title: 'Second', brief: VALID_BRIEF, next_action: 'scout the tree' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.m2.next_action, 'scout the tree');
}

// --- checkpoint --------------------------------------------------------------
{
  const r = mission(['checkpoint', root, 'm1'], {
    step: 'wired the widget',
    done_evidence: 'commit abc1234',
    next: 'add tests',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.m1.next_action, 'add tests');

  const progress = readRecords(path.join(root, 'missions', 'm1', 'progress.jsonl'));
  assert.strictEqual(progress.records.length, 2);
  const cp = progress.records[1];
  assert.strictEqual(cp.kind, 'checkpoint');
  assert.strictEqual(cp.step, 'wired the widget');
  assert.strictEqual(cp.done_evidence, 'commit abc1234');
  assert.strictEqual(cp.next, 'add tests');

  // unknown mission refused
  const bad = mission(['checkpoint', root, 'ghost'], { step: 'a', done_evidence: 'b', next: 'c' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /no such mission/);

  // missing field refused
  const missing = mission(['checkpoint', root, 'm1'], { step: 'a', next: 'c' });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /done_evidence/);
}

// --- record-envelope ---------------------------------------------------------
{
  const envelope = {
    state: 'done',
    result: 'widget shipped',
    evidence: 'tests green, see artifact',
    risks: 'none observed',
    artifact: 'missions/m1/artifacts/report.md',
    question: '',
  };
  const r = mission(['record-envelope', root, 'm1', 'executor-sol'], envelope);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(fs.existsSync(out.envelope_path), 'envelope file written');
  assert.match(path.basename(out.envelope_path), /-executor-sol\.json$/);
  assert.deepStrictEqual(readJson(out.envelope_path), envelope);

  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'envelope');
  assert.strictEqual(rec.mission_id, 'm1');
  assert.strictEqual(rec.seat, 'executor-sol');
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(path.join(root, rec.path), out.envelope_path);

  // invalid envelope refused (blocked with empty question)
  const before = fs.readdirSync(path.join(root, 'missions', 'm1', 'envelopes')).length;
  const bad = mission(['record-envelope', root, 'm1', 'executor-sol'], { ...envelope, state: 'blocked' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid envelope/);
  assert.strictEqual(
    fs.readdirSync(path.join(root, 'missions', 'm1', 'envelopes')).length,
    before,
    'refused envelope writes nothing'
  );

  // unsafe seat refused
  const evil = mission(['record-envelope', root, 'm1', '../seat'], envelope);
  assert.strictEqual(evil.status, 1);
  assert.match(evil.stderr, /seat/);
}

// --- record-consult ----------------------------------------------------------
{
  const r = mission(['record-consult', root, 'm1'], {
    consult_id: 'c1',
    question: 'which config wins?',
    verdict: 'settings.json wins',
    anchor: 'src/config.js:42',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'consult');
  assert.strictEqual(rec.consult_id, 'c1');
  assert.strictEqual(rec.anchor, 'src/config.js:42');

  const bad = mission(['record-consult', root, 'm1'], { consult_id: 'c2', question: 'q', verdict: 'v' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /anchor/);
}

// --- gates for the close tests ----------------------------------------------
const passGate = run(GATE, ['run-gate', root, 'm1', 'tests', '--', 'true']);
assert.strictEqual(passGate.status, 0, passGate.stderr);
const passSeq = JSON.parse(passGate.stdout).ledger_seq;

const failGate = run(GATE, ['run-gate', root, 'm1', 'lint', '--', 'false']);
assert.strictEqual(failGate.status, 0, failGate.stderr);
const failSeq = JSON.parse(failGate.stdout).ledger_seq;
assert.strictEqual(JSON.parse(failGate.stdout).exit_code, 1);

const m2Gate = run(GATE, ['run-gate', root, 'm2', 'tests', '--', 'true']);
assert.strictEqual(m2Gate.status, 0, m2Gate.stderr);
const m2Seq = JSON.parse(m2Gate.stdout).ledger_seq;

// --- close: refusals ---------------------------------------------------------
{
  // same-family review
  let r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'gpt' },
    gate_seq: passSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /cross-family/);

  // revise verdict
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'revise', family: 'claude' },
    gate_seq: passSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /"revise"/);

  // verdict outside the vocabulary
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'lgtm', family: 'claude' },
    gate_seq: passSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /verdict/);

  // missing gate record
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: 9999,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no ledger record has seq 9999/);

  // failed gate
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: failSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exit_code 1/);

  // a ledger record that is not a gate (seq 0 is mission-open)
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: 0,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /kind "mission-open", not "gate"/);

  // another mission's gate
  r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: m2Seq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to mission "m2"/);

  // unknown family
  r = mission(['close', root, 'm1'], {
    author_family: 'grok',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: passSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /author_family/);

  assert.strictEqual(stateOf().missions.m1.status, 'open', 'every refusal leaves the mission open');
}

// --- close: happy path -------------------------------------------------------
{
  const r = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: passSeq,
  });
  assert.strictEqual(r.status, 0, r.stderr);

  const state = stateOf();
  assert.strictEqual(state.missions.m1.status, 'done');
  assert.strictEqual(state.missions.m1.next_action, null);

  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.kind, 'mission-close');
  assert.strictEqual(close.mission_id, 'm1');
  assert.strictEqual(close.author_family, 'gpt');
  assert.deepStrictEqual(close.review, { verdict: 'approve', family: 'claude' });
  assert.strictEqual(close.gate_seq, passSeq);
}

// --- a done mission accepts no further writes --------------------------------
{
  const again = mission(['close', root, 'm1'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: passSeq,
  });
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /status "done"/);

  const cp = mission(['checkpoint', root, 'm1'], { step: 'a', done_evidence: 'b', next: 'c' });
  assert.strictEqual(cp.status, 1);
  assert.match(cp.stderr, /status "done"/);

  const env = mission(['record-envelope', root, 'm1', 'scout'], {
    state: 'done',
    result: 'r',
    evidence: 'e',
    risks: 'none',
    artifact: 'a.md',
    question: '',
  });
  assert.strictEqual(env.status, 1);
  assert.match(env.stderr, /status "done"/);

  const consult = mission(['record-consult', root, 'm1'], {
    consult_id: 'c9',
    question: 'q',
    verdict: 'v',
    anchor: 'a:1',
  });
  assert.strictEqual(consult.status, 1);
  assert.match(consult.stderr, /status "done"/);
}

// --- close: a superseded green gate is stale evidence ------------------------
{
  // m2's "tests" gate passed at m2Seq; a later run of the same gate fails.
  const laterFail = run(GATE, ['run-gate', root, 'm2', 'tests', '--', 'false']);
  assert.strictEqual(laterFail.status, 0, laterFail.stderr);

  const stale = mission(['close', root, 'm2'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: m2Seq,
  });
  assert.strictEqual(stale.status, 1, 'close must refuse a green gate a newer run has turned red');
  assert.match(stale.stderr, /superseded by a later run/);
  assert.strictEqual(stateOf().missions.m2.status, 'open');

  // A fresh green run of the same gate restores closeability at its own seq.
  const rerun = run(GATE, ['run-gate', root, 'm2', 'tests', '--', 'true']);
  assert.strictEqual(rerun.status, 0, rerun.stderr);
  const freshSeq = JSON.parse(rerun.stdout).ledger_seq;
  const closed = mission(['close', root, 'm2'], {
    author_family: 'gpt',
    review: { verdict: 'approve', family: 'claude' },
    gate_seq: freshSeq,
  });
  assert.strictEqual(closed.status, 0, closed.stderr);
  assert.strictEqual(stateOf().missions.m2.status, 'done');
}

// --- symlink containment -----------------------------------------------------
{
  // open refused when missions/<id> is a pre-planted (dangling) symlink
  const nowhere = path.join(tmp, 'nowhere');
  fs.symlinkSync(nowhere, path.join(root, 'missions', 'm5'));
  const r = mission(['open', root], { mission_id: 'm5', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /symlink/);
  assert.ok(!fs.existsSync(nowhere), 'nothing created through the symlink');
  assert.strictEqual(stateOf().missions.m5, undefined);

  // record-envelope refused when envelopes/ is a symlink out of the tree
  const outside = path.join(tmp, 'outside-envelopes');
  fs.mkdirSync(outside);
  assert.strictEqual(
    mission(['open', root], { mission_id: 'm6', title: 'x', brief: VALID_BRIEF }).status,
    0
  );
  const envDir = path.join(root, 'missions', 'm6', 'envelopes');
  fs.rmdirSync(envDir);
  fs.symlinkSync(outside, envDir);
  const before = ledgerOf().records.length;
  const env = mission(['record-envelope', root, 'm6', 'scout'], {
    state: 'done',
    result: 'r',
    evidence: 'e',
    risks: 'none',
    artifact: 'a.md',
    question: '',
  });
  assert.strictEqual(env.status, 1);
  assert.match(env.stderr, /symlink/);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'no envelope escaped the tree');
  assert.strictEqual(ledgerOf().records.length, before, 'no ledger record for the refused envelope');
}

// --- argv fail-closed --------------------------------------------------------
{
  let r = mission(['open', root, 'surplus'], { mission_id: 'x', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exactly 1 argument/);

  r = mission(['frobnicate', root]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown command/);

  r = run(MISSION, ['checkpoint', root, 'm2'], undefined); // empty stdin
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /valid JSON/);
}

console.log('test-mission: OK');
