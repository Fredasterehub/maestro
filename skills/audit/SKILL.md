---
name: audit
description: This skill should be used whenever the user says "audit", "audit the process", "is the orchestration itself buggy", "why so many revisions", "why does this keep hitting the ladder", "are the reviewers actually finding real things", "process health", "how much friction is there", "is maestro working well", "is fable-low pulling its weight", "should we qualify fable-low", or wants to know whether the orchestration process itself — not any one project's code — is healthy: revise-cap hit rate, ladder engagements per mission, repeated same-theme reviewer findings, envelope validation failures, worker death rate, first-pass rate by class, fable-low rescue behaviour, degraded-path exposure, experiment-worthy (class, seat) cells. Runs `friction.js rates` plus bounded ledger reads and reports a plain verdict with evidence counts per pattern; zero friction on a pattern is a legitimate, explicitly reported outcome, never silence. Read-only, no repairs. Skip it for install/state health (tree, roster liveness, holds, routing digest) — that is `/maestro:doctor`.
---

# audit — process health, read-only

Doctor asks "is the install and the recorded state healthy." Audit asks a
different question: "is the *orchestration itself* behaving well" — is review
disagreement resolving cleanly or grinding the ladder, are reviewers finding
new things or the same thing on repeat, are workers dying. Both questions
matter and neither is the other; a project can have a pristine `.maestro/`
tree and still be burning revise rounds on the same finding three times in a
row.

Audit diagnoses and stops there, for the same reason doctor does: every
friction record has exactly one sanctioned writer (`friction.js`), and an
audit that "fixes" a pattern in passing becomes an undocumented second writer
with no trail. The one thing this skill produces besides the report is
nothing — it runs no CLI that mutates `.maestro/`.

Resolve `<plugin-root>` from the loaded skill path (two directories above this
`skills/audit` directory). Hook-only environment variables are not guaranteed
inside an ordinary Codex shell.

Report every pattern on every run, whether or not it fired. Zero friction on
a pattern is a legitimate, reportable outcome and is stated as exactly
that — "0 ladder engagements across 4 missions" is a finding, not a skipped
line.

## Source discipline: bounded reads only

`ledger.jsonl` and `roster-archive.jsonl` are unbounded append-only streams —
never `cat` or unbounded-`Read` either one. Every pattern below either reads
through a machine CLI that already emits a bounded aggregate
(`friction.js rates`), or a `grep`/`tail`-bounded slice, never a full stream
dump into context. This is the same discipline the PreToolUse warn-guard
enforces on every session.

## Patterns — six, always reported together

1. **Revise-cap hit rate.**

   ```
   node "<plugin-root>/machine/src/friction.js" rates <treeRoot>
   ```

   Read `revise_verdict_by_mission`. A mission at 2 (the cap,
   `references/landing.md`) is cap-hit. Report `<cap-hit>/<missions with any
   revise-verdict records>` plus the per-mission counts. No revise-verdict
   records at all is a legitimate outcome — first-pass approval every
   time — reported as exactly that.

2. **Ladder engagements per mission.**

   Same `rates` call: `by_mission[<id>]["ladder-engaged"]` and the
   `ladder_engaged_total` scalar. Report per-mission counts, not only the
   total — 3 engagements spread across 3 missions and 3 engagements on one
   mission are different findings, and the total alone erases which one is
   true.

3. **Repeated same-theme reviewer findings — heuristic.**

   ```
   grep '"kind":"revise-verdict"' <treeRoot>/ledger.jsonl | tail -50
   ```

   Group the matched lines by `mission_id`; each carries a `detail` field
   that is already a plain-sentence finding summary, by `friction.js`'s own
   contract. Flag a mission where two or more rounds share a repeated
   substantive phrase (three-or-more-word overlap, case-insensitive). This is
   literal text matching, not semantic understanding — name it as a heuristic
   in the report every time it fires, not only the first. A mission with no
   repeated phrase is reported "no repeat found (heuristic)"; a mission with
   fewer than two revise rounds is reported "not enough rounds to assess" —
   never folded silently into "no repeats."

4. **Envelope validation failures — heuristic, structurally blind by design.**

   `mission.js record-envelope` refuses an invalid envelope before anything
   reaches disk, so a validation *failure* leaves no direct record by the
   machine layer's own design — this pattern can only ever approximate.
   Two bounded proxies:

   ```
   node "<plugin-root>/machine/src/friction.js" rates <treeRoot>
   ```

   read `unparseable_lines` (malformed lines the ledger reader itself
   reports), and a bounded per-mission scan for envelope files that fail to
   parse:

   ```
   for f in <treeRoot>/missions/*/envelopes/*.json; do
     node -e "JSON.parse(require('fs').readFileSync(process.argv[1]))" "$f" >/dev/null 2>&1 || echo "$f"
   done
   ```

   State the limitation in the report every time: this counts malformed
   *survivors*, never rejections — a validation refusal, by design, wrote
   nothing to find. Zero here means "nothing malformed survived," explicitly
   not "no worker ever failed validation."

