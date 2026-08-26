/**
 * workflow-kernel/workshops/formalization/roles.ts - the CanonicalRoleContract
 * bindings of the Formalization workshop (WP-11F, plan phase EK-8 workshop
 * conversion; ADR-053 / FWD:F007).
 *
 * Laws implemented here:
 *   - The workshop binds EXACTLY the two launch kinds the FROZEN
 *     role-contract manifest admits for this workshop:
 *     formalization.implementation.author and
 *     formalization.implementation.reviewer. Exact role-universe equality:
 *     every binding's protocol role is author or reviewer (the kernel
 *     universe's closed set); planner/implementer/reviewer/certifier are
 *     semantic profiles and can never appear as kernel roles (mutation k).
 *   - ONE resolution path: the WP-17 resolver (installRoleContracts +
 *     resolveRoleContract) is the only compilation/resolution authority.
 *     Each launch kind resolves EXACTLY ONCE; every later consumer -
 *     dispatcher, runner, prompt builder, tracker - receives the SAME
 *     frozen pin object, never a second resolution, never a
 *     reclassification.
 *   - The pin a WorkIntent/ActivityAttempt copies is the SAME object this
 *     runtime resolved (the kernel guards enforce the copy; this module
 *     supplies the one identity they compare against).
 *
 * PURITY: imports only the pure kernel (domain + the WP-17 roles package).
 */

import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  ProtocolRole,
  TypedRefusal,
} from '../../domain/types.js';
import { sha256OfCanonical } from '../../domain/digest.js';
import { installRoleContracts, resolveRoleContract } from '../../roles/resolver.js';
import type { InstalledRoleContracts } from '../../roles/resolver.js';
import { manifestBindingByLaunchKind } from '../../roles/compiler.js';
import type { CompileRoleContractInput } from '../../roles/compiler.js';
import type { SemanticProfileArtifact } from '../../roles/shapes.js';
import {
  syntheticCompletionCommandSchema,
  syntheticProductContractRef,
  syntheticPromptBudgetStandIn,
  syntheticRouteTable,
  syntheticSkill,
  syntheticTrackerProfile,
} from '../../roles/fixtures/support.js';

/** The workshop's author launch kind (the frozen manifest binding row). */
export const FORMALIZATION_AUTHOR_LAUNCH_KIND = 'formalization.implementation.author';
/** The workshop's reviewer launch kind (the frozen manifest binding row). */
export const FORMALIZATION_REVIEWER_LAUNCH_KIND = 'formalization.implementation.reviewer';

/** The exact kernel protocol-role universe (mutation k fence). */
export const KERNEL_PROTOCOL_ROLE_UNIVERSE: readonly ProtocolRole[] = ['author', 'reviewer'];

/* ------------------------------------------------------------------ */
/* Contract fixture builders (compiled through the ONE compiler)        */
/* ------------------------------------------------------------------ */

