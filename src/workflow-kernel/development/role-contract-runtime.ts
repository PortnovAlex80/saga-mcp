/**
 * workflow-kernel/development/role-contract-runtime.ts - the ONE resolution
 * of the frozen CanonicalRoleContract at WorkIntent creation (WP-08, plan
 * phase EK-5; ADR-053 / FWD:F007).
 *
 * Laws implemented here:
 *   - The CanonicalRoleContract is resolved EXACTLY ONCE per launch kind at
 *     WorkIntent creation (workplace.admitWorkIntent). Every later consumer
 *     - dispatcher, runner, prompt builder and tracker - receives the SAME
 *     frozen reference/digest pair (object identity), never a second
 *     resolution, never a reclassification.
 *   - The resolution path is the WP-17 resolver (installRoleContracts +
 *     resolveRoleContract): the pin is the only input, the closed installed
 *     set is the only corpus, fail-closed on every mismatch. This module
 *     adds no second resolution path.
 *   - Semantic profiles (planner/implementer/reviewer/certifier) select a
 *     content-addressed launch slot ONLY; they can never appear as a kernel
 *     protocol role (mutation k). Reclassification attempts are typed
 *     refusals.
 *   - The pin an ActivityAttempt copies is the SAME object the WorkIntent
 *     pinned (mutation i/j fences live in the kernel guards; this runtime
 *     supplies the one identity they compare against).
 *
 * PURITY: imports only the pure kernel (domain + roles resolver). No I/O.
 */

import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  ProtocolRole,
  TypedRefusal,
} from '../domain/types.js';
import { installRoleContracts, resolveRoleContract } from '../roles/resolver.js';
import type { InstalledRoleContracts } from '../roles/resolver.js';

/** An opaque resolved slot token (consumers never see a raw contract). */
export interface ResolvedRoleSlot {
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly contract: CanonicalRoleContract;
  /** THE pin: one frozen object shared by every view (identity-stable). */
  readonly pin: CanonicalRoleContractReference;
}

/**
 * The view every downstream consumer receives. Four named constructors over
 * the SAME slot; all views carry the identical `pin` object.
 */
export interface RolePinView {
  readonly consumer: 'dispatcher' | 'runner' | 'prompt-builder' | 'tracker';
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly roleContractRef: string;
  readonly roleContractDigest: string;
  /** Identity-stable: `dispatcherView(s).pin === runnerView(s).pin` etc. */
  readonly pin: CanonicalRoleContractReference;
}

export type RoleResolution =
  | { readonly resolved: true; readonly slot: ResolvedRoleSlot }
  | TypedRefusal;

export type RoleReclassification =
  | { readonly reclassified: false; readonly detail: string }
  | TypedRefusal;

/**
 * The one runtime. Construct once per run with the compiled contracts of the
 * installed workshop manifest bound to their launch kinds; resolve each
 * launch kind at most once.
 */
export class RoleContractRuntime {
  private readonly installed: InstalledRoleContracts;
  private readonly byLaunchKind = new Map<string, CanonicalRoleContract>();
  private readonly slots = new Map<string, ResolvedRoleSlot>();
  private resolutions = 0;

  constructor(bindings: readonly LaunchKindBinding[]) {
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

  /** How many times the resolver actually ran (must stay 1 per launch kind). */
  get resolutionCount(): number {
    return this.resolutions;
  }

  /** True once the launch kind has been resolved (cached views need no re-resolution). */
  isResolved(launchKind: string): boolean {
    return this.slots.has(launchKind);
  }

  /**
   * Resolve the frozen contract of one launch kind ONCE. Subsequent calls
   * return the cached slot WITHOUT touching the resolver (the counter stays
   * at one per kind). Unknown launch kinds and pin drift are typed refusals.
   */
  resolveOnce(launchKind: string): RoleResolution {
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
    // The single resolution: the derived pin resolves through the WP-17
    // resolver (digest verification inside). Counter increments exactly here.
    const resolution = resolveRoleContract(this.installed, {
      roleContractRef: `sha256:${contract.contractDigest}`,
      roleContractDigest: contract.contractDigest,
    });
    if ('refused' in resolution) {
      return resolution;
    }
    this.resolutions += 1;
    const slot: ResolvedRoleSlot = {
      launchKind,
      protocolRole: contract.protocolRole,
      contract: resolution.contract,
      pin: Object.freeze({ roleContractRef: resolution.contract.roleContractRef, roleContractDigest: resolution.contract.contractDigest }),
    };
    this.slots.set(launchKind, slot);
    return { resolved: true, slot };
  }

  /**
   * Reclassification is refused: a semantic profile or role name can never
   * re-key a resolved slot. The slot's protocol role is immutable for the
   * WorkIntent's lifetime.
   */
  reclassify(_slot: ResolvedRoleSlot, requestedRole: string): RoleReclassification {
    if ((SEMANTIC_PROFILE_NAMES as readonly string[]).includes(requestedRole)) {
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

  dispatcherView(slot: ResolvedRoleSlot): RolePinView {
    return viewOf(slot, 'dispatcher');
  }

  runnerView(slot: ResolvedRoleSlot): RolePinView {
    return viewOf(slot, 'runner');
  }

  promptBuilderView(slot: ResolvedRoleSlot): RolePinView {
    return viewOf(slot, 'prompt-builder');
  }

  trackerView(slot: ResolvedRoleSlot): RolePinView {
    return viewOf(slot, 'tracker');
  }

  /**
   * Slot lookup by launch kind for already-resolved slots only (consumers
   * that rehydrate from durable facts never trigger a fresh resolution).
   */
  slotOf(launchKind: string): ResolvedRoleSlot | undefined {
    return this.slots.get(launchKind);
  }
}

/** One installed launch-kind -> compiled contract binding. */
export interface LaunchKindBinding {
  readonly launchKind: string;
  readonly contract: CanonicalRoleContract;
}

/** The four semantic profiles (never kernel roles - mutation k). */
const SEMANTIC_PROFILE_NAMES = ['planner', 'implementer', 'reviewer', 'certifier'] as const;

function viewOf(slot: ResolvedRoleSlot, consumer: RolePinView['consumer']): RolePinView {
  return Object.freeze({
    consumer,
    launchKind: slot.launchKind,
    protocolRole: slot.protocolRole,
    roleContractRef: slot.pin.roleContractRef,
    roleContractDigest: slot.pin.roleContractDigest,
    pin: slot.pin,
  });
}
