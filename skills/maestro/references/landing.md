# Landing — review, merge, and honest endings

Nothing reaches the real tree except through this procedure. The liaison is
the sole finisher — sole committer to the mainline, sole merger, sole closer
of missions — because a single landing hand is what makes "what changed and
why" answerable later, and what keeps a worker from ever landing its own
unreviewed work.

## Review-then-merge (default mode)

When an executor's envelope reports `done`:

1. **Route review cross-family.** Dispatch the reviewer seat whose model
   family differs from the author's (`reviewer-claude` for gpt/gemini work,
   `reviewer-sol` for claude/gemini work, `reviewer-gemini` for claude/gpt
   work). Same-family review inherits the author's blind spots — route it
   cross-family here. Close does not refuse a same-family review
   structurally; it refuses one dishonestly *labeled* `cross-family`, and
   accepts the same reviewer honestly labeled `degraded-path` only when the
   author route's own snapshot recorded a degraded mode (see "Seat routing"
   in `references/dispatch.md`). Getting the reviewer right at dispatch is
   what protects the mission — close is a backstop against a lie about the
   route, not against the route itself.
2. **Brief the reviewer for coverage.** Report every finding — including
   low-severity and uncertain ones — with confidence and severity per
   finding. Zero findings is a legitimate outcome and is reported as exactly
   that, not padded into invented nits. Never brief a reviewer to "only flag
   serious issues": these seats comply literally and recall drops; severity
   filtering is the liaison's job after the report.
