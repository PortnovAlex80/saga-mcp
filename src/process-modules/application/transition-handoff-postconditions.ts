import type Database from 'better-sqlite3';

import type { TransitionObligation } from '../persistence/sqlite-transition-obligation-ledger.js';

export interface TransitionHandoffPostcondition {
  readonly satisfied: boolean;
  readonly reason: string;
}

/**
 * A returned orchestration episode, a changed Workplace state, or a broadly
 * matching downstream row is not proof that THIS handoff completed. Wherever
 * the source has an exact persisted identity today, postconditions bind to it.
 */
export function readTransitionHandoffPostcondition(
  db: Database.Database,
  obligation: TransitionObligation,
): TransitionHandoffPostcondition {
  switch (obligation.handoffKind) {
    case 'close-presentation': {
      const row = db.prepare(
        `SELECT 1
           FROM factory_final_presentation_commitments c
           JOIN command_receipts cr ON cr.execution_id=c.execution_id
          WHERE c.commitment_ref=?
            AND cr.command_kind IN ('worker_done','presentation_close')
            AND cr.accepted=1
          LIMIT 1`,
      ).get(obligation.sourceRef);
      return fact(row, 'presentation closure receipt is not durable yet');
    }
    case 'run-gate': {
      const row = db.prepare(
        `SELECT 1
           FROM factory_candidate_sets cs
           JOIN factory_gate_runs gr
             ON gr.state='terminal'
            AND (gr.subject_candidate_set_ref=cs.candidate_set_ref OR EXISTS (
              SELECT 1 FROM json_each(gr.assessment_candidate_set_refs) a
               WHERE a.value=cs.candidate_set_ref
            ))
          WHERE cs.candidate_set_ref=?
            AND cs.candidate_set_digest=?
          LIMIT 1`,
      ).get(obligation.sourceRef, obligation.sourceDigest);
      return fact(row, 'terminal GateRun for the exact CandidateSet is not durable yet');
    }
    case 'run-effects': {
      // Exact effect receipt for this accepted GateDecision, or an exact
      // immutable repair issue plus the matching repair Workplace state, or
      // an exact FinalAcceptance for the same GateDecision in the no-effect
      // path. A changed loop state alone is never a completion proof.
      const row = db.prepare(
        `SELECT 1
           FROM factory_cell_effect_receipts er
          WHERE er.workplace_ref=? AND er.gate_decision_key=?
          UNION ALL
         SELECT 1
           FROM factory_cell_effect_repair_issues ri
           JOIN factory_workplaces w ON w.workplace_ref=ri.workplace_ref
          WHERE ri.workplace_ref=? AND ri.gate_decision_key=?
            AND ri.gate_decision_digest=?
            AND w.revision>=ri.resulting_workplace_revision
          UNION ALL
         SELECT 1
           FROM factory_cell_final_acceptances fa
          WHERE fa.workplace_ref=? AND fa.gate_decision_key=?
          LIMIT 1`,
      ).get(
        obligation.subjectRef,
        obligation.sourceRef,
        obligation.subjectRef,
        obligation.sourceRef,
        obligation.sourceDigest,
        obligation.subjectRef,
        obligation.sourceRef,
      );
      return fact(
        row,
        'exact GateDecision has neither an effect receipt, routed repair issue, nor FinalAcceptance yet',
      );
    }
    case 'record-final-acceptance': {
      // effects-settled now uses the exact CellEffectReceipt as its source.
      const row = db.prepare(
        `SELECT 1
           FROM factory_cell_final_acceptances fa
          WHERE fa.workplace_ref=?
            AND EXISTS (
              SELECT 1 FROM json_each(fa.effect_receipt_refs) er
               WHERE er.value=?
            )
          LIMIT 1`,
      ).get(obligation.subjectRef, obligation.sourceRef);
      return fact(row, 'FinalAcceptance for the exact EffectReceipt is not durable yet');
    }
    case 'route-lifecycle': {
      const processRunId = processRunIdFromSource(obligation.sourceRef);
      const row = db.prepare(
        `SELECT sr.status AS stage_status,lr.status AS lifecycle_status,
                lr.current_stage_run_id,sr.id AS stage_run_id
           FROM factory_stage_runs sr
           JOIN factory_lifecycle_runs lr ON lr.id=sr.lifecycle_run_id
          WHERE sr.process_run_id=?`,
      ).get(processRunId) as {
        stage_status: string;
        lifecycle_status: string;
        current_stage_run_id: number | null;
        stage_run_id: number;
      } | undefined;
      // `paused` is explicitly NOT a routing receipt: the lifecycle may be
      // paused on this exact StageRun because routing is still pending.
      const routed = row !== undefined && (
        row.current_stage_run_id !== row.stage_run_id
        || ['completed', 'failed', 'cancelled'].includes(row.lifecycle_status)
      );
      return {
        satisfied: routed,
        reason: routed
          ? 'Lifecycle routing is durable for the settled ProcessRun'
          : 'Lifecycle has not routed the settled ProcessRun yet',
      };
    }
  }
}

function fact(row: unknown, missingReason: string): TransitionHandoffPostcondition {
  return row
    ? { satisfied: true, reason: 'durable exact postcondition exists' }
    : { satisfied: false, reason: missingReason };
}

function processRunIdFromSource(sourceRef: string): number {
  const match = /^process-run:(\d+)$/.exec(sourceRef);
  if (!match) throw new Error(`TRANSITION_OBLIGATION_SOURCE_INVALID: ${sourceRef}`);
  return Number(match[1]);
}
