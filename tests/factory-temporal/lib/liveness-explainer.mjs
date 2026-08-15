// tests/factory-temporal/lib/liveness-explainer.mjs
//
// Pure read-only Factory liveness explainer (ADR-048 temporal conformance).
//
// Classifies a Factory state snapshot as one of:
//   progressing | waiting_expected | stalled | inconsistent_state | terminal
//
// # Contract
//
//   - Opens ONE consistent READ-ONLY snapshot of the SQLite DB via
//     better-sqlite3 { readonly: true }. NEVER mutates Factory authority.
//   - Resolves the chain FactoryOrder -> LifecycleRun -> StageRun ->
//     ProcessRun -> NodeRun -> Workplace -> WorkerExecution -> CandidateSet
//     -> GateRun -> GateDecision, mirroring CONVEYOR-TRANSITION-DIAGNOSTICS §1.
//   - For every non-terminal scope, evaluates the PROGRESS-OBLIGATION
//     invariant: at least one of
//       (a) a valid live owner — worker_executions.state IN
//           ('reserved','running','cancel_requested') on the workplace's
//           active_reservation_ref;
//       (b) an enabled idempotent kernel command — workplace loop_state
//           repair_wait below the recovery budget (kernel requeues) OR
//           effect_pending with an in-flight acceptance effect OR
//           verifying with a pending GateRun;
//       (c) a typed wait with a wake source — paused with an open
//           human_requests row, or a GateDecision verdict 'human_required';
//       (d) a committed transition obligation awaiting routing — a terminal
//           ProcessRun (or terminal workplace) not yet journaled into
//           factory_process_transitions.
//     If NONE holds, classify `stalled` with a reason code.
//   - If durable authorities CONTRADICT one another
//     (worker_executions.state='exited' + tasks.status='in_progress' +
//     workplace loop_state='verifying' with no pending GateRun and no
//     kernel transition), classify `inconsistent_state`.

import Database from 'better-sqlite3';

/** worker_executions states that count as a LIVE owner. */
const LIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);
/** loop_states the kernel requeues/seals itself (idempotent). */
const KERNEL_DRIVEN_LOOP_STATES = new Set(['repair_wait', 'verifying', 'effect_pending']);
/** lifecycle_run.status values that are terminal. */
const TERMINAL_LIFECYCLE_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Explain the liveness of the Factory run rooted at the given DB.
 *
 * @param {string} dbPath - absolute path to the saga SQLite DB file.
 * @param {object} [opts]
 * @param {number} [opts.projectId] - optional scope
 * @param {number} [opts.lifecycleRunId] - optional explicit lifecycle run.
 * @param {number} [opts.staleThresholdMs] - max age of a running NodeRun's
 *   started_at before it is considered stale (host cycle budget). A stale
 *   'running' row does NOT prove the kernel is cycling — the host process
 *   may have died without terminalizing the row. Default 60000 (60s).
 */
export function explainFactoryLiveness(dbPath, opts = {}) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return explainWith(db, opts);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Core classifier.
// ---------------------------------------------------------------------------

