// tests/matrix/b-material-reidentification.test.mjs
//
// STAGE-16 SPACE B — material re-identification, defect shape S1.
//
// Thesis (tests/matrix/README.md): a seal references material; the material's
// row is deleted and re-created with IDENTICAL content (a new rowid — SQLite
// AUTOINCREMENT never reuses ids); must the seal still resolve? The stage-11
// fix closed this for traces (REPLAY_CAPTURE_TRACE_NOT_FOUND, run 011 death).
// Nothing proved it for any other kind. This file sweeps every kind.
//
// Method (brief §SPACE B):
//   B1  the kind list is derived FROM CODE: the sealing path is
//       SqliteReplayCapsuleRepository.captureAcceptedExecution +
//       assertReplayCapsuleComplete (the post-acceptance certification every
//       accepted CandidateSet flows through — replay-capture-effect.ts:108,
//       replay-claim-binder.ts:310), backed by SqliteSealedProductMaterial-
//       Repository (products), SqliteWorkplaceProductionRevisionRepository
//       (revisions) and the sealed-table CHECKs/triggers in src/schema.ts.
//       The storage fences (no-delete triggers) are extracted from SCHEMA_SQL
//       at runtime, not typed from memory.
//   B2  every kind carries its identity basis (row id / content digest /
//       content tuple / string ref / git sha) WITH the code location that
//       resolves it. The basis is not asserted from reading — each B3 scenario
//       CONFIRMS it behaviorally (recreation always changes the rowid).
//   B3  for every row-id kind: seal a reference (REAL handlers: artifact_create,
//       trace_add, trace_delete, worker_done; REAL resolvers from dist/),
//       delete the row, re-create identical content, resolve the seal.
//   B4  where it does NOT resolve: recorded in FINDINGS below with kind, file,
//       line — and the assertions acknowledge the honest state (they assert the
//       breakage, so the suite is green while stating the gap; a future fix
//       flips them RED and the registry gets updated in the same commit).
//   B5  the honest negative: genuinely missing material must fail CLOSED,
//       naming the material by content — asserted per kind.
//   B6  the final table is printed (kind → identity basis → resolves).
//
// Fixtures are domain-free (brief §0.2): titles/paths/codes are arbitrary
// strings; the ONLY structure that is real is what a provider reads — the
// artifact file bytes (readArtifactBytes base64s them for file_backed
// artifacts) and the trace tuples. Each scenario runs on its own throwaway
// SQLite DB under os.tmpdir() so destructive probes cannot leak between kinds.
//
// Findings are recorded, not fixed (brief §2).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

const dbDir = mkdtempSync(path.join(os.tmpdir(), 'saga-matrix-b-'));
process.env.DB_PATH = path.join(dbDir, 'b0.sqlite');
process.env.SAGA_RUN_JOURNAL = 'off';

