/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * roles.ts - the ROLE BINDING of the derive-system-requirements Production
 * Cell (FRF-WP05) through the WP-17 pattern.
 *
 * WP-17 law (EK plan WP-17 + the workshop roles.ts convention):
 *   - ONE resolution path: the compiler (compileRoleContract) + the
 *     resolver (installRoleContracts + resolveRoleContract) are the only
 *     compilation/resolution authorities. Each launch kind resolves
 *     EXACTLY ONCE; every later consumer receives the SAME frozen pin
 *     object.
 *   - The Cell binds EXACTLY the two launch kinds the FROZEN
 *     role-contract manifest admits for this workshop
 *     (formalization.implementation.author /
 *     formalization.implementation.reviewer - manifestBindingByLaunchKind,
 *     never an invented launch kind).
 *   - The semantic-skill artifacts pinned by the Cell's contracts are the
 *     desk skill of THIS cell (./skill.ts), so the author and reviewer
 *     cognition both run the derive-system-requirements instructions.
 *   - The runtime wrapper is the workshop's FormalizationRoleRuntime (the
 *     one installed WP-17 consumer port) - this module compiles and
 *     installs; it never opens a second resolution path.
 *
 * PURITY: imports only the pure kernel (domain + roles package) and the
 * workshop's installed role runtime. No I/O, no session, no SQL.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import { manifestBindingByLaunchKind } from '../../../../roles/compiler.js';
import type { CompileRoleContractInput } from '../../../../roles/compiler.js';
import type { SemanticProfileArtifact } from '../../../../roles/shapes.js';
import {
  syntheticCompletionCommandSchema,
  syntheticProductContractRef,
  syntheticPromptBudgetStandIn,
  syntheticRouteTable,
  syntheticTrackerProfile,
} from '../../../../roles/fixtures/support.js';
import { compileRoleContract } from '../../../../roles/compiler.js';
import {
  FORMALIZATION_AUTHOR_LAUNCH_KIND,
  FORMALIZATION_REVIEWER_LAUNCH_KIND,
  FormalizationRoleRuntime,
  KERNEL_PROTOCOL_ROLE_UNIVERSE,
} from '../../roles.js';
import {
  REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  SYSTEM_REQUIREMENTS_PRODUCT_KIND,
  UPSTREAM_PRD_CONTRACT_KIND,
  UPSTREAM_UC_CONTRACT_KIND,
} from './contract.js';
import {
  SYSTEM_REQUIREMENTS_SKILL_ARTIFACT,
  SYSTEM_REQUIREMENTS_DESK_SKILL_ID,
} from './skill.js';

/* ------------------------------------------------------------------ */
/* The desk-scoped compile inputs (through the ONE compiler)           */
/* ------------------------------------------------------------------ */

