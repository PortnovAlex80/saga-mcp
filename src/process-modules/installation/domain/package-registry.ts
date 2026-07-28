/**
 * W2-A5 — `PackageRegistry` PORT + `InstallationBasedPackageRegistry` adapter.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *       §1 row 9, §2 (Ports vs adapters), §4 (identity rules).
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A5-package-registry.md`.
 * Plan: §14.4.1 (registry replaces built-in catalog lookups),
 *       §14.4.5 (NO prefix matching, NO first-match — multiple matches →
 *       highest version, deterministically), §3.6 / C011 (NO module-name
 *       switching — the registry resolves by selector only).
 *
 * This module replaces the in-memory catalog lookup that previously lived
 * inside the composition root (plan §0 reconnaissance note). It is the single
 * Runtime-facing surface for "given a `ModuleSelector`, give me the installed
 * `ModuleInstallationRecord` that satisfies it". Resolution is by selector
 * (name + semver range) — there is no module-name switching, no central
 * catalog of "known" modules, and no first-match policy. When multiple active
 * installations of the same name satisfy a range, the registry returns the
 * one with the highest semver version (deterministic; ties broken by highest
 * installation id).
 *
 * The registry is RUNTIME state (behavioral): a cache/view over the persisted
 * `ModuleInstallationRepository`. The repository is the single source of
 * truth for "what is installed"; the registry is the runtime-facing selector
 * over it. Nothing the registry does is persisted — `registerInstallation`
 * delegates straight to the repository.
 *
 * Dependency-direction ratchet (Rule 5, plan §3.16): this file lives under
 * `installation/domain/` and imports ONLY from sibling `installation/*` (the
 * repository port, defined below for isolation — see INTEGRATION NOTE) and
 * from the Wave 1 pure-SPI barrel (`domain/spi/index.js`). It does NOT import
 * `application/`, `persistence/`, `composition/`, `modules/`, or
 * `infrastructure/`. The sqlite adapter for the repository lives in a sibling
 * `installation/persistence/` file owned by W2-A2 and is injected here.
 *
 * INTEGRATION NOTE (integrator, Wave 2 cherry-pick): the value types
 * `ModuleInstallationId`, `ModuleInstallationStatus`,
 * `ModuleInstallationRecord` and the PORT `ModuleInstallationRepository` are
 * OWNED by W2-A2 (`installation/domain/installation.ts` +
 * `installation/persistence/installation-repository.ts`). In this isolated
 * lane worktree those sibling files are not present, so the shapes are
 * re-declared here for type-safety and so the adapter compiles + tests run.
 * At integration time the integrator removes the local declarations below
 * (search for "W2-A2-OWNED") and imports them from
 * `./installation.js` and `../persistence/installation-repository.js`. The
 * shapes are frozen by WAVE2-IMMUTABLE-INSTALLATION-SPEC §1 row 3 and §4 —
 * they MUST stay byte-compatible with W2-A2's, which is why the field list
 * matches the spec verbatim.
 */

// Wave 1 pure-SPI barrel — `ModuleSelector { name; versionRange }` and the
// manifest/resource types that `ModuleInstallationRecord` carries as opaque
// readonly data. Type-only imports: the registry never constructs a manifest.
import type {
  ModuleSelector,
  ProcessModuleManifest,
  ResourceIndexEntry,
  HandlerRef,
} from '../../domain/spi/index.js';

// ---------------------------------------------------------------------------
// W2-A2-OWNED: value types + repository port.
//
// These declarations are temporary in this isolated worktree. The owning lane
// is W2-A2. At integration time, delete this block and import the symbols
// from `./installation.js` (value types) and
// `../persistence/installation-repository.js` (port). Field shapes are frozen
// by WAVE2-IMMUTABLE-INSTALLATION-SPEC §1 row 3.
// ---------------------------------------------------------------------------

