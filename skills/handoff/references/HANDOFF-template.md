# Context handoff template

This is the semantic content contract for both handoff surfaces. For automatic
rollover, `continuity.js` exclusively owns the JSON and Markdown under
`.maestro/continuity/`. For a cold transfer, the model writes the separate
project-level `HANDOFF.md` and `handoff-state.json`; those files are not machine
continuity projections and use the explicit schema at the end of this file.

## Mission

State the current objective, who or what it serves, and the completion bar.

## Operator intent

Preserve exact operator rulings or concise faithful excerpts when wording
changes the work. Include a source such as a turn identifier when available.
Do not convert an inference into a quote.

## Verified state

Record completed facts only with durable evidence: file and line, artifact,
commit, recorded gate, or exact command result. Record where to re-check
volatile facts instead of freezing their current value.

## In flight

Name the unit of work, its exact stopping point, any partial side effects, and
the first action needed to resume it safely.

## Blockers

Name what is blocked, the evidence for the blocker, and the condition that
unblocks it. Separate operator-intent questions from implementation judgment.

## Next actions

Order the smallest cold-startable actions. Make the first action executable
without reconstructing the former conversation.

## Decisions and rationale

Carry decisions, reasons, constraints, and rejected alternatives that would
change future action. Do not preserve hidden chain-of-thought or invent a
retrospective reasoning trace.

## Open threads and hypotheses

Carry unresolved hypotheses, why each is plausible, what evidence would decide
it, and the next check. Label hypotheses as hypotheses.

## Traps, paths, and commands

Record only traps likely to recur, high-value paths or identifiers, and exact
commands needed to build, test, or resume. Never copy secrets; record their
location only.

## Cold-transfer `handoff-state.json` schema

Use exactly these top-level fields for a project-level transfer. Keep
`next_actions` ordered and non-empty; use a single explicit completion action
when no work remains. A `done` checklist item requires durable evidence.

```json
{
  "schema_version": 1,
  "updated_utc": "<ISO-8601 UTC>",
  "origin": {
    "session": "<session id/name or unknown>",
    "window": "<context-window id or unknown>"
  },
  "mission": {
    "id": "<stable mission/project id>",
    "objective": "<objective>",
    "completion_bar": "<observable finish condition>"
  },
  "operator_intent": "<faithful bounded statement of operator rulings>",
  "checklist": [
    {
      "item": "<unit of work>",
      "status": "done|in_progress|todo|blocked",
      "evidence": "<durable evidence or not_verified>",
      "exact_next": "<next action or none>"
    }
  ],
  "blockers": [
    {
      "blocker": "<what is blocked>",
      "unblock": "<condition that unblocks it>"
    }
  ],
  "gates": [
    {
      "name": "<gate name>",
      "command": "<exact command>",
      "last_result": "pass|fail|not_run"
    }
  ],
  "next_actions": ["<first cold-startable action>"],
  "decisions": [
    {
      "decision": "<decision>",
      "reason": "<bounded rationale>"
    }
  ],
  "hypotheses": [
    {
      "hypothesis": "<unresolved hypothesis>",
      "basis": "<why it remains plausible>",
      "next_check": "<discriminating check>"
    }
  ],
  "values": {
    "<stable key such as branch or important_path>": "<value or lookup location>"
  }
}
```
