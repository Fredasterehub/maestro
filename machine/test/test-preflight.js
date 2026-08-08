'use strict';

// Tests for preflight.js pair semantics, driven by PATH manipulation with
// fake CLIs: measured absence, measured presence, unexpected error
// (observed "unknown" routing as absent), and semantic auth failure.
// Preflight reports rather than gates: exit 0 in every probed condition.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const PREFLIGHT = path.join(SRC, 'preflight.js');
const { scaffoldTree } = require(path.join(SRC, 'scaffold.js'));
const { readJson } = require(path.join(SRC, 'atomic-json.js'));
const { readRecords } = require(path.join(SRC, 'jsonl.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-preflight-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, 'proj', '.maestro');
scaffoldTree(root);

// Fake CLI bin dir. Exit codes are steered per-run via environment
// variables, so one pair of scripts covers every scenario.
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(
  path.join(fakeBin, 'codex'),
  '#!/bin/sh\n' +
    'if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit ${FAKE_CODEX_VERSION_EXIT:-0}; fi\n' +
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${FAKE_CODEX_AUTH_EXIT:-0}; fi\n' +
    'if [ "$1" = "exec" ]; then echo "${FAKE_CODEX_EXEC_MSG:-ok}" >&2; exit ${FAKE_CODEX_EXEC_EXIT:-0}; fi\n' +
    'exit 2\n',
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(fakeBin, 'gemini'),
  '#!/bin/sh\n' +
    'if [ "$1" = "--version" ]; then echo "9.9.9"; exit ${FAKE_GEMINI_VERSION_EXIT:-0}; fi\n' +
    'if [ "$1" = "-p" ]; then echo "${FAKE_GEMINI_EXEC_MSG:-ok}" >&2; exit ${FAKE_GEMINI_EXEC_EXIT:-0}; fi\n' +
    'exit 2\n',
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(fakeBin, 'antigravity'),
  '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "antigravity 1.0.0"; exit ${FAKE_ANTIGRAVITY_VERSION_EXIT:-0}; fi\nexit 2\n',
  { mode: 0o755 }
);

// A second bin dir carrying gemini but deliberately not antigravity, so the
// "gemini present, antigravity absent" split can be exercised on its own.
const geminiOnlyBin = path.join(tmp, 'geminionlybin');
fs.mkdirSync(geminiOnlyBin);
fs.copyFileSync(path.join(fakeBin, 'gemini'), path.join(geminiOnlyBin, 'gemini'));
fs.chmodSync(path.join(geminiOnlyBin, 'gemini'), 0o755);

// PATH always carries the real node (the node probe must find it) via a
// private shim dir — node's own directory would leak every npm-global CLI
// (codex included) back onto the PATH. git and gh are deliberately never on
// it, so those probes measure a clean absence.
const nodeDir = path.join(tmp, 'nodebin');
fs.mkdirSync(nodeDir);
fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));

function runPreflight(env) {
  const r = spawnSync(process.execPath, [PREFLIGHT, 'run', root], {
    encoding: 'utf8',
    env: { PATH: env.path, ...env.vars },
  });
  assert.strictEqual(r.status, 0, `preflight must exit 0 (reporting, not gating): ${r.stderr}`);
  return { cli: r, block: readJson(path.join(root, 'state.json')).preflight };
}

function assertPair(cap, routing, observed, label) {
  assert.strictEqual(cap.routing, routing, `${label} routing`);
  assert.strictEqual(cap.observed, observed, `${label} observed`);
}

// Model-shape assertions, applied to any provider's capability record:
// every entry is an object with a tri-state status that is never rounded
// to "present" without discovery, and efforts is always an array.
function assertModelsShape(models, label) {
  assert.ok(models !== null && typeof models === 'object' && !Array.isArray(models), `${label} models must be an object`);
  for (const [modelId, entry] of Object.entries(models)) {
    assert.ok(['present', 'absent', 'unknown'].includes(entry.status), `${label}.${modelId} status must be tri-state`);
    assert.ok(Array.isArray(entry.efforts), `${label}.${modelId} efforts must always be an array`);
  }
}