/**
 * Stable identifier for an installed module package. Branded so it cannot be
 * confused with a generic number at the type level. Persisted as the
 * `saga3_module_installations.id` INTEGER PRIMARY KEY.
 */
export type ModuleInstallationId = number & { readonly __brand: 'ModuleInstallationId' };

/**
 * Lifecycle status of an installation. Only `'active'` installations are
 * selectable by the registry. Transitions are owned by
 * `ModuleInstallationRepository` (W2-A2).
 */
export type ModuleInstallationStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'retired'
  | 'corrupt';

/**
 * The persisted, immutable record of an installed module package. Single
 * source of truth for "what is installed" (plan §14.4.1, spec §1 row 3).
 *
 * `(name, version)` is UNIQUE among `status='active'` rows (version
 * immutability, spec §4). Two active records may share a `name` if their
 * `version` differs (the registry picks the highest semver on range match).
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

/**
 * Persistence PORT for module installations (W2-A2 owner). The sqlite adapter
 * lives in `installation/persistence/installation-repository.ts`. The registry
 * depends only on this interface — never on sqlite or `db.ts` (Rule 5).
 *
 * The registry uses `listActive()` to enumerate selectable records and
 * `insert()` for `registerInstallation`. The exact-match method
 * `getActiveByNameVersion` is part of the port surface for other consumers
 * (W2-A4 ProcessRun pinning); the registry does not call it because range
 * resolution needs the full list.
 */
export interface ModuleInstallationRepository {
  insert(record: ModuleInstallationRecord): ModuleInstallationRecord;
  getById(id: ModuleInstallationId): ModuleInstallationRecord | null;
  getByPackageDigest(digest: string): ModuleInstallationRecord | null;
  getActiveByNameVersion(
    name: string,
    version: string,
  ): ModuleInstallationRecord | null;
  activate(id: ModuleInstallationId): ModuleInstallationRecord;
  retire(id: ModuleInstallationId): ModuleInstallationRecord;
  markCorrupt(id: ModuleInstallationId): ModuleInstallationRecord;
  listActive(): readonly ModuleInstallationRecord[];
}

// ---------------------------------------------------------------------------
// PackageRegistry PORT.
// ---------------------------------------------------------------------------

/**
 * Error code raised when no active installation matches a selector. Matches
 * the W2-A2 error-code naming convention (`MODULE_INSTALLATION_*`) but uses
 * the registry's own surface name (`PACKAGE_NOT_INSTALLED`) per spec §1 row 9.
 */
export const PACKAGE_NOT_INSTALLED = 'PACKAGE_NOT_INSTALLED';

/**
 * Thrown by `PackageRegistry.select` / `selectOrThrow` when no active
 * installation matches the given selector. Carries the selector verbatim so
 * callers can build a precise diagnostic without re-stringifying.
 */
export class PackageNotInstalledError extends Error {
  readonly code: typeof PACKAGE_NOT_INSTALLED = PACKAGE_NOT_INSTALLED;
  readonly selector: ModuleSelector;
  constructor(selector: ModuleSelector) {
    super(
      `${PACKAGE_NOT_INSTALLED}: no active installation matches ` +
        `name=${JSON.stringify(selector.name)} ` +
        `versionRange=${JSON.stringify(selector.versionRange)}`,
    );
    this.name = 'PackageNotInstalledError';
    this.selector = selector;
    // Restore prototype chain across the ES5/ES6 boundary (TS target ES2022
    // extends Error; this keeps `instanceof` correct when the class is
    // re-thrown across module boundaries).
    Object.setPrototypeOf(this, PackageNotInstalledError.prototype);
  }
}

/**
 * Runtime-facing PORT for resolving a `ModuleSelector` (name + semver range)
 * to the concrete `ModuleInstallationRecord` that satisfies it.
 *
 * The registry is RUNTIME state (a cache/view). It does not own installation
 * identity — `ModuleInstallationRepository` does. The registry only selects.
 *
 * Plan §14.4.1, §14.4.5: NO module-name switching, NO first-match policy,
 * NO prefix matching. When multiple active installations of the same name
 * satisfy a range, the implementation MUST return the highest semver version
 * deterministically.
 */
