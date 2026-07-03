// src/validators/brief.ts
//
// SRS-004 §2b.2 — brief-section validator.
//
// Pure, stateless function. Does NOT touch the database. Validates the shape
// and cross-field rules of a BriefPayload (the structured output of the
// discovery phase) and returns human-readable, per-field errors.
//
// ============================================================================
// Implemented by body-task AC-1 (#217).
// ============================================================================
// The API CONTRACT (types + function signature) was fixed by SCAFFOLD #215
// (Pattern B). This file now implements the full validation rule set from
// SRS-004 §2b.2:
//
//   - decision must be one of 4 literals, else errors.push('decision: invalid').
//   - affected_projects.length > 1 AND topology_hint === 'parallel-independent'
//       → errors.push('topology_hint: multi-project requires sequence or
//         scaffold-then-parallel').
//   - completeness === 'low' AND decision === 'go'
//       → errors.push('completeness=low blocks decision=go; use clarify').
//   - empty reasoning string → error.
//
// Extension point (SRS §2b.2): a new validation rule = a new branch in
// validateBrief. No classes, no strategies — one function.
// ============================================================================

/**
 * Structured payload of a discovery brief (SRS §2b.2).
 */
export interface BriefPayload {
  classification: 'product' | 'tech-task' | 'research';
  complexity: {
    tshirt: 'XS' | 'S' | 'M' | 'L' | 'XL';
    risk_triggers: string[]; // ≤7, from a fixed list of triggers
  };
  hypotheses?: string[];
  quality_gate_checklist?: string[];
  open_questions?: string[];
  decision_matrix?: {
    criteria: string[];
    variants: { name: string; scores: Record<string, number> }[];
  };
  decision: 'go' | 'fast-track' | 'clarify' | 'reject';
  reasoning: string; // ≥1 sentence
  affected_projects: number[]; // saga project_id
  topology_hint: 'parallel-independent' | 'sequence' | 'scaffold-then-parallel';
  scaffold_artifacts: string[]; // file paths
  shared_mutation_risk: boolean;
  completeness: 'high' | 'low';
  degraded: boolean;
}

/**
 * Result of validating a BriefPayload (SRS §2b.2).
 */
export interface BriefValidationResult {
  ok: boolean;
  errors: string[]; // human-readable, per-field
}

const DECISION_LITERALS = ['go', 'fast-track', 'clarify', 'reject'] as const;
const TOPOLOGY_LITERALS = ['parallel-independent', 'sequence', 'scaffold-then-parallel'] as const;
const COMPLETENESS_LITERALS = ['high', 'low'] as const;

/**
 * Validate a brief payload (SRS §2b.2).
 *
 * Pure, stateless — never touches the DB. Collects ALL applicable errors in a
 * single pass (does not short-circuit on the first), so a caller sees every
 * problem at once. Each error string is human-readable and field-scoped, and
 * uses the exact wording fixed by the SRS contract (the unit tests assert on
 * those literals — keep them stable).
 *
 * Rules (SRS §2b.2):
 *   1. `decision` must be one of {go, fast-track, clarify, reject}.
 *   2. `affected_projects.length > 1` AND `topology_hint === 'parallel-independent'`
 *      → multi-project work cannot be parallel-independent.
 *   3. `completeness === 'low'` AND `decision === 'go'` → a low-completeness
 *      brief must not commit to go; use 'clarify'.
 *   4. `reasoning` must be a non-empty (non-blank) string.
 *
 * The payload is typed `unknown` (callers pass `metadata.brief_payload` straight
 * from the tool args, which is untyped JSON), so every field is read defensively.
 * Missing/wrong-typed optional fields are not errors; missing/wrong-typed
 * REQUIRED fields (decision, reasoning) are.
 *
 * @see SRS-004 §2b.2
 */
export function validateBrief(payload: unknown): BriefValidationResult {
  const errors: string[] = [];

  if (payload == null || typeof payload !== 'object') {
    // Nothing structural to check against the rules — report the root shape.
    return { ok: false, errors: ['brief_payload: must be an object'] };
  }

  const p = payload as Record<string, unknown>;

  // Rule 1 — decision literal. This is the contract's keystone: a brief with a
  // missing/invalid decision stays in `draft` (AC-1). Missing counts as invalid.
  const decision = p.decision;
  if (
    typeof decision !== 'string' ||
    !(DECISION_LITERALS as readonly string[]).includes(decision)
  ) {
    errors.push('decision: invalid');
  }

  // Rule 4 — reasoning non-empty. `reasoning` is a required string field; a
  // blank/whitespace-only value carries no rationale and fails the brief.
  const reasoning = p.reasoning;
  if (typeof reasoning !== 'string' || reasoning.trim() === '') {
    errors.push('reasoning: must be a non-empty string');
  }

  // Rule 2 — multi-project topology. Only meaningful when the caller actually
  // supplied affected_projects; a missing/malformed array is left for a stricter
  // schema validator — here we only enforce the cross-field invariant.
  const affectedProjects = p.affected_projects;
  const topologyHint = p.topology_hint;
  if (
    Array.isArray(affectedProjects) && affectedProjects.length > 1 &&
    topologyHint === 'parallel-independent'
  ) {
    errors.push(
      'topology_hint: multi-project requires sequence or scaffold-then-parallel',
    );
  }

  // Rule 3 — low completeness forbids a 'go' decision. (If decision was invalid,
  // it cannot equal 'go', so this rule simply does not fire — the invalidity is
  // already reported by rule 1.)
  if (p.completeness === 'low' && decision === 'go') {
    errors.push('completeness=low blocks decision=go; use clarify');
  }

  return { ok: errors.length === 0, errors };
}
