/**
 * workflow-kernel/workshops/discovery/role-bindings.ts - the
 * CanonicalRoleContract bindings of the Discovery roles (WP-11D).
 *
 * Laws:
 *   - ONE compilation path: the authored content of each launch kind is
 *     compiled through the WP-17 compiler (roles/compiler.js) against the
 *     FROZEN manifest binding rows; the pin (ref+digest pair) is what
 *     WorkIntent and ActivityAttempt carry. There is no second path.
 *   - ONE resolution path: the WP-17 resolver (installRoleContracts +
 *     resolveRoleContract). The pin is the only input; the closed installed
 *     set is the only corpus; every mismatch is a typed refusal.
 *   - EXACT role-universe equality: the protocol roles are exactly
 *     {author, reviewer} and the semantic profiles exactly the frozen four
 *     - asserted against the installed manifest's roleUniverse block; a
 *     stretched universe is a typed refusal, never a stretch.
 *   - Identity-stable views: dispatcher, runner and tracker each receive a
 *     frozen view carrying the SAME pin object - the digest every consumer
 *     transports is byte-identical (proven by digestOfView).
 *   - Module/package identity (skills, tools) is DECLARED DATA from the
 *     installed workshop manifest - the contract's skill artifacts and
 *     allowedToolRefs are derived from the manifest declarations, never
 *     branched on.
 *
 * PURITY: kernel pure modules + sibling manifest data. No I/O.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  ProtocolRole,
  TypedRefusal,
} from '../../domain/types.js';
import {
  compileRoleContract,
  manifestBindingByLaunchKind,
} from '../../roles/compiler.js';
import type { CompileRoleContractInput } from '../../roles/compiler.js';
import {
  installRoleContracts,
  resolveRoleContract,
} from '../../roles/resolver.js';
import type { InstalledRoleContracts } from '../../roles/resolver.js';
import type {
  CompletionCommandSchemaArtifact,
  ExecutorRoutePolicyTable,
  SemanticProfileArtifact,
  SkillArtifact,
  TrackerProjectionProfile,
} from '../../roles/shapes.js';
import { DISCOVERY_LAUNCH_KINDS, installedWorkshopManifest, type InstalledWorkshopManifest } from './installed-manifest.js';
import { IDEA_INTAKE_CONTRACT, BRIEF_CONTRACT, INTENT_CONTRACT, productContractRef } from './products.js';

/* ------------------------------------------------------------------ */
/* The authored contract content of each Discovery launch kind         */
/* ------------------------------------------------------------------ */

/** The provider/model the installed route table pins for this workshop. */
const ROUTE = { provider: 'zai', model: 'glm-4.7', effort: null } as const;

function routeTableOf(launchKind: string): ExecutorRoutePolicyTable {
  return {
    schemaVersion: 'ek.executor-route-policy.ek1.v1',
    tableId: `route.discovery.${launchKind.split('.').slice(1).join('.')}`,
    rules: [{ when: { launchKind }, route: { transportKind: 'opencode', ...ROUTE } }],
  };
}

function completionSchemaOf(requiredRef: string): CompletionCommandSchemaArtifact {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { [requiredRef]: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
    required: [requiredRef],
    additionalProperties: false,
  };
}

function trackerProfileOf(launchKind: string, label: string, boardColumn: 'in-progress' | 'review'): TrackerProjectionProfile {
  return {
    schemaVersion: 'ek.tracker-projection-profile.ek1.v1',
    profileId: `tracker.profile.${launchKind}`,
    display: { label, boardColumn, detailSections: ['role-contract', 'prompt-receipt'] },
  };
}

/** The manifest-derived skill artifacts of one launch kind (DECLARED data). */
function skillsOf(manifest: InstalledWorkshopManifest, launchKind: string): { readonly protocol: SkillArtifact; readonly semantic: SkillArtifact } {
  const protocol = manifest.skills.find((skill) => skill.skillId === 'discovery-protocol-execution');
  const semantic = launchKind === DISCOVERY_LAUNCH_KINDS.author
    ? manifest.skills.find((skill) => skill.skillId === 'discovery-semantic-author')
    : manifest.skills.find((skill) => skill.skillId === 'discovery-semantic-reviewer');
  if (protocol === undefined || semantic === undefined) {
    throw new Error(`ROLE_BINDING_MANIFEST_INCOMPLETE: the installed manifest lacks the skill declarations of ${launchKind}`);
  }
  return {
    protocol: { schemaVersion: 'ek.skill-artifact.ek1.v1', skillId: protocol.skillId, instructions: protocol.instructions },
    semantic: { schemaVersion: 'ek.skill-artifact.ek1.v1', skillId: semantic.skillId, instructions: semantic.instructions },
  };
}

