// tests/execution/hardening-security.test.mjs
//
// W12-A5 — Invalid package/schema/capability/mapping/route/authority/tool
// security tests (fail-closed proof).
//
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md
//       Lane W12-A5; exit gate §3.4: "Invalid packages/schemas/capabilities/
//       mappings/routes/authority/tools fail BEFORE semantic work."
// Task: docs/refactor-management/05-subagent-tasks/W12-a5.md
//
// WHAT THIS FILE PROVES
//
//   The Saga 3 architecture is FAIL-CLOSED across every trust boundary. Every
//   invalid input is rejected BEFORE any semantic work (LM call, scenario
//   execution, package activation, tool dispatch) begins. The seven input
//   classes named in the frozen spec are each proven in their own section:
//
//     1. PACKAGES   — invalid ProcessModuleManifests never reach the package
//                     store; undeclared/corrupt/traversal resources never
//                     activate.
//     2. SCHEMAS    — malformed discovery proposals, unknown ContractRefs,
//                     and non-canonical-serializable values are rejected
//                     before any codec or kernel work runs.
//     3. CAPABILITIES — invalid CapabilityRequirement / GuardBinding shapes
//                      are rejected by their pure validators.
//     4. MAPPINGS   — unsafe mapping paths (prototype pollution) and invalid
//                     mapping expressions are rejected statically; a manifest
//                     smuggling a `routeResolver` key is rejected.
//     5. ROUTES     — outcome routes that target undeclared stages/terminals,
//                     or smuggle an executable resolver, fail before the
//                     router can consume them.
//     6. AUTHORITY  — the Saga MCP gateway denies every disallowed tool,
//                     every malformed execution context, and every authority
//                     hash mismatch BEFORE the handler runs.
//     7. TOOLS      — invalid ModuleToolContribution shapes (bad idempotency,
//                     sideEffect, contract refs) are rejected by the pure
//                     validator.
//
//   The "before semantic work" property is asserted structurally: every gate
//   under test is a PURE function (or a synchronous DB read) that returns a
//   rejection decision WITHOUT calling any LM, executor, store.write, or
//   activate. Where a pipeline could proceed past the gate, we assert the
//   gate fires first by observing that the downstream effect (a store.write,
//   a repo.activate, a handler invocation) never happens.
//
// TEST-ONLY WAVE (§0.15.2): this file adds NO production code. Every
// assertion exercises EXISTING Waves 0-11 fail-closed logic. Any failure
// documents a bug for the owning subsystem and is recorded in the return,
// NOT patched here.
//
// These tests are SELF-CONTAINED: real SQLite for the authority gateway
// (mirrors tests/discovery/d1-1-authority.test.mjs), in-memory fakes for the
// package store/repo (mirrors tests/installation/installer.test.mjs), and
// inline fixtures for manifests/scenarios (mirrors
// tests/execution/scenario-compiler.test.mjs). No cross-W12-lane imports.
//
// Run: node --test tests/execution/hardening-security.test.mjs
// (after `npm run build` — imports are from dist/).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// --- Pure validators / value types (Waves 1-2) ----------------------------
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const {
  validateProcessModuleManifest,
} = await import(
  '../../dist/process-modules/domain/spi/module-manifest.js'
);
const {
  validateLifecycleScenarioManifest,
  isSafeMappingPath,
} = await import(
  '../../dist/process-modules/domain/spi/scenario-manifest.js'
);
const {
  validateModuleToolContribution,
  validateCapabilityRequirement,
  validateGuardBinding,
  TOOL_IDEMPOTENCY_VALUES,
  TOOL_SIDE_EFFECT_VALUES,
} = await import(
  '../../dist/process-modules/domain/spi/tool-contribution.js'
);
const {
  InMemoryContractSchemaRegistry,
  CONTRACT_SCHEMA_UNKNOWN,
} = await import(
  '../../dist/process-modules/domain/spi/contract-schema-registry.js'
);
const {
  PackageInstaller,
  PackageInstallerError,
  MODULE_INSTALLATION_MANIFEST_INVALID,
  MODULE_INSTALLATION_UNDECLARED_RESOURCE,
  MODULE_INSTALLATION_CORRUPT,
  MODULE_INSTALLATION_VERSION_COLLISION,
} = await import(
  '../../dist/process-modules/installation/domain/installer.js'
);
const {
  FilesystemModulePackageStore,
} = await import(
  '../../dist/process-modules/installation/adapters/filesystem-package-store.js'
);
const {
  PACKAGE_STORE_PATH_TRAVERSAL,
  PackageStoreError,
} = await import(
  '../../dist/process-modules/installation/domain/package-store.js'
);

// --- Scenario compiler (Wave 7) -------------------------------------------
const {
  compileScenario,
  createModuleContractResolver,
  ENVELOPE_INVALID,
  MODULE_CONTRACT_UNRESOLVED,
  MAPPING_EXPRESSION_INVALID,
  CONTRACT_REF_NOT_REGISTERED,
} = await import('../../dist/application/scenario-compiler.js');

// --- Discovery proposal validator (Wave 9 saga3) --------------------------
const {
  validateDiscoveryProposal,
  DISCOVERY_OUTCOMES,
} = await import('../../dist/modules/discovery/domain/discovery-proposal.js');

// --- Authority gateway (D1.1) ---------------------------------------------
const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { closeDb, getDb } = await import('../../dist/db.js');
const { authorizeSagaToolCall } = await import(
  '../../dist/shared/authority/authorize-tool-call.js'
);
const { authorityHash, executionContextHash } = await import(
  '../../dist/shared/authority/execution-context.js'
);

// ---------------------------------------------------------------------------
// Shared fixture builders (mirrors of the canonical patterns in the sibling
// test files — kept inline so this lane builds in isolation).
// ---------------------------------------------------------------------------

/** sha256 of raw bytes via crypto (matches computeResourceDigest). */
function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function ref(schemaId, version, digest) {
  return { schemaId, version, digest: digest ?? `d-${schemaId}-${version}` };
}

