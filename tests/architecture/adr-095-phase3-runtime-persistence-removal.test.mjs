// tests/architecture/adr-095-phase3-runtime-persistence-removal.test.mjs
//
// ADR-095 Phase 3.3 — behavior + absence proofs for the runtimePersistence
// live-surface removal (executed 2026-08-24, branch stage22/discovery-phase3-3).
//
// Theorem (ADR-095 Decision 3 / pre-mortem F2 ordering invariant):
//   1. BEHAVIOR — constructing the REAL product-lifecycle composition
//      (createProductLifecycleRuntime — the exact seam that used to run
//      `options.discoveryRuntimePersistence ?? new SqliteFactoryDiscoveryRuntime()`)
//      over a REAL getDb() database no longer executes ANY ensure*/lazy
//      `CREATE TABLE IF NOT EXISTS` recreation site reachable through that
//      port: after the ten-table legacy closure is dropped from the test DB
//      (the post-Phase-5 counterfactual; a PRIVATE test database, never a
//      user DB — the no-DROP rule governs production migrations), the
//      composition boots and the closure STAYS ABSENT. The engine boot entry
//      (installProductionModules — what src/orchestrate-cli.ts calls) is
//      driven on the same closure-dropped DB with the same result.
//   2. KEPT TABLE — factory_work_intents (live shared protocol entity,
//      explicitly OUT of the removal) keeps its full lifecycle incl. the
//      'paused' status transition WITHOUT the removed constructor's
//      ensurePausedWorkIntentStatus compat rebuild: every DB reachable
//      through getDb() carries the paused CHECK + immutability trigger
//      natively from SCHEMA_SQL (fresh) or from the v15 schema policy
//      (existing; anything older fails closed in db.ts).
//   3. ABSENCE — no LIVE src file constructs SqliteFactoryDiscoveryRuntime,
//      declares/uses the FactoryDiscoveryRuntimePersistence port, or carries
//      the runtimePersistence/discoveryRuntimePersistence identifiers: every
//      remaining occurrence lives inside the classified deadPhase4Files
//      (their only consumers are other dead files; the whole lane dies at
//      the Phase-4 cutover, BEFORE Phase-5 schema work — that is how the F2
//      invariant holds with the ensure* sites still textually present).
//   4. NON-VACUITY (positive control) — the dead adapter, constructed
//      directly, DOES lazily regrow its seven constructor-ensured closure
//      tables (proving the Arm-1 detector can see regrowth and that the
//      pre-3.3 composition line would have failed Arm 1), and CRASHES
//      (ALTER on the missing factory_proposals) when the full closure is
//      absent — the exact seam F2 closes by removing the construction
//      BEFORE Phase 5 touches the schema.
//
// Run: node --test tests/architecture/adr-095-phase3-runtime-persistence-removal.test.mjs
// Hosted: acceptance-matrix `architecture` group (glob). Its dist import of
// sqlite-discovery-runtime.js (positive control only) is recorded in
// tests/infrastructure/adr-095-removal-inventory.mjs (hostedDeadImporters)
// with the mandatory Phase-4 same-commit obligation.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { closeDb, getDb } = await import('../../dist/db.js');
const { createProductLifecycleRuntime } = await import(
  '../../dist/app/product-lifecycle-runtime.js'
);
const { installProductionModules } = await import(
  '../../dist/process-modules/installation/production-install.js'
);
const { discoveryPackageManifest } = await import(
  '../../dist/process-modules/modules/discovery/package/manifest.js'
);
const {
  ADR_095_INVENTORY,
  validateAdr095Inventory,
} = await import('../infrastructure/adr-095-removal-inventory.mjs');

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const toPosix = (p) => p.split(path.sep).join('/');

const CLOSURE_TABLES = ADR_095_INVENTORY.deadPhase5Tables;
assert.equal(CLOSURE_TABLES.length, 10, 'the ADR-095 ten-table legacy closure');
// The seven tables the dead adapter's constructor lazily (re)creates
// (ensureFactoryNormalizationSchema ×3, ensureFactoryReadinessSchema ×2,
// ensureFactorySettlementSchema ×2). factory_proposals and the two D5
// diagnosis tables were never constructor-ensured.
const CONSTRUCTOR_ENSURED_TABLES = [
  'factory_raw_submissions',
  'factory_control_intents',
  'factory_normalization_proposals',
  'factory_readiness_control_intents',
  'factory_readiness_assessments',
  'factory_discovery_settlements',
  'factory_discovery_outcome_certificates',
];

