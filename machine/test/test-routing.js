'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'routing.js');
const { DATED_CONFIG_RE, CURRENT_ROUTING_REVISION, buildRevision1Config, buildDefaultConfig, validateRoutingConfig } = require(SRC);

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

// A tree whose dated config is the shipped default with one mutation — for
// exercising read-path refusals that the shipped content never triggers.
// The digest is computed from the mutated bytes, so only shape validation
// stands between the mutation and the resolver.
function customTree(name, mutate) {
  const root = freshTree(name);
  const dir = path.join(root, 'routing');
  fs.mkdirSync(dir, { recursive: true });
  const config = buildDefaultConfig('2026-08-07');
  mutate(config);
  const filename = 'routing-2026-08-07-1.json';
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(config, null, 2) + '\n');
  const digest =
    'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, filename))).digest('hex');
  fs.writeFileSync(
    path.join(dir, 'active.json'),
    JSON.stringify({ schema_version: 1, active_config: filename, digest }) + '\n'
  );
  return root;
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
  // the highest shipped migration is r3->r4, so the current revision is 4
  // and init stamps exactly that — never a label above or below the
  // content. Each slice that ships a migration raises both literals.
  assert.strictEqual(CURRENT_ROUTING_REVISION, 4);
  assert.strictEqual(config.revision, 4);
  // Class-keyed ladders (design §6.1/§6.2), naming only seats this revision
  // carries: the gpt standard rung (reviewer-terra) arrives with r5 and is
  // inserted into these same rows there. gemini is named in the claude expert
  // and apex rows for roster completeness and skipped there at resolution as
  // unqualified; the gpt rows write that restriction as absence, per §6.2's
  // "never to gemini" for expert- and apex-class gpt-authored work.
  assert.deepStrictEqual(config.review_routing, {
    claude: {
      recon: ['reviewer-gemini'],
      mechanical: ['reviewer-gemini'],
      standard: ['reviewer-gemini'],
      expert: ['reviewer-sol-expert-rev', 'reviewer-gemini'],
      apex: ['reviewer-sol-apex-rev', 'reviewer-gemini'],
    },
    gpt: {
      recon: ['reviewer-claude', 'reviewer-gemini'],
      mechanical: ['reviewer-claude', 'reviewer-gemini'],
      standard: ['reviewer-claude', 'reviewer-gemini'],
      expert: ['reviewer-claude-expert'],
      apex: ['reviewer-claude-apex'],
    },
    gemini: {
      recon: ['reviewer-claude'],
      mechanical: ['reviewer-claude'],
      standard: ['reviewer-claude'],
      expert: ['reviewer-claude-expert', 'reviewer-sol-expert-rev'],
      apex: ['reviewer-claude-apex', 'reviewer-sol-apex-rev'],
    },
  });
  // The six tiered Claude seats are routable entries, and the qualification
  // bounds sit on the seats that carry each rung — reviewer-claude's r3 apex
  // bound existed only because it was the whole Claude floor, and the ladder
  // ends that monopoly (plan amendment, 2026-08-07).
  assert.deepStrictEqual(config.seats['executor-claude-mech'], { model: 'sonnet-5', family: 'claude', effort: 'low' });
  assert.deepStrictEqual(config.seats['executor-claude-standard'], { model: 'sonnet-5', family: 'claude', effort: 'high' });
  assert.deepStrictEqual(config.seats['executor-fable-low'], { model: 'fable-5', family: 'claude', effort: 'low' });
  assert.deepStrictEqual(config.seats['executor-fable'], { model: 'fable-5', family: 'claude', effort: 'high' });
  assert.deepStrictEqual(config.seats['reviewer-claude-expert'], { model: 'opus-5', family: 'claude', effort: 'high' });
  assert.deepStrictEqual(config.seats['reviewer-claude-apex'], { model: 'fable-5', family: 'claude', effort: 'low' });
  assert.deepStrictEqual(config.seats.planner, { model: 'fable-5', family: 'claude', effort: 'low' });
  assert.deepStrictEqual(config.review_qualification, {
    'reviewer-claude': 'standard',
    'reviewer-claude-expert': 'expert',
    'reviewer-claude-apex': 'apex',
    'reviewer-sol-expert-rev': 'expert',
    'reviewer-sol-apex-rev': 'apex',
    'reviewer-gemini': 'standard',
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
  assert.deepStrictEqual(config.seats.convergence, { model: 'fable-5', fallback: 'opus-5', effort: 'low' });
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
  assert.deepStrictEqual(effective.review_routing.claude.expert, ['reviewer-sol-expert-rev', 'reviewer-gemini']);
  assert.deepStrictEqual(effective.review_routing.claude.standard, ['reviewer-gemini']);
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
  // The default class is standard, whose claude ladder is gemini's alone
  // until r5 seats the gpt standard rung; expert climbs to the Sol expert rung.
  assert.strictEqual(run(['review-for', root, 'claude']).stdout.trim(), 'reviewer-gemini');
  assert.strictEqual(run(['review-for', root, 'claude', 'expert']).stdout.trim(), 'reviewer-sol-expert-rev');
  assert.strictEqual(run(['review-for', root, 'claude', 'apex']).stdout.trim(), 'reviewer-sol-apex-rev');
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
  // Every claude class keeps only the gemini lane; the expert and apex rows
  // still name it, and it is the qualification bound below — never the row —
  // that keeps those classes off it.
  assert.deepStrictEqual(active.review_routing.claude, {
    recon: ['reviewer-gemini'],
    mechanical: ['reviewer-gemini'],
    standard: ['reviewer-gemini'],
    expert: ['reviewer-gemini'],
    apex: ['reviewer-gemini'],
  });
  assert.deepStrictEqual(active.review_routing.gemini.standard, ['reviewer-claude']);
  assert.deepStrictEqual(active.review_routing.gemini.expert, ['reviewer-claude-expert']);

  const claude = run(['review-for', root, 'claude']);
  assert.strictEqual(claude.status, 0, claude.stderr);
  assert.strictEqual(claude.stdout.trim(), 'reviewer-gemini', 'standard claude work keeps the reviewer its own ladder names');
  assert.strictEqual(claude.stderr, '', 'a class whose ladder never named the dead lane is not rerouted by its loss');

  // Expert claude work is: its ladder led with the Sol expert rung, and with
  // that lane down the only remaining candidate is unqualified for the class.
  const expert = run(['review-for', root, 'claude', 'expert']);
  assert.strictEqual(expert.stdout.trim(), 'reviewer-degraded-sonnet');
  assert.match(expert.stderr, /decorrelation/, 'rerouted choice carries the notice on stderr');

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
  // The claude standard rung empties out with gemini gone — the gpt standard
  // rung arrives with r5 — so standard claude work takes the degraded path
  // while expert and apex still climb the live Sol rungs.
  assert.deepStrictEqual(active.review_routing.claude.standard, []);
  assert.strictEqual(run(['review-for', root, 'claude']).stdout.trim(), 'reviewer-degraded-opus');
  assert.strictEqual(run(['review-for', root, 'claude', 'expert']).stdout.trim(), 'reviewer-sol-expert-rev');
  assert.strictEqual(run(['review-for', root, 'claude', 'apex']).stdout.trim(), 'reviewer-sol-apex-rev');
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
  assert.deepStrictEqual(
    active.review_routing.claude,
    { recon: [], mechanical: [], standard: [], expert: [], apex: [] },
    'no cross-family reviewer remains for claude work at any class'
  );
  assert.deepStrictEqual(active.review_routing.gpt.standard, ['reviewer-claude']);
  assert.deepStrictEqual(active.review_routing.gpt.apex, ['reviewer-claude-apex'], 'the always-on claude floor keeps its apex rung');

  // With every cross-family lane out, claude-authored work no longer waits:
  // it falls to the explicit degraded path (class defaults to standard →
  // sonnet-authored pairing), labeled by the decorrelation notice — never
  // relabeled cross-family.
  const claude = run(['review-for', root, 'claude']);
  assert.strictEqual(claude.status, 0, claude.stderr);
  assert.strictEqual(claude.stdout.trim(), 'reviewer-degraded-opus');
  assert.match(claude.stderr, /NOT cross-family review/, 'the degraded transition carries the decorrelation notice');

  const apex = run(['review-for', root, 'claude', 'apex', '--json']);
  assert.strictEqual(apex.status, 0, apex.stderr);
  const apexBundle = JSON.parse(apex.stdout);
  assert.strictEqual(apexBundle.seat, 'reviewer-degraded-opus-apex', 'apex tier-scales to the heavy-model pairing, no ceiling');
  assert.strictEqual(apexBundle.independence, 'degraded-path');

  assert.strictEqual(run(['review-for', root, 'gpt']).stdout.trim(), 'reviewer-claude');

  // Chain-resolution: plan-counterpart maps to reviewer-gemini under
  // codex_down, and reviewer-gemini maps to reviewer-claude under
  // gemini_down — the composed substitution must land on the live seat,
  // never the dead intermediate.
  assert.strictEqual(active.seat_substitutions['plan-counterpart'], 'reviewer-claude');
}

// --- operator-down lanes compose like probe-down ones (settings channel) -----
{
  const { root } = initTree('operator-down');
  // Preflight healthy: the degradation must come from settings alone.
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  // provider_lanes is a settings SCHEMA knob (3a), read through settings'
  // clamped boundary. The live tree already carries this key — publishing
  // the lane as "auto" against it was finding N1.
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ provider_lanes: { gpt: 'operator-down' } }) + '\n'
  );

  const active = JSON.parse(run(['active', root]).stdout);
  assert.strictEqual(active.provider_lanes.gpt, 'operator-down', 'a lane the operator declared down is never published as auto');
  assert.deepStrictEqual(active.degraded_modes, ['codex_down'], 'operator-down activates the same degraded table a probe failure does');
  assert.strictEqual(active.notices.length, 1);
  assert.match(active.notices[0], /operator-down/, 'the notice names the operator toggle, not a probe failure');
  assert.ok(!('degraded_review_posture' in active), 'the settings-snapshot posture is internal, not printed');

  const claude = run(['review-for', root, 'claude']);
  assert.strictEqual(claude.stdout.trim(), 'reviewer-gemini', 'claude work reroutes off the operator-down gpt lane');

  // Both lanes operator-down: the composed state is the degraded transition.
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ provider_lanes: { gpt: 'operator-down', gemini: 'operator-down' } }) + '\n'
  );
  const degraded = run(['review-for', root, 'claude']);
  assert.strictEqual(degraded.status, 0, degraded.stderr);
  assert.strictEqual(degraded.stdout.trim(), 'reviewer-degraded-opus');
  assert.match(degraded.stderr, /NOT cross-family review/);
}

