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
//       → ALLOWED if the brief carries a decision_matrix with ≥3 variants
//         AND a recommended_variant AND all open_questions are answered by
//         the agent itself (status='answered'). This is the agent-first
//         path: the agent has enough context to commit, no human needed.
//       → errors.push('completeness=low blocks decision=go; use clarify')
//         ONLY when those conditions are NOT met.
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
  open_questions?: Array<{
    id: string;
    target?: string;
    question: string;
    status?: 'open' | 'answered';
    answer?: string;
    reasoning?: string;
  }>;
  decision_matrix?: {
    criteria: string[];
    variants: { name: string; scores: Record<string, number> }[];
  };
  recommended_variant?: string;
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
 *   3. `completeness === 'low'` AND `decision === 'go'` → ALLOWED only when
 *      the brief carries an agent-resolved justification:
 *        (a) `decision_matrix` with ≥3 variants,
 *        (b) `recommended_variant` non-empty,
 *        (c) every entry in `open_questions` has `status='answered'` with a
 *            non-empty `answer` (the agent itself resolved them via domain
 *            knowledge rather than escalating to a human).
 *      This is the **agent-first** path: the agent knows more about the
 *      engineering context than the human sponsor; asking the human to
 *      rubber-stamp the agent's own domain reasoning is wasteful. If any of
 *      (a)/(b)/(c) is missing, the rule fires and the brief must use 'clarify'.
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

  // Rule 3 — low completeness with decision='go' is ALLOWED only when the
  // agent has resolved every open question itself AND built a real decision
  // matrix (≥3 variants + recommended_variant). This is the agent-first
  // auto-resolve path: the agent uses its domain knowledge to answer the
  // questions a human sponsor would otherwise be asked, then commits to 'go'
  // on the strength of its own matrix. If any precondition is missing, the
  // brief must escalate to 'clarify' (the human-in-the-loop fallback).
  if (p.completeness === 'low' && decision === 'go') {
    const matrix = p.decision_matrix as
      | { variants?: unknown[] }
      | undefined;
    const recommended = typeof p.recommended_variant === 'string'
      ? (p.recommended_variant as string).trim()
      : '';
    const openQuestions = Array.isArray(p.open_questions) ? p.open_questions as Array<Record<string, unknown>> : [];
    const allAnswered = openQuestions.length > 0
      && openQuestions.every(q => q.status === 'answered' && typeof q.answer === 'string' && (q.answer as string).trim() !== '');
    const hasMatrix = !!matrix && Array.isArray(matrix.variants) && matrix.variants.length >= 3;
    const agentResolved = hasMatrix && recommended !== '' && allAnswered;
    if (!agentResolved) {
      errors.push('completeness=low blocks decision=go; use clarify (or agent-resolve all open_questions with answers + provide recommended_variant + decision_matrix with ≥3 variants)');
    }
  }

  return { ok: errors.length === 0, errors };
}
