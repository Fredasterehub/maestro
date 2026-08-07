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
//
// It also owns the canonical artifact identity (§7): `artifactIdentity` is
// the one helper that computes {source_head, source_tree, patch_digest,
// dirty} for a worktree, and route.js validates that same object into review
// routes. Computation lives here because this is the module that already
// observes reality by running processes, and because the identity must
// travel with the evidence — the gate records the identity it tested and
// re-computes it afterwards, so a gate that mutated the tree it was testing
// becomes a recorded fact instead of a silent one.

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

// --- canonical artifact identity (§7) ----------------------------------------

// The four fields, in the order §7 writes them. route.js validates this same
// object; there is exactly one place that computes it.
const IDENTITY_FIELDS = ['source_head', 'source_tree', 'patch_digest', 'dirty'];

// The branch the work will land on, tried in order. The patch is taken against
// the merge base with the first one that exists, so every computation of this
// identity — author, gate, review, landing — takes it against the same point.
const BASE_BRANCH_CANDIDATES = ['main', 'master'];

// CANONICAL PATCH. `git diff` with every formatting knob pinned on the command
// line, so that nothing outside the content can move the digest:
//   --no-color, --no-ext-diff, --no-textconv  no colouring, no user diff driver
//   --full-index (implied by --binary, stated anyway)  whole blob object ids,
//       so the digest is derived from object content rather than from whatever
//       core.abbrev happens to be in this repository
//   --no-renames            rename detection is a similarity heuristic, not content
//   --diff-algorithm=myers, -U3, explicit a/ b/ prefixes  pin the hunk layout
//       that diff.algorithm, diff.context and diff.mnemonicPrefix would
//       otherwise vary per user
// git patch-id is deliberately NOT used as this digest: it normalises
// whitespace and hunk offsets away, which makes it the right tool for proving
// a squash landed an equivalent change (§7) and the wrong one for identity —
// a whitespace-only edit is a real content change and must move this digest.
const PATCH_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--full-index',
  '--binary',
  '--no-renames',
  '--diff-algorithm=myers',
  '-U3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// An inherited GIT_DIR (or friends) would silently aim git at a different
// repository than the path we were asked about, so the identity is computed
// with those out of the environment.
function gitEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) {
    delete env[key];
  }
  return env;
}

function git(worktree, args, input) {
  return spawnSync('git', ['--no-optional-locks', '-C', worktree, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input: input === undefined ? '' : input,
    env: gitEnv(),
  });
}

function gitOut(worktree, args, what, input) {
  const outcome = git(worktree, args, input);
  if (outcome.error) {
    throw new Error(`gate: could not run git in "${worktree}" (${what}): ${outcome.error.message}`);
  }
  if (outcome.status !== 0) {
    const detail = (outcome.stderr || '').trim().split('\n')[0] || `exit ${outcome.status}`;
    throw new Error(`gate: git ${args[0]} failed in "${worktree}" (${what}): ${detail}`);
  }
  return outcome.stdout.trim();
}

// A real Git worktree or nothing: there is no plain-directory fallback, because
// an identity computed from a directory that git does not track is not an
// identity of anything.
function requireWorktree(worktree) {
  if (typeof worktree !== 'string' || worktree.trim() === '') {
    throw new TypeError('gate: worktree must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(worktree);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`gate: no such worktree "${worktree}"`);
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`gate: "${worktree}" is not a directory`);
  }
  if (git(worktree, ['rev-parse', '--show-toplevel']).status !== 0) {
    throw new Error(`gate: "${worktree}" is not a git worktree — an artifact identity needs a real git context`);
  }
}

function mergeBaseOf(worktree) {
  for (const branch of BASE_BRANCH_CANDIDATES) {
    const outcome = git(worktree, ['merge-base', 'HEAD', branch]);
    if (outcome.status === 0) {
      const oid = outcome.stdout.trim();
      if (oid !== '') return oid;
    }
  }
  // No landing branch in this repository yet: the whole tree is the change, so
  // the patch is taken against the empty tree (asked of git, since its object
  // id differs between sha1 and sha256 repositories).
  return gitOut(worktree, ['hash-object', '-t', 'tree', '--stdin'], 'empty tree id', '');
}

