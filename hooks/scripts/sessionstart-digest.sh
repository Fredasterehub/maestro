#!/usr/bin/env bash
# Maestro SessionStart context composer.
#
# This hook is reporting-only and always exits 0. On an ordinary start it
# injects the liaison posture plus a bounded digest of durable `.maestro`
# state. A Codex `source=compact` is treated as a hard same-thread rollover
# only when PreToolUse(new_context) left a fresh matching arm and the one-time
# consume succeeds; only then does this hook inject the bounded handoff. An
# unarmed compact event stays on neutral durable recovery and leaves the
# handoff unconsumed. Claude also emits `source=compact`, but never enters this
# Codex arm/consume path.
#
# Output is bounded: hook input 64 KiB, posture 7,000 bytes, state digest 2,400
# bytes, continuity projection 4,200 bytes, and final additional context
# 12,500 bytes. A hook failure must never prevent a session from starting.

set -u

# --- hook input and roots ---------------------------------------------------

HOOK_INPUT=$(head -c 65536 2>/dev/null || true)

json_field() {
  local field="$1"
  if command -v node >/dev/null 2>&1; then
    MAESTRO_HOOK_INPUT="$HOOK_INPUT" MAESTRO_HOOK_FIELD="$field" node -e '
      try {
        const input = JSON.parse(process.env.MAESTRO_HOOK_INPUT || "{}");
        const value = input[process.env.MAESTRO_HOOK_FIELD || ""];
        if (typeof value === "string") process.stdout.write(value);
      } catch {}
    ' 2>/dev/null || true
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | jq -r --arg key "$field" '.[$key] // empty | select(type == "string")' 2>/dev/null || true
  fi
}

SOURCE=$(json_field source)
HOOK_CWD=$(json_field cwd)
SESSION_ID=$(json_field session_id)

CODEX_PLUGIN_HOST=0
if [ -n "${PLUGIN_ROOT:-}" ]; then
  CODEX_PLUGIN_HOST=1
fi
PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$PLUGIN_ROOT" ]; then
  SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd) || SCRIPT_DIR=""
  if [ -n "$SCRIPT_DIR" ]; then
    PLUGIN_ROOT="${SCRIPT_DIR%/hooks/scripts}"
  fi
fi

ROOT="${HOOK_CWD:-${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}}"

# --- posture block ----------------------------------------------------------