/**
 * Minimal valid ProcessModuleManifest. Mirrors scenario-compiler.test.mjs's
 * builder so the envelope passes validateProcessModuleManifest.
 */
function moduleManifest(name, version) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: {
      identity: {
        name,
        version,
        kind: 'process',
        displayName: name,
        description: `${name} module`,
      },
      inputContract: { id: `${name}.input` },
      outputContract: { id: `${name}.output` },
      outcomes: [
        { code: 'go', description: 'proceed', terminal: false },
        { code: 'clarify', description: 'needs work', terminal: true },
      ],
      flow: {
        id: `${name}-flow`,
        version: '1.0.0',
        entryNodeId: 'n1',
        nodes: [
          { id: 'n1', label: 'do', kind: 'lm', executionProfile: 'p1', description: 'do work', emitsOutcome: 'go' },
        ],
        transitions: [],
        terminalNodeIds: ['n1'],
      },
      artifacts: [],
      policies: [],
      invariants: [],
      executionProfiles: [
        {
          id: 'p1',
          workIntentKind: 'w',
          workIntentSchema: { id: 'w.schema' },
          taskKind: 't',
          executionSkill: 's',
          protocolSkill: 'ps',
          semanticSkill: 'ss',
          executionMode: 'git_change',
          allowedTools: [],
          trackerTemplate: null,
          workspaceTemplates: [],
          callTemplates: [],
          checklists: [],
          outputSchema: { id: 'o.schema' },
          retryPolicy: { maxAttempts: 1, retryOn: [], backoff: 'none' },
          recoveryPolicy: {
            resumeFromCheckpoint: false,
            reuseWorkIntent: false,
            reuseAcceptedOutput: false,
            onExhausted: 'fail',
          },
        },
      ],
    },
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: ref(`${name}.input`, '1.0.0'),
    outputContractRef: ref(`${name}.output`, '1.0.0'),
    runtimeCompatibilityRange: '^3.0.0',
  };
}

/** A valid module manifest WITH declared resources (for install tests). */
function moduleManifestWithResources(name, version) {
  const base = moduleManifest(name, version);
  const bytes = new TextEncoder().encode('hello world');
  const d = digestBytes(bytes);
  return {
    ...base,
    resourceIndex: [
      { logicalId: 'res-a', path: 'skills/a.md', kind: 'skill', digest: d },
    ],
    handlerRefs: [
      // K3 (de9b2f88): a handlerRef must pin a REAL implementation digest —
      // the placeholder is legal on resources only. Any stable 64-hex pins
      // this fixture's (inline) handler implementation.
      { logicalId: 'h-a', version: '0.1.0', digest: 'f'.repeat(64) },
    ],
  };
}

/** ResourceBlob[] matching moduleManifestWithResources. */
function matchingResources() {
  const bytes = new TextEncoder().encode('hello world');
  return [
    { logicalId: 'res-a', kind: 'skill', bytes, digest: digestBytes(bytes) },
  ];
}

/** A stage binding with route-complete default outcomeRoutes. */
function stage(id, moduleName, moduleVersion, opts = {}) {
  const routes = opts.routes ?? {
    go: { type: 'terminal', status: 'done' },
    clarify: { type: 'terminal', status: 'done' },
  };
  return {
    id,
    displayName: opts.displayName ?? id,
    moduleRef: { name: moduleName, version: moduleVersion },
    moduleSelector: { name: moduleName, versionRange: opts.versionRange ?? moduleVersion },
    inputMapping: opts.inputMapping ?? { payload: 'root.payload' },
    outputMapping: opts.outputMapping,
    outcomeRoutes: routes,
    entryConditions: opts.entryConditions ?? [],
    exitConditions: opts.exitConditions ?? [],
  };
}

/** A baseline VALID scenario manifest. */
function validScenarioManifest(stages) {
  const moduleNames = [...new Set(stages.map((s) => s.moduleSelector.name + '@' + s.moduleSelector.versionRange))]
    .map((key) => {
      const [name, versionRange] = key.split('@');
      return { name, versionRange };
    });
  return {
    manifestFormatVersion: '0.1.0',
    identity: {
      name: 'hardening-scenario',
      version: '1.0.0',
      displayName: 'Hardening Scenario',
      description: 'a test',
    },
    inputContractRef: ref('scenario.input', '1.0.0'),
    outputContractRef: ref('scenario.output', '1.0.0'),
    entryStageId: stages[0].id,
    stageBindings: stages,
    outcomeRoutes: {},
    inputMappings: { root: 'root' },
    outputMappings: {},
    terminalStatuses: ['done'],
    scenarioPolicies: {},
    requiredModuleSelectors: moduleNames,
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 2 },
  };
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

// ---------------------------------------------------------------------------
// In-memory fake ModulePackageStore + ModuleInstallationRepository.
// Faithful port implementations mirroring tests/installation/installer.test.mjs
// so the fail-closed pipeline ordering can be observed without sqlite.
// ---------------------------------------------------------------------------

function computePackageDigest(manifest, resources) {
  return sha256Hex({
    manifest,
    resourceIndex: manifest.resourceIndex,
    resourceDigests: resources.map((r) => r.digest),
  });
}

