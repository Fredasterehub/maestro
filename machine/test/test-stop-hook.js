'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'scripts', 'stop-guard.mjs');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-stop-hook-'));
const tree = path.join(project, '.maestro');
fs.mkdirSync(tree);
fs.writeFileSync(path.join(tree, 'roster.json'), JSON.stringify({
  schema_version: 1,
  entries: [
    { seat: 'executor-sol', task_id: 'task-1', status: 'alive' },
    { seat: 'reviewer-claude', task_id: 'task-2', status: 'finished' },
  ],
}));

function run(input) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: project,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

// The real roster shape must expose its alive seat, and Codex's stable
// last_assistant_message field is the primary supervision signal.
let result = run({
  hook_event_name: 'Stop',
  cwd: project,
  stop_hook_active: false,
  last_assistant_message: 'The requested edit is complete.',
});
assert.strictEqual(result.status, 0, result.stderr);
let output = JSON.parse(result.stdout);
assert.strictEqual(output.decision, 'block');
assert.match(output.reason, /executor-sol \(task task-1\)/);

result = run({
  hook_event_name: 'Stop',
  cwd: project,
  stop_hook_active: false,
  last_assistant_message: 'The worker is still running; I will report when it finishes.',
});
assert.strictEqual(result.status, 0, result.stderr);
assert.strictEqual(result.stdout, '', 'visible supervision permits the turn to end');

// Loop prevention and malformed host input remain fail-open.
result = run({
  hook_event_name: 'Stop',
  cwd: project,
  stop_hook_active: true,
  last_assistant_message: 'No supervision wording.',
});
assert.strictEqual(result.stdout, '');
result = run('{bad hook input');
assert.strictEqual(result.stdout, '');

fs.rmSync(project, { recursive: true, force: true });
console.log('test-stop-hook: ok');
