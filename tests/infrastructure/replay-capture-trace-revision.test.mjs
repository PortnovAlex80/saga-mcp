// tests/infrastructure/replay-capture-trace-revision.test.mjs
//
// STAGE-11 TASK 1 — the regression test for the stage-10 run death.
//
// The stage-10 kill chain (architect forensics + five-lens investigation):
//   trace_add xN -> worker_done seals a WorkplaceProductionSnapshot holding
//   the N trace ROWIDS -> trace_delete xN (rows die) -> trace_add xN with the
//   SAME tuples (new rowids) -> replay capture dereferences the sealed rowids
//   -> REPLAY_CAPTURE_TRACE_NOT_FOUND: expected N, resolved 0 -> run dead.
//
// CONVEYOR §9: a rowid is run-local identity and may never be replay
// authority. A trace re-created with identical content is the SAME material
// and must resolve; a genuinely missing trace must fail closed BY CONTENT.
//
// This test drives the REAL seam — no hand-written artifact/trace rows:
//   - the dispatcher's real artifact_create / trace_add / trace_delete /
//     worker_done handlers (managed provenance + freeze + seal);
//   - the replay key material derived by the REAL resolver
//     (resolveReplayKeyMaterial) and hashed by the REAL computeReplayKey;
//   - the capture itself: SqliteReplayCapsuleRepository.captureAcceptedExecution.
// The candidate-set rows are given-world fixtures (established c5 style) but
// point at the REAL sealed product produced by worker_done.
//
// BEFORE the TASK-2 fix this is RED with the exact stage-10 error. If it
// passes before the fix, the wrong thing is under test.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

const dbDir = mkdtempSync(path.join(os.tmpdir(), 'saga-trace-revision-'));
const dbPath = path.join(dbDir, 'factory.sqlite');
process.env.DB_PATH = dbPath;
process.env.SAGA_RUN_JOURNAL = 'off';

const { getDb, closeDb } = await import('../../dist/db.js');
const { handlers: workerHandlers } = await import('../../dist/tools/dispatcher.js');
const { handlers: artifactHandlers } = await import('../../dist/tools/artifacts.js');
const handlers = { ...artifactHandlers, ...workerHandlers };
const { initSubmissionRegistries } = await import(
  '../../dist/process-modules/application/submission-registries.js'
);
const { ensureManagedProductionLedgerSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js'
);
const { SqliteProcessProductRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-product-repository.js'
);
const { buildExecutionContext } = await import(
  '../../dist/shared/authority/build-execution-context.js'
);
const { executionContextHash } = await import(
  '../../dist/shared/authority/execution-context.js'
);
const { SqliteReplayCapsuleRepository } = await import(
  '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js'
);
const { resolveReplayKeyMaterial } = await import(
  '../../dist/infrastructure/replay/replay-key-material.js'
);
const { computeReplayKey } = await import(
  '../../dist/replay/replay-capsule.js'
);
const { SqliteSealedProductMaterialRepository } = await import(
  '../../dist/infrastructure/workplace/sqlite-sealed-product-material-repository.js'
);

const WORKPLACE_REF = 'workplace/1/product-discovery@3.0.2/cell/item';
const HEX64 = 'a'.repeat(64);