/** Builds the compile input of the cell's author contract (implementer profile). */
export function buildSystemRequirementsAuthorFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(FORMALIZATION_AUTHOR_LAUNCH_KIND);
  if (binding === undefined) {
    throw new Error(`system-requirements roles: launch kind ${FORMALIZATION_AUTHOR_LAUNCH_KIND} is outside the installed manifest`);
  }
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'implementer',
    definitionSummary: 'Authors the FR/NFR/RULE requirements bundle of the derive-system-requirements desk against exact accepted PRD/UC material.',
  };
  const protocolSkill = {
    schemaVersion: 'ek.skill-artifact.ek1.v1' as const,
    skillId: `${SYSTEM_REQUIREMENTS_DESK_SKILL_ID}-protocol`,
    instructions: 'Execution-protocol instructions for the derive-system-requirements author: claim the desk, read the supplied accepted surfaces, author the bundle, submit for review.',
  };
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.system-requirements-author',
    FORMALIZATION_AUTHOR_LAUNCH_KIND,
    'synthetic-model-author',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('contributionRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.system-requirements-author',
    'System-requirements author',
    'in-progress',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('system-requirements-author');
  return {
    binding,
    content: {
      schemaVersion: 'ek.canonical-role-contract.ek1.v1',
      protocolRole: binding.protocolRole,
      semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfileArtifact)}`,
      protocolSkillRef: `sha256:${sha256OfCanonical(protocolSkill)}`,
      protocolSkillDigest: sha256OfCanonical(protocolSkill),
      semanticSkillRef: `sha256:${sha256OfCanonical(SYSTEM_REQUIREMENTS_SKILL_ARTIFACT)}`,
      semanticSkillDigest: sha256OfCanonical(SYSTEM_REQUIREMENTS_SKILL_ARTIFACT),
      executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
      executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read', 'material.write'],
      allowedToolRefs: ['artifact-create', 'trace-add', 'fs:read', 'fs:write'],
      inputProductContracts: [
        syntheticProductContractRef(UPSTREAM_PRD_CONTRACT_KIND),
        syntheticProductContractRef(UPSTREAM_UC_CONTRACT_KIND),
      ],
      outputProductContracts: [
        syntheticProductContractRef(REQUIREMENTS_BUNDLE_CONTRACT_KIND),
        syntheticProductContractRef(SYSTEM_REQUIREMENTS_PRODUCT_KIND),
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
      semanticSkill: SYSTEM_REQUIREMENTS_SKILL_ARTIFACT,
      executorRoutePolicyTable,
      completionCommandSchema,
      trackerProjectionProfile,
      promptBudgetProfile,
    },
  };
}

/** Builds the compile input of the cell's reviewer contract (reviewer profile). */
export function buildSystemRequirementsReviewerFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(FORMALIZATION_REVIEWER_LAUNCH_KIND);
  if (binding === undefined) {
    throw new Error(`system-requirements roles: launch kind ${FORMALIZATION_REVIEWER_LAUNCH_KIND} is outside the installed manifest`);
  }
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'reviewer',
    definitionSummary: 'Reviews the FR/NFR/RULE requirements bundle of the derive-system-requirements desk: accept/repair routed by the typed derivation-law findings.',
  };
  const protocolSkill = {
    schemaVersion: 'ek.skill-artifact.ek1.v1' as const,
    skillId: `${SYSTEM_REQUIREMENTS_DESK_SKILL_ID}-protocol`,
    instructions: 'Execution-protocol instructions for the derive-system-requirements reviewer: read the candidate, run the desk review route, submit the verdict.',
  };
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.system-requirements-reviewer',
    FORMALIZATION_REVIEWER_LAUNCH_KIND,
    'synthetic-model-reviewer',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('verdictRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.system-requirements-reviewer',
    'System-requirements reviewer',
    'review',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('system-requirements-reviewer');
  return {
    binding,
    content: {
      schemaVersion: 'ek.canonical-role-contract.ek1.v1',
      protocolRole: binding.protocolRole,
      semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfileArtifact)}`,
      protocolSkillRef: `sha256:${sha256OfCanonical(protocolSkill)}`,
      protocolSkillDigest: sha256OfCanonical(protocolSkill),
      semanticSkillRef: `sha256:${sha256OfCanonical(SYSTEM_REQUIREMENTS_SKILL_ARTIFACT)}`,
      semanticSkillDigest: sha256OfCanonical(SYSTEM_REQUIREMENTS_SKILL_ARTIFACT),
      executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
      executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read'],
      allowedToolRefs: ['candidate-read', 'product-read', 'product-submit'],
      inputProductContracts: [
        syntheticProductContractRef(REQUIREMENTS_BUNDLE_CONTRACT_KIND),
        syntheticProductContractRef(SYSTEM_REQUIREMENTS_PRODUCT_KIND),
      ],
      outputProductContracts: [syntheticProductContractRef('system-requirements-review-verdict.v0')],
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
      semanticSkill: SYSTEM_REQUIREMENTS_SKILL_ARTIFACT,
      executorRoutePolicyTable,
      completionCommandSchema,
      trackerProjectionProfile,
      promptBudgetProfile,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The one install (single resolution per launch kind)                 */
/* ------------------------------------------------------------------ */

export interface SystemRequirementsRoleInstall {
  readonly runtime: FormalizationRoleRuntime;
  readonly authorLaunchKind: typeof FORMALIZATION_AUTHOR_LAUNCH_KIND;
  readonly reviewerLaunchKind: typeof FORMALIZATION_REVIEWER_LAUNCH_KIND;
}

/**
 * Compile and install the Cell's two role contracts through the ONE
 * compiler/resolver pair (the WP-17 pattern). The returned runtime is the
 * workshop's installed FormalizationRoleRuntime: each launch kind
 * resolves exactly once through resolveOnce; consumers share the frozen
 * pin objects. Throws typed on any compile/install refusal (fail-closed:
 * a half-installed role set is never handed out).
 */
export function installSystemRequirementsRoles(): SystemRequirementsRoleInstall {
  const author = compileRoleContract(buildSystemRequirementsAuthorFixture());
  if (!author.compiled) {
    throw new Error(`SYSTEM_REQUIREMENTS_ROLE_COMPILE_REFUSED (author): ${author.errors.join('; ')}`);
  }
  const reviewer = compileRoleContract(buildSystemRequirementsReviewerFixture());
  if (!reviewer.compiled) {
    throw new Error(`SYSTEM_REQUIREMENTS_ROLE_COMPILE_REFUSED (reviewer): ${reviewer.errors.join('; ')}`);
  }
  for (const contract of [author.contract, reviewer.contract]) {
    if (!KERNEL_PROTOCOL_ROLE_UNIVERSE.includes(contract.protocolRole)) {
      throw new Error(`SYSTEM_REQUIREMENTS_ROLE_UNIVERSE_VIOLATION: protocol role ${contract.protocolRole} is outside the kernel universe ${KERNEL_PROTOCOL_ROLE_UNIVERSE.join('|')}`);
    }
  }
  const runtime = new FormalizationRoleRuntime([
    { launchKind: FORMALIZATION_AUTHOR_LAUNCH_KIND, contract: author.contract },
    { launchKind: FORMALIZATION_REVIEWER_LAUNCH_KIND, contract: reviewer.contract },
  ]);
  return {
    runtime,
    authorLaunchKind: FORMALIZATION_AUTHOR_LAUNCH_KIND,
    reviewerLaunchKind: FORMALIZATION_REVIEWER_LAUNCH_KIND,
  };
}
