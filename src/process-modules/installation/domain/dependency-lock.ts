/**
 * W2-A3 — DependencyLock: immutable lock document over a manifest's references.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 * §1 row 6 + §4 digest/identity rules.
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A3-installer-dependency-lock.md`.
 *
 * A `DependencyLock` is the immutable, content-addressed bill-of-materials for
 * one `ProcessModuleManifest`: every `ContractRef`, `HandlerRef`, and
 * `ResourceIndexEntry` the manifest declares is projected into a flat list of
 * `DependencyLockEntry` rows, each carrying the digest sourced from the
 * manifest field. The lock's own `lockDigest` is `sha256Hex(canonicalJson(entries))`,
 * so any drift in any referenced digest changes the lock digest — making
 * tampering or accidental drift detectable at replay time.
 *
 * This module is PURE (plan §3.16, Rule 5). It imports only:
 *   - sibling Wave 1 SPI types (`ContractRef`, `HandlerRef`, `ResourceIndexEntry`,
 *     `ProcessModuleManifest`) — type-only;
 *   - the frozen canonical primitives (`canonicalJson`, `sha256Hex`) from
 *     `shared/canonical-json.ts`.
 * No filesystem, no database, no application/persistence/composition imports.
 *
 * Wave 2 does NOT resolve against a live `ContractSchemaRegistry`. Placeholder
 * digests equal to {@link PENDING_LOCK_DIGEST} (`'pending@wave-2'`) are accepted
 * and flagged via {@link DependencyLockOptions.flagPendingDigests} (default
 * true); real resolution arrives in Wave 3+ (spec §1 row 6 anti-scope).
 */

