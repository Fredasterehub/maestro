'use strict';

// maestro machine layer — deterministic context-rollover continuity writer.
//
// A Codex context window is disposable; the operator's workflow is not. This
// module records the small, explicit state needed to continue that workflow
// after compaction without preserving a transcript or hidden chain of
// thought. The input contract carries facts, exact stop/next positions,
// decisions with reasons, and explicit hypotheses. The script owns all
// provenance metadata (timestamp, generation, and content digest).
//
// `write` validates the complete input before its first mutation, then holds
// state.json's normal machine lock while atomically replacing the canonical
// JSON state and its concise Markdown projection. A small ledger record is
// appended last: a context-handoff event therefore means both projections
// landed. Atomicity is per file; the state JSON is authoritative if a process
// dies between the two atomic renames.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('./atomic-json.js');
const { writeText } = require('./atomic-text.js');
const { assertContained } = require('./contain.js');
const { appendRecord, readRecords, withLock, ISO_8601_UTC_RE } = require('./jsonl.js');

const SCHEMA_VERSION = 1;
const CONTINUITY_DIR = 'continuity';
const STATE_BASENAME = 'handoff-state.json';
const HANDOFF_BASENAME = 'HANDOFF.md';
const CONSUMED_BASENAME = 'consumed.json';
const ARMED_BASENAME = 'armed.json';
const TREE_STATE_BASENAME = 'state.json';
const LEDGER_BASENAME = 'ledger.jsonl';

const INPUT_BYTE_CEILING = 65536;
const STATE_PAYLOAD_BYTE_CEILING = 32768;
const RESUME_BYTE_CEILING = 24576;
const COMPACT_CAPSULE_BYTE_CEILING = 4200;
const AUTO_HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;
const AUTO_HANDOFF_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ARM_TTL_MS = 2 * 60 * 1000;
const ARM_MAX_FUTURE_SKEW_MS = 5 * 1000;
const MODES = new Set(['auto', 'manual', 'transfer']);
const CONSUMED_KEYS = Object.freeze(['schema_version', 'generation', 'digest', 'consumed_at']);
const ARMED_KEYS = Object.freeze([
  'schema_version',
  'generation',
  'digest',
  'session_id',
  'armed_at',
  'expires_at',
]);

const INPUT_KEYS = Object.freeze([
  'mode',
  'mission',
  'operator_intent',
  'verified_evidence',
  'in_progress',
  'blockers',
  'next_actions',
  'decisions',
  'hypotheses',
  'open_threads',
  'traps',
  'key_paths',
  'commands',
  'origin',
]);
const STORED_KEYS = Object.freeze([
  'schema_version',
  'generation',
  'generated_at',
  'digest',
  ...INPUT_KEYS,
]);

const ARRAY_SPECS = Object.freeze({
  verified_evidence: { max: 16, keys: ['fact', 'source'], limits: { fact: 1200, source: 1024 } },
  in_progress: {
    max: 8,
    keys: ['item', 'exact_stop', 'exact_next'],
    limits: { item: 800, exact_stop: 1600, exact_next: 1600 },
  },
  blockers: { max: 12, keys: ['blocker', 'unblock'], limits: { blocker: 1200, unblock: 1200 } },
  next_actions: { max: 20, stringLimit: 1200 },
  decisions: { max: 16, keys: ['decision', 'reason'], limits: { decision: 1200, reason: 1600 } },
  hypotheses: {
    max: 12,
    keys: ['hypothesis', 'basis', 'next_check'],
    limits: { hypothesis: 1200, basis: 1200, next_check: 1200 },
  },
  open_threads: { max: 12, keys: ['thread', 'why'], limits: { thread: 1200, why: 1200 } },
  traps: { max: 16, stringLimit: 1200 },
  key_paths: { max: 40, stringLimit: 1024 },
  commands: {
    max: 16,
    keys: ['command', 'last_result'],
    limits: { command: 2000, last_result: 1600 },
  },
});

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SESSION_ID_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MISSING = Symbol('continuity.missing');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkExactKeys(value, expected, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be a plain object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${label} has unexpected extra key "${key}"`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${label} is missing required key "${key}"`);
    }
  }
  return true;
}

function checkString(value, label, max, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.length > max) errors.push(`${label} must be at most ${max} characters`);
  if (CONTROL_RE.test(value)) errors.push(`${label} must not contain control characters`);
}

function requireSessionId(sessionId) {
  const errors = [];
  checkString(sessionId, 'session_id', 256, errors);
  if (typeof sessionId === 'string' && SESSION_ID_CONTROL_RE.test(sessionId)) {
    errors.push('session_id must not contain control characters');
  }
  if (errors.length > 0) throw new TypeError(`continuity: invalid session_id — ${errors.join('; ')}`);
  return sessionId;
}

