'use strict';

// Shared close-chain fixture (not a test file — run-all.js ignores it).
//
// The close contract derives everything from records, so "a closed mission"
// in a test needs the real chain: a git repo whose work branch is the
// artifact, an author-phase route, a review-phase route binding the computed
// identity, a green gate run in that same worktree, a landed result, and a
// close proven against the repo. This module builds those pieces so every
// test file that merely needs a done mission does not carry five copies.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const MISSION = path.join(SRC, 'mission.js');
const GATE = path.join(SRC, 'gate.js');

const { reserve, reserveReview } = require(path.join(SRC, 'route.js'));
const { register, mark } = require(path.join(SRC, 'roster.js'));
const { readRecords } = require(path.join(SRC, 'jsonl.js'));
const { artifactIdentity } = require(GATE);
const routing = require(path.join(SRC, 'routing.js'));

const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
const ROUTING_CONFIG = 'routing-2026-08-06-2.json';

function runNode(script, args, stdin) {
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

// A review route derives its reviewer's family from the routing config's seat
// table, so a tree that carries this fixture's chain must carry a routing
// table. Called once per test tree, here rather than copied into every file
// that uses the fixture. The fixture's reviewer seat is a real config seat, so
// the derivation agrees with what the chain asserts.
function initRouting(root) {
  fs.mkdirSync(root, { recursive: true });
  return routing.init(root);
}

let repoCounter = 0;

// A repo with a base commit on main and one commit of unique content on a
// work branch — HEAD left on work, so artifactIdentity(repo) is the artifact.
function newWorkRepo(dir) {
  repoCounter += 1;
  const repo = path.join(dir, `close-repo-${repoCounter}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@maestro.invalid');
  git(repo, 'config', 'user.name', 'maestro test');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo, 'work.txt'), `work ${repoCounter}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `work ${repoCounter}`);
  return repo;
}

// Lands work onto main: 'merge' (--no-ff, proven later by containment),
// 'squash' (a new commit object, proven later by patch identity), or 'none'.
function land(repo, mode) {
  if (mode === 'none') return;
  git(repo, 'checkout', '-q', 'main');
  if (mode === 'merge') {
    git(repo, 'merge', '-q', '--no-ff', '-m', 'land work', 'work');
  } else if (mode === 'squash') {
    git(repo, 'merge', '-q', '--squash', 'work');
    git(repo, 'commit', '-q', '-m', 'squash-land work');
  } else {
    throw new Error(`unknown landing mode "${mode}"`);
  }
}

function authorRouteInput(missionId, overrides) {
  return {
    mission_id: missionId,
    attempt: 1,
    brief_digest: DIGEST_A,
    task_class: 'expert',
    routing_config: ROUTING_CONFIG,
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

function reviewRouteInput(missionId, authorRouteSeq, authorDispatchSeq, identity, overrides) {
  return {
    mission_id: missionId,
    author_route_seq: authorRouteSeq,
    author_attempt: 1,
    author_dispatch_seq: authorDispatchSeq,
    artifact_identity: identity,
    reviewer_seat: 'reviewer-degraded-sonnet',
    reviewer_family: 'claude',
    reviewer_model: 'sonnet-5',
    reviewer_effort: 'high',
    reviewer_host_model: null,
    reviewer_host_effort: null,
    independence: 'degraded-path',
    routing_config: ROUTING_CONFIG,
    routing_digest: DIGEST_B,
    replacement_reason: null,
    ...overrides,
  };
}

// Reserves the author route, then the review route binding the identity.
// Until roster.js's dispatch-record writer ships, the author dispatch seq is
// stood in by the author route's own seq (a same-mission durable record).
function reserveChain(root, missionId, identity, opts = {}) {
  const author = reserve(root, authorRouteInput(missionId, opts.author));
  const review = reserveReview(
    root,
    reviewRouteInput(missionId, author.seq, author.seq, identity, opts.review)
  );
  return { authorSeq: author.seq, reviewSeq: review.seq, author, review };
}

function recordReview(root, missionId, input) {
  return runNode(MISSION, ['record-review', root, missionId], input);
}

let dispatchCounter = 0;

// Registers a real "dispatch" ledger record against an already-reserved
// route (roster.js register is its sole writer — §16.1), then immediately
// retires the roster entry so the same seat name is free for the fixture's
// next attempt: a test tree reuses a handful of seat names across many
// independent lineages, and roster.js refuses a second live entry under one
// name. Returns the dispatch record's own ledger seq — the value close's
// dispatch/winning_* keys now name, not the route's seq that stood in for it
// before this writer existed.
function registerDispatch(root, missionId, routeSeq, seat, family) {
  dispatchCounter += 1;
  const taskId = `close-fixture-dispatch-${dispatchCounter}`;
  register(root, { seat, task_id: taskId, family, mission_id: missionId, route_seq: routeSeq });
  mark(root, taskId, 'finished');
  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const dispatches = records.filter(
    (r) => r.kind === 'dispatch' && r.route_seq === routeSeq && r.mission_id === missionId
  );
  assert.ok(dispatches.length > 0, `fixture dispatch must be recorded for route ${routeSeq}`);
  return dispatches[dispatches.length - 1].seq;
}

// Records the approve verdict close requires, bound to the chain's review
// route and the reviewed identity.
function recordApprove(root, missionId, chain, identity, dispatchSeq) {
  const r = recordReview(root, missionId, {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: dispatchSeq === undefined ? chain.reviewSeq : dispatchSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(r.status, 0, `fixture approve must record: ${r.stderr}`);
  return JSON.parse(r.stdout).ledger_seq;
}

function runGreenGate(root, missionId, gateId, repo) {
  const r = runNode(GATE, ['run-gate', '--worktree', repo, root, missionId, gateId, '--', 'true']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.exit_code, 0, 'fixture gate must pass');
  return out.ledger_seq;
}

function closeInputOf(chain, gateSeq, overrides) {
  return {
    author_route_seq: chain.authorSeq,
    author_dispatch_seq: chain.authorSeq,
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: chain.authorSeq,
    winning_review_dispatch_seq: chain.reviewSeq,
    ...overrides,
  };
}

function runClose(root, missionId, repo, input) {
  return runNode(MISSION, ['close', '--repo', repo, root, missionId], input);
}

// The one-shot: review -> recorded approve -> gate -> land -> close, on an
// already-open mission. opts: { dir (required scratch dir), landing:
// 'merge'|'squash' (default 'merge'), gateId (default 'tests'), author,
// review } — returns every seq.
function closeMissionFully(root, missionId, opts) {
  const landing = opts.landing === undefined ? 'merge' : opts.landing;
  const repo = newWorkRepo(opts.dir);
  const identity = artifactIdentity(repo);
  const chain = reserveChain(root, missionId, identity, opts);
  recordApprove(root, missionId, chain, identity);
  const gateSeq = runGreenGate(root, missionId, opts.gateId === undefined ? 'tests' : opts.gateId, repo);
  land(repo, landing);
  const input = closeInputOf(chain, gateSeq);
  const closed = runClose(root, missionId, repo, input);
  assert.strictEqual(closed.status, 0, `fixture close must succeed: ${closed.stderr}`);
  return { repo, identity, chain, gateSeq, input, result: JSON.parse(closed.stdout) };
}

module.exports = {
  initRouting,
  newWorkRepo,
  land,
  authorRouteInput,
  reviewRouteInput,
  reserveChain,
  recordReview,
  recordApprove,
  registerDispatch,
  runGreenGate,
  closeInputOf,
  runClose,
  closeMissionFully,
  artifactIdentity,
  ROUTING_CONFIG,
};
