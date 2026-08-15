/**
 * W2-A2 — Pure value types for an immutable Process Module installation.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 * §1 row 4, §3, §4. Task: `docs/refactor-management/05-subagent-tasks/W02-A2-installation-repository-sql-owner.md`.
 *
 * A `ModuleInstallationRecord` is the SINGLE SOURCE OF TRUTH for "what is
 * installed". It is created by the Wave 2 installer (W2-A3) once the manifest
 * has been validated, resources resolved, the dependency lock computed, the
 * package digest computed, and the bytes durably stored; the record is then
 * persisted by `SqliteModuleInstallationRepository` and activated. After
 * activation its `(name, version)` is UNIQUE among active installations — a
 * second active installation under the same `(name, version)` with a DIFFERENT
 * `packageDigest` is REJECTED (`MODULE_INSTALLATION_VERSION_COLLISION`, spec §4).
 *
 * Installations are deletion-restricted (plan §5.5.9): the repository exposes
 * NO delete method. An installation that must be withdrawn is `retire`-d
 * (status transition `active` → `retired`), which releases the unique-active
 * slot but preserves the row for replay verification.
 *
 * This module is PURE DATA ONLY (plan §3.5). Every field is canonically
 * serializable. The only import is the Wave 1 SPI barrel (domain → domain,
 * Rule 5 clean): the record *carries* a `ProcessModuleManifest` snapshot and
 * `ResourceIndexEntry[]` / `HandlerRef[]` copies; it never validates them.
 */

// Wave 1 SPI barrel — pure manifest + resource-index types.
// Rule 5 clean: domain → domain (sibling subtree under domain/spi/).
import type {
  ProcessModuleManifest,
  ResourceIndexEntry,
  HandlerRef,
} from '../../domain/spi/index.js';

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/**
 * Database-assigned primary key of a `factory_module_installations` row.
 *
 * Branded so that a bare `number` cannot be silently passed where an
 * installation id is expected (and vice-versa). The brand is erased at the
 * runtime boundary (SQLite returns a plain number); the persistence adapter
 * casts via `as ModuleInstallationId`.
 *
 * Branded number (not string) because the column is `INTEGER PRIMARY KEY`.
 */
export type ModuleInstallationId = number & { readonly __brand: 'ModuleInstallationId' };

/** Brand a plain (SQLite-returned) number as a `ModuleInstallationId`. */
export function asModuleInstallationId(id: number): ModuleInstallationId {
  return id as ModuleInstallationId;
}

// ---------------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of an installation record (spec §3 column definition).
 *
 * - `'staged'`     — row inserted; bytes stored; NOT yet validated/activated.
 * - `'validated'`  — manifest + dependency lock validated; ready to activate.
 * - `'active'`     — the unique-active slot for `(name, version)` is held.
 *                    The partial UNIQUE index
 *                    `idx_factory_module_installations_active`
 *                    enforces that at most ONE row per `(name, version)`
 *                    carries this status — version immutability (spec §4).
 * - `'retired'`    — withdrawn from the active slot. Row preserved for replay
 *                    verification (deletion-restricted, plan §5.5.9).
 * - `'corrupt'`    — replay verification re-hashed stored bytes and found a
 *                    mismatch (spec §4, §5.5.7). The installation MUST NOT be
 *                    selected for new runs.
 */
export type ModuleInstallationStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'retired'
  | 'corrupt';

/** Frozen set of accepted statuses (mirrors the SQL CHECK intent). */
export const MODULE_INSTALLATION_STATUSES: readonly ModuleInstallationStatus[] = Object.freeze([
  'staged',
  'validated',
  'active',
  'retired',
  'corrupt',
]);

// ---------------------------------------------------------------------------
// Record.
// ---------------------------------------------------------------------------

/**
 * The canonical, persisted description of an installed Process Module package.
 * Pure readonly data — the single source of truth for "what is installed".
 *
 * @property id                Database primary key (branded).
 * @property name              Module identity name (`manifest.definition.identity.name`).
 *                             Stored denormalized for the UNIQUE-active index.
 * @property version           Module identity version
 *                             (`manifest.definition.identity.version`).
 *                             Stored denormalized for the UNIQUE-active index.
 * @property packageDigest     `sha256Hex` of canonical
 *                             `{ manifest, resourceIndex, resourceDigests }`
 *                             (computed by W2-A3). Identity of the stored
 *                             bytes; replay verification re-hashes and
 *                             compares (spec §4).
 * @property manifestSnapshot  Canonical JSON snapshot of the
 *                             {@link ProcessModuleManifest} at install time.
 *                             Frozen: the manifest the package was installed
 *                             under, never the live module definition.
 * @property storeLocation     Content-addressed path returned by the package
 *                             store (W2-A1). Points at the immutable byte
 *                             bundle; replay reads from here.
 * @property resourceIndex     Snapshot of the manifest's
 *                             `resourceIndex` (resource logicalIds + digests).
 * @property handlerRefs       Snapshot of the manifest's `handlerRefs`.
 * @property dependencyLock    Immutable dependency-lock document (W2-A3):
 *                             every `ContractRef` / `HandlerRef` /
 *                             `ResourceIndexEntry` resolved to a digest.
 *                             Opaque to this layer — stored as canonical JSON.
 * @property status            Lifecycle status (see {@link ModuleInstallationStatus}).
 * @property installedAt       ISO timestamp — row insert time.
 * @property activatedAt       ISO timestamp — first transition to `active`,
 *                             or `undefined` while staged/validated/corrupt.
 * @property retiredAt         ISO timestamp — transition to `retired`, or
 *                             `undefined` while not retired.
 */
export interface ModuleInstallationRecord {
  readonly id: ModuleInstallationId;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly manifestSnapshot: ProcessModuleManifest;
  readonly storeLocation: string;
  readonly resourceIndex: readonly ResourceIndexEntry[];
  readonly handlerRefs: readonly HandlerRef[];
  readonly dependencyLock: unknown;
  readonly status: ModuleInstallationStatus;
  readonly installedAt: string;
  readonly activatedAt?: string;
  readonly retiredAt?: string;
}

// ---------------------------------------------------------------------------
// Error codes (spec §4, §5.5.7, §5.5.8).
// ---------------------------------------------------------------------------

/**
 * Attempt to insert (or activate) a second `status='active'` installation for
 * the same `(name, version)` with a DIFFERENT `packageDigest`. Released
 * package identity is immutable (spec §4). Development MUST use a prerelease
 * version (`0.0.0-dev.<build>`) or explicit build identity (plan §5.5.8).
 */
export const MODULE_INSTALLATION_VERSION_COLLISION = 'MODULE_INSTALLATION_VERSION_COLLISION';

/**
 * No installation row matched the supplied id / digest /
 * `(name, version)` selector.
 */
export const MODULE_INSTALLATION_NOT_FOUND = 'MODULE_INSTALLATION_NOT_FOUND';

/**
 * Replay verification re-hashed the stored bytes and the result did NOT match
 * `packageDigest` (spec §4, §5.5.7). The installation is corrupt and MUST NOT
 * be selected for new runs; its status is flipped to `'corrupt'`.
 */
export const MODULE_INSTALLATION_CORRUPT = 'MODULE_INSTALLATION_CORRUPT';
