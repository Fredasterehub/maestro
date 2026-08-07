<div align="center">

<img src="docs/assets/art/mark.svg" alt="The maestro mark: a squared M with a single underscore stroke." width="128">

# MAESTRO

### He runs the work. You keep the decisions.

A Claude Code plugin that stops your session from doing the work itself. It
dispatches thirty-one agents — thirty workers and the butler — writes each of them a brief,
dispatches the work into isolated worktrees, has it signed off by a rival family,
records everything that happened, and interrupts you only when the decision is
genuinely yours.

<p>
<img src="https://img.shields.io/badge/license-MIT-2A2536?style=flat-square&labelColor=0A0911" alt="MIT licensed">
<img src="https://img.shields.io/badge/Claude%20Code-plugin-2A2536?style=flat-square&labelColor=0A0911" alt="Claude Code plugin">
<img src="https://img.shields.io/badge/31-agents-AD7051?style=flat-square&labelColor=0A0911" alt="31 agents">
<img src="https://img.shields.io/badge/the%20record-open-AD7051?style=flat-square&labelColor=0A0911" alt="The record is open">
</p>

</div>

<img src="docs/assets/art/hero-readme.jpg" alt="A session at full dispatch, drawn as a circuit board: one request arrives on a paired trace, fans out through dispatch junctions to sixteen android faces, and returns along dashed lines to Oscar, whose portrait sits in a copper ring at the left — one paired trace leaves toward your chair." width="100%">

## The premise

The one you talk to never touches the code. That is the whole trick, and it is
the only reason thirty workers can hold one mission together: one mind keeps the
shape, and no worker has to hold anybody else's brief in its head.

Your session is the post. Before Oscar took it, you stood there *and* did
every job — arguing with the linter at midnight with six hundred lines of log in
working memory, watching context fill until the session died mid-phrase, starting
the same work over the next morning because nothing had been written down.

Sessions died young. Work got done twice. Nothing was recorded, so nothing could
be resumed.

Then Oscar took the post.

<img src="docs/assets/terminal-session.svg" alt="A terminal session: one request in, work dispatched to the workers, outcomes reported back." width="100%">

## What he actually does

**The roster.** Thirty-one agents, filled the day you install him, never
improvised mid-mission. (Closed roster: three implementer families — five
claude seats and four gpt seats scaled across task classes, one gemini seat
— a reviewer ladder to match (three claude, three gpt, one gemini) plus four
degraded-path fallback reviewers for when no cross-family reviewer is
available, a planner, two convergence agents, and the support group of six
— scout, researcher, context-keeper, crystallizer, handoff-recorder,
fleet-medic. Two more names, `executor-sol` and `reviewer-sol`, are retired
r1→r2 aliases that no longer route and are not counted above.)

**The record.** "Tests pass" is not a sentence. It is a stamped entry with an exit
code. Not in the record? It didn't happen. (`.maestro/ledger.jsonl`, append-only,
written only by the machine layer — never by a model in a hurry.)

**No worker reviews its own work.** A worker builds in an isolated worktree, and a
reviewer from a *different* model family signs the work before it lands. The
script that closes a mission refuses to record a same-family review. (Worktree
isolation plus mandatory cross-family review. That rule cannot be lowered.)

**The record survives the night.** Send every worker home mid-mission. At dawn new
workers read the record and resume at the exact step where work stopped. (Per-step
checkpoints; a restart is reconciliation, not re-planning.)

**One drawer for your decisions.** Questions that are truly yours pile up neatly
in one place. Nothing else knocks — no retry narration, no progress theatre.
(Holds queue plus a short escalation whitelist.)

**The convergence pass.** When two workers disagree, two families with no stake in
the dispute take independent positions — two passes, no more — and come out with
one answer, or bring you both positions verbatim.

<details>
<summary><b>The roster, in full</b></summary>

<br>

<img src="docs/assets/art/crew.jpg" alt="Workers in flight, drawn as a circuit board: android faces set in copper rings, joined by bone-white traces, with dashed return lines carrying finished work back toward Oscar." width="100%">

