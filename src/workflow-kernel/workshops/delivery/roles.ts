/**
 * workflow-kernel/workshops/delivery/roles.ts - the CanonicalRoleContract
 * bindings of the release cell (WP-11L, plan phase EK-8).
 *
 * CANONICALROLECONTRACT BINDINGS + ONE RESOLUTION PATH (assignment point 7):
 * the two launch kinds of this workshop bind compiled canonical contracts
 * built against the FROZEN role-contract manifest rows (never hand-pinned
 * digests), and resolution goes through the ONE runtime the kernel already
 * owns - development/role-contract-runtime.ts RoleContractRuntime - so the
 * WorkIntent, the ActivityAttempt and every consumer view share the SAME
 * frozen pin object. This module adds no second resolution path and no
 * re-classification surface (semantic profiles select slots only).
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { CompileRoleContractInput } from '../../roles/compiler.js';
import { compileRoleContract } from '../../roles/compiler.js';
import type { SemanticProfileArtifact } from '../../roles/shapes.js';
import {
  syntheticCompletionCommandSchema,
  syntheticProductContractRef,
  syntheticPromptBudgetStandIn,
  syntheticRouteTable,
  syntheticSkill,
  syntheticTrackerProfile,
} from '../../roles/fixtures/support.js';
import { RoleContractRuntime } from '../../development/role-contract-runtime.js';
import {
  DELIVERY_AUTHOR_LAUNCH_KIND,
  DELIVERY_REVIEWER_LAUNCH_KIND,
  DELIVERY_INPUT_PRODUCT_CONTRACT,
  DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT,
  DELIVERY_OUTPUT_RELEASE_RECORD_CONTRACT,
  deliveryBinding,
} from './manifest.js';

/* ------------------------------------------------------------------ */
/* The compiled fixtures of the two launch kinds                       */
/* ------------------------------------------------------------------ */

/** Build the compile input of one release-cell launch kind (author side). */
export function buildReleaseAuthorFixture(): CompileRoleContractInput {
  const binding = deliveryBinding(DELIVERY_AUTHOR_LAUNCH_KIND);
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'implementer',
    definitionSummary: 'Produces local release packaging material against the verified bundle.',
  };
  const protocolSkill = syntheticSkill(
    'delivery-protocol-release',
    'Synthetic cognition-only execution-protocol instructions for the release cell author.',
  );
  const semanticSkill = syntheticSkill(
    'delivery-semantic-packaging',
    'Synthetic cognition-only packaging semantics for the release cell author (local assembly, digests, release record).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.delivery-implementation-author',
    DELIVERY_AUTHOR_LAUNCH_KIND,
    'synthetic-model-release',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('contributionRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.delivery-implementation-author',
    'Release author',
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
      inputProductContracts: [syntheticProductContractRef(DELIVERY_INPUT_PRODUCT_CONTRACT)],
      outputProductContracts: [
        syntheticProductContractRef(DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT),
        syntheticProductContractRef(DELIVERY_OUTPUT_RELEASE_RECORD_CONTRACT),
      ],
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

/** Build the compile input of the release-cell reviewer launch kind. */
export function buildReleaseReviewerFixture(): CompileRoleContractInput {
  const binding = deliveryBinding(DELIVERY_REVIEWER_LAUNCH_KIND);
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'reviewer',
    definitionSummary: 'Reviews local release packaging against the verified bundle.',
  };
  const protocolSkill = syntheticSkill(
    'delivery-protocol-release-review',
    'Synthetic cognition-only execution-protocol instructions for the release cell reviewer.',
  );
  const semanticSkill = syntheticSkill(
    'delivery-semantic-release-review',
    'Synthetic cognition-only review semantics for the release cell (preflight + packaging verdict).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.delivery-implementation-reviewer',
    DELIVERY_REVIEWER_LAUNCH_KIND,
    'synthetic-model-release-review',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('verdictRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.delivery-implementation-reviewer',
    'Release reviewer',
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
      inputProductContracts: [syntheticProductContractRef(DELIVERY_INPUT_PRODUCT_CONTRACT)],
      outputProductContracts: [syntheticProductContractRef(DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT)],
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

/* ------------------------------------------------------------------ */
/* The ONE resolution runtime over the two bindings                    */
/* ------------------------------------------------------------------ */

export interface DeliveryRoleRuntime {
  /** The ONE runtime (resolution happens exactly once per launch kind). */
  readonly runtime: InstanceType<typeof RoleContractRuntime>;
  readonly authorLaunchKind: typeof DELIVERY_AUTHOR_LAUNCH_KIND;
  readonly reviewerLaunchKind: typeof DELIVERY_REVIEWER_LAUNCH_KIND;
}

/**
 * Compile both contracts and install them in the ONE RoleContractRuntime.
 * Compilation is fail-closed: a contract that does not compile aborts the
 * workshop composition (never a silent fallback to a hand pin).
 */
export function deliveryRoleRuntime(): DeliveryRoleRuntime {
  const author = compileRoleContract(buildReleaseAuthorFixture());
  const reviewer = compileRoleContract(buildReleaseReviewerFixture());
  if (!author.compiled || !reviewer.compiled) {
    throw new Error(`DELIVERY_ROLES: fixture contracts failed to compile: ${JSON.stringify([author, reviewer])}`);
  }
  const runtime = new RoleContractRuntime([
    { launchKind: DELIVERY_AUTHOR_LAUNCH_KIND, contract: author.contract },
    { launchKind: DELIVERY_REVIEWER_LAUNCH_KIND, contract: reviewer.contract },
  ]);
  return { runtime, authorLaunchKind: DELIVERY_AUTHOR_LAUNCH_KIND, reviewerLaunchKind: DELIVERY_REVIEWER_LAUNCH_KIND };
}
