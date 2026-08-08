'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROUTE = path.join(__dirname, '..', 'src', 'route.js');
const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const GATE = path.join(__dirname, '..', 'src', 'gate.js');
const JSONL = path.join(__dirname, '..', 'src', 'jsonl.js');
const ROUTING = path.join(__dirname, '..', 'src', 'routing.js');
const SETTINGS = path.join(__dirname, '..', 'src', 'settings.js');

const { readRecords } = require(JSONL);
const { BRIEF_TIER_VALUES } = require(path.join(__dirname, '..', 'src', 'validators.js'));
const { reserve, reserveReview, supersede, seatFamily, CLASS_ORDER, ROUTE_KIND, SUPERSEDED_KIND } = require(ROUTE);
const { artifactIdentity } = require(GATE);
const routing = require(ROUTING);
const settings = require(SETTINGS);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-route-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');

// Routing is initialized before any route is reserved, because a review route
// now derives its reviewer's family from the config's seat table — a tree with
// route records and no routing table is a tree that cannot say who anyone is.
fs.mkdirSync(root, { recursive: true });
const routingInit = routing.init(root);
const routingConfig = routing.loadRouting(root).config;

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
const DIGEST_C = 'sha256:' + 'c'.repeat(64);
const HEAD_A = '1'.repeat(40);
const TREE_A = '2'.repeat(40);

const BRIEF = {
  outcome: 'o',
  scope: 's',
  anchors: ['a.js'],
  acceptance: 'a',
  freshness: 'f',
  tier: 'expert',
  return_format: 'r',
  stop_condition: 'sc',
};

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

let missionCounter = 0;
function openMission() {
  missionCounter += 1;
  const id = `m${missionCounter}`;
  const r = run(MISSION, ['open', root], { mission_id: id, title: `route testbed ${id}`, brief: BRIEF });
  assert.strictEqual(r.status, 0, r.stderr);
  return id;
}

function ledger() {
  return readRecords(path.join(root, 'ledger.jsonl'));
}

function recordsOf(missionId, kind) {
  return ledger().records.filter((r) => r.kind === kind && r.mission_id === missionId);
}

// Every mission's ledger opens with its own mission-open record; that record is
// the stand-in evidence_seq for supersession tests (it exists and correlates).
function evidenceSeqOf(missionId) {
  const open = ledger().records.find((r) => r.kind === 'mission-open' && r.mission_id === missionId);
  assert.ok(open, 'mission-open record must exist');
  return open.seq;
}

function authorInput(overrides) {
  return {
    mission_id: 'REPLACE-ME',
    attempt: 1,
    brief_digest: DIGEST_A,
    task_class: 'expert',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: DIGEST_B,
    routing_revision: 6,
    requested_seat: 'executor-claude',
    resolved_seat: 'executor-claude',
    author_family: 'claude',
    worker_model: 'opus-5',
    worker_effort: 'high',
    host_model: null,
    host_effort: null,
    fallback_profile: null,
    escalation_profile: false,
    selection: { candidates_skipped: [], substituted: false, substitution_reason: null },
    reserved_review: {
      seat: 'reviewer-degraded-sonnet',
      family: 'claude',
      model: 'sonnet-5',
      effort: 'high',
      independence: 'degraded-path',
    },
    lane_state: { claude: 'auto', gpt: 'operator-down', gemini: 'auto' },
    degraded_modes: ['codex_down'],
    notices: ['gpt lane operator-down; claude author'],
    ...overrides,
  };
}

function reviewInput(authorRouteSeq, overrides) {
  return {
    mission_id: 'REPLACE-ME',
    author_route_seq: authorRouteSeq,
    author_attempt: 1,
    author_dispatch_seq: 7,
    artifact_identity: {
      source_head: HEAD_A,
      source_tree: TREE_A,
      patch_digest: DIGEST_C,
      dirty: false,
    },
    reviewer_seat: 'reviewer-degraded-sonnet',
    reviewer_family: 'claude',
    reviewer_model: 'sonnet-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'degraded-path',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: DIGEST_B,
    replacement_reason: null,
    ...overrides,
  };
}

// --- the escalation ordering covers the brief's task-class vocabulary ---------
{
  assert.deepStrictEqual(
    [...CLASS_ORDER].sort(),
    [...BRIEF_TIER_VALUES].sort(),
    'CLASS_ORDER must cover exactly the brief tier vocabulary it orders'
  );
  assert.strictEqual(ROUTE_KIND, 'route');
  assert.strictEqual(SUPERSEDED_KIND, 'route-superseded');
}

// --- author route: one record kind, mandatory phase --------------------------
{
  const m = openMission();
  const rec = reserve(root, authorInput({ mission_id: m }));

  assert.strictEqual(rec.kind, 'route', 'ONE record kind — the phase is a field, not a kind');
  assert.strictEqual(rec.phase, 'author');
  assert.strictEqual(rec.schema_version, 1);
  assert.strictEqual(rec.correlation_id, m);
  assert.ok(typeof rec.ts === 'string' && rec.ts.endsWith('Z'), 'timestamp comes from the stream header');
  assert.strictEqual(rec.attempt, 1);
  assert.strictEqual(rec.brief_digest, DIGEST_A);
  assert.strictEqual(rec.task_class, 'expert');
  assert.strictEqual(rec.routing_config, 'routing-2026-08-06-2.json');
  assert.strictEqual(rec.routing_revision, 6);
  assert.strictEqual(rec.author_family, 'claude');
  assert.strictEqual(rec.host_model, null);
  assert.strictEqual(rec.host_effort, null);
  assert.deepStrictEqual(rec.reserved_review, authorInput().reserved_review);
  assert.deepStrictEqual(rec.lane_state, authorInput().lane_state);
  assert.deepStrictEqual(rec.degraded_modes, ['codex_down']);
  assert.strictEqual(rec.predecessor, null, 'a fresh route names no predecessor');
  assert.strictEqual(rec.resumed, false, 'resumed is derived, never caller-supplied');

  assert.strictEqual(recordsOf(m, 'route').length, 1);
}

