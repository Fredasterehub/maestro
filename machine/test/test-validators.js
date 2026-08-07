'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'validators.js');
const {
  validateEnvelope,
  validateBrief,
  validateDeviation,
  validateStop,
} = require(SRC);

function ok(result, label) {
  assert.strictEqual(result.ok, true, `${label}: expected ok, got errors ${JSON.stringify(result.errors)}`);
  assert.deepStrictEqual(result.errors, []);
}

function bad(result, pattern, label) {
  assert.strictEqual(result.ok, false, `${label}: expected rejection`);
  assert.ok(
    result.errors.some((e) => pattern.test(e)),
    `${label}: no error matching ${pattern} in ${JSON.stringify(result.errors)}`
  );
}

function envelope(overrides) {
  return {
    state: 'done',
    result: 'implemented the module',
    evidence: 'tests green',
    risks: 'none',
    artifact: 'missions/m1/artifacts/report.md',
    question: '',
    ...overrides,
  };
}

// --- envelope: happy paths ---------------------------------------------------
ok(validateEnvelope(envelope()), 'done envelope');
ok(validateEnvelope(envelope({ state: 'partial' })), 'partial envelope');
ok(validateEnvelope(envelope({ state: 'blocked', question: 'which schema wins?' })), 'blocked envelope');

// --- envelope: exact keys ----------------------------------------------------
bad(validateEnvelope({ ...envelope(), extra: 'x' }), /unexpected extra key "extra"/, 'envelope extra key');
{
  const missing = envelope();
  delete missing.artifact;
  bad(validateEnvelope(missing), /missing required key "artifact"/, 'envelope missing key');
}

// --- envelope: state + types -------------------------------------------------
bad(validateEnvelope(envelope({ state: 'finished' })), /must be one of done, partial, blocked/, 'bad state');
bad(validateEnvelope(envelope({ state: 42 })), /"state" must be a string/, 'non-string state');
bad(validateEnvelope(envelope({ risks: null })), /"risks" must be a string/, 'non-string field');

// --- envelope: question IFF blocked ------------------------------------------
bad(validateEnvelope(envelope({ state: 'blocked', question: '' })), /must be non-empty when state is "blocked"/, 'blocked without question');
bad(validateEnvelope(envelope({ state: 'blocked', question: '   ' })), /must be non-empty when state is "blocked"/, 'blocked with whitespace question');
bad(validateEnvelope(envelope({ state: 'done', question: 'why?' })), /must be empty when state is "done"/, 'done with question');
bad(validateEnvelope(envelope({ state: 'partial', question: 'why?' })), /must be empty when state is "partial"/, 'partial with question');

// --- envelope: 300-word ceiling ----------------------------------------------
{
  // 298 words in result + 1 each in evidence/risks (question '') = exactly 300.
  const at = envelope({ result: Array(298).fill('w').join(' '), evidence: 'one', risks: 'one' });
  ok(validateEnvelope(at), 'exactly 300 words');
  const over = envelope({ result: Array(299).fill('w').join(' '), evidence: 'one', risks: 'one' });
  bad(validateEnvelope(over), /is 301, exceeding the 300-word ceiling/, '301 words');
}

// --- envelope: 8192-byte ceiling ---------------------------------------------
{
  // artifact carries no word-count weight, so the byte ceiling trips alone.
  const fat = envelope({ artifact: 'x'.repeat(9000) });
  bad(validateEnvelope(fat), /exceeding the 8192-byte ceiling/, 'over byte ceiling');
  // Exact boundary: pad the artifact until serialized line + newline == 8192.
  const base = envelope({ artifact: '' });
  const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8') + 1;
  ok(validateEnvelope(envelope({ artifact: 'x'.repeat(8192 - overhead) })), 'exactly at byte ceiling');
  bad(
    validateEnvelope(envelope({ artifact: 'x'.repeat(8192 - overhead + 1) })),
    /exceeding the 8192-byte ceiling/,
    'one byte over the ceiling'
  );
}

// --- envelope: never throws on hostile input ---------------------------------
bad(validateEnvelope(null), /plain object/, 'null envelope');
bad(validateEnvelope([]), /plain object/, 'array envelope');
bad(validateEnvelope('str'), /plain object/, 'string envelope');
bad(validateEnvelope(envelope({ toJSON: () => ({}) })), /plain object/, 'toJSON envelope');
{
  class Fake {}
  const inst = Object.assign(new Fake(), envelope());
  bad(validateEnvelope(inst), /plain object/, 'custom-prototype envelope');
}
{
  const trap = new Proxy({}, { ownKeys() { throw new Error('trapped'); }, getPrototypeOf() { return Object.prototype; } });
  const result = validateEnvelope(trap);
  assert.strictEqual(result.ok, false, 'proxy trap never throws out of the validator');
}
{
  const throwing = {};
  Object.defineProperty(throwing, 'state', { get() { throw new Error('gotcha'); }, enumerable: true });
  assert.strictEqual(validateEnvelope(throwing).ok, false, 'throwing getter never escapes');
}