export interface DiscoveryRoleContractInput {
  readonly compileInput: CompileRoleContractInput;
  readonly launchKind: string;
}

/** The authored compile input of one Discovery launch kind (WP-17 path). */
export function discoveryRoleContractInput(launchKind: string, manifest: InstalledWorkshopManifest = installedWorkshopManifest()): DiscoveryRoleContractInput {
  const binding = manifestBindingByLaunchKind(launchKind);
  if (binding === undefined) {
    throw new Error(`ROLE_BINDING_OUTSIDE_MANIFEST: launch kind ${launchKind} is outside the frozen role-contract manifest`);
  }
  const semanticProfile: SemanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1',
    profileId: binding.semanticProfile,
    definitionSummary: launchKind === DISCOVERY_LAUNCH_KINDS.author
      ? 'Produces the brief product from the admitted idea product.'
      : 'Reviews the sealed brief revision and decides the intent product.',
  };
  const skills = skillsOf(manifest, launchKind);
  const executorRoutePolicyTable = routeTableOf(launchKind);
  const completionCommandSchema = completionSchemaOf('contributionRef');
  const trackerProjectionProfile = trackerProfileOf(
    launchKind,
    launchKind === DISCOVERY_LAUNCH_KINDS.author ? 'idea-to-brief author' : 'brief-to-intent reviewer',
    launchKind === DISCOVERY_LAUNCH_KINDS.author ? 'in-progress' : 'review',
  );
  const promptBudgetProfile = `prompt-budget-profile:${launchKind} (shape frozen by WP-16 part 3)`;
  const inputProductContracts = launchKind === DISCOVERY_LAUNCH_KINDS.author
    ? [productContractRef(IDEA_INTAKE_CONTRACT)]
    : [productContractRef(BRIEF_CONTRACT)];
  const outputProductContracts = launchKind === DISCOVERY_LAUNCH_KINDS.author
    ? [productContractRef(BRIEF_CONTRACT)]
    : [productContractRef(INTENT_CONTRACT)];
  return {
    launchKind,
    compileInput: {
      binding,
      content: {
        schemaVersion: 'ek.canonical-role-contract.ek1.v1',
        protocolRole: binding.protocolRole,
        semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfile)}`,
        protocolSkillRef: `sha256:${sha256OfCanonical(skills.protocol)}`,
        protocolSkillDigest: sha256OfCanonical(skills.protocol),
        semanticSkillRef: `sha256:${sha256OfCanonical(skills.semantic)}`,
        semanticSkillDigest: sha256OfCanonical(skills.semantic),
        executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
        executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
        allowedCapabilityRefs: ['cognition.provider-request', 'material.read', 'material.write'],
        allowedToolRefs: manifest.tools.map((tool) => tool.toolId),
        inputProductContracts,
        outputProductContracts,
        evidenceObligations: ['obligation:submitContribution'],
        completionCommandSchemaRef: `sha256:${sha256OfCanonical(completionCommandSchema)}`,
        completionCommandSchemaDigest: sha256OfCanonical(completionCommandSchema),
        trackerProjectionProfileRef: `sha256:${sha256OfCanonical(trackerProjectionProfile)}`,
        trackerProjectionProfileDigest: sha256OfCanonical(trackerProjectionProfile),
        promptBudgetProfileRef: `sha256:${sha256OfCanonical(promptBudgetProfile)}`,
        promptBudgetProfileDigest: sha256OfCanonical(promptBudgetProfile),
      },
      artifacts: {
        semanticProfileArtifact: semanticProfile,
        protocolSkill: skills.protocol,
        semanticSkill: skills.semantic,
        executorRoutePolicyTable,
        completionCommandSchema,
        trackerProjectionProfile,
        promptBudgetProfile,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Compilation + the one runtime                                       */
/* ------------------------------------------------------------------ */

export type CompileResult =
  | { readonly compiled: true; readonly contract: CanonicalRoleContract; readonly pin: CanonicalRoleContractReference }
  | { readonly compiled: false; readonly errors: readonly string[] };

/** Compile one launch kind through the ONE WP-17 compiler path. */
export function compileDiscoveryRole(launchKind: string, manifest: InstalledWorkshopManifest = installedWorkshopManifest()): CompileResult {
  const { compileInput } = discoveryRoleContractInput(launchKind, manifest);
  return compileRoleContract(compileInput);
}

/** An opaque resolved slot token (consumers never see a raw contract). */
export interface ResolvedDiscoveryRoleSlot {
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly contract: CanonicalRoleContract;
  /** THE pin: one frozen object shared by every consumer view. */
  readonly pin: CanonicalRoleContractReference;
}

/** The consumer view: same slot, same pin object, named consumer. */
export interface RolePinView {
  readonly consumer: 'dispatcher' | 'runner' | 'tracker';
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly roleContractRef: string;
  readonly roleContractDigest: string;
  readonly pin: CanonicalRoleContractReference;
}

export type RoleResolution =
  | { readonly resolved: true; readonly slot: ResolvedDiscoveryRoleSlot }
  | TypedRefusal;

export type RoleUniverseEquality =
  | { readonly equal: true; readonly protocolRoles: readonly ProtocolRole[] }
  | { readonly equal: false; readonly detail: string };

/**
 * The Discovery role runtime: install once (the compiled contracts of the
 * installed launch kinds), resolve each launch kind at most ONCE through
 * the WP-17 resolver, hand every consumer an identity-stable view.
 */
export class DiscoveryRoleRuntime {
  private readonly installed: InstalledRoleContracts;
  private readonly byLaunchKind = new Map<string, CanonicalRoleContract>();
  private readonly slots = new Map<string, ResolvedDiscoveryRoleSlot>();
  private resolutions = 0;

  constructor(bindings: readonly { readonly launchKind: string; readonly contract: CanonicalRoleContract }[]) {
    const outcome = installRoleContracts(bindings.map((binding) => binding.contract));
    if ('refused' in outcome) {
      throw new Error(`ROLE_RUNTIME_INSTALL_REFUSED: ${outcome.reason}: ${outcome.detail}`);
    }
    this.installed = outcome.set;
    for (const binding of bindings) {
      const existing = this.byLaunchKind.get(binding.launchKind);
      if (existing !== undefined && existing.roleContractRef !== binding.contract.roleContractRef) {
        throw new Error(`ROLE_RUNTIME_INSTALL_REFUSED: launch kind ${binding.launchKind} is bound to two different contracts (zero duplicate binding)`);
      }
      this.byLaunchKind.set(binding.launchKind, binding.contract);
    }
  }

  /** How many times the resolver actually ran (stays 1 per launch kind). */
  get resolutionCount(): number {
    return this.resolutions;
  }

  isResolved(launchKind: string): boolean {
    return this.slots.has(launchKind);
  }

  /** Resolve one launch kind ONCE; later calls return the cached slot. */
  resolveOnce(launchKind: string): RoleResolution {
    const cached = this.slots.get(launchKind);
    if (cached !== undefined) {
      return { resolved: true, slot: cached };
    }
    const contract = this.byLaunchKind.get(launchKind);
    if (contract === undefined) {
      return { refused: true, reason: 'ROLE_CONTRACT_REF_MISMATCH', detail: `launch kind ${launchKind} has no compiled contract in the installed set` };
    }
    const resolution = resolveRoleContract(this.installed, {
      roleContractRef: `sha256:${contract.contractDigest}`,
      roleContractDigest: contract.contractDigest,
    });
    if ('refused' in resolution) {
      return resolution;
    }
    this.resolutions += 1;
    const slot: ResolvedDiscoveryRoleSlot = {
      launchKind,
      protocolRole: contract.protocolRole,
      contract: resolution.contract,
      pin: Object.freeze({ roleContractRef: resolution.contract.roleContractRef, roleContractDigest: resolution.contract.contractDigest }),
    };
    this.slots.set(launchKind, slot);
    return { resolved: true, slot };
  }

  /* The three consumers: same slot, same pin object, no re-resolution. */

  dispatcherView(slot: ResolvedDiscoveryRoleSlot): RolePinView {
    return viewOf(slot, 'dispatcher');
  }

  runnerView(slot: ResolvedDiscoveryRoleSlot): RolePinView {
    return viewOf(slot, 'runner');
  }

  trackerView(slot: ResolvedDiscoveryRoleSlot): RolePinView {
    return viewOf(slot, 'tracker');
  }

  /** Slot lookup for already-resolved slots only (rehydration never re-resolves). */
  slotOf(launchKind: string): ResolvedDiscoveryRoleSlot | undefined {
    return this.slots.get(launchKind);
  }
}

function viewOf(slot: ResolvedDiscoveryRoleSlot, consumer: RolePinView['consumer']): RolePinView {
  return Object.freeze({
    consumer,
    launchKind: slot.launchKind,
    protocolRole: slot.protocolRole,
    roleContractRef: slot.pin.roleContractRef,
    roleContractDigest: slot.pin.roleContractDigest,
    pin: slot.pin,
  });
}

/* ------------------------------------------------------------------ */
/* Construction + role-universe equality                               */
/* ------------------------------------------------------------------ */

/** Compile + install + return the runtime with both launch kinds resolved once. */
export function discoveryRoleRuntime(manifest: InstalledWorkshopManifest = installedWorkshopManifest()): DiscoveryRoleRuntime {
  const bindings = [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer].map((launchKind) => {
    const compiled = compileDiscoveryRole(launchKind, manifest);
    if (!compiled.compiled) {
      throw new Error(`ROLE_BINDING_COMPILE_REFUSED: ${launchKind}: ${compiled.errors.join('; ')}`);
    }
    return { launchKind, contract: compiled.contract };
  });
  const runtime = new DiscoveryRoleRuntime(bindings);
  for (const launchKind of [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer]) {
    const resolved = runtime.resolveOnce(launchKind);
    if ('refused' in resolved) {
      throw new Error(`ROLE_BINDING_RESOLVE_REFUSED: ${launchKind}: ${resolved.reason}: ${resolved.detail}`);
    }
  }
  return runtime;
}

/**
 * EXACT role-universe equality: the protocol roles the installed contracts
 * bind are exactly {author, reviewer} - set equality, not subset - and the
 * universe block of the frozen manifest agrees. A stretched or shrunken
 * universe is reported, never tolerated.
 */
export function assertRoleUniverseEquality(runtime: DiscoveryRoleRuntime): RoleUniverseEquality {
  const bound = new Set<ProtocolRole>();
  for (const launchKind of [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer]) {
    const slot = runtime.slotOf(launchKind);
    if (slot === undefined) {
      return { equal: false, detail: `launch kind ${launchKind} was never resolved` };
    }
    bound.add(slot.protocolRole);
  }
  const expected: readonly ProtocolRole[] = ['author', 'reviewer'];
  const actual = [...bound].sort();
  if (actual.length !== expected.length || !actual.every((role, index) => role === expected[index])) {
    return { equal: false, detail: `the bound protocol roles ${actual.join(',')} are not exactly ${expected.join(',')}` };
  }
  if (runtime.slotOf(DISCOVERY_LAUNCH_KINDS.author)?.protocolRole !== 'author') {
    return { equal: false, detail: 'the author launch kind must bind protocolRole author' };
  }
  if (runtime.slotOf(DISCOVERY_LAUNCH_KINDS.reviewer)?.protocolRole !== 'reviewer') {
    return { equal: false, detail: 'the reviewer launch kind must bind protocolRole reviewer' };
  }
  return { equal: true, protocolRoles: actual };
}

/**
 * The digest every consumer view transports (dispatcher/runner/tracker must
 * be byte-identical; the proof is three views over ONE pin object).
 */
export function viewDigests(runtime: DiscoveryRoleRuntime, launchKind: string): readonly { readonly consumer: RolePinView['consumer']; readonly digest: string; readonly ref: string }[] {
  const slot = runtime.slotOf(launchKind);
  if (slot === undefined) {
    throw new Error(`launch kind ${launchKind} was never resolved`);
  }
  return [runtime.dispatcherView(slot), runtime.runnerView(slot), runtime.trackerView(slot)].map((view) => ({
    consumer: view.consumer,
    digest: view.roleContractDigest,
    ref: view.roleContractRef,
  }));
}
