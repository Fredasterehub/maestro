# Dispatch — briefs, seats, worktrees, roster

A dispatch is a contract, not a message. The brief is validated before spawn
because a worker holding a malformed contract produces malformed work — and
per the contract, a worker that receives an invalid brief returns `blocked`
naming the validator errors instead of guessing at intent.

Flow: write the brief → `validators.js validate-brief` (brief JSON via
stdin) → `mission.js open` — every write below targets this mission and
`route.js` refuses against one that isn't open → `routing.js tier-for`,
which resolves the author seat and its reviewer together → `route.js
reserve` for the author phase, carrying the reserved review capacity →
spawn the seat (worktree isolation for anything that mutates) → `roster.js
register`. On author completion: compute the
artifact identity → `route.js reserve-review`, naming that identity →
dispatch the review. See "Dispatching through the route lifecycle" below for
the full shape of that sequence. For small ship tasks the liaison writes the
brief directly; for goal-shaped work, dispatch the `planner` seat and it
returns validated briefs plus acceptance criteria.

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

## Dispatching through the route lifecycle

Every dispatch — ship or goal-shaped — routes through `route.js` before a
worker ever spawns. Some of the order below is machine-enforced — the writer
that receives the next call refuses one that arrives out of turn — and that
enforcement is noted at the point of each claim; where nothing yet consults
the record before it, that is noted just as plainly, because a step this
document states and the machine does not check is only as reliable as the
liaison following it.

