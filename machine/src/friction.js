'use strict';

// maestro machine layer — friction recorder.
//
// The SOLE sanctioned writer of ledger.jsonl friction records: the closed
// vocabulary from DECISIONS.md's Visibility section — three rare real-time
// events (ladder engaged, seat degraded, worker died-and-re-dispatched) plus
// revise-verdict, recorded on every reviewer revise so the revise-cap and the
// per-mission audit patterns have one honest source. Unlike deviate.js's
// wrapper "deviation" kind, the ledger kind here is the friction kind
// *verbatim* — a reader can `grep '"kind":"ladder-engaged"'` the ledger
// directly, no second field to unwrap.
//
// `rates` is the read side: JSON aggregates over the ledger's friction
// records, the evidence `/maestro:audit` reports against. Zero of any kind
// is a legitimate, reportable outcome — it is never omitted from the shape.

const fs = require('node:fs');
const path = require('node:path');

const { appendRecord, readRecords } = require('./jsonl.js');
const { validateFriction, FRICTION_KINDS } = require('./validators.js');

const LEDGER_BASENAME = 'ledger.jsonl';
const UNKNOWN_MISSION = '(unknown mission)';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Refuses a treeRoot that is not an existing directory: this module records
// into a tree, it never creates one — genesis belongs to the scaffold.
function requireTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('friction: treeRoot must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`friction: no tree at "${treeRoot}" — scaffold it first`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`friction: "${treeRoot}" is not a directory`);
  }
}

// recordFriction(treeRoot, friction) -> stamped ledger record. Refuses
// (throws) before anything reaches disk on a malformed friction record.
function recordFriction(treeRoot, friction) {
  requireTree(treeRoot);
  const { ok, errors } = validateFriction(friction);
  if (!ok) {
    throw new TypeError(`friction: invalid friction record — ${errors.join('; ')}`);
  }
  const payload = { mission_id: friction.mission_id };
  if (Object.prototype.hasOwnProperty.call(friction, 'seat')) {
    payload.seat = friction.seat;
  }
  payload.detail = friction.detail;
  return appendRecord(path.join(treeRoot, LEDGER_BASENAME), {
    // Ledger kind is the friction kind verbatim — never wrapped.
    kind: friction.kind,
    payload,
    correlation_id: friction.mission_id,
  });
}

function emptyKindCounts() {
  const counts = {};
  for (const kind of FRICTION_KINDS) counts[kind] = 0;
  return counts;
}

// computeRates(treeRoot) -> aggregates over every friction record on the
// ledger: counts per kind (global), a per-mission breakdown (per kind plus
// a total), the revise-verdict count per mission on its own (the field the
// revise-cap pattern reads directly), and the ladder-engaged total (the
// field the ladder-engagement pattern reads directly). A ledger record whose
// kind is outside FRICTION_KINDS is not a friction record and is skipped —
// this stream is shared with every other ledger writer.
function computeRates(treeRoot) {
  requireTree(treeRoot);
  const { records, errors } = readRecords(path.join(treeRoot, LEDGER_BASENAME));

  const by_kind = emptyKindCounts();
  const by_mission = {};

  for (const record of records) {
    if (!isPlainObject(record) || typeof record.kind !== 'string' || !FRICTION_KINDS.has(record.kind)) {
      continue;
    }
    by_kind[record.kind] += 1;
    const missionId = isNonEmptyString(record.mission_id) ? record.mission_id : UNKNOWN_MISSION;
    if (!by_mission[missionId]) {
      by_mission[missionId] = { ...emptyKindCounts(), total: 0 };
    }
    by_mission[missionId][record.kind] += 1;
    by_mission[missionId].total += 1;
  }

  const revise_verdict_by_mission = {};
  for (const [missionId, counts] of Object.entries(by_mission)) {
    revise_verdict_by_mission[missionId] = counts['revise-verdict'];
  }

  return {
    by_kind,
    by_mission,
    revise_verdict_by_mission,
    ladder_engaged_total: by_kind['ladder-engaged'],
    unparseable_lines: errors.length,
  };
}

// --- CLI --------------------------------------------------------------------

const HELP = `friction.js — maestro friction recorder (sole writer of ledger friction records)

usage: friction.js record <treeRoot>   (friction JSON piped via stdin)
       friction.js rates <treeRoot>

commands:
  record   stdin { kind, mission_id, seat?, detail } — kind one of
           ${[...FRICTION_KINDS].join(', ')};
           mission_id and detail non-empty strings; detail single-line,
           <=200 chars; seat non-empty when present; no extra keys. Appends
           a ledger record whose "kind" is the friction kind verbatim (not
           a wrapper kind) and prints the stamped record.
  rates    prints JSON aggregates over the ledger's friction records:
           { by_kind, by_mission, revise_verdict_by_mission,
             ladder_engaged_total, unparseable_lines }. by_kind and every
           by_mission entry carry all four kinds even at zero — zero
           friction is a legitimate, reportable outcome.

Errors go to stderr with exit 1; nothing reaches disk on a refusal.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (command === 'record') {
      if (!isNonEmptyString(treeRoot)) throw new Error('record requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

      const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`friction JSON via stdin is not valid JSON: ${err.message}`);
      }
      const result = recordFriction(treeRoot, parsed);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (command === 'rates') {
      if (!isNonEmptyString(treeRoot)) throw new Error('rates requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

      const result = computeRates(treeRoot);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      throw new Error(
        command === undefined ? 'a command is required' : `unknown command "${command}" (expected record or rates)`
      );
    }
  } catch (err) {
    process.stderr.write(`friction.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { recordFriction, computeRates, LEDGER_BASENAME };
