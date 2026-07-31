'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'hold.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { recordPark, openHolds, resolveHold, S1_REFUSAL } = require(SRC);

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-hold-'));
}

function runCli(args, input) {
  return spawnSync(process.execPath, [SRC, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
  });
}

// --- S1 park refusal ---------------------------------------------------------
{
  const tree = makeTree();
  const r = runCli(['park', tree], { summary: 'foundational schema dispute', severity: 'S1' });
  assert.strictEqual(r.status, 1, 'S1 park must exit 1');
  assert.ok(r.stderr.includes(S1_REFUSAL), `stderr must carry "${S1_REFUSAL}", got: ${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(tree, 'holds.jsonl')), 'S1 refusal must write nothing');

  assert.throws(() => recordPark(tree, { summary: 'x', severity: 'S1' }), new RegExp(S1_REFUSAL.replace(/[;+]/g, '\\$&')));
}

// --- park validation ---------------------------------------------------------
{
  const tree = makeTree();
  assert.throws(() => recordPark(tree, { severity: 'S2' }), /missing required key "summary"/);
  assert.throws(() => recordPark(tree, { summary: 'x', severity: 'S4' }), /"severity" must be "S2" or "S3"/);
  assert.throws(() => recordPark(tree, { summary: 'x', severity: 'S2', extra: 1 }), /unexpected extra key "extra"/);
  assert.throws(() => recordPark(tree, { summary: 'x', severity: 'S2', owner_mission: '' }), /"owner_mission"/);
  assert.throws(() => recordPark(tree, 'not an object'), /plain object/);
  assert.ok(!fs.existsSync(path.join(tree, 'holds.jsonl')), 'invalid parks must write nothing');
}

// --- treeRoot must exist -----------------------------------------------------
{
  const tree = makeTree();
  const missing = path.join(tree, 'nope');
  assert.throws(() => recordPark(missing, { summary: 'x', severity: 'S2' }), /scaffold it first/);
  assert.throws(() => openHolds(missing), /scaffold it first/);
}

// --- resolve lifecycle -------------------------------------------------------
{
  const tree = makeTree();
  const p0 = recordPark(tree, { summary: 'flaky CSS in dark mode', severity: 'S3' });
  const p1 = recordPark(tree, { summary: 'parser rejects BOM input', severity: 'S2', owner_mission: 'm1' });
  assert.strictEqual(p0.seq, 0);
  assert.strictEqual(p0.kind, 'park');
  assert.strictEqual(p0.correlation_id, null);
  assert.strictEqual(p1.seq, 1);
  assert.strictEqual(p1.owner_mission, 'm1');
  assert.strictEqual(p1.correlation_id, 'm1');

  let open = openHolds(tree);
  assert.deepStrictEqual(open.map((h) => h.seq), [0, 1], 'both parks open');

  // resolve seq 0
  const res = resolveHold(tree, 0, { answer: 'accept the dark-mode variance', routed_to: 'operator' });
  assert.strictEqual(res.kind, 'resolve');
  assert.strictEqual(res.park_seq, 0);
  assert.strictEqual(res.answer, 'accept the dark-mode variance');
  assert.strictEqual(res.routed_to, 'operator');
  assert.strictEqual(res.correlation_id, 'park-0');

  open = openHolds(tree);
  assert.deepStrictEqual(open.map((h) => h.seq), [1], 'only seq 1 remains open');

  // already resolved
  assert.throws(() => resolveHold(tree, 0, { answer: 'again' }), /already resolved/);
  // unknown seq
  assert.throws(() => resolveHold(tree, 99, { answer: 'x' }), /no park record with seq 99/);
  // a resolve record's own seq is not a park
  assert.throws(() => resolveHold(tree, res.seq, { answer: 'x' }), new RegExp(`no park record with seq ${res.seq}`));
  // resolution validation
  assert.throws(() => resolveHold(tree, 1, { answer: '' }), /"answer" must be a non-empty string/);
  assert.throws(() => resolveHold(tree, 1, { answer: 'x', extra: true }), /unexpected extra key "extra"/);
  assert.throws(() => resolveHold(tree, -1, { answer: 'x' }), /non-negative integer/);

  // refusals appended nothing
  const { records } = readRecords(path.join(tree, 'holds.jsonl'));
  assert.strictEqual(records.length, 3, 'two parks + one resolve on the stream');

  // resolve the second via the CLI
  const r = runCli(['resolve', tree, '1'], { answer: 'strip the BOM at intake' });
  assert.strictEqual(r.status, 0, `resolve CLI failed: ${r.stderr}`);
  assert.deepStrictEqual(openHolds(tree), [], 'no open holds left');

  // no leftover lock/txn files
  const leftovers = fs.readdirSync(tree).filter((n) => n.includes('.lock') || n.includes('.txn'));
  assert.deepStrictEqual(leftovers, [], `leftover lock artifacts: ${leftovers}`);
}

// --- CLI: park + list --------------------------------------------------------
{
  const tree = makeTree();
  let r = runCli(['park', tree], { summary: 'renderer polish deferred', severity: 'S3' });
  assert.strictEqual(r.status, 0, r.stderr);
  const parked = JSON.parse(r.stdout);
  assert.strictEqual(parked.kind, 'park');
  assert.strictEqual(parked.seq, 0);

  r = runCli(['list', tree]);
  assert.strictEqual(r.status, 0, r.stderr);
  const listed = JSON.parse(r.stdout);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].summary, 'renderer polish deferred');

  // list on a tree with no holds.jsonl is an empty array, not an error
  const bare = makeTree();
  r = runCli(['list', bare]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), []);
}

// --- CLI: fail-closed argv + stdin -------------------------------------------
{
  const tree = makeTree();
  assert.strictEqual(runCli(['park', tree, 'surplus'], { summary: 'x', severity: 'S2' }).status, 1, 'surplus arg refused');
  assert.strictEqual(runCli(['unknown', tree]).status, 1, 'unknown command refused');
  assert.strictEqual(runCli(['resolve', tree, 'zero'], { answer: 'x' }).status, 1, 'non-numeric seq refused');
  assert.strictEqual(runCli(['resolve', tree], { answer: 'x' }).status, 1, 'missing seq refused');
  const badJson = spawnSync(process.execPath, [SRC, 'park', tree], { input: '{not json', encoding: 'utf8' });
  assert.strictEqual(badJson.status, 1, 'malformed stdin JSON refused');
  assert.ok(badJson.stderr.includes('not valid JSON'), badJson.stderr);
  assert.strictEqual(runCli(['--help']).status, 0, '--help exits 0');
}

console.log('test-hold: ok');
