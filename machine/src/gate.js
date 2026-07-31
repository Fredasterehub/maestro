'use strict';

// maestro machine layer — gate execution + honesty audit CLI.
//
// Sole sanctioned writer of ledger.jsonl kind "gate" — the ONLY way "it
// passed" evidence comes to exist. run-gate actually executes the command
// and records the exit code the process really returned; a caller can never
// hand-author a pass, and a non-zero exit is recorded just as faithfully as
// a zero. check-honesty then answers "does real evidence back this gate?"
// from the ledger alone, latest-by-seq, so a stale success can never paper
// over a later failure.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');
const { readJson } = require('./atomic-json.js');
const { assertContained } = require('./contain.js');

const LOG_TAIL_LINES = 20;

// Same shape as mission.js: ids become path segments under missions/.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSegment(value) {
  return typeof value === 'string' && SEGMENT_RE.test(value);
}

function ledgerPathOf(treeRoot) {
  return path.join(treeRoot, 'ledger.jsonl');
}

function missionDirOf(treeRoot, missionId) {
  return path.join(treeRoot, 'missions', missionId);
}

// mission.js's open-status guard, applied to this stream's writer too: a
// closed mission's evidence stream accepts no new gate records, so the
// immutability mission.js promises holds across every ledger writer.
function requireOpenInState(treeRoot, missionId) {
  const statePath = path.join(treeRoot, 'state.json');
  const state = readJson(statePath, undefined);
  if (!isPlainObject(state) || !isPlainObject(state.missions)) {
    throw new Error(`gate: ${statePath} is missing or malformed — mission.js open records missions there`);
  }
  const entry = state.missions[missionId];
  if (!isPlainObject(entry)) {
    throw new Error(`gate: no such mission "${missionId}" in ${statePath} (mission.js open first)`);
  }
  if (entry.status !== 'open') {
    throw new Error(
      `gate: mission "${missionId}" has status "${entry.status}" — a closed mission's evidence stream accepts no new gate records`
    );
  }
}

// Atomic text replacement, mirroring atomic-json.js's temp+fsync+rename
// (that module is JSON-only, and the gate log is plain text): a reader never
// observes a torn log, and the unpredictable 'wx' temp name closes the
// planted-symlink and shared-pid holes the same way.
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const fd = fs.openSync(tmpFile, 'wx');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpFile, file);
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
}

function tailLines(text, count) {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count);
}

// --- run-gate ----------------------------------------------------------------

function runGate(treeRoot, missionId, gateId, cmd) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`gate: missionId must match ${SEGMENT_RE}`);
  }
  if (!isSafeSegment(gateId)) {
    throw new TypeError(`gate: gateId must match ${SEGMENT_RE} (got ${JSON.stringify(gateId)})`);
  }
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== 'string' || a === '')) {
    throw new TypeError('gate: cmd must be a non-empty argv array of non-empty strings');
  }
  const missionDir = missionDirOf(treeRoot, missionId);
  if (!fs.existsSync(missionDir)) {
    throw new Error(`gate: no such mission "${missionId}" — ${missionDir} does not exist (mission.js open first)`);
  }
  const logPath = path.join(missionDir, 'artifacts', `gate-${gateId}.log`);
  // Both refusals land before the command runs: a closed mission's stream
  // stays immutable, and a planted symlink can't aim the log outside the tree.
  requireOpenInState(treeRoot, missionId);
  assertContained(treeRoot, logPath, 'gate');

  // No shell: the argv is executed exactly as given, so the recorded cmd and
  // the executed one can never diverge through quoting or interpolation.
  const outcome = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  // A spawn failure or signal kill leaves status null; either way the gate
  // did not pass, so it is honestly recorded as exit 1 with the reason in
  // the log — never silently dropped, never zero.
  const exitCode = typeof outcome.status === 'number' ? outcome.status : 1;

  const combined = (outcome.stdout || '') + (outcome.stderr || '');
  const tail = tailLines(combined, LOG_TAIL_LINES);
  const logLines = [
    `gate_id: ${gateId}`,
    `mission_id: ${missionId}`,
    `cmd: ${JSON.stringify(cmd)}`,
    `exit_code: ${exitCode}`,
  ];
  if (outcome.error) logLines.push(`spawn_error: ${outcome.error.message}`);
  if (outcome.signal) logLines.push(`signal: ${outcome.signal}`);
  logLines.push(`--- last ${LOG_TAIL_LINES} output lines ---`, ...tail);

  // Recording runs under state.json's own lock, with the open-status re-read
  // inside it: a close that lands while the command was running wins, and no
  // gate record can slip in after mission-close. Lock order (state → ledger)
  // matches every other writer, so the two can never deadlock.
  const statePath = path.join(treeRoot, 'state.json');
  const seq = withLock(statePath, () => {
    requireOpenInState(treeRoot, missionId);
    writeTextAtomic(logPath, logLines.join('\n') + '\n');
    return appendRecord(ledgerPathOf(treeRoot), {
      kind: 'gate',
      payload: { gate_id: gateId, cmd, exit_code: exitCode, mission_id: missionId },
      correlation_id: missionId,
    }).seq;
  });

  return { gate_id: gateId, mission_id: missionId, cmd, exit_code: exitCode, ledger_seq: seq, log: logPath };
}

