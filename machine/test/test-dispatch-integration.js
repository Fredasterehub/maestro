'use strict';

// Slice 2d — proves the documented liaison flow
// (references/dispatch.md: "Dispatching through the route lifecycle") is
// what the machine actually enforces, by driving route.js, roster.js and
// gate.js's artifact identity together end to end. This is integration
// coverage on top of test-route.js's unit-level shape/refusal tests, not a
// replacement for them.
//
// Three pieces of the documented flow are NOT tested here because they are
// not yet real at this base (see the plan correction appended to
// execution-plan.md from this step's consult):
//   - roster.js register does not accept route_seq and appends nothing to
//     the ledger, so the four-way ledger order (route, registration, review
//     route, review) is provable only for its route/review-route/review
//     half; registration's position is timestamp evidence read from
//     roster.json, not a refusal the machine performs — nothing in
//     roster.js consults a route, so nothing there could refuse one out of
//     order.
//   - mission.js close is being rewritten in a parallel step and does not
//     yet compare artifact identities at close; only reserve-review's own
//     refusals (below) are tested here, not close's.
//   - a genuine cross-record identity *mismatch* — a review or close naming
//     an identity that disagrees with one already committed elsewhere — is
//     not expressible at this base: AUTHOR_KEYS carries no artifact
//     identity for a review route to disagree with, and close's own
//     identity comparison belongs to the parallel step. What's tested below
//     is reserve-review's real refusals on the identity object itself: a
//     dirty worktree, and a shape mismatch between an oid field and a
//     digest field.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROUTE = path.join(__dirname, '..', 'src', 'route.js');
const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const ROSTER = path.join(__dirname, '..', 'src', 'roster.js');