3. **Act on the verdict.** Vocabulary is `approve | revise`, nothing else.
   Either way, record it first — `mission.js record-review` with
   `{review_route_seq, review_dispatch_seq, verdict, artifact_identity}` —
   binding the verdict to the exact review route and identity it judged,
   before anything else happens to the artifact. This is what makes the
   review-then-gate order real rather than a convention: a gate cited at
   close must not predate the approve it is supposed to have been run
   against, so the verdict is recorded here, not after the gate. Recording
   a revise the same way is what a rejected review being answered, not
   skipped, actually means for the route being closed — a revise never
   recorded is a revise close cannot see. These four keys are what a FIRST
   verdict on a review route needs. The ordinary revise-then-fix loop
   reserves a fresh review route for round two (`references/dispatch.md`'s
   route lifecycle — a new review dispatch, not a second verdict on the old
   route), so it needs nothing more; only a verdict that REPLACES the
   standing one on its own route needs three more keys —
   `supersedes_seq`, `reason`, `evidence_seq` naming a gate record that
   postdates and answers the verdict it replaces — and that path is for
   overturning a finding with new evidence, not for the loop above.
   - `approve` → then run the gate: `gate.js run-gate` against the mission's
     acceptance command. run-gate is the *only* producer of pass evidence —
     "tests pass" exists only as a recorded gate with exit code 0; a green
     run narrated in prose is a claim, not evidence.
   - `revise` → then record the round — `friction.js record` with
     `{kind: 'revise-verdict', mission_id, detail}` — then resume the
     **same executor** (resume-don't-respawn) with the findings as the fix
     list. Silent recording, no real-time line (`references/supervision.md`
     "Friction"); the round count surfaces in the landing note below.
4. **Merge and close.** With a recorded approve and a passing gate both on
   the ledger, the liaison merges the worktree into the mainline locally
   (squashing the worker's WIP checkpoints is fine — checkpoint commits
   served recovery, not history), then `mission.js close`. Close's stdin is
   nothing but sequence references — author, review, and gate seqs — and it
   derives what it enforces from the records those name: the recorded
   approve, the author and reviewer families, and the gate's exit code. One
   check is not a ledger derivation: close also proves, against the real
   repository named by `--repo` (the liaison's cwd when omitted), that the
   reviewed commit actually landed — by commit containment for an ordinary
   merge, by patch identity for a squash. Three things follow from that: the
   merge must land on `main` or `master`; close must be pointed at (or run
   from) the repository it landed in; and the reviewed commit must still be
   resolvable there when close runs — deleting the branch and pruning before
   closing makes the mission uncloseable. If close refuses, something in the
   procedure was skipped or a record disagrees with another; fix the record,
   do not work around the refusal. (Close's stdin is seven sequence
   references in total, not three — the author, author-dispatch, review, and
   review-dispatch seqs, the gate seq, and two winning-attempt seqs held
   equal to the review pair today; `mission.js --help` has the exact shape.)
5. **Report the outcome** — see "The landing note" below.

## The landing note

A few plain sentences, in the operator's vocabulary, carrying three things:

**What changed, in their product.** Not what the pipeline did — what is
different now that wasn't before, and why it was wrong. Lead with this; it is
the sentence they would ask for if they said "just tell me".

**The whole board, in one line.** What else is running, what is waiting on
them, what is done. A landing note that reports only the item that just landed
leaves the operator knowing one fact and not their situation; they have been
away, and one item is not a status. One sentence is enough: "Two other
missions are still going; nothing needs you." or "That was the last one — the
export question from earlier is still waiting on your call."

**What the mission cost, only when it is non-zero.** The revise round count and
the ladder's arbitration outcome (convergence consensus applied, or the
S1/S2/S3 it resolved to), both already on record (`friction.js rates`,
`hold.js list`) — this is where DECISIONS.md's Visibility section wants them
disclosed, batched here, never narrated as they happened. Zero rounds and no
ladder means say nothing; a clean landing does not need its cleanliness
itemized.

Everything else — the file list, the seat that did it, the branch name, the
gate command — goes in the artifact and the record, not the note. The operator
can ask, and asking is cheaper than reading past it every time.

**Then sweep it before you send it.** The rewrite table in
`references/supervision.md` ("How those lines read") is a pre-send check at
landing time, not a style note to apply when convenient: run the finished note
against the inside words — worktree, envelope, brief, seat, gate, tier, hold,
cross-family, mission ids — and translate every hit. "Reviewed cross-family,
green gate" goes out as "a second model checked it and the tests pass";
"mission `add-receipt` is closed" goes out as what the operator actually got.
Mission names are inside words too — name one only if the operator named it
first, since an id they never used is a lookup you just handed them. This is
the last thing the operator reads about a piece of work, so it is the line that
sets whether the next report gets trusted or re-read.

```
GOOD  The receipt endpoint is in and merged — it was rejecting valid dates
      because of a timezone assumption, and there's a test for that now. The
      reviewer sent it back once over error handling. Two other missions are
      still running; nothing needs you.

BAD   **Mission `add-receipt` — COMPLETE**
      1. Executor: executor-sol (isolated worktree)
      2. Cross-family review: approve after 1 revise round
      3. Gate: exit 0 (9/9)
      4. Merged to mainline, mission closed
      Ready for the next dispatch.
```

The bad one is not inaccurate. It is unreadable: every noun is the plugin's,
the numbering implies four things to act on when there are zero, and after
reading it the operator still doesn't know what changed in their product or
what the rest of the board looks like.

## Revise loop cap: 2

Each recorded `revise-verdict` is what the cap counts against — `friction.js
rates` reports the per-mission count directly, so the cap is checked against
the record, never a remembered tally. Two revise rounds maximum, then the
ladder (`references/supervision.md`) —
because a third round on the same disagreement is almost never new
information, it is the same two positions restated at higher cost. Repeated
same-theme findings across rounds are the classic fix-loop local minimum:
stop iterating and escalate the underlying question instead of paying for
round three. The ladder's convergence pass exists exactly for this: two
uninvolved families adjudicate what author and reviewer cannot settle.

## Landing modes per project

`settings.json` sets the project's landing mode — read it through
`settings.js read <treeRoot>` (the schema-clamped reader), before landing, not
after. The `landing` knob's values:

- **review-then-merge** (default) — the procedure above: local merge by the
  liaison after the cross-family approve and the recorded gate.
- **pr** — identical through the gate, but instead of merging locally the
  liaison pushes the branch and opens a PR; the merge decision belongs to
  the project's normal PR process. Report the full PR URL, never a bare
  number — a bare number makes the operator go look it up.
- **report-only** — no mutation lands at all; the deliverable is the
  reviewed diff plus the report. Used for projects maestro may not write to.

The mode changes where the work goes; it never changes the review floor.
Review-floor scale-down is banned by routing policy — a small diff still gets
its cross-family review, because diff size and blast radius are not the same
thing.

## Landed-work proof before cleanup

Never discard a worktree or branch until the work is provably reachable
somewhere durable: in the default branch, in a pushed remote branch, or in a
merged PR head — checked squash-merge-aware, since a squash rewrites hashes
and `branch --contains` alone will lie about it (compare patch-ids or the
PR's merged state instead). The check runs before every cleanup because
worktree deletion is the one irreversible step in the whole pipeline: every
other mistake in landing can be redone from records; deleting unlanded
commits cannot. Discarding genuinely unwanted work is the operator's call —
explicit, in-the-moment — never a cleanup side effect.

## Faithful outcome reporting

Report outcomes as they are, with evidence:

- Failed is failed — stated plainly, with the failing output or gate record,
  not softened into "mostly working".
- Untested is untested; a null result means NOT COMPUTED, never "probably
  fine".
- An unchanged fleet is not progress and is never dressed as an update.
- Skipped is skipped, named as such.

The reason is mechanical, not moral: the operator makes decisions on these
reports, and a flattering report converts their next decision into a mistake
made with confidence. Every claim in an outcome report should trace to a
record — an envelope, a gate, a merge commit — the same standard the liaison
holds its workers to.

**Never narrate a process event you have no record of.** "The review caught a
rounding bug", "the tests passed", "a worker rebuilt it" — each of those is a
claim about something that either exists on disk or does not. If there is no
reviewer verdict, no gate with exit 0, no envelope, the sentence claiming it
does not exist either: not softened, not hedged, not rephrased as "I verified".
Say what you actually did.

This is the one dishonesty that compounds. A flattering severity rating is a
bad estimate the operator can learn to discount; an invented review is a fact
they will build on. One fabricated "the review caught X" retroactively makes
every real review in the session unciteable, because they now have to check.