// --- brief -------------------------------------------------------------------
function brief(overrides) {
  return {
    outcome: 'jsonl module exists and passes tests',
    scope: 'machine/src/jsonl.js only',
    anchors: ['machine/src/jsonl.js', 'ARCHITECTURE.md'],
    acceptance: 'node test/test-jsonl.js exits 0',
    freshness: 'no external docs needed',
    tier: 'standard',
    return_format: 'six-field envelope',
    stop_condition: 'tests green or blocked',
    ...overrides,
  };
}

ok(validateBrief(brief()), 'valid brief');
bad(validateBrief({ ...brief(), bonus: 1 }), /unexpected extra key "bonus"/, 'brief extra key');
{
  const missing = brief();
  delete missing.tier;
  bad(validateBrief(missing), /missing required key "tier"/, 'brief missing key');
}
bad(validateBrief(brief({ scope: '' })), /"scope" must be a non-empty string/, 'brief empty string');
bad(validateBrief(brief({ scope: '   ' })), /"scope" must be a non-empty string/, 'brief whitespace string');
bad(validateBrief(brief({ outcome: 9 })), /"outcome" must be a non-empty string/, 'brief non-string');
bad(validateBrief(brief({ anchors: [] })), /non-empty array of non-empty strings/, 'empty anchors');
bad(validateBrief(brief({ anchors: 'src/a.js' })), /non-empty array of non-empty strings/, 'anchors not array');
bad(validateBrief(brief({ anchors: ['src/a.js', ''] })), /only non-empty strings/, 'empty anchor entry');
bad(validateBrief(brief({ anchors: ['src/a.js', 3] })), /only non-empty strings/, 'non-string anchor entry');
bad(validateBrief(null), /plain object/, 'null brief');
bad(validateBrief(brief({ toJSON: () => 1 })), /plain object/, 'toJSON brief');

// --- deviation ---------------------------------------------------------------
function deviation(overrides) {
  return {
    reported_by: 'executor-sol',
    expected: 'config.js exports loadConfig',
    actual: 'config.js does not exist',
    summary: 'brief anchors a file the tree does not carry',
    ...overrides,
  };
}

ok(validateDeviation(deviation()), 'valid deviation');
bad(validateDeviation(deviation({ reported_by: 'system' })), /never "system"/, 'system reporter');
bad(validateDeviation(deviation({ reported_by: 'unknown' })), /never "unknown"/, 'unknown reporter');
bad(validateDeviation(deviation({ severity: 'S2' })), /unexpected extra key "severity"/, 'deviation refuses severity');
{
  const missing = deviation();
  delete missing.actual;
  bad(validateDeviation(missing), /missing required key "actual"/, 'deviation missing key');
}
bad(validateDeviation(deviation({ summary: ' ' })), /"summary" must be a non-empty string/, 'deviation empty field');
bad(validateDeviation(deviation({ expected: 5 })), /"expected" must be a non-empty string/, 'deviation non-string');
bad(validateDeviation(null), /plain object/, 'null deviation');

// --- stop --------------------------------------------------------------------
ok(validateStop({ stop_state: 'DONE', reporter: 'handoff-recorder' }), 'DONE stop');
ok(validateStop({ stop_state: 'BUDGET-CEILING', reporter: 'handoff-recorder' }), 'BUDGET-CEILING stop');
ok(validateStop({ stop_state: 'EXHAUSTED', reporter: 'handoff-recorder' }), 'EXHAUSTED stop');
ok(
  validateStop({ stop_state: 'BLOCKED-OPERATOR', reporter: 'handoff-recorder', question: 'merge to main or hold?' }),
  'BLOCKED-OPERATOR stop'
);
ok(
  validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'handoff-recorder', earliest_resume: '2026-08-01T03:00:00Z' }),
  'QUOTA-WAIT stop'
);
ok(
  validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'r', earliest_resume: '2026-08-01T03:00:00.500Z' }),
  'QUOTA-WAIT fractional seconds'
);

bad(validateStop({ stop_state: 'PAUSED', reporter: 'r' }), /"stop_state" must be one of/, 'unknown stop_state');
bad(validateStop({ stop_state: 'DONE' }), /"reporter" must be a non-empty string/, 'missing reporter');
bad(validateStop({ stop_state: 'DONE', reporter: 'a\nb' }), /must not contain a newline/, 'multiline reporter');

