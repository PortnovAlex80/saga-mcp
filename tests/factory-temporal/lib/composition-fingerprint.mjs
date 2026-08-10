// tests/factory-temporal/lib/composition-fingerprint.mjs
//
// Stable composition fingerprint for ADR-048 temporal conformance tests.
//
// Detects production/test composition drift by hashing sections of the Factory
// production pipeline composition:
//   1. lifecycle identity  — read from the REAL productBuildLifecycle definition
//   2. installed modules    — each manifest's packageDigest after installProductionModules
//   3. trusted providers    — trusted_providers rows (category, determinism)
//   4. executor kinds       — nodeExecutors Map keys (sourced from runtime, with count ratchet)
//   5. check-provider cats  — trusted_providers.category enum (sourced from types.ts)
//
// Section hashes are joined and hashed once more to form the final fingerprint.
// A drift in ANY section changes exactly one section hash, which changes the
// final fingerprint — giving triage a quick pointer to which dimension drifted.
//
// READ-ONLY: opens the SQLite DB with readonly:true. Never writes. The lifecycle
// definition import is also read-only (it is a pure data export; the lifecycle
// module has no DB or runtime side effects — verified by importing it here from
// the dist build, not via the DB-backed product-lifecycle-runtime.ts).

import Database from 'better-sqlite3';
import { sha256Hex } from '../../../dist/shared/canonical-json.js';
// REAL production lifecycle definition. This is the single source of truth for
// lifecycleId, version, stage ids and moduleRefs. If a stage is added/removed,
// a version is bumped, or a moduleRef changes, the fingerprint will drift —
// which is exactly the signal ADR-048 pre-mortem risk #1 demands.
import { productBuildLifecycle } from '../../../dist/process-modules/lifecycles/product-build-lifecycle.js';

// ---------------------------------------------------------------------------
// Executor kinds — sourced from the production runtime, NOT from the lifecycle
// definition (StageBinding has no `nodes` array, so the kind is a runtime
// property of node execution, not a declarative stage property).
//
// Authoritative source:
//   src/app/product-lifecycle-runtime.ts lines 362-564 — the `nodeExecutors`
//   Map literal. Its keys are:
//     'kernel'           — KernelNodeExecutor
//     'human'            — HumanNodeExecutor
//     'production-cell'  — ProductionCellNodeExecutor
//     'lm'               — alias of 'production-cell' (line 564)
//
// We cannot import the runtime here (it requires a live DB to construct), so
// the keys are mirrored as a constant. The RATCHET below verifies the count so
// a silent add/remove of an executor kind trips the fingerprint test even
// before someone updates this constant.
// ---------------------------------------------------------------------------

export const EXECUTOR_KINDS = ['kernel', 'human', 'production-cell', 'lm'];

// Ratchet: if someone adds a new executor kind to the runtime nodeExecutors
// Map (src/app/product-lifecycle-runtime.ts ~L362-564) without updating
// EXECUTOR_KINDS above, this count assertion fires. Bumping the number here is
// a deliberate, reviewed act that also recomputes the fingerprint.
export const EXECUTOR_KINDS_EXPECTED_COUNT = 4;

export const CHECK_PROVIDER_CATEGORIES = [
  'deterministic_evidence',
  'authoritative_state',
  'authorized_decision',
];

// ---------------------------------------------------------------------------
// Overlay allowlist — ADR-048 strict overlay policy.
//
// ADR-048 §Decision: "Replace only the inference WorkerExecutorFactory and an
// explicitly declared deterministic check-provider port." Everything else in
// the production composition (lifecycle, stage routing, package installation,
// repository implementations, settlement policy, preflight policy, delivery
// providers, CandidateSet sealing, GateRun driving, effect semantics, recovery
// policy) MUST NOT be replaced by a composition that claims to be canonical.
//
// This allowlist is the ratchet for CANONICAL compositions. The temporal test
// composition (tests/factory-temporal/lib/temporal-composition.mjs) currently
// DOES override the policy/provider entries below for the limited purpose of
// running hermetic scripted-worker scenarios against deterministic reference
// policies; that composition is a TEST harness that mirrors
// tests/factory-contract/scenario-composition.mjs and is NOT claimed to be
// canonical. The allowlist ratchet only applies to compositions that claim to
// reproduce production — i.e. nothing replaces the production lifecycle
// settlement policy here.
// ---------------------------------------------------------------------------

export const OVERLAY_ALLOWLIST = [
  'workerExecutorFactory',                       // inference port — ADR-048 allows replacement
  'resolveWorkerContext',                        // workspace resolution — required for the executor
  'development.verificationCheckProviderFactory', // declared check-provider port (ADR-048)
];

// ---------------------------------------------------------------------------
// Section hashers
// ---------------------------------------------------------------------------

function hashLifecycleSection() {
  // Read lifecycle identity and stage shape from the REAL production
  // definition (imported at the top of this file). Hardcoding these would let
  // the fingerprint stay green while production drifts — the exact failure
  // ADR-048 pre-mortem risk #1 warns against.
  const id = productBuildLifecycle.identity.name;
  const version = productBuildLifecycle.identity.version;
  const idAndVersion = `${id}@${version}`;
  const stagesDigest = sha256Hex(
    (productBuildLifecycle.stages || []).map(stage => ({
      stageId: stage.id,
      moduleName: stage.moduleRef?.name ?? stage.moduleRef,
      version: stage.moduleRef?.version,
      // Do NOT hardcode executorKind. StageBinding has no `nodes` field in the
      // current lifecycle domain model (see src/process-modules/domain/
      // lifecycle.ts); if/when nodes are added, read each node's kind from the
      // node definition so an executor swap is detected. Until then this is an
      // empty array per stage — stable across runs, but ready to capture drift
      // the moment the schema grows a `nodes` array.
      nodeKinds: (stage.nodes || []).map(n => n.kind || n.executorKind).sort(),
    })),
  );
  const sectionHash = sha256Hex({ id: idAndVersion, version, stagesDigest });
  return { id: idAndVersion, version, stagesDigest, sectionHash };
}

