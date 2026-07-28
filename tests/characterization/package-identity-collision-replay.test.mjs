// W0-A5 — Characterization: package identity, version collision, mutation, replay.
//
// This file PINS THE CURRENT (prototype, incomplete) package-identity behavior
// so Wave 2 can correct it (immutable bytes, version-collision rejection,
// installation pinning) with the gap made explicit.
//
// Plan refs:
//   §0.3.6  — W0-A5 owns this surface.
//   §5      — Process Module Package.
//   §5.5.x  — target production behavior (immutable store, version immutability,
//             installation pinning, digest verification, handler/policy
//             digest binding).
//   §5.6    — the prototype "must not be accepted as final until it stores
//             immutable bytes, uses serializable records instead of Map,
//             enforces version immutability, and makes installation pinning
//             mandatory for the new execution path."
//   §13.15  — "the in-progress package prototype adds digests and installation
//             rows but currently hashes mutable source files without preserving
//             immutable package bytes and allows multiple digests under the
//             same released version."
//
// Every pinned gap is tagged `// WAVE 2 WILL FIX`.
//
// Anti-scope: this file is ASSERT-CURRENT-BEHAVIOR only. No production source
// is changed. No ModulePackageStore or installation table is added (Wave 2).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..', '..');

// --- Under test ------------------------------------------------------------

const { processModuleKey } = await import(
  '../../dist/process-modules/domain/process-module.js'
);
const { ProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/application/process-module-installation-registry.js'
);
const { createBuiltInProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/modules/installations.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
const { sha256Hex, canonicalJson } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const {
  SqliteManagedProductionLedger,
  ensureManagedProductionLedgerSchema,
} = await import(
  '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js'
);

// --- Fixtures ---------------------------------------------------------------

function fakeExecutor({ moduleRef, kind = 'legacy-adapter', marker = 'A' } = {}) {
  return {
    moduleRef,
    kind,
    marker,
    async execute(_module, _ctx) {
      return { outcome: 'go', output: null, certificate: null, authority: null };
    },
  };
}

const DISCOVERY_REF = { name: 'product-discovery', version: '3.0.0' };
const FORMALIZATION_REF = { name: 'solution-formalization', version: '1.0.0' };
const DEVELOPMENT_REF = { name: 'solution-development', version: '1.0.0' };
const DELIVERY_REF = { name: 'delivery-release', version: '1.0.0' };

// Identity strings of the four production module packages. See baseline §"Modules"
// (4 production packages).
const PRODUCTION_MODULE_KEYS = [
  'product-discovery@3.0.0',
  'solution-formalization@1.0.0',
  'solution-development@1.0.0',
  'delivery-release@1.0.0',
];

const PRODUCTION_MODULES = [
  discoveryProcessModule,
  formalizationProcessModule,
  developmentProcessModule,
  deliveryProcessModule,
];

// A minimal but valid generic-flow-style executor that wires to a definition
// with at least one kernel node. Used to exercise the fail-fast coverage path.
function genericFlowExecutor({ moduleRef }) {
  return {
    moduleRef,
    kind: 'generic-flow',
    async execute(_module, _ctx) {
      return { outcome: 'completed', output: null, certificate: null, authority: null };
    },
  };
}

// ===========================================================================
// 1. In-memory installation registry
// ===========================================================================

test('1a. createBuiltInProcessModuleInstallationRegistry returns the 4 production installations', () => {
  // Current behavior: the factory accepts a caller-supplied installation list.
  // The 4 production packages each have a Definition; paired with executors
  // they form the built-in registry used by product-lifecycle-runtime.ts.
  const registry = createBuiltInProcessModuleInstallationRegistry([
    { definition: discoveryProcessModule, executor: genericFlowExecutor({ moduleRef: DISCOVERY_REF }) },
    { definition: formalizationProcessModule, executor: genericFlowExecutor({ moduleRef: FORMALIZATION_REF }) },
    { definition: developmentProcessModule, executor: genericFlowExecutor({ moduleRef: DEVELOPMENT_REF }) },
    { definition: deliveryProcessModule, executor: genericFlowExecutor({ moduleRef: DELIVERY_REF }) },
  ]);

  const installed = registry.list();
  assert.equal(installed.length, 4, 'expected the 4 production installations');

  const installedKeys = installed
    .map((i) => processModuleKey(i.definition.identity))
    .sort();
  assert.deepEqual(
    installedKeys,
    [...PRODUCTION_MODULE_KEYS].sort(),
    'built-in registry must surface the 4 production module identities',
  );

  for (const ref of [DISCOVERY_REF, FORMALIZATION_REF, DEVELOPMENT_REF, DELIVERY_REF]) {
    assert.ok(registry.get(ref), `registry must resolve ${processModuleKey(ref)} by ref`);
  }
});

test('1b. registry lookup-by-ref: get() returns null, require() throws for unknown ref', () => {
  const registry = new ProcessModuleInstallationRegistry();
  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });

  // Known ref resolves.
  assert.equal(
    registry.get(DISCOVERY_REF).definition.identity.name,
    'product-discovery',
  );

  // Unknown ref: get() returns null (read-only lookup).
  const unknown = { name: 'does-not-exist', version: '9.9.9' };
  assert.equal(registry.get(unknown), null);

  // Unknown ref: require() throws — the Runtime uses this when it must execute.
  assert.throws(
    () => registry.require(unknown),
    /is not installed/,
  );
});