function explainWith(db, opts) {
  const lifecycle = resolveLifecycleRun(db, opts);
  if (!lifecycle) {
    return incident({
      classification: 'inconsistent_state',
      reasonCode: 'unknown-scope',
      retryClass: 'reconcile',
      landmark: emptyLandmark(),
      authorities: emptyAuthorities(),
      detail: 'No resumable FactoryOrder/LifecycleRun resolves for the given scope.',
    });
  }

  const landmark = resolveCurrentLandmark(db, lifecycle);
  if (TERMINAL_LIFECYCLE_STATUSES.has(lifecycle.status)) {
    const routed = readTerminalTransition(db, lifecycle.id);
    if (routed) {
      return incident({
        classification: 'terminal',
        reasonCode: 'lifecycle-terminal',
        retryClass: 'terminal',
        landmark,
        authorities: emptyAuthorities(),
        evidenceRefs: [routed.transition_key],
        detail: `LifecycleRun id=${lifecycle.id} status='${lifecycle.status}' with journaled terminal transition '${routed.transition_key}'.`,
      });
    }
    return incident({
      classification: 'waiting_expected',
      reasonCode: 'routing-pending',
      retryClass: 'wait',
      landmark,
      authorities: emptyAuthorities(),
      detail: `LifecycleRun id=${lifecycle.id} reached status='${lifecycle.status}' but no factory_process_transitions row of target_type='terminal' was journaled yet.`,
    });
  }

  if (!landmark.processRunId) {
    return incident({
      classification: 'inconsistent_state',
      reasonCode: 'unknown-scope',
      retryClass: 'reconcile',
      landmark,
      authorities: emptyAuthorities(),
      detail: `Current StageRun id=${landmark.stageRunId} has no bound ProcessRun. LifecycleRun id=${lifecycle.id} cannot be progressed.`,
    });
  }

  const workplaces = readWorkplacesForProcessRun(db, landmark.processRunId);
  if (workplaces.length === 0) {
    return incident({
      classification: 'waiting_expected',
      reasonCode: 'routing-pending',
      retryClass: 'wait',
      landmark,
      authorities: emptyAuthorities(),
      detail: `ProcessRun id=${landmark.processRunId} has no materialized workplaces yet; cell materialization pending.`,
    });
  }

  const kernelAlive = readKernelAlive(db, landmark.processRunId, {
    staleThresholdMs: opts.staleThresholdMs ?? 60_000,
  });
  let progressedAny = false;
  let waitingExpected = null;
  let stalled = null;
  let inconsistent = null;

  for (const wp of workplaces) {
    if (wp.loop_state === 'terminal') continue;
    const verdict = classifyWorkplace(db, wp, kernelAlive);
    if (verdict.classification === 'progressing') {
      progressedAny = true;
    } else if (verdict.classification === 'waiting_expected' && !waitingExpected) {
      waitingExpected = verdict;
    } else if (verdict.classification === 'stalled' && !stalled) {
      stalled = verdict;
    } else if (verdict.classification === 'inconsistent_state' && !inconsistent) {
      inconsistent = verdict;
    }
  }

  if (inconsistent) return withLandmark(inconsistent, landmark);
  if (stalled) return withLandmark(stalled, landmark);
  if (waitingExpected) return withLandmark(waitingExpected, landmark);
  if (progressedAny) {
    return incident({
      classification: 'progressing',
      reasonCode: 'live-worker-progress',
      retryClass: 'wait',
      landmark,
      authorities: emptyAuthorities(),
      detail: `At least one workplace on ProcessRun id=${landmark.processRunId} has a live owner or enabled kernel transition.`,
    });
  }

  return incident({
    classification: 'waiting_expected',
    reasonCode: 'routing-pending',
    retryClass: 'wait',
    landmark,
    authorities: emptyAuthorities(),
    detail: `All workplaces on ProcessRun id=${landmark.processRunId} are terminal but LifecycleRun id=${lifecycle.id} is still '${lifecycle.status}'.`,
  });
}

// ---------------------------------------------------------------------------
// Per-workplace classifier — evaluates the four-clause progress obligation.
// ---------------------------------------------------------------------------

