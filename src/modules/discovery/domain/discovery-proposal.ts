/**
 * DiscoveryProposal — the typed payload a discovery product worker emits
 * against a discovery WorkIntent.
 *
 * Roadmap §6.2 (fields) + §5.3 (DiscoveryOutcome enumeration). This is the
 * semantic payload ONLY: provenance is added by the kernel, never by the
 * worker. A valid proposal has every required field and a recommended_outcome
 * drawn from the discovery outcome enumeration.
 *
 * The discovery worker skill (saga-discovery-worker/SKILL.md, now under
 * src/process-modules/modules/discovery/package/resources/skills/) instructs
 * the LM to build exactly this shape and submit it via proposal_submit.
 */

import {
  ORDER_CONSTRAINT_CLASSES,
  type OrderConstraintDraft,
} from '../../../shared/constraint-register.js';

/**
 * The WORKER-RECOMMENDATION vocabulary for discovery — a business verdict
 * about the idea, not a process state. 'failed' is a runtime-only outcome
 * (kernel-seam process failure) and deliberately absent: no worker may
 * recommend it. 'defer' and 'inconclusive' were deleted with their routes
 * (no runtime producer — W9-04-UNREACHABLE-EDGE-EVIDENCE, RESOLVED); a
 * submission carrying them is invalid input, never translated.
 */
export type DiscoveryOutcome =
  | 'go'
  | 'clarify'
  | 'reject';

export const DISCOVERY_OUTCOMES: readonly DiscoveryOutcome[] = [
  'go', 'clarify', 'reject',
];

/**
 * Schema version for the discovery proposal payload. proposal_submit rejects a
 * submission whose schema_version does not match this exactly — the kernel, not
 * the worker, owns the contract version.
 */
export const DISCOVERY_PROPOSAL_SCHEMA = 'factory.discovery-proposal.v1';

/** Typed discovery proposal payload (roadmap §6.2). */
export interface DiscoveryProposalPayload {
  problem_statement: string;
  observed_context: string;
  stakeholders_or_actors: string[];
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  candidate_scope: string;
  evidence_refs: string[];
  recommended_outcome: DiscoveryOutcome;
  rationale: string;
  /**
   * AC-drift remedy (network 0): the typed constraints the worker observed in
   * the order's initiative, serialized ONCE while they are visible. The
   * kernel-side settlement turns these drafts into the digest-pinned
   * constraint register (see constraint-register.ts). Optional for
   * retro-compatibility: absent field → no register → empty downstream
   * diffs → all existing gates stay green.
   */
  order_constraints?: readonly OrderConstraintDraft[];
}

/** Result of validating a discovery proposal payload. */
export interface DiscoveryProposalValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Deterministic, schema-level validation of a discovery proposal payload.
 *
 * D1 does ONLY structural validation: required fields present, correct types,
 * recommended_outcome in the enumeration. Semantic quality assessment
 * (readiness advisor) is D3; normalization is D2. The kernel must be able to
 * reject a malformed proposal without any LM call.
 */
export function validateDiscoveryProposal(payload: unknown): DiscoveryProposalValidation {
  const errors: string[] = [];

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { valid: false, errors: ['payload must be a JSON object'] };
  }
  const p = payload as Record<string, unknown>;

  const requiredStrings: Array<keyof DiscoveryProposalPayload> = [
    'problem_statement', 'observed_context', 'candidate_scope', 'rationale',
  ];
  for (const key of requiredStrings) {
    const v = p[key];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`field '${key}' must be a non-empty string`);
    }
  }

  const requiredArrays: Array<keyof DiscoveryProposalPayload> = [
    'stakeholders_or_actors', 'assumptions', 'unknowns', 'risks', 'evidence_refs',
  ];
  for (const key of requiredArrays) {
    const v = p[key];
    if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) {
      errors.push(`field '${key}' must be an array of strings`);
    }
  }

  const outcome = p['recommended_outcome'];
  if (typeof outcome !== 'string' || !DISCOVERY_OUTCOMES.includes(outcome as DiscoveryOutcome)) {
    errors.push(
      `field 'recommended_outcome' must be one of [${DISCOVERY_OUTCOMES.join(', ')}]`,
    );
  }

  // AC-drift remedy: order_constraints is OPTIONAL (retro-compat), but when
  // present every draft must be structurally valid — the settlement builds
  // the digest-pinned register from these rows without any further LM step,
  // so a malformed draft must fail at the submission boundary, not at
  // settlement.
  if (p['order_constraints'] !== undefined) {
    if (!Array.isArray(p['order_constraints'])) {
      errors.push("field 'order_constraints' must be an array of constraint drafts");
    } else {
      p['order_constraints'].forEach((draft, index) => {
        if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
          errors.push(`order_constraints[${index}] must be an object`);
          return;
        }
        const row = draft as Record<string, unknown>;
        if (
          typeof row['class'] !== 'string'
          || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(row['class'])
        ) {
          errors.push(
            `order_constraints[${index}].class must be one of ${ORDER_CONSTRAINT_CLASSES.join('|')}`,
          );
        }
        if (typeof row['text'] !== 'string' || row['text'].trim() === '') {
          errors.push(`order_constraints[${index}].text must be a non-empty string`);
        }
        if (typeof row['evidence_ref'] !== 'string' || row['evidence_ref'].trim() === '') {
          errors.push(`order_constraints[${index}].evidence_ref must be a non-empty string`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Map a discovery proposal's recommended_outcome to the provisional outcome the
 * engine records for the run. In D1 the engine does NOT settle authoritatively
 * — it records outcomeAuthority='worker_proposal' alongside this value. D4
 * settlement may override it.
 */
export function provisionalOutcomeFromProposal(
  payload: DiscoveryProposalPayload,
): { outcome: DiscoveryOutcome; authority: 'worker_proposal' } {
  return { outcome: payload.recommended_outcome, authority: 'worker_proposal' };
}