/** Builds the compile input of the author contract (implementer profile). */
export function buildFormalizationAuthorFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(FORMALIZATION_AUTHOR_LAUNCH_KIND);
  if (binding === undefined) {
    throw new Error(`formalization roles: launch kind ${FORMALIZATION_AUTHOR_LAUNCH_KIND} is outside the installed manifest`);
  }
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'implementer',
    definitionSummary: 'Produces formalization desk material against pinned product contracts.',
  };
  const protocolSkill = syntheticSkill(
    'synthetic-protocol-formalization-author',
    'Synthetic cognition-only execution-protocol instructions for the formalization author profile.',
  );
  const semanticSkill = syntheticSkill(
    'synthetic-semantic-formalization-author',
    'Synthetic cognition-only formalization author instructions (desk material production).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.formalization-author',
    FORMALIZATION_AUTHOR_LAUNCH_KIND,
    'synthetic-model-author',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('contributionRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.formalization-author',
    'Formalization author',
    'in-progress',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('formalization-author');
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
      allowedToolRefs: ['artifact-create', 'trace-add', 'fs:read', 'fs:write'],
      inputProductContracts: [syntheticProductContractRef('formalization-desk-input-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('formalization-desk-output-contract.v0')],
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

/** Builds the compile input of the reviewer contract (reviewer profile). */
export function buildFormalizationReviewerFixture(): CompileRoleContractInput {
  const binding = manifestBindingByLaunchKind(FORMALIZATION_REVIEWER_LAUNCH_KIND);
  if (binding === undefined) {
    throw new Error(`formalization roles: launch kind ${FORMALIZATION_REVIEWER_LAUNCH_KIND} is outside the installed manifest`);
  }
  const semanticProfileArtifact: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: 'reviewer',
    definitionSummary: 'Gates formalization desk material against the pinned product contracts.',
  };
  const protocolSkill = syntheticSkill(
    'synthetic-protocol-formalization-reviewer',
    'Synthetic cognition-only execution-protocol instructions for the formalization reviewer profile.',
  );
  const semanticSkill = syntheticSkill(
    'synthetic-semantic-formalization-reviewer',
    'Synthetic cognition-only formalization reviewer instructions (independent semantic review).',
  );
  const executorRoutePolicyTable = syntheticRouteTable(
    'synthetic.route-table.formalization-reviewer',
    FORMALIZATION_REVIEWER_LAUNCH_KIND,
    'synthetic-model-reviewer',
  );
  const completionCommandSchema = syntheticCompletionCommandSchema('verdictRef');
  const trackerProjectionProfile = syntheticTrackerProfile(
    'synthetic.tracker.formalization-reviewer',
    'Formalization reviewer',
    'review',
  );
  const promptBudgetProfile = syntheticPromptBudgetStandIn('formalization-reviewer');
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
      allowedToolRefs: ['candidate-read', 'product-read', 'product-submit'],
      inputProductContracts: [syntheticProductContractRef('formalization-candidate-input-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('formalization-verdict-output-contract.v0')],
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
/* The one runtime (single resolution per launch kind)                 */
/* ------------------------------------------------------------------ */

/** An opaque resolved slot token (consumers never see a raw contract). */
export interface ResolvedFormalizationSlot {
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly contract: CanonicalRoleContract;
  /** THE pin: one frozen object shared by every view (identity-stable). */
  readonly pin: CanonicalRoleContractReference;
}

/** The view every downstream consumer receives (same slot, same pin object). */
export interface FormalizationRolePinView {
  readonly consumer: 'dispatcher' | 'runner' | 'prompt-builder' | 'tracker';
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly roleContractRef: string;
  readonly roleContractDigest: string;
  readonly pin: CanonicalRoleContractReference;
}

export type FormalizationRoleResolution =
  | { readonly resolved: true; readonly slot: ResolvedFormalizationSlot }
  | TypedRefusal;

export type FormalizationReclassification =
  | { readonly reclassified: false; readonly detail: string }
  | TypedRefusal;

/**
 * The formalization role runtime: the ONE resolution of each launch kind's
 * frozen contract (WP-17 resolver underneath; no second resolution path).
 */
export class FormalizationRoleRuntime {
  private readonly installed: InstalledRoleContracts;
  private readonly byLaunchKind = new Map<string, CanonicalRoleContract>();
  private readonly slots = new Map<string, ResolvedFormalizationSlot>();
  private resolutions = 0;

  constructor(bindings: readonly { readonly launchKind: string; readonly contract: CanonicalRoleContract }[]) {
    const outcome = installRoleContracts(bindings.map((binding) => binding.contract));
    if ('refused' in outcome) {
      throw new Error(`FORMALIZATION_ROLE_INSTALL_REFUSED: ${outcome.reason}: ${outcome.detail}`);
    }
    this.installed = outcome.set;
    for (const binding of bindings) {
      const existing = this.byLaunchKind.get(binding.launchKind);
      if (existing !== undefined && existing.roleContractRef !== binding.contract.roleContractRef) {
        throw new Error(`FORMALIZATION_ROLE_INSTALL_REFUSED: launch kind ${binding.launchKind} is bound to two different contracts (zero duplicate binding)`);
      }
      this.byLaunchKind.set(binding.launchKind, binding.contract);
    }
    // Exact role-universe equality at construction: every bound contract's
    // protocol role is inside the kernel's closed two-role universe.
    for (const binding of bindings) {
      if (!KERNEL_PROTOCOL_ROLE_UNIVERSE.includes(binding.contract.protocolRole)) {
        throw new Error(`FORMALIZATION_ROLE_UNIVERSE_VIOLATION: launch kind ${binding.launchKind} binds protocol role ${binding.contract.protocolRole} outside the kernel universe ${KERNEL_PROTOCOL_ROLE_UNIVERSE.join('|')}`);
      }
    }
  }

  /** How many times the resolver actually ran (must stay 1 per launch kind). */
  get resolutionCount(): number {
    return this.resolutions;
  }

  isResolved(launchKind: string): boolean {
    return this.slots.has(launchKind);
  }

  /** Resolve the frozen contract of one launch kind ONCE; later calls return the cached slot. */
  resolveOnce(launchKind: string): FormalizationRoleResolution {
    const cached = this.slots.get(launchKind);
    if (cached !== undefined) {
      return { resolved: true, slot: cached };
    }
    const contract = this.byLaunchKind.get(launchKind);
    if (contract === undefined) {
      return {
        refused: true,
        reason: 'ROLE_CONTRACT_REF_MISMATCH',
        detail: `launch kind ${launchKind} has no compiled contract in the installed set`,
      };
    }
    const resolution = resolveRoleContract(this.installed, {
      roleContractRef: `sha256:${contract.contractDigest}`,
      roleContractDigest: contract.contractDigest,
    });
    if ('refused' in resolution) {
      return resolution;
    }
    this.resolutions += 1;
    const slot: ResolvedFormalizationSlot = {
      launchKind,
      protocolRole: resolution.contract.protocolRole,
      contract: resolution.contract,
      pin: Object.freeze({ roleContractRef: resolution.contract.roleContractRef, roleContractDigest: resolution.contract.contractDigest }),
    };
    this.slots.set(launchKind, slot);
    return { resolved: true, slot };
  }

  /** Reclassification is refused: a semantic profile can never re-key a resolved slot (mutation k). */
  reclassify(_slot: ResolvedFormalizationSlot, requestedRole: string): FormalizationReclassification {
    if (['planner', 'implementer', 'reviewer', 'certifier'].includes(requestedRole)) {
      return {
        refused: true,
        reason: 'PROTOCOL_ROLE_UNIVERSE_VIOLATION',
        detail: `${requestedRole} is a semantic profile, not a kernel protocol role; semantic profiles select a content-addressed slot and can never reclassify one (mutation k)`,
      };
    }
    return {
      refused: true,
      reason: 'ROLE_CONTRACT_REF_MISMATCH',
      detail: 'a resolved launch slot is never re-keyed; open a new launch kind through the installed manifest instead',
    };
  }

  /* The four consumers: same slot, same pin object, no re-resolution. */

  dispatcherView(slot: ResolvedFormalizationSlot): FormalizationRolePinView {
    return viewOf(slot, 'dispatcher');
  }

  runnerView(slot: ResolvedFormalizationSlot): FormalizationRolePinView {
    return viewOf(slot, 'runner');
  }

  promptBuilderView(slot: ResolvedFormalizationSlot): FormalizationRolePinView {
    return viewOf(slot, 'prompt-builder');
  }

  trackerView(slot: ResolvedFormalizationSlot): FormalizationRolePinView {
    return viewOf(slot, 'tracker');
  }

  slotOf(launchKind: string): ResolvedFormalizationSlot | undefined {
    return this.slots.get(launchKind);
  }
}

function viewOf(slot: ResolvedFormalizationSlot, consumer: FormalizationRolePinView['consumer']): FormalizationRolePinView {
  return Object.freeze({
    consumer,
    launchKind: slot.launchKind,
    protocolRole: slot.protocolRole,
    roleContractRef: slot.pin.roleContractRef,
    roleContractDigest: slot.pin.roleContractDigest,
    pin: slot.pin,
  });
}
