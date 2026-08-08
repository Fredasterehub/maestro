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

// A test that cannot impose its precondition here (an unavailable rlimit, a
// date that rolled over mid-run) prints a "SKIP" line and still exits 0.
// That is correct — it is not a failure — but a green run that silently
// covered less than the last one is how a coverage gap becomes permanent.
// Every SKIP is therefore re-reported as a named known gap at the end, where
// CI output actually gets read.
const skipped = [];
let failed = 0;
for (const test of tests) {
  const r = spawnSync(process.execPath, [path.join(__dirname, test)], { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  for (const line of (r.stdout || '').split('\n')) {
    if (line.includes('SKIP')) skipped.push(line.trim());
  }
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
if (skipped.length > 0) {
  console.log(`KNOWN GAPS: ${skipped.length} case(s) skipped in this run, not covered by the green above:`);
  for (const line of skipped) console.log(`  - ${line}`);
}
