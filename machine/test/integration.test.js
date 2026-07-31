'use strict';
// End-to-end lifecycle integration test: one temp treeRoot driven through
// scaffold -> preflight -> routing -> settings -> mission/roster/gate/close ->
// hold -> deviate -> stop -> reconcile -> views, asserting file-level outcomes
// (records present, seq monotonic, no lock leftovers) at every stage.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const SCRIPT = (name) => path.join(SRC, name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-integration-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// The tree lives inside a fake project dir (preflight probes git -C <project>).
const project = path.join(tmp, 'proj');
fs.mkdirSync(project);
const root = path.join(project, '.maestro');

// Controlled PATH for preflight: real node via a private symlink (node's own
// bin dir would leak npm-global CLIs back onto the PATH), plus codex/gemini
// shims that exit 0 so both providers measure "present" deterministically and
// routing applies no degradation.
const shimDir = path.join(tmp, 'bin');
fs.mkdirSync(shimDir);
fs.symlinkSync(process.execPath, path.join(shimDir, 'node'));
for (const shim of ['codex', 'gemini']) {
  const p = path.join(shimDir, shim);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
}

function run(script, args, stdin, env) {
  return spawnSync(process.execPath, [SCRIPT(script), ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
    env: env || process.env,
  });
}

function ok(r, label) {
  assert.strictEqual(r.status, 0, `${label}: ${r.stderr || r.stdout}`);
  return r;
}

function refused(r, pattern, label) {
  assert.strictEqual(r.status, 1, `${label} must be refused (stdout: ${r.stdout})`);
  assert.match(r.stderr, pattern, label);
  return r;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readRecords(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

const stateOf = () => readJson(path.join(root, 'state.json'));
const ledgerOf = () => readRecords(path.join(root, 'ledger.jsonl'));

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

// --- 1. scaffold genesis -----------------------------------------------------
{
  ok(run('scaffold.js', [root]), 'scaffold genesis');
  const state = stateOf();
  assert.strictEqual(state.schema_version, 1);
  assert.deepStrictEqual(state.missions, {});
  assert.strictEqual(state.active_mission, null);
  assert.strictEqual(state.preflight, null);
  assert.strictEqual(state.last_stop, null);
  assert.ok(typeof state.created_ts === 'string' && state.created_ts.endsWith('Z'));

  const ledger = ledgerOf();
  assert.strictEqual(ledger.length, 1, 'ledger genesis-seeded with one record');
  assert.strictEqual(ledger[0].kind, 'genesis');
  assert.strictEqual(ledger[0].seq, 0);
  const holds = readRecords(path.join(root, 'holds.jsonl'));
  assert.strictEqual(holds.length, 1);
  assert.strictEqual(holds[0].kind, 'genesis');

  for (const p of ['settings.json', 'routing/active.json', 'handoff.md']) {
    assert.ok(fs.existsSync(path.join(root, p)), `${p} exists after scaffold`);
  }
  for (const d of ['missions', 'views', 'routing']) {
    assert.ok(fs.statSync(path.join(root, d)).isDirectory(), `${d}/ exists`);
  }

  // Genesis puts `.maestro/` in the project's .gitignore (created here — the
  // fake project had none).
  const gitignore = path.join(project, '.gitignore');
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '.maestro/\n');

  // Re-scaffold is inert.
  const again = ok(run('scaffold.js', [root]), 're-scaffold');
  assert.match(again.stdout, /exists/);
  assert.strictEqual(ledgerOf().length, 1, 're-scaffold mutates nothing');
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '.maestro/\n', 're-scaffold leaves .gitignore alone');
}

// --- 2. preflight run (both providers present via shims) ---------------------
{
  ok(
    run('preflight.js', ['run', root], undefined, { PATH: shimDir }),
    'preflight run'
  );
  const pf = stateOf().preflight;
  assert.ok(pf, 'state.json.preflight recorded');
  assert.strictEqual(pf.node.routing, 'present');
  assert.strictEqual(pf.per_provider.codex.routing, 'present');
  assert.strictEqual(pf.per_provider.gemini.routing, 'present');
  assert.strictEqual(pf.providers.codex.observed, 'present');
  assert.strictEqual(pf.providers.gemini.observed, 'present');

  const ledger = ledgerOf();
  assert.strictEqual(ledger[ledger.length - 1].kind, 'preflight');
}

