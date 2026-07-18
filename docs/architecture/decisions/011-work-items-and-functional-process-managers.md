# ADR-011: Work items implemented by functional process managers

- **Status:** Proposed
- **Date:** 2026-07-18
- **Supersedes:** —
- **Superseded by:** —
- **Decision-maker:** autonomous-decision review

## Context

ADR-010 chose a typed command kernel, durable command receipts, and an
integration outbox for passive workers. This decision refines the internal
model and implementation patterns.

Three facts drive the refinement:

1. `tasks.status` currently represents queue availability, semantic phase,
   assignment, and partial completion.
2. `worker_executions.phase` is process telemetry. It is not independently
   claimable work with an outcome and retry history.
3. A successful review is currently rewound to `review` when its same-process
   integration execution dies. If it is not rewound, `done + pending` has no
   independently claimable unit to resume.

The implementation must preserve accepted review outcomes, support fresh
attempts for passive one-shot processes, and remain incrementally deployable.

## Decision drivers

| Driver | Weight | Why it matters |
|---|---:|---|
| Lifecycle correctness | 3 | A failed attempt must not erase an earlier successful phase |
| Conceptual clarity | 2 | Task, semantic work, retry, and OS process need distinct meanings |
| Migration and reversibility | 2 | Existing boards need a staged compatibility path |
| Testability | 1 | Pure transition and failure tests must be deterministic |
| Operational simplicity | 1 | Operators must understand and recover stuck work |
| Extensibility | 1 | Human waits and integration retries are already real phases |

Scores use 1 (poor) through 5 (excellent).

## Considered options

### Option A — Transaction scripts

Put each lifecycle transition in one explicit SQLite transaction and call the
functions from current handlers. This has the lowest abstraction and migration
cost, but retains duplicated validation and an incomplete state model.

### Option B — Functional command kernel over current snapshots

Use Functional Core / Imperative Shell, Ports and Adapters, typed commands,
receipts, events, and specialized process managers. Keep `tasks` and
`worker_executions` canonical indefinitely.

This cleanly centralizes transitions, but the snapshots still cannot represent
an approved review plus a separately retryable integration operation without
another implicit axis.

### Option C — Canonical work items and attempts

Treat a task as a stable goal. Persist implementation, review, integration,
human decision, and cleanup as work items. Persist every try as an attempt and
link the OS process through `worker_executions`.

Implement the model with the patterns from option B: pure reducers, a typed
command boundary, ports/adapters, command receipts, transactional outbox, and
small process managers. Keep current task columns as a materialized
compatibility projection during migration.

## MCDA matrix

| Option | Correctness (3) | Clarity (2) | Migration (2) | Testability (1) | Operations (1) | Extensibility (1) | Weighted total |
|---|---:|---:|---:|---:|---:|---:|---:|
| A: transaction scripts | 3 | 3 | 5 | 3 | 4 | 2 | 34 |
| B: kernel/current snapshots | 3 | 5 | 4 | 5 | 3 | 4 | 39 |
| C: work items + functional managers | 5 | 5 | 3 | 5 | 3 | 5 | 44 |

**Sanity check:** option C costs more to migrate, but the schema additions are
additive and `worker_executions` already supplies much of the attempt backfill.
The correctness gap in option B is structural rather than an implementation
detail.

## Pre-mortem

Assumption: option C was implemented and failed six months later.

1. **Task, item, attempt, and execution became four names for the same thing**
   — likelihood: medium; detectable: yes, in APIs and onboarding; mitigation:
   enforce one responsibility for each entity and never copy PID/liveness into
   attempts.
2. **Legacy task columns and item projections coexisted forever** — likelihood:
   high; detectable: yes, by projection mismatch metrics and direct-writer CI;
   mitigation: define a cutover slice and removal release before dual-write
   starts.
3. **Migration invented false historical attempts** — likelihood: medium;
   detectable: yes, by import metadata; mitigation: create only a synthetic
   current pipeline and mark `history_complete=false`.
