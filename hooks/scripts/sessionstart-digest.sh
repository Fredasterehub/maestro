#!/usr/bin/env bash
# maestro SessionStart digest composer.
#
# Registered in hooks.json for SessionStart with matcher startup|resume|clear|compact.
# Why "compact" is in the matcher (JSON has no comments, so the rationale lives
# here): the liaison posture exists only in the session context — it is injected,
# not stored anywhere the model re-reads. Compaction rewrites that context, and a
# compacted summary routinely drops standing instructions. Without the compact
# matcher, the one session type most likely to be deep into orchestration work
# (long enough to compact) would be exactly the one that loses its operating
# posture mid-flight. Re-injecting on compact keeps the posture alive for the
# session's whole life, which is the point of the posture.
#
# Contract: reporting, never gating. This script always exits 0 — a broken
# digest must never cost the operator a session start. Every external
# dependency (posture file, .maestro tree, node, jq) has a fallback.
#
# Output: hook JSON with hookSpecificOutput.additionalContext containing
# (1) the posture block verbatim, (2) a read-once state digest when ./.maestro
# exists, or a one-line stateless notice when it does not. If no JSON encoder
# is available, falls back to plain stdout — SessionStart adds stdout to
# context as well, so the posture still lands.
#
# Budget: the posture block is ~1.1k tokens; the digest portion is hard-capped
# (mission list truncated at 10, strings clipped, byte cap) to keep the whole
# injection under ~1.5k tokens.

set -u

# --- resolve roots (tolerate missing env) -----------------------------------

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd) || SCRIPT_DIR=""
  if [ -n "$SCRIPT_DIR" ]; then
    PLUGIN_ROOT="${SCRIPT_DIR%/hooks/scripts}"
  fi
fi

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# Drain hook input from stdin; the digest depends only on disk state, and the
# same digest is correct for every SessionStart source.
cat >/dev/null 2>&1 || true

# --- posture block (verbatim) ------------------------------------------------

POSTURE=""
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/hooks/posture.md" ]; then
  POSTURE=$(head -c 7000 "$PLUGIN_ROOT/hooks/posture.md" 2>/dev/null) || POSTURE=""
  # The posture cites machine CLIs as ${CLAUDE_PLUGIN_ROOT}/... — a variable
  # only hooks resolve, not the session's own shell. Interpolate it here so
  # the injected text carries an absolute path the session can actually run.
  POSTURE=${POSTURE//'${CLAUDE_PLUGIN_ROOT}'/$PLUGIN_ROOT}
fi
if [ -z "$POSTURE" ]; then
  # Minimal stand-in so a missing/unreadable posture file still leaves the
  # session with the load-bearing rules.
  POSTURE="<maestro-posture>
(posture file unavailable — condensed form) You are a maestro liaison: delegate
all substantive work to workers; consume six-field envelopes and bounded
projections, never raw sources; you are the sole committer/merger; operator-intent
ambiguity earns one precise question, implementation judgment climbs the ladder
(retry-distinct, convergence pass, S1); .maestro/state.json is the single resume
pointer. Load the maestro skill for the full playbook.
</maestro-posture>"
fi

# --- state digest ------------------------------------------------------------

DIGEST_BODY=""

if [ -d "$ROOT/.maestro" ]; then
  if command -v node >/dev/null 2>&1; then
    DIGEST_JS=$(cat <<'MAESTRO_DIGEST_EOF'
const fs = require('fs');
const path = require('path');
const root = process.env.MAESTRO_ROOT || process.cwd();
const m = (p) => path.join(root, '.maestro', p);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };
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
  lines.push('state.json: missing or unparseable — treat state as unknown until a worker verifies it');
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
    DIGEST_BODY="state digest unavailable (node missing or state unreadable). .maestro/ exists — read state.json once as the resume pointer, then proceed."
  fi

  # Byte cap on the digest body so a pathological state file cannot blow the
  # token budget; the closing line is appended after the cap so it survives.
  DIGEST_BODY=$(printf '%s' "$DIGEST_BODY" | head -c 2400) || true

  DIGEST="## .maestro state digest (read-once)

${DIGEST_BODY}

Digest complete — do not re-read these sources this session absent corruption or targeted need."
else
  DIGEST="No .maestro/ tree in this project — stateless mode. Orchestrate the same way; scaffold the tree (run scaffold.js — never mkdir) before the first mission that will produce a deliverable — a code change or an investigation report — so recovery has something to stand on."
fi

CONTEXT="${POSTURE}

${DIGEST}"
CONTEXT=$(printf '%s' "$CONTEXT" | head -c 12500) || true

# --- emit --------------------------------------------------------------------

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
  # SessionStart adds plain stdout to context; the posture still lands.
  printf '%s\n' "$CONTEXT" 2>/dev/null || true
fi

exit 0
