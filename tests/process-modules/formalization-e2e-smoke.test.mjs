// P6 tests: Formalization E2E smoke against a real artifact graph.
//
// Unlike P5 (which uses a fake graph port), these tests seed REAL artifact
// rows + traces + tasks into the saga DB and run the FULL Saga3FormalizationEngine
// (composition-root entry point) end-to-end. This proves the universality claim:
// Formalization mounts through the same OrchestrationEngine port, hits the same
// ProcessRun persistence, and issues the same generic certificate — no special-
// casing, no module-specific code paths in the Runtime.
//
// Scenarios:
//   - happy path: complete graph → outcome 'formalized' + certificate issued
//   - clarification-required: missing PRD → outcome 'clarification-required'
//   - inconsistent: missing trace edge → outcome 'inconsistent'
//   - restart: re-run on the same epic → existing run + certificate replay
//   - duplicate start: process_run_start with the same key → replayed=true
//   - certificate replay: re-issue same hash → replayed=true, no second row

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { Saga3FormalizationEngine } = await import(
  '../../dist/engines/saga3-formalization-engine.js'
);
const {
  LegacyFormalizationProcessAdapter,
  hashFormalizationCase,
} = await import(
  '../../dist/process-modules/modules/formalization/legacy-formalization-process-adapter.js'
);
const { ReferenceFormalizationSettlementPolicy, SqliteFormalizationArtifactGraph } = await import(
  '../../dist/process-modules/modules/formalization/sqlite-formalization-kernel.js'
);
const { FORMALIZATION_CASE_SCHEMA } = await import(
  '../../dist/process-modules/modules/formalization/formalization-schemas.js'
);

