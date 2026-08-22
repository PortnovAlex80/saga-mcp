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
  ORDER_CONSTRAINT_KINDS,
  ORDER_CONSTRAINT_DRAFT_KINDS,
  ORDER_CONSTRAINT_RESERVED_KINDS,
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
   *
   * ADR-090 (CC-IC-1): a draft row MAY carry a `kind` from the
   * DRAFT-AUTHORABLE subset of the closed six-value vocabulary
   * (`scope|mechanics|quality`) and a kind `quality` row MAY carry a typed
   * `measurability` binding. The reserved kinds (`open-question`,
   * `synthesis`, `ordered-smoke`) are kernel-only — created by the
   * deterministic unknown lifting and the declared lifecycle injection table
   * respectively — and `lifecycle_synthesis` is NEVER worker-declarable
   * (kernel-assigned on injected entries only).
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
        // ADR-088 (CC-GAP-6): entrypoint declarations are execution-class
        // only and must be repository-relative file paths — fail at the
        // submission boundary, exactly like every other draft field (the
        // register builder repeats the check fail-closed).
        if (row['entrypoint_files'] !== undefined && row['entrypoint_files'] !== null) {
          if (typeof row['class'] === 'string' && row['class'] !== 'execution') {
            errors.push(
              `order_constraints[${index}].entrypoint_files may only be declared by execution-class constraints`,
            );
          }
          if (!Array.isArray(row['entrypoint_files'])) {
            errors.push(
              `order_constraints[${index}].entrypoint_files must be an array of repository-relative file paths`,
            );
          } else if (row['entrypoint_files'].length > 0) {
            for (const file of row['entrypoint_files']) {
              if (typeof file !== 'string' || file.trim() === '') {
                errors.push(
                  `order_constraints[${index}].entrypoint_files entries must be non-empty repository-relative file paths`,
                );
                break;
              }
            }
          }
        }
        // ADR-090 (CC-IC-1): the closed kind vocabulary at the submission
        // boundary — a draft row carrying a `kind` MUST carry one of the six
        // closed values; anything else is a typed submission error at the
        // same boundary that already checks class/text/evidence_ref.
        const kind = row['kind'];
        const kindPresent = kind !== undefined && kind !== null;
        if (kindPresent
          && (typeof kind !== 'string'
            || !(ORDER_CONSTRAINT_KINDS as readonly string[]).includes(kind))) {
          errors.push(
            `order_constraints[${index}].kind must be one of ${ORDER_CONSTRAINT_KINDS.join('|')}`,
          );
        }
        // ADR-090 (CC-IC-1 focused repair): the reserved kinds are kernel-only
        // authorities — open-question is created only by the deterministic
        // unknown lifting at settlement, and synthesis|ordered-smoke only by
        // the declared, digest-pinned lifecycle injection table. A draft row
        // carrying a reserved kind is a typed submission error here and again
        // at the v2 register builder (never a worker-forged authority).
        if (kindPresent
          && typeof kind === 'string'
          && (ORDER_CONSTRAINT_RESERVED_KINDS as readonly string[]).includes(kind)) {
          errors.push(
            `order_constraints[${index}].kind '${kind}' is kernel-reserved (open-question is `
            + 'drafted 1:1 from the proposal unknowns; synthesis|ordered-smoke are injected '
            + `from the declared lifecycle injection table) — a draft may declare only `
            + ORDER_CONSTRAINT_DRAFT_KINDS.join('|'),
          );
        }
        // ADR-090 (CC-IC-1): typed measurability binds ONLY kind `quality`
        // rows; when present it must be the measurable-interpretation form or
        // the typed-deferral form. The completeness rule (a quality row MUST
        // carry one) is enforced fail-closed by the register builder — the
        // boundary checks shape and kind-binding here.
        if (row['measurability'] !== undefined && row['measurability'] !== null) {
          const measurability = row['measurability'];
          if (kindPresent && kind !== 'quality') {
            errors.push(
              `order_constraints[${index}].measurability may only be declared by kind 'quality' constraints`,
            );
          }
          if (typeof measurability !== 'object' || measurability === null
            || Array.isArray(measurability)) {
            errors.push(
              `order_constraints[${index}].measurability must be { state: 'measurable', interpretation_ref } or { state: 'deferred', reason }`,
            );
          } else {
            const binding = measurability as Record<string, unknown>;
            const state = binding['state'];
            if (state === 'measurable') {
              const interpretationRef = binding['interpretation_ref'];
              if (typeof interpretationRef !== 'string' || interpretationRef.trim() === '') {
                errors.push(
                  `order_constraints[${index}].measurability of state 'measurable' requires a non-empty interpretation_ref`,
                );
              }
            } else if (state === 'deferred') {
              const reason = binding['reason'];
              if (typeof reason !== 'string' || reason.trim() === '') {
                errors.push(
                  `order_constraints[${index}].measurability of state 'deferred' requires a non-empty reason`,
                );
              }
            } else {
              errors.push(
                `order_constraints[${index}].measurability.state must be 'measurable' or 'deferred'`,
              );
            }
          }
        }
        // ADR-090 (CC-IC-1): lifecycle_synthesis is kernel-assigned on
        // injected entries only — a worker declaring it is a typed defect at
        // the submission boundary (the register builder repeats the check).
        if (row['lifecycle_synthesis'] !== undefined && row['lifecycle_synthesis'] !== null) {
          errors.push(
            `order_constraints[${index}].lifecycle_synthesis is kernel-assigned on injected entries only`,
          );
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
