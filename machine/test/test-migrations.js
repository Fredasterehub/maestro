'use strict';

// Exercises execution-plan.md section 11's routing migration contract:
// determinism, boundary idempotence, digest-verified dated writes, rollback
// by repoint, re-upgrade re-running only the remaining migrations, refusal
// of a malformed source revision, filename-collision increment, an
// already-current no-op that writes nothing, and init writing the current
// revision directly. Every fixture tree here is synthetic, under this
// test's own temporary directory — the project's real .maestro tree is
// never read or written.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SRC_DIR = path.join(__dirname, '..', 'src');
const ROUTING_SRC = path.join(SRC_DIR, 'routing.js');
const routing = require(ROUTING_SRC);
const { buildRevision1Config, MIGRATIONS, CURRENT_ROUTING_REVISION, DATED_CONFIG_RE } = routing;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-migrations-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sha256Of(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

function run(scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

function writeDatedFixture(dir, filename, config) {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  return { path: p, digest: sha256Of(fs.readFileSync(p)) };
}

function writePointer(dir, filename, digest) {
  fs.writeFileSync(
    path.join(dir, 'active.json'),
    JSON.stringify({ schema_version: 1, active_config: filename, digest }, null, 2) + '\n'
  );
}

// A revision-1 tree built the same way init would have built one at the
// historical revision — buildRevision1Config is exported from routing.js
// precisely so this fixture is genuine, never a hand-duplicated shape that
// can drift from the real baseline.
function revision1Tree(name, dateStr) {
  const root = freshTree(name);
  const dir = path.join(root, 'routing');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `routing-${dateStr}-1.json`;
  const { digest } = writeDatedFixture(dir, filename, buildRevision1Config(dateStr));
  writePointer(dir, filename, digest);
  return { root, dir, filename, digest };
}

// --- determinism and boundary idempotence of the real, shipped migration ----
{
  assert.strictEqual(MIGRATIONS.length, 3, 'this suite assumes three shipped migrations — update it alongside the next one');
  let input = buildRevision1Config('2026-08-01');
  for (const [index, migrate] of MIGRATIONS.entries()) {
    const out1 = migrate(JSON.parse(JSON.stringify(input)));
    const out2 = migrate(JSON.parse(JSON.stringify(input)));
    assert.deepStrictEqual(out1, out2, `MIGRATIONS[${index}] must be deterministic: identical input must yield identical output across repeated runs`);

    // Idempotent at its own boundary: running the migration again on its own
    // output must change nothing further.
    const reapplied = migrate(JSON.parse(JSON.stringify(out1)));
    assert.deepStrictEqual(reapplied, out1, `MIGRATIONS[${index}] must be idempotent at its own boundary — reapplying to its own output must be a no-op`);
    input = out1;
  }
}

// --- each migration refuses a source below its own boundary -----------------
{
  // §11 makes every MIGRATIONS entry independently testable, so each must
  // refuse a wrong-shaped source by name rather than stamp it forward: the
  // r2->r3 migration applied straight to a revision-1 config (no Sol
  // split) must throw, never emit a config labeled revision 3 that never
  // received revision 2's content.
  assert.throws(
    () => MIGRATIONS[1](buildRevision1Config('2026-08-01')),
    /not a revision-2 shape/,
    'migrateDegradedReview must refuse a revision-1 source instead of stamping revision 3 onto it'
  );
  // Same rule one revision up: the r3->r4 migration reprofiles seats and
  // replaces rows that only a revision-3 config carries, so a revision-2
  // source (Sol split applied, degraded-review block absent) must be refused
  // rather than stamped revision 4.
  assert.throws(
    () => MIGRATIONS[2](MIGRATIONS[0](buildRevision1Config('2026-08-01'))),
    /not a revision-3 shape/,
    'migrateClaudeLadder must refuse a revision-2 source instead of stamping revision 4 onto it'
  );
}

// --- init writes the current revision directly, never revision 1 -----------
{
  const root = freshTree('init-current');
  const r = run(ROUTING_SRC, ['init', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const init = JSON.parse(r.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'routing', init.active_config), 'utf8'));
  assert.strictEqual(config.revision, CURRENT_ROUTING_REVISION, 'init must write the current schema at the current revision, never a modern schema mislabeled revision 1');
}

// --- dated write carries a digest that verifies ------------------------------
{
  const { root, dir, filename } = revision1Tree('digest-verify', '2026-08-01');
  const r = run(ROUTING_SRC, ['revise', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  for (const step of result.steps) {
    const bytes = fs.readFileSync(path.join(dir, step.file));
    assert.strictEqual(step.digest, sha256Of(bytes), `step digest for ${step.file} must verify against its own bytes`);
  }
  const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'active.json'), 'utf8'));
  const activeBytes = fs.readFileSync(path.join(dir, pointer.active_config));
  assert.strictEqual(pointer.digest, sha256Of(activeBytes), 'active.json digest must verify against the dated file it points at');
  assert.ok(fs.existsSync(path.join(dir, filename)), 'the pre-migration dated file stays on disk, untouched');
}

// --- malformed source revision is refused, not repaired --------------------
{
  for (const badRevision of [0, CURRENT_ROUTING_REVISION + 97]) {
    const root = freshTree(`malformed-${badRevision}`);
    const dir = path.join(root, 'routing');
    fs.mkdirSync(dir, { recursive: true });
    const config = buildRevision1Config('2026-08-01');
    config.revision = badRevision; // otherwise-valid shape; only the revision number is out of range
    const filename = 'routing-2026-08-01-1.json';
    const { digest } = writeDatedFixture(dir, filename, config);
    writePointer(dir, filename, digest);

    const r = run(ROUTING_SRC, ['revise', root]);
    assert.strictEqual(r.status, 1, `revise must refuse a source revision of ${badRevision}`);
    assert.match(r.stderr, /refusing to migrate a malformed source revision/);
    assert.deepStrictEqual(
      fs.readdirSync(dir).filter((f) => DATED_CONFIG_RE.test(f)),
      [filename],
      'a refused malformed revision must write no new dated file'
    );
  }
}

// --- filename collision increments the suffix, never overwrites ------------
{
  // revise() dates its own writes off the real clock (not the source
  // fixture's `calibrated` field), so the source fixture is built for
  // today's date too — that is the date under which the collision actually
  // has to be provoked. The window between reading the clock here and
  // revise()'s own internal read is milliseconds, but a run straddling UTC
  // midnight would otherwise date the new write under tomorrow and produce
  // an unreproducible, spurious failure rather than a missed collision — so
  // the date the child process actually used is read back from its own
  // output and the strict assertion only runs when it agrees with `today`.
  const today = new Date().toISOString().slice(0, 10);
  const { root, dir } = revision1Tree('collision', today);
  // Pre-occupy the slot revise would otherwise claim next (N=2) with an
  // unrelated file, so the migration's write must skip to N=3.
  fs.writeFileSync(path.join(dir, `routing-${today}-2.json`), '{"squatter": true}\n');

  const r = run(ROUTING_SRC, ['revise', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  // Guarded rather than indexed straight off the match: an active_config
  // that does not match this shape is exactly what this test exists to
  // catch, so it has to arrive as a named assertion, not a TypeError on
  // null[1].
  const written = String(result.active_config).match(/^routing-(\d{4}-\d{2}-\d{2})-\d+\.json$/);
  assert.ok(written, `revise wrote an unexpected active_config filename: ${JSON.stringify(result.active_config)}`);
  const writtenDate = written[1];
  if (writtenDate !== today) {
    console.log(`test-migrations: SKIP collision-suffix strict filename assertion (UTC date rolled over mid-test: fixture built for ${today}, revise wrote under ${writtenDate})`);
  } else {
    // Three shipped migrations: the r1->r2 write skips the occupied N=2 to
    // claim N=3, and the r2->r3 and r3->r4 writes land on N=4 and N=5.
    assert.strictEqual(result.active_config, `routing-${today}-5.json`, 'a collision at N must increment to the next free N, never overwrite it');
  }
  // Independent of the date race: whatever name revise picked, it must not
  // be N=2 (already occupied), and the occupant must survive untouched.
  assert.ok(!result.active_config.endsWith('-2.json'), 'revise must never claim the already-occupied N=2 slot');

  const squatter = fs.readFileSync(path.join(dir, `routing-${today}-2.json`), 'utf8');
  assert.strictEqual(squatter, '{"squatter": true}\n', 'the pre-existing occupant of the collided name must be left untouched');
}

// --- already-current is an explicit no-op, writing no file ------------------
{
  const root = freshTree('already-current');
  run(ROUTING_SRC, ['init', root]);
  const dir = path.join(root, 'routing');
  const before = fs.readdirSync(dir).sort();

  const r = run(ROUTING_SRC, ['revise', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already at revision/);

  const after = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(after, before, 'an already-current revise must write no file');
}

// --- rollback: repointing active.json at an older dated file leaves it authoritative ----
{
  const dateStr = '2026-08-01';
  const { root, dir, filename: r1File, digest: r1Digest } = revision1Tree('rollback', dateStr);
  const revised = run(ROUTING_SRC, ['revise', root]);
  assert.strictEqual(revised.status, 0, revised.stderr);
  const r2File = JSON.parse(revised.stdout).active_config;

  writePointer(dir, r1File, r1Digest);
  const active = run(ROUTING_SRC, ['active', root]);
  assert.strictEqual(active.status, 0, active.stderr);
  assert.strictEqual(JSON.parse(active.stdout).revision, 1, 'a repoint to the older dated file must leave the older config authoritative');
  assert.ok(fs.existsSync(path.join(dir, r2File)), 'the newer dated file is never deleted by a rollback — it stays on disk, just unpointed');
}

// Byte-patches a copy of routing.js's own MIGRATIONS declaration (never the
// real file under machine/src/) so a test can exercise a migration set the
// shipped module does not carry. `migrationsSource` is the literal
// replacement for `const MIGRATIONS = [migrateSolSplit, migrateDegradedReview];`
// — free to define its own extra migration functions above that assignment,
// since it is spliced in at the exact point the real declaration lives.
// Every caller must read CURRENT_ROUTING_REVISION back off the returned
// module rather than assume a value: the constant is computed once at
// require time as `1 + MIGRATIONS.length`, so it moves with whatever
// migration count the patch introduces, and nothing here hardcodes it
// independently.
function buildPatchedRoutingModule(migrationsSource, fixtureName) {
  const marker = 'const MIGRATIONS = [migrateSolSplit, migrateDegradedReview, migrateClaudeLadder];';
  // The copy lives outside machine/src/, so every sibling require must be
  // rewritten absolute — a relative one would resolve against the temp dir.
  const requireMarkers = ['atomic-json.js', 'settings.js', 'validators.js'].map((f) => [
    `require('./${f}')`,
    `require(${JSON.stringify(path.join(SRC_DIR, f))})`,
  ]);
  const realSrc = fs.readFileSync(ROUTING_SRC, 'utf8');
  assert.ok(
    realSrc.includes(marker) && requireMarkers.every(([from]) => realSrc.includes(from)),
    'test-migrations: routing.js shape moved — update the synthetic-module fixture'
  );

  let patched = realSrc.replace(marker, migrationsSource);
  for (const [from, to] of requireMarkers) {
    patched = patched.replace(from, to);
  }
  const syntheticSrc = path.join(tmp, fixtureName);
  fs.writeFileSync(syntheticSrc, patched);
  return { path: syntheticSrc, module: require(syntheticSrc) };
}

// --- validateRoutingConfig is actually enforced on migration output --------
//
// §11 requires each migration's output to be validated before it is
// written. Proven from outside routing.js (never by editing it): a
// synthetic single migration that returns a structurally invalid config
// (no `bans` table) must be refused by revise, and must write no file.
{
  const { path: invalidSrc } = buildPatchedRoutingModule(
    [
      'function migrateDropsRequiredField(config) {',
      '  const out = JSON.parse(JSON.stringify(config));',
      '  delete out.bans;',
      '  out.revision = 2;',
      '  return out;',
      '}',
      'const MIGRATIONS = [migrateDropsRequiredField];',
    ].join('\n'),
    'routing-invalid-migration.js'
  );

  const dateStr = '2026-08-03';
  const root = freshTree('validate-on-output');
  const dir = path.join(root, 'routing');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `routing-${dateStr}-1.json`;
  const { digest } = writeDatedFixture(dir, filename, buildRevision1Config(dateStr));
  writePointer(dir, filename, digest);

  const r = run(invalidSrc, ['revise', root]);
  assert.strictEqual(r.status, 1, 'a migration producing an invalid config must be refused, not written');
  assert.match(r.stderr, /produced an invalid config/);
  assert.match(r.stderr, /bans must be an object/);
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((f) => DATED_CONFIG_RE.test(f)),
    [filename],
    'a refused invalid migration output must write no new dated file'
  );
}

// --- multi-step revise, rollback to an intermediate step, and re-upgrade running only the remaining migration ----
//
// Only one migration ships today, so exercising a genuine multi-step
// sequence needs a second, synthetic one. routing.js is never edited for
// this — a byte-patched copy of its source is written to this test's own
// temp directory (never machine/src/), and CURRENT_ROUTING_REVISION is read
// back from that same copy rather than assumed, since adding a migration
// moves the constant along with it (1 + MIGRATIONS.length).
{
  const { path: syntheticSrc, module: synthetic } = buildPatchedRoutingModule(
    [
      'function migrateSyntheticTestStep(config) {',
      '  const out = JSON.parse(JSON.stringify(config));',
      "  out.seats['synthetic-test-seat'] = { model: 'sonnet-5', family: 'claude', effort: 'low' };",
      '  out.revision = 3;',
      '  return out;',
      '}',
      'const MIGRATIONS = [migrateSolSplit, migrateSyntheticTestStep];',
    ].join('\n'),
    'routing-synthetic.js'
  );
  assert.strictEqual(synthetic.CURRENT_ROUTING_REVISION, 3, 'the synthetic fixture must carry its own second migration in its current-revision constant');

  const dateStr = '2026-08-02';
  const { root, dir } = (() => {
    const r = freshTree('multi-step');
    const d = path.join(r, 'routing');
    fs.mkdirSync(d, { recursive: true });
    const filename = `routing-${dateStr}-1.json`;
    const { digest } = writeDatedFixture(d, filename, buildRevision1Config(dateStr));
    writePointer(d, filename, digest);
    return { root: r, dir: d };
  })();

  // Full multi-step: revision 1 -> 3 in one call, two dated files written.
  const full = run(syntheticSrc, ['revise', root]);
  assert.strictEqual(full.status, 0, full.stderr);
  const fullResult = JSON.parse(full.stdout);
  assert.strictEqual(fullResult.from, 1);
  assert.strictEqual(fullResult.to, 3);
  assert.strictEqual(fullResult.steps.length, 2, 'a two-migration gap must write exactly two dated files, one per step');
  const [step1, step2] = fullResult.steps;
  assert.strictEqual(step1.revision, 2);
  assert.strictEqual(step2.revision, 3);

  // Rollback to the intermediate (revision-2) dated file.
  writePointer(dir, step1.file, step1.digest);
  const rolledBack = run(syntheticSrc, ['active', root]);
  assert.strictEqual(rolledBack.status, 0, rolledBack.stderr);
  assert.strictEqual(JSON.parse(rolledBack.stdout).revision, 2, 'repointing at the intermediate dated file must leave revision 2 authoritative');

  // Re-upgrade from the intermediate: must re-run only the remaining
  // (second) migration, landing back at the current revision, not restart
  // from revision 1.
  const reupgrade = run(syntheticSrc, ['revise', root]);
  assert.strictEqual(reupgrade.status, 0, reupgrade.stderr);
  const reupgradeResult = JSON.parse(reupgrade.stdout);
  assert.strictEqual(reupgradeResult.from, 2, 're-upgrade after a rollback must resume from the rolled-back revision, not from 1');
  assert.strictEqual(reupgradeResult.to, 3);
  assert.strictEqual(reupgradeResult.steps.length, 1, 're-upgrade must re-run only the remaining migration, not the one already applied');
  assert.strictEqual(reupgradeResult.steps[0].revision, 3);
}

console.log('test-migrations: OK');