function classifyWorkplace(db, wp, kernelAlive) {
  const authorities = collectAuthorities(db, wp);
  const evidenceRefs = [];

  // Clause (c): typed wait with a wake source (paused + human request).
  if (wp.loop_state === 'paused') {
    const openHuman = readOpenHumanRequest(db, wp.workplace_ref);
    if (openHuman) {
      evidenceRefs.push(openHuman.request_id);
      return incident({
        classification: 'waiting_expected',
        reasonCode: 'human-required-pause',
        retryClass: 'human',
        authorities,
        evidenceRefs,
        detail: `Workplace ${wp.workplace_ref} paused with open human_requests.request_id='${openHuman.request_id}'.`,
      });
    }
    if (kernelAlive) {
      return incident({
        classification: 'progressing',
        reasonCode: 'kernel-requeue-progress',
        retryClass: 'wait',
        authorities,
        detail: `Workplace ${wp.workplace_ref} paused; kernel orchestrator is cycling.`,
      });
    }
    return incident({
      classification: 'stalled',
      reasonCode: 'kernel-transition-not-driven',
      retryClass: 'safe_retry',
      authorities,
      detail: `Workplace ${wp.workplace_ref} paused with no open human_requests row and no live NodeRun.`,
    });
  }

  // Clause (a): valid live owner.
  if (hasLiveOwner(authorities)) {
    return incident({
      classification: 'progressing',
      reasonCode: 'live-worker-progress',
      retryClass: 'wait',
      authorities,
      detail: `Workplace ${wp.workplace_ref} loop='${wp.loop_state}' has live worker_executions.state='${authorities.workerExecutionState}'.`,
    });
  }

  if (KERNEL_DRIVEN_LOOP_STATES.has(wp.loop_state)) {
    if (wp.loop_state === 'repair_wait') {
      if (kernelAlive) {
        return incident({
          classification: 'progressing',
          reasonCode: 'kernel-requeue-progress',
          retryClass: 'wait',
          authorities,
          detail: `Workplace ${wp.workplace_ref} in repair_wait; kernel will requeue within recovery budget.`,
        });
      }
      return incident({
        classification: 'stalled',
        reasonCode: 'kernel-transition-not-driven',
        retryClass: 'safe_retry',
        authorities,
        detail: `Workplace ${wp.workplace_ref} in repair_wait but no live NodeRun on its ProcessRun.`,
      });
    }
    if (wp.loop_state === 'verifying') {
      const pendingGate = readPendingGateRun(db, wp.workplace_ref);
      if (pendingGate) {
        evidenceRefs.push(pendingGate.gate_run_ref);
        return incident({
          classification: 'waiting_expected',
          reasonCode: 'pending-gate',
          retryClass: 'wait',
          authorities,
          evidenceRefs,
          detail: `Workplace ${wp.workplace_ref} verifying with GateRun ref='${pendingGate.gate_run_ref}' in state='${pendingGate.state}'.`,
        });
      }
      const sealedCandidate = readLatestCandidateSet(db, wp.workplace_ref);
      if (sealedCandidate && kernelAlive) {
        evidenceRefs.push(sealedCandidate.candidate_set_ref);
        return incident({
          classification: 'progressing',
          reasonCode: 'gate-progress',
          retryClass: 'wait',
          authorities,
          evidenceRefs,
          detail: `Workplace ${wp.workplace_ref} verifying with sealed CandidateSet='${sealedCandidate.candidate_set_ref}'; kernel will open the GateRun.`,
        });
      }
      if (authorities.workerExecutionState
          && authorities.workerExecutionState !== null
          && !LIVE_EXECUTION_STATES.has(authorities.workerExecutionState)
          && authorities.taskStatus === 'in_progress') {
        return incident({
          classification: 'inconsistent_state',
          reasonCode: 'durable-identity-divergence',
          retryClass: 'reconcile',
          authorities,
          detail: `Workplace ${wp.workplace_ref} loop_state='verifying' but worker_executions.state='${authorities.workerExecutionState}' (terminal) while tasks.status='in_progress'. No pending GateRun, no CandidateSet, no kernel transition pending.`,
        });
      }
      return incident({
        classification: 'stalled',
        reasonCode: 'engine-dead-runnable',
        retryClass: 'repair',
        authorities,
        detail: `Workplace ${wp.workplace_ref} loop_state='verifying' has no live WorkerExecution, no CandidateSet, and no pending GateRun.`,
      });
    }
    if (wp.loop_state === 'effect_pending') {
      if (kernelAlive) {
        return incident({
          classification: 'progressing',
          reasonCode: 'gate-progress',
          retryClass: 'wait',
          authorities,
          detail: `Workplace ${wp.workplace_ref} in effect_pending; kernel will settle the acceptance effect.`,
        });
      }
      return incident({
        classification: 'stalled',
        reasonCode: 'kernel-transition-not-driven',
        retryClass: 'safe_retry',
        authorities,
        detail: `Workplace ${wp.workplace_ref} in effect_pending but no live NodeRun.`,
      });
    }
  }

  if (['queued', 'leased', 'running'].includes(wp.loop_state)) {
    if (authorities.workerExecutionState
        && !LIVE_EXECUTION_STATES.has(authorities.workerExecutionState)
        && authorities.taskStatus === 'in_progress') {
      return incident({
        classification: 'inconsistent_state',
        reasonCode: 'durable-identity-divergence',
        retryClass: 'reconcile',
        authorities,
        detail: `Workplace ${wp.workplace_ref} loop_state='${wp.loop_state}' expects a live owner but worker_executions.state='${authorities.workerExecutionState}' (terminal) while tasks.status='in_progress'.`,
      });
    }
    return incident({
      classification: 'stalled',
      reasonCode: 'engine-dead-runnable',
      retryClass: 'repair',
      authorities,
      detail: `Workplace ${wp.workplace_ref} loop_state='${wp.loop_state}' has no live WorkerExecution.`,
    });
  }

  if (wp.loop_state === 'idle') {
    if (kernelAlive) {
      return incident({
        classification: 'progressing',
        reasonCode: 'kernel-requeue-progress',
        retryClass: 'wait',
        authorities,
        detail: `Workplace ${wp.workplace_ref} idle; kernel will admit work.`,
      });
    }
    return incident({
      classification: 'stalled',
      reasonCode: 'kernel-transition-not-driven',
      retryClass: 'safe_retry',
      authorities,
      detail: `Workplace ${wp.workplace_ref} idle but no live NodeRun to admit work.`,
    });
  }

  return incident({
    classification: 'inconsistent_state',
    reasonCode: 'durable-identity-divergence',
    retryClass: 'reconcile',
    authorities,
    detail: `Workplace ${wp.workplace_ref} in unexpected non-terminal loop_state='${wp.loop_state}'.`,
  });
}