const { SCHEMA_SQL } = await import('../../dist/schema.js');
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
const { captureReplayCapsuleFailClosed } = await import(
  '../../dist/infrastructure/replay/replay-capsule-completeness.js'
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
const { SqliteWorkplaceProductionRevisionRepository } = await import(
  '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js'
);

const WORKPLACE_REF = 'workplace/1/product-discovery@3.0.2/cell/item';
const HEX64 = 'a'.repeat(64);

// ── B2: the kind table. basis values: 'row-id' | 'content-digest' |
// 'content-tuple' | 'string-ref' | 'git-sha'. `resolves` is the B3/B4 answer
// AFTER delete + identical re-creation (rowid always changes): 'yes',
// 'NO (finding <id>)', or 'fenced' — deletion is impossible through SQL
// (no-delete trigger), so S1 cannot enter at the storage layer.
// Citations are src/ locations; dist/ is the compiled same code under test.
const MATERIAL_KINDS = [
  { kind: 'sealed product payload', basis: 'content-digest', resolves: 'yes',
    cite: 'src/infrastructure/workplace/sqlite-sealed-product-material-repository.ts:63-87 — readExact WHERE (schema_id, product_ref, content_digest); PK (schema_id, content_digest)' },
  { kind: 'workplace production revision', basis: 'string-ref', resolves: 'fenced',
    cite: 'src/infrastructure/workplace/sqlite-workplace-production-revision-repository.ts:162-187 — getRevision(ref) / getRevisionByMaterialDigest(workplace, material_digest); row is no-delete triggered (schema.ts:1887-1890)' },
  { kind: 'candidate set', basis: 'string-ref', resolves: 'yes',
    cite: 'src/infrastructure/replay/replay-capsule-completeness.ts:16-27 + sqlite-replay-capsule-repository.ts:583-598 — WHERE candidate_set_ref=? (TEXT PK; NO storage fence — only FK RESTRICT from receipts)' },
  { kind: 'candidate set member row', basis: 'string-ref', resolves: 'yes',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:589-598 — read by (candidate_set_ref, ordinal); the AUTOINCREMENT id is never read by any consumer' },
  { kind: 'artifact', basis: 'row-id', resolves: 'NO (finding B-F1)',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:800-813 + replay-capsule-completeness.ts:105-122 — snapshot.artifacts[].artifactId (INTEGER rowid) → SELECT ... FROM artifacts WHERE id=?', note: 'the stage-11 TASK-3 twin was skipped as latent; this matrix cell drives it' },
  { kind: 'trace', basis: 'content-tuple', resolves: 'yes',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:436-457,838-858 — resolved by the (source_id,target_type,target_id,link_type) tuple / traceHash, not by the sealed traceId rowid (the stage-11 fix)' },
  { kind: 'trace task target (tasks row)', basis: 'row-id', resolves: 'NO (finding B-F2)',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:872-879 — SELECT generation_key FROM tasks WHERE id=<sealed targetId rowid>; hard-fails at replay-capsule-completeness.ts:148-155 even though tasks.generation_key IS a content identity that could have been sealed instead' },
  { kind: 'worker execution', basis: 'string-ref', resolves: 'n/a (capture-time only)',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:716-721 — WHERE execution_id=?; provenance only, not dereferenced post-seal' },
  { kind: 'check receipt', basis: 'string-ref', resolves: 'fenced',
    cite: 'src/schema.ts:2058-2090 — TEXT PK + trg_factory_check_receipts_no_delete' },
  { kind: 'gate decision', basis: 'string-ref', resolves: 'fenced',
    cite: 'src/schema.ts:2095-2152 — TEXT PK decision_key + no-update/no-delete triggers (REG-18)' },
  { kind: 'effect receipt', basis: 'content-digest', resolves: 'fenced',
    cite: 'src/schema.ts:1576-1592 — effect_receipt_ref/digest-derived TEXT PK + no-delete trigger (1685-1692); resolved by exact ref at src/infrastructure/workplace/sqlite-cell-final-acceptance.ts:380' },
  { kind: 'git commit (recipe)', basis: 'git-sha', resolves: 'yes',
    cite: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts:516-571 — commit/tree SHAs are git-native content identity; no rowid participates' },
];

// The S1-live kinds: referenced by row id AND deletable through SQL (no
// storage fence) — exactly the two rows with resolves:'NO' plus the trace
// (rowid-bearing content tuple, closed by stage 11).
const ROW_ID_KINDS = MATERIAL_KINDS.filter(k => k.basis === 'row-id').map(k => k.kind);

// ── B4: the findings registry (recorded, not fixed). Every gap the sweep
// found, with the file:line that owns it, ordered by how badly it hurts.
const FINDINGS = [
  { id: 'B-F1', severity: 'high', kind: 'artifact',
    file: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts', line: '800-813 (mirror: replay-capsule-completeness.ts:105-122)',
    why: 'A sealed snapshot stores artifact rowids; capture/certification resolve artifacts ONLY by WHERE id=?. Delete the artifact row and re-create IDENTICAL content (new AUTOINCREMENT id, never reused) and every capsule over that snapshot is permanently unresolvable (REPLAY_CAPTURE_ARTIFACT_NOT_FOUND). artifact_traces.source_id ON DELETE CASCADE (schema.ts:516) additionally destroys trace rows when the SOURCE artifact dies. Known-latent since stage-11 TASK 3 ("no worker artifact_delete tool; operator routes only") — but nothing at the storage layer fences artifacts, so any future deletion path retroactively kills sealed capsules. This is the stage-10 trace death, one table over.' },
  { id: 'B-F2', severity: 'medium', kind: 'trace task target (tasks row)',
    file: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts', line: '872-879 (hard fail: replay-capsule-completeness.ts:148-155)',
    why: 'The trace tuple stores target_id = tasks.id rowid; capture dereferences it with SELECT generation_key FROM tasks WHERE id=? and nulls softly, then certification throws REPLAY_CAPTURE_TRACE_TASK_TARGET_IDENTITY_MISSING. A task deleted and re-created with IDENTICAL content (same generation_key — a content identity that exists and could have been sealed directly) gets a new rowid and breaks the seal. Capture even SUCCEEDS; only the completeness proof dies, so the failure surfaces one boundary later than the cause.' },
  { id: 'B-F3', severity: 'low', kind: 'artifact (observability)',
    file: 'src/infrastructure/replay/sqlite-replay-capsule-repository.ts', line: '809-812',
    why: 'When the artifact seal breaks, the error is "REPLAY_CAPTURE_ARTIFACT_NOT_FOUND: expected N, resolved M" — bare counts. The stage-11 trace fix added content naming ("missing by content: source=... traceHash=..."); the artifact path never got the same treatment, so a real run dying on B-F1 cannot name WHICH material is missing.' },
];

// ── B1: storage fences derived from the schema source at runtime ───────────
function noDeleteFencedTables(sql) {
  const out = new Set();
  const re = /CREATE TRIGGER IF NOT EXISTS\s+\w+_no_delete\s+BEFORE DELETE ON\s+(\w+)/g;
  for (const m of sql.matchAll(re)) out.add(m[1]);
  return out;
}
const FENCED = noDeleteFencedTables(SCHEMA_SQL);
const EXPECTED_FENCED = [
  'factory_sealed_product_materials', 'factory_sealed_product_aliases',
  'factory_workplace_production_revisions', 'factory_check_receipts',
  'factory_gate_decisions', 'factory_cell_effect_receipts',
  'factory_effect_attempts', 'factory_cell_final_acceptances',
];
// The kinds with NO fence are exactly the S1 entry surface.
const UNFENCED_LIVE = ['factory_candidate_sets', 'factory_candidate_set_members', 'artifacts', 'artifact_traces', 'tasks'];

// ── the real seam (established stage-11 style; nothing hand-rolled) ─────────
let dbSeq = 0;
function freshDb() {
  closeDb();
  const dir = path.join(dbDir, `s${++dbSeq}`);
  mkdirSync(dir, { recursive: true });
  process.env.DB_PATH = path.join(dir, 'factory.sqlite');
  const db = getDb();
  seed(db, dir);
  return { db, dir };
}

function seed(db, contentDir) {
  // The managed-worker execution contract (runner-injected env; the handlers
  // resolve provenance from these).
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
  // local_path points at the scenario content dir so readArtifactBytes can
  // resolve real file bytes for file_backed artifacts (the one place the
  // certification provider reads content — real structure, arbitrary bytes).
  db.prepare(
    `INSERT INTO project_repositories (id,project_id,repository_id,role,local_path)
     VALUES (1,1,1,'product',?)`,
  ).run(contentDir);
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

function addArtifact(db, dir, code, hashSeed) {
  // Arbitrary text everywhere; the only real structure is the file the
  // certification provider reads bytes from.
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', `${code}.md`), `x-${code}\n`);
  const reply = handlers.artifact_create({
    project_id: 1, epic_id: 1, project_repository_id: 1,
    type: 'SPEC', title: `t-${code}`, path: `docs/${code}.md`, code,
    status: 'draft', content_hash: hashSeed.repeat(64).slice(0, 64),
  });
  const id = reply.artifact?.id ?? reply.id;
  assert.ok(Number.isInteger(id), `artifact id resolved: ${JSON.stringify(reply)}`);
  return { id, contentHash: hashSeed.repeat(64).slice(0, 64) };
}

/** Produce → freeze (real worker_done) → seal (real seal repo) → candidate
 * set over the REAL sealed product. Returns the sealed triple + ids. */
function produceAndSeal(db, dir, { taskTarget = false } = {}) {
  const S = addArtifact(db, dir, 'SRC', '1');
  const T = taskTarget
    ? { id: null, contentHash: null }
    : addArtifact(db, dir, 'TGT', '2');
  let targetTaskId = null;
  if (taskTarget) {
    db.prepare(
      `INSERT INTO tasks (epic_id,title,status,generation_key,task_kind,execution_mode)
       VALUES (1,'tt','todo','gk-matrix','plain','tracker_only')`,
    ).run();
    targetTaskId = db.prepare('SELECT id FROM tasks WHERE generation_key=?').get('gk-matrix').id;
    handlers.trace_add({
      source_id: S.id, target_type: 'task', target_id: targetTaskId, link_type: 'derived_from',
    });
  } else {
    handlers.trace_add({
      source_id: S.id, target_type: 'artifact', target_id: T.id, link_type: 'derived_from',
    });
  }

  const done = handlers.worker_done({
    task_id: 1, worker_id: 'worker-1', execution_id: 'exec-1', result: 'x',
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
  assert.ok(snapshot.artifacts.length >= 1, 'the seal carries the artifact(s)');
  assert.equal(snapshot.traces.length, 1, 'the seal carries the trace');

  // Seal through the SAME repository call the production node executor makes.
  new SqliteSealedProductMaterialRepository(db).seal({
    productRef: { schemaId: frozen.schema_id, ref: frozen.product_ref, digest: frozen.product_digest },
    payload: snapshot,
  });

  // Given-world candidate set pointing at the REAL sealed product.
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
     VALUES (?,?,?,'author',NULL,?,'seal:matrix-b',datetime('now'))`,
  ).run(candidateSetRef, WORKPLACE_REF, `revision:${candidateSetRef}`, HEX64);
  db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
        origin,source_candidate_set_ref)
     VALUES (?,0,?,?,?,'produced',NULL)`,
  ).run(candidateSetRef, frozen.schema_id, frozen.product_ref, frozen.product_digest);

  return { frozen, snapshot, candidateSetRef, S, T, targetTaskId };
}

/** The seal-resolution operation under test: the production post-acceptance
 * path (replay-capture-effect.ts:108 / replay-claim-binder.ts:310). */
function resolveSeal(db, candidateSetRef) {
  return captureReplayCapsuleFailClosed(
    db,
    () => new SqliteReplayCapsuleRepository(db).captureAcceptedExecution({
      executionRef: 'exec-1',
      candidateSetRef,
    }),
  );
}

// ── B1/B2 sanity: the enumeration is real, derived, and complete ────────────
test('space B — B1: fences derived from SCHEMA_SQL; the kind table is coherent', () => {
  for (const table of EXPECTED_FENCED) {
    assert.ok(FENCED.has(table), `${table} must carry a no-delete trigger (enumeration source drifted)`);
  }
  // The S1 entry surface is exactly the unfenced, rowid-bearing kinds.
  for (const table of UNFENCED_LIVE) {
    assert.ok(!FENCED.has(table), `${table} was expected UNfenced — S1 live surface changed; update the table`);
  }
  // Every kind row is well-formed and every non-resolving row is a finding.
  for (const row of MATERIAL_KINDS) {
    assert.ok(row.kind && row.basis && row.cite, `malformed kind row: ${JSON.stringify(row)}`);
    if (row.resolves.startsWith('NO')) {
      const findingId = row.resolves.match(/finding (B-F\d)/)?.[1];
      assert.ok(findingId && FINDINGS.some(f => f.id === findingId),
        `${row.kind} does not resolve but has no finding`);
    }
  }
  assert.deepEqual(ROW_ID_KINDS, ['artifact', 'trace task target (tasks row)'],
    'the row-id kinds drifted — re-derive B1 from the resolver code');
  for (const f of FINDINGS) {
    assert.ok(f.kind && f.file && f.line && f.why && f.severity, `malformed finding ${f.id}`);
  }
});

// ── B3: kind 'trace' — content identity (the stage-11 precedent, re-derived ─
// as a matrix cell, not a one-bug regression) ────────────────────────────────
test('space B — B3 kind: trace (content-tuple) resolves after delete + identical re-creation', () => {
  const { db, dir } = freshDb();
  const { S, T, candidateSetRef } = produceAndSeal(db, dir);

  // Control: the seal resolves on intact material.
  const control = resolveSeal(db, candidateSetRef);
  assert.equal(control.payload.traces.length, 1, 'control capture resolves the trace');

  // Delete the sealed trace row, re-create the IDENTICAL tuple (new rowid).
  const sealedTraceRowid = db.prepare('SELECT id FROM artifact_traces').get().id;
  handlers.trace_delete({
    source_id: S.id, target_type: 'artifact', target_id: T.id, link_type: 'derived_from',
  });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM artifact_traces').get().n, 0,
    'the sealed trace row is gone');
  handlers.trace_add({
    source_id: S.id, target_type: 'artifact', target_id: T.id, link_type: 'derived_from',
  });
  const newRow = db.prepare('SELECT id FROM artifact_traces').get();
  assert.notEqual(newRow.id, sealedTraceRowid,
    'the re-created trace has a NEW rowid (AUTOINCREMENT never reuses)');

  const record = resolveSeal(db, candidateSetRef);
  assert.ok(record, 'capture + completeness certification succeed — identical content is the same material');
  assert.equal(record.payload.traces.length, 1, 'the trace identity resolved into the capsule');
});

// ── B5: the honest negative for traces — fail CLOSED, named by content ──────
test('space B — B5 kind: trace genuinely missing fails closed naming the content', () => {
  const { db, dir } = freshDb();
  const { S, T, candidateSetRef } = produceAndSeal(db, dir);
  handlers.trace_delete({
    source_id: S.id, target_type: 'artifact', target_id: T.id, link_type: 'derived_from',
  });
  assert.throws(
    () => resolveSeal(db, candidateSetRef),
    err => err.message.startsWith('REPLAY_CAPTURE_TRACE_NOT_FOUND')
      && err.message.includes('missing by content:')
      && err.message.includes('traceHash='),
    'must fail closed AND name the material by its content identity',
  );
});

// ── B3/B4: kind 'artifact' — ROW ID (finding B-F1, observability B-F3) ──────
test('space B — B3/B4 kind: artifact (row-id) does NOT resolve after identical re-creation — FINDING B-F1/B-F3', () => {
  const { db, dir } = freshDb();
  const { T, candidateSetRef } = produceAndSeal(db, dir);
  const control = resolveSeal(db, candidateSetRef);
  assert.equal(control.payload.artifacts.length, 2, 'control capture resolves both artifacts');

  // Delete the TARGET artifact (no trace cascade: only source_id is FK'd) and
  // re-create IDENTICAL content — same type/code/title/path/status/hash/file.
  const old = db.prepare('SELECT * FROM artifacts WHERE id=?').get(T.id);
  db.prepare('DELETE FROM artifacts WHERE id=?').run(T.id);
  db.prepare(
    `INSERT INTO artifacts
       (project_id,epic_id,type,code,title,path,status,parent_artifact_id,
        project_repository_id,content_hash,storage_kind,tags,metadata)
     VALUES (?,?,?,?,?,?,?,NULL,?,?, 'file_backed','[]','{}')`,
  ).run(old.project_id, old.epic_id, old.type, old.code, old.title, old.path,
    old.status, old.project_repository_id, old.content_hash);
  const twin = db.prepare('SELECT id FROM artifacts WHERE code=? ORDER BY id DESC').get(old.code).id;
  assert.notEqual(twin, T.id, 'the identical twin has a NEW rowid');

  // FINDING B-F1 (acknowledged honest state): the seal does NOT resolve.
  let message = null;
  try {
    resolveSeal(db, candidateSetRef);
  } catch (err) {
    message = err.message;
  }
  assert.ok(message?.startsWith('REPLAY_CAPTURE_ARTIFACT_NOT_FOUND'),
    'FINDING B-F1: artifact rowid is the sealed identity — an identical-content twin cannot restore it');
  // FINDING B-F3 (acknowledged honest state): the failure names COUNTS only,
  // not the material by content (the stage-11 trace fix names content; this
  // path never got the same treatment). When this is repaired, flip this
  // assertion and retire B-F3 in the same commit.
  assert.match(message, /^REPLAY_CAPTURE_ARTIFACT_NOT_FOUND: expected \d+, resolved \d+$/,
    'FINDING B-F3: the error is counts-only — it does not name the missing material');
});

// ── B5: artifact genuinely gone fails closed (B-F1's flip side) ─────────────
test('space B — B5 kind: artifact genuinely missing fails closed (counts-only, see B-F3)', () => {
  const { db, dir } = freshDb();
  const { T, candidateSetRef } = produceAndSeal(db, dir);
  db.prepare('DELETE FROM artifacts WHERE id=?').run(T.id);
  db.prepare('DELETE FROM artifact_traces WHERE target_id=?').run(T.id);
  assert.throws(
    () => resolveSeal(db, candidateSetRef),
    /REPLAY_CAPTURE_ARTIFACT_NOT_FOUND/,
    'genuinely missing artifact material must fail closed',
  );
});

// ── B3/B4: kind 'trace task target' — ROW ID (finding B-F2) ─────────────────
test('space B — B3/B4 kind: trace task target (row-id) does NOT survive identical re-creation — FINDING B-F2', () => {
  const { db, dir } = freshDb();
  const { candidateSetRef, targetTaskId } = produceAndSeal(db, dir, { taskTarget: true });
  // Control: with the task alive (generation_key present) the seal resolves.
  const control = resolveSeal(db, candidateSetRef);
  assert.equal(control.payload.traces[0].targetTaskGenerationKey, 'gk-matrix',
    'control: the task target resolves by generation key');

  // Delete the task, re-create IDENTICAL content — including the SAME
  // generation_key (a content identity) — under a new rowid.
  const old = db.prepare('SELECT * FROM tasks WHERE id=?').get(targetTaskId);
  db.prepare('DELETE FROM tasks WHERE id=?').run(targetTaskId);
  db.prepare(
    `INSERT INTO tasks (epic_id,title,status,generation_key,task_kind,execution_mode)
     VALUES (?,?,?,?,?,?)`,
  ).run(old.epic_id, old.title, old.status, old.generation_key, old.task_kind, old.execution_mode);
  const twin = db.prepare('SELECT id FROM tasks WHERE generation_key=?').get('gk-matrix').id;
  assert.notEqual(twin, targetTaskId, 'the identical twin task has a NEW rowid');

  // FINDING B-F2 (acknowledged honest state): capture even SUCCEEDS, then the
  // completeness certification dies one boundary later.
  const capsulesBefore = db.prepare('SELECT COUNT(*) n FROM factory_replay_capsules').get().n;
  assert.throws(
    () => resolveSeal(db, candidateSetRef),
    /REPLAY_CAPTURE_TRACE_TASK_TARGET_IDENTITY_MISSING/,
    'FINDING B-F2: the sealed targetId rowid dangles although the named content (generation_key) exists',
  );
  // And the partial capsule was removed — no half-certified material survives
  // (the count is unchanged: the control capsule stays, nothing was added).
  assert.equal(db.prepare('SELECT COUNT(*) n FROM factory_replay_capsules').get().n, capsulesBefore,
    'fail-closed cleanup removed the partial capsule');
});

// ── B3: kind 'sealed product payload' — content digest + storage fence ──────
test('space B — B3 kind: sealed product (content-digest) resolves after re-seal; fence + honest negative', () => {
  const { db, dir } = freshDb();
  const { frozen, candidateSetRef } = produceAndSeal(db, dir);
  const repo = new SqliteSealedProductMaterialRepository(db);
  const productRef = {
    schemaId: frozen.schema_id, ref: frozen.product_ref, digest: frozen.product_digest,
  };

  // The storage fence: deletion is impossible through SQL (S1 cannot enter).
  assert.throws(
    () => db.prepare('DELETE FROM factory_sealed_product_materials').run(),
    /immutable/,
    'the no-delete trigger must fence the sealed material store',
  );

  // B5 honest negative: with the fence lifted and NO re-creation, resolution
  // fails closed NAMING the material by its content identity.
  db.exec('DROP TRIGGER trg_factory_sealed_product_materials_no_delete');
  db.exec('DROP TRIGGER trg_factory_sealed_product_aliases_no_delete');
  db.prepare('DELETE FROM factory_sealed_product_aliases').run();
  db.prepare('DELETE FROM factory_sealed_product_materials').run();
  assert.throws(
    () => repo.readExact(productRef),
    err => err.message.startsWith('SEALED_PRODUCT_NOT_FOUND')
      && err.message.includes(frozen.product_digest),
    'must fail closed naming schema/ref/digest',
  );

  // B3: re-create identical content (re-seal) → resolves. Identity is the
  // (schema_id, content_digest) PK — no rowid participates anywhere.
  const snapshot = JSON.parse(db.prepare(
    'SELECT payload_snapshot FROM factory_process_products WHERE artifact_ref=? AND schema_id=?',
  ).get(frozen.product_ref, frozen.schema_id).payload_snapshot);
  repo.seal({ productRef, payload: snapshot });
  const resolved = repo.readExact(productRef);
  assert.equal(resolved.schemaVersion, 'factory.workplace-production-snapshot.v3',
    'identical content re-seals to the SAME material and resolves');

  // And the full seal over the re-created material still resolves end-to-end.
  assert.ok(resolveSeal(db, candidateSetRef), 'capture + certification resolve after product re-creation');
});

// ── B3: kinds 'candidate set' + 'candidate set member row' — string ref ─────
test('space B — B3 kinds: candidate set + members (string-ref) resolve after identical re-creation', () => {
  const { db, dir } = freshDb();
  const { frozen, candidateSetRef } = produceAndSeal(db, dir);
  const control = resolveSeal(db, candidateSetRef);
  assert.ok(control, 'control capture resolves');

  // Delete set + members (no storage fence on either table), re-create
  // IDENTICAL content: same string refs, same ordinal/triple — but NEW
  // AUTOINCREMENT rowids on the member rows.
  const members = db.prepare(
    'SELECT ordinal,product_schema,product_ref,product_digest,origin,source_candidate_set_ref FROM factory_candidate_set_members WHERE candidate_set_ref=?',
  ).all(candidateSetRef);
  const setRow = db.prepare('SELECT * FROM factory_candidate_sets WHERE candidate_set_ref=?').get(candidateSetRef);
  const oldMemberIds = db.prepare('SELECT id FROM factory_candidate_set_members WHERE candidate_set_ref=?').all(candidateSetRef).map(r => r.id);
  db.prepare('DELETE FROM factory_candidate_set_members WHERE candidate_set_ref=?').run(candidateSetRef);
  db.prepare('DELETE FROM factory_candidate_sets WHERE candidate_set_ref=?').run(candidateSetRef);
  db.prepare(
    `INSERT INTO factory_candidate_sets
       (candidate_set_ref,workplace_ref,production_revision_ref,role,
        subject_candidate_set_ref,candidate_set_digest,seal_receipt_ref,sealed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(setRow.candidate_set_ref, setRow.workplace_ref, setRow.production_revision_ref,
    setRow.role, setRow.subject_candidate_set_ref, setRow.candidate_set_digest,
    setRow.seal_receipt_ref, setRow.sealed_at);
  for (const m of members) {
    db.prepare(
      `INSERT INTO factory_candidate_set_members
         (candidate_set_ref,ordinal,product_schema,product_ref,product_digest,
          origin,source_candidate_set_ref)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(candidateSetRef, m.ordinal, m.product_schema, m.product_ref,
      m.product_digest, m.origin, m.source_candidate_set_ref);
  }
  const newMemberIds = db.prepare('SELECT id FROM factory_candidate_set_members WHERE candidate_set_ref=?').all(candidateSetRef).map(r => r.id);
  assert.notDeepEqual(newMemberIds, oldMemberIds, 'the re-created member rows have NEW rowids');

  const record = resolveSeal(db, candidateSetRef);
  assert.ok(record, 'the seal resolves — member rowids are never the identity');

  // B5 honest negative: genuinely missing set fails closed naming the ref.
  db.prepare('DELETE FROM factory_candidate_set_members WHERE candidate_set_ref=?').run(candidateSetRef);
  db.prepare('DELETE FROM factory_candidate_sets WHERE candidate_set_ref=?').run(candidateSetRef);
  assert.throws(
    () => resolveSeal(db, candidateSetRef),
    err => err.message.startsWith('REPLAY_CAPTURE_CANDIDATE_NOT_FOUND')
      && err.message.includes(candidateSetRef),
    'must fail closed naming the candidate-set ref',
  );
});

// ── B3 (fenced kinds): revisions, check receipts, gate decisions ────────────
test('space B — B3 fenced kinds: revision / check receipt / gate decision refuse deletion at storage level', () => {
  const { db, dir } = freshDb();
  const { candidateSetRef } = produceAndSeal(db, dir);

  // Workplace production revision: sealed immutable material state.
  const revisionRef = `revision:${candidateSetRef}`;
  assert.throws(
    () => db.prepare('DELETE FROM factory_workplace_production_revisions WHERE revision_ref=?').run(revisionRef),
    /immutable/,
  );
  // Content-addressed re-seal converges on the SAME revision (idempotent).
  const revisions = new SqliteWorkplaceProductionRevisionRepository(db);
  const persisted = revisions.getRevision(revisionRef);
  assert.ok(persisted, 'revision resolves by string ref');
  assert.ok(revisions.getRevisionByMaterialDigest(WORKPLACE_REF, persisted.materialDigest),
    'revision resolves by material digest — content identity');

  // Check receipt (REG-17) and gate decision (REG-18): representative of the
  // receipt family (effect receipts, effect attempts, final acceptances share
  // the same trigger pattern — asserted derived in the B1 test).
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,
        provider_version,provider_digest,outcome,receipt_digest)
     VALUES ('cr:1','run:1',?,'prov','1','d','passed','rd')`,
  ).run(candidateSetRef);
  assert.throws(
    () => db.prepare('DELETE FROM factory_check_receipts').run(),
    /v4 check receipts are immutable/,
  );
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,verdict,check_plan_ref,check_plan_digest,
        decision_policy_ref,decision_policy_digest,installation_digest,decision_digest)
     VALUES ('dk:1',?,'g','gr','author','tr',?,'accepted','cp','cpd','dp','dpd','inst','dd')`,
  ).run(WORKPLACE_REF, candidateSetRef);
  assert.throws(
    () => db.prepare('DELETE FROM factory_gate_decisions').run(),
    /v4 gate decisions are immutable/,
  );
});

// ── B6: the report ──────────────────────────────────────────────────────────
test('space B — B6: the kind → identity-basis → resolves table', () => {
  const lines = MATERIAL_KINDS.map(row =>
    `  ${row.kind.padEnd(34)} ${row.basis.padEnd(15)} ${row.resolves}`);
  // eslint-disable-next-line no-console
  console.log([
    '[space B] material re-identification (defect shape S1):',
    ...lines,
    `  findings: ${FINDINGS.map(f => `${f.id}(${f.severity})`).join(', ')}`,
    `  storage-fenced kinds (S1 cannot enter): ${EXPECTED_FENCED.length}`,
    `  unfenced live tables: ${UNFENCED_LIVE.join(', ')}`,
  ].join('\n'));
  // The report is the contract: exactly the two row-id kinds fail, and both
  // are registered findings (the honest state, not an aspiration).
  const noResolve = MATERIAL_KINDS.filter(k => k.resolves.startsWith('NO'));
  assert.equal(noResolve.length, FINDINGS.filter(f => f.id !== 'B-F3').length,
    'every non-resolving kind is a registered finding');
});

process.on('exit', () => {
  try { closeDb(); } catch { /* best effort */ }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
