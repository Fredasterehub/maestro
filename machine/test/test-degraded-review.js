'use strict';

// Proves the degraded review path by tests, not prose (execution-plan.md §8,
// §9, §16 and the amendments appended to that file — the r3 qualification
// bound and the reviewer-claude apex-bound record are the two most recent and
// supersede everything they touch). Covers, against the real interfaces as
// they exist in this worktree (step 2c's seq-reference closeMission is
// present; author_route_seq/review_route_seq/artifact-identity/independence
// derive from records, per execution-plan.md §8/§14 and the two governing
// amendments appended to that file — "close must still prove the reviewer
// approved" and "the same artifact is one predicate, defined once and
// disjunctive"):
//
//   (A) an operator-down lane excludes candidates exactly as a preflight-
//       absent one does, and re-enabling it via a settings write alone
//       restores the pre-toggle resolution — no code change.
//   (B) a degraded resolution is always labeled "degraded-path", carries the
//       design's verbatim decorrelation notice, and is never "cross-family".
//   (C) the tier-scaled preferred pairing resolves correctly through every
//       class including apex, both authorship directions.
//   (D) the same-model fresh-instance fallback's static shape (model, effort,
//       fresh_instance, verbatim fallback notice) is design-conformant on
//       every degraded bundle, and resolving never throws under this file's
//       fixtures. NOT proven, and not fabricated: routing.js has no signal
//       that makes the preferred cross-model partner unavailable (Claude has
//       no capability probe the way codex/gemini do), so no case here ever
//       exercises the conditional fallback path itself, and `fallback_used`/
//       `fallback_reason` have no writer anywhere in machine/src — that
//       record belongs to roster.js's `recordOutcome`, step 7a, not built at
//       this commit. This section is honest shape/design-conformance
//       coverage, not conditional-behaviour coverage.
//   (E) an explicit operator-requested hold throws rather than resolving, at
//       every class; the default and the explicit "degraded-path" posture
//       never do.
//   (F) a substitution that would land on the author's own family is
//       dropped, never returned as a laundered cross-family bundle.
//   (G) mission close's cross-family law refuses a review-phase record that
//       reports a real degraded reviewer's family as if it were cross-family
//       review.
//   (H) route.js's own real primitives: reserveReview refuses cross-family
//       independence naming the author's own family, and
//       validateArtifactIdentity refuses a dirty worktree and a shape
//       mismatch (a diff digest never interchanges with a commit SHA).
//   (I) close refuses when the artifact that landed differs from the one
//       reviewed and gated — proven by landing an amended tip, not merely an
//       unlanded one.
//   (J) a degraded close resolved from a REAL reviewFor bundle stays legal
//       under the route snapshot that authorized it after the provider lane
//       genuinely recovers (state.json.preflight and settings.json both say
//       so) — close derives from records, never present-day provider state.
//
// NOT covered here, and not fabricated, because the behaviour the brief
// names does not exist in machine/src at this commit:
//   - "...never *counted* as cross-family" (the labeling bullet's second
//     half): there is no telemetry surface yet (§16 is slice 7 work).
//   - "carries fallback_used and a fallback_reason" and "never held merely
//     because the preferred model was unavailable" (the fallback bullet's
//     conditional half): see (D) above — no availability signal, no record
//     writer, both step 7a's.
//   - "the order review-then-final-gate-then-merge is asserted": the
//     review-then-gate half IS asserted, at test-mission.js:1221-1236
//     against mission.js:1544 — not duplicated here. The gate-then-merge
//     half has no enforcing site anywhere in machine/src: no record
//     establishes when a landing happened, because landing/merging is done
//     by hand outside the machine. That is an implementation gap for the
//     plan to decide, not a test this file can honestly write — inventing
//     one would assert an order the code does not enforce.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const ROUTING = path.join(SRC_DIR, 'routing.js');
const MISSION = path.join(SRC_DIR, 'mission.js');
const ROUTE = path.join(SRC_DIR, 'route.js');

