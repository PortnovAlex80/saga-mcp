/**
 * workflow-kernel/roles/resolver.ts - the ONE consumer port of compiled
 * role contracts (WP-17).
 *
 * Resolution law (plan "Canonical role contract"):
 *   - WorkIntent and ActivityAttempt pin the exact role-contract reference
 *     and digest; this module resolves a pin to its contract and NOTHING
 *     ELSE. The pin is the only input it ever sees; the closed installed
 *     set is the only corpus it ever consults.
 *   - Fail-closed on every mismatch: an unknown or malformed content
 *     address and a digest that does not verify are typed refusals. There
 *     is no substitute contract, no second candidate, no relaxed retry.
 *   - The installed set is closed: install refuses a value whose
 *     self-address does not verify and refuses two values that share one
 *     content address.
 *
 * NOTE FOR THE STRUCTURAL TEST: this module deliberately avoids the
 * vocabulary of every banned substitute source; the WP-17 structural
 * test asserts that absence on this file's source text.
 *
 * PURITY: imports only ../domain/* (the pure kernel). No I/O at all.
 */

import { contractDigestOf } from '../domain/digest.js';
import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  TypedRefusal,
} from '../domain/types.js';

/** A closed, verified set of compiled contracts keyed by content address. */
export interface InstalledRoleContracts {
  readonly count: number;
  readonly byRef: ReadonlyMap<string, CanonicalRoleContract>;
}

export type InstallOutcome =
  | { readonly installed: true; readonly set: InstalledRoleContracts }
  | TypedRefusal;

export type RoleContractResolution =
  | { readonly resolved: true; readonly contract: CanonicalRoleContract }
  | TypedRefusal;

const CONTENT_ADDRESS_PATTERN = /^sha256:[0-9a-f]{64}$/;

function refused(reason: TypedRefusal['reason'], detail: string): TypedRefusal {
  return { refused: true, reason, detail };
}

/** The exact pin a WorkIntent carries for one compiled contract. */
export function roleContractPinOf(contract: CanonicalRoleContract): CanonicalRoleContractReference {
  return { roleContractRef: contract.roleContractRef, roleContractDigest: contract.contractDigest };
}

/**
 * Install compiled contracts as the closed resolution set. Every value's
 * self-address is re-verified (computed slot fingerprint equals the stored
 * digest, and the stored ref equals "sha256:"+digest); two values sharing
 * one content address are refused.
 */
export function installRoleContracts(contracts: readonly CanonicalRoleContract[]): InstallOutcome {
  const byRef = new Map<string, CanonicalRoleContract>();
  for (const contract of contracts) {
    const computed = contractDigestOf(contract);
    if (computed !== contract.contractDigest) {
      return refused(
        'ROLE_CONTRACT_DIGEST_MISMATCH',
        `install: stored digest ${contract.contractDigest} does not equal the computed slot fingerprint ${computed}`,
      );
    }
    if (contract.roleContractRef !== `sha256:${computed}`) {
      return refused(
        'ROLE_CONTRACT_REF_MISMATCH',
        `install: stored ref ${contract.roleContractRef} does not equal the derived content address sha256:${computed}`,
      );
    }
    const existing = byRef.get(contract.roleContractRef);
    if (existing !== undefined) {
      return refused(
        'UNIVERSE_VIOLATION',
        `install: two installed values share the content address ${contract.roleContractRef} (zero duplicate binding)`,
      );
    }
    byRef.set(contract.roleContractRef, contract);
  }
  return { installed: true, set: { count: byRef.size, byRef } };
}

/**
 * The ONE resolution path: a pinned reference/digest pair resolves to its
 * contract or the resolution is refused. The pin is the only input; the
 * closed installed set is the only corpus.
 */
export function resolveRoleContract(
  set: InstalledRoleContracts,
  pin: CanonicalRoleContractReference,
): RoleContractResolution {
  if (!CONTENT_ADDRESS_PATTERN.test(pin.roleContractRef)) {
    return refused(
      'ROLE_CONTRACT_REF_MISMATCH',
      `resolve: pinned ref ${JSON.stringify(pin.roleContractRef)} is not a content address (sha256 + 64 lowercase hex)`,
    );
  }
  const stored = set.byRef.get(pin.roleContractRef);
  if (stored === undefined) {
    return refused(
      'ROLE_CONTRACT_REF_MISMATCH',
      `resolve: pinned ref ${pin.roleContractRef} is outside the closed installed set`,
    );
  }
  const computed = contractDigestOf(stored);
  if (computed !== pin.roleContractDigest || stored.contractDigest !== computed) {
    return refused(
      'ROLE_CONTRACT_DIGEST_MISMATCH',
      `resolve: pinned digest ${pin.roleContractDigest} does not verify against the stored contract (computed ${computed})`,
    );
  }
  if (stored.roleContractRef !== pin.roleContractRef) {
    return refused(
      'ROLE_CONTRACT_REF_MISMATCH',
      `resolve: stored ref ${stored.roleContractRef} drifted from the pinned ${pin.roleContractRef}`,
    );
  }
  return { resolved: true, contract: stored };
}
