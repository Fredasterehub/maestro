# Dispatch — briefs, seats, worktrees, roster

A dispatch is a contract, not a message. The brief is validated before spawn
because a worker holding a malformed contract produces malformed work — and
per the contract, a worker that receives an invalid brief returns `blocked`
naming the validator errors instead of guessing at intent.

Flow: write the brief → `validators.js validate-brief` (brief JSON via stdin) → spawn the seat (worktree
isolation for anything that mutates) → `roster.js register` →
`mission.js open` / record the dispatch. For small ship tasks the liaison
writes the brief directly; for goal-shaped work, dispatch the `planner` seat
and it returns validated briefs plus acceptance criteria.

## The eight fields

Every field earns its place by removing a specific failure mode:

| Field | What it is | Failure it prevents |
|---|---|---|
| `outcome` | What exists when the work is done, stated as a result, not an activity | Workers optimizing for effort instead of the end state |
| `scope` | What is in and — explicitly — what is out | Scope creep, and literal models stopping at the first instance |
| `anchors` | File paths (and artifact paths) the worker starts from — never pasted content | Stale pasted snapshots; context bloat in the brief itself |
| `acceptance` | Checkable criteria, ideally a command with an expected exit code | "Looks done" substituting for done |
| `freshness` | What is current, what may be stale, what to re-verify firsthand | Workers trusting summaries over source |
| `tier` | The closed task class routing reads to seat the work: `recon, mechanical, standard, expert, apex` | Mis-sized dispatches; budget surprises |
| `return_format` | The six-field envelope plus where the artifact lives | Prose reports that cannot be acted on |
| `stop_condition` | When to stop and return `blocked`/`partial` instead of pushing on | Workers grinding past a decision that is not theirs |

`recon` is read-only, no mutation. `mechanical` is bounded scope, named
files, command-verifiable acceptance, no delegated judgment (all must hold).
`standard` is bounded features/fixes with known patterns and local blast
radius. `expert` is open-ended shape, material ambiguity, system blast
radius, a hard-to-reverse change, or weak verification with mutation. `apex`
is foundational ambiguity, external-contract blast radius, destructive
reversibility, or a hard fence (auth/authz/schema/public-api/concurrency/
data-integrity). One moderate risk does not buy apex; two interacting risks
do.

Anchors carry paths, not content, because the worker reads files itself in its
own context — pasting content into a brief freezes a snapshot that goes stale
the moment anything moves, and spends liaison context on what worker context
is for.

## Writing for the seat's model

Seats pin `model` (alias) and `effort` in their agent frontmatter — dispatch
routes by seat name and never overrides model inline. What varies is how the
brief is worded:

- **Sonnet 5 seats** (`scout`, `researcher`, the hosting executors, all
  reviewers, `plan-counterpart`, `crystallizer`, `handoff-recorder`,
  `fleet-medic`) follow scope
  literally and will not generalize an instruction beyond what it says. State
  scope exhaustively: "every call site, not just the first", "all three
  config files", "the whole directory". A scope they were not told about is a
  scope they will not touch.
- **Opus 5 seats** (`planner`, `executor-claude`, `context-keeper`) do their
  best work given the complete specification up front and left to run. Do
  **not** add "double-check your work", "verify before returning", or a final
  self-review step — Opus 5 already self-verifies, and instructing it to
  causes over-verification: slower, no better. Acceptance criteria are fine;
  they are a gate, not a ritual.
- **Review seats** get report-everything language: ask for every finding
  including low-severity and uncertain ones, with confidence and severity per
  finding, and state that zero findings is a legitimate outcome. Never write
  "only report serious issues" — these models comply literally and recall
  drops. Filtering is the liaison's job downstream, via severity routing.

## Example brief — Ship

```json
{
  "outcome": "The invoice importer accepts DD-MM-YYYY dates; the currently failing test test_import_eu_dates passes.",
  "scope": "src/importer/dates.ts and tests/importer/dates.test.ts only. Apply the fix to every parse path in that file, not just the one the failing test exercises. Out of scope: the exporter, shared date utils, formatting anywhere else — those stay byte-identical.",
  "anchors": [
    "src/importer/dates.ts",
    "tests/importer/dates.test.ts",
    ".maestro/missions/m-0412/artifacts/date-bug-findings.md"
  ],
  "acceptance": "npm test -- importer exits 0; the previously passing suite shows no new failures.",
  "freshness": "The findings artifact is from this mission and current. Re-read both source anchors yourself before editing; do not trust any summary of their contents, including the findings file's excerpts.",
  "tier": "standard",
  "return_format": "Six-field envelope. artifact = your worktree branch name; commit after each coherent step and append a checkpoint via mission.js checkpoint.",
  "stop_condition": "Return blocked if the fix requires changing shared date utils or any exported interface — that widens the contract and is a liaison decision. Return partial with a checkpoint if you hit the acceptance command failing for reasons unrelated to dates."
}
```

## Example brief — Scout

