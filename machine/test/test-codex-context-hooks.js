'use strict';

// Narrow integration coverage for the Codex same-thread rollover hooks:
// SessionStart source parsing/continuity recovery and the voluntary
// `new_context` freshness guard.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scaffoldTree } = require(path.join(__dirname, '..', 'src', 'scaffold.js'));
const { writeContinuity } = require(path.join(__dirname, '..', 'src', 'continuity.js'));

const REPO = path.resolve(__dirname, '..', '..');
const SESSIONSTART = path.join(REPO, 'hooks', 'scripts', 'sessionstart-digest.sh');
const PRECONTEXT = path.join(REPO, 'hooks', 'scripts', 'precontext-guard.mjs');
const SESSION_A = 'codex-session-a';
const SESSION_B = 'codex-session-b';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-codex-hooks-'));
const project = path.join(tmp, 'project');
const tree = path.join(project, '.maestro');
const continuityDir = path.join(tree, 'continuity');
const fakePlugin = path.join(tmp, 'plugin');

fs.mkdirSync(project, { recursive: true });
scaffoldTree(tree);
fs.mkdirSync(path.join(fakePlugin, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(fakePlugin, 'machine', 'src'), { recursive: true });

fs.writeFileSync(path.join(fakePlugin, 'hooks', 'posture.md'), '<test-posture>plugin-root-ok</test-posture>\n');
fs.writeFileSync(
  path.join(fakePlugin, 'machine', 'src', 'continuity.js'),
  [
    `const machine = require(${JSON.stringify(path.join(REPO, 'machine', 'src', 'continuity.js'))});`,
    "if (process.argv[2] === 'consume') {",
    "  const claimed = machine.consumeContinuity(process.argv[3], process.argv[4]);",
    "  if (process.env.MAESTRO_TEST_BIG) process.stdout.write('x'.repeat(20000));",
    "  else process.stdout.write('continuity-sentinel\\n' + claimed.capsule);",
    "} else if (process.argv[2] === 'read') {",
    "  process.stdout.write(machine.readContinuity(process.argv[3]));",
    "} else process.exit(3);",
    '',
  ].join('\n')
);

fs.writeFileSync(path.join(tree, 'state.json'), JSON.stringify({
  schema_version: 1,
  missions: {
    alpha: { status: 'active', next_action: 'finish hook tests' },
    done: { status: 'closed', next_action: null },
  },
  active_mission: 'alpha',
  preflight: null,
  last_stop: null,
}));
fs.writeFileSync(path.join(tree, 'holds.jsonl'), [
  JSON.stringify({ seq: 0, kind: 'genesis', payload: {} }),
  JSON.stringify({ seq: 1, kind: 'park', payload: { summary: 'resolved' } }),
  JSON.stringify({ seq: 2, kind: 'park', payload: { summary: 'open' } }),
  JSON.stringify({ seq: 3, kind: 'resolve', park_seq: 1, payload: {} }),
  '',
].join('\n'));
fs.writeFileSync(path.join(tree, 'roster.json'), JSON.stringify({
  schema_version: 1,
  entries: [
    { seat: 'one', task_id: 't-1', status: 'alive' },
    { seat: 'two', task_id: 't-2', status: 'dead' },
  ],
}));

function baseEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.CODEX_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'PLUGIN_ROOT')) delete env.PLUGIN_ROOT;
  if (!Object.prototype.hasOwnProperty.call(overrides, 'CLAUDE_PLUGIN_ROOT')) delete env.CLAUDE_PLUGIN_ROOT;
  return env;
}

function runSession(source, overrides = {}, sessionId = SESSION_A) {
  const result = spawnSync('bash', [SESSIONSTART], {
    cwd: project,
    env: baseEnv({ PLUGIN_ROOT: fakePlugin, ...overrides }),
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd: project, session_id: sessionId }),
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return parsed.hookSpecificOutput.additionalContext;
}

function writeGuardState(patch = {}) {
  fs.rmSync(continuityDir, { recursive: true, force: true });
  return writeContinuity(tree, {
    mode: 'auto',
    mission: { id: 'alpha', objective: 'Finish the Codex rollover hook' },
    operator_intent: 'Continue autonomously through context rollover.',
    verified_evidence: [],
    in_progress: [{ item: 'Hook integration', exact_stop: 'Guard implemented.', exact_next: 'Run hook tests.' }],
    blockers: [],
    next_actions: ['Run the narrow hook tests'],
    decisions: [],
    hypotheses: [],
    open_threads: [],
    traps: [],
    key_paths: ['hooks/scripts/precontext-guard.mjs'],
    commands: [],
    origin: { session: 'test-session', window: 'test-window' },
    ...patch,
  });
}