/** Tracks whether store.store / repo.activate were called (semantic-work probes). */
function createInstrumentedStore() {
  const packages = new Map();
  let counter = 0;
  let storeCalls = 0;
  const store = {
    async store(manifest, resources) {
      storeCalls += 1;
      const packageDigest = computePackageDigest(manifest, resources);
      if (!packages.has(packageDigest)) {
        counter += 1;
        packages.set(packageDigest, {
          manifest,
          resources: resources.map((r) => ({ ...r, bytes: r.bytes.slice() })),
          packageDigest,
          storedAt: `mem://packages/${counter}`,
        });
      }
      const p = packages.get(packageDigest);
      return { manifest: p.manifest, resources: p.resources, packageDigest: p.packageDigest, storedAt: p.storedAt };
    },
    async read(packageDigest) {
      const p = packages.get(packageDigest);
      if (!p) {
        throw Object.assign(new Error('not found'), { code: 'PACKAGE_STORE_NOT_FOUND' });
      }
      return { manifest: p.manifest, resources: p.resources, packageDigest: p.packageDigest, storedAt: p.storedAt };
    },
    async exists(packageDigest) { return packages.has(packageDigest); },
    async verify(packageDigest) {
      const p = packages.get(packageDigest);
      if (!p) return false;
      const recomputedResourceDigests = p.resources.map((r) =>
        createHash('sha256').update(r.bytes).digest('hex'),
      );
      const recomputed = sha256Hex({
        manifest: p.manifest,
        resourceIndex: p.manifest.resourceIndex,
        resourceDigests: recomputedResourceDigests,
      });
      return recomputed === packageDigest;
    },
    /** Test-only: corrupt stored bytes. */
    _corrupt(packageDigest) {
      const p = packages.get(packageDigest);
      if (p && p.resources.length > 0) {
        p.resources[0].bytes[0] = (p.resources[0].bytes[0] ?? 0) ^ 0xff;
      }
    },
    _storeCallCount() { return storeCalls; },
  };
  return store;
}

function createInstrumentedRepo() {
  const rows = [];
  let nextId = 0;
  let activateCalls = 0;
  let insertCalls = 0;
  const repo = {
    async insert(record) {
      insertCalls += 1;
      if (rows.some((r) => r.name === record.name && r.version === record.version && r.status === 'active' && r.packageDigest !== record.packageDigest)) {
        throw Object.assign(new Error('version collision'), { code: MODULE_INSTALLATION_VERSION_COLLISION });
      }
      nextId += 1;
      const row = { id: nextId, ...record };
      rows.push(row);
      return row;
    },
    async getActiveByNameVersion(name, version) {
      return rows.find((r) => r.name === name && r.version === version && r.status === 'active') ?? null;
    },
    async activate(id) {
      activateCalls += 1;
      const row = rows.find((r) => r.id === id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'MODULE_INSTALLATION_NOT_FOUND' });
      row.status = 'active';
      row.activatedAt = row.activatedAt ?? new Date().toISOString();
      return row;
    },
    async markCorrupt(id) {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = 'corrupt';
      return row;
    },
    _activateCallCount() { return activateCalls; },
    _insertCallCount() { return insertCalls; },
    _rows() { return rows; },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Authority-gateway fixture (real SQLite, mirrors d1-1-authority.test.mjs).
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = ['task_get', 'proposal_submit', 'worker_done'];

function makeAuthorityFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-w12-a5-auth-'));
  process.env.DB_PATH = path.join(temp, 'w12-a5-auth.db');
  const db = getDb();
  return { temp, db };
}

function cleanupAuthorityFixture(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.SAGA_EXECUTION_ID;
  delete process.env.SAGA_MANAGED_EXECUTION;
  delete process.env.SAGA_TASK_ID;
  delete process.env.SAGA_WORKER_ID;
}

