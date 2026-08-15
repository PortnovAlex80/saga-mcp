# Mandatory recovery/supervision QA addendum

This file is part of the `saga-factory-qa` skill bundle and is mandatory whenever a change touches WorkerExecution supervision, leases, stuck detection, resume, crash recovery, or Workplace reservation recovery.

## RS-01 — classify before renewing

A supervision sweep MUST classify/reconcile existing active executions against the durable PRE-SWEEP lease before extending any worker lease.

Required order:

```text
acquire supervision authority
  -> reconcile active WorkerExecutions using persisted lease/PID/birth identity
  -> terminalize/release stale or orphaned executions
  -> repair Workplace authority and clear stale activeReservationRef
  -> renew leases only for executions that survived reconciliation
```

The following order is a BLOCKER:

```text
renewLeases(all same-host active executions)
  -> reconcile
```

because a restarted orchestrate host can adopt an orphan from the previous host by extending its expired lease before stuck policy observes expiry.

## RS-02 — same host is not same foreman

`machine_id == current hostname` is insufficient proof that the current supervisor owns an execution. Never infer supervisor ownership solely from hostname, worker PID existence, or task ownership.

If renewal can occur before the previous supervisor identity is disproven, QA must require an explicit durable foreman/supervisor owner token. Reordering reconcile before renewal is acceptable only when expired/orphaned executions are guaranteed to be evaluated before renewal.

## RS-03 — expired alive orphan is terminated, not adopted

For a local execution whose durable lease is expired while its worker process is still alive, the expected path is:

```text
expired lease
  -> verify worker PID birth identity
  -> terminate verified orphan
  -> terminal WorkerExecution
  -> clear task execution fence
  -> Workplace running -> repair_wait
  -> clear activeReservationRef
  -> replacement execution gets a fresh reservation
```

Renewing that execution first is FAIL.

## RS-04 — dead orphan repairs both execution and Workplace

A release in `worker_executions/tasks` is insufficient. The same recovery authority must also repair the bound Workplace. `factory_workplaces.loop_state='running'` with `active_reservation_ref` pointing at a terminal execution is a BLOCKER.

## RS-05 — resume starts from durable completed boundary

After the orphan is recovered, same-run resume must not rerun completed ProcessRun/StageRun work. It resumes the unfinished Production Cell/Workplace. Replay Capsules are not the same-run cursor mechanism.

## RS-06 — mandatory falsifying probes

At minimum prove:

1. An active same-host execution with an expired lease is NOT renewed before reconcile.
2. An expired alive execution with matching PID birth identity is terminated/released.
3. A dead execution is released.
4. The bound Workplace leaves `running`, enters `repair_wait` (or declared exhausted state), and clears `activeReservationRef`.
5. A replacement claim installs a new reservation and can complete without `FENCE_MISMATCH`.
6. Completed earlier lifecycle stages remain unchanged during resume.

A source-order regex is a useful permanent ratchet but is NOT sufficient runtime proof. The behavioral crash/resume probe required by the main QA skill remains mandatory.

## RS-07 — diagnosis discipline

When a factory repeatedly exits with an empty queue while unfinished work exists, inspect together:

```text
tasks.status / current_execution_id / assigned_to
worker_executions.state / lease_expires_at / heartbeat_at / progress_at / stuck_state
factory_workplaces.loop_state / active_reservation_ref
current ProcessRun / StageRun / LifecycleRun status
supervision sweep ordering and logs
```

Do not conclude that the model or dispatcher is idle until stale execution authority and Workplace state have been disproven.