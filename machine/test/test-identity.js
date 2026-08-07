'use strict';

// The canonical artifact identity (§7): one object, one helper, four fields.
// These tests pin the properties the binding chain depends on — the digest
// tracks content and nothing else, and a dirty worktree says so.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { artifactIdentity } = require(path.join(__dirname, '..', 'src', 'gate.js'));
const { validateArtifactIdentity, IDENTITY_KEYS } = require(path.join(__dirname, '..', 'src', 'route.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-identity-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let repoCounter = 0;
function newRepo() {
  repoCounter += 1;
  const repo = path.join(tmp, `repo${repoCounter}`);
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
  git(repo, 'commit', '-q', '-m', 'work');
  return repo;
}

// --- exactly the four §7 fields, and the same four route.js validates --------
{
  const repo = newRepo();
  const id = artifactIdentity(repo);
  assert.deepStrictEqual(Object.keys(id), IDENTITY_KEYS, 'the helper produces exactly the §7 identity, in schema order');
  assert.deepStrictEqual(validateArtifactIdentity(id), { ok: true, errors: [] }, 'a computed identity satisfies the schema');

  assert.strictEqual(id.source_head, git(repo, 'rev-parse', 'HEAD'));
  assert.strictEqual(id.source_tree, git(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.notStrictEqual(id.source_head, id.source_tree, 'the commit and its tree are different objects');
  assert.match(id.patch_digest, /^sha256:[0-9a-f]{64}$/, 'a digest is prefixed; an oid never is — the two can never be confused');
  assert.strictEqual(id.dirty, false);
}

// --- stable across repeated computation on an unchanged worktree -------------
{
  const repo = newRepo();
  const first = artifactIdentity(repo);
  const second = artifactIdentity(repo);
  assert.deepStrictEqual(second, first, 'the same content computes the same identity');
}

// --- the digest tracks content, not commit metadata --------------------------
{
  const repo = newRepo();
  const before = artifactIdentity(repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'a commit that changes nothing');
  const after = artifactIdentity(repo);

  assert.notStrictEqual(after.source_head, before.source_head, 'a new commit is a new head');
  assert.strictEqual(after.source_tree, before.source_tree, 'unchanged content is the same tree');
  assert.strictEqual(after.patch_digest, before.patch_digest, 'the patch digest is content, not commit metadata');
}

// --- ...and changes when the content changes ---------------------------------
{
  const repo = newRepo();
  const before = artifactIdentity(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'more');
  const after = artifactIdentity(repo);

  assert.notStrictEqual(after.patch_digest, before.patch_digest, 'changed content is a changed patch digest');
  assert.notStrictEqual(after.source_tree, before.source_tree);
  assert.strictEqual(after.dirty, false);
}

// --- a new file the patch did not carry before changes the digest too --------
{
  const repo = newRepo();
  const before = artifactIdentity(repo);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add b');
  assert.notStrictEqual(artifactIdentity(repo).patch_digest, before.patch_digest);
}

// --- dirty is reported truthfully, and never silently cleaned ----------------
{
  const repo = newRepo();
  const clean = artifactIdentity(repo);
  assert.strictEqual(clean.dirty, false);

  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nuncommitted\n');
  const dirty = artifactIdentity(repo);
  assert.strictEqual(dirty.dirty, true, 'an uncommitted change is reported, never ignored');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\ntwo\nuncommitted\n', 'the helper observes the worktree, it never cleans it');
  assert.strictEqual(dirty.source_head, clean.source_head, 'the head is still the head — dirty is the fact that there is more');

  git(repo, 'checkout', '-q', '--', 'a.txt');
  assert.strictEqual(artifactIdentity(repo).dirty, false, 'restoring the file restores a clean identity');

  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'stray\n');
  assert.strictEqual(artifactIdentity(repo).dirty, true, 'an untracked file is a dirty worktree');
}

// --- a dirty identity is refused by the review-route schema, not by the helper
{
  const repo = newRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'drifted\n');
  const id = artifactIdentity(repo);
  const verdict = validateArtifactIdentity(id);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.errors.join('; '), /may not name a dirty worktree/);
}

// --- refusals ----------------------------------------------------------------
{
  const notARepo = path.join(tmp, 'plain');
  fs.mkdirSync(notARepo);
  assert.throws(() => artifactIdentity(notARepo), /not a git worktree|no such worktree/);

  assert.throws(() => artifactIdentity(path.join(tmp, 'missing')), /no such worktree/);
  assert.throws(() => artifactIdentity(''), /non-empty string/);
}

console.log('test-identity: OK');
