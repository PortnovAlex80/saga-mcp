/**
 * workflow-kernel/roles/fixtures/implementer.ts - the synthetic VALID
 * canonical role contract of the implementer semantic profile (WP-17
 * fixture). Bound to the development implementation-cell author launch
 * kind (development.implementation.author): cell material production.
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

export const implementerLaunchKind = 'development.implementation.author';

/** Builds the compile input: manifest row + content + referenced artifacts. */
export function buildImplementerFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(implementerLaunchKind);
  if (binding === undefined) {
    throw new Error(`implementer fixture: launch kind ${implementerLaunchKind} is outside the installed manifest`);
  }

  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'implementer',
    definitionSummary: 'Produces cell material against pinned product contracts.',
  };
  const protocolSkill = syntheticSkill(
    'synthetic-protocol-implementer',
    'Synthetic cognition-only execution-protocol instructions for the implementer profile.',
  );
  const semanticSkill = syntheticSkill(
    'synthetic-semantic-implementer',
    'Synthetic cognition-only implementer-profile semantic instructions (cell material production).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.development-implementation-author',
    implementerLaunchKind,
    'synthetic-model-build',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('contributionRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.development-implementation-author',
    'Development implementer',
    'in-progress',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('implementer');

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
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read', 'material.write'],
      allowedToolRefs: ['saga-board', 'fs:read', 'fs:write'],
      inputProductContracts: [syntheticProductContractRef('work-plan-input-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('cell-material-output-contract.v0')],
      evidenceObligations: ['obligation:submitContribution'],
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
