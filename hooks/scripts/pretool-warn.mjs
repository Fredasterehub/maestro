#!/usr/bin/env node
// maestro PreToolUse warn-guard (Read|Bash). Warn, never block.
//
// Purpose: the liaison's context is the product — a 2,000-line file read or a
// full test-suite dump inline shortens the session and degrades every decision
// after it. This hook notices those moments and attaches a one-sentence
// reminder naming the delegation route. It deliberately emits NO
// permissionDecision: setting "allow" would auto-approve calls the user's
// permission config might otherwise gate, and this guard must never change
// permission outcomes in either direction. It only speaks.
//
// Stable reason codes (grep-able, never renamed):
//   maestro:big-read    Read of a >400-line file with no limit/offset
//   maestro:test-run    unbounded test-suite invocation
//   maestro:build-run   unbounded build invocation
//   maestro:log-dump    cat of a *.log file without head/tail bounding
//   maestro:log-follow  tail -f (unbounded by construction)
//
// Exemptions:
//   - Subagent sessions: workers are SUPPOSED to read big files and run
//     suites; warning them would be noise. Detected from the hook input's
//     agent/session indicators; when in doubt, we stay silent.
//   - Paths under .maestro/ and under the plugin itself: these are the
//     sanctioned bounded surfaces (views, envelopes, posture) the liaison is
//     meant to read directly.
//
// Fail open: any internal error -> silent allow (exit 0, no output). A broken
// guard must cost nothing.

import fs from 'node:fs';
import path from 'node:path';

const LINE_THRESHOLD = 400;
const READ_SIZE_GUARD = 2 * 1024 * 1024; // above this, don't read to count — it's big either way

function emitWarn(code, sentence) {
  const msg = `[maestro:${code}] ${sentence}`;
  process.stdout.write(JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: msg,
    },
  }));
}

function isSubagentSession(input) {
  if (input.agent_id || input.agent_type || input.agent_name) return true;
  if (input.parent_tool_use_id || input.parent_session_id) return true;
  if (input.is_subagent === true) return true;
  if (typeof input.transcript_path === 'string' && /[\\/]subagents?[\\/]/.test(input.transcript_path)) return true;
  return false;
}

function isExemptPath(resolved) {
  if (/[\\/]\.maestro[\\/]/.test(resolved)) return true;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && resolved.startsWith(pluginRoot)) return true;
  return false;
}

function checkRead(input) {
  const ti = input.tool_input || {};
  if (ti.limit != null || ti.offset != null) return; // already bounded
  if (typeof ti.file_path !== 'string' || !ti.file_path) return;

  const resolved = path.isAbsolute(ti.file_path)
    ? ti.file_path
    : path.resolve(input.cwd || process.cwd(), ti.file_path);
  if (isExemptPath(resolved)) return;

  const st = fs.statSync(resolved); // throws for missing paths -> outer catch -> silent allow
  if (!st.isFile()) return;
  if (st.size <= LINE_THRESHOLD) return; // >400 lines needs >400 bytes

  let big = false;
  let detail = '';
  if (st.size > READ_SIZE_GUARD) {
    big = true;
    detail = `${Math.round(st.size / 1024)}KB`;
  } else {
    const lineCount = fs.readFileSync(resolved, 'utf8').split('\n').length;
    if (lineCount > LINE_THRESHOLD) {
      big = true;
      detail = `${lineCount} lines`;
    }
  }
  if (big) {
    emitWarn('big-read',
      `${path.basename(resolved)} is ${detail} and this Read has no limit/offset — this belongs in a worker: dispatch scout (or the relevant executor) and read the envelope instead, or re-read a bounded slice.`);
  }
}

const TEST_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|pytest\b|cargo\s+test\b|go\s+test\b|vitest\b|jest\b|mocha\b)/;
const BUILD_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+run\s+build\b|cargo\s+build\b|go\s+build\b|make\b|gradle(?:w)?\s+build\b|mvn\b|tsc\b)/;
const LOG_CAT_RE = /\bcat\b[^|;&]*\.log\b/;
const TAIL_F_RE = /\btail\s+(?:-\S+\s+)*-\S*f\b/;
const BOUNDED_RE = /\|\s*(?:head|tail)\b/;

function checkBash(input) {
  const cmd = String((input.tool_input || {}).command || '');
  if (!cmd) return;

  // tail -f never terminates, so piping through head/tail does not tame it.
  if (TAIL_F_RE.test(cmd)) {
    emitWarn('log-follow',
      '`tail -f` streams unbounded output into liaison context — this belongs in a worker: dispatch a background worker to watch the log and report an envelope.');
    return;
  }

  if (BOUNDED_RE.test(cmd)) return; // operator already capped the output

  if (TEST_RE.test(cmd)) {
    emitWarn('test-run',
      'A full test run dumps its output into liaison context — this belongs in a worker: dispatch an executor to run it as a recorded gate and read the envelope, or bound it with `| tail -30`.');
    return;
  }
  if (BUILD_RE.test(cmd)) {
    emitWarn('build-run',
      'A full build dumps its output into liaison context — this belongs in a worker: dispatch an executor and read the envelope, or bound it with `| tail -30`.');
    return;
  }
  if (LOG_CAT_RE.test(cmd)) {
    emitWarn('log-dump',
      'cat on a log file pulls the whole log into liaison context — this belongs in a worker: dispatch scout to extract what you need and read the envelope, or bound it with `tail -n 100`.');
  }
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!isSubagentSession(input)) {
    if (input.tool_name === 'Read') checkRead(input);
    else if (input.tool_name === 'Bash') checkBash(input);
  }
} catch {
  // fail open: silent allow
}
process.exit(0);
