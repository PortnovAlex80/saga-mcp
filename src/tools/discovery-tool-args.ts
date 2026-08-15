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
 *
 * W13-A5: the workflow hint appended by `enrichPayloadErrors` is now
 * PARAMETERIZED via {@link renderWorkflowHint} from the W6-A5
 * `ActionableToolError` platform module. The hard-coded Discovery tracker
 * literal that used to live here is gone; each calling site passes its own
 * module's `trackerRef`/`checklistRef`/`resumeStep`. The four saga3 handlers
 * are Discovery tools, so they share {@link DISCOVERY_WORKFLOW_REFS}.
 */

import { renderWorkflowHint } from '../application/actionable-tool-error.js';

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
export const FACTORY_TOOL_CALL_SHAPES = {
  proposal_submit:
    'proposal_submit({ intent_id: <int from task_get.metadata.work_intent_id>, task_id: <int, your task_id>, execution_id: <string, your execution_id>, kind: "discovery", schema_version: "factory.discovery-proposal.v1", payload: { problem_statement, observed_context, stakeholders_or_actors: [], assumptions: [], unknowns: [], risks: [], candidate_scope, evidence_refs: [], recommended_outcome, rationale } })',
  readiness_get:
    'readiness_get({ control_intent_id: <int from task metadata>, execution_id: <string> })',
  readiness_submit:
    'readiness_submit({ control_intent_id: <int>, execution_id: <string>, schema_version: "factory.discovery-readiness-assessment.v1", payload: { proposal_id, proposal_content_hash, overall_readiness, dimension_assessments: { problem_clarity, scope_boundedness, stakeholder_coverage, assumption_visibility, unknowns_manageability, risk_visibility, evidence_grounding }, blocking_gaps: [], non_blocking_gaps: [], recommended_next_action, confidence, rationale } })',
  normalization_get:
    'normalization_get({ control_intent_id: <int>, source_submission_id: <int>, execution_id: <string> })',
  normalization_submit:
    'normalization_submit({ control_intent_id: <int>, source_submission_id: <int>, execution_id: <string>, schema_version: "factory.discovery-normalization-proposal.v1", payload: { ...normalized discovery proposal fields... } })',
} as const;

/** Where each integer/string argument should come from — used in error messages. */
export const FACTORY_ARG_SOURCES = {
  intent_id: 'task_get → metadata.work_intent_id (top-level arg, NOT inside payload)',
  task_id: 'your assigned task_id (top-level arg, NOT inside payload)',
  execution_id: 'your execution_id (top-level arg, NOT inside payload)',
  control_intent_id: 'task_get → metadata.control_intent_id (top-level arg, NOT inside payload)',
  source_submission_id: 'normalization_get → source_submission_id (top-level arg, NOT inside payload)',
  schema_version: 'the exact schema string for this tool (top-level arg, NOT inside payload)',
  kind: '"discovery" (top-level arg, NOT inside payload)',
} as const;

/**
 * Per-tool mapping of PAYLOAD fields (the typed object inside the tool's
 * `payload` arg) to where the worker should source their correct values. This
 * extends FACTORY_ARG_SOURCES (which covers envelope args) to the payload body.
 *
 * Identity-echo fields (proposal_id, certificate_id, hashes) point the worker to
 * the read-only `_get` tool that already returned them. source_refs failures
 * point to the `allowed_source_refs` list the `_get` tool returned. Fields that
 * are the worker's own analysis (rationale, description, summary) get no hint.
 */
const PAYLOAD_FIELD_SOURCES: Record<string, Record<string, string>> = {
  readiness_submit: {
    proposal_id: 'readiness_get → proposal_id (echo the value readiness_get returned; must be an integer)',
    proposal_content_hash: 'readiness_get → proposal_content_hash (echo the 64-char hex readiness_get returned)',
    source_refs: 'use ONLY refs from the allowed_source_refs list returned by readiness_get',
    overall_readiness: 'one of: ready, conditionally_ready, not_ready, inconclusive',
    recommended_next_action: 'one of: proceed_to_settlement, request_clarification, repeat_discovery, defer, reject, manual_review',
    confidence: 'a number between 0 and 1',
    dimension_assessments: 'object with all 7 keys: problem_clarity, scope_boundedness, stakeholder_coverage, assumption_visibility, unknowns_manageability, risk_visibility, evidence_grounding',
    blocking_gaps: 'array of { code, description, source_refs[] }',
    non_blocking_gaps: 'array of { code, description, source_refs[] }',
  },
  proposal_submit: {
    recommended_outcome: 'one of: go, clarify, reject, defer, inconclusive, failed',
    evidence_refs: 'array of non-empty strings (citations the proposal is grounded on)',
    stakeholders_or_actors: 'array of strings',
    assumptions: 'array of strings',
    unknowns: 'array of strings (NOT a JSON string — an actual array)',
    risks: 'array of strings',
  },
  normalization_submit: {
    source_submission_id: 'normalization_get → source_submission_id (echo the integer)',
    source_raw_hash: 'normalization_get → source raw hash (echo the 64-char hex)',
    source_field_map: 'object mapping each canonical field to source JSON paths that exist in the raw payload',
    normalized_payload: 'a valid discovery proposal object (see proposal_submit payload shape)',
  },
};

