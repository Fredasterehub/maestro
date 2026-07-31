'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'friction.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { recordFriction, computeRates } = require(SRC);

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-friction-'));
}

function runCli(args, input) {
  return spawnSync(process.execPath, [SRC, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function friction(overrides) {
  return {
    kind: 'ladder-engaged',
    mission_id: 'm1',
    detail: 'retry-distinct exhausted; convergence pass dispatched',
    ...overrides,
  };
}

// --- happy path: ledger kind is the friction kind verbatim -------------------
{
  const tree = makeTree();
  const rec = recordFriction(tree, friction());
  assert.strictEqual(rec.kind, 'ladder-engaged', 'ledger kind is the friction kind verbatim, not a wrapper');
  assert.strictEqual(rec.seq, 0);
  assert.strictEqual(rec.mission_id, 'm1');
  assert.strictEqual(rec.detail, friction().detail);
  assert.strictEqual(rec.correlation_id, 'm1');
  assert.strictEqual(rec.seat, undefined, 'seat omitted when not provided');

  const { records } = readRecords(path.join(tree, 'ledger.jsonl'));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].kind, 'ladder-engaged');
  assert.strictEqual(records[0].schema_version, 1);
  assert.ok(typeof records[0].ts === 'string');
}

// --- seat is carried when present, absent otherwise ---------------------------
{
  const tree = makeTree();
  const rec = recordFriction(tree, friction({ kind: 'seat-degraded', seat: 'reviewer-sol', detail: 'codex down; reviewer-sol substituted' }));
  assert.strictEqual(rec.kind, 'seat-degraded');
  assert.strictEqual(rec.seat, 'reviewer-sol');
}

// --- closed vocabulary + exact-key shape enforced -----------------------------
{
  const tree = makeTree();
  assert.throws(() => recordFriction(tree, friction({ kind: 'oh-no' })), /"kind" must be one of/);
  assert.throws(() => recordFriction(tree, friction({ mission_id: '' })), /"mission_id" must be a non-empty string/);
  assert.throws(() => recordFriction(tree, friction({ detail: '' })), /"detail" must be a non-empty string/);
  assert.throws(() => recordFriction(tree, friction({ detail: 'a\nb' })), /must not contain a newline/);
  assert.throws(() => recordFriction(tree, friction({ detail: 'x'.repeat(201) })), /at most 200 characters/);
  assert.throws(() => recordFriction(tree, friction({ seat: '' })), /"seat" must be a non-empty string when present/);
  const missing = friction();
  delete missing.mission_id;
  assert.throws(() => recordFriction(tree, missing), /missing required key "mission_id"/);
  assert.throws(() => recordFriction(tree, friction({ severity: 'S2' })), /unexpected extra key "severity"/);
  assert.throws(() => recordFriction(tree, ['not', 'an', 'object']), /plain object/);
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')), 'refusals must write nothing');
}

// --- 200-char detail is exactly the ceiling, accepted -------------------------
{
  const tree = makeTree();
  const rec = recordFriction(tree, friction({ detail: 'x'.repeat(200) }));
  assert.strictEqual(rec.detail.length, 200);
}

// --- treeRoot must exist -------------------------------------------------------
{
  const tree = makeTree();
  assert.throws(() => recordFriction(path.join(tree, 'nope'), friction()), /scaffold it first/);
  assert.throws(() => computeRates(path.join(tree, 'nope')), /scaffold it first/);
}

// --- rates: zero friction is a legitimate, fully-shaped outcome ---------------
{
  const tree = makeTree();
  const rates = computeRates(tree);
  assert.deepStrictEqual(rates.by_kind, {
    'ladder-engaged': 0,
    'seat-degraded': 0,
    'worker-died': 0,
    'revise-verdict': 0,
  });
  assert.deepStrictEqual(rates.by_mission, {});
  assert.deepStrictEqual(rates.revise_verdict_by_mission, {});
  assert.strictEqual(rates.ladder_engaged_total, 0);
  assert.strictEqual(rates.unparseable_lines, 0);
}

// --- rates: mixed kinds across missions aggregate correctly -------------------
{
  const tree = makeTree();
  recordFriction(tree, friction({ kind: 'revise-verdict', mission_id: 'm1', detail: 'round 1 revise: missing edge case' }));
  recordFriction(tree, friction({ kind: 'revise-verdict', mission_id: 'm1', detail: 'round 2 revise: same theme resurfaced' }));
  recordFriction(tree, friction({ kind: 'ladder-engaged', mission_id: 'm1', detail: 'revise cap hit; ladder engaged' }));
  recordFriction(tree, friction({ kind: 'seat-degraded', mission_id: 'm2', seat: 'reviewer-gemini', detail: 'gemini down; claude substitute' }));
  recordFriction(tree, friction({ kind: 'worker-died', mission_id: 'm2', seat: 'executor-sol', detail: 'seat died mid-task; re-dispatched' }));
  recordFriction(tree, friction({ kind: 'revise-verdict', mission_id: 'm3', detail: 'single revise round' }));

  const rates = computeRates(tree);
  assert.deepStrictEqual(rates.by_kind, {
    'ladder-engaged': 1,
    'seat-degraded': 1,
    'worker-died': 1,
    'revise-verdict': 3,
  });
  assert.strictEqual(rates.by_mission.m1.total, 3);
  assert.strictEqual(rates.by_mission.m1['revise-verdict'], 2);
  assert.strictEqual(rates.by_mission.m1['ladder-engaged'], 1);
  assert.strictEqual(rates.by_mission.m2.total, 2);
  assert.strictEqual(rates.by_mission.m2['seat-degraded'], 1);
  assert.strictEqual(rates.by_mission.m2['worker-died'], 1);
  assert.strictEqual(rates.by_mission.m3.total, 1);
  assert.deepStrictEqual(rates.revise_verdict_by_mission, { m1: 2, m2: 0, m3: 1 });
  assert.strictEqual(rates.ladder_engaged_total, 1);

  // Non-friction ledger kinds (e.g. from other writers sharing the stream)
  // are skipped by rates, never miscounted as friction.
  const { appendRecord } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
  appendRecord(path.join(tree, 'ledger.jsonl'), { kind: 'genesis', payload: {} });
  const rates2 = computeRates(tree);
  assert.strictEqual(rates2.by_kind['revise-verdict'], 3, 'genesis record does not pollute friction counts');
}

// --- CLI: happy path, argv fail-closed, stdin fail-closed ----------------------
{
  const tree = makeTree();
  let r = runCli(['record', tree], friction());
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.strictEqual(rec.kind, 'ladder-engaged');

  assert.strictEqual(runCli(['record', tree, 'surplus'], friction()).status, 1, 'surplus arg refused');
  assert.strictEqual(runCli(['bogus', tree]).status, 1, 'unknown command refused');
  assert.strictEqual(runCli([]).status, 1, 'missing command refused');
  const badJson = spawnSync(process.execPath, [SRC, 'record', tree], { input: 'nope', encoding: 'utf8' });
  assert.strictEqual(badJson.status, 1, 'malformed stdin JSON refused');
  assert.strictEqual(runCli(['--help']).status, 0, '--help exits 0');

  const { records } = readRecords(path.join(tree, 'ledger.jsonl'));
  assert.strictEqual(records.length, 1, 'only the one valid CLI record landed');
}

// --- CLI: rates ------------------------------------------------------------
{
  const tree = makeTree();
  runCli(['record', tree], friction({ kind: 'revise-verdict', detail: 'first revise' }));
  runCli(['record', tree], friction({ kind: 'revise-verdict', detail: 'second revise, ladder next' }));
  const r = runCli(['rates', tree]);
  assert.strictEqual(r.status, 0, r.stderr);
  const rates = JSON.parse(r.stdout);
  assert.strictEqual(rates.revise_verdict_by_mission.m1, 2);
  assert.strictEqual(rates.ladder_engaged_total, 0);

  assert.strictEqual(runCli(['rates', tree, 'surplus']).status, 1, 'surplus arg refused');
  assert.strictEqual(runCli(['rates']).status, 1, 'missing treeRoot refused');
}

console.log('test-friction: ok');
