'use strict';

// maestro machine layer — decision-hold ledger (holds.jsonl).
//
// The SOLE sanctioned writer of holds.jsonl. Two record kinds live on this
// stream, both produced only here:
//
//   park     { summary, severity, owner_mission? } — an S2/S3 outcome of the
//            blocker ladder, parked with evidence so work continues. S1 is
//            structurally refused: S1 never parks; it goes to the operator.
//   resolve  { park_seq, answer, routed_to? } — the operator's (or ladder's)
//            decision on a previously parked hold, referencing the park's
//            ledger seq.
//
// A hold is OPEN when its park record has no resolve record referencing its
// seq. `list` prints exactly that set; stop.js imports openHolds() so the
// handoff's open-holds count can never drift from this one definition.

const fs = require('node:fs');
const path = require('node:path');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');

const HOLDS_BASENAME = 'holds.jsonl';

const PARK_SEVERITIES = new Set(['S2', 'S3']);
const S1_REFUSAL = 'S1 never parks; it goes to the operator';
const PARK_REQUIRED_KEYS = ['summary', 'severity'];
const PARK_ALL_KEYS = ['summary', 'severity', 'owner_mission'];
const RESOLVE_REQUIRED_KEYS = ['answer'];
const RESOLVE_ALL_KEYS = ['answer', 'routed_to'];

// Ordinary data objects only — same rationale as validators.js: a
// custom-prototype instance or a toJSON carrier can present one shape to the
// field checks and serialize another.
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (typeof value.toJSON === 'function') return false;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function holdsPathOf(treeRoot) {
  return path.join(treeRoot, HOLDS_BASENAME);
}

// Refuses a treeRoot that is not an existing directory: this module records
// into a tree, it never creates one — genesis belongs to the scaffold.
function requireTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('hold: treeRoot must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`hold: no tree at "${treeRoot}" — scaffold it first`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`hold: "${treeRoot}" is not a directory`);
  }
}

