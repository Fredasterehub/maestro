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
  degraded_review: 'degraded-path',
  upgrade_degraded_review: 'never',
  provider_lanes: { gpt: 'auto', gemini: 'auto' },
  cross_family_when_available: true,
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

// --- degraded_review / upgrade_degraded_review: operator-changeable enums ----
{
  const root = freshTree('degraded-review-enum');
  const r = run(['read', root]);
  const d0 = JSON.parse(r.stdout).settings;
  assert.strictEqual(d0.degraded_review, 'degraded-path', 'default is "degraded-path"');
  assert.strictEqual(d0.upgrade_degraded_review, 'never', 'default is "never"');

  const w = run(['write', root], JSON.stringify({ degraded_review: 'hold', upgrade_degraded_review: 'before-close' }));
  assert.strictEqual(w.status, 0, w.stderr);
  assert.strictEqual(diskDoc(root).degraded_review, 'hold');
  assert.strictEqual(diskDoc(root).upgrade_degraded_review, 'before-close');

  const badDR = run(['write', root], JSON.stringify({ degraded_review: 'skip' }));
  assert.strictEqual(badDR.status, 1);
  assert.match(badDR.stderr, /"degraded_review" must be one of "degraded-path", "hold"/);

  const badUDR = run(['write', root], JSON.stringify({ upgrade_degraded_review: 'always' }));
  assert.strictEqual(badUDR.status, 1);
  assert.match(badUDR.stderr, /"upgrade_degraded_review" must be one of "never", "before-close"/);
}

// --- provider_lanes: nested deep-merge ---------------------------------------
{
  // Setting gpt alone must not disturb gemini, and vice versa.
  const root = freshTree('lanes-partial');
  const gptOnly = run(['write', root], JSON.stringify({ provider_lanes: { gpt: 'operator-down' } }));
  assert.strictEqual(gptOnly.status, 0, gptOnly.stderr);
  assert.deepStrictEqual(JSON.parse(gptOnly.stdout).settings.provider_lanes, { gpt: 'operator-down', gemini: 'auto' });
  assert.deepStrictEqual(diskDoc(root).provider_lanes, { gpt: 'operator-down', gemini: 'auto' });

  const geminiOnly = run(['write', root], JSON.stringify({ provider_lanes: { gemini: 'operator-down' } }));
  assert.strictEqual(geminiOnly.status, 0, geminiOnly.stderr);
  assert.deepStrictEqual(
    JSON.parse(geminiOnly.stdout).settings.provider_lanes,
    { gpt: 'operator-down', gemini: 'operator-down' },
    'setting gemini leaves gpt at its prior value rather than resetting it'
  );
  assert.deepStrictEqual(diskDoc(root).provider_lanes, { gpt: 'operator-down', gemini: 'operator-down' });
}

{
  // Setting a nested key when the parent is entirely absent from the
  // current document: the untouched sibling takes its documented default.
  const root = freshTree('lanes-absent-parent');
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')));
  const w = run(['write', root], JSON.stringify({ provider_lanes: { gpt: 'operator-down' } }));
  assert.strictEqual(w.status, 0, w.stderr);
  assert.deepStrictEqual(JSON.parse(w.stdout).settings.provider_lanes, { gpt: 'operator-down', gemini: 'auto' });
  assert.deepStrictEqual(diskDoc(root).provider_lanes, { gpt: 'operator-down', gemini: 'auto' });
}

{
  // Unknown provider key refuses the whole write.
  const root = freshTree('lanes-unknown-provider');
  const bad = run(['write', root], JSON.stringify({ provider_lanes: { claude: 'operator-down' } }));
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown provider "claude" in provider_lanes/);
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')), 'refused write created no file');
}

{
  // Unknown nested enum value refuses the whole write.
  const root = freshTree('lanes-unknown-value');
  const bad = run(['write', root], JSON.stringify({ provider_lanes: { gpt: 'disabled' } }));
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /"provider_lanes\.gpt" must be one of "auto", "operator-down"/);
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')), 'refused write created no file');
}

{
  // provider_lanes patch must itself be an object.
  const root = freshTree('lanes-not-object');
  const bad = run(['write', root], JSON.stringify({ provider_lanes: 'operator-down' }));
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /"provider_lanes" must be a nested object/);
}

{
  // Hand-edit recovery: unknown provider dropped, unknown nested value
  // clamps to default, missing sibling fills from default — every
  // correction reported.
  const root = freshTree('lanes-hand-edit');
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ provider_lanes: { gpt: 'operator-down', claude: 'operator-down', gemini: 'sideways' } }) + '\n'
  );
  const r = run(['read', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  const { settings, clamps } = JSON.parse(r.stdout);
  assert.deepStrictEqual(settings.provider_lanes, { gpt: 'operator-down', gemini: 'auto' });
  assert.ok(
    clampFor(clamps, 'provider_lanes.claude').some((c) => c.rule === 'unknown'),
    'unknown provider dropped and reported'
  );
  assert.ok(
    clampFor(clamps, 'provider_lanes.gemini').some((c) => c.rule === 'enum' && c.from === 'sideways' && c.to === 'auto'),
    'unknown nested value clamps to default and is reported'
  );

  // Missing parent entirely: every sibling reports its default.
  const root2 = freshTree('lanes-hand-edit-absent');
  fs.writeFileSync(path.join(root2, 'settings.json'), JSON.stringify({ delegation: 'balanced' }) + '\n');
  const r2 = run(['read', root2]);
  const { settings: s2, clamps: c2 } = JSON.parse(r2.stdout);
  assert.deepStrictEqual(s2.provider_lanes, { gpt: 'auto', gemini: 'auto' });
  assert.ok(clampFor(c2, 'provider_lanes').some((c) => c.rule === 'default'));
}

// --- cross_family_when_available: locked exactly like review_floor ----------
{
  const root = freshTree('locked-cross-family');
  const change = run(['write', root], JSON.stringify({ cross_family_when_available: false }));
  assert.strictEqual(change.status, 1, 'changing the locked key refuses the whole write');
  assert.match(change.stderr, /cross_family_when_available is locked at true/);
  assert.ok(!fs.existsSync(path.join(root, 'settings.json')));

  const restate = run(['write', root], JSON.stringify({ cross_family_when_available: true }));
  assert.strictEqual(restate.status, 0, restate.stderr);
  assert.strictEqual(diskDoc(root).cross_family_when_available, true);

  // A locked-key change smuggled in beside a valid lane patch still refuses everything.
  const smuggled = run(
    ['write', root],
    JSON.stringify({ provider_lanes: { gpt: 'operator-down' }, cross_family_when_available: false })
  );
  assert.strictEqual(smuggled.status, 1);
  assert.strictEqual(diskDoc(root).provider_lanes.gpt, 'auto', 'the valid half of a refused patch did not land');

  // Hand-edited locked value is discarded and re-applied on read.
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ cross_family_when_available: false }) + '\n');
  const r = run(['read', root]);
  const { settings, clamps } = JSON.parse(r.stdout);
  assert.strictEqual(settings.cross_family_when_available, true);
  const locked = clampFor(clamps, 'cross_family_when_available')[0];
  assert.strictEqual(locked.rule, 'locked');
  assert.strictEqual(locked.from, false);
  assert.strictEqual(locked.to, true);
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