POSTURE=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/hooks/posture.md" ]; then
  POSTURE=$(head -c 7000 "$PLUGIN_ROOT/hooks/posture.md" 2>/dev/null) || POSTURE=""
  # Both plugin hosts expose a root variable. Resolve either spelling before
  # the text reaches the model so commands in the posture are executable.
  POSTURE=${POSTURE//'${PLUGIN_ROOT}'/$PLUGIN_ROOT}
  POSTURE=${POSTURE//'${CLAUDE_PLUGIN_ROOT}'/$PLUGIN_ROOT}
fi
if [ -z "$POSTURE" ]; then
  POSTURE="<maestro-posture>
(posture file unavailable — condensed form) You are a maestro liaison: delegate
all substantive work to workers; consume bounded envelopes, never raw sources;
you are the sole committer/merger; operator-intent ambiguity earns one precise
question; .maestro/state.json is the durable resume pointer. Load the Maestro
skill for the full playbook.
</maestro-posture>"
fi

# --- durable state digest ---------------------------------------------------

DIGEST_BODY=""

if [ -d "$ROOT/.maestro" ]; then
  if command -v node >/dev/null 2>&1; then
    DIGEST_JS=$(cat <<'MAESTRO_DIGEST_EOF'
const fs = require('fs');
const path = require('path');
const root = process.env.MAESTRO_ROOT || process.cwd();
const m = (p) => path.join(root, '.maestro', p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const lines = [];

const state = readJson(m('state.json'));
if (state && typeof state === 'object') {
  const missions = state.missions && typeof state.missions === 'object' ? Object.entries(state.missions) : [];
  const closedish = new Set(['closed', 'done', 'merged', 'abandoned']);
  const open = missions.filter(([, v]) => v && typeof v === 'object' && !closedish.has(String(v.status || '')));
  let head = `state.json: ${missions.length} mission(s), ${open.length} open`;
  if (state.active_mission) head += `; active: ${clip(state.active_mission, 60)}`;
  lines.push(head);
  for (const [id, v] of open.slice(0, 10)) {
    lines.push(`- ${clip(id, 60)} [${clip(v.status || '?', 20)}] next: ${v.next_action != null ? clip(v.next_action, 120) : '(none recorded)'}`);
  }
  if (open.length > 10) lines.push(`- …and ${open.length - 10} more open missions (state.json has the full list)`);
  if (state.last_stop != null) lines.push(`last_stop: ${clip(state.last_stop, 200)}`);
  if (state.preflight != null) lines.push(`preflight: ${clip(state.preflight, 200)}`);
} else {
  lines.push('state.json: missing or unparseable — treat state as unknown until verified');
}

try {
  const rows = fs.readFileSync(m('holds.jsonl'), 'utf8').split('\n').filter(Boolean);
  const records = [];
  for (const row of rows) {
    try {
      const record = JSON.parse(row);
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record);
    } catch {}
  }
  const resolved = new Set(
    records
      .filter((r) => r.kind === 'resolve' && Number.isSafeInteger(r.park_seq))
      .map((r) => r.park_seq)
  );
  const parks = records.filter((r) => r.kind === 'park' && Number.isSafeInteger(r.seq));
  const open = parks.filter((r) => !resolved.has(r.seq));
  lines.push(`holds: ${open.length} open of ${parks.length} parked`);
} catch {
  lines.push('holds: none recorded');
}

const roster = readJson(m('roster.json'));
if (roster && typeof roster === 'object' && Array.isArray(roster.entries)) {
  const entries = roster.entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  const counts = {};
  for (const entry of entries) {
    const status = String(entry.status || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ');
  let line = `roster: ${entries.length} seat(s)${parts ? ` (${parts})` : ''}`;
  if (counts.alive) line += ' — reconcile session-bound workers against live tasks before trusting "alive"';
  lines.push(line);
} else {
  lines.push('roster: empty or unrecognized');
}

process.stdout.write(lines.join('\n'));
MAESTRO_DIGEST_EOF
)
    DIGEST_BODY=$(MAESTRO_ROOT="$ROOT" node -e "$DIGEST_JS" 2>/dev/null) || DIGEST_BODY=""
  fi

  if [ -z "$DIGEST_BODY" ]; then
    DIGEST_BODY="state digest unavailable (node missing or state unreadable). .maestro/ exists; verify state.json before acting."
  fi

  DIGEST_BODY=$(printf '%s' "$DIGEST_BODY" | head -c 2400) || true
  BASE_DIGEST="## .maestro state digest (read once)

${DIGEST_BODY}

Digest complete. Re-read a source only for corruption or a targeted need."
else
  BASE_DIGEST="No .maestro/ tree exists in this project. Treat prior operational state as unavailable; scaffold through the Maestro machine before creating a deliverable."
fi

# --- compact-window continuity --------------------------------------------

if [ "$SOURCE" = "compact" ] && [ "$CODEX_PLUGIN_HOST" = "1" ]; then
  CONTINUITY=""
  CONTINUITY_SCRIPT="$PLUGIN_ROOT/machine/src/continuity.js"
  CONTINUITY_STATE="$ROOT/.maestro/continuity/handoff-state.json"
  if command -v node >/dev/null 2>&1 \
      && [ -f "$CONTINUITY_SCRIPT" ] \
      && [ -f "$CONTINUITY_STATE" ] \
      && [ -n "$SESSION_ID" ]; then
    # `consume` validates freshness/schema/digest/ledger state and claims the
    # generation once under the shared state lock before printing its compact
    # capsule. A repeated or corrupt generation exits non-zero and degrades.
    if CONTINUITY_RAW=$(node "$CONTINUITY_SCRIPT" consume "$ROOT/.maestro" "$SESSION_ID" 2>/dev/null); then
      CONTINUITY_BYTES=$(printf '%s' "$CONTINUITY_RAW" | wc -c | tr -d '[:space:]')
      if [ -n "$CONTINUITY_RAW" ] \
          && [ "$CONTINUITY_BYTES" -le 4200 ] 2>/dev/null; then
        CONTINUITY="$CONTINUITY_RAW"
      fi
    fi
  fi

  if [ -n "$CONTINUITY" ]; then
    DIGEST="## Same-thread context rollover

Codex intentionally cleared the prior model-visible messages and continued in
this same thread. The bounded handoff below is the working-memory bridge.
Reconcile it with durable .maestro state and Git only where relevant, then
immediately perform its exact next action. Do not scan the old transcript, ask
the operator to open a new session, or ask them to restate the request.

${CONTINUITY}"
  else
    DIGEST="## Compact recovery — no one-time capsule

No fresh continuity generation could be claimed for this compact event. Do not
replay an older handoff, invent lost operator intent, or claim transcript-level
continuity. Use only the durable digest below and continue the safest supported
next action. Do not ask for a new session or a general restatement; ask one
narrow question only if an essential choice is absent from durable state.

${BASE_DIGEST}"
  fi
else
  DIGEST="$BASE_DIGEST"
fi

CONTEXT="${POSTURE}

${DIGEST}"
CONTEXT=$(printf '%s' "$CONTEXT" | head -c 12500) || true

# --- emit ------------------------------------------------------------------

emit_json() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$CONTEXT" | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}' 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    MAESTRO_CTX="$CONTEXT" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: process.env.MAESTRO_CTX || ""}}))' 2>/dev/null && return 0
  fi
  return 1
}

if ! emit_json; then
  # SessionStart accepts plain stdout as context; preserve a useful fallback.
  printf '%s\n' "$CONTEXT" 2>/dev/null || true
fi

exit 0
