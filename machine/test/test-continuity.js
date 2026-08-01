'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const SRC = path.join(SRC_DIR, 'continuity.js');
const SESSION_A = 'codex-session-a';
const SESSION_B = 'codex-session-b';
const { scaffoldTree } = require(path.join(SRC_DIR, 'scaffold.js'));
const { readJson } = require(path.join(SRC_DIR, 'atomic-json.js'));
const { readRecords } = require(path.join(SRC_DIR, 'jsonl.js'));
const {
  COMPACT_CAPSULE_BYTE_CEILING,
  RESUME_BYTE_CEILING,
  armContinuity,
  consumeContinuity,
  continuityConsumptionStatus,
  readContinuity,
  validateArmMarker,
  validateConsumptionMarker,
  validateContinuityInput,
  validateStoredState,
  writeContinuity,
} = require(SRC);

function makeTree(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `maestro-continuity-${label}-`));
  const tree = path.join(project, '.maestro');
  scaffoldTree(tree);
  return tree;
}

function input(overrides = {}) {
  return {
    mode: 'auto',
    mission: { id: 'mission-17', objective: 'Port rollover continuity to Codex without operator intervention.' },
    operator_intent: 'Keep the autonomous workflow running across context boundaries and preserve verified state.',
    verified_evidence: [
      { fact: 'All existing machine tests passed before this handoff.', source: 'machine/test/run-all.js output' },
    ],
    in_progress: [
      {
        item: 'Continuity writer implementation',
        exact_stop: 'Writer and schema are implemented; focused tests are running.',
        exact_next: 'Inspect the focused test result, then wire the hook and skill.',
      },
    ],
    blockers: [],
    next_actions: ['Run the focused continuity test.', 'Wire compact hooks only after the machine contract is green.'],
    decisions: [
      { decision: 'Use disk state as authoritative continuity.', reason: 'A compacted model context is not durable storage.' },
    ],
    hypotheses: [
      {
        hypothesis: 'A bounded SessionStart injection is enough to resume.',
        basis: 'The handoff names the exact stop, next action, evidence, and paths.',
        next_check: 'Exercise an actual compact rollover canary.',
      },
    ],
    open_threads: [{ thread: 'Hook integration', why: 'The machine contract must land first.' }],
    traps: ['Do not treat unverified command output as current after rollover.'],
    key_paths: ['machine/src/continuity.js', 'machine/test/test-continuity.js'],
    commands: [{ command: 'node machine/test/test-continuity.js', last_result: 'not run yet' }],
    origin: { session: 'session-a', window: 'window-1' },
    ...overrides,
  };
}