function checkObjectArray(value, key, spec, errors) {
  const label = `continuity field "${key}"`;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length > spec.max) errors.push(`${label} may contain at most ${spec.max} entries`);
  for (let i = 0; i < value.length; i += 1) {
    const itemLabel = `${label}[${i}]`;
    if (!checkExactKeys(value[i], spec.keys, itemLabel, errors)) continue;
    for (const field of spec.keys) {
      if (Object.prototype.hasOwnProperty.call(value[i], field)) {
        checkString(value[i][field], `${itemLabel}."${field}"`, spec.limits[field], errors);
      }
    }
  }
}

function checkStringArray(value, key, spec, errors) {
  const label = `continuity field "${key}"`;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  if (value.length > spec.max) errors.push(`${label} may contain at most ${spec.max} entries`);
  for (let i = 0; i < value.length; i += 1) {
    checkString(value[i], `${label}[${i}]`, spec.stringLimit, errors);
  }
}

// Canonical JSON is used only for the digest. Sorting every object key means
// semantically identical strict input has the same digest regardless of the
// property order used by its producer.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function inputFromStored(state) {
  const input = {};
  for (const key of INPUT_KEYS) input[key] = state[key];
  return input;
}

function validateContinuityInput(input) {
  try {
    const errors = [];
    if (!checkExactKeys(input, INPUT_KEYS, 'continuity input', errors)) {
      return { ok: false, errors };
    }

    if (Object.prototype.hasOwnProperty.call(input, 'mode')) {
      if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
        errors.push('continuity field "mode" must be one of auto, manual, transfer');
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, 'mission')) {
      if (checkExactKeys(input.mission, ['id', 'objective'], 'continuity field "mission"', errors)) {
        if (Object.prototype.hasOwnProperty.call(input.mission, 'id')) {
          checkString(input.mission.id, 'continuity field "mission"."id"', 256, errors);
        }
        if (Object.prototype.hasOwnProperty.call(input.mission, 'objective')) {
          checkString(input.mission.objective, 'continuity field "mission"."objective"', 2000, errors);
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, 'operator_intent')) {
      checkString(input.operator_intent, 'continuity field "operator_intent"', 2400, errors);
    }

    for (const [key, spec] of Object.entries(ARRAY_SPECS)) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      if (spec.stringLimit !== undefined) checkStringArray(input[key], key, spec, errors);
      else checkObjectArray(input[key], key, spec, errors);
    }

    if (Object.prototype.hasOwnProperty.call(input, 'origin')) {
      if (checkExactKeys(input.origin, ['session', 'window'], 'continuity field "origin"', errors)) {
        if (Object.prototype.hasOwnProperty.call(input.origin, 'session')) {
          checkString(input.origin.session, 'continuity field "origin"."session"', 256, errors);
        }
        if (Object.prototype.hasOwnProperty.call(input.origin, 'window')) {
          checkString(input.origin.window, 'continuity field "origin"."window"', 256, errors);
        }
      }
    }

    if (
      input.mode === 'auto' &&
      Array.isArray(input.next_actions) &&
      input.next_actions.length === 0
    ) {
      errors.push('continuity field "next_actions" must contain at least one action in auto mode');
    }

    let bytes = Infinity;
    try {
      bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
    } catch {
      errors.push('continuity input must be JSON-serializable');
    }
    if (bytes > STATE_PAYLOAD_BYTE_CEILING) {
      errors.push(
        `continuity input is ${bytes} bytes, exceeding the ${STATE_PAYLOAD_BYTE_CEILING}-byte state ceiling`
      );
    }
    return { ok: errors.length === 0, errors };
  } catch (err) {
    return { ok: false, errors: [`continuity input could not be inspected: ${err.message}`] };
  }
}

function unsignedStoredState(state) {
  const unsigned = {};
  for (const key of STORED_KEYS) {
    if (key !== 'digest') unsigned[key] = state[key];
  }
  return unsigned;
}