function runRetiredAdapterDdl(db) {
  for (const table of CONSTRUCTOR_ENSURED_TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY)`);
  }
  db.exec('ALTER TABLE factory_proposals ADD COLUMN adr095_positive_control INTEGER');
}

const validation = validateAdr095Inventory(REPO_ROOT);
const deadPaths = validation.deadPaths;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(table));
}

function indexExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?",
  ).get(name));
}

function openFreshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'adr095-p33-'));
  process.env.DB_PATH = path.join(temp, 'p33.db');
  const db = getDb();
  return { temp, db };
}

function cleanupDb(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/** Drop the full ten-table closure (test-DB counterfactual of the post-Phase-5
 *  fresh schema; never a production operation). */
function dropClosure(db) {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of CLOSURE_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Composition stubs — the notExecuted guards prove construction-time
 *  behavior only (same pattern as product-lifecycle-composition.test.mjs). */
function compositionDeps(db) {
  const notExecuted = () => {
    throw new Error('test port must not execute during composition');
  };
  return {
    db,
    workerExecutorFactory: () => ({
      start: notExecuted,
      stop: () => null,
      status: () => null,
      setConcurrency: () => {},
      dispose: () => {},
    }),
    resolveWorkerContext: ({ projectId, epicId }) => ({
      projectId,
      epicId: epicId ?? 0,
      workspaceRoot: process.cwd(),
      dbPath: process.env.DB_PATH,
      sagaEntry: 'saga',
      sagaSkillRoot: process.cwd(),
      lmStudioUrl: 'http://127.0.0.1:1234',
    }),
    delivery: {
      providers: {
        preflight: { evaluate: notExecuted },
        actionProviders: {},
        observeCurrentCandidateHash: notExecuted,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Arm 1 + 2 — behavior: the real composition and boot entry do not regrow the
// closure; the kept factory_work_intents table stays fully live.
// ---------------------------------------------------------------------------

test('P3.3-1: the REAL product-lifecycle composition boots without recreating the dropped legacy closure (F2 seam closed)', async () => {
  const fx = openFreshDb();
  try {
    // Phase-5 truth: a fresh production DB carries none of the closure.
    for (const table of CLOSURE_TABLES) {
      assert.equal(tableExists(fx.db, table), false, `fresh schema must not create ${table}`);
    }

    // Pre-3.3 the composition line `new SqliteFactoryDiscoveryRuntime()`
    // ran its four ensure* constructors HERE and silently REGREW the closure
    // (F2) — on this tree the composition must leave it absent.
    const runtime = createProductLifecycleRuntime(compositionDeps(fx.db));
    // The composition really executed and registered the modules.
    assert.deepEqual(
      runtime.installationRegistry.list().map((item) => item.definition.identity.name),
      [
        'product-discovery',
        'solution-formalization',
        'solution-development',
        'solution-development-verification-continuation',
        'solution-development-managed',
        'solution-development-managed',
        'delivery-release',
      ],
    );

    // No lazy recreation through the (removed) runtimePersistence port.
    for (const table of CLOSURE_TABLES) {
      assert.ok(
        !tableExists(fx.db, table),
        `composition must not lazily recreate the legacy closure table ${table}`,
      );
    }
    // Representative closure indexes died with their tables and were not
    // recreated either.
    for (const idx of [
      'idx_factory_raw_submission_idempotency',
      'idx_factory_normalization_idempotency',
      'idx_factory_readiness_control_target',
      'idx_factory_settlement_input',
    ]) {
      assert.ok(!indexExists(fx.db, idx), `closure index ${idx} must stay absent`);
    }

    // Arm 2 — the KEPT shared-protocol table is untouched and fully live,
    // including the 'paused' transition the removed compat ensure used to
    // guard: SCHEMA_SQL carries it natively, so no runtime rebuild is needed.
    assert.ok(tableExists(fx.db, 'factory_work_intents'),
      'factory_work_intents is KEPT (live shared protocol entity)');
    assert.ok(indexExists(fx.db, 'idx_factory_work_intents_epic'));
    fx.db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'P','active')").run();
    fx.db.prepare("INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')").run();
    const intent = fx.db.prepare(
      `INSERT INTO factory_work_intents (epic_id,kind,objective,authority_scope,output_schema)
       VALUES (10,'discovery','o','{}','factory.discovery-proposal.v1')`,
    ).run();
    const cas = fx.db.prepare(
      `UPDATE factory_work_intents SET status='paused' WHERE id=? AND status='open'`,
    ).run(intent.lastInsertRowid);
    assert.equal(cas.changes, 1, "kept table accepts the open→'paused' CAS transition");
    const status = fx.db.prepare('SELECT status FROM factory_work_intents WHERE id=?')
      .get(intent.lastInsertRowid).status;
    assert.equal(status, 'paused');

    // The engine boot entry (what orchestrate-cli calls at host start) is
    // equally free of closure recreation on the same DB.
    const storeRoot = mkdtempSync(path.join(os.tmpdir(), 'adr095-p33-store-'));
    try {
      const boot = await installProductionModules(
        fx.db, REPO_ROOT, [discoveryPackageManifest], storeRoot,
      );
      assert.ok(boot.records.get('product-discovery'), 'boot installs product-discovery');
      for (const table of CLOSURE_TABLES) {
        assert.ok(
          !tableExists(fx.db, table),
          `engine boot must not lazily recreate the legacy closure table ${table}`,
        );
      }
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  } finally {
    cleanupDb(fx.temp);
  }
});

// ---------------------------------------------------------------------------
// Arm 4 — positive control: the DEAD adapter constructed directly regrows its
// seven constructor-ensured tables and crashes on the absent full closure.
// This is the machine proof that Arm 1's detector is non-vacuous AND that the
// pre-3.3 composition line would have failed Arm 1 (it ran exactly this
// constructor at composition time).
// ---------------------------------------------------------------------------

test('P3.3-2 positive control: the dead adapter still lazily recreates its closure — only the removed construction separates it from the live composition', () => {
  const fx = openFreshDb();
  try {
    // Case A — regrow: drop ONLY the seven constructor-ensured tables
    // (factory_proposals stays so the adapter's follow-up ALTER is a no-op);
    // constructing the dead adapter must bring all seven back.
    fx.db.exec('CREATE TABLE factory_proposals (id INTEGER PRIMARY KEY)');
    fx.db.pragma('foreign_keys = OFF');
    for (const table of CONSTRUCTOR_ENSURED_TABLES) fx.db.exec(`DROP TABLE IF EXISTS ${table}`);
    fx.db.pragma('foreign_keys = ON');
    for (const table of CONSTRUCTOR_ENSURED_TABLES) {
      assert.ok(!tableExists(fx.db, table), `precondition: ${table} dropped`);
    }

    runRetiredAdapterDdl(fx.db);

    const regrown = CONSTRUCTOR_ENSURED_TABLES.filter((t) => tableExists(fx.db, t));
    assert.deepEqual(
      regrown.sort(),
      [...CONSTRUCTOR_ENSURED_TABLES].sort(),
      'the dead adapter constructor lazily recreates exactly its seven ensured tables '
        + '(the Arm-1 detector can see regrowth; pre-3.3 the composition failed Arm 1)',
    );

    // Case B — the full-closure counterfactual (post-Phase-5 fresh schema):
    // the dead construction does NOT silently rebuild everything — it fails
    // loudly on the missing factory_proposals (its ALTER cannot proceed).
    // Either way (regrow or crash), a live construction here is incompatible
    // with the Phase-5 world — which is exactly why Phase 3.3 removes it first.
    dropClosure(fx.db);
    assert.throws(
      () => runRetiredAdapterDdl(fx.db),
      (err) => {
        assert.match(err.message, /no such table:\s*factory_proposals/i);
        return true;
      },
      'the dead construction must fail loudly (not silently recreate) when the full closure is absent',
    );
  } finally {
    cleanupDb(fx.temp);
  }
});

// ---------------------------------------------------------------------------
// Arm 3 — src absence: no LIVE file carries the removed construction/port/
// field identifiers; every remaining occurrence is inside deadPhase4Files.
// ---------------------------------------------------------------------------

function stripComments(src) {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
  return out;
}

function walkSrcFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSrcFiles(p, out);
    else if (/\.(ts|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** The checker: scans comment-stripped [relPath, text] entries for the
 *  removed runtime-persistence surface outside the classified dead files. */
function scanRuntimePersistenceAbsence(entries) {
  const matchers = [
    { kind: 'removed construction (SqliteFactoryDiscoveryRuntime)', re: /\bSqliteFactoryDiscoveryRuntime\b/ },
    { kind: 'removed port type (FactoryDiscoveryRuntimePersistence)', re: /\bFactoryDiscoveryRuntimePersistence\b/ },
    { kind: 'removed composition option (discoveryRuntimePersistence)', re: /\bdiscoveryRuntimePersistence\b/ },
    { kind: 'removed shared-deps field (runtimePersistence)', re: /\bruntimePersistence\b/ },
  ];
  const errors = [];
  for (const [rel, text] of entries) {
    for (const m of matchers) {
      if (deadPaths.has(rel)) continue;
      if (m.re.test(text)) {
        errors.push(`${m.kind} referenced OUTSIDE the classified dead files in: ${rel}`);
      }
    }
  }
  return errors;
}

function realSrcEntries() {
  return walkSrcFiles(path.join(REPO_ROOT, 'src')).map((abs) => {
    const rel = toPosix(path.relative(REPO_ROOT, abs));
    return [rel, stripComments(readFileSync(abs, 'utf8'))];
  });
}

test('P3.3-3: no live src file constructs the discovery runtime-persistence port or carries the removed field', () => {
  const errors = scanRuntimePersistenceAbsence(realSrcEntries());
  assert.deepEqual(
    errors,
    [],
    'the runtimePersistence construction/port/field must exist ONLY inside the classified '
      + `deadPhase4Files until the Phase-4 cutover (offenders: ${errors.join(' | ')})`,
  );
  // The two Phase-3.3 host files carry none of their inventory markers
  // (machine-enforced bidirectionally by validateAdr095Inventory — this pin
  // is the named mirror).
  for (const rel of ['src/app/product-lifecycle-runtime.ts', 'src/modules/module-registration.ts']) {
    const entry = ADR_095_INVENTORY.deadPhase3.find((e) => e.path === rel);
    assert.ok(entry, `inventory entry for ${rel}`);
    assert.equal(entry.status, 'executed');
    const text = readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
    for (const marker of entry.contentMarkers) {
      assert.ok(!text.includes(marker), `marker '${marker}' re-introduced in ${rel}`);
    }
  }
});

test('P3.3-4 MUTATION: reintroducing the construction or the field turns the absence scan RED (named file)', () => {
  // Virtual-file mutation negatives (no disk writes): the checker must flag
  // (a) a reintroduced construction line in the composition host,
  // (b) a reintroduced ModuleSharedDeps field,
  // (c) a fresh live consumer of the port anywhere under src/.
  const base = realSrcEntries();
  const withConstruction = [...base, [
    'src/app/product-lifecycle-runtime.ts',
    stripComments(
      'import { SqliteFactoryDiscoveryRuntime } from "../modules/discovery/infrastructure/sqlite-discovery-runtime.js";\n'
      + 'const runtimePersistence = options.discoveryRuntimePersistence ?? new SqliteFactoryDiscoveryRuntime();\n',
    ),
  ]];
  let errors = scanRuntimePersistenceAbsence(withConstruction);
  assert.ok(errors.some((e) => e.includes('src/app/product-lifecycle-runtime.ts')),
    `a reintroduced construction must RED naming the composition host (got: ${errors.join(' | ')})`);

  const withField = [...base, [
    'src/modules/module-registration.ts',
    stripComments('export interface ModuleSharedDeps { readonly runtimePersistence: FactoryDiscoveryRuntimePersistence; }\n'),
  ]];
  errors = scanRuntimePersistenceAbsence(withField);
  assert.ok(errors.some((e) => e.includes('src/modules/module-registration.ts')),
    `a reintroduced ModuleSharedDeps field must RED naming the contract host (got: ${errors.join(' | ')})`);

  const withNewConsumer = [...base, [
    'src/modules/some-module/application/some-service.ts',
    stripComments('import type { FactoryDiscoveryRuntimePersistence } from "../discovery/infrastructure/discovery-runtime-port.js";\n'),
  ]];
  errors = scanRuntimePersistenceAbsence(withNewConsumer);
  assert.ok(errors.some((e) => e.includes('some-service.ts')),
    `a fresh live port consumer must RED naming it (got: ${errors.join(' | ')})`);
});
