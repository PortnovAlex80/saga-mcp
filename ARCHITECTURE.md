# Saga5 architecture

One event-sourced kernel, declarative workshops, a content-addressed desk.

The normative plan is [`docs/plans/SAGA5-REBUILD-PLAN.md`](docs/plans/SAGA5-REBUILD-PLAN.md);
the board and artifact projections are described in
[`docs/architecture/SAGA5-BOARD-AND-ARTIFACTS.md`](docs/architecture/SAGA5-BOARD-AND-ARTIFACTS.md).
The conveyor's normative meaning lives in
[`docs/architecture/CONVEYOR-MENTAL-MODEL.md`](docs/architecture/CONVEYOR-MENTAL-MODEL.md).

> Documents under `docs/architecture/decisions/` numbered 024–075 belong to
> **saga4** and describe machinery this engine no longer has. They are kept as
> the reasoning trail behind ADR-053, not as current design.

## Three pillars

```text
DECLARATION            KERNEL                        MATERIAL
workflow graph    →    deterministic interpreter  →  content-addressed desk
(n8n shape)            append-only event log         (sealed desk revisions)
                       (Temporal split)
```

- **Declaration** — `{nodes, connections}` JSON. A workshop is data, never
  engine code. The kernel never branches on a workshop's name or meaning.
- **Kernel** — folds the event log and emits command events. Scripted nodes
  execute inside one kernel transaction; activities (LLM, external effects)
  run in worker processes; gates are decided by the kernel over the sealed
  revision.
- **Material** — identity is `sha256(schema_ref, content)`. Which execution
  produced it is provenance, never identity (ADR-053, from the first commit).

## Authority

`events` is the only authority. Every other table is a header or a projection
that can be rebuilt by folding the log.

| Concern | Authority |
|---|---|
| Everything that happened | `events` (append-only, enforced by trigger) |
| Run position | fold of the log (`runs` is a header projection) |
| Produced material | `materials` (immutable, content-addressed) |
| Accepted material | the desk revision a gate accepted |
| Activity attempt | `executions` (lease + heartbeat + typed timeouts) |
| External change | `effects` (idempotency key + typed receipt) |
| Human choice | `operator.resolved` event |
| Kanban card, artifact page, board task | **projections** — never authority |

## Execution loop

1. `workshop_start` (or `factory_start` with a raw graph) registers the graph
   and creates a run.
2. The kernel drives: every runnable node is executed, scheduled or decided.
   Scripted nodes commit `scheduled + started + material + completed` in ONE
   transaction; activities get an `execution` row and wait for a worker.
3. The bridge claims queued executions and spawns one worker process per
   attempt. A worker may only heartbeat and settle **its own** execution, with
   the lease it was handed. Workers never choose work.
4. A gate evaluates the accumulated desk, seals a revision and decides:
   `accepted` | `repair_required` | `human_required`.
5. The sweep is a SELECT, not a supervisor: expired heartbeats become
   `execution.timed_out`, and the retry decision is the kernel's, recorded
   durably.

`waiting` is never `crashed`: a human gate, a queued activity and a repair
cycle are legitimate pauses.

## Quality

- **Acceptance criteria** are positive and satisfied by any surviving desk
  member — accumulation across attempts is a feature.
- **Admission criteria** (`not_contains`) must hold for every member; a
  violating member leaves the desk via `material.superseded` with a durable
  reason, otherwise an accumulating desk could never be repaired.
- Repair reasons travel into the next attempt's prompt, so a worker fixes what
  failed instead of rolling the dice again.
- The operator may answer a human gate by **repairing the material**: an
  operator submission is an ordinary material submission (`author: operator`),
  and the gate re-decides by the same criteria.

## Code layout

- `src/events.ts`, `src/materials.ts`, `src/schema.ts` — the log, the material
  store, the ~12-table schema.
- `src/kernel/` — `runner` (interpreter), `graph`, `node-types` (the plugin
  registry), `gate`, `executions`, `sweep`, `projection`, `board`,
  `artifacts`, `stats`.
- `src/runtime/worker.ts` — the activity worker process (LLM and git effects).
- `src/workshops.ts` — the default workshops as declarative graphs, and THE
  start path.
- `src/operator.ts` — human gate decisions and operator-authored material.
- `src/bridge.ts` — sweep + worker dispatch + JSON API + desk static, one origin.
- `src/tools/` — the MCP surface (board tools from upstream + the kernel tools).
- `desk/` — React Flow desk: board, canvas, artifact wiki.

## Budgets and fitness tests

- Kernel LOC budget ≤ 10 000; schema ≤ 12 tables (plan §5).
- A new table is allowed only if it cannot be expressed as an event or a
  projection of events.
- A new workshop adds a graph — never a tool, an endpoint or a UI branch.
- No consumer selects material by `execution_id`, `task_id` or `latest`.
- `npm test` runs the whole suite (kernel, quality loop, effects, bridge E2E,
  board and artifact projections) with scripted workers — no network, no LLM.
