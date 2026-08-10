// tests/factory-temporal/lib/composition-fingerprint.mjs
//
// Stable composition fingerprint for ADR-048 temporal conformance tests.
//
// Detects production/test composition drift by hashing sections of the Factory
// production pipeline composition:
//   1. lifecycle identity  — lifecycleId, version, stagesDigest
//   2. installed modules    — each manifest's packageDigest after installProductionModules
//   3. trusted providers    — trusted_providers rows (category, determinism)
//   4. executor kinds       — nodeExecutors Map keys (stable, from source)
//   5. check-provider cats  — trusted_providers.category enum (stable, from source)
//
// Section hashes are joined and hashed once more to form the final fingerprint.
// A drift in ANY section changes exactly one section hash, which changes the
// final fingerprint — giving triage a quick pointer to which dimension drifted.
//
// READ-ONLY: opens the SQLite DB with readonly:true. Never writes.

import Database from 'better-sqlite3';
import { sha256Hex } from '../../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Stable constants — sourced from production TS, hardcoded here so the
// fingerprint does not depend on importing the lifecycle runtime.
// ---------------------------------------------------------------------------

export const LIFECYCLE_ID = 'product-build';
export const LIFECYCLE_VERSION = '1.0.0';

export const LIFECYCLE_STAGES = [
  { stageId: 'initial-discovery', moduleName: 'product-discovery', version: '3.0.2', executorKind: 'production-cell' },
  { stageId: 'solution-formalization', moduleName: 'solution-formalization', version: '1.0.0', executorKind: 'production-cell' },
  { stageId: 'solution-development', moduleName: 'solution-development', version: '1.1.0', executorKind: 'production-cell' },
];

export const EXECUTOR_KINDS = ['kernel', 'human', 'production-cell', 'lm'];

export const CHECK_PROVIDER_CATEGORIES = [
  'deterministic_evidence',
  'authoritative_state',
  'authorized_decision',
];

export const OVERLAY_ALLOWLIST = [
  'workerExecutorFactory',
  'resolveWorkerContext',
  'development.verificationCheckProviderFactory',
  'development.taskGraphPolicy',
  'development.settlementPolicy',
  'delivery.providers',
  'delivery.preflightPolicy',
  'delivery.settlementPolicy',
];

// ---------------------------------------------------------------------------
// Section hashers
// ---------------------------------------------------------------------------

function hashLifecycleSection() {
  const id = `${LIFECYCLE_ID}@${LIFECYCLE_VERSION}`;
  const stagesDigest = sha256Hex(
    LIFECYCLE_STAGES.map(stage => ({
      moduleName: stage.moduleName,
      version: stage.version,
      executorKind: stage.executorKind,
    })),
  );
  const sectionHash = sha256Hex({ id, version: LIFECYCLE_VERSION, stagesDigest });
  return { id, version: LIFECYCLE_VERSION, stagesDigest, sectionHash };
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
    const lifecycle = hashLifecycleSection(db);
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
