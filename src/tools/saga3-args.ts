/**
 * Shared argument validation + actionable-error helpers for the saga3 MCP tool
 * handlers (`proposal_submit`, `readiness_get`/`readiness_submit`,
 * `diagnosis_get`/`diagnosis_submit`, `normalization_get`/`normalization_submit`).
 *
 * WHY THIS EXISTS: the four handlers previously each hand-rolled (or copy-pasted)
 * their argument validators, producing THREE different `integerArg`/`stringArg`
 * error formats that drifted (readiness/diagnosis echoed the offending value,
 * normalization did not, proposals had no helper at all). More importantly, every
 * error was DIAGNOSTIC ONLY — it said WHAT was wrong ("intent_id must be an
 * integer") but not WHERE the worker should get the right value, nor the EXPECTED
 * call shape. The first real E2E run on a weaker model (`gemma-4-12b-qat`) showed
 * the cost: the model built a semantically-correct discovery proposal but failed
 * `proposal_submit` 6+ times because it put top-level args inside `payload`, and
 * the short errors gave it no path to self-correct.
 *
 * This module makes every argument error ACTIONABLE: it keeps the original short
 * phrase as a SUBSTRING (so existing regex-based tests keep matching) and appends:
 *   - the EXPECTED call shape for this tool;
 *   - the SOURCE of the correct value (which tool/field to read it from);
 *   - the GOT value (JSON-stringified, so the worker sees exactly what it sent).
 *
 * Placement: `src/tools/` (NOT `src/saga3/shared/`). Tool-call ergonomics is a
 * responsibility of the tools layer; `shared/` is reserved for canonical data
 * helpers (canonicalJson, sha256Hex) consumed by the pure domain layer, and an
 * MCP-error format must not leak into domain code. The precedent is
 * `src/tools/dispatcher.ts`, which already exports `withImmediateTransaction`
 * shared across all saga3 handlers.
 */

/**
 * Build an actionable error message. The `message` MUST contain the original
 * short diagnostic phrase as a substring (e.g. "must be an integer",
 * "schema_version mismatch") so existing regex-based handler tests keep passing;
 * this function appends the expected shape, the value source, and the got value.
 */
export function actionableError(
  tool: string,
  message: string,
  details: { field?: string; expected?: string; source?: string; got?: unknown } = {},
): Error {
  const parts: string[] = [`${tool}: ${message}`];
  if (details.expected) parts.push(`Expected shape: ${details.expected}`);
  if (details.source) parts.push(`Source: ${details.source}`);
  if (details.got !== undefined) parts.push(`Got: ${JSON.stringify(details.got)}`);
  return new Error(parts.join('. '));
}

/**
 * Read and validate an integer argument. Throws an actionable error that keeps
 * the legacy phrase "must be an integer" as a substring, plus the expected shape,
 * where to read the value from, and the offending value.
 */
export function argInt(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  opts: { source?: string; expected?: string } = {},
): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw actionableError(
      tool,
      `'${key}' must be an integer, got ${JSON.stringify(v)}`,
      { field: key, source: opts.source, expected: opts.expected, got: v },
    );
  }
  return v;
}

/**
 * Read and validate a non-empty string argument. Throws an actionable error that
 * keeps the legacy phrase "must be a non-empty string" as a substring. By default
 * trims before the empty check (matches readiness/diagnosis behaviour; the legacy
 * normalization helper did NOT trim — that drift is intentionally resolved toward
 * trim, since an all-whitespace string is never a valid saga identifier).
 */
export function argStr(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  opts: { source?: string; expected?: string; allowEmpty?: boolean } = {},
): string {
  const v = args[key];
  if (typeof v !== 'string' || (!opts.allowEmpty && v.trim() === '')) {
    throw actionableError(
      tool,
      `'${key}' must be a non-empty string`,
      { field: key, source: opts.source, expected: opts.expected, got: v },
    );
  }
  return v;
}

/**
 * The expected call shapes, surfaced both in errors and (eventually) in a future
 * read-only `proposal_get`. Centralised so the error message and the skill
 * template cannot drift apart.
 */
export const SAGA3_TOOL_CALL_SHAPES = {
  proposal_submit:
    'proposal_submit({ intent_id: <int from task_get.metadata.work_intent_id>, task_id: <int, your task_id>, execution_id: <string, your execution_id>, kind: "discovery", schema_version: "saga3.discovery-proposal.v1", payload: { problem_statement, observed_context, stakeholders_or_actors: [], assumptions: [], unknowns: [], risks: [], candidate_scope, evidence_refs: [], recommended_outcome, rationale } })',
  readiness_get:
    'readiness_get({ control_intent_id: <int from task metadata>, execution_id: <string> })',
  readiness_submit:
    'readiness_submit({ control_intent_id: <int>, execution_id: <string>, schema_version: "saga3.discovery-readiness-assessment.v1", payload: { proposal_id, proposal_content_hash, overall_readiness, dimension_assessments: { problem_clarity, scope_boundedness, stakeholder_coverage, assumption_visibility, unknowns_manageability, risk_visibility, evidence_grounding }, blocking_gaps: [], non_blocking_gaps: [], recommended_next_action, confidence, rationale } })',
  diagnosis_get:
    'diagnosis_get({ control_intent_id: <int from task metadata>, execution_id: <string> })',
  diagnosis_submit:
    'diagnosis_submit({ control_intent_id: <int>, execution_id: <string>, schema_version: "saga3.discovery-diagnosis.v1", payload: { target: { certificate_id, certificate_hash, settlement_input_hash, decision }, executive_summary, cause_analysis: [], information_requests: [], recommended_actions: [], residual_risks: [], confidence } })',
  normalization_get:
    'normalization_get({ control_intent_id: <int>, source_submission_id: <int>, execution_id: <string> })',
  normalization_submit:
    'normalization_submit({ control_intent_id: <int>, source_submission_id: <int>, execution_id: <string>, schema_version: "saga3.discovery-normalization-proposal.v1", payload: { ...normalized discovery proposal fields... } })',
} as const;

/** Where each integer/string argument should come from — used in error messages. */
export const SAGA3_ARG_SOURCES = {
  intent_id: 'task_get → metadata.work_intent_id (top-level arg, NOT inside payload)',
  task_id: 'your assigned task_id (top-level arg, NOT inside payload)',
  execution_id: 'your execution_id (top-level arg, NOT inside payload)',
  control_intent_id: 'task_get → metadata.control_intent_id (top-level arg, NOT inside payload)',
  source_submission_id: 'normalization_get → source_submission_id (top-level arg, NOT inside payload)',
  schema_version: 'the exact schema string for this tool (top-level arg, NOT inside payload)',
  kind: '"discovery" (top-level arg, NOT inside payload)',
} as const;