function validateStoredState(state) {
  const errors = [];
  if (!checkExactKeys(state, STORED_KEYS, 'stored continuity state', errors)) {
    return { ok: false, errors };
  }
  if (state.schema_version !== SCHEMA_VERSION) {
    errors.push(`stored continuity state schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(state.generation) || state.generation < 1) {
    errors.push('stored continuity state generation must be a positive safe integer');
  }
  if (typeof state.generated_at !== 'string' || !ISO_8601_UTC_RE.test(state.generated_at)) {
    errors.push('stored continuity state generated_at must be an ISO-8601 UTC timestamp');
  }
  if (typeof state.digest !== 'string' || !DIGEST_RE.test(state.digest)) {
    errors.push('stored continuity state digest must be sha256:<64 lowercase hex characters>');
  }
  const inputValidation = validateContinuityInput(inputFromStored(state));
  errors.push(...inputValidation.errors.map((error) => `stored ${error}`));
  if (errors.length === 0 && sha256(unsignedStoredState(state)) !== state.digest) {
    errors.push('stored continuity state digest does not match its content');
  }
  return { ok: errors.length === 0, errors };
}

function validateConsumptionMarker(marker) {
  const errors = [];
  if (!checkExactKeys(marker, CONSUMED_KEYS, 'continuity consumption marker', errors)) {
    return { ok: false, errors };
  }
  if (marker.schema_version !== SCHEMA_VERSION) {
    errors.push(`continuity consumption marker schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(marker.generation) || marker.generation < 1) {
    errors.push('continuity consumption marker generation must be a positive safe integer');
  }
  if (typeof marker.digest !== 'string' || !DIGEST_RE.test(marker.digest)) {
    errors.push('continuity consumption marker digest must be sha256:<64 lowercase hex characters>');
  }
  if (typeof marker.consumed_at !== 'string' || !ISO_8601_UTC_RE.test(marker.consumed_at)) {
    errors.push('continuity consumption marker consumed_at must be an ISO-8601 UTC timestamp');
  } else if (!Number.isFinite(Date.parse(marker.consumed_at))) {
    errors.push('continuity consumption marker consumed_at must name a real calendar instant');
  }
  return { ok: errors.length === 0, errors };
}

function validateArmMarker(marker) {
  const errors = [];
  if (!checkExactKeys(marker, ARMED_KEYS, 'continuity arm marker', errors)) {
    return { ok: false, errors };
  }
  if (marker.schema_version !== SCHEMA_VERSION) {
    errors.push(`continuity arm marker schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(marker.generation) || marker.generation < 1) {
    errors.push('continuity arm marker generation must be a positive safe integer');
  }
  if (typeof marker.digest !== 'string' || !DIGEST_RE.test(marker.digest)) {
    errors.push('continuity arm marker digest must be sha256:<64 lowercase hex characters>');
  }
  checkString(marker.session_id, 'continuity arm marker session_id', 256, errors);
  if (typeof marker.session_id === 'string' && SESSION_ID_CONTROL_RE.test(marker.session_id)) {
    errors.push('continuity arm marker session_id must not contain control characters');
  }
  for (const field of ['armed_at', 'expires_at']) {
    if (typeof marker[field] !== 'string' || !ISO_8601_UTC_RE.test(marker[field])) {
      errors.push(`continuity arm marker ${field} must be an ISO-8601 UTC timestamp`);
    } else if (!Number.isFinite(Date.parse(marker[field]))) {
      errors.push(`continuity arm marker ${field} must name a real calendar instant`);
    }
  }
  if (errors.length === 0) {
    const armedAt = Date.parse(marker.armed_at);
    const expiresAt = Date.parse(marker.expires_at);
    const duration = expiresAt - armedAt;
    if (duration <= 0 || duration > ARM_TTL_MS) {
      errors.push(`continuity arm marker lifetime must be greater than zero and at most ${ARM_TTL_MS}ms`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function requireRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`continuity: no ${label} at "${file}" — scaffold the tree first`);
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error(`continuity: ${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`continuity: ${label} at "${file}" must be a regular file`);
}

function requireScaffoldedTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) throw new TypeError('continuity: treeRoot must be a non-empty string');
  let stat;
  try {
    stat = fs.lstatSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`continuity: no tree at "${treeRoot}" — scaffold it first`);
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error('continuity: treeRoot must not be a symlink');
  if (!stat.isDirectory()) throw new Error(`continuity: "${treeRoot}" is not a directory`);

  const statePath = path.join(treeRoot, TREE_STATE_BASENAME);
  const ledgerPath = path.join(treeRoot, LEDGER_BASENAME);
  requireRegularFile(statePath, TREE_STATE_BASENAME);
  requireRegularFile(ledgerPath, LEDGER_BASENAME);
  assertContained(treeRoot, statePath, 'continuity');
  assertContained(treeRoot, `${statePath}.lock`, 'continuity');
  assertContained(treeRoot, ledgerPath, 'continuity');

  const treeState = readJson(statePath, MISSING);
  if (!isPlainObject(treeState) || treeState.schema_version !== 1 || !isPlainObject(treeState.missions)) {
    throw new Error(`continuity: ${TREE_STATE_BASENAME} is not a recognized scaffold state`);
  }
  const ledger = readRecords(ledgerPath);
  if (ledger.records.length === 0 || ledger.records[0].kind !== 'genesis') {
    throw new Error(`continuity: ${LEDGER_BASENAME} has no genesis record — scaffold the tree first`);
  }
  if (ledger.errors.length > 0) {
    throw new Error(`continuity: ${LEDGER_BASENAME} has ${ledger.errors.length} unparseable line(s)`);
  }
  return { statePath, ledgerPath };
}

function assertOutputPaths(treeRoot) {
  const continuityDir = path.join(treeRoot, CONTINUITY_DIR);
  const continuityStatePath = path.join(continuityDir, STATE_BASENAME);
  const handoffPath = path.join(continuityDir, HANDOFF_BASENAME);
  const consumedPath = path.join(continuityDir, CONSUMED_BASENAME);
  const armedPath = path.join(continuityDir, ARMED_BASENAME);
  assertContained(treeRoot, continuityDir, 'continuity');
  assertContained(treeRoot, continuityStatePath, 'continuity');
  assertContained(treeRoot, handoffPath, 'continuity');
  assertContained(treeRoot, consumedPath, 'continuity');
  assertContained(treeRoot, armedPath, 'continuity');
  return { continuityDir, continuityStatePath, handoffPath, consumedPath, armedPath };
}

function ensureContinuityDirectory(continuityDir) {
  let stat;
  try {
    stat = fs.lstatSync(continuityDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(continuityDir);
    return;
  }
  if (stat.isSymbolicLink()) throw new Error('continuity: continuity directory must not be a symlink');
  if (!stat.isDirectory()) throw new Error('continuity: continuity path exists and is not a directory');
}

function display(value, max = 1800) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function appendSection(lines, title, entries) {
  lines.push('', `## ${title}`, '');
  if (entries.length === 0) lines.push('- (none recorded)');
  else lines.push(...entries);
}

function boundLines(lines, maxBytes) {
  const full = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
  const marker = '(projection truncated; inspect continuity/handoff-state.json and verify its digest)';
  const kept = [];
  for (const line of lines) {
    const candidate = `${[...kept, line, '', marker].join('\n')}\n`;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    kept.push(line);
  }
  kept.push('', marker);
  return `${kept.join('\n')}\n`;
}

function renderResumePrompt(state) {
  const lines = [
    '# Codex context-rollover handoff',
    '',
    'Continue the same logical operator workflow; a context boundary is not a request to stop or open a new operator session.',
    'This is bounded recorded state, not hidden reasoning. Preserve operator intent and recorded decisions; reverify mutable evidence, hypotheses, and command results before relying on them.',
    '',
    `- Generation: ${state.generation}`,
    `- Generated: ${state.generated_at}`,
    `- Mode: ${state.mode}`,
    `- Origin: session=${display(state.origin.session, 256)} window=${display(state.origin.window, 256)}`,
    `- Integrity: ${state.digest}`,
    '- Authoritative state: continuity/handoff-state.json',
    '',
    '## Mission and operator intent',
    '',
    `- Mission: ${display(state.mission.id, 256)} — ${display(state.mission.objective)}`,
    `- Operator intent: ${display(state.operator_intent, 2400)}`,
  ];

  appendSection(lines, 'Ordered next actions', state.next_actions.map((item, i) => `${i + 1}. ${display(item)}`));
  appendSection(
    lines,
    'Exact continuation point',
    state.in_progress.flatMap((item, i) => [
      `${i + 1}. ${display(item.item)}`,
      `   - Exact stop: ${display(item.exact_stop)}`,
      `   - Exact next: ${display(item.exact_next)}`,
    ])
  );
  appendSection(
    lines,
    'Blockers',
    state.blockers.map((item) => `- ${display(item.blocker)} | unblock: ${display(item.unblock)}`)
  );
  appendSection(
    lines,
    'Decisions and reasons',
    state.decisions.map((item) => `- ${display(item.decision)} | reason: ${display(item.reason)}`)
  );
  appendSection(
    lines,
    'Verified evidence',
    state.verified_evidence.map((item) => `- ${display(item.fact)} | source: ${display(item.source)}`)
  );
  appendSection(
    lines,
    'Explicit hypotheses',
    state.hypotheses.map(
      (item) => `- ${display(item.hypothesis)} | basis: ${display(item.basis)} | next check: ${display(item.next_check)}`
    )
  );
  appendSection(
    lines,
    'Open threads',
    state.open_threads.map((item) => `- ${display(item.thread)} | why open: ${display(item.why)}`)
  );
  appendSection(lines, 'Traps', state.traps.map((item) => `- ${display(item)}`));
  appendSection(lines, 'Key paths', state.key_paths.map((item) => `- ${display(item, 1024)}`));
  appendSection(
    lines,
    'Commands and last results',
    state.commands.map((item) => `- ${display(item.command, 2000)} | last result: ${display(item.last_result)}`)
  );
  lines.push('', 'Resume from the first applicable ordered next action. Do not reconstruct or invent unrecorded reasoning.', '');
  return boundLines(lines, RESUME_BYTE_CEILING);
}

function clipUtf8(value, maxBytes) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(flat, 'utf8') <= maxBytes) return flat;
  const ellipsis = '…';
  const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8');
  let bytes = 0;
  let output = '';
  for (const character of flat) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size + ellipsisBytes > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output + ellipsis;
}