function seed(db) {
  // The managed-worker execution contract: the runner injects these into the
  // spawned worker env; the handlers resolve provenance from them.
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = 'exec-1';
  process.env.SAGA_TASK_ID = '1';
  ensureManagedProductionLedgerSchema(db);
  new SqliteProcessProductRepository(db);
  initSubmissionRegistries(db);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO repositories (id,name,remote_url,default_branch)
     VALUES (1,'repo','https://example.invalid/repo.git','main')`,
  ).run();
  db.prepare(
    `INSERT INTO project_repositories (id,project_id,repository_id,role)
     VALUES (1,1,1,'product')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
        executor_kind,input_schema,input_snapshot,input_hash,status,package_digest)
     VALUES (1,1,1,'product-discovery','3.0.2','product-discovery@3.0.2','run-1','generic-flow',
             'factory.synthetic-input.v1','{}',?,'running',?)`,
  ).run(HEX64, HEX64);
  const authorityScope = {
    enforcement: 'runtime',
    allowed_tools: ['artifact_create', 'trace_add', 'trace_delete', 'worker_done'],
    scope: 'workplace:synthetic',
    snapshot_ref: 'snapshot:synthetic',
  };
  db.prepare(
    `INSERT INTO factory_work_intents
       (id,epic_id,kind,objective,authority_scope,output_schema,status)
     VALUES (1,1,'synthetic.author','produce',?,
             'factory.synthetic-bundle.v1','executing')`,
  ).run(JSON.stringify(authorityScope));
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES (?,1,'product-discovery@3.0.2','cell','item','in_progress','running','author',2,'exec-1')`,
  ).run(WORKPLACE_REF);
  db.prepare(
    `INSERT INTO tasks
       (id,epic_id,title,status,assigned_to,current_execution_id,workplace_ref,
        task_kind,execution_mode,metadata)
     VALUES (1,1,'produce','in_progress','worker-1','exec-1',?,
             'synthetic.work','tracker_only',?)`,
  ).run(WORKPLACE_REF, JSON.stringify({
    process_run_id: 1,
    process_module_ref: 'product-discovery@3.0.2',
    process_node_id: 'produce-proposal',
    process_input_hash: HEX64,
    production_cell_id: 'cell',
    work_key: 'item',
    workplace_ref: WORKPLACE_REF,
    work_intent_id: 1,
    semantic_input_digest: HEX64,
  }));
  db.prepare(`UPDATE factory_work_intents SET projected_task_id=1 WHERE id=1`).run();
  const intent = db.prepare('SELECT * FROM factory_work_intents WHERE id=1').get();
  const task = db.prepare('SELECT * FROM tasks WHERE id=1').get();

  // Replay identity via the REAL resolver + hasher (§9 chain, not invented).
  const keyMaterial = resolveReplayKeyMaterial(db, task, 'author');
  assert.ok(keyMaterial, 'real key material resolves from the seeded binding');
  const replayKey = computeReplayKey(keyMaterial);

  const executionContext = buildExecutionContext({
    modelRoute: { provider: 'test', model: 'test', effort: 'low' },
    workIntent: { ...intent, authority_scope: JSON.parse(intent.authority_scope) },
    capturedAt: new Date().toISOString(),
  });
  executionContext.replay = {
    key: replayKey,
    key_material: keyMaterial,
    capsule_ref: null,
    capsule_payload_hash: null,
  };
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase,metadata)
     VALUES ('exec-1','dispatch-1',1,1,1,'worker-1','machine','test',
             'running','executing',?)`,
  ).run(JSON.stringify({
    execution_context: executionContext,
    execution_context_hash: executionContextHash(executionContext),
  }));
}

function addArtifact(code) {
  const reply = handlers.artifact_create({
    project_id: 1, epic_id: 1, project_repository_id: 1,
    type: 'SPEC', title: `spec-${code}`, path: `docs/${code}.md`, code,
    status: 'draft',
  });
  return reply;
}

test('STAGE-11 TASK 1: capture survives trace revision — delete + re-add same content', () => {
  const db = getDb();
  seed(db);

  // 1. A worker produces artifacts and traces (real handlers).
  const source = addArtifact('SRC');
  const targetA = addArtifact('TGT-A');
  const targetB = addArtifact('TGT-B');
  const sourceId = source.artifact?.id ?? source.id;
  const aId = targetA.artifact?.id ?? targetA.id;
  const bId = targetB.artifact?.id ?? targetB.id;
  assert.ok(Number.isInteger(sourceId) && Number.isInteger(aId) && Number.isInteger(bId),
    `artifact ids resolved: ${JSON.stringify(source)} / ${JSON.stringify(targetA)}`);

  handlers.trace_add({ source_id: sourceId, target_type: 'artifact', target_id: aId, link_type: 'derived_from' });
  handlers.trace_add({ source_id: sourceId, target_type: 'artifact', target_id: bId, link_type: 'derived_from' });
  let live = db.prepare('SELECT COUNT(*) n FROM artifact_traces').get().n;
  assert.equal(live, 2, 'two traces exist after adds');

  // 2. The production snapshot is sealed (real worker_done freeze).
  const done = handlers.worker_done({
    task_id: 1,
    worker_id: 'worker-1',
    execution_id: 'exec-1',
    result: 'produced the bundle with two traces',
  });
  assert.equal(done.stop, true, 'worker_done accepted');
  const frozen = db.prepare(
    `SELECT schema_id,product_ref,product_digest
       FROM factory_execution_completion_products ORDER BY rowid DESC LIMIT 1`,
  ).get();
  assert.ok(frozen, 'a completion product was frozen at worker_done');
  const snapshot = JSON.parse(db.prepare(
    'SELECT payload_snapshot FROM factory_process_products WHERE artifact_ref=? AND schema_id=?',
  ).get(frozen.product_ref, frozen.schema_id).payload_snapshot);
  assert.equal(snapshot.schemaVersion, 'factory.workplace-production-snapshot.v3');
  const sealedTraceIds = snapshot.traces.map((t) => t.traceId).sort((x, y) => x - y);
  assert.equal(sealedTraceIds.length, 2, 'the seal carries both traces');
  for (const t of snapshot.traces) {
    assert.ok(typeof t.traceHash === 'string' && t.traceHash.length === 64,
      'the seal carries the trace content hash');
  }
  // Seal through the SAME repository call the production node executor makes
  // (production-cell-node-executor.ts seal site) — no hand-written rows.
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: { schemaId: frozen.schema_id, ref: frozen.product_ref, digest: frozen.product_digest },
    payload: snapshot,
  });
  const sealed = {
    product_schema: frozen.schema_id,
    product_ref: frozen.product_ref,
    content_digest: frozen.product_digest,
  };

  // 3. The worker revises: delete both, re-add the SAME tuples (new rowids).
  handlers.trace_delete({ source_id: sourceId, target_type: 'artifact', target_id: aId, link_type: 'derived_from' });
  handlers.trace_delete({ source_id: sourceId, target_type: 'artifact', target_id: bId, link_type: 'derived_from' });
  live = db.prepare('SELECT COUNT(*) n FROM artifact_traces').get().n;
  assert.equal(live, 0, 'both trace rows are gone — the sealed rowids now dangle');
  handlers.trace_add({ source_id: sourceId, target_type: 'artifact', target_id: aId, link_type: 'derived_from' });
  handlers.trace_add({ source_id: sourceId, target_type: 'artifact', target_id: bId, link_type: 'derived_from' });
  live = db.prepare('SELECT COUNT(*) n FROM artifact_traces').get().n;
  assert.equal(live, 2, 'equivalent traces re-created with identical content');

  // Given-world candidate set pointing at the REAL sealed product (c5 style).
  const candidateSetRef = `candidate-set/1/product-discovery@3.0.2/cell/item/${'c'.repeat(16)}`;
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
       (revision_ref,workplace_ref,parent_revision_ref,members,
        contributing_execution_refs,presenter_ref,material_digest,
        semantic_digest,sealed_at)
     VALUES (?,?,NULL,'[]','[]',?,?,?,datetime('now'))`,
  ).run(`revision:${candidateSetRef}`, WORKPLACE_REF, `presenter:${candidateSetRef}`, HEX64, HEX64);
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,'author',NULL,?,'seal:stage11',datetime('now'))`,
  ).run(candidateSetRef, WORKPLACE_REF, `revision:${candidateSetRef}`, HEX64);
  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'produced',NULL)`,
  ).run(candidateSetRef, sealed.product_schema, sealed.product_ref, sealed.content_digest);

  // 4+5. The replay capsule capture runs over the revised trace set.
  const repo = new SqliteReplayCapsuleRepository(db);
  const capsule = repo.captureAcceptedExecution({
    executionRef: 'exec-1',
    candidateSetRef,
  });

  assert.ok(capsule, 'capture succeeds — re-created identical content is the same material');
  const payload = JSON.parse(capsule.payload_snapshot ?? capsule.payload ?? '{}');
  const traces = payload.traces ?? [];
  assert.equal(traces.length, 2, 'both trace identities resolved into the capsule');
  const tuples = new Set(traces.map((t) => JSON.stringify([
    t.source?.code ?? t.source?.title ?? t.source,
    t.linkType ?? t.link_type,
    t.target?.code ?? t.target?.title ?? t.target,
  ])));
  assert.equal(tuples.size, 2, 'the two identities are distinct by content');
});

test('STAGE-11 TASK 3 twin (SKIPPED — artifact side, latent exposure): capture after artifact deletion', {
  skip: 'artifact_delete does not exist as a worker tool; the exposure is latent (operator routes only). See the TASK 3 report.',
}, () => {
  // Same shape as above, but the deleted+re-created row is the ARTIFACT the
  // sealed snapshot points at. Unreachable for workers today; becomes live
  // the moment any artifact-deletion path lands. Do not enable silently —
  // content-addressed artifact resolution changes capsule identity for every
  // existing capsule (architect decision, brief TASK 3).
});

process.on('exit', () => {
  try { closeDb(); } catch { /* best effort */ }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
