# Saga 2 Runtime Contract Inventory

Date: 2026-07-23
Status: Phase A baseline
Stable branch: `saga2`
Refactoring branch: `saga2-refactoring`
Frozen source commit: `6d8c68ad802a800b1519d9794efeff0091a55460`

## 1. Purpose

This document records the runtime behavior that already works in Saga 2 and must survive the architecture refactoring unchanged.

Phase A does not redesign these contracts. It makes them explicit and observable so later extraction work cannot silently lose configuration, frontend behavior, worker protocol details, persistence semantics, artifact handling, or workflow progression.

The stable `saga2` branch is the operational reference. All refactoring work happens in `saga2-refactoring`.

## 2. System boundary

Saga 2 currently consists of five collaborating runtime areas:

1. Orchestration engine — selects work, launches workers, advances workflow stages, handles recovery, and closes episodes.
2. Worker runtime — Claude CLI or an LM Studio-routed Claude CLI process driven through the board runner and Saga MCP tools.
3. Persistence and lifecycle — SQLite schema, task transitions, worker execution fencing, evidence, integration intents, activity records, and artifact traces.
4. Administrative frontend — tracker board, workflow visibility, model and concurrency controls, worker logs, artifacts, and wiki editing.
5. Product workspace — Git repositories, worktrees, generated files, accepted artifacts, hashes, traces, and integration branches.

The future replaceable engine must not require replacement of areas 2-5.

## 3. Stable entrypoints

The following package commands are part of the current operating contract:

| Command | Contract |
|---|---|
| `npm run build` | Compile TypeScript with `tsc`. |
| `npm run start` | Start the Saga MCP server from `dist/index.js`. |
| `npm run tracker` | Start the tracker frontend from `tracker-view/tracker-view.mjs`. |
| `npm run docs-graph` | Start the artifact/document graph viewer. |
| `npm test` | Compile and run the Node test suite. |
| `npm run test:e2e` | Run the autonomous engine subprocess smoke test. |
| `npm run mock:run` | Run the orchestration CLI with the mock Claude process. |

Removing, renaming, or changing the semantics of these commands requires an explicit contract change.

## 4. Configuration contract

The current runtime reads configuration from process environment, episode metadata, Claude settings, and persisted project/repository records.

Known externally significant environment variables include:

| Variable | Current responsibility |
|---|---|
| `DB_PATH` | Shared SQLite database used by MCP, engine, and tracker. |
| `TRACKER_AUTOSTART` | Controls tracker startup from the MCP process. |
| `SAGA_CLAUDE_PATH` | Selects the Claude-compatible executable. |
| `SAGA_LMSTUDIO_URL` | LM Studio endpoint used by worker routing. |
| `PORT` | Tracker HTTP port. |
| `RELOAD_SEC` | Tracker refresh interval. |
| `SAGA_ORCHESTRATION_MODE` | Existing orchestration mode selector; preserved during Phase A. |

Configuration precedence and defaults are behavioral contracts. Phase B may wrap them in a typed configuration object, but must not change their effective values or precedence in the same change.

## 5. Worker execution contract

The stable worker boundary is implemented by `tracker-view/claude-runner.mjs` and the Saga MCP tool surface.

### 5.1 Assignment envelope

A launched worker receives at least:

- project ID and project name;
- task ID;
- worker ID;
- execution ID when fencing is active;
- role and dispatcher-selected skill;
- task kind and workflow stage;
- execution mode;
- repository/workspace identity;
- serialized assigned task payload;
- MCP configuration pointing to the shared `DB_PATH`.

### 5.2 Mandatory worker behavior

The worker is instructed to:

- work only on the assigned task;
- never call `worker_next` from a single-use process;
- read the selected Skill while skipping task-claim instructions;
- call `worker_done` exactly once;
- include `execution_id` in fenced lifecycle calls;
- call `verification_record` for `verification.ac` work;
- use `worker_merge_acquire` and `worker_merge_release` for required integration;
- stop after the assigned terminal protocol instead of claiming another task.

### 5.3 Process observations

The runner exposes and persists:

- process ID;
- run ID;
- worker ID;
- execution ID;
- start and finish state;
- exit code or spawn failure;
- JSONL log path;
- heartbeat events;
- active/completed/failed/claimed counters;
- concurrency ceiling and runtime changes.

These fields are consumed by the engine and frontend and therefore form a compatibility contract.

## 6. MCP contract

Saga MCP is the worker's operational surface. The exact schemas must be inventoried from the registered tool definitions before extraction, but these protocol families are already compatibility-critical:

- project, epic, task, dependency, and repository queries;
- task claim and lifecycle completion;
- comments and recovery summaries;
- artifact create/save/update/list/get;
- artifact trace create/list;
- verification evidence recording;
- worker need/done protocol;
- merge lock acquire/release;
- workflow generation and episode transitions;
- model/provider and administrative controls exposed through the host.

During Phase A, MCP names, required parameters, return shapes, and error semantics are frozen.

## 7. Persistence contract

The same SQLite database is shared by the MCP server, orchestration process, and tracker. WAL-based concurrent access and idempotent initialization are operational requirements.

At minimum, the following persisted concepts must remain readable and writable through the refactoring:

- projects and epics;
- episode workflows and stages;
- tasks and task dependencies;
- task/work attempts and current execution identity;
- worker executions and process observations;
- repositories and machine checkouts;
- artifacts, accepted hashes, drift state, and artifact traces;
- verification evidence;
- integration intents and integration state;
- activity log and comments;
- model/provider metadata and operational flags.

Schema changes are outside Phase A. Characterization tests must use the current schema rather than a new abstraction schema.

## 8. Frontend and board contract

The tracker is an administrative projection over the same database, not the orchestration engine.

The current frontend contract includes:

- project index and per-project kanban;
- columns `todo`, `in_progress`, `review`, `review_in_progress`, `done`, and `blocked`;
- episode stage and gate-error visibility;
- active worker panel with PID, worker ID, task ID, start time, and log path;
- model/provider and concurrency administration;
- engine start, stop, restart, and status controls;
- artifact tree, trace links, accepted/drift state, markdown view, and edit/save behavior;
- worker log tail and heartbeat visibility;
- use of `DB_PATH` as the single shared data source.

The frontend may later depend on projection interfaces, but its current HTTP behavior and visible data must remain unchanged while those interfaces are introduced.

## 9. Workflow contract

The displayed stage sequence currently includes:

`discovery -> formalization -> planning -> development -> verification -> integration -> completed`

The operational contract is broader than the stage name:

- workflow generation creates tasks with specific `task_kind`, `workflow_stage`, `execution_skill`, `execution_mode`, dependencies, and artifact provenance;
- dispatcher admission respects task state, dependencies, repository availability, execution ownership, and conflict rules;
- lifecycle commands produce the expected task and review transitions;
- stage gates inspect accepted artifacts, traces, verification, integration state, and pending work;
- recovery may create or reopen work but must preserve the same board/process contracts;
- an episode that is currently able to finish on Saga 2 must still finish after each refactoring slice.

## 10. Artifact contract

The existing artifact subsystem must preserve:

- physical file path;
- artifact type and code;
- project and epic ownership;
- status lifecycle;
- content hash and accepted hash;
- drift detection;
- parent relationship;
- trace relationships such as `derived_from`, `implements`, `verified_by`, and `depends_on`;
- frontend tree and wiki rendering;
- save/edit behavior that updates the file and metadata consistently.

The engine may request artifacts, but filesystem and artifact persistence behavior belong outside the future engine implementation.

## 11. Existing characterization coverage

The repository already contains important behavioral suites. They are part of the Phase A safety net and must not be replaced by tests of a new architecture:

- `tests/product-workflow.test.mjs` — discovery/formalization and workflow generation behavior;
- `tests/e2e-pipeline.test.mjs` — real orchestration pump plus subprocess worker contract for verification through completion;
- `tests/mock-claude.mjs` — stable subprocess replacement for worker protocol testing;
- lifecycle, dispatcher, artifact, trace, integration, and schema tests discovered by `node --test`.

The new `tests/characterization/saga2-runtime-contracts.test.mjs` adds a static compatibility perimeter around package commands and cross-process integration anchors. It is deliberately additive.

## 12. Phase A characterization matrix

| Scenario | Required observation |
|---|---|
| Project creation | Project is persisted and visible to the tracker. |
| Epic creation | Epic is linked to the project and can own a workflow. |
| First workflow work | Expected task kind, stage, skill, mode, and provenance are created. |
| Worker assignment | One task is claimed with worker and execution identity. |
| Worker launch | Process, log, heartbeat, and MCP config are created. |
| Worker completion | `worker_done` drives the expected lifecycle transition exactly once. |
| Review | Review queue and reviewer completion retain their current states. |
| Verification | Evidence is tied to the canonical artifact/task and affects the gate. |
| Integration | Merge ownership and integration state are durable and observable. |
| Next-stage generation | Completed work creates or enables the correct downstream work. |
| Artifact tree | Files, hashes, accepted state, drift, and traces remain visible. |
| Provider selection | Claude/LM Studio routing preserves current configuration semantics. |
| Recovery | Spawn failures, crashed workers, and gate failures preserve retry/recovery behavior. |
| Full episode | A known Saga 2 episode reaches its current terminal state. |

## 13. Refactoring rules for Phase B

1. One boundary at a time.
2. No simultaneous behavior improvement and dependency extraction.
3. No schema replacement while extracting repositories.
4. No frontend rewrite while extracting projections.
5. No worker prompt/protocol rewrite while extracting `WorkerExecutor`.
6. Every patch must pass the Saga 2 characterization suite.
7. The stable `saga2` branch is not used for experiments.
8. Saga 3 research code may be mined for ideas, but is not merged wholesale.

## 14. Phase A exit criteria

Phase A is complete when:

- `saga2` points to the frozen working baseline;
- `saga2-refactoring` was created from the same commit;
- the current runtime contracts are documented;
- existing behavioral tests are identified and runnable;
- static compatibility tests protect the major cross-process anchors;
- at least one known full Saga 2 run is recorded as a reproducible acceptance fixture;
- no production behavior has changed.

The immutable Git tag remains an operational follow-up because the currently connected GitHub tool can create branches but not tag refs. The exact frozen commit is recorded above so the tag can be created later without ambiguity.