// --- the lane state survives sanctioned settings writes (round-two R1) -------
{
  // R1's failure was that settings.write rebuilt the file from SCHEMA keys
  // alone and stripped provider_lanes, so the recovered lane state silently
  // reverted on any unrelated write. With the 3a knobs in SCHEMA the key is
  // durable: an unrelated write must leave the operator-down lane on disk
  // and operating.
  const settingsMod = require(path.join(__dirname, '..', 'src', 'settings.js'));
  const { root } = initTree('lane-durability');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  settingsMod.write(root, { provider_lanes: { gpt: 'operator-down' } });
  settingsMod.write(root, { fleet_ceiling: 5 }); // the unrelated knob from R1's own reproduction

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  assert.strictEqual(onDisk.provider_lanes.gpt, 'operator-down', 'a sanctioned write of an unrelated knob must not strip the lane state off disk');

  const active = JSON.parse(run(['active', root]).stdout);
  assert.strictEqual(active.provider_lanes.gpt, 'operator-down', 'the lane state survives the write and keeps operating');
  assert.deepStrictEqual(active.degraded_modes, ['codex_down']);
}

// --- the hold posture operates through the same settings channel -------------
{
  const { root } = initTree('hold-posture');
  setPreflight(root, {}); // both providers route as absent
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ degraded_review: 'hold' }) + '\n');
  const held = run(['review-for', root, 'claude']);
  assert.strictEqual(held.status, 1, 'an operator-selected hold must refuse, not resolve');
  assert.match(held.stderr, /operator-selected hold posture refuses the degraded path/);

  // Only the exact token holds; the explicit non-default resolves normally.
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ degraded_review: 'degraded-path' }) + '\n');
  assert.strictEqual(run(['review-for', root, 'claude']).stdout.trim(), 'reviewer-degraded-opus');
}

