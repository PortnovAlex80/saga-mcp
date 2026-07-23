/**
 * DiscoveryProposal — the typed payload a discovery product worker emits
 * against a discovery WorkIntent.
 *
 * Roadmap §6.2 (fields) + §5.3 (DiscoveryOutcome enumeration). This is the
 * semantic payload ONLY: provenance is added by the kernel, never by the
 * worker. A valid proposal has every required field and a recommended_outcome
 * drawn from the discovery outcome enumeration.
 *
 * The discovery worker skill (skills/saga-discovery-worker/SKILL.md) instructs
 * the LM to build exactly this shape and submit it via proposal_submit.
 */

/**
 * The six discovery outcomes. These are BUSINESS verdicts about the idea, not
 * process states. The provisional outcome the engine records in D1 is taken
 * directly from a valid proposal's recommended_outcome; D4 settlement makes it
 * authoritative.
 */
export type DiscoveryOutcome =
  | 'go'
  | 'clarify'
  | 'reject'
  | 'defer'
  | 'inconclusive'
  | 'failed';

export const DISCOVERY_OUTCOMES: readonly DiscoveryOutcome[] = [
  'go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed',
];

/**
 * Schema version for the discovery proposal payload. proposal_submit rejects a
 * submission whose schema_version does not match this exactly — the kernel, not
 * the worker, owns the contract version.
 */
export const DISCOVERY_PROPOSAL_SCHEMA = 'saga3.discovery-proposal.v1';

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