test('1c. registry fail-fast: invalid Definition is rejected at register time', () => {
  // The registry re-validates the Definition structurally (catalog validator)
  // before binding. An invalid Definition never reaches the in-memory Map.
  const registry = new ProcessModuleInstallationRegistry();
  const broken = {
    ...discoveryProcessModule,
    identity: { ...discoveryProcessModule.identity, version: 'not-semver' },
  };
  assert.throws(
    () => registry.register({
      definition: broken,
      executor: fakeExecutor({
        moduleRef: { name: 'product-discovery', version: 'not-semver' },
      }),
    }),
    /ProcessModuleInstallationRegistrationError/,
  );
  // And nothing was retained.
  assert.equal(registry.list().length, 0);
});

test('1d. GAP: registry is in-memory only — two instances are independent, no shared persisted state', () => {
  // WAVE 2 WILL FIX: there is NO persisted installation record, NO content-
  // addressed bytes, NO digest. Plan §5.6 (must "store immutable bytes" and
  // "make installation pinning mandatory") and §5.5.6 (persist installation
  // identity, manifest snapshot, package digest, immutable store location).
  //
  // Current behavior: every registry is a fresh in-memory Map. Two
  // construction sites (composition-root.ts:385 and product-lifecycle-
  // runtime.ts:362) independently rebuild the registry on every process.
  const a = new ProcessModuleInstallationRegistry();
  const b = new ProcessModuleInstallationRegistry();
  a.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF }),
  });

  // b knows nothing about a's installation.
  assert.equal(a.list().length, 1);
  assert.equal(b.list().length, 0);
  assert.equal(b.get(DISCOVERY_REF), null);

  // WAVE 2 WILL FIX: there is no saga3_process_module_installations table.
  // Confirm absence in the canonical fresh-DB schema.
  const schemaSql = readSchemaSql();
  assert.ok(
    !/saga3_process_module_installations/i.test(schemaSql),
    'no persisted process_module_installations table today (plan §5.5.6 / baseline §"saga3_process_module_installations does NOT exist")',
  );
});

// ===========================================================================
// 2. Module identity & key
// ===========================================================================

test('2a. processModuleKey has the shape name@version', () => {
  assert.equal(
    processModuleKey({ name: 'product-discovery', version: '3.0.0' }),
    'product-discovery@3.0.0',
  );
  assert.equal(
    processModuleKey({ name: 'solution-formalization', version: '1.0.0' }),
    'solution-formalization@1.0.0',
  );
});

test('2b. GAP: two modules with same name+version but different content produce the SAME key (identity has NO digest today)', () => {
  // WAVE 2 WILL FIX: identity has NO digest, so same name+version with
  // different content yields the same key. Plan §5.6 ("enforces version
  // immutability") and §5.5.8 ("reject a different digest under an already
  // released name and version") require the key/digest to be bound.

  // Two definitions with the SAME name+version but visibly different content
  // (different identity.description). The key is identical because the key is
  // a pure function of name@version.
  const modA = discoveryProcessModule;
  const modB = {
    ...discoveryProcessModule,
    identity: {
      ...discoveryProcessModule.identity,
      description: 'tampered-description-content',
    },
  };

  const keyA = processModuleKey(modA.identity);
  const keyB = processModuleKey(modB.identity);

  assert.equal(keyA, keyB, 'same name@version yields same key regardless of content');
  assert.equal(keyA, 'product-discovery@3.0.0');

  // And the key is a pure function of name+version — no third component.
  assert.equal(
    processModuleKey({ name: 'x', version: '1' }),
    processModuleKey({ name: 'x', version: '1' }),
  );
});