function fixture(graphSeed = 'complete') {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-forme2e-'));
  process.env.DB_PATH = path.join(temp, 'e2e.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (50,1,'Disc')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (100,1,'Form')`).run();
  seedGraph(db, 100, graphSeed);
  return { temp, db };
}
function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Seed the artifact graph for one formalization epic. Modes:
 *   'complete'         — all artifacts accepted, all traces present, tasks done.
 *   'no-prd'           — PRD missing.
 *   'no-srs'           — SRS missing.
 *   'trace-gap-uc-fr'  — UC has no 'covers' edge to FR.
 *   'tasks-not-ready'  — formalization task not done.
 */
function seedGraph(db, epicId, mode) {
  const ins = db.prepare(
    `INSERT INTO artifacts (id,project_id,epic_id,type,code,status,content_hash,accepted_hash,drift_state,path,title)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const acceptedHash = 'a'.repeat(64);
  // brief artifact (referenced by PRD) — lives in a sibling epic.
  db.prepare(`INSERT INTO epics (id,project_id,name) SELECT 9999,1,'Brief' WHERE NOT EXISTS (SELECT 1 FROM epics WHERE id=9999)`).run();
  ins.run(1, 1, 9999, 'brief', null, 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/brief.md', 'Brief');

  // PRD
  if (mode !== 'no-prd') {
    ins.run(2, 1, epicId, 'PRD', 'PRD', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/prd.md', 'PRD');
  }
  // FRs
  ins.run(10, 1, epicId, 'FR', 'FR-1', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/fr-1.md', 'FR-1');
  // NFRs
  ins.run(11, 1, epicId, 'NFR', 'NFR-1', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/nfr-1.md', 'NFR-1');
  // UC
  ins.run(20, 1, epicId, 'UC', 'UC-1', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/uc-1.md', 'UC-1');
  // ACs
  ins.run(30, 1, epicId, 'AC', 'AC-1', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/ac-1.md', 'AC-1');
  ins.run(31, 1, epicId, 'AC', 'AC-2', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/ac-2.md', 'AC-2');
  // SRS
  if (mode !== 'no-srs') {
    ins.run(40, 1, epicId, 'SRS', 'SRS', 'accepted', acceptedHash, acceptedHash, 'clean', 'docs/srs.md', 'SRS');
  }

  // Traces
  const trace = db.prepare(
    `INSERT INTO artifact_traces (source_id,target_type,target_id,link_type) VALUES (?,?,?,?)`,
  );
  // PRD -> brief (derived_from)
  if (mode !== 'no-prd') trace.run(2, 'artifact', 1, 'derived_from');
  // SRS -> PRD (derived_from)
  if (mode !== 'no-srs' && mode !== 'no-prd') trace.run(40, 'artifact', 2, 'derived_from');
  // UC -> PRD (derived_from)
  if (mode !== 'no-prd') trace.run(20, 'artifact', 2, 'derived_from');
  // UC -> FR (covers) — unless we want a trace gap
  if (mode !== 'trace-gap-uc-fr') trace.run(20, 'artifact', 10, 'covers');
  // AC -> FR (derived_from)
  trace.run(30, 'artifact', 10, 'derived_from');
  trace.run(31, 'artifact', 10, 'derived_from');
  // FR-derived ACs must also trace to the behavioural UC.
  trace.run(30, 'artifact', 20, 'derived_from');
  trace.run(31, 'artifact', 20, 'derived_from');

  // Formalization tasks — all done+merged unless tasks-not-ready.
  const taskStatus = mode === 'tasks-not-ready' ? 'todo' : 'done';
  const taskIntegration = mode === 'tasks-not-ready' ? 'pending' : 'merged';
  db.prepare(
    `INSERT INTO tasks (id,epic_id,title,status,priority,task_kind,workflow_stage,execution_skill,execution_mode,integration_state,generation_key,tags,metadata)
     VALUES (?,?,?,?,?,'formalization.prd','formalization','saga-product','tracker_only',?,'g','[]','{}')`,
  ).run(70, epicId, 'PRD task', taskStatus, 'high', taskIntegration);
}

function buildEngine(db) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const engine = new Saga3FormalizationEngine({
    db, processRunRepo, certificateRepo,
    resolveFormalizationCase: command => ({
      discoveryEpicId: 50,
      formalizationEpicId: command.epicId,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go',
      initiatedBy: 'operator',
    }),
  });
  return { engine, processRunRepo, certificateRepo };
}

// --- Tests ------------------------------------------------------------------

test('E2E happy path: complete graph → formalized + certificate', async () => {
  const { temp, db } = fixture('complete');
  try {
    const { engine, processRunRepo, certificateRepo } = buildEngine(db);
    const result = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(result.outcome, 'formalized');
    assert.equal(result.finalStage, 'formalization');
    assert.equal(result.reason, 'completed');
    assert.equal(result.processModule.kind, 'formalization');
    assert.equal(result.processOutcome.authority, 'formalization_settlement_policy');

    // The ProcessRun is terminal + has a certificate.
    const runs = processRunRepo.list(1, 100);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].localOutcome, 'formalized');
    assert.ok(runs[0].certificateHash);

    const cert = certificateRepo.readByProcessRun(runs[0].id);
    assert.ok(cert);
    assert.equal(cert.decision, 'formalized');
    assert.equal(cert.authority, 'formalization_settlement_policy');
  } finally { cleanup(temp); }
});

test('E2E clarification-required: missing PRD', async () => {
  const { temp, db } = fixture('no-prd');
  try {
    const { engine } = buildEngine(db);
    const result = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(result.outcome, 'clarification-required');
    assert.equal(result.processOutcome.code, 'clarification-required');
  } finally { cleanup(temp); }
});

test('E2E clarification-required: missing SRS', async () => {
  const { temp, db } = fixture('no-srs');
  try {
    const { engine } = buildEngine(db);
    const result = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(result.outcome, 'clarification-required');
  } finally { cleanup(temp); }
});

test('E2E inconsistent: traceability gap (UC missing covers→FR)', async () => {
  const { temp, db } = fixture('trace-gap-uc-fr');
  try {
    const { engine } = buildEngine(db);
    const result = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(result.outcome, 'inconsistent');
  } finally { cleanup(temp); }
});

test('E2E inconsistent: formalization tasks not ready', async () => {
  const { temp, db } = fixture('tasks-not-ready');
  try {
    const { engine } = buildEngine(db);
    const result = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(result.outcome, 'inconsistent');
  } finally { cleanup(temp); }
});

test('E2E restart: re-run on the same epic returns the persisted terminal result', async () => {
  const { temp, db } = fixture('complete');
  try {
    const { engine, processRunRepo, certificateRepo } = buildEngine(db);
    const first = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(first.outcome, 'formalized');

    // Re-run — the ProcessRun is already terminal, the engine short-circuits
    // and returns the persisted outcome. No second certificate is issued.
    const second = await engine.run({ projectId: 1, epicId: 100 });
    assert.equal(second.outcome, 'formalized');

    const runs = processRunRepo.list(1, 100);
    assert.equal(runs.length, 1, 'no second ProcessRun row');
    const certs = certificateRepo.list(1, 100);
    assert.equal(certs.length, 1, 'no second certificate');
  } finally { cleanup(temp); }
});

// Discovery is a product-idea gate, not a build gate. A weak idea
// (clarify/reject/defer/inconclusive/failed) must still pass into formalization;
// the strength of the idea is recorded in the discovery certificate, not used
// to block settlement. The settlement handler must reason about the contract
// (PRD/UC/AC/SRS/baseline), not about the discovery decision.
test('E2E weak idea: non-go discovery outcome still reaches formalization settlement', async () => {
  const { temp, db } = fixture('complete');
  try {
    const processRunRepo = new SqliteProcessRunRepository(db);
    const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
    const engine = new Saga3FormalizationEngine({
      db, processRunRepo, certificateRepo,
      resolveFormalizationCase: command => ({
        discoveryEpicId: 50,
        formalizationEpicId: command.epicId,
        discoveryCertificateRef: 'certificate:5',
        discoveryCertificateHash: 'd'.repeat(64),
        // Discovery said "the idea needs clarification". Formalization must
        // still run settlement on the contract, not reject on the decision.
        discoveryOutcome: 'clarify',
        initiatedBy: 'operator',
      }),
    });
    const result = await engine.run({ projectId: 1, epicId: 100 });
    // Settlement reached a real decision on the contract (formalized),
    // proving the gate did not throw on the non-go discovery outcome.
    assert.equal(result.outcome, 'formalized');
    assert.equal(result.reason, 'completed');
  } finally { cleanup(temp); }
});

test('E2E duplicate start: process_run_start with same idempotency_key replays', () => {
  const { temp, db } = fixture('complete');
  try {
    const processRunRepo = new SqliteProcessRunRepository(db);
    const casePayload = {
      schemaVersion: FORMALIZATION_CASE_SCHEMA,
      discoveryEpicId: 50, formalizationEpicId: 100,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go', initiatedBy: 'operator',
    };
    const start = (key) => processRunRepo.start({
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      executorKind: 'legacy-adapter',
      input: { schema: FORMALIZATION_CASE_SCHEMA, payload: casePayload,
        contentHash: hashFormalizationCase(casePayload) },
      projectedStage: 'formalization',
      invocationContext: { projectId: 1, epicId: 100, initiatedBy: 'operator', idempotencyKey: key },
    });
    const a = start('formalization-epic-100');
    const b = start('formalization-epic-100');
    assert.equal(b.replayed, true);
    assert.equal(b.record.id, a.record.id);
  } finally { cleanup(temp); }
});

test('E2E certificate replay: re-issue same hash returns replayed=true', async () => {
  const { temp, db } = fixture('complete');
  try {
    const { engine, certificateRepo } = buildEngine(db);
    await engine.run({ projectId: 1, epicId: 100 });
    const cert = certificateRepo.list(1, 100)[0];
    // Re-issue the exact same payload + hash.
    const { replayed } = certificateRepo.issue({
      processRunId: cert.processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 100,
      payload: cert.certificatePayload,
      certificateHash: cert.certificateHash,
      authority: 'formalization_settlement_policy',
    });
    assert.equal(replayed, true);
    assert.equal(certificateRepo.list(1, 100).length, 1);
  } finally { cleanup(temp); }
});

test('E2E: adapter drives the ProcessRun through the full lifecycle', async () => {
  // Direct adapter invocation (not through the engine) — verifies the
  // preparing→running→settling→completed path on a fresh ProcessRun.
  const { temp, db } = fixture('complete');
  try {
    const processRunRepo = new SqliteProcessRunRepository(db);
    const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
    const graph = new SqliteFormalizationArtifactGraph(db);
    const policy = new ReferenceFormalizationSettlementPolicy();
    const adapter = new LegacyFormalizationProcessAdapter({
      graph, policy, processRunRepo, certificateRepo,
    });
    const casePayload = {
      schemaVersion: FORMALIZATION_CASE_SCHEMA,
      discoveryEpicId: 50, formalizationEpicId: 100,
      discoveryCertificateRef: 'certificate:5',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go', initiatedBy: 'operator',
    };
    const { record } = processRunRepo.start({
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      executorKind: 'legacy-adapter',
      input: { schema: FORMALIZATION_CASE_SCHEMA, payload: casePayload,
        contentHash: hashFormalizationCase(casePayload) },
      projectedStage: 'formalization',
      invocationContext: { projectId: 1, epicId: 100, initiatedBy: 'operator', idempotencyKey: 'k' },
    });
    assert.equal(record.status, 'created');
    const result = await adapter.execute(undefined, {
      projectId: 1, epicId: 100, processRunId: record.id,
      inputPayload: casePayload,
      inputHash: hashFormalizationCase(casePayload),
      initiatedBy: 'operator',
    });
    assert.equal(result.outcome, 'formalized');
    const after = processRunRepo.read(record.id);
    assert.equal(after.status, 'completed');
    assert.ok(after.completedAt);
  } finally { cleanup(temp); }
});
