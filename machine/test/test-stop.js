'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'stop.js');
const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { readJson, writeJson } = require(path.join(__dirname, '..', 'src', 'atomic-json.js'));
const { recordPark, resolveHold } = require(path.join(__dirname, '..', 'src', 'hold.js'));
const { writeStop, RESUME_LINE } = require(SRC);

function makeTree(state) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-stop-'));
  if (state !== undefined) {
    writeJson(path.join(tree, 'state.json'), state);
  }
  return tree;
}

function baseState() {
  return {
    schema_version: 1,
    created_ts: '2026-07-30T00:00:00.000Z',
    missions: {
      m1: { status: 'open', next_action: 'wire the config parser to the loader' },
      m2: { status: 'blocked', next_action: 'await schema decision from operator' },
      m3: { status: 'done', next_action: 'nothing — closed' },
    },
    active_mission: 'm1',
    preflight: null,
    gates: [],
    last_stop: null,
    updated_utc: '2026-07-30T00:00:00.000Z',
  };
}

function runCli(args, input) {
  return spawnSync(process.execPath, [SRC, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8',
  });
}

function stopRecords(tree) {
  return readRecords(path.join(tree, 'ledger.jsonl')).records.filter((r) => r.kind === 'stop');
}

// --- vocabulary fail-closed --------------------------------------------------
{
  const tree = makeTree(baseState());
  for (const bad of [
    { stop_state: 'FINISHED', reporter: 'handoff-recorder' },
    { stop_state: 'done', reporter: 'handoff-recorder' }, // case matters: closed vocabulary
    { stop_state: '', reporter: 'handoff-recorder' },
    { reporter: 'handoff-recorder' },
  ]) {
    assert.throws(() => writeStop(tree, bad), /"stop_state" must be one of/, JSON.stringify(bad));
  }
  // conditional-field discipline
  assert.throws(
    () => writeStop(tree, { stop_state: 'BLOCKED-OPERATOR', reporter: 'handoff-recorder' }),
    /"question" must be a non-empty string when stop_state is "BLOCKED-OPERATOR"/,
    'BLOCKED-OPERATOR without question refused'
  );
  assert.throws(
    () => writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder', question: 'why?' }),
    /"question" is not permitted when stop_state is "DONE"/
  );
  assert.throws(
    () => writeStop(tree, { stop_state: 'QUOTA-WAIT', reporter: 'handoff-recorder' }),
    /"earliest_resume" must be an ISO-8601 UTC/
  );
  assert.throws(
    () =>
      writeStop(tree, { stop_state: 'QUOTA-WAIT', reporter: 'handoff-recorder', earliest_resume: '2026-07-30T10:00:00+02:00' }),
    /"earliest_resume" must be an ISO-8601 UTC/,
    'offset timestamps refused — Z only'
  );
  assert.throws(
    () => writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder', extra: 1 }),
    /unexpected extra key "extra"/
  );

  // nothing reached disk on any refusal
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')), 'no ledger on refusal');
  assert.ok(!fs.existsSync(path.join(tree, 'handoff.md')), 'no handoff on refusal');
  assert.strictEqual(readJson(path.join(tree, 'state.json')).last_stop, null, 'state untouched on refusal');

  // same fail-closed surface through the CLI
  const r = runCli(['write-stop', tree], { stop_state: 'PAUSED', reporter: 'handoff-recorder' });
  assert.strictEqual(r.status, 1, 'CLI must exit 1 on a bad vocabulary word');
  assert.ok(r.stderr.includes('must be one of'), r.stderr);
}

