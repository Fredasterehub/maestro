'use strict';

// maestro machine layer — mission lifecycle CLI.
//
// Sole sanctioned writer of:
//   ledger.jsonl kinds:            mission-open, envelope, consult, mission-close
//   missions/<id>/progress.jsonl:  genesis, checkpoint
//   missions/<id>/brief.json, missions/<id>/envelopes/*.json
//   state.json.missions[<id>] entries (status + next_action)
//
// Every state.json mutation runs inside updateJson's lock, and the ledger
// append it pairs with happens FROM INSIDE the updater, so both writes are
// decided against the same locked read (ledger-first: the evidence record
// lands before the resume pointer moves).
//
// close refuses without a cross-family "approve" AND a ledger gate record
// with exit_code 0 for this mission at the exact seq the caller cites,
// still latest-by-seq for its gate_id (a superseded green gate is stale
// evidence) — gate.js run-gate is the only producer of that evidence, so a
// mission can never report done on prose alone.

const fs = require('node:fs');
const path = require('node:path');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');
const { readJson, writeJson, updateJson } = require('./atomic-json.js');
const { validateBrief, validateEnvelope } = require('./validators.js');
const { assertContained } = require('./contain.js');

const FAMILIES = new Set(['claude', 'gpt', 'gemini']);
const REVIEW_VERDICTS = new Set(['approve', 'revise']);
const MISSION_STATUSES = { OPEN: 'open', DONE: 'done' };
const DEFAULT_NEXT_ACTION = 'dispatch a worker against brief.json';

// Ids and seats become path segments under missions/; anything outside this
// shape (separators, dot-prefixes, empty) is refused before any path is built.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeSegment(value) {
  return typeof value === 'string' && SEGMENT_RE.test(value);
}

function assertExactKeys(obj, requiredKeys, optionalKeys, label) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} has unexpected extra key "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new TypeError(`${label} is missing required key "${key}"`);
    }
  }
}

function statePathOf(treeRoot) {
  return path.join(treeRoot, 'state.json');
}

function ledgerPathOf(treeRoot) {
  return path.join(treeRoot, 'ledger.jsonl');
}

function missionDirOf(treeRoot, missionId) {
  return path.join(treeRoot, 'missions', missionId);
}

function progressPathOf(treeRoot, missionId) {
  return path.join(missionDirOf(treeRoot, missionId), 'progress.jsonl');
}

// Minimal state.json genesis for a tree scaffold.js has not seeded yet;
// existing fields are always spread forward, never clobbered, since other
// scripts (stop.js, preflight.js) own their own fields in the same file.
function freshState() {
  return { schema_version: 1, missions: {}, active_mission: null };
}

function missionsOf(state, statePath) {
  if (!isPlainObject(state)) {
    throw new Error(`mission: ${statePath} is not a JSON object`);
  }
  const missions = state.missions === undefined ? {} : state.missions;
  if (!isPlainObject(missions)) {
    throw new Error(`mission: ${statePath} field "missions" is not an object`);
  }
  return missions;
}

// The guard every post-open write shares: the mission must exist and still
// be open — a closed mission's evidence stream never stays mutable.
function requireOpenMission(state, statePath, missionId) {
  const missions = missionsOf(state, statePath);
  const entry = missions[missionId];
  if (!isPlainObject(entry)) {
    throw new Error(`mission: no such mission "${missionId}" in ${statePath} (open it first)`);
  }
  if (entry.status !== MISSION_STATUSES.OPEN) {
    throw new Error(
      `mission: mission "${missionId}" has status "${entry.status}" — only an open mission accepts writes`
    );
  }
  return entry;
}

// --- open --------------------------------------------------------------------

