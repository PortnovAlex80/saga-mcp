/**
 * workflow-kernel/roles/fixtures/reviewer.ts - the synthetic VALID canonical
 * role contract of the reviewer semantic profile (WP-17 fixture). Bound to
 * the development implementation-cell reviewer launch kind
 * (development.implementation.reviewer): the Workplace author/reviewer
 * loop's gate side.
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

export const reviewerLaunchKind = 'development.implementation.reviewer';

/** Builds the compile input: manifest row + content + referenced artifacts. */
export function buildReviewerFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(reviewerLaunchKind);
  if (binding === undefined) {
    throw new Error(`reviewer fixture: launch kind ${reviewerLaunchKind} is outside the installed manifest`);
  }

  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'reviewer',
    definitionSummary: 'Gates produced material against the pinned acceptance contracts.',
  };
  const protocolSkill = syntheticSkill(
    'synthetic-protocol-reviewer',
    'Synthetic cognition-only execution-protocol instructions for the reviewer profile.',
  );
  const semanticSkill = syntheticSkill(
    'synthetic-semantic-reviewer',
    'Synthetic cognition-only reviewer-profile semantic instructions (gate evaluation).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.development-implementation-reviewer',
    reviewerLaunchKind,
    'synthetic-model-review',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('gateVerdictRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.development-implementation-reviewer',
    'Development reviewer',
    'review',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('reviewer');

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
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read'],
      allowedToolRefs: ['saga-board', 'fs:read'],
      inputProductContracts: [syntheticProductContractRef('cell-material-input-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('gate-decision-output-contract.v0')],
      evidenceObligations: ['obligation:runGate.author'],
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
