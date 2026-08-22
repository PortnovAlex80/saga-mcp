# W1-2 F-R2 Candidate Fix — One Worker Termination Authority

Date: 2026-08-21
Branch: `w0-waves`
Code commit: `78590106e9f03eff30028a767fff98d5b506b432`
Validation status: NOT RUN in this session by operator request.

## Problem

W1-2 Run B proved that frozen-capsule replay can replace scripted inference for compatible cells, but one reviewer replay fails closed with `MANAGED_NODE_SUBMISSION_SCHEMA_MISMATCH` (F-R1). The capsule becomes ineligible as designed. The next ordinary execution, however, was not created within the drive budget (F-R2).

The immediate cause was not a missing Production Cell recovery rule. It was a divergence in the canonical-fast test adapter.

`tests/factory-e2e/scripted-inference.mjs` replayed through production handlers but then terminalized `worker_executions` with direct SQL (`lost` / `exited`). That bypassed the production physical-termination authority.

The real executor already uses:

`finalizeManagedWorkerProcess()`

for both successful in-process replay and failed replay (`src/infrastructure/workers/claude-board-worker-executor.ts`).

## Decision

There is no replay-specific retry algorithm.

A capsule replay is one implementation of a normal `WorkerExecution`. Therefore every worker termination path — spawned model worker, normal scripted worker, or frozen-capsule replay — must converge on the same production finalizer.

The canonical-fast replay adapter now:

1. marks the execution running with the production `markExecutionRunning` primitive;
2. executes the frozen capsule through the production capsule replay executor and production MCP handlers;
3. emits ordinary `worker_done` on a successful replay;
4. calls `finalizeManagedWorkerProcess()` on both success and failure;
5. reports the returned production termination outcome instead of fabricating `taskReleased`, `workplaceRepairRequested`, or execution state.

## Expected failed-replay transition

```text
reserved WorkerExecution
  -> markExecutionRunning
  -> running
  -> executeCapsuleReplay throws typed validation failure
  -> finalizeManagedWorkerProcess
       -> ConveyorRuntime.releaseExecution(outcome='crashed')
            -> Workplace running -> repair_wait
            -> active reservation cleared
       -> releaseExecutionAtomically(terminalState='lost')
            -> execution terminalized
            -> task fence cleared atomically
            -> Workplace-derived task status preserved
  -> next ProductionCell reconciliation
       -> cell.recovery policy decides requeue vs exhaustion
```

The test adapter does not decide retry count, retry role, or escalation.

## Expected successful-replay transition

```text
reserved WorkerExecution
  -> running
  -> executeCapsuleReplay
  -> ordinary worker_done receipt
  -> finalizeManagedWorkerProcess
       -> semanticCompletion=true
       -> execution='exited'
       -> task fence released
       -> authoritative Workplace/Gate projection preserved
```

## Why this is a kernel-conformance change

This reduces, rather than expands, the test runtime surface.

The test lane still replaces cognition, but it no longer owns termination or recovery semantics. The same production authority now decides:

- semantic completion;
- lost vs exited classification;
- Workplace crash repair;
- atomic task-fence release;
- preservation of the Workplace projection;
- handoff to Production Cell recovery budgets.

This is consistent with ADR-084: no fourth runtime and no test-owned authority model.

## What remains unknown until local validation

Do not mark W1-2 green yet.

The following must be checked locally:

- Run B reaches a terminal lifecycle after the reviewer replay rejection.
- The failed reviewer replay is followed by a new execution under ordinary recovery.
- The ineligible reviewer capsule is not selected again for that replacement execution.
- Compatible Run B cells still perform zero scripted inference calls.
- Run C starts only after Run B releases the lifecycle-scope guard.
- Run C with incompatible semantic input performs cold execution and zero capsule replay.
- No existing canonical-fast crash/adversarial scenario regresses because replay termination now uses the production finalizer.

If Run B still stalls after this change, F-R2 is then a real Production Cell reconciliation defect rather than a replay-adapter terminalization defect. Diagnose the `repair_wait -> requeueForRepair` owner next; do not add another recovery path to the test harness.
