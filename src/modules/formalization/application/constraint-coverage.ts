/**
 * Shared reader for the AC-drift coverage inputs: the constraint register
 * resolved from the FormalizationCase (which rides the task's frozen
 * process_node_input) plus the validly-waived IDs from the accepted brief's
 * constraint_dispositions metadata.
 *
 * One reader, three consumers (acceptance validator, reconciliation
 * validator, SRS validator) — the diff itself lives in
 * formalization-contract-analysis.ts, so the worker_done gate and the
 * resolver can never disagree on what "covered" means.
 */

import type { FormalizationCase } from '../domain/formalization-schemas.js';
import {
  FORMALIZATION_CASE_SCHEMA,
  resolveFormalizationCaseConstraintRegister,
} from '../domain/formalization-schemas.js';
import type {
  ConstraintCoverageRequirement,
} from './formalization-contract-analysis.js';

/**
 * Driver-neutral database handle alias. See srs-contract-validator.ts for
 * rationale (Wave 7 architecture test: no-sqlite-in-modules).
 */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

/**
 * Resolve the coverage requirement for a task. Returns null when the case
 * carries no register (retro-compat: empty diff, gate stays green).
 *
 * Waivers count ONLY when they carry a non-empty reason — an invalid waiver
 * is an A1 reaction defect, never a coverage free pass.
 */
export function readConstraintCoverageRequirement(
  db: DbHandle,
  taskId: number,
  processRunId: number,
): (ConstraintCoverageRequirement & { registerTexts: Readonly<Record<string, string>> }) | null {
  const taskRow = db.prepare(
    'SELECT metadata FROM tasks WHERE id=?',
  ).get(taskId) as { metadata: string | null } | undefined;
  if (!taskRow || typeof taskRow.metadata !== 'string') return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(taskRow.metadata);
  } catch {
    return null;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const caseCandidate = (metadata as Record<string, unknown>).process_node_input;
  if (
    typeof caseCandidate !== 'object'
    || caseCandidate === null
    || Array.isArray(caseCandidate)
    || (caseCandidate as Record<string, unknown>).schemaVersion !== FORMALIZATION_CASE_SCHEMA
  ) {
    return null;
  }
  const formalizationCase = caseCandidate as unknown as FormalizationCase;
  const binding = resolveFormalizationCaseConstraintRegister(formalizationCase);
  if (!binding) return null;

  const briefRow = db.prepare(
    `SELECT a.metadata
       FROM artifacts a
       JOIN factory_managed_artifact_productions p ON p.artifact_id = a.id
      WHERE p.process_run_id=? AND a.type='brief'
      ORDER BY a.id DESC LIMIT 1`,
  ).get(processRunId) as { metadata: string | null } | undefined;
  const waivedIds: string[] = [];
  if (briefRow && typeof briefRow.metadata === 'string') {
    try {
      const parsed = JSON.parse(briefRow.metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const dispositions = (parsed as Record<string, unknown>).constraint_dispositions;
        if (typeof dispositions === 'object' && dispositions !== null && !Array.isArray(dispositions)) {
          for (const [id, value] of Object.entries(dispositions as Record<string, unknown>)) {
            if (
              typeof value === 'object' && value !== null && !Array.isArray(value)
              && (value as Record<string, unknown>).disposition === 'waived'
              && typeof (value as Record<string, unknown>).reason === 'string'
              && ((value as Record<string, unknown>).reason as string).trim().length > 0
            ) {
              waivedIds.push(id);
            }
          }
        }
      }
    } catch {
      // Unreadable brief metadata: no waivers count. The A1 gate owns the
      // disposition-validity defect; here it just means nothing is waived.
    }
  }

  const registerTexts: Record<string, string> = {};
  for (const entry of binding.constraintRegister.constraints) {
    registerTexts[entry.id] = `${entry.class}: ${entry.text}`;
  }
  return {
    constraintIds: binding.constraintRegister.constraints.map(entry => entry.id),
    waivedIds,
    registerTexts,
  };
}

/**
 * Build the structured per-ID SubmissionGaps for uncovered constraints. The
 * relation is `covers_constraint` — the same typed relation the A1
 * disposition gate uses, so repair feedback names the ID either way.
 */
export function constraintCoverageSubmissionGaps(
  uncoveredIds: readonly string[],
  registerTexts: Readonly<Record<string, string>>,
): ReadonlyArray<{
  artifactId: number;
  artifactCode: string;
  artifactType: string;
  existingTargets: ReadonlyArray<{ type: string; id: number }>;
  missing: {
    relation: string;
    requiredTargetTypes: ReadonlyArray<string>;
    minimum: number;
  };
  message: string;
}> {
  return uncoveredIds.map(id => ({
    artifactId: -1,
    artifactCode: id,
    artifactType: 'AC',
    existingTargets: [],
    missing: {
      relation: 'covers_constraint',
      requiredTargetTypes: [id],
      minimum: 1,
    },
    message: `Constraint ${id} (${registerTexts[id] ?? 'order constraint'}) is covered by no AC:`
      + ` add it to an AC artifact's metadata covered_constraint_ids`
      + ` (or waive it in the brief with a reason).`,
  }));
}