function runCli(args, stdin) {
  return spawnSync(process.execPath, [SRC, ...args], {
    input: stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

function handoffRecords(tree) {
  return readRecords(path.join(tree, 'ledger.jsonl')).records.filter((record) => record.kind === 'context-handoff');
}

function padded(prefix, length, character) {
  return prefix + character.repeat(length - prefix.length);
}

// --- valid CLI write/read round-trip -----------------------------------------
{
  const tree = makeTree('roundtrip');
  const original = input();
  const write = runCli(['write', tree], original);
  assert.strictEqual(write.status, 0, write.stderr);
  const summary = JSON.parse(write.stdout);
  assert.strictEqual(summary.generation, 1);
  assert.strictEqual(summary.mode, 'auto');
  assert.match(summary.digest, /^sha256:[a-f0-9]{64}$/);

  const statePath = path.join(tree, 'continuity', 'handoff-state.json');
  const state = readJson(statePath);
  assert.strictEqual(state.generation, 1);
  assert.deepStrictEqual(
    Object.fromEntries(Object.keys(original).map((key) => [key, state[key]])),
    original,
    'canonical state preserves every contracted input field'
  );
  assert.deepStrictEqual(validateStoredState(state), { ok: true, errors: [] });

  const read = runCli(['read', tree]);
  assert.strictEqual(read.status, 0, read.stderr);
  assert.strictEqual(read.stdout, fs.readFileSync(path.join(tree, 'continuity', 'HANDOFF.md'), 'utf8'));
  assert.ok(read.stdout.includes('Continue the same logical operator workflow'));
  assert.ok(read.stdout.includes('Exact stop: Writer and schema are implemented'));
  assert.ok(read.stdout.includes('1. Run the focused continuity test.'));
  assert.ok(read.stdout.includes(summary.digest), 'readback carries the integrity digest');

  const records = handoffRecords(tree);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].generation, 1);
  assert.strictEqual(records[0].digest, summary.digest);
  assert.strictEqual(records[0].mission_id, original.mission.id);
}

// --- invalid input refuses before any continuity or ledger mutation ---------
{
  const tree = makeTree('invalid');
  const beforeLedger = fs.readFileSync(path.join(tree, 'ledger.jsonl'), 'utf8');
  const bad = input({ chain_of_thought: 'private transcript-like reasoning must never cross the boundary' });
  const result = runCli(['write', tree], bad);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /unexpected extra key "chain_of_thought"/);
  assert.ok(!fs.existsSync(path.join(tree, 'continuity')), 'invalid input creates no output directory');
  assert.strictEqual(fs.readFileSync(path.join(tree, 'ledger.jsonl'), 'utf8'), beforeLedger, 'ledger stays byte-identical');

  const malformed = runCli(['write', tree], '{');
  assert.strictEqual(malformed.status, 1);
  assert.ok(!fs.existsSync(path.join(tree, 'continuity')), 'malformed JSON also writes nothing');

  const noNextAction = runCli(['write', tree], input({ next_actions: [] }));
  assert.strictEqual(noNextAction.status, 1);
  assert.match(noNextAction.stderr, /at least one action in auto mode/);
  assert.ok(!fs.existsSync(path.join(tree, 'continuity')), 'automatic rollover without a next action writes nothing');
}

// --- aggregate state ceiling is enforced beyond the per-field ceilings -----
{
  const tree = makeTree('oversize');
  const oversized = input({
    verified_evidence: Array.from({ length: 16 }, (_, i) => ({
      fact: `fact-${i} ${'f'.repeat(1180)}`,
      source: `source-${i} ${'s'.repeat(990)}`,
    })),
  });
  const validation = validateContinuityInput(oversized);
  assert.strictEqual(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('32768-byte state ceiling')), validation.errors.join('; '));
  assert.throws(() => writeContinuity(tree, oversized), /32768-byte state ceiling/);
  assert.ok(!fs.existsSync(path.join(tree, 'continuity')), 'over-ceiling state writes nothing');
  assert.strictEqual(handoffRecords(tree).length, 0, 'over-ceiling state appends no event');
}

// --- read output is hard-bounded even when valid state is near its ceiling ---
{
  const tree = makeTree('bounded');
  const wide = input({
    verified_evidence: Array.from({ length: 16 }, (_, i) => ({
      fact: `fact-${i} ${'e'.repeat(590)}`,
      source: `source-${i} ${'s'.repeat(240)}`,
    })),
    in_progress: Array.from({ length: 2 }, (_, i) => ({
      item: `item-${i} ${'i'.repeat(390)}`,
      exact_stop: `stop-${i} ${'x'.repeat(590)}`,
      exact_next: `next-${i} ${'n'.repeat(590)}`,
    })),
    next_actions: Array.from({ length: 8 }, (_, i) => `action-${i} ${'a'.repeat(440)}`),
    commands: Array.from({ length: 6 }, (_, i) => ({
      command: `command-${i} ${'c'.repeat(390)}`,
      last_result: `result-${i} ${'r'.repeat(290)}`,
    })),
  });
  assert.deepStrictEqual(validateContinuityInput(wide), { ok: true, errors: [] }, 'near-ceiling fixture is valid');
  writeContinuity(tree, wide);
  const prompt = readContinuity(tree);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= RESUME_BYTE_CEILING, 'read prompt obeys the byte ceiling');
  assert.ok(prompt.includes('projection truncated'), 'bounded projection reports omitted tail instead of hiding it');
}