function writeNextGuardState(patch = {}) {
  return writeContinuity(tree, {
    mode: 'auto',
    mission: { id: 'alpha', objective: 'Finish the Codex rollover hook' },
    operator_intent: 'Continue autonomously through context rollover.',
    verified_evidence: [],
    in_progress: [{ item: 'Hook integration', exact_stop: 'Guard implemented.', exact_next: 'Run hook tests.' }],
    blockers: [],
    next_actions: ['Run the narrow hook tests'],
    decisions: [],
    hypotheses: [],
    open_threads: [],
    traps: [],
    key_paths: ['hooks/scripts/precontext-guard.mjs'],
    commands: [],
    origin: { session: 'test-session', window: 'test-window-next' },
    ...patch,
  });
}

function runGuard(
  input = { hook_event_name: 'PreToolUse', tool_name: 'new_context', cwd: project, session_id: SESSION_A },
  script = PRECONTEXT
) {
  return spawnSync(process.execPath, [script], {
    cwd: project,
    env: baseEnv(),
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

// Ordinary SessionStart uses the Codex-native PLUGIN_ROOT, parses cwd from
// stdin, and reports real park/resolve and roster.entries semantics.
let context = runSession('startup');
assert.match(context, /plugin-root-ok/);
assert.match(context, /state\.json: 2 mission\(s\), 1 open/);
assert.match(context, /holds: 1 open of 2 parked/);
assert.match(context, /roster: 2 seat\(s\) \(1 alive, 1 dead\)/);

// Claude compatibility remains: an empty PLUGIN_ROOT falls back to the older
// CLAUDE_PLUGIN_ROOT variable.
context = runSession('startup', { PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: fakePlugin });
assert.match(context, /plugin-root-ok/);

// Claude also reports source=compact, but it has not performed Codex's blank
// same-thread reset. With only CLAUDE_PLUGIN_ROOT, stay on the ordinary digest.
context = runSession('compact', { PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: fakePlugin });
assert.match(context, /plugin-root-ok/);
assert.match(context, /\.maestro state digest/);
assert.doesNotMatch(context, /Same-thread context rollover/);
assert.doesNotMatch(context, /Compact recovery — no one-time capsule/);

// A fresh handoff alone does not prove that this compact came from the
// explicit new_context tool. Unarmed Codex compact is neutral and leaves the
// generation available.
const firstState = writeGuardState();
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.doesNotMatch(context, /continuity-sentinel/);
assert.ok(!fs.existsSync(path.join(continuityDir, 'consumed.json')));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(continuityDir, 'handoff-state.json'), 'utf8')).digest, firstState.digest);
context = runSession('compact', {}, '');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.ok(!fs.existsSync(path.join(continuityDir, 'consumed.json')), 'missing SessionStart session_id cannot consume');

// Successful PreToolUse validation atomically arms this exact generation.
// SessionStart can then consume it once and inject the compact capsule.
let guarded = runGuard();
assert.strictEqual(guarded.status, 0, guarded.stderr);
assert.strictEqual(guarded.stdout, '');
const armed = JSON.parse(fs.readFileSync(path.join(continuityDir, 'armed.json'), 'utf8'));
assert.strictEqual(armed.generation, firstState.generation);
assert.strictEqual(armed.digest, firstState.digest);
assert.strictEqual(armed.session_id, SESSION_A);

// A second Codex session in the same cwd sees source=compact too, but cannot
// claim session A's arm. Its neutral recovery leaves both state and arm intact.
context = runSession('compact', {}, SESSION_B);
assert.match(context, /Compact recovery — no one-time capsule/);
assert.doesNotMatch(context, /continuity-sentinel/);
assert.ok(!fs.existsSync(path.join(continuityDir, 'consumed.json')));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(continuityDir, 'armed.json'), 'utf8')).session_id, SESSION_A);

context = runSession('compact');
assert.match(context, /Same-thread context rollover/);
assert.match(context, /continuity-sentinel/);
assert.match(context, /immediately perform its exact next action/);
assert.match(context, /Do not scan the old transcript/);
assert.match(context, /ask them to restate the request/);
assert.ok(fs.existsSync(path.join(continuityDir, 'consumed.json')));
assert.ok(!fs.existsSync(path.join(continuityDir, 'armed.json')), 'successful consume retires the arm');

// The same generation cannot be injected twice, even when SessionStart is
// replayed inside the freshness window.
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.doesNotMatch(context, /continuity-sentinel/);
const replayGuard = runGuard();
assert.match(
  JSON.parse(replayGuard.stdout).hookSpecificOutput.permissionDecisionReason,
  /already been consumed/,
  'the consumed generation must not authorize another voluntary reset'
);

// Hook output remains within its declared context cap even if the continuity
// consumer violates its own bounded-output contract. A new generation is
// consumable even though the preceding generation has a consumed marker.
writeNextGuardState({ next_actions: ['Consume generation two with bounded output.'] });
guarded = runGuard();
assert.strictEqual(guarded.stdout, '');
context = runSession('compact', { MAESTRO_TEST_BIG: '1' });
assert.ok(Buffer.byteLength(context, 'utf8') <= 12500, 'SessionStart context must be hard-capped');
assert.match(context, /Compact recovery — no one-time capsule/);

