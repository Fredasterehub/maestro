'use strict';

// tier-for: one validated brief in, one whole dispatch topology out — or a
// refusal. The fixtures below are grouped by what they defend:
//
//   1. the ladder itself — a brief per class resolving to the seat design §12
//      names, at the profile the config pins, with the review half the same
//      resolver review-for uses would return;
//   2. the skip semantics slice 5 landed — lane-down and capability-absent
//      recorded per rung, never guessed and never silently dropped;
//   3. the escalation rules — an escalation rung is unreachable on a fresh
//      resolution and named as withheld, --escalated reaches it, and the
//      illegal case is refused by route.js rather than here;
//   4. the refusals — each proven by a fixture that fails only that check,
//      beside a control that differs in exactly the checked fact and emits.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'routing.js');
const { buildDefaultConfig, reviewFor, tierFor } = require(SRC);
const { validateAuthorRoute } = require(path.join(__dirname, '..', 'src', 'route.js'));
const settingsMod = require(path.join(__dirname, '..', 'src', 'settings.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tier-for-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const CLASSES = ['recon', 'mechanical', 'standard', 'expert', 'apex'];
const SHIPPED = buildDefaultConfig('2026-08-07');

function run(args) {
  return spawnSync(process.execPath, [SRC, ...args], { encoding: 'utf8' });
}

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function initTree(name) {
  const root = freshTree(name);
  const r = run(['init', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  return root;
}

// A tree whose dated config is the shipped default with one mutation, digest
// recomputed over the mutated bytes — for the refusals the shipped table never
// produces on its own.
function customTree(name, mutate) {
  const root = freshTree(name);
  const dir = path.join(root, 'routing');
  fs.mkdirSync(dir, { recursive: true });
  const config = buildDefaultConfig('2026-08-07');
  mutate(config);
  const filename = 'routing-2026-08-07-1.json';
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(config, null, 2) + '\n');
  const digest =
    'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, filename))).digest('hex');
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ schema_version: 1, active_config: filename, digest }) + '\n');
  return root;
}

function setPreflight(root, perProvider) {
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({ schema_version: 1, preflight: { per_provider: perProvider } }) + '\n'
  );
}

