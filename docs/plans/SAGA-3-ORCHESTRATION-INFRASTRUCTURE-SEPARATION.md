# Saga 3 — Orchestration / Infrastructure Separation Plan

Date: 2026-07-23
Status: active refactoring plan
Branch: `saga3`

## 1. Objective

Separate Saga 3 deterministic orchestration from SQLite, MCP transport, filesystem writes, process launching, Git observation, and tracker compatibility.

The target boundary is behavioral, not merely directory-based:

```text
Level 1 normative contracts
        ↓
Level 2 application/control decisions
        ↓ commands and ports
Level 3 infrastructure adapters and productive workers
```

Only Level 2 may mutate authoritative Saga state. Infrastructure may observe reality, persist accepted state, execute authorized commands, and transport worker submissions. It may not decide that a condition is satisfied, select terminal outcomes, invent trust, or bypass assignment authority.

## 2. Confirmed violations in the current branch

1. `EpisodeController` contains SQLite statements and persistence error policy.
2. `pipeline-contracts.ts` imports SQLite and creates legacy `tasks` rows.
3. `cli.ts` is a second controller: it owns retries, terminal resource exhaustion, execution state, and condition reload semantics.
4. The LM-facing MCP server writes files, evidence, and condition state directly.
5. Production verification trusts worker-supplied verdicts instead of executing an authorized OraclePort observation.
6. Walking-skeleton tests exercise `controller.ingestOutput`, while production uses direct MCP-to-SQL mutation.
7. The tracker projection is coupled to old `task_kind`, `workflow_stage`, and `workflow.ts` contracts.

## 3. Target modules

```text
src/saga3/
  normative/                 # policies and immutable contracts
  control/
    application/             # use cases / orchestration services
    domain/                  # pure decisions and invariants
    ports/                   # semantic ports
  execution/                 # worker assignment and submission contracts
  infrastructure/
    sqlite/                  # repository implementations
    filesystem/              # artifact writer
    git/                     # source observation
    oracle/                  # command/test runners
    lm/                      # model process adapter
    mcp/                     # transport only
    tracker/                 # read-only projection
  app/                       # composition roots only
```

Existing directories may be moved incrementally, but dependency direction is mandatory immediately:

```text
infrastructure → control ports / domain
app → control + infrastructure
control !→ better-sqlite3, node:fs, child_process, MCP SDK, tracker tables
normative !→ infrastructure
```

## 4. Refactoring sequence

### Slice A — worker submission authority boundary

This commit implements the first slice.

- Add a durable `WorkerSubmission` inbox.
- MCP tools append artifact and verification proposals to the inbox.
- MCP does not write product files, evidence records, or condition state directly.
- `saga3_complete` invokes one application service.
- The application service validates execution/assignment authority.
- Artifact proposals are applied through an `ArtifactWriter` port.
- Verification proposals are executed through `OraclePort`; worker verdict/stdout are not evidence.
- The service attaches controller-owned provenance and persists evidence.
- Condition projection is updated only from accepted evidence.

### Slice B — semantic repositories

- Introduce `EpisodeRepository`, `ConditionRepository`, `WorkIntentRepository`, `AssignmentRepository`, `EvidenceRepository`, `OutcomeRepository`, and `IncidentRepository`.
- Remove `better-sqlite3` imports and raw SQL from `EpisodeController`.
- Replace best-effort persistence with explicit transactional outcomes.

### Slice C — one application pump

- Move retry, recovery, worker lifecycle, terminal certification, and scheduling decisions out of `cli.ts`.
- Make CLI a composition root and process host only.
- One `ReconcileEpisode` use case returns commands such as `LaunchWorker`, `ExecuteOracle`, `ApplyEffect`, `Wait`, or `Terminal`.

### Slice D — tracker projection isolation

- Remove `Database` and legacy task creation from `domain/pipeline-contracts.ts`.
- Move task-row compatibility to `infrastructure/tracker/Saga3TrackerProjection`.
- Projection is write-only from Saga 3 control events and is never read as execution authority.

### Slice E — current source and environment observation

- Observe repository fingerprint through `RepositoryPort` at attestation time.
- Observe environment fingerprint through an environment adapter.
- Invalidate downstream evidence and conditions when source/environment changes.
- Do not mutate frozen EpisodeSpec baselines to represent runtime observations.

### Slice F — production-path tests

Add tests for the exact production chain:

```text
MCP submission
→ durable inbox
→ application authorization
→ artifact adapter
→ OraclePort execution
→ evidence attestation
→ condition projection
```

Also test stale lease, wrong execution, wrong condition, unregistered oracle, failed oracle, duplicate completion, crash before and after each durable boundary, and source invalidation.

## 5. Invariants

1. Worker output is a proposal or raw submission, never authoritative state.
2. Every submission is bound to an existing running assignment and execution.
3. The condition and obligation are resolved from the WorkIntent, not trusted from the worker.
4. The worker cannot choose trust class.
5. A worker-provided verdict is diagnostic only and cannot satisfy a condition.
6. Verification evidence requires an actual OraclePort execution.
7. Artifact application and evidence acceptance are idempotent.
8. Completion is fenced by execution identity and lease epoch.
9. Tracker rows cannot authorize work.
10. CLI and MCP adapters cannot issue terminal outcomes.

## 6. Completion criteria

The separation is complete when:

- `src/saga3/control/**` has no imports from SQLite, filesystem, process, MCP, or tracker modules;
- `EpisodeController` is a pure decision component or delegates persistence exclusively through semantic repositories;
- one application service owns the production reconcile loop;
- MCP handlers contain validation/transport mapping only;
- all authoritative writes occur inside application transactions;
- production and tests use the same submission-ingestion path;
- replacing SQLite or Claude CLI requires changes only in `infrastructure/` and `app/`;
- no old `tasks` or `workflow_stage` row is read as control authority.

## 7. Scope of the first implementation commit

The first implementation commit intentionally does not complete all slices. It establishes the most important authority boundary: LM-facing MCP becomes a submission transport, and a dedicated application service becomes the sole writer of artifacts, evidence, assignment completion, and condition projection for worker completion.
