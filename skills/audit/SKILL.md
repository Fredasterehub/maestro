---
name: audit
description: >-
  This skill should be used whenever the user says "audit", "audit the process",
  "is the orchestration itself buggy", "why so many revisions", "why does this
  keep hitting the ladder", "are the reviewers actually finding real things",
  "process health", "how much friction is there", "is maestro working well", or
  wants to know whether the orchestration process itself — not any one project's
  code — is healthy: revise-cap hit rate, ladder engagements per mission,
  repeated same-theme reviewer findings, envelope validation failures, worker
  death rate. Runs `friction.js rates` plus bounded ledger reads and reports a
  plain verdict with evidence counts per pattern; zero friction on a pattern is
  a legitimate, explicitly reported outcome, never silence. Read-only, no
  repairs. Skip it for install/state health (tree, roster liveness, holds,
  routing digest) — that is `/maestro:doctor`.
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

## Patterns — five, always reported together

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

## Output shape

One line per pattern — name, verdict, the evidence counts, the heuristic
caveat inline where it applies — then one closing line:

```
revise-cap     1/2 missions hit cap          m1: 2, m2: 1, m3: 0
ladder         1 engagement, one mission     m1: 1 (all others: 0)
findings       1 mission flagged (heuristic) m1 rounds 1+2 share "missing edge case handling"
envelope       0 malformed survivors         proxy only — refusals leave no direct record
worker-death   1/4 retired (heuristic)       m2: executor-sol died, re-dispatched
Verdict: 2 pattern(s) worth a look (revise-cap on m1, repeated finding on m1).
Verdict: clean across all five patterns — nothing recorded, nothing repeated.
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
