# Codex hard-rollover configuration

Use this configuration when the operator wants one long-running Codex thread
whose model-visible message history is periodically cleared and rebuilt from a
durable Maestro handoff.

Verified against Codex CLI 0.146.0 on 2026-07-31. `token_budget` is currently
an under-development feature, so re-check `codex features list` and the current
config schema before carrying this block to another Codex release.

Normal OpenAI remote compaction is not this contract: it installs an opaque
compaction item plus a bounded recent-message prefix, and its summary behavior
is not precisely controlled by `compact_prompt`. The configuration below uses
the separate clean-window path instead.

```toml
model_context_window = 272000
model_auto_compact_token_limit = 200000
model_auto_compact_token_limit_scope = "total"

[features.token_budget]
enabled = true
reminder_threshold_tokens = 24000
reminder_message_template = "A context rollover is approaching; {n_remaining} tokens remain. Finish and persist the current atomic step, write the Maestro window handoff, then call new_context. Do not ask the operator to open another session."
guidance_message = "This is a persistent Maestro thread. Before calling new_context, write a bounded handoff containing conversation-only operator decisions, hypotheses, and the exact next action. After any fresh context window, read .maestro/continuity and continue its first valid next action. Durable .maestro state remains authoritative."
auto_compact_fallback_prompt = "Do not start another substantive tool. Persist every conversation-only decision or hypothesis into the Maestro window handoff now, then call new_context. Do not ask the operator to open another session."
auto_compact_fallback_buffer_tokens = 16000
```

The GPT-5.6 API advertises a 1.05-million-token context window, but Codex CLI
0.146.0's installed Sol catalog entry caps this profile at 272,000 tokens. This
pinned configuration names that CLI value explicitly instead of relying on a
larger override that the catalog will clamp. At Codex's 95% effective limit,
the usable window is 258,400 tokens. The base boundary is 200,000 total
active-context tokens. The one-per-window reminder first becomes eligible at
24,000 tokens remaining, normally around 176,000 active tokens. At the base
boundary, Codex injects the fallback prompt and reserves another 16,000 tokens
for checkpoint tool calls. If the model has not requested a new window by the
buffered boundary, Codex forces the rollover when another model continuation is
needed; if the turn has ended, it rolls over before the next model request. The
forced boundary is therefore 216,000, leaving about 42,400 tokens below the
effective hard window for tool output and estimation error.

Do not set the base limit or base-plus-buffer above the model's effective
window. Leave headroom for tool output, the replacement world-state prefix, and
token-estimation error.

## Lifecycle

```text
normal work
  -> one reminder near the boundary
  -> handoff writes and verifies .maestro/continuity
  -> new_context requests rollover
  -> PreCompact(auto)
  -> old model-visible message items are replaced by fresh initial context
  -> PostCompact(auto)
  -> SessionStart(source=compact) injects the resume directive
  -> the same operator turn continues from disk
```

The Codex thread, transcript, files, processes, and environment are not deleted.
Only the model-visible context window is replaced. This is what preserves the
operator's single-thread experience while giving the model a clean window.

## Failure rule

Never call `new_context` after a failed or unverified handoff write. If Codex
forces a rollover anyway, the compact SessionStart hook must fall back to the
bounded `.maestro` state digest and report that continuity is degraded. It must
not manufacture missing operator intent.

After the urgent fallback prompt appears, do not start another substantive tool
whose result exists only in conversation. A forced mid-turn reset can remove a
just-returned tool result before the model has persisted or interpreted it.

## Subagent boundary

This mode primarily targets the root Maestro liaison. In Codex CLI 0.146.0,
`SessionStart(source=compact)` is not dispatched to subagent sessions. Keep
native child tasks bounded so they return durable envelopes before rollover, or
provide child rehydration through canonical guidance or a durable
`notes.thread_hint` integration. Do not rely on the root SessionStart hook to
restore a child window.

## Implementation anchors

- [Token-budget clean reset lifecycle](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/compact_token_budget.rs#L21-L92)
- [`new_context` tool contract](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/handlers/new_context_window_spec.rs#L6-L16)
- [Same-thread rollover and hard-drop tests](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/tests/suite/token_budget.rs#L651-L860)
- [Codex hook lifecycle and `SessionStart(source=compact)`](https://learn.chatgpt.com/docs/hooks)
- [GPT-5.6 Sol API model window](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