// --- the no-laundering invariant refuses a family-less reviewer seat ---------
{
  // Validation half: a routed reviewer seat that declares no family is
  // refused at the read boundary, not compared open through undefined.
  const config = buildDefaultConfig('2026-08-07');
  config.seats['reviewer-mystery'] = { model: 'opus-5', effort: 'high' }; // a Claude model, no declared family
  config.review_routing.claude.standard.push('reviewer-mystery');
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, false, 'a family-less seat in a cross-family row must fail validation');
  assert.ok(errors.some((e) => /declares no family/.test(e)), errors.join('; '));
}
{
  // Resolution half: a degraded substitution can land on a seat no review
  // row names, so row validation never saw it — the guard itself must
  // refuse rather than resolve the seat as cross-family.
  const root = customTree('launder-familyless', (config) => {
    config.seats['reviewer-mystery'] = { model: 'opus-5', effort: 'high' };
    config.degraded.codex_down.seats['reviewer-gemini'] = 'reviewer-mystery';
  });
  setPreflight(root, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  const r = run(['review-for', root, 'claude']);
  assert.strictEqual(r.status, 1, 'a family-less resolved reviewer must refuse, never resolve');
  assert.match(r.stderr, /declares no family/);
}

// --- a degraded seat in a cross-family row is refused by name ----------------
{
  // The rows-membership check alone is self-referential: omit the seat
  // from this config's own degraded_review.rows and it would pass. The
  // reserved reviewer-degraded-* namespace closes that door.
  const config = buildDefaultConfig('2026-08-07');
  for (const row of Object.values(config.degraded_review.rows)) {
    for (const key of Object.keys(row)) {
      if (row[key] === 'reviewer-degraded-opus') row[key] = 'reviewer-degraded-sonnet';
    }
  }
  config.review_routing.gpt.standard.push('reviewer-degraded-opus'); // claude-family seat in a gpt row: the family check alone passes it
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, false, 'a degraded-named seat in a cross-family row must fail validation even when rows omit it');
  assert.ok(errors.some((e) => /"reviewer-degraded-opus", which never appears in a cross-family row/.test(e)), errors.join('; '));
}

