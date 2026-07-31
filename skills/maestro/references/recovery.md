# Recovery — restart as a non-event

The design goal: killing the liaison session at any moment costs at most one
checkpoint of work. That holds only if disk is authoritative and conversation
memory is not — durable records and live task inventory outrank anything the
previous session "knew". Recovery is therefore reconciliation, not
re-planning: the plan already exists in briefs and checkpoints; the only
question is what is actually still running and what is actually still missing.

## state.json is the sole resume pointer

`.maestro/state.json` — `{missions: {id: {status, next_action}}, active_mission,
preflight, last_stop}` — is the one place resume starts. The ledger is
evidence, never the pointer: replaying `ledger.jsonl` to figure out "where
were we" spends context reconstructing what `state.json` already says in a
dozen lines. If state.json and the ledger disagree, that is a real
inconsistency to fix (via the machine CLIs), not a reason to trust the longer
document.

## Trust the SessionStart digest

The SessionStart hook prints the read-once digest: state summary, open
missions, roster pointer, unresolved holds. Trust it and do not re-read the
sources it printed — the digest exists precisely so session start costs one
read instead of many. Re-open a source only for corruption or a targeted need
the digest cannot answer (e.g. a specific mission's full checkpoint list).
This applies after compaction too: the hook re-fires on compact, so the
posture and digest survive without manual re-reading.

## Roster reconcile procedure

First act over an existing tree after restart:

1. `roster.js reconcile <treeRoot>` — match roster entries against the live
   task list (dispatch `fleet-medic` for the sweep if the picture is large).
2. Entries with a live task: leave them alone; they are still working and
   will report. Reattach supervision by trusting their next envelope, not by
   messaging them "are you alive" — an unprompted ping costs the worker a
   turn and answers nothing an envelope would not.
3. Entries whose task died: candidates for checkpoint re-dispatch (below).
4. Tasks alive but absent from the roster: register them now — unregistered
   work is invisible to every future recovery.

If the operator intervened directly in a worker session while the liaison was
down, that intervention is authoritative input to reconcile — fold it in;
it is not a topology violation to correct.

## Checkpoint-based re-dispatch

For each open mission whose worker died, establish what survived: the last
records in `missions/<id>/progress.jsonl`, plus `git log` in the worker's
worktree (workers commit after every coherent step, so the worktree is a
checkpoint record in itself). Then re-dispatch with the **same brief** plus a
brief addendum — never a rewritten brief, because the brief-of-record is what
the mission's acceptance and review are anchored to:

```
Addendum to the brief above — this is a resumption, not a fresh start.
Already done (verified from checkpoints and worktree commits):
  - <step>: <done_evidence>
  - <step>: <done_evidence>
Continue from: <next from the last checkpoint record>.
Do not redo the completed steps; build on the existing worktree commits.
```

Redo the missing part, never the whole task. Recovery cost is bounded by
checkpoint granularity, not by task size — which is also why executors are
briefed to checkpoint via `mission.js checkpoint` after every coherent step
in the first place.

Continuity handles come from `roster.json`, never from memory: a surviving
Claude task resumes via SendMessage to its transcript handle; a Sol worker's
hosted session resumes via its stored `codex_session`. Gemini seats have no
session to resume — their `gemini_handle` records the saved dispatch prompt
and its hash, so recovery is re-dispatch from that prompt, not continuation.
Only when no live path exists does re-dispatch spawn a fresh seat.

## The resume report

Recovery is invisible to the operator unless you say what it recovered. Work
that spanned a restart names the inherited thing — by its real name, in the
reply's first sentence:

> `formatReceipt` was already committed from the last session; this session
> added the tests and landed them.

Not "the earlier work", not "what was already there": the function, the file,
the endpoint, named. The test is a reader who saw neither session — from that
one sentence they can list what each session did. If your sentence fails that
test it is still the abstract version, however carefully it splits the halves.
Reporting the mission as one undifferentiated accomplishment ("added receipt
formatting with tests") is not false, but it hides the thing the operator most
wants to know after a crash: that nothing was redone and nothing was lost. It
also quietly takes credit for work they already paid for, which makes the next
estimate wrong.

Then the whole board, one plain sentence: what is done, what is still running,
what is waiting on them. After a restart the operator's mental model is stale
by definition — the item outcome alone leaves them worse informed than a
status recap would.

Register: their vocabulary, not the recovery machinery's. They do not need to
hear "reconciled the roster", "re-dispatched from the last checkpoint", or
"the worktree survived". Compare:

```
GOOD  Picked the receipt work back up where it stopped — the endpoint and the
      migration were already committed from before, so this session only
      needed the validation tests, which pass now. Nothing was redone. The
      search mission is still running; nothing needs you.

BAD   Recovery complete. Reconciled roster against live tasks (1 dead seat),
      re-dispatched mission `add-receipt` from checkpoint 4 with brief
      addendum. Executor resumed, gate exit 0, cross-family approve, merged.
```

The second one describes the plumbing to someone who owns a product.

## Stop recording discipline

A stop that was narrated but not recorded did not happen. Every deliberate
halt, of every kind, is recorded by spawning the `handoff-recorder` seat with
the assembled stop payload — that seat runs `stop.js write-stop`, the sole
stop writer; the liaison never calls it directly and never writes the stop
fields itself — using only the stop vocabulary: `DONE | BLOCKED-OPERATOR (+question) | QUOTA-WAIT
(+earliest_resume) | BUDGET-CEILING | EXHAUSTED`. The writer fails closed on
anything outside that vocabulary and renders `handoff.md` as a side effect —
which is exactly why prose stops are worthless: the next session resumes from
records, and a stop that lives only in conversation text is invisible to it.

`QUOTA-WAIT` carries `earliest_resume` so the next session knows when trying
again becomes rational; `BLOCKED-OPERATOR` carries the question so the
operator can answer it without archaeology.

## /maestro:handoff before deliberate resets

Before any *deliberate* reset — `/clear`, ending a long session, switching
machines — run `/maestro:handoff`: it sweeps conversation-only knowledge
(decisions made verbally, constraints the operator stated, lessons learned)
into durable homes and records the stop. The crash path is covered by
checkpoints and state.json; handoff covers the one thing checkpoints cannot —
knowledge that exists only in the conversation. A reset without a handoff
silently deletes exactly the facts that were never written down, and those
are unrecoverable by definition.
