'use strict';

// Proves the degraded review path by tests, not prose (execution-plan.md §8,
// §9, §16 and the amendments appended to that file — the r3 qualification
// bound and the reviewer-claude apex-bound record are the two most recent and
// supersede everything they touch). Covers, against the real interfaces as
// they exist in this worktree:
//
//   (A) an operator-down lane excludes candidates exactly as a preflight-
//       absent one does, and re-enabling it via a settings write alone
//       restores the pre-toggle resolution — no code change.
//   (B) a degraded resolution is always labeled "degraded-path", carries the
//       design's verbatim decorrelation notice, and is never "cross-family".
//   (C) the tier-scaled preferred pairing resolves correctly through every
//       class including apex, both authorship directions.
//   (D) when the preferred pairing partner would be unavailable, the bundle
//       already carries the legal same-model fresh-instance fallback
//       (model, effort, fresh_instance, verbatim fallback notice) that a
//       caller records as fallback_used/fallback_reason — and resolution
//       never throws for this reason, at any class.
//   (E) an explicit operator-requested hold throws rather than resolving, at
//       every class; the default and the explicit "degraded-path" posture
//       never do.
//   (F) a substitution that would land on the author's own family is
//       dropped, never returned as a laundered cross-family bundle.
//   (G) mission close's existing cross-family law refuses a caller who
//       reports a degraded reviewer's true family as if the mission had
//       received cross-family review.
//
// NOT covered here, and not fabricated: "close refuses when the artifact
// identity changed between review and landing" and "a degraded close that
// was legal under its route snapshot stays legal after the provider lane
// recovers". Both describe the seq-reference closeMission contract
// (execution-plan.md §8/§14 — author_route_seq/review_route_seq/artifact
// identity/independence-aware close). machine/src/mission.js:344 in this
// worktree still takes the pre-rewrite input shape
// { author_family, review: { verdict, family }, gate_seq } with no artifact
// identity, no route_seq and no independence field anywhere in closeMission
// — that rewrite lives on the unmerged sibling branch slice2c-close-rewrite
// (tip b8d6348), not on main as of be6a454. There is no real interface here
// to drive for those two behaviours; see the envelope for this finding.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const ROUTING = path.join(SRC_DIR, 'routing.js');
const MISSION = path.join(SRC_DIR, 'mission.js');
const GATE = path.join(SRC_DIR, 'gate.js');

const { reviewFor, buildDefaultConfig, FAMILIES } = require(ROUTING);
const settingsMod = require(path.join(SRC_DIR, 'settings.js'));
const { openMission, closeMission } = require(MISSION);

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

function setPreflight(root, perProvider) {
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({ schema_version: 1, preflight: { per_provider: perProvider } }) + '\n'
  );
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

function runGate(root, missionId, gateId, cmd) {
  return spawnSync(process.execPath, [GATE, 'run-gate', root, missionId, gateId, '--', ...cmd], { encoding: 'utf8' });
}

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

  assert.strictEqual(
    runRouting(['review-for', probeDown, 'claude']).stdout.trim(),
    runRouting(['review-for', operatorDown, 'claude']).stdout.trim(),
    'the resolved reviewer must be identical under either cause'
  );

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
  assert.strictEqual(
    runRouting(['review-for', operatorDown, 'claude']).stdout.trim(),
    runRouting(['review-for', neverToggled, 'claude']).stdout.trim()
  );
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
    assert.notStrictEqual(bundle.independence, 'cross-family', `${klass}: a degraded resolution is never cross-family`);
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
}

// =============================================================================
// (D) the same-model fresh-instance fallback: legal, carries what a caller
//     needs to record fallback_used/fallback_reason, and resolution never
//     throws or holds merely because the preferred model would be
//     unavailable — at any class.
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
    // The resolution itself never throws — this module has no signal by
    // which a Claude model could be reported "unavailable" (Claude is the
    // runtime; no probe represents it), so nothing here can ever hold a
    // class solely for the preferred degraded-path model being unavailable.
    let bundle;
    assert.doesNotThrow(() => {
      bundle = reviewFor(root, 'claude', exp.klass, exp.authorModel);
    }, `${label}: resolving the degraded path must never throw for preferred-model unavailability`);
    assert.strictEqual(bundle.independence, 'degraded-path');
    // The fallback the bundle carries is the caller's fallback_used/reason
    // material: same model as the author, fresh context, effort high (never
    // the preferred seat's own — possibly lower — effort), and the design's
    // verbatim fallback-variant notice.
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

  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ degraded_review: 'hold' }) + '\n');
  for (const klass of CLASSES) {
    assert.throws(
      () => reviewFor(root, 'claude', klass),
      /operator-selected hold posture refuses the degraded path/,
      `${klass}: an explicit operator hold must refuse, not resolve`
    );
  }

  for (const posture of [undefined, 'degraded-path']) {
    if (posture === undefined) {
      fs.rmSync(path.join(root, 'settings.json'), { force: true });
    } else {
      fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ degraded_review: posture }) + '\n');
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
  });
  setPreflight(rootGemini, { codex: { routing: 'absent' }, gemini: { routing: 'present' } });
  assert.throws(
    () => reviewFor(rootGemini, 'gemini', 'standard'),
    /degraded path is scoped to claude-authored work/,
    'a gemini author with only a same-family substitute must refuse, never launder a cross-family label'
  );
}

// =============================================================================
// (G) mission close's existing cross-family law refuses a caller who reports
//     a real degraded reviewer's family as if it were the mission's
//     cross-family review.
//
// mission.js's closeMission on this branch (pre slice2c-close-rewrite) takes
// author_family and the review verdict/family as caller-asserted input, with
// no route-derived cross-check (that binding is exactly what 2c adds). What
// it DOES already enforce — and what this proves against a REAL routing.js
// resolution rather than a hand-picked family string — is that a claude
// author cannot close by naming its own family as the review family, which
// is precisely the family a degraded-path reviewer for a claude author
// always carries (per (B) above). So a caller cannot use this mission's own
// real degraded resolution to close as if it had received cross-family
// review.
// =============================================================================
{
  const root = initTree('close-degraded-family-law');
  setPreflight(root, {});
  const bundle = reviewFor(root, 'claude', 'standard');
  assert.strictEqual(bundle.family, 'claude');

  const missionRoot = freshTree('close-degraded-family-law-mission');
  const missionId = 'm1';
  openMission(missionRoot, { mission_id: missionId, title: 'degraded-path close law', brief: BRIEF });
  const gate = runGate(missionRoot, missionId, 'tests', ['true']);
  assert.strictEqual(gate.status, 0, gate.stderr);
  const gateSeq = JSON.parse(gate.stdout).ledger_seq;

  assert.throws(
    () => closeMission(missionRoot, missionId, { author_family: 'claude', review: { verdict: 'approve', family: bundle.family }, gate_seq: gateSeq }),
    /cross-family review law/,
    'closing a claude-authored mission by naming the degraded reviewer\'s own (claude) family as the review family must refuse'
  );

  // The honest label for the same review — degraded-path, reviewed by a
  // seat this mission's real resolution actually names — cannot be spelled
  // as an approving cross-family close at all, by construction: FAMILIES has
  // exactly claude/gpt/gemini, and the only family a claude-author's
  // degraded review ever carries is claude, so no truthful review object
  // reporting this bundle can ever satisfy review.family !== author_family.
  assert.ok(![...FAMILIES].some((f) => f !== 'claude' && f === bundle.family), 'a degraded review for a claude author never carries a non-claude family to misreport as cross-family');
}

console.log('test-degraded-review: OK');