// BLOCKED-OPERATOR: question required, single-line; earliest_resume forbidden.
bad(validateStop({ stop_state: 'BLOCKED-OPERATOR', reporter: 'r' }), /"question" must be a non-empty string when stop_state is "BLOCKED-OPERATOR"/, 'blocked without question');
bad(validateStop({ stop_state: 'BLOCKED-OPERATOR', reporter: 'r', question: 'a\nStop state: DONE' }), /"question" must not contain a newline/, 'multiline question');
bad(
  validateStop({ stop_state: 'BLOCKED-OPERATOR', reporter: 'r', question: 'q?', earliest_resume: '2026-08-01T00:00:00Z' }),
  /"earliest_resume" is not permitted when stop_state is "BLOCKED-OPERATOR"/,
  'blocked with earliest_resume'
);

// QUOTA-WAIT: earliest_resume required, UTC 'Z' only; question forbidden.
bad(validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'r' }), /"earliest_resume" must be an ISO-8601 UTC/, 'quota-wait without earliest_resume');
bad(
  validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'r', earliest_resume: '2026-08-01T03:00:00+02:00' }),
  /ISO-8601 UTC/,
  'numeric-offset timestamp refused'
);
bad(
  validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'r', earliest_resume: '2026-13-01T00:00:00Z' }),
  /ISO-8601 UTC/,
  'unparseable calendar date refused'
);
bad(
  validateStop({ stop_state: 'QUOTA-WAIT', reporter: 'r', earliest_resume: '2026-08-01T03:00:00Z', question: 'q?' }),
  /"question" is not permitted when stop_state is "QUOTA-WAIT"/,
  'quota-wait with question'
);

// The bare three permit neither conditional field.
for (const state of ['DONE', 'BUDGET-CEILING', 'EXHAUSTED']) {
  bad(
    validateStop({ stop_state: state, reporter: 'r', question: 'q?' }),
    /"question" is not permitted/,
    `${state} with question`
  );
  bad(
    validateStop({ stop_state: state, reporter: 'r', earliest_resume: '2026-08-01T00:00:00Z' }),
    /"earliest_resume" is not permitted/,
    `${state} with earliest_resume`
  );
}

bad(validateStop({ stop_state: 'DONE', reporter: 'r', note: 'hi' }), /unexpected extra key "note"/, 'stop extra key');
bad(validateStop(null), /plain object/, 'null stop');
bad(validateStop([]), /plain object/, 'array stop');

// --- CLI ---------------------------------------------------------------------
function cli(args, input) {
  return spawnSync(process.execPath, [SRC, ...args], { input, encoding: 'utf8' });
}

{
  const r = cli(['validate-envelope'], JSON.stringify(envelope()));
  assert.strictEqual(r.status, 0, `valid envelope exits 0: ${r.stdout} ${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, errors: [] });
}
{
  const r = cli(['validate-envelope'], JSON.stringify(envelope({ state: 'blocked', question: '' })));
  assert.strictEqual(r.status, 1, 'invalid envelope exits 1');
  assert.strictEqual(JSON.parse(r.stdout).ok, false);
}
{
  const r = cli(['validate-brief'], JSON.stringify(brief()));
  assert.strictEqual(r.status, 0, 'valid brief exits 0');
}
{
  const r = cli(['validate-deviation'], JSON.stringify(deviation()));
  assert.strictEqual(r.status, 0, 'valid deviation exits 0');
}
{
  const r = cli(['validate-stop'], JSON.stringify({ stop_state: 'DONE', reporter: 'handoff-recorder' }));
  assert.strictEqual(r.status, 0, 'valid stop exits 0');
}
{
  // Malformed stdin never throws: reported as { ok: false } on stdout, exit 1.
  const r = cli(['validate-envelope'], 'this is not json');
  assert.strictEqual(r.status, 1, 'malformed stdin exits 1');
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.ok, false);
  assert.ok(parsed.errors[0].includes('stdin did not carry valid JSON'));
  assert.ok(!r.stderr.includes('Error:'), 'no thrown stack trace');
}
{
  const r = cli(['validate-envelope'], 'null');
  assert.strictEqual(r.status, 1, 'JSON null exits 1');
  assert.strictEqual(JSON.parse(r.stdout).ok, false);
}
{
  const r = cli(['validate-everything'], '{}');
  assert.strictEqual(r.status, 1, 'unknown command exits 1');
  assert.ok(r.stderr.includes('unknown command'));
}
{
  const r = cli([], '{}');
  assert.strictEqual(r.status, 1, 'missing command exits 1');
}
{
  const r = cli(['validate-brief', 'surplus'], '{}');
  assert.strictEqual(r.status, 1, 'surplus argument fails closed');
  assert.ok(r.stderr.includes('unexpected extra argument'));
}
{
  const r = cli(['--help'], '');
  assert.strictEqual(r.status, 0, '--help exits 0');
  assert.ok(r.stdout.includes('validate-envelope'));
  assert.ok(r.stdout.includes('validate-stop'));
}

console.log('test-validators: OK');
