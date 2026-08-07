---
name: handoff
description: This skill should be used whenever the user says "handoff", "save the session", "save what we learned", "wrap up the session", "prepare for a reset", "about to /clear", "don't lose this", "prépare la relève", asks to preserve context before compaction or restart, or whenever a long working session is ending and conversation-only knowledge is about to be destroyed. Sweeps every durable finding out of conversation memory into its most-specific disk home — project CLAUDE.md, mission artifacts, checkpoints, holds, user memory — then reports what is now safe to reset. Skip it for a mid-task pause where the session will simply continue.
---

# handoff — pre-reset knowledge sweep

Everything this session learned that lives only in conversation memory dies at
the next reset, compaction, or crash. Handoff is the deliberate sweep that
moves each durable finding to a disk home the next session will actually
consult — so that restart stays reconciliation, never re-discovery.

The failure mode this skill exists to prevent is not losing knowledge — it is
dumping knowledge. An append-forever memory file rots, and its cost is paid by
every future session that loads it. Handoff routes each finding to its
most-specific owner and prunes as it writes.

## 1. Sweep

Walk the conversation for durable material. Durable means a future session
would act differently for knowing it:

- decisions made and their reasons (including operator rulings)
- facts discovered the hard way (a config quirk, a build constraint, a
  disproven assumption)
- corrections and lessons — confirmed approaches and failed ones alike
- undone or half-done work, with what remains
- open questions and unresolved disagreements

Not durable: retry narration, transient paths, tool output already reflected
in files, anything git history or existing records already capture. Copied
live state (versions, listings, statuses) rots the moment it is written —
record where to look, not what was seen.

## 2. Route — most-specific owner wins

| Finding | Home | How |
|---|---|---|
| Progress or remaining work on an open mission | `.maestro/missions/<id>/progress.jsonl` | `node "<plugin-root>/machine/src/mission.js" checkpoint .maestro <id> ...` with `{step, done_evidence, next}` |
| Mission-scoped evidence, research, sealed corpus | `.maestro/missions/<id>/artifacts/` | Write the file; reference it from the checkpoint |
| Unresolved operator decision, parked disagreement, undone work with no mission home | Holds queue | `node "<plugin-root>/machine/src/hold.js" park .maestro ...` |
| Project convention or fact every future session in this repo needs | Project `CLAUDE.md` | Read it, integrate, prune — see writing discipline |
| Cross-project operator preference | `~/.claude/CLAUDE.md` | Same discipline |
| Already recorded (ledger, git, brief, existing doc) | Nowhere | Duplication is rot, not safety |

The table is ordered: check each finding from the top and stop at the first
row that fits. A mission-scoped fact does not belong in CLAUDE.md just because
CLAUDE.md is easier to reach — every session pays for what CLAUDE.md carries,
and only this mission needs the fact.

Machine-owned records (checkpoints, holds) go only through their CLI — each
script is the sole sanctioned writer of its record kind, and a hand-written
line breaks the evidence chain the ledger exists for. Each script's `--help`
is the authoritative CLI reference. Prose homes (CLAUDE.md files, artifacts)
are written directly.

Resolve `<plugin-root>` from the loaded skill path (two directories above this
`skills/handoff` directory). Hook-only environment variables are not
guaranteed inside an ordinary Codex shell.

## 3. Writing discipline

- **Inspect, then update.** Read the target before writing. Merge into what
  exists, rewrite the section, delete what the new finding supersedes.
  Rewrite-and-prune, never append-forever.
- **Undone work is filed, not described.** An open mission gets a checkpoint
  stating what is done (with evidence) and what comes next — precise enough
  that a re-dispatched worker redoes only the missing part. Work without a
  mission gets a hold naming it. Prose like "we should also..." in a memory
  file is where work goes to be forgotten.
- **Never create or edit a skill as a side effect.** If a finding wants to
  become a skill or change one, park a hold naming the candidate and move on.
  Skill authoring is deliberate work with its own review, not a memory
  curation byproduct.
- Secrets by location, never by content — "token in `.env.local`", never the
  token.

## 4. Report

Close with a faithful accounting, one line per routed finding:

```
Handed off:
- <finding> → <home>
Dropped as ephemeral:
- <item> (<why>)
Verdict: safe to reset. | NOT yet safe to reset: <unhandled item and why>.
```

The verdict is a claim backed by the lines above it. Anything durable still
without a disk home blocks the safe-to-reset claim — say so plainly and name
it rather than rounding up to safe. If nothing durable surfaced at all, that
is a legitimate outcome: report "nothing to hand off" and the verdict.
