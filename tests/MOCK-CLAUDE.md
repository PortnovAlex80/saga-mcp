# Mock-claude for saga-mcp engine tests

A subprocess replacement for `claude.exe` that lets the orchestrate engine be
tested end-to-end without invoking real claude. The mock reads the same argv
vector and env block as a real worker, drives the saga DB through the canonical
worker lifecycle, and exits 0.

## Why

Before mock-claude, the engine's pump loop, close-handler, stage transitions,
reconciliation, and recovery paths had no integration coverage. Every bug we
hit on the 4D_Las_viewer epic (spurious traces, orphan workers, log-silence
liveness, summary tasks stranded in `completed`) was discovered by running
real claude.exe — at ~30 minutes per full cycle and ~$0.70 per run.

Mock-claude runs the same path in **~8 seconds** with zero cost. It catches
regressions in:

- `episode_transition` gates (assertTasksReady, assertVerificationPassed)
- close-handler classification (completed / changes_requested / failed)
- `worker_executions` fencing and reconciliation
- recovery-tree spawn on gate failure
- engine drain of summary/recovery tasks in terminal stages

## How to run

```bash
# Build dist/ (mock imports handlers from there)
npm run build

# Run the e2e smoke test alone
npm run test:e2e

# Or run the full suite (e2e + unit + migrations)
npm test

# Manual: spin up the engine against a fresh temp epic with the mock
SAGA_CLAUDE_PATH="node tests/mock-claude.mjs" \
  DB_PATH=/tmp/test.db \
  node dist/orchestrate-cli.js <projectId> <epicId> --concurrency=1
```

## What the mock does

Per spawn (one task lifecycle):

1. **Parse argv** — ignore claude CLI flags (`-p`, `--model`, etc.), take the
   last positional as the prompt, and the `--mcp-config <path>` argument.
2. **Parse the prompt** — extract `task_id`, `worker_id`, `execution_id`,
   `task_kind`, `execution_mode`, `role`. The prompt is built by
   `claude-runner.mjs:buildPrompt()` and always starts with `key=value` lines.
3. **Resolve DB_PATH** from `--mcp-config` (preferred) or `process.env.DB_PATH`
   (fallback).
4. **Emit stream-json JSONL** — minimal but valid: `system/init`,
   `assistant/text`, `result/success`. The runner pipes stdout/stderr into a
   `.jsonl` log; the `/api/workers/active` endpoint reads the file's mtime to
   decide liveness freshness.
5. **Sleep 1 second** — simulates "work" (cargo/vitest).
6. **Drive the saga DB** via direct handler imports:
   - `verification.ac` → `verification_record(passed)` for the canonical AC
     target stored on `tasks.verification_target_artifact_id`.
   - `git_change` review task → `worker_done(approved)` → `worker_merge_acquire`
     → empty git commit on `task/<id>` branch → `git merge` →
     `worker_merge_release(merged|conflict)`.
   - Anything else → `worker_done(approved)`.
7. **Heartbeat** — writes `CLAIMED` and `MOCK_DONE` (or `MOCK_PARTIAL`) lines
   to `~/.zcode/cli/worker-heartbeat.log`, same format as real workers.
8. **Exit 0** always. A non-zero exit triggers `recoverAssignment` in the
   close-handler and an infinite respawn loop. If a saga handler throws
   (e.g. "Task X not assigned"), the mock logs `MOCK_PARTIAL` and still exits
   0 — the engine's own reconciliation surfaces the problem, same as a real
   worker that crashed mid-work.

## What the mock does NOT do (MVP scope)

- **No fixture-driven failures.** Every run is APPROVED + 1s. There is no
  way to simulate `changes_requested`, exit 1, cargo delay, or rate-limit
  events. Roadmap: read `tests/mock-fixtures/<task_id>.json` for per-task
  behaviour overrides.
- **No real MCP stdio protocol.** The mock imports the compiled handlers
  from `dist/tools/*.js` directly. This is faster than JSON-RPC over stdio
  but means the mock does not exercise MCP-level errors (malformed args,
  tool-not-found, etc.).
- **No real skill loading.** The prompt references `skills/saga-worker/SKILL.md`
  — the mock does not read it. Saga's skill content has no effect on the
  mock's behaviour.
- **No stream-json tool_use/tool_result events.** The mock emits only
  `assistant/text`. Real workers emit `tool_use` and `tool_result` for each
  saga MCP call; the mock's simpler shape is enough for the runner (which
  only checks log mtime + final close code).

## Limitations discovered

- **Concurrency > 1 with a single claimable task** races: two workers spawn
  for the same task; the second sees `status=done` when it calls `worker_done`
  and the close-handler classifies it as FAILED, triggering an infinite
  respawn. Always use `concurrency: 1` in tests with a single-task-per-stage
  episode, or seed enough tasks to fill the pool.
- **`execution_mode='git_change'` requires real merge plumbing.** The mock's
  merge step assumes a `task/<id>` branch exists. If it doesn't, the merge
  fails and the task is flagged `integration_state='conflict'` → `needs-human`
  → episode pauses. The current e2e test sidesteps this by using
  `execution_mode='tracker_only'` for both verification and integration tasks.
  A follow-up should add worktree setup in the test fixture.

## Roadmap

1. **Failure fixtures** — per-task JSON overrides in `tests/mock-fixtures/`
   so tests can simulate changes_requested, exit 1, cargo delay, and
   rate-limit events.
2. **Approach A (spawn injection)** — fast unit tests that bypass the
   subprocess boundary entirely. The runner already accepts `spawn` in its
   constructor options; a fake spawn returning a hand-rolled ChildProcess
   can drive the same DB transitions in milliseconds, not seconds.
3. **Real worktree setup** — extend the test fixture to create `task/<id>`
   branches and worktrees so `execution_mode='git_change'` works end-to-end
   including merge.
4. **CI** — `.github/workflows/test.yml` runs `npm test` on every PR. With
   mock-claude, the full suite is ~2 minutes and uses no external APIs.

## Files

- `tests/mock-claude.mjs` — the mock subprocess (~390 lines)
- `tests/e2e-pipeline.test.mjs` — the smoke test (~180 lines, 1 test case)
- `tests/MOCK-CLAUDE.md` — this document
- `package.json` — adds `test:e2e` and `mock:run` scripts