const { reviewFor, buildDefaultConfig } = require(ROUTING);
const settingsMod = require(path.join(SRC_DIR, 'settings.js'));
const { openMission } = require(MISSION);
const { reserve, reserveReview, validateArtifactIdentity } = require(ROUTE);
const { appendRecord, readRecords } = require(path.join(SRC_DIR, 'jsonl.js'));
const fx = require('./close-fixture.js');

// The design's verbatim text (tiered-dispatch-final-design.md §8), copied
// independently of routing.js's own DEGRADED_REVIEW_NOTICE/
// DEGRADED_REVIEW_FALLBACK_NOTICE constants so this test checks the shipped
// behaviour against the design, not against routing.js's opinion of itself.
const DESIGN_NOTICE =
  'No cross-family reviewer is available, so this work was reviewed on the ' +
  "degraded path: a fresh-context Claude reviewer with no access to the author's " +
  'transcript, on a different Claude model than the author. This is NOT ' +
  'cross-family review — author and reviewer share one model family and may share ' +
  'blind spots. The verdict is recorded as review.independence "degraded-path" ' +
  'and is never counted as independent cross-family approval.';

const DESIGN_FALLBACK_NOTICE =
  'No cross-family reviewer is available, and the preferred cross-model ' +
  'degraded reviewer was also unavailable, so this work was reviewed by a ' +
  'second fresh-context instance of the same model as the author, with no ' +
  "access to the author's transcript or session. This is NOT cross-family " +
  'review and NOT cross-model review — author and reviewer share one model and ' +
  'family and may share more blind spots than the preferred pairing would have. ' +
  'The verdict is recorded as review.independence "degraded-path" with ' +
  '`fallback_used: true`, and is never counted as independent cross-family or ' +
  'cross-model approval.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-degraded-review-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function runRouting(args) {
  return spawnSync(process.execPath, [ROUTING, ...args], { encoding: 'utf8' });
}