// ===========================================================================
// 3. ManagedProductionLedger
// ===========================================================================

test('3a. ManagedArtifactProductionRecord shape: carries contentHash, deterministic for same content', () => {
  // The ledger stamps ManagedArtifactProductionRecord with contentHash for
  // each mutation made by a managed worker execution. Pin the record shape and
  // the determinism of the hashing primitive.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'w0a5-ledger-'));
  try {
    const dbPath = path.join(tmp, 'ledger.db');
    const db = new Database(dbPath);
    ensureManagedProductionLedgerSchema(db);

    // Insert two ledger rows with the same artifact content_hash. The
    // recorded contentHash must be byte-identical.
    const processRunId = seedProcessRun(db, { epicId: 1, projectId: 1, moduleRef: 'product-discovery@3.0.0' });
    insertArtifactLedgerRow(db, {
      processRunId,
      moduleRef: 'product-discovery@3.0.0',
      nodeId: 'discovery-lm',
      intentId: 7,
      taskId: 11,
      executionId: 'exec-A',
      artifactId: 101,
      artifactType: 'discovery-proposal',
      artifactStatus: 'accepted',
      contentHash: 'a'.repeat(64),
      operation: 'create',
    });

    const ledger = new SqliteManagedProductionLedger(db);
    const rows = ledger.listArtifactsForExecution({
      processRunId,
      moduleRef: 'product-discovery@3.0.0',
      nodeId: 'discovery-lm',
      intentId: 7,
      taskId: 11,
      executionId: 'exec-A',
    });
    assert.equal(rows.length, 1);
    const rec = rows[0];

    // Pin the record shape.
    assert.equal(typeof rec.ledgerId, 'number');
    assert.equal(rec.processRunId, processRunId);
    assert.equal(rec.moduleRef, 'product-discovery@3.0.0');
    assert.equal(rec.nodeId, 'discovery-lm');
    assert.equal(rec.intentId, 7);
    assert.equal(rec.taskId, 11);
    assert.equal(rec.executionId, 'exec-A');
    assert.equal(rec.artifactId, 101);
    assert.equal(rec.artifactType, 'discovery-proposal');
    assert.equal(rec.artifactStatus, 'accepted');
    assert.equal(rec.contentHash, 'a'.repeat(64));
    assert.equal(rec.operation, 'create');
    assert.equal(typeof rec.recordedAt, 'string');

    // Determinism: same artifact content_hash inserted twice (different
    // artifact id) keeps identical contentHash — hashing is over stored bytes.
    const processRunId2 = seedProcessRun(db, { epicId: 1, projectId: 1, moduleRef: 'product-discovery@3.0.0' });
    insertArtifactLedgerRow(db, {
      processRunId: processRunId2,
      moduleRef: 'product-discovery@3.0.0',
      nodeId: 'discovery-lm',
      intentId: 7,
      taskId: 12,
      executionId: 'exec-B',
      artifactId: 102,
      artifactType: 'discovery-proposal',
      artifactStatus: 'accepted',
      contentHash: 'a'.repeat(64),
      operation: 'create',
    });
    const ledger2 = new SqliteManagedProductionLedger(db);
    const rows2 = ledger2.listArtifactsForExecution({
      processRunId: processRunId2,
      moduleRef: 'product-discovery@3.0.0',
      nodeId: 'discovery-lm',
      intentId: 7,
      taskId: 12,
      executionId: 'exec-B',
    });
    assert.equal(rows2[0].contentHash, rows[0].contentHash);

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('3b. GAP: ledger is keyed by board/task vocab (processRunId/moduleRef/nodeId/intentId/taskId/executionId)', () => {
  // WAVE 3 CLEANUP TARGET (baseline §"Cross-cutting refactor seams" #3:
  // board/task/WorkIntent vocab leak). The ManagedExecutionProductQuery
  // key surface mixes process-module vocabulary (processRunId, moduleRef,
  // nodeId) with board/task vocabulary (intentId, taskId, executionId).
  //
  // Pin the CURRENT key columns so Wave 3 can mechanically find and clean
  // every site that depends on this surface.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'w0a5-key-'));
  try {
    const db = new Database(path.join(tmp, 'k.db'));
    ensureManagedProductionLedgerSchema(db);

    // Read back the actual table definition.
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='saga3_managed_artifact_productions'")
      .get();
    const sql = String(ddl.sql);
    for (const col of [
      'process_run_id',
      'module_ref',
      'node_id',
      'intent_id',     // board/task vocab — WAVE 3 CLEANUP TARGET
      'task_id',       // board/task vocab — WAVE 3 CLEANUP TARGET
      'execution_id',  // board/task vocab — WAVE 3 CLEANUP TARGET
      'content_hash',
    ]) {
      assert.ok(
        sql.includes(col),
        `key column ${col} present in saga3_managed_artifact_productions`,
      );
    }
    // WAVE 3 CLEANUP TARGET: confirm the index that hard-codes this
    // composite board+process key.
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_saga3_managed_artifact_product_execution'")
      .get();
    assert.ok(
      String(idx?.sql ?? '').includes('intent_id')
        && String(idx?.sql ?? '').includes('task_id')
        && String(idx?.sql ?? '').includes('execution_id'),
      'execution index mixes process + board/task vocabulary',
    );
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. Version collision behavior (current)
// ===========================================================================

test('4a. CURRENT behavior: re-registering the SAME module ref (collision on name@version) throws', () => {
  // The registry prevents two installations of the same name@version inside
  // ONE registry instance — but only via an in-memory "already registered"
  // guard. It does NOT compare digests; two installations with identical
  // name@version but DIFFERENT executor factories still collide as same-key.
  const registry = new ProcessModuleInstallationRegistry();

  registry.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF, marker: 'A' }),
  });

  // A second installation with a visibly different executor (different
  // `marker`) but the same module ref key.
  assert.throws(
    () => registry.register({
      definition: discoveryProcessModule,
      executor: fakeExecutor({ moduleRef: DISCOVERY_REF, marker: 'B' }),
    }),
    /already registered/,
  );
});

test('4b. GAP: collision check is keyed by name@version only, not by content/digest', () => {
  // WAVE 2 WILL FIX: Plan §5.5.8 mandates rejection of "a different digest
  // under an already released name and version" (development mode must use a
  // prerelease version or explicit build identity). Today there is NO digest
  // component in the collision key.
  //
  // Current behavior: two modules with same name+version but different
  // content are treated as the SAME key, so the second registration in the
  // SAME registry instance is rejected as "already registered" (and, when
  // installed in SEPARATE registry instances, they coexist silently — neither
  // instance knows about the other, no cross-instance comparison).
  const a = new ProcessModuleInstallationRegistry();
  const b = new ProcessModuleInstallationRegistry();

  // Module A: pristine discovery module.
  // Module B: discovery identity but mutated content (different
  // identity.description — survives structural validation, same name@version).
  const mutatedDiscovery = {
    ...discoveryProcessModule,
    identity: {
      ...discoveryProcessModule.identity,
      description: 'mutated-description-content',
    },
  };

  a.register({
    definition: discoveryProcessModule,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF, marker: 'pristine' }),
  });

  // b silently accepts a DIFFERENT-content module under the same key — there is
  // no cross-instance comparison, no digest check.
  b.register({
    definition: mutatedDiscovery,
    executor: fakeExecutor({ moduleRef: DISCOVERY_REF, marker: 'mutated' }),
  });

  // Both instances claim to hold product-discovery@3.0.0 with different
  // underlying Definitions — neither knows the other exists.
  assert.equal(
    a.require(DISCOVERY_REF).definition.identity.description,
    discoveryProcessModule.identity.description,
  );
  assert.equal(
    b.require(DISCOVERY_REF).definition.identity.description,
    'mutated-description-content',
  );

  // And the key derived from each is identical — identity has no digest
  // component to distinguish them.
  assert.equal(
    processModuleKey(discoveryProcessModule.identity),
    processModuleKey(mutatedDiscovery.identity),
  );
});