function openMission(treeRoot, input) {
  if (!isPlainObject(input)) {
    throw new TypeError('mission: open requires a JSON object via stdin');
  }
  assertExactKeys(input, ['mission_id', 'title', 'brief'], ['next_action'], 'open input');
  const { mission_id: missionId, title, brief } = input;
  if (!isSafeSegment(missionId)) {
    throw new TypeError(
      `mission: "mission_id" must match ${SEGMENT_RE} (got ${JSON.stringify(missionId)})`
    );
  }
  if (!isNonEmptyString(title)) {
    throw new TypeError('mission: "title" must be a non-empty string');
  }
  const nextAction = Object.prototype.hasOwnProperty.call(input, 'next_action')
    ? input.next_action
    : DEFAULT_NEXT_ACTION;
  if (!isNonEmptyString(nextAction)) {
    throw new TypeError('mission: "next_action" must be a non-empty string when provided');
  }
  const briefCheck = validateBrief(brief);
  if (!briefCheck.ok) {
    throw new Error(`mission: refusing to open on an invalid brief — ${briefCheck.errors.join('; ')}`);
  }

  const statePath = statePathOf(treeRoot);
  const missionDir = missionDirOf(treeRoot, missionId);
  let openSeq;

  updateJson(
    statePath,
    (current) => {
      const state = current === undefined ? freshState() : current;
      const missions = missionsOf(state, statePath);
      if (Object.prototype.hasOwnProperty.call(missions, missionId)) {
        throw new Error(`mission: mission "${missionId}" already exists in ${statePath} — open is one-shot`);
      }
      if (fs.existsSync(missionDir)) {
        throw new Error(`mission: mission directory already exists at ${missionDir} — open is one-shot`);
      }
      // A dangling symlink at missions/<id> (existsSync false) or a symlinked
      // missions/ parent would aim every write below outside the tree.
      assertContained(treeRoot, missionDir, 'mission');

      for (const sub of ['mailbox', 'envelopes', 'artifacts']) {
        fs.mkdirSync(path.join(missionDir, sub), { recursive: true });
      }
      writeJson(path.join(missionDir, 'brief.json'), brief);
      // Genesis-seeded stream: "never ran" stays distinguishable from "ran
      // and produced nothing".
      appendRecord(progressPathOf(treeRoot, missionId), {
        kind: 'genesis',
        payload: {},
        correlation_id: missionId,
      });
      openSeq = appendRecord(ledgerPathOf(treeRoot), {
        kind: 'mission-open',
        payload: { mission_id: missionId, title },
        correlation_id: missionId,
      }).seq;

      return {
        ...state,
        missions: {
          ...missions,
          [missionId]: { status: MISSION_STATUSES.OPEN, next_action: nextAction },
        },
      };
    },
    undefined
  );

  return { mission_id: missionId, mission_dir: missionDir, next_action: nextAction, ledger_seq: openSeq };
}

// --- checkpoint --------------------------------------------------------------

function checkpointMission(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: checkpoint requires a JSON object via stdin');
  }
  assertExactKeys(input, ['step', 'done_evidence', 'next'], [], 'checkpoint input');
  for (const key of ['step', 'done_evidence', 'next']) {
    if (!isNonEmptyString(input[key])) {
      throw new TypeError(`mission: checkpoint field "${key}" must be a non-empty string`);
    }
  }

  const statePath = statePathOf(treeRoot);
  const progressPath = progressPathOf(treeRoot, missionId);
  let seq;

  updateJson(
    statePath,
    (current) => {
      const state = current;
      const entry = requireOpenMission(state, statePath, missionId);
      if (!fs.existsSync(progressPath)) {
        throw new Error(`mission: ${progressPath} does not exist — mission tree is missing its progress stream`);
      }
      assertContained(treeRoot, progressPath, 'mission');
      seq = appendRecord(progressPath, {
        kind: 'checkpoint',
        payload: { step: input.step, done_evidence: input.done_evidence, next: input.next },
        correlation_id: missionId,
      }).seq;
      return {
        ...state,
        missions: {
          ...missionsOf(state, statePath),
          [missionId]: { ...entry, next_action: input.next },
        },
      };
    },
    undefined
  );

  return { mission_id: missionId, progress_seq: seq, next_action: input.next };
}

// --- record-envelope ---------------------------------------------------------

