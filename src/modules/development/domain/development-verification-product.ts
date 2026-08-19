import {
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  type DevelopmentVerificationEvidenceProduct,
  type VerificationOutcome,
} from './development-schemas.js';

const HASH = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set<VerificationOutcome>([
  'passed', 'failed', 'unknown', 'error',
]);

export type DevelopmentVerificationProductDecode =
  | { readonly ok: true; readonly value: DevelopmentVerificationEvidenceProduct }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Runtime decoder for the exact LM -> Factory verification product. */
export function decodeDevelopmentVerificationProduct(
  payload: unknown,
): DevelopmentVerificationProductDecode {
  const errors: string[] = [];
  if (!record(payload)) {
    return { ok: false, errors: ['content must be an object'] };
  }
  const allowed = new Set([
    'schemaVersion',
    'verificationItemKey',
    'acceptanceCriterionId',
    'acceptedCriterionHash',
    'candidateHash',
    'coveredConstraintIds',
    'outcome',
    'evidence',
  ]);
  const unknown = Object.keys(payload).filter(key => !allowed.has(key));
  if (unknown.length > 0) errors.push(`unknown fields: ${unknown.sort().join(', ')}`);
  if (payload.schemaVersion !== DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA) {
    errors.push(`schemaVersion must equal ${DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA}`);
  }
  if (!text(payload.verificationItemKey)) errors.push('verificationItemKey is required');
  if (!Number.isSafeInteger(payload.acceptanceCriterionId)
      || Number(payload.acceptanceCriterionId) < 1) {
    errors.push('acceptanceCriterionId must be a positive integer');
  }
  if (!text(payload.acceptedCriterionHash)
      || !HASH.test(String(payload.acceptedCriterionHash))) {
    errors.push('acceptedCriterionHash must be a lowercase SHA-256 hex digest');
  }
  if (!text(payload.candidateHash) || !HASH.test(String(payload.candidateHash))) {
    errors.push('candidateHash must be a lowercase SHA-256 hex digest');
  }
  if (payload.coveredConstraintIds !== undefined
      && !stringArray(payload.coveredConstraintIds, true)) {
    errors.push('coveredConstraintIds must be a string array when present');
  }
  if (typeof payload.outcome !== 'string'
      || !OUTCOMES.has(payload.outcome as VerificationOutcome)) {
    errors.push('outcome must be passed|failed|unknown|error');
  }
  if (!record(payload.evidence)) {
    errors.push('evidence must be an object');
  } else {
    const evidenceAllowed = new Set(['summary', 'observations', 'limitations']);
    const evidenceUnknown = Object.keys(payload.evidence)
      .filter(key => !evidenceAllowed.has(key));
    if (evidenceUnknown.length > 0) {
      errors.push(`evidence unknown fields: ${evidenceUnknown.sort().join(', ')}`);
    }
    if (!text(payload.evidence.summary)) errors.push('evidence.summary is required');
    if (!stringArray(payload.evidence.observations, false)) {
      errors.push('evidence.observations must be a non-empty string array');
    }
    if (!stringArray(payload.evidence.limitations, true)) {
      errors.push('evidence.limitations must be a string array');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: payload as unknown as DevelopmentVerificationEvidenceProduct };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown, emptyAllowed: boolean): value is string[] {
  return Array.isArray(value)
    && (emptyAllowed || value.length > 0)
    && value.every(text);
}