// --- the verbatim notices are pinned by validation ---------------------------
{
  const config = buildDefaultConfig('2026-08-07');
  config.degraded_review.notice = 'whatever';
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, false, 'a diverged degraded-review notice must fail validation — the design text is verbatim authoritative');
  assert.ok(errors.some((e) => /verbatim degraded-path notice text/.test(e)), errors.join('; '));
  assert.strictEqual(validateRoutingConfig(buildDefaultConfig('2026-08-07')).ok, true, 'the shipped text itself validates');
}

// --- an incomplete review_routing table is a named refusal, not a TypeError --
{
  const missingFamily = buildDefaultConfig('2026-08-07');
  delete missingFamily.review_routing.gemini;
  const r1 = validateRoutingConfig(missingFamily);
  assert.strictEqual(r1.ok, false, 'a review_routing table missing a family must fail validation');
  assert.ok(r1.errors.some((e) => /review_routing\.gemini must be an object mapping each task class/.test(e)), r1.errors.join('; '));

  // A family present but missing one of its class rows is the same defect one
  // level down: the class vocabulary is closed, and a ladder that omits a
  // class would resolve that class off the end of the table.
  const missingClass = buildDefaultConfig('2026-08-07');
  delete missingClass.review_routing.claude.apex;
  const r2 = validateRoutingConfig(missingClass);
  assert.strictEqual(r2.ok, false, 'a class-keyed row missing a class must fail validation');
  assert.ok(r2.errors.some((e) => /review_routing\.claude\.apex must be an array/.test(e)), r2.errors.join('; '));

  // An unknown class key is refused rather than carried as dead data.
  const strayClass = buildDefaultConfig('2026-08-07');
  strayClass.review_routing.claude.heroic = ['reviewer-gemini'];
  const r3 = validateRoutingConfig(strayClass);
  assert.strictEqual(r3.ok, false, 'a row keyed by a class outside the closed vocabulary must fail validation');
  assert.ok(r3.errors.some((e) => /review_routing\.claude\.heroic is not a known task class/.test(e)), r3.errors.join('; '));

  // Half-migrated tables are refused as a pair, not composed against each
  // other: composition intersects a base row with its degraded override, so
  // the two must be the same shape.
  const mixed = buildDefaultConfig('2026-08-07');
  mixed.degraded.codex_down.review_routing.claude = ['reviewer-gemini'];
  const r4 = validateRoutingConfig(mixed);
  assert.strictEqual(r4.ok, false, 'a degraded override still carrying a flat row must fail validation');
  assert.ok(
    r4.errors.some((e) => /degraded\.codex_down\.review_routing\.claude must be an object mapping each task class/.test(e)),
    r4.errors.join('; ')
  );
}