// --- missing state.json: scaffold-first precondition -------------------------
{
  const tree = makeTree(); // no state.json
  assert.throws(() => writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder' }), /scaffold the tree first/);
  assert.ok(!fs.existsSync(path.join(tree, 'ledger.jsonl')), 'precondition failure appends nothing');
}

// --- full DONE stop after two open missions + one open hold ------------------
{
  const tree = makeTree(baseState());
  recordPark(tree, { summary: 'BOM handling deferred', severity: 'S2', owner_mission: 'm1' }); // seq 0, stays open
  recordPark(tree, { summary: 'polish pass deferred', severity: 'S3' }); // seq 1, resolved below
  resolveHold(tree, 1, { answer: 'accepted as-is' });

  const result = writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder' });

  // ledger-first: the stop record exists and state cites its exact seq/ts
  const stops = stopRecords(tree);
  assert.strictEqual(stops.length, 1);
  assert.strictEqual(stops[0].stop_state, 'DONE');
  assert.strictEqual(stops[0].reporter, 'handoff-recorder');
  assert.strictEqual(stops[0].correlation_id, 'DONE');

  const state = readJson(path.join(tree, 'state.json'));
  assert.deepStrictEqual(state.last_stop, { stop_state: 'DONE', ts: stops[0].ts, seq: stops[0].seq });
  assert.strictEqual(result.seq, stops[0].seq);
  assert.strictEqual(state.missions.m1.status, 'open', 'missions untouched');

  // handoff.md is a mechanical projection of exactly this state
  const handoff = fs.readFileSync(path.join(tree, 'handoff.md'), 'utf8');
  assert.ok(handoff.startsWith('# Handoff\n'), 'header');
  assert.ok(handoff.includes('## Last stop'), 'last-stop section');
  assert.ok(handoff.includes('- Stop state: DONE'), 'stop state line');
  assert.ok(handoff.includes('- Reporter: handoff-recorder'), 'reporter line');
  assert.ok(handoff.includes(`- Recorded: ${stops[0].ts} (ledger.jsonl seq ${stops[0].seq})`), 'recorded line cites the event');
  assert.ok(handoff.includes('## Open missions'), 'missions section');
  assert.ok(handoff.includes('- m1 (open): wire the config parser to the loader'), 'm1 line');
  assert.ok(handoff.includes('- m2 (blocked): await schema decision from operator'), 'm2 line');
  assert.ok(!handoff.includes('m3'), 'done mission renders no line');
  assert.ok(handoff.includes('- Open holds: 1'), 'one hold open (the S2), the resolved S3 not counted');
  assert.ok(handoff.includes(RESUME_LINE), 'resume line');
  assert.ok(!handoff.includes('Operator question'), 'DONE carries no question line — no event, no line');
  assert.ok(!handoff.includes('Earliest resume'), 'DONE carries no earliest_resume line');
}

// --- BLOCKED-OPERATOR carries its question into the handoff ------------------
{
  const tree = makeTree(baseState());
  const question = 'Should mission m2 adopt schema v2 or stay on v1?';
  const r = runCli(['write-stop', tree], { stop_state: 'BLOCKED-OPERATOR', reporter: 'handoff-recorder', question });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.state.last_stop.stop_state, 'BLOCKED-OPERATOR');
  const handoff = fs.readFileSync(path.join(tree, 'handoff.md'), 'utf8');
  assert.ok(handoff.includes(`- Operator question: ${question}`), 'verbatim question line');
  assert.ok(handoff.includes('- Open holds: 0'), 'zero holds recorded honestly');
}

// --- QUOTA-WAIT carries earliest_resume --------------------------------------
{
  const tree = makeTree(baseState());
  writeStop(tree, { stop_state: 'QUOTA-WAIT', reporter: 'handoff-recorder', earliest_resume: '2026-07-31T05:00:00Z' });
  const handoff = fs.readFileSync(path.join(tree, 'handoff.md'), 'utf8');
  assert.ok(handoff.includes('- Earliest resume: 2026-07-31T05:00:00Z'));
}

// --- a second stop supersedes the first --------------------------------------
{
  const tree = makeTree(baseState());
  writeStop(tree, { stop_state: 'EXHAUSTED', reporter: 'handoff-recorder' });
  writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder' });
  const stops = stopRecords(tree);
  assert.strictEqual(stops.length, 2, 'both stops on the ledger');
  const state = readJson(path.join(tree, 'state.json'));
  assert.strictEqual(state.last_stop.stop_state, 'DONE');
  assert.strictEqual(state.last_stop.seq, stops[1].seq);
  const handoff = fs.readFileSync(path.join(tree, 'handoff.md'), 'utf8');
  assert.ok(handoff.includes('- Stop state: DONE'), 'handoff shows the latest stop');
  assert.ok(!handoff.includes('EXHAUSTED'), 'superseded stop not rendered');
}

// --- symlinked handoff.md refuses with nothing mutated -----------------------
{
  const tree = makeTree(baseState());
  writeStop(tree, { stop_state: 'EXHAUSTED', reporter: 'handoff-recorder' });
  const before = {
    stops: stopRecords(tree).length,
    lastStop: readJson(path.join(tree, 'state.json')).last_stop,
  };

  const decoy = path.join(tree, 'decoy.md');
  fs.writeFileSync(decoy, 'decoy\n');
  fs.rmSync(path.join(tree, 'handoff.md'));
  fs.symlinkSync(decoy, path.join(tree, 'handoff.md'));

  assert.throws(
    () => writeStop(tree, { stop_state: 'DONE', reporter: 'handoff-recorder' }),
    /refusing to write through a symlinked target/
  );
  assert.strictEqual(stopRecords(tree).length, before.stops, 'containment refusal precedes the ledger append');
  assert.deepStrictEqual(readJson(path.join(tree, 'state.json')).last_stop, before.lastStop, 'state untouched');
  assert.strictEqual(fs.readFileSync(decoy, 'utf8'), 'decoy\n', 'symlink target untouched');
}

// --- CLI: argv + stdin fail-closed -------------------------------------------
{
  const tree = makeTree(baseState());
  assert.strictEqual(runCli(['write-stop', tree, 'surplus'], { stop_state: 'DONE', reporter: 'x' }).status, 1);
  assert.strictEqual(runCli(['stop', tree], { stop_state: 'DONE', reporter: 'x' }).status, 1, 'unknown command refused');
  const badJson = spawnSync(process.execPath, [SRC, 'write-stop', tree], { input: '{', encoding: 'utf8' });
  assert.strictEqual(badJson.status, 1, 'malformed stdin JSON refused');
  assert.strictEqual(runCli(['--help']).status, 0, '--help exits 0');
  assert.ok(!fs.existsSync(path.join(tree, 'handoff.md')), 'no refusal rendered a handoff');
}

console.log('test-stop: ok');