1. `mission.js open`, if the mission isn't already. Every step below writes
   against this mission, and `route.js reserve` refuses one that isn't open
   (`route.js`'s `requireOpenInState`) — the one enforced fact behind
   route-before-spawn today; nothing yet checks that a spawn didn't happen
   first.
2. `routing.js tier-for <treeRoot> <briefPath> [--escalated]` — the author
   seat and the reviewer behind it, resolved together from the brief's own
   `tier`. It validates the brief again, walks that class's candidate
   ladder in preference order (recording each rung it could not try, with
   reason `lane-down` or `capability-absent`), resolves the review half
   through the same resolver step 3 names, and prints the whole topology:
   seat, worker model+effort, host model+effort or null, `review {seat,
   family, model, effort, independence}`, `candidates_skipped`,
   `lane_state`, `degraded_modes`, `notices`, and the routing config,
   digest and revision both halves resolved under. **It refuses instead of
   emitting when the route could not lawfully close** — no resolvable
   review, or the operator's `degraded_review: "hold"` posture — so a
   dispatch that could never land is stopped before a worker exists rather
   than after the work does. Escalation rungs are unreachable here: a fresh
   resolution names them in `escalation_withheld`, and `--escalated` walks
   them instead. The flag is convenience input, never authority — `route.js`
   refuses an escalation profile on a route with no predecessor to escalate
   from.
3. The reviewer arrives inside step 2's output; `routing.js review-for
   <treeRoot> <author_family> [class] [author_model] --json` is the same
   resolution on its own, for a caller that has an author already and needs
   only the reviewer — it returns the whole `reserved_review` bundle in one
   call (`seat`, `family`, `model`, `effort`, `independence`, cross-family
   by law), and the bare two-argument form, with no `--json`, prints only
   the reviewer *seat*. Under degraded modes the resolved reviewer may be a
   same-family seat labeled `independence: "degraded-path"` instead — see
   "Seat routing" below.
4. `route.js reserve` — writes the author-phase route record, which already
   carries the resolved reviewer as `reserved_review`. This is the step that
   needs the open mission from step 1.
5. Spawn the seat.
6. `roster.js register`, naming the author route this dispatch belongs to
   with `route_seq` (Slice 2c's addition to `REGISTER_OPTIONAL_KEYS`; see
   "Roster registration" below for the full call shape). Nothing here is
   machine-enforced yet: `roster.js register` validates `route_seq` only as
   a shape — a nonnegative integer — and consults no route record, so a
   registration naming the wrong seq, or none at all, is accepted today,
   not refused.
7. On author completion: compute the artifact identity — the
   `{source_head, source_tree, patch_digest, dirty}` object `gate.js`'s
   `artifactIdentity` helper produces and `route.js` validates (there is no
   separate CLI subcommand for it; the liaison calls the same helper
   `run-gate` uses internally) → `route.js reserve-review`, naming that
   identity, the author route it reviews, and `author_dispatch_seq` (the
   roster dispatch record this last field names is Slice 7a's; until it
   exists, `reserve-review` validates it only as a shape — any non-negative
   integer, commonly `0` — never resolving it against a real record) →
   dispatch the review. Inside a workflow, a chained review step reserves
   this same review route itself, as its own first action (recorded
   resolution, operator hold open) — see "Workflow transport" below; there
   is no pre-launch review reservation.

The author pick is no longer liaison judgment against the seat table below:
`tier-for` reads it out of the routing config's own class ladders, and the
table is there to be read, not to be routed from by hand. One field in the
sequence is still pending, for a reason distinct from `route_seq` (step 6's
`roster.js register` accepts that key today, Slice 2c having added it) —
`author_dispatch_seq`'s real binding in step 7 waits on a writer that
doesn't exist at all — the roster dispatch ledger record Slice 7a adds. It
is named at the point the call needs it, not only in a later paragraph.

One shape note where step 2 meets step 4: `tier-for`'s `notices` are the
routing layer's verbatim text, while the route record's own `notices` field
holds short single-line summaries (200 characters each). The liaison
composes the record's notices from the topology's rather than passing them
through.

## Writing for the seat's model

Seats pin `model` (alias) and `effort` in their agent frontmatter — dispatch
routes by seat name and never overrides model inline. What varies is how the
brief is worded:

- **Sonnet 5 seats** (`scout`, `researcher`, `executor-claude-mech`,
  `executor-claude-standard`, `reviewer-claude`, `reviewer-degraded-sonnet`,
  every hosted executor and reviewer — the gpt ladder (`executor-luna`,
  `executor-terra`, `executor-sol-expert`, `executor-sol-apex`,
  `reviewer-terra`, `reviewer-sol-expert-rev`, `reviewer-sol-apex-rev`) and
  `executor-gemini`/`reviewer-gemini` — plus `plan-counterpart`,
  `crystallizer`, `handoff-recorder`, `fleet-medic`) follow scope
  literally and will not generalize an instruction beyond what it says. State
  scope exhaustively: "every call site, not just the first", "all three
  config files", "the whole directory". A scope they were not told about is a
  scope they will not touch.
- **Opus 5 seats** (`executor-claude`, `context-keeper`, `reviewer-claude-expert`,
  `reviewer-degraded-opus`, `reviewer-degraded-opus-apex`) do their
  best work given the complete specification up front and left to run. Do
  **not** add "double-check your work", "verify before returning", or a final
  self-review step — Opus 5 already self-verifies, and instructing it to
  causes over-verification: slower, no better. Acceptance criteria are fine;
  they are a gate, not a ritual.
- **Fable 5 seats** (`planner`, `convergence`, `executor-fable-low`,
  `executor-fable`, `reviewer-claude-apex`, `reviewer-degraded-fable-apex`)
  have no wording guidance of their own yet — none of these placements has
  run long enough for a revise-rate signal to say whether Opus 5's guidance
  above transfers. Until it does, write for them as an Opus 5 seat: complete
  specification up front, no added self-review ritual.
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
| `scout` | Sonnet 5 medium (claude) | Codebase recon, file/symbol location; artifact = findings file | — |
| `researcher` | Sonnet 5 high (claude) | Docs-first deep research; artifact = citation-anchored note | — |
| `planner` | Fable 5 low (claude), fallback Opus 5 high | Goal → validated briefs + acceptance criteria | — |
| `context-keeper` | Opus 5 high (claude) | Per-mission memory; mailbox consults, verdict + file:line anchor | — |
| `executor-claude-mech` | Sonnet 5 low (claude) | Mechanical class: exact, enumerated, command-verifiable edits, no delegated judgment | — |
| `executor-claude-standard` | Sonnet 5 high (claude) | Standard class: bounded features/fixes on established patterns, local blast radius | — |
| `executor-claude` | Opus 5 high (claude) | UI/creative work; degraded-mode substitute; TDD where tests exist | — |
| `executor-fable-low` | Fable 5 low (claude), fallback Opus 5 high | Expert-class escalation only, reached after opus expert work is defeated — never first-dispatched | — |
| `executor-fable` | Fable 5 high (claude), fallback Opus 5 high | Apex class: foundational ambiguity, external-contract blast radius, destructive reversibility, hard fences | — |
| `executor-gemini` | Sonnet 5 high hosting Gemini 3.1 Pro (gemini) | Large-context and rotation implementation | — |
| `executor-luna` | Sonnet 5 low hosting GPT-5.6-Luna (gpt) — dormant until the gpt lane is effective | Mechanical class, gpt ladder | — |
| `executor-terra` | Sonnet 5 medium hosting GPT-5.6-Terra (gpt) — dormant until the gpt lane is effective | Standard class, gpt ladder | — |
| `executor-sol-expert` | Sonnet 5 medium hosting GPT-5.6-Sol (gpt) — dormant until the gpt lane is effective | Expert class, gpt ladder; profile-split successor of the `executor-sol` alias below | — |
| `executor-sol-apex` | Sonnet 5 high hosting GPT-5.6-Sol (gpt) — dormant until the gpt lane is effective | Apex class, gpt ladder | — |
| `executor-sol` | — | Alias of `executor-sol-expert` since the r1→r2 Sol split. No read path resolves an alias — it is never routable. | — |
| `reviewer-claude` | Sonnet 5 high (claude) | — | recon/mechanical/standard-class gpt- and gemini-authored work |
| `reviewer-claude-expert` | Opus 5 high (claude) | — | expert-class gpt- and gemini-authored work |
| `reviewer-claude-apex` | Fable 5 low (claude), fallback Opus 5 high | — | apex-class gpt- and gemini-authored work |
| `reviewer-gemini` | Sonnet 5 medium hosting Gemini (gemini) | — | recon/mechanical/standard-class claude- and gpt-authored work — gemini is not qualified above standard (operator restriction, 2026-08-07); expert/apex claude-authored work falls to the degraded path, expert/apex gpt-authored work routes to `reviewer-claude-expert`/`reviewer-claude-apex` instead |
| `reviewer-terra` | Sonnet 5 medium host, GPT-5.6-Terra high guest (gpt) — dormant until the gpt lane is effective | — | recon/mechanical/standard-class claude- and gemini-authored work |
| `reviewer-sol-expert-rev` | Sonnet 5 medium hosting GPT-5.6-Sol (gpt) — dormant until the gpt lane is effective | — | expert-class claude- and gemini-authored work; profile-split successor of the `reviewer-sol` alias below |
| `reviewer-sol-apex-rev` | Sonnet 5 high hosting GPT-5.6-Sol (gpt) — dormant until the gpt lane is effective | — | apex-class claude- and gemini-authored work |
| `reviewer-sol` | — | Alias of `reviewer-sol-expert-rev` since the r1→r2 Sol split. No read path resolves an alias — it is never routable. | — |
| `reviewer-degraded-opus` | Opus 5 medium (claude) | — | degraded path only: sonnet-authored recon/mechanical/standard work, when no cross-family reviewer is effectively available |
| `reviewer-degraded-sonnet` | Sonnet 5 high (claude) | — | degraded path only: opus- or fable-authored expert work |
| `reviewer-degraded-opus-apex` | Opus 5 high (claude) | — | degraded path only: fable-authored apex work (preferred heavy-model pairing) |
| `reviewer-degraded-fable-apex` | Fable 5 low (claude) — no seat-level fallback; an unavailable pairing partner is resolved by `reviewFor` to a fresh instance of the author's own model (opus-5 high, since this seat only reviews opus-authored apex work) | — | degraded path only: opus-authored apex work (preferred heavy-model pairing) |
| `convergence` | Fable 5 low (claude), fallback Opus 5 high; dispatches Sol or Gemini directly for the second family | Both convergence moments: ladder step 2 (two-seat consensus on a disputed judgment) and direction-setting plans | — |
| `plan-counterpart` | Sonnet 5 high hosting Sol (gpt) | The plan moment's second family: challenges a plan at standard rigor, drafts a rival plan at full. Spawned by `convergence`, not by the liaison | — |
| `crystallizer` | Sonnet 5 high (claude) | Sealed corpus → bounded artifact the liaison may read | — |
| `handoff-recorder` | Sonnet 5 medium (claude) | One stop, one record; runs the stop writer only | — |
| `fleet-medic` | Sonnet 5 medium (claude) | Roster-vs-TaskList reconciliation sweeps | — |

Review routing is a law, not a preference: the reviewer's model family always
differs from the implementer's, because same-family review inherits the
author's blind spots — correlated models miss correlated bugs. Close derives
both families from the route records, never from caller prose, and refuses a
review labeled `independence: "cross-family"` whose reviewer family matches
the author's — a laundered label. A route legitimately taken through the
degraded path is labeled `degraded-path` instead, and close accepts that
label only when the author route's own snapshot recorded a degraded mode —
the degraded path is authorized by what was recorded before the author ran,
never by the review label alone. Close also refuses a review whose seat,
family, model, effort, or independence deviates from the `reserved_review`
capacity the author route recorded, unless the deviation carries a
`replacement_reason` — a second way to route a reviewer wrongly at dispatch
and only discover it at close. `independence` is the field this covers most
often: a reservation taken cross-family whose lane is lost while the author
runs is reviewed on the degraded path instead, and it closes only because a
`replacement_reason` is recorded. Close can catch a dishonest or unexplained
label, not fix a wrong one — route the reviewer correctly at dispatch.

A same-model degraded fallback is a different fact and takes different
fields. The degraded path is a preference ladder: when the preferred
cross-model reviewer is unavailable, a second fresh instance of the author's
own model reviews instead. The seat is unchanged there — only the model
behind it fell back — so that is recorded as `fallback_used: true` with a
`fallback_reason` on the review route, the same pair the author-phase
outcome record uses, never as a `replacement_reason`.

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

## Escalation policy

Re-dispatch is a recorded transition, not a judgment call. Every route that
names a predecessor declares a `transition` and a `reason`, and `route.js
supersede` decides whether that claim is legal **against the recorded chain**
— the ledger is the authority, never the caller's description of it. This
table mirrors what that code enforces; it adds no rule of its own.

| Transition | Reason it takes | What it must keep | Budget |
|---|---|---|---|
| `same-profile-resume` | `quality`, `infrastructure`, `quota` — never `safety-refusal` | same attempt, same profile, same brief; the record is marked `resumed` | one per mission on `quality` — **zero for `mechanical`**, which escalates instead of grinding |
| `same-class-provider-reroute` | any | same task class; new attempt | unlimited — infrastructure, quota and runtime trouble buy no quality escalation |
| `class-escalation` | `quality` only | a strictly higher task class; new attempt | shares the mission's single profile escalation |
| `within-class-profile-escalation` | `quality` only | the same class, with a genuinely changed profile; new attempt | shares that same single escalation |
| `convergence` | `quality` only | new attempt, adjudication route | where quality disagreement goes once the escalation is spent |

The rules that cut across the table:

- **One escalation per mission.** The two escalation transitions draw on one
  budget, counted by distinct predecessor — a crash-orphaned replacement and
  the retry that follows it name the same predecessor and are charged once.
  After it, further quality disagreement is convergence.
- **Infrastructure never buys an escalation.** `infrastructure`, `quota` and a
  runtime retry reroute in class; naming one of them on an escalation or
  convergence transition is refused outright.
- **A safety refusal reroutes the unchanged brief.** It is a
  `same-class-provider-reroute` and the replacement must carry the same brief
  digest — the brief is never rewritten to get past a refusal.
- **Apex invents nothing above itself.** At apex both escalation transitions
  are refused: convergence or an operator decision, never a higher automatic
  effort.
- **The escalation claim is convenience input, never authority.** A route
  marked `escalation_profile: true` is legal only through an escalation
  transition, and never on a fresh route — an escalation-only seat is reached
  by superseding the route that defeated the ordinary one.
- **A review route is replaced in class.** Only
  `same-class-provider-reroute` supersedes a review-phase route, keeping the
  author route and attempt it judges; escalation is an author-profile concept.

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
seat, task id, family, the continuity handles (`codex_session` for Sol
seats, which do resume; `gemini_handle` for Gemini seats, which do not — it
holds the saved dispatch prompt and hash a re-dispatch reconstructs from),
and `route_seq` (Slice 2c's addition), naming the author route the entry
belongs to directly. Register right after `route.js reserve` (see
"Dispatching through the route lifecycle" above); nothing yet cross-checks
the seq against a real route record, so the field names the route but does
not yet bind to it.

The roster exists so that continuity never depends on liaison memory:
resume-don't-respawn (`references/supervision.md`) and restart recovery
(`references/recovery.md`) both look up handles in `roster.json`, and a
worker that was never registered is a worker recovery cannot find.

## Parallel by default

Dispatch every independent track the moment its brief validates. Serialization
is the exception and needs one of the three concrete reasons from
`references/intake.md` (semantic dependency, shared mutable external state,
incompatible migration). The fleet ceiling in `settings.json` is the only
numeric limit. While workers run, the liaison keeps working — supervision is
event-driven, and waiting idle on a running worker is spending session
lifetime on nothing.

## Workflow transport

A workflow is the preferred transport whenever a slice or a wave has two or
more independent routed steps; a bare single spawn stays correct for a lone
step with nothing to run beside it. `.claude-plugin/plugin.json` advertises
delegation to "background subagents, teams, and Workflows" — this section is
what makes the third one usable from a brief.

A workflow is a transport, never a routing decision. Routing still picks the
seat, its pinned model × effort, and the reviewer — a workflow step names
that seat and never re-profiles it. One workflow step per routed dispatch,
and each step's review is chained directly behind its own author, so a fast
track never waits on a slow sibling.

Author routes are reserved by the liaison before the workflow launches, one
per author route in the wave, unchanged from the bare-spawn flow — workflow
scripts have no filesystem access and cannot call `route.js` themselves, so
this is stricter than the bare-spawn flow's route-before-spawn, not looser.
Review routes are never reserved pre-launch, because `reserve-review` needs
a real artifact identity and no author has run yet to produce one. Instead,
a review route is reserved from the workflow's returned author artifact
identity — by the liaison, after the workflow returns, for a review that
isn't chained; or by the chained review step itself, as its own first
action (each step's agent has Bash, even though the workflow script that
launches it does not), for a review that runs inside the same workflow.
This is the recorded resolution of a real conflict with the binding operator
amendment's own rule for review routes under workflow transport
(execution-plan.md: "where a chained review must run inside the same
workflow, its route record is reserved in the same pre-launch pass and
bound to the author route it follows") — the resolution is recorded in the
plan correction "a chained review reserves its own route from inside its
step," parked as a hold for the operator to confirm or overrule — not
settled doctrine, and this is the paragraph to revisit if the operator
rules otherwise. Under this resolution, either way the review
route is real before the review it names ever dispatches — there is no
pre-launch review reservation, chained or not.

Gates, merges, and close stay with the liaison after the workflow returns —
a workflow orchestrates work, it never seals it. And structured returns
replace prose relay: workflow steps return schema-validated objects, so
envelopes and verdicts arrive as data rather than text to parse. The
six-field envelope and its word ceiling are unchanged.