// --- author route: shape refusals write nothing -------------------------------
{
  const m = openMission();
  const before = ledger().records.length;
  const bad = (over, re) => assert.throws(() => reserve(root, authorInput({ mission_id: m, ...over })), re);

  bad({ surprise: 1 }, /unexpected extra key "surprise"/);
  bad({ attempt: 0 }, /"attempt" must be an integer >= 1/);
  bad({ attempt: 1.5 }, /"attempt" must be an integer >= 1/);
  bad({ brief_digest: 'a'.repeat(64) }, /"brief_digest" must be a sha256 digest/);
  bad({ routing_digest: 'sha256:zz' }, /"routing_digest" must be a sha256 digest/);
  bad({ routing_config: 'routing.json' }, /"routing_config" must be a dated routing config filename/);
  bad({ routing_config: '../routing-2026-08-06-2.json' }, /"routing_config" must be a dated routing config filename/);
  bad({ routing_revision: 0 }, /"routing_revision" must be an integer >= 1/);
  bad({ task_class: 'wizard' }, /"task_class" must be one of/);
  bad({ author_family: 'anthropic' }, /"author_family" must be one of/);
  bad({ resolved_seat: 'bad seat' }, /"resolved_seat" must be/);
  bad({ worker_model: '' }, /"worker_model" must be/);
  bad({ host_model: 'sonnet-5' }, /both be null \(native seat\) or both be non-empty/);
  bad({ host_effort: 'high' }, /both be null \(native seat\) or both be non-empty/);
  bad({ fallback_profile: { model: 'opus-5' } }, /fallback_profile is missing required key "effort"/);
  bad({ escalation_profile: 'yes' }, /"escalation_profile" must be a boolean/);
  bad({ reserved_review: { seat: 'reviewer-claude' } }, /reserved_review is missing required key/);
  bad(
    { reserved_review: { ...authorInput().reserved_review, independence: 'independent' } },
    /reserved_review field "independence" must be one of cross-family, degraded-path/
  );
  bad({ lane_state: {} }, /"lane_state" must be a non-empty object/);
  bad({ lane_state: { gpt: 42 } }, /lane_state\["gpt"\] must be a non-empty single-line string/);
  bad({ degraded_modes: 'codex_down' }, /"degraded_modes" must be an array/);
  bad({ notices: ['x'.repeat(201)] }, /notices\[0\] must be at most 200 characters/);
  bad({ notices: new Array(21).fill('n') }, /"notices" must hold at most 20 entries/);
  bad({ predecessor: { predecessor_route_seq: 1 } }, /unexpected extra key "predecessor"/);
  bad({ resumed: true }, /unexpected extra key "resumed"/);
  const missing = authorInput({ mission_id: m });
  delete missing.reserved_review;
  assert.throws(() => reserve(root, missing), /missing required key "reserved_review"/);
  assert.throws(() => reserve(root, ['nope']), /must be a plain object/);

  assert.strictEqual(ledger().records.length, before, 'a refusal reaches no disk');
}

// --- author route: the mission must exist, be open, and have a real tree ------
{
  const m = openMission();
  assert.throws(() => reserve(root, authorInput({ mission_id: 'nosuch' })), /no such mission "nosuch"/);
  assert.throws(() => reserve(path.join(tmp, 'absent'), authorInput({ mission_id: m })), /scaffold it first/);

  // close derives from records: a done mission takes the full chain (routes,
  // identity-bound gate, landed result), which the shared fixture builds.
  require('./close-fixture.js').closeMissionFully(root, m, { dir: tmp });

  const before = ledger().records.length;
  assert.throws(() => reserve(root, authorInput({ mission_id: m })), /status "done"/);
  assert.strictEqual(ledger().records.length, before, 'no route record on a closed mission');
}

// --- selection honesty: a skipped candidate is never a requested one ----------
{
  const m = openMission();

  // The honest fresh-resolution shape: gpt lane down, its candidate skipped.
  const rec = reserve(
    root,
    authorInput({
      mission_id: m,
      selection: {
        candidates_skipped: [
          { seat: 'executor-sol-expert', reason: 'lane-down' },
          { seat: 'executor-gemini', reason: 'capability-absent' },
        ],
        substituted: false,
        substitution_reason: null,
      },
    })
  );
  assert.strictEqual(rec.selection.candidates_skipped.length, 2);
  assert.strictEqual(rec.selection.substituted, false);
  assert.strictEqual(rec.selection.substitution_reason, null);

  const bad = (selection, re, over) =>
    assert.throws(() => reserve(root, authorInput({ mission_id: m, selection, ...over })), re);

  // Correction 9: no requested-then-substituted pair for a never-eligible seat.
  bad(
    { candidates_skipped: [], substituted: true, substitution_reason: 'gpt lane down' },
    /a fresh route may not claim substituted:true/
  );
  bad(
    { candidates_skipped: [], substituted: false, substitution_reason: null },
    /a fresh route must resolve the seat it requested/,
    { requested_seat: 'executor-sol-expert' }
  );
  bad(
    {
      candidates_skipped: [{ seat: 'executor-claude', reason: 'lane-down' }],
      substituted: false,
      substitution_reason: null,
    },
    /appears in candidates_skipped/
  );
  // The four vocabularies stay distinct: a reroute is not a skip reason.
  bad(
    {
      candidates_skipped: [{ seat: 'executor-sol-expert', reason: 'provider-rerouted' }],
      substituted: false,
      substitution_reason: null,
    },
    /candidates_skipped\[0\] field "reason" must be one of lane-down, capability-absent/
  );
  bad(
    {
      candidates_skipped: [
        { seat: 'executor-sol-expert', reason: 'lane-down' },
        { seat: 'executor-sol-expert', reason: 'capability-absent' },
      ],
      substituted: false,
      substitution_reason: null,
    },
    /candidates_skipped names seat "executor-sol-expert" twice/
  );
  bad(
    { candidates_skipped: [], substituted: false, substitution_reason: 'unused' },
    /"substitution_reason" must be null unless substituted is true/
  );

  // Escalation-only profiles are unreachable on a fresh route.
  assert.throws(
    () => reserve(root, authorInput({ mission_id: m, escalation_profile: true })),
    /a fresh route may not select an escalation-only profile/
  );
}

// --- review route: binds the author route and its reserved capacity ----------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const rec = reserveReview(root, reviewInput(author.seq, { mission_id: m }));

  assert.strictEqual(rec.kind, 'route');
  assert.strictEqual(rec.phase, 'review');
  assert.strictEqual(rec.author_route_seq, author.seq);
  assert.strictEqual(rec.author_attempt, 1);
  assert.strictEqual(rec.author_dispatch_seq, 7);
  assert.deepStrictEqual(rec.artifact_identity, reviewInput(0).artifact_identity);
  assert.strictEqual(rec.independence, 'degraded-path');
  assert.strictEqual(rec.replacement_reason, null, 'the reserved reviewer was honoured');
  assert.strictEqual(rec.predecessor, null);
  assert.ok(rec.seq > author.seq, 'the review route is written after the author route');
}

// --- review route: embeds a really-computed identity, field for field -------
// The reviewer is told what it will see by the same helper the gate uses, so
// "what was reviewed" and "what was gated" are one object, not two narratives.
{
  const repo = path.join(tmp, 'worktree');
  fs.mkdirSync(repo);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@maestro.invalid');
  git('config', 'user.name', 'maestro test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'work');

  const identity = artifactIdentity(repo);
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const rec = reserveReview(root, reviewInput(author.seq, { mission_id: m, artifact_identity: identity }));

  assert.deepStrictEqual(rec.artifact_identity, identity, 'the route names exactly the computed identity');
  const onDisk = recordsOf(m, ROUTE_KIND).find((r) => r.phase === 'review');
  assert.deepStrictEqual(onDisk.artifact_identity, identity, 'and it survives the ledger unchanged');
}

// --- review route: a lost reserved reviewer must say so ----------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));

  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(author.seq, { mission_id: m, reviewer_model: 'opus-5', reviewer_effort: 'medium' })
      ),
    /differs from the reserved review capacity .* "replacement_reason"/s
  );

  const rec = reserveReview(
    root,
    reviewInput(author.seq, {
      mission_id: m,
      reviewer_seat: 'reviewer-degraded-opus',
      reviewer_model: 'opus-5',
      reviewer_effort: 'medium',
      replacement_reason: 'reserved sonnet reviewer unavailable at review time',
    })
  );
  assert.strictEqual(rec.reviewer_seat, 'reviewer-degraded-opus');
  assert.match(rec.replacement_reason, /unavailable/);

  // ...and an unchanged reviewer may not invent one.
  assert.throws(
    () => reserveReview(root, reviewInput(author.seq, { mission_id: m, replacement_reason: 'no reviewer was lost' })),
    /"replacement_reason" must be null when the reserved review capacity was honoured/
  );
}