/**
 * Workflow references for the Discovery module's saga3 tools. W13-A5: the four
 * saga3 handlers all belong to the Discovery Process Module, so they share one
 * set of tracker/checklist/resume refs. Passing these into {@link enrichPayloadErrors}
 * (and into the proposal_submit success hint) keeps the Discovery path tokens
 * out of the platform helpers — a Formalization or Delivery tool would pass its
 * own refs and never see a `docs/discovery/...` literal.
 */
export const DISCOVERY_WORKFLOW_REFS = {
  trackerRef: 'the exact tracker_path returned by task_get._workflow_hint',
  checklistRef: 'the exact checklist path returned by task_get._workflow_hint',
  resumeStep: 'the rejected operation after repairing and re-reading the materialized call file',
} as const;

/**
 * Enrich raw payload-validator errors with actionable context for the model.
 * The validators return terse diagnostics like "field 'proposal_id' must be an
 * integer" — this appends a Source hint telling the worker WHERE to get the
 * correct value (readiness_get/diagnosis_get/normalization_get), plus the
 * expected call shape once per batch. The raw error phrase is preserved as a
 * substring so existing regex tests and DB-stored audit errors stay stable.
 *
 * Applied ONLY at the handler→model boundaries (the DB copy stays raw for
 * kernel audit). The pure validators are untouched.
 *
 * W13-A5: the trailing `[Workflow: ...]` sentence is PARAMETERIZED via
 * {@link renderWorkflowHint}. Callers pass their module's own
 * tracker/checklist/resume refs (`workflowRefs`); when omitted, no workflow
 * sentence is appended (the caller had nothing actionable to point at). The
 * hard-coded Discovery literal that used to be appended here is removed.
 */
export function enrichPayloadErrors(
  tool: string,
  errors: string[],
  workflowRefs: { trackerRef?: string; checklistRef?: string; resumeStep?: string } = DISCOVERY_WORKFLOW_REFS,
): string[] {
  if (!errors || errors.length === 0) return errors;
  const sources = PAYLOAD_FIELD_SOURCES[tool];
  const shape = (FACTORY_TOOL_CALL_SHAPES as Record<string, string>)[tool];

  // This helper is deliberately scoped to known Saga 3 tool contracts. Adding a
  // generic workflow sentence to an unknown tool changes its error semantics and
  // can hide the fact that no actionable shape/source registry exists for it.
  if (!sources && !shape) return errors;

  const enriched = errors.map((raw) => {
    let hint: string | undefined;
    if (sources) {
      // source_refs errors must be matched FIRST — they nest under many paths
      // (dimension_assessments.X.source_refs, blocking_gaps[i].source_refs, etc.)
      // and the generic field-key loop below would wrongly match the parent
      // field (e.g. 'dimension_assessments') instead of the source_refs rule.
      if (/source_ref|unresolved source|empty source|invents evidence/.test(raw) && sources.source_refs) {
        hint = sources.source_refs;
      }
      if (!hint) {
        const fieldKeys = Object.keys(sources).sort((a, b) => b.length - a.length);
        for (const field of fieldKeys) {
          if (field !== 'source_refs' && raw.includes(field)) {
            hint = sources[field];
            break;
          }
        }
      }
    }
    return hint ? `${raw} [Source: ${hint}]` : raw;
  });

  // Keep the expected shape as the final, highest-value recovery instruction.
  // Tests and weak-model skills rely on this stable last element.
  const workflowHint = renderWorkflowHint(workflowRefs);
  if (workflowHint) enriched.push(workflowHint);
  if (shape) enriched.push(`[Expected ${tool} shape: ${shape}]`);
  return enriched;
}
