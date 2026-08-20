// tests/factory-proof/trace-observer.mjs
//
// W0-3 — the read-only durable trace observer. It reads the REAL durable
// facts of a run (WorkIntents/tasks, products, CandidateSets, CheckReceipts,
// GateDecisions, recovery epochs, effect/transition receipts, lifecycle
// outcomes) and NORMALIZES them into facts + authority refs.
//
// It never computes an expected transition, never imports a reducer, and
// never writes an authority table. Expectations arrive from the scenario /
// obligation registry; this module only reports what durable state exists.

import Database from 'better-sqlite3';

/**
 * Snapshot the durable trace of one factory DB (read-only handle).
 * Unknown/absent tables normalize to empty arrays — the observer reports,
 * it does not demand.
 */
export function observeDurableTrace(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const all = (sql, ...args) => {
      try { return db.prepare(sql).all(...args); } catch { return []; }
    };
    return {
      observedAt: new Date().toISOString(),
      lifecycleRuns: all('SELECT id,status,current_stage_id,terminal_status FROM factory_lifecycle_runs ORDER BY id'),
      processRuns: all('SELECT id,module_name,status,local_outcome FROM factory_process_runs ORDER BY id'),
      workIntents: all(
        'SELECT id, task_kind, status, workplace_ref FROM tasks ORDER BY id',
      ),
      workplaces: all(
        'SELECT workplace_ref, process_run_id, kanban_phase, loop_state, terminal_reason, revision, next_role FROM factory_workplaces ORDER BY workplace_ref',
      ),
      candidateSets: all(
        'SELECT candidate_set_ref, workplace_ref, role, sealed_at FROM factory_candidate_sets ORDER BY candidate_set_ref',
      ),
      gateDecisions: all(
        'SELECT decision_key, workplace_ref, gate_phase, verdict, decided_at FROM factory_gate_decisions ORDER BY decided_at',
      ),
      checkReceipts: all(
        'SELECT check_receipt_ref, subject_candidate_set_ref, provider_id, provider_version, outcome FROM factory_check_receipts ORDER BY check_receipt_ref',
      ),
      finalAcceptances: all(
        'SELECT workplace_ref, candidate_set_ref, gate_decision_key FROM factory_cell_final_acceptances ORDER BY workplace_ref',
      ),
      acceptedAuthorityHeads: all(
        'SELECT workplace_ref, accepted_candidate_set_ref, accepted_author_task_id FROM factory_accepted_authority_head ORDER BY workplace_ref',
      ),
      effectReceipts: all(
        'SELECT effect_key, effect_kind, state FROM factory_effect_receipts ORDER BY effect_key',
      ),
      transitionObligations: all(
        'SELECT obligation_key, source_kind, source_ref, handoff_kind, state, last_error FROM factory_transition_obligations ORDER BY obligation_key',
      ),
      recoveryEpochs: all(
        'SELECT workplace_ref, epoch, reason_key, reason_repeat_count FROM factory_workplace_recovery_epochs ORDER BY rowid',
      ),
      workerExecutions: all(
        'SELECT execution_ref, task_id, state, voided_at FROM worker_executions ORDER BY execution_ref',
      ),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The progress oracle — after a fair drain every nonterminal MUST classify.
// ---------------------------------------------------------------------------

/**
 * Classify every nonterminal workplace after a fair drain. Anything that
 * maps to none of the four lawful classes is an ANONYMOUS STALL — the
 * failure the oracle exists to name (GRAPH-TEST-STRATEGY §C).
 *
 * Lawful classes:
 *   runnable-owner    — an active reservation/execution owns the next move;
 *   due-transition    — an open (non-completed) transition obligation exists;
 *   typed-wait        — loop_state declares a typed wait (paused/repair_wait/
 *                       effect_pending/verifying/human boundary);
 *   typed-terminal    — terminal_reason set (honest terminal).
 */
export function classifyPostDrainProgress(trace) {
  const openObligationsFor = workplace => (trace.transitionObligations ?? [])
    .filter(o => o.state !== 'completed'
      && typeof o.source_ref === 'string'
      && o.source_ref.includes(workplace));
  const activeExecutions = new Set(
    (trace.workerExecutions ?? [])
      .filter(e => ['reserved', 'running', 'cancel_requested'].includes(e.state) && !e.voided_at)
      .map(e => e.task_id),
  );
  const tasksByWorkplace = new Map();
  for (const t of trace.workIntents ?? []) {
    if (t.workplace_ref) tasksByWorkplace.set(t.workplace_ref, t.id);
  }

  const rows = [];
  for (const w of trace.workplaces ?? []) {
    const terminal = w.loop_state === 'terminal';
    if (terminal) {
      rows.push({ workplace: w.workplace_ref, classification: 'typed-terminal', evidence: w.terminal_reason ?? 'terminal' });
      continue;
    }
    const taskId = tasksByWorkplace.get(w.workplace_ref);
    if (taskId !== undefined && activeExecutions.has(taskId)) {
      rows.push({ workplace: w.workplace_ref, classification: 'runnable-owner', evidence: `task ${taskId} has an active execution` });
      continue;
    }
    if (['paused', 'repair_wait', 'effect_pending', 'verifying'].includes(w.loop_state)) {
      rows.push({ workplace: w.workplace_ref, classification: 'typed-wait', evidence: `loop_state=${w.loop_state}` });
      continue;
    }
    const own = openObligationsFor(w.workplace_ref);
    if (own.length > 0) {
      rows.push({ workplace: w.workplace_ref, classification: 'due-transition', evidence: `open obligations: ${own.slice(0, 3).map(o => o.obligation_key).join(', ')}` });
      continue;
    }
    rows.push({
      workplace: w.workplace_ref,
      classification: 'ANONYMOUS-STALL',
      evidence: `kanban=${w.kanban_phase} loop=${w.loop_state} with no owner, no open obligation, no typed wait`,
    });
  }
  const stalls = rows.filter(r => r.classification === 'ANONYMOUS-STALL');
  return {
    rows,
    stalls,
    ok: stalls.length === 0,
  };
}
