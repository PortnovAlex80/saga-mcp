#!/usr/bin/env node
/**
 * HEX LIFECYCLE FLOW — deterministic end-to-end runner (no model).
 *
 * Drives the REAL Product Delivery lifecycle (discovery -> formalization ->
 * development -> delivery) with hex-lifecycle-input.json on a FRESH temp DB,
 * using stub module executors (as in hardening-product-delivery-e2e.test.mjs).
 *
 * This proves the ORCHESTRATOR + RUNTIME + PERSISTENCE + HANDOFF chain accept
 * the real input and reach the `released` terminal status, independent of LM
 * authoring quality. The stubs replace LM work with deterministic payloads.
 *
 * Run: node run-hex-lifecycle.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const prevDbPath = process.env.DB_PATH;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hex-flow-'));
const dbPath = path.join(tmp, 'lifecycle.db');
process.env.DB_PATH = dbPath;

let exitCode = 0;
try {
  const { getDb, closeDb } = await import('./dist/db.js');
  const { sha256Hex } = await import(
    './dist/process-modules/shared/canonical-json.js'
  );
  const { SqliteLifecycleRunRepository } = await import(
    './dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
  );
  const { SqliteProcessRunRepository } = await import(
    './dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const { LifecycleOrchestrator } = await import(
    './dist/process-modules/application/lifecycle-orchestrator.js'
  );
  const {
    productDeliveryLifecycle,
    assertProductDeliveryLifecycleInput,
    PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  } = await import(
    './dist/process-modules/lifecycles/product-delivery-lifecycle.js'
  );
  // Inline registry (Wave 13 removed modules/catalog.ts + installations.ts).
  const { ProcessModuleRegistry } = await import(
    './dist/process-modules/application/process-module-registry.js'
  );
  const { ProcessModuleInstallationRegistry } = await import(
    './dist/process-modules/application/process-module-installation-registry.js'
  );
  const { discoveryProcessModule } = await import(
    './dist/process-modules/modules/discovery/discovery-process-module.js'
  );
  const { formalizationProcessModule } = await import(
    './dist/process-modules/modules/formalization/formalization-process-module.js'
  );
  const { developmentProcessModule } = await import(
    './dist/process-modules/modules/development/development-process-module.js'
  );
  const { deliveryProcessModule } = await import(
    './dist/process-modules/modules/delivery/delivery-process-module.js'
  );

  // ---- boot fresh DB ----
  const db = getDb();
  // projectRepositoryId=59 is referenced by hex-lifecycle-input development binding.
  db.prepare(
    `INSERT INTO projects (id,name,status) VALUES (1,'Hex','active')`,
  ).run();
  db.prepare(
    `INSERT INTO epics (id,project_id,name) VALUES (10,1,'Hex Initiative')`,
  ).run();
  // Register a repository binding so projectRepositoryId=59 resolves.
  // (repositories table has its own surrogate id; we set it to 59.)
  const repoRow = db.prepare(
    `INSERT INTO repositories (name, remote_url, default_branch, metadata)
     VALUES ('hex-ui', NULL, 'main', '{}') RETURNING id`,
  ).get();
  db.prepare(
    `INSERT INTO project_repositories
       (project_id, repository_id, role, local_path, integration_branch, docs_root, status, metadata)
     VALUES (1, ?, 'component', ?, 'dev', NULL, 'active', '{}')`,
  ).run(repoRow.id, tmp);

  // ---- load + validate the real input ----
  const inputPath = path.join(root, 'hex-lifecycle-input.json');
  const lifecycleInput = JSON.parse(readFileSync(inputPath, 'utf8'));
  assertProductDeliveryLifecycleInput(lifecycleInput);
  console.log('[input] hex-lifecycle-input.json validated ✓\n');

  // ---- deterministic per-stage payloads (minimum downstream-mapping fields) ----
  const DISCOVERY_PAYLOAD = {
    schemaVersion: 'saga3.discovery-certificate.v1',
    outcome: 'go',
    evidenceRefs: ['log:discovery-1'],
  };
  const SOLUTION_CONTRACT_PAYLOAD = {
    schemaVersion: 'saga3.solution-contract-certificate.v1',
    bundle: { acceptanceBaselineHash: 'a'.repeat(64) },
    srs: { schema: 'saga3.srs.v1', ref: 'SRS:1', hash: 'b'.repeat(64) },
    acceptanceCriteria: [
      { artifactId: 1, code: 'AC-1', acceptedHash: 'c'.repeat(64), implementationRequired: true },
    ],
  };
  const VERIFIED_BUNDLE_PAYLOAD = {
    schemaVersion: 'saga3.verified-integration-bundle.v1',
    integratedCandidate: {
      schema: 'saga3.integration-candidate.v1',
      ref: 'IC:1',
      hash: 'd'.repeat(64),
    },
  };
  const RELEASE_RECORD_PAYLOAD = {
    schemaVersion: 'saga3.release-record.v1',
    releaseRef: 'rel:1',
  };
  const MODULE_OUTPUTS = {
    'product-discovery':         { schema: 'saga3.discovery-certificate.v1',           payload: DISCOVERY_PAYLOAD,         outcome: 'go' },
    'solution-formalization':    { schema: 'saga3.solution-contract-certificate.v1',   payload: SOLUTION_CONTRACT_PAYLOAD, outcome: 'formalized' },
    'solution-development':      { schema: 'saga3.verified-integration-bundle.v1',     payload: VERIFIED_BUNDLE_PAYLOAD,   outcome: 'verified' },
    'delivery-release':          { schema: 'saga3.release-record.v1',                  payload: RELEASE_RECORD_PAYLOAD,    outcome: 'released' },
  };

  // ---- build orchestrator with stub executors ----
  const catalog = new ProcessModuleRegistry();
  catalog.register(discoveryProcessModule);
  catalog.register(formalizationProcessModule);
  catalog.register(developmentProcessModule);
  catalog.register(deliveryProcessModule);

  const processRunRepo = new SqliteProcessRunRepository(db);
  const installations = catalog.list().map(def => {
    const mo = MODULE_OUTPUTS[def.identity.name];
    if (!mo) throw new Error(`no stub output for module ${def.identity.name}`);
    const contentHash = sha256Hex(mo.payload);
    const executor = {
      moduleRef: { name: def.identity.name, version: def.identity.version },
      kind: 'legacy-adapter',
      async execute(_module, context) {
        const output = {
          schema: mo.schema,
          artifactRef: `${def.identity.name}-out-${context.processRunId}`,
          contentHash,
        };
        // drive the real status machine to completed
        const steps = [
          ['created','preparing'], ['preparing','running'],
          ['running','settling'], ['settling','completed'],
        ];
        let current = processRunRepo.read(context.processRunId).status;
        for (const [from, to] of steps) {
          if (current === to) continue;
          if (current === from) {
            const isTerminal = to === 'completed';
            const updated = processRunRepo.update(context.processRunId, {
              status: to,
              ...(isTerminal ? {
                localOutcome: mo.outcome, output,
                completedAt: new Date().toISOString(),
              } : {}),
            });
            current = updated.status;
          }
        }
        return { outcome: mo.outcome, output, certificate: null, authority: 'hex-stub' };
      },
    };
    return { definition: def, executor };
  });
  const installationRegistry = new ProcessModuleInstallationRegistry({});
  for (const inst of installations) installationRegistry.register(inst);

  const resolversBySchema = new Map();
  for (const mo of Object.values(MODULE_OUTPUTS)) {
    resolversBySchema.set(mo.schema, () => mo.payload);
  }
  const resolveOutputPayload = ctx => {
    const r = resolversBySchema.get(ctx.output.schema);
    if (!r) throw new Error(`no resolver for schema ${ctx.output.schema}`);
    return r(ctx);
  };

  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo, processRunRepo,
    moduleRegistry: catalog, installationRegistry, resolveOutputPayload,
  });

  // ---- RUN ----
  // Override the development binding's projectRepositoryId to the real one,
  // since the input hardcodes 59 but we created a fresh repo with a new id.
  lifecycleInput.development.repositories[0].projectRepositoryId = repoRow.id;

  console.log('[run] starting lifecycle...');
  const result = await orchestrator.run(productDeliveryLifecycle, {
    projectId: 1,
    epicId: 10,
    inputSchema: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
    inputPayload: lifecycleInput,
    initiatedBy: 'hex-runner',
    idempotencyKey: 'hex-lifecycle-v1',
  });

  console.log(`\n[run] lifecycle result:`);
  console.log(`  status:         ${result.status}`);
  console.log(`  terminalStatus: ${result.terminalStatus}`);
  console.log(`  stageRuns:      ${result.stageRuns?.length ?? 0}`);
  if (result.stageRuns) {
    for (const sr of result.stageRuns) {
      console.log(`    - stage=${sr.stageId} status=${sr.status} outcome=${sr.localOutcome ?? '-'}`);
    }
  }
  if (result.error) console.log(`  error:          ${result.error}`);

  // ---- assert ----
  console.log('\n[assert] terminal status === released');
  try {
    assert.equal(result.status, 'completed');
    assert.equal(result.terminalStatus, 'released');
    console.log('  ✓ PASSED — lifecycle reached released\n');
  } catch (e) {
    console.log(`  ✗ FAILED — ${e.message}\n`);
    exitCode = 1;
  }

  closeDb();
} catch (e) {
  console.error('\n[FATAL]', e.stack || e.message);
  exitCode = 1;
} finally {
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
