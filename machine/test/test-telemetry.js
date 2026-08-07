'use strict';

// Slice 7a — the two records that make a mission auditable: what was
// dispatched (`dispatch`, appended by roster.js register) and what actually
// ran (`profile-outcome`, appended by roster.js recordOutcome).
//
// Every assertion below reads the record back out of ledger.jsonl rather than
// out of the object the writer returned, because the audit reads disk. And
// every field the records carry is checked against the ROUTE record it was
// sourced from — not against the registration that named it — since a field a
// caller can set is a field the audit cannot trust.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const ROSTER = path.join(SRC, 'roster.js');
const { readRecords } = require(path.join(SRC, 'jsonl.js'));
const { reserve, reserveReview, supersede } = require(path.join(SRC, 'route.js'));
const roster = require(ROSTER);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-telemetry-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

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

let treeCounter = 0;
let missionCounter = 0;

// A route record's family is derived from the routing config's seat table, so
// every fixture tree is a real initialised tree with a real open mission.
function newTree() {
  treeCounter += 1;
  const root = path.join(tmp, `tree${treeCounter}`, '.maestro');
  fs.mkdirSync(root, { recursive: true });
  const init = run(path.join(SRC, 'routing.js'), ['init', root]);
  assert.strictEqual(init.status, 0, init.stderr);
  missionCounter += 1;
  const missionId = `m${missionCounter}`;
  const open = run(path.join(SRC, 'mission.js'), ['open', root], {
    mission_id: missionId,
    title: `telemetry ${missionId}`,
    brief: BRIEF,
  });
  assert.strictEqual(open.status, 0, open.stderr);
  return { root, missionId };
}

function ledger(root) {
  const { records, errors } = readRecords(path.join(root, 'ledger.jsonl'));
  assert.deepStrictEqual(errors, [], 'ledger must parse cleanly');
  return records;
}

function dispatchRecords(root) {
  return ledger(root).filter((r) => r.kind === 'dispatch');
}

// A refused registration must leave no roster at all where none existed, so
// "no file" and "no entries" are the same answer here.
function readRoster(root) {
  const file = path.join(root, 'roster.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema_version: 1, entries: [] };
}

// The hosted gpt author: a Claude host in front of a gpt worker, which is the
// only shape the host-reattribution rule can apply to.
function hostedAuthor(missionId, overrides) {
  return {
    mission_id: missionId,
    attempt: 1,
    brief_digest: 'sha256:' + 'a'.repeat(64),
    task_class: 'expert',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    routing_revision: 5,
    requested_seat: 'executor-sol-expert',
    resolved_seat: 'executor-sol-expert',
    author_family: 'gpt',
    worker_model: 'gpt-5.6-sol',
    worker_effort: 'medium',
    host_model: 'sonnet-5',
    host_effort: 'medium',
    fallback_profile: null,
    escalation_profile: false,
    selection: { candidates_skipped: [], substituted: false, substitution_reason: null },
    reserved_review: {
      seat: 'reviewer-claude',
      family: 'claude',
      model: 'sonnet-5',
      effort: 'high',
      independence: 'cross-family',
    },
    lane_state: { claude: 'auto', gpt: 'auto', gemini: 'auto' },
    degraded_modes: ['gemini_down'],
    notices: [],
    ...overrides,
  };
}

// The native fable seat with its reserved opus fallback — the profile the
// fallback-attribution rule turns on.
function fableAuthor(missionId, overrides) {
  return hostedAuthor(missionId, {
    requested_seat: 'executor-fable-low',
    resolved_seat: 'executor-fable-low',
    author_family: 'claude',
    worker_model: 'fable-5',
    worker_effort: 'low',
    host_model: null,
    host_effort: null,
    fallback_profile: { model: 'opus-5', effort: 'high' },
    reserved_review: {
      seat: 'reviewer-degraded-sonnet',
      family: 'claude',
      model: 'sonnet-5',
      effort: 'high',
      independence: 'degraded-path',
    },
    ...overrides,
  });
}

function registration(missionId, overrides) {
  return {
    seat: 'executor-sol-expert',
    task_id: `${missionId}-author`,
    family: 'gpt',
    mission_id: missionId,
    ...overrides,
  };
}

// === the dispatch record is sourced from the route, field by field ==========
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  const entry = roster.register(root, registration(missionId, { route_seq: route.seq }));

  const records = dispatchRecords(root);
  assert.strictEqual(records.length, 1, 'one registration naming a route writes exactly one dispatch record');
  const d = records[0];

  assert.strictEqual(d.correlation_id, missionId, 'the mission rides as correlation_id');
  assert.strictEqual(d.phase, 'author');
  assert.strictEqual(d.route_seq, route.seq);
  assert.strictEqual(d.task_id, entry.task_id);
  assert.strictEqual(d.spawned_ts, entry.spawned_ts, 'the dispatch record carries the roster entry it followed');

  // Sourced from the route record on disk, not from the registration.
  const onDisk = ledger(root).find((r) => r.kind === 'route' && r.seq === route.seq);
  for (const [field, from] of [
    ['mission_id', 'mission_id'],
    ['class', 'task_class'],
    ['attempt', 'attempt'],
    ['resumed', 'resumed'],
    ['requested_seat', 'requested_seat'],
    ['resolved_seat', 'resolved_seat'],
    ['seat', 'resolved_seat'],
    ['family', 'author_family'],
    ['worker_model', 'worker_model'],
    ['worker_effort', 'worker_effort'],
    ['host_model', 'host_model'],
    ['host_effort', 'host_effort'],
    ['routing_config', 'routing_config'],
    ['routing_digest', 'routing_digest'],
    ['routing_revision', 'routing_revision'],
  ]) {
    assert.deepStrictEqual(d[field], onDisk[from], `dispatch.${field} must be the route record's ${from}`);
  }
  assert.deepStrictEqual(d.degraded_modes, ['gemini_down']);

  // The dispatch record lands strictly after the route it names, and the
  // roster write it follows is already durable.
  assert.ok(d.seq > route.seq, 'the dispatch record follows the route it sources');
  assert.strictEqual(readRoster(root).entries.length, 1);
}

