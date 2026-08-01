---
name: doctor
description: >-
  This skill should be used whenever the user says "doctor", "health check",
  "check maestro", "is the state healthy", "run preflight", "something looks
  broken", "why is the state stale", after a crash or messy restart, before
  trusting `.maestro/` state that may have been hand-edited, or when workers
  seem out of sync with the recorded roster. Runs environment preflight and
  prints a complete state-health report — tree, state.json, roster liveness,
  holds, routing digest — naming the exact fix for every problem found while
  performing none of them. Read-only door. Skip it when the user wants a status
  recap — that is `/maestro:status`.
---

# doctor — state health, read-only

One pass over the environment and the `.maestro/` tree; report every check,
healthy or not; name the exact fix for each problem; perform none of them.

Doctor diagnoses and stops there because every record kind in `.maestro/` has
exactly one sanctioned writer, and a doctor that repairs in passing becomes a
second writer with no evidence trail — the operator could never again tell
what the state said before it was "helped". The one sanctioned write in this
skill is preflight recording its own probe results: that is the probe doing
its job, not a repair.

Each machine script's `--help` is the authoritative CLI reference; the
invocations below follow the machine spec.

Resolve `<plugin-root>` from the loaded skill path (two directories above this
`skills/doctor` directory). Hook-only environment variables are not guaranteed
inside an ordinary Codex shell.

## Checks — run and report all of them

Report every check even when it passes. A report that only lists problems
leaves "did it look?" unanswered for everything else; zero findings is a
legitimate outcome and is stated per check, not implied by silence.

1. **Environment preflight.** With the tree present:

   ```
   node "<plugin-root>/machine/src/preflight.js" run .maestro
   ```

   probes node, git, codex (version and login status), gemini, and gh and
   records the result in `state.json.preflight`. Without the tree, probe
   directly (`node --version`, `git --version`, `codex --version` plus
   `codex login status`, `gemini --version`, `gh auth status`) and report the
   same facts. An absent codex or gemini is not an error — report it as the
   degraded routing it implies (same-family substitutes, decorrelation cost
   on reviews) so the operator knows what quality trade is active.

2. **Tree.** `.maestro/` present or absent. Absent is healthy for a project
   with no missions yet — report it as such, name the route ("scaffolds via
   the maestro skill before the first mission that produces a deliverable"),
   and skip checks 3–6 with an explicit "skipped: no tree" line each.

3. **state.json.** Parses cleanly; `active_mission` names a mission that
   exists; each mission entry carries a status and a `next_action`; `last_stop`
   uses the stop vocabulary; `preflight` is present and current. A mission
   with no `next_action`, or a narrated-but-unrecorded stop, is a finding —
   fix: record it through `stop.js` / `mission.js`, the sole writers for
   those records.

4. **Roster liveness.** Read `.maestro/roster.json` and compare each seat's
   task against the live task list — a read-side comparison, not a
   reconciliation. Report counts: alive, finished, unknown/zombie (rostered
   but no live task), unrostered (live task no seat claims). Report "unknown"
   rather than guessing from a stale entry. Any drift → fix:
   `node "<plugin-root>/machine/src/roster.js" reconcile .maestro`
   (named, not run — reconcile writes roster.json).

5. **Holds.**

   ```
   node "<plugin-root>/machine/src/hold.js" list .maestro
   ```

   Report unresolved count, severities, the oldest hold's age, and which
   holds are waiting on an operator decision. Long-lived unresolved holds are
   a finding — fix: surface them for decision (status bucket 1), resolve
   via `hold.js resolve`.

6. **Routing digest.** `.maestro/routing/active.json` parses; the dated
   immutable `routing-*.json` it points to exists; the recorded digest
   matches that file's actual hash (a checksum is a read). A missing target
   or digest mismatch means routing has been hand-edited or corrupted — a
   finding at full severity, since review-family separation depends on it.
   Fix: move the corrupt `routing/` aside and re-run `routing.js init`
   (init refuses over an existing pointer — dated configs are immutable);
   never patch the dated file in place.

## Output shape

One line per check — name, status, then the fix when there is a problem:

```
preflight   ok        node 22.x, git 2.x, codex ok, gemini ABSENT, gh ok → degraded table gemini_down active
tree        ok        .maestro/ present
state.json  ok        2 missions (1 active), last_stop DONE, preflight current
roster      PROBLEM   3 seats: 1 alive, 1 finished, 1 unknown → fix: roster.js reconcile
holds       ok        1 unresolved (S3, 2d) — none awaiting operator
routing     ok        active → routing-2026-07-28-1.json, digest verified
Verdict: 1 problem, fix named above. | Verdict: healthy — nothing to fix.
```

The verdict counts problems and points at the named fixes; it never says
"fixed". Doctor performs no scaffold, no reconcile, no resolve, no settings
or routing writes — when the operator wants a fix applied, that is the next
request, taken through the fix's own sanctioned route.