5. **Worker death rate.**

   `friction.js rates`'s `by_kind["worker-died"]` against the closest
   available denominator, total seats ever retired:

   ```
   grep -c '"kind":"roster_retire"' <treeRoot>/roster-archive.jsonl
   ```

   Report `worker-died / retired` as the rate, named as an approximation —
   only a dead seat the liaison actually chose to re-dispatch gets recorded
   (`references/supervision.md` "Friction"), so a dead seat quietly
   abandoned instead never enters this count. Zero `worker-died` records is a
   legitimate, reportable outcome.

6. **Tiered-dispatch rates — first-pass by class, fable-low rescue, degraded
   exposure, experiment-worthy cells.**

   Same `rates` call, four more fields: `by_class`, `rescue`,
   `experiment_proposals`, and the two per-close facts that live inside
   `by_class` rather than beside it.

   - **`by_class[<class>]`** — every task class present even at zero:
     `dispatched` (author attempts registered in that class) against
     `closed` (missions that actually closed with a winning attempt in that
     class), `degraded_path_closes` (closes whose recorded review
     independence is `degraded-path`, per class).

   - **Two first-pass counts, never conflated.** `mission_first_pass` counts
     closes where the winning attempt was the mission's *first* AND the
     whole mission spent zero revise rounds, zero provider reroutes and zero
     profile escalations. `attempt_first_pass` counts closes where the
     *winning attempt's own* review history alone was clean — it says
     nothing about what earlier attempts on the same mission cost. These are
     different questions and `attempt_first_pass` is always ≥
     `mission_first_pass` within a class; report both numbers together and
     name the gap between them explicitly — a mission that took three
     attempts to land one clean review round is a materially different
     finding than a mission that got it right immediately, and folding the
     two counts into one number erases exactly that distinction.

   - **`rescue` — fable-low's own terms, never a comparison against opus.**
     `fallback_rate`, `refusal_rate`, `rescue_rate`, `time_to_rescue_ms` and
     `convergence_fraction` are each stated over the fable-low population
     alone. Production routing is selection-biased — fable-low sees work an
     escalation already required, opus does not see the same work — so a
     ratio between the two would measure the routing decision, not either
     model, and report that as if it were a model comparison. Never compute
     or state one; report each rescue figure on its own, and say so in the
     write-up. `incremental_cost_per_rescue` is always `null`: no writer in
     `machine/src` records a dollar or token cost, so this is reported
     absent rather than approximated from a proxy (attempt count, wall time)
     that is not actually cost. A `null` here is the correct, honest answer,
     not a gap to fill in by hand.

   - **`experiment_proposals` — propose, never conclude.** A `(class, seat)`
     cell reaching 20 closes appears here as `{class, seat, closes}`. This is
     a proposal to run a real experiment (paired evaluation, randomized
     routing, shadow evaluation, or an operator-commissioned benchmark) —
     never an `estimated → qualified` status flip, and this skill never
     writes one. Report every entry present; an empty list is "no cell has
     reached the threshold yet," stated as exactly that.

## Output shape

One line per pattern — name, verdict, the evidence counts, the heuristic
caveat inline where it applies — then one closing line:

```
revise-cap     1/2 missions hit cap          m1: 2, m2: 1, m3: 0
ladder         1 engagement, one mission     m1: 1 (all others: 0)
findings       1 mission flagged (heuristic) m1 rounds 1+2 share "missing edge case handling"
envelope       0 malformed survivors         proxy only — refusals leave no direct record
worker-death   1/4 retired (heuristic)       m2: executor-sol died, re-dispatched
tiered-rates   standard: 3/4 mission_first_pass, 4/4 attempt_first_pass; fable-low: 2 fallbacks, rescue_rate 1/2 (own terms, not vs. opus); 0 experiment proposals
Verdict: 2 pattern(s) worth a look (revise-cap on m1, repeated finding on m1).
Verdict: clean across all six patterns — nothing recorded, nothing repeated.
```

The verdict names which patterns fired and on which mission; it never
recommends a fix — that decision, and its route, belongs to the operator's
next request.

## What this skill does not do

No repairs, no re-dispatch, no hold resolution, no settings or routing
writes, no re-running a gate. For install and recorded-state health — tree
presence, `state.json` shape, roster liveness, open holds, the routing
digest — that is `/maestro:doctor`, a different door asking a different
question.
