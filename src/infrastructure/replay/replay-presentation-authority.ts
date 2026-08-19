import type Database from 'better-sqlite3';

export interface AcceptedCandidatePresentation {
  readonly presentationRef: string;
  readonly replayKey: string | null;
  readonly replayKeyMaterial: string | null;
  readonly replayCapsuleRef: string | null;
  readonly replayCapsulePayloadHash: string | null;
}

/**
 * B-004/W-3 — the kernel carry-forward presenter identity.
 *
 * A carried-forward author CandidateSet is presented by the KERNEL, not by a
 * worker execution: `SqliteAuthorCandidateCarryForward.resolve` mints the
 * deterministic presenter ref `factory-carry-forward-presenter:<authorization_ref>`
 * and the gate records it like any presentation. By design there is NO
 * worker_executions row for it — which made every replay-certification lookup
 * (INNER JOIN worker_executions) throw
 * REPLAY_CERTIFICATION_PRESENTATION_MISSING inside
 * recordFinalAcceptanceAndCapture, so FinalAcceptance was never recorded.
 */
export const CARRY_FORWARD_PRESENTER_PREFIX = 'factory-carry-forward-presenter:';

export function isCarryForwardPresenterRef(presentationRef: string): boolean {
  return typeof presentationRef === 'string'
    && presentationRef.startsWith(CARRY_FORWARD_PRESENTER_PREFIX);
}

/**
 * Does the SEALED carry-forward chain prove this presenter ref presented this
 * CandidateSet? The presenter ref format is deterministic
 * (`prefix + authorization_ref`), so the proof is exact-row, not form-matching:
 *   1. a sealed authorization row exists with that exact authorization_ref;
 *   2. its consumption row binds THIS target CandidateSet and THIS presenter
 *      ref (the gate decision's subject chain, written by
 *      SqliteAuthorCandidateCarryForward.consume at presentation time);
 *   3. the ref is byte-identical to prefix + authorization_ref.
 *
 * Anything else — a fabricated ref, a ref for a different candidate set, a
 * missing consumption — is NOT proven and stays rejected (fail-closed).
 */
export function carryForwardPresentationProven(
  db: Database.Database,
  presentationRef: string,
  candidateSetRef: string,
): boolean {
  if (!isCarryForwardPresenterRef(presentationRef)) return false;
  const authorizationRef = presentationRef.slice(CARRY_FORWARD_PRESENTER_PREFIX.length);
  if (authorizationRef === '') return false;
  const row = db.prepare(
    `SELECT 1
       FROM factory_author_candidate_carry_forward_consumptions c
       JOIN factory_author_candidate_carry_forward_authorizations a
         ON a.authorization_ref=c.authorization_ref
      WHERE c.presenter_ref=?
        AND c.target_candidate_set_ref=?
        AND a.authorization_ref=?
      LIMIT 1`,
  ).get(presentationRef, candidateSetRef, authorizationRef);
  return row !== undefined;
}

/** Exact immutable presentations whose GateDecision accepted one CandidateSet. */
export function acceptedCandidatePresentations(
  db: Database.Database,
  input: {
    workplaceRef: string;
    finalDecisionKey: string;
    finalSubjectCandidateSetRef: string;
    candidateSetRef: string;
  },
): readonly AcceptedCandidatePresentation[] {
  let decisionKey = input.finalDecisionKey;
  if (input.candidateSetRef === input.finalSubjectCandidateSetRef) {
    const head = db.prepare(
      `SELECT accepted_author_gate_decision_key AS decisionKey
         FROM factory_accepted_authority_head
        WHERE workplace_ref=? AND accepted_author_candidate_set_ref=?`,
    ).get(input.workplaceRef, input.candidateSetRef) as { decisionKey: string } | undefined;
    if (!head) throw new Error(`REPLAY_AUTHOR_GATE_AUTHORITY_MISSING: ${input.candidateSetRef}`);
    decisionKey = head.decisionKey;
  }
  // B-004/W-3 — LEFT JOIN: the kernel carry-forward presenter deliberately
  // has no worker_executions row. A presentation is certifiable when a worker
  // execution exists (the ordinary, unchanged requirement) OR when the sealed
  // carry-forward chain proves the kernel presentation. Form alone is never
  // authority — carryForwardPresentationProven checks the exact rows.
  const rows = db.prepare(
    `SELECT DISTINCT gpa.presentation_ref AS presentationRef,
            gpa.replay_key AS replayKey,gpa.replay_key_material AS replayKeyMaterial,
            gpa.replay_capsule_ref AS replayCapsuleRef,
            gpa.replay_capsule_payload_hash AS replayCapsulePayloadHash,
            we.execution_id AS workerExecutionId
       FROM factory_gate_decisions gd
       JOIN factory_gate_presentation_attempts gpa
         ON gpa.gate_run_ref=gd.gate_run_ref
       LEFT JOIN worker_executions we ON we.execution_id=gpa.presentation_ref
      WHERE gd.decision_key=? AND gd.workplace_ref=?
        AND (gd.subject_candidate_set_ref=?
          OR EXISTS (SELECT 1 FROM json_each(gd.assessment_candidate_set_refs)
                      WHERE value=?))
      ORDER BY gpa.presentation_ref`,
  ).all(decisionKey, input.workplaceRef, input.candidateSetRef, input.candidateSetRef) as
    Array<AcceptedCandidatePresentation & { workerExecutionId: string | null }>;
  return rows.filter((row) => row.workerExecutionId !== null
    || carryForwardPresentationProven(db, row.presentationRef, input.candidateSetRef))
    .map(({ workerExecutionId: _workerExecutionId, ...presentation }) => presentation);
}

export function acceptedCandidatePresentationRefs(
  db: Database.Database,
  input: Parameters<typeof acceptedCandidatePresentations>[1],
): readonly string[] {
  return acceptedCandidatePresentations(db, input).map(row => row.presentationRef);
}

export function requireAcceptedCandidatePresentations(
  db: Database.Database,
  input: Parameters<typeof acceptedCandidatePresentations>[1],
): readonly AcceptedCandidatePresentation[] {
  const rows = acceptedCandidatePresentations(db, input);
  if (rows.length === 0) {
    throw new Error(`REPLAY_CERTIFICATION_PRESENTATION_MISSING: ${input.candidateSetRef}`);
  }
  return rows;
}