// --- 3. routing active + review-for gpt --------------------------------------
{
  const active = ok(run('routing.js', ['active', root]), 'routing active');
  const effective = JSON.parse(active.stdout);
  assert.deepStrictEqual(effective.degraded_modes, [], 'both providers up: no degradation');
  assert.deepStrictEqual(effective.seat_substitutions, {}, 'no substitutions');
  assert.ok(effective.seats['executor-sol'], 'seat table present');
  assert.deepStrictEqual(
    effective.review_routing.gpt,
    ['reviewer-claude', 'reviewer-gemini'],
    'gpt review row intact'
  );

  const rf = ok(run('routing.js', ['review-for', root, 'gpt']), 'review-for gpt');
  assert.strictEqual(rf.stdout.trim(), 'reviewer-claude');
  assert.strictEqual(rf.stderr, '', 'no decorrelation notice when the route did not change');
}

// --- 4. settings: clamp + locked-key rejection --------------------------------
{
  const clampWrite = ok(
    run('settings.js', ['write', root], { fleet_ceiling: 40 }),
    'settings write fleet_ceiling 40'
  );
  const out = JSON.parse(clampWrite.stdout);
  assert.strictEqual(out.settings.fleet_ceiling, 12, 'out-of-range clamps to ceiling');
  assert.ok(
    out.clamps.some((c) => c.key === 'fleet_ceiling' && c.rule === 'ceiling' && c.from === 40 && c.to === 12),
    'ceiling clamp reported'
  );
  assert.strictEqual(readJson(path.join(root, 'settings.json')).fleet_ceiling, 12);

  // Locked key: whole write refused, nothing lands.
  refused(
    run('settings.js', ['write', root], { review_floor: 'single-family', fleet_ceiling: 3 }),
    /review_floor/,
    'review_floor change'
  );
  assert.strictEqual(
    readJson(path.join(root, 'settings.json')).fleet_ceiling,
    12,
    'refused write lands nothing, not even the valid part'
  );
}

// --- 5. mission open ----------------------------------------------------------
{
  const r = ok(
    run('mission.js', ['open', root], { mission_id: 'm1', title: 'Ship the widget', brief: VALID_BRIEF }),
    'mission open m1'
  );
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.mission_id, 'm1');
  assert.deepStrictEqual(readJson(path.join(root, 'missions', 'm1', 'brief.json')), VALID_BRIEF);
  assert.strictEqual(stateOf().missions.m1.status, 'open');
  const progress = readRecords(path.join(root, 'missions', 'm1', 'progress.jsonl'));
  assert.strictEqual(progress[0].kind, 'genesis', 'progress stream genesis-seeded');
  const ledger = ledgerOf();
  assert.strictEqual(ledger[ledger.length - 1].kind, 'mission-open');
}

// --- 6. roster register executor-sol -----------------------------------------
{
  const r = ok(
    run('roster.js', ['register', root], {
      seat: 'executor-sol',
      task_id: 't-1',
      family: 'gpt',
      codex_session: 'sess-abc',
      mission_id: 'm1',
    }),
    'roster register'
  );
  const entry = JSON.parse(r.stdout);
  assert.strictEqual(entry.status, 'alive');
  const roster = readJson(path.join(root, 'roster.json'));
  assert.strictEqual(roster.entries.length, 1);
  assert.strictEqual(roster.entries[0].task_id, 't-1');
}

// --- 7. checkpoint x2 ---------------------------------------------------------
{
  ok(
    run('mission.js', ['checkpoint', root, 'm1'], {
      step: 'scaffolded widget module',
      done_evidence: 'commit abc123 in worktree',
      next: 'wire the widget into the CLI',
    }),
    'checkpoint 1'
  );
  ok(
    run('mission.js', ['checkpoint', root, 'm1'], {
      step: 'wired widget into CLI',
      done_evidence: 'commit def456, tests green locally',
      next: 'run the gate',
    }),
    'checkpoint 2'
  );
  const progress = readRecords(path.join(root, 'missions', 'm1', 'progress.jsonl'));
  const checkpoints = progress.filter((p) => p.kind === 'checkpoint');
  assert.strictEqual(checkpoints.length, 2);
  assert.strictEqual(checkpoints[1].step, 'wired widget into CLI');
  assert.strictEqual(stateOf().missions.m1.next_action, 'run the gate');
}

