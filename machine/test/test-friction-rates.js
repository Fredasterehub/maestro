'use strict';

// Slice 7c — friction.js's computeRates widened past the friction kinds
// alone: by_class (joined through the dispatch, route, review-outcome,
// dispatch-outcome and mission-close streams 7a/7b landed), the two
// first-pass measures, the fable-low rescue metrics, and the (class, seat)
// experiment-proposal threshold. Repair round 1 (review-slice7c.md, F1-F13)
// found that several of these looked correct and were not; the fixtures
// below are built to fail the way the review's own probes did before the
// fix, not merely to exercise the happy path.
//
// Driven through the real writers (route.js, roster.js, mission.js), never
// through hand-rolled records shaped by guesswork, except the 20-close cell
// (a pure aggregation-arithmetic case that gains nothing from 20 real git+
// gate cycles) and the zero-population case (nothing to drive).

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

const { reserve, reserveReview, supersede, CLASS_ORDER } = require(ROUTE);
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

function evidenceSeqOf(root, missionId) {
  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const openRecord = records.find((r) => r.kind === 'mission-open' && r.mission_id === missionId);
  assert.ok(openRecord, 'mission-open record must exist');
  return openRecord.seq;
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

function emptyCell() {
  return {
    dispatched: 0,
    closed: 0,
    initial_dispatches: 0,
    initial_class_closes: 0,
    mission_first_pass: 0,
    attempt_first_pass: 0,
    degraded_path_closes: 0,
    first_pass_unknown: 0,
  };
}

// === register-through-close, single attempt =================================
// The gate's own fixture: one author dispatch, one review dispatch, a clean
// approve, a green gate, a close.
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
    ...emptyCell(),
    dispatched: 1,
    closed: 1,
    initial_dispatches: 1,
    initial_class_closes: 1,
    mission_first_pass: 1,
    attempt_first_pass: 1,
    degraded_path_closes: 1,
  });
}

// === F1 regression: a genuine fable-low execution that wins the close =======
// fallback_used: false — fable-low itself ran and its own dispatch won.
// This is the population rescue_rate/time_to_rescue/convergence_fraction
// must be scoped to.
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
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: false,
  });
  assert.strictEqual(outcome.actual_worker_model, 'fable-5', 'no fallback — fable-low genuinely ran');
  assert.strictEqual(outcome.actual_worker_effort, 'low');
  assert.strictEqual(outcome.fallback_used, false);
  assert.strictEqual(outcome.safety_refusal, false);

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
  assert.strictEqual(rates.rescue.fable_low_outcomes_recorded, 1);
  assert.strictEqual(rates.rescue.fallback_count, 0);
  assert.strictEqual(rates.rescue.fallback_rate, 0);
  assert.strictEqual(rates.rescue.refusal_count, 0);
  assert.strictEqual(rates.rescue.refusal_rate, 0);
  assert.strictEqual(rates.rescue.rescued_count, 1, 'the genuine fable-low execution is the one the mission closed on');
  assert.strictEqual(rates.rescue.rescue_rate, 1);
  assert.strictEqual(typeof rates.rescue.time_to_rescue_ms, 'number');
  assert.ok(rates.rescue.time_to_rescue_ms >= 0);
  assert.strictEqual(rates.rescue.time_to_rescue_sample_size, 1);
  assert.strictEqual(rates.rescue.convergence_count, 0);
  assert.strictEqual(rates.rescue.convergence_fraction, 0);
  assert.strictEqual(rates.rescue.evidence_level, 'unknown');
  assert.strictEqual(rates.rescue.incremental_cost_per_rescue, null);
}