// --- author route: the author's family is derived from the seat table too ----
//
// The other operand of the same comparison, and the identical move: an
// executor-claude route asserting family "gpt" makes an honest claude reviewer
// read as cross-family. Deriving only the reviewer would have left this door
// beside the fence.
{
  assert.strictEqual(routingConfig.seats['executor-claude'].family, 'claude');
  const m = openMission();
  assert.throws(
    () => reserve(root, authorInput({ mission_id: m, author_family: 'gpt' })),
    /author_family "gpt" contradicts the routing config, which seats "executor-claude" in family "claude"/,
    'an author family the config contradicts is refused'
  );
  assert.strictEqual(recordsOf(m, 'route').length, 0, 'nothing reached disk on the refusal');

  // Underivable is refused, not defaulted — the same three ways as the
  // reviewer. The unknown seat is a synthetic name rather than a
  // not-yet-shipped one: dormant ladder seats land in the config revision by
  // revision (the r4->r5 migration seated executor-luna), so borrowing one
  // would quietly turn this fence into a no-op the day its seat arrives.
  assert.throws(
    () => reserve(root, authorInput({ mission_id: m, requested_seat: 'executor-phantom', resolved_seat: 'executor-phantom' })),
    /the family of author seat "executor-phantom" cannot be derived — the routing config's seat table records no seat/
  );
  assert.throws(
    () =>
      reserve(
        root,
        authorInput({
          mission_id: m,
          requested_seat: 'executor-sol',
          resolved_seat: 'executor-sol',
          author_family: 'gpt',
          worker_model: 'gpt-5.6-sol',
          host_model: 'sonnet-5',
          host_effort: 'high',
        })
      ),
    /records "executor-sol" as an alias of "executor-sol-expert", and an alias seat is never routable/
  );

  // An honest author route is accepted and says so on the record.
  const honest = reserve(root, authorInput({ mission_id: m }));
  assert.strictEqual(honest.author_family, 'claude');
  assert.strictEqual(honest.author_family_derived, true);

  // A real gpt seat, honestly seated: the fence is about truth, not about
  // keeping every author on one family.
  const m2 = openMission();
  const sol = reserve(
    root,
    authorInput({
      mission_id: m2,
      requested_seat: 'executor-sol-expert',
      resolved_seat: 'executor-sol-expert',
      author_family: 'gpt',
      worker_model: 'gpt-5.6-sol',
      worker_effort: 'medium',
      host_model: 'sonnet-5',
      host_effort: 'medium',
    })
  );
  assert.strictEqual(sol.author_family, 'gpt');
  assert.strictEqual(sol.author_family_derived, true);

  // The marker is derived, never caller-supplied.
  assert.throws(
    () => reserve(root, authorInput({ mission_id: m, author_family_derived: true })),
    /unexpected extra key "author_family_derived"/
  );
}

// --- review route: no family laundering --------------------------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, author_family: 'claude' }));
  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(author.seq, {
          mission_id: m,
          independence: 'cross-family',
          replacement_reason: 'reserved reviewer lost',
        })
      ),
    /cross-family independence with reviewer family "claude" is the author's own family/
  );

  const rec = reserveReview(
    root,
    reviewInput(author.seq, {
      mission_id: m,
      reviewer_seat: 'reviewer-sol-expert-rev',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6-sol',
      reviewer_effort: 'medium',
      reviewer_host_model: 'sonnet-5',
      reviewer_host_effort: 'medium',
      independence: 'cross-family',
      replacement_reason: 'gpt lane returned before review dispatch',
    })
  );
  assert.strictEqual(rec.independence, 'cross-family');
  assert.strictEqual(rec.reviewer_host_model, 'sonnet-5');
}

// --- review route: the reviewer's family is derived from the seat table ------
//
// The block above proves the laundering check works when the family is true.
// This one is why that was not enough: the reservation reserveReview compares
// the assertion against is the SAME caller's, so a false pair that agrees with
// itself used to pass. The seat table is the authority, and it disagrees.
{
  // The exact reproduction handed over with this step: a gemini seat wearing a
  // claude family, agreed to by the author route's own reservation.
  const falsePair = {
    seat: 'reviewer-gemini',
    family: 'claude',
    model: 'gemini-3.1-pro-preview',
    effort: 'high',
    independence: 'degraded-path',
  };
  assert.strictEqual(routingConfig.seats['reviewer-gemini'].family, 'gemini', 'the config is what contradicts the pair');

  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, reserved_review: falsePair }));
  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(author.seq, {
          mission_id: m,
          reviewer_seat: falsePair.seat,
          reviewer_family: falsePair.family,
          reviewer_model: falsePair.model,
          reviewer_effort: falsePair.effort,
        })
      ),
    /reviewer_family "claude" contradicts the routing config, which seats "reviewer-gemini" in family "gemini"/,
    'a family the config contradicts is refused even when the reservation agrees with it'
  );
  assert.strictEqual(recordsOf(m, 'route').length, 1, 'nothing reached disk on the refusal');

  // A seat the table does not carry establishes no family at all, and an
  // unestablished family is refused rather than defaulted.
  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(author.seq, {
          mission_id: m,
          reviewer_seat: 'reviewer-phantom',
          reviewer_family: 'gpt',
          reviewer_model: 'gpt-5.6-terra',
          replacement_reason: 'a seat this config does not carry',
        })
      ),
    /cannot be derived — the routing config's seat table records no seat "reviewer-phantom"/
  );

  // An alias is a compatibility pointer, never a routable seat: routing.js
  // resolves none on any read path, and neither does this.
  assert.strictEqual(routingConfig.seats['reviewer-sol'].alias_of, 'reviewer-sol-expert-rev');
  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(author.seq, {
          mission_id: m,
          reviewer_seat: 'reviewer-sol',
          reviewer_family: 'gpt',
          reviewer_model: 'gpt-5.6-sol',
          reviewer_effort: 'medium',
          reviewer_host_model: 'sonnet-5',
          reviewer_host_effort: 'medium',
          replacement_reason: 'an alias is not a seat',
        })
      ),
    /records "reviewer-sol" as an alias of "reviewer-sol-expert-rev", and an alias seat is never routable/
  );
}

