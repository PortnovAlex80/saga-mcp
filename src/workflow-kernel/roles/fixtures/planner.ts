/**
 * workflow-kernel/roles/fixtures/planner.ts - the synthetic VALID canonical
 * role contract of the planner semantic profile (WP-17 fixture).
 *
 * Bound to the development planning-cell author launch kind
 * (development.planning.author): workItem.planGraph cognition per frozen
 * decision D10. All referenced artifacts are synthetic; digests are
 * computed through the kernel's ONE canonical rule at build time.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import { manifestBindingByLaunchKind } from '../compiler.js';
import type { CompileRoleContractInput } from '../compiler.js';
import type { SemanticProfileArtifact } from '../shapes.js';
import {
  syntheticCompletionCommandSchema,
  syntheticProductContractRef,
  syntheticPromptBudgetStandIn,
  syntheticRouteTable,
  syntheticSkill,
  syntheticTrackerProfile,
} from './support.js';

export const plannerLaunchKind = 'development.planning.author';

/** Builds the compile input: manifest row + content + referenced artifacts. */
export function buildPlannerFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(plannerLaunchKind);
  if (binding === undefined) {
    throw new Error(`planner fixture: launch kind ${plannerLaunchKind} is outside the installed manifest`);
  }

  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'planner',
    definitionSummary: 'Plans repository-scoped cell work against accepted upstream material.',
  };
  const protocolSkill = syntheticSkill(
    'synthetic-protocol-planner',
    'Synthetic cognition-only execution-protocol instructions for the planner profile.',
  );
  const semanticSkill = syntheticSkill(
    'synthetic-semantic-planner',
    'Synthetic cognition-only planner-profile semantic instructions (plan graph construction).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.development-planning-author',
    plannerLaunchKind,
    'synthetic-model-plan',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('planRevisionRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.development-planning-author',
    'Development planner',
    'in-progress',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('planner');

  return {
    binding,
    content: {
      schemaVersion: 'ek.canonical-role-contract.ek1.v1',
      protocolRole: binding.protocolRole,
      semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfileArtifact)}`,
      protocolSkillRef: `sha256:${sha256OfCanonical(protocolSkill)}`,
      protocolSkillDigest: sha256OfCanonical(protocolSkill),
      semanticSkillRef: `sha256:${sha256OfCanonical(semanticSkill)}`,
      semanticSkillDigest: sha256OfCanonical(semanticSkill),
      executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
      executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read', 'plan.write'],
      allowedToolRefs: ['saga-board', 'fs:read'],
      inputProductContracts: [syntheticProductContractRef('accepted-ac-input-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('work-plan-output-contract.v0')],
      evidenceObligations: ['obligation:presentCandidates'],
      completionCommandSchemaRef: `sha256:${sha256OfCanonical(completionCommandSchema)}`,
      completionCommandSchemaDigest: sha256OfCanonical(completionCommandSchema),
      trackerProjectionProfileRef: `sha256:${sha256OfCanonical(trackerProjectionProfile)}`,
      trackerProjectionProfileDigest: sha256OfCanonical(trackerProjectionProfile),
      promptBudgetProfileRef: `sha256:${sha256OfCanonical(promptBudgetProfile)}`,
      promptBudgetProfileDigest: sha256OfCanonical(promptBudgetProfile),
    },
    artifacts: {
      semanticProfileArtifact,
      protocolSkill,
      semanticSkill,
      executorRoutePolicyTable,
      completionCommandSchema,
      trackerProjectionProfile,
      promptBudgetProfile,
    },
  };
}
