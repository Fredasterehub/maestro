'use strict';

// Tests for scaffold.js: genesis shape, genesis distinguishability
// (streams seeded with a kind:"genesis" record), routing digest integrity,
// and the no-clobber contract ("exists", exit 0, nothing mutated).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const SCAFFOLD = path.join(SRC, 'scaffold.js');
const { readRecords } = require(path.join(SRC, 'jsonl.js'));
const { readJson } = require(path.join(SRC, 'atomic-json.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-scaffold-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function runCli(args) {
  return spawnSync(process.execPath, [SCAFFOLD, ...args], { encoding: 'utf8' });
}

// --- genesis ----------------------------------------------------------------

const root = path.join(tmp, 'proj', '.maestro');
{
  const r = runCli([root]);
  assert.strictEqual(r.status, 0, `scaffold failed: ${r.stderr}`);

  // state.json — exact genesis shape.
  const state = readJson(path.join(root, 'state.json'));
  assert.deepStrictEqual(Object.keys(state).sort(), [
    'active_mission',
    'created_ts',
    'last_stop',
    'missions',
    'preflight',
    'schema_version',
  ]);
  assert.strictEqual(state.schema_version, 1);
  assert.ok(ISO_Z_RE.test(state.created_ts), `created_ts not ISO UTC: ${state.created_ts}`);
  assert.deepStrictEqual(state.missions, {});
  assert.strictEqual(state.active_mission, null);
  assert.strictEqual(state.preflight, null);
  assert.strictEqual(state.last_stop, null);

  // Genesis distinguishability: both streams EXIST and carry exactly one
  // kind:"genesis" record — "ran and empty" is a different observable fact
  // from "never ran" (file absent, zero records).
  for (const stream of ['ledger.jsonl', 'holds.jsonl']) {
    const file = path.join(root, stream);
    assert.ok(fs.existsSync(file), `${stream} missing`);
    const { records, errors } = readRecords(file);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(records.length, 1, `${stream} should hold exactly the genesis record`);
    assert.strictEqual(records[0].kind, 'genesis');
    assert.strictEqual(records[0].seq, 0);
    assert.strictEqual(records[0].schema_version, 1);
    assert.ok(ISO_Z_RE.test(records[0].ts));
    // And the contrast: an unscaffolded tree reads as zero records.
    const never = readRecords(path.join(tmp, 'no-such-tree', stream));
    assert.strictEqual(never.records.length, 0);
  }

  // settings.json defaults, seeded through settings.js's own schema.
  const settings = readJson(path.join(root, 'settings.json'));
  const settingsSchema = require(path.join(SRC, 'settings.js')).SCHEMA;
  assert.deepStrictEqual(Object.keys(settings).sort(), Object.keys(settingsSchema).sort());
  assert.strictEqual(settings.review_floor, 'cross-family');

  // routing/: dated immutable config + digest pointer that verifies.
  const active = readJson(path.join(root, 'routing', 'active.json'));
  assert.strictEqual(active.schema_version, 1);
  assert.match(active.active_config, /^routing-\d{4}-\d{2}-\d{2}-\d+\.json$/);
  const configRaw = fs.readFileSync(path.join(root, 'routing', active.active_config));
  const digest = `sha256:${crypto.createHash('sha256').update(configRaw).digest('hex')}`;
  assert.strictEqual(active.digest, digest, 'active.json digest must match the dated config bytes');
  const config = JSON.parse(configRaw.toString('utf8'));
  assert.strictEqual(config.schema_version, 1);
  assert.ok(Number.isInteger(config.revision));
  assert.ok(config.seats && typeof config.seats === 'object');
  assert.ok(config.bans && typeof config.bans === 'object');
  assert.strictEqual(config.bans.haiku, 'never');
  assert.strictEqual(config.bans.liaison_implements, 'never');

  // Directories + handoff stub.
  for (const dir of ['missions', 'views']) {
    assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), `${dir}/ missing`);
  }
  const handoff = fs.readFileSync(path.join(root, 'handoff.md'), 'utf8');
  assert.ok(handoff.startsWith('# Handoff'), 'handoff.md genesis stub missing');

  // Genesis with no .gitignore creates one holding exactly the ignore line,
  // and the CLI reports the file it touched.
  const gitignore = path.join(path.dirname(root), '.gitignore');
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), '.maestro/\n');
  assert.ok(r.stdout.split('\n').includes(gitignore), 'created .gitignore reported on stdout');

  // No genesis staging debris left beside the tree.
  const siblings = fs.readdirSync(path.dirname(root)).sort();
  assert.deepStrictEqual(siblings, ['.gitignore', '.maestro'], `unexpected debris: ${siblings}`);
}

