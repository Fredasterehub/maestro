---
name: handoff
description: Preserve and restore task continuity for Codex. Use when Codex warns that a context rollover is approaching, before calling new_context, after SessionStart(source=compact), when the user asks to hand off, save, pause, stop, wrap up, switch model/machine/person, or resume from a handoff. Supports automatic same-thread rollover, deliberate cold transfer, and resume. Skip only for an ordinary pause that will remain in the current healthy context window.
---

# Context handoff

Preserve enough semantic state that a fresh model-visible context can take the
correct next action without access to prior messages. Do not promise transcript
losslessness: a rollover deliberately removes prior messages. The target is
operational continuity backed by durable evidence.

Choose exactly one mode:

- **rollover** — checkpoint, call `new_context`, and continue automatically in
  the same Codex thread. This is the default for token warnings and compaction.
- **transfer** — prepare files and a copyable prompt for another thread,
  machine, model, person, or deliberate stop.
- **resume** — reconcile a rollover or transfer handoff with current disk state
  and continue its first valid next action.

Read `references/HANDOFF-template.md` before writing semantic handoff content.
For rollover behavior and the pinned experimental configuration, read
`references/codex-rollover.md`.

## Shared content contract

Carry only state that would change the next model's behavior:

- current mission, objective, constraints, and completion bar
- exact operator rulings or faithful concise excerpts, with their source
- verified results with durable evidence
- work in flight, its exact stopping point, and partial side effects
- blockers and their unblock conditions
- ordered cold-startable next actions
- decisions and the reasons or rejected alternatives that still matter
- labeled hypotheses, their basis, and the next discriminating check
- unresolved threads, recurring traps, high-value paths, and exact commands

Do not carry routine narration, duplicated repository facts, copied volatile
status, secrets, or hidden chain-of-thought. Preserve decisions and concise
rationales; never invent a retrospective reasoning trace. Record secret
locations only.

Treat source files, Git, tests, and `.maestro` machine records as authoritative.
The handoff is a bounded semantic index over that state, not a second database.

## Rollover mode

Use `.maestro/continuity/` for rolling context-window state. Never overwrite a
root `HANDOFF.md` or Maestro's mechanical stop record for a routine rollover.

### Maintain write-through continuity

After a material operator ruling, major verified milestone, or change to the
immediate next action, refresh the continuity record while the evidence is
local. At the boundary, reconcile only the delta. Do not spend the emergency
reserve rescanning the full transcript.

Locate the loaded Maestro plugin root, then inspect the writer's current CLI:

```text
node <plugin-root>/machine/src/continuity.js --help
```

Derive `<plugin-root>` from the loaded skill path (two directories above this
`skills/handoff` directory). Do not assume hook-only environment variables are
present in an ordinary model shell.

The writer is the sole owner of `.maestro/continuity/handoff-state.json` and
`.maestro/continuity/HANDOFF.md`. Supply the strict JSON shape shown by
`--help`; use payload mode `auto` for rollover and do not hand-edit either
generated file.

### Roll over at a safe boundary

1. Stop starting substantive work. Finish the atomic step already in flight or
   record its exact stop and any partial effects.
2. Reconcile current continuity with the most specific durable owners: mission
   checkpoints, artifacts, holds, roster, ledger, source files, and Git. Avoid
   broad re-verification that is unrelated to the next action.
3. Write the bounded payload through `continuity.js write <tree-root>` and cite
   evidence for every completed claim. The tree root is normally `.maestro`,
   not the repository root; follow `--help` if the installed interface differs.
4. Read it back with `continuity.js read <tree-root>`. Verify that it names the
   objective, exact stop, operator-only knowledge, and one executable first next
   action. A parse error, missing next action, or failed write blocks a voluntary
   reset.
5. Call `new_context`. Do not ask the operator to open another session, copy a
   prompt, or restate the task.
6. In the fresh window, follow resume mode immediately. Successful rollover is
   silent unless the operator asked for a status report.

Call `new_context` only after the record verifies. If the tool is unavailable,
leave the verified handoff in place and report that the experimental Codex
rollover feature is not enabled; do not pretend history was cleared.

A forced reset may bypass voluntary validation. On `SessionStart` with source
`compact`, use the injected bounded fallback, label continuity degraded, inspect
durable state, and recover without inventing lost operator intent. Do not ask
the operator to repeat information unless a materially necessary ruling exists
nowhere on disk.

## Transfer mode

Use this only for a deliberate cold handoff outside the automatic same-thread
path.

1. Land or precisely pin the micro-action in flight. Run only the gates needed
   to distinguish verified work from assumptions.
2. Write `HANDOFF.md` and `handoff-state.json` at the agreed project handoff
   location. These are distinct cold-transfer files, not machine-owned
   `.maestro/continuity` projections. Follow the prose order and exact JSON
   schema in the semantic template; include timestamps, origin, gate
   commands/results, Git status, and the first exact next action.
3. Preserve existing user changes. Do not commit merely because a handoff is
   happening. Commit the handoff only when the operator requested a commit or
   the project's established workflow requires one.
4. Read both files back and ensure every `done` claim has evidence. If the
   destination cannot access a referenced local artifact, include or relocate
   it within the authorized project scope.
5. Report the paths and provide this filled-in prompt:

```text
Resume work via the handoff protocol in <project path>.
Read HANDOFF.md and handoff-state.json first. Inspect the referenced source,
artifacts, Git status, and recent history. Treat disk and current gate results as
authoritative; the handoff is their map. Re-run only the gates needed before
building on recorded claims, then continue with: <first exact next action>.
Do not redo work already verified unless current evidence contradicts it.
```

If overwriting an existing manual transfer record would destroy useful history,
archive it using the project's convention or ask before replacing it.

## Resume mode

1. Determine whether this is a rolling `.maestro/continuity` handoff or a manual
   `HANDOFF.md` plus `handoff-state.json` transfer.
2. Read the machine-readable state before prose. Read only the referenced files,
   artifacts, mission records, and Git evidence needed for the first action.
3. Reconcile claims with current reality. If a recorded gate now fails or a
   referenced file moved, state the contradiction and update continuity before
   proceeding.
4. Restore the objective and constraints, then execute the first still-valid
   next action. Do not repeat completed work and do not ask the operator to
   restate preserved context.
5. Continue write-through updates at major milestones so the next rollover is a
   small reconciliation rather than a reconstruction.

## Failure rules

- Never mark inferred or unverified work complete.
- Never call a voluntary `new_context` after a failed handoff write or readback.
- Never block forced compaction after its boundary; recover honestly from
  durable state instead.
- Never copy secrets, credentials, or large raw tool output into continuity.
- Never claim hidden reasoning was preserved. Carry decisions, reasons,
  hypotheses, evidence, and next checks.
