'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src', 'settings.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-settings-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const DEFAULTS = {
  delegation: 'strict',
  fleet_ceiling: 6,
  landing: 'review-then-merge',
  escalation: 'auto_remedy',
  plan_rigor: 'ask',
  review_floor: 'cross-family',
};

function freshTree(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function run(args, stdin) {
  return spawnSync(process.execPath, [SRC, ...args], {
    encoding: 'utf8',
    input: stdin === undefined ? undefined : stdin,
  });
}

function diskDoc(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
}

function clampFor(clamps, key) {
  return clamps.filter((c) => c.key === key);
}

// --- read on an empty tree: pure defaults ------------------------------------
{
  const root = freshTree('defaults');
  const r = run(['read', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const { settings, clamps, source } = JSON.parse(r.stdout);
  assert.strictEqual(source, 'defaults');
  assert.deepStrictEqual(settings, DEFAULTS);
  assert.strictEqual(clampFor(clamps, 'delegation')[0].rule, 'default');
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')), 'read never writes');
}

// --- write: valid patch lands, defaults fill the rest ------------------------
{
  const root = freshTree('write');
  const r = run(['write', root], JSON.stringify({ delegation: 'balanced', landing: 'pr' }));
  assert.strictEqual(r.status, 0, r.stderr);
  const { settings } = JSON.parse(r.stdout);
  assert.deepStrictEqual(settings, { ...DEFAULTS, delegation: 'balanced', landing: 'pr' });
  assert.deepStrictEqual(diskDoc(root), settings, 'printed settings are exactly what landed on disk');

  // A later patch merges over the earlier write rather than resetting it.
  const r2 = run(['write', root], JSON.stringify({ fleet_ceiling: 3 }));
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.deepStrictEqual(diskDoc(root), {
    ...DEFAULTS,
    delegation: 'balanced',
    landing: 'pr',
    fleet_ceiling: 3,
  });
}

// --- clamp behavior: out-of-range integers clamp with a report ---------------
{
  const root = freshTree('clamp');
  const high = run(['write', root], JSON.stringify({ fleet_ceiling: 40 }));
  assert.strictEqual(high.status, 0, high.stderr);
  const highOut = JSON.parse(high.stdout);
  assert.strictEqual(highOut.settings.fleet_ceiling, 12, 'above ceiling clamps to 12');
  const ceilClamp = clampFor(highOut.clamps, 'fleet_ceiling').find((c) => c.rule === 'ceiling');
  assert.deepStrictEqual(ceilClamp, { key: 'fleet_ceiling', from: 40, to: 12, rule: 'ceiling' });
  assert.strictEqual(diskDoc(root).fleet_ceiling, 12);

  const low = run(['write', root], JSON.stringify({ fleet_ceiling: 0 }));
  assert.strictEqual(low.status, 0, low.stderr);
  const lowOut = JSON.parse(low.stdout);
  assert.strictEqual(lowOut.settings.fleet_ceiling, 1, 'below floor clamps to 1');
  assert.ok(clampFor(lowOut.clamps, 'fleet_ceiling').some((c) => c.rule === 'floor'));

  // Non-integer values are a type error, not a clamp: the write fails closed.
  const frac = run(['write', root], JSON.stringify({ fleet_ceiling: 5.5 }));
  assert.strictEqual(frac.status, 1);
  assert.match(frac.stderr, /"fleet_ceiling" must be an integer between 1 and 12/);
  const str = run(['write', root], JSON.stringify({ fleet_ceiling: '9' }));
  assert.strictEqual(str.status, 1);
  assert.strictEqual(diskDoc(root).fleet_ceiling, 1, 'refused writes changed nothing');
}

// --- plan_rigor: operator-changeable enum, not locked ------------------------
{
  const root = freshTree('plan-rigor');
  const r = run(['read', root]);
  assert.strictEqual(JSON.parse(r.stdout).settings.plan_rigor, 'ask', 'default is "ask"');

  const w = run(['write', root], JSON.stringify({ plan_rigor: 'full' }));
  assert.strictEqual(w.status, 0, w.stderr);
  assert.strictEqual(JSON.parse(w.stdout).settings.plan_rigor, 'full');
  assert.strictEqual(diskDoc(root).plan_rigor, 'full', 'plan_rigor is operator-changeable, unlike review_floor');

  const back = run(['write', root], JSON.stringify({ plan_rigor: 'standard' }));
  assert.strictEqual(back.status, 0, back.stderr);
  assert.strictEqual(diskDoc(root).plan_rigor, 'standard');

  const badEnum = run(['write', root], JSON.stringify({ plan_rigor: 'yolo' }));
  assert.strictEqual(badEnum.status, 1, 'out-of-enum plan_rigor refuses the write');
  assert.match(badEnum.stderr, /"plan_rigor" must be one of "ask", "standard", "full"/);
  assert.strictEqual(diskDoc(root).plan_rigor, 'standard', 'refused write left the prior value in place');

  // Hand-edited unknown value clamps to the default on read, with a report.
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ plan_rigor: 'aggressive' }) + '\n');
  const clamped = run(['read', root]);
  assert.strictEqual(clamped.status, 0, clamped.stderr);
  const { settings, clamps } = JSON.parse(clamped.stdout);
  assert.strictEqual(settings.plan_rigor, 'ask', 'unknown hand-edited value clamps to the default');
  const clamp = clampFor(clamps, 'plan_rigor')[0];
  assert.deepStrictEqual(clamp, { key: 'plan_rigor', from: 'aggressive', to: 'ask', rule: 'enum' });
}

