'use strict';

// Slice 7c — friction.js's computeRates widened past the friction kinds
// alone: by_class (joined through the dispatch, route, review-outcome and
// mission-close streams 7a/7b landed), the two first-pass measures, the
// fable-low rescue metrics, and the (class, seat) experiment-proposal
// threshold. Driven through the real writers (route.js, roster.js,
// mission.js), never through hand-rolled records shaped by guesswork, for
// the three fixtures the mission's gate names explicitly; a handful of
// hand-appended ledger records cover the edge cases that would otherwise
// need a full git+gate cycle per case (the 20-close threshold in particular).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const ROUTE = path.join(SRC, 'route.js');
const ROSTER = path.join(SRC, 'roster.js');
const MISSION = path.join(SRC, 'mission.js');
const GATE = path.join(SRC, 'gate.js');

const { reserve, reserveReview, CLASS_ORDER } = require(ROUTE);
const { register, mark, recordOutcome } = require(ROSTER);
const { readRecords, appendRecord } = require(path.join(SRC, 'jsonl.js'));
const { artifactIdentity } = require(GATE);
const { openMission } = require(MISSION);
const routing = require(path.join(SRC, 'routing.js'));
const { computeRates } = require(path.join(SRC, 'friction.js'));

const ROUTING_CONFIG = 'routing-2026-08-06-2.json';
const DIGEST_A = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);
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

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let repoCounter = 0;
function newWorkRepo(dir) {
  repoCounter += 1;
  const repo = path.join(dir, `repo-${repoCounter}`);
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

function land(repo) {
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'land work', 'work');
}

function runNode(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

function newTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-friction-rates-'));
  const root = path.join(tmp, '.maestro');
  fs.mkdirSync(root, { recursive: true });
  routing.init(root);
  return { tmp, root };
}

let missionCounter = 0;
function open(root) {
  missionCounter += 1;
  const missionId = `m${missionCounter}`;
  openMission(root, { mission_id: missionId, title: `friction-rates ${missionId}`, brief: BRIEF });
  return missionId;
}

// Real "dispatch" ledger record (roster.js register, §16.1), returned by its
// own ledger seq — the value close's dispatch/winning_* keys name, never the
// route's seq standing in for it.
let dispatchCounter = 0;
function registerDispatch(root, missionId, routeSeq, seat, family) {
  dispatchCounter += 1;
  const taskId = `friction-rates-dispatch-${dispatchCounter}`;
  register(root, { seat, task_id: taskId, family, mission_id: missionId, route_seq: routeSeq });
  mark(root, taskId, 'finished');
  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const dispatches = records.filter((r) => r.kind === 'dispatch' && r.route_seq === routeSeq && r.mission_id === missionId);
  assert.ok(dispatches.length > 0, `dispatch record must land for route ${routeSeq}`);
  return dispatches[dispatches.length - 1].seq;
}

function recordReview(root, missionId, input) {
  const r = runNode(MISSION, ['record-review', root, missionId], input);
  assert.strictEqual(r.status, 0, `record-review must succeed: ${r.stderr}`);
  return JSON.parse(r.stdout).ledger_seq;
}

function runGreenGate(root, missionId, repo) {
  const r = runNode(GATE, ['run-gate', '--worktree', repo, root, missionId, 'tests', '--', 'true']);
  assert.strictEqual(r.status, 0, `gate must pass: ${r.stderr}`);
  return JSON.parse(r.stdout).ledger_seq;
}