// --- the degraded path is scoped to claude-authored work ---------------------
{
  // A gpt author whose effective row empties must refuse, never receive a
  // Claude reviewer under a notice asserting a shared family it does not
  // share — a false record is worse than a refusal.
  const root = customTree('non-claude-degraded', (config) => {
    for (const klass of Object.keys(config.degraded.codex_down.review_routing.gpt)) {
      config.degraded.codex_down.review_routing.gpt[klass] = [];
    }
  });
  setPreflight(root, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  const r = run(['review-for', root, 'gpt']);
  assert.strictEqual(r.status, 1, 'a non-claude author must never fall into the claude-scoped degraded path');
  assert.match(r.stderr, /scoped to claude-authored work/);
}

// --- degraded pairing by author model, and bundle shape symmetry -------------
{
  const { root } = initTree('author-model');
  setPreflight(root, {}); // both providers route as absent
  const opus = run(['review-for', root, 'claude', 'apex', 'opus-5', '--json']);
  assert.strictEqual(opus.status, 0, opus.stderr);
  const opusBundle = JSON.parse(opus.stdout);
  assert.strictEqual(opusBundle.seat, 'reviewer-degraded-fable-apex', 'the opus-authored apex pairing is resolvable from the CLI, not only the row-order default');
  assert.strictEqual(opusBundle.author_model, 'opus-5');
  assert.strictEqual(opusBundle.fallback.model, 'opus-5');

  // Same substitution fields as the cross-family path: consumers never
  // branch on independence to learn which fields exist.
  assert.strictEqual(opusBundle.requested_seat, opusBundle.seat);
  assert.strictEqual(opusBundle.substituted, false);

  const unpaired = run(['review-for', root, 'claude', 'apex', 'haiku', '--json']);
  assert.strictEqual(unpaired.status, 1, 'an unpaired author model is refused, never silently defaulted');
  assert.match(unpaired.stderr, /no pairing for author model "haiku"/);
}

// --- the qualification bound refuses scale-down, never relabels it -----------
{
  // The mission's own live lane state: gpt operator-down, gemini up. This
  // is the configuration whose round-one behaviour — expert and apex
  // claude work resolving reviewer-gemini labeled cross-family — violated
  // the review-floor ban and disproved the N3/N4 deferral's bound.
  const { root } = initTree('qualification-bound');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ provider_lanes: { gpt: 'operator-down' } }) + '\n'
  );

  const standard = JSON.parse(run(['review-for', root, 'claude', 'standard', 'sonnet-5', '--json']).stdout);
  assert.strictEqual(standard.seat, 'reviewer-gemini', 'gemini keeps its remaining standard-and-below reviewer scope');
  assert.strictEqual(standard.independence, 'cross-family');
  // The pairing key is a degraded-path concept: on the cross-family path
  // the accepted author-model argument has no bearing, and the bundle says
  // so explicitly rather than omitting the field.
  assert.strictEqual(standard.author_model, null);

  const expert = JSON.parse(run(['review-for', root, 'claude', 'expert', '--json']).stdout);
  assert.strictEqual(expert.seat, 'reviewer-degraded-sonnet', 'expert claude work skips the unqualified gemini reviewer and falls to the degraded path');
  assert.strictEqual(expert.independence, 'degraded-path');

  const apex = JSON.parse(run(['review-for', root, 'claude', 'apex', '--json']).stdout);
  assert.strictEqual(apex.seat, 'reviewer-degraded-opus-apex', 'apex falls to the heavy-model degraded pairing, never a scaled-down cross-family claim');
  assert.strictEqual(apex.independence, 'degraded-path');

  // gpt- and gemini-authored work stays on the always-on claude floor at
  // every class — and from r4 on it lands on the rung its class names, never
  // on a profile below it. reviewer-claude's r3 apex bound existed only
  // because it was the whole floor; the ladder retires it.
  assert.strictEqual(run(['review-for', root, 'gpt', 'apex']).stdout.trim(), 'reviewer-claude-apex');
  assert.strictEqual(run(['review-for', root, 'gemini', 'expert']).stdout.trim(), 'reviewer-claude-expert');
}

