import {
  DISCOVERY_PROPOSAL_FIELDS,
  readTopLevelSourcePath,
  type DiscoveryProposalField,
} from './discovery-normalization.js';
import {
  validateDiscoveryProposal,
  type DiscoveryProposalPayload,
} from './discovery-proposal.js';

export const DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA =
  'saga3.discovery-normalization-proposal.v1';

export interface DiscoveryNormalizationProposalPayload {
  source_submission_id: number;
  source_raw_hash: string;
  normalized_payload: DiscoveryProposalPayload;
  /** Canonical field -> top-level source JSON paths used to derive it. */
  source_field_map: Record<DiscoveryProposalField, string[]>;
  notes: string[];
}

export interface DiscoveryNormalizationProposalValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateDiscoveryNormalizationProposal(
  value: unknown,
  sourceParsedPayload: unknown,
  allowedEvidenceRefs: readonly string[],
): DiscoveryNormalizationProposalValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ['normalization proposal must be an object'] };
  }

  if (!Number.isInteger(value.source_submission_id)) {
    errors.push('source_submission_id must be an integer');
  }
  if (typeof value.source_raw_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.source_raw_hash)) {
    errors.push('source_raw_hash must be a lowercase SHA-256 hex string');
  }

  const normalizedValidation = validateDiscoveryProposal(value.normalized_payload);
  if (!normalizedValidation.valid) {
    errors.push(...normalizedValidation.errors.map(error => `normalized_payload: ${error}`));
  }

  if (!isRecord(value.source_field_map)) {
    errors.push('source_field_map must be an object');
  } else {
    for (const field of DISCOVERY_PROPOSAL_FIELDS) {
      const paths = value.source_field_map[field];
      if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
        errors.push(`source_field_map.${field} must be an array of JSON paths`);
        continue;
      }
      if (field !== 'evidence_refs' && paths.length === 0) {
        errors.push(`source_field_map.${field} must cite at least one source path`);
      }
      for (const path of paths) {
        if (readTopLevelSourcePath(sourceParsedPayload, path) === undefined) {
          errors.push(`source_field_map.${field} path '${path}' does not exist in source payload`);
        }
      }
    }
  }

  if (!Array.isArray(value.notes) || value.notes.some(note => typeof note !== 'string')) {
    errors.push('notes must be an array of strings');
  }

  if (normalizedValidation.valid) {
    const normalized = value.normalized_payload as DiscoveryProposalPayload;
    const allowed = new Set(allowedEvidenceRefs);
    for (const evidence of normalized.evidence_refs) {
      if (!allowed.has(evidence)) {
        errors.push(`normalized_payload.evidence_refs invents evidence '${evidence}'`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