// --- each successful replacement increments generation exactly once ---------
{
  const tree = makeTree('generation');
  const first = writeContinuity(tree, input());
  const secondInput = input({
    origin: { session: 'session-a', window: 'window-2' },
    next_actions: ['Continue from generation two.'],
  });
  const second = writeContinuity(tree, secondInput);
  assert.strictEqual(first.generation, 1);
  assert.strictEqual(second.generation, 2);
  assert.notStrictEqual(second.digest, first.digest);
  const state = readJson(path.join(tree, 'continuity', 'handoff-state.json'));
  assert.strictEqual(state.generation, 2);
  assert.deepStrictEqual(state.next_actions, secondInput.next_actions);
  assert.strictEqual(handoffRecords(tree).length, 2, 'one small ledger event per completed replacement');
}

// --- automatic handoff generations are consumed exactly once ----------------
{
  const tree = makeTree('consume');
  const first = writeContinuity(tree, input());
  assert.deepStrictEqual(continuityConsumptionStatus(tree), {
    consumable: true,
    reason: 'ready',
    generation: 1,
    digest: first.digest,
    consumed_generation: null,
  });

  const markerPath = path.join(tree, 'continuity', 'consumed.json');
  const armPath = path.join(tree, 'continuity', 'armed.json');
  const unarmed = runCli(['consume', tree, SESSION_A]);
  assert.strictEqual(unarmed.status, 1);
  assert.match(unarmed.stderr, /is not armed by PreToolUse\(new_context\)/);
  assert.ok(!fs.existsSync(markerPath), 'unarmed compact must leave the handoff unconsumed');

  const armed = armContinuity(tree, SESSION_A);
  assert.deepStrictEqual(Object.keys(armed), ['schema_version', 'generation', 'digest', 'session_id', 'armed_at', 'expires_at']);
  assert.deepStrictEqual(validateArmMarker(armed), { ok: true, errors: [] });
  assert.strictEqual(armed.generation, first.generation);
  assert.strictEqual(armed.digest, first.digest);
  assert.strictEqual(armed.session_id, SESSION_A);

  const claim = runCli(['consume', tree, SESSION_A]);
  assert.strictEqual(claim.status, 0, claim.stderr);
  assert.match(claim.stdout, /Maestro same-thread rollover capsule/);
  assert.match(claim.stdout, /First next action: Run the focused continuity test\./);
  assert.ok(Buffer.byteLength(claim.stdout, 'utf8') <= COMPACT_CAPSULE_BYTE_CEILING);

  const marker = readJson(markerPath);
  assert.deepStrictEqual(Object.keys(marker), ['schema_version', 'generation', 'digest', 'consumed_at']);
  assert.deepStrictEqual(validateConsumptionMarker(marker), { ok: true, errors: [] });
  assert.strictEqual(marker.generation, first.generation);
  assert.strictEqual(marker.digest, first.digest);
  assert.ok(!fs.existsSync(armPath), 'successful consume retires its one-time arm');
  assert.deepStrictEqual(continuityConsumptionStatus(tree), {
    consumable: false,
    reason: 'already-consumed',
    generation: 1,
    digest: first.digest,
    consumed_generation: 1,
  });

  const beforeReplay = fs.readFileSync(markerPath, 'utf8');
  const replay = runCli(['consume', tree, SESSION_A]);
  assert.strictEqual(replay.status, 1);
  assert.match(replay.stderr, /generation 1 has already been consumed/);
  assert.strictEqual(replay.stdout, '');
  assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), beforeReplay, 'replay refusal leaves marker unchanged');

  const second = writeContinuity(tree, input({
    origin: { session: 'session-a', window: 'window-2' },
    next_actions: ['Consume the second generation exactly once.'],
  }));
  assert.strictEqual(second.generation, 2);
  assert.deepStrictEqual(continuityConsumptionStatus(tree), {
    consumable: true,
    reason: 'ready',
    generation: 2,
    digest: second.digest,
    consumed_generation: 1,
  });
  armContinuity(tree, SESSION_A);
  const secondClaim = consumeContinuity(tree, SESSION_A);
  assert.strictEqual(secondClaim.marker.generation, 2);
  assert.strictEqual(secondClaim.marker.digest, second.digest);
  assert.match(secondClaim.capsule, /Consume the second generation exactly once\./);

  fs.writeFileSync(markerPath, '{broken marker');
  assert.throws(() => continuityConsumptionStatus(tree), /consumption marker is unreadable/);
  const corrupt = runCli(['consume', tree, SESSION_A]);
  assert.strictEqual(corrupt.status, 1);
  assert.match(corrupt.stderr, /consumption marker is unreadable/);
}