// artifactIdentity(worktree, baseRef?) -> the §7 identity object.
//
// source_head and source_tree are what HEAD is; patch_digest is the committed
// content measured against the merge base; dirty says whether the worktree
// holds anything HEAD does not. A dirty worktree is REPORTED, never cleaned and
// never ignored — the review-route schema is what refuses to judge one.
function artifactIdentity(worktree, baseRef) {
  requireWorktree(worktree);
  const head = gitOut(worktree, ['rev-parse', 'HEAD'], 'source_head');
  const tree = gitOut(worktree, ['rev-parse', 'HEAD^{tree}'], 'source_tree');
  const base =
    baseRef === undefined || baseRef === null
      ? mergeBaseOf(worktree)
      : gitOut(worktree, ['rev-parse', `${baseRef}^{commit}`], 'base ref');
  const patch = gitOut(worktree, [...PATCH_ARGS, base, head], 'canonical patch');
  const status = gitOut(worktree, ['status', '--porcelain'], 'worktree status');

  return {
    source_head: head,
    source_tree: tree,
    patch_digest: 'sha256:' + crypto.createHash('sha256').update(patch, 'utf8').digest('hex'),
    dirty: status !== '',
  };
}

// Field by field, and only like against like: a patch digest is never compared
// with a commit sha, because the two are different kinds of fact.
function identityDiff(before, after) {
  const changed = [];
  for (const field of IDENTITY_FIELDS) {
    if (before[field] !== after[field]) changed.push({ field, before: before[field], after: after[field] });
  }
  return changed;
}

// --- run-gate ----------------------------------------------------------------

// The identity is evidence, not a precondition: a worktree we were not asked
// about and that git cannot identify records as an absent identity with the
// reason, so the gate still runs and still records its exit code honestly.
function identityOf(worktree) {
  try {
    return { identity: artifactIdentity(worktree), error: null };
  } catch (err) {
    return { identity: null, error: err.message };
  }
}

function identityCheckOf(before, after) {
  if (before.error !== null) return { verified: null, changed: null, error: before.error };
  if (after.error !== null) return { verified: null, changed: null, error: after.error };
  const changed = identityDiff(before.identity, after.identity);
  return { verified: changed.length === 0, changed, error: null };
}

function runGate(treeRoot, missionId, gateId, cmd, options) {
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
  // The tree the gate tests is the tree the command runs in — naming one and
  // running in another is exactly the mismatch this identity exists to catch.
  const named = options !== undefined && options !== null && options.worktree !== undefined && options.worktree !== null;
  const worktree = named ? options.worktree : process.cwd();
  // Every refusal lands before the command runs: a closed mission's stream
  // stays immutable, a planted symlink can't aim the log outside the tree, and
  // a worktree named by the caller must be one.
  if (named) requireWorktree(worktree);
  requireOpenInState(treeRoot, missionId);
  assertContained(treeRoot, logPath, 'gate');

  const before = identityOf(worktree);
  // No shell: the argv is executed exactly as given, so the recorded cmd and
  // the executed one can never diverge through quoting or interpolation.
  const outcome = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', cwd: worktree });
  const identityCheck = identityCheckOf(before, identityOf(worktree));
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
  if (before.identity === null) {
    logLines.push(`artifact_identity: unavailable — ${before.error}`);
  } else {
    for (const field of IDENTITY_FIELDS) logLines.push(`${field}: ${before.identity[field]}`);
  }
  if (identityCheck.verified === false) {
    logLines.push(`identity_mutation: ${JSON.stringify(identityCheck.changed)}`);
  } else if (identityCheck.verified === null && before.identity !== null) {
    logLines.push(`identity_unverified: ${identityCheck.error}`);
  }
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
      payload: {
        gate_id: gateId,
        cmd,
        exit_code: exitCode,
        mission_id: missionId,
        // The identity that was tested — the pre-gate one — and what became of
        // it across the run.
        artifact_identity: before.identity,
        identity_check: identityCheck,
      },
      correlation_id: missionId,
    }).seq;
  });

  return {
    gate_id: gateId,
    mission_id: missionId,
    cmd,
    exit_code: exitCode,
    artifact_identity: before.identity,
    identity_check: identityCheck,
    ledger_seq: seq,
    log: logPath,
  };
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
  // A pass produced by a gate that changed the artifact under it does not
  // describe the artifact anyone will land. Only an explicit false refuses:
  // a record from before identities were carried claims nothing either way.
  const check = latest.identity_check;
  if (isPlainObject(check) && check.verified === false) {
    const fields = Array.isArray(check.changed) ? check.changed.map((c) => c.field).join(', ') : 'unknown field(s)';
    return {
      ok: false,
      gate_id: gateId,
      mission_id: missionId,
      seq: latest.seq,
      exit_code: latest.exit_code,
      reason: `gate record (seq ${latest.seq}) mutated the tree it tested (${fields} changed across the run) — such a pass is not evidence for the artifact it named`,
    };
  }
  return {
    ok: true,
    gate_id: gateId,
    mission_id: missionId,
    seq: latest.seq,
    exit_code: 0,
    cmd: latest.cmd,
    artifact_identity: latest.artifact_identity === undefined ? null : latest.artifact_identity,
  };
}

