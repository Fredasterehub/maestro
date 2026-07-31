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
    'exit 2\n',
  { mode: 0o755 }
);
fs.writeFileSync(
  path.join(fakeBin, 'gemini'),
  '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; exit ${FAKE_GEMINI_VERSION_EXIT:-0}; fi\nexit 2\n',
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

// Case A: codex/gemini/antigravity/git/gh all off PATH — measured absence
// everywhere.
{
  const { block } = runPreflight({ path: nodeDir, vars: {} });
  assertPair(block.node, 'present', 'present', 'A node');
  assertPair(block.providers.codex, 'absent', 'absent', 'A codex');
  assert.strictEqual(block.providers.codex.checks.auth, null, 'A: auth never ran, so it is null (NOT COMPUTED)');
  assertPair(block.providers.gemini, 'absent', 'absent', 'A gemini');
  assertPair(block.providers.antigravity, 'absent', 'absent', 'A antigravity');
  assertPair(block.git, 'absent', 'absent', 'A git');
  assertPair(block.gh, 'absent', 'absent', 'A gh');
  assert.match(block.checked_ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
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
  assert.match(cli.stdout, /codex\s+present/);
  assert.match(cli.stdout, /gemini\s+present.*prefers antigravity/, 'B: preference recorded on the gemini line');
  assert.match(cli.stdout, /antigravity\s+present/);
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
  assert.deepStrictEqual(last.codex, { routing: 'absent', observed: 'absent' });
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
  assert.strictEqual(effective.seat_substitutions['executor-sol'], 'executor-claude');
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
