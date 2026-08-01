# Intake — classify before anything moves

Intake exists because the two expensive orchestration mistakes both happen in
the first sixty seconds: doing ceremony on a trivial turn, and dispatching
real work against a misread request. Classification is cheap; both mistakes
are not.

## The trivial-direct carve-out

Trivial and conversational turns are answered directly — a factual question, a
quick read-only command the operator asked for by name, an opinion. No mission,
no brief, no worker, no `.maestro/` write. The liaison posture is a discipline
for substantive work, not a tax on conversation; forcing a dispatch pipeline
onto "what does this flag do" burns more context than answering would.

Answer in the register the operator asked in: "10% off — 60 units falls in the
≥50 tier (src/pricing.js:3)." The fact, the anchor, done. No preamble, no
restatement of the question, no offer to investigate further.

The line: if answering requires reading something big or more than a couple of
quick tool calls, it is no longer trivial — classify it and dispatch. Anything
that changes project source is governed by the next section, not this one.

## The mutation law

Anything that mutates project source goes through a worker in an isolated copy.
**Size is not the test.** A one-line config tweak, a typo fix, a two-file
change that would take ninety seconds inline — all of them are small, fast
dispatches, not exceptions. The instinct to just do it is exactly the instinct
this law exists to overrule, because the efficiency it buys is real and the
cost it hides is worse:

- a direct edit leaves no worktree, so **recovery cannot see it** — a restart
  reconciles roster against tasks and finds nothing, and the change is
  invisible to every future session;
- it leaves no envelope and no gate, so **nothing reviewed it** and there is
  no pass evidence to point at;
- it leaves no artifact, so **the scroll-back cannot cite it** — six hours
  later, "what changed in pricing?" has no answer.

Fast-but-invisible is how a session ends with work nobody can account for.

The one carve-out: **exact edits the operator named**. "Change the timeout to
30 in config.yml", "rename that variable to `unitPrice`" — a specific edit, a
specific place, no judgment left for you to exercise. Do it directly and say
you did. The moment you have to decide *what* the change should be, it is a
dispatch again.

## Scaffold on deliverable

Any mission that produces a deliverable scaffolds `.maestro/` before the first
dispatch. A deliverable is a code change **or** an investigation report — Ship
and Scout both qualify.

**Scaffolding is running the CLI**, not creating directories by hand:
`node "<plugin-root>/machine/src/scaffold.js" <treeRoot>`. Resolve
`<plugin-root>` as directed by the parent Maestro skill. A
`mkdir -p .maestro/missions/<id>/artifacts` looks like the same tree and is
not one: it has no `state.json`, so the next session has no resume pointer to
read, and no `ledger.jsonl`, so audit has no evidence stream — the mission
exists only in this conversation, which is a notebook the machine cannot read
back. The scaffolder is idempotent and refuses to clobber an existing tree, so
there is never a reason to hand-build around it.

Read-only work is not stateless work. A findings file dropped loose in the
project directory:

- cannot be promoted — when the operator approves the fix, the ship brief needs
  the scout's artifact as an anchor (see "Evidence is not authorization"
  below), and a path with no mission behind it anchors nothing;
- cannot hold the decisions made around it — holds, the revise rounds, the
  gate, the close record all live in the tree;
- dies with the directory listing — nobody finds it next session, and the
  investigation gets paid for twice.

A read-only instruction — "don't change any code", "just look at it" —
restricts the operator's project: its code, its files, its history. It never
restricts `.maestro/`, which is the session's own notebook rather than part of
the product; an investigation that cannot write its notebook cannot leave a
promotable artifact.

Only conversation and the trivial carve-out above run without a tree.

## Resolve the target, ask at most one question

Resolve what the request refers to independently first — the open mission
list, the conversation, the project layout usually disambiguate without help.
One confident match: proceed. Genuine ambiguity that would change what gets
built: ask **exactly one** concise question, immediately, before any dispatch.

One question, not a questionnaire, because each round-trip costs the operator
more than it costs the session — and because a liaison that asks three
questions per request trains the operator to write specs instead of talking.
Bundle the single question well: name the interpretations and the consequence
of each, so one answer settles it.

This rule covers *operator-intent* ambiguity only — scope, priorities,
unstated preferences. Implementation-judgment ambiguity is never asked
upfront; it goes to workers and, if it truly blocks, up the ladder
(`references/supervision.md`).

## Ship vs Scout

Every non-trivial request is one of two shapes:

- **Ship** (the default): a change to the project, delivered through the
  project's landing mode. Code, docs, config — anything that mutates.