// Case A: codex/gemini/antigravity/git/gh all off PATH — measured absence
// everywhere.
{
  const { cli, block } = runPreflight({ path: nodeDir, vars: {} });
  assertPair(block.node, 'present', 'present', 'A node');
  assertPair(block.providers.codex, 'absent', 'absent', 'A codex');
  assert.strictEqual(block.providers.codex.checks.auth, null, 'A: auth never ran, so it is null (NOT COMPUTED)');
  assertPair(block.providers.gemini, 'absent', 'absent', 'A gemini');
  assertPair(block.providers.antigravity, 'absent', 'absent', 'A antigravity');
  // Classification 3 of 4: no binary on PATH is a measured "absent" lane,
  // recorded without ever running the live probe.
  assert.strictEqual(block.providers.codex.lane.state, 'absent', 'A codex lane absent');
  assert.strictEqual(block.providers.gemini.lane.state, 'absent', 'A gemini lane absent');
  assert.strictEqual(block.providers.codex.lane.reset_at, null, 'A: an absent lane states no reset time');
  assertPair(block.git, 'absent', 'absent', 'A git');
  assertPair(block.gh, 'absent', 'absent', 'A gh');
  assert.match(block.checked_ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  // Exact model x effort shape (design §11.1): present for every probed
  // provider (codex, gemini, antigravity), in both the detailed record and
  // the bare per_provider record, and never "no map" even when a provider
  // has no tracked model id.
  for (const providerKey of ['codex', 'gemini', 'antigravity']) {
    assertModelsShape(block.providers[providerKey].models, `A providers.${providerKey}`);
    assertModelsShape(block.per_provider[providerKey].models, `A per_provider.${providerKey}`);
    assert.deepStrictEqual(
      block.per_provider[providerKey].models,
      block.providers[providerKey].models,
      `A per_provider.${providerKey}.models mirrors providers.${providerKey}.models`
    );
  }
  assert.ok(
    Object.keys(block.providers.codex.models).length > 0,
    'A codex tracks at least one model id'
  );

  // An absent provider (codex here) yields model entries that are never
  // "present" — no authenticated discovery surface exists in this repo
  // today for any provider, so codex's entries stay "unknown", not
  // fabricated from the CLI being absent.
  for (const entry of Object.values(block.providers.codex.models)) {
    assert.notStrictEqual(entry.status, 'present', 'A codex model status is never present without discovery');
    assert.strictEqual(entry.status, 'unknown', 'A codex model status stays unknown, never rounded to absent/present');
    assert.deepStrictEqual(entry.efforts, [], 'A codex model efforts is an empty array, not fabricated');
  }

  // unknown survives into the printed summary too, never silently rounded.
  assert.match(cli.stdout, /gpt-5\.6-luna:unknown\[\]/, 'A: unknown status renders in the summary');
  assert.match(cli.stdout, /models: \(no tracked models\)/, 'A: antigravity has no tracked model id today');
}

// Case B: all three fake CLIs healthy and authenticated — measured presence,
// and antigravity being present shows up as a preference note on gemini's
// summary line.
{
  const { cli, block } = runPreflight({ path: `${fakeBin}:${nodeDir}`, vars: {} });
  assertPair(block.providers.codex, 'present', 'present', 'B codex');
  assert.strictEqual(block.providers.codex.version, 'codex-cli 9.9.9');
  assert.strictEqual(block.providers.codex.checks.auth.exit, 0);
  assertPair(block.providers.gemini, 'present', 'present', 'B gemini');
  assertPair(block.providers.antigravity, 'present', 'present', 'B antigravity');
  assert.strictEqual(block.providers.antigravity.version, 'antigravity 1.0.0');
  // Classification 1 of 4: the live probe completed a trivial job, so the
  // lane is available and routes up.
  assert.strictEqual(block.providers.codex.lane.state, 'available', 'B codex lane available');
  assert.strictEqual(block.providers.gemini.lane.state, 'available', 'B gemini lane available');
  assert.match(block.providers.codex.lane.cmd, /^codex exec /, 'B: the lane probe records the exact command it ran');
  assert.match(cli.stdout, /lane: available/, 'B: the lane state renders in the summary');
  assert.match(cli.stdout, /codex\s+present/);
  assert.match(cli.stdout, /gemini\s+present.*prefers antigravity/, 'B: preference recorded on the gemini line');
  assert.match(cli.stdout, /antigravity\s+present/);

  // A present provider still carries only "unknown" model entries: CLI
  // presence/auth is not a model-level discovery surface, so status is
  // never inferred from it — through a full run and through the summary.
  for (const providerKey of ['codex', 'gemini', 'antigravity']) {
    assertModelsShape(block.providers[providerKey].models, `B providers.${providerKey}`);
    for (const entry of Object.values(block.providers[providerKey].models)) {
      assert.strictEqual(entry.status, 'unknown', `B ${providerKey} model status stays unknown despite CLI presence`);
    }
  }
  assert.match(cli.stdout, /gpt-5\.6-sol:unknown\[\]/, 'B: unknown status renders in the summary even when codex is present');
}

// Case B2: gemini present, antigravity absent — no preference is recorded,
// and the two capabilities stay independent pairs.
{
  const { cli, block } = runPreflight({ path: `${geminiOnlyBin}:${nodeDir}`, vars: {} });
  assertPair(block.providers.gemini, 'present', 'present', 'B2 gemini');
  assertPair(block.providers.antigravity, 'absent', 'absent', 'B2 antigravity');
  assert.doesNotMatch(cli.stdout, /prefers antigravity/, 'B2: no preference note when antigravity is absent');
}

// Case C: codex --version errors unexpectedly (exit 3) — the pair must
// preserve the distinction: observed "unknown", routed as absent, never
// rounded down to a measured "absent".
{
  const { block } = runPreflight({
    path: `${fakeBin}:${nodeDir}`,
    vars: { FAKE_CODEX_VERSION_EXIT: '3' },
  });
  assertPair(block.providers.codex, 'absent', 'unknown', 'C codex');
  assert.strictEqual(block.providers.codex.checks.auth, null, 'C: auth not computed after a failed version probe');
  assert.strictEqual(block.providers.codex.checks.version.exit, 3);
}

// Case D: codex present but unauthenticated — the auth exit code IS the
// semantic check, so this is a measured absence, not an unknown.
{
  const { block } = runPreflight({
    path: `${fakeBin}:${nodeDir}`,
    vars: { FAKE_CODEX_AUTH_EXIT: '1' },
  });
  assertPair(block.providers.codex, 'absent', 'absent', 'D codex');
  assert.strictEqual(block.providers.codex.checks.version.exit, 0);
  assert.strictEqual(block.providers.codex.checks.auth.exit, 1);
}

// Ledger evidence: one kind:"preflight" record per run, pairs preserved.
{
  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const preflights = records.filter((r) => r.kind === 'preflight');
  assert.strictEqual(preflights.length, 5, 'one preflight ledger record per run');
  const last = preflights[preflights.length - 1];
  // Case D: authenticated check failed, so the live probe never ran and the
  // lane is recorded from the presence evidence alone.
  assert.deepStrictEqual(last.codex, { routing: 'absent', observed: 'absent', lane: 'failing', lane_reset_at: null });
  assert.deepStrictEqual(last.gemini, { routing: 'present', observed: 'present', lane: 'available', lane_reset_at: null });
  assert.deepStrictEqual(last.node, { routing: 'present', observed: 'present' });
  assert.deepStrictEqual(last.antigravity, { routing: 'present', observed: 'present' }, 'D still had antigravity on PATH via fakeBin');
}

// Routing integration: the recorded per_provider pairs drive routing.js's
// degraded modes. Last run (case D) measured codex absent, gemini present.
{
  const { effectiveRouting } = require(path.join(SRC, 'routing.js'));
  const effective = effectiveRouting(root);
  assert.strictEqual(effective.preflight_recorded, true);
  assert.deepStrictEqual(effective.degraded_modes, ['codex_down']);
  assert.strictEqual(effective.seat_substitutions['executor-sol-expert'], 'executor-claude');
}

// Case E: the real-world 2026-08-08 case — codex is installed and
// authenticated, and the live probe comes back on a usage limit that names
// its own reset time. Classification 2 of 4: quota-limited, observed
// "present" (the CLI genuinely is there), routed as absent.
{
  const { cli, block } = runPreflight({
    path: `${fakeBin}:${nodeDir}`,
    vars: {
      FAKE_CODEX_EXEC_EXIT: '1',
      FAKE_CODEX_EXEC_MSG: 'You have hit your usage limit. Please try again at 2026-08-09T04:00:00Z.',
    },
  });
  assertPair(block.providers.codex, 'absent', 'present', 'E codex');
  assert.strictEqual(block.providers.codex.lane.state, 'quota-limited');
  assert.strictEqual(block.providers.codex.lane.reset_at, '2026-08-09T04:00:00Z', 'E: the reset time is parsed out of the error text');
  assert.strictEqual(block.providers.codex.checks.auth.exit, 0, 'E: the CLI really is authenticated');
  assert.strictEqual(block.per_provider.codex.lane.state, 'quota-limited', 'E: the bare routing surface carries the lane state');
  assert.match(cli.stdout, /lane: quota-limited — resets 2026-08-09T04:00:00Z/);

  // Routing keys off the lane state, not mere presence: a quota-walled codex
  // is codex_down, and every gpt seat resolves to its Claude substitute.
  const { effectiveRouting } = require(path.join(SRC, 'routing.js'));
  const effective = effectiveRouting(root);
  assert.deepStrictEqual(effective.degraded_modes, ['codex_down'], 'E: the quota wall flips the lane down');
  assert.strictEqual(effective.seat_substitutions['executor-sol-expert'], 'executor-claude');
  assert.strictEqual(effective.seat_substitutions['reviewer-terra'], 'reviewer-claude');
  assert.deepStrictEqual(effective.lane_states.gpt, { state: 'quota-limited', reset_at: '2026-08-09T04:00:00Z' });
  assert.deepStrictEqual(effective.lane_states.gemini, { state: 'available', reset_at: null });
  assert.ok(
    effective.notices.some((n) => n.includes('hit its usage limit') && n.includes('2026-08-09T04:00:00Z')),
    'E: a notice names the cause and the reset time'
  );
  // The gemini lane stayed available, so claude-authored standard work keeps
  // its gemini reviewer while losing the gpt rung the downed lane carried.
  assert.deepStrictEqual(effective.review_routing.claude.standard, ['reviewer-gemini']);
}

// Case F: the live probe fails for a reason that is not a quota wall —
// classification 4 of 4. The lane is down, but it is never relabeled as a
// quota wall, and preflight still exits 0.
{
  const { cli, block } = runPreflight({
    path: `${fakeBin}:${nodeDir}`,
    vars: { FAKE_GEMINI_EXEC_EXIT: '7', FAKE_GEMINI_EXEC_MSG: 'internal error: model backend unreachable' },
  });
  assertPair(block.providers.gemini, 'absent', 'present', 'F gemini');
  assert.strictEqual(block.providers.gemini.lane.state, 'failing');
  assert.strictEqual(block.providers.gemini.lane.reset_at, null, 'F: a failing lane claims no reset time');
  assert.match(block.providers.gemini.lane.detail, /exit 7.*model backend unreachable/s);
  assert.match(cli.stdout, /lane: failing/);

  const { effectiveRouting } = require(path.join(SRC, 'routing.js'));
  const effective = effectiveRouting(root);
  assert.deepStrictEqual(effective.degraded_modes, ['gemini_down'], 'F: a failing lane is that lane down');
  assert.strictEqual(effective.seat_substitutions['executor-gemini'], 'executor-claude');
  assert.strictEqual(effective.seat_substitutions['reviewer-gemini'], 'reviewer-claude');
  assert.deepStrictEqual(effective.lane_states.gemini, { state: 'failing', reset_at: null });
}

// The classifier itself, against synthesized probe results — every branch
// reachable without a subprocess at all, real CLI or fake.
{
  const { classifyLaneProbe, parseQuotaReset, LANE_STATES } = require(PREFLIGHT);
  const probe = (over) => ({ cmd: 'x', exit: 1, errorCode: null, text: '', ...over });

  assert.deepStrictEqual(classifyLaneProbe(probe({ exit: 0 })), { state: 'available', reset_at: null, detail: null });
  assert.strictEqual(classifyLaneProbe(probe({ errorCode: 'ENOENT', exit: null })).state, 'absent');
  assert.strictEqual(classifyLaneProbe(probe({ errorCode: 'ETIMEDOUT', exit: null })).state, 'failing');
  assert.match(classifyLaneProbe(probe({ errorCode: 'ETIMEDOUT', exit: null })).detail, /timed out after 60s/);
  assert.strictEqual(classifyLaneProbe(probe({ text: 'stack overflow' })).state, 'failing');

  // Every quota phrasing the wild uses, at whatever exit code, plus the
  // transport-level ones — all one classification.
  for (const text of [
    'You have hit your usage limit',
    'Quota exceeded for this project',
    'rate-limit reached',
    'HTTP 429 Too Many Requests',
    'RESOURCE_EXHAUSTED',
  ]) {
    assert.strictEqual(classifyLaneProbe(probe({ text })).state, 'quota-limited', `quota text: ${text}`);
  }
  // Quota text never wins over a successful run: exit 0 is exit 0.
  assert.strictEqual(classifyLaneProbe(probe({ exit: 0, text: 'usage limit' })).state, 'available');

  // Reset parsing is best effort and verbatim — no reformatting into a
  // timestamp nothing measured, and null when the error names no time.
  assert.strictEqual(parseQuotaReset('try again at 2026-08-09T04:00:00Z.'), '2026-08-09T04:00:00Z');
  assert.strictEqual(parseQuotaReset('Your limit resets in 3 hours.'), '3 hours');
  assert.strictEqual(parseQuotaReset('retry-after: 600'), '600');
  assert.strictEqual(parseQuotaReset('you have hit your usage limit'), null);

  assert.deepStrictEqual(LANE_STATES, ['available', 'quota-limited', 'absent', 'failing']);
}

// Unscaffolded tree: a usage error, exit 1.
{
  const r = spawnSync(process.execPath, [PREFLIGHT, 'run', path.join(tmp, 'nowhere')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /scaffold the tree first/);
}

// Argv discipline + help.
{
  const bad = spawnSync(process.execPath, [PREFLIGHT, 'run', root, 'surplus'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  const help = spawnSync(process.execPath, [PREFLIGHT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /usage: preflight\.js run <treeRoot>/);
}

console.log('test-preflight: ok');
