'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MISSION = path.join(__dirname, '..', 'src', 'mission.js');
const GATE = path.join(__dirname, '..', 'src', 'gate.js');
const { readRecords, appendRecord } = require(path.join(__dirname, '..', 'src', 'jsonl.js'));
const { readJson } = require(path.join(__dirname, '..', 'src', 'atomic-json.js'));
const { supersede, reserveReview } = require(path.join(__dirname, '..', 'src', 'route.js'));
const fx = require('./close-fixture.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mission-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');
fx.initRouting(root);

function run(script, args, stdin, options) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
    ...(options || {}),
  });
}

function mission(args, stdin) {
  return run(MISSION, args, stdin);
}

const VALID_BRIEF = {
  outcome: 'ship the widget',
  scope: 'src/widget only',
  anchors: ['src/widget.js'],
  acceptance: 'tests pass',
  freshness: 'repo state as of today',
  tier: 'standard',
  return_format: 'six-field envelope',
  stop_condition: 'acceptance met or blocked',
};

function stateOf() {
  return readJson(path.join(root, 'state.json'), undefined);
}

function ledgerOf() {
  return readRecords(path.join(root, 'ledger.jsonl'));
}

function openM(id, extra) {
  const r = mission(['open', root], { mission_id: id, title: `mission ${id}`, brief: VALID_BRIEF, ...(extra || {}) });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).ledger_seq;
}

// Hand-appends a raw route/gate record, bypassing its sanctioned writer: close
// is the last fence and must refuse a lying record no matter who wrote it.
function appendRaw(kind, missionId, payload) {
  return appendRecord(path.join(root, 'ledger.jsonl'), { kind, payload, correlation_id: missionId });
}