function recordEnvelope(treeRoot, missionId, seat, envelope) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isSafeSegment(seat)) {
    throw new TypeError(`mission: seat must match ${SEGMENT_RE} (got ${JSON.stringify(seat)})`);
  }
  const check = validateEnvelope(envelope);
  if (!check.ok) {
    throw new Error(`mission: refusing an invalid envelope — ${check.errors.join('; ')}`);
  }

  const statePath = statePathOf(treeRoot);
  const envelopesDir = path.join(missionDirOf(treeRoot, missionId), 'envelopes');

  // The open-status check, the file write, and the ledger append all run
  // under state.json's own lock — the same lock close's updater holds — so
  // a concurrent close can never let an envelope land on a done mission.
  // Lock order (state → ledger) matches every other writer.
  return withLock(statePath, () => {
    const state = readJson(statePath, undefined);
    requireOpenMission(state, statePath, missionId);
    // Before mkdir: a symlinked envelopes/ (or parent) would aim the write
    // outside the tree.
    assertContained(treeRoot, envelopesDir, 'mission');
    fs.mkdirSync(envelopesDir, { recursive: true });

    // ISO timestamp made filesystem-safe; a same-millisecond collision for the
    // same seat gets a numeric suffix rather than an overwrite.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let envelopePath = path.join(envelopesDir, `${ts}-${seat}.json`);
    for (let n = 2; fs.existsSync(envelopePath); n++) {
      envelopePath = path.join(envelopesDir, `${ts}-${seat}-${n}.json`);
    }
    writeJson(envelopePath, envelope);

    // File first, ledger second: the event names a path, and an event naming a
    // path that does not exist yet would be false the moment it was written.
    const seq = appendRecord(ledgerPathOf(treeRoot), {
      kind: 'envelope',
      payload: {
        mission_id: missionId,
        seat,
        state: envelope.state,
        path: path.relative(treeRoot, envelopePath),
      },
      correlation_id: missionId,
    }).seq;

    return { mission_id: missionId, seat, envelope_path: envelopePath, ledger_seq: seq };
  });
}

// --- record-consult ----------------------------------------------------------

function recordConsult(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: record-consult requires a JSON object via stdin');
  }
  assertExactKeys(input, ['consult_id', 'question', 'verdict', 'anchor'], [], 'consult input');
  for (const key of ['consult_id', 'question', 'verdict', 'anchor']) {
    if (!isNonEmptyString(input[key])) {
      throw new TypeError(`mission: consult field "${key}" must be a non-empty string`);
    }
  }

  const statePath = statePathOf(treeRoot);

  // Same discipline as record-envelope: open-status is decided under the
  // state lock, so a racing close can never be interleaved with this append.
  return withLock(statePath, () => {
    const state = readJson(statePath, undefined);
    requireOpenMission(state, statePath, missionId);

    const seq = appendRecord(ledgerPathOf(treeRoot), {
      kind: 'consult',
      payload: {
        mission_id: missionId,
        consult_id: input.consult_id,
        question: input.question,
        verdict: input.verdict,
        anchor: input.anchor,
      },
      correlation_id: missionId,
    }).seq;

    return { mission_id: missionId, consult_id: input.consult_id, ledger_seq: seq };
  });
}

// --- close -------------------------------------------------------------------

