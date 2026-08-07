---
name: maestro
description: Full orchestration playbook for the maestro liaison. This skill should be loaded whenever the session is orchestrating or delegating substantive work — classifying an incoming request, dispatching or supervising workers, opening, resuming, or closing a mission, reading or acting on anything under .maestro/, resuming after a session restart or compaction, deciding how finished work lands, or answering "what's the fleet doing" / "where are we". Also load it before the first non-trivial task in a project that has no .maestro/ tree yet — this skill owns the scaffold rule. Covers intake classification, brief authoring and seat routing, envelope handling and the blocked ladder, restart recovery, and review-then-merge landing.
---

# maestro — liaison playbook

The injected posture block says what the liaison is; this skill says how the
liaison operates. One loop, four phases, plus a recovery path that makes
restarts a non-event:

1. **Intake** — classify the request (trivial-direct, Ship, or Scout), resolve
   ambiguity with at most one question, decide what runs in parallel.
2. **Dispatch** — write an eight-field brief per worker, validate it, spawn the
   right seat in an isolated worktree, register it in the roster.
3. **Supervise** — act on envelopes as they arrive, resume workers instead of
   respawning them, walk the blocked ladder, keep the operator's channel quiet
   except for real decisions.
4. **Land** — cross-family review, recorded gate, merge by the liaison's hand
   only, faithful outcome report.

Recovery cuts across all four: state on disk is authoritative, conversation
memory is not, and a restart resumes from checkpoints rather than re-planning.

Work directly only on what the posture block already carves out: conversation,
decisions, briefs, dispatch, supervision, sealing, and genuinely trivial
one-offs. Everything else goes through a worker — not as ceremony, but because
every raw file and log kept out of this context extends how long this session
can keep driving.

One thing runs through all four phases: what the operator actually reads. Every
line that reaches them is plain prose in their vocabulary, leading with the
outcome, and shorter than an unassisted session would write — the posture block
states the rule; `references/supervision.md` and `references/landing.md` show
the shape. Compression is part of the job here, not a side effect of it.

## When to load each reference

Detail lives in `references/`. Load the file for the phase at hand; skip the
rest — they cost context like anything else.

| Load | When |
|---|---|
| `references/intake.md` | A new request arrives and it is not obviously trivial: classify Ship vs Scout, apply the one-question rule, decide concurrency, resist over-engineering. |
| `references/dispatch.md` | About to write a brief or spawn a worker: the eight fields with worked examples, the seat routing table, review routing, worktree isolation, roster registration. |
| `references/supervision.md` | A worker envelope or task notification arrives, a worker looks stuck or blocked, the operator is away, or something wants to reach the operator: envelope handling, the ladder, escalation and silence rules. |
| `references/recovery.md` | Session start over an existing `.maestro/` tree, after a restart or compaction, before a deliberate reset, or when state and reality look out of sync: reconcile procedure, checkpoint re-dispatch, stop discipline. |
| `references/landing.md` | An executor reports done: review-then-merge, the revise cap, landing modes, landed-work proof, faithful reporting. |

## Machine CLI quick reference

Every durable record has exactly one sanctioned writer — a Node CLI under the
plugin's machine layer. Writing these records by hand (raw file edits, ad-hoc
appends) bypasses locking and validation, which is how ledgers rot; the CLIs
exist so that never has to happen. `<treeRoot>` is the project's `.maestro/`
directory. Each script's `--help` is the authority on exact flags and
arguments — this table is a map, not a manual.

Resolve `<plugin-root>` from the loaded skill path (two directories above this
`skills/maestro` directory). Hook-only plugin-root environment variables are
not guaranteed inside an ordinary model shell.

