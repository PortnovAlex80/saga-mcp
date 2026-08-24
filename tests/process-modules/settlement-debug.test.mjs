// Test for settlement_explain tool — verifies it reads persisted settlement
// data from the DB and returns a structured causal trace.
//
// Seeds: a ProcessRun + a process_outcome_certificate + two NodeRun rows with
// realistic output_bindings (one clean, one with a gap). Then calls the
// settlement_explain handler and asserts the structured output matches.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers } = await import('../../dist/tools/settlement-debug.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { ensureFactoryProcessOutcomeCertificateSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { ensureFactoryNodeRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);

const PROJECT_ID = 1;
const EPIC_ID = 100;
const PROCESS_RUN_ID = 5001;

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-setdbg-'));
  process.env.DB_PATH = path.join(temp, 'setdbg.db');
  const db = getDb();
  // Ensure saga3 tables exist (lazily created by repos).
  new SqliteProcessRunRepository(db);
  ensureFactoryProcessOutcomeCertificateSchema(db);
  ensureFactoryNodeRunSchema(db);

  // Minimal project + epic.
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (100,1,'Form')`).run();

  // ProcessRun — settled 'inconsistent'.
  db.prepare(`
    INSERT INTO factory_process_runs
      (id, project_id, epic_id,
       module_name, module_version, module_ref_key,
       idempotency_key, executor_kind,
       input_schema, input_snapshot, input_hash,
       status, local_outcome, authority,
       certificate_schema, certificate_ref, certificate_hash,
       created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    PROCESS_RUN_ID, PROJECT_ID, EPIC_ID,
    'product-formalization', '1.0.0', 'product-formalization@1.0.0',
    `idemp-${PROCESS_RUN_ID}`, 'generic-flow',
    'factory.formalization-case.v1', '{"epicId":100}', 'abc123',
    'completed', 'inconsistent', 'formalization_settlement_policy',
    'factory.formalization-certificate.v1',
    'factory_process_outcome_certificates:42',
    'def456',
    new Date().toISOString(), new Date().toISOString(),
  );

  // Certificate — decision 'inconsistent', reason_codes with traceability-gap.
  db.prepare(`
    INSERT INTO factory_process_outcome_certificates
      (process_run_id, project_id, epic_id,
       module_name, module_version, module_ref_key, schema_version,
       decision, reason_codes, rationale, input_hash,
       certificate_payload, certificate_hash,
       authority, issued_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    PROCESS_RUN_ID, PROJECT_ID, EPIC_ID,
    'product-formalization', '1.0.0', 'product-formalization@1.0.0',
    'factory.formalization-certificate.v1',
    'inconsistent',
    JSON.stringify(['traceability-gap']),
    'UC-1 is missing a covers edge to an FR artifact',
    'abc123',
    JSON.stringify({ bundleHash: 'bbb', acceptanceBaselineHash: 'ccc', discoveryCertificateRef: null }),
    'def456',
    'formalization_settlement_policy',
    new Date().toISOString(),
  );

  // NodeRun #1 — a clean resolve node (no gap).
  db.prepare(`
    INSERT INTO factory_node_runs
      (id, process_run_id, node_id, node_kind, attempt, status,
       output_schema, output_hash, output_bindings,
       completion, completion_hash,
       execution_receipt, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    6001, PROCESS_RUN_ID, 'resolve-product', 'kernel', 1, 'completed',
    'factory.formalization-manifest.v1', 'h1',
    JSON.stringify({
      gap: null,
      unacceptedArtifactIds: [],
      baselineDriftArtifactIds: [],
      traceDigest: 'td1',
      ledgerArtifactWriteIds: [101, 102],
      categoryBindings: { PRD: 1, FR: 2, NFR: 1 },
    }),
    null, null,
    JSON.stringify({ taskId: 200, executionId: 'exec-200' }),
    new Date().toISOString(), new Date().toISOString(),
  );

  // NodeRun #2 — settlement node WITH a gap.
  db.prepare(`
    INSERT INTO factory_node_runs
      (id, process_run_id, node_id, node_kind, attempt, status,
       output_schema, output_hash, output_bindings,
       completion, completion_hash,
       execution_receipt, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    6002, PROCESS_RUN_ID, 'formalization-settlement-policy', 'kernel', 1, 'completed',
    'factory.formalization-manifest.v1', 'h2',
    JSON.stringify({
      gap: 'UC-1 (id=20) has no covers edge to any FR',
      unacceptedArtifactIds: [],
      baselineDriftArtifactIds: [],
      traceDigest: 'td2',
      ledgerArtifactWriteIds: [],
      categoryBindings: {},
    }),
    JSON.stringify({
      outcome: 'inconsistent',
      terminal: true,
      outputEnvelope: {
        certificateRef: { schema: 'factory.formalization-certificate.v1', ref: 42, hash: 'def456' },
      },
    }),
    'comp-hash',
    JSON.stringify({ taskId: 201, executionId: 'exec-201' }),
    new Date().toISOString(), new Date().toISOString(),
  );

  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('settlement_explain: returns full causal trace for an inconsistent run', () => {
  const { temp } = fixture();
  try {
    const result = handlers.settlement_explain({ process_run_id: PROCESS_RUN_ID });

    // --- Run summary ---
    assert.equal(result.run.processRunId, PROCESS_RUN_ID);
    assert.equal(result.run.status, 'completed');
    assert.equal(result.run.localOutcome, 'inconsistent');
    assert.equal(result.run.authority, 'formalization_settlement_policy');
    assert.equal(result.run.certificate.hash, 'def456');

    // --- Certificate ---
    assert.ok(result.certificate, 'certificate must be present');
    assert.equal(result.certificate.decision, 'inconsistent');
    assert.deepEqual(result.certificate.reasonCodes, ['traceability-gap']);
    assert.match(result.certificate.rationale, /UC-1 is missing a covers edge/);
    assert.equal(result.certificate.certificateHash, 'def456');
    assert.ok(result.certificate.certificatePayload, 'payload must be decoded');
    assert.equal(result.certificate.certificatePayload.bundleHash, 'bbb');

    // --- Node trace (ordered by id ASC) ---
    assert.equal(result.nodeTrace.length, 2, 'two node runs');

    // Node #1: clean
    const n1 = result.nodeTrace[0];
    assert.equal(n1.nodeId, 'resolve-product');
    assert.equal(n1.bindings.gap, null, 'node 1 has no gap');
    assert.deepEqual(n1.bindings.ledgerArtifactWriteIds, [101, 102]);
    assert.deepEqual(n1.bindings.categoryBindings, { PRD: 1, FR: 2, NFR: 1 });
    assert.equal(n1.completion, null, 'node 1 is not terminal');
    assert.equal(n1.executionReceipt.taskId, 200);

    // Node #2: settlement with gap
    const n2 = result.nodeTrace[1];
    assert.equal(n2.nodeId, 'formalization-settlement-policy');
    assert.match(n2.bindings.gap, /UC-1.*covers edge/);
    assert.equal(n2.completion.outcome, 'inconsistent');
    assert.equal(n2.completion.terminal, true);
    assert.ok(n2.completion.certificateRef, 'settlement node has certificate ref');
    assert.equal(n2.completion.certificateRef.ref, 42);

    // No discovery settlement section at all: the legacy Discovery query was
    // removed (ADR-095 Phase 3.2) — the key must be ABSENT from the response
    // shape, not merely null.
    assert.equal('discoverySettlement' in result, false,
      'the discoverySettlement key must not exist in the settlement_explain response');
  } finally {
    cleanup(temp);
  }
});

test('settlement_explain: throws for non-existent run', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-setdbg-nf-'));
  process.env.DB_PATH = path.join(temp, 'nf.db');
  try {
    const db = getDb();
    new SqliteProcessRunRepository(db); // ensure factory_process_runs exists
    assert.throws(
      () => handlers.settlement_explain({ process_run_id: 999999 }),
      /process_run 999999 not found/,
    );
  } finally {
    cleanup(temp);
  }
});

test('settlement_explain: handles run without certificate or node runs gracefully', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-setdbg-empty-'));
  process.env.DB_PATH = path.join(temp, 'empty.db');
  try {
    const db = getDb();
    new SqliteProcessRunRepository(db); // ensure factory_process_runs exists
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (100,1,'Form')`).run();
    // A run that's still 'running' — no certificate, no node runs yet.
    db.prepare(`
      INSERT INTO factory_process_runs
        (id, project_id, epic_id,
         module_name, module_version, module_ref_key,
         idempotency_key, executor_kind,
         input_schema, input_snapshot, input_hash,
         status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      7001, 1, 100,
      'product-formalization', '1.0.0', 'product-formalization@1.0.0',
      'idemp-7001', 'generic-flow',
      'factory.formalization-case.v1', '{}', 'x',
      'running',
      new Date().toISOString(), new Date().toISOString(),
    );

    const result = handlers.settlement_explain({ process_run_id: 7001 });
    assert.equal(result.run.status, 'running');
    assert.equal(result.certificate, null, 'no certificate for a running process');
    assert.equal(result.nodeTrace.length, 0, 'no node runs yet');
  } finally {
    cleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// ADR-095 Phase 3.2 — the legacy Discovery settlement query is GONE.
//
// Non-vacuity contract of this test (deliberate-mutation RED/GREEN): against
// the pre-Phase-3.2 code this test FAILS twice — (a) the response carried a
// `discoverySettlement` key (null, because the legacy query selected columns
// that no longer exist in the D4 DDL and its throw was silently swallowed),
// and (b) the traced SQL contained the legacy settlement table name. The
// removal must keep both negative facts true while the generic trace stays
// fully functional for a Discovery-module run whose legacy table still holds
// a row (the table itself is only removed from the fresh schema at Phase 5).
// ---------------------------------------------------------------------------

const DISCOVERY_PROCESS_RUN_ID = 8001;
const LEGACY_SETTLEMENT_TABLE = 'factory_discovery_settlements';

test('settlement_explain: discovery run traced generically, legacy settlement query absent (ADR-095 Phase 3.2)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-setdbg-disc-'));
  process.env.DB_PATH = path.join(temp, 'disc.db');
  let db;
  try {
    db = getDb();
    new SqliteProcessRunRepository(db);
    ensureFactoryProcessOutcomeCertificateSchema(db);
    ensureFactoryNodeRunSchema(db);

    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (100,1,'Disc')`).run();

    // A settled DISCOVERY-module ProcessRun — the exact module_ref_key shape
    // ('discovery') that used to arm the legacy query block.
    db.prepare(`
      INSERT INTO factory_process_runs
        (id, project_id, epic_id,
         module_name, module_version, module_ref_key,
         idempotency_key, executor_kind,
         input_schema, input_snapshot, input_hash,
         status, local_outcome, authority,
         created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      DISCOVERY_PROCESS_RUN_ID, 1, 100,
      'product-discovery', '3.0.2', 'discovery',
      `idemp-${DISCOVERY_PROCESS_RUN_ID}`, 'generic-flow',
      'factory.discovery-settlement-input.v1', '{}', 'hash-8001',
      'completed', 'go', 'discovery_settlement_policy',
      new Date().toISOString(), new Date().toISOString(),
    );

    // Generic certificate for the discovery run.
    db.prepare(`
      INSERT INTO factory_process_outcome_certificates
        (process_run_id, project_id, epic_id,
         module_name, module_version, module_ref_key, schema_version,
         decision, reason_codes, rationale, input_hash,
         certificate_payload, certificate_hash,
         authority, issued_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      DISCOVERY_PROCESS_RUN_ID, 1, 100,
      'product-discovery', '3.0.2', 'discovery',
      'factory.discovery-outcome-certificate.v1',
      'go',
      JSON.stringify(['GO_READY_AND_GROUNDED']),
      'Proposal is ready, grounded, and confident enough to proceed',
      'hash-8001',
      JSON.stringify({ bundleHash: 'ddd', acceptanceBaselineHash: 'eee' }),
      'cert-hash-8001',
      'discovery_settlement_policy',
      new Date().toISOString(),
    );

    // One generic NodeRun row.
    db.prepare(`
      INSERT INTO factory_node_runs
        (id, process_run_id, node_id, node_kind, attempt, status,
         output_schema, output_hash, output_bindings,
         completion, completion_hash,
         execution_receipt, started_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      9001, DISCOVERY_PROCESS_RUN_ID, 'discovery-settlement-policy', 'kernel', 1, 'completed',
      'factory.discovery-outcome-certificate.v1', 'h8001',
      JSON.stringify({ gap: null, traceDigest: 'td8001', categoryBindings: { PROPOSAL: 1 } }),
      JSON.stringify({
        outcome: 'go',
        terminal: true,
        outputEnvelope: {
          certificateRef: { schema: 'factory.discovery-outcome-certificate.v1', ref: 43, hash: 'cert-hash-8001' },
        },
      }),
      'comp-hash-8001',
      JSON.stringify({ taskId: 300, executionId: 'exec-300' }),
      new Date().toISOString(), new Date().toISOString(),
    );

    // Seed the legacy D4 settlement table with a live row (FK chain of the
    // legacy closure is out of scope for this fixture — toggle FK for the
    // seed insert only). The row MUST be ignored by the tool.
    // ADR-095 Phase-5 note: fresh DBs no longer create this table; the
    // fixture DDL below recreates it exactly as an EXISTING pre-cutover
    // database carries it — inert history the tool must still never read.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${LEGACY_SETTLEMENT_TABLE} (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id                   INTEGER NOT NULL,
        proposal_id               INTEGER NOT NULL,
        proposal_content_hash     TEXT,
        readiness_assessment_hash TEXT,
        policy_version            TEXT,
        policy_hash               TEXT,
        input_snapshot            TEXT,
        input_hash                TEXT,
        decision                  TEXT NOT NULL,
        rationale                 TEXT
      );
    `);
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare(`
        INSERT INTO ${LEGACY_SETTLEMENT_TABLE}
          (epic_id, proposal_id, proposal_content_hash,
           readiness_assessment_hash, policy_version, policy_hash,
           input_snapshot, input_hash, decision, rationale)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        100, 1, 'deadbeef',
        'none', 'factory.discovery-settlement-policy.v1', 'policy-hash',
        JSON.stringify({ proposal: 'legacy' }), 'input-hash', 'go',
        'legacy row that must never be read by settlement_explain',
      );
    } finally {
      db.pragma('foreign_keys = ON');
    }
    const seeded = db.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY_SETTLEMENT_TABLE}`).get();
    assert.equal(seeded.n, 1, 'fixture fact: the legacy table exists and holds one row');

    // Trace every prepared statement while the handler runs.
    const tracedSql = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      tracedSql.push(String(sql));
      return originalPrepare(sql);
    };
    let result;
    try {
      result = handlers.settlement_explain({ process_run_id: DISCOVERY_PROCESS_RUN_ID });
    } finally {
      delete db.prepare; // restore the prototype method
    }

    // (1) Generic behavior remains for a Discovery-module run.
    assert.equal(result.run.processRunId, DISCOVERY_PROCESS_RUN_ID);
    assert.equal(result.run.status, 'completed');
    assert.equal(result.run.localOutcome, 'go');
    assert.equal(result.run.authority, 'discovery_settlement_policy');
    assert.equal(result.certificate.decision, 'go');
    assert.deepEqual(result.certificate.reasonCodes, ['GO_READY_AND_GROUNDED']);
    assert.equal(result.nodeTrace.length, 1);
    assert.equal(result.nodeTrace[0].nodeId, 'discovery-settlement-policy');
    assert.equal(result.nodeTrace[0].completion.certificateRef.ref, 43);

    // (2) The Discovery section is absent from the response shape entirely.
    assert.equal('discoverySettlement' in result, false,
      'settlement_explain must not carry a discoverySettlement key after ADR-095 Phase 3.2');

    // (3) Positive control for the SQL trace: the prepare hook DID capture
    // the handler's statements — tracedSql contains the exact real generic
    // run query (FROM factory_process_runs WHERE id = ?). Without this, the
    // zero-legacy-reads assertion below could pass vacuously if the hook had
    // captured nothing (e.g., the handler resolved another db handle).
    assert.ok(
      tracedSql.some((sql) => sql.includes('FROM factory_process_runs WHERE id = ?')),
      'positive control: tracedSql must contain the generic factory_process_runs query '
        + `before zero-legacy-reads is asserted (got ${tracedSql.length} traced statements)`,
    );

    // (4) The legacy query is absent at the SQL seam: no prepared statement
    // touches the legacy settlement table.
    const legacyReads = tracedSql.filter((sql) => sql.includes(LEGACY_SETTLEMENT_TABLE));
    assert.deepEqual(legacyReads, [],
      `settlement_explain must not query ${LEGACY_SETTLEMENT_TABLE} (got: ${legacyReads.join(' | ')})`);

    // (5) The seeded legacy row is untouched — the tool neither read nor
    // altered it (read-only generic trace only).
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${LEGACY_SETTLEMENT_TABLE}`).get().n, 1);
  } finally {
    cleanup(temp);
  }
});