function runClose(root, missionId, repo, input) {
  const r = runNode(MISSION, ['close', '--repo', repo, root, missionId], input);
  assert.strictEqual(r.status, 0, `close must succeed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function claudeAuthorInput(missionId, attempt, overrides) {
  return {
    mission_id: missionId,
    attempt,
    brief_digest: DIGEST_A,
    task_class: 'mechanical',
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

function claudeReviewInput(missionId, authorRoute, authorDispatchSeq, identity, overrides) {
  return {
    mission_id: missionId,
    author_route_seq: authorRoute.seq,
    author_attempt: authorRoute.attempt,
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

// === register-through-close, single attempt =================================
// The gate's own fixture: one author dispatch, one review dispatch, a clean
// approve, a green gate, a close — by_class must read {dispatched:1,
// closed:1, attempt_first_pass:1} for the class dispatched, mission_first_pass
// alongside it since attempt 1 also spent zero revise rounds.
{
  const { tmp, root } = newTree();
  const missionId = open(root);

  const author = reserve(root, claudeAuthorInput(missionId, 1));
  const authorDispatchSeq = registerDispatch(root, missionId, author.seq, 'executor-claude', 'claude');

  const repo = newWorkRepo(tmp);
  const identity = artifactIdentity(repo);
  const review = reserveReview(root, claudeReviewInput(missionId, author, authorDispatchSeq, identity));
  const reviewDispatchSeq = registerDispatch(root, missionId, review.seq, 'reviewer-degraded-sonnet', 'claude');

  recordReview(root, missionId, {
    review_route_seq: review.seq,
    review_dispatch_seq: reviewDispatchSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });

  const gateSeq = runGreenGate(root, missionId, repo);
  land(repo);
  runClose(root, missionId, repo, {
    author_route_seq: author.seq,
    author_dispatch_seq: authorDispatchSeq,
    review_route_seq: review.seq,
    review_dispatch_seq: reviewDispatchSeq,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: authorDispatchSeq,
    winning_review_dispatch_seq: reviewDispatchSeq,
  });

  const rates = computeRates(root);
  assert.deepStrictEqual(rates.by_class.mechanical, {
    dispatched: 1,
    closed: 1,
    mission_first_pass: 1,
    attempt_first_pass: 1,
    degraded_path_closes: 1,
  });
}

// === fable-low fallback, attributed to opus ==================================
// executor-fable-low requests fable-5/low; the worker refuses and the
// recorded opus-5/high fallback carries the dispatch instead
// (roster.js recordOutcome, §16.2). computeRates must count this as a
// fable-low fallback/refusal/rescue, and the profile-outcome record itself
// must attribute the actual execution to opus, never to a "fable success."
{
  const { tmp, root } = newTree();
  const missionId = open(root);

  const author = reserve(
    root,
    claudeAuthorInput(missionId, 1, {
      task_class: 'expert',
      requested_seat: 'executor-fable-low',
      resolved_seat: 'executor-fable-low',
      worker_model: 'fable-5',
      worker_effort: 'low',
      fallback_profile: { model: 'opus-5', effort: 'high' },
      reserved_review: {
        seat: 'reviewer-degraded-opus',
        family: 'claude',
        model: 'opus-5',
        effort: 'medium',
        independence: 'degraded-path',
      },
    })
  );
  const authorDispatchSeq = registerDispatch(root, missionId, author.seq, 'executor-fable-low', 'claude');

  const outcome = recordOutcome(root, {
    dispatch_seq: authorDispatchSeq,
    fallback_used: true,
    fallback_reason: 'worker reported stop_reason refusal; recorded opus fallback engaged',
    host_materially_authored: false,
  });
  assert.strictEqual(outcome.requested_worker_model, 'fable-5');
  assert.strictEqual(outcome.requested_worker_effort, 'low');
  assert.strictEqual(outcome.actual_worker_model, 'opus-5', 'a fable seat that fell back to opus is opus execution');
  assert.strictEqual(outcome.actual_worker_effort, 'high');
  assert.strictEqual(outcome.fallback_used, true);

  const repo = newWorkRepo(tmp);
  const identity = artifactIdentity(repo);
  const review = reserveReview(
    root,
    claudeReviewInput(missionId, author, authorDispatchSeq, identity, {
      reviewer_seat: 'reviewer-degraded-opus',
      reviewer_model: 'opus-5',
      reviewer_effort: 'medium',
    })
  );
  const reviewDispatchSeq = registerDispatch(root, missionId, review.seq, 'reviewer-degraded-opus', 'claude');

  recordReview(root, missionId, {
    review_route_seq: review.seq,
    review_dispatch_seq: reviewDispatchSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });

  const gateSeq = runGreenGate(root, missionId, repo);
  land(repo);
  runClose(root, missionId, repo, {
    author_route_seq: author.seq,
    author_dispatch_seq: authorDispatchSeq,
    review_route_seq: review.seq,
    review_dispatch_seq: reviewDispatchSeq,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: authorDispatchSeq,
    winning_review_dispatch_seq: reviewDispatchSeq,
  });

  const rates = computeRates(root);
  assert.strictEqual(rates.rescue.fable_low_dispatches, 1);
  assert.strictEqual(rates.rescue.fallback_count, 1);
  assert.strictEqual(rates.rescue.fallback_rate, 1);
  assert.strictEqual(rates.rescue.refusal_count, 1);
  assert.strictEqual(rates.rescue.refusal_rate, 1);
  assert.strictEqual(rates.rescue.rescued_count, 1);
  assert.strictEqual(rates.rescue.rescue_rate, 1, 'opus’s fallback dispatch is the one the mission actually closed on');
  assert.strictEqual(typeof rates.rescue.time_to_rescue_ms, 'number');
  assert.ok(rates.rescue.time_to_rescue_ms >= 0, 'a real elapsed time between the dispatch and the close it won, never a guess');
  assert.strictEqual(rates.rescue.convergence_count, 0);
  assert.strictEqual(rates.rescue.convergence_fraction, 0);
  // Never approximated from a proxy: no writer in machine/src records a cost.
  assert.strictEqual(rates.rescue.incremental_cost_per_rescue, null);
}

// === second-attempt clean close: attempt_first_pass ≠ mission_first_pass ====
// Attempt 1 is reviewed and revised (no supersession needed — a revise
// verdict alone gives classify() a resolvable "revised" fate for both of
// attempt 1's dispatches). Attempt 2 is a fresh author route, reviewed and
// approved with no revise round of its own, and wins the close. Its OWN
// review history is clean (attempt_first_pass), but the mission spent a
// revise round on attempt 1 and the winner was not the mission's first
// attempt (mission_first_pass) — the two measures must read differently on
// the very same close, which is the whole point of naming them apart.
{
  const { tmp, root } = newTree();
  const missionId = open(root);

  const author1 = reserve(root, claudeAuthorInput(missionId, 1, { task_class: 'standard' }));
  const authorDispatch1 = registerDispatch(root, missionId, author1.seq, 'executor-claude', 'claude');
  const repo1 = newWorkRepo(tmp);
  const identity1 = artifactIdentity(repo1);
  const review1 = reserveReview(root, claudeReviewInput(missionId, author1, authorDispatch1, identity1));
  const reviewDispatch1 = registerDispatch(root, missionId, review1.seq, 'reviewer-degraded-sonnet', 'claude');
  recordReview(root, missionId, {
    review_route_seq: review1.seq,
    review_dispatch_seq: reviewDispatch1,
    verdict: 'revise',
    artifact_identity: identity1,
  });

  const author2 = reserve(root, claudeAuthorInput(missionId, 2, { task_class: 'standard' }));
  const authorDispatch2 = registerDispatch(root, missionId, author2.seq, 'executor-claude', 'claude');
  const repo2 = newWorkRepo(tmp);
  const identity2 = artifactIdentity(repo2);
  const review2 = reserveReview(root, claudeReviewInput(missionId, author2, authorDispatch2, identity2));
  const reviewDispatch2 = registerDispatch(root, missionId, review2.seq, 'reviewer-degraded-sonnet', 'claude');
  recordReview(root, missionId, {
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    verdict: 'approve',
    artifact_identity: identity2,
  });

  const gateSeq = runGreenGate(root, missionId, repo2);
  land(repo2);
  runClose(root, missionId, repo2, {
    author_route_seq: author2.seq,
    author_dispatch_seq: authorDispatch2,
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: authorDispatch2,
    winning_review_dispatch_seq: reviewDispatch2,
  });

  const rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.dispatched, 2, 'both attempts dispatched an author');
  assert.strictEqual(rates.by_class.standard.closed, 1);
  assert.strictEqual(rates.by_class.standard.attempt_first_pass, 1, 'the winning attempt (2) had zero revise rounds of its own');
  assert.strictEqual(
    rates.by_class.standard.mission_first_pass,
    0,
    'the mission spent a revise round on attempt 1, and its winner was not attempt 1 — mission_first_pass is a different, stricter fact'
  );
}

// === zero population: every rate absent, never approximated to zero ==========
{
  const { root } = newTree();
  const rates = computeRates(root);
  for (const cls of CLASS_ORDER) {
    assert.deepStrictEqual(rates.by_class[cls], {
      dispatched: 0,
      closed: 0,
      mission_first_pass: 0,
      attempt_first_pass: 0,
      degraded_path_closes: 0,
    });
  }
  assert.deepStrictEqual(rates.rescue, {
    fable_low_dispatches: 0,
    fallback_count: 0,
    fallback_rate: null,
    refusal_count: 0,
    refusal_rate: null,
    rescued_count: 0,
    rescue_rate: null,
    time_to_rescue_ms: null,
    convergence_count: 0,
    convergence_fraction: null,
    incremental_cost_per_rescue: null,
  });
  assert.deepStrictEqual(rates.experiment_proposals, []);
}

// === 20 closes in one (class, seat) cell: propose, never conclude ===========
// Hand-appended mission-close-shaped records — a full git+gate close cycle 20
// times over would only re-prove the same join the fixture above already
// proves once; what this block tests is purely the threshold arithmetic and
// the "propose, don't promote" shape, which needs nothing but the ledger kind
// and the two grouping fields (task_class, author_seat).
{
  const { root } = newTree();
  const ledger = path.join(root, 'ledger.jsonl');
  function appendClose(i) {
    appendRecord(ledger, {
      kind: 'mission-close',
      payload: {
        mission_id: `cell-m${i}`,
        author_route_seq: i,
        author_dispatch_seq: i,
        review_route_seq: i,
        review_dispatch_seq: i,
        gate_seq: i,
        winning_author_dispatch_seq: i,
        winning_review_dispatch_seq: i,
        author_family: 'claude',
        author_seat: 'executor-claude-standard',
        task_class: 'standard',
        review_outcome_seq: i,
        review: {
          seat: 'reviewer-degraded-opus',
          family: 'claude',
          model: 'opus-5',
          effort: 'medium',
          independence: 'degraded-path',
          replacement_reason: null,
          degraded_authorization: null,
        },
        artifact_identity: { source_head: 'h', source_tree: 't', patch_digest: 'p', dirty: false },
        landing: { mode: 'merge' },
        terminal_outcome_count: 0,
      },
      correlation_id: `cell-m${i}`,
    });
  }

  for (let i = 0; i < 19; i++) appendClose(i);
  let rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.closed, 19);
  assert.deepStrictEqual(rates.experiment_proposals, [], '19 closes is not yet worth proposing');

  appendClose(19);
  rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.closed, 20);
  assert.deepStrictEqual(rates.experiment_proposals, [{ class: 'standard', seat: 'executor-claude-standard', closes: 20 }]);
  assert.strictEqual(rates.by_class.standard.degraded_path_closes, 20);
}

console.log('test-friction-rates: ok');