// --- 8. record-envelope: valid landed, invalid refused ------------------------
{
  const envelope = {
    state: 'done',
    result: 'widget shipped',
    evidence: 'tests green, see artifact',
    risks: 'none observed',
    artifact: 'missions/m1/artifacts/report.md',
    question: '',
  };
  const r = ok(run('mission.js', ['record-envelope', root, 'm1', 'executor-sol'], envelope), 'record-envelope');
  const out = JSON.parse(r.stdout);
  assert.ok(fs.existsSync(out.envelope_path), 'envelope file written');
  assert.deepStrictEqual(readJson(out.envelope_path), envelope);
  const ledger = ledgerOf();
  assert.strictEqual(ledger[ledger.length - 1].kind, 'envelope');

  const envDir = path.join(root, 'missions', 'm1', 'envelopes');
  const before = fs.readdirSync(envDir).length;
  // blocked with an empty question violates the six-field contract
  refused(
    run('mission.js', ['record-envelope', root, 'm1', 'executor-sol'], { ...envelope, state: 'blocked' }),
    /invalid envelope/,
    'invalid envelope'
  );
  assert.strictEqual(fs.readdirSync(envDir).length, before, 'refused envelope writes nothing');
  assert.strictEqual(ledgerOf().length, ledger.length, 'refused envelope appends nothing');
}

// --- 9. gate run-gate with a passing cmd --------------------------------------
let passSeq;
{
  const r = ok(run('gate.js', ['run-gate', root, 'm1', 'tests', '--', 'true']), 'run-gate');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 0);
  passSeq = out.ledger_seq;
  assert.ok(Number.isSafeInteger(passSeq));
  assert.ok(fs.existsSync(path.join(root, 'missions', 'm1', 'artifacts', 'gate-tests.log')), 'gate log written');
  const rec = ledgerOf().find((l) => l.seq === passSeq);
  assert.strictEqual(rec.kind, 'gate');
  assert.strictEqual(rec.exit_code, 0);
  assert.strictEqual(rec.mission_id, 'm1');

  const honesty = ok(run('gate.js', ['check-honesty', root, 'm1', 'tests']), 'check-honesty');
  assert.strictEqual(JSON.parse(honesty.stdout).ok, true);
}

// --- 10. close refused on same-family review ----------------------------------
{
  refused(
    run('mission.js', ['close', root, 'm1'], {
      author_family: 'gpt',
      review: { verdict: 'approve', family: 'gpt' },
      gate_seq: passSeq,
    }),
    /cross-family/,
    'same-family close'
  );
  assert.strictEqual(stateOf().missions.m1.status, 'open', 'refusal leaves the mission open');
}

// --- 11. close succeeds with cross-family approve + gate seq ------------------
{
  const r = ok(
    run('mission.js', ['close', root, 'm1'], {
      author_family: 'gpt',
      review: { verdict: 'approve', family: 'claude' },
      gate_seq: passSeq,
    }),
    'cross-family close'
  );
  void r;
  const state = stateOf();
  assert.strictEqual(state.missions.m1.status, 'done');
  assert.strictEqual(state.missions.m1.next_action, null);
  const ledger = ledgerOf();
  assert.strictEqual(ledger[ledger.length - 1].kind, 'mission-close');
}

// A second mission stays open so the handoff has a mission line to render.
ok(
  run('mission.js', ['open', root], {
    mission_id: 'm2',
    title: 'Follow-up polish',
    brief: VALID_BRIEF,
    next_action: 'scout the tree',
  }),
  'mission open m2'
);

// --- 12. hold park S2, S1 refusal ---------------------------------------------
let parkSeq;
{
  const r = ok(
    run('hold.js', ['park', root], { summary: 'flaky test in widget suite', severity: 'S2', owner_mission: 'm2' }),
    'park S2'
  );
  const rec = JSON.parse(r.stdout);
  assert.strictEqual(rec.kind, 'park');
  parkSeq = rec.seq;

  refused(
    run('hold.js', ['park', root], { summary: 'foundational schema dispute', severity: 'S1' }),
    /S1 never parks; it goes to the operator/,
    'S1 park'
  );

  const list = ok(run('hold.js', ['list', root]), 'hold list');
  const open = JSON.parse(list.stdout);
  assert.deepStrictEqual(open.map((h) => h.seq), [parkSeq], 'exactly the S2 park is open');
}

// --- 13. deviation record -----------------------------------------------------
{
  const r = ok(
    run('deviate.js', ['record-deviation', root], {
      reported_by: 'executor-sol',
      expected: 'config.json present per brief',
      actual: 'config.json missing from the tree',
      summary: 'brief premise false; refused the step',
    }),
    'record-deviation'
  );
  assert.strictEqual(JSON.parse(r.stdout).kind, 'deviation');
}