// === the three new optional keys are checked against the route, never taken ==
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));

  // Offered and agreeing: accepted, and the record still carries the route's.
  const entry = roster.register(
    root,
    registration(missionId, { route_seq: route.seq, class: 'expert', attempt: 1, resumed: false })
  );
  assert.strictEqual(entry.class, 'expert');
  assert.strictEqual(entry.attempt, 1);
  assert.strictEqual(entry.resumed, false);
  assert.strictEqual(dispatchRecords(root).length, 1);

  // Offered and contradicting: refused, on every dimension the route carries.
  for (const [override, pattern] of [
    [{ class: 'mechanical' }, /class "mechanical" contradicts the route record/],
    [{ attempt: 4 }, /attempt 4 contradicts the route record/],
    [{ resumed: true }, /resumed true contradicts the route record/],
    [{ seat: 'executor-claude' }, /seat "executor-claude" contradicts the route record/],
    [{ family: 'claude' }, /family "claude" contradicts the route record/],
    [{ mission_id: 'other' }, /mission_id "other" contradicts the route record/],
  ]) {
    assert.throws(
      () => roster.register(root, registration(missionId, { task_id: 't-x', route_seq: route.seq, ...override })),
      pattern,
      `a registration contradicting the route on ${Object.keys(override)[0]} must be refused`
    );
  }

  // Nothing a refusal touched reached either file.
  assert.strictEqual(readRoster(root).entries.length, 1, 'refused registrations wrote no roster entry');
  assert.strictEqual(dispatchRecords(root).length, 1, 'refused registrations wrote no dispatch record');

  // Shape refusals on the new keys.
  for (const [override, pattern] of [
    [{ class: 'gigantic' }, /"class" must be one of/],
    [{ attempt: 0 }, /"attempt" must be an integer >= 1/],
    [{ resumed: 'yes' }, /"resumed" must be a boolean/],
  ]) {
    assert.throws(() => roster.register(root, registration(missionId, { task_id: 't-y', ...override })), pattern);
  }
}

// === a route_seq that names nothing, or names a non-route, is refused ========
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  const openRecord = ledger(root).find((r) => r.kind === 'mission-open');

  assert.throws(
    () => roster.register(root, registration(missionId, { route_seq: 9999 })),
    /no ledger record at seq 9999/,
    'a route_seq naming no record is an unsourceable dispatch, not a dispatch'
  );
  assert.throws(
    () => roster.register(root, registration(missionId, { route_seq: openRecord.seq })),
    /is a "mission-open" record, not a route record/
  );
  assert.strictEqual(readRoster(root).entries.length, 0, 'both refusals wrote nothing');
  assert.strictEqual(dispatchRecords(root).length, 0);

  // And the sourceable one still works.
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  assert.strictEqual(dispatchRecords(root).length, 1);
}