// --- an arm is owned by one Codex session even in the same project cwd -------
{
  const tree = makeTree('session-bound-arm');
  const state = writeContinuity(tree, input());
  const arm = armContinuity(tree, SESSION_A);
  assert.strictEqual(arm.session_id, SESSION_A);
  assert.throws(
    () => armContinuity(tree, SESSION_B),
    /already armed for a different Codex session_id/,
    'another live session cannot steal a fresh arm'
  );
  assert.throws(
    () => consumeContinuity(tree, SESSION_B),
    /different Codex session_id/,
    'session B cannot consume session A arm in the same cwd'
  );
  assert.ok(!fs.existsSync(path.join(tree, 'continuity', 'consumed.json')));
  assert.strictEqual(readJson(path.join(tree, 'continuity', 'armed.json')).session_id, SESSION_A);
  const claimed = consumeContinuity(tree, SESSION_A);
  assert.strictEqual(claimed.marker.generation, state.generation);
  assert.ok(!fs.existsSync(path.join(tree, 'continuity', 'armed.json')));
  assert.throws(() => armContinuity(tree, ''), /invalid session_id/);
  const missingArg = runCli(['consume', tree]);
  assert.strictEqual(missingArg.status, 1);
  assert.match(missingArg.stderr, /requires exactly one <session_id>/);
}

// --- stale, mismatched, corrupt, and symlink arms never authorize consume ----
{
  const tree = makeTree('arm-refusals');
  const first = writeContinuity(tree, input());
  const armPath = path.join(tree, 'continuity', 'armed.json');
  const consumedPath = path.join(tree, 'continuity', 'consumed.json');

  const stale = armContinuity(tree, SESSION_A);
  const staleNow = Date.now();
  stale.armed_at = new Date(staleNow - 3 * 60 * 1000).toISOString();
  stale.expires_at = new Date(staleNow - 60 * 1000).toISOString();
  assert.deepStrictEqual(validateArmMarker(stale), { ok: true, errors: [] });
  fs.writeFileSync(armPath, `${JSON.stringify(stale, null, 2)}\n`);
  assert.throws(() => consumeContinuity(tree, SESSION_A), /expired arm marker/);
  assert.ok(!fs.existsSync(consumedPath));

  const refreshed = armContinuity(tree, SESSION_A);
  assert.strictEqual(refreshed.generation, first.generation);
  const second = writeContinuity(tree, input({ next_actions: ['Arm generation two.'] }));
  assert.throws(() => consumeContinuity(tree, SESSION_A), /different generation or digest/);
  assert.ok(!fs.existsSync(consumedPath));

  const secondArm = armContinuity(tree, SESSION_A);
  assert.strictEqual(secondArm.generation, second.generation);
  fs.writeFileSync(armPath, '{broken arm');
  assert.throws(() => consumeContinuity(tree, SESSION_A), /arm marker is unreadable/);
  assert.throws(() => armContinuity(tree, SESSION_A), /arm marker is unreadable/);
  assert.ok(!fs.existsSync(consumedPath));

  fs.rmSync(armPath);
  fs.symlinkSync(path.join(tree, 'state.json'), armPath);
  assert.throws(() => consumeContinuity(tree, SESSION_A), /symlink/);
  assert.throws(() => armContinuity(tree, SESSION_A), /symlink/);
  assert.ok(!fs.existsSync(consumedPath));
}

