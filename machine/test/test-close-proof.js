'use strict';

// Regressions for battery findings D4 and D5 (closing-battery-report.md), and
// for review-slice8b.md's F1/F2/F3 findings on the first pass at D5:
//
// D5, round one — commit containment alone is a one-way proof: "the reviewed
// commit is an ancestor of the landing branch" stays true when the branch's
// own tip is a later, never-reviewed descendant of it, so an unreviewed
// commit added to the work branch after the gate and merged alongside the
// reviewed one used to land clean (battery 4.2c).
//
// D5, round two (F1/F2) — testing the tip's own parent list (round one's
// fix) is a fixture-shaped proxy: it missed an ordinary commit stacked on a
// fast-forward landing (probe B), a merge with the reviewed head in the
// FIRST parent position and a sneak sidecar in the second (probe C), an
// octopus merge (probe D), and a squash landing with an extra unreviewed
// commit riding after it (probe E) — the tip-parent check ran only on the
// commit-containment path. `locateLanding` (mission.js) instead walks the
// landing branch's own first-parent history to find the SPECIFIC commit that
// introduced the reviewed work, and proves THAT commit introduced exactly
// the gated work and nothing riding along with it.
//
// F3 — a legitimate close must remain legal after a later, separately
// reviewed sibling lands on the target branch before this mission closes:
// `locateLanding` walks straight past a later merge whose first parent
// already contains the reviewed commit, because that merge is not the
// introduction being judged.
//
// D4 — the `dirty` fence (validateArtifactIdentity, route.js) sits only at
// review-reservation and gate time, over the WORK worktree; nothing at close
// time inspected the LANDING repository's own working tree, so a dirty
// landing repo closed clean (battery 4.2b). proveLanding refuses when the
// landing repository itself carries an uncommitted change — unchanged by the
// F1/F2 repair, per the review's own confirmation that D4 is correct.

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

// Fast-forwards main to the work branch's tip directly — no merge commit —
// which is only possible because the fixture's work branch never diverges
// from main on its own side.
function ffLand(repo) {
  gitAt(repo, 'checkout', '-q', 'main');
  gitAt(repo, 'merge', '-q', '--ff-only', 'work');
}

// Builds a one-commit branch off `from`, unrelated to the reviewed work, and
// leaves the repo checked out on `from` again — the "sneak" content probes B
// through E each attach differently.
function sneakBranch(repo, from, name) {
  gitAt(repo, 'checkout', '-q', from);
  gitAt(repo, 'checkout', '-q', '-b', name);
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', name);
  const head = gitAt(repo, 'rev-parse', 'HEAD');
  gitAt(repo, 'checkout', '-q', from);
  return head;
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
  assert.match(r.stderr, /merges commit .*, not the reviewed commit .*; content beyond the reviewed identity rode along unreviewed/);
  assert.strictEqual(stateOf().missions.m4_2c.status, 'open');
}

// --- F1 probe B (refusing): a fast-forward landing, then an unreviewed
// non-merge commit straight on main -------------------------------------------
{
  openM('mprobeb');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mprobeb', identity);
  fx.recordApprove(root, 'mprobeb', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mprobeb', 'tests', repo);

  ffLand(repo); // main === the reviewed head, no merge commit
  fs.writeFileSync(path.join(repo, 'sneak-b.txt'), 'sneak\n');
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', 'unreviewed commit straight on main');

  const r = fx.runClose(root, 'mprobeb', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'an unreviewed commit stacked on a fast-forward landing must refuse');
  assert.match(r.stderr, /carries the reviewed commit .* directly in its first-parent history with no landing merge or squash/);
  assert.strictEqual(stateOf().missions.mprobeb.status, 'open');
}

// --- F1 probe C (refusing): the reviewed head as the merge's FIRST parent,
// an unreviewed sidecar as the second ------------------------------------------
{
  openM('mprobec');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mprobec', identity);
  fx.recordApprove(root, 'mprobec', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mprobec', 'tests', repo);

  ffLand(repo); // main === the reviewed head
  sneakBranch(repo, 'main', 'sneak-c');
  gitAt(repo, 'merge', '-q', '--no-ff', '-m', 'merge sneak-c', 'sneak-c'); // head is first parent by construction

  const r = fx.runClose(root, 'mprobec', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'the reviewed head in the FIRST parent position must not launder a sneak second parent');
  assert.match(r.stderr, /carries the reviewed commit .* directly in its first-parent history with no landing merge or squash/);
  assert.strictEqual(stateOf().missions.mprobec.status, 'open');
}

// --- F1 probe D (refusing): an octopus merge carrying the reviewed head plus
// an unreviewed rider -----------------------------------------------------------
{
  openM('mprobed');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mprobed', identity);
  fx.recordApprove(root, 'mprobed', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mprobed', 'tests', repo);

  const sneakHead = sneakBranch(repo, 'main', 'sneak-d');
  gitAt(repo, 'checkout', '-q', 'main');
  gitAt(repo, 'merge', '-q', '--no-ff', '-m', 'octopus land', 'work', sneakHead);

  const r = fx.runClose(root, 'mprobed', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'an octopus merge must never be accepted as a landing');
  assert.match(r.stderr, /is an octopus merge \(3 parents\)/);
  assert.strictEqual(stateOf().missions.mprobed.status, 'open');
}

// --- F2 probe E (refusing): a squash landing plus an extra unreviewed commit
// riding after it ---------------------------------------------------------------
{
  openM('mprobee');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mprobee', identity);
  fx.recordApprove(root, 'mprobee', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mprobee', 'tests', repo);

  fx.land(repo, 'squash'); // main: base -> squash commit (matches the reviewed patch)
  fs.writeFileSync(path.join(repo, 'sneak-e.txt'), 'sneak\n');
  gitAt(repo, 'add', '-A');
  gitAt(repo, 'commit', '-q', '-m', 'unreviewed commit riding the squash');

  const r = fx.runClose(root, 'mprobee', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 1, 'an unreviewed commit riding a squash landing must refuse the close');
  assert.match(r.stderr, /is an ordinary commit that neither is the reviewed commit .* nor carries its patch identity/);
  assert.strictEqual(stateOf().missions.mprobee.status, 'open');
}

// --- F3 probe F (passing): a legitimate close survives a later, separately
// reviewed sibling landing on main before this mission closes ------------------
{
  openM('mprobef');
  const repo = fx.newWorkRepo(tmp);
  const identity = fx.artifactIdentity(repo);
  const chain = fx.reserveChain(root, 'mprobef', identity);
  fx.recordApprove(root, 'mprobef', chain, identity);
  const gateSeq = fx.runGreenGate(root, 'mprobef', 'tests', repo);
  fx.land(repo, 'merge'); // our own no-ff merge, exactly the reviewed head
  const ourMerge = gitAt(repo, 'rev-parse', 'main');

  // A separately reviewed sibling mission's own merge, landing after ours and
  // before this one closes.
  sneakBranch(repo, 'main', 'sibling-work');
  gitAt(repo, 'checkout', '-q', 'main');
  gitAt(repo, 'merge', '-q', '--no-ff', '-m', 'land sibling', 'sibling-work');

  const r = fx.runClose(root, 'mprobef', repo, fx.closeInputOf(chain, gateSeq));
  assert.strictEqual(r.status, 0, `a later sibling merge must not block this close: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.landing.method, 'commit-containment');
  assert.strictEqual(out.landing.landed_head, ourMerge, 'the proof names OUR OWN merge, not the sibling that landed after it');
  assert.strictEqual(stateOf().missions.mprobef.status, 'done');
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