// Purpose-built compact projection for SessionStart(source=compact). Unlike
// the full manual readback, every load-bearing continuation field has a fixed
// byte allotment, so a maximal objective or operator-intent string can never
// push the first action or exact stop out of the injected prefix.
function renderCompactCapsule(state) {
  const validation = validateStoredState(state);
  if (!validation.ok) {
    throw new Error(`continuity: cannot render compact capsule from invalid state — ${validation.errors.join('; ')}`);
  }
  const active = state.in_progress[0] || null;
  const firstAction = state.next_actions[0] || '(none recorded)';
  const lines = [
    '# Maestro same-thread rollover capsule',
    '',
    `- Generation: ${state.generation}`,
    `- Integrity: ${state.digest}`,
    '- Authoritative state: continuity/handoff-state.json',
    '',
    '## Continue now',
    '',
    `- First next action: ${clipUtf8(firstAction, 700)}`,
    `- In-progress item: ${clipUtf8(active ? active.item : '(none recorded)', 300)}`,
    `- Exact stop: ${clipUtf8(active ? active.exact_stop : '(none recorded)', 600)}`,
    `- Exact next: ${clipUtf8(active ? active.exact_next : firstAction, 600)}`,
    '',
    '## Intent anchors',
    '',
    `- Mission objective: ${clipUtf8(state.mission.objective, 500)}`,
    `- Operator intent: ${clipUtf8(state.operator_intent, 650)}`,
    '',
    'Continue from the first next action. Reverify mutable evidence; do not reconstruct unrecorded reasoning.',
    '',
  ];
  const capsule = lines.join('\n');
  const bytes = Buffer.byteLength(capsule, 'utf8');
  if (bytes > COMPACT_CAPSULE_BYTE_CEILING) {
    throw new Error(
      `continuity: compact capsule is ${bytes} bytes, exceeding its ${COMPACT_CAPSULE_BYTE_CEILING}-byte ceiling`
    );
  }
  return capsule;
}

