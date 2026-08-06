/**
 * CheckPlan declaration for the architecture contract Production Cell.
 *
 * A CheckPlan is an immutable, versioned definition that declares which
 * checks the gate runs for a given CandidateSet (REG-14). It is pinned by
 * digest and referenced by the GateRun.
 *
 * For the first slice, the architecture CheckPlan has one entry: the SRS
 * structural check. Future entries will include:
 *   - SRS → PRD traceability check
 *   - Baseline drift check
 *   - Reviewer semantic check (in the final gate phase)
 *
 * The decision policy for the first slice is fail-closed: any 'failed' or
 * 'unknown'/'error' receipt → repair_required. This matches the existing
 * ExactCandidateAcceptance binary outcome.
 */

import { createHash } from 'node:crypto';
import type { CheckPlan } from '../../../process-modules/domain/workplace/gate.js';
import {
  SRS_STRUCTURAL_CHECK_PROVIDER_ID,
  SRS_STRUCTURAL_CHECK_PROVIDER_VERSION,
  SRS_STRUCTURAL_CHECK_PROVIDER_DIGEST,
} from './srs-structural-check-provider.js';

/**
 * The decision policy reference for the architecture gate. Fail-closed:
 * unknown/error outcomes block acceptance. This is the conservative default
 * — a future release-policy may issue DegradationAuthorization records that
 * allow specific degradable ACs to pass on unknown.
 */
const ARCHITECTURE_DECISION_POLICY_REF = 'formalization.architecture-gate-policy.v1';
const ARCHITECTURE_DECISION_POLICY_DIGEST = createHash('sha256')
  .update('fail-closed-blocker-default-v1')
  .digest('hex');

/**
 * Build the architecture CheckPlan. The plan is content-addressed: its digest
 * covers the entries + decision policy ref/digest + unknown-error policy.
 * When the plan changes (new check added, policy changed), the digest changes.
 */
export function buildArchitectureCheckPlan(): CheckPlan {
  const entries = [
    {
      check: {
        providerId: SRS_STRUCTURAL_CHECK_PROVIDER_ID,
        version: SRS_STRUCTURAL_CHECK_PROVIDER_VERSION,
        providerDigest: SRS_STRUCTURAL_CHECK_PROVIDER_DIGEST,
      },
      parameters: {},
      environmentRef: null,
    },
  ];
  const checkPlanId = 'formalization.architecture-check-plan.v1';
  const version = '1.0.0';
  const unknownErrorPolicy = 'fail-closed' as const;
  const checkPlanDigest = createHash('sha256')
    .update(JSON.stringify({
      checkPlanId,
      version,
      entries,
      decisionPolicyRef: ARCHITECTURE_DECISION_POLICY_REF,
      decisionPolicyDigest: ARCHITECTURE_DECISION_POLICY_DIGEST,
      unknownErrorPolicy,
    }))
    .digest('hex');
  return {
    checkPlanId,
    version,
    checkPlanDigest,
    entries,
    decisionPolicyRef: ARCHITECTURE_DECISION_POLICY_REF,
    decisionPolicyDigest: ARCHITECTURE_DECISION_POLICY_DIGEST,
    unknownErrorPolicy,
  };
}