function closeMission(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: close requires a JSON object via stdin');
  }
  assertExactKeys(input, ['author_family', 'review', 'gate_seq'], [], 'close input');
  const { author_family: authorFamily, review, gate_seq: gateSeq } = input;
  if (!FAMILIES.has(authorFamily)) {
    throw new TypeError(
      `mission: "author_family" must be one of ${[...FAMILIES].join(', ')} (got ${JSON.stringify(authorFamily)})`
    );
  }
  if (!isPlainObject(review)) {
    throw new TypeError('mission: "review" must be an object { verdict, family }');
  }
  assertExactKeys(review, ['verdict', 'family'], [], 'close review');
  if (!REVIEW_VERDICTS.has(review.verdict)) {
    throw new TypeError(
      `mission: "review.verdict" must be one of ${[...REVIEW_VERDICTS].join(', ')} (got ${JSON.stringify(review.verdict)})`
    );
  }
  if (!FAMILIES.has(review.family)) {
    throw new TypeError(
      `mission: "review.family" must be one of ${[...FAMILIES].join(', ')} (got ${JSON.stringify(review.family)})`
    );
  }
  if (!Number.isSafeInteger(gateSeq) || gateSeq < 0) {
    throw new TypeError('mission: "gate_seq" must be a nonnegative integer naming a ledger seq');
  }

  // The three refusals that make "done" mean something. Verdict and family
  // are checked before any file is touched; the gate evidence is re-read
  // under the state lock so a close can never race its own evidence.
  if (review.verdict !== 'approve') {
    throw new Error(
      `mission: close refused — review verdict is "${review.verdict}", and only "approve" closes a mission`
    );
  }
  if (review.family === authorFamily) {
    throw new Error(
      `mission: close refused — review.family ("${review.family}") equals author_family: cross-family review law`
    );
  }

  const statePath = statePathOf(treeRoot);
  const ledgerPath = ledgerPathOf(treeRoot);
  let closeSeq;

  updateJson(
    statePath,
    (current) => {
      const state = current;
      const entry = requireOpenMission(state, statePath, missionId);

      const { records, errors } = readRecords(ledgerPath);
      if (errors.length > 0) {
        const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
        throw new Error(`mission: ${ledgerPath} has malformed record(s) — refusing to trust this stream: ${detail}`);
      }
      const matches = records.filter((r) => isPlainObject(r) && r.seq === gateSeq);
      if (matches.length === 0) {
        throw new Error(`mission: close refused — no ledger record has seq ${gateSeq}`);
      }
      if (matches.length > 1) {
        throw new Error(`mission: close refused — seq ${gateSeq} is ambiguous (${matches.length} records carry it)`);
      }
      const gate = matches[0];
      if (gate.kind !== 'gate') {
        throw new Error(
          `mission: close refused — ledger record at seq ${gateSeq} has kind "${gate.kind}", not "gate"`
        );
      }
      if (gate.mission_id !== missionId) {
        throw new Error(
          `mission: close refused — gate record at seq ${gateSeq} belongs to mission ${JSON.stringify(gate.mission_id)}, not "${missionId}"`
        );
      }
      if (gate.exit_code !== 0) {
        throw new Error(
          `mission: close refused — gate record at seq ${gateSeq} has exit_code ${JSON.stringify(gate.exit_code)}, and only a real 0 closes a mission`
        );
      }
      // Latest-by-seq honesty (check-honesty's law, enforced at close): the
      // cited green gate must still be the newest record for its gate_id on
      // this mission — a stale success can never paper over a later failure.
      for (const record of records) {
        if (!isPlainObject(record) || record.kind !== 'gate') continue;
        if (record.mission_id !== missionId || record.gate_id !== gate.gate_id) continue;
        if (Number.isSafeInteger(record.seq) && record.seq > gate.seq) {
          throw new Error(
            `mission: close refused — gate "${gate.gate_id}" at seq ${gateSeq} is superseded by a later run at seq ${record.seq} (latest-by-seq honesty)`
          );
        }
      }

      closeSeq = appendRecord(ledgerPath, {
        kind: 'mission-close',
        payload: {
          mission_id: missionId,
          author_family: authorFamily,
          review: { verdict: review.verdict, family: review.family },
          gate_seq: gateSeq,
        },
        correlation_id: missionId,
      }).seq;

      const next = {
        ...state,
        missions: {
          ...missionsOf(state, statePath),
          [missionId]: { ...entry, status: MISSION_STATUSES.DONE, next_action: null },
        },
      };
      // A resume pointer aimed at a mission that just finished is stale the
      // moment the close lands.
      if (next.active_mission === missionId) {
        next.active_mission = null;
      }
      return next;
    },
    undefined
  );

  return { mission_id: missionId, status: MISSION_STATUSES.DONE, ledger_seq: closeSeq, gate_seq: gateSeq };
}

