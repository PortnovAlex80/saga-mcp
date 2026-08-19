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
      // K13 (card commit 4) — exact source: routing is durable iff the
      // lifecycle moved PAST EVERY stage run of the settled ProcessRun, or
      // the lifecycle itself reached a terminal state. The pre-K13 check
      // sampled ONE arbitrary joined row (.get()) — with two stage runs it
      // could read "routed" off the first while the lifecycle was still
      // pinned on the second. `paused` is explicitly NOT a routing receipt:
      // the lifecycle may be paused on this exact StageRun because routing
      // is still pending.
      const processRunId = processRunIdFromSource(obligation.sourceRef);
      const rows = db.prepare(
        `SELECT sr.id AS stage_run_id, lr.current_stage_run_id, lr.status AS lifecycle_status
           FROM factory_stage_runs sr
           JOIN factory_lifecycle_runs lr ON lr.id = sr.lifecycle_run_id
          WHERE sr.process_run_id=?`,
      ).all(processRunId) as Array<{
        stage_run_id: number;
        current_stage_run_id: number | null;
        lifecycle_status: string;
      }>;
      if (rows.length === 0) {
        return {
          satisfied: false,
          reason: 'Lifecycle has no stage runs for the settled ProcessRun yet',
        };
      }
      const terminal = rows.every(row => ['completed', 'failed', 'cancelled'].includes(row.lifecycle_status));
      const routedPast = rows.every(row => row.current_stage_run_id !== row.stage_run_id);
      const satisfied = terminal || routedPast;
      return {
        satisfied,
        reason: satisfied
          ? 'Lifecycle routing is durable for every stage run of the settled ProcessRun'
          : 'Lifecycle has not routed past every stage run of the settled ProcessRun yet',
      };
    }
  }
}

function fact(row: unknown, missingReason: string): TransitionHandoffPostcondition {
  return row
    ? { satisfied: true, reason: 'durable exact postcondition exists' }
    : { satisfied: false, reason: missingReason };
}

/**
 * B-004/W-1/O-B1 — the ONE predicate for the effects-settled boundary.
 *
 * The boundary was previously evaluated four divergent ways: the C8
 * re-entry gate demanded obligation state 'in_progress' only, TB-12 accepted
 * 'in_progress OR completed' with no durability proof, this module's
 * run-effects postcondition accepted receipt/repair/final-acceptance, and
 * the reconciler completed run-effects from that postcondition without
 * re-driving. A crash between completeAcceptanceEffect and
 * recordFinalAcceptanceAndCapture left the run-effects obligation completed
 * (postcondition satisfied via the receipt) while the C8 gate was
 * permanently false → record-final-acceptance deferred forever.
 *
 * This function is the shared decision BOTH node-executor callers use:
 *   - 'in_progress' → proceed (a live reconciler lease drives the handoff);
 *   - 'completed'   → proceed ONLY while the durable postcondition chain
 *     still justifies it (the exact run-effects postcondition of this
 *     module — receipt, routed repair issue, or FinalAcceptance for the
 *     exact accepted GateDecision);
 *   - anything else → not proceedable.
 */
export function effectsSettledProceedable(
  db: Database.Database,
  obligation: TransitionObligation | null | undefined,
): TransitionHandoffPostcondition {
  if (!obligation || obligation.handoffKind !== 'run-effects') {
    return {
      satisfied: false,
      reason: 'run-effects handoff obligation is absent',
    };
  }
  if (obligation.state === 'in_progress') {
    return {
      satisfied: true,
      reason: 'run-effects handoff holds a live reconciler lease',
    };
  }
  if (obligation.state !== 'completed') {
    return {
      satisfied: false,
      reason: `run-effects handoff is ${obligation.state}`,
    };
  }
  const postcondition = readTransitionHandoffPostcondition(db, obligation);
  if (!postcondition.satisfied) {
    return {
      satisfied: false,
      reason: `completed run-effects handoff no longer satisfies its durable `
        + `postcondition: ${postcondition.reason}`,
    };
  }
  return {
    satisfied: true,
    reason: 'completed run-effects handoff with its durable postcondition still satisfied',
  };
}

/**
 * B-004/W-1 companion — is the FinalAcceptance recovery target GENUINELY
 * absent? The C8/record-final-acceptance re-entry may fire on a COMPLETED
 * run-effects handoff only while the acceptance row it exists to record is
 * still missing; presence means there is nothing to recover and production
 * must not be re-driven. Derived from the same postcondition tables the
 * reconciler's record-final-acceptance postcondition reads — not from a
 * second, divergent predicate.
 */
export function finalAcceptanceAbsent(
  db: Database.Database,
  workplaceRef: string,
  gateDecisionKey: string,
): boolean {
  const row = db.prepare(
    `SELECT 1
       FROM factory_cell_final_acceptances fa
      WHERE fa.workplace_ref=? AND fa.gate_decision_key=?
      LIMIT 1`,
  ).get(workplaceRef, gateDecisionKey);
  return row === undefined;
}

/**
 * K13 (card commit 3) — the EXACT durable completion receipt for an
 * obligation: the persisted row's own identity, never a fabricated alias.
 *
 * Scoped to `record-final-acceptance` by the card: the receipt IS the
 * cell-final-acceptance row digest (`cell-final-acceptance:<sha256>`). The
 * other handoff kinds still fabricate `transition-completion:<key>` aliases
 * — the same defect class, reported to the architect (stage-9 escalation
 * rule: report, do not generalize a fix) — and return null here.
 */
export function readExactCompletionReceipt(
  db: Database.Database,
  obligation: TransitionObligation,
): string | null {
  if (obligation.handoffKind !== 'record-final-acceptance') {
    return null;
  }
  const row = db.prepare(
    `SELECT final_acceptance_ref
       FROM factory_cell_final_acceptances fa
      WHERE fa.workplace_ref=?
        AND EXISTS (
          SELECT 1 FROM json_each(fa.effect_receipt_refs) er
           WHERE er.value=?
        )
      LIMIT 1`,
  ).get(obligation.subjectRef, obligation.sourceRef) as
    | { final_acceptance_ref: string }
    | undefined;
  return row?.final_acceptance_ref ?? null;
}

function processRunIdFromSource(sourceRef: string): number {
  const match = /^process-run:(\d+)$/.exec(sourceRef);
  if (!match) throw new Error(`TRANSITION_OBLIGATION_SOURCE_INVALID: ${sourceRef}`);
  return Number(match[1]);
}