// --- no cross-family resolution reviews above its own qualification ---------
//
// The two spot fixtures above prove the mission's live lane state; this is the
// same law as a sweep, which is what the plan amendment reversing the N3/N4
// deferral asks step 4b to assert. Every author family, every class, every
// lane state: a resolution labeled cross-family must name a reviewer whose
// qualification bound covers the class, and non-claude-authored expert and
// apex work — which has no degraded path to fall to, the claude lane being its
// always-on floor — must land on the rung its class names, never below it.
{
  const { reviewFor } = require(SRC);
  const CLASSES = ['recon', 'mechanical', 'standard', 'expert', 'apex'];
  const RUNG_OF_CLASS = { recon: 'standard', mechanical: 'standard', standard: 'standard', expert: 'expert', apex: 'apex' };
  const qualification = buildDefaultConfig('2026-08-07').review_qualification;
  const covers = (bound, klass) => CLASSES.indexOf(bound) >= CLASSES.indexOf(klass);

  const laneStates = [
    ['both lanes up', { codex: { routing: 'present' }, gemini: { routing: 'present' } }],
    ['gemini only', { codex: { routing: 'absent' }, gemini: { routing: 'present' } }],
    ['gpt only', { codex: { routing: 'present' }, gemini: { routing: 'absent' } }],
    ['neither lane', {}],
  ];
  laneStates.forEach(([label, preflight], index) => {
    const { root } = initTree(`qualification-sweep-${index}`);
    setPreflight(root, preflight);
    for (const family of ['claude', 'gpt', 'gemini']) {
      for (const klass of CLASSES) {
        const bundle = reviewFor(root, family, klass);
        if (bundle.independence !== 'cross-family') continue;
        const bound = qualification[bundle.seat];
        assert.ok(
          covers(bound, klass),
          `${label}: ${family}-authored ${klass} work resolved "${bundle.seat}", qualified only to ${JSON.stringify(bound)} — a cross-family label over a scaled-down review floor`
        );
        if (family !== 'claude' && (klass === 'expert' || klass === 'apex')) {
          assert.strictEqual(
            bound,
            RUNG_OF_CLASS[klass],
            `${label}: ${family}-authored ${klass} work must reach the ${RUNG_OF_CLASS[klass]} review rung, not "${bundle.seat}"`
          );
        }
      }
    }
  });
}

// --- apex never scales down onto the expert review rung ----------------------
{
  // gpt lane up, gemini down. Before the class-keyed ladders both classes read
  // one flat row led by the expert rung, so apex had to refuse it and degrade
  // rather than resolve below its floor; now each class reads its own rung and
  // apex resolves the apex reviewer cross-family. Either way the expert rung
  // never reviews apex work — that is the ban, and only the road to honouring
  // it changed.
  const { root } = initTree('apex-floor');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'absent' } });
  assert.strictEqual(run(['review-for', root, 'claude', 'expert']).stdout.trim(), 'reviewer-sol-expert-rev');
  const apex = JSON.parse(run(['review-for', root, 'claude', 'apex', '--json']).stdout);
  assert.strictEqual(apex.seat, 'reviewer-sol-apex-rev');
  assert.strictEqual(apex.independence, 'cross-family');
}

