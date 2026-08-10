# ADR-047: Workplace recovery is kernel-driven; pause is an explicit boundary

- Status: accepted
- Date: 2026-08-10
- Corrects: investigation 046 and tactical fix 3100ce1

## Observed symptom

A real GLM-4.7 run could finish a worker process while the lifecycle remained
paused. The CLI then reported an empty queue and exited, after which an operator
manually changed Workplace/task rows to continue.

Investigation 046 correctly identified the visible timing race and the small
Formalization retry budget, but its recovery-driver model was incomplete.

## Verified runtime model

`worker-crashed` / `worker-lost` moves a running Workplace to `repair_wait`.
The periodic WorkerSupervisionService reconciles durable WorkerExecutions and
leases; it does not perform the semantic `repair_wait -> queued` transition.

That transition belongs to `ProductionCellNodeExecutor.reconcile()`. On the
next `runEpisode` it reads `repair_wait`, evaluates the bounded recovery budget,
and either:

- calls `coordinator.requeue(...)` and projects the role task again; or
- on exhaustion, applies `human_required`, producing `blocked/paused`.

Therefore waiting for a 30 second supervision timer is not the normal repair
mechanism. The CLI should promptly return kernel-owned states to `runEpisode`.

## Defects in 3100ce1

1. It joined `factory_lifecycle_runs.current_stage_run_id` directly to
   `factory_workplaces.process_run_id`. These are different identities.
   Correct lineage is:

   `LifecycleRun.current_stage_run_id -> StageRun.id -> StageRun.process_run_id -> Workplace.process_run_id`.

2. It classified `paused` as pending automatic recovery. `paused` is the
   explicit `onExhausted: pause` / human-required boundary. Supervision does not
   auto-resume it, so the CLI could wait forever.

3. It relied on a 5 second sleep to give a 30 second watchman time to act even
   though `repair_wait` is synchronously driven by the next lifecycle pass.

## Decision

At an empty dispatch boundary the CLI now:

1. performs one immediate supervision reconciliation to collapse any stale
   WorkerExecution fence without waiting for the periodic timer;
2. reads current-stage Workplaces through the exact StageRun -> ProcessRun
   binding;
3. immediately resumes lifecycle processing for `repair_wait`, `verifying` and
   `effect_pending` without consuming the empty-queue streak;
4. stops cleanly in `paused` and reports that explicit resume is required;
5. uses the bounded empty-queue streak only when neither an active execution nor
   a kernel-owned transition explains the pause.

## Formalization recovery budget

Formalization uses independent author and reviewer gates. The attempt counter is
role-scoped CandidateSet history across the whole Workplace, so `maxAttempts=2`
means only an initial candidate plus one repair for that role. An author-gate
format repair can therefore consume the same finite budget needed later for a
reviewer-proven semantic defect.

For Formalization only, the bounded budget is raised to 5 total attempts per
role (initial production plus up to four repair rounds). `onExhausted='pause'`
remains unchanged: repeated failure still stops at an explicit human boundary;
there is no infinite auto-resume.

## Non-goals

This change does not make `paused` automatically recoverable and does not remove
bounded retry policy. It also does not redesign the crash-attempt counter; that
counter has a separate edge case when a role already has sealed CandidateSets
and a later repair worker crashes before sealing a new one.
