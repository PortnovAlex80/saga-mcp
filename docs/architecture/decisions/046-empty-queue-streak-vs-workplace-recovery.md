# Investigation: orchestrate-cli exits before workplace recovery completes

## Date
2026-08-10

## Symptom
Factory process exits with "empty-queue streak exhausted" after a worker
exits without worker_done. The workplace is left in `paused/blocked` state.
Manual DB intervention (reset workplace to queued) is required to resume.

## Evidence from glm-test DB (task 12, architecture review)

```
Worker exit:   13:58:17 (exit code 0, no worker_done)
Workplace update: 13:58:20 (→ paused/blocked)  [3 seconds later]
Factory exit:  13:58:22 ("streak exhausted")     [2 seconds later]
```

The factory exited only **5 seconds** after worker exit. During those 5
seconds, supervision had one sweep (30s interval) — it did NOT fire between
worker exit and factory exit.

## Root cause chain

### 1. Worker exits without worker_done → finalizeManagedWorkerProcess

When Claude process exits with code 0 but no `worker_done` receipt,
`finalizeManagedWorkerProcess` (worker-process-termination.ts) detects the
missing receipt and transitions the execution to `lost`.

This is **correct** — exit 0 without receipt is not completion.

### 2. finalizeManagedWorkerProcess → workplace transition

The finalizer calls the coordinator to apply a `worker-crashed` transition.
The production-cell-coordinator transitions the workplace:

```
running/verifying → repair_wait (if attempts < maxAttempts)
                  OR
running/verifying → paused/blocked (if attempts >= maxAttempts)
```

### 3. maxAttempts = 2 is too low for reviewer tasks

Formalization cells define `maxAttempts: 2, onExhausted: 'pause'`. After
2 gate-repair rejections, the workplace goes to `paused/blocked`.

For task 12 (architecture review), the timeline was:

```
gate decisions: 6 × repair_required, 2 × accepted
worker executions: 6 (across multiple manual resets)
workplace revision: 38
```

The gate rejected 6 times. With maxAttempts=2, the workplace went to
`paused/blocked` after the 2nd rejection **within a single execution attempt**.
Manual resets gave more attempts, but each time maxAttempts=2 was exhausted
within 2 retries, and the workplace blocked.

### 4. paused/blocked workplace is invisible to dispatcher

`findNextClaimable` (work-assignment-core.ts line 424-442) requires:

```sql
w.loop_state IN ('idle','queued')
OR (w.loop_state IN ('leased','running','verifying') AND NOT EXISTS active exec)
```

`paused` is NOT in either branch. A paused workplace is invisible.

### 5. orchestrate-cli empty-queue-streak fires immediately

With `dispatched = 0` and no active executions and no claimable tasks:

```
Cycle 1: dispatched=0 → activeExecutions.n=0 → streak 1/3 → sleep 2s
Cycle 2: dispatched=0 → activeExecutions.n=0 → streak 2/3 → sleep 2s
Cycle 3: dispatched=0 → activeExecutions.n=0 → streak 3/3 → BREAK
```

Total elapsed: ~6 seconds. Supervision sweep interval: 30 seconds.
Supervision never gets a chance to reconcile.

### 6. Even if supervision fired, paused/blocked needs operator recovery

The `onExhausted: 'pause'` policy means the factory deliberately blocks the
workplace for human intervention. This is **by design** — maxAttempts
exhausted = semantic defect that the model cannot fix by retrying.

Supervision reconcile releases orphaned executions and requeues
`repair_wait` workplaces. But `paused/blocked` is NOT `repair_wait` — it
is a deliberate human-required stop. Supervision correctly does NOT
auto-recover paused workplaces.

## Why Discovery tasks don't hit this

Discovery cells use `typed-submission` with `product_submit`. The model
reliably calls product_submit → worker_done. No repair loop.

Formalization author cells use `managed-production`. Before fix 3d86044,
worker_done was rejected (PRODUCTION_CELL_PRODUCT_REQUIRED). After fix,
worker_done is accepted but the formalization gate can still reject the
product (FORMALIZATION_CONTRACT_INCOMPLETE). Each rejection consumes one
repair attempt. With maxAttempts=2, two rejections = blocked.

## Fix applied (commit 3100ce1)

Before counting emptyDispatchStreak, check if there are non-terminal
workplaces in the current lifecycle run. If yes, wait 5s and continue
instead of counting a stuck streak.

This gives supervision time to requeue `repair_wait` workplaces. It does
NOT auto-recover `paused/blocked` workplaces (those need operator
intervention by design).

## Remaining architectural gap

`paused/blocked` after maxAttempts exhaustion is correct behavior. But the
factory provides no operator API to resume a paused workplace from within
orchestrate-cli. The `factory-start.ts` `resumePausedSubmissionWorkplace`
function exists but is not wired into the dispatch loop — it requires an
explicit operator call with actorId + reason.

For LLM runs where the model's repair attempt is non-deterministic,
maxAttempts=2 is too conservative. The model may need 3-5 attempts to
satisfy the formalization gate. Options:

1. Increase maxAttempts for formalization cells (2 → 5)
2. Add auto-resume for paused workplaces with a backoff
3. Keep maxAttempts=2 but add operator-friendly resume API
