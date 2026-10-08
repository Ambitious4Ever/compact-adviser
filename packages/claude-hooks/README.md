# compact-adviser (OpenRouter, Claude Code hooks)

This variant lives in a fork. It tells you when your Claude Code session has reached a good checkpoint to run `/compact`: after work lands, not in the middle of a task.

It reuses the upstream judge (Jev's two questions, the score, and the sliding floor) and changes two things:

- **Plain command hooks.** Upstream `packages/claude-mod` needs the early-access `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. This version uses ordinary `Stop` and `SessionStart` hooks, so it works on any Claude Code install, including Windows.
- **OpenRouter instead of TypeSafe's API.** The judgment is a chat completion against `typesafe/jev-router`, or any model you set, with a strict JSON schema.

This version is hint-only. Command hooks can't trigger `/compact` themselves.

## Requirements

- Node.js 22.18 or newer on `PATH`. It runs the `.ts` sources directly, with no build step.
- An OpenRouter API key.

## Install

```
/plugin marketplace add Ambitious4Ever/compact-adviser
/plugin install compact-adviser-openrouter@compact-adviser
```

For a local checkout: `claude --plugin-dir packages/claude-hooks`.

## Settings

Each setting is read from the first place that has a value: an environment variable, then the plugin's `/config` option, then `~/.claude/compact-adviser/config.json`.

| Setting | Env var | Default |
| --- | --- | --- |
| API key | `OPENROUTER_API_KEY` (also read from a project `.env`) | none: the adviser stays silent |
| mode (`hint` / `off`) | `COMPACT_ADVISER_MODE` | `hint` |
| minContextTokens | `COMPACT_ADVISER_MIN_CONTEXT_TOKENS` | 40000 |
| contextLimitTokens | `COMPACT_ADVISER_CONTEXT_LIMIT_TOKENS` | 200000 |
| contextBudgetTokens | `COMPACT_ADVISER_CONTEXT_BUDGET_TOKENS` | 0 (off) |
| model | `COMPACT_ADVISER_MODEL` | `typesafe/jev-router` |
| logRequests | `COMPACT_ADVISER_LOG_REQUESTS` | false |
| profile (judge profile JSON) | `COMPACT_ADVISER_PROFILE` | shipped defaults |

`OPENROUTER_BASE` overrides the API base. It must be https, or http on loopback only.

## How it decides

On every `Stop` it does the following:

1. It counts the exchange.
2. It skips the judgment if context is below the minimum, a cooldown is active (20k new tokens and 3 exchanges after a compaction, or backoff after errors), the conversation is small, or this same checkpoint was already hinted.
3. Otherwise it sends a bounded snapshot to Jev and shows `Run /compact` only when the score clears the floor. The floor is strict when context is mostly empty and relaxes as it fills.

Errors, timeouts and malformed replies never produce a hint. A bad key or bad configuration is shown once. Transient errors back off silently.

## Data that leaves your machine

The snapshot is the same bounded, redacted shape as upstream: user constraints, up to the last 64 replies with tool results clipped to 512 bytes, an existing summary, and saved file names. It's capped at 32,000 bytes. It goes to **OpenRouter**, which routes it to TypeSafe's Jev or whichever model you set. Your key is sent only in the `Authorization` header. It's scrubbed from the snapshot and never logged. Redaction is best-effort, so don't use this on material that must not leave the machine.

## Develop

```
cd packages/claude-hooks
npm install
npm run check
```

To debug a hook by hand:

```
echo '{"session_id":"t","transcript_path":"<path to a session .jsonl>"}' | COMPACT_ADVISER_DEBUG=1 node hooks/run.ts stop
```
