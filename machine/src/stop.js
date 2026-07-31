'use strict';

// maestro machine layer — stop recorder.
//
// The SOLE sanctioned writer of ledger.jsonl "stop" records, of
// state.json.last_stop, and of handoff.md. A stop narrated but not recorded
// through this seat did not happen, as far as the next session's resume can
// tell. Fails closed outside validators.js's five-value stop vocabulary —
// nothing reaches disk on a malformed stop.
//
// The whole write runs as ONE critical section held on state.json's own
// lock — the SAME lockfile atomic-json.js's updateJson takes on that path,
// so every other state.json writer stays serialized against this one. In
// order, inside that lock:
//   1. precondition: state.json must exist and parse (scaffold owns genesis);
//   2. handoff.md containment is validated — an existing symlink at the
//      target, or a symlinked parent escaping the tree, refuses with the
//      ledger and state.json both still untouched;
//   3. ledger-first write-ahead: the "stop" record is appended (the ledger
//      is evidence — if anything later fails, the event still happened);
//   4. state.json.last_stop = { stop_state, ts, seq } citing that exact
//      record, written atomically;
//   5. handoff.md is rendered and rename-committed — a mechanical projection
//      of recorded state only: no event, no line.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { withLock, appendRecord } = require('./jsonl.js');
const { readJson, writeJson } = require('./atomic-json.js');
const { validateStop } = require('./validators.js');
const { openHolds } = require('./hold.js');
const { assertContained } = require('./contain.js');

const LEDGER_BASENAME = 'ledger.jsonl';
const STATE_BASENAME = 'state.json';
const HANDOFF_BASENAME = 'handoff.md';
const RESUME_LINE = 'Resume: claude + trust the SessionStart digest';

const MISSING_STATE = Symbol('stop.missing-state');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Atomic text write with the same temp+fsync+rename discipline
// atomic-json.js applies to JSON — here over Markdown content. Callers MUST
// have already run assertContained against this same targetPath.
function writeContainedText(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const fd = fs.openSync(tmpFile, 'wx');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpFile, targetPath);
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
}

// state.json values are interpolated one per handoff line; collapsing any
// embedded whitespace run (including newlines) to a single space keeps a
// stray multi-line value from forging extra, unattributed lines. Stop
// fields need no such treatment: validateStop already enforces single-line.
function oneLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

// Purely mechanical: every line traces to a field on the recorded stop, on
// state.json, or on holds.jsonl's open set — never invented prose. A stop
// kind without a question/earliest_resume gets no such line; a mission
// entry with no next_action gets none appended.
function renderHandoffMd(state, stop, seq, ts, openHoldsCount) {
  const lines = ['# Handoff', '', '## Last stop', ''];
  lines.push(`- Stop state: ${stop.stop_state}`);
  lines.push(`- Reporter: ${stop.reporter}`);
  lines.push(`- Recorded: ${ts} (${LEDGER_BASENAME} seq ${seq})`);
  if (isNonEmptyString(stop.question)) {
    lines.push(`- Operator question: ${stop.question}`);
  }
  if (isNonEmptyString(stop.earliest_resume)) {
    lines.push(`- Earliest resume: ${stop.earliest_resume}`);
  }

  lines.push('', '## Open missions', '');
  const missions = isPlainObject(state.missions) ? state.missions : {};
  for (const [id, mission] of Object.entries(missions)) {
    if (!isPlainObject(mission)) continue;
    // Every mission not recorded done is open work the next session must
    // see — blocked and parked ones especially.
    if (mission.status === 'done') continue;
    let line = `- ${oneLine(id)}`;
    if (isNonEmptyString(mission.status)) line += ` (${oneLine(mission.status)})`;
    if (isNonEmptyString(mission.next_action)) line += `: ${oneLine(mission.next_action)}`;
    lines.push(line);
  }

  lines.push('', `- Open holds: ${openHoldsCount}`);
  lines.push('', RESUME_LINE, '');
  return lines.join('\n');
}

// writeStop(treeRoot, stop) -> { seq, ts, stop, state } — see the header
// comment for the exact transaction order and its guarantees.
function writeStop(treeRoot, stop) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('stop: treeRoot must be a non-empty string');
  }
  const { ok, errors } = validateStop(stop);
  if (!ok) {
    throw new TypeError(`stop: invalid stop — ${errors.join('; ')}`);
  }

  const statePath = path.join(treeRoot, STATE_BASENAME);
  const ledgerPath = path.join(treeRoot, LEDGER_BASENAME);
  const handoffPath = path.join(treeRoot, HANDOFF_BASENAME);

  return withLock(statePath, () => {
    const state = readJson(statePath, MISSING_STATE);
    if (state === MISSING_STATE) {
      throw new Error(`stop: no ${STATE_BASENAME} found at ${statePath} — scaffold the tree first`);
    }
    if (!isPlainObject(state)) {
      throw new Error(`stop: state at ${statePath} must be a JSON object`);
    }

    assertContained(treeRoot, handoffPath, 'stop');

    // The open-holds count is read before the first mutation too, so a
    // holds.jsonl read failure also refuses with nothing written.
    const openHoldsCount = openHolds(treeRoot).length;

    // Ledger-first write-ahead — the transaction's first mutation.
    // appendRecord takes ledger.jsonl's own lock (a different lockfile than
    // the state.json lock this transaction holds — no reentrancy).
    const record = appendRecord(ledgerPath, {
      kind: 'stop',
      payload: stop,
      correlation_id: stop.stop_state,
    });

    // last_stop cites the recorded event's own ts and seq — the pointer
    // points at evidence, it never restates it from a second clock.
    const newState = {
      ...state,
      last_stop: { stop_state: stop.stop_state, ts: record.ts, seq: record.seq },
      updated_utc: new Date().toISOString(),
    };
    // writeJson (not updateJson): this transaction already holds
    // state.json's lock, and updateJson would try to take the same one.
    writeJson(statePath, newState);

    writeContainedText(handoffPath, renderHandoffMd(newState, stop, record.seq, record.ts, openHoldsCount));

    return { seq: record.seq, ts: record.ts, stop, state: newState };
  });
}

// --- CLI --------------------------------------------------------------------

const HELP = `stop.js — maestro stop recorder (sole writer of ledger "stop" records,
state.json.last_stop, and handoff.md)

usage: stop.js write-stop <treeRoot>   (stop JSON piped via stdin)

stdin shape (validators.js validate-stop):
  { stop_state, reporter } plus the one field its kind requires —
  BLOCKED-OPERATOR -> question, QUOTA-WAIT -> earliest_resume (ISO-8601 UTC
  "Z"); DONE, BUDGET-CEILING, EXHAUSTED carry neither. Fails closed outside
  that five-value vocabulary.

Under one state.json lock, ledger-first: appends the "stop" ledger record,
sets state.json.last_stop = { stop_state, ts, seq } citing it, then renders
handoff.md as a mechanical projection (last stop, open missions with their
next_action, open holds count, resume line) — no recorded event, no line.
Errors go to stderr with exit 1; a refusal leaves everything untouched.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (command !== 'write-stop') {
      throw new Error(
        command === undefined ? 'a command is required' : `unknown command "${command}" (expected write-stop)`
      );
    }
    if (!isNonEmptyString(treeRoot)) throw new Error('write-stop requires <treeRoot>');
    if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

    const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`stop JSON via stdin is not valid JSON: ${err.message}`);
    }
    const result = writeStop(treeRoot, parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`stop.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { writeStop, RESUME_LINE };