export interface PackageRegistry {
  /**
   * Resolve `selector` to a single active installation. Throws
   * {@link PackageNotInstalledError} (code {@link PACKAGE_NOT_INSTALLED}) if
   * no active installation matches the name + range.
   *
   * Determinism: when multiple active installations of `selector.name`
   * satisfy `selector.versionRange`, returns the one with the highest semver
   * version. Ties (same version — impossible under the repo's UNIQUE index
   * but defended against) are broken by highest installation id.
   */
  select(selector: ModuleSelector): ModuleInstallationRecord;

  /**
   * Persist a new installation via the backing repository. Delegates straight
   * to `ModuleInstallationRepository.insert`. The repository enforces the
   * UNIQUE-on-active `(name, version)` invariant; the registry trusts it.
   */
  registerInstallation(record: ModuleInstallationRecord): void;

  /**
   * Snapshot of every active installation currently selectable, expressed as
   * the (name, exact-version) selector pair. Order is whatever the backing
   * repository yields (the registry does not re-sort). Useful for diagnostics
   * and "what can I select right now?" enumeration. The returned array is a
   * frozen copy — callers cannot mutate registry state through it.
   */
  listSelectors(): readonly ModuleSelector[];

  /**
   * Predicate form of {@link select}: returns `true` iff at least one active
   * installation matches the selector. Never throws
   * {@link PackageNotInstalledError}.
   */
  has(selector: ModuleSelector): boolean;
}

// ---------------------------------------------------------------------------
// Inline semver matcher (~30 lines, NO dependency — plan §14.4.5).
//
// Supported syntaxes (frozen by the task file):
//   - `*` (or empty string)        — matches any version
//   - exact `x.y.z`                — exact equality (e.g. `1.0.0`)
//   - `^x.y.z` (caret)             — compatible-with: same major; npm's
//                                    `0.x` and `0.0.x` tightening applies
//                                    (a `^0.2.3` only matches `0.2.x >= 0.2.3`;
//                                    a `^0.0.3` only matches exactly `0.0.3`)
//   - `~x.y.z` (tilde)             — approximately equivalent: same
//                                    major.minor, patch >= base
//
// Explicitly NOT supported (plan §14.4.5 — NO prefix matching):
//   - `1.x`, `1.2.x`, `>=1.0.0`, ranges, OR-ranges (`||`), hyphen ranges.
// A range that does not match one of the four shapes above either matches
// exactly (if it parses as `x.y.z`) or matches nothing.
// ---------------------------------------------------------------------------

type Semver = readonly [number, number, number];
const ZERO: Semver = [-1, -1, -1] as const;

/** Parse `"x.y.z"` (digits only) into a triple. Returns null on malformed input. */
function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Total order on parsed semvers. >0 if a>b, <0 if a<b, 0 if equal. */
function compareSemver(a: Semver, b: Semver): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * Does `version` satisfy `range`? See the syntax table above. The matcher is
 * pure (no globals, no allocations beyond the parsed triples). Returns false
 * for any `version` or `range` that does not parse — the registry then treats
 * the selector as matching nothing and raises `PACKAGE_NOT_INSTALLED`.
 */