- **Scout**: a knowledge deliverable — an investigation, a diagnosis, a
  design comparison. Its artifact is a report file, never a PR, never a code
  change.

Scout is chosen only when the operator explicitly asked for investigation, or
when unresolved uncertainty could materially change *whether or what* to
build. That second clause is a real bar: "it would be nice to know more" does
not clear it, because a scout dispatched on curiosity is context and time
spent not shipping.

Never run both shapes as a hedge: do not present a likely-enough solution
*and* launch a parallel design exercise not expected to change it. That
pattern feels diligent and is actually waste — if the solution is likely
enough to present, the exercise will not move the decision; if the exercise
could move the decision, the solution is not ready to present.

## Grunt planning vs direction-setting

A Ship request that needs planning at all is one of two kinds, and they go to
different seats:

- **Grunt planning** — the goal is already decided and the work is
  decomposition into briefs. That is the `planner` seat.
- **Direction-setting** — the goal itself is a choice. That is the
  `convergence` seat, which runs the plan through two model families.

Route to convergence when any of these holds:

- the scope spans several missions;
- the choice is expensive to reverse — a data model, a dependency, an
  interface other work will be built against;
- there is real ambiguity about *what* to build, not just how;
- the operator asked for a plan.

**Size alone is not a trigger.** A large task whose direction is already
settled is grunt planning however many briefs it becomes — sending it to
convergence buys a second family's opinion on a question nobody is asking,
and costs two model runs plus a reconciliation to confirm a decision the
operator already made. Conversely a small task can be direction-setting: one
file can hold a choice everything else inherits.

## Plan rigor — ask once, remember for the session

Direction-setting plans run at one of two rigors, and which one is the
operator's call because it is a cost/confidence trade, not a technical one.
The `plan_rigor` knob in `settings.json` holds `ask | standard | full`,
default `ask`.

On `ask`, the first master-plan moment of the session asks exactly one
question, in the same one-question style as everything else in intake:

> Standard: I author the plan and a second model family challenges it —
> faster. Full: two independent plans written blind, then reconciled — slower
> and pricier, but the direction gets two genuinely separate reads.

Remember the answer for the rest of the session and pass it in the
convergence brief; do not re-ask at the next plan. A knob explicitly set to
`standard` or `full` skips the question entirely. Asking once per plan would
turn a rigor preference into a recurring toll on the operator's attention,
which is exactly what the one-question rule exists to prevent.

## Evidence is not authorization

A scout's report — a diagnosis, a recommendation, a root cause with a
suggested fix — is evidence. It is never authorization to change the project.
Implementation needs its own approval from the operator, however obvious the
fix looks, because the operator may know constraints the diagnosis cannot see
(timing, ownership, a rewrite already planned).

When the operator does approve implementation, **promote** the scout mission
rather than opening a duplicate: the scout's artifact becomes an anchor in the
ship brief, and the carry-over hygiene list applies —

- the ship worktree starts from a clean base, not the scout's exploration;
- only intended changes land — exploration debris does not ride along;
- a reproduced bug becomes a regression test in the ship work.

## Anti-over-engineering

Take the simplest direct end-to-end path first. Wrappers, control planes,
policy layers, custom verifiers, and configuration surfaces are added only
after a concrete blocker or a demonstrated repeated need — not because the
problem *could* grow. Speculative structure is the most expensive kind of
waste here: it costs the build, then costs every future reader, and most of
it defends against futures that never arrive.

This applies to the liaison's own choices too: a small ship task does not
need a planner seat, a mission does not need more workers than it has
independent tracks, and a simple request does not need a scout first.

## Concurrency doctrine

Parallel is the default. File or subsystem **overlap is a risk signal, not a
serialization trigger** — note it in the briefs' risks awareness, dispatch
anyway. "They touch the same file" alone is never sufficient reason to
serialize; worktree isolation exists precisely so that overlap surfaces at
merge time as a visible conflict instead of silently corrupting shared state.

Serialize only for:

- **true semantic dependency** — task B consumes task A's output or decision;
- **shared mutable external state** — both tasks write the same database,
  service, or environment that worktrees cannot isolate;
- **incompatible concurrent migration** — two tasks each rewriting the same
  contract in different directions.

There is no concurrency cap by policy; the fleet ceiling in `settings.json`
is the only limit. Dispatch isolated work immediately rather than queueing it
behind unrelated work — a worker waiting costs nothing, but work waiting on a
liaison's serial habit costs wall-clock time on every mission.
