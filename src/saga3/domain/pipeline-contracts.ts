/**
 * Saga 3 — Pipeline condition contracts.
 *
 * Defines the condition dependency graph for the full delivery pipeline.
 * The controller does not know about "stages" — it knows about conditions
 * and their dependencies. Stages are derived for display only.
 *
 * Plan §13 Gate H: "Expand the walking skeleton to cover discovery,
 * formalization, feasibility, architecture, planning, development,
 * verification, integration, runtime validation, release, observation,
 * degradation, truthful negative outcomes."
 */

import type Database from 'better-sqlite3';
import type { ConditionContract, ActionContract } from './types.js';

/**
 * The standard pipeline condition contracts.
 * Each condition depends on upstream conditions being True.
 * The controller resolves deficits top-to-bottom.
 */
export const PIPELINE_CONDITIONS: readonly ConditionContract[] = [
  // Discovery
  {
    conditionType: 'MandatePresent',
    obligationId: 'mandate',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'mandate-check',
    dependsOn: [],
  },
  {
    conditionType: 'ConstitutionReady',
    obligationId: 'constitution',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'constitution-check',
    dependsOn: ['MandatePresent'],
  },
  // Formalization
  {
    conditionType: 'ContractConsistent',
    obligationId: 'contract',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'traceability-check',
    dependsOn: ['ConstitutionReady'],
  },
  {
    conditionType: 'BaselineFrozen',
    obligationId: 'baseline',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'baseline-hash-check',
    dependsOn: ['ContractConsistent'],
  },
  // Architecture
  {
    conditionType: 'ArchitectureReady',
    obligationId: 'architecture',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'srs-check',
    dependsOn: ['BaselineFrozen'],
  },
  // Planning
  {
    conditionType: 'PlanReady',
    obligationId: 'plan',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'plan-completeness-check',
    dependsOn: ['ArchitectureReady'],
  },
  // Development
  {
    conditionType: 'ImplementationComplete',
    obligationId: 'implementation',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'build-check',
    dependsOn: ['PlanReady'],
  },
  // Verification
  {
    conditionType: 'VerificationCurrent',
    obligationId: 'verification',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'evidence-check',
    dependsOn: ['ImplementationComplete'],
  },
  // Integration
  {
    conditionType: 'IntegrationComplete',
    obligationId: 'integration',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'integration-check',
    dependsOn: ['VerificationCurrent'],
  },
  // Release
  {
    conditionType: 'ReleaseReady',
    obligationId: 'release',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'release-check',
    dependsOn: ['IntegrationComplete'],
  },
  {
    conditionType: 'ReleaseCompleted',
    obligationId: 'release-done',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'release-observed',
    dependsOn: ['ReleaseReady'],
  },
  // Observation
  {
    conditionType: 'ObservationHealthy',
    obligationId: 'observation',
    scopeType: 'episode',
    scopeId: '',
    oracleRequired: 'health-check',
    dependsOn: ['ReleaseCompleted'],
  },
];

/**
 * The standard pipeline action contracts.
 * Each action maps to a Skill that can produce the required artifact/observation.
 */