4. **A generic workflow engine replaced understandable code** — likelihood:
   medium; detectable: yes, when task kinds start defining runtime JSON graphs;
   mitigation: fixed typed templates and no workflow DSL.
5. **Queries and UI became slow or confusing** — likelihood: medium;
   detectable: yes, through projection latency and operator tests; mitigation:
   retain a materialized board projection and expose task/item/attempt/process
   separately.

**Net effect:** option C survives with a staged cutover, fixed workflow
templates, and strict entity boundaries.

## Red Team

**Strongest argument against the initial leading option B:**

Pure reducers can make an incomplete model deterministic, but cannot make it
complete. Current recovery must either erase a successful review when
integration dies or leave an unclaimable `done + pending` task. An integration
retry needs its own durable, claimable semantic state.

**Source in repo:**

- `src/tools/dispatcher.ts` changes one execution from reviewing to integrating;
- `src/worker-executions.ts` rewinds `done + pending` to review on process loss.

**Response:**

Accepted. Choose option C. Retain option B's implementation patterns and use its
snapshot-only form only as the first stabilization slice, not as the target
domain model.

## Decision

Choose **canonical work items and attempts, implemented through a functional
typed command kernel and specialized process managers**.

The responsibilities are:

- `task`: stable goal, provenance, priority, and dependencies;
- `work_item`: one semantic phase and immutable terminal outcome;
- `work_attempt`: one retryable try at a work item;
- `worker_execution`: OS-process/delivery truth for an attempt;
- `tasks.status`: materialized compatibility board projection.

The write architecture uses Functional Core / Imperative Shell and Ports and
Adapters. Commands are idempotent through stored receipts. External effects use
an outbox. Worker, human-wait, and integration coordination use separate small
process managers. No generic event bus or full event sourcing is adopted.

Rollout begins with the terminal execution command kernel while current
snapshots remain authoritative. Work items are then shadow-written, backfilled
honestly, projection-compared, and made canonical only after equivalence and
failure probes pass.

## Consequences

**Positive:**

- review success survives integration retries;
- passive processes own attempts rather than tasks;
- human waits terminate one attempt and resume through another;
- task completion has one derived definition;
- retry history and current work are observable without interpreting comments;
- implementation logic remains pure and testable.

**Negative:**

- new tables, concepts, migrations, projections, and operator views are needed;
- exports/imports and UI queries must support compatibility fields;
- dual-model rollout requires strict deadlines and comparison tooling.

**Neutral / follow-ups:**

- use the implementation plan in
  `docs/architecture/passive-worker-kernel-blueprint.md`;
- keep fixed workflow templates;
- reassess event sourcing only through a separate ADR;
- retain old columns until rollback and export compatibility are proven.

## Decision Journal

**Date:** 2026-07-18

**Decision (one line):** Model semantic phases as canonical work items and
retries as attempts, implemented with a functional command kernel and process
managers.

**Ex-ante expectations — IF this decision is right, I expect:**

- In 30 days: terminal recovery uses one command path and the work-item shadow
  projection represents `done + pending` as approved review plus ready
  integration.
- In 90 days: managed claims address work items/attempts, ASK resumes through a
  fresh attempt, and an integration loss does not reopen review.
- In 6 months: no new lifecycle fix requires interpreting task status and
  process phase as one state machine.

**Check trigger:** projection mismatch, a lifecycle incident that requires
rewinding a completed work item, or a new semantic phase encoded only as a tag
or process phase.

**What would change my mind:** if the shadow model cannot reduce direct writers
or makes common task queries materially harder without preventing real failure
modes, stop the cutover and retain the command kernel with snapshots.

## References

- ADR-009: Durable worker executions and canonical verification targets
- ADR-010: Passive worker command kernel and durable integration intents
- `docs/architecture/passive-worker-kernel-blueprint.md`
- `GUARDRAILS.md` signs 003, 004, 010, and 011