// ---------------------------------------------------------------------------
// Relational predicates — small, read-only, no production-SQL copying.
// ---------------------------------------------------------------------------

function resolveLifecycleRun(db, opts) {
  if (Number.isSafeInteger(opts.lifecycleRunId) && opts.lifecycleRunId > 0) {
    return db.prepare(
      `SELECT id, project_id, status, current_stage_run_id
         FROM factory_lifecycle_runs WHERE id = ?`,
    ).get(opts.lifecycleRunId) || null;
  }
  const where = Number.isSafeInteger(opts.projectId) && opts.projectId > 0
    ? 'WHERE project_id = ? AND status NOT IN (\'completed\',\'failed\',\'cancelled\')'
    : 'WHERE status NOT IN (\'completed\',\'failed\',\'cancelled\')';
  const params = Number.isSafeInteger(opts.projectId) && opts.projectId > 0
    ? [opts.projectId]
    : [];
  const rows = db.prepare(
    `SELECT id, project_id, status, current_stage_run_id
       FROM factory_lifecycle_runs ${where} ORDER BY id DESC`,
  ).all(...params);
  if (rows.length === 0) {
    const any = db.prepare(
      `SELECT id, project_id, status, current_stage_run_id
         FROM factory_lifecycle_runs
         ${Number.isSafeInteger(opts.projectId) && opts.projectId > 0 ? 'WHERE project_id = ?' : ''}
         ORDER BY id DESC LIMIT 1`,
    ).get(...(Number.isSafeInteger(opts.projectId) && opts.projectId > 0 ? [opts.projectId] : []));
    return any || null;
  }
  return rows[0];
}

function resolveCurrentLandmark(db, lifecycle) {
  const landmark = {
    lifecycleRunId: lifecycle.id,
    stageRunId: lifecycle.current_stage_run_id ?? null,
    processRunId: null,
    nodeRunId: null,
    workplaceRef: null,
  };
  if (!landmark.stageRunId) return landmark;
  const stage = db.prepare(
    `SELECT id, process_run_id, module_name, module_version
       FROM factory_stage_runs WHERE id = ? AND lifecycle_run_id = ?`,
  ).get(landmark.stageRunId, lifecycle.id);
  if (!stage) return landmark;
  landmark.processRunId = stage.process_run_id ?? null;
  if (!landmark.processRunId) return landmark;
  const runningNode = db.prepare(
    `SELECT id FROM factory_node_runs
      WHERE process_run_id = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1`,
  ).get(landmark.processRunId);
  landmark.nodeRunId = runningNode?.id ?? null;
  return landmark;
}

function readWorkplacesForProcessRun(db, processRunId) {
  return db.prepare(
    `SELECT workplace_ref, process_run_id, kanban_phase, loop_state, next_role,
            terminal_reason, revision, active_reservation_ref, active_gate_ref
       FROM factory_workplaces WHERE process_run_id = ? ORDER BY workplace_ref`,
  ).all(processRunId);
}

/**
 * Durable kernel-liveness predicate.
 *
 * A `status='running'` NodeRun row alone is NOT sufficient proof the kernel
 * is cycling — after the host process dies the row is left 'running'
 * indefinitely (never terminalized). There is no heartbeat or updated_at
 * column on factory_node_runs, so we cannot use timestamp age to detect
 * staleness (a legitimately long-running worker would be falsely declared
 * dead after 60s).
 *
 * Instead, the kernel is considered "alive" for a ProcessRun if EITHER:
 *  (a) there is a running NodeRun AND at least one WorkerExecution in the
 *      active set (reserved/running/cancel_requested) bound to a workplace
 *      on this ProcessRun — a live worker proves the kernel is cycling; OR
 *  (b) there is a running NodeRun AND the explainer was called with
 *      `opts.assumeKernelAlive=true` — a test override for scenarios where
 *      the kernel is known to be in-process (e.g. temporal-driver).
 *
 * This avoids both false negatives (long-running worker declared dead) and
 * false positives (stale running row treated as proof of liveness). When
 * neither condition holds, the kernel is treated as NOT alive, and
 * repair_wait/verifying/effect_pending workplaces fall through to the
 * stalled/inconsistent_state branches.
 */