function makeStoredState(input, generation) {
  const unsigned = {
    schema_version: SCHEMA_VERSION,
    generation,
    generated_at: new Date().toISOString(),
    ...input,
  };
  return {
    schema_version: unsigned.schema_version,
    generation: unsigned.generation,
    generated_at: unsigned.generated_at,
    digest: sha256(unsigned),
    ...input,
  };
}

function writeContinuity(treeRoot, input) {
  const validation = validateContinuityInput(input);
  if (!validation.ok) {
    throw new TypeError(`continuity: invalid handoff — ${validation.errors.join('; ')}`);
  }
  const { statePath: treeStatePath, ledgerPath } = requireScaffoldedTree(treeRoot);
  assertOutputPaths(treeRoot);

  return withLock(treeStatePath, () => {
    // Recheck every mutable precondition after acquiring the shared machine
    // lock. No output directory has been created yet.
    requireScaffoldedTree(treeRoot);
    const { continuityDir, continuityStatePath, handoffPath } = assertOutputPaths(treeRoot);
    const previous = readJson(continuityStatePath, MISSING);
    let generation = 1;
    if (previous !== MISSING) {
      const previousValidation = validateStoredState(previous);
      if (!previousValidation.ok) {
        throw new Error(`continuity: existing handoff state is invalid — ${previousValidation.errors.join('; ')}`);
      }
      generation = previous.generation + 1;
      if (!Number.isSafeInteger(generation)) throw new Error('continuity: generation counter is exhausted');
    }

    const state = makeStoredState(input, generation);
    const handoff = renderResumePrompt(state);

    // First mutation. Invalid input and all precondition/containment failures
    // have already returned above without creating continuity/.
    ensureContinuityDirectory(continuityDir);
    assertOutputPaths(treeRoot);
    writeJson(continuityStatePath, state);
    writeText(handoffPath, handoff);
    const record = appendRecord(ledgerPath, {
      kind: 'context-handoff',
      payload: {
        generation: state.generation,
        digest: state.digest,
        mode: state.mode,
        mission_id: state.mission.id,
        origin_session: state.origin.session,
        origin_window: state.origin.window,
      },
      correlation_id: state.mission.id,
    });
    return {
      generation: state.generation,
      generated_at: state.generated_at,
      digest: state.digest,
      mode: state.mode,
      mission_id: state.mission.id,
      ledger_seq: record.seq,
      state_path: continuityStatePath,
      handoff_path: handoffPath,
      state,
    };
  });
}

