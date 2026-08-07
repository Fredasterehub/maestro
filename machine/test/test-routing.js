'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'routing.js');
const { DATED_CONFIG_RE, CURRENT_ROUTING_REVISION } = require(SRC);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-routing-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function run(args) {
  return spawnSync(process.execPath, [SRC, ...args], { encoding: 'utf8' });
}

function initTree(name) {
  const root = freshTree(name);
  const r = run(['init', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  return { root, init: JSON.parse(r.stdout) };
}

function setPreflight(root, perProvider) {
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({ schema_version: 1, preflight: { per_provider: perProvider } }) + '\n'
  );
}

// --- init --------------------------------------------------------------------
{
  const { root, init } = initTree('init');
  assert.match(init.active_config, DATED_CONFIG_RE);
  assert.match(init.digest, /^sha256:[0-9a-f]{64}$/);

  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'routing', 'active.json'), 'utf8'));
  assert.strictEqual(pointer.active_config, init.active_config);
  assert.strictEqual(pointer.digest, init.digest);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'routing', init.active_config), 'utf8'));
  // Literals, not the module's own constant, so this can actually fail:
  // the highest shipped migration is r1->r2, so the current revision is 2
  // and init stamps exactly that — never a label above or below the
  // content. Each slice that ships a migration raises both literals.
  assert.strictEqual(CURRENT_ROUTING_REVISION, 2);
  assert.strictEqual(config.revision, 2);
  assert.deepStrictEqual(config.review_routing, {
    claude: ['reviewer-sol-expert-rev', 'reviewer-gemini'],
    gpt: ['reviewer-claude', 'reviewer-gemini'],
    gemini: ['reviewer-claude', 'reviewer-sol-expert-rev'],
  });
  assert.deepStrictEqual(config.bans, {
    haiku: 'never',
    liaison_implements: 'never',
    review_floor_scale_down: 'never',
    runtime_agent_creation: 'never',
  });
  assert.strictEqual(config.degraded.codex_down.seats['executor-sol-expert'], 'executor-claude');
  assert.strictEqual(config.degraded.gemini_down.seats['executor-gemini'], 'executor-claude');

  // Convergence protocol seats: convergence (Fable, both moments) and its
  // Sol counterpart, plan-counterpart.
  assert.deepStrictEqual(config.seats.convergence, { model: 'fable-5', fallback: 'opus-5', effort: 'high' });
  assert.deepStrictEqual(config.seats['plan-counterpart'], { family: 'gpt', hosted: true, effort: 'high' });
  assert.ok(!('agreement-pass' in config.seats), 'agreement-pass is renamed away, not carried forward');

  // codex_down degrades plan-counterpart to the Gemini review seat first —
  // the challenge stays cross-family, which is the counterpart's whole point.
  // Claude is reached only by chain-resolution when gemini is down too.
  assert.strictEqual(config.degraded.codex_down.seats['plan-counterpart'], 'reviewer-gemini');
  assert.match(config.degraded.codex_down.notice, /decorrelation/);

  // fable-unavailable is data-only: convergence falls back to its own
  // `fallback` field rather than being substituted to a different seat, so
  // it carries no seat substitutions.
  assert.deepStrictEqual(config.degraded['fable-unavailable'].seats, {});
  assert.match(config.degraded['fable-unavailable'].notice, /fallback/);

  // Re-init refused: dated configs are immutable and the pointer exists.
  const again = run(['init', root]);
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /already initialized/);

  const noTree = run(['init', path.join(tmp, 'missing-tree')]);
  assert.strictEqual(noTree.status, 1);
  assert.match(noTree.stderr, /tree root does not exist/);
}

// --- active: healthy, no preflight recorded ----------------------------------
{
  const { root } = initTree('active-clean');
  const r = run(['active', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const effective = JSON.parse(r.stdout);
  assert.strictEqual(effective.preflight_recorded, false);
  assert.deepStrictEqual(effective.degraded_modes, []);
  assert.deepStrictEqual(effective.seat_substitutions, {});
  assert.deepStrictEqual(effective.notices, []);
  assert.deepStrictEqual(effective.review_routing.claude, ['reviewer-sol-expert-rev', 'reviewer-gemini']);
  assert.ok(effective.seats['executor-sol'], 'seat table rides along');
  assert.strictEqual(effective.bans.review_floor_scale_down, 'never');
  assert.ok(!('base_review_routing' in effective), 'internal comparison surface is not printed');
}

// --- active: digest mismatch refusal -----------------------------------------
{
  const { root, init } = initTree('tampered');
  const configPath = path.join(root, 'routing', init.active_config);
  const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  doc.bans.haiku = 'sometimes';
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2) + '\n');

  const r = run(['active', root]);
  assert.strictEqual(r.status, 1, 'tampered dated config must be refused');
  assert.match(r.stderr, /digest mismatch/);

  const rf = run(['review-for', root, 'claude']);
  assert.strictEqual(rf.status, 1, 'review-for refuses on the same tampered config');
  assert.match(rf.stderr, /digest mismatch/);
}

// --- active: symlinked target refusal ----------------------------------------
{
  const { root, init } = initTree('symlink');
  const configPath = path.join(root, 'routing', init.active_config);
  const stash = path.join(root, 'stash.json');
  fs.renameSync(configPath, stash);
  fs.symlinkSync(stash, configPath);

  const r = run(['active', root]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is a symlink/);
}