// --- review route: an honest pair is accepted and stamped as derived ---------
// Both independence kinds, because the fence must not cost the degraded path
// its legality or the cross-family path its reason for existing.
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));

  const degraded = reserveReview(root, reviewInput(author.seq, { mission_id: m }));
  assert.strictEqual(degraded.reviewer_seat, 'reviewer-degraded-sonnet');
  assert.strictEqual(degraded.reviewer_family, 'claude');
  assert.strictEqual(degraded.independence, 'degraded-path');
  assert.strictEqual(
    degraded.reviewer_family_derived,
    true,
    'the record says its family was derived, so close can tell it from one written before the rule'
  );

  const m2 = openMission();
  const author2 = reserve(root, authorInput({ mission_id: m2 }));
  const cross = reserveReview(
    root,
    reviewInput(author2.seq, {
      mission_id: m2,
      reviewer_seat: 'reviewer-sol-expert-rev',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6-sol',
      reviewer_effort: 'medium',
      reviewer_host_model: 'sonnet-5',
      reviewer_host_effort: 'medium',
      independence: 'cross-family',
      replacement_reason: 'gpt lane came back before review dispatch',
    })
  );
  assert.strictEqual(cross.reviewer_family, 'gpt');
  assert.strictEqual(cross.reviewer_family_derived, true);

  // The marker is derived, never caller-supplied.
  assert.throws(
    () => reserveReview(root, reviewInput(author.seq, { mission_id: m, reviewer_family_derived: true })),
    /unexpected extra key "reviewer_family_derived"/
  );
}

// --- review route: the derivation itself, seat by seat -----------------------
{
  assert.deepStrictEqual(seatFamily(root, 'reviewer-gemini'), { family: 'gemini', reason: null });
  assert.deepStrictEqual(seatFamily(root, 'reviewer-degraded-sonnet'), { family: 'claude', reason: null });
  assert.deepStrictEqual(seatFamily(root, 'reviewer-sol-expert-rev'), { family: 'gpt', reason: null });
  assert.strictEqual(seatFamily(root, 'reviewer-phantom').family, null);
  assert.strictEqual(seatFamily(root, 'reviewer-sol').family, null, 'an alias resolves to no family');
  // No routing table is no family either — the fence never fails open on a
  // tree that cannot say who a seat is.
  const bare = fs.mkdtempSync(path.join(tmp, 'no-routing-'));
  const noConfig = seatFamily(bare, 'reviewer-gemini');
  assert.strictEqual(noConfig.family, null);
  assert.match(noConfig.reason, /the routing config could not be read/);

  // The DATED config a record names is what the derivation reads, not the
  // tree's active pointer: a seat re-seated by a later revise must still
  // derive the family the record was written against.
  const routingDir = path.join(root, 'routing');
  const active = JSON.parse(fs.readFileSync(path.join(routingDir, 'active.json'), 'utf8'));
  const pinnedName = 'routing-2020-01-01-1.json';
  const pinned = JSON.parse(fs.readFileSync(path.join(routingDir, active.active_config), 'utf8'));
  pinned.seats['reviewer-retired'] = { model: 'sonnet-5', family: 'claude', effort: 'high' };
  fs.writeFileSync(path.join(routingDir, pinnedName), JSON.stringify(pinned, null, 2) + '\n');
  assert.strictEqual(
    seatFamily(root, 'reviewer-retired').family,
    null,
    'the seat is absent from the tree-active config'
  );
  assert.deepStrictEqual(
    seatFamily(root, 'reviewer-retired', pinnedName),
    { family: 'claude', reason: null },
    'the named dated config is the authority, not the active pointer'
  );
  // A named config the tree no longer carries falls back to the active one
  // rather than making an honest record underivable.
  assert.deepStrictEqual(
    seatFamily(root, 'reviewer-gemini', 'routing-2019-01-01-1.json'),
    { family: 'gemini', reason: null },
    'a missing dated config falls back to the active config'
  );
}

// --- review route: artifact identity is one object, never a digest/SHA mix ---
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const badIdentity = (identity, re) =>
    assert.throws(
      () => reserveReview(root, reviewInput(author.seq, { mission_id: m, artifact_identity: identity })),
      re
    );
  const id = reviewInput(0).artifact_identity;

  badIdentity({ ...id, source_head: DIGEST_C }, /"source_head" must be a git object id/);
  badIdentity({ ...id, patch_digest: HEAD_A }, /"patch_digest" must be a sha256 digest/);
  badIdentity({ ...id, dirty: true }, /a review route may not name a dirty worktree/);
  badIdentity({ ...id, dirty: 'no' }, /"dirty" must be a boolean/);
  badIdentity({ source_head: HEAD_A, source_tree: TREE_A, patch_digest: DIGEST_C }, /missing required key "dirty"/);
  badIdentity({ ...id, extra: 1 }, /unexpected extra key "extra"/);
}

// --- review route: the named author route must really be one -----------------
{
  const m = openMission();
  const other = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const foreign = reserve(root, authorInput({ mission_id: other }));

  assert.throws(
    () => reserveReview(root, reviewInput(9999, { mission_id: m })),
    /no route record at ledger seq 9999/
  );
  assert.throws(
    () => reserveReview(root, reviewInput(foreign.seq, { mission_id: m })),
    /belongs to mission "m\d+", not "m\d+"/
  );
  assert.throws(
    () => reserveReview(root, reviewInput(author.seq, { mission_id: m, author_attempt: 2 })),
    /author_attempt 2 does not match the author route's attempt 1/
  );
  const review = reserveReview(root, reviewInput(author.seq, { mission_id: m }));
  assert.throws(
    () => reserveReview(root, reviewInput(review.seq, { mission_id: m })),
    /is a review-phase route, not an author-phase route/
  );
}

// --- supersession is replacement-first ---------------------------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({
      mission_id: m,
      attempt: 2,
      requested_seat: 'executor-claude',
      resolved_seat: 'executor-claude-standard',
      selection: {
        candidates_skipped: [],
        substituted: true,
        substitution_reason: 'reserved author seat died mid-dispatch',
      },
    }),
  });

  assert.strictEqual(out.route.kind, 'route');
  assert.strictEqual(out.superseded.kind, 'route-superseded');
  assert.ok(
    out.route.seq < out.superseded.seq,
    'the replacement route is durable before the supersession pointer exists'
  );
  assert.deepStrictEqual(out.route.predecessor, {
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
  });
  assert.strictEqual(out.superseded.predecessor_route_seq, author.seq);
  assert.strictEqual(out.superseded.replacement_route_seq, out.route.seq);
  assert.strictEqual(out.superseded.transition, 'same-class-provider-reroute');
  assert.strictEqual(out.superseded.reason, 'infrastructure');
  assert.strictEqual(out.superseded.mission_id, m);
  assert.strictEqual(out.route.attempt, 2, 'a reroute is a new attempt');
  assert.strictEqual(out.route.resumed, false);
  assert.strictEqual(out.route.selection.substituted, true, 'a concrete reserved route really was lost');

  // The predecessor is never overwritten or reinterpreted.
  const predecessorNow = ledger().records.find((r) => r.seq === author.seq);
  assert.deepStrictEqual(predecessorNow, author);

  // One predecessor, one supersession.
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: author.seq,
        transition: 'same-class-provider-reroute',
        reason: 'quota',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({ mission_id: m, attempt: 2 }),
      }),
    /is already superseded by route/
  );
}

