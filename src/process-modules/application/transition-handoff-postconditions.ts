import type Database from 'better-sqlite3';

import type { TransitionObligation } from '../persistence/sqlite-transition-obligation-ledger.js';

export interface TransitionHandoffPostcondition {
  readonly satisfied: boolean;
  readonly reason: string;
}

/** A returned orchestration episode is not proof that its handoff completed. */
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
        `SELECT 1 FROM factory_gate_runs gr
          WHERE gr.state='terminal'
            AND (gr.subject_candidate_set_ref=? OR EXISTS (
              SELECT 1 FROM json_each(gr.assessment_candidate_set_refs) a
               WHERE a.value=?
            )) LIMIT 1`,
      ).get(obligation.sourceRef, obligation.sourceRef);
      return fact(row, 'terminal GateRun is not durable yet');
    }
    case 'run-effects': {
      const receipt = db.prepare(
        `SELECT 1 FROM factory_cell_effect_receipts
          WHERE workplace_ref=? AND gate_decision_key=? LIMIT 1`,
      ).get(obligation.subjectRef, obligation.sourceRef);
      if (receipt) return fact(receipt, 'effect receipt is durable');
      const workplace = db.prepare(
        `SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?`,
      ).get(obligation.subjectRef) as { loop_state: string } | undefined;
      const routed = workplace !== undefined && workplace.loop_state !== 'effect_pending';
      return {
        satisfied: routed,
        reason: routed
          ? `Workplace durably routed to ${workplace.loop_state}`
          : 'effect is still pending and has no durable receipt',
      };
    }
    case 'record-final-acceptance': {
      const row = db.prepare(
        `SELECT 1 FROM factory_cell_final_acceptances
          WHERE workplace_ref=? LIMIT 1`,
      ).get(obligation.subjectRef);
      return fact(row, 'FinalAcceptance is not durable yet');
    }
    case 'settle-process': {
      const processRunId = processRunIdFromSubject(obligation.subjectRef);
      const row = db.prepare(
        `SELECT 1 FROM factory_transition_obligations
          WHERE source_kind='process-settled' AND source_ref=?
            AND handoff_kind='route-lifecycle' LIMIT 1`,
      ).get(`process-run:${processRunId}`);
      return fact(row, 'Process settlement obligation is not durable yet');
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
      const routed = row !== undefined && (
        row.current_stage_run_id !== row.stage_run_id
        || ['completed', 'failed', 'paused', 'cancelled'].includes(row.lifecycle_status)
        || ['completed', 'failed', 'paused', 'cancelled'].includes(row.stage_status)
      );
      return {
        satisfied: routed,
        reason: routed ? 'Lifecycle routing is durable' : 'Lifecycle has not routed the settled ProcessRun yet',
      };
    }
  }
}

function fact(row: unknown, missingReason: string): TransitionHandoffPostcondition {
  return row
    ? { satisfied: true, reason: 'durable postcondition exists' }
    : { satisfied: false, reason: missingReason };
}

function processRunIdFromSubject(subjectRef: string): number {
  const match = /^workplace\/(\d+)\//.exec(subjectRef);
  if (!match) throw new Error(`TRANSITION_OBLIGATION_SUBJECT_INVALID: ${subjectRef}`);
  return Number(match[1]);
}

function processRunIdFromSource(sourceRef: string): number {
  const match = /^process-run:(\d+)$/.exec(sourceRef);
  if (!match) throw new Error(`TRANSITION_OBLIGATION_SOURCE_INVALID: ${sourceRef}`);
  return Number(match[1]);
}