// === F1 regression: an opus fallback is NOT a fable-low rescue ==============
// fallback_used: true — fable-low did not run; §16.2 attributes the actual
// execution to opus. Even though this exact dispatch_seq is the one the
// mission closes on, it must not count toward rescued_count/rescue_rate:
// that population is opus's, not fable-low's.
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
  assert.strictEqual(outcome.actual_worker_model, 'opus-5', 'a fable seat that fell back to opus is opus execution');
  assert.strictEqual(outcome.safety_refusal, false, 'no route-superseded safety-refusal record exists for this route');

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
  assert.strictEqual(rates.rescue.fallback_count, 1);
  assert.strictEqual(rates.rescue.fallback_rate, 1);
  // The false positive F2 found: this fallback_reason contains the word
  // "refusal", but no route-superseded safety-refusal record backs it —
  // refusal_rate must read the authoritative field, not the free text.
  assert.strictEqual(rates.rescue.refusal_count, 0);
  assert.strictEqual(rates.rescue.refusal_rate, 0);
  // The F1 fix: the mission closed on this dispatch, but fable-low never ran
  // it — opus did — so it is excluded from the "ran" population entirely.
  assert.strictEqual(rates.rescue.rescued_count, 0, 'opus won this close, not fable-low — not a rescue');
  assert.strictEqual(rates.rescue.rescue_rate, null, 'no fable-low execution ran at all in this population');
  assert.strictEqual(rates.rescue.time_to_rescue_ms, null);
  assert.strictEqual(rates.rescue.time_to_rescue_sample_size, 0);
  assert.strictEqual(rates.rescue.convergence_fraction, null);
}

// === F2 regression: a real safety refusal is read from the authoritative
// field, never regexed from free text ========================================
// The refusal never reaches a fallback at all: the whole route is rerouted
// to a different provider, so fallback_used stays false on this dispatch's
// own outcome — the false negative F2 found.
{
  const { root } = newTree();
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
    })
  );
  const authorDispatchSeq = registerDispatch(root, missionId, author.seq, 'executor-fable-low', 'claude');

  supersede(root, {
    mission_id: missionId,
    predecessor_route_seq: author.seq,
    transition: 'same-class-provider-reroute',
    reason: 'safety-refusal',
    evidence_seq: evidenceSeqOf(root, missionId),
    replacement: claudeAuthorInput(missionId, 2, {
      task_class: 'expert',
      requested_seat: 'executor-fable-low',
      resolved_seat: 'executor-claude',
      worker_model: 'opus-5',
      worker_effort: 'high',
      fallback_profile: null,
      selection: {
        candidates_skipped: [],
        substituted: true,
        substitution_reason: 'fable-low seat refused the brief on safety grounds',
      },
    }),
  });

  const outcome = recordOutcome(root, {
    dispatch_seq: authorDispatchSeq,
    fallback_used: false,
    fallback_reason: null,
    host_materially_authored: false,
  });
  assert.strictEqual(outcome.fallback_used, false, 'a safety refusal reroutes the whole route — it is not an inline fallback');
  assert.strictEqual(outcome.safety_refusal, true, "roster.js's own derivation off the route-superseded record");

  const rates = computeRates(root);
  assert.strictEqual(rates.rescue.fallback_count, 0, 'never a fallback — the false negative F2 found');
  assert.strictEqual(rates.rescue.refusal_count, 1);
  assert.strictEqual(rates.rescue.refusal_rate, 1);
}

// === second-attempt clean close: attempt_first_pass ≠ mission_first_pass ====
// Attempt 1 is reviewed and revised (no supersession needed — a revise
// verdict alone gives classify() a resolvable "revised" fate for both of
// attempt 1's dispatches). Attempt 2 is a fresh author route, reviewed and
// approved with no revise round of its own, and wins the close.
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
  assert.strictEqual(rates.by_class.standard.initial_dispatches, 1, 'one mission started in this class');
  assert.strictEqual(rates.by_class.standard.initial_class_closes, 1, 'and it did eventually close');
  assert.strictEqual(rates.by_class.standard.attempt_first_pass, 1, 'the winning attempt (2) had zero revise rounds of its own');
  assert.strictEqual(
    rates.by_class.standard.mission_first_pass,
    0,
    'the mission spent a revise round on attempt 1, and its winner was not attempt 1 — mission_first_pass is a different, stricter fact'
  );
}

