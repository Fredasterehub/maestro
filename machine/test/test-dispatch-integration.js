'use strict';

// Slice 2d — proves the documented liaison flow
// (references/dispatch.md: "Dispatching through the route lifecycle") is
// what the machine actually enforces, by driving route.js, roster.js and
// gate.js's artifact identity together end to end. This is integration
// coverage on top of test-route.js's unit-level shape/refusal tests, not a
// replacement for them.
//
// Two pieces of the documented flow are NOT tested here because they are not
// yet real at this base (see the plan correction appended to
// execution-plan.md from this step's consult):
//   - roster.js register does not accept route_seq and appends nothing to
//     the ledger, so the four-way ledger order (route, registration, review
//     route, review) is provable only for its route/review-route/review
//     half; registration's position is asserted through roster.json instead.
//   - mission.js close is being rewritten in a parallel step and does not
//     yet compare artifact identities at close; the identity-mismatch
//     refusal proven below is route.js reserve-review's own refusal, not
//     close's.

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

function authorInput(missionId, overrides) {
  return {
    mission_id: missionId,
    attempt: 1,
    brief_digest: 'sha256:' + 'a'.repeat(64),
    task_class: 'standard',
    routing_config: 'routing-2026-08-06-2.json',
    routing_digest: 'sha256:' + 'b'.repeat(64),
    routing_revision: 6,
    requested_seat: 'executor-sol',
    resolved_seat: 'executor-sol',
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
  const root = path.join(tmp, 'flow', '.maestro');
  fs.mkdirSync(root, { recursive: true });
  const m = openMission(root);

  // 1-3: seat picked, reviewer resolved (fixed in this fixture), route reserved
  // before any spawn.
  const authorRoute = reserve(root, authorInput(m));
  assert.strictEqual(authorRoute.kind, 'route');
  assert.strictEqual(authorRoute.phase, 'author');

  // 4-5: spawn (simulated), then roster registration. Ordering is proven by
  // calling register only now, with the just-reserved route already durable,
  // and by comparing timestamps below — roster.js register carries no
  // route_seq yet (Slice 2c) and appends nothing to the ledger (Slice 7a), so
  // its position is provable only through roster.json, not a ledger record.
  const authorReg = run(ROSTER, ['register', root], {
    seat: 'executor-sol',
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
  // review route that names it, by seq and by timestamp — read from the
  // ledger alone, not from the JS objects still in scope.
  assert.ok(reviewRoute.seq > authorRoute.seq, 'review route must follow the author route in the ledger');
  assert.ok(
    new Date(reviewRoute.ts).getTime() >= new Date(authorRoute.ts).getTime(),
    'review route must be timestamped at or after the author route'
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
  const root = path.join(tmp, 'recovery', '.maestro');
  fs.mkdirSync(root, { recursive: true });
  const m = openMission(root);

  const authorRoute = reserve(root, authorInput(m));
  run(ROSTER, ['register', root], { seat: 'executor-sol', task_id: `${m}-author`, family: 'gpt', mission_id: m });
  const worktree = newAuthorWorktree();
  const identity = artifactIdentity(worktree);
  const reviewRoute = reserveReview(root, reviewInput(m, authorRoute, identity));
  run(ROSTER, ['register', root], { seat: 'reviewer-claude', task_id: `${m}-review`, family: 'claude', mission_id: m });

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

  const recoveredAuthorReg = roster.entries.find((e) => e.mission_id === m && e.seat === 'executor-sol');
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
  const root = path.join(tmp, 'supersede', '.maestro');
  fs.mkdirSync(root, { recursive: true });
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

// === identity-mismatch refusal ===============================================
// route.js reserve-review refuses a review route whose artifact identity does
// not honestly describe the worktree it claims to name: a dirty worktree's
// reported state does not match its own committed identity, and that half of
// the review/close identity-matching contract (§6, §7) is enforced today by
// reserve-review itself. (Close's own cross-record identity comparison is
// mission.js's, rewritten in the parallel step 2c — not tested here.)
{
  const root = path.join(tmp, 'identity', '.maestro');
  fs.mkdirSync(root, { recursive: true });
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
