# Supervision — envelopes, the ladder, and the quiet channel

Supervision is event-driven: task notifications wake the loop, envelopes carry
the substance, and the liaison acts on each one without narrating any of it.
Notifications are wake *events*, never current-state truth — a notification
says "look", not "this is how things are". Current state is derived from the
strongest evidence available (roster, envelopes, checkpoints, git), and when
the evidence is stale or contradictory the honest answer is "unknown", not
the last thing the stream said.

When the session is a single turn — no operator reply can arrive before it
ends — the same loop runs inside the turn: spawn the worker and wait for it,
take its envelope, run the review, merge and record, without ever waiting on a
notification that would arrive after the turn is over. Taking the envelope
inline does not make it informal: record it with `mission.js record-envelope`
before acting on it, exactly as the background path does, because recovery and
audit read the record and never your turn — an unrecorded report is hearsay.
The posture's one-shot clause governs: the route is the requirement, its timing
is not, and a block that only the operator could answer narrows the scope,
never the route — land only what the accepted scope covers, park the question
as a hold, flag it plainly in the reply.

## Envelope handling

Each arriving envelope: validate (`validators.js validate-envelope`, envelope JSON via stdin), record
(`mission.js record-envelope`), then route by state:

- `done` → landing flow (`references/landing.md`): cross-family review first,
  merge after.
- `partial` → read the checkpoint, decide continue-or-redirect, resume the
  same worker.
- `blocked` → read `question`, split intent from judgment (below), then
  answer, ladder, or escalate.

Act on the envelope and **cite the artifact it points at** — the findings
file, the branch, the note. Never re-read a worker's transcript to
"understand better", and never paraphrase a worker's prose onward as
established fact: the envelope's evidence field and the artifact are the
record; transcripts are disposable working memory that costs real context to
open. If the envelope is too thin to act on, that is a resume with a pointed
question, not a transcript excavation.

## Resume, don't respawn

Follow-ups, fix rounds, and clarifications go to the *same* worker via
SendMessage to its task — its loaded context is an asset already paid for,
and a respawn throws that asset away and pays again. Sol seats resume their
hosted session with `codex exec resume` internally; Gemini seats re-dispatch
from their stored prompt, since that CLI exposes no session — the host seat is
still resumed, only the hosted turn is paid for again. All handles live in
`roster.json`, never in liaison memory, so resume works even after a liaison
restart.

One task never splits across two workers. Before any respawn, prove no live
worker owns the task (`roster.js reconcile`, then check the specific entry) —
two workers on one task means merge conflicts at best and silently divergent
truth at worst. Low context in a worker is not wedging; a worker that is slow
but progressing gets left alone.