// === no route_seq: registration stands, no dispatch record is invented ======
{
  const { root, missionId } = newTree();
  const entry = roster.register(root, registration(missionId));
  assert.strictEqual(entry.status, 'alive');
  assert.strictEqual(readRoster(root).entries.length, 1);
  assert.strictEqual(
    dispatchRecords(root).length,
    0,
    'with no route record to source from, every field would be the caller\'s own word — so no record is written'
  );
}

// === the review dispatch sources the reviewer half plus the author's class ==
{
  const { root, missionId } = newTree();
  const authorRoute = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: authorRoute.seq }));

  const identity = {
    source_head: 'c'.repeat(40),
    source_tree: 'd'.repeat(40),
    patch_digest: 'sha256:' + 'e'.repeat(64),
    dirty: false,
  };
  const reviewRoute = reserveReview(root, {
    mission_id: missionId,
    author_route_seq: authorRoute.seq,
    author_attempt: 1,
    author_dispatch_seq: dispatchRecords(root)[0].seq,
    artifact_identity: identity,
    reviewer_seat: 'reviewer-claude',
    reviewer_family: 'claude',
    reviewer_model: 'sonnet-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'cross-family',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    replacement_reason: null,
  });

  roster.register(root, {
    seat: 'reviewer-claude',
    task_id: `${missionId}-review`,
    family: 'claude',
    mission_id: missionId,
    route_seq: reviewRoute.seq,
  });

  const reviewDispatch = dispatchRecords(root).find((r) => r.phase === 'review');
  assert.ok(reviewDispatch, 'a reviewer registration naming its review route gets a dispatch record too');
  assert.strictEqual(reviewDispatch.seat, 'reviewer-claude');
  assert.strictEqual(reviewDispatch.family, 'claude');
  assert.strictEqual(reviewDispatch.worker_model, 'sonnet-5');
  assert.strictEqual(reviewDispatch.worker_effort, 'high');
  assert.strictEqual(reviewDispatch.host_model, null);
  assert.strictEqual(reviewDispatch.requested_seat, 'reviewer-claude', "the author route's reserved reviewer");
  // Class, attempt and degraded modes belong to the author route the review
  // route names — they are properties of the attempt being reviewed, so they
  // describe this dispatch as much as the author's.
  assert.strictEqual(reviewDispatch.class, 'expert');
  assert.strictEqual(reviewDispatch.attempt, 1);
  assert.deepStrictEqual(reviewDispatch.degraded_modes, ['gemini_down']);

  // A resume is NOT such a property: it is a fact about one worker's own run.
  // No record anywhere establishes a reviewer's, so the record says so rather
  // than borrowing the author's — which would state one subject's fact under
  // another subject's name, permanently and silently.
  assert.strictEqual(
    reviewDispatch.resumed,
    null,
    "a review dispatch's resumed is unknown, never the author attempt's value"
  );
  assert.notStrictEqual(reviewDispatch.resumed, authorRoute.resumed);

  // And because it is unsourced rather than contradicted, a reviewer that
  // truthfully resumed can still register and say so: the claim stays on the
  // roster entry as fleet bookkeeping, and the audit record keeps its null.
  // (This is also why no one-dispatch-per-route fence lives here: a review
  // route has no resume transition to reserve a successor with, so this
  // re-registration is the only shape a reviewer resume can take.)
  roster.mark(root, `${missionId}-review`, 'dead');
  const resumedEntry = roster.register(root, {
    seat: 'reviewer-claude',
    task_id: `${missionId}-review-resumed`,
    family: 'claude',
    mission_id: missionId,
    route_seq: reviewRoute.seq,
    resumed: true,
  });
  assert.strictEqual(resumedEntry.resumed, true, 'the roster entry keeps the claim');
  const resumedDispatch = dispatchRecords(root).find((r) => r.task_id === `${missionId}-review-resumed`);
  assert.strictEqual(resumedDispatch.resumed, null, 'the ledger record still records only what a record establishes');

  // A reviewer registration whose seat is not the one the review route named.
  assert.throws(
    () =>
      roster.register(root, {
        seat: 'reviewer-degraded-sonnet',
        task_id: `${missionId}-review-2`,
        family: 'claude',
        mission_id: missionId,
        route_seq: reviewRoute.seq,
      }),
    /seat "reviewer-degraded-sonnet" contradicts the route record/
  );
}