const EMPTY_STATUS =
  '# Codex context-rollover status\n\n' +
  'No continuity handoff has been recorded. Continue from the normal bounded SessionStart state.\n';

function readContinuity(treeRoot) {
  requireScaffoldedTree(treeRoot);
  const { continuityStatePath } = assertOutputPaths(treeRoot);
  const state = readJson(continuityStatePath, MISSING);
  if (state === MISSING) return EMPTY_STATUS;
  const validation = validateStoredState(state);
  if (!validation.ok) {
    throw new Error(`continuity: stored handoff is invalid — ${validation.errors.join('; ')}`);
  }
  return renderResumePrompt(state);
}

function readConsumptionMarker(consumedPath) {
  let stat;
  try {
    stat = fs.lstatSync(consumedPath);
  } catch (err) {
    if (err.code === 'ENOENT') return MISSING;
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error('continuity: consumption marker must not be a symlink');
  if (!stat.isFile()) throw new Error('continuity: consumption marker must be a regular file');

  let marker;
  try {
    marker = readJson(consumedPath, MISSING);
  } catch (err) {
    throw new Error(`continuity: consumption marker is unreadable — ${err.message}`);
  }
  const validation = validateConsumptionMarker(marker);
  if (!validation.ok) {
    throw new Error(`continuity: consumption marker is invalid — ${validation.errors.join('; ')}`);
  }
  return marker;
}

function readArmMarker(armedPath) {
  let stat;
  try {
    stat = fs.lstatSync(armedPath);
  } catch (err) {
    if (err.code === 'ENOENT') return MISSING;
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error('continuity: arm marker must not be a symlink');
  if (!stat.isFile()) throw new Error('continuity: arm marker must be a regular file');

  let marker;
  try {
    marker = readJson(armedPath, MISSING);
  } catch (err) {
    throw new Error(`continuity: arm marker is unreadable — ${err.message}`);
  }
  const validation = validateArmMarker(marker);
  if (!validation.ok) {
    throw new Error(`continuity: arm marker is invalid — ${validation.errors.join('; ')}`);
  }
  return marker;
}

function recordedHandoffMatches(ledgerPath, generation, digest) {
  const { records, errors } = readRecords(ledgerPath);
  if (errors.length > 0) return false;
  return records.some(
    (record) =>
      record &&
      record.kind === 'context-handoff' &&
      record.generation === generation &&
      record.digest === digest
  );
}

function inspectConsumption(treeRoot, now = Date.now()) {
  const { ledgerPath } = requireScaffoldedTree(treeRoot);
  const { continuityStatePath, consumedPath } = assertOutputPaths(treeRoot);
  requireRegularFile(continuityStatePath, STATE_BASENAME);
  const state = readJson(continuityStatePath, MISSING);
  const stateValidation = validateStoredState(state);
  if (!stateValidation.ok) {
    throw new Error(`continuity: stored handoff is invalid — ${stateValidation.errors.join('; ')}`);
  }
  if (!recordedHandoffMatches(ledgerPath, state.generation, state.digest)) {
    throw new Error('continuity: stored handoff has no matching context-handoff ledger record');
  }

  const marker = readConsumptionMarker(consumedPath);
  if (marker !== MISSING) {
    if (!recordedHandoffMatches(ledgerPath, marker.generation, marker.digest)) {
      throw new Error('continuity: consumption marker does not match a recorded handoff generation');
    }
    if (marker.generation > state.generation) {
      throw new Error('continuity: consumption marker generation is ahead of the current handoff');
    }
    if (marker.generation === state.generation) {
      if (marker.digest !== state.digest) {
        throw new Error('continuity: consumption marker conflicts with the current handoff digest');
      }
      return {
        consumable: false,
        reason: 'already-consumed',
        generation: state.generation,
        digest: state.digest,
        consumed_generation: marker.generation,
        state,
        marker,
      };
    }
  }

  let reason = 'ready';
  if (state.mode !== 'auto') {
    reason = 'wrong-mode';
  } else {
    const generated = Date.parse(state.generated_at);
    const age = now - generated;
    if (!Number.isFinite(generated)) reason = 'invalid-time';
    else if (age < -AUTO_HANDOFF_MAX_FUTURE_SKEW_MS) reason = 'future';
    else if (age > AUTO_HANDOFF_MAX_AGE_MS) reason = 'stale';
  }

  return {
    consumable: reason === 'ready',
    reason,
    generation: state.generation,
    digest: state.digest,
    consumed_generation: marker === MISSING ? null : marker.generation,
    state,
    marker: marker === MISSING ? null : marker,
  };
}

function continuityConsumptionStatus(treeRoot) {
  const snapshot = inspectConsumption(treeRoot);
  return {
    consumable: snapshot.consumable,
    reason: snapshot.reason,
    generation: snapshot.generation,
    digest: snapshot.digest,
    consumed_generation: snapshot.consumed_generation,
  };
}

function armProblem(marker, state, sessionId, now = Date.now()) {
  if (marker === MISSING) return 'is not armed by PreToolUse(new_context)';
  if (marker.generation !== state.generation || marker.digest !== state.digest) {
    return 'has an arm marker for a different generation or digest';
  }
  if (marker.session_id !== sessionId) return 'has an arm marker for a different Codex session_id';
  const armedAt = Date.parse(marker.armed_at);
  const expiresAt = Date.parse(marker.expires_at);
  if (armedAt > now + ARM_MAX_FUTURE_SKEW_MS) return 'has an arm marker timestamp too far in the future';
  if (now > expiresAt) return 'has an expired arm marker';
  return null;
}

function armContinuity(treeRoot, sessionId) {
  requireSessionId(sessionId);
  const { statePath: treeStatePath } = requireScaffoldedTree(treeRoot);
  assertOutputPaths(treeRoot);

  return withLock(treeStatePath, () => {
    const snapshot = inspectConsumption(treeRoot);
    if (!snapshot.consumable) {
      throw new Error(
        `continuity: handoff generation ${snapshot.generation} cannot be armed (${snapshot.reason})`
      );
    }

    const { armedPath } = assertOutputPaths(treeRoot);
    // A malformed/symlink arm is never overwritten silently. A prior valid
    // arm may be refreshed for the current generation after validation.
    const previousArm = readArmMarker(armedPath);
    const now = Date.now();
    if (
      previousArm !== MISSING &&
      armProblem(previousArm, snapshot.state, previousArm.session_id, now) === null &&
      previousArm.session_id !== sessionId
    ) {
      throw new Error('continuity: current handoff is already armed for a different Codex session_id');
    }
    const marker = {
      schema_version: SCHEMA_VERSION,
      generation: snapshot.state.generation,
      digest: snapshot.state.digest,
      session_id: sessionId,
      armed_at: new Date(now).toISOString(),
      expires_at: new Date(now + ARM_TTL_MS).toISOString(),
    };
    writeJson(armedPath, marker);
    const persisted = readArmMarker(armedPath);
    if (
      persisted === MISSING ||
      persisted.generation !== marker.generation ||
      persisted.digest !== marker.digest ||
      persisted.session_id !== marker.session_id ||
      persisted.armed_at !== marker.armed_at ||
      persisted.expires_at !== marker.expires_at
    ) {
      throw new Error('continuity: arm marker verification failed after atomic write');
    }
    return marker;
  });
}

function consumeContinuity(treeRoot, sessionId) {
  requireSessionId(sessionId);
  const { statePath: treeStatePath } = requireScaffoldedTree(treeRoot);
  assertOutputPaths(treeRoot);

  return withLock(treeStatePath, () => {
    const snapshot = inspectConsumption(treeRoot);
    if (!snapshot.consumable) {
      const descriptions = {
        'already-consumed': 'has already been consumed',
        'wrong-mode': 'is not an automatic-rollover handoff',
        'invalid-time': 'has an invalid generated_at timestamp',
        future: 'has a generated_at timestamp too far in the future',
        stale: 'is older than the 30-minute automatic-rollover limit',
      };
      throw new Error(
        `continuity: handoff generation ${snapshot.generation} ${descriptions[snapshot.reason] || 'is not consumable'}`
      );
    }

    const { consumedPath, armedPath } = assertOutputPaths(treeRoot);
    const arm = readArmMarker(armedPath);
    const armFailure = armProblem(arm, snapshot.state, sessionId);
    if (armFailure) {
      throw new Error(`continuity: handoff generation ${snapshot.generation} ${armFailure}`);
    }
    const capsule = renderCompactCapsule(snapshot.state);
    const marker = {
      schema_version: SCHEMA_VERSION,
      generation: snapshot.state.generation,
      digest: snapshot.state.digest,
      consumed_at: new Date().toISOString(),
    };
    writeJson(consumedPath, marker);
    const persisted = readConsumptionMarker(consumedPath);
    if (
      persisted === MISSING ||
      persisted.generation !== marker.generation ||
      persisted.digest !== marker.digest ||
      persisted.consumed_at !== marker.consumed_at
    ) {
      throw new Error('continuity: consumption marker verification failed after atomic write');
    }
    fs.rmSync(armedPath);
    try {
      fs.lstatSync(armedPath);
      throw new Error('continuity: arm marker still exists after retirement');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return {
      marker,
      capsule,
    };
  });
}

// --- CLI --------------------------------------------------------------------

const HELP = `continuity.js — Codex context-rollover handoff state machine

usage: continuity.js write <treeRoot>   (strict handoff JSON via stdin)
       continuity.js read <treeRoot>
       continuity.js consume <treeRoot> <session_id>

write input (all keys required; arrays may be empty except next_actions in
automatic mode; no extra keys):
  {
    mode: "auto" | "manual" | "transfer",
    mission: { id, objective },
    operator_intent,
    verified_evidence: [{ fact, source }],
    in_progress: [{ item, exact_stop, exact_next }],
    blockers: [{ blocker, unblock }],
    next_actions: [string],
    decisions: [{ decision, reason }],
    hypotheses: [{ hypothesis, basis, next_check }],
    open_threads: [{ thread, why }],
    traps: [string],
    key_paths: [string],
    commands: [{ command, last_result }],
    origin: { session, window }
  }

Automatic context-compaction rollover uses mode "auto". Modes "manual" and
"transfer" are reserved for deliberate operator/skill handoffs.

The script assigns schema_version, generation, generated_at, and a SHA-256
digest. It atomically replaces continuity/handoff-state.json and HANDOFF.md,
then appends a small context-handoff ledger record. Input is capped at
${STATE_PAYLOAD_BYTE_CEILING} serialized bytes. Transcript, analysis, and
hidden-chain-of-thought fields are not accepted; record decision reasons and
explicit hypotheses instead.

read verifies the state digest and prints a mechanical resume prompt capped
at ${RESUME_BYTE_CEILING} bytes. When no handoff exists it prints a bounded
status instead. The tree must already have been scaffolded.

consume is the one-time automatic-rollover claim. Under the same state.json
lock used by write, it validates the current handoff and the prior consumption
marker, requires a fresh generation-, digest-, and Codex-session-bound
continuity/armed.json written by PreToolUse(new_context), atomically writes
continuity/consumed.json, retires the arm, and prints a purpose-built capsule capped at
${COMPACT_CAPSULE_BYTE_CEILING} bytes. It refuses unarmed, manual, transfer,
stale, already-consumed, corrupt, or unrecorded handoffs. Forced/ordinary
compaction bypasses arming and therefore cannot consume or replay a capsule.
Writing and arming the next valid generation makes that generation consumable.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (command !== 'write' && command !== 'read' && command !== 'consume') {
      throw new Error(
        command === undefined
          ? 'a command is required'
          : `unknown command "${command}" (expected write, read, or consume)`
      );
    }
    if (!isNonEmptyString(treeRoot)) throw new Error(`${command} requires <treeRoot>`);

    if (command === 'consume') {
      if (rest.length !== 1) throw new Error('consume requires exactly one <session_id> argument');
      process.stdout.write(consumeContinuity(treeRoot, rest[0]).capsule);
      return;
    }
    if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

    if (command === 'read') {
      process.stdout.write(readContinuity(treeRoot));
      return;
    }
    const text = fs.readFileSync(0, 'utf8');
    const inputBytes = Buffer.byteLength(text, 'utf8');
    if (inputBytes > INPUT_BYTE_CEILING) {
      throw new Error(`handoff JSON via stdin exceeds the ${INPUT_BYTE_CEILING}-byte input ceiling`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`handoff JSON via stdin is not valid JSON: ${err.message}`);
    }
    const result = writeContinuity(treeRoot, parsed);
    const { state: _state, ...summary } = result;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`continuity.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  ARM_TTL_MS,
  AUTO_HANDOFF_MAX_AGE_MS,
  COMPACT_CAPSULE_BYTE_CEILING,
  INPUT_KEYS,
  RESUME_BYTE_CEILING,
  STATE_PAYLOAD_BYTE_CEILING,
  armContinuity,
  consumeContinuity,
  continuityConsumptionStatus,
  readContinuity,
  renderCompactCapsule,
  renderResumePrompt,
  validateArmMarker,
  validateConsumptionMarker,
  validateContinuityInput,
  validateStoredState,
  writeContinuity,
};