// A real eight-field brief, valid by validators.js's own rules — the fixtures
// vary `tier` and nothing else, so what a case proves is the class routing and
// never an accident of brief shape.
let briefCounter = 0;
function writeBrief(tier, over) {
  const file = path.join(tmp, `brief-${tier}-${briefCounter++}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      outcome: `the ${tier} slice exists and its acceptance passes`,
      scope: 'the files the brief names, and nothing beside them',
      anchors: ['/DEV/orchestratorskill/machine/src/routing.js'],
      acceptance: 'node machine/test/run-all.js',
      freshness: 'read the code in the worktree, never this description of it',
      tier,
      return_format: 'six-field envelope',
      stop_condition: 'return blocked rather than guessing the intent',
      ...over,
    }) + '\n'
  );
  return file;
}

// The review half tier-for should have produced, computed by calling the same
// resolver directly. Asserting against this rather than a literal seat name is
// what pins "resolves the review side through reviewFor" as behaviour: a
// reimplementation that agreed on today's table and diverged anywhere else
// would fail here the day it diverged.
function expectedReview(root, authorFamily, taskClass, authorModel) {
  const bundle = reviewFor(root, authorFamily, taskClass, authorModel);
  return {
    seat: bundle.seat,
    family: bundle.family,
    model: bundle.model,
    effort: bundle.effort,
    independence: bundle.independence,
  };
}

// Every profile field of an emitted topology, checked against the seat table
// the config actually carries — so a later revision that reprofiles a seat is
// covered the day it lands, and a resolver reading the wrong seat's profile is
// caught even when it picks the right seat name.
function assertProfileMatchesConfig(topology, root) {
  const seat = SHIPPED.seats[topology.seat];
  assert.ok(seat, `topology named seat "${topology.seat}", which the shipped config does not carry`);
  assert.strictEqual(topology.author_family, seat.family);
  assert.strictEqual(topology.worker_model, seat.model === undefined ? null : seat.model);
  assert.strictEqual(topology.worker_effort, seat.effort === undefined ? null : seat.effort);
  assert.strictEqual(topology.host_model, seat.host === undefined ? null : seat.host);
  assert.strictEqual(topology.host_effort, seat.host_effort === undefined ? null : seat.host_effort);
  assert.deepStrictEqual(
    topology.fallback_profile,
    typeof seat.fallback === 'string' && typeof seat.fallback_effort === 'string'
      ? { model: seat.fallback, effort: seat.fallback_effort }
      : null,
    `${topology.seat}: a fallback profile is a { model, effort } pair or it is nothing`
  );
  // A fresh resolution resolves the seat it requested: an unusable rung is a
  // skip, never a requested-then-substituted pair (route.js §7 correction 9).
  assert.strictEqual(topology.requested_seat, topology.seat);
  assert.strictEqual(topology.substituted, false);
  assert.deepStrictEqual(topology.review, expectedReview(root, seat.family, topology.class, seat.model));
}

// --- a brief per class resolves to the whole topology, both lanes up ---------
{
  const root = initTree('per-class-lanes-up');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });

  // Design §12's ladders, read top-down with nothing filtered: the first
  // ordinary rung of each class.
  const expected = {
    recon: 'scout',
    mechanical: 'executor-luna',
    standard: 'executor-terra',
    expert: 'executor-sol-expert',
    apex: 'executor-fable',
  };
  for (const klass of CLASSES) {
    const r = run(['tier-for', root, writeBrief(klass)]);
    assert.strictEqual(r.status, 0, `${klass}: ${r.stderr}`);
    const topology = JSON.parse(r.stdout);
    assert.strictEqual(topology.class, klass, 'the topology resolves the class the brief declared');
    assert.strictEqual(topology.seat, expected[klass], `${klass} must lead with the first rung of its own ladder`);
    assert.strictEqual(topology.status, 'estimated', 'every placement in this revision states its confidence');
    assert.deepStrictEqual(topology.candidates_skipped, [], `${klass}: with both lanes up the leading rung costs no skips`);
    assert.strictEqual(topology.routing_revision, SHIPPED.revision);
    assert.deepStrictEqual(topology.degraded_modes, []);
    assertProfileMatchesConfig(topology, root);
  }

  // The hosted/native split is a property of the seat, and the topology carries
  // it as the pair §5 requires — never one half of it.
  const hosted = JSON.parse(run(['tier-for', root, writeBrief('standard')]).stdout);
  assert.strictEqual(hosted.host_model, 'sonnet-5');
  assert.strictEqual(hosted.host_effort, 'medium');
  const native = JSON.parse(run(['tier-for', root, writeBrief('recon')]).stdout);
  assert.strictEqual(native.host_model, null);
  assert.strictEqual(native.host_effort, null);
}

// --- the mission's own lane state: gpt operator-down --------------------------
//
// The state every dispatch in this mission actually runs under. The gpt rungs
// are skipped as lane-down — recorded, not silently dropped — and each class
// falls to its Claude rung, which is what makes "dormant" a lane state rather
// than an unfinished ladder.
{
  const root = initTree('per-class-gpt-down');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  settingsMod.write(root, { provider_lanes: { gpt: 'operator-down' } });

  const expected = {
    recon: ['scout', []],
    mechanical: ['executor-claude-mech', [{ seat: 'executor-luna', reason: 'lane-down' }]],
    standard: ['executor-claude-standard', [{ seat: 'executor-terra', reason: 'lane-down' }]],
    expert: ['executor-claude', [{ seat: 'executor-sol-expert', reason: 'lane-down' }]],
    apex: ['executor-fable', []],
  };
  for (const klass of CLASSES) {
    const r = run(['tier-for', root, writeBrief(klass)]);
    assert.strictEqual(r.status, 0, `${klass}: ${r.stderr}`);
    const topology = JSON.parse(r.stdout);
    assert.strictEqual(topology.seat, expected[klass][0], `${klass} must fall to its claude rung with the gpt lane down`);
    assert.deepStrictEqual(
      topology.candidates_skipped,
      expected[klass][1],
      `${klass}: the rungs a downed lane cost this class are recorded with their reason`
    );
    assert.strictEqual(topology.author_family, 'claude', 'no gpt seat authors while the operator holds the lane down');
    assert.deepStrictEqual(topology.degraded_modes, ['codex_down']);
    assert.ok(
      topology.notices.some((n) => /operator-down/.test(n)),
      'the topology carries the notice naming the operator toggle rather than a probe failure'
    );
    assert.deepStrictEqual(topology.lane_state, { gpt: 'operator-down', gemini: 'auto' });
    assertProfileMatchesConfig(topology, root);
  }

  // Expert and apex have no qualified cross-family reviewer in this state
  // (gemini is bounded at standard), so both take the explicit degraded
  // transition — and the topology says so in the review half rather than
  // labeling a same-family reviewer cross-family.
  const expert = JSON.parse(run(['tier-for', root, writeBrief('expert')]).stdout);
  assert.strictEqual(expert.review.seat, 'reviewer-degraded-sonnet');
  assert.strictEqual(expert.review.independence, 'degraded-path');
  assert.ok(
    expert.notices.some((n) => /NOT\s+cross-family review/.test(n)),
    'the degraded-path notice reaches the topology, not only the review-for bundle'
  );
  const standard = JSON.parse(run(['tier-for', root, writeBrief('standard')]).stdout);
  assert.strictEqual(standard.review.independence, 'cross-family');
}

// --- capability-absent is a skip with its own reason, never a guess ----------
{
  // The gpt lane is up and its probe healthy, but the capability map does not
  // record Sol at the effort the expert rung pins — §11.1's exact model x
  // effort claim. The rung is skipped for that reason and the next one takes
  // the work; the lane is NOT reported down, because it isn't.
  const root = initTree('capability-absent');
  setPreflight(root, {
    codex: { routing: 'present', models: { 'gpt-5.6-sol': { status: 'present', efforts: ['high'] } } },
    gemini: { routing: 'present' },
  });
  const topology = JSON.parse(run(['tier-for', root, writeBrief('expert')]).stdout);
  assert.strictEqual(topology.seat, 'executor-claude');
  assert.deepStrictEqual(topology.candidates_skipped, [{ seat: 'executor-sol-expert', reason: 'capability-absent' }]);
  assert.deepStrictEqual(topology.degraded_modes, [], 'an unavailable model is not a downed lane');

  // Positive control on the same tree shape: recorded present at the pinned
  // effort, and the same rung is taken.
  const up = initTree('capability-present');
  setPreflight(up, {
    codex: { routing: 'present', models: { 'gpt-5.6-sol': { status: 'present', efforts: ['medium', 'high'] } } },
    gemini: { routing: 'present' },
  });
  const taken = JSON.parse(run(['tier-for', up, writeBrief('expert')]).stdout);
  assert.strictEqual(taken.seat, 'executor-sol-expert');
  assert.deepStrictEqual(taken.candidates_skipped, []);
}

// --- escalation entries: unreachable fresh, reachable escalated -------------
{
  const root = initTree('escalation');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });

  const fresh = JSON.parse(run(['tier-for', root, writeBrief('expert')]).stdout);
  assert.strictEqual(fresh.seat, 'executor-sol-expert');
  assert.strictEqual(fresh.escalated, false);
  assert.strictEqual(fresh.escalation_profile, false);
  // Withheld, not skipped: the rung was available and held back by law, and
  // route.js's closed availability vocabulary must never be used to say so.
  assert.deepStrictEqual(fresh.escalation_withheld, ['executor-fable-low']);
  assert.ok(
    !fresh.candidates_skipped.some((s) => s.seat === 'executor-fable-low'),
    'a rung withheld by law is not an availability skip'
  );

  const escalated = JSON.parse(run(['tier-for', root, writeBrief('expert'), '--escalated']).stdout);
  assert.strictEqual(escalated.seat, 'executor-fable-low', 'an escalated expert resolution reaches the escalation rung');
  assert.strictEqual(escalated.escalated, true);
  assert.strictEqual(escalated.escalation_profile, true);
  assert.deepStrictEqual(escalated.escalation_withheld, []);
  // §10's expert row is "escalate opus-high -> fable-low": an escalation that
  // resolved the rung the ordinary ladder already offers would change no
  // profile, and route.js refuses a within-class-profile-escalation that
  // changes none.
  assert.notStrictEqual(escalated.seat, fresh.seat);
  assert.deepStrictEqual(escalated.fallback_profile, { model: 'opus-5', effort: 'high' });
  assertProfileMatchesConfig(escalated, root);

  // A class with no escalation rung refuses an escalated resolution rather
  // than quietly handing back the ordinary one under an escalation label.
  for (const klass of ['recon', 'mechanical', 'standard', 'apex']) {
    const r = run(['tier-for', root, writeBrief(klass), '--escalated']);
    assert.strictEqual(r.status, 1, `${klass} carries no escalation rung and must refuse`);
    assert.match(r.stderr, /carries no escalation rung/);
  }
}

// --- no fresh resolution reaches an escalation rung, in any lane state -------
//
// The two fixtures above prove the expert row; this is the same law as a sweep
// over every class and every lane state, read out of the config so a rung a
// later revision marks escalation is covered the day it lands.
{
  const escalationSeats = new Set();
  for (const klass of Object.values(SHIPPED.tiers.classes)) {
    for (const candidate of klass.candidates) {
      if (candidate.escalation === true) escalationSeats.add(candidate.seat);
    }
  }
  assert.ok(escalationSeats.size > 0, 'this sweep is vacuous unless the shipped ladder marks at least one escalation rung');

  const laneStates = [
    ['both lanes up', { codex: { routing: 'present' }, gemini: { routing: 'present' } }],
    ['gemini only', { codex: { routing: 'absent' }, gemini: { routing: 'present' } }],
    ['gpt only', { codex: { routing: 'present' }, gemini: { routing: 'absent' } }],
    ['neither lane', {}],
  ];
  laneStates.forEach(([label, preflight], index) => {
    const root = initTree(`escalation-sweep-${index}`);
    setPreflight(root, preflight);
    for (const klass of CLASSES) {
      let topology;
      try {
        topology = tierFor(root, writeBrief(klass));
      } catch (err) {
        // A refusal is not a violation of this law: what may never happen is a
        // fresh resolution EMITTING an escalation rung.
        continue;
      }
      assert.ok(
        !escalationSeats.has(topology.seat),
        `${label}: a fresh ${klass} resolution reached escalation rung "${topology.seat}"`
      );
      assert.strictEqual(topology.escalation_profile, false, `${label}: ${klass} claimed an escalation profile on a fresh resolution`);
    }
  });
}

// --- the illegal escalated flag is refused by route.js, not here -------------
//
// tier-for resolves what was asked and records it truthfully; §9's state
// machine is route.js's, and a fresh route may not select an escalation-only
// profile. Proven where the law lives, against the topology this command
// actually emits — so the two modules are checked against each other rather
// than each against its own assumption.
{
  const root = initTree('escalated-reserve');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  const escalated = tierFor(root, writeBrief('expert'), true);

  const authorRoute = {
    mission_id: 'tier-for-fixture',
    attempt: 1,
    brief_digest: 'sha256:' + 'a'.repeat(64),
    task_class: escalated.class,
    routing_config: escalated.routing_config,
    routing_digest: escalated.routing_digest,
    routing_revision: escalated.routing_revision,
    requested_seat: escalated.requested_seat,
    resolved_seat: escalated.seat,
    author_family: escalated.author_family,
    worker_model: escalated.worker_model,
    worker_effort: escalated.worker_effort,
    host_model: escalated.host_model,
    host_effort: escalated.host_effort,
    fallback_profile: escalated.fallback_profile,
    escalation_profile: escalated.escalation_profile,
    selection: { candidates_skipped: escalated.candidates_skipped, substituted: false, substitution_reason: null },
    reserved_review: escalated.review,
    lane_state: escalated.lane_state,
    degraded_modes: escalated.degraded_modes,
    notices: [],
  };

  const fresh = validateAuthorRoute(authorRoute, false);
  assert.strictEqual(fresh.ok, false, 'a fresh route carrying an escalation profile must be refused by route.js');
  assert.ok(
    fresh.errors.some((e) => /may not select an escalation-only profile/.test(e)),
    fresh.errors.join('; ')
  );

  // The same topology behind a predecessor is lawful — so the refusal above is
  // route.js's escalation law, not tier-for emitting an unreservable record.
  const superseding = validateAuthorRoute({ ...authorRoute, attempt: 2 }, true);
  assert.deepStrictEqual(superseding.errors, []);
  assert.strictEqual(superseding.ok, true);
}

// --- refusal: an invalid brief resolves no topology --------------------------
{
  const root = initTree('brief-refusals');
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });

  const legacyTier = run(['tier-for', root, writeBrief('standard', { tier: 'medium' })]);
  assert.strictEqual(legacyTier.status, 1, 'a tier outside the closed enum is refused, never normalized');
  assert.match(legacyTier.stderr, /is not a valid eight-field brief/);
  assert.match(legacyTier.stderr, /must be one of recon, mechanical, standard, expert, apex/);

  const missingField = writeBrief('standard');
  const partial = JSON.parse(fs.readFileSync(missingField, 'utf8'));
  delete partial.acceptance;
  const partialPath = path.join(tmp, 'brief-missing-acceptance.json');
  fs.writeFileSync(partialPath, JSON.stringify(partial) + '\n');
  const seven = run(['tier-for', root, partialPath]);
  assert.strictEqual(seven.status, 1, 'a seven-field brief is refused');
  assert.match(seven.stderr, /acceptance/);

  const absent = run(['tier-for', root, path.join(tmp, 'no-such-brief.json')]);
  assert.strictEqual(absent.status, 1);
  assert.match(absent.stderr, /no brief at /);

  const malformed = path.join(tmp, 'brief-malformed.json');
  fs.writeFileSync(malformed, '{"outcome": \n');
  const broken = run(['tier-for', root, malformed]);
  assert.strictEqual(broken.status, 1);
  assert.match(broken.stderr, /failed to parse JSON/);

  // Control: the same brief with nothing wrong emits.
  const ok = run(['tier-for', root, writeBrief('standard')]);
  assert.strictEqual(ok.status, 0, ok.stderr);
}

// --- refusal: the operator-selected hold ------------------------------------
//
// Fails only this check: the tree, the lane state and the brief are identical
// in both halves, and the single difference is the settings posture.
{
  const build = (name) => {
    const root = initTree(name);
    setPreflight(root, {}); // both providers route as absent — no cross-family reviewer survives
    return root;
  };

  const held = build('hold-refusal');
  settingsMod.write(held, { degraded_review: 'hold' });
  const refused = run(['tier-for', held, writeBrief('expert')]);
  assert.strictEqual(refused.status, 1, 'an operator hold refuses the topology at the door');
  assert.match(refused.stderr, /refusing to emit a topology that could not lawfully close/);
  assert.match(refused.stderr, /degraded_review is "hold"/);

  const open = build('hold-control');
  settingsMod.write(open, { degraded_review: 'degraded-path' });
  const emitted = run(['tier-for', open, writeBrief('expert')]);
  assert.strictEqual(emitted.status, 0, emitted.stderr);
  assert.strictEqual(JSON.parse(emitted.stdout).review.independence, 'degraded-path');

  // The hold only bites where the degraded path is what would have been taken:
  // with a qualified cross-family reviewer available, the same posture emits.
  const crossFamily = initTree('hold-cross-family');
  setPreflight(crossFamily, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  settingsMod.write(crossFamily, { degraded_review: 'hold' });
  const unaffected = run(['tier-for', crossFamily, writeBrief('standard')]);
  assert.strictEqual(unaffected.status, 0, unaffected.stderr);
  assert.strictEqual(JSON.parse(unaffected.stdout).review.independence, 'cross-family');
}

// --- refusal: no review resolves at all -------------------------------------
//
// A gpt-authored class whose cross-family row is empty. The degraded path is
// claude-scoped by design (§8), so this author has nothing to fall to and the
// route could never close — which is the whole reason the check runs here,
// before a worker exists, rather than at close.
{
  const emptyRow = customTree('no-review', (config) => {
    config.review_routing.gpt.expert = [];
    config.degraded.codex_down.review_routing.gpt.expert = [];
    config.degraded.gemini_down.review_routing.gpt.expert = [];
  });
  setPreflight(emptyRow, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  const refused = run(['tier-for', emptyRow, writeBrief('expert')]);
  assert.strictEqual(refused.status, 1, 'an author whose review cannot resolve is refused before it is spawned');
  assert.match(refused.stderr, /refusing to emit a topology that could not lawfully close/);
  assert.match(refused.stderr, /gpt-authored expert work on seat "executor-sol-expert"/);
  assert.match(refused.stderr, /no cross-family reviewer is effectively available/);

  // Control: the identical tree with the row intact resolves the same author,
  // so the refusal above turns on the emptied row and nothing else.
  const intact = customTree('no-review-control', () => {});
  setPreflight(intact, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  const emitted = run(['tier-for', intact, writeBrief('expert')]);
  assert.strictEqual(emitted.status, 0, emitted.stderr);
  const topology = JSON.parse(emitted.stdout);
  assert.strictEqual(topology.seat, 'executor-sol-expert');
  assert.strictEqual(topology.review.seat, 'reviewer-claude-expert');
}

// --- the degraded pairing follows the model the ladder actually picked -------
//
// The apex degraded row pairs two author models, and the reviewer differs by
// which one authored: fable-authored apex is reviewed by opus, opus-authored
// apex by fable. Resolving the review half without saying which model the
// ladder picked would silently take the row's first pairing — right for the
// canonical apex authorship and wrong for the other one — so the apex ladder is
// cut to its opus rung here and the reviewer must follow the author.
{
  const root = customTree('degraded-pairing', (config) => {
    config.tiers.classes.apex.candidates = [{ seat: 'executor-claude', status: 'estimated' }];
  });
  setPreflight(root, {}); // no cross-family lane survives: the degraded row is what answers
  const topology = JSON.parse(run(['tier-for', root, writeBrief('apex')]).stdout);
  assert.strictEqual(topology.seat, 'executor-claude');
  assert.strictEqual(topology.worker_model, 'opus-5');
  assert.strictEqual(
    topology.review.seat,
    'reviewer-degraded-fable-apex',
    'the opus-authored apex pairing, not the row-order default the canonical fable authorship would take'
  );
  assert.strictEqual(topology.review.independence, 'degraded-path');
}

// --- refusal: no candidate in the class is available -------------------------
{
  // The mechanical ladder cut to its gpt rung alone, with that lane down: the
  // walk has nothing left to take, and a topology naming a seat that cannot run
  // is not a topology.
  const root = customTree('no-candidate', (config) => {
    config.tiers.classes.mechanical.candidates = [{ seat: 'executor-luna', status: 'estimated' }];
  });
  setPreflight(root, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  const refused = run(['tier-for', root, writeBrief('mechanical')]);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /no author seat is available for mechanical work/);
  assert.match(refused.stderr, /executor-luna \(lane-down\)/);

  // Control: same config, the lane up.
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  const emitted = run(['tier-for', root, writeBrief('mechanical')]);
  assert.strictEqual(emitted.status, 0, emitted.stderr);
  assert.strictEqual(JSON.parse(emitted.stdout).seat, 'executor-luna');
}

// --- CLI hygiene -------------------------------------------------------------
{
  const root = initTree('cli-hygiene');
  const noBrief = run(['tier-for', root]);
  assert.strictEqual(noBrief.status, 1);
  assert.match(noBrief.stderr, /missing required argument/);

  const extra = run(['tier-for', root, writeBrief('recon'), 'surplus']);
  assert.strictEqual(extra.status, 1);
  assert.match(extra.stderr, /unexpected extra argument/);

  const misplaced = run(['review-for', root, 'claude', '--escalated']);
  assert.strictEqual(misplaced.status, 1);
  assert.match(misplaced.stderr, /--escalated is only accepted by tier-for/);

  const help = run(['--help']);
  assert.match(help.stdout, /tier-for <treeRoot> <briefPath> \[--escalated\]/);
}

console.log('test-tier-for: OK');
