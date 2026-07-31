---
name: status
description: This skill should be used whenever the user asks "where are we", "status", "what's going on", "catch me up", "recap", "fleet status", "what needs me", "what did I miss", returns to the session after time away, or whenever a status digest is owed — after a restart, at the end of an away-mode stretch, or when the operator seems unsure what is in flight. Renders the complete four-bucket status digest (needs-your-action / recently done / self-progressing / queued) from machine views, strictly read-only. Skip it when the question is about one specific task's detail — answer that directly from its envelope.
---

# status — four-bucket status digest

Render one deterministic snapshot of everything maestro is tracking in this
project, organized by who must act next. This is the operator's re-grounding
surface: after time away, after a restart, or on request, it answers "what
needs me, what got done, what is running, what is waiting" in one pass.

Strictly read-only. Status never dispatches, resumes, merges, resolves,
reconciles, or scaffolds — a recap that quietly changes state can no longer be
trusted as a recap. When the snapshot reveals something that needs doing, name
the route (a hold to resolve, `/maestro:doctor`, a dispatch) as the item's
next decision; do not take it during this skill.

## Source

Regenerate the projections, then read only what they name:

```
node "${CLAUDE_PLUGIN_ROOT}/machine/src/project.js" views .maestro
```

Read the view files the command reports (under `.maestro/views/`). Views are
the only sanctioned read surface here — they exist precisely so a recap never
requires pulling raw ledger lines, envelopes, or worker transcripts into the
liaison's context. If a view seems stale or contradicts live task
notifications, report what the views say and flag the discrepancy as a
needs-your-action item pointing at `/maestro:doctor` — do not read around the
views to resolve it yourself.

If `.maestro/` does not exist, say so in one line, then render the same four
buckets from what the session can see live (task list, this conversation),
labeled "not disk-backed". The bucket contract holds even without the tree.

## The four buckets

Every tracked item lands in exactly one bucket — the buckets partition the
worker pool, they never overlap. When an item could arguably sit in two, the
bucket requiring operator action wins: underreporting a needed decision costs
more than an item looking slightly more urgent than it is.

Render all four buckets every single time, including empty ones, each with an
explicit "none" line. An empty bucket is a claim ("nothing needs you"); an
omitted bucket is ambiguity ("did it check?"). This applies to every render,
not only the first.

1. **Needs your action** — the operator is the blocker: work ready for
   review, finished investigation findings not yet seen, S1 verdicts (both
   positions verbatim), blockers that survived the ladder, holds explicitly
   awaiting an operator decision, needed credentials, pending confirmation of
   anything destructive or irreversible. Each item ends with the specific
   decision or input requested.
2. **Recently done** — sealed since the operator was last demonstrably up to
   date: merged work, closed missions, resolved holds. One line each: outcome
   and consequence. When unsure whether something was already seen, include
   it — a repeated line is cheap, a silently dropped outcome is not.
3. **Self-progressing** — live workers with a live supervising path. No one
   needs to act; results will arrive via task notifications. State what each
   is doing and its last checkpoint, nothing more — no retry narration, no
   supervision mechanics.
4. **Queued** — waiting on something that is neither the operator nor a
   running worker: parked S2/S3 holds, quota-waits (with earliest resume),
   validated-but-undispatched briefs, work blocked on a dependency. Name what
   each item waits for.

## Rendering rules

- **Complete snapshot, never a delta.** Render the full state every time,
  even when most of it was shown an hour ago. The operator may have missed
  the previous recap; a delta silently presumes they didn't.
- **Operator nouns.** Outcome, consequence, next decision — in the user's
  vocabulary. Envelope, seat, worktree, brief stay internal; "the auth
  refactor is merged and deployed to staging" beats any of them.
- **Cite artifacts, not transcripts.** When an item points at material worth
  reading, give the artifact path an envelope named — never a paraphrase of
  worker prose presented as fact, never a transcript.
- **Deterministic ordering.** Buckets in the order above; items within a
  bucket ordered as the views list them. Same state, same digest — the
  operator should be able to diff two renders by eye.
- Lead with bucket 1. If it is empty, say so in the first line — "nothing
  needs you" is the single most valuable sentence this skill can produce.

## Output skeleton

```
Needs your action (2)
- <item>: <outcome so far> — <the decision or input requested>
Recently done (1)
- <item>: <outcome and consequence>
Self-progressing (3)
- <item>: <what it is doing> — last checkpoint: <step>
Queued (1)
- <item>: waiting on <what>
```

Counts in headers, "none" for empty buckets, no preamble before the first
bucket and no summary after the last — the digest is the message.
