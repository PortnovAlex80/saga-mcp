// tests/factory-contract/transition-conformance-scenarios.mjs
//
// Golden-path scenarios with one deliberate universal Production Cell repair
// loop. The Formalization reconciliation cell is used only as a concrete
// installed cell; the theorem under test is Factory-wide:
//
//   author candidate 1 -> reviewer changes_requested -> recovery feedback ->
//   author candidate 2 -> reviewer approved -> terminal accepted.
//
// Decisions are derived from durable candidate content and recovery feedback,
// never from process-local counters.

import { actions } from './scenario-engine.mjs';
import { goldenPathScenarios } from './golden-path-scenarios.mjs';

const FRM = 'solution-formalization@1.0.0';
const RECONCILIATION_SCHEMA = 'factory.formalization-reconciliation-report.v1';
const REVIEW_SCHEMA = 'factory.review-verdict.v1';
const AUTHOR_KEY = `${FRM}/reconcile-what/author/singleton`;
const REVIEWER_KEY = `${FRM}/reconcile-what/reviewer/singleton`;
const REPAIR_MARKER = 'factory-transition-conformance-revision=2';

function metaOf(task) {
  return typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
}

const reconciliationAuthor = async ({ client, task, prompt }) => {
  const feedback = metaOf(task).recovery_feedback;
  const repairing = feedback?.schemaVersion === 'factory.production-cell-recovery-feedback.v1';

  if (repairing) {
    if (feedback.repairTargetRole !== 'author') {
      throw new Error(`CONFORMANCE_RECOVERY_ROLE_INVALID: ${feedback.repairTargetRole}`);
    }
    if (!feedback.issue?.rejectedGateDecisionRef) {
      throw new Error('CONFORMANCE_RECOVERY_DECISION_MISSING');
    }
    if (!feedback.rejectedCandidateSet?.candidateSetRef) {
      throw new Error('CONFORMANCE_REJECTED_CANDIDATE_MISSING');
    }
  }

  await actions.submitProduct(client, RECONCILIATION_SCHEMA, {
    status: 'reconciled',
    rationale: repairing
      ? `Independent review finding repaired; ${REPAIR_MARKER}.`
      : 'Initial reconciliation candidate for independent review.',
    remaining_gaps: [],
    repairs: [],
  });
  await actions.done(
    client,
    Number(prompt.task_id),
    prompt.worker_id,
    prompt.execution_id,
    repairing
      ? 'formalization reconciliation: repaired from authoritative recovery feedback'
      : 'formalization reconciliation: initial candidate',
  );
};

const reconciliationReviewer = async ({ client, task, prompt }) => {
  const workplaceRef = metaOf(task).workplace_ref;
  if (!workplaceRef) throw new Error('CONFORMANCE_WORKPLACE_REF_MISSING');

  const candidate = await actions.readAuthorCandidate(client, workplaceRef);
  const productRef = (candidate.product_refs || []).find(
    product => product.schemaId === RECONCILIATION_SCHEMA,
  );
  if (!productRef) throw new Error('CONFORMANCE_RECONCILIATION_PRODUCT_MISSING');

  const read = await client.callJson('product_read', {
    schema_id: productRef.schemaId,
    ref: productRef.ref,
    digest: productRef.digest,
  });
  const payload = read.content || read;
  const repaired = typeof payload.rationale === 'string'
    && payload.rationale.includes(REPAIR_MARKER);

  await actions.submitProduct(client, REVIEW_SCHEMA, {
    verdict: repaired ? 'approved' : 'changes_requested',
    findings: repaired
      ? []
      : ['Apply the authoritative review finding and submit a new reconciliation candidate.'],
    subject_candidate_set_ref: candidate.candidate_set_ref,
  });
  await actions.done(
    client,
    Number(prompt.task_id),
    prompt.worker_id,
    prompt.execution_id,
    repaired
      ? 'review: approved repaired reconciliation candidate'
      : 'review: changes_requested for initial reconciliation candidate',
  );
};

export const scenarios = {
  ...goldenPathScenarios,
  [AUTHOR_KEY]: reconciliationAuthor,
  [REVIEWER_KEY]: reconciliationReviewer,
};