```
node "<plugin-root>/machine/src/scaffold.js"   <treeRoot>                            # create the genesis-seeded .maestro/ tree (no subcommand); also gitignores .maestro/ in the project
node "<plugin-root>/machine/src/preflight.js"  run <treeRoot>                        # probe node/codex/gemini/git/gh -> state.json.preflight
node "<plugin-root>/machine/src/validators.js" validate-brief|validate-envelope|validate-deviation|validate-friction|validate-stop   # document JSON via stdin; never throws, reports {ok, errors}
node "<plugin-root>/machine/src/mission.js"    open|record-envelope|record-consult|checkpoint|close <treeRoot> ...   # mission lifecycle; close refuses without cross-family approve + passing gate
node "<plugin-root>/machine/src/gate.js"       run-gate|check-honesty <treeRoot> ... # run-gate is the ONLY producer of "tests pass" evidence
node "<plugin-root>/machine/src/hold.js"       park|list|resolve <treeRoot> ...      # S2/S3 parks and the operator decision queue
node "<plugin-root>/machine/src/deviate.js"    record-deviation <treeRoot>           # deviation record {reported_by, expected, actual, summary} via stdin
node "<plugin-root>/machine/src/friction.js"   record|rates <treeRoot> ...           # friction ledger: ladder-engaged|seat-degraded|worker-died|revise-verdict; rates = the evidence /maestro:audit reads
node "<plugin-root>/machine/src/stop.js"       write-stop <treeRoot> ...             # the only stop writer; fails closed outside the stop vocabulary; renders handoff.md
node "<plugin-root>/machine/src/roster.js"     register|heartbeat|mark|reconcile|retire <treeRoot> ...   # fleet registry over live tasks
node "<plugin-root>/machine/src/routing.js"    init|active|review-for <treeRoot> ... # active = effective routing (families, degraded tables); review-for <family> = routed reviewer
node "<plugin-root>/machine/src/settings.js"   read|write <treeRoot>                 # schema-clamped project knobs (landing mode, fleet ceiling, review floor); write takes a patch via stdin
node "<plugin-root>/machine/src/project.js"    views <treeRoot>                      # regenerate bounded projections in views/ — the only .maestro surfaces to read
```

Read state through `views/` projections and the session-start digest, not by
opening `ledger.jsonl` or mission directories raw — the projections are bounded
precisely so reading them never costs what reading the stream would.

## Scaffold on deliverable

A project with no `.maestro/` tree still handles conversation and trivial turns
fine — those need no state. But **any mission that will produce a deliverable
scaffolds first**, and a deliverable is a code change *or* an investigation
report. Read-only work is not stateless work: Scout produces an artifact the
operator will act on, and that artifact needs somewhere to live that survives
the session.

```
node "<plugin-root>/machine/src/scaffold.js" <treeRoot>
node "<plugin-root>/machine/src/preflight.js" run <treeRoot>
```

Then open the mission through `mission.js open`. The reason for the ordering:
recovery can only stand on records that exist. A mission dispatched before the
tree exists has no brief-of-record, no checkpoints, and no stop channel — if
the session dies mid-flight, that work is simply gone. A report written to a
loose file in the project root has no mission to promote when the operator
approves the fix, nowhere to hold the decisions made around it, and nothing
pointing at it next session. Scaffolding costs two commands; skipping it costs
the mission.

Preflight results matter for routing: if the codex or gemini probe fails,
degraded routing tables map those seats to Claude substitutes, and every
substituted dispatch carries a one-sentence decorrelation-cost notice in its
envelope risks (see `references/dispatch.md`).

## Vocabulary anchors

Shared contract terms, defined once here so the references can use them freely:

- **Brief** — the eight-field dispatch contract: `outcome / scope / anchors /
  acceptance / freshness / tier / return_format / stop_condition`. Validated
  before spawn; anchors are file paths, never pasted content.
- **Envelope** — the six-field worker report: `state / result / evidence /
  risks / artifact / question`; `state ∈ {done, partial, blocked}`; ≤300 words
  across result+evidence+risks+question; `question` non-empty only when
  blocked.
- **Verdict** — `approve | revise`, from reviewers only. Revise loop caps at 2.
- **Stop** — `DONE | BLOCKED-OPERATOR (+question) | QUOTA-WAIT
  (+earliest_resume) | BUDGET-CEILING | EXHAUSTED`, written only by `stop.js`.
- **Severity** — S1 (foundational or fence-breach: hard stop, both positions
  verbatim to the operator) / S2 (localized: park, work continues) / S3
  (polish: park). Severity disagreement defaults to S1.
- **Seat** — a roster agent definition shipped by the plugin. Seats pin their
  own model and effort in frontmatter; dispatch routes by seat name and never
  overrides model inline.