// === an unappendable record is refused before the roster write ==============
// The gap between the two writes must hold nothing that could have been
// decided earlier. The ledger's line ceiling is knowable up front, so a
// registration whose record could not be appended is refused before the
// roster write rather than after it — otherwise a lawful input registers a
// seat and then loses its dispatch record permanently, with no re-emit path.
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));

  assert.throws(
    () => roster.register(root, registration(missionId, { task_id: 'x'.repeat(9000), route_seq: route.seq })),
    /over the ledger's 8192-byte line ceiling/
  );
  assert.strictEqual(readRoster(root).entries.length, 0, 'the refusal reached no file at all');
  assert.strictEqual(dispatchRecords(root).length, 0);

  // The same registration at a sane size is unaffected.
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  assert.strictEqual(dispatchRecords(root).length, 1);
}

// === a review dispatch's revision travels with the config it belongs to =====
{
  const { root, missionId } = newTree();
  const authorRoute = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: authorRoute.seq }));
  const identity = {
    source_head: 'c'.repeat(40),
    source_tree: 'd'.repeat(40),
    patch_digest: 'sha256:' + 'e'.repeat(64),
    dirty: false,
  };
  // A review route reserved under a LATER routing config than the author's. It
  // records that config and its digest but no revision number of its own, and
  // the author route's revision belongs to the author's config — so pairing
  // them would state a revision that does not describe the named config.
  const reviewRoute = reserveReview(root, {
    mission_id: missionId,
    author_route_seq: authorRoute.seq,
    author_attempt: 1,
    author_dispatch_seq: dispatchRecords(root)[0].seq,
    artifact_identity: identity,
    reviewer_seat: 'reviewer-claude',
    reviewer_family: 'claude',
    reviewer_model: 'sonnet-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'cross-family',
    routing_config: 'routing-2026-08-07-1.json',
    routing_digest: 'sha256:' + 'f'.repeat(64),
    replacement_reason: null,
  });
  roster.register(root, {
    seat: 'reviewer-claude',
    task_id: `${missionId}-review`,
    family: 'claude',
    mission_id: missionId,
    route_seq: reviewRoute.seq,
  });

  const reviewDispatch = dispatchRecords(root).find((r) => r.phase === 'review');
  assert.strictEqual(reviewDispatch.routing_config, 'routing-2026-08-07-1.json');
  assert.strictEqual(reviewDispatch.routing_digest, 'sha256:' + 'f'.repeat(64));
  assert.strictEqual(
    reviewDispatch.routing_revision,
    null,
    'a revision number describes one config; it does not travel to a different one'
  );
}

// === recordOutcome: requested against actual, every dimension ===============
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  const dispatch = dispatchRecords(root)[0];

  const outcome = roster.recordOutcome(root, {
    dispatch_seq: dispatch.seq,
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: false,
  });

  const onDisk = ledger(root).find((r) => r.kind === 'profile-outcome' && r.seq === outcome.seq);
  assert.ok(onDisk, 'the outcome must be readable back out of the ledger');
  assert.strictEqual(onDisk.correlation_id, missionId);
  assert.strictEqual(onDisk.dispatch_seq, dispatch.seq);
  assert.strictEqual(onDisk.route_seq, route.seq);
  assert.strictEqual(onDisk.class, 'expert');

  assert.strictEqual(onDisk.requested_worker_model, 'gpt-5.6-sol');
  assert.strictEqual(onDisk.requested_worker_effort, 'medium');
  assert.strictEqual(onDisk.actual_worker_model, 'gpt-5.6-sol');
  assert.strictEqual(onDisk.actual_worker_effort, 'medium');
  assert.strictEqual(onDisk.requested_host_model, 'sonnet-5');
  assert.strictEqual(onDisk.actual_host_effort, 'medium');
  // The reviewer half: requested is the author route's reserved capacity;
  // actual stays null until a review route records one.
  assert.strictEqual(onDisk.requested_reviewer_model, 'sonnet-5');
  assert.strictEqual(onDisk.requested_reviewer_effort, 'high');
  assert.strictEqual(onDisk.actual_reviewer_model, null);
  assert.strictEqual(onDisk.actual_reviewer_effort, null);

  assert.strictEqual(onDisk.fallback_used, false);
  assert.strictEqual(onDisk.fallback_reason, null);
  assert.strictEqual(onDisk.runtime_mismatch, false);
  assert.strictEqual(onDisk.safety_refusal, false);
  assert.strictEqual(onDisk.family_requested, 'gpt');
  assert.strictEqual(onDisk.family_attributed, 'gpt');
  assert.strictEqual(onDisk.family_reattributed, false);
  assert.strictEqual(onDisk.review_reresolve_required, false);
  // Closed vocabulary, and nothing in machine/src reports a runtime profile,
  // so the honest level is the one that says so.
  assert.ok(roster.EVIDENCE_LEVELS.includes(onDisk.evidence_level));
  assert.strictEqual(onDisk.evidence_level, 'unknown');

  // One outcome per dispatch; a second is a rewrite of history.
  assert.throws(
    () =>
      roster.recordOutcome(root, {
        dispatch_seq: dispatch.seq,
        fallback_used: false,
        fallback_reason: null,
        host_materially_authored: false,
      }),
    /already has a profile outcome/
  );
}