function satisfiesRange(version: string, range: string): boolean {
  // Every selector — even `*` — requires the installed version to be a
  // parseable `x.y.z`. The registry trusts the repo to store only valid
  // semver; a record whose version doesn't parse is treated as unselectable
  // (defense in depth: its identity is suspect). This keeps `select` from
  // ever returning a record whose version the matcher cannot rank, which
  // would break the highest-version determinism invariant.
  const v = parseSemver(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '' || r === '*') return true;
  if (r.startsWith('^')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (compareSemver(v, base) < 0) return false;
    const [major, minor] = base;
    if (major > 0) return v[0] === major;
    if (minor > 0) return v[0] === 0 && v[1] === minor;
    return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  if (r.startsWith('~')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (compareSemver(v, base) < 0) return false;
    return v[0] === base[0] && v[1] === base[1];
  }
  const baseExact = parseSemver(r);
  return baseExact !== null && compareSemver(v, baseExact) === 0;
}

// ---------------------------------------------------------------------------
// InstallationBasedPackageRegistry — default adapter.
// ---------------------------------------------------------------------------

/**
 * Default `PackageRegistry` adapter backed by a `ModuleInstallationRepository`
 * (spec §2: port ← adapter). The repository is the single source of truth;
 * this adapter is the runtime selector over it.
 *
 * Construction: `new InstallationBasedPackageRegistry(repo)`. The repository
 * is injected so Wave 13 can swap sqlite for an in-memory fake or a remote
 * store without touching this file (plan §4.3, §4.4).
 *
 * Lifecycle: the registry does NOT cache installations across calls — every
 * `select` re-queries `repo.listActive()` so the registry reflects the latest
 * activate/retire transitions. The repo is expected to be cheap to query
 * (sqlite UNIQUE-indexed). If this ever becomes hot, the registry can add a
 * generation-tagged cache — but Wave 2 keeps it stateless.
 */
export class InstallationBasedPackageRegistry implements PackageRegistry {
  private readonly repo: ModuleInstallationRepository;

  constructor(repo: ModuleInstallationRepository) {
    this.repo = repo;
  }

  /** @inheritdoc */
  select(selector: ModuleSelector): ModuleInstallationRecord {
    const rec = this.selectOrNull(selector);
    if (rec === null) {
      throw new PackageNotInstalledError(selector);
    }
    return rec;
  }

  /** @inheritdoc */
  registerInstallation(record: ModuleInstallationRecord): void {
    // Pure delegation. The repository enforces UNIQUE on
    // `(name, version, status='active')`; the registry trusts that invariant
    // (spec §4). A second active row with the same `(name, version)` but a
    // different `packageDigest` is rejected by the repo as
    // `MODULE_INSTALLATION_VERSION_COLLISION`.
    this.repo.insert(record);
  }

  /** @inheritdoc */
  listSelectors(): readonly ModuleSelector[] {
    return this.repo.listActive().map((rec) => ({
      name: rec.name,
      // Exact version of the installed record. `ModuleSelector.versionRange`
      // is a semver RANGE; the exact installed version is the tightest
      // possible range and the one that round-trips back through `select`.
      versionRange: rec.version,
    }));
  }

  /** @inheritdoc */
  has(selector: ModuleSelector): boolean {
    return this.selectOrNull(selector) !== null;
  }

  /**
   * Internal: same as {@link select} but returns `null` instead of throwing.
   * Used by both `select` and `has` so there is exactly one resolution path.
   */
  private selectOrNull(selector: ModuleSelector): ModuleInstallationRecord | null {
    const range = selector.versionRange;
    // Single pass: filter active records by name AND range, track the best.
    // Determinism: highest semver wins; ties broken by highest id (most
    // recently inserted). The repo's UNIQUE index makes same-(name,version)
    // collisions impossible at runtime — the id tiebreak is belt-and-braces.
    let best: ModuleInstallationRecord | null = null;
    let bestSemver: Semver = ZERO;
    for (const rec of this.repo.listActive()) {
      if (rec.name !== selector.name) continue;
      if (!satisfiesRange(rec.version, range)) continue;
      const recSemver = parseSemver(rec.version) ?? ZERO;
      if (
        best === null ||
        compareSemver(recSemver, bestSemver) > 0 ||
        (compareSemver(recSemver, bestSemver) === 0 && rec.id > best.id)
      ) {
        best = rec;
        bestSemver = recSemver;
      }
    }
    return best;
  }
}
