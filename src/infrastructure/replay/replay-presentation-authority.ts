import type Database from 'better-sqlite3';

/** Exact worker presentations whose GateDecision accepted one CandidateSet. */
export function acceptedCandidatePresentationRefs(
  db: Database.Database,
  input: {
    workplaceRef: string;
    finalDecisionKey: string;
    finalSubjectCandidateSetRef: string;
    candidateSetRef: string;
  },
): readonly string[] {
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
  const rows = db.prepare(
    `SELECT DISTINCT gpa.presentation_ref AS presentationRef
       FROM factory_gate_decisions gd
       JOIN factory_gate_presentation_attempts gpa
         ON gpa.gate_run_ref=gd.gate_run_ref
       JOIN worker_executions we ON we.execution_id=gpa.presentation_ref
      WHERE gd.decision_key=? AND gd.workplace_ref=?
        AND (gd.subject_candidate_set_ref=?
          OR EXISTS (SELECT 1 FROM json_each(gd.assessment_candidate_set_refs)
                      WHERE value=?))
      ORDER BY gpa.presentation_ref`,
  ).all(decisionKey, input.workplaceRef, input.candidateSetRef, input.candidateSetRef) as Array<{
    presentationRef: string;
  }>;
  return rows.map(row => row.presentationRef);
}
