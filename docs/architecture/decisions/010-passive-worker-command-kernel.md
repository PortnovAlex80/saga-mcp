# ADR-010: Passive worker command kernel and durable integration intents

- **Status:** Proposed
- **Date:** 2026-07-18
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision review

## Context

ADR-009 separated task workflow state from managed OS-process state and added
execution fencing. That closes the observed spawn/claim and silent-worker
failure modes, but an end-to-end audit found that the product is not one simple
state machine. It is the cross-product of at least five mutable axes:

- task status and assignment;
- worker execution state and phase;
- repository integration state;
- episode workflow stage;
- task/episode human-attention flags.

The managed Claude CLI worker is passive with respect to allocation:
`claude-runner` claims before spawn, injects the assignment, and disables
`worker_next`. The worker should therefore report outcomes while the controller
owns lifecycle transitions.

In the current implementation, lifecycle writes are distributed among
`dispatcher.ts`, `worker-executions.ts`, dependency reconciliation, two runner
recovery adapters, and the public batch-update tool. `worker_done` also combines
task transition, execution phase, evidence gates, comments, integration setup,
dependency release, activity logging, and downstream generation.

The audit found these concrete residual defects:

1. `task_batch_update` can write `status` and `assigned_to` directly, bypassing
   the dispatcher, execution fence, evidence gates, and integration rules.
2. A reviewer can commit `done + integration_state=pending` and then exit before
   merge. Runner recovery requires the old assignment, which `worker_done`
   already cleared; process close then clears the fence. Recovery is delegated
   to a later LLM healer instead of a deterministic transition.
3. A repository merge lock expires after a fixed wall-clock interval even when
   its process is alive. `worker_merge_release` also accepts a missing lock.
4. Dependency reconciliation can move a running fenced task to `blocked` while
   leaving its execution active and its fence intact.
5. Execution terminalization and task release are separate writes, leaving a
   crash window between them.
6. The documented ASK protocol assumes that the same agent can wait for a human
   and resume. Managed workers are one-shot `claude -p` processes with ignored
   stdin, so they have no answer-delivery channel. A tagged process exit can
   leave a dead assignment and later be re-dispatched with the same unresolved
   tag.
7. Worker instructions still describe `changes_requested` as reassignment to
   the reviewer, while runtime code returns the task to an unassigned `todo`
   queue. Merge examples omit the required managed execution fence.
8. Worker commands do not have request idempotency. If a successful MCP result
   is lost, retrying `worker_done` is rejected and cannot distinguish “already
   applied” from “never applied”.

All 169 tests pass, but runner tests mock the dispatcher and lifecycle tests do
not run a real managed child. The critical review-to-integration seam therefore
has no end-to-end failure test.

This is a Complex architectural decision under Cynefin: database transitions
are analyzable, but correctness also depends on external Git and OS side
effects. The implementation must start with a bounded probe.

## Decision drivers

| Driver | Weight | Why it matters here |
|---|---:|---|
| Composite lifecycle correctness | 3 | A stale worker or partial merge must not corrupt workflow truth |
| Single-writer modifiability | 2 | Every new transition currently requires synchronized edits in several files |
| Migration safety | 2 | Existing boards and legacy/manual tasks must remain recoverable |
| Testability | 1 | Allowed and rejected transitions need table-driven and race tests |
| Observability and audit | 1 | Operators must distinguish command, task, process, and external-effect truth |
| Reversibility | 1 | The repair must be deployable and removable incrementally |

Scores use 1 (poor) through 5 (excellent).

## Considered options

### Option A — Snapshot-only transition kernel

Keep the current schema authoritative and route all lifecycle writes through
one transactional command service. This is the smallest and most reversible
centralization, but it cannot durably bridge the SQLite-to-Git crash window.

### Option B — Explicit work items and attempts

Model implementation, review, and integration as separate work items with
append-only attempts. Derive task status from them and retain current task
columns as a compatibility projection. This gives the cleanest semantic
history, but requires a large migration and still needs a durable external
effect protocol for Git.

### Option C — Command kernel with event receipt and integration outbox

Route lifecycle commands through one transactional kernel. Give every command
an idempotency key; atomically store its receipt/result, validate and update the
current snapshots, append a compact domain event, and enqueue external effects.
Keep `tasks` and `worker_executions` authoritative during rollout rather than
adopting full event sourcing. Execute Git integration from a durable intent and
record an observed result after checking repository state.

After Red Team review, option C's additive rollout was rescored as safer and
more reversible than a full event-sourcing migration.

## MCDA matrix

| Option | Correctness (3) | Modifiability (2) | Migration (2) | Testability (1) | Observability (1) | Reversibility (1) | Weighted total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A: snapshot kernel | 3 | 5 | 5 | 5 | 3 | 5 | 42 |
| B: work items | 5 | 4 | 2 | 4 | 5 | 2 | 38 |
| C: kernel + receipt/outbox | 5 | 4 | 4 | 5 | 5 | 4 | 45 |

**Sanity check:** the margin is small. Option C wins because it covers the
highest-severity SQLite/Git crash window without requiring the full semantic
migration of option B. If external Git effects are removed from workers, option
A becomes competitive again.

## Pre-mortem

Assumption: option C was implemented and failed six months later.

1. **Old and new writers coexisted permanently** — likelihood: high;
   detectable: yes, by a CI architecture check and runtime source labels;
   mitigation: migrate one terminal slice at a time and forbid direct writes
   to lifecycle columns outside the projection repository.