// ===========================================================================
// 5. Resource mutation behavior (current)
// ===========================================================================

test('5a. sha256Hex hashes in-memory JSON, NOT source file bytes — same JSON ⇒ same hash', () => {
  // The current prototype hashing primitive (shared/canonical-json.ts, a
  // re-export of saga3/shared/discovery-canonical.ts) hashes the CANONICAL
  // JSON of an in-memory value. It is pure: node:crypto only, no I/O.
  const a = sha256Hex({ b: 2, a: 1, c: [3, 2, 1] });
  const b = sha256Hex({ a: 1, b: 2, c: [3, 2, 1] }); // key order differs
  assert.equal(a, b, 'canonical JSON sorts keys, so order is irrelevant');
  assert.match(a, /^[0-9a-f]{64}$/, '64-char lowercase hex');
});

test('5b. GAP: hashing is over mutable content, mutating that content changes the hash (not replay-safe)', () => {
  // WAVE 2 WILL FIX: Plan §13.15 — "the in-progress package prototype adds
  // digests and installation rows but currently hashes mutable source files
  // without preserving immutable package bytes." The current hashing
  // primitive operates on in-memory JSON values derived from mutable
  // configuration/code; mutating the source content produces a different
  // hash, so a recorded content_hash cannot be replayed against a frozen
  // byte sequence.
  //
  // Demonstrate by hashing two artifacts that differ only by one byte of
  // content. The hashes differ — there is no immutable byte-store today.
  const manifestA = {
    schema: 'saga3.formalization-baseline.v1',
    artifactIds: [1, 2, 3],
    artifactHashes: ['h1', 'h2', 'h3'],
  };
  const manifestB = {
    ...manifestA,
    artifactHashes: ['h1', 'h2', 'h3-MUTATED'],
  };

  const hashA = sha256Hex(manifestA);
  const hashB = sha256Hex(manifestB);

  assert.notEqual(hashA, hashB, 'mutating content changes the hash');
  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.match(hashB, /^[0-9a-f]{64}$/);

  // canonicalJson is the same primitive used by formalization-installation
  // (acceptanceBaselineHash, contentHash over manifests), development-
  // installation, delivery-installation and ManagedProductionLedger trace
  // hashing. Pin that canonicalJson over identical input is byte-identical.
  assert.equal(canonicalJson(manifestA), canonicalJson({ ...manifestA }));
});