// --- no-clobber -------------------------------------------------------------

{
  const before = {
    state: fs.readFileSync(path.join(root, 'state.json'), 'utf8'),
    ledger: fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8'),
    holds: fs.readFileSync(path.join(root, 'holds.jsonl'), 'utf8'),
    gitignore: fs.readFileSync(path.join(path.dirname(root), '.gitignore'), 'utf8'),
  };
  const r = runCli([root]);
  assert.strictEqual(r.status, 0, 're-scaffold must exit 0');
  assert.strictEqual(r.stdout, 'exists\n', 're-scaffold must print exactly "exists"');
  assert.strictEqual(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), before.state);
  assert.strictEqual(fs.readFileSync(path.join(root, 'ledger.jsonl'), 'utf8'), before.ledger);
  assert.strictEqual(fs.readFileSync(path.join(root, 'holds.jsonl'), 'utf8'), before.holds);
  assert.strictEqual(
    fs.readFileSync(path.join(path.dirname(root), '.gitignore'), 'utf8'),
    before.gitignore,
    're-scaffold never touches .gitignore'
  );
}

// --- .gitignore append + idempotence -----------------------------------------

// An existing .gitignore without the line gets it appended — original content
// intact, missing trailing newline repaired, exactly one ignore line added.
{
  const proj = path.join(tmp, 'proj-append');
  fs.mkdirSync(proj);
  const gitignore = path.join(proj, '.gitignore');
  fs.writeFileSync(gitignore, 'node_modules/\ndist'); // deliberately no trailing newline
  const r = runCli([path.join(proj, '.maestro')]);
  assert.strictEqual(r.status, 0, `scaffold failed: ${r.stderr}`);
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), 'node_modules/\ndist\n.maestro/\n');
  assert.ok(r.stdout.split('\n').includes(gitignore), 'appended .gitignore reported on stdout');
}

// A .gitignore already covering the tree — with or without the trailing
// slash — stays byte-identical, and the CLI does not report it.
for (const existing of ['node_modules/\n.maestro/\n', '.maestro\n']) {
  const proj = path.join(tmp, `proj-present-${existing.includes('/') ? 'slash' : 'bare'}`);
  fs.mkdirSync(proj);
  const gitignore = path.join(proj, '.gitignore');
  fs.writeFileSync(gitignore, existing);
  const r = runCli([path.join(proj, '.maestro')]);
  assert.strictEqual(r.status, 0, `scaffold failed: ${r.stderr}`);
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), existing, 'covered .gitignore untouched');
  assert.ok(!r.stdout.split('\n').includes(gitignore), 'untouched .gitignore not reported');
}

// treeRoot exists as a FILE: a real error, never "exists", never clobbered.
{
  const fileRoot = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(fileRoot, 'keep me');
  const r = runCli([fileRoot]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not a directory/);
  assert.strictEqual(fs.readFileSync(fileRoot, 'utf8'), 'keep me');
}

// --- argv discipline --------------------------------------------------------

{
  assert.strictEqual(runCli([]).status, 1, 'missing treeRoot must fail');
  assert.strictEqual(runCli([path.join(tmp, 'x'), 'surplus']).status, 1, 'surplus argv must fail');
  const help = runCli(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /usage: scaffold\.js <treeRoot>/);
}

console.log('test-scaffold: ok');