// === attribution rule 1: a fable seat that fell back ran opus ===============
{
  const { root, missionId } = newTree();
  const route = reserve(root, fableAuthor(missionId));
  roster.register(
    root,
    registration(missionId, { seat: 'executor-fable-low', family: 'claude', route_seq: route.seq })
  );
  const dispatch = dispatchRecords(root)[0];

  const outcome = roster.recordOutcome(root, {
    dispatch_seq: dispatch.seq,
    fallback_used: true,
    fallback_reason: 'fable-5 low returned stop_reason refusal',
    host_materially_authored: false,
  });
  const onDisk = ledger(root).find((r) => r.kind === 'profile-outcome' && r.seq === outcome.seq);

  assert.strictEqual(onDisk.requested_worker_model, 'fable-5');
  assert.strictEqual(onDisk.requested_worker_effort, 'low');
  // The whole point: what ran is the reserved fallback profile, and the
  // actual columns are what telemetry counts.
  assert.strictEqual(onDisk.actual_worker_model, 'opus-5', 'a fable seat that fell back counts as opus execution');
  assert.strictEqual(onDisk.actual_worker_effort, 'high');
  assert.notStrictEqual(onDisk.actual_worker_model, 'fable-5', 'never a fable success');
  assert.strictEqual(onDisk.fallback_used, true);
  assert.strictEqual(onDisk.fallback_reason, 'fable-5 low returned stop_reason refusal');
  assert.strictEqual(onDisk.runtime_mismatch, true, 'actual differs from requested');
  // Both profiles are claude seats, so nothing about the family changed.
  assert.strictEqual(onDisk.family_attributed, 'claude');
  assert.strictEqual(onDisk.family_reattributed, false);
  assert.strictEqual(onDisk.review_reresolve_required, false);
}

// === a fallback that was never reserved never ran ===========================
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId)); // fallback_profile: null
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  const dispatch = dispatchRecords(root)[0];

  assert.throws(
    () =>
      roster.recordOutcome(root, {
        dispatch_seq: dispatch.seq,
        fallback_used: true,
        fallback_reason: 'claimed',
        host_materially_authored: false,
      }),
    /reserved no fallback profile/,
    'the actual profile is chosen among profiles the route reserved, never named by the caller'
  );
  assert.strictEqual(ledger(root).filter((r) => r.kind === 'profile-outcome').length, 0);

  // fallback_reason and fallback_used travel together, both ways.
  assert.throws(
    () =>
      roster.recordOutcome(root, {
        dispatch_seq: dispatch.seq,
        fallback_used: false,
        fallback_reason: 'unused but stated',
        host_materially_authored: false,
      }),
    /"fallback_reason" must be null unless "fallback_used" is true/
  );
}

// === attribution rule 2: a Claude host that authored the diff is claude =====
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  const dispatch = dispatchRecords(root)[0];

  const outcome = roster.recordOutcome(root, {
    dispatch_seq: dispatch.seq,
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: true,
  });
  const onDisk = ledger(root).find((r) => r.kind === 'profile-outcome' && r.seq === outcome.seq);

  assert.strictEqual(onDisk.family_requested, 'gpt', 'the route dispatched a gpt worker');
  assert.strictEqual(onDisk.family_attributed, 'claude', 'the host materially authored, so the family is the host\'s');
  assert.strictEqual(onDisk.family_reattributed, true);
  assert.strictEqual(
    onDisk.review_reresolve_required,
    true,
    'the reserved cross-family reviewer was resolved against gpt and must re-resolve against claude'
  );
  // The worker profile is unchanged by the reattribution — what ran, ran.
  assert.strictEqual(onDisk.actual_worker_model, 'gpt-5.6-sol');
}