// --- supersession: shape and reference refusals ------------------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const base = {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 2 }),
  };
  const bad = (over, re) => assert.throws(() => supersede(root, { ...base, ...over }), re);

  bad({ transition: 'vibes' }, /"transition" must be one of/);
  bad({ reason: 'because' }, /"reason" must be one of/);
  bad({ evidence_seq: 9999 }, /"evidence_seq" 9999 names no ledger record/);
  bad({ predecessor_route_seq: 9999 }, /no route record at ledger seq 9999/);
  bad({ surprise: 1 }, /unexpected extra key "surprise"/);
  bad(
    { replacement: { ...authorInput({ mission_id: m, attempt: 2 }), predecessor: null } },
    /replacement must not carry its own "predecessor"/
  );
  bad({ replacement: authorInput({ mission_id: 'other', attempt: 2 }) }, /replacement mission_id .* predecessor/);

  const before = ledger().records.length;
  assert.throws(() => supersede(root, { ...base, replacement: authorInput({ mission_id: m, attempt: 9 }) }), /attempt/);
  assert.strictEqual(ledger().records.length, before, 'a refused supersession reserves nothing');
}

// --- §9: same-profile resume keeps the attempt and marks resumed -------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const resume = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-profile-resume',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 1 }),
  });
  assert.strictEqual(resume.route.attempt, 1, 'a resume is the same attempt');
  assert.strictEqual(resume.route.resumed, true);

  // One same-profile quality repair, then no more.
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: resume.route.seq,
        transition: 'same-profile-resume',
        reason: 'quality',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({ mission_id: m, attempt: 1 }),
      }),
    /mission "m\d+" has already spent its one same-profile quality repair/
  );

  // An infrastructure resume is a runtime retry and consumes no quality budget.
  const retry = supersede(root, {
    mission_id: m,
    predecessor_route_seq: resume.route.seq,
    transition: 'same-profile-resume',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 1 }),
  });
  assert.strictEqual(retry.route.resumed, true);
}

// --- §9: a resume really must be the same profile and the same brief ---------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const resumeWith = (over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition: 'same-profile-resume',
      reason: 'quality',
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({ mission_id: m, attempt: 1, ...over }),
    });

  assert.throws(() => resumeWith({ worker_effort: 'medium' }), /same-profile-resume must keep the profile/);
  assert.throws(() => resumeWith({ attempt: 2 }), /same-profile-resume must keep attempt 1/);
  assert.throws(() => resumeWith({ brief_digest: DIGEST_C }), /same-profile-resume must keep the brief/);
}

// --- §9: mechanical never grinds ---------------------------------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'mechanical' }));
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: author.seq,
        transition: 'same-profile-resume',
        reason: 'quality',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({ mission_id: m, attempt: 1, task_class: 'mechanical' }),
      }),
    /the mechanical class takes zero same-profile quality repairs/
  );
  // The same class still reroutes for infrastructure.
  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-profile-resume',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 1, task_class: 'mechanical' }),
  });
  assert.strictEqual(out.route.task_class, 'mechanical');
}

// --- §9: one profile escalation per mission, then convergence ----------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'standard', worker_model: 'sonnet-5' }));

  const escalated = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'class-escalation',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 2, task_class: 'expert' }),
  });
  assert.strictEqual(escalated.route.task_class, 'expert');
  assert.strictEqual(escalated.route.attempt, 2);

  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: escalated.route.seq,
        transition: 'within-class-profile-escalation',
        reason: 'quality',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({
          mission_id: m,
          attempt: 3,
          resolved_seat: 'executor-fable-low',
          requested_seat: 'executor-fable-low',
          worker_model: 'fable-5',
          worker_effort: 'low',
        }),
      }),
    /has already spent its one profile escalation/
  );

  // Further quality disagreement goes to convergence.
  const converged = supersede(root, {
    mission_id: m,
    predecessor_route_seq: escalated.route.seq,
    transition: 'convergence',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 3, resolved_seat: 'convergence', requested_seat: 'convergence' }),
  });
  assert.strictEqual(converged.route.attempt, 3);
  assert.strictEqual(converged.superseded.transition, 'convergence');
}

// --- §9: escalation is a quality response; infrastructure never buys it ------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'standard' }));
  const escalateWith = (transition, reason, over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition,
      reason,
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({ mission_id: m, attempt: 2, task_class: 'standard', ...over }),
    });

  assert.throws(
    () => escalateWith('class-escalation', 'infrastructure', { task_class: 'expert' }),
    /transition "class-escalation" is a quality response/
  );
  assert.throws(
    () => escalateWith('class-escalation', 'quota', { task_class: 'expert' }),
    /transition "class-escalation" is a quality response/
  );
  assert.throws(
    () => escalateWith('convergence', 'infrastructure', {}),
    /transition "convergence" is a quality response/
  );
  // Two provider reroutes consume nothing: the escalation is still available.
  const rerouted = escalateWith('same-class-provider-reroute', 'infrastructure', {});
  const rerouted2 = supersede(root, {
    mission_id: m,
    predecessor_route_seq: rerouted.route.seq,
    transition: 'same-class-provider-reroute',
    reason: 'quota',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 3, task_class: 'standard' }),
  });
  const stillAvailable = supersede(root, {
    mission_id: m,
    predecessor_route_seq: rerouted2.route.seq,
    transition: 'class-escalation',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 4, task_class: 'expert' }),
  });
  assert.strictEqual(stillAvailable.route.task_class, 'expert');
}

// --- §9: class escalation goes up, and a reroute stays in class --------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'standard', worker_model: 'sonnet-5' }));
  const with_ = (transition, over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition,
      reason: 'quality',
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({ mission_id: m, attempt: 2, ...over }),
    });

  assert.throws(() => with_('class-escalation', { task_class: 'standard' }), /must name a higher task class/);
  assert.throws(() => with_('class-escalation', { task_class: 'mechanical' }), /must name a higher task class/);
  assert.throws(
    () => with_('same-class-provider-reroute', { task_class: 'expert' }),
    /same-class-provider-reroute must keep task class "standard"/
  );
  assert.throws(
    () => with_('within-class-profile-escalation', { task_class: 'standard', worker_model: 'sonnet-5' }),
    /within-class-profile-escalation must change the profile/
  );
  const ok = with_('within-class-profile-escalation', { task_class: 'standard' });
  assert.strictEqual(ok.route.worker_model, 'opus-5', 'sonnet-5 -> opus-5 is a real profile change');
}

// --- §9: apex never invents a higher automatic effort ------------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'apex' }));
  const apexWith = (transition, over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition,
      reason: 'quality',
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({ mission_id: m, attempt: 2, task_class: 'apex', ...over }),
    });

  assert.throws(() => apexWith('class-escalation', {}), /apex is the top task class/);
  assert.throws(
    () => apexWith('within-class-profile-escalation', { worker_model: 'fable-5', worker_effort: 'high' }),
    /apex never invents a higher automatic effort/
  );
  const converged = apexWith('convergence', {});
  assert.strictEqual(converged.route.task_class, 'apex');
}