function readKernelAlive(db, processRunId, opts = {}) {
  // Test override: when the caller knows the kernel is in-process.
  if (opts.assumeKernelAlive) return true;

  const hasRunningNode = db.prepare(
    `SELECT 1 AS one FROM factory_node_runs
      WHERE process_run_id = ? AND status = 'running'
      LIMIT 1`,
  ).get(processRunId);
  if (!hasRunningNode) return false;

  // Check for a live WorkerExecution on any workplace of this ProcessRun.
  const hasLiveWorker = db.prepare(
    `SELECT 1 AS one
       FROM worker_executions we
       JOIN tasks t ON t.id = we.task_id
       JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
      WHERE w.process_run_id = ?
        AND we.state IN ('reserved','running','cancel_requested')
      LIMIT 1`,
  ).get(processRunId);
  return Boolean(hasLiveWorker);
}

function collectAuthorities(db, wp) {
  const task = db.prepare(
    `SELECT id, status, current_execution_id FROM tasks WHERE workplace_ref = ?`,
  ).get(wp.workplace_ref) || null;
  let execution = null;
  const execRef = wp.active_reservation_ref ?? task?.current_execution_id ?? null;
  if (execRef) {
    execution = db.prepare(
      `SELECT execution_id, state, phase FROM worker_executions WHERE execution_id = ?`,
    ).get(execRef) || null;
  }
  const candidateSets = db.prepare(
    `SELECT candidate_set_ref, role,  sealed_at
       FROM factory_candidate_sets WHERE workplace_ref = ?
       ORDER BY sealed_at DESC`,
  ).all(wp.workplace_ref);
  const gateDecisions = db.prepare(
    `SELECT decision_key, verdict, repair_target_role, decided_at
       FROM factory_gate_decisions WHERE workplace_ref = ?
       ORDER BY decided_at DESC`,
  ).all(wp.workplace_ref);
  return {
    workerExecutionState: execution?.state ?? null,
    workerExecutionId: execution?.execution_id ?? null,
    workplaceLoopState: wp.loop_state,
    taskStatus: task?.status ?? null,
    taskId: task?.id ?? null,
    candidateSets,
    gateDecisions,
  };
}

function hasLiveOwner(authorities) {
  return authorities.workerExecutionState !== null
    && LIVE_EXECUTION_STATES.has(authorities.workerExecutionState);
}

function readPendingGateRun(db, workplaceRef) {
  return db.prepare(
    `SELECT gate_run_ref, state, gate_phase, subject_candidate_set_ref
       FROM factory_gate_runs
      WHERE workplace_ref = ? AND state IN ('claimed','checking')
      ORDER BY updated_at DESC LIMIT 1`,
  ).get(workplaceRef) || null;
}

function readLatestCandidateSet(db, workplaceRef) {
  return db.prepare(
    `SELECT candidate_set_ref, role,  sealed_at
       FROM factory_candidate_sets WHERE workplace_ref = ?
       ORDER BY sealed_at DESC LIMIT 1`,
  ).get(workplaceRef) || null;
}

function readOpenHumanRequest(db, workplaceRef) {
  return db.prepare(
    `SELECT hr.request_id, hr.state, hr.resume_phase
       FROM human_requests hr
       JOIN tasks t ON t.id = hr.task_id
      WHERE t.workplace_ref = ? AND hr.state = 'open'
      ORDER BY hr.created_at DESC LIMIT 1`,
  ).get(workplaceRef) || null;
}

function readTerminalTransition(db, lifecycleRunId) {
  return db.prepare(
    `SELECT transition_key, outcome, target_type, terminal_status
       FROM factory_process_transitions
      WHERE lifecycle_run_id = ? AND target_type = 'terminal'
      ORDER BY id DESC LIMIT 1`,
  ).get(lifecycleRunId) || null;
}

// ---------------------------------------------------------------------------
// Incident-card builders.
// ---------------------------------------------------------------------------

function emptyLandmark() {
  return {
    lifecycleRunId: null,
    stageRunId: null,
    processRunId: null,
    nodeRunId: null,
    workplaceRef: null,
  };
}

function emptyAuthorities() {
  return {
    workerExecutionState: null,
    workplaceLoopState: null,
    taskStatus: null,
    candidateSets: [],
    gateDecisions: [],
  };
}

function incident(partial) {
  return {
    classification: partial.classification,
    reasonCode: partial.reasonCode,
    landmark: partial.landmark ?? emptyLandmark(),
    authorities: partial.authorities ?? emptyAuthorities(),
    evidenceRefs: partial.evidenceRefs ?? [],
    retryClass: partial.retryClass,
    detail: partial.detail,
  };
}

function withLandmark(verdict, landmark) {
  return { ...verdict, landmark };
}