// === a dispatch with no host has no host authorship =========================
{
  const { root, missionId } = newTree();
  const route = reserve(root, fableAuthor(missionId));
  roster.register(
    root,
    registration(missionId, { seat: 'executor-fable-low', family: 'claude', route_seq: route.seq })
  );
  const dispatch = dispatchRecords(root)[0];

  assert.throws(
    () =>
      roster.recordOutcome(root, {
        dispatch_seq: dispatch.seq,
        fallback_used: false,
        fallback_reason: null,
        host_materially_authored: true,
      }),
    /records no host/,
    'a native seat has no host to reattribute to'
  );
}

// === safety_refusal and the actual reviewer are read off the ledger =========
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: route.seq }));
  const dispatch = dispatchRecords(root)[0];

  // The review route the author route reserved capacity for — but resolved to
  // a different reviewer, which is what "actual" means on this dimension.
  const identity = {
    source_head: 'c'.repeat(40),
    source_tree: 'd'.repeat(40),
    patch_digest: 'sha256:' + 'e'.repeat(64),
    dirty: false,
  };
  reserveReview(root, {
    mission_id: missionId,
    author_route_seq: route.seq,
    author_attempt: 1,
    author_dispatch_seq: dispatch.seq,
    artifact_identity: identity,
    reviewer_seat: 'reviewer-claude-expert',
    reviewer_family: 'claude',
    reviewer_model: 'opus-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'cross-family',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    replacement_reason: 'reserved reviewer-claude was unavailable',
  });

  // A safety refusal is a fact the route stream already records: the
  // supersession that rerouted this route's unchanged brief.
  const evidence = ledger(root).find((r) => r.kind === 'mission-open');
  supersede(root, {
    mission_id: missionId,
    predecessor_route_seq: route.seq,
    transition: 'same-class-provider-reroute',
    reason: 'safety-refusal',
    evidence_seq: evidence.seq,
    replacement: hostedAuthor(missionId, {
      attempt: 2,
      requested_seat: 'executor-sol-expert',
      resolved_seat: 'executor-gemini',
      author_family: 'gemini',
      worker_model: 'gemini-3.1-pro-preview',
      worker_effort: 'medium',
      host_model: 'sonnet-5',
      host_effort: 'high',
      selection: { candidates_skipped: [], substituted: true, substitution_reason: 'safety refusal on the gpt lane' },
      reserved_review: {
        seat: 'reviewer-claude',
        family: 'claude',
        model: 'sonnet-5',
        effort: 'high',
        independence: 'cross-family',
      },
    }),
  });

  const outcome = roster.recordOutcome(root, {
    dispatch_seq: dispatch.seq,
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: false,
  });
  const onDisk = ledger(root).find((r) => r.kind === 'profile-outcome' && r.seq === outcome.seq);

  assert.strictEqual(onDisk.safety_refusal, true, 'derived from the supersession, never asserted by the caller');
  assert.strictEqual(onDisk.actual_reviewer_model, 'opus-5', 'the reviewer the review route actually resolved');
  assert.strictEqual(onDisk.actual_reviewer_effort, 'high');
  assert.strictEqual(onDisk.requested_reviewer_model, 'sonnet-5', 'against the capacity the author route reserved');
  assert.strictEqual(onDisk.runtime_mismatch, true, 'the reviewer dimension differs too');
}

// === recordOutcome's own refusals ===========================================
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: route.seq }));

  assert.throws(
    () => roster.recordOutcome(root, { dispatch_seq: 9999, fallback_used: false, fallback_reason: null, host_materially_authored: false }),
    /no ledger record at seq 9999/
  );
  assert.throws(
    () => roster.recordOutcome(root, { dispatch_seq: route.seq, fallback_used: false, fallback_reason: null, host_materially_authored: false }),
    /is a "route" record, not a dispatch record/
  );
  assert.throws(
    () => roster.recordOutcome(root, { dispatch_seq: 0, fallback_used: false, fallback_reason: null, sneaky: true, host_materially_authored: false }),
    /unexpected extra key "sneaky"/
  );
  assert.throws(
    () => roster.recordOutcome(root, { dispatch_seq: 0, fallback_used: false, fallback_reason: null }),
    /"host_materially_authored" must be a boolean/
  );
}