// --- §9: a safety refusal reroutes the unchanged brief -----------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: author.seq,
        transition: 'same-profile-resume',
        reason: 'safety-refusal',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({ mission_id: m, attempt: 1 }),
      }),
    /a safety refusal reroutes the unchanged brief to another provider/
  );
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: author.seq,
        transition: 'same-class-provider-reroute',
        reason: 'safety-refusal',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({ mission_id: m, attempt: 2, brief_digest: DIGEST_C }),
      }),
    /a safety refusal never rewrites the brief/
  );
  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'safety-refusal',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({
      mission_id: m,
      attempt: 2,
      requested_seat: 'executor-claude',
      resolved_seat: 'executor-sol-expert',
      author_family: 'gpt',
      worker_model: 'gpt-5.6-sol',
      worker_effort: 'medium',
      host_model: 'sonnet-5',
      host_effort: 'medium',
      selection: {
        candidates_skipped: [],
        substituted: true,
        substitution_reason: 'author seat refused the brief on safety grounds',
      },
    }),
  });
  assert.strictEqual(out.route.brief_digest, DIGEST_A, 'the brief travels unchanged');
  assert.strictEqual(out.superseded.reason, 'safety-refusal');
}

// --- §9: substituted:true must name the seat that was really reserved --------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const rerouteWith = (over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition: 'same-class-provider-reroute',
      reason: 'infrastructure',
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({ mission_id: m, attempt: 2, ...over }),
    });

  assert.throws(
    () =>
      rerouteWith({
        requested_seat: 'executor-gemini',
        resolved_seat: 'executor-claude-standard',
        selection: { candidates_skipped: [], substituted: true, substitution_reason: 'lost' },
      }),
    /substituted:true must name the predecessor's resolved seat "executor-claude" as requested_seat/
  );
  assert.throws(
    () =>
      rerouteWith({
        selection: { candidates_skipped: [], substituted: true, substitution_reason: 'lost' },
      }),
    /substituted:true requires a resolved seat different from the requested one/
  );
  assert.throws(
    () =>
      rerouteWith({
        resolved_seat: 'executor-claude-standard',
        selection: { candidates_skipped: [], substituted: true, substitution_reason: '' },
      }),
    /"substitution_reason" must be a non-empty/
  );
}

// --- §9: the escalated claim is convenience input, never authority -----------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m, task_class: 'expert' }));
  const claimWith = (transition, over) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: author.seq,
      transition,
      reason: transition === 'same-class-provider-reroute' ? 'infrastructure' : 'quality',
      evidence_seq: evidenceSeqOf(m),
      replacement: authorInput({
        mission_id: m,
        attempt: 2,
        task_class: 'expert',
        escalation_profile: true,
        requested_seat: 'executor-fable-low',
        resolved_seat: 'executor-fable-low',
        worker_model: 'fable-5',
        worker_effort: 'low',
        ...over,
      }),
    });

  assert.throws(
    () => claimWith('same-class-provider-reroute', {}),
    /an escalation-only profile is reachable only through an escalation transition/
  );
  const ok = claimWith('within-class-profile-escalation', {});
  assert.strictEqual(ok.route.escalation_profile, true);
  assert.strictEqual(ok.route.worker_model, 'fable-5');
}

// --- a review route is superseded in class, never escalated ------------------
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const review = reserveReview(root, reviewInput(author.seq, { mission_id: m }));

  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: review.seq,
        transition: 'class-escalation',
        reason: 'quality',
        evidence_seq: evidenceSeqOf(m),
        replacement: reviewInput(author.seq, { mission_id: m }),
      }),
    /a review-phase route is superseded only by same-class-provider-reroute/
  );
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: review.seq,
        transition: 'same-class-provider-reroute',
        reason: 'infrastructure',
        evidence_seq: evidenceSeqOf(m),
        replacement: reviewInput(author.seq, { mission_id: m, author_attempt: 2 }),
      }),
    /author_attempt/
  );

  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: review.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: reviewInput(author.seq, {
      mission_id: m,
      reviewer_seat: 'reviewer-degraded-opus',
      reviewer_model: 'opus-5',
      reviewer_effort: 'medium',
      replacement_reason: 'reserved sonnet reviewer went unavailable',
    }),
  });
  assert.strictEqual(out.route.phase, 'review');
  assert.ok(out.route.seq < out.superseded.seq, 'replacement-first holds for review routes too');
  assert.strictEqual(out.route.predecessor.predecessor_route_seq, review.seq);
  assert.strictEqual(out.route.reviewer_family_derived, true, 'a replacement is derived like any other review record');
}

// --- supersede: a review replacement derives its family too -------------------
// Replacing a lost reviewer is exactly where a false family would be swapped
// in, so the fence reserveReview holds must hold here or it is one call away
// from being useless.
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const review = reserveReview(root, reviewInput(author.seq, { mission_id: m }));
  const before = ledger().records.length;
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: review.seq,
        transition: 'same-class-provider-reroute',
        reason: 'infrastructure',
        evidence_seq: evidenceSeqOf(m),
        replacement: reviewInput(author.seq, {
          mission_id: m,
          reviewer_seat: 'reviewer-gemini',
          reviewer_family: 'claude',
          reviewer_model: 'gemini-3.1-pro-preview',
          replacement_reason: 'the reserved reviewer was lost',
        }),
      }),
    /reviewer_family "claude" contradicts the routing config, which seats "reviewer-gemini" in family "gemini"/
  );
  assert.strictEqual(ledger().records.length, before, 'a refused supersession leaves no orphan replacement');
}

// --- supersede: an author replacement derives its family too ------------------
// A same-class provider reroute is the transition that MOVES an author across
// families, so it is the one place a false author family would be introduced
// after the fact.
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const before = ledger().records.length;
  assert.throws(
    () =>
      supersede(root, {
        mission_id: m,
        predecessor_route_seq: author.seq,
        transition: 'same-class-provider-reroute',
        reason: 'infrastructure',
        evidence_seq: evidenceSeqOf(m),
        replacement: authorInput({
          mission_id: m,
          attempt: 2,
          author_family: 'gemini', // executor-claude is seated in claude
          selection: { candidates_skipped: [], substituted: false, substitution_reason: null },
        }),
      }),
    /author_family "gemini" contradicts the routing config, which seats "executor-claude" in family "claude"/
  );
  assert.strictEqual(ledger().records.length, before, 'a refused supersession leaves no orphan replacement');

  // The honest reroute across families goes through, and is stamped derived.
  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({
      mission_id: m,
      attempt: 2,
      requested_seat: 'executor-claude',
      resolved_seat: 'executor-sol-expert',
      author_family: 'gpt',
      worker_model: 'gpt-5.6-sol',
      worker_effort: 'medium',
      host_model: 'sonnet-5',
      host_effort: 'medium',
      selection: {
        candidates_skipped: [],
        substituted: true,
        substitution_reason: 'claude lane lost; rerouted in class to the gpt expert rung',
      },
    }),
  });
  assert.strictEqual(out.route.author_family, 'gpt');
  assert.strictEqual(out.route.author_family_derived, true);
}

