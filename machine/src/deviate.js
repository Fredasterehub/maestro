'use strict';

// maestro machine layer — deviation recorder.
//
// The SOLE sanctioned writer of ledger.jsonl "deviation" records: the audit
// channel for a gap between an instruction's premise and observed reality.
// Workers refuse the false-premise step AND record the deviation here — a
// workaround that works leaves the false premise standing for every step
// after it. The shape is validators.js's validateDeviation: exactly
// { reported_by, expected, actual, summary }, all non-empty, reported_by
// never "system" or "unknown" (an audit fact with no attributable reporter
// behind it is not a deviation report), and deliberately no severity field —
// whether the gap also became a blocker is the ladder's separate question.

const fs = require('node:fs');
const path = require('node:path');

const { appendRecord } = require('./jsonl.js');
const { validateDeviation, DEVIATION_KEYS } = require('./validators.js');

const LEDGER_BASENAME = 'ledger.jsonl';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Refuses a treeRoot that is not an existing directory: this module records
// into a tree, it never creates one — genesis belongs to the scaffold.
function requireTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('deviate: treeRoot must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`deviate: no tree at "${treeRoot}" — scaffold it first`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`deviate: "${treeRoot}" is not a directory`);
  }
}

// recordDeviation(treeRoot, deviation) -> stamped ledger record. Refuses
// (throws) before anything reaches disk on a malformed deviation.
function recordDeviation(treeRoot, deviation) {
  requireTree(treeRoot);
  const { ok, errors } = validateDeviation(deviation);
  if (!ok) {
    throw new TypeError(`deviate: invalid deviation — ${errors.join('; ')}`);
  }
  // Rebuilt from the named fields (validated exact-key, so nothing is lost):
  // the payload appended is exactly the four-field contract, never the raw
  // parsed input.
  const payload = {};
  for (const key of DEVIATION_KEYS) {
    payload[key] = deviation[key];
  }
  return appendRecord(path.join(treeRoot, LEDGER_BASENAME), {
    kind: 'deviation',
    payload,
    correlation_id: null,
  });
}

// --- CLI --------------------------------------------------------------------

const HELP = `deviate.js — maestro deviation recorder (sole writer of ledger "deviation" records)

usage: deviate.js record-deviation <treeRoot>   (deviation JSON piped via stdin)

stdin shape (validators.js validate-deviation):
  { reported_by, expected, actual, summary } — all non-empty strings;
  reported_by must name a real reporting agent, never "system" or "unknown";
  no extra keys; deliberately no severity field.

Appends a "deviation" record to <treeRoot>/${LEDGER_BASENAME} and prints the
stamped record. Errors go to stderr with exit 1; nothing reaches disk on a
refusal.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (command !== 'record-deviation') {
      throw new Error(
        command === undefined ? 'a command is required' : `unknown command "${command}" (expected record-deviation)`
      );
    }
    if (!isNonEmptyString(treeRoot)) throw new Error('record-deviation requires <treeRoot>');
    if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

    const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`deviation JSON via stdin is not valid JSON: ${err.message}`);
    }
    const result = recordDeviation(treeRoot, parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`deviate.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { recordDeviation };