// === F3 regression: a reviewer reroute after a revise must not count against
// the author it never touched =================================================
// Reviewer 1 issues revise; the reviewer is replaced
// (same-class-provider-reroute / infrastructure) before any repair to the
// AUTHOR's own work happens; reviewer 2 approves; the mission closes on
// attempt 1. mission.js's own close disregards a superseded reviewer's
// verdict when judging the author (mission.js's supersededReviewSeqs filter)
// — attempt_first_pass must agree.
{
  const { tmp, root } = newTree();
  const missionId = open(root);

  const author = reserve(root, claudeAuthorInput(missionId, 1, { task_class: 'standard' }));
  const authorDispatchSeq = registerDispatch(root, missionId, author.seq, 'executor-claude', 'claude');
  const repo = newWorkRepo(tmp);
  const identity = artifactIdentity(repo);

  const review1 = reserveReview(root, claudeReviewInput(missionId, author, authorDispatchSeq, identity));
  const reviewDispatch1 = registerDispatch(root, missionId, review1.seq, 'reviewer-degraded-sonnet', 'claude');
  recordReview(root, missionId, {
    review_route_seq: review1.seq,
    review_dispatch_seq: reviewDispatch1,
    verdict: 'revise',
    artifact_identity: identity,
  });

  // A standing revise is answered by overturn evidence, and close names a
  // gate record specifically as the only evidence that can contradict it
  // (a green re-run of the same command the reviewer judged) — never the
  // mission's own open record, which is what a real reviewer reroute after a
  // revise needs regardless of the reroute's own reason.
  const overturnGateSeq = runGreenGate(root, missionId, repo);
  const reroute = supersede(root, {
    mission_id: missionId,
    predecessor_route_seq: review1.seq,
    transition: 'same-class-provider-reroute',
    reason: 'infrastructure',
    evidence_seq: overturnGateSeq,
    replacement: claudeReviewInput(missionId, author, authorDispatchSeq, identity, {
      reviewer_seat: 'reviewer-degraded-opus',
      reviewer_model: 'opus-5',
      reviewer_effort: 'medium',
      replacement_reason: 'reviewer-degraded-sonnet lane down mid-review; substituted reviewer-degraded-opus',
    }),
  });
  const review2 = reroute.route;
  const reviewDispatch2 = registerDispatch(root, missionId, review2.seq, 'reviewer-degraded-opus', 'claude');
  recordReview(root, missionId, {
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    verdict: 'approve',
    artifact_identity: identity,
  });

  // The final gate runs on the approved artifact, after the standing
  // approve — a fresh run rather than the overturn gate above.
  const gateSeq = runGreenGate(root, missionId, repo);
  land(repo);
  runClose(root, missionId, repo, {
    author_route_seq: author.seq,
    author_dispatch_seq: authorDispatchSeq,
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: authorDispatchSeq,
    winning_review_dispatch_seq: reviewDispatch2,
  });

  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const outcomes = records.filter((r) => r.kind === 'dispatch-outcome' && r.mission_id === missionId);
  assert.deepStrictEqual(
    outcomes.map((o) => o.outcome),
    ['provider-rerouted'],
    "the close classifies the replaced reviewer's dispatch as provider-rerouted, not revised"
  );

  const rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.dispatched, 1, 'one author attempt — only the reviewer was replaced');
  assert.strictEqual(rates.by_class.standard.closed, 1);
  assert.strictEqual(
    rates.by_class.standard.attempt_first_pass,
    1,
    'the superseded reviewer’s revise never touched the author — the close itself disregards it, and this must agree'
  );
}

// === F4 regression: class escalation reads mission.js's own dispatch-outcome
// classification, not a re-derived transition/reason mapping =================
{
  const { tmp, root } = newTree();
  const missionId = open(root);

  const author1 = reserve(root, claudeAuthorInput(missionId, 1, { task_class: 'standard' }));
  const authorDispatch1 = registerDispatch(root, missionId, author1.seq, 'executor-claude', 'claude');

  const escalated = supersede(root, {
    mission_id: missionId,
    predecessor_route_seq: author1.seq,
    transition: 'class-escalation',
    reason: 'quality',
    evidence_seq: evidenceSeqOf(root, missionId),
    replacement: claudeAuthorInput(missionId, 2, { task_class: 'expert' }),
  });
  const author2 = escalated.route;
  const authorDispatch2 = registerDispatch(root, missionId, author2.seq, 'executor-claude', 'claude');

  const repo = newWorkRepo(tmp);
  const identity = artifactIdentity(repo);
  const review2 = reserveReview(root, claudeReviewInput(missionId, author2, authorDispatch2, identity));
  const reviewDispatch2 = registerDispatch(root, missionId, review2.seq, 'reviewer-degraded-sonnet', 'claude');
  recordReview(root, missionId, {
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    verdict: 'approve',
    artifact_identity: identity,
  });

  const gateSeq = runGreenGate(root, missionId, repo);
  land(repo);
  runClose(root, missionId, repo, {
    author_route_seq: author2.seq,
    author_dispatch_seq: authorDispatch2,
    review_route_seq: review2.seq,
    review_dispatch_seq: reviewDispatch2,
    gate_seq: gateSeq,
    winning_author_dispatch_seq: authorDispatch2,
    winning_review_dispatch_seq: reviewDispatch2,
  });

  const { records } = readRecords(path.join(root, 'ledger.jsonl'));
  const outcomes = records.filter((r) => r.kind === 'dispatch-outcome' && r.mission_id === missionId);
  assert.deepStrictEqual(outcomes.map((o) => o.outcome), ['profile-escalated']);

  const rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.dispatched, 1);
  assert.strictEqual(rates.by_class.standard.closed, 0);
  assert.strictEqual(rates.by_class.standard.initial_dispatches, 1, 'the mission started in standard');
  assert.strictEqual(rates.by_class.standard.initial_class_closes, 1, 'and it did close, just not as standard');
  assert.strictEqual(rates.by_class.expert.dispatched, 1);
  assert.strictEqual(rates.by_class.expert.closed, 1);
  assert.strictEqual(rates.by_class.expert.initial_dispatches, 0, 'no mission started in expert');
  assert.strictEqual(rates.by_class.expert.attempt_first_pass, 1, "the winning attempt's own review was clean");
  assert.strictEqual(
    rates.by_class.expert.mission_first_pass,
    0,
    'the mission spent its one profile escalation, read off the dispatch-outcome record mission.js itself wrote'
  );
}