| Role | Agent | What it does |
|---|---|---|
| The gpt implementer ladder | `executor-luna` · `executor-terra` · `executor-sol-expert` · `executor-sol-apex` | GPT-5.6 (Luna/Terra/Sol) via Codex CLI, one rung per task class — mechanical, standard, expert, apex. (`executor-sol` is now an alias of `executor-sol-expert` and does not route.) |
| The specialist | `executor-claude` | Opus 5. Interface and creative work, and the same-family substitute when the gpt lane is down. |
| The claude implementer ladder | `executor-claude-mech` · `executor-claude-standard` · `executor-fable-low` · `executor-fable` | Sonnet 5 (mechanical, standard) and Fable 5 (expert escalation, apex), class-scaled alongside the specialist. |
| The wide-context worker | `executor-gemini` | Gemini 3.1 Pro. Large context, and the rotation agent. |
| The reviewers, for gpt/gemini work | `reviewer-claude` · `reviewer-claude-expert` · `reviewer-claude-apex` | Never from the family that wrote the code; class-scaled recon/standard through expert/apex. |
| The reviewers, for claude/gemini work | `reviewer-terra` · `reviewer-sol-expert-rev` · `reviewer-sol-apex-rev` | GPT-5.6 via Codex CLI, class-scaled. (`reviewer-sol` is now an alias of `reviewer-sol-expert-rev` and does not route.) |
| The reviewer, for claude/gpt work | `reviewer-gemini` | Gemini 3.1 Pro. All claude classes; recon/mechanical/standard gpt classes only — gpt expert/apex route to the claude reviewers instead. |
| The degraded-path reviewers | `reviewer-degraded-opus` · `reviewer-degraded-sonnet` · `reviewer-degraded-opus-apex` · `reviewer-degraded-fable-apex` | Same-family, fresh-context fallback used only when no cross-family reviewer is effectively available — always labeled, never counted as cross-family. |
| The planner | `planner` | Turns "fix everything" into numbered briefs with acceptance criteria. |
| The convergence pair | `convergence` · `plan-counterpart` | Two uninvolved families, one closed room. Two passes. One answer. |
| The context-keeper | `context-keeper` | Holds what you meant, not just what you said. |
| The scout | `scout` | Fast, cheap, reads everything, writes nothing. |
| The researcher | `researcher` | Returns with citations or does not return. |
| The crystallizer | `crystallizer` | Reads the entire corpus so nobody else has to. Hands back one page. |
| The recorder | `handoff-recorder` | Records how the session ended. One entry, no poetry. |
| The fleet medic | `fleet-medic` | Reconciles the roster against what is actually running: alive, dead, or pretending. |
| The butler | `maestro` | Dispatches. Implements nothing. There is a law against it. |

</details>

## Install

<img src="docs/assets/terminal-install.svg" alt="A terminal: adding the maestro marketplace and installing the plugin." width="100%">

```sh
claude plugin marketplace add Fredasterehub/maestro
claude plugin install maestro@maestro
```

Installed once, at user scope — he is at every session from then on. `claude plugin update maestro` when a new version lands.

One caveat, and he is firm about it: remove any competing orchestration layer from
your global `CLAUDE.md` first. Two orchestration layers in one session will spend
it arguing about who is in charge.

## The shape of it

<div align="center">

<img src="docs/assets/tree-worktree.svg" alt="The .maestro/ directory: state.json, the append-only ledger, the holds queue, routing and views, and one directory per mission holding its brief, progress log, envelopes and artifacts." width="92%">

<sub><i>The record on disk. One directory per mission — and the ledger that outlives all of them.</i></sub>

<br><br>

<img src="docs/assets/tree-decision.svg" alt="One request from arrival to your chair: dispatched to an isolated worktree, reviewed by a different family, landed — and only an unresolved S1 reaches you." width="92%">

<sub><i>Revise, then the closed room, then — and only then — your chair.</i></sub>

</div>

## What you can ask him

| Command | What you get |
|---|---|
| `/maestro:status` | Where everything stands: needs you, just landed, still moving, waiting in line. |
| `/maestro:handoff` | Before you close the session — everything worth keeping, moved somewhere durable. |
| `/maestro:doctor` | Install and state health. Reads everything, touches nothing. |
| `/maestro:audit` | The record read back to you: revise rates, ladder engagements, workers lost in service. |

## Provenance

The policy layer — liaison discipline, escalation rules, restart-proofing — is
migrated from [firstmate](https://github.com/kunchenguid/firstmate) onto Claude
Code's own primitives: background subagents, worktree isolation, task
notifications. The worker contracts and roster design honour kiln's protocol work:
the report envelope, the dispatch brief, the verdict and stop vocabularies, the
convergence passes. No tmux, no watchers, no external processes.

Built with Claude Code and hardened across three evaluation iterations;
cross-family review was verified live rather than asserted. What is here is what
shipped — a fleet-of-projects registry, detached workers, push notifications and
milestone machinery are all deliberately outside v1.

<div align="center">
<br>

### Dispatch. Don't implement.

<sub><a href="https://fredasterehub.github.io/maestro/">The record, at length</a> · <a href="LICENSE">MIT</a>. The workers are synthetic. So, quietly, is the butler.</sub>

</div>
