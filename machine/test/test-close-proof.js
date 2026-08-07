'use strict';

// Regressions for battery findings D4 and D5 (closing-battery-report.md):
//
// D5 — commit containment alone is a one-way proof. "The reviewed commit is
// an ancestor of the landing branch" stays true when the landing branch's
// tip is a later, never-reviewed descendant of it, so an unreviewed commit
// added to the work branch after the gate and merged alongside the reviewed
// one used to land clean (battery 4.2c). proveLanding (mission.js) now also
// requires the reviewed commit to sit directly at the landing tip — either
// AS the tip, or as one of the tip's own parents — which the two legitimate
// landing shapes (a no-ff merge of exactly the reviewed head, and a head
// rebased onto the merge target then re-gated) both satisfy on their own.
//
// D4 — the `dirty` fence (validateArtifactIdentity, route.js) sits only at
// review-reservation and gate time, over the WORK worktree; nothing at close
// time inspected the LANDING repository's own working tree, so a dirty
// landing repo closed clean (battery 4.2b). proveLanding now refuses when
// the landing repository itself carries an uncommitted change.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJson } = require(path.join(__dirname, '..', 'src', 'atomic-json.js'));
const fx = require('./close-fixture.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-close-proof-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, '.maestro');
fx.initRouting(root);

const MISSION = path.join(__dirname, '..', 'src', 'mission.js');

function run(script, args, stdin) {
  return spawnSync(process.execPath, [script, ...args], {
    input: stdin === undefined ? '' : JSON.stringify(stdin),
    encoding: 'utf8',
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

function openM(id) {
  const r = mission(['open', root], { mission_id: id, title: `mission ${id}`, brief: VALID_BRIEF });
  assert.strictEqual(r.status, 0, r.stderr);
}

function stateOf() {
  return readJson(path.join(root, 'state.json'), undefined);
}

function gitAt(repo, ...args) {
  const g = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(g.status, 0, `git -C ${repo} ${args.join(' ')}: ${g.stderr}`);
  return g.stdout.trim();
}

// A sibling step lands on main between review and close — the ordinary shape
// of parallel work, and what makes a rebase happen at all.
function landSibling(repo, name) {
  const branch = gitAt(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  gitAt(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', `sibling ${name} lands`);
  gitAt(repo, 'checkout', '-q', branch);
}

// --- D5 refusing: reproduce battery 4.2c — an extra unreviewed commit rides
// along the reviewed one into the same merge ----------------------------------
{
  openM('m4_2c');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'm4_2c', identity);
  fx.recordApprove(root, 'm4_2c', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'm4_2c', 'tests', repo);

  // Added to the work branch AFTER the gate ran — never reviewed, never gated.
  fs.writeFileSync(path.join(repo, 'sneak.txt'), 'sneak\n');
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', 'sneak in after the gate');

  fx.land(repo, 'merge'); // merges the sneak-carrying head, not the reviewed one
  const r = fx.runClose(root, 'm4_2c', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a stray unreviewed commit riding the merge must refuse the close');
  assert.match(r.stderr, /does not land it directly/);
  assert.match(r.stderr, /content beyond the reviewed identity rode along unreviewed/);
  assert.strictEqual(stateOf().missions.m4_2c.status, 'open');
}

// --- D5 passing (legitimate shape 1): a no-ff merge of exactly the reviewed
// head still closes ------------------------------------------------------------
{
  openM('mlegmerge');
  const done = fx.closeMissionFully(root, 'mlegmerge', { dir: tmp, landing: 'merge' });
  assert.strictEqual(done.result.landing.method, 'commit-containment');
  assert.strictEqual(stateOf().missions.mlegmerge.status, 'done');
}

// --- D5 passing (legitimate shape 2): a head rebased onto the merge target,
// then re-gated, still closes — this mission's own standard practice --------
{
  openM('mlegrebase');
  const repo = fx.newWorkRepo(tmp);

  landSibling(repo, 'sibling-rebase');
  gitAt(repo, 'rebase', '-q', 'main');
  const rebased = fx.artifactIdentity(repo);

  const chain = fx.reserveChain(root, 'mlegrebase', rebased);
  fx.recordApprove(root, 'mlegrebase', chain, rebased);
  const gateSeq = fx.runGreenGate(root, 'mlegrebase', 'tests', repo);
  fx.land(repo, 'merge');
  const r = fx.runClose(root, 'mlegrebase', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, `rebase-then-gate must still close: ${r.stderr}`);
  assert.strictEqual(JSON.parse(r.stdout).landing.method, 'commit-containment');
  assert.strictEqual(stateOf().missions.mlegrebase.status, 'done');
}

// --- D4 refusing: reproduce battery 4.2b — an uncommitted change in the
// landing repo at close time -------------------------------------------------
{
  openM('m4_2b');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'm4_2b', identity);
  fx.recordApprove(root, 'm4_2b', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'm4_2b', 'tests', repo);
  fx.land(repo, 'merge');

  // Left uncommitted in the landing repo before close.
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');

  const r = fx.runClose(root, 'm4_2b', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'a dirty landing repo must refuse the close');
  assert.match(r.stderr, /uncommitted change/);
  assert.match(r.stderr, /dirty\.txt/);
  assert.strictEqual(stateOf().missions.m4_2b.status, 'open');

  // Cleaning it up lets the same close proceed — the fence is the dirt, not
  // the mission.
  gitAt(repo, 'clean', '-fd');
  const r2 = fx.runClose(root, 'm4_2b', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r2.status, 0, `a clean landing repo must close once the dirt is gone: ${r2.stderr}`);
  assert.strictEqual(stateOf().missions.m4_2b.status, 'done');
}

console.log('test-close-proof: OK');