// --- 14. stop write-stop BLOCKED-OPERATOR -------------------------------------
const QUESTION = 'Which config schema should m2 target, v1 or v2?';
{
  // question is required for BLOCKED-OPERATOR
  refused(
    run('stop.js', ['write-stop', root], { stop_state: 'BLOCKED-OPERATOR', reporter: 'handoff-recorder' }),
    /question/,
    'BLOCKED-OPERATOR without question'
  );

  ok(
    run('stop.js', ['write-stop', root], {
      stop_state: 'BLOCKED-OPERATOR',
      reporter: 'handoff-recorder',
      question: QUESTION,
    }),
    'write-stop'
  );
  const state = stateOf();
  assert.strictEqual(state.last_stop.stop_state, 'BLOCKED-OPERATOR');
  const ledger = ledgerOf();
  const stopRec = ledger[ledger.length - 1];
  assert.strictEqual(stopRec.kind, 'stop');
  assert.strictEqual(state.last_stop.seq, stopRec.seq, 'last_stop cites the ledger record');
}

// --- 15. handoff.md projection ------------------------------------------------
{
  const handoff = fs.readFileSync(path.join(root, 'handoff.md'), 'utf8');
  assert.ok(handoff.startsWith('# Handoff\n'), 'header');
  assert.ok(handoff.includes('## Last stop'), 'last-stop section');
  assert.ok(handoff.includes('BLOCKED-OPERATOR'), 'stop state present');
  assert.ok(handoff.includes(QUESTION), 'question rendered verbatim');
  assert.ok(handoff.includes('- Open holds: 1'), 'open-hold count');
  assert.match(handoff, /- m2 \(open\): scout the tree/, 'open mission line with next_action');
  assert.ok(!/^- m1 /m.test(handoff), 'done mission renders no line');
}

// --- 16. roster reconcile with an empty live-list ------------------------------
{
  ok(run('roster.js', ['reconcile', root], []), 'roster reconcile');
  const roster = readJson(path.join(root, 'roster.json'));
  assert.strictEqual(roster.entries.length, 1);
  assert.strictEqual(roster.entries[0].task_id, 't-1');
  assert.strictEqual(roster.entries[0].status, 'dead', 'empty live-list marks the seat dead');
}

// --- 17. project views --------------------------------------------------------
{
  ok(run('project.js', ['views', root]), 'project views');
  for (const view of ['fleet.md', 'missions.md', 'holds.md', 'recent.md']) {
    const p = path.join(root, 'views', view);
    assert.ok(fs.existsSync(p), `${view} rendered`);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    assert.ok(lines.length > 0 && lines.some((l) => l.trim() !== ''), `${view} non-empty`);
    assert.ok(lines.length <= 61, `${view} bounded at 60 lines (got ${lines.length - 1})`);
  }
  const fleet = fs.readFileSync(path.join(root, 'views', 'fleet.md'), 'utf8');
  assert.ok(fleet.includes('executor-sol'), 'fleet view shows the seat');
  const holdsView = fs.readFileSync(path.join(root, 'views', 'holds.md'), 'utf8');
  assert.ok(holdsView.includes('flaky test in widget suite'), 'holds view shows the open hold');
}

// --- 18. file-level invariants ------------------------------------------------
{
  // Every stream's seqs are strictly monotonic and consecutive from 0.
  for (const stream of ['ledger.jsonl', 'holds.jsonl', path.join('missions', 'm1', 'progress.jsonl')]) {
    const records = readRecords(path.join(root, stream));
    records.forEach((rec, i) => {
      assert.strictEqual(rec.seq, i, `${stream} seq ${rec.seq} at position ${i}`);
      assert.strictEqual(rec.schema_version, 1, `${stream} schema_version`);
      assert.ok(typeof rec.ts === 'string' && rec.ts.endsWith('Z'), `${stream} ts is UTC Z`);
    });
  }

  // The ledger carries exactly the expected evidence kinds.
  const kinds = ledgerOf().map((r) => r.kind);
  for (const expected of ['genesis', 'preflight', 'mission-open', 'envelope', 'gate', 'mission-close', 'deviation', 'stop']) {
    assert.ok(kinds.includes(expected), `ledger has a ${expected} record`);
  }

  // No lock or temp leftovers anywhere in the tree.
  const leftovers = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.lock$|\.tmp|~$/.test(entry.name)) leftovers.push(p);
    }
  })(root);
  assert.deepStrictEqual(leftovers, [], 'no lock/temp leftovers');
}

console.log('integration.test.js: all stages green');