// --- CLI ---------------------------------------------------------------------

const HELP = `mission.js — maestro mission lifecycle (sole writer of mission records)

usage: mission.js <command> <treeRoot> [args]   (input JSON piped via stdin)

commands:
  open <treeRoot>
      stdin { mission_id, title, brief, next_action? } — brief is the
      eight-field dispatch brief and is validated before anything is written.
      Creates missions/<id>/{brief.json, mailbox/, envelopes/, artifacts/,
      progress.jsonl (genesis-seeded)}, appends ledger kind "mission-open",
      and sets state.json.missions[<id>] = { status: "open", next_action }.
      One-shot: an existing mission id or directory refuses the open.
  checkpoint <treeRoot> <missionId>
      stdin { step, done_evidence, next } — appends a "checkpoint" record to
      missions/<id>/progress.jsonl and moves state.json.missions[<id>]
      .next_action to next. Open missions only.
  record-envelope <treeRoot> <missionId> <seat>
      stdin: a six-field worker envelope, validated (invalid is refused with
      the exact validator errors). Written atomically to
      missions/<id>/envelopes/<ts>-<seat>.json, then ledger kind "envelope".
  record-consult <treeRoot> <missionId>
      stdin { consult_id, question, verdict, anchor } — ledger kind "consult".
  close <treeRoot> <missionId>
      stdin { author_family, review: { verdict, family }, gate_seq }.
      REFUSES unless review.verdict is "approve", review.family differs from
      author_family (cross-family review law), and the ledger record at seq
      gate_seq is kind "gate" with exit_code 0 for this mission AND is the
      latest gate record for its gate_id on this mission — a green gate that
      a later run has superseded is stale evidence (gate.js run-gate is the
      only producer of that evidence). On success sets status "done" and
      appends ledger kind "mission-close".

Families: ${[...FAMILIES].join(' | ')}. Prints a result JSON on success and
exits 0; any refusal prints its reason to stderr and exits 1.
`;

function readStdinJson() {
  let text;
  try {
    text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (err) {
    throw new Error(`stdin could not be read: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin did not carry valid JSON: ${err.message}`);
  }
}

// Positional arity per command, after <command> itself. Fail-closed: a
// surplus argument or an unknown command is a refusal, never ignored.
const COMMAND_ARITY = {
  open: 1,
  checkpoint: 2,
  'record-envelope': 3,
  'record-consult': 2,
  close: 2,
};

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, ...rest] = argv;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_ARITY, command)) {
    process.stderr.write(
      `mission.js: ${command === undefined ? 'a command is required' : `unknown command "${command}"`}\n${HELP}`
    );
    process.exit(1);
  }
  if (rest.length !== COMMAND_ARITY[command]) {
    process.stderr.write(
      `mission.js: "${command}" takes exactly ${COMMAND_ARITY[command]} argument(s), got ${rest.length}\n${HELP}`
    );
    process.exit(1);
  }
  const [treeRoot] = rest;
  if (!isNonEmptyString(treeRoot)) {
    process.stderr.write(`mission.js: <treeRoot> must be a non-empty path\n`);
    process.exit(1);
  }

  try {
    const input = readStdinJson();
    let result;
    if (command === 'open') {
      result = openMission(treeRoot, input);
    } else if (command === 'checkpoint') {
      result = checkpointMission(treeRoot, rest[1], input);
    } else if (command === 'record-envelope') {
      result = recordEnvelope(treeRoot, rest[1], rest[2], input);
    } else if (command === 'record-consult') {
      result = recordConsult(treeRoot, rest[1], input);
    } else {
      result = closeMission(treeRoot, rest[1], input);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`mission.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  openMission,
  checkpointMission,
  recordEnvelope,
  recordConsult,
  closeMission,
  FAMILIES,
  REVIEW_VERDICTS,
  MISSION_STATUSES,
};