// --- compact capsule always retains the continuation fields -----------------
{
  const tree = makeTree('compact-capsule');
  const maximal = input({
    mission: {
      id: 'mission-max',
      objective: padded('OBJECTIVE_SENTINEL ', 2000, 'o'),
    },
    operator_intent: padded('OPERATOR_INTENT_SENTINEL ', 2400, 'i'),
    in_progress: [{
      item: padded('IN_PROGRESS_SENTINEL ', 800, 'p'),
      exact_stop: padded('EXACT_STOP_SENTINEL ', 1600, 's'),
      exact_next: padded('EXACT_NEXT_SENTINEL ', 1600, 'n'),
    }],
    next_actions: [padded('FIRST_ACTION_SENTINEL ', 1200, 'a')],
  });
  const written = writeContinuity(tree, maximal);
  armContinuity(tree, SESSION_A);
  const { capsule } = consumeContinuity(tree, SESSION_A);
  assert.ok(Buffer.byteLength(capsule, 'utf8') <= COMPACT_CAPSULE_BYTE_CEILING);
  for (const sentinel of [
    'OBJECTIVE_SENTINEL',
    'OPERATOR_INTENT_SENTINEL',
    'FIRST_ACTION_SENTINEL',
    'IN_PROGRESS_SENTINEL',
    'EXACT_STOP_SENTINEL',
    'EXACT_NEXT_SENTINEL',
  ]) {
    assert.ok(capsule.includes(sentinel), `compact capsule must retain ${sentinel}`);
  }
  assert.ok(capsule.includes(`Generation: ${written.generation}`));
  assert.ok(capsule.includes(`Integrity: ${written.digest}`));
  assert.match(capsule, /Authoritative state: continuity\/handoff-state\.json/);
}

// --- a marker ahead of rolled-back state is corruption, never authorization --
{
  const tree = makeTree('higher-consumed');
  const first = writeContinuity(tree, input());
  writeContinuity(tree, input({ next_actions: ['Second generation.'] }));
  armContinuity(tree, SESSION_A);
  consumeContinuity(tree, SESSION_A);
  fs.writeFileSync(
    path.join(tree, 'continuity', 'handoff-state.json'),
    `${JSON.stringify(first.state, null, 2)}\n`
  );
  assert.throws(() => continuityConsumptionStatus(tree), /marker generation is ahead/);
  const claim = runCli(['consume', tree, SESSION_A]);
  assert.strictEqual(claim.status, 1);
  assert.match(claim.stderr, /marker generation is ahead/);
}

// --- concurrent claims serialize: exactly one process receives the capsule --
{
  const tree = makeTree('concurrent-consume');
  writeContinuity(tree, input());
  armContinuity(tree, SESSION_A);
  const raceProgram = String.raw`
    const { spawn } = require('node:child_process');
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1], 'consume', process.argv[2], process.argv[3]]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    Promise.all([run(), run()]).then((results) => process.stdout.write(JSON.stringify(results)));
  `;
  const race = spawnSync(process.execPath, ['-e', raceProgram, SRC, tree, SESSION_A], { encoding: 'utf8' });
  assert.strictEqual(race.status, 0, race.stderr);
  const results = JSON.parse(race.stdout);
  assert.deepStrictEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.strictEqual(results.filter((result) => /rollover capsule/.test(result.stdout)).length, 1);
  assert.strictEqual(results.filter((result) => /already been consumed/.test(result.stderr)).length, 1);
}

console.log('test-continuity: ok');