function gitAt(repo, ...args) {
  const g = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`);
  return g.stdout.trim();
}

// A sibling step lands on main while this work is under review — the ordinary
// shape of parallel work, and what makes a rebase happen at all.
function landSibling(repo, name) {
  const branch = gitAt(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  gitAt(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', `sibling ${name} lands`);
  gitAt(repo, 'checkout', '-q', branch);
}

// --- help --------------------------------------------------------------------
{
  const r = mission(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /mission\.js — maestro mission lifecycle/);
}

// --- open: happy path --------------------------------------------------------
{
  const r = mission(['open', root], { mission_id: 'm1', title: 'First mission', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.mission_id, 'm1');

  const dir = path.join(root, 'missions', 'm1');
  for (const sub of ['mailbox', 'envelopes', 'artifacts']) {
    assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), `${sub}/ must exist`);
  }
  assert.deepStrictEqual(readJson(path.join(dir, 'brief.json')), VALID_BRIEF);

  const progress = readRecords(path.join(dir, 'progress.jsonl'));
  assert.strictEqual(progress.errors.length, 0);
  assert.strictEqual(progress.records.length, 1);
  assert.strictEqual(progress.records[0].kind, 'genesis', 'progress stream is genesis-seeded');

  const { records } = ledgerOf();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].kind, 'mission-open');
  assert.strictEqual(records[0].mission_id, 'm1');
  assert.strictEqual(records[0].title, 'First mission');
  assert.strictEqual(records[0].correlation_id, 'm1');

  const state = stateOf();
  assert.deepStrictEqual(state.missions.m1, {
    status: 'open',
    next_action: 'dispatch a worker against brief.json',
  });
}

// --- open: refusals ----------------------------------------------------------
{
  // duplicate id
  let r = mission(['open', root], { mission_id: 'm1', title: 'again', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /already exists/);

  // invalid brief refused, nothing created
  r = mission(['open', root], { mission_id: 'm-bad', title: 'x', brief: { outcome: 'only this' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid brief/);
  assert.ok(!fs.existsSync(path.join(root, 'missions', 'm-bad')), 'refused open writes nothing');
  assert.strictEqual(stateOf().missions['m-bad'], undefined);

  // unsafe mission_id refused
  r = mission(['open', root], { mission_id: '../evil', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /mission_id/);

  // extra key refused
  r = mission(['open', root], { mission_id: 'm2', title: 'x', brief: VALID_BRIEF, sneaky: 1 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /extra key "sneaky"/);

  // custom next_action honored
  r = mission(['open', root], { mission_id: 'm2', title: 'Second', brief: VALID_BRIEF, next_action: 'scout the tree' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.m2.next_action, 'scout the tree');
}

// --- checkpoint --------------------------------------------------------------
{
  const r = mission(['checkpoint', root, 'm1'], {
    step: 'wired the widget',
    done_evidence: 'commit abc1234',
    next: 'add tests',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.m1.next_action, 'add tests');

  const progress = readRecords(path.join(root, 'missions', 'm1', 'progress.jsonl'));
  assert.strictEqual(progress.records.length, 2);
  const cp = progress.records[1];
  assert.strictEqual(cp.kind, 'checkpoint');
  assert.strictEqual(cp.step, 'wired the widget');
  assert.strictEqual(cp.done_evidence, 'commit abc1234');
  assert.strictEqual(cp.next, 'add tests');

  // unknown mission refused
  const bad = mission(['checkpoint', root, 'ghost'], { step: 'a', done_evidence: 'b', next: 'c' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /no such mission/);

  // missing field refused
  const missing = mission(['checkpoint', root, 'm1'], { step: 'a', next: 'c' });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /done_evidence/);
}

// --- record-envelope ---------------------------------------------------------
{
  const envelope = {
    state: 'done',
    result: 'widget shipped',
    evidence: 'tests green, see artifact',
    risks: 'none observed',
    artifact: 'missions/m1/artifacts/report.md',
    question: '',
  };
  const r = mission(['record-envelope', root, 'm1', 'executor-sol'], envelope);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(fs.existsSync(out.envelope_path), 'envelope file written');
  assert.match(path.basename(out.envelope_path), /-executor-sol\.json$/);
  assert.deepStrictEqual(readJson(out.envelope_path), envelope);

  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'envelope');
  assert.strictEqual(rec.mission_id, 'm1');
  assert.strictEqual(rec.seat, 'executor-sol');
  assert.strictEqual(rec.state, 'done');
  assert.strictEqual(path.join(root, rec.path), out.envelope_path);

  // invalid envelope refused (blocked with empty question)
  const before = fs.readdirSync(path.join(root, 'missions', 'm1', 'envelopes')).length;
  const bad = mission(['record-envelope', root, 'm1', 'executor-sol'], { ...envelope, state: 'blocked' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid envelope/);
  assert.strictEqual(
    fs.readdirSync(path.join(root, 'missions', 'm1', 'envelopes')).length,
    before,
    'refused envelope writes nothing'
  );

  // unsafe seat refused
  const evil = mission(['record-envelope', root, 'm1', '../seat'], envelope);
  assert.strictEqual(evil.status, 1);
  assert.match(evil.stderr, /seat/);
}

// --- record-consult ----------------------------------------------------------
{
  const r = mission(['record-consult', root, 'm1'], {
    consult_id: 'c1',
    question: 'which config wins?',
    verdict: 'settings.json wins',
    anchor: 'src/config.js:42',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'consult');
  assert.strictEqual(rec.consult_id, 'c1');
  assert.strictEqual(rec.anchor, 'src/config.js:42');

  const bad = mission(['record-consult', root, 'm1'], { consult_id: 'c2', question: 'q', verdict: 'v' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /anchor/);
}

// --- close testbed: the m1 chain (reviewed, gated, not yet landed) -----------
// A second mission "mx" provides genuinely foreign records for the
// cross-mission refusals.
const m1Repo = fx.newWorkRepo(tmp);
const m1Identity = fx.artifactIdentity(m1Repo);
const m1Chain = fx.reserveChain(root, 'm1', m1Identity);
fx.recordApprove(root, 'm1', m1Chain, m1Identity);
const m1GateSeq = fx.runGreenGate(root, 'm1', 'tests', m1Repo);
const m1Input = fx.closeInputOf(m1Chain, m1GateSeq);

const mxOpenSeq = openM('mx');
const mxRepo = fx.newWorkRepo(tmp);
const mxChain = fx.reserveChain(root, 'mx', fx.artifactIdentity(mxRepo));
const mxGateSeq = fx.runGreenGate(root, 'mx', 'tests', mxRepo);

// --- close: the caller-assertion channel is gone -----------------------------
{
  // author_family is not an input key any more — the ledger is the authority,
  // and a caller that can assert its own family can launder one.
  let r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, author_family: 'gpt' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unexpected extra key "author_family"/);

  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, review: { verdict: 'approve', family: 'gpt' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unexpected extra key "review"/);

  const missing = { ...m1Input };
  delete missing.winning_review_dispatch_seq;
  r = fx.runClose(root, 'm1', m1Repo, missing);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /missing required key "winning_review_dispatch_seq"/);

  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, gate_seq: '5' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /"gate_seq" must be a nonnegative integer/);
}

// --- close: route derivation refusals ----------------------------------------
{
  // no record at the cited seq
  let r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, author_route_seq: 9999 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no ledger record has seq 9999/);

  // a record that is not a route (seq 0 is m1's mission-open)
  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, author_route_seq: 0 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /kind "mission-open", not "route"/);

  // a review-phase route cited as the author route
  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, author_route_seq: m1Chain.reviewSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /"review"-phase route, not "author"-phase/);

  // another mission's author route
  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, author_route_seq: mxChain.authorSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to mission "mx"/);

  // the review route must bind the exact author route and author dispatch
  r = fx.runClose(root, 'm1', m1Repo, {
    ...m1Input,
    author_route_seq: mxChain.authorSeq,
    author_dispatch_seq: mxChain.authorSeq,
    winning_author_dispatch_seq: mxChain.authorSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to mission "mx"/);

  r = fx.runClose(root, 'm1', m1Repo, {
    ...m1Input,
    author_dispatch_seq: m1GateSeq,
    winning_author_dispatch_seq: m1GateSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /binds author dispatch/);

  // winning attribution must be the dispatches the cited chain binds
  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, winning_author_dispatch_seq: m1GateSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /winning_author_dispatch_seq/);

  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, winning_review_dispatch_seq: m1GateSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /winning_review_dispatch_seq/);

  // gate refusals: not a gate, foreign gate
  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, gate_seq: m1Chain.authorSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /kind "route", not "gate"/);

  r = fx.runClose(root, 'm1', m1Repo, { ...m1Input, gate_seq: mxGateSeq });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /belongs to mission "mx"/);

  assert.strictEqual(stateOf().missions.m1.status, 'open', 'every refusal leaves the mission open');
}

// --- close: a dispatch seq naming another mission's record is a lie ----------
{
  openM('mdm');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mdm', fx.artifactIdentity(repo), {
    review: { author_dispatch_seq: mxOpenSeq },
  });
  const gateSeq = fx.runGreenGate(root, 'mdm', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mdm', repo, {
    ...fx.closeInputOf(chain, gateSeq),
    author_dispatch_seq: mxOpenSeq,
    winning_author_dispatch_seq: mxOpenSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /author dispatch seq \d+ names a record belonging to mission "mx"/);
}

// --- close: a dispatch seq no record carries yet claims nothing either way ---
// The dispatch record's writer (roster.js) ships in a later step; a legal
// close is never invalidated by a writer arriving later.
{
  openM('mabs');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mabs', identity, {
    review: { author_dispatch_seq: 100000 },
  });
  fx.recordApprove(root, 'mabs', chain, identity, 100001);
  const gateSeq = fx.runGreenGate(root, 'mabs', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mabs', repo, {
    ...fx.closeInputOf(chain, gateSeq),
    author_dispatch_seq: 100000,
    review_dispatch_seq: 100001,
    winning_author_dispatch_seq: 100000,
    winning_review_dispatch_seq: 100001,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mabs.status, 'done');
}

// --- close: a superseded route never closes ----------------------------------
{
  const openSeq = openM('msup');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'msup', identity);
  fx.recordApprove(root, 'msup', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'msup', 'tests', repo);
  fx.land(repo, 'merge');

  supersede(root, {
    mission_id: 'msup',
    predecessor_route_seq: chain.authorSeq,
    transition: 'same-profile-resume',
    reason: 'infrastructure',
    evidence_seq: openSeq,
    replacement: fx.authorRouteInput('msup', {
      selection: { candidates_skipped: [], substituted: false, substitution_reason: null },
    }),
  });

  const r = fx.runClose(root, 'msup', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a superseded route must not close');
  assert.match(r.stderr, /author route at seq \d+ was superseded by route \d+/);
  assert.strictEqual(stateOf().missions.msup.status, 'open');
}

// --- close: a family lie is an unrecorded deviation from the reservation -----
// The review route deviates from the reserved capacity (a "gpt cross-family"
// reviewer the route never reserved) with no replacement_reason. route.js
// would refuse to write this; close refuses it even hand-appended, because
// close derives — it does not trust writer discipline.
{
  openM('mlie');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const author = fx.reserveChain(root, 'mlie', identity); // reserves the honest review route too
  const lying = appendRaw('route', 'mlie', {
    ...fx.reviewRouteInput('mlie', author.authorSeq, author.authorSeq, identity, {
      // A seat whose config family really is gpt, so the derivation this
      // record passes leaves the unrecorded deviation as the only thing
      // wrong with it — which is what this block is about.
      reviewer_seat: 'reviewer-sol-expert-rev',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6-sol',
      reviewer_effort: 'medium',
      independence: 'cross-family',
    }),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mlie', { reviewSeq: lying.seq }, identity, lying.seq);
  const gateSeq = fx.runGreenGate(root, 'mlie', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mlie', repo, {
    ...fx.closeInputOf({ authorSeq: author.authorSeq, reviewSeq: lying.seq }, gateSeq),
  });
  assert.strictEqual(r.status, 1, 'a review profile the route never reserved must not close unexplained');
  assert.match(r.stderr, /a deviation from the reservation must be recorded/);
}

// --- close: mislabeled independence — degraded reported as cross-family ------
{
  openM('mind');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  // The reservation itself carries the laundered label, so the deviation check
  // passes and only the independence lie can refuse this close.
  const reserved = {
    seat: 'reviewer-degraded-sonnet',
    family: 'claude',
    model: 'sonnet-5',
    effort: 'high',
    independence: 'cross-family',
  };
  const author = appendRaw('route', 'mind', {
    ...fx.authorRouteInput('mind', { reserved_review: reserved }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review = appendRaw('route', 'mind', {
    ...fx.reviewRouteInput('mind', author.seq, author.seq, identity, { independence: 'cross-family' }),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mind', { reviewSeq: review.seq }, identity, review.seq);
  const gateSeq = fx.runGreenGate(root, 'mind', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mind', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 1, 'a same-family review labeled cross-family must not close');
  assert.match(r.stderr, /laundered label/);
}

// --- close: the reviewer's family is re-derived from the routing config ------
//
// route.js refuses to WRITE a review route whose asserted family the config
// contradicts. This is the second fence, and it exists because the first is
// written by the same hand that writes the record — and because records that
// predate the rule are already on ledgers. The reviewer's own reproduction,
// hand-appended past the writer that now refuses it: a gemini seat wearing a
// claude family, agreed to by the author route's reservation and therefore
// invisible to every check that compares the record with itself.
{
  openM('mgem');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const falsePair = {
    seat: 'reviewer-gemini',
    family: 'claude',
    model: 'gemini-3.1-pro-preview',
    effort: 'high',
    independence: 'degraded-path',
  };
  const author = appendRaw('route', 'mgem', {
    ...fx.authorRouteInput('mgem', { reserved_review: falsePair }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review = appendRaw('route', 'mgem', {
    ...fx.reviewRouteInput('mgem', author.seq, author.seq, identity, {
      reviewer_seat: falsePair.seat,
      reviewer_family: falsePair.family,
      reviewer_model: falsePair.model,
      reviewer_effort: falsePair.effort,
    }),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mgem', { reviewSeq: review.seq }, identity, review.seq);
  const gateSeq = fx.runGreenGate(root, 'mgem', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mgem', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 1, 'a family the routing config contradicts must not close');
  assert.match(r.stderr, /claims reviewer family "claude" for seat "reviewer-gemini", which the routing config seats in family "gemini"/);
  assert.strictEqual(stateOf().missions.mgem.status, 'open');
}

// --- close: the AUTHOR's family is re-derived too ----------------------------
//
// The same fence over the comparison's other operand, and the reason it is not
// a separate concern: every field here is honest except the author's family,
// the reviewer is honestly derived claude, and the review is recorded as
// cross-family purely because the author route claims to be gpt. Without this
// half, the whole chain closes — it did, on the probe that opened this pass.
{
  openM('mauth');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const reviewerPair = {
    seat: 'reviewer-degraded-sonnet',
    family: 'claude',
    model: 'sonnet-5',
    effort: 'high',
    independence: 'cross-family',
  };
  const author = appendRaw('route', 'mauth', {
    ...fx.authorRouteInput('mauth', {
      resolved_seat: 'executor-claude', // the config seats this in claude
      author_family: 'gpt', // ...and this is the lie the whole chain rests on
      reserved_review: reviewerPair,
      lane_state: { claude: 'auto', gpt: 'auto', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
    }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review = appendRaw('route', 'mauth', {
    ...fx.reviewRouteInput('mauth', author.seq, author.seq, identity, { independence: 'cross-family' }),
    phase: 'review',
    predecessor: null,
    reviewer_family_derived: true, // the reviewer half is honest and derived
  });
  fx.recordApprove(root, 'mauth', { reviewSeq: review.seq }, identity, review.seq);
  const gateSeq = fx.runGreenGate(root, 'mauth', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mauth', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 1, 'a false author family must not close a same-family review as cross-family');
  assert.match(r.stderr, /claims author family "gpt" for seat "executor-claude", which the routing config seats in family "claude"/);
  assert.strictEqual(stateOf().missions.mauth.status, 'open');
}

// --- close: the author tolerance is bounded by author routes alone -----------
// Each phase is bounded by its own records. A stream that derives reviewers
// says nothing about whether its AUTHOR routes predate the author-side rule,
// so the reviewer marker must not condemn an author route — while a real
// author-side omission still refuses.
{
  const root4 = path.join(tmp, '.maestro-authpre');
  fx.initRouting(root4);
  const rawAt = (missionId, kind, payload) =>
    appendRecord(path.join(root4, 'ledger.jsonl'), { kind, payload, correlation_id: missionId });

  // (1) a pre-rule author route naming a seat this config cannot resolve, in a
  // stream whose review routes DO derive: the author half still closes.
  const r0 = mission(['open', root4], { mission_id: 'mapre', title: 'author pre-rule', brief: VALID_BRIEF });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const author = rawAt('mapre', 'route', {
    ...fx.authorRouteInput('mapre', { resolved_seat: 'executor-luna', author_family: 'gpt' }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review = rawAt('mapre', 'route', {
    ...fx.reviewRouteInput('mapre', author.seq, author.seq, identity, {}),
    phase: 'review',
    predecessor: null,
    reviewer_family_derived: true,
  });
  fx.recordApprove(root4, 'mapre', { reviewSeq: review.seq }, identity, review.seq);
  const gateSeq = fx.runGreenGate(root4, 'mapre', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root4, 'mapre', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 0, r.stderr);

  // (2) once an author route in this stream derives its family, a later one
  // that does not is an omission — the author-side bound, closed by an
  // author-side record.
  const r1 = mission(['open', root4], { mission_id: 'mapost', title: 'author post-rule', brief: VALID_BRIEF });
  assert.strictEqual(r1.status, 0, r1.stderr);
  const repo2 = fx.newWorkRepo(tmp);
  const identity2 = fx.artifactIdentity(repo2);
  const derived = fx.reserveChain(root4, 'mapost', identity2);
  assert.strictEqual(derived.author.author_family_derived, true, 'this is the record that bounds the tolerance');
  const late = rawAt('mapost', 'route', {
    ...fx.authorRouteInput('mapost', { resolved_seat: 'executor-luna', author_family: 'gpt' }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const lateReview = rawAt('mapost', 'route', {
    ...fx.reviewRouteInput('mapost', late.seq, late.seq, identity2, {}),
    phase: 'review',
    predecessor: null,
    reviewer_family_derived: true,
  });
  fx.recordApprove(root4, 'mapost', { reviewSeq: lateReview.seq }, identity2, lateReview.seq);
  const gate2 = fx.runGreenGate(root4, 'mapost', 'tests', repo2);
  fx.land(repo2, 'merge');
  const r2 = fx.runClose(root4, 'mapost', repo2, fx.closeInputOf({ authorSeq: late.seq, reviewSeq: lateReview.seq }, gate2));
  assert.strictEqual(r2.status, 1, 'an author-side omission must not close once author routes derive');
  assert.match(r2.stderr, /names author seat "executor-luna".*an omission is not a legacy record/s);
}

// --- close: an underivable seat is an omission, not a legacy record ----------
// A seat the config does not carry establishes no family. In a stream whose
// review routes already record a derived family, a later record that does not
// is the cheapest way past this binding — name a seat nobody has heard of and
// the family goes unchecked — so the tolerance stops at the first derived one.
{
  openM('mnoseat');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  // reserveChain writes a derived review route first, which is what bounds the
  // tolerance for everything appended after it.
  const honest = fx.reserveChain(root, 'mnoseat', identity);
  assert.strictEqual(honest.review.reviewer_family_derived, true);
  const absent = appendRaw('route', 'mnoseat', {
    ...fx.reviewRouteInput('mnoseat', honest.authorSeq, honest.authorSeq, identity, {
      reviewer_seat: 'reviewer-terra',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6-terra',
      independence: 'cross-family',
      replacement_reason: 'a seat this config does not carry',
    }),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mnoseat', { reviewSeq: absent.seq }, identity, absent.seq);
  const gateSeq = fx.runGreenGate(root, 'mnoseat', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mnoseat', repo, fx.closeInputOf({ authorSeq: honest.authorSeq, reviewSeq: absent.seq }, gateSeq));
  assert.strictEqual(r.status, 1, 'an underivable family must not close a stream that already derives them');
  assert.match(r.stderr, /whose family cannot be derived .*records no seat "reviewer-terra".*an omission is not a legacy record/s);
}

// --- close: a review route from before the rule still closes -----------------
// The other half of the bound, in its own tree so the stream genuinely
// predates the rule: no review route here records a derived family, so a
// record naming a seat this config cannot resolve closes. A legal close is
// never invalidated by a rule arriving later — and the block above is what
// keeps that from being a door.
{
  const root3 = path.join(tmp, '.maestro-prerule');
  fx.initRouting(root3);
  const r0 = mission(['open', root3], { mission_id: 'mpre', title: 'pre-rule tree', brief: VALID_BRIEF });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const reserved = {
    seat: 'reviewer-terra',
    family: 'gpt',
    model: 'gpt-5.6-terra',
    effort: 'high',
    independence: 'cross-family',
  };
  const rawAt = (kind, payload) =>
    appendRecord(path.join(root3, 'ledger.jsonl'), { kind, payload, correlation_id: 'mpre' });
  const author = rawAt('route', {
    ...fx.authorRouteInput('mpre', { reserved_review: reserved }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review = rawAt('route', {
    ...fx.reviewRouteInput('mpre', author.seq, author.seq, identity, {
      reviewer_seat: reserved.seat,
      reviewer_family: reserved.family,
      reviewer_model: reserved.model,
      reviewer_effort: reserved.effort,
      independence: 'cross-family',
    }),
    phase: 'review',
    predecessor: null,
  });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(review, 'reviewer_family_derived'),
    'this record must genuinely predate the rule, or it proves nothing'
  );
  fx.recordApprove(root3, 'mpre', { reviewSeq: review.seq }, identity, review.seq);
  const gateSeq = fx.runGreenGate(root3, 'mpre', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root3, 'mpre', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readJson(path.join(root3, 'state.json'), undefined).missions.mpre.status, 'done');

  // ...but a false family is false at any age: derivable and contradicted
  // refuses even in a stream that carries no derived record at all.
  const r1 = mission(['open', root3], { mission_id: 'mpre2', title: 'pre-rule tree, false family', brief: VALID_BRIEF });
  assert.strictEqual(r1.status, 0, r1.stderr);
  const repo2 = fx.newWorkRepo(tmp);
  const identity2 = fx.artifactIdentity(repo2);
  const falsePair = {
    seat: 'reviewer-gemini',
    family: 'claude',
    model: 'gemini-3.1-pro-preview',
    effort: 'high',
    independence: 'degraded-path',
  };
  const rawAt2 = (kind, payload) =>
    appendRecord(path.join(root3, 'ledger.jsonl'), { kind, payload, correlation_id: 'mpre2' });
  const author2 = rawAt2('route', {
    ...fx.authorRouteInput('mpre2', { reserved_review: falsePair }),
    phase: 'author',
    predecessor: null,
    resumed: false,
  });
  const review2 = rawAt2('route', {
    ...fx.reviewRouteInput('mpre2', author2.seq, author2.seq, identity2, {
      reviewer_seat: falsePair.seat,
      reviewer_family: falsePair.family,
      reviewer_model: falsePair.model,
      reviewer_effort: falsePair.effort,
    }),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root3, 'mpre2', { reviewSeq: review2.seq }, identity2, review2.seq);
  const gate2 = fx.runGreenGate(root3, 'mpre2', 'tests', repo2);
  fx.land(repo2, 'merge');
  const r2 = fx.runClose(
    root3,
    'mpre2',
    repo2,
    fx.closeInputOf({ authorSeq: author2.seq, reviewSeq: review2.seq }, gate2)
  );
  assert.strictEqual(r2.status, 1, 'the tolerance covers an underivable family, never a contradicted one');
  assert.match(r2.stderr, /which the routing config seats in family "gemini"/);
}

// --- close: the artifact changed between review and gate ----------------------
{
  openM('mchg');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mchg', identity);
  fx.recordApprove(root, 'mchg', chain, identity);
  // a commit after the review: the gate tests something the review never saw
  fs.writeFileSync(path.join(repo, 'drift.txt'), 'post-review drift\n');
  const g = spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0);
  const c = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'drift'], { encoding: 'utf8' });
  assert.strictEqual(c.status, 0);
  const gateSeq = fx.runGreenGate(root, 'mchg', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mchg', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a changed artifact between review and gate must not close');
  assert.match(r.stderr, /tested a different artifact than the review/);
}

// --- close: a gate sharing only one content field with the review is not ---
// --- the same artifact, though the disjunctive work predicate calls it so --
//
// checkGateIdentity is a CHAIN link — the gate must name the exact artifact
// the review judged, field by field over all four IDENTITY_FIELDS — and is
// deliberately NOT namesSameArtifact, the disjunctive predicate the standing-
// revise scan uses to ask "is this about the same change" (mission.js's own
// comment above CONTENT_IDENTITY_FIELDS says so explicitly). A gate identity
// that shares source_tree with the reviewed identity but differs in
// source_head and patch_digest is exactly the case where the two predicates
// diverge: namesSameArtifact would call it the same work (one content field
// matches), so a widening of checkGateIdentity to that predicate would let
// this gate close a review it never tested. Hand-appended, like the legacy-
// gate fixture below: a real gate.js run cannot be made to report a
// mismatched identity for an unrelated commit while still sharing exactly
// one content field with the review by construction.
{
  openM('mgateshare');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mgateshare', identity);
  fx.recordApprove(root, 'mgateshare', chain, identity);
  const shared = {
    source_head: 'f'.repeat(40),
    source_tree: identity.source_tree,
    patch_digest: 'sha256:' + 'e'.repeat(64),
    dirty: false,
  };
  const gate = appendRecord(path.join(root, 'ledger.jsonl'), {
    kind: 'gate',
    payload: {
      gate_id: 'tests',
      cmd: ['true'],
      exit_code: 0,
      mission_id: 'mgateshare',
      artifact_identity: shared,
      identity_check: { verified: true, changed: [], error: null },
    },
    correlation_id: 'mgateshare',
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mgateshare', repo, fx.closeInputOf(chain, gate.seq));
  assert.strictEqual(r.status, 1, 'a gate sharing only the tree with the review must not close');
  assert.match(r.stderr, /tested a different artifact than the review/);
}

// --- close: a gate that mutated the tree it tested is not pass evidence ------
// The same record check-honesty refuses — close and the audit agree.
{
  openM('mmut');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mmut', identity);
  fx.recordApprove(root, 'mmut', chain, identity);
  const mutate = run(GATE, [
    'run-gate', '--worktree', repo, root, 'mmut', 'tests', '--',
    process.execPath, '-e', "require('fs').writeFileSync('mutated.txt','x')",
  ]);
  assert.strictEqual(mutate.status, 0, mutate.stderr);
  const out = JSON.parse(mutate.stdout);
  assert.strictEqual(out.exit_code, 0);
  assert.strictEqual(out.identity_check.verified, false, 'the fixture gate must have mutated the tree');
  fs.rmSync(path.join(repo, 'mutated.txt'));
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mmut', repo, fx.closeInputOf(chain, out.ledger_seq));
  assert.strictEqual(r.status, 1, 'a tree-mutating gate pass must not close');
  assert.match(r.stderr, /mutated the tree it tested/);

  const honesty = run(GATE, ['check-honesty', root, 'mmut', 'tests']);
  assert.strictEqual(honesty.status, 1, 'check-honesty refuses the same record close refuses');
}

// --- close: a gate that named no identity is not evidence for this artifact --
{
  openM('mnul');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mnul', identity);
  fx.recordApprove(root, 'mnul', chain, identity);
  const plain = path.join(tmp, 'mnul-plain');
  fs.mkdirSync(plain, { recursive: true });
  // no --worktree, cwd outside any git context: identity records as null
  const gate = run(GATE, ['run-gate', root, 'mnul', 'tests', '--', 'true'], undefined, { cwd: plain });
  assert.strictEqual(gate.status, 0, gate.stderr);
  const out = JSON.parse(gate.stdout);
  assert.strictEqual(out.artifact_identity, null);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mnul', repo, fx.closeInputOf(chain, out.ledger_seq));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /could not name the identity it tested/);
}

// --- close: a gate record from before identities were carried still closes ---
// A legal close is never invalidated by a field arriving later — but only in
// a stream that genuinely predates the fields, so this runs in its own tree,
// where no gate record has ever carried an identity.
{
  const root2 = path.join(tmp, '.maestro-legacy');
  fx.initRouting(root2);
  const r0 = mission(['open', root2], { mission_id: 'mleg', title: 'legacy tree', brief: VALID_BRIEF });
  assert.strictEqual(r0.status, 0, r0.stderr);
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root2, 'mleg', identity);
  fx.recordApprove(root2, 'mleg', chain, identity);
  const legacy = appendRecord(path.join(root2, 'ledger.jsonl'), {
    kind: 'gate',
    payload: { gate_id: 'legacy', cmd: ['true'], exit_code: 0, mission_id: 'mleg' },
    correlation_id: 'mleg',
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(root2, 'mleg', repo, fx.closeInputOf(chain, legacy.seq));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readJson(path.join(root2, 'state.json'), undefined).missions.mleg.status, 'done');
}

// --- close: omitting the identity fields is not the legacy tolerance ---------
// In a stream whose gate records already carry identities, a field-less gate
// record is an omission — the cheapest forgery — and refuses.
{
  openM('momit');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'momit', identity);
  fx.recordApprove(root, 'momit', chain, identity);
  const fieldless = appendRaw('gate', 'momit', {
    gate_id: 'forged',
    cmd: ['false'],
    exit_code: 0,
    mission_id: 'momit',
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'momit', repo, fx.closeInputOf(chain, fieldless.seq));
  assert.strictEqual(r.status, 1, 'a field-less gate in an identity-carrying stream must not close');
  assert.match(r.stderr, /an omission is not a legacy record/);
}

// --- close: landing refusals -------------------------------------------------
{
  openM('mnol');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mnol', identity);
  fx.recordApprove(root, 'mnol', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mnol', 'tests', repo);
  const input = fx.closeInputOf(chain, gateSeq);

  // nothing landed: not contained, no commit with the reviewed patch identity
  let r = fx.runClose(root, 'mnol', repo, input);
  assert.strictEqual(r.status, 1, 'an unlanded result must not close');
  assert.match(r.stderr, /neither contains the reviewed commit .* nor carries any commit with its patch identity/);

  // --repo that is not a git worktree
  const plain = path.join(tmp, 'mnol-plain');
  fs.mkdirSync(plain, { recursive: true });
  r = fx.runClose(root, 'mnol', plain, input);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is not a git worktree/);

  // a repository that never held the reviewed commit
  const stranger = fx.newWorkRepo(tmp);
  r = fx.runClose(root, 'mnol', stranger, input);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown to/);

  assert.strictEqual(stateOf().missions.mnol.status, 'open');
}

// --- close: an ordinary merge is proven by commit containment ----------------
// (the m1 finale: its chain was reviewed and gated above, refusals left it
// open; landing it makes the same input close, and the close record carries
// only derived facts)
{
  fx.land(m1Repo, 'merge');
  const r = fx.runClose(root, 'm1', m1Repo, m1Input);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.status, 'done');
  assert.strictEqual(out.landing.method, 'commit-containment');
  assert.strictEqual(out.landing.branch, 'main');
  // the proof's repository is recorded so the close can be re-audited
  assert.strictEqual(out.landing.repository.path, fs.realpathSync(m1Repo));
  assert.ok(Array.isArray(out.landing.repository.roots) && out.landing.repository.roots.length > 0);
  assert.strictEqual(out.landing.repository.origin, null, 'no origin configured in the fixture repo');

  const state = stateOf();
  assert.strictEqual(state.missions.m1.status, 'done');
  assert.strictEqual(state.missions.m1.next_action, null);

  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.kind, 'mission-close');
  assert.strictEqual(close.mission_id, 'm1');
  assert.strictEqual(close.author_family, 'claude', 'the author family is the ledger route record, not caller prose');
  assert.strictEqual(close.author_seat, 'executor-claude');
  assert.strictEqual(close.task_class, 'expert');
  assert.deepStrictEqual(close.review, {
    seat: 'reviewer-degraded-sonnet',
    family: 'claude',
    model: 'sonnet-5',
    effort: 'high',
    independence: 'degraded-path',
    replacement_reason: null,
    // the reservation itself was the degraded path, so the snapshot — not a
    // later loss — is what authorized this review
    degraded_authorization: 'snapshot',
  });
  assert.deepStrictEqual(close.artifact_identity, m1Identity);
  assert.strictEqual(close.gate_seq, m1GateSeq);
  assert.ok(Number.isSafeInteger(close.review_outcome_seq), 'the close names the recorded approve it derived from');
  assert.strictEqual(close.author_route_seq, m1Chain.authorSeq);
  assert.strictEqual(close.review_route_seq, m1Chain.reviewSeq);
  assert.strictEqual(close.winning_author_dispatch_seq, m1Chain.authorSeq);
  assert.strictEqual(close.winning_review_dispatch_seq, m1Chain.reviewSeq);
  assert.strictEqual(close.landing.method, 'commit-containment');
}

// --- close: a squash landing is proven by patch identity ----------------------
{
  openM('msq');
  const done = fx.closeMissionFully(root, 'msq', { dir: tmp, landing: 'squash' });
  assert.strictEqual(done.result.landing.method, 'squash-patch-identity');
  assert.notStrictEqual(
    done.result.landing.landed_head,
    done.identity.source_head,
    'a squash lands a different commit object — only its patch identity proves it'
  );
  assert.strictEqual(stateOf().missions.msq.status, 'done');
}

// --- close: a legal degraded review survives the provider recovering ----------
// Apex class, no ceiling: the degraded-path close is judged under the route
// snapshot that authorized it. After the review, the gpt lane "comes back"
// (a fresher preflight record and a settings file both say so) — close reads
// neither, so the completed review stays legal.
{
  openM('mrec');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mrec', identity, {
    author: { task_class: 'apex' },
  });
  fx.recordApprove(root, 'mrec', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mrec', 'tests', repo);
  fx.land(repo, 'merge');

  appendRaw('preflight', 'mrec', { providers: { gpt: 'present', gemini: 'present' } });
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ provider_lanes: { gpt: 'auto', gemini: 'auto' } }, null, 2) + '\n'
  );

  const r = fx.runClose(root, 'mrec', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, 'provider recovery must never retroactively invalidate a legal degraded review');
  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.task_class, 'apex', 'no class ceiling — apex closes on the degraded path');
  assert.strictEqual(close.review.independence, 'degraded-path');
}

// --- close: the degraded path is never self-authorizing ----------------------
// A route whose snapshot recorded every lane healthy and no degraded mode
// cannot close on a degraded-path label: the label is authorized by the
// recorded snapshot, never by itself.
{
  openM('mdeg');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mdeg', identity, {
    author: {
      lane_state: { claude: 'auto', gpt: 'auto', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
    },
  });
  fx.recordApprove(root, 'mdeg', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mdeg', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mdeg', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a degraded-path label on a healthy snapshot must not close');
  assert.match(r.stderr, /records no degraded mode/);
  assert.strictEqual(stateOf().missions.mdeg.status, 'open');
}

// --- close: a cross-family review closes — the mission's stated floor --------
{
  openM('mxf');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  // A real cross-family seat out of the config's own table: the reviewer's
  // family is derived from that entry now, so a made-up seat would refuse here
  // for a reason this block is not about.
  const reserved = {
    seat: 'reviewer-sol-expert-rev',
    family: 'gpt',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    independence: 'cross-family',
  };
  const chain = fx.reserveChain(root, 'mxf', identity, {
    author: {
      lane_state: { claude: 'auto', gpt: 'auto', gemini: 'auto' },
      degraded_modes: [],
      notices: [],
      reserved_review: reserved,
    },
    review: {
      reviewer_seat: reserved.seat,
      reviewer_family: reserved.family,
      reviewer_model: reserved.model,
      reviewer_effort: reserved.effort,
      reviewer_host_model: 'sonnet-5',
      reviewer_host_effort: 'medium',
      independence: 'cross-family',
    },
  });
  fx.recordApprove(root, 'mxf', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mxf', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mxf', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, r.stderr);
  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.review.family, 'gpt');
  assert.strictEqual(close.review.independence, 'cross-family');
  assert.strictEqual(close.author_family, 'claude');
}

// --- close: an unanswered red gate under any name blocks the close -----------
// §8: one gate, one name. Until a record names which gate_id is final, no
// other gate_id's latest record may stand red.
{
  openM('mred');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mred', identity);
  fx.recordApprove(root, 'mred', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mred', 'tests', repo);
  const redLint = run(GATE, ['run-gate', '--worktree', repo, root, 'mred', 'lint', '--', 'false']);
  assert.strictEqual(redLint.status, 0, redLint.stderr);
  fx.land(repo, 'merge');
  const input = fx.closeInputOf(chain, gateSeq);

  let r = fx.runClose(root, 'mred', repo, input);
  assert.strictEqual(r.status, 1, 'a red gate under another name must block the close');
  assert.match(r.stderr, /latest record of gate "lint".*unanswered red gate/);

  // answering the red gate with a green run of the same gate_id restores it
  const back = spawnSync('git', ['-C', repo, 'checkout', '-q', 'work'], { encoding: 'utf8' });
  assert.strictEqual(back.status, 0, back.stderr);
  const greenLint = run(GATE, ['run-gate', '--worktree', repo, root, 'mred', 'lint', '--', 'true']);
  assert.strictEqual(greenLint.status, 0, greenLint.stderr);
  r = fx.runClose(root, 'mred', repo, input);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mred.status, 'done');
}

// --- close: a dirty reviewed identity never closes ----------------------------
// route.js refuses to write one, so the route and its gate are hand-crafted;
// close derives and refuses on its own.
{
  openM('mdirty');
  const repo = fx.newWorkRepo(tmp);
  const identity = { ...fx.artifactIdentity(repo), dirty: true };
  const author = fx.reserveChain(root, 'mdirty', fx.artifactIdentity(repo)).author;
  const review = appendRaw('route', 'mdirty', {
    ...fx.reviewRouteInput('mdirty', author.seq, author.seq, identity),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mdirty', { reviewSeq: review.seq }, identity, review.seq);
  const gate = appendRaw('gate', 'mdirty', {
    gate_id: 'tests',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mdirty',
    artifact_identity: identity,
    identity_check: { verified: true, changed: [], error: null },
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mdirty',
    repo,
    fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gate.seq)
  );
  assert.strictEqual(r.status, 1, 'a dirty reviewed identity must not close');
  assert.match(r.stderr, /dirty worktree is never a reviewable artifact/);
}

// --- close: a source_tree that is not the tree of source_head never closes ---
{
  openM('mtree');
  const repo = fx.newWorkRepo(tmp);
  const real = fx.artifactIdentity(repo);
  const baseTree = spawnSync('git', ['-C', repo, 'rev-parse', 'main^{tree}'], { encoding: 'utf8' });
  assert.strictEqual(baseTree.status, 0, baseTree.stderr);
  const lie = { ...real, source_tree: baseTree.stdout.trim() };
  const author = fx.reserveChain(root, 'mtree', real).author;
  const review = appendRaw('route', 'mtree', {
    ...fx.reviewRouteInput('mtree', author.seq, author.seq, lie),
    phase: 'review',
    predecessor: null,
  });
  fx.recordApprove(root, 'mtree', { reviewSeq: review.seq }, lie, review.seq);
  const gate = appendRaw('gate', 'mtree', {
    gate_id: 'tests',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mtree',
    artifact_identity: lie,
    identity_check: { verified: true, changed: [], error: null },
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mtree',
    repo,
    fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gate.seq)
  );
  assert.strictEqual(r.status, 1, 'an identity binding a head to a foreign tree must not close');
  assert.match(r.stderr, /is not the tree of source_head/);
}

// --- record-review: the sole producer of the verdict close depends on --------
{
  openM('mver');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mver', identity);
  const before = ledgerOf().records.length;

  // verdict outside the vocabulary
  let r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'lgtm',
    artifact_identity: identity,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /"verdict" must be one of approve, revise/);

  // extra key refused
  r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    reviewer: 'me',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unexpected extra key "reviewer"/);

  // the seq must be this mission's review-phase route
  r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.authorSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /"author"-phase route, not "review"-phase/);

  // the verdict must name the identity the review route bound
  r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: { ...identity, source_head: 'f'.repeat(40) },
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /names a different artifact than the review route bound/);

  // a first verdict has nothing to supersede
  r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
    supersedes_seq: 0,
    reason: 'x',
    evidence_seq: 0,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /nothing to supersede/);

  assert.strictEqual(ledgerOf().records.length, before, 'a refused verdict reaches no disk');

  // both verdicts record the same way
  r = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const { records } = ledgerOf();
  const rec = records[records.length - 1];
  assert.strictEqual(rec.kind, 'review-outcome');
  assert.strictEqual(rec.mission_id, 'mver');
  assert.strictEqual(rec.verdict, 'revise');
  assert.strictEqual(rec.review_route_seq, chain.reviewSeq);
  assert.deepStrictEqual(rec.artifact_identity, identity);
  assert.strictEqual(rec.supersedes_seq, null, 'a first verdict supersedes nothing');

  // a verdict is an assertion, not a re-executed command: replacing the
  // standing verdict takes the full answer — the standing seq, a reason, and
  // recorded evidence — never a bare later append
  const bare = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(bare.status, 1, 'a bare second verdict must be refused');
  assert.match(bare.stderr, /answered, never silently replaced/);

  const partial = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: rec.seq,
    reason: 'repair verified',
  });
  assert.strictEqual(partial.status, 1);
  assert.match(partial.stderr, /carries all of supersedes_seq, reason, evidence_seq/);

  const wrongSeq = fx.recordReview(root, 'mver', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: rec.seq + 1,
    reason: 'repair verified',
    evidence_seq: rec.seq,
  });
  assert.strictEqual(wrongSeq.status, 1);
  assert.match(wrongSeq.stderr, /is not the standing verdict/);
}

// --- close: no verdict, a standing revise, and a bare overturn all refuse ----
{
  const openSeq = openM('mnov');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mnov', identity);
  // gate_seq 0 is m1's mission-open record; the verdict refusals fire before
  // gate resolution, so the placeholder is never reached
  const input0 = fx.closeInputOf(chain, 0);

  // no review-outcome record at all
  let r = fx.runClose(root, 'mnov', repo, input0);
  assert.strictEqual(r.status, 1, 'a close with no recorded verdict must refuse');
  assert.match(r.stderr, /a close needs a recorded verdict, not a narrated one/);

  // a revise on record refuses the same way
  const revise = fx.recordReview(root, 'mnov', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;
  r = fx.runClose(root, 'mnov', repo, input0);
  assert.strictEqual(r.status, 1, 'a revise verdict must not close');
  assert.match(r.stderr, /is "revise", and only a recorded approve closes a mission/);
  assert.strictEqual(stateOf().missions.mnov.status, 'open');

  // an approve that answers the revise takes recorded CONTRADICTORY REPOSITORY
  // evidence: the mission's own open record is a well-formed seq and no kind
  // of evidence, and neither is the revise it overturns
  for (const [seq, why] of [
    [openSeq, /a "mission-open" record; contradictory repository evidence is a gate record/],
    [reviseSeq, /a "review-outcome" record/],
  ]) {
    const bad = fx.recordReview(root, 'mnov', {
      review_route_seq: chain.reviewSeq,
      review_dispatch_seq: chain.reviewSeq,
      verdict: 'approve',
      artifact_identity: identity,
      supersedes_seq: reviseSeq,
      reason: 'disagreed with the finding',
      evidence_seq: seq,
    });
    assert.strictEqual(bad.status, 1, `evidence_seq ${seq} must not pass as evidence`);
    assert.match(bad.stderr, why);
  }

  // the legitimate flow: the finding is answered by a gate run AFTER it
  const evidenceGateSeq = fx.runGreenGate(root, 'mnov', 'tests', repo);
  const answer = fx.recordReview(root, 'mnov', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: reviseSeq,
    reason: 'revise finding contradicted by recorded repository evidence',
    evidence_seq: evidenceGateSeq,
  });
  assert.strictEqual(answer.status, 0, answer.stderr);
  // and the final gate runs on the approved artifact, so a second run is what
  // close cites — the evidence gate predates the approve by construction
  const gateSeq = fx.runGreenGate(root, 'mnov', 'tests', repo);
  fx.land(repo, 'merge');
  r = fx.runClose(root, 'mnov', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mnov.status, 'done');
  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.review_outcome_seq, JSON.parse(answer.stdout).ledger_seq);
}

// --- close: a bare later approve never silently overturns a recorded revise --
// The p7 shape, hand-appended past the writer's own refusal: close derives
// the answer chain itself. A verdict stream carrying an unanswered
// replacement stays unclosable — the recovery path is a fresh review route,
// never a quieter append.
{
  openM('mbare');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mbare', identity);
  const revise = fx.recordReview(root, 'mbare', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  appendRaw('review-outcome', 'mbare', {
    mission_id: 'mbare',
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });
  const gateSeq = fx.runGreenGate(root, 'mbare', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mbare', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a bare overturning approve must not close');
  assert.match(r.stderr, /answered, never silently replaced/);
  assert.strictEqual(stateOf().missions.mbare.status, 'open');
}

// --- close: the approve must credit this dispatch and this exact artifact ----
{
  const openSeq = openM('mfid');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mfid', identity);
  const approveSeq = fx.recordApprove(root, 'mfid', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mfid', 'tests', repo);
  fx.land(repo, 'merge');
  const input = fx.closeInputOf(chain, gateSeq);

  // the recorded approve names a different review dispatch than the one credited
  let r = fx.runClose(root, 'mfid', repo, {
    ...input,
    review_dispatch_seq: chain.authorSeq,
    winning_review_dispatch_seq: chain.authorSeq,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /names review dispatch \d+, not the \d+ being credited/);

  // an approve for a different identity, hand-appended past the writer's own
  // refusal (with a well-formed answer chain, so only the identity lies):
  // close derives, so the lie refuses here too
  appendRaw('review-outcome', 'mfid', {
    mission_id: 'mfid',
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: { ...identity, source_head: 'f'.repeat(40) },
    supersedes_seq: approveSeq,
    reason: 'forged',
    evidence_seq: gateSeq,
  });
  r = fx.runClose(root, 'mfid', repo, input);
  assert.strictEqual(r.status, 1, 'an approve for a different artifact must not close');
  assert.match(r.stderr, /recorded approve \(seq \d+\) names a different artifact/);
  assert.strictEqual(stateOf().missions.mfid.status, 'open');
}

// --- close: a verdict record misattributing its mission is not evidence ------
{
  openM('mout');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mout', identity);
  // a perfect approve in every field except the mission it claims
  appendRaw('review-outcome', 'mout', {
    mission_id: 'mx',
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });
  const gateSeq = fx.runGreenGate(root, 'mout', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mout', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /misattributes its mission/);
}

// --- record-review: the supersession keys are shaped, not just present ------
{
  openM('mshape');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mshape', identity);
  const first = fx.recordReview(root, 'mshape', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(first.status, 0, first.stderr);
  const reviseSeq = JSON.parse(first.stdout).ledger_seq;
  const evidenceSeq = fx.runGreenGate(root, 'mshape', 'tests', repo);
  // a gate of this mission, recorded after the finding, but run on other work
  const otherGateSeq = fx.runGreenGate(root, 'mshape', 'tests', fx.newWorkRepo(tmp));
  const before = ledgerOf().records.length;

  const answer = (overrides) =>
    fx.recordReview(root, 'mshape', {
      review_route_seq: chain.reviewSeq,
      review_dispatch_seq: chain.reviewSeq,
      verdict: 'approve',
      artifact_identity: identity,
      supersedes_seq: reviseSeq,
      reason: 'gate contradicts the finding',
      evidence_seq: evidenceSeq,
      ...overrides,
    });

  // the two seqs are ledger references, not free text
  for (const bad of [{ supersedes_seq: String(reviseSeq) }, { supersedes_seq: -1 }, { evidence_seq: 1.5 }]) {
    const r = answer(bad);
    assert.strictEqual(r.status, 1, `${JSON.stringify(bad)} must be refused`);
    assert.match(r.stderr, /must be a nonnegative integer naming a ledger seq/);
  }

  // the reason is a single line of bounded length, so a record cannot carry a
  // narrative (or a forged extra record) in the field that explains itself
  for (const bad of ['', '   ', 'line one\nline two', 'x'.repeat(201)]) {
    const r = answer({ reason: bad });
    assert.strictEqual(r.status, 1, `reason ${JSON.stringify(bad.slice(0, 12))} must be refused`);
    assert.match(r.stderr, /"reason" must be a non-empty single-line string of at most 200 characters/);
  }

  // a true fact about other work contradicts nothing here
  let r = answer({ evidence_seq: otherGateSeq });
  assert.strictEqual(r.status, 1, 'a gate on another artifact is not evidence about this one');
  assert.match(r.stderr, /tested a different artifact than the verdict it answers/);

  // the evidence must resolve to exactly one record of THIS mission
  r = answer({ evidence_seq: 999999 });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /names no ledger record in "evidence_seq" 999999/);

  r = answer({ evidence_seq: mxGateSeq });
  assert.strictEqual(r.status, 1, "another mission's gate is not this mission's evidence");
  assert.match(r.stderr, /belongs to mission "mx", not "mshape"/);

  assert.strictEqual(ledgerOf().records.length, before, 'every refused verdict reaches no disk');

  // and the well-formed answer records
  r = answer({});
  assert.strictEqual(r.status, 0, r.stderr);
}

// --- close: the final gate runs on the approved artifact ---------------------
// §8's review-then-gate order, asserted where it is enforced: the gate is
// green, on the right artifact, and the latest of its name — and it ran before
// any verdict existed, so it proves a pre-verdict state of the world.
{
  openM('morder');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'morder', identity);
  const gateSeq = fx.runGreenGate(root, 'morder', 'tests', repo);
  fx.recordApprove(root, 'morder', chain, identity);

  // the pre-verdict run is green, on the reviewed artifact, and still the
  // latest of its name — only its position in the stream is wrong
  let r = fx.runClose(root, 'morder', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a gate that predates the approve must not close');
  assert.match(r.stderr, /ran before the standing approve was recorded .*review-then-gate order/);
  assert.strictEqual(stateOf().missions.morder.status, 'open');

  // re-running the same gate after the verdict is what the order asks for; both
  // runs are on the unlanded artifact, so only their order distinguishes them
  const afterSeq = fx.runGreenGate(root, 'morder', 'tests', repo);
  fx.land(repo, 'merge');
  r = fx.runClose(root, 'morder', repo, fx.closeInputOf(chain, afterSeq));
  assert.strictEqual(r.status, 0, r.stderr);
}

// --- close: a standing revise is answered, never routed around ---------------
// The cheapest way round a per-route supersession ritual: leave the revise
// standing, reserve a SECOND review route on the same author dispatch naming
// the byte-identical artifact, and record a first (so ritual-free) approve
// there. Two lawful CLI calls, nothing forged, nothing about the artifact
// changed — and the finding is still on the ledger, unanswered.
{
  openM('mtwo');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mtwo', identity);
  const revise = fx.recordReview(root, 'mtwo', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);

  const second = reserveReview(root, fx.reviewRouteInput('mtwo', chain.authorSeq, chain.authorSeq, identity));
  const approve = fx.recordReview(root, 'mtwo', {
    review_route_seq: second.seq,
    review_dispatch_seq: second.seq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve.status, 0, 'a first verdict on a fresh route is legal at the writer');
  const gateSeq = fx.runGreenGate(root, 'mtwo', 'tests', repo);
  fx.land(repo, 'merge');

  const r = fx.runClose(
    root,
    'mtwo',
    repo,
    fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: second.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 1, 'a second route on the same artifact must not overturn a revise');
  assert.match(r.stderr, /carries a standing revise \(seq \d+\) against the very artifact being closed/);
  assert.strictEqual(stateOf().missions.mtwo.status, 'open');
}

// --- close: a standing revise is not escaped by a second MISSION either ------
// The mtwo attack one boundary further out. A route belongs to a mission, an
// artifact does not, and mission ids cost one `mission open` with a valid
// brief: leave the revise standing where it is, open a second mission, reserve
// a chain binding the byte-identical identity, record a first (so ritual-free)
// approve there, gate, land, and close THAT mission. Every call lawful, nothing
// forged — and the finding is still on the ledger, unanswered.
{
  openM('mvictim');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const victim = fx.reserveChain(root, 'mvictim', identity);
  const revise = fx.recordReview(root, 'mvictim', {
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;

  openM('mclean');
  const clean = fx.reserveChain(root, 'mclean', identity);
  const approve = fx.recordReview(root, 'mclean', {
    review_route_seq: clean.reviewSeq,
    review_dispatch_seq: clean.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve.status, 0, 'a first verdict in a fresh mission is legal at the writer');
  const gateSeq = fx.runGreenGate(root, 'mclean', 'tests', repo);
  fx.land(repo, 'merge');

  const r = fx.runClose(root, 'mclean', repo, fx.closeInputOf(clean, gateSeq));
  assert.strictEqual(r.status, 1, 'a second mission on the same artifact must not overturn a revise');
  assert.match(
    r.stderr,
    new RegExp(`mission "mvictim" carries a standing revise \\(seq ${reviseSeq}\\) on its review route ${victim.reviewSeq}`)
  );
  assert.match(r.stderr, /never by opening a second mission on the same work/);
  assert.strictEqual(stateOf().missions.mclean.status, 'open');
  assert.strictEqual(stateOf().missions.mvictim.status, 'open');
}

// --- close: a foreign revise naming a PARTIAL identity does not block --------
// The foreign-scan guard requires a FULL identity, not merely a readable
// object: a revise recording `source_head`, `source_tree` (matching the
// artifact being closed) and `dirty`, but no `patch_digest`, fails
// `carriesFullIdentity` and is skipped exactly as `{}` is — one field short
// rather than four. record-review's own writer refuses any identity that
// isn't the full four fields (`assertExactKeys`), so this record only reaches
// the ledger by hand-append, the same way the mnoid fixture above does.
// Loosening the guard to `isPlainObject` would let `namesSameArtifact` match
// on the shared tree alone and block this close — the case the comment above
// the foreign-scan loop calls an unanswerable wall, since answering it would
// itself be refused by the same full-identity rule on the evidence it cites.
{
  openM('mforeignv');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const victim = fx.reserveChain(root, 'mforeignv', identity);
  const partial = {
    source_head: identity.source_head,
    source_tree: identity.source_tree,
    dirty: identity.dirty,
  };
  appendRaw('review-outcome', 'mforeignv', {
    mission_id: 'mforeignv',
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: partial,
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });

  openM('mforeignc');
  const clean = fx.reserveChain(root, 'mforeignc', identity);
  const approve = fx.recordReview(root, 'mforeignc', {
    review_route_seq: clean.reviewSeq,
    review_dispatch_seq: clean.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mforeignc', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mforeignc', repo, fx.closeInputOf(clean, gateSeq));
  assert.strictEqual(r.status, 0, `a partial foreign identity must not block: ${r.stderr}`);
  assert.strictEqual(stateOf().missions.mforeignc.status, 'done');
}

// --- close: the two foreign-scan guards are pinned INDEPENDENTLY, not only ---
// --- as a pair -----------------------------------------------------------
// A single-outcome foreign revise (above) cannot tell the two
// `carriesFullIdentity` calls apart — whichever one stays strict blocks the
// same record, so loosening either alone still passes that fixture. Each
// guard gets its own two-outcome chain here, engineered so only ONE guard's
// looseness can change the outcome.

// Guard 1 alone — the `aboutThisWork` scan. The standing (last) outcome is
// deliberately unreadable (`{}`) and irrelevant; what matters is an EARLIER
// outcome on the same route carrying a partial identity that matches this
// work, and a malformed link between the two (no `supersedes_seq`). Under
// the committed guard the route is invisible — `aboutThisWork` is false, so
// the malformed chain is never even inspected — and close succeeds. Loosen
// only this guard and the partial outcome makes the route visible, so its
// malformed supersession chain surfaces and refuses the close, whatever
// guard 2 does.
{
  openM('mforeignv1a');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const victim = fx.reserveChain(root, 'mforeignv1a', identity);
  const partial = {
    source_head: identity.source_head,
    source_tree: identity.source_tree,
    dirty: identity.dirty,
  };
  const outcome1 = appendRaw('review-outcome', 'mforeignv1a', {
    mission_id: 'mforeignv1a',
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: partial,
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });
  // Malformed on purpose: claims no supersession, so requireAnsweredChain
  // throws on it the moment the route is inspected at all.
  appendRaw('review-outcome', 'mforeignv1a', {
    mission_id: 'mforeignv1a',
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: {},
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });
  assert.ok(outcome1.seq >= 0);

  openM('mforeignv1c');
  const clean1 = fx.reserveChain(root, 'mforeignv1c', identity);
  const approve1 = fx.recordReview(root, 'mforeignv1c', {
    review_route_seq: clean1.reviewSeq,
    review_dispatch_seq: clean1.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve1.status, 0, approve1.stderr);
  const gateSeq1 = fx.runGreenGate(root, 'mforeignv1c', 'tests', repo);
  fx.land(repo, 'merge');
  const r1 = fx.runClose(root, 'mforeignv1c', repo, fx.closeInputOf(clean1, gateSeq1));
  assert.strictEqual(r1.status, 0, `a partial earlier outcome must leave the route unseen: ${r1.stderr}`);
  assert.strictEqual(stateOf().missions.mforeignv1c.status, 'done');
}

// Guard 2 alone — the standing-verdict check. Outcome 1 carries the FULL,
// matching identity, so `aboutThisWork` is true whatever guard 1 does — this
// isolates guard 2. Outcome 2 properly supersedes outcome 1 (a real green
// gate in the foreign mission answers it, so the chain itself is
// well-formed), but outcome 2's OWN identity is partial. Under the committed
// guard the standing verdict is unreadable and skipped, so close succeeds;
// loosen only this guard and it matches on the shared tree, blocking.
{
  openM('mforeignv2a');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const victim = fx.reserveChain(root, 'mforeignv2a', identity);
  const revise = fx.recordReview(root, 'mforeignv2a', {
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;
  const answeringGateSeq = fx.runGreenGate(root, 'mforeignv2a', 'tests', repo);
  const partial = {
    source_head: identity.source_head,
    source_tree: identity.source_tree,
    dirty: identity.dirty,
  };
  appendRaw('review-outcome', 'mforeignv2a', {
    mission_id: 'mforeignv2a',
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: partial,
    supersedes_seq: reviseSeq,
    reason: 'answering the first revise with a fresh green gate',
    evidence_seq: answeringGateSeq,
  });

  openM('mforeignv2c');
  const clean2 = fx.reserveChain(root, 'mforeignv2c', identity);
  const approve2 = fx.recordReview(root, 'mforeignv2c', {
    review_route_seq: clean2.reviewSeq,
    review_dispatch_seq: clean2.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve2.status, 0, approve2.stderr);
  const gateSeq2 = fx.runGreenGate(root, 'mforeignv2c', 'tests', repo);
  fx.land(repo, 'merge');
  const r2 = fx.runClose(root, 'mforeignv2c', repo, fx.closeInputOf(clean2, gateSeq2));
  assert.strictEqual(r2.status, 0, `a partial standing verdict must not block: ${r2.stderr}`);
  assert.strictEqual(stateOf().missions.mforeignv2c.status, 'done');
}

// --- close: a foreign revise that WAS answered does not block ----------------
// The other half of the cross-mission rule, and the half that decides whether
// it is a fence or a wall. A finding recorded in another mission is honoured
// there: answered on its own route, or by superseding that route with recorded
// evidence, or dissolved because the artifact changed. Each of the three must
// let a second mission on that artifact close.
{
  // (a) answered on its own route, by a superseding verdict with evidence
  openM('mfroute');
  const repoA = fx.newWorkRepo(tmp);
  const idA = fx.artifactIdentity(repoA);
  const foreignA = fx.reserveChain(root, 'mfroute', idA);
  const reviseA = fx.recordReview(root, 'mfroute', {
    review_route_seq: foreignA.reviewSeq,
    review_dispatch_seq: foreignA.reviewSeq,
    verdict: 'revise',
    artifact_identity: idA,
  });
  assert.strictEqual(reviseA.status, 0, reviseA.stderr);
  const evidenceA = fx.runGreenGate(root, 'mfroute', 'tests', repoA);
  const answeredA = fx.recordReview(root, 'mfroute', {
    review_route_seq: foreignA.reviewSeq,
    review_dispatch_seq: foreignA.reviewSeq,
    verdict: 'approve',
    artifact_identity: idA,
    supersedes_seq: JSON.parse(reviseA.stdout).ledger_seq,
    reason: 'finding answered by a recorded gate run',
    evidence_seq: evidenceA,
  });
  assert.strictEqual(answeredA.status, 0, answeredA.stderr);

  openM('mfroute2');
  const chainA = fx.reserveChain(root, 'mfroute2', idA);
  fx.recordApprove(root, 'mfroute2', chainA, idA);
  const gateA = fx.runGreenGate(root, 'mfroute2', 'tests', repoA);
  fx.land(repoA, 'merge');
  let r = fx.runClose(root, 'mfroute2', repoA, fx.closeInputOf(chainA, gateA));
  assert.strictEqual(r.status, 0, `a foreign revise answered on its own route must not block: ${r.stderr}`);
  assert.strictEqual(stateOf().missions.mfroute2.status, 'done');

  // (b) answered by superseding the foreign route, with evidence held to the
  // same standard and scoped to the mission that recorded the finding
  openM('mfsup');
  const repoB = fx.newWorkRepo(tmp);
  const idB = fx.artifactIdentity(repoB);
  const foreignB = fx.reserveChain(root, 'mfsup', idB);
  const reviseB = fx.recordReview(root, 'mfsup', {
    review_route_seq: foreignB.reviewSeq,
    review_dispatch_seq: foreignB.reviewSeq,
    verdict: 'revise',
    artifact_identity: idB,
  });
  assert.strictEqual(reviseB.status, 0, reviseB.stderr);
  const evidenceB = fx.runGreenGate(root, 'mfsup', 'tests', repoB);
  assert.ok(evidenceB > JSON.parse(reviseB.stdout).ledger_seq, 'the evidence postdates the finding');
  supersede(root, {
    mission_id: 'mfsup',
    predecessor_route_seq: foreignB.reviewSeq,
    transition: 'same-class-provider-reroute',
    reason: 'quality',
    evidence_seq: evidenceB,
    replacement: fx.reviewRouteInput('mfsup', foreignB.authorSeq, foreignB.authorSeq, idB),
  });

  openM('mfsup2');
  const chainB = fx.reserveChain(root, 'mfsup2', idB);
  fx.recordApprove(root, 'mfsup2', chainB, idB);
  const gateB = fx.runGreenGate(root, 'mfsup2', 'tests', repoB);
  fx.land(repoB, 'merge');
  r = fx.runClose(root, 'mfsup2', repoB, fx.closeInputOf(chainB, gateB));
  assert.strictEqual(r.status, 0, `a superseded foreign route must not block: ${r.stderr}`);
  assert.strictEqual(stateOf().missions.mfsup2.status, 'done');

  // (c) dissolved: the author changed the artifact, so the foreign finding is
  // no longer about the work being closed
  openM('mfold');
  const repoC = fx.newWorkRepo(tmp);
  const rejected = fx.artifactIdentity(repoC);
  const foreignC = fx.reserveChain(root, 'mfold', rejected);
  const reviseC = fx.recordReview(root, 'mfold', {
    review_route_seq: foreignC.reviewSeq,
    review_dispatch_seq: foreignC.reviewSeq,
    verdict: 'revise',
    artifact_identity: rejected,
  });
  assert.strictEqual(reviseC.status, 0, reviseC.stderr);

  fs.writeFileSync(path.join(repoC, 'fix.txt'), 'the foreign finding, repaired\n');
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'repair the foreign finding']]) {
    const g = spawnSync('git', ['-C', repoC, ...args], { encoding: 'utf8' });
    assert.strictEqual(g.status, 0, g.stderr);
  }
  const repaired = fx.artifactIdentity(repoC);
  assert.notStrictEqual(repaired.source_tree, rejected.source_tree, 'the repair is a different artifact');

  openM('mfnew');
  const chainC = fx.reserveChain(root, 'mfnew', repaired);
  fx.recordApprove(root, 'mfnew', chainC, repaired);
  const gateC = fx.runGreenGate(root, 'mfnew', 'tests', repoC);
  fx.land(repoC, 'merge');
  r = fx.runClose(root, 'mfnew', repoC, fx.closeInputOf(chainC, gateC));
  assert.strictEqual(r.status, 0, `a foreign revise on other bytes must not block: ${r.stderr}`);
  assert.strictEqual(stateOf().missions.mfnew.status, 'done');
}

// --- close: a foreign verdict chain ABOUT THIS ARTIFACT is re-derived too ----
// Foreign chains are read only where they name the artifact being closed — but
// where they do, the same chain rule applies, so a bare overturn hand-appended
// in another mission is no more an answer than one appended here.
{
  openM('mfbare');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const foreign = fx.reserveChain(root, 'mfbare', identity);
  const revise = fx.recordReview(root, 'mfbare', {
    review_route_seq: foreign.reviewSeq,
    review_dispatch_seq: foreign.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  appendRaw('review-outcome', 'mfbare', {
    mission_id: 'mfbare',
    review_route_seq: foreign.reviewSeq,
    review_dispatch_seq: foreign.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });

  openM('mfbare2');
  const chain = fx.reserveChain(root, 'mfbare2', identity);
  fx.recordApprove(root, 'mfbare2', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mfbare2', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mfbare2', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a bare foreign overturn on this artifact must not close');
  assert.match(r.stderr, /answered, never silently replaced/);
  assert.strictEqual(stateOf().missions.mfbare2.status, 'open');
}

// --- close: superseding the rejecting route answers it, with the same evidence
{
  const openSeq = openM('mroute');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mroute', identity);
  const revise = fx.recordReview(root, 'mroute', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;

  // route.js accepts any same-mission record as its evidence_seq; close does
  // not, or superseding the route would be the cheap way round the rule the
  // superseding VERDICT has to obey
  const weak = supersede(root, {
    mission_id: 'mroute',
    predecessor_route_seq: chain.reviewSeq,
    transition: 'same-class-provider-reroute',
    reason: 'quality',
    evidence_seq: openSeq,
    replacement: fx.reviewRouteInput('mroute', chain.authorSeq, chain.authorSeq, identity),
  });
  const approve = fx.recordReview(root, 'mroute', {
    review_route_seq: weak.route.seq,
    review_dispatch_seq: weak.route.seq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mroute', 'tests', repo);
  fx.land(repo, 'merge');
  const input = fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: weak.route.seq }, gateSeq);

  let r = fx.runClose(root, 'mroute', repo, input);
  assert.strictEqual(r.status, 1, 'a supersession citing the mission-open record answers nothing');
  assert.match(r.stderr, /the supersession of review route \d+ .*which answers the standing revise/);
  assert.match(r.stderr, /a "mission-open" record/);
  assert.strictEqual(stateOf().missions.mroute.status, 'open');

  // the same shape with real evidence — a gate recorded after the finding —
  // closes: this is the recorded way to answer a revise on unchanged work
  openM('mroute2');
  const repo2 = fx.newWorkRepo(tmp);
  const identity2 = fx.artifactIdentity(repo2);
  const chain2 = fx.reserveChain(root, 'mroute2', identity2);
  const revise2 = fx.recordReview(root, 'mroute2', {
    review_route_seq: chain2.reviewSeq,
    review_dispatch_seq: chain2.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity2,
  });
  assert.strictEqual(revise2.status, 0, revise2.stderr);
  const evidenceSeq = fx.runGreenGate(root, 'mroute2', 'tests', repo2);
  assert.ok(evidenceSeq > JSON.parse(revise2.stdout).ledger_seq, 'the evidence postdates the finding');
  const strong = supersede(root, {
    mission_id: 'mroute2',
    predecessor_route_seq: chain2.reviewSeq,
    transition: 'same-class-provider-reroute',
    reason: 'quality',
    evidence_seq: evidenceSeq,
    replacement: fx.reviewRouteInput('mroute2', chain2.authorSeq, chain2.authorSeq, identity2),
  });
  const approve2 = fx.recordReview(root, 'mroute2', {
    review_route_seq: strong.route.seq,
    review_dispatch_seq: strong.route.seq,
    verdict: 'approve',
    artifact_identity: identity2,
  });
  assert.strictEqual(approve2.status, 0, approve2.stderr);
  const gate2 = fx.runGreenGate(root, 'mroute2', 'tests', repo2);
  fx.land(repo2, 'merge');
  r = fx.runClose(
    root,
    'mroute2',
    repo2,
    fx.closeInputOf({ authorSeq: chain2.authorSeq, reviewSeq: strong.route.seq }, gate2)
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mroute2.status, 'done');
}

// --- close: a genuine second round names a different artifact and stays legal
// The rule is scoped to the identity being closed, so the ordinary repair loop
// — revise, the author fixes it, a fresh review route on the new commit —
// closes with the old finding on the ledger and no ritual at all.
{
  openM('mfix');
  const repo = fx.newWorkRepo(tmp);
  const rejected = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mfix', rejected);
  const revise = fx.recordReview(root, 'mfix', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: rejected,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);

  fs.writeFileSync(path.join(repo, 'fix.txt'), 'the finding, repaired\n');
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'repair the finding']]) {
    const g = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.strictEqual(g.status, 0, g.stderr);
  }
  const repaired = fx.artifactIdentity(repo);
  assert.notStrictEqual(repaired.source_head, rejected.source_head, 'the repair is a different artifact');

  const round2 = reserveReview(root, fx.reviewRouteInput('mfix', chain.authorSeq, chain.authorSeq, repaired));
  const approve = fx.recordReview(root, 'mfix', {
    review_route_seq: round2.seq,
    review_dispatch_seq: round2.seq,
    verdict: 'approve',
    artifact_identity: repaired,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mfix', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mfix',
    repo,
    fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: round2.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mfix.status, 'done');
}

// --- close: an empty commit is a relabel, not a second round -----------------
// The cheapest thing that ever looked like "the artifact changed":
// `git commit --allow-empty` mints a fresh source_head while source_tree and
// patch_digest stay byte-identical, so a head-keyed match would let the very
// bytes the reviewer rejected close under a new name. The match is on content.
{
  openM('mempty');
  const repo = fx.newWorkRepo(tmp);
  const rejected = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mempty', rejected);
  const revise = fx.recordReview(root, 'mempty', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: rejected,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);

  const empty = spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'relabel'], { encoding: 'utf8' });
  assert.strictEqual(empty.status, 0, empty.stderr);
  const relabelled = fx.artifactIdentity(repo);
  assert.notStrictEqual(relabelled.source_head, rejected.source_head, 'the head is fresh');
  assert.strictEqual(relabelled.source_tree, rejected.source_tree, 'the tree is the rejected one');
  assert.strictEqual(relabelled.patch_digest, rejected.patch_digest, 'the patch is the rejected one');

  const round2 = reserveReview(root, fx.reviewRouteInput('mempty', chain.authorSeq, chain.authorSeq, relabelled));
  const approve = fx.recordReview(root, 'mempty', {
    review_route_seq: round2.seq,
    review_dispatch_seq: round2.seq,
    verdict: 'approve',
    artifact_identity: relabelled,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mempty', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mempty',
    repo,
    fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: round2.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 1, 'an empty-commit relabel must not escape a standing revise');
  assert.match(r.stderr, /carries a standing revise \(seq \d+\) against the very artifact being closed/);
  assert.strictEqual(stateOf().missions.mempty.status, 'open');
}

// --- close: a rebase is a relabel too, and so is a reparent ------------------
// Neither of these needs an attacker. A sibling step lands on main, the author
// runs `git rebase main`, and the canonical patch the review route recorded is
// byte-identical while the tree now carries the sibling's file — so a match
// requiring BOTH content fields stops firing and the rejected change closes.
// The mirror image (the same tree reparented onto the moved mainline) moves
// the patch instead. The predicate is disjunctive precisely so that either
// field alone still identifies the work.
{
  const cases = [
    [
      'mreb',
      'sibling-a',
      (repo) => gitAt(repo, 'rebase', '-q', 'main'),
      (moved, rejected) => {
        assert.strictEqual(moved.patch_digest, rejected.patch_digest, 'the rebase preserves the patch');
        assert.notStrictEqual(moved.source_tree, rejected.source_tree, 'the rebase moves the tree');
      },
    ],
    [
      'mrepar',
      'sibling-b',
      (repo) => {
        const reparented = gitAt(
          repo,
          'commit-tree',
          gitAt(repo, 'rev-parse', 'HEAD^{tree}'),
          '-p',
          gitAt(repo, 'rev-parse', 'main'),
          '-m',
          'reparent onto the moved mainline'
        );
        gitAt(repo, 'reset', '-q', '--hard', reparented);
      },
      (moved, rejected) => {
        assert.strictEqual(moved.source_tree, rejected.source_tree, 'the reparent preserves the tree');
        assert.notStrictEqual(moved.patch_digest, rejected.patch_digest, 'the reparent moves the patch');
      },
    ],
  ];
  for (const [id, sibling, move, expectShape] of cases) {
    openM(id);
    const repo = fx.newWorkRepo(tmp);
    const rejected = fx.artifactIdentity(repo);
    const chain = fx.reserveChain(root, id, rejected);
    const revise = fx.recordReview(root, id, {
      review_route_seq: chain.reviewSeq,
      review_dispatch_seq: chain.reviewSeq,
      verdict: 'revise',
      artifact_identity: rejected,
    });
    assert.strictEqual(revise.status, 0, revise.stderr);

    landSibling(repo, sibling);
    move(repo);
    const moved = fx.artifactIdentity(repo);
    expectShape(moved, rejected);

    const round2 = reserveReview(root, fx.reviewRouteInput(id, chain.authorSeq, chain.authorSeq, moved));
    const approve = fx.recordReview(root, id, {
      review_route_seq: round2.seq,
      review_dispatch_seq: round2.seq,
      verdict: 'approve',
      artifact_identity: moved,
    });
    assert.strictEqual(approve.status, 0, approve.stderr);
    const gateSeq = fx.runGreenGate(root, id, 'tests', repo);
    fx.land(repo, 'merge');
    const r = fx.runClose(
      root,
      id,
      repo,
      fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: round2.seq }, gateSeq)
    );
    assert.strictEqual(r.status, 1, `${id}: one content field surviving is still the same work`);
    assert.match(r.stderr, /carries a standing revise \(seq \d+\) against the very artifact being closed/);
    assert.strictEqual(stateOf().missions[id].status, 'open');
  }
}

// --- close: the same predicate across the mission boundary -------------------
{
  openM('mrebv');
  const repo = fx.newWorkRepo(tmp);
  const rejected = fx.artifactIdentity(repo);
  const victim = fx.reserveChain(root, 'mrebv', rejected);
  const revise = fx.recordReview(root, 'mrebv', {
    review_route_seq: victim.reviewSeq,
    review_dispatch_seq: victim.reviewSeq,
    verdict: 'revise',
    artifact_identity: rejected,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;

  landSibling(repo, 'sibling-c');
  gitAt(repo, 'rebase', '-q', 'main');
  const rebased = fx.artifactIdentity(repo);
  assert.strictEqual(rebased.patch_digest, rejected.patch_digest, 'the rebase preserves the patch');

  openM('mrebc');
  const clean = fx.reserveChain(root, 'mrebc', rebased);
  const approve = fx.recordReview(root, 'mrebc', {
    review_route_seq: clean.reviewSeq,
    review_dispatch_seq: clean.reviewSeq,
    verdict: 'approve',
    artifact_identity: rebased,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mrebc', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mrebc', repo, fx.closeInputOf(clean, gateSeq));
  assert.strictEqual(r.status, 1, 'a rebase does not dissolve another mission\'s finding either');
  assert.match(
    r.stderr,
    new RegExp(`mission "mrebv" carries a standing revise \\(seq ${reviseSeq}\\) on its review route ${victim.reviewSeq}`)
  );
  assert.strictEqual(stateOf().missions.mrebc.status, 'open');
}

// --- close: after a rebase the finding is still ANSWERABLE on its own route --
// The fence and the answer share one predicate, so the honest path stays open:
// a gate run after the rebase is evidence about the same work the finding
// judged, the superseding verdict records it, and the mission closes with the
// finding answered rather than dissolved.
{
  openM('mansrb');
  const repo = fx.newWorkRepo(tmp);
  const rejected = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mansrb', rejected);
  const revise = fx.recordReview(root, 'mansrb', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: rejected,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);

  landSibling(repo, 'sibling-d');
  gitAt(repo, 'rebase', '-q', 'main');
  const rebased = fx.artifactIdentity(repo);
  const evidenceSeq = fx.runGreenGate(root, 'mansrb', 'tests', repo);
  // the verdict names the identity ITS route bound; the evidence is the gate
  // that ran on the rebased tree, and the two are the same work
  const answer = fx.recordReview(root, 'mansrb', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: rejected,
    supersedes_seq: JSON.parse(revise.stdout).ledger_seq,
    reason: 'finding answered by a gate run after the rebase',
    evidence_seq: evidenceSeq,
  });
  assert.strictEqual(answer.status, 0, `a post-rebase gate must answer the finding it postdates: ${answer.stderr}`);

  const round2 = reserveReview(root, fx.reviewRouteInput('mansrb', chain.authorSeq, chain.authorSeq, rebased));
  const approve = fx.recordReview(root, 'mansrb', {
    review_route_seq: round2.seq,
    review_dispatch_seq: round2.seq,
    verdict: 'approve',
    artifact_identity: rebased,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mansrb', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mansrb',
    repo,
    fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: round2.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 0, `an answered finding must leave the work closable: ${r.stderr}`);
  assert.strictEqual(stateOf().missions.mansrb.status, 'done');
}

// --- close: a revise naming {} says as little as one naming nothing ----------
{
  openM('mnoid');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mnoid', identity);
  // record-review binds the verdict to the route's identity, so an empty one
  // reaches the ledger only by hand-append
  appendRaw('review-outcome', 'mnoid', {
    mission_id: 'mnoid',
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: {},
    supersedes_seq: null,
    reason: null,
    evidence_seq: null,
  });
  const second = reserveReview(root, fx.reviewRouteInput('mnoid', chain.authorSeq, chain.authorSeq, identity));
  const approve = fx.recordReview(root, 'mnoid', {
    review_route_seq: second.seq,
    review_dispatch_seq: second.seq,
    verdict: 'approve',
    artifact_identity: identity,
  });
  assert.strictEqual(approve.status, 0, approve.stderr);
  const gateSeq = fx.runGreenGate(root, 'mnoid', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(
    root,
    'mnoid',
    repo,
    fx.closeInputOf({ authorSeq: chain.authorSeq, reviewSeq: second.seq }, gateSeq)
  );
  assert.strictEqual(r.status, 1, 'an empty identity is not a match, it is an unreadable finding');
  assert.match(r.stderr, /is a revise naming no artifact/);
  assert.strictEqual(stateOf().missions.mnoid.status, 'open');
}

// --- close: the evidence rule is re-derived, not trusted to the writer -------
// Each of these is refused by record-review and hand-appended past it; close
// derives the same rule from the records, because the writer is exactly what a
// forger skips.
// Three missions, one defect each: the chain is well-formed in every other
// respect, so each close refuses on the clause under test and nothing else.
{
  const cases = [
    // a gate record — but another mission's
    ['mevx', (ctx) => mxGateSeq, /belongs to mission "mx", not "mevx"/],
    // this mission's own gate, recorded before the finding it claims to refute
    ['mevp', (ctx) => ctx.staleSeq, /does not postdate the verdict at seq \d+ it answers/],
    // the overturning record pointing at itself
    ['mevs', (ctx) => ctx.nextSeq, /a "review-outcome" record; contradictory repository evidence is a gate record/],
  ];
  for (const [id, evidenceOf, expected] of cases) {
    openM(id);
    const repo = fx.newWorkRepo(tmp);
    const identity = fx.artifactIdentity(repo);
    const chain = fx.reserveChain(root, id, identity);
    // a gate that predates the finding — the "stale" evidence of case two, and
    // the gate every one of these closes cites
    const staleSeq = fx.runGreenGate(root, id, 'tests', repo);
    const revise = fx.recordReview(root, id, {
      review_route_seq: chain.reviewSeq,
      review_dispatch_seq: chain.reviewSeq,
      verdict: 'revise',
      artifact_identity: identity,
    });
    assert.strictEqual(revise.status, 0, revise.stderr);
    const reviseSeq = JSON.parse(revise.stdout).ledger_seq;
    const nextSeq = ledgerOf().records.length;
    appendRaw('review-outcome', id, {
      mission_id: id,
      review_route_seq: chain.reviewSeq,
      review_dispatch_seq: chain.reviewSeq,
      verdict: 'approve',
      artifact_identity: identity,
      supersedes_seq: reviseSeq,
      reason: 'disagreed with the finding',
      evidence_seq: evidenceOf({ staleSeq, nextSeq }),
    });
    const gateSeq = fx.runGreenGate(root, id, 'tests', repo);
    fx.land(repo, 'merge');
    const r = fx.runClose(root, id, repo, fx.closeInputOf(chain, gateSeq));
    assert.strictEqual(r.status, 1, `${id}: this overturn must not close`);
    assert.match(r.stderr, expected);
    assert.strictEqual(stateOf().missions[id].status, 'open');
  }
}

// --- close: a lone verdict may not claim a supersession that never happened --
{
  openM('mfirst');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mfirst', identity);
  appendRaw('review-outcome', 'mfirst', {
    mission_id: 'mfirst',
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: 0,
    reason: 'answers a verdict that is not there',
    evidence_seq: 0,
  });
  const gateSeq = fx.runGreenGate(root, 'mfirst', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mfirst', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a close must not name a supersession that never happened');
  assert.match(r.stderr, /is the first for review route \d+ and claims to supersede seq 0/);
}

// --- close: overturn evidence may not skip the identity binding by omission --
// gate.js always records the identity fields, so a green gate that carries
// none of them in a stream where every lawful gate does is a hand-append, and
// omission would otherwise be the cheapest way past "the evidence must be
// about the artifact the finding judged". Bounded exactly as the gate check is.
{
  openM('mevo');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mevo', identity);
  const revise = fx.recordReview(root, 'mevo', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;
  const blindSeq = appendRaw('gate', 'mevo', {
    gate_id: 'tests',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mevo',
  }).seq;
  assert.ok(blindSeq > reviseSeq, 'the blind gate postdates the finding, so only the omission is under test');

  // the writer refuses it
  const overturn = {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: reviseSeq,
    reason: 'answered by a gate that names no artifact',
    evidence_seq: blindSeq,
  };
  const refused = fx.recordReview(root, 'mevo', overturn);
  assert.strictEqual(refused.status, 1, 'an identity-less gate is not overturn evidence');
  assert.match(refused.stderr, /carries no artifact identity although this stream's gate records have carried one since seq \d+/);

  // and so does close, when the same record is appended past the writer
  appendRaw('review-outcome', 'mevo', { mission_id: 'mevo', ...overturn });
  const gateSeq = fx.runGreenGate(root, 'mevo', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mevo', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'close re-derives the same bound');
  assert.match(r.stderr, /carries no artifact identity although this stream's gate records have carried one since seq \d+/);
  assert.strictEqual(stateOf().missions.mevo.status, 'open');
}

// --- record-review: an identity naming nothing is unreadable at the evidence
// check too, not merely a non-match. `{}` has one meaning across the module:
// the predicate never sees it, and every site that could pass it one says so.
{
  openM('mevempty');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mevempty', identity);
  const revise = fx.recordReview(root, 'mevempty', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: identity,
  });
  assert.strictEqual(revise.status, 0, revise.stderr);
  const reviseSeq = JSON.parse(revise.stdout).ledger_seq;
  // a green gate that carries an identity object with no fields in it: past
  // the omission bound (it does carry artifact_identity), and still nothing
  const blindSeq = appendRaw('gate', 'mevempty', {
    gate_id: 'tests',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mevempty',
    artifact_identity: {},
  }).seq;
  const refused = fx.recordReview(root, 'mevempty', {
    review_route_seq: chain.reviewSeq,
    review_dispatch_seq: chain.reviewSeq,
    verdict: 'approve',
    artifact_identity: identity,
    supersedes_seq: reviseSeq,
    reason: 'answered by a gate whose identity says nothing',
    evidence_seq: blindSeq,
  });
  assert.strictEqual(refused.status, 1, 'an identity naming nothing is not evidence about this work');
  assert.match(refused.stderr, new RegExp(`rests on an identity that names no artifact: gate record ${blindSeq}`));
}

// --- close: a dishonest green under another name is as unanswered as a red ---
{
  openM('mhon');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mhon', identity);
  fx.recordApprove(root, 'mhon', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mhon', 'tests', repo);
  // exit 0, but the gate's own identity_check says it mutated the tree it
  // tested — check-honesty and checkGateIdentity both call that a non-pass
  appendRaw('gate', 'mhon', {
    gate_id: 'lint',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mhon',
    artifact_identity: identity,
    identity_check: { verified: false, changed: [{ field: 'source_tree' }], error: null },
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mhon', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a dishonest green under another gate_id must block the close');
  assert.match(r.stderr, /exited 0 but reports that it mutated the tree it tested/);
}

// --- close: which record authorized a degraded review is recorded ------------
// A cross-family reviewer reserved before the author was spawned and lost
// before the review is a legal degraded close — the snapshot did not authorize
// it, the recorded replacement did, and the close record says so rather than
// leaving the two indistinguishable.
{
  openM('mdev');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mdev', identity, {
    author: {
      task_class: 'apex',
      reserved_review: {
        seat: 'reviewer-terra',
        family: 'gpt',
        model: 'gpt-5.6-sol',
        effort: 'high',
        independence: 'cross-family',
      },
    },
    review: { replacement_reason: 'gpt lane lost after the author was spawned' },
  });
  fx.recordApprove(root, 'mdev', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mdev', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mdev', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, r.stderr);
  const { records } = ledgerOf();
  const close = records[records.length - 1];
  assert.strictEqual(close.review.independence, 'degraded-path');
  assert.strictEqual(close.review.degraded_authorization, 'deviation');
  assert.strictEqual(close.review.replacement_reason, 'gpt lane lost after the author was spawned');
}

// --- close: a repository problem never masks the one-shot refusal ------------
{
  openM('monce');
  const done = fx.closeMissionFully(root, 'monce', { dir: tmp });
  // the landing line moves on, as it does in any live repository
  const renamed = spawnSync('git', ['-C', done.repo, 'branch', '-m', 'main', 'trunk'], { encoding: 'utf8' });
  assert.strictEqual(renamed.status, 0, renamed.stderr);
  const r = fx.runClose(root, 'monce', done.repo, done.input);
  assert.strictEqual(r.status, 1);
  assert.match(
    r.stderr,
    /has status "done" — only an open mission accepts writes/,
    'the message names the one-shot, not the repository the proof would have failed in'
  );
}

// --- a done mission accepts no further writes --------------------------------
{
  const again = fx.runClose(root, 'm1', m1Repo, m1Input);
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /status "done"/);

  const cp = mission(['checkpoint', root, 'm1'], { step: 'a', done_evidence: 'b', next: 'c' });
  assert.strictEqual(cp.status, 1);
  assert.match(cp.stderr, /status "done"/);

  const env = mission(['record-envelope', root, 'm1', 'scout'], {
    state: 'done',
    result: 'r',
    evidence: 'e',
    risks: 'none',
    artifact: 'a.md',
    question: '',
  });
  assert.strictEqual(env.status, 1);
  assert.match(env.stderr, /status "done"/);

  const consult = mission(['record-consult', root, 'm1'], {
    consult_id: 'c9',
    question: 'q',
    verdict: 'v',
    anchor: 'a:1',
  });
  assert.strictEqual(consult.status, 1);
  assert.match(consult.stderr, /status "done"/);

  const verdict = fx.recordReview(root, 'm1', {
    review_route_seq: m1Chain.reviewSeq,
    review_dispatch_seq: m1Chain.reviewSeq,
    verdict: 'revise',
    artifact_identity: m1Identity,
  });
  assert.strictEqual(verdict.status, 1);
  assert.match(verdict.stderr, /status "done"/);
}

// --- close: a superseded green gate is stale evidence ------------------------
{
  openM('mstale');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mstale', identity);
  fx.recordApprove(root, 'mstale', chain, identity);
  const passSeq = fx.runGreenGate(root, 'mstale', 'tests', repo);

  // a later run of the same gate fails (pre-merge, like every §8 gate)
  const laterFail = run(GATE, ['run-gate', '--worktree', repo, root, 'mstale', 'tests', '--', 'false']);
  assert.strictEqual(laterFail.status, 0, laterFail.stderr);
  const failSeq = JSON.parse(laterFail.stdout).ledger_seq;

  const stale = fx.runClose(root, 'mstale', repo, fx.closeInputOf(chain, passSeq));
  assert.strictEqual(stale.status, 1, 'close must refuse a green gate a newer run has turned red');
  assert.match(stale.stderr, /superseded by a later run/);

  const failed = fx.runClose(root, 'mstale', repo, fx.closeInputOf(chain, failSeq));
  assert.strictEqual(failed.status, 1);
  assert.match(failed.stderr, /exit_code 1/);
  assert.strictEqual(stateOf().missions.mstale.status, 'open');

  // A fresh green run of the same gate restores closeability at its own seq.
  const rerun = run(GATE, ['run-gate', '--worktree', repo, root, 'mstale', 'tests', '--', 'true']);
  assert.strictEqual(rerun.status, 0, rerun.stderr);
  const freshSeq = JSON.parse(rerun.stdout).ledger_seq;
  fx.land(repo, 'merge');
  const closed = fx.runClose(root, 'mstale', repo, fx.closeInputOf(chain, freshSeq));
  assert.strictEqual(closed.status, 0, closed.stderr);
  assert.strictEqual(stateOf().missions.mstale.status, 'done');
}

// --- symlink containment -----------------------------------------------------
{
  // open refused when missions/<id> is a pre-planted (dangling) symlink
  const nowhere = path.join(tmp, 'nowhere');
  fs.symlinkSync(nowhere, path.join(root, 'missions', 'm5'));
  const r = mission(['open', root], { mission_id: 'm5', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /symlink/);
  assert.ok(!fs.existsSync(nowhere), 'nothing created through the symlink');
  assert.strictEqual(stateOf().missions.m5, undefined);

  // record-envelope refused when envelopes/ is a symlink out of the tree
  const outside = path.join(tmp, 'outside-envelopes');
  fs.mkdirSync(outside);
  assert.strictEqual(
    mission(['open', root], { mission_id: 'm6', title: 'x', brief: VALID_BRIEF }).status,
    0
  );
  const envDir = path.join(root, 'missions', 'm6', 'envelopes');
  fs.rmdirSync(envDir);
  fs.symlinkSync(outside, envDir);
  const before = ledgerOf().records.length;
  const env = mission(['record-envelope', root, 'm6', 'scout'], {
    state: 'done',
    result: 'r',
    evidence: 'e',
    risks: 'none',
    artifact: 'a.md',
    question: '',
  });
  assert.strictEqual(env.status, 1);
  assert.match(env.stderr, /symlink/);
  assert.deepStrictEqual(fs.readdirSync(outside), [], 'no envelope escaped the tree');
  assert.strictEqual(ledgerOf().records.length, before, 'no ledger record for the refused envelope');
}

// --- argv fail-closed --------------------------------------------------------
{
  let r = mission(['open', root, 'surplus'], { mission_id: 'x', title: 'x', brief: VALID_BRIEF });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exactly 1 argument/);

  r = mission(['frobnicate', root]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown command/);

  r = run(MISSION, ['checkpoint', root, 'm2'], undefined); // empty stdin
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /valid JSON/);

  // --repo without a path
  r = run(MISSION, ['close', '--repo'], undefined);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--repo requires a path/);

  // --repo consumed, then arity still enforced
  r = run(MISSION, ['close', '--repo', tmp, root], undefined);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exactly 2 argument/);
}

console.log('test-mission: OK');