// --- the qualification table is validated, and inseparable from degraded_review ----
{
  const uncovered = buildDefaultConfig('2026-08-07');
  delete uncovered.review_qualification['reviewer-gemini'];
  const r1 = validateRoutingConfig(uncovered);
  assert.strictEqual(r1.ok, false, 'a routed reviewer seat without a qualification bound must fail validation');
  assert.ok(r1.errors.some((e) => /"reviewer-gemini" with no review_qualification entry/.test(e)), r1.errors.join('; '));

  const badBound = buildDefaultConfig('2026-08-07');
  badBound.review_qualification['reviewer-gemini'] = 'ultra';
  const r2 = validateRoutingConfig(badBound);
  assert.strictEqual(r2.ok, false, 'a bound outside the closed class vocabulary must fail validation');
  assert.ok(r2.errors.some((e) => /review_qualification\.reviewer-gemini must be one of/.test(e)), r2.errors.join('; '));

  const stripped = buildDefaultConfig('2026-08-07');
  delete stripped.review_qualification;
  const r3 = validateRoutingConfig(stripped);
  assert.strictEqual(r3.ok, false, 'the two r3 blocks are one contract — neither fence can be stripped alone');
  assert.ok(r3.errors.some((e) => /arrive together in the r2->r3 migration/.test(e)), r3.errors.join('; '));
}

// --- revise: a failed dated-config write consumes no immutable name ----------
//
// The failure is imposed from outside the process (RLIMIT_FSIZE of 0, with
// SIGXFSZ ignored so the write returns EFBIG instead of killing node), so
// this exercises whatever write path the code uses rather than asserting a
// shape. §11: a partially written migration leaves the not-yet-repointed
// active config authoritative AND reports the orphan file — a corrupt file
// stranded at an immutable dated name, absent from the report, breaks both
// the immutable-set invariant and the rollback procedure that walks it.
{
  function shq(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }
  function underWriteFailure(argv) {
    const cmd = `ulimit -f 0; trap '' XFSZ; exec ${[process.execPath, ...argv].map(shq).join(' ')}`;
    return spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  }

  const probeRoot = freshTree('write-failure-probe');
  const probe = underWriteFailure(['-e', 'require("fs").writeFileSync(process.argv[1], "x")', path.join(probeRoot, 'p.txt')]);
  const imposable = probe.status !== 0 && /EFBIG/.test(probe.stderr);

  if (!imposable) {
    console.log('test-routing: SKIP failed-write orphan case (RLIMIT_FSIZE not imposable here)');
  } else {
    // A revision-1 tree, built the way init builds one but at the historical
    // revision, so `revise` has exactly one migration to run and write.
    const root = freshTree('revise-write-failure');
    const dir = path.join(root, 'routing');
    fs.mkdirSync(dir, { recursive: true });
    const sourceFile = 'routing-2026-07-31-1.json';
    const sourcePath = path.join(dir, sourceFile);
    fs.writeFileSync(sourcePath, JSON.stringify(buildRevision1Config('2026-07-31'), null, 2) + '\n');
    const digest =
      'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    fs.writeFileSync(
      path.join(dir, 'active.json'),
      JSON.stringify({ schema_version: 1, active_config: sourceFile, digest }, null, 2) + '\n'
    );

    const r = underWriteFailure([SRC, 'revise', root]);
    assert.strictEqual(r.status, 1, `revise must fail under an imposed write failure: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /revise failed at revision 1/);
    assert.match(r.stderr, /stays authoritative/);

    const after = fs.readdirSync(dir).sort();
    const dated = after.filter((f) => DATED_CONFIG_RE.test(f));
    assert.deepStrictEqual(
      dated,
      [sourceFile],
      `a failed write must consume no dated immutable name; directory held ${after.join(', ')}`
    );
    for (const f of after) {
      if (f === 'active.json' || f === sourceFile) continue;
      assert.ok(r.stderr.includes(f), `leftover ${f} must be named in the orphan report: ${r.stderr}`);
    }

    // The pointer never moved and the tree still loads: the pre-migration
    // config stays authoritative, which is the other half of the invariant.
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'active.json'), 'utf8'));
    assert.strictEqual(pointer.active_config, sourceFile);
    const active = run(['active', root]);
    assert.strictEqual(active.status, 0, active.stderr);
    assert.strictEqual(JSON.parse(active.stdout).revision, 1);

    // With the limit lifted the same tree migrates cleanly — the failed
    // attempt left no wreckage in the way of the name it would have used.
    const retry = run(['revise', root]);
    assert.strictEqual(retry.status, 0, retry.stderr);
    const result = JSON.parse(retry.stdout);
    assert.strictEqual(result.from, 1);
    assert.strictEqual(result.to, CURRENT_ROUTING_REVISION);
    assert.match(result.active_config, DATED_CONFIG_RE);
  }
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