// === F5 regression: a same-profile resume is not a new attempt ==============
{
  const { root } = newTree();
  const missionId = open(root);

  const author = reserve(root, claudeAuthorInput(missionId, 1, { task_class: 'standard' }));
  registerDispatch(root, missionId, author.seq, 'executor-claude', 'claude');

  const resumed = supersede(root, {
    mission_id: missionId,
    predecessor_route_seq: author.seq,
    transition: 'same-profile-resume',
    reason: 'infrastructure',
    evidence_seq: evidenceSeqOf(root, missionId),
    replacement: claudeAuthorInput(missionId, 1, { task_class: 'standard' }),
  });
  assert.strictEqual(resumed.route.resumed, true);
  registerDispatch(root, missionId, resumed.route.seq, 'executor-claude', 'claude');

  const rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.dispatched, 1, 'the resumed dispatch is not a second attempt');
  assert.strictEqual(rates.by_class.standard.initial_dispatches, 1);
}

// === zero population: every rate absent, never approximated to zero ==========
{
  const { root } = newTree();
  const rates = computeRates(root);
  for (const cls of CLASS_ORDER) {
    assert.deepStrictEqual(rates.by_class[cls], emptyCell());
  }
  assert.deepStrictEqual(rates.rescue, {
    fable_low_dispatches: 0,
    fable_low_outcomes_recorded: 0,
    fallback_count: 0,
    fallback_rate: null,
    refusal_count: 0,
    refusal_rate: null,
    rescued_count: 0,
    rescue_rate: null,
    time_to_rescue_ms: null,
    time_to_rescue_sample_size: 0,
    convergence_count: 0,
    convergence_fraction: null,
    evidence_level: null,
    incremental_cost_per_rescue: null,
  });
  assert.deepStrictEqual(rates.experiment_proposals, []);
}

// === 20 closes in one (class, seat) cell: propose, never conclude ===========
// Hand-appended mission-close-shaped records with no dispatch/route behind
// them — a full git+gate close cycle 20 times over would only re-prove the
// same join the fixtures above already prove once; what this block tests is
// the threshold arithmetic, the "propose, don't promote" shape, and (F11)
// that an unjoinable close is counted honestly rather than folded into a
// first-pass zero.
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
  assert.strictEqual(rates.by_class.standard.first_pass_unknown, 19, 'no dispatch/route record backs any of these closes');
  assert.strictEqual(rates.by_class.standard.mission_first_pass, 0);
  assert.strictEqual(rates.by_class.standard.attempt_first_pass, 0);
  assert.deepStrictEqual(rates.experiment_proposals, [], '19 closes is not yet worth proposing');

  appendClose(19);
  rates = computeRates(root);
  assert.strictEqual(rates.by_class.standard.closed, 20);
  assert.strictEqual(rates.by_class.standard.first_pass_unknown, 20);
  assert.deepStrictEqual(rates.experiment_proposals, [{ class: 'standard', seat: 'executor-claude-standard', closes: 20 }]);
  assert.strictEqual(rates.by_class.standard.degraded_path_closes, 20);
}

console.log('test-friction-rates: ok');
