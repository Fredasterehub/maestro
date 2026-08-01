#!/usr/bin/env node
// maestro Stop guard: no turn ends blind.
//
// Purpose: the supervision loop runs on task notifications, but a notification
// only helps if the liaison ended its turn knowing what is in flight. A turn
// that ends while roster.json still lists alive seats — and whose final message
// shows no supervision path (no acknowledgment of the running work, no
// reconciliation, no recorded stop) — strands those workers: their results
// arrive into a session that has forgotten they exist. This guard blocks that
// specific ending and names what is in flight, so the model can close the loop
// before stopping.
//
// Bounded, never absolute: a persistent budget (.maestro/.stop-guard-budget,
// starts at 3) decrements on each block and resets whenever the guard condition
// is clean (no alive seats, or supervision visible). When the budget is
// exhausted the guard allows the stop with a visible degraded-mode message —
// a guard that can wedge a session is worse than the blindness it prevents.
//
// Loop safety (per the Stop hook docs): when the input carries
// stop_hook_active, this stop follows a stop-hook continuation — blocking again
// would loop the model forever, so the guard always allows it (without
// resetting the budget, since the condition was not verified clean).
//
// Fail open on any error: missing/unreadable state, transcript, or budget file
// -> allow. Only main-session stops reach this hook (subagents fire
// SubagentStop, which is not registered).

import fs from 'node:fs';
import path from 'node:path';

const BUDGET_START = 3;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_TAIL_LINES = 200;

// Signals that the final assistant message keeps a supervision path alive:
// either it talks about the in-flight work in supervising terms, or its last
// actions were fleet-facing tool calls.
const SUPERVISION_TEXT_RE = new RegExp(
  [
    'task notification', 'in flight', 'in-flight', 'still running',
    'running in the background', 'background (?:task|worker|subagent|agent)',
    'monitor', 'supervis', 'await', 'watching', 'reconcil',
    'will (?:pick|resume|report|check|merge|review)',
    'when (?:it|they|the worker|the task)s? (?:finish|complete|report)',
    'envelope', 'fleet-medic', 'recorded (?:a )?stop', 'stop writer',
  ].join('|'),
  'i',
);
const SUPERVISION_TOOLS = new Set(['Monitor', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'SendMessage', 'Task']);

function budgetPath(root) {
  return path.join(root, '.maestro', '.stop-guard-budget');
}

function readBudget(root) {
  try {
    const n = parseInt(fs.readFileSync(budgetPath(root), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : BUDGET_START;
  } catch {
    return BUDGET_START;
  }
}

function writeBudget(root, n) {
  try { fs.writeFileSync(budgetPath(root), String(n) + '\n'); } catch { /* non-fatal */ }
}

function rosterAliveSeats(root) {
  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(path.join(root, '.maestro', 'roster.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!roster || typeof roster !== 'object') return [];
  let entries = Array.isArray(roster) ? roster
    : Array.isArray(roster.entries) ? roster.entries
    : Array.isArray(roster.seats) ? roster.seats
    : Array.isArray(roster.workers) ? roster.workers
    : Object.values(roster);
  return entries.filter((e) => e && typeof e === 'object' && String(e.status || '') === 'alive');
}

// Returns true when the transcript's last assistant message shows a live
// supervision path — and also true when the transcript cannot be judged at
// all (fail open: never block on evidence we could not read).
function supervisionVisible(input) {
  try {
    // Codex exposes the stable final text directly. Prefer it over parsing the
    // transcript, whose format the hook contract explicitly marks unstable.
    if (typeof input.last_assistant_message === 'string') {
      return SUPERVISION_TEXT_RE.test(input.last_assistant_message);
    }
    const transcriptPath = input.transcript_path;
    if (typeof transcriptPath !== 'string' || !transcriptPath) return true;
    const st = fs.statSync(transcriptPath);
    const start = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(transcriptPath, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(-TRANSCRIPT_TAIL_LINES);

    let lastText = '';
    const toolNames = [];
    let sawAssistant = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      const msg = entry && (entry.message || entry);
      const role = (msg && msg.role) || (entry && entry.type);
      if (role !== 'assistant') continue;
      sawAssistant = true;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            lastText = block.text + '\n' + lastText;
          } else if (block && block.type === 'tool_use' && block.name) {
            toolNames.push(String(block.name));
          }
        }
      } else if (typeof content === 'string') {
        lastText = content;
      }
      if (lastText) break; // reached the final assistant text; earlier turns are history
    }

    if (!sawAssistant) return true; // nothing to judge — fail open
    if (toolNames.some((n) => SUPERVISION_TOOLS.has(n))) return true;
    return SUPERVISION_TEXT_RE.test(lastText);
  } catch {
    return true; // fail open
  }
}

function seatLabel(e) {
  const name = e.seat || e.name || e.agent || 'seat';
  return e.task_id ? `${name} (task ${e.task_id})` : String(name);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));

  // Loop safety: never block a stop that follows a stop-hook continuation.
  if (input.stop_hook_active) process.exit(0);

  const root = input.cwd || process.env.CODEX_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!fs.existsSync(path.join(root, '.maestro'))) process.exit(0);

  const alive = rosterAliveSeats(root);
  if (alive.length === 0) {
    writeBudget(root, BUDGET_START); // condition clean — reset
    process.exit(0);
  }

  if (supervisionVisible(input)) {
    writeBudget(root, BUDGET_START); // condition clean — reset
    process.exit(0);
  }

  const names = alive.slice(0, 5).map(seatLabel).join(', ')
    + (alive.length > 5 ? ` and ${alive.length - 5} more` : '');

  const budget = readBudget(root);
  if (budget <= 0) {
    // Degraded mode: visible, but no longer blocking. Budget stays exhausted
    // until a clean allow resets it.
    process.stdout.write(JSON.stringify({
      systemMessage: `maestro stop-guard: block budget exhausted — allowing this turn to end in degraded mode while ${alive.length} seat(s) are still marked alive (${names}). The roster may be stale; reconcile it against live tasks when work resumes.`,
    }));
    process.exit(0);
  }

  writeBudget(root, budget - 1);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `This turn is ending while tracked work is still in flight with no visible supervision path: ${names}. Ending blind strands those workers — their results would arrive into a session that no longer remembers them. Before stopping, close the loop one of these ways: state what is in flight and that you will act on its task notifications; reconcile the roster if those seats actually finished (fleet-medic sweep or roster reconcile); or, if the work is genuinely over, record the stop through the stop writer. If the roster is simply stale, reconciling it is the fix — not ignoring it. (stop-guard budget: ${budget - 1} block(s) remaining before degraded allow)`,
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail open
}
