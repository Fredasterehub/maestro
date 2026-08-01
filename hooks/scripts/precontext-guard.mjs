#!/usr/bin/env node
// Maestro PreToolUse guard for Codex's `new_context` tool.
//
// A voluntary same-thread rollover is safe only after the current model has
// written a fresh, machine-readable continuity handoff. Missing, malformed,
// stale, or transfer-mode state is denied with a repair instruction the model
// can follow immediately. This hook is intentionally registered only for the
// explicit tool call; Codex's forced automatic compaction does not pass
// through it and can never be blocked here.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SESSION_ID_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let validateStoredState = null;
let continuityConsumptionStatus = null;
let armContinuity = null;
try {
  ({
    armContinuity,
    continuityConsumptionStatus,
    validateStoredState,
  } = require(path.resolve(scriptDir, '..', '..', 'machine', 'src', 'continuity.js')));
} catch {
  // Validation below denies the voluntary reset when this coupled module is
  // unavailable. Forced automatic compaction bypasses this guard and still has
  // the SessionStart durable-state fallback.
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deny(detail) {
  const reason = `[maestro:context-handoff-required] ${detail} Before calling new_context, run $handoff in rollover mode, verify that it wrote .maestro/continuity/handoff-state.json, then retry new_context.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function validate(state, now, treeRoot) {
  if (!isPlainObject(state)) return 'The continuity handoff is not a JSON object.';
  if (state.schema_version !== 1) return 'The continuity handoff has an unsupported schema version.';
  if (!Number.isSafeInteger(state.generation) || state.generation < 1) {
    return 'The continuity handoff has no valid generation.';
  }
  if (state.mode !== 'auto') return 'The continuity handoff is not in automatic-rollover mode.';
  if (!isPlainObject(state.mission) || typeof state.mission.objective !== 'string' || state.mission.objective.trim() === '') {
    return 'The continuity handoff has no mission objective.';
  }
  if (!Array.isArray(state.next_actions)
      || state.next_actions.length === 0
      || state.next_actions.some((action) => typeof action !== 'string' || action.trim() === '')) {
    return 'The continuity handoff has no usable next action.';
  }

  const generated = Date.parse(state.generated_at);
  if (!Number.isFinite(generated)) return 'The continuity handoff has no valid generated_at timestamp.';
  if (generated > now + MAX_FUTURE_SKEW_MS) return 'The continuity handoff timestamp is implausibly in the future.';
  if (now - generated > MAX_AGE_MS) return 'The continuity handoff is stale (older than 30 minutes).';
  if (!validateStoredState || !continuityConsumptionStatus || !armContinuity) {
    return 'The continuity machine validator is unavailable, so the handoff cannot be verified.';
  }
  const validation = validateStoredState(state);
  if (!validation.ok) return 'The continuity handoff failed schema or integrity validation.';
  let consumption;
  try {
    consumption = continuityConsumptionStatus(treeRoot);
  } catch {
    return 'The continuity consumption marker or state is unreadable, invalid, or unrecorded.';
  }
  if (!consumption.consumable) {
    if (consumption.reason === 'already-consumed') {
      return `Continuity handoff generation ${consumption.generation} has already been consumed.`;
    }
    return `Continuity handoff generation ${consumption.generation} is not consumable (${consumption.reason}).`;
  }
  return null;
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!isPlainObject(input)) {
    deny('The new_context hook input must be a plain JSON object.');
    process.exit(0);
  }
  if (typeof input.tool_name !== 'string' || input.tool_name.trim() === '') {
    deny('The new_context hook input is missing tool_name.');
    process.exit(0);
  }
  // Matcher registration should make this redundant, but avoid surprising a
  // direct invocation with a different tool name.
  if (input.tool_name !== 'new_context') process.exit(0);
  if (
    typeof input.session_id !== 'string' ||
    input.session_id.trim() === '' ||
    input.session_id.length > 256 ||
    SESSION_ID_CONTROL_RE.test(input.session_id)
  ) {
    deny('The new_context hook input requires a non-empty bounded session_id.');
    process.exit(0);
  }

  const root = input.cwd
    || process.env.CODEX_PROJECT_DIR
    || process.env.CLAUDE_PROJECT_DIR
    || process.cwd();
  const statePath = path.join(root, '.maestro', 'continuity', 'handoff-state.json');

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    const detail = err && err.code === 'ENOENT'
      ? 'No continuity handoff exists for this rollover.'
      : 'The continuity handoff is unreadable or malformed.';
    deny(detail);
    process.exit(0);
  }

  const problem = validate(state, Date.now(), path.join(root, '.maestro'));
  if (problem) {
    deny(problem);
    process.exit(0);
  }
  try {
    armContinuity(path.join(root, '.maestro'), input.session_id);
  } catch {
    deny('The continuity arm marker could not be created or verified safely.');
  }
  process.exit(0);
} catch {
  // This hook is matched only to voluntary new_context. Forced automatic
  // rollover bypasses it, so malformed integration input is not safe evidence
  // and must deny rather than silently authorizing a destructive reset.
  deny('The new_context hook input is unreadable or malformed.');
  process.exit(0);
}