function hashModulesSection(db) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT name, version, package_digest AS packageDigest
         FROM factory_module_installations
        WHERE status='active'
        ORDER BY name, version`,
    ).all() ?? [];
  } catch { rows = []; }
  const modules = rows.map(row => ({
    name: row.name,
    version: row.version,
    packageDigest: row.packageDigest,
  }));
  return { modules, sectionHash: sha256Hex(modules) };
}

function hashProvidersSection(db) {
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT name, version, category, determinism
         FROM trusted_providers
        WHERE status='active'
        ORDER BY COALESCE(project_id, -1), name`,
    ).all() ?? [];
  } catch { rows = []; }
  const providers = rows.map(row => ({
    name: row.name,
    category: row.category,
    determinism: row.determinism,
  }));
  return { providers, sectionHash: sha256Hex(providers) };
}

function hashExecutorKindsSection() {
  // Ratchet: if someone added/removed a key in the runtime nodeExecutors Map
  // (src/app/product-lifecycle-runtime.ts ~L362-564) but forgot to update the
  // EXECUTOR_KINDS mirror constant above, the count diverges and this throws —
  // turning a silent fingerprint drift into an explicit, located failure.
  if (EXECUTOR_KINDS.length !== EXECUTOR_KINDS_EXPECTED_COUNT) {
    throw new Error(
      `EXECUTOR_KINDS_RATCHET_BROKEN: EXECUTOR_KINDS has ${EXECUTOR_KINDS.length} entries `
        + `but EXECUTOR_KINDS_EXPECTED_COUNT=${EXECUTOR_KINDS_EXPECTED_COUNT}. `
        + `Either restore the constant to match src/app/product-lifecycle-runtime.ts `
        + `nodeExecutors Map keys, or update EXECUTOR_KINDS_EXPECTED_COUNT deliberately.`,
    );
  }
  return { executorKinds: [...EXECUTOR_KINDS], sectionHash: sha256Hex(EXECUTOR_KINDS) };
}

function hashCheckProviderCategoriesSection() {
  return {
    checkProviderCategories: [...CHECK_PROVIDER_CATEGORIES],
    sectionHash: sha256Hex(CHECK_PROVIDER_CATEGORIES),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function computeCompositionFingerprint(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const lifecycle = hashLifecycleSection();
    const modules = hashModulesSection(db);
    const providers = hashProvidersSection(db);
    const executorKinds = hashExecutorKindsSection();
    const checkProviderCategories = hashCheckProviderCategoriesSection();

    const sectionHashes = {
      lifecycle: lifecycle.sectionHash,
      modules: modules.sectionHash,
      providers: providers.sectionHash,
      executorKinds: executorKinds.sectionHash,
      checkProviderCategories: checkProviderCategories.sectionHash,
    };
    const joined = [
      sectionHashes.lifecycle,
      sectionHashes.modules,
      sectionHashes.providers,
      sectionHashes.executorKinds,
      sectionHashes.checkProviderCategories,
    ].join(':');
    const fingerprint = sha256Hex(joined);

    return {
      lifecycle: { id: lifecycle.id, version: lifecycle.version, stagesDigest: lifecycle.stagesDigest },
      modules: modules.modules,
      providers: providers.providers,
      executorKinds: executorKinds.executorKinds,
      checkProviderCategories: checkProviderCategories.checkProviderCategories,
      sectionHashes,
      fingerprint,
      overlayAllowlist: [...OVERLAY_ALLOWLIST],
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Overlay allowlist assertion
// ---------------------------------------------------------------------------

export function assertOverlayAllowlist(actualComposition, options = {}) {
  const allowlist = new Set(options.allowlist ?? OVERLAY_ALLOWLIST);
  const violations = [];

  const nestedGroups = {
    development: [
      'store', 'taskGraph', 'settlementState', 'taskGraphPolicy',
      'settlementPolicy', 'outputRepository', 'verificationCheckProviderFactory',
    ],
    delivery: [
      'runtime', 'providers', 'approvalInbox', 'preflightState',
      'approval', 'publication', 'observation', 'settlementState',
      'preflightPolicy', 'settlementPolicy', 'outputRepository',
    ],
  };

  for (const [key, value] of Object.entries(actualComposition ?? {})) {
    if (value === undefined) continue;

    if (Object.prototype.hasOwnProperty.call(nestedGroups, key)) {
      const child = value && typeof value === 'object' ? value : {};
      for (const childKey of Object.keys(child)) {
        if (child[childKey] === undefined) continue;
        const dotted = `${key}.${childKey}`;
        if (!allowlist.has(dotted)) {
          violations.push(dotted);
        }
      }
    } else {
      if (!allowlist.has(key)) {
        violations.push(key);
      }
    }
  }

  if (violations.length > 0) {
    const error = new Error(
      `COMPOSITION_OVERLAY_VIOLATION: composition overrides keys outside the `
        + `temporal overlay allowlist: ${violations.sort().join(', ')}. `
        + `Allowed: ${[...allowlist].sort().join(', ')}`,
    );
    error.code = 'COMPOSITION_OVERLAY_VIOLATION';
    error.violations = violations.sort();
    error.allowlist = [...allowlist].sort();
    throw error;
  }
}

export { sha256Hex };