// --- active: malformed basename refusal --------------------------------------
{
  const { root } = initTree('basename');
  const pointerPath = path.join(root, 'routing', 'active.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.active_config = '../routing-2026-01-01-1.json';
  fs.writeFileSync(pointerPath, JSON.stringify(pointer) + '\n');

  const r = run(['active', root]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not a valid routing-YYYY-MM-DD-N\.json basename/);
}

// --- active: missing pointer -------------------------------------------------
{
  const root = freshTree('no-pointer');
  const r = run(['active', root]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no active pointer/);
}

// --- review-for: healthy routing ---------------------------------------------
{
  const { root } = initTree('review-clean');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  assert.strictEqual(run(['review-for', root, 'claude']).stdout.trim(), 'reviewer-sol-expert-rev');
  assert.strictEqual(run(['review-for', root, 'gpt']).stdout.trim(), 'reviewer-claude');
  assert.strictEqual(run(['review-for', root, 'gemini']).stdout.trim(), 'reviewer-claude');

  const healthy = run(['review-for', root, 'claude']);
  assert.strictEqual(healthy.stderr, '', 'no decorrelation notice when nothing is degraded');

  const badFamily = run(['review-for', root, 'rooster']);
  assert.strictEqual(badFamily.status, 1);
  assert.match(badFamily.stderr, /author family must be one of claude, gpt, gemini/);
}

// --- degraded rerouting: codex down ------------------------------------------
{
  const { root } = initTree('codex-down');
  setPreflight(root, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });

  const active = JSON.parse(run(['active', root]).stdout);
  assert.strictEqual(active.preflight_recorded, true);
  assert.deepStrictEqual(active.degraded_modes, ['codex_down']);
  // The Sol split carries the codex_down substitutes onto the live
  // successors; the alias names key nothing, since nothing routes them.
  assert.deepStrictEqual(active.seat_substitutions, {
    'executor-sol-expert': 'executor-claude',
    'executor-sol-apex': 'executor-claude',
    'reviewer-sol-expert-rev': 'reviewer-claude',
    'reviewer-sol-apex-rev': 'reviewer-claude',
    'plan-counterpart': 'reviewer-gemini',
  });
  assert.strictEqual(active.notices.length, 1);
  assert.match(active.notices[0], /decorrelation/);
  assert.deepStrictEqual(active.review_routing.claude, ['reviewer-gemini']);
  assert.deepStrictEqual(active.review_routing.gemini, ['reviewer-claude']);

  const claude = run(['review-for', root, 'claude']);
  assert.strictEqual(claude.status, 0, claude.stderr);
  assert.strictEqual(claude.stdout.trim(), 'reviewer-gemini', 'claude work reroutes away from the dead gpt reviewer');
  assert.match(claude.stderr, /decorrelation/, 'rerouted choice carries the notice on stderr');

  const gpt = run(['review-for', root, 'gpt']);
  assert.strictEqual(gpt.stdout.trim(), 'reviewer-claude');
  assert.strictEqual(gpt.stderr, '', 'unaffected routing prints no notice');
}

// --- degraded rerouting: gemini down, and unknown routes as absent -----------
{
  const { root } = initTree('gemini-down');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'unknown', observation: 'unknown' } });

  const active = JSON.parse(run(['active', root]).stdout);
  assert.deepStrictEqual(active.degraded_modes, ['gemini_down'], 'unknown routing token routes as absent');
  assert.strictEqual(run(['review-for', root, 'claude']).stdout.trim(), 'reviewer-sol-expert-rev');
  assert.strictEqual(run(['review-for', root, 'gpt']).stdout.trim(), 'reviewer-claude');
  assert.strictEqual(run(['review-for', root, 'gemini']).stdout.trim(), 'reviewer-claude');
}

// --- degraded rerouting: both down — the review floor never scales down ------
{
  const { root } = initTree('both-down');
  setPreflight(root, {}); // recorded preflight naming neither provider: both route as absent

  const active = JSON.parse(run(['active', root]).stdout);
  assert.deepStrictEqual(active.degraded_modes, ['codex_down', 'gemini_down']);
  assert.ok(
    !active.degraded_modes.includes('fable-unavailable'),
    'fable-unavailable is not preflight-driven — it never enters automatic composition'
  );
  assert.deepStrictEqual(active.review_routing.claude, [], 'no cross-family reviewer remains for claude work');
  assert.deepStrictEqual(active.review_routing.gpt, ['reviewer-claude']);

  const claude = run(['review-for', root, 'claude']);
  assert.strictEqual(claude.status, 1, 'claude-authored review must refuse rather than scale the floor down');
  assert.match(claude.stderr, /review_floor_scale_down is banned/);

  assert.strictEqual(run(['review-for', root, 'gpt']).stdout.trim(), 'reviewer-claude');

  // Chain-resolution: plan-counterpart maps to reviewer-gemini under
  // codex_down, and reviewer-gemini maps to reviewer-claude under
  // gemini_down — the composed substitution must land on the live seat,
  // never the dead intermediate.
  assert.strictEqual(active.seat_substitutions['plan-counterpart'], 'reviewer-claude');
}

// --- CLI hygiene -------------------------------------------------------------
{
  const help = run(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /digest-verified pointer/);

  const unknownCmd = run(['route-everything', tmp]);
  assert.strictEqual(unknownCmd.status, 1);
  assert.match(unknownCmd.stderr, /unknown command/);

  const extra = run(['active', tmp, 'surplus']);
  assert.strictEqual(extra.status, 1);
  assert.match(extra.stderr, /unexpected extra argument/);
}

console.log('test-routing: OK');
