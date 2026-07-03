// src/validators/brief.ts
//
// SRS-004 §2b.2 — brief-section validator.
//
// Pure, stateless function. Does NOT touch the database. Validates the shape
// and cross-field rules of a BriefPayload (the structured output of the
// discovery phase) and returns human-readable, per-field errors.
//
// ============================================================================
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (types + function signature) BEFORE the
// body-task lands. The function body is a permissive stub. The full validation
// rules live in SRS-004 §2b.2 and are implemented by the body-task AC-1
// (artifact_create(type:'brief'/'theme') + validateBrief, task #217):
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

/**
 * Validate a brief payload (SRS §2b.2).
 *
 * SCAFFOLD stub: returns a permissive {ok:true, errors:[]} so that dependent
 * body-tasks can wire artifact_create(type:'brief') before the real validation
 * rules ship in body-task AC-1 (#217). The body-task replaces this stub with
 * the full rule set documented above.
 *
 * @see SRS-004 §2b.2
 * @see body-task AC-1 (#217) — implements the validation rules
 */
export function validateBrief(_payload: unknown): BriefValidationResult {
  // SCAFFOLD stub — body-task AC-1 (#217) implements the real rules.
  return { ok: true, errors: [] };
}