const { readRecords } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { reserve, reserveReview, supersede } = require(ROUTE);
const { artifactIdentity } = require(path.join(__dirname, '..', 'src', 'gate.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-dispatch-integration-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

// Every fixture tree here reserves a route, and a route record's family is
// derived from the routing config's seat table — a tree with no table
// establishes no family, which refuses rather than defaulting. So each root is
// initialised, not merely created.
function newTree(...segments) {
  const root = path.join(tmp, ...segments);
  fs.mkdirSync(root, { recursive: true });
  const r = run(path.join(__dirname, '..', 'src', 'routing.js'), ['init', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  return root;
}

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let repoCounter = 0;
// A real git worktree to compute the canonical artifact identity from — the
// same helper gate.js's run-gate uses, per the documented flow's step 6.
function newAuthorWorktree() {
  repoCounter += 1;
  const repo = path.join(tmp, `worktree${repoCounter}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@maestro.invalid');
  git(repo, 'config', 'user.name', 'maestro test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'author work');
  return repo;
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

let missionCounter = 0;
function openMission(root) {
  missionCounter += 1;
  const id = `m${missionCounter}`;
  const r = run(MISSION, ['open', root], { mission_id: id, title: `dispatch integration ${id}`, brief: BRIEF });
  assert.strictEqual(r.status, 0, r.stderr);
  return id;
}

function ledger(root) {
  const { records, errors } = readRecords(path.join(root, 'ledger.jsonl'));
  assert.strictEqual(errors.length, 0, `ledger must be readable: ${JSON.stringify(errors)}`);
  return records;
}

function readRoster(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'roster.json'), 'utf8'));
}

// The seat here was 'executor-sol' when this fixture was written, which the
// r1->r2 Sol split has since turned into an alias of 'executor-sol-expert'.
// routing.js resolves an alias on no read path — it exists so an older config
// keeps validating, and is never routable — so a route record naming one
// establishes no family and is refused. The name is fixture furniture, not
// what any block below asserts; every assertion is on ledger order, recovery
// from disk, replacement-first supersession and the identity refusals, and
// each reads the same string this returns. Do not put the alias back.
function authorInput(missionId, overrides) {
  return {
    mission_id: missionId,
    attempt: 1,
    brief_digest: 'sha256:' + 'a'.repeat(64),
    task_class: 'standard',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    routing_revision: 6,
    requested_seat: 'executor-sol-expert',
    resolved_seat: 'executor-sol-expert',
    author_family: 'gpt',
    worker_model: 'gpt-5.6-sol',
    worker_effort: 'high',
    host_model: 'sonnet-5',
    host_effort: 'high',
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
    degraded_modes: [],
    notices: [],
    ...overrides,
  };
}

function reviewInput(missionId, authorRoute, identity, overrides) {
  return {
    mission_id: missionId,
    author_route_seq: authorRoute.seq,
    author_attempt: authorRoute.attempt,
    author_dispatch_seq: 0,
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
    ...overrides,
  };
}

// === the documented flow, end to end, ledger-order proof ====================
// author route -> roster registration -> artifact identity -> review route ->
// review dispatch (second registration), exactly as
// "Dispatching through the route lifecycle" in dispatch.md describes it.
{
  const root = newTree('flow', '.maestro');
  const m = openMission(root);

  // 1-3: seat picked, reviewer resolved (fixed in this fixture), route reserved
  // before any spawn.
  const authorRoute = reserve(root, authorInput(m));
  assert.strictEqual(authorRoute.kind, 'route');
  assert.strictEqual(authorRoute.phase, 'author');

  // 4-5: spawn (simulated), then roster registration. roster.js register
  // carries no route_seq yet (Slice 2c) and appends nothing to the ledger
  // (Slice 7a), so nothing in the machine could refuse a register call that
  // arrived before the route — the timestamp check below is evidence this
  // test's own calls landed in the documented order, never a proof that an
  // out-of-order call would be refused.
  const authorReg = run(ROSTER, ['register', root], {
    seat: 'executor-sol-expert',
    task_id: `${m}-author`,
    family: 'gpt',
    mission_id: m,
  });
  assert.strictEqual(authorReg.status, 0, authorReg.stderr);
  const authorEntry = JSON.parse(authorReg.stdout);
  assert.ok(
    new Date(authorEntry.spawned_ts).getTime() >= new Date(authorRoute.ts).getTime(),
    'roster registration must be timestamped at or after the author route it follows'
  );

  // 6: author completes; compute the artifact identity from the real
  // worktree, then reserve the review route before any review dispatch.
  const worktree = newAuthorWorktree();
  const identity = artifactIdentity(worktree);
  assert.strictEqual(identity.dirty, false);

  const reviewRoute = reserveReview(root, reviewInput(m, authorRoute, identity));
  assert.strictEqual(reviewRoute.kind, 'route');
  assert.strictEqual(reviewRoute.phase, 'review');
  assert.deepStrictEqual(reviewRoute.artifact_identity, identity);

  // Review dispatch: a second registration, for the reviewer seat, only after
  // the review route naming the reviewed identity is durable.
  const reviewReg = run(ROSTER, ['register', root], {
    seat: 'reviewer-claude',
    task_id: `${m}-review`,
    family: 'claude',
    mission_id: m,
  });
  assert.strictEqual(reviewReg.status, 0, reviewReg.stderr);
  const reviewEntry = JSON.parse(reviewReg.stdout);
  assert.ok(
    new Date(reviewEntry.spawned_ts).getTime() >= new Date(reviewRoute.ts).getTime(),
    'review dispatch must be timestamped at or after the review route it reviews under'
  );

  // The ledger-provable half of the order: author route strictly precedes the
  // review route that names it, by seq and by timestamp — re-read from
  // ledger.jsonl itself, not from the reserve()/reserveReview() return
  // values still in scope, so this proves what is actually on disk.
  const flowLedger = ledger(root);
  const ledgerAuthorRoute = flowLedger.find((r) => r.kind === 'route' && r.seq === authorRoute.seq);
  const ledgerReviewRoute = flowLedger.find((r) => r.kind === 'route' && r.seq === reviewRoute.seq);
  assert.ok(ledgerAuthorRoute && ledgerReviewRoute, 'both routes must be readable back out of ledger.jsonl');
  assert.strictEqual(ledgerAuthorRoute.phase, 'author');
  assert.strictEqual(ledgerReviewRoute.phase, 'review');
  assert.strictEqual(ledgerReviewRoute.author_route_seq, ledgerAuthorRoute.seq);
  assert.ok(
    ledgerReviewRoute.seq > ledgerAuthorRoute.seq,
    'on disk, the review route must follow the author route it names'
  );
  assert.ok(
    new Date(ledgerReviewRoute.ts).getTime() >= new Date(ledgerAuthorRoute.ts).getTime(),
    'on disk, the review route must be timestamped at or after the author route'
  );

  // The roster half of the order: both registrations exist, in the right
  // order, findable through roster.json alone.
  const roster = readRoster(root);
  const authorRosterEntry = roster.entries.find((e) => e.task_id === `${m}-author`);
  const reviewRosterEntry = roster.entries.find((e) => e.task_id === `${m}-review`);
  assert.ok(authorRosterEntry && reviewRosterEntry, 'both registrations must be findable in roster.json');
  assert.ok(
    new Date(reviewRosterEntry.spawned_ts).getTime() >= new Date(authorRosterEntry.spawned_ts).getTime(),
    'the review dispatch registers no earlier than the author dispatch'
  );
}

// === recovery: both topologies reconstruct from disk alone ==================
// A fresh read of ledger.jsonl and roster.json — no reference to the route or
// registration objects the flow above produced — must be enough to rebuild
// which route belongs to which mission and which review route reviews it.
{
  const root = newTree('recovery', '.maestro');
  const m = openMission(root);

  const authorRoute = reserve(root, authorInput(m));
  const authorReg = run(ROSTER, ['register', root], {
    seat: 'executor-sol-expert',
    task_id: `${m}-author`,
    family: 'gpt',
    mission_id: m,
  });
  assert.strictEqual(authorReg.status, 0, authorReg.stderr);
  const worktree = newAuthorWorktree();
  const identity = artifactIdentity(worktree);
  const reviewRoute = reserveReview(root, reviewInput(m, authorRoute, identity));
  const reviewReg = run(ROSTER, ['register', root], {
    seat: 'reviewer-claude',
    task_id: `${m}-review`,
    family: 'claude',
    mission_id: m,
  });
  assert.strictEqual(reviewReg.status, 0, reviewReg.stderr);

  // A cold read: everything below is derived from freshly-parsed disk state,
  // never from authorRoute/reviewRoute above.
  const records = ledger(root);
  const roster = readRoster(root);

  const recoveredAuthor = records.find(
    (r) => r.kind === 'route' && r.phase === 'author' && r.mission_id === m && r.predecessor === null
  );
  assert.ok(recoveredAuthor, 'the author route must be reconstructable from the ledger alone');

  const recoveredReview = records.find(
    (r) => r.kind === 'route' && r.phase === 'review' && r.author_route_seq === recoveredAuthor.seq
  );
  assert.ok(recoveredReview, 'the review route must be reconstructable by following author_route_seq');
  assert.strictEqual(recoveredReview.mission_id, m);
  assert.deepStrictEqual(recoveredReview.artifact_identity, identity);

  const recoveredAuthorReg = roster.entries.find((e) => e.mission_id === m && e.seat === 'executor-sol-expert');
  const recoveredReviewReg = roster.entries.find((e) => e.mission_id === m && e.seat === 'reviewer-claude');
  assert.ok(recoveredAuthorReg && recoveredReviewReg, 'both dispatches must be reconstructable from roster.json alone');
  assert.strictEqual(recoveredAuthorReg.family, 'gpt');
  assert.strictEqual(recoveredReviewReg.family, 'claude');
}

// === supersession is replacement-first =======================================
// supersede() must make the replacement route durable before the
// route-superseded record that points at it — provable here by seq order,
// since the two writes happen inside one call and cannot literally be
// interrupted from a test, but the order they land in is exactly what a crash
// between them would leave behind: an orphan reservation, never a dangling
// pointer.
{
  const root = newTree('supersede', '.maestro');
  const m = openMission(root);
  const authorRoute = reserve(root, authorInput(m));

  const evidence = ledger(root).find((r) => r.kind === 'mission-open' && r.mission_id === m);
  const out = supersede(root, {
    mission_id: m,
    predecessor_route_seq: authorRoute.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: evidence.seq,
    replacement: authorInput(m, { requested_seat: authorRoute.resolved_seat, resolved_seat: 'executor-gemini', author_family: 'gemini', worker_model: 'gemini-3.1-pro', selection: { candidates_skipped: [], substituted: true, substitution_reason: 'lane failure mid-dispatch' }, attempt: 2 }),
  });

  assert.ok(out.route.seq < out.superseded.seq, 'the replacement route must be durable before the record that points at it');
  assert.strictEqual(out.superseded.predecessor_route_seq, authorRoute.seq);
  assert.strictEqual(out.superseded.replacement_route_seq, out.route.seq);

  // Reading the ledger as of the moment right after the replacement landed
  // (before the supersession record) would show a valid, orphaned
  // reservation — nothing yet points at it, and nothing is broken by that.
  const asOfReplacement = ledger(root).filter((r) => r.seq <= out.route.seq);
  const supersessionAtThatPoint = asOfReplacement.find(
    (r) => r.kind === 'route-superseded' && r.predecessor_route_seq === authorRoute.seq
  );
  assert.strictEqual(supersessionAtThatPoint, undefined, 'the supersession record must not exist before the replacement it names');
}

// === reserve-review's own identity refusals: dirty and shape-mismatched ====
// Not a cross-record mismatch test (see the file header) — this proves the
// two refusals reserve-review itself performs on the identity object: a
// dirty worktree's reported state disagreeing with its own committed HEAD,
// and a digest field carrying an oid instead of a digest. Both are real
// refusals at this base; neither compares against a previously-recorded
// identity, because nothing upstream of reserve-review records one yet.
{
  const root = newTree('identity', '.maestro');
  const m = openMission(root);
  const authorRoute = reserve(root, authorInput(m));

  const worktree = newAuthorWorktree();
  const clean = artifactIdentity(worktree);
  assert.strictEqual(clean.dirty, false);

  // A clean identity is accepted.
  const okReview = reserveReview(root, reviewInput(m, authorRoute, clean));
  assert.strictEqual(okReview.phase, 'review');

  // Dirtying the same worktree after the fact — its reported identity no
  // longer matches a durable, reviewable artifact.
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo\nthree\n');
  const dirty = artifactIdentity(worktree);
  assert.strictEqual(dirty.dirty, true);
  assert.strictEqual(dirty.source_head, clean.source_head, 'HEAD is unchanged; only the working tree drifted from it');

  assert.throws(
    () => reserveReview(root, reviewInput(m, authorRoute, dirty, { author_dispatch_seq: 1 })),
    /may not name a dirty worktree/,
    'a review naming a dirty worktree must be refused'
  );

  // A shape mismatch — an oid where a digest belongs — is refused the same
  // way: identity fields are never interchangeable, so a caller that
  // confuses them is refused rather than silently accepted.
  assert.throws(
    () =>
      reserveReview(
        root,
        reviewInput(m, authorRoute, { ...clean, patch_digest: clean.source_head }, { author_dispatch_seq: 2 })
      ),
    /patch_digest.*must be a sha256 digest/,
    'a digest field carrying a bare oid must be refused, never silently accepted as equivalent'
  );
}

console.log('test-dispatch-integration: ok');
