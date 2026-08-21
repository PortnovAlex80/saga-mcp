/**
 * Pinned payload contract for the `reconcile-what` node's declared output
 * (`factory.formalization-reconciliation-report.v1`).
 *
 * Defect class (Formalization conformance, 2026-08-21): the reconciliation
 * report had NO payload contract — the WHAT-graph validator analyzed trace
 * coverage but nothing decoded the report payload itself, so a malformed
 * report (`{status:'reconciled'}` with no rationale/gaps/repairs) was
 * accepted by product_submit and sealed into the CandidateSet. This contract
 * pins the shape at the product_submit intake boundary — the same mechanism
 * that already protects review verdicts and development products
 * (`assertPinnedProductPayload`, typed PRODUCT_PAYLOAD_CONTRACT_REJECTED
 * before any authority write).
 *
 * An accepted report must:
 *  - declare `status: 'reconciled'` (closed grammar — the accepted transition
 *    means the WHAT contract IS reconciled);
 *  - carry a non-empty `rationale` (a no-op report explains why nothing
 *    needed repair);
 *  - carry an EMPTY `remaining_gaps` array (a report admitting unresolved
 *    gaps cannot accept the cell — repair the gap instead of reporting it);
 *  - carry a `repairs` array (may be empty for a no-op).
 */

import {
  productPayloadContractDigest,
  type ProductPayloadContract,
} from '../../../process-modules/application/product-payload-contract.js';
import {
  FORMALIZATION_RECONCILIATION_SCHEMA,
} from '../domain/formalization-schemas.js';

export const FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_ID =
  'factory.formalization-reconciliation-payload.v1';
export const FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_VERSION = '1.0.0';
export const FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_DEFINITION = {
  type: 'object',
  required: ['status', 'rationale', 'remaining_gaps', 'repairs'],
  status: 'reconciled',
  rationale: 'non-empty-string',
  remaining_gaps: 'empty-array',
  repairs: 'array',
} as const;
export const FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_DIGEST =
  productPayloadContractDigest({
    schemaId: FORMALIZATION_RECONCILIATION_SCHEMA,
    contractId: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_ID,
    version: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_VERSION,
    definition: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_DEFINITION,
  });

/** Human-actionable typed errors; pure over the payload (unit-testable). */
export function reconciliationReportPayloadErrors(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [
      `the reconciliation report must be a JSON object with schema ${FORMALIZATION_RECONCILIATION_SCHEMA} `
      + '(fields: status, rationale, remaining_gaps, repairs)',
    ];
  }
  const report = payload as Record<string, unknown>;
  const errors: string[] = [];
  if (report.status !== 'reconciled') {
    errors.push(
      `field 'status' must be exactly 'reconciled' (got ${JSON.stringify(report.status ?? null)}); `
      + 'the accepted transition means the WHAT contract is reconciled',
    );
  }
  if (typeof report.rationale !== 'string' || report.rationale.trim().length === 0) {
    errors.push(
      "field 'rationale' must be a non-empty string explaining the reconciliation "
      + '(a no-op report explains why nothing needed repair)',
    );
  }
  if (!Array.isArray(report.remaining_gaps)) {
    errors.push("field 'remaining_gaps' must be an array (empty when the contract is reconciled)");
  } else if (report.remaining_gaps.length > 0) {
    errors.push(
      `field 'remaining_gaps' must be empty for an accepted reconciliation (got `
      + `${report.remaining_gaps.length} entries); an unresolved gap means the WHAT contract is `
      + 'NOT reconciled — repair the gap before submitting',
    );
  }
  if (!Array.isArray(report.repairs)) {
    errors.push("field 'repairs' must be an array describing performed repairs (empty for a no-op report)");
  }
  return errors;
}

export const formalizationReconciliationReportPayloadContract: ProductPayloadContract = {
  schemaId: FORMALIZATION_RECONCILIATION_SCHEMA,
  contractId: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_ID,
  version: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_VERSION,
  definition: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_DEFINITION,
  contractDigest: FORMALIZATION_RECONCILIATION_PAYLOAD_CONTRACT_DIGEST,
  validate: reconciliationReportPayloadErrors,
};
