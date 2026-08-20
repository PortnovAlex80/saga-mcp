// tests/factory-proof/canonical-proof-composition.mjs
//
// THE canonical proof composition (ADR-084 / GRAPH-TEST-STRATEGY W0-1).
//
// Exactly one composition authority for every new causal proof. It is a thin
// ADAPTER OVER the production driver src/factory-e2e/fresh-harness.ts
// (bootstrapFreshHarness + driveFreshHarness) — it never copies the drive loop
// and never introduces a second runtime. SQLite repositories, WorkIntent, MCP,
// ProductRef, CandidateSet, gates, effects, routing and postconditions all stay
// on production implementations.
//
// Closed overlay allowlist (extend only by deliberate edit with a reason):
//   workerExecutorFactory      — scripted inference; replaces ONLY model
//                                cognition (the §8.9 seam).
//   resolveWorkerContext       — per-run workspace resolution for the executor.
//   delivery.providers.*       — deterministic EXTERNAL doubles (preflight,
//                                actionProviders, observeCurrentCandidateHash).
//                                Delivery cannot be proven in an isolated
//                                environment without them; their identities are
//                                visibly test doubles, never "production".
//
// Explicitly NOT in the overlay — production registration constructs these as
// defaults when omitted (src/modules/development/index.ts, registerDevelopment
// with `{}`; src/modules/delivery/index.ts, registerDelivery defaults):
//   development.taskGraphPolicy, development.settlementPolicy,
//   delivery.preflightPolicy, delivery.settlementPolicy, delivery.runtime,
//   delivery.approvalInbox, delivery.preflightState, ...
// Re-passing the Reference policies as "override" would be a mirror with zero
// production value (brief W0-1 §2) — the canonical composition omits them and
// the overlay allowlist rejects any attempt to sneak them back in.
//
// Composition discipline enforced per proof-run (not on a toy fixture):
//   assertCanonicalOverlay(composition)  — the REAL composition object;
//   readInstalledIdentity(bootstrap)     — durable installed module/package
//                                          identity from the per-run DB;
//   computeCanonicalProofFingerprint()   — hash over the actual overlay keys +
//                                          installed production identity;
//   driveCanonicalProof(opts)            — assert → fingerprint → delegate to
//                                          the production driver.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { createInProcessScriptedExecutorFactory, createScriptedObserver }
  from '../factory-e2e/scripted-inference.mjs';

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Overlay allowlist — closed set, dotted keys for nested groups.
// ---------------------------------------------------------------------------

export const CANONICAL_OVERLAY_ALLOWLIST = Object.freeze([
  'workerExecutorFactory',
  // K2 (conformance-engine plan §K2): the STRICT L3 seam — replaces only the
  // physical CLI subprocess; the production executor/envelope is preserved.
  // Mutually exclusive with workerExecutorFactory in one composition.
  'workerSpawn',
  'resolveWorkerContext',
  'delivery.providers',
  'delivery.providers.preflight',
  'delivery.providers.actionProviders',
  'delivery.providers.observeCurrentCandidateHash',
]);

// Declarative allowlist tree: LEAF = an allowed key whose VALUE (a function,
// a provider double, a map of doubles) is not itself overlay surface — the
// walk stops there. Group nodes (delivery → providers) must be objects; any
// key not in the tree is a violation.
const LEAF = Symbol('leaf');
const CANONICAL_OVERLAY_TREE = Object.freeze({
  workerExecutorFactory: LEAF,
  workerSpawn: LEAF,
  resolveWorkerContext: LEAF,
  delivery: Object.freeze({
    providers: Object.freeze({
      preflight: LEAF,
      actionProviders: LEAF,
      observeCurrentCandidateHash: LEAF,
    }),
  }),
});

/**
 * Assert the overlay allowlist against the REAL composition object of a
 * proof-run — never against a synthetic "safe" fixture. Any key outside the
 * closed allowlist (including re-passed Reference policies as mirror
 * overrides) turns the proof red with the exact violation list.
 */