// === the review dispatch has no reserved fallback profile to source ========
{
  const { root, missionId } = newTree();
  const authorRoute = reserve(root, hostedAuthor(missionId));
  roster.register(root, registration(missionId, { route_seq: authorRoute.seq }));
  const identity = {
    source_head: 'c'.repeat(40),
    source_tree: 'd'.repeat(40),
    patch_digest: 'sha256:' + 'e'.repeat(64),
    dirty: false,
  };
  const reviewRoute = reserveReview(root, {
    mission_id: missionId,
    author_route_seq: authorRoute.seq,
    author_attempt: 1,
    author_dispatch_seq: dispatchRecords(root)[0].seq,
    artifact_identity: identity,
    reviewer_seat: 'reviewer-claude',
    reviewer_family: 'claude',
    reviewer_model: 'sonnet-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'cross-family',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    replacement_reason: null,
  });
  roster.register(root, {
    seat: 'reviewer-claude',
    task_id: `${missionId}-review`,
    family: 'claude',
    mission_id: missionId,
    route_seq: reviewRoute.seq,
  });
  const reviewDispatch = dispatchRecords(root).find((r) => r.phase === 'review');

  assert.throws(
    () =>
      roster.recordOutcome(root, {
        dispatch_seq: reviewDispatch.seq,
        fallback_used: false,
        fallback_reason: null,
        host_materially_authored: false,
      }),
    /author-phase dispatch/,
    'no record anywhere reserves a reviewer fallback profile, so a reviewer outcome cannot be sourced'
  );
}

// === CLI surface ============================================================
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  const reg = run(ROSTER, ['register', root], registration(missionId, { route_seq: route.seq }));
  assert.strictEqual(reg.status, 0, reg.stderr);
  const dispatch = dispatchRecords(root)[0];

  const out = run(ROSTER, ['record-outcome', root], {
    dispatch_seq: dispatch.seq,
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: false,
  });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(JSON.parse(out.stdout).evidence_level, 'unknown');

  const bad = run(ROSTER, ['record-outcome', root], { dispatch_seq: dispatch.seq });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /"fallback_used" must be a boolean/);

  const help = run(ROSTER, ['--help']);
  assert.match(help.stdout, /record-outcome/);
  assert.match(help.stdout, /never corrupts/);
}

// === the crash between the roster write and the ledger append ===============
// The design fixed the order — roster first, ledger second — so that a crash
// in the gap loses one telemetry datum and corrupts nothing. Proven by making
// the ledger append itself fail: roster.js is re-required with jsonl's
// appendRecord replaced, which is exactly the state a process death between
// the two writes leaves behind.
{
  const { root, missionId } = newTree();
  const route = reserve(root, hostedAuthor(missionId));
  const beforeLedger = fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8');

  const jsonl = require(path.join(SRC, 'jsonl.js'));
  const realAppend = jsonl.appendRecord;
  jsonl.appendRecord = () => {
    throw new Error('simulated crash between the roster write and the ledger append');
  };
  delete require.cache[require.resolve(ROSTER)];
  const crashRoster = require(ROSTER);

  assert.throws(
    () => crashRoster.register(root, registration(missionId, { route_seq: route.seq })),
    /simulated crash/
  );

  jsonl.appendRecord = realAppend;
  delete require.cache[require.resolve(ROSTER)];

  // The roster write survived, intact and usable.
  const rosterFile = readRoster(root);
  assert.strictEqual(rosterFile.schema_version, 1);
  assert.strictEqual(rosterFile.entries.length, 1, 'the registration is durable — the roster write came first');
  assert.strictEqual(rosterFile.entries[0].task_id, `${missionId}-author`);
  assert.strictEqual(rosterFile.entries[0].status, 'alive');

  // The ledger lost the datum and nothing else: byte-identical, still parsing.
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8'),
    beforeLedger,
    'the ledger is untouched — one datum lost, nothing corrupted'
  );
  assert.strictEqual(dispatchRecords(root).length, 0);

  // And the roster still takes the next mutation, so nothing is wedged.
  const hb = require(ROSTER).heartbeat(root, `${missionId}-author`);
  assert.strictEqual(hb.status, 'alive');
}

console.log('test-telemetry: ok');