export const PIPELINE_ACTIONS: readonly ActionContract[] = [
  // Discovery
  {
    actionKind: 'discover',
    targetCondition: 'ConstitutionReady',
    skillId: 'saga-kickstart',
    prerequisites: ['MandatePresent'],
  },
  // Formalization
  {
    actionKind: 'compile-prd',
    targetCondition: 'ContractConsistent',
    skillId: 'saga-product',
    prerequisites: ['ConstitutionReady'],
  },
  {
    actionKind: 'stamp-baseline',
    targetCondition: 'BaselineFrozen',
    skillId: 'saga-reconciler',
    prerequisites: ['ContractConsistent'],
  },
  // Architecture
  {
    actionKind: 'compile-srs',
    targetCondition: 'ArchitectureReady',
    skillId: 'saga-architect',
    prerequisites: ['BaselineFrozen'],
  },
  // Planning
  {
    actionKind: 'decompose',
    targetCondition: 'PlanReady',
    skillId: 'saga-planner',
    prerequisites: ['ArchitectureReady'],
  },
  // Development — one action per AC obligation
  {
    actionKind: 'implement',
    targetCondition: 'ImplementationComplete',
    skillId: 'saga-worker',
    prerequisites: ['PlanReady'],
  },
  // Verification
  {
    actionKind: 'verify',
    targetCondition: 'VerificationCurrent',
    skillId: 'saga-verifier',
    prerequisites: ['ImplementationComplete'],
  },
  // Integration
  {
    actionKind: 'integrate',
    targetCondition: 'IntegrationComplete',
    skillId: 'saga-worker',
    prerequisites: ['VerificationCurrent'],
  },
  // Release
  {
    actionKind: 'prepare-release',
    targetCondition: 'ReleaseReady',
    skillId: 'saga-release',
    prerequisites: ['IntegrationComplete'],
  },
  {
    actionKind: 'release',
    targetCondition: 'ReleaseCompleted',
    skillId: 'saga-release',
    prerequisites: ['ReleaseReady'],
  },
  // Observation
  {
    actionKind: 'observe',
    targetCondition: 'ObservationHealthy',
    skillId: 'saga-verifier',
    prerequisites: ['ReleaseCompleted'],
  },
];

/**
 * ConditionType → v2 task_kind mapping.
 *
 * saga3 authorizes work on CONDITIONS, but the visibility layer
 * (worker_executions, the frontend board, task list) speaks the v2 contract:
 * one row in `tasks` per unit of work, addressed by real `task_id`. Without a
 * real task row, the board shows synthetic ids (#9041356) that mean nothing to
 * the operator. This map bridges the two: each condition carries the canonical
 * v2 `task_kind` (and `workflow_stage`) that the corresponding skill produces,
 * so the engine can resolve a real `tasks.id` for the episode and the board
 * renders "🤖 #103 Discovery: ..." exactly as in v2.
 *
 * task_kind values are the SAME canonical set src/tools/workflow.ts validates
 * transitions against (brief_accepted, prd_accepted, uc_accepted, ...). Do not
 * invent new ones here — they would not auto-fire the downstream generation.
 */
export const CONDITION_TASK_KIND: Record<string, { task_kind: string; workflow_stage: string }> = {
  ConstitutionReady:     { task_kind: 'discovery.kickstart',        workflow_stage: 'discovery' },
  ContractConsistent:    { task_kind: 'formalization.prd',          workflow_stage: 'formalization' },
  BaselineFrozen:        { task_kind: 'formalization.reconciliation', workflow_stage: 'formalization' },
  ArchitectureReady:     { task_kind: 'formalization.srs',          workflow_stage: 'formalization' },
  PlanReady:             { task_kind: 'planning.decomposition',      workflow_stage: 'planning' },
  ImplementationComplete:{ task_kind: 'development.code',           workflow_stage: 'development' },
  VerificationCurrent:   { task_kind: 'verification.ac',            workflow_stage: 'verification' },
  IntegrationComplete:   { task_kind: 'integration.merge',          workflow_stage: 'integration' },
  ReleaseReady:          { task_kind: 'release.prepare',            workflow_stage: 'release' },
  ReleaseCompleted:      { task_kind: 'release.publish',            workflow_stage: 'release' },
  ObservationHealthy:    { task_kind: 'observation.monitor',        workflow_stage: 'observation' },
};

/**
 * Resolve a real `tasks.id` for an episode + condition, creating the task row
 * if it does not exist yet. The id is stable across restarts (idempotent INSERT
 * OR IGNORE on epic_id + task_kind), so the engine never invents synthetic
 * ids and the board always renders a real task number.
 *
 * Returns 0 only if the condition is unmapped (defensive — should not happen
 * for the canonical 11 conditions).
 */