// --- write fails closed: unknown keys and bad enum values --------------------
{
  const root = freshTree('closed');
  const unknown = run(['write', root], JSON.stringify({ warp_speed: true }));
  assert.strictEqual(unknown.status, 1);
  assert.match(unknown.stderr, /unknown settings key "warp_speed" — the knob set is closed/);
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')), 'refused write created no file');

  const badEnum = run(['write', root], JSON.stringify({ delegation: 'yolo' }));
  assert.strictEqual(badEnum.status, 1);
  assert.match(badEnum.stderr, /"delegation" must be one of "strict", "balanced"/);

  const notObject = run(['write', root], JSON.stringify(['strict']));
  assert.strictEqual(notObject.status, 1);
  assert.match(notObject.stderr, /patch must be a JSON object/);

  const badJson = run(['write', root], '{ torn');
  assert.strictEqual(badJson.status, 1);
  assert.match(badJson.stderr, /stdin did not carry valid JSON/);

  const noTree = run(['write', path.join(tmp, 'missing-tree')], JSON.stringify({ landing: 'pr' }));
  assert.strictEqual(noTree.status, 1);
  assert.match(noTree.stderr, /tree root does not exist/);
}

// --- locked-key enforcement: review_floor ------------------------------------
{
  const root = freshTree('locked');
  const change = run(['write', root], JSON.stringify({ review_floor: 'same-family' }));
  assert.strictEqual(change.status, 1, 'changing the locked key refuses the whole write');
  assert.match(change.stderr, /review_floor is locked at "cross-family"/);
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')));

  // Restating the locked value is a no-op, not a refusal.
  const restate = run(['write', root], JSON.stringify({ review_floor: 'cross-family' }));
  assert.strictEqual(restate.status, 0, restate.stderr);
  assert.strictEqual(diskDoc(root).review_floor, 'cross-family');

  // A locked-key change smuggled in beside a valid knob still refuses everything.
  const smuggled = run(['write', root], JSON.stringify({ landing: 'pr', review_floor: 'none' }));
  assert.strictEqual(smuggled.status, 1);
  assert.strictEqual(diskDoc(root).landing, 'review-then-merge', 'the valid half of a refused patch did not land');
}

// --- hand-edit recovery: read re-clamps, deleted-not-falsed ------------------
{
  const root = freshTree('hand-edit');
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({
      delegation: 'reckless',
      fleet_ceiling: 99,
      review_floor: 'none',
      pet_name: 'boulder',
    }) + '\n'
  );

  const r = run(['read', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const { settings, clamps, source } = JSON.parse(r.stdout);
  assert.strictEqual(source, 'file');
  assert.strictEqual(settings.review_floor, 'cross-family', 'hand-edited locked key reads as the locked value');
  const locked = clampFor(clamps, 'review_floor')[0];
  assert.strictEqual(locked.rule, 'locked');
  assert.strictEqual(locked.from, 'none');
  assert.strictEqual(locked.to, 'cross-family');
  assert.strictEqual(settings.delegation, 'strict', 'out-of-enum hand-edit falls back to default');
  assert.ok(clampFor(clamps, 'delegation').some((c) => c.rule === 'enum'));
  assert.strictEqual(settings.fleet_ceiling, 12, 'hand-edited overshoot clamps to the ceiling');
  assert.ok(!('pet_name' in settings), 'unknown hand-edited key is dropped');
  assert.ok(clampFor(clamps, 'pet_name').some((c) => c.rule === 'unknown'));

  // The next write persists the recovered document: the bad hand-edit is
  // deleted from disk, never carried forward.
  const w = run(['write', root], JSON.stringify({ escalation: 'advise_me' }));
  assert.strictEqual(w.status, 0, w.stderr);
  const doc = diskDoc(root);
  assert.strictEqual(doc.review_floor, 'cross-family');
  assert.strictEqual(doc.delegation, 'strict');
  assert.ok(!('pet_name' in doc));
  assert.strictEqual(doc.escalation, 'advise_me');
}

// --- CLI hygiene -------------------------------------------------------------
{
  const help = run(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /review_floor\s+locked at "cross-family"/);

  const unknownCmd = run(['erase', tmp]);
  assert.strictEqual(unknownCmd.status, 1);
  assert.match(unknownCmd.stderr, /unknown command "erase"/);

  const extra = run(['read', tmp, 'surplus']);
  assert.strictEqual(extra.status, 1);
  assert.match(extra.stderr, /unexpected extra argument/);
}

console.log('test-settings: OK');