// --- CLI ---------------------------------------------------------------------

const HELP = `gate.js — maestro gate runner + honesty audit (sole writer of ledger kind "gate")

usage:
  gate.js run-gate [--worktree <path>] <treeRoot> <missionId> <gateId> -- <cmd> [args...]
      Executes the command (no shell, argv as given) in the worktree, writes
      the exit code, the artifact identity and the last ${LOG_TAIL_LINES} output lines
      to missions/<id>/artifacts/gate-<gateId>.log, and appends ledger kind
      "gate" { gate_id, cmd, exit_code, mission_id, artifact_identity,
      identity_check } — recorded honestly on non-zero exits too. The only
      producer of pass evidence: mission.js close and check-honesty both
      trust nothing else. --worktree defaults to the current directory and
      is both where the command runs and what the recorded identity
      describes; the identity is re-computed afterwards, so a gate that
      mutated the tree it tested is recorded as such (identity_check
      { verified, changed, error }) instead of passing quietly. Outside a
      git worktree the identity records as null with the reason, and the
      gate still runs. REFUSES a mission whose state.json status is not
      "open" (a closed mission's evidence stream is immutable), a
      --worktree that is not a git worktree, and a log path that is or
      crosses a symlink out of the tree. Exits 0 once the record is written
      (the gate's own exit code is in the output JSON), 1 when nothing could
      be recorded.
  gate.js check-honesty <treeRoot> <missionId> <gateId>
      Reads ledger.jsonl and verdicts whether the latest-by-seq gate record
      for this mission+gate exists with exit_code 0 and did not mutate the
      tree it tested. Prints the verdict JSON and exits 0 when honest
      evidence backs the gate, 1 otherwise.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, ...rest] = argv;

  if (command === 'run-gate') {
    // Fail-closed argv parsing: an optional leading --worktree <path>, then
    // exactly three positionals, then a literal "--", then the command argv —
    // anything else is a refusal.
    let args = rest;
    let worktree;
    if (args[0] === '--worktree') {
      if (args.length < 2 || args[1] === '--') {
        process.stderr.write(`gate.js: --worktree requires a path\n${HELP}`);
        process.exit(1);
      }
      worktree = args[1];
      args = args.slice(2);
    }
    const sep = args.indexOf('--');
    if (sep !== 3 || args.length < 5) {
      process.stderr.write(
        `gate.js: run-gate requires [--worktree <path>] <treeRoot> <missionId> <gateId> -- <cmd> [args...]\n${HELP}`
      );
      process.exit(1);
    }
    const [treeRoot, missionId, gateId] = args;
    const cmd = args.slice(sep + 1);
    try {
      const result = runGate(treeRoot, missionId, gateId, cmd, { worktree });
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

module.exports = { runGate, checkHonesty, artifactIdentity, IDENTITY_FIELDS, LOG_TAIL_LINES };
