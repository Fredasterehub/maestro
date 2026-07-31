'use strict';

// Runs every test-*.js and *.test.js in this directory as its own node
// process; exits non-zero if any fails.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tests = fs
  .readdirSync(__dirname)
  .filter((name) => (name.startsWith('test-') && name.endsWith('.js')) || name.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const test of tests) {
  const r = spawnSync(process.execPath, [path.join(__dirname, test)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL ${test} (exit ${r.status})`);
  }
}

if (failed > 0) {
  console.error(`${failed}/${tests.length} test files failed`);
  process.exit(1);
}
console.log(`all ${tests.length} test files passed`);