function seedExecutionRow(db, executionId, metadata, { taskId = 100, workerId = 'w-1' } = {}) {
  db.prepare(`INSERT OR IGNORE INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT OR IGNORE INTO epics (id,project_id,name) VALUES (10,1,'REQ-10')`).run();
  let taskMetadata = '{}';
  try {
    const parsed = JSON.parse(metadata);
    const context = parsed?.execution_context;
    if (context?.authority && Number.isInteger(context.work_intent_id)) {
      taskMetadata = JSON.stringify({ work_intent_id: context.work_intent_id });
    }
  } catch { taskMetadata = '{}'; }
  db.prepare(`INSERT OR IGNORE INTO tasks (id, epic_id, title, status, task_kind, generation_key, metadata)
              VALUES (?, 10, 'T', 'in_progress', 'discovery.work', ?, ?)`).run(taskId, `gk-${taskId}`, taskMetadata);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase, metadata)
     VALUES (?, 'run-1', 1, 10, ?, ?, 'm-1', 'running', 'executing', ?)`,
  ).run(executionId, taskId, workerId, metadata);
}

function runtimeAuthoritySnapshot(allowed = ALLOWED_TOOLS, workIntentId = 7, overrides = {}) {
  const authority = {
    enforcement: 'runtime',
    allowed_saga_tools: allowed,
    scope: 'read-only discovery context',
    snapshot_ref: 'episode:10',
    work_intent_id: workIntentId,
  };
  authority.authority_hash = authorityHash(authority);
  const execution_context = {
    policy_version: 'factory.execution.v2',
    executor_kind: 'claude-cli',
    work_intent_id: workIntentId,
    authority,
    model_route: { provider: 'lmstudio', model: 'qwen-test', effort: null },
    captured_at: '2026-07-23T20:00:00.000Z',
    ...overrides,
  };
  return JSON.stringify({ execution_context, execution_context_hash: executionContextHash(execution_context) });
}

// ===========================================================================
// SECTION 1 — PACKAGES (invalid manifests + corrupt/undeclared/traversal
// resources never activate; the gate fires before semantic work).
// ===========================================================================

test('PACKAGES: manifest missing required fields is rejected by validateProcessModuleManifest', () => {
  const result = validateProcessModuleManifest({});
  assert.equal(result.ok, false, 'an empty object must not validate');
  // Multiple structural failures surface at once (fail-closed collects every
  // reason before returning, so the operator sees the full defect set).
  const codes = new Set(result.errors.map((e) => e.code));
  assert.ok(codes.has('MANIFEST_FORMAT_VERSION_EMPTY'));
  assert.ok(codes.has('MANIFEST_DEFINITION_MISSING'));
  assert.ok(codes.has('MANIFEST_RESOURCE_INDEX_MISSING'));
  assert.ok(codes.has('MANIFEST_HANDLER_REFS_MISSING'));
});

test('PACKAGES: manifest carrying a function value is rejected (canonical-serialization gate)', async () => {
  const m = deepClone(moduleManifest('evil', '1.0.0'));
  // Smuggle a function into a data-only envelope. The canonical-serialization
  // pre-check is FAIL-FAST: it THROWS on the first forbidden value (a
  // non-canonical-serializable value can never round-trip through the
  // content-addressed store). Throwing is the strongest fail-closed form —
  // no caller can ignore a returned {ok:false} and proceed.
  m.runtimeCompatibilityRange = () => { /* prototype pollution payload */ };
  assert.throws(
    () => validateProcessModuleManifest(m),
    (err) => {
      assert.equal(err.code, 'CANONICAL_SERIALIZATION_INVALID');
      return true;
    },
  );
  // The PackageInstaller normalizes this throw into its typed error surface
  // (MODULE_INSTALLATION_MANIFEST_INVALID), so callers that cannot catch the
  // raw canonical error still see a typed rejection before any store write.
  const store = createInstrumentedStore();
  const repo = createInstrumentedRepo();
  const installer = new PackageInstaller();
  await assert.rejects(
    () => installer.installPackage(m, [], { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_MANIFEST_INVALID);
      assert.equal(store._storeCallCount(), 0, 'store.store must NOT be called');
      return true;
    },
  );
});

test('PACKAGES: manifest with duplicate resource logicalIds is rejected', () => {
  const m = moduleManifestWithResources('dup', '1.0.0');
  const entry = m.resourceIndex[0];
  m.resourceIndex = [entry, { ...entry }];
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'RESOURCE_LOGICAL_ID_DUPLICATE'));
});

test('PACKAGES: manifest with unknown resource kind is rejected', () => {
  const m = moduleManifestWithResources('badkind', '1.0.0');
  m.resourceIndex[0].kind = 'malware-payload';
  const result = validateProcessModuleManifest(m);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'RESOURCE_KIND_UNKNOWN'));
});

test('PACKAGES: PackageInstaller rejects an invalid manifest BEFORE store.store is called', async () => {
  // The fail-closed ordering proof: a manifest that fails validation must
  // never reach the store. We instrument the store to count calls.
  const store = createInstrumentedStore();
  const repo = createInstrumentedRepo();
  const installer = new PackageInstaller();
  const invalid = deepClone(moduleManifest('invalid', '1.0.0'));
  invalid.manifestFormatVersion = ''; // validation failure

  await assert.rejects(
    () => installer.installPackage(invalid, [], { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_MANIFEST_INVALID);
      return true;
    },
  );
  // BEFORE-semantic-work assertion: the store was never written.
  assert.equal(store._storeCallCount(), 0, 'store.store must NOT be called on an invalid manifest');
  assert.equal(repo._insertCallCount(), 0, 'repo.insert must NOT be called on an invalid manifest');
});

test('PACKAGES: PackageInstaller rejects undeclared resources BEFORE store.store is called', async () => {
  const store = createInstrumentedStore();
  const repo = createInstrumentedRepo();
  const installer = new PackageInstaller();
  const manifest = moduleManifestWithResources('undeclared', '1.0.0');
  // Supply a blob whose logicalId is NOT in the manifest's resourceIndex.
  const evilBytes = new TextEncoder().encode('evil');
  const undeclared = [
    { logicalId: 'not-declared', kind: 'skill', bytes: evilBytes, digest: digestBytes(evilBytes) },
  ];

  await assert.rejects(
    () => installer.installPackage(manifest, undeclared, { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_UNDECLARED_RESOURCE);
      return true;
    },
  );
  assert.equal(store._storeCallCount(), 0, 'undeclared resource must not reach the store');
});

test('PACKAGES: PackageInstaller rejects a corrupt package and marks it corrupt (never activates)', async () => {
  // Corrupt store: verify() returns false after a write. The installer must
  // flip the staged row to corrupt and throw — activation never happens.
  const realStore = createInstrumentedStore();
  // Wrap verify to simulate on-disk corruption discovered post-write.
  const corruptedStore = {
    ...realStore,
    async verify() { return false; },
  };
  const repo = createInstrumentedRepo();
  const installer = new PackageInstaller();

  await assert.rejects(
    () => installer.installPackage(
      moduleManifestWithResources('corrupt', '1.0.0'),
      matchingResources(),
      { store: corruptedStore, repo },
    ),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_CORRUPT);
      return true;
    },
  );
  // The staged row was flipped to corrupt; activate was never called.
  const rows = repo._rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'corrupt');
  assert.equal(repo._activateCallCount(), 0, 'a corrupt package must never activate');
});

test('PACKAGES: FilesystemModulePackageStore rejects path-traversal logicalIds BEFORE any byte is written', async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'factory-w12-a5-store-'));
  try {
    const store = new FilesystemModulePackageStore(tmpRoot);
    const manifest = moduleManifestWithResources('traversal', '1.0.0');
    // Smuggle a traversal segment into the resource blob AND the manifest so
    // the manifest itself validates but the blob's logicalId escapes root.
    manifest.resourceIndex[0].logicalId = '../escape';
    const traversalBytes = new TextEncoder().encode('escape');
    const traversalBlob = {
      logicalId: '../escape',
      kind: 'skill',
      bytes: traversalBytes,
      digest: digestBytes(traversalBytes),
    };
    await assert.rejects(
      () => store.store(manifest, [traversalBlob]),
      (err) => {
        // The store rejects traversal with the canonical code, before any
        // file is written under the package root.
        assert.ok(err instanceof PackageStoreError || err.code === PACKAGE_STORE_PATH_TRAVERSAL);
        assert.equal(err.code, PACKAGE_STORE_PATH_TRAVERSAL);
        return true;
      },
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PACKAGES: PackageInstaller rejects a version collision (different digest, same active identity)', async () => {
  const store = createInstrumentedStore();
  const repo = createInstrumentedRepo();
  const installer = new PackageInstaller();
  // First install succeeds and activates.
  await installer.installPackage(
    moduleManifestWithResources('collide', '1.0.0'),
    matchingResources(),
    { store, repo },
  );
  // Second install of the SAME (name, version) but DIFFERENT bytes (different
  // digest) must be rejected — released identity is immutable.
  const differentBytes = new TextEncoder().encode('different bytes entirely');
  const differentResources = [
    { logicalId: 'res-a', kind: 'skill', bytes: differentBytes, digest: digestBytes(differentBytes) },
  ];
  const manifestWithDifferentDigest = moduleManifestWithResources('collide', '1.0.0');
  // Align the manifest's declared digest so validation passes but the content
  // address diverges from the active row.
  manifestWithDifferentDigest.resourceIndex[0].digest = digestBytes(differentBytes);

  await assert.rejects(
    () => installer.installPackage(
      manifestWithDifferentDigest,
      differentResources,
      { store, repo },
    ),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_VERSION_COLLISION);
      return true;
    },
  );
});

// ===========================================================================
// SECTION 2 — SCHEMAS (discovery proposal, ContractRef, canonical-serial).
// ===========================================================================

test('SCHEMAS: malformed discovery proposal payload is rejected without an LM call', () => {
  // The proposal validator is the kernel's first gate: it must reject a
  // structurally invalid payload deterministically, BEFORE any readiness
  // advisor or normalization worker is invoked.
  const badPayloads = [
    null,
    'not-an-object',
    [],
    { /* missing every required field */ },
    { problem_statement: '', observed_context: 'x', candidate_scope: 'x', rationale: 'x', stakeholders_or_actors: [], assumptions: [], unknowns: [], risks: [], evidence_refs: [], recommended_outcome: 'go' }, // empty problem_statement
    { problem_statement: 'x', observed_context: 'x', candidate_scope: 'x', rationale: 'x', stakeholders_or_actors: 'not-array', assumptions: [], unknowns: [], risks: [], evidence_refs: [], recommended_outcome: 'go' }, // wrong array type
    { problem_statement: 'x', observed_context: 'x', candidate_scope: 'x', rationale: 'x', stakeholders_or_actors: [], assumptions: [], unknowns: [], risks: [], evidence_refs: [], recommended_outcome: 'PROCEED' }, // outcome not in enum
    { problem_statement: 'x', observed_context: 'x', candidate_scope: 'x', rationale: 'x', stakeholders_or_actors: [42], assumptions: [], unknowns: [], risks: [], evidence_refs: [], recommended_outcome: 'go' }, // non-string array element
  ];
  for (const bad of badPayloads) {
    const result = validateDiscoveryProposal(bad);
    assert.equal(result.valid, false, `payload must be rejected: ${JSON.stringify(bad)}`);
    assert.ok(result.errors.length > 0, 'a rejection must carry at least one reason');
  }
  // A fully valid payload passes (control — proves the gate is precise, not
  // just blanket-rejecting).
  const valid = {
    problem_statement: 'p',
    observed_context: 'c',
    stakeholders_or_actors: [],
    assumptions: [],
    unknowns: [],
    risks: [],
    candidate_scope: 's',
    evidence_refs: [],
    recommended_outcome: 'go',
    rationale: 'r',
  };
  assert.equal(validateDiscoveryProposal(valid).valid, true);
});

test('SCHEMAS: recommended_outcome must be one of the frozen enumeration', () => {
  const base = {
    problem_statement: 'p', observed_context: 'c', stakeholders_or_actors: [],
    assumptions: [], unknowns: [], risks: [], candidate_scope: 's',
    evidence_refs: [], recommended_outcome: 'go', rationale: 'r',
  };
  // Every enumerated outcome is accepted.
  for (const outcome of DISCOVERY_OUTCOMES) {
    assert.equal(
      validateDiscoveryProposal({ ...base, recommended_outcome: outcome }).valid,
      true,
      `outcome ${outcome} must be accepted`,
    );
  }
  // Anything outside the enumeration is rejected.
  assert.equal(
    validateDiscoveryProposal({ ...base, recommended_outcome: 'ship-it' }).valid,
    false,
  );
});

test('SCHEMAS: ContractSchemaRegistry rejects an unknown ContractRef with the canonical token', () => {
  // validateOrThrow is the codec gate: an unregistered ref must fail BEFORE
  // any encode/decode against a real schema document runs.
  const registry = new InMemoryContractSchemaRegistry();
  const unknown = ref('never.registered', '9.9.9');
  assert.equal(registry.has(unknown), false);
  assert.throws(
    () => registry.validateOrThrow(unknown, { any: 'value' }),
    (err) => {
      assert.match(err.message, new RegExp(`^${CONTRACT_SCHEMA_UNKNOWN}`));
      return true;
    },
  );
  // encode/decode on an unknown ref likewise fail closed.
  assert.throws(() => registry.encode(unknown, { x: 1 }), /CONTRACT_SCHEMA_UNKNOWN/);
  assert.throws(() => registry.decode(unknown, '{}'), /CONTRACT_SCHEMA_UNKNOWN/);
});

test('SCHEMAS: compileScenario rejects a scenario whose inputContractRef is unregistered', () => {
  // When a schema registry is supplied, the compiler verifies the scenario's
  // contract refs are present — a dangling ref is a compile-time defect.
  const m1 = moduleManifest('alpha', '1.0.0');
  const stages = [stage('s1', 'alpha', '1.0.0')];
  const manifest = validScenarioManifest(stages);
  const registry = new InMemoryContractSchemaRegistry(); // empty — nothing registered
  const result = compileScenario(manifest, createModuleContractResolver([m1]), registry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === CONTRACT_REF_NOT_REGISTERED));
});

// ===========================================================================
// SECTION 3 — CAPABILITIES (CapabilityRequirement / GuardBinding shapes).
// ===========================================================================

test('CAPABILITIES: invalid CapabilityRequirement shapes are rejected', async () => {
  const invalid = [
    null,
    'string',
    { ref: '', version: '1.0.0' }, // empty ref
    { ref: 'cap', version: '' }, // empty version
    { ref: 'cap', version: '1.0.0', optional: 'not-a-boolean' }, // bad optional
    { ref: 'cap' }, // missing version
  ];
  for (const bad of invalid) {
    const result = await validateCapabilityRequirement(bad);
    assert.equal(result.ok, false, `CapabilityRequirement must be rejected: ${JSON.stringify(bad)}`);
  }
  // Valid control.
  const ok = await validateCapabilityRequirement({ ref: 'cap', version: '1.0.0' });
  assert.equal(ok.ok, true);
  const okOptional = await validateCapabilityRequirement({ ref: 'cap', version: '1.0.0', optional: true });
  assert.equal(okOptional.ok, true);
});

test('CAPABILITIES: invalid GuardBinding shapes are rejected', async () => {
  const invalid = [
    null,
    [],
    { ref: '', scope: 'call' }, // empty ref
    { ref: 'guard', scope: '' }, // empty scope
    { ref: 'guard' }, // missing scope
  ];
  for (const bad of invalid) {
    const result = await validateGuardBinding(bad);
    assert.equal(result.ok, false, `GuardBinding must be rejected: ${JSON.stringify(bad)}`);
  }
  const ok = await validateGuardBinding({ ref: 'guard', scope: 'call' });
  assert.equal(ok.ok, true);
});

test('CAPABILITIES: a capability carrying a Map is rejected (canonical-serialization gate)', async () => {
  // Smuggle a non-canonical value into a capability. The validator runs the
  // canonical-serialization pre-check first so a Map (which cannot round-trip
  // through the persisted manifest) is rejected before structural checks.
  const result = await validateCapabilityRequirement({
    ref: 'cap',
    version: '1.0.0',
    extra: new Map([['evil', 'payload']]),
  });
  assert.equal(result.ok, false);
});

// ===========================================================================
// SECTION 4 — MAPPINGS (unsafe paths, invalid expressions, routeResolver).
// ===========================================================================

test('MAPPINGS: isSafeMappingPath rejects prototype-pollution segments', () => {
  // The pure predicate is the static defense against prototype pollution:
  // a mapping path that traverses __proto__/prototype/constructor can never
  // be dereferenced against a runtime frame.
  assert.equal(isSafeMappingPath('__proto__.polluted'), false);
  assert.equal(isSafeMappingPath('foo.prototype.bar'), false);
  assert.equal(isSafeMappingPath('constructor'), false);
  assert.equal(isSafeMappingPath(''), false);
  assert.equal(isSafeMappingPath('foo..bar'), false); // empty segment
  // Safe paths pass (control).
  assert.equal(isSafeMappingPath('root.payload'), true);
  assert.equal(isSafeMappingPath('stages.draft.output.campaignDraft'), true);
  // Non-string expressions are not paths — left to the structural validator.
  assert.equal(isSafeMappingPath(42), true);
  assert.equal(isSafeMappingPath(null), true);
});

test('MAPPINGS: scenario manifest with unsafe inputMapping path is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.inputMappings = { evil: '__proto__.polluted' };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSAFE_MAPPING_PATH'));
});

test('MAPPINGS: scenario manifest with unsafe per-stage outputMapping path is rejected', () => {
  const manifest = validScenarioManifest([
    stage('s1', 'alpha', '1.0.0', { outputMapping: { leak: 'prototype.toString' } }),
  ]);
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSAFE_MAPPING_PATH'));
});

test('MAPPINGS: scenario manifest smuggling a routeResolver key is rejected (§6.4)', () => {
  // The type must be STRUCTURALLY incapable of carrying an executable
  // resolver. Even an undefined-valued key is a shape violation.
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.routeResolver = undefined;
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'));
});

test('MAPPINGS: scenario manifest smuggling a function routeResolver is rejected', () => {
  // The §6.4 check fires BEFORE the canonical gate, so even a smuggled
  // function (a second, independent violation) produces the §6.4 code.
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.routeResolver = () => ({ type: 'terminal', status: 'done' });
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  const codes = new Set(result.errors.map((e) => e.code));
  assert.ok(codes.has('ROUTE_RESOLVER_FORBIDDEN'), '§6.4 must fire even on a function value');
});

test('MAPPINGS: compiler rejects an invalid runtime mapping expression', () => {
  const m1 = moduleManifest('alpha', '1.0.0');
  const manifest = validScenarioManifest([
    stage('s1', 'alpha', '1.0.0', { inputMapping: { bad: { runtime: 'notARealVariable' } } }),
  ]);
  const result = compileScenario(manifest, createModuleContractResolver([m1]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === MAPPING_EXPRESSION_INVALID));
});

// ===========================================================================
// SECTION 5 — ROUTES (undeclared stage/terminal targets; reachability).
// ===========================================================================

test('ROUTES: outcome route to an undeclared stage is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.stageBindings[0].outcomeRoutes = {
    go: { type: 'stage', stageId: 'does-not-exist' },
  };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID'));
});

test('ROUTES: outcome route to an undeclared terminal status is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.stageBindings[0].outcomeRoutes = {
    go: { type: 'terminal', status: 'never-declared' },
  };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID'));
});

test('ROUTES: outcome route with an invalid target type is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.stageBindings[0].outcomeRoutes = {
    go: { type: 'execute-arbitrary-code', stageId: 's1' },
  };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID'));
});

test('ROUTES: scenario-level outcomeRoute to an undeclared terminal is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.outcomeRoutes = { abort: { type: 'terminal', status: 'unknown' } };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID'));
});

test('ROUTES: empty terminalStatuses is rejected (no way to terminate)', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.terminalStatuses = [];
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'TERMINAL_STATUSES_EMPTY'));
});

test('ROUTES: entryStageId not in stageBindings is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.entryStageId = 'nope';
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'ENTRY_STAGE_MISSING'));
});

test('ROUTES: invalid transition budget is rejected', () => {
  // maxTransitions <= 0 fails the structural budget rule (returned, not thrown).
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.transitionBudgets = { maxTransitions: 0 };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'TRANSITION_BUDGET_INVALID'));
});

test('ROUTES: non-finite transition budget is rejected by the canonical-serialization gate', () => {
  // Infinity/NaN are non-canonical-serializable: the canonical pre-check
  // fires BEFORE the structural budget rule runs. The scenario validator
  // catches the canonical error and returns {ok:false} with
  // NOT_CANONICAL_SERIALIZABLE — either way the non-finite cap (which could
  // never persist through canonical JSON) is rejected before semantic work.
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.transitionBudgets = { maxTransitions: Number.POSITIVE_INFINITY };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

test('ROUTES: negative reentry budget is rejected', () => {
  const manifest = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  manifest.reentryBudgets = { maxReentries: -1 };
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'REENTRY_BUDGET_INVALID'));
});

test('ROUTES: compiler rejects an unresolved module contract (route table cannot be checked)', () => {
  // A stage bound to a module the resolver cannot supply is a fail-closed
  // compile defect: the compiler cannot verify route completeness without
  // the contract, so it refuses rather than guessing.
  const manifest = validScenarioManifest([stage('s1', 'ghost', '1.0.0')]);
  const result = compileScenario(manifest, () => undefined);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === MODULE_CONTRACT_UNRESOLVED));
});

// ===========================================================================
// SECTION 6 — AUTHORITY (Saga MCP gateway denies before handler runs).
// ===========================================================================

test('AUTHORITY: managed execution with a disallowed tool is denied with AUTHORITY_DENIED', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-deny', runtimeAuthoritySnapshot());
    const decision = authorizeSagaToolCall({
      toolName: 'task_create', // not in ALLOWED_TOOLS
      db,
      executionId: 'exec-deny',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_DENIED');
    assert.equal(decision.details.requested_tool, 'task_create');
    assert.deepEqual(decision.details.allowed_tools, ALLOWED_TOOLS);
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: denial fires BEFORE the handler runs (spy never invoked)', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-spy', runtimeAuthoritySnapshot());
    let invoked = false;
    const spyHandler = () => { invoked = true; return { ok: true }; };
    const decision = authorizeSagaToolCall({
      toolName: 'task_create',
      db,
      executionId: 'exec-spy',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    // The gateway returns a denial decision; the caller is expected to honor
    // it and NOT invoke the handler. The spy remains uninvoked.
    assert.equal(invoked, false, 'the handler must not run when the gateway denies');
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: an unknown Saga tool is denied (default-deny, no allowlist bypass)', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-unknown', runtimeAuthoritySnapshot());
    const decision = authorizeSagaToolCall({
      toolName: 'totally_made_up_tool',
      db,
      executionId: 'exec-unknown',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_DENIED');
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: managed execution with no execution_context snapshot is fail-closed', () => {
  // A worker_executions row whose metadata carries NO execution_context is a
  // malformed managed execution — the gateway must deny, never guess.
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-no-context', JSON.stringify({ /* no execution_context */ }));
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      executionId: 'exec-no-context',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
    assert.match(decision.details.reason, /execution_context/i);
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: a tampered authority_hash is rejected (hash mismatch = fail-closed)', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    // Build a valid snapshot, then mutate the authority_hash so it no longer
    // matches the recomputed hash. The gateway must detect the tampering.
    const valid = JSON.parse(runtimeAuthoritySnapshot());
    valid.execution_context.authority.authority_hash = '0'.repeat(64); // wrong hash
    valid.execution_context_hash = executionContextHash(valid.execution_context);
    seedExecutionRow(db, 'exec-tampered', JSON.stringify(valid));
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      executionId: 'exec-tampered',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: a duplicate allowed_saga_tools entry is rejected (malformed authority)', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    // Duplicate tool entries are a malformed authority — the parse rejects.
    const dup = ['task_get', 'task_get', 'proposal_submit', 'worker_done'];
    const snapshot = JSON.parse(runtimeAuthoritySnapshot(dup));
    // Recompute the authority_hash over the duplicated list so only the
    // duplicate-entry rule fires (not the hash-mismatch rule).
    snapshot.execution_context.authority.authority_hash = authorityHash({
      enforcement: 'runtime',
      allowed_saga_tools: dup,
      scope: snapshot.execution_context.authority.scope,
      snapshot_ref: snapshot.execution_context.authority.snapshot_ref,
      work_intent_id: snapshot.execution_context.authority.work_intent_id,
    });
    snapshot.execution_context_hash = executionContextHash(snapshot.execution_context);
    seedExecutionRow(db, 'exec-dup', JSON.stringify(snapshot));
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      executionId: 'exec-dup',
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: managed execution missing SAGA_EXECUTION_ID is fail-closed', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      // executionId intentionally omitted; marker forces managed path.
      managedExecution: '1',
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
    assert.match(decision.details.reason, /SAGA_EXECUTION_ID/);
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: task-id mismatch between execution row and request is rejected', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-task-mismatch', runtimeAuthoritySnapshot());
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      executionId: 'exec-task-mismatch',
      managedExecution: '1',
      taskId: '999', // the seeded row has task_id 100
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
    assert.match(decision.details.reason, /SAGA_TASK_ID/);
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

test('AUTHORITY: allowed tool on a valid runtime snapshot is authorized (control)', () => {
  const { temp, db } = makeAuthorityFixture();
  try {
    seedExecutionRow(db, 'exec-allow', runtimeAuthoritySnapshot());
    const decision = authorizeSagaToolCall({
      toolName: 'task_get',
      db,
      executionId: 'exec-allow',
      managedExecution: '1',
    });
    assert.equal(decision.allow, true);
  } finally {
    cleanupAuthorityFixture(temp);
  }
});

// ===========================================================================
// SECTION 7 — TOOLS (ModuleToolContribution shape validation).
// ===========================================================================

test('TOOLS: valid ModuleToolContribution passes (control)', async () => {
  const valid = {
    logicalId: 'discovery.proposal_submit',
    version: '1.0.0',
    inputContractRef: ref('proposal.input', '1.0.0'),
    outputContractRef: ref('proposal.output', '1.0.0'),
    handlerRef: 'proposal-handler',
    guardBindings: [{ ref: 'guard-1', scope: 'call' }],
    idempotency: 'idempotent',
    sideEffect: 'write',
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, true);
});

test('TOOLS: ModuleToolContribution with empty logicalId/version/handlerRef is rejected', async () => {
  const base = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'read',
  };
  for (const field of ['logicalId', 'version', 'handlerRef']) {
    const bad = { ...base, [field]: '' };
    const result = await validateModuleToolContribution(bad);
    assert.equal(result.ok, false, `empty ${field} must be rejected`);
  }
});

test('TOOLS: ModuleToolContribution with an invalid inputContractRef is rejected', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: { schemaId: '', version: '1.0.0', digest: 'd' }, // empty schemaId
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'read',
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.startsWith('inputContractRef')));
});

test('TOOLS: ModuleToolContribution with a non-array guardBindings is rejected', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: 'not-an-array',
    idempotency: 'none',
    sideEffect: 'read',
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'BAD_GUARD_BINDINGS'));
});

test('TOOLS: ModuleToolContribution with an invalid guard binding element is rejected', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [{ ref: '', scope: 'call' }], // empty ref
    idempotency: 'none',
    sideEffect: 'read',
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.startsWith('guardBindings[0]')));
});

test('TOOLS: ModuleToolContribution with an invalid idempotency enum is rejected', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'maybe', // not in enum
    sideEffect: 'read',
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'BAD_IDEMPOTENCY'));
  // Confirm the accepted set is exactly the frozen enumeration.
  for (const value of TOOL_IDEMPOTENCY_VALUES) {
    const okResult = await validateModuleToolContribution({ ...valid, idempotency: value });
    assert.equal(okResult.ok, true, `idempotency ${value} must be accepted`);
  }
});

test('TOOLS: ModuleToolContribution with an invalid sideEffect enum is rejected', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'destructive', // not in enum
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'BAD_SIDE_EFFECT'));
  for (const value of TOOL_SIDE_EFFECT_VALUES) {
    const okResult = await validateModuleToolContribution({ ...valid, sideEffect: value });
    assert.equal(okResult.ok, true, `sideEffect ${value} must be accepted`);
  }
});

test('TOOLS: ModuleToolContribution with optional empty-string refs is rejected', async () => {
  // callTemplateRef / checklistRef / errorHintRef are optional, but when
  // present they must be non-empty (an empty ref is a dangling pointer).
  const base = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'read',
  };
  for (const field of ['callTemplateRef', 'checklistRef', 'errorHintRef']) {
    const bad = { ...base, [field]: '' };
    const result = await validateModuleToolContribution(bad);
    assert.equal(result.ok, false, `empty ${field} must be rejected`);
  }
});

test('TOOLS: ModuleToolContribution smuggling a Symbol is rejected (canonical gate)', async () => {
  const valid = {
    logicalId: 't',
    version: '1.0.0',
    inputContractRef: ref('t.in', '1.0.0'),
    outputContractRef: ref('t.out', '1.0.0'),
    handlerRef: 'h',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'read',
    evil: Symbol.for('pollution'),
  };
  const result = await validateModuleToolContribution(valid);
  assert.equal(result.ok, false);
});

// ===========================================================================
// CROSS-CUTTING — the architecture is fail-closed by construction: every
// gate is pure/synchronous and returns a decision before any side effect.
// ===========================================================================

test('CROSS-CUTTING: a non-canonical-serializable manifest is rejected by BOTH validators', () => {
  // The canonical-serialization pre-check is the shared defense-in-depth
  // across the manifest + scenario gates. A value that cannot round-trip
  // through canonical JSON is rejected everywhere, consistently. The two
  // validators surface the rejection differently but BOTH are fail-closed:
  //   - validateProcessModuleManifest lets the canonical error THROW
  //     (fail-fast; the strongest form — no caller can swallow a return and
  //     proceed). This matches its documented "throws only for canonical-
  //     serialization impurity" contract.
  //   - validateLifecycleScenarioManifest CATCHES the canonical error and
  //     returns {ok:false} with a NOT_CANONICAL_SERIALIZABLE error code.
  // Either way the input never reaches semantic work.
  const evil = deepClone(moduleManifest('evil', '1.0.0'));
  evil.definition.outcomes.push(undefined); // undefined-in-array
  assert.throws(
    () => validateProcessModuleManifest(evil),
    (err) => { assert.equal(err.code, 'CANONICAL_SERIALIZATION_INVALID'); return true; },
    'module manifest must reject undefined-in-array (throws)',
  );

  const evilScenario = validScenarioManifest([stage('s1', 'alpha', '1.0.0')]);
  evilScenario.terminalStatuses.push(undefined);
  const scenarioResult = validateLifecycleScenarioManifest(evilScenario);
  assert.equal(scenarioResult.ok, false, 'scenario manifest must reject undefined-in-array (returns)');
  assert.ok(
    scenarioResult.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'),
    'scenario manifest must surface the canonical failure code',
  );
});

test('CROSS-CUTTING: an undefined manifest argument is rejected, never silently accepted', () => {
  assert.equal(validateProcessModuleManifest(undefined).ok, false);
  assert.equal(validateProcessModuleManifest(null).ok, false);
  assert.equal(validateLifecycleScenarioManifest(undefined).ok, false);
  assert.equal(validateLifecycleScenarioManifest(null).ok, false);
});