// --- §9 end to end: one mission walks the shipped Claude ladder --------------
//
// The blocks above exercise each rule against hand-written profiles. This one
// runs a whole mission through the CLI on the routing table the tree actually
// carries: every seat profile is read out of the active config, every reserved
// reviewer comes from routing.js's own resolution, and the route records carry
// the real dated config, digest and revision. So the ladder the config
// describes and the ladder route.js polices are proven to be the same one.
//
// Expert class, because that is the Claude ladder this walk is about — it holds
// the repair, escalation and convergence rungs the §9 rules act on. (Until r5
// it was also the only constructible class: the standard rungs resolved the
// hosted gemini reviewer, whose config entry records no worker effort, and a
// reserved review needs one. r5's gpt standard rung records both, so that
// obstacle is gone; widening the walk is not this step's work.)
{
  const m = openMission();
  const init = routingInit; // initialized once at the top of this file
  const config = routingConfig;
  const seat = (name) => config.seats[name];
  const reviewer = (klass) => {
    const bundle = routing.reviewFor(root, 'claude', klass);
    return {
      seat: bundle.seat,
      family: bundle.family,
      model: bundle.model,
      effort: bundle.effort,
      independence: bundle.independence,
    };
  };
  const onLadder = (seatName, over) =>
    authorInput({
      mission_id: m,
      task_class: 'expert',
      routing_config: init.active_config,
      routing_digest: init.digest,
      routing_revision: config.revision,
      requested_seat: seatName,
      resolved_seat: seatName,
      worker_model: seat(seatName).model,
      worker_effort: seat(seatName).effort,
      reserved_review: reviewer('expert'),
      lane_state: { claude: 'auto', gpt: 'auto', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
      ...over,
    });

  assert.strictEqual(config.revision, routing.CURRENT_ROUTING_REVISION, 'this walk is over the shipped ladder, whatever revision it currently is');
  assert.strictEqual(reviewer('expert').seat, 'reviewer-sol-expert-rev', 'expert claude work is reviewed on the expert rung');

  // 1. The expert default is reserved and its review capacity is honoured.
  const author = reserve(root, onLadder('executor-claude'));
  assert.strictEqual(author.worker_model, 'opus-5');
  const review = reserveReview(
    root,
    reviewInput(author.seq, {
      mission_id: m,
      reviewer_seat: 'reviewer-sol-expert-rev',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6-sol',
      reviewer_effort: 'medium',
      reviewer_host_model: 'sonnet-5',
      reviewer_host_effort: 'medium',
      independence: 'cross-family',
      routing_config: init.active_config,
      routing_digest: init.digest,
    })
  );
  assert.strictEqual(review.phase, 'review');

  const step = (predecessorSeq, transition, reason, replacement) =>
    supersede(root, {
      mission_id: m,
      predecessor_route_seq: predecessorSeq,
      transition,
      reason,
      evidence_seq: evidenceSeqOf(m),
      replacement,
    });

  // 2. One same-profile quality repair, and only one.
  const repair = step(author.seq, 'same-profile-resume', 'quality', onLadder('executor-claude'));
  assert.strictEqual(repair.route.resumed, true);
  assert.strictEqual(repair.route.attempt, 1, 'a repair is the same attempt');
  assert.throws(
    () => step(repair.route.seq, 'same-profile-resume', 'quality', onLadder('executor-claude')),
    /already spent its one same-profile quality repair/
  );

  // 3. The escalation rung: fable-low is escalation-only, and reaching it is
  //    what spends the mission's single profile escalation.
  const escalated = step(
    repair.route.seq,
    'within-class-profile-escalation',
    'quality',
    onLadder('executor-fable-low', { attempt: 2, escalation_profile: true })
  );
  assert.strictEqual(escalated.route.worker_model, 'fable-5');
  assert.strictEqual(escalated.route.worker_effort, 'low');
  assert.strictEqual(escalated.route.escalation_profile, true);
  assert.throws(
    () =>
      step(escalated.route.seq, 'class-escalation', 'quality', onLadder('executor-fable', { attempt: 3, task_class: 'apex' })),
    /already spent its one profile escalation/
  );

  // 4. Infrastructure and quota still reroute in class afterwards: they never
  //    drew on the quality budget, so its exhaustion does not bind them.
  const rerouted = step(escalated.route.seq, 'same-class-provider-reroute', 'quota', onLadder('executor-claude', { attempt: 3 }));
  assert.strictEqual(rerouted.route.task_class, 'expert');
  assert.strictEqual(rerouted.route.escalation_profile, false);

  // 5. Further quality disagreement goes to convergence, on the seat the
  //    config seats there.
  const converged = step(
    rerouted.route.seq,
    'convergence',
    'quality',
    onLadder('convergence', { attempt: 4, worker_model: seat('convergence').model, worker_effort: seat('convergence').effort })
  );
  assert.strictEqual(converged.route.worker_model, 'fable-5');
  assert.strictEqual(converged.route.worker_effort, 'low');
  assert.strictEqual(converged.superseded.transition, 'convergence');

  // The mechanical rung is seated and routable on the same table, though its
  // zero-repair rule is proven above rather than here — this walk stays on the
  // expert class where §9's repair and escalation rungs live.
  assert.deepStrictEqual(seat('executor-claude-mech'), { model: 'sonnet-5', family: 'claude', effort: 'low' });
}

// --- D9 regression: both gemini seats produce route-acceptable bundles
// through the resolver's own output -------------------------------------------
//
// Before this fix, executor-gemini and reviewer-gemini declared a host pair
// but no worker-level `effort` in the seat table, so routing.js's own bundles
// carried `effort: null` straight into route.js's non-empty-string checks —
// refused before the live default resolution (claude-authored standard work
// reviewed by reviewer-gemini) could ever be recorded. Neither half of that
// path had a test naming either gemini seat until now.
{
  const m = openMission();
  const config = routingConfig;
  const seat = (name) => config.seats[name];

  // The live project's recorded lane posture (design §11.3): gpt operator-down,
  // gemini auto — the exact state the battery's live probe ran under, and the
  // one that puts reviewer-gemini in claude-standard's class row without a gpt
  // rung ahead of it.
  settings.write(root, { provider_lanes: { gpt: 'operator-down', gemini: 'auto' } });

  // The live default: claude-authored standard work resolves reviewer-gemini.
  const reviewBundle = routing.reviewFor(root, 'claude', 'standard');
  assert.strictEqual(reviewBundle.seat, 'reviewer-gemini', 'standard claude-authored work is reviewed on reviewer-gemini');
  assert.strictEqual(typeof reviewBundle.effort, 'string', 'reviewFor must not resolve a null worker effort for reviewer-gemini');
  assert.notStrictEqual(reviewBundle.effort, '', 'reviewFor must not resolve an empty worker effort for reviewer-gemini');

  // Feed that bundle straight into an author route's reserved_review field —
  // the exact input D9 quotes route.js refusing.
  const author = reserve(
    root,
    authorInput({
      mission_id: m,
      task_class: 'standard',
      requested_seat: 'executor-claude-standard',
      resolved_seat: 'executor-claude-standard',
      author_family: 'claude',
      worker_model: seat('executor-claude-standard').model,
      worker_effort: seat('executor-claude-standard').effort,
      host_model: null,
      host_effort: null,
      reserved_review: {
        seat: reviewBundle.seat,
        family: reviewBundle.family,
        model: reviewBundle.model,
        effort: reviewBundle.effort,
        independence: reviewBundle.independence,
      },
      lane_state: { claude: 'auto', gpt: 'operator-down', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
    })
  );
  assert.strictEqual(author.reserved_review.seat, 'reviewer-gemini');
  assert.strictEqual(author.reserved_review.effort, reviewBundle.effort);

  // The review route naming reviewer-gemini as the reviewer, fed from the same
  // resolver bundle — the review-side half of D9's refusal.
  const review = reserveReview(
    root,
    reviewInput(author.seq, {
      mission_id: m,
      reviewer_seat: reviewBundle.seat,
      reviewer_family: reviewBundle.family,
      reviewer_model: reviewBundle.model,
      reviewer_effort: reviewBundle.effort,
      reviewer_host_model: reviewBundle.host_model,
      reviewer_host_effort: reviewBundle.host_effort,
      independence: reviewBundle.independence,
    })
  );
  assert.strictEqual(review.phase, 'review');
  assert.strictEqual(review.reviewer_seat, 'reviewer-gemini');

  // The author side of the gemini lane: an author route naming executor-gemini
  // directly, worker_model/worker_effort read straight off the seat table —
  // D9's second quoted refusal (`validateAuthorRoute(executor-gemini,
  // worker_effort: null)`).
  const geminiReview = routing.reviewFor(root, 'gemini', 'standard');
  const geminiAuthor = reserve(
    root,
    authorInput({
      mission_id: m,
      task_class: 'standard',
      requested_seat: 'executor-gemini',
      resolved_seat: 'executor-gemini',
      author_family: 'gemini',
      worker_model: seat('executor-gemini').model,
      worker_effort: seat('executor-gemini').effort,
      host_model: seat('executor-gemini').host,
      host_effort: seat('executor-gemini').host_effort,
      reserved_review: {
        seat: geminiReview.seat,
        family: geminiReview.family,
        model: geminiReview.model,
        effort: geminiReview.effort,
        independence: geminiReview.independence,
      },
      lane_state: { claude: 'auto', gpt: 'operator-down', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
    })
  );
  assert.strictEqual(geminiAuthor.worker_model, 'gemini-3.1-pro-preview');
  assert.strictEqual(typeof geminiAuthor.worker_effort, 'string');
  assert.notStrictEqual(geminiAuthor.worker_effort, '');

  // Restore: this block borrowed the file-wide shared `root` fixture's lane
  // state, and every block after it resolves reviewers against the default
  // posture (both lanes 'auto') unless it says otherwise.
  settings.write(root, { provider_lanes: { gpt: 'auto', gemini: 'auto' } });
}

// --- a crash between the two writes leaves an orphan, never a dangling pointer
{
  const m = openMission();
  const author = reserve(root, authorInput({ mission_id: m }));
  const input = {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'class-escalation',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 2, task_class: 'apex' }),
  };

  // Fault injection with no production accommodation: the child pre-seeds the
  // module cache so route.js's appendRecord throws on the supersession write.
  const script = path.join(tmp, 'crash-child.js');
  fs.writeFileSync(
    script,
    `'use strict';
const real = require(${JSON.stringify(JSONL)});
require.cache[require.resolve(${JSON.stringify(JSONL)})].exports = Object.assign({}, real, {
  appendRecord(file, record) {
    if (record && record.kind === 'route-superseded') throw new Error('simulated crash before the supersession append');
    return real.appendRecord(file, record);
  },
});
const route = require(${JSON.stringify(ROUTE)});
try {
  route.supersede(${JSON.stringify(root)}, ${JSON.stringify(input)});
} catch (err) {
  process.stdout.write(err.message);
  process.exit(3);
}
process.exit(0);
`
  );
  const crashed = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.strictEqual(crashed.status, 3, `expected the injected crash, got: ${crashed.stdout}${crashed.stderr}`);
  assert.match(crashed.stdout, /simulated crash/);

  const { records, errors } = ledger();
  assert.strictEqual(errors.length, 0, 'the ledger stays fully parseable through the crash');
  const orphan = records.find(
    (r) => r.kind === 'route' && r.mission_id === m && r.predecessor && r.predecessor.predecessor_route_seq === author.seq
  );
  assert.ok(orphan, 'the replacement reservation is durable');
  assert.strictEqual(orphan.task_class, 'apex');
  assert.strictEqual(
    records.filter((r) => r.kind === 'route-superseded' && r.predecessor_route_seq === author.seq).length,
    0,
    'no supersession pointer without its replacement'
  );

  // Recovery: the retry names the same predecessor, so the escalation budget
  // is not double-charged by the orphan it left behind.
  const retried = supersede(root, input);
  assert.strictEqual(retried.superseded.predecessor_route_seq, author.seq);
  assert.ok(retried.route.seq > orphan.seq);
}

// --- CLI ---------------------------------------------------------------------
{
  const m = openMission();
  assert.strictEqual(run(ROUTE, ['--help']).status, 0);
  assert.match(run(ROUTE, ['--help']).stdout, /route\.js — maestro route lifecycle/);

  const r = run(ROUTE, ['reserve', root], authorInput({ mission_id: m }));
  assert.strictEqual(r.status, 0, r.stderr);
  const author = JSON.parse(r.stdout);
  assert.strictEqual(author.phase, 'author');

  const rr = run(ROUTE, ['reserve-review', root], reviewInput(author.seq, { mission_id: m }));
  assert.strictEqual(rr.status, 0, rr.stderr);
  assert.strictEqual(JSON.parse(rr.stdout).phase, 'review');

  const sup = run(ROUTE, ['supersede', root], {
    mission_id: m,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'quota',
    evidence_seq: evidenceSeqOf(m),
    replacement: authorInput({ mission_id: m, attempt: 2 }),
  });
  assert.strictEqual(sup.status, 0, sup.stderr);
  const out = JSON.parse(sup.stdout);
  assert.ok(out.route.seq < out.superseded.seq);

  assert.strictEqual(run(ROUTE, ['reserve']).status, 1, 'missing treeRoot refused');
  assert.strictEqual(run(ROUTE, ['reserve', root, 'surplus'], authorInput({ mission_id: m })).status, 1);
  assert.strictEqual(run(ROUTE, ['bogus', root]).status, 1);
  assert.strictEqual(run(ROUTE, []).status, 1);
  assert.strictEqual(
    spawnSync(process.execPath, [ROUTE, 'reserve', root], { input: 'not json', encoding: 'utf8' }).status,
    1
  );
}

console.log('test-route: ok');