function checkExactKeys(obj, allKeys, requiredKeys, label, errors) {
  for (const key of Object.keys(obj)) {
    if (!allKeys.includes(key)) {
      errors.push(`${label} has unexpected extra key "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`${label} is missing required key "${key}"`);
    }
  }
}

function validatePark(park) {
  try {
    return validateParkChecked(park);
  } catch (err) {
    return { ok: false, errors: [`park could not be inspected: ${err.message}`] };
  }
}

function validateParkChecked(park) {
  if (!isPlainObject(park)) {
    return { ok: false, errors: ['park must be a plain object'] };
  }
  const errors = [];
  checkExactKeys(park, PARK_ALL_KEYS, PARK_REQUIRED_KEYS, 'park', errors);

  if (Object.prototype.hasOwnProperty.call(park, 'summary') && !isNonEmptyString(park.summary)) {
    errors.push('park field "summary" must be a non-empty string');
  }
  if (Object.prototype.hasOwnProperty.call(park, 'severity')) {
    if (park.severity === 'S1') {
      errors.push(S1_REFUSAL);
    } else if (!isNonEmptyString(park.severity) || !PARK_SEVERITIES.has(park.severity)) {
      errors.push('park field "severity" must be "S2" or "S3"');
    }
  }
  if (Object.prototype.hasOwnProperty.call(park, 'owner_mission') && !isNonEmptyString(park.owner_mission)) {
    errors.push('park field "owner_mission" must be a non-empty string when present');
  }
  return { ok: errors.length === 0, errors };
}

function validateResolution(resolution) {
  try {
    return validateResolutionChecked(resolution);
  } catch (err) {
    return { ok: false, errors: [`resolution could not be inspected: ${err.message}`] };
  }
}

function validateResolutionChecked(resolution) {
  if (!isPlainObject(resolution)) {
    return { ok: false, errors: ['resolution must be a plain object'] };
  }
  const errors = [];
  checkExactKeys(resolution, RESOLVE_ALL_KEYS, RESOLVE_REQUIRED_KEYS, 'resolution', errors);

  if (Object.prototype.hasOwnProperty.call(resolution, 'answer') && !isNonEmptyString(resolution.answer)) {
    errors.push('resolution field "answer" must be a non-empty string');
  }
  if (Object.prototype.hasOwnProperty.call(resolution, 'routed_to') && !isNonEmptyString(resolution.routed_to)) {
    errors.push('resolution field "routed_to" must be a non-empty string when present');
  }
  return { ok: errors.length === 0, errors };
}

// recordPark(treeRoot, park) -> stamped park record. Refuses (throws) before
// anything reaches disk on a malformed park, including the S1 refusal.
function recordPark(treeRoot, park) {
  requireTree(treeRoot);
  const { ok, errors } = validatePark(park);
  if (!ok) {
    throw new TypeError(`hold: invalid park — ${errors.join('; ')}`);
  }
  const payload = { summary: park.summary, severity: park.severity };
  if (Object.prototype.hasOwnProperty.call(park, 'owner_mission')) {
    payload.owner_mission = park.owner_mission;
  }
  return appendRecord(holdsPathOf(treeRoot), {
    kind: 'park',
    payload,
    // The owning mission is the natural correlator when the park names one.
    correlation_id: payload.owner_mission !== undefined ? payload.owner_mission : null,
  });
}

// openHolds(treeRoot) -> stamped park records that no resolve record has
// referenced yet — THE definition of "open", shared with stop.js's handoff
// count so the two surfaces can never disagree.
function openHolds(treeRoot) {
  requireTree(treeRoot);
  const { records } = readRecords(holdsPathOf(treeRoot));
  const resolvedSeqs = new Set();
  for (const record of records) {
    if (isRecordObject(record) && record.kind === 'resolve' && Number.isSafeInteger(record.park_seq)) {
      resolvedSeqs.add(record.park_seq);
    }
  }
  return records.filter(
    (record) =>
      isRecordObject(record) &&
      record.kind === 'park' &&
      Number.isSafeInteger(record.seq) &&
      !resolvedSeqs.has(record.seq)
  );
}

// resolveHold(treeRoot, seq, resolution) -> stamped resolve record. Refuses
// an unknown seq (no park record carries it) and an already-resolved one.
//
// This is a read-decide-append transaction over holds.jsonl. The stream's
// own lock lives inside appendRecord and is not reentrant, so the DECISION
// serializes on a dedicated transaction guard (same withLock primitive, its
// own lockfile): two concurrent resolves of the same seq cannot both pass
// the already-resolved check. park needs no guard — it decides nothing from
// a prior read.
function resolveHold(treeRoot, seq, resolution) {
  requireTree(treeRoot);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError('hold: seq must be a non-negative integer');
  }
  const { ok, errors } = validateResolution(resolution);
  if (!ok) {
    throw new TypeError(`hold: invalid resolution — ${errors.join('; ')}`);
  }

  const holdsPath = holdsPathOf(treeRoot);
  return withLock(holdsPath + '.txn', () => {
    const { records } = readRecords(holdsPath);
    let parkFound = false;
    for (const record of records) {
      if (!isRecordObject(record)) continue;
      if (record.kind === 'park' && record.seq === seq) parkFound = true;
      if (record.kind === 'resolve' && record.park_seq === seq) {
        throw new Error(`hold: park seq ${seq} is already resolved`);
      }
    }
    if (!parkFound) {
      throw new Error(`hold: no park record with seq ${seq} in ${HOLDS_BASENAME}`);
    }

    const payload = { park_seq: seq, answer: resolution.answer };
    if (Object.prototype.hasOwnProperty.call(resolution, 'routed_to')) {
      payload.routed_to = resolution.routed_to;
    }
    return appendRecord(holdsPath, {
      kind: 'resolve',
      payload,
      correlation_id: `park-${seq}`,
    });
  });
}

// --- CLI --------------------------------------------------------------------

const HELP = `hold.js — maestro decision-hold ledger (sole writer of holds.jsonl)

usage: hold.js park <treeRoot>            (park JSON piped via stdin)
       hold.js list <treeRoot>
       hold.js resolve <treeRoot> <seq>   (resolution JSON piped via stdin)

commands:
  park     stdin { summary, severity, owner_mission? }; severity "S2" or
           "S3" only — ${S1_REFUSAL}. Appends a "park"
           record and prints it.
  list     prints the open holds as a JSON array — every park record no
           resolve record references yet.
  resolve  stdin { answer, routed_to? }; appends a "resolve" record
           referencing park seq <seq>. Refuses an unknown or
           already-resolved seq.

Errors go to stderr with exit 1; nothing reaches disk on a refusal.
`;

function readStdinJson(label) {
  const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} JSON via stdin is not valid JSON: ${err.message}`);
  }
  return parsed;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    let result;
    if (command === 'park') {
      if (!isNonEmptyString(treeRoot)) throw new Error('park requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);
      result = recordPark(treeRoot, readStdinJson('park'));
    } else if (command === 'list') {
      if (!isNonEmptyString(treeRoot)) throw new Error('list requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);
      result = openHolds(treeRoot);
    } else if (command === 'resolve') {
      if (!isNonEmptyString(treeRoot)) throw new Error('resolve requires <treeRoot> <seq>');
      const [seqArg, ...extra] = rest;
      if (extra.length > 0) throw new Error(`unexpected extra argument(s): ${extra.join(' ')}`);
      if (typeof seqArg !== 'string' || !/^\d+$/.test(seqArg)) {
        throw new Error('resolve requires <seq> as a non-negative integer');
      }
      result = resolveHold(treeRoot, Number(seqArg), readStdinJson('resolution'));
    } else {
      throw new Error(
        command === undefined ? 'a command is required' : `unknown command "${command}" (expected park, list, or resolve)`
      );
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`hold.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { recordPark, openHolds, resolveHold, validatePark, S1_REFUSAL, HOLDS_BASENAME };
