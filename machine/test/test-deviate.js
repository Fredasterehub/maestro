'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'deviate.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { recordDeviation } = require(SRC);

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-deviate-'));
}

function runCli(args, input) {
  return spawnSync(process.execPath, [SRC, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function deviation(overrides) {
  return {
    reported_by: 'executor-sol',
    expected: 'config.yaml declares a "port" key per the brief',
    actual: 'config.yaml has no "port" key at all',
    summary: 'brief premise about config.yaml is false; step refused',
    ...overrides,
  };
}

// --- happy path --------------------------------------------------------------
{
  const tree = makeTree();
  const rec = recordDeviation(tree, deviation());
  assert.strictEqual(rec.kind, 'deviation');
  assert.strictEqual(rec.seq, 0);
  assert.strictEqual(rec.reported_by, 'executor-sol');
  assert.strictEqual(rec.correlation_id, null);

  const { records } = readRecords(path.join(tree, 'ledger.jsonl'));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].kind, 'deviation');
  assert.strictEqual(records[0].summary, rec.summary);
  assert.strictEqual(records[0].schema_version, 1);
  assert.ok(typeof records[0].ts === 'string');
}

// --- reporter-identity floor -------------------------------------------------
{
  const tree = makeTree();
  assert.throws(
    () => recordDeviation(tree, deviation({ reported_by: 'system' })),
    /never "system"/,
    'reported_by "system" refused'
  );
  assert.throws(
    () => recordDeviation(tree, deviation({ reported_by: 'unknown' })),
    /never "unknown"/,
    'reported_by "unknown" refused'
  );
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')), 'refusals must write nothing');

  const r = runCli(['record-deviation', tree], deviation({ reported_by: 'system' }));
  assert.strictEqual(r.status, 1, 'CLI must exit 1');
  assert.ok(r.stderr.includes('never "system"'), r.stderr);
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')), 'CLI refusal must write nothing');
}

// --- four-field shape enforced -----------------------------------------------
{
  const tree = makeTree();
  const missing = deviation();
  delete missing.actual;
  assert.throws(() => recordDeviation(tree, missing), /missing required key "actual"/);
  assert.throws(() => recordDeviation(tree, deviation({ severity: 'S2' })), /unexpected extra key "severity"/);
  assert.throws(() => recordDeviation(tree, deviation({ expected: '  ' })), /"expected" must be a non-empty string/);
  assert.throws(() => recordDeviation(tree, ['not', 'an', 'object']), /plain object/);
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')));
}

// --- treeRoot must exist -----------------------------------------------------
{
  const tree = makeTree();
  assert.throws(() => recordDeviation(path.join(tree, 'nope'), deviation()), /scaffold it first/);
}

// --- CLI: happy path, argv fail-closed, stdin fail-closed --------------------
{
  const tree = makeTree();
  let r = runCli(['record-deviation', tree], deviation());
  assert.strictEqual(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.strictEqual(rec.kind, 'deviation');

  assert.strictEqual(runCli(['record-deviation', tree, 'surplus'], deviation()).status, 1, 'surplus arg refused');
  assert.strictEqual(runCli(['record'], deviation()).status, 1, 'unknown command refused');
  assert.strictEqual(runCli([]).status, 1, 'missing command refused');
  const badJson = spawnSync(process.execPath, [SRC, 'record-deviation', tree], { input: 'nope', encoding: 'utf8' });
  assert.strictEqual(badJson.status, 1, 'malformed stdin JSON refused');
  assert.strictEqual(runCli(['--help']).status, 0, '--help exits 0');

  const { records } = readRecords(path.join(tree, 'ledger.jsonl'));
  assert.strictEqual(records.length, 1, 'only the one valid CLI deviation landed');
}

console.log('test-deviate: ok');