test('5c. GAP: no source-file hashing path in process-modules — all hashing is over in-memory JSON manifests', () => {
  // WAVE 2 WILL FIX: Plan §5.5.5 ("Atomically copy the complete package into
  // an immutable content-addressed store"). Today NO process-module code
  // hashes source files for replay. All sha256Hex/createHash usage in
  // process-modules hashes IN-MEMORY JSON values (manifests, payloads,
  // artifact snapshots). The "source files" of §13.15 are the live TS/JSON
  // in the repo at runtime — they are not captured into a byte-store.
  //
  // Pin by mutating a temp JSON file and confirming sha256Hex of its parsed
  // contents tracks the mutation (the file is never itself the hash input —
  // the parsed canonical form is).
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'w0a5-mut-'));
  try {
    const fileA = path.join(tmp, 'manifest.json');
    writeFileSync(fileA, JSON.stringify({ v: 1 }));
    const hashBefore = sha256Hex(JSON.parse(asText(fileA)));

    // Mutate the source file.
    writeFileSync(fileA, JSON.stringify({ v: 2 }));
    const hashAfter = sha256Hex(JSON.parse(asText(fileA)));

    assert.notEqual(hashBefore, hashAfter, 'mutating the source file mutates the derived hash');
    // WAVE 2 WILL FIX: the previous hashBefore is NOT replayable against
    // any preserved byte sequence — there is no immutable package bytes dir.
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// 6. Replay behavior (current gap)
// ===========================================================================

test('6a. GAP: there is NO replay-from-immutable-bytes path today (ModulePackageStore absent)', async () => {
  // WAVE 2 WILL FIX: Plan §5.5.7 ("Verify stored bytes against the digest
  // before activation and replay"). Today there is no ModulePackageStore,
  // no content-addressed store directory, no installation table — so there
  // is no replay-from-immutable-bytes path.
  //
  // Assert the absence of the symbol across both source and built dist.
  for (const sub of ['src/process-modules', 'dist/process-modules']) {
    const dir = path.join(root, sub);
    if (!existsSync(dir)) continue;
    const offenders = readdirRecursive(dir).filter((f) =>
      /ModulePackageStore|ContentAddressedStore|package-store/i.test(asTextSafe(f)),
    );
    assert.equal(
      offenders.length,
      0,
      `no ModulePackageStore symbol in ${sub} today (plan §5.5.7 / §5.6)`,
    );
  }

  // And no saga3_process_module_installations table in the canonical schema.
  const schemaSql = readSchemaSql();
  assert.ok(
    !/saga3_process_module_installations/i.test(schemaSql),
    'no persisted installation table today — replay-bytes cannot be pinned to a row',
  );

  // And the ManagedProductionLedger (the closest thing to a "production
  // record with contentHash") exposes NO method to fetch content by digest —
  // it can only list production records by execution key.
  const ledgerProto = Object.getPrototypeOf(new SqliteManagedProductionLedger(noopDbHandle()));
  const methods = Object.getOwnPropertyNames(ledgerProto);
  const replayish = methods.filter((m) =>
    /replay|fetchBytes|readPackage|store|getByDigest|loadImmutable/i.test(m),
  );
  assert.deepEqual(
    replayish,
    [],
    'ManagedProductionLedger has no replay/fetch-by-digest method today',
  );
});

// ===========================================================================
// Cross-cutting pin: no production module declares a digest in its identity
// ===========================================================================

test('7. GAP: none of the 4 production module identities carries a digest/build-id component', () => {
  // WAVE 2 WILL FIX: Plan §5.5.10 ("bind handler and policy identities to
  // actual packaged code or deployment bundle digests"). Today every
  // production module identity is name+version+kind+displayName+description —
  // no digest. Pin ProcessModuleIdentity shape so Wave 2 can extend it.
  for (const mod of PRODUCTION_MODULES) {
    const id = mod.identity;
    assert.ok(id.name, `${id.name} identity.name present`);
    assert.ok(id.version, `${id.name} identity.version present`);
    assert.ok(id.kind, `${id.name} identity.kind present`);
    // Identity has exactly the 5 declared fields — no digest.
    assert.deepEqual(
      Object.keys(id).sort(),
      ['description', 'displayName', 'kind', 'name', 'version'],
      `${id.name} identity has no digest/build-id field (plan §5.5.10)`,
    );
  }
});

// --- Helpers ----------------------------------------------------------------

function readSchemaSql() {
  // The canonical fresh-DB schema lives in src/schema.ts as a string template.
  // We read it as text rather than evaluate it, since we only assert absence.
  return readFileSync(path.join(root, 'src/schema.ts'), 'utf8');
}

function seedProcessRun(db, { epicId, projectId, moduleRef }) {
  // Minimal seed for saga3_process_runs so the FK on the ledger is satisfied.
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      epic_id INTEGER,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      input_schema TEXT,
      input_hash TEXT,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      initiated_by TEXT
    );
  `);
  const [name, version] = moduleRef.split('@');
  const info = db.prepare(
    `INSERT INTO saga3_process_runs (project_id, epic_id, module_name, module_version, module_ref_key, executor_kind, input_hash, idempotency_key, status, initiated_by)
     VALUES (?, ?, ?, ?, ?, 'generic-flow', ?, ?, 'completed', 'w0a5-test')`,
  ).run(projectId, epicId, name, version, moduleRef, '0'.repeat(64), `seed-${Math.random()}`);
  return Number(info.lastInsertRowid);
}

function insertArtifactLedgerRow(db, row) {
  ensureManagedProductionLedgerSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO saga3_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.processRunId,
    row.moduleRef,
    row.nodeId,
    row.intentId,
    row.taskId,
    row.executionId,
    row.artifactId,
    row.artifactType,
    row.artifactStatus,
    row.contentHash,
    row.operation,
  );
}

function asText(file) {
  return readFileSync(file, 'utf8');
}

function asTextSafe(file) {
  try {
    return asText(file);
  } catch {
    return '';
  }
}

function readdirRecursive(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readdirRecursive(full, acc);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

// Minimal stand-in for better-sqlite3 used only for prototype inspection
// (Object.getPrototypeOf on a SqliteManagedProductionLedger instance). The
// constructor only calls ensureManagedProductionLedgerSchema(db), which we
// short-circuit by passing an object whose exec() is a no-op.
function noopDbHandle() {
  return { exec() {}, prepare() { return { get() { return null; }, all() { return []; } }; } };
}