export function resolveTaskForCondition(
  db: Database.Database,
  epicId: number,
  conditionType: string,
  mandate: string,
): number {
  const mapping = CONDITION_TASK_KIND[conditionType];
  if (!mapping) return 0;
  const existing = db.prepare(
    `SELECT id FROM tasks WHERE epic_id=? AND task_kind=? ORDER BY id LIMIT 1`,
  ).get(epicId, mapping.task_kind) as { id: number } | undefined;
  if (existing) return existing.id;
  // Create the canonical task for this stage. task_kind + workflow_stage match
  // what workflow.ts validates transitions against, so a downstream
  // brief_accepted/prd_accepted/... generation can fire from worker_done.
  const title = mapping.task_kind === 'discovery.kickstart'
    ? `Discovery: ${mandate}`
    : `${mapping.task_kind} — ${conditionType}`;
  const result = db.prepare(
    `INSERT OR IGNORE INTO tasks
       (epic_id, title, description, status, priority, task_kind, workflow_stage,
        execution_skill, execution_mode, tags, metadata)
     VALUES (?, ?, '', 'todo', 'high', ?, ?, ?, 'tracker_only',
             ?, '{}')`,
  ).run(
    epicId, title, mapping.task_kind, mapping.workflow_stage,
    PIPELINE_ACTIONS.find((a) => a.targetCondition === conditionType)?.skillId ?? 'saga-worker',
    JSON.stringify([`stage:${mapping.workflow_stage}`, `kind:${mapping.task_kind}`]),
  );
  // INSERT OR IGNORE may have matched an existing row (changes=0); re-read.
  if (!result.changes) {
    const reread = db.prepare(
      `SELECT id FROM tasks WHERE epic_id=? AND task_kind=? ORDER BY id LIMIT 1`,
    ).get(epicId, mapping.task_kind) as { id: number } | undefined;
    return reread?.id ?? 0;
  }
  return Number(result.lastInsertRowid);
}

/**
 * Derived display stages — for UI only. Never authorizes dispatch.
 */
export const DISPLAY_STAGES: ReadonlyArray<{
  readonly stage: string;
  readonly entryConditions: readonly string[];
}> = [
  { stage: 'discovery', entryConditions: ['MandatePresent'] },
  { stage: 'formalization', entryConditions: ['ConstitutionReady'] },
  { stage: 'architecture', entryConditions: ['BaselineFrozen'] },
  { stage: 'planning', entryConditions: ['ArchitectureReady'] },
  { stage: 'development', entryConditions: ['PlanReady'] },
  { stage: 'verification', entryConditions: ['ImplementationComplete'] },
  { stage: 'integration', entryConditions: ['VerificationCurrent'] },
  { stage: 'release', entryConditions: ['IntegrationComplete'] },
  { stage: 'observation', entryConditions: ['ReleaseCompleted'] },
  { stage: 'completed', entryConditions: ['ObservationHealthy'] },
];

/**
 * The terminal conditions: all of these must be True for SUCCEEDED.
 */
export const MANDATORY_CONDITIONS = [
  'MandatePresent',
  'ConstitutionReady',
  'ContractConsistent',
  'BaselineFrozen',
  'ArchitectureReady',
  'PlanReady',
  'ImplementationComplete',
  'VerificationCurrent',
  'IntegrationComplete',
  'ReleaseCompleted',
  'ObservationHealthy',
] as const;

/**
 * Build initial condition instances for a fresh episode.
 * All start as Unknown.
 */
export function initialConditions(episodeSpecId: string): Map<string, {
  episodeSpecId: string;
  conditionType: string;
  obligationId: string;
  scopeType: string;
  scopeId: string;
  status: 'Unknown';
  projectionVersion: number;
  observedGeneration: null;
  sourceFingerprint: null;
  invalidationReason: null;
}> {
  const map = new Map();
  for (const c of PIPELINE_CONDITIONS) {
    map.set(c.conditionType, {
      episodeSpecId,
      conditionType: c.conditionType,
      obligationId: c.obligationId,
      scopeType: c.scopeType,
      scopeId: c.scopeId,
      status: 'Unknown' as const,
      projectionVersion: 0,
      observedGeneration: null,
      sourceFingerprint: null,
      invalidationReason: null,
    });
  }
  return map;
}