```json
{
  "outcome": "A findings file answering: where is session state persisted today, and what concretely breaks if it moves to Redis.",
  "scope": "Read-only investigation across src/session/ and src/config/ — cover every persistence call site in both, not only the first ones found. No code changes, no fixes even for bugs noticed along the way; record those as findings instead.",
  "anchors": [
    "src/session/",
    "src/config/stores.ts"
  ],
  "freshness": "No prior artifacts exist for this question; everything comes from reading current source. Cite what you read, not what you infer.",
  "tier": "recon",
  "acceptance": "The findings file exists at .maestro/missions/m-0413/artifacts/session-state-findings.md and every claim in it carries a file:line citation.",
  "return_format": "Six-field envelope; artifact = the findings file path. Findings only in the file — the envelope carries conclusions, not the survey.",
  "stop_condition": "Stop when every call site is cited. If the surface exceeds roughly 40 files, return partial with what is cited so far and name the uncovered area — sizing the remainder is a dispatch decision, not a reason to grind."
}
```

## Seat routing

| Seat | Model / family | Route here for | Reviews work from |
|---|---|---|---|
| `scout` | Sonnet 5 (claude) | Codebase recon, file/symbol location; artifact = findings file | — |
| `researcher` | Sonnet 5 (claude) | Docs-first deep research; artifact = citation-anchored note | — |
| `planner` | Opus 5 (claude) | Goal → validated briefs + acceptance criteria | — |
| `context-keeper` | Opus 5 (claude) | Per-mission memory; mailbox consults, verdict + file:line anchor | — |
| `executor-sol` | Sonnet 5 hosting GPT-5.6-Sol (gpt) | Default implementer | — |
| `executor-claude` | Opus 5 (claude) | UI/creative work; degraded-mode substitute; TDD where tests exist | — |
| `executor-gemini` | Sonnet 5 hosting Gemini 3.1 Pro (gemini) | Large-context and rotation implementation | — |
| `reviewer-claude` | Sonnet 5 (claude) | — | gpt- and gemini-authored work |
| `reviewer-sol` | Sonnet 5 hosting Sol (gpt) | — | claude- and gemini-authored work |
| `reviewer-gemini` | Sonnet 5 hosting Gemini (gemini) | — | claude- and gpt-authored work |
| `convergence` | Fable 5 high hosting Sol (claude+gpt); Opus 5 high on the Fable side when Fable is unavailable | Both convergence moments: ladder step 2 (two-seat consensus on a disputed judgment) and direction-setting plans | — |
| `plan-counterpart` | Sonnet 5 high hosting Sol (gpt) | The plan moment's second family: challenges a plan at standard rigor, drafts a rival plan at full. Spawned by `convergence`, not by the liaison | — |
| `crystallizer` | Sonnet 5 (claude) | Sealed corpus → bounded artifact the liaison may read | — |
| `handoff-recorder` | Sonnet 5 (claude) | One stop, one record; runs the stop writer only | — |
| `fleet-medic` | Sonnet 5 (claude) | Roster-vs-TaskList reconciliation sweeps | — |

Review routing is a law, not a preference: the reviewer's model family always
differs from the implementer's, because same-family review inherits the
author's blind spots — correlated models miss correlated bugs. The
close-record writer refuses `review.family == author_family` structurally, so
routing a same-family review just fails later; route it correctly at dispatch.

Live routing (including which seats are currently degraded) is data, not this
table: `routing.js active <treeRoot>` (and `routing.js review-for <treeRoot>
<author_family> [class] [author_model] [--json]` for the routed reviewer —
class-aware, and `--json` returns the full resolution bundle with its
independence label). When a codex or gemini probe is down, or the operator
has set that provider's lane to `operator-down` in settings (either cause
composes through the same degraded tables, each carrying its own notice),
the tables substitute same-family Claude seats — and every substituted
dispatch's envelope carries a one-sentence decorrelation-cost notice in
`risks`, so nobody mistakes a degraded review chain for a full one.

## Worktree isolation

Anything that mutates the project runs in an isolated worktree via the Agent
tool's isolation option (executor seats declare `isolation: worktree` in
their agent frontmatter, so spawning the seat is enough). Size is not the
test — a two-line fix takes the same route, because the route is what leaves
the trail; the only exception is an exact edit the operator named (the
mutation law in intake.md). Isolation is what
makes the concurrency doctrine safe — overlapping work becomes a visible
merge-time conflict instead of two workers silently interleaving writes — and
it is what makes the landing procedure meaningful: nothing reaches the real
tree except through the liaison's merge after review.

Read-only seats (scout, researcher, reviewers) need no worktree; they read
the tree in place and write only under `.maestro/missions/<id>/artifacts/`.

## Roster registration

Register every spawn immediately: `roster.js register <treeRoot> ...` with
seat, task id, family, and the continuity handles (`codex_session` for Sol
seats, which do resume; `gemini_handle` for Gemini seats, which do not — it
holds the saved dispatch prompt and hash a re-dispatch reconstructs from). The roster exists so that
continuity never depends on liaison memory: resume-don't-respawn
(`references/supervision.md`) and restart recovery (`references/recovery.md`)
both look up handles in `roster.json`, and a worker that was never registered
is a worker recovery cannot find.

## Parallel by default

Dispatch every independent track the moment its brief validates. Serialization
is the exception and needs one of the three concrete reasons from
`references/intake.md` (semantic dependency, shared mutable external state,
incompatible migration). The fleet ceiling in `settings.json` is the only
numeric limit. While workers run, the liaison keeps working — supervision is
event-driven, and waiting idle on a running worker is spending session
lifetime on nothing.