import type { ContractRef } from '../../domain/spi/contract-ref.js';
import type { ProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

/**
 * Placeholder digest Wave 2 callers carry when they have no real content hash
 * yet. Matches the Wave 1 sentinel used by `ContractRef`, `HandlerRef`, and
 * `ResourceIndexEntry` (`CONTRACT_REF_PENDING_DIGEST` / `LEGACY_CONTRACT_DIGEST`
 * / `PENDING_DIGEST`). The lock accepts it but flags it so Wave 3+ can find
 * every unresolved reference by scanning `DependencyLock.entries`.
 */
export const PENDING_LOCK_DIGEST = 'pending@wave-2';

/**
 * Kind of reference a {@link DependencyLockEntry} points at. Mirrors the three
 * manifest field families iterated by {@link computeDependencyLock}.
 */
export type DependencyLockRefKind = 'contract' | 'handler' | 'resource';

/**
 * A single row in the dependency lock: a stable logical id, the kind of
 * reference it is, an optional version (contracts + handlers carry one;
 * resources do not), and the content digest sourced from the manifest field.
 *
 * `digest` may be the literal {@link PENDING_LOCK_DIGEST} sentinel during Wave
 * 2; Wave 3+ replaces every pending entry with a real content hash.
 */
export interface DependencyLockEntry {
  readonly refKind: DependencyLockRefKind;
  readonly logicalId: string;
  readonly version?: string;
  readonly digest: string;
}

/**
 * The immutable lock document. `entries` is sorted in a deterministic order
 * (see {@link computeDependencyLock}) so `canonicalJson(entries)` is stable
 * across runs and `lockDigest` is reproducible.
 *
 * `lockDigest = sha256Hex(canonicalJson(entries))`.
 */
export interface DependencyLock {
  readonly entries: readonly DependencyLockEntry[];
  readonly lockDigest: string;
}

/**
 * Options for {@link computeDependencyLock}.
 */
export interface DependencyLockOptions {
  /**
   * When true (default), entries whose `digest` equals
   * {@link PENDING_LOCK_DIGEST} are kept as-is; callers can find them by
   * filtering `lock.entries` on `digest === PENDING_LOCK_DIGEST`. This flag is
   * accepted for forward compatibility with Wave 3 resolution and to let a
   * future caller reject pending digests outright by passing `false`.
   *
   * When `false`, a pending digest anywhere in the manifest causes
   * `computeDependencyLock` to throw {@link PendingDigestError}.
   */
  readonly flagPendingDigests?: boolean;
}

/**
 * Error thrown when {@link DependencyLockOptions.flagPendingDigests} is `false`
 * and a manifest reference carries {@link PENDING_LOCK_DIGEST}. Lists every
 * offending entry so the caller can report them.
 */
export class PendingDigestError extends Error {
  readonly entries: readonly DependencyLockEntry[];
  constructor(entries: readonly DependencyLockEntry[]) {
    const rendered = entries
      .map((e) => `  ${e.refKind} ${e.logicalId}${e.version ? `@${e.version}` : ''}`)
      .join('\n');
    super(
      `dependency lock contains ${entries.length} pending digest(s):\n${rendered}`,
    );
    this.name = 'PendingDigestError';
    this.entries = entries;
  }
}

/**
 * Project a `ContractRef` into a lock entry. `schemaId` is the logical id;
 * `version` and `digest` come from the ref.
 */
function contractEntry(
  role: string,
  ref: ContractRef,
): DependencyLockEntry {
  return {
    refKind: 'contract',
    // Disambiguate input vs output by role prefix so two contract refs that
    // happen to share a schemaId (input and output of the same schema) do not
    // collide. The role is fixed (`input` / `output`), keeping the entry set
    // deterministic.
    logicalId: `${role}:${ref.schemaId}`,
    version: ref.version,
    digest: ref.digest,
  };
}

/**
 * Compare two entries for the deterministic sort. Order: refKind alpha
 * (contract, handler, resource), then logicalId, then version (absent first).
 * Produces a total order for any two distinct entries; equal entries (which
 * cannot occur for a valid manifest — logicalIds are unique per family and the
 * role prefix disambiguates the two contract refs) compare as 0.
 */
function compareEntries(a: DependencyLockEntry, b: DependencyLockEntry): number {
  if (a.refKind !== b.refKind) {
    return a.refKind < b.refKind ? -1 : 1;
  }
  if (a.logicalId !== b.logicalId) {
    return a.logicalId < b.logicalId ? -1 : 1;
  }
  const va = a.version ?? '';
  const vb = b.version ?? '';
  if (va !== vb) {
    return va < vb ? -1 : 1;
  }
  return 0;
}

/**
 * Compute the immutable {@link DependencyLock} for a manifest.
 *
 * Iterates the manifest's:
 *   - `inputContractRef`  → one `'contract'` entry (role `input`);
 *   - `outputContractRef` → one `'contract'` entry (role `output`);
 *   - `handlerRefs`       → one `'handler'` entry per `HandlerRef`;
 *   - `resourceIndex`     → one `'resource'` entry per `ResourceIndexEntry`.
 *
 * Each entry's `digest` is sourced verbatim from the manifest field
 * (`ContractRef.digest`, `HandlerRef.digest`, `ResourceIndexEntry.digest`). The
 * entry list is sorted deterministically (refKind, then logicalId, then
 * version) so `lockDigest = sha256Hex(canonicalJson(entries))` is stable across
 * runs and across Node versions.
 *
 * Wave 2 accepts placeholder digests equal to {@link PENDING_LOCK_DIGEST} by
 * default. Pass `{ flagPendingDigests: false }` to reject them with
 * {@link PendingDigestError} (Wave 3+ resolution path).
 *
 * @param manifest the manifest to lock.
 * @param opts     see {@link DependencyLockOptions}.
 * @returns the immutable lock document.
 * @throws {PendingDigestError} when `opts.flagPendingDigests === false` and any
 *         referenced digest equals {@link PENDING_LOCK_DIGEST}.
 */
export function computeDependencyLock(
  manifest: ProcessModuleManifest,
  opts?: DependencyLockOptions,
): DependencyLock {
  const flagPending = opts?.flagPendingDigests ?? true;

  const entries: DependencyLockEntry[] = [];

  // Contracts: input + output. Role-prefixed logicalIds keep them distinct.
  entries.push(contractEntry('input', manifest.inputContractRef));
  entries.push(contractEntry('output', manifest.outputContractRef));

  // Handlers.
  for (const h of manifest.handlerRefs) {
    entries.push({
      refKind: 'handler',
      logicalId: h.logicalId,
      version: h.version,
      digest: h.digest,
    });
  }

  // Resources. ResourceIndexEntry has no version field.
  for (const r of manifest.resourceIndex) {
    entries.push({
      refKind: 'resource',
      logicalId: r.logicalId,
      digest: r.digest,
    });
  }

  // Deterministic order so the digest is reproducible.
  entries.sort(compareEntries);

  if (!flagPending) {
    const pending = entries.filter((e) => e.digest === PENDING_LOCK_DIGEST);
    if (pending.length > 0) {
      throw new PendingDigestError(pending);
    }
  }

  const lockDigest = sha256Hex(canonicalJson(entries));
  return { entries, lockDigest };
}