function initTree(name) {
  const root = freshTree(name);
  const r = runRouting(['init', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  return root;
}

function activeOf(root) {
  const r = runRouting(['active', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// The CLI's non-JSON form prints only bundle.seat; comparing that alone
// would miss a divergence in model/effort/independence and would let two
// failed invocations both print '' and compare equal, so callers that need
// to compare a resolution use this instead, which checks status itself.
function reviewForJson(root, ...args) {
  const r = runRouting(['review-for', root, ...args, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function setPreflight(root, perProvider) {
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({ schema_version: 1, preflight: { per_provider: perProvider } }) + '\n'
  );
}

function gitAt(repo, ...args) {
  const g = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`);
  return g.stdout.trim();
}

// customTree mirrors test-routing.js's own helper: a shipped default config
// with one hand-shaped mutation, so a substitution that the shipped tables
// never produce can still be exercised through the real read/resolve path.
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
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ schema_version: 1, active_config: filename, digest }) + '\n');
  return root;
}

const CLASSES = ['recon', 'mechanical', 'standard', 'expert', 'apex'];

const BRIEF = {
  outcome: 'o',
  scope: 's',
  anchors: ['a.js'],
  acceptance: 'a',
  freshness: 'f',
  tier: 'standard',
  return_format: 'r',
  stop_condition: 'sc',
};

// =============================================================================
// (A) lane posture equivalence: preflight-absent vs operator-down, and the
//     re-enabling round trip.
// =============================================================================
{
  const probeDown = initTree('lane-posture-probe-down');
  setPreflight(probeDown, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  const probeActive = activeOf(probeDown);

  const operatorDown = initTree('lane-posture-operator-down');
  setPreflight(operatorDown, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  settingsMod.write(operatorDown, { provider_lanes: { gpt: 'operator-down' } });
  const operatorActive = activeOf(operatorDown);

  // Same effective exclusion either way: composed review routing and seat
  // substitutions are identical regardless of which of the two causes fired.
  assert.deepStrictEqual(probeActive.degraded_modes, ['codex_down']);
  assert.deepStrictEqual(operatorActive.degraded_modes, ['codex_down']);
  assert.deepStrictEqual(probeActive.review_routing, operatorActive.review_routing, 'a probe-down and an operator-down gpt lane must exclude the same candidates');
  assert.deepStrictEqual(probeActive.seat_substitutions, operatorActive.seat_substitutions);

  // Each cause names itself, so a reader can tell why the lane is out.
  assert.strictEqual(probeActive.provider_lanes.gpt, 'auto', 'a probe failure alone is not an operator toggle');
  assert.match(probeActive.notices[0], /Codex CLI is unavailable/);
  assert.strictEqual(operatorActive.provider_lanes.gpt, 'operator-down');
  assert.match(operatorActive.notices[0], /operator-down \(settings provider_lanes\.gpt = "operator-down"\)/);
  assert.match(operatorActive.notices[0], /not a probe failure/);

  const probeBundle = reviewForJson(probeDown, 'claude');
  const operatorBundle = reviewForJson(operatorDown, 'claude');
  // Every field a caller would actually dispatch on, not merely the printed
  // seat name — and each call's own status is checked (reviewForJson
  // asserts it), so two refusals could never compare equal by both
  // returning an empty string.
  for (const field of ['seat', 'family', 'model', 'effort', 'independence', 'author_model']) {
    assert.strictEqual(probeBundle[field], operatorBundle[field], `field "${field}" must be identical under either cause`);
  }

  // Re-enabling: a settings write alone (no source edit, no new dated
  // config) restores exactly the healthy-tree resolution.
  settingsMod.write(operatorDown, { provider_lanes: { gpt: 'auto' } });
  const restored = activeOf(operatorDown);
  assert.deepStrictEqual(restored.degraded_modes, [], 're-enabling the lane must clear the degraded mode with no code change');
  assert.deepStrictEqual(restored.seat_substitutions, {});
  assert.strictEqual(restored.provider_lanes.gpt, 'auto');

  const neverToggled = initTree('lane-posture-never-toggled');
  setPreflight(neverToggled, { codex: { routing: 'present' }, gemini: { routing: 'present' } });
  assert.deepStrictEqual(restored.review_routing, activeOf(neverToggled).review_routing, 're-enabled tree must resolve identically to one that was never toggled down');
  const reEnabledBundle = reviewForJson(operatorDown, 'claude');
  const neverToggledBundle = reviewForJson(neverToggled, 'claude');
  for (const field of ['seat', 'family', 'model', 'effort', 'independence', 'author_model']) {
    assert.strictEqual(reEnabledBundle[field], neverToggledBundle[field], `field "${field}" must match a tree that was never toggled down`);
  }
}

// =============================================================================
// (B) a degraded resolution is always "degraded-path", never "cross-family",
//     and always carries the design's verbatim decorrelation notice.
// =============================================================================
{
  const root = initTree('degraded-label-discipline');
  setPreflight(root, {}); // both non-claude lanes preflight-absent: nothing survives to cross-family
  for (const klass of CLASSES) {
    const bundle = reviewFor(root, 'claude', klass);
    assert.strictEqual(bundle.independence, 'degraded-path', `${klass}: degraded resolution must be labeled degraded-path`);
    assert.strictEqual(bundle.family, 'claude', `${klass}: the degraded path is a fresh-context Claude reviewer by definition`);
    assert.ok(bundle.notices.includes(DESIGN_NOTICE), `${klass}: the bundle must carry the design's verbatim decorrelation notice`);
  }
}

// =============================================================================
// (C) tier-scaled preferred pairing through every class, apex both
//     directions (design §8's table).
// =============================================================================
{
  const root = initTree('tier-scaled-pairing');
  setPreflight(root, {});

  const expectations = [
    { klass: 'recon', authorModel: undefined, seat: 'reviewer-degraded-opus', model: 'opus-5', effort: 'medium' },
    { klass: 'mechanical', authorModel: undefined, seat: 'reviewer-degraded-opus', model: 'opus-5', effort: 'medium' },
    { klass: 'standard', authorModel: undefined, seat: 'reviewer-degraded-opus', model: 'opus-5', effort: 'medium' },
    { klass: 'expert', authorModel: undefined, seat: 'reviewer-degraded-sonnet', model: 'sonnet-5', effort: 'high' },
    // apex, fable-authored (the canonical apex authorship, and the row's
    // first pairing — what an authorship-blind caller gets by default).
    { klass: 'apex', authorModel: undefined, seat: 'reviewer-degraded-opus-apex', model: 'opus-5', effort: 'high' },
    { klass: 'apex', authorModel: 'fable-5', seat: 'reviewer-degraded-opus-apex', model: 'opus-5', effort: 'high' },
    // apex, opus-authored — the other half of the heavy-model pairing.
    { klass: 'apex', authorModel: 'opus-5', seat: 'reviewer-degraded-fable-apex', model: 'fable-5', effort: 'low' },
  ];

  for (const exp of expectations) {
    const bundle = reviewFor(root, 'claude', exp.klass, exp.authorModel);
    const label = `${exp.klass}${exp.authorModel ? ` (author ${exp.authorModel})` : ''}`;
    assert.strictEqual(bundle.seat, exp.seat, `${label}: wrong preferred reviewer seat`);
    assert.strictEqual(bundle.model, exp.model, `${label}: wrong reviewer model`);
    assert.strictEqual(bundle.effort, exp.effort, `${label}: wrong reviewer effort`);
    assert.strictEqual(bundle.independence, 'degraded-path');
  }

  // An author model the row does not pair is refused, never silently
  // defaulted to the row's first entry.
  assert.throws(
    () => reviewFor(root, 'claude', 'standard', 'opus-5'),
    /has no pairing for author model "opus-5"/,
    'an unpaired author model must refuse rather than default'
  );
}

// =============================================================================
// (D) the same-model fresh-instance fallback's STATIC SHAPE, design-
//     conformant on every degraded bundle: this is shape/design-conformance
//     coverage, not conditional-behaviour coverage — see the file header for
//     exactly what is and is not proven here, and why (step 7a dependency).
// =============================================================================
{
  const root = initTree('same-model-fallback');
  setPreflight(root, {});

  const expectations = [
    { klass: 'recon', authorModel: undefined, fallbackModel: 'sonnet-5' },
    { klass: 'mechanical', authorModel: undefined, fallbackModel: 'sonnet-5' },
    { klass: 'standard', authorModel: undefined, fallbackModel: 'sonnet-5' },
    { klass: 'expert', authorModel: undefined, fallbackModel: 'opus-5' },
    { klass: 'apex', authorModel: undefined, fallbackModel: 'fable-5' }, // fable-authored default
    { klass: 'apex', authorModel: 'fable-5', fallbackModel: 'fable-5' },
    { klass: 'apex', authorModel: 'opus-5', fallbackModel: 'opus-5' },
  ];

  for (const exp of expectations) {
    const label = `${exp.klass}${exp.authorModel ? ` (author ${exp.authorModel})` : ''}`;
    // Resolving does not throw under this tree's fixtures. This is NOT a
    // test of "never held for preferred-model unavailability" — nothing here
    // ever makes the preferred partner unavailable, since routing.js has no
    // such signal for a Claude model (Claude is the runtime; no probe
    // represents it) — it is the same doesNotThrow (E) and (B)/(C) already
    // establish for this tree, restated so the fallback-field reads below
    // are against a bundle this file actually produced.
    const bundle = reviewFor(root, 'claude', exp.klass, exp.authorModel);
    assert.strictEqual(bundle.independence, 'degraded-path');
    // The bundle's static fallback field, checked against the design's table
    // (tiered-dispatch-final-design.md:322-327): same model as the author,
    // fresh context, effort high (never the preferred seat's own — possibly
    // lower — effort), and the verbatim fallback-variant notice. Whether a
    // caller ever actually engages this fallback, and records fallback_used/
    // fallback_reason when it does, is unimplemented and untested here (no
    // writer exists yet — roster.js recordOutcome, step 7a).
    assert.strictEqual(bundle.fallback.model, exp.fallbackModel, `${label}: fallback must name the author's own model`);
    assert.strictEqual(bundle.fallback.effort, 'high', `${label}: the same-model fallback always reviews at high effort`);
    assert.strictEqual(bundle.fallback.fresh_instance, true);
    assert.strictEqual(bundle.fallback.notice, DESIGN_FALLBACK_NOTICE, `${label}: the fallback notice must be the design's verbatim text`);
  }
}

// =============================================================================
// (E) an explicit operator-requested hold throws rather than resolving, at
//     every class; the default and the explicit "degraded-path" posture do
//     not.
// =============================================================================
{
  const root = initTree('hold-posture-every-class');
  setPreflight(root, {});

  // degraded_review is a real settings schema key (settings.js:44), so the
  // sanctioned writer sets it — the same writer section (A) already uses for
  // the sibling provider_lanes knob.
  settingsMod.write(root, { degraded_review: 'hold' });
  for (const klass of CLASSES) {
    assert.throws(
      () => reviewFor(root, 'claude', klass),
      /operator-selected hold posture refuses the degraded path/,
      `${klass}: an explicit operator hold must refuse, not resolve`
    );
  }

  for (const posture of [undefined, 'degraded-path']) {
    if (posture === undefined) {
      // No sanctioned "unset" exists — settings.js has no delete/reset
      // command — so the absent-file default case removes the file directly.
      fs.rmSync(path.join(root, 'settings.json'), { force: true });
    } else {
      settingsMod.write(root, { degraded_review: posture });
    }
    for (const klass of CLASSES) {
      assert.doesNotThrow(
        () => reviewFor(root, 'claude', klass),
        `${klass}: posture ${posture === undefined ? 'default' : posture} must resolve, never hold`
      );
    }
  }
}

// =============================================================================
// (F) a substitution that would return a reviewer of the author's own family
//     is dropped from cross-family candidacy — never returned as a laundered
//     "cross-family" bundle.
// =============================================================================
{
  // Claude author: the only surviving cross-family candidate (after gemini
  // goes down) is substituted onto a same-family seat. The candidate must
  // be dropped, and the resolution must fall through to the honestly
  // labeled degraded path — never claim cross-family independence with a
  // reviewer sharing the author's own family.
  const root = customTree('launder-same-family-claude', (config) => {
    config.seats['reviewer-mystery-claude'] = { model: 'opus-5', family: 'claude' };
    config.degraded.gemini_down.seats['reviewer-sol-expert-rev'] = 'reviewer-mystery-claude';
    // A qualification bound at or above the task class, so the injected
    // candidate reaches the same-family drop instead of being dropped
    // earlier by the (unrelated) missing-qualification filter — otherwise
    // this fixture would pass even with the same-family check removed.
    config.review_qualification['reviewer-mystery-claude'] = 'apex';
  });
  setPreflight(root, { codex: { routing: 'present' }, gemini: { routing: 'absent' } });

  const bundle = reviewFor(root, 'claude', 'standard');
  assert.strictEqual(bundle.independence, 'degraded-path', 'a same-family substitution must never be labeled cross-family');
  assert.notStrictEqual(bundle.seat, 'reviewer-mystery-claude', 'the laundered seat must never be returned');
  assert.strictEqual(bundle.seat, 'reviewer-degraded-opus', 'resolution must fall to the honest degraded path instead');

  // Non-claude author: the analogous substitution leaves every candidate
  // same-family, and the degraded path is scoped to claude-authored work —
  // so the correct outcome is an outright refusal, never a false claim that
  // author and reviewer are cross-family.
  const rootGemini = customTree('launder-same-family-gemini', (config) => {
    config.seats['reviewer-mystery-gemini'] = { model: 'gemini-3.1-pro-preview', family: 'gemini' };
    config.degraded.codex_down.seats['reviewer-claude'] = 'reviewer-mystery-gemini';
    // Same reason as the claude fixture above: reach the same-family drop,
    // not the missing-qualification one.
    config.review_qualification['reviewer-mystery-gemini'] = 'apex';
  });
  setPreflight(rootGemini, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  assert.throws(
    () => reviewFor(rootGemini, 'gemini', 'standard'),
    /degraded path is scoped to claude-authored work/,
    'a gemini author with only a same-family substitute must refuse, never launder a cross-family label'
  );
}

// =============================================================================
// (G) mission close's cross-family law refuses a review route that reports a
//     real degraded reviewer's family as if it were cross-family review —
//     re-expressed against the seq-reference contract now that 2c has
//     landed. closeMission derives author_family from the author-phase
//     route and reviewer_family/independence from the review-phase route
//     (mission.js:1050-1060's checkReviewLegality); there is no caller key
//     to assert either any more, so what this proves is that a review-phase
//     record itself cannot carry the laundered pair. route.js's own
//     reserveReview already refuses this combination at reservation time
//     (H), so the review route below is appended directly to the ledger —
//     bypassing that sanctioned writer, the way a hand-forged or otherwise
//     malformed record would — to prove close is a second, independent
//     fence over the same law, not merely relying on route.js's guard.
// =============================================================================
{
  const root = initTree('close-degraded-family-law');
  setPreflight(root, {});
  const bundle = reviewFor(root, 'claude', 'standard');
  assert.strictEqual(bundle.family, 'claude');
  assert.strictEqual(bundle.independence, 'degraded-path');

  const missionRoot = freshTree('close-degraded-family-law-mission');
  const missionId = 'm1';
  openMission(missionRoot, { mission_id: missionId, title: 'degraded-path close law', brief: BRIEF });

  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const author = reserve(missionRoot, fx.authorRouteInput(missionId));
  assert.strictEqual(author.author_family, 'claude');

  // The real bundle's family, seat and model — laundered as "cross-family"
  // instead of the honest "degraded-path" its independence actually is.
  const review = appendRecord(path.join(missionRoot, 'ledger.jsonl'), {
    kind: 'route',
    payload: {
      ...fx.reviewRouteInput(missionId, author.seq, author.seq, identity, {
        reviewer_seat: bundle.seat,
        reviewer_family: bundle.family,
        reviewer_model: bundle.model,
        reviewer_effort: bundle.effort,
        independence: 'cross-family',
      }),
      phase: 'review',
      predecessor: null,
    },
    correlation_id: missionId,
  });

  fx.recordApprove(missionRoot, missionId, { authorSeq: author.seq, reviewSeq: review.seq }, identity);
  const gateSeq = fx.runGreenGate(missionRoot, missionId, 'tests', repo);
  fx.land(repo, 'merge');

  const r = fx.runClose(
    missionRoot,
    missionId,
    repo,
    fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 1, "closing on a real degraded reviewer's family relabeled cross-family must refuse");
  assert.match(r.stderr, /laundered label/);
}

// =============================================================================
// (H) route.js's own real primitives: reserveReview refuses cross-family
//     independence naming the author's own family, and
//     validateArtifactIdentity refuses a dirty worktree and a shape mismatch.
//     Distinct from (G): this is the reservation-time fence in route.js
//     itself, not close's independent one.
// =============================================================================
{
  const missionRoot = freshTree('route-primitives-mission');
  const missionId = 'm1';
  openMission(missionRoot, { mission_id: missionId, title: 'route primitives', brief: BRIEF });

  const DIGEST_A = 'sha256:' + 'a'.repeat(64);
  const DIGEST_B = 'sha256:' + 'b'.repeat(64);
  const DIGEST_C = 'sha256:' + 'c'.repeat(64);
  const HEAD_A = '1'.repeat(40);
  const TREE_A = '2'.repeat(40);

  const authorInput = (overrides) => ({
    mission_id: missionId,
    attempt: 1,
    brief_digest: DIGEST_A,
    task_class: 'standard',
    routing_config: 'routing-2026-08-07-1.json',
    routing_digest: DIGEST_B,
    routing_revision: 3,
    requested_seat: 'executor-claude-standard',
    resolved_seat: 'executor-claude-standard',
    author_family: 'claude',
    worker_model: 'sonnet-5',
    worker_effort: 'high',
    host_model: null,
    host_effort: null,
    fallback_profile: null,
    escalation_profile: false,
    selection: { candidates_skipped: [], substituted: false, substitution_reason: null },
    reserved_review: {
      seat: 'reviewer-degraded-opus',
      family: 'claude',
      model: 'opus-5',
      effort: 'medium',
      independence: 'degraded-path',
    },
    lane_state: { claude: 'auto', gpt: 'operator-down', gemini: 'auto' },
    degraded_modes: ['codex_down', 'gemini_down'],
    notices: ['both non-claude lanes down; claude author falls to the degraded path'],
    ...overrides,
  });

  const reviewInput = (authorRouteSeq, overrides) => ({
    mission_id: missionId,
    author_route_seq: authorRouteSeq,
    author_attempt: 1,
    author_dispatch_seq: 1,
    artifact_identity: { source_head: HEAD_A, source_tree: TREE_A, patch_digest: DIGEST_C, dirty: false },
    reviewer_seat: 'reviewer-degraded-opus',
    reviewer_family: 'claude',
    reviewer_model: 'opus-5',
    reviewer_effort: 'medium',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'degraded-path',
    routing_config: 'routing-2026-08-07-1.json',
    routing_digest: DIGEST_B,
    replacement_reason: null,
    ...overrides,
  });

  const author = reserve(missionRoot, authorInput());

  // A degraded-path reviewer sharing the author's own family — exactly what
  // (B)/(C) above prove legal — is what route.js must accept.
  const degraded = reserveReview(missionRoot, reviewInput(author.seq));
  assert.strictEqual(degraded.independence, 'degraded-path');
  assert.strictEqual(degraded.reviewer_family, 'claude');

  // The identical reviewer family claimed as cross-family instead must
  // refuse: it is the label that is illegal, not the family by itself.
  assert.throws(
    () =>
      reserveReview(missionRoot, reviewInput(author.seq, { independence: 'cross-family', replacement_reason: 'x' })),
    /cross-family independence with reviewer family "claude" is the author's own family/,
    "reserveReview must refuse cross-family independence naming the author's own family"
  );

  // A dirty worktree is never a reviewable artifact...
  const dirty = validateArtifactIdentity({ source_head: HEAD_A, source_tree: TREE_A, patch_digest: DIGEST_C, dirty: true });
  assert.strictEqual(dirty.ok, false);
  assert.ok(dirty.errors.some((e) => /may not name a dirty worktree/.test(e)));

  // ...and a digest never interchanges with a commit/tree oid, either way.
  const shapeMismatch = validateArtifactIdentity({
    source_head: DIGEST_C,
    source_tree: TREE_A,
    patch_digest: HEAD_A,
    dirty: false,
  });
  assert.strictEqual(shapeMismatch.ok, false);
  assert.ok(shapeMismatch.errors.some((e) => /"source_head" must be a git object id/.test(e)));
  assert.ok(shapeMismatch.errors.some((e) => /"patch_digest" must be a sha256 digest/.test(e)));
}

// =============================================================================
// (I) close refuses when the artifact that landed differs from the one
//     reviewed and gated — an artifact that changed between review and
//     landing, distinct from one that never landed at all: the reviewed
//     commit is amended (different tree, different patch) after the gate
//     passes, and the amended tip — not the reviewed one — is what lands.
// =============================================================================
{
  const missionRoot = freshTree('landing-changed-mission');
  openMission(missionRoot, { mission_id: 'mland-changed', title: 'landed artifact drifted', brief: BRIEF });
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo); // the commit that gets reviewed
  const chain = fx.reserveChain(missionRoot, 'mland-changed', identity);
  fx.recordApprove(missionRoot, 'mland-changed', chain, identity);
  const gateSeq = fx.runGreenGate(missionRoot, 'mland-changed', 'tests', repo); // gate passes against the reviewed commit

  // Amend the reviewed commit's content in place: a new tip object (different
  // tree, different patch) replaces it on the work branch. The original
  // commit object still exists (git does not delete it), so a check that
  // merely asked "does this object exist" would miss the substitution —
  // proveLanding instead asks whether the LANDING BRANCH contains it, or
  // carries an equivalent patch.
  fs.appendFileSync(path.join(repo, 'work.txt'), 'amended after the gate ran\n');
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '--amend', '-q', '-m', 'work, amended after review and gate');

  fx.land(repo, 'merge'); // lands the amended tip, not the reviewed one

  const r = fx.runClose(missionRoot, 'mland-changed', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'landing a different commit than the one reviewed and gated must refuse close');
  assert.match(r.stderr, /neither contains the reviewed commit .* nor carries any commit with its patch identity/);
}

// =============================================================================
// (J) a degraded close resolved from a REAL routing.js reviewFor bundle stays
//     legal under the route snapshot that authorized it after the provider
//     lane genuinely recovers — state.json.preflight AND settings.json both
//     say the lane is back — because closeMission reads neither.
// =============================================================================
{
  const lanesRoot = initTree('apex-recovery-lanes');
  setPreflight(lanesRoot, {}); // both non-claude lanes preflight-absent at resolution time
  const bundle = reviewFor(lanesRoot, 'claude', 'apex'); // fable-authored apex -> reviewer-degraded-opus-apex
  assert.strictEqual(bundle.seat, 'reviewer-degraded-opus-apex');
  assert.strictEqual(bundle.independence, 'degraded-path');

  // The same tree doubles as the mission tree: mission.js's state.json.missions
  // and routing's state.json.preflight are independent keys on one document,
  // and every writer here spreads the document forward rather than replacing it.
  openMission(lanesRoot, { mission_id: 'mapex-recover', title: 'apex degraded close', brief: { ...BRIEF, tier: 'apex' } });
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(lanesRoot, 'mapex-recover', identity, {
    author: {
      task_class: 'apex',
      reserved_review: {
        seat: bundle.seat,
        family: bundle.family,
        model: bundle.model,
        effort: bundle.effort,
        independence: bundle.independence,
      },
      lane_state: { claude: 'auto', gpt: 'operator-down', gemini: 'operator-down' },
      degraded_modes: ['codex_down', 'gemini_down'],
      notices: ['both non-claude lanes down at resolution time; apex falls to the heavy-model degraded pairing'],
    },
    review: {
      reviewer_seat: bundle.seat,
      reviewer_family: bundle.family,
      reviewer_model: bundle.model,
      reviewer_effort: bundle.effort,
      independence: bundle.independence,
    },
  });
  fx.recordApprove(lanesRoot, 'mapex-recover', chain, identity);
  const gateSeq = fx.runGreenGate(lanesRoot, 'mapex-recover', 'tests', repo);
  fx.land(repo, 'merge');

  // The provider recovers for real, after the review: a fresh preflight
  // record and a settings write both say both lanes are up. Neither write
  // may clobber the mission state already recorded in the same state.json.
  const stateBefore = JSON.parse(fs.readFileSync(path.join(lanesRoot, 'state.json'), 'utf8'));
  fs.writeFileSync(
    path.join(lanesRoot, 'state.json'),
    JSON.stringify({ ...stateBefore, preflight: { per_provider: { codex: { routing: 'present' }, gemini: { routing: 'present' } } } }, null, 2) + '\n'
  );
  settingsMod.write(lanesRoot, { provider_lanes: { gpt: 'auto', gemini: 'auto' } });

  // The recovered tree would now resolve a live cross-family reviewer for
  // fresh standard-class work — proving the recovery is real, not merely
  // asserted (apex itself has no r3-qualified cross-family candidate at any
  // lane state — the r3 qualification bound amendment — so a fresh apex
  // resolution staying degraded here would prove nothing about recovery).
  const freshResolution = reviewFor(lanesRoot, 'claude', 'standard');
  assert.notStrictEqual(freshResolution.independence, 'degraded-path', 'the lane really did recover for a fresh resolution');

  const r = fx.runClose(lanesRoot, 'mapex-recover', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, `a legal degraded close must survive provider recovery: ${r.stderr}`);
  const closed = JSON.parse(r.stdout);
  assert.strictEqual(closed.status, 'done');
  const { records } = readRecords(path.join(lanesRoot, 'ledger.jsonl'));
  const close = records[records.length - 1];
  assert.strictEqual(close.kind, 'mission-close');
  assert.strictEqual(close.task_class, 'apex', 'no class ceiling — apex closes on the degraded path');
  assert.strictEqual(close.review.independence, 'degraded-path');
  assert.strictEqual(close.review.family, 'claude');
}

console.log('test-degraded-review: OK');