2. **An outbox retry duplicated a merge** — likelihood: medium; detectable:
   yes, by command IDs and Git ancestry checks; mitigation: bind the intent to
   repository, source commit, target branch, and expected pre-merge head, then
   make reconciliation observe before acting.
3. **Events and snapshots drifted** — likelihood: medium; detectable: yes, by
   reducer-vs-row comparison after every probe transition; mitigation: append
   receipt/event and update snapshots in one `BEGIN IMMEDIATE` transaction.
4. **The command kernel became another god object** — likelihood: medium;
   detectable: yes, by module dependency and transition-table review;
   mitigation: separate task, execution, and integration aggregates behind one
   dispatch boundary and return declarative effects.
5. **A stuck outbox silently stopped the board** — likelihood: medium;
   detectable: yes, with age/retry/dead-letter metrics in the worker UI;
   mitigation: explicit retry policy, operator-visible failure state, and a
   deterministic admin retry command.

**Net effect:** option C survives as a bounded command/event receipt and outbox
design. Full event sourcing remains rejected.

## Red Team

**Strongest argument against the initial leading option A:**

The critical correctness gap is outside SQLite. The reviewer first commits
`done + pending`, then separately runs `git merge`, then reports
`worker_merge_release`. If it dies after Git changed but before the report, a
snapshot-only kernel cannot know whether merge happened and may repeat or roll
back the wrong semantic step.

**Source in repo:**

- `src/tools/dispatcher.ts` (`worker_done`, merge acquire/release);
- `src/worker-executions.ts` (`done + pending` recovery);
- `tracker-view/claude-runner.mjs` (single-process review/integration protocol).

**Response:**

Accepted. The decision changed from option A to bounded option C. The event log
is not made the source of truth; its immediate purpose is command idempotency,
audit, and durable external-effect intent.

## Decision

Choose **option C: a transactional command kernel with durable command
receipts and integration outbox, while retaining current snapshots as
authoritative projections during rollout**.

Workers emit outcomes; they do not move board columns directly. Controller,
recovery, dependency, admin, and UI paths submit typed commands to the same
kernel. Each command validates the exact task/execution/integration pre-state
under `BEGIN IMMEDIATE`, applies conditional snapshot writes, appends its event
and stored response, and emits declarative effects.

The passive-worker ASK command is terminal: persist the question, return the
task to its unassigned source queue, keep it excluded from dispatch through the
`needs-human` flag, and finish the execution. A human answer clears the flag
and a fresh process resumes from persisted task/comment context.

Git effects use durable intents. A merger must hold a live execution-bound
lock. `release` without `acquire` is rejected. Recovery observes repository
ancestry before retrying or compensating, rather than asking a generic LLM
healer to infer whether the merge occurred.

## Consequences

**Positive:**

- one owner validates the composite state machine;
- passive workers have a protocol that matches their process topology;
- command retries become deterministic;
- Git crash recovery is based on durable intent and observed repository state;
- UI, engine, dependency, and admin paths cannot silently bypass lifecycle
  gates;
- existing snapshots and APIs can be migrated incrementally.

**Negative:**

- commands, receipts, events, and outbox add concepts and writes;
- Git reconciliation must be deliberately idempotent;
- legacy/manual operations need an explicit audited admin command;
- temporary dual-write requires strict comparison and removal milestones.

**Neutral / follow-ups:**

1. Probe the terminal slice: process exit/loss, passive ASK, and integration.
2. Add an architecture test forbidding direct runtime writes to lifecycle
   columns outside the kernel/projection repository.
3. Remove status mutation from `task_batch_update`; add a separately named,
   reason-required admin override.
4. Make claimability a shared query/view used by dispatcher and engine counts.
5. Align `saga-worker` instructions with the runtime transition table.
6. Add one real end-to-end managed test covering implementation, review,
   changes requested, approval, merge, crash, and recovery.
7. Reconsider explicit work items only if repeated review/integration attempts
   require first-class history beyond command events.

## Decision Journal

**Date:** 2026-07-18

**Decision (one line):** Stabilize passive workers with a single transactional
command boundary plus durable receipts and Git integration intents; do not
adopt full event sourcing.

**Ex-ante expectations — IF this decision is right, I expect:**

- In 30 days: terminal/recovery transitions have one production writer;
  `task_batch_update` cannot alter lifecycle fields; ASK parks and releases a
  managed process; release-without-lock is rejected.
- In 90 days: all lifecycle writers use typed commands; command retry tests are
  deterministic; the real managed lifecycle failure suite has no stranded
  `done + pending`, active-without-fence, or fence-with-terminal-execution rows.
- In 6 months: no new incident is caused by a forgotten lifecycle update path,
  and outbox backlog age is visible and bounded.

**Check trigger:** any task/execution invariant repair by manual SQL, any
duplicate/unknown Git merge, or any new direct runtime `UPDATE tasks` touching
the lifecycle columns.

**What would change my mind:** if the bounded kernel/outbox cannot represent
two review/integration cycles without growing conditional state, adopt option B
and make work items/attempts canonical.

## References

- ADR-009: Durable worker executions and canonical verification targets
- `GUARDRAILS.md` signs 003, 004, 010, and 011
- `src/tools/dispatcher.ts`
- `src/worker-executions.ts`
- `tracker-view/claude-runner.mjs`
- `skills/saga-worker/SKILL.md`