// --- check-honesty -----------------------------------------------------------

function checkHonesty(treeRoot, missionId, gateId) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`gate: missionId must match ${SEGMENT_RE}`);
  }
  if (!isSafeSegment(gateId)) {
    throw new TypeError(`gate: gateId must match ${SEGMENT_RE}`);
  }
  const ledgerPath = ledgerPathOf(treeRoot);
  const { records, errors } = readRecords(ledgerPath);
  // Fail closed on a stream that cannot be trusted end to end: a verdict
  // computed over a partially-readable ledger is not a verdict.
  if (errors.length > 0) {
    const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
    return {
      ok: false,
      gate_id: gateId,
      mission_id: missionId,
      reason: `ledger has malformed record(s): ${detail}`,
    };
  }

  let latest = null;
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    if (record.kind !== 'gate') continue;
    if (record.gate_id !== gateId || record.mission_id !== missionId) continue;
    // A record without a well-formed seq cannot establish "latest" and
    // cannot serve as evidence.
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    if (latest === null || record.seq > latest.seq) latest = record;
  }

  if (latest === null) {
    return {
      ok: false,
      gate_id: gateId,
      mission_id: missionId,
      reason: `no gate record for gate_id "${gateId}" and mission "${missionId}" in ${ledgerPath}`,
    };
  }
  if (latest.exit_code !== 0) {
    return {
      ok: false,
      gate_id: gateId,
      mission_id: missionId,
      seq: latest.seq,
      exit_code: latest.exit_code,
      reason: `latest gate record (seq ${latest.seq}) has exit_code ${JSON.stringify(latest.exit_code)}`,
    };
  }
  return { ok: true, gate_id: gateId, mission_id: missionId, seq: latest.seq, exit_code: 0, cmd: latest.cmd };
}

// --- CLI ---------------------------------------------------------------------

const HELP = `gate.js — maestro gate runner + honesty audit (sole writer of ledger kind "gate")

usage:
  gate.js run-gate <treeRoot> <missionId> <gateId> -- <cmd> [args...]
      Executes the command (no shell, argv as given), writes the exit code
      and the last ${LOG_TAIL_LINES} output lines to
      missions/<id>/artifacts/gate-<gateId>.log, and appends ledger kind
      "gate" { gate_id, cmd, exit_code, mission_id } — recorded honestly on
      non-zero exits too. The only producer of pass evidence: mission.js
      close and check-honesty both trust nothing else. REFUSES a mission
      whose state.json status is not "open" (a closed mission's evidence
      stream is immutable) and a log path that is or crosses a symlink out
      of the tree. Exits 0 once the record is written (the gate's own exit
      code is in the output JSON), 1 when nothing could be recorded.
  gate.js check-honesty <treeRoot> <missionId> <gateId>
      Reads ledger.jsonl and verdicts whether the latest-by-seq gate record
      for this mission+gate exists with exit_code 0. Prints the verdict JSON
      and exits 0 when honest evidence backs the gate, 1 otherwise.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, ...rest] = argv;

  if (command === 'run-gate') {
    // Fail-closed argv parsing: exactly three positionals, then a literal
    // "--", then the command argv — anything else is a refusal.
    const sep = rest.indexOf('--');
    if (sep !== 3 || rest.length < 5) {
      process.stderr.write(`gate.js: run-gate requires <treeRoot> <missionId> <gateId> -- <cmd> [args...]\n${HELP}`);
      process.exit(1);
    }
    const [treeRoot, missionId, gateId] = rest;
    const cmd = rest.slice(sep + 1);
    try {
      const result = runGate(treeRoot, missionId, gateId, cmd);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`gate.js: ${err.message}\n`);
      process.exit(1);
    }
  }

  if (command === 'check-honesty') {
    if (rest.length !== 3) {
      process.stderr.write(`gate.js: check-honesty requires <treeRoot> <missionId> <gateId>\n${HELP}`);
      process.exit(1);
    }
    try {
      const verdict = checkHonesty(rest[0], rest[1], rest[2]);
      process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
      process.exit(verdict.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`gate.js: ${err.message}\n`);
      process.exit(1);
    }
  }

  process.stderr.write(
    `gate.js: ${command === undefined ? 'a command is required' : `unknown command "${command}"`}\n${HELP}`
  );
  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { runGate, checkHonesty, LOG_TAIL_LINES };
