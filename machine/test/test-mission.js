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
const { supersede } = require(path.join(__dirname, '..', 'src', 'route.js'));
const fx = require('./close-fixture.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mission-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');

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
  const chain = fx.reserveChain(root, 'mabs', fx.artifactIdentity(repo), {
    review: { author_dispatch_seq: 100000 },
  });
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
  const chain = fx.reserveChain(root, 'msup', fx.artifactIdentity(repo));
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

// --- close: a family lie fails the floor recorded at route time --------------
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
      reviewer_seat: 'reviewer-terra',
      reviewer_family: 'gpt',
      reviewer_model: 'gpt-5.6',
      reviewer_effort: 'high',
      independence: 'cross-family',
    }),
    phase: 'review',
    predecessor: null,
  });
  const gateSeq = fx.runGreenGate(root, 'mlie', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mlie', repo, {
    ...fx.closeInputOf({ authorSeq: author.authorSeq, reviewSeq: lying.seq }, gateSeq),
  });
  assert.strictEqual(r.status, 1, 'a review profile the route never reserved must not close unexplained');
  assert.match(r.stderr, /floor recorded at route time was not met/);
}

// --- close: mislabeled independence — degraded reported as cross-family ------
{
  openM('mind');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  // The reservation itself carries the laundered label, so the floor check
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
  const gateSeq = fx.runGreenGate(root, 'mind', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mind', repo, fx.closeInputOf({ authorSeq: author.seq, reviewSeq: review.seq }, gateSeq));
  assert.strictEqual(r.status, 1, 'a same-family review labeled cross-family must not close');
  assert.match(r.stderr, /laundered label/);
}

// --- close: the artifact changed between review and gate ----------------------
{
  openM('mchg');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mchg', fx.artifactIdentity(repo));
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

// --- close: a gate that mutated the tree it tested is not pass evidence ------
// The same record check-honesty refuses — close and the audit agree.
{
  openM('mmut');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mmut', fx.artifactIdentity(repo));
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
  const chain = fx.reserveChain(root, 'mnul', fx.artifactIdentity(repo));
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
// A legal close is never invalidated by a field arriving later.
{
  openM('mleg');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mleg', fx.artifactIdentity(repo));
  const legacy = appendRaw('gate', 'mleg', {
    gate_id: 'legacy',
    cmd: ['true'],
    exit_code: 0,
    mission_id: 'mleg',
  });
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mleg', repo, fx.closeInputOf(chain, legacy.seq));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(stateOf().missions.mleg.status, 'done');
}

// --- close: landing refusals -------------------------------------------------
{
  openM('mnol');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mnol', fx.artifactIdentity(repo));
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
  });
  assert.deepStrictEqual(close.artifact_identity, m1Identity);
  assert.strictEqual(close.gate_seq, m1GateSeq);
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
  const chain = fx.reserveChain(root, 'mrec', fx.artifactIdentity(repo), {
    author: { task_class: 'apex' },
  });
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
}

// --- close: a superseded green gate is stale evidence ------------------------
{
  openM('mstale');
  const repo = fx.newWorkRepo(tmp);
  const chain = fx.reserveChain(root, 'mstale', fx.artifactIdentity(repo));
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