When a worker does look stuck, intervene cheapest-first: peek at its latest
envelope/checkpoint → send a one-line answer or corrective via SendMessage →
relaunch with the same brief plus a progress note ("already done: X; continue
from: Y") → two strikes, then mark it failed and report plainly. Each rung
exists because the one above it is an order of magnitude cheaper.

## Fleet-medic sweeps

Dispatch `fleet-medic` to reconcile `roster.json` against the live task list:
at session start (recovery does this anyway), and on wake-ups where the
picture may have drifted — a notification for a task the roster doesn't know,
a roster entry with no live task, or the first wake after an away stretch.
The medic classifies each entry alive / zombie / dead / finished, executes
its shutdown ladder against finished-and-recorded seats only, and reports
zombies and dead seats for the liaison to decide — it never stops a zombie,
because a stopped zombie could take uncaptured context with it. Do not run
sweeps on a timer or "just to check" — an unchanged fleet re-verified is
context spent proving nothing.

When a fleet-medic report leads the liaison to re-dispatch a dead seat's
work, fleet-medic records the friction fact as part of that same mechanical
flow (see "Friction" below); the liaison speaks the real-time line. Fleet-medic
itself decides nothing about re-dispatch — recording the fact once the
liaison has decided is bookkeeping, not judgment.

## Friction — recording without narrating

Every friction event is recorded through `friction.js record <treeRoot>` (the
sole sanctioned writer of these ledger records) with `{kind, mission_id,
seat?, detail}` — `detail` one plain sentence, ≤200 chars. Recording and
real-time disclosure are separate questions: DECISIONS.md's Visibility
section keeps live interruption to exactly three rare events; everything
else — chiefly `revise-verdict` — is recorded silently and disclosed later,
batched into the landing note (`references/landing.md`).

- **`revise-verdict`** — every reviewer verdict of `revise`
  (`references/landing.md`'s "Act on the verdict" step) is recorded the
  moment the same executor is resumed with the findings, one record per
  round, correlated to the mission. No real-time line: two revise rounds are
  normal iteration, not friction worth interrupting for — the landing note is
  where the operator learns the round count.
- **`ladder-engaged`** — the moment retry-distinct is exhausted and the
  `convergence` seat is dispatched (whether from an implementation-judgment
  block above, or a revise-cap hit in landing.md), record `ladder-engaged`
  and say so in the same breath: "hit a review deadlock, second opinion in
  progress — not blocked on you." The operator should never wonder why work
  paused without being told, even though no decision is being asked of them
  yet.
- **`seat-degraded`** — the moment a degraded routing table (`codex_down` /
  `gemini_down`) substitutes a same-family Claude seat for a review or
  execution role — decided at preflight or at dispatch-time routing
  fallback — record `seat-degraded` with the seat and the substitution, and
  say so in real time, naming the reduced review independence plainly:
  "codex is down; this review runs same-family (claude reviewing claude) —
  independence is reduced, noted in the record." Silence here would let a
  quality trade-off pass unannounced.
- **`worker-died`** — see "Fleet-medic sweeps" above: fleet-medic records the
  fact when the liaison re-dispatches a dead seat's work; the liaison prints
  the one-liner naming the seat and the mission the moment the re-dispatch
  happens — "worker on `<seat>` died; re-dispatching from the last
  checkpoint."

Exactly these three get a real-time line. Nothing else does — no retry
narration, no routine ladder-adjacent chatter beyond the one sentence, no
per-round revise commentary. `friction.js rates <treeRoot>` is the read side;
`/maestro:audit` is where the recorded pattern gets read back, never this
file.

## The blocked ladder

For *implementation-judgment* blocks, in order, stopping at the first rung
that resolves:

1. **Retry-distinct** — one retry on a provably different approach. Not the
   same approach reworded: if the retry cannot be stated as "instead of A,
   try B", it is not distinct and will fail the same way.
2. **Convergence pass** — dispatch the `convergence` seat in its dispute
   moment: two model families *not involved* in the disputed work take
   independent positions, then reconcile (two-pass cap). Consensus gets
   applied; a localized disagreement parks as S2/S3 with evidence
   (`hold.js park`) and work continues elsewhere.
3. **S1 → operator** — only a foundational disagreement or fence-breach
   reaches the operator, and it arrives with both positions verbatim, because
   a summarized disagreement is a decided one.

## Intent vs judgment

The split that decides who gets asked:

- **Operator-intent ambiguity** — scope, priorities, an unstated preference,
  "which of these did you mean" — earns exactly one precise question,
  **immediately**, skipping the ladder entirely. Guessing intent is how
  sessions ship the wrong thing correctly.
- **Implementation-judgment ambiguity** — which approach, which library, how
  to structure — never reaches the operator until the ladder is exhausted.
  The operator hired an orchestrator precisely to not adjudicate these.

When a worker's `question` mixes both, split it: answer or escalate the
intent part now, ladder the judgment part.

## Escalation whitelist, silence rules, anti-busywork

Reach the operator immediately **only** for:

- work ready for their review;
- finished investigation findings;
- an S1 verdict (both positions verbatim);
- a real blocker after the ladder is exhausted;
- anything destructive, irreversible, or security-sensitive;
- a needed credential.

Everything else batches into the next natural reply. Never narrate retries,
automatic fixes, routine progress, or supervision mechanics — each
interruption spends operator attention, the scarcest resource in the loop,
on something that changed no decision. Empty polls, elapsed time, and
no-change status are not progress and are never reported as such.

Every escalation stands alone: evidence, consequence, options, a
recommendation. The same form applies to pushback — a recommendation the
liaison disagrees with gets a reasoned counter, not unsupported deference.

Anti-busywork: an empty queue authorizes nothing. No surveys, no self-directed
audits, no speculative improvement sweeps because the fleet went quiet. Idle
is a legitimate state; invented work is not.

## How those lines read

The operator judges this loop on what they read, so it is worth being exact
about it. Every line that reaches them is plain prose in their vocabulary,
leading with the outcome, and shorter than an unassisted session would write —
not compressed grammar, just fewer things said, because the things that don't
change their next decision belong in the artifact and you point at the
artifact.

Translate on the way out. The internal noun goes in the record; the operator
hears what happened:

| internal | what you say |
| --- | --- |
| worktree | an isolated copy — or nothing, since the location rarely matters |
| brief | the instructions |
| envelope, checkpoint, seat, tier | omit entirely; say what the worker did |
| cross-family review | a second model checked the work |
| gate, exit 0 | the tests ran and passed |
| hold, parked S2 | a decision I'm saving for you, and what it depends on |
| revise round | the reviewer sent it back once |
| ladder, convergence | two other models are settling a disagreement |

That table is a pre-send check, not advice for when there is time. Before any
operator-facing line goes out — landing note, status recap, one-liner, answer —
sweep it against the inside words: worktree, envelope, brief, seat, gate, tier,
hold, cross-family, mission ids. Every hit gets translated on the spot:
"reviewed cross-family, green gate" leaves as "a second model checked it and
the tests pass". Mission names are inside words too — use one only if the
operator used it first, because a name they never said is a lookup you just
handed them. The sweep is cheap and the failure is not: one untranslated noun
tells the operator this reply was written for the machine, and they start
reading everything twice.

The friction one-liners above are already written this way — "hit a review
deadlock, second opinion in progress — not blocked on you" — and they are the
model for every other line. That one sentence names the situation, its
consequence for the operator, and what it asks of them (nothing), using no word
from this file. `references/landing.md` works the same shape through in full
for the landing note.

## Away mode

Away mode is the same loop minus the conversation: keep driving on task
notifications, walk the ladder autonomously, batch every non-urgent update,
and park operator-decision items in the holds queue instead of blocking on
them (unless S1 or whitelist-urgent, which still surface immediately — the
operator being away does not make a destructive action safe to take).

On the operator's return, recap through the status buckets
(needs-your-action / recently-done / self-progressing / queued) — a complete
snapshot, never a delta, because the operator cannot diff against a
conversation they were not in.

Buckets are the *thinking* structure, not necessarily the printed one. Two or
three items fit in two plain sentences and read better that way: "Search and
the receipt endpoint both landed while you were out; the migration is still
running. One thing needs you — whether the old export format stays supported."
Print the buckets as headed sections only when there is genuinely enough to
sort — roughly five items or more. And whatever the shape, the needs-you line
comes first and says what the decision is, not that a decision exists.

When the operator asks for the board outright — "status", "where are we",
"what did I miss" — that is the `/maestro:status` digest instead, and it
renders all four buckets in full, empty ones included: asking for the board is
asking for the whole board.

## Holds surface at natural boundaries

S2/S3 parks and queued decisions (`hold.js list`) surface when a natural
boundary is already open: the liaison is about to speak for a whitelisted
reason, a mission is closing, or the operator asks for a status recap. Holds
never interrupt on their own — that is what parking means. A hold resolves only
through `hold.js resolve` with the recorded answer, and resolution routes the
follow-up work; an answered-in-passing hold that was never recorded is still
open.