export function assertCanonicalOverlay(composition) {
  const violations = [];

  const walk = (obj, node, prefix) => {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (value === undefined) continue;
      const dotted = prefix ? `${prefix}.${key}` : key;
      const allowed = node[key];
      if (allowed === LEAF) continue;
      if (allowed === undefined) {
        // Unknown key: the violation is the KEY itself (`delivery.preflightPolicy`,
        // `development`). Descending into its members would report method
        // surface (`.evaluate`) as if it were the violation — noise.
        violations.push(dotted);
        continue;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${dotted} (group must be an object)`);
        continue;
      }
      walk(value, allowed, dotted);
    }
  };
  walk(composition, CANONICAL_OVERLAY_TREE, '');

  if (violations.length > 0) {
    const error = new Error(
      `CANONICAL_COMPOSITION_OVERLAY_VIOLATION: composition carries keys `
      + `outside the canonical proof overlay allowlist: `
      + `${violations.sort().join(', ')}. Allowed: `
      + `${[...CANONICAL_OVERLAY_ALLOWLIST].sort().join(', ')}. The canonical `
      + `composition must omit production-default policies (Reference*) `
      + `entirely — production registration constructs them.`,
    );
    error.code = 'CANONICAL_COMPOSITION_OVERLAY_VIOLATION';
    error.violations = violations.sort();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Deterministic external Delivery doubles — TEST identities, visibly so.
// bootstrapFreshHarness seeds the matching trusted_providers rows; settlement
// consults them. These doubles are file-marker providers: execute() writes a
// marker under the per-run repo .git, observe() reads it back. They never
// fabricate approval decisions or a released outcome the marker does not carry.
// ---------------------------------------------------------------------------

export const CANONICAL_TEST_PROVIDERS = Object.freeze({
  preflight: Object.freeze({
    providerId: 9001,
    name: 'fresh-harness-preflight',
    version: '1.0.0',
    category: 'deterministic_evidence',
    determinism: 'full',
    role: 'test-double',
  }),
  deployment: Object.freeze({
    providerId: 9002,
    name: 'fresh-harness-deployment-state',
    version: '1.0.0',
    category: 'authoritative_state',
    determinism: 'partial',
    role: 'test-double',
  }),
});

function providerEvidence(prefix, body) {
  const hash = sha256Hex(body);
  return { schema: `factory.proof.${prefix}.v1`, ref: `proof:${prefix}:${hash}`, hash };
}

export function buildCanonicalDeliveryProviders({ repoPath }) {
  const markerRoot = path.join(repoPath, '.git');
  const markerPath = actionKey => path.join(
    markerRoot, `.proof-release-marker-${sha256Hex(actionKey)}.json`,
  );

  const preflight = {
    identity: CANONICAL_TEST_PROVIDERS.preflight,
    evaluate({ deliveryCase, checkId }) {
      const body = {
        checkId,
        candidateHash: deliveryCase.integratedCandidate.hash,
        result: 'passed',
      };
      return {
        outcome: 'passed',
        evidence: providerEvidence('preflight-evidence', body),
        provider: CANONICAL_TEST_PROVIDERS.preflight,
      };
    },
  };

  const deployment = {
    namespace: 'proof-deployment',
    identity: CANONICAL_TEST_PROVIDERS.deployment,
    async execute({ action, actionKey }) {
      const marker = markerPath(actionKey);
      const state = {
        actionKey,
        target: action.target,
        desiredStateHash: action.desiredStateHash,
      };
      writeFileSync(marker, JSON.stringify(state), 'utf8');
      return {
        outcome: 'succeeded',
        externalRef: `proof-deployment:${sha256Hex(actionKey)}`,
        resultHash: sha256Hex(state),
      };
    },
    async observe({ action, actionKey }) {
      const marker = markerPath(actionKey);
      let observedStateHash = 'proof-deployment:not-applied';
      if (existsSync(marker)) {
        try {
          const state = JSON.parse(readFileSync(marker, 'utf8'));
          if (state?.actionKey === actionKey && state?.target === action.target) {
            observedStateHash = String(state.desiredStateHash || '');
          }
        } catch {
          observedStateHash = 'proof-deployment:corrupt-state';
        }
      }
      const matched = observedStateHash === action.desiredStateHash;
      const body = { actionKey, target: action.target, observedStateHash, matched };
      return {
        outcome: matched ? 'matched' : 'mismatched',
        observedStateHash,
        observation: providerEvidence('deployment-observation', body),
      };
    },
  };

  return {
    preflight,
    actionProviders: { deployment },
    observeCurrentCandidateHash(deliveryCase) {
      return deliveryCase.integratedCandidate.hash;
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical composition builder — only allowlisted keys ever appear.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.observer                 Scripted observer (createScriptedObserver()).
 * @param {string} opts.repoPath                 Fresh per-run git repo.
 * @param {string} opts.sagaRepoRoot             saga-mcp repo root.
 * @param {Record<string, Function>} [opts.handlers]  Scripted scenario handlers.
 * @param {object} [opts.crashPoint]             Named deterministic crash point.
 * @param {object} [opts.deliveryProviders]      Pre-built provider set (defaults to
 *                                                buildCanonicalDeliveryProviders).
 */
export function buildCanonicalProofComposition(opts) {
  const { observer, repoPath, sagaRepoRoot, handlers, crashPoint, workerSpawn } = opts;
  if (!observer) throw new Error('CANONICAL_COMPOSITION_OBSERVER_REQUIRED');
  if (!repoPath) throw new Error('CANONICAL_COMPOSITION_REPO_PATH_REQUIRED');
  if (!sagaRepoRoot) throw new Error('CANONICAL_COMPOSITION_REPO_ROOT_REQUIRED');
  if (workerSpawn && handlers) {
    throw new Error('CANONICAL_COMPOSITION_MODE_CONFLICT: strict workerSpawn and in-process handlers are mutually exclusive');
  }
  if (workerSpawn && typeof workerSpawn !== 'function') {
    throw new Error('CANONICAL_COMPOSITION_SPAWN_INVALID: workerSpawn must be a spawn function');
  }

  // STRICT L3 (K2): no in-process executor at all — the composition root
  // builds the PRODUCTION pinned worker factory and only the physical
  // subprocess is the scripted child. The fast lane stays the default.
  if (workerSpawn) {
    return {
      workerSpawn,
      resolveWorkerContext: ctx => ({
        projectId: ctx.projectId,
        epicId: ctx.epicId ?? 0,
        workspaceRoot: repoPath,
        dbPath: process.env.DB_PATH,
        sagaEntry: path.resolve(sagaRepoRoot, 'dist/index.js'),
        sagaSkillRoot: sagaRepoRoot,
        claudePath: 'k2-strict-spawn',
        lmStudioUrl: process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
      }),
      delivery: {
        providers: opts.deliveryProviders ?? buildCanonicalDeliveryProviders({ repoPath }),
      },
    };
  }

  const scriptedExecutorFactory = createInProcessScriptedExecutorFactory({
    observer,
    handlers: handlers ?? {},
    crashPoint: crashPoint ?? null,
  });

  return {
    workerExecutorFactory: scriptedExecutorFactory,
    resolveWorkerContext: ctx => ({
      projectId: ctx.projectId,
      epicId: ctx.epicId ?? 0,
      workspaceRoot: repoPath,
      dbPath: process.env.DB_PATH,
      sagaEntry: path.resolve(sagaRepoRoot, 'dist/index.js'),
      sagaSkillRoot: sagaRepoRoot,
      claudePath: undefined,
      lmStudioUrl: process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
    }),
    delivery: {
      providers: opts.deliveryProviders ?? buildCanonicalDeliveryProviders({ repoPath }),
    },
  };
}

// ---------------------------------------------------------------------------
// Installed production identity — read from the per-run DB + the production
// lifecycle definition. This records WHAT WAS COMPOSED; it is not a normative
// oracle (that is the W0-2 registry). Read-only: SELECT only.
// ---------------------------------------------------------------------------

export async function readInstalledIdentity(bootstrap) {
  const { getDb } = await import(pathToFileURL(path.resolve(REPO_ROOT, 'dist/db.js')).href);
  const db = getDb();

  const { productBuildLifecycle } = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/process-modules/lifecycles/product-build-lifecycle.js')).href
  );

  const lifecycle = {
    id: `${productBuildLifecycle.identity.name}@${productBuildLifecycle.identity.version}`,
    stages: (productBuildLifecycle.stages || []).map(stage => ({
      stageId: stage.id,
      moduleName: stage.moduleRef?.name ?? stage.moduleRef,
      version: stage.moduleRef?.version,
    })),
  };

  const modules = db.prepare(
    `SELECT name, version, package_digest AS packageDigest
       FROM factory_module_installations
      WHERE status='active'
      ORDER BY name, version`,
  ).all();

  const providers = db.prepare(
    `SELECT name, version, category, determinism
       FROM trusted_providers
      WHERE status='active'
      ORDER BY name`,
  ).all();

  return { lifecycle, modules, providers };
}

/**
 * Assert the installed identity is COMPLETE and matches what the bootstrap
  * installed through the production installer. A removed or mutated
  * module/package identity row (composition surface, not authority) makes the
  * proof red instead of silently composing a partial factory.
  */
export function assertInstalledIdentity(bootstrap, identity) {
  const expected = new Map(
    [...bootstrap.packageInstallation.records.entries()]
      .map(([name, record]) => [`${name}@${record.version}`, record.packageDigest]),
  );
  const installed = new Map(identity.modules.map(m => [`${m.name}@${m.version}`, m.packageDigest]));

  const missing = [...expected.keys()].filter(k => !installed.has(k));
  if (missing.length > 0) {
    throw new Error(
      `CANONICAL_PROOF_IDENTITY_INCOMPLETE: production module identity missing from `
      + `the per-run DB: ${missing.sort().join(', ')}. A proof may not compose a `
      + `partial factory — the installed package surface must match the bootstrap `
      + `installation exactly.`,
    );
  }
  const mutated = [...expected.entries()]
    .filter(([key, digest]) => installed.get(key) !== digest)
    .map(([key]) => key);
  if (mutated.length > 0) {
    throw new Error(
      `CANONICAL_PROOF_IDENTITY_MUTATED: installed package digest differs from the `
      + `bootstrap installation for: ${mutated.sort().join(', ')}.`,
    );
  }
  if (identity.lifecycle.stages.length === 0) {
    throw new Error('CANONICAL_PROOF_IDENTITY_INCOMPLETE: lifecycle definition has no stages');
  }
  return identity;
}

/**
 * Fingerprint of the ACTUAL composition: the overlay keys really present on
 * the override object + the durable installed production identity. Any added
 * overlay key, removed production module, or lifecycle identity change alters
 * the fingerprint.
 */
export function computeCanonicalProofFingerprint(bootstrap, composition, identity) {
  const overlayKeys = Object.freeze(Object.entries(composition ?? {})
    .flatMap(([key, value]) => {
      if (value === undefined) return [];
      if (key === 'delivery' && value && typeof value === 'object') {
        return Object.keys(value)
          .filter(child => value[child] !== undefined)
          .map(child => `delivery.${child}`);
      }
      return [key];
    })
    .sort());

  const sections = {
    lifecycle: sha256Hex({
      id: identity.lifecycle.id,
      stages: identity.lifecycle.stages,
    }),
    modules: sha256Hex(identity.modules),
    providers: sha256Hex(identity.providers),
    overlay: sha256Hex(overlayKeys),
  };
  const fingerprint = sha256Hex([
    sections.lifecycle, sections.modules, sections.providers, sections.overlay,
  ].join(':'));

  return { overlayKeys: [...overlayKeys], sections, fingerprint };
}

// ---------------------------------------------------------------------------
// driveCanonicalProof — assert → fingerprint → delegate to the PRODUCTION
// driver. This is an adapter, not a copy: the drive loop is driveFreshHarness.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts  driveFreshHarness options (bootstrap, composition, ...)
 *                       minus nothing — all pass through.
 * @returns {Promise<{result: object, identity: object, fingerprint: object}>}
 */
export async function driveCanonicalProof(opts) {
  const { bootstrap, composition } = opts;
  assertCanonicalOverlay(composition);
  const identity = assertInstalledIdentity(
    bootstrap,
    await readInstalledIdentity(bootstrap),
  );
  const fingerprint = computeCanonicalProofFingerprint(bootstrap, composition, identity);

  const { driveFreshHarness } = await import(
    pathToFileURL(path.resolve(REPO_ROOT, 'dist/factory-e2e/fresh-harness.js')).href
  );
  const result = await driveFreshHarness(opts);

  return { result, identity, fingerprint };
}

export { createScriptedObserver };
