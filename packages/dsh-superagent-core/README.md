# Vendored DeepSeek Superagent core

Upstream: https://github.com/deepseek-ai/dsh-superagent-prototype

Pinned commit: `6337fc823ce20251c8de8085948165c81aaa701e`.

The 15 files in `src/` are unmodified copies of upstream `src/core/`.
See `UPSTREAM.json` for hashes and `LICENSE` for the original MIT notice.
No upstream Harness runtime, account setup, shell executor, GitHub or Feishu writer is included.

Application-owned adapters live in `apps/gateway/src/assistant-event-store.ts`,
`assistant-events.ts`, and `assistant-notifications.ts`. They permit only read-only
local project summaries and local message publication. Persona and memory stay
behind the application's existing Mastra/Letta boundary.

When upgrading, inspect the complete upstream core and its license, compare the
manifest, then run the application event, restart, citation and budget tests.
Do not run upstream `SETUP.md` against a user's active Harness profile.