// Missing continuity cannot be passed off as lossless: compact recovery is
// labeled as lacking a one-time capsule and falls back to the durable digest.
fs.unlinkSync(path.join(continuityDir, 'handoff-state.json'));
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.match(context, /No fresh continuity generation could be claimed/);
assert.match(context, /holds: 1 open of 2 parked/);
assert.doesNotMatch(context, /continuity-sentinel/);

// The explicit rollover tool is denied until a valid, recent rollover record
// exists. The hook always exits 0; denial is expressed in the hook protocol.
guarded = runGuard();
assert.strictEqual(guarded.status, 0, guarded.stderr);
let denial = JSON.parse(guarded.stdout);
assert.strictEqual(denial.hookSpecificOutput.hookEventName, 'PreToolUse');
assert.strictEqual(denial.hookSpecificOutput.permissionDecision, 'deny');
assert.match(denial.hookSpecificOutput.permissionDecisionReason, /\$handoff in rollover mode/);

fs.writeFileSync(path.join(continuityDir, 'handoff-state.json'), '{not json');
guarded = runGuard();
assert.strictEqual(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecision, 'deny');

writeGuardState();
const noActionPath = path.join(continuityDir, 'handoff-state.json');
const noAction = JSON.parse(fs.readFileSync(noActionPath, 'utf8'));
noAction.next_actions = [];
fs.writeFileSync(noActionPath, JSON.stringify(noAction));
guarded = runGuard();
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /no usable next action/);

writeGuardState({ mode: 'transfer' });
guarded = runGuard();
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /not in automatic-rollover mode/);

writeGuardState();
const stalePath = path.join(continuityDir, 'handoff-state.json');
const stale = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
stale.generated_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
fs.writeFileSync(stalePath, JSON.stringify(stale));
guarded = runGuard();
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /stale/);
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/, 'forced compact must not rehydrate from a stale prior-window handoff');
assert.doesNotMatch(context, /continuity-sentinel/);

writeGuardState();
const corruptPath = path.join(continuityDir, 'handoff-state.json');
const corrupt = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
corrupt.digest = `sha256:${'0'.repeat(64)}`;
fs.writeFileSync(corruptPath, JSON.stringify(corrupt));
guarded = runGuard();
assert.match(
  JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason,
  /failed schema or integrity validation/,
  'a shape-correct handoff with a corrupt digest must not permit rollover'
);
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/, 'compact SessionStart must reject a corrupt handoff digest');

writeGuardState();
fs.writeFileSync(path.join(continuityDir, 'armed.json'), '{broken arm');
guarded = runGuard();
assert.match(
  JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason,
  /arm marker could not be created or verified safely/,
  'a malformed arm marker must deny PreToolUse rather than being overwritten'
);
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.ok(!fs.existsSync(path.join(continuityDir, 'consumed.json')));

writeGuardState();
guarded = runGuard();
assert.strictEqual(guarded.status, 0, guarded.stderr);
assert.strictEqual(guarded.stdout, '', 'fresh rollover handoff should permit new_context silently');

fs.writeFileSync(path.join(continuityDir, 'consumed.json'), '{broken marker');
guarded = runGuard();
assert.match(
  JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason,
  /consumption marker or state is unreadable/,
  'an unreadable consumption marker must deny voluntary rollover'
);
context = runSession('compact');
assert.match(context, /Compact recovery — no one-time capsule/);
assert.doesNotMatch(context, /continuity-sentinel/);

// A voluntary reset cannot be verified when the coupled machine validator is
// unavailable. Deny it; Codex's forced automatic boundary bypasses this hook.
const detachedGuard = path.join(tmp, 'detached', 'hooks', 'scripts', 'precontext-guard.mjs');
fs.mkdirSync(path.dirname(detachedGuard), { recursive: true });
fs.copyFileSync(PRECONTEXT, detachedGuard);
guarded = runGuard(undefined, detachedGuard);
assert.match(
  JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason,
  /validator is unavailable/,
  'shape-only validation must never permit voluntary new_context'
);

// Matcher defense leaves unrelated tools alone. Malformed matched input denies
// the voluntary reset; forced automatic rollover never invokes this guard.
guarded = runGuard({ tool_name: 'Read', cwd: project });
assert.strictEqual(guarded.stdout, '');
guarded = runGuard({ cwd: project });
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /missing tool_name/);
guarded = runGuard({ tool_name: 'new_context', cwd: project });
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /bounded session_id/);
guarded = runGuard({ tool_name: 'new_context', cwd: project, session_id: 's'.repeat(257) });
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /bounded session_id/);
guarded = runGuard([]);
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /plain JSON object/);
guarded = runGuard('{broken hook input');
assert.strictEqual(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecision, 'deny');
assert.match(JSON.parse(guarded.stdout).hookSpecificOutput.permissionDecisionReason, /hook input is unreadable or malformed/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('test-codex-context-hooks: ok');
