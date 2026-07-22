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
