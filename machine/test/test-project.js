'use strict';

// Tests for project.js views: the four projections render, every view stays
// within the 60-line ceiling, truncation is noted with shown/total counts,
// resolved holds disappear, and recent.md is labeled as event history.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const PROJECT = path.join(SRC, 'project.js');
const { scaffoldTree } = require(path.join(SRC, 'scaffold.js'));
const { readJson, writeJson } = require(path.join(SRC, 'atomic-json.js'));
const { appendRecord } = require(path.join(SRC, 'jsonl.js'));
const { VIEW_LINE_CEILING } = require(PROJECT);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-project-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const root = path.join(tmp, 'proj', '.maestro');
scaffoldTree(root);

// --- seed the tree (test seeding writes directly; production writers are
// --- roster.js / mission.js / hold.js, not under test here) -----------------

writeJson(path.join(root, 'roster.json'), {
  schema_version: 1,
  entries: [
    { seat: 'executor-sol', family: 'gpt', task_id: 't1', status: 'alive', last_seen: '2026-07-30T10:00:00Z' },
    { seat: 'fleet-medic', family: 'claude', task_id: 't2', status: 'alive', last_seen: '2026-07-30T10:01:00Z' },
    { seat: 'scout', family: 'claude', task_id: 't0', status: 'finished', last_seen: '2026-07-30T09:00:00Z' },
  ],
});

// 80 open missions (forces truncation) + one done mission (must not render).
const state = readJson(path.join(root, 'state.json'));
const missions = {};
missions.m01 = { status: 'open', next_action: 'review executor envelope' };
for (let i = 2; i <= 80; i++) {
  missions[`m${String(i).padStart(2, '0')}`] = { status: 'open', next_action: `advance step ${i}` };
}
missions.mdone = { status: 'done', next_action: null };
writeJson(path.join(root, 'state.json'), { ...state, missions, active_mission: 'm01' });

// m01 checkpoints + envelopes.
const m01 = path.join(root, 'missions', 'm01');
fs.mkdirSync(path.join(m01, 'envelopes'), { recursive: true });
appendRecord(path.join(m01, 'progress.jsonl'), {
  kind: 'checkpoint',
  payload: { step: 'wired-config-loader', done_evidence: 'commit abc123', next: 'add tests' },
  correlation_id: 'm01',
});
appendRecord(path.join(m01, 'progress.jsonl'), {
  kind: 'checkpoint',
  payload: { step: 'loader-tests-green', done_evidence: 'gate seq 12', next: 'docs' },
  correlation_id: 'm01',
});
for (const name of ['e1.json', 'e2.json', 'e3.json']) {
  fs.writeFileSync(path.join(m01, 'envelopes', name), '{}\n');
}

// 70 parked holds (seqs 1..70 after the genesis seed), first one resolved —
// 69 open, forcing truncation of holds.md. Seeded through hold.js — the
// stream's sole writer — so the view is tested against real records.
const { recordPark, resolveHold } = require(path.join(SRC, 'hold.js'));
const parkSeqs = [];
for (let i = 1; i <= 70; i++) {
  const rec = recordPark(root, {
    summary: `parked issue number ${i}`,
    severity: i % 2 === 0 ? 'S3' : 'S2',
    owner_mission: 'm01',
  });
  parkSeqs.push(rec.seq);
}
resolveHold(root, parkSeqs[0], { answer: 'fixed upstream' });

// 40 more ledger events (genesis already present → 41 total).
const ledgerPath = path.join(root, 'ledger.jsonl');
for (let i = 1; i <= 40; i++) {
  appendRecord(ledgerPath, {
    kind: 'gate',
    payload: { gate_id: `gate-${i}`, cmd: 'true', exit_code: 0 },
    correlation_id: `gate-${i}`,
  });
}

// --- render -----------------------------------------------------------------

const r = spawnSync(process.execPath, [PROJECT, 'views', root], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, `views render failed: ${r.stderr}`);

function readView(name) {
  const text = fs.readFileSync(path.join(root, 'views', name), 'utf8');
  assert.ok(text.endsWith('\n'), `${name} must end with a newline`);
  const lines = text.slice(0, -1).split('\n');
  assert.ok(
    lines.length <= VIEW_LINE_CEILING,
    `${name} has ${lines.length} lines, over the ${VIEW_LINE_CEILING}-line ceiling`
  );
  return { text, lines };
}

// fleet.md: grouped by status, one line per seat.
{
  const { text } = readView('fleet.md');
  assert.match(text, /## alive \(2\)/);
  assert.match(text, /## finished \(1\)/);
  assert.match(text, /- executor-sol\s+family=gpt\s+task=t1/);
}

// missions.md: open only, next_action + checkpoint + envelope count,
// truncation counted.
{
  const { text } = readView('missions.md');
  assert.match(text, /- m01 \[open\] \*active\*\s+next: review executor envelope/);
  assert.match(text, /last checkpoint: loader-tests-green/);
  assert.match(text, /envelopes: 3/);
  assert.ok(!text.includes('mdone'), 'done missions must not render');
  assert.match(text, /\(truncated: showing \d+ of 80 open missions\)/);
}

// holds.md: open holds oldest first, resolved park gone, truncation counted.
{
  const { text, lines } = readView('holds.md');
  const firstEntry = lines.find((l) => l.startsWith('- seq='));
  assert.ok(firstEntry.startsWith(`- seq=${parkSeqs[1]} `), `oldest open hold first, got: ${firstEntry}`);
  assert.ok(!text.includes(`- seq=${parkSeqs[0]} `), 'resolved hold must not render');
  assert.match(text, /\(truncated: showing \d+ of 69 open holds\)/);
  assert.match(text, /parked issue number 2/);
}

// recent.md: last 15 of 41, labeled as history, newest events present.
{
  const { text } = readView('recent.md');
  assert.match(text, /Event history, not current state/);
  assert.match(text, /Last 15 of 41 ledger record\(s\)/);
  assert.match(text, /gate-40\s+.*exit=0|gate_id=gate-40 exit=0/);
  assert.ok(!text.includes('gate_id=gate-25'), 'only the last 15 events render');
}

// Empty tree: views still render, small and honest.
{
  const bare = path.join(tmp, 'bare', '.maestro');
  scaffoldTree(bare);
  const rb = spawnSync(process.execPath, [PROJECT, 'views', bare], { encoding: 'utf8' });
  assert.strictEqual(rb.status, 0, rb.stderr);
  assert.match(fs.readFileSync(path.join(bare, 'views', 'fleet.md'), 'utf8'), /No roster recorded\./);
  assert.match(fs.readFileSync(path.join(bare, 'views', 'missions.md'), 'utf8'), /No open missions\./);
  assert.match(fs.readFileSync(path.join(bare, 'views', 'holds.md'), 'utf8'), /No open holds\./);
  assert.match(fs.readFileSync(path.join(bare, 'views', 'recent.md'), 'utf8'), /genesis/);
}

// Unscaffolded tree refuses; argv discipline; help.
{
  const bad = spawnSync(process.execPath, [PROJECT, 'views', path.join(tmp, 'nope')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /scaffold the tree first/);
  const surplus = spawnSync(process.execPath, [PROJECT, 'views', root, 'x'], { encoding: 'utf8' });
  assert.strictEqual(surplus.status, 1);
  const help = spawnSync(process.execPath, [PROJECT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /usage: project\.js views <treeRoot>/);
}

console.log('test-project: ok');
