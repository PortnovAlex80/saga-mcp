// P3 tests: Generic ProcessOutcomeCertificate.
//
// Covers:
//   - schema creation idempotent
//   - issue is idempotent on certificate_hash (replay returns same row)
//   - re-issuing a DIFFERENT hash for the same process_run_id throws
//     PROCESS_RUN_ALREADY_CERTIFIED
//   - one certificate per process_run_id (UNIQUE index)
//   - read by id / by process_run / by hash / by module+run
//   - list by project / by project+epic
//   - certificate_hash is UNIQUE globally (integrity check)

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
const {
  SqliteProcessOutcomeCertificateRepository,
  hashProcessOutcomeCertificatePayload,
} = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-poc-'));
  process.env.DB_PATH = path.join(temp, 'poc.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  // We need a ProcessRun row to attach certificates to.
  const runRepo = new SqliteProcessRunRepository(db);
  const { record } = runRepo.start({
    moduleRef: { name: 'solution-formalization', version: '1.0.0' },
    executorKind: 'legacy-adapter',
    input: {
      schema: 'saga3.formalization-case.v1',
      payload: { epicId: 10 },
      contentHash: createHash('sha256').update(JSON.stringify({ epicId: 10 })).digest('hex'),
    },
    projectedStage: 'formalization',
    invocationContext: {
      projectId: 1, epicId: 10, initiatedBy: 'op', idempotencyKey: 'k1',
    },
  });
  return { temp, db, processRunId: record.id, runRepo };
}
function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function makePayload({ decision = 'accepted', rationale = 'ok' } = {}) {
  return {
    schemaVersion: 'saga3.solution-contract-certificate.v1',
    decision,
    reasonCodes: [],
    rationale,
    inputHash: 'i'.repeat(64),
    payload: { baselineHash: 'b'.repeat(64), srsHash: 's'.repeat(64) },
  };
}

test('schema creation is idempotent', () => {
  const { temp, db } = fixture();
  try {
    new SqliteProcessOutcomeCertificateRepository(db);
    new SqliteProcessOutcomeCertificateRepository(db);
    const cols = db.prepare('PRAGMA table_info(saga3_process_outcome_certificates)').all().map(c => c.name);
    assert.ok(cols.includes('certificate_hash'));
    assert.ok(cols.includes('process_run_id'));
    assert.ok(cols.includes('authority'));
  } finally { cleanup(temp); }
});

test('issue creates a certificate and read returns it', () => {
  const { temp, processRunId } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository();
    const payload = makePayload();
    const hash = hashProcessOutcomeCertificatePayload(payload);
    const { record, replayed } = repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload,
      certificateHash: hash,
      authority: 'formalization_settlement_policy',
    });
    assert.equal(replayed, false);
    assert.equal(record.decision, 'accepted');
    assert.equal(record.certificateHash, hash);
    assert.equal(record.authority, 'formalization_settlement_policy');
    assert.equal(record.processRunId, processRunId);

    assert.equal(repo.read(record.id)?.id, record.id);
    assert.equal(repo.readByProcessRun(processRunId)?.id, record.id);
    assert.equal(repo.readByHash(hash)?.id, record.id);
  } finally { cleanup(temp); }
});

test('issue is idempotent on certificate_hash (replay)', () => {
  const { temp, processRunId } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository();
    const payload = makePayload();
    const hash = hashProcessOutcomeCertificatePayload(payload);
    const first = repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload, certificateHash: hash,
      authority: 'formalization_settlement_policy',
    });
    const second = repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload, certificateHash: hash,
      authority: 'formalization_settlement_policy',
    });
    assert.equal(second.replayed, true);
    assert.equal(second.record.id, first.record.id);
  } finally { cleanup(temp); }
});

test('re-issuing a DIFFERENT hash for the same process_run_id throws PROCESS_RUN_ALREADY_CERTIFIED', () => {
  const { temp, processRunId } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository();
    const payload1 = makePayload({ rationale: 'first' });
    repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload: payload1,
      certificateHash: hashProcessOutcomeCertificatePayload(payload1),
      authority: 'formalization_settlement_policy',
    });
    // Different payload → different hash → must throw.
    const payload2 = makePayload({ rationale: 'second' });
    assert.throws(
      () => repo.issue({
        processRunId,
        moduleRef: { name: 'solution-formalization', version: '1.0.0' },
        projectId: 1, epicId: 10,
        payload: payload2,
        certificateHash: hashProcessOutcomeCertificatePayload(payload2),
        authority: 'formalization_settlement_policy',
      }),
      /PROCESS_RUN_ALREADY_CERTIFIED/,
    );
  } finally { cleanup(temp); }
});

test('certificate_hash is UNIQUE globally (two runs cannot share a hash)', () => {
  const { temp, db, runRepo } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository(db);
    // Start a second run on a different idempotency key.
    const { record: run2 } = runRepo.start({
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      executorKind: 'legacy-adapter',
      input: {
        schema: 'saga3.formalization-case.v1',
        payload: { epicId: 10 },
        contentHash: createHash('sha256').update(JSON.stringify({ epicId: 10 })).digest('hex'),
      },
      projectedStage: 'formalization',
      invocationContext: {
        projectId: 1, epicId: 10, initiatedBy: 'op', idempotencyKey: 'k2',
      },
    });

    const payload = makePayload();
    const hash = hashProcessOutcomeCertificatePayload(payload);
    // First issue is fine. We need a run id to attach to; use the fixture's.
    const firstRunId = (() => {
      const r = db.prepare('SELECT MIN(id) AS m FROM saga3_process_runs').get();
      return r.m;
    })();
    repo.issue({
      processRunId: firstRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload, certificateHash: hash,
      authority: 'formalization_settlement_policy',
    });
    // Reusing the same hash for a different run → SQLite UNIQUE violation surfaces.
    assert.throws(
      () => repo.issue({
        processRunId: run2.id,
        moduleRef: { name: 'solution-formalization', version: '1.0.0' },
        projectId: 1, epicId: 10,
        payload, certificateHash: hash,
        authority: 'formalization_settlement_policy',
      }),
    );
  } finally { cleanup(temp); }
});

test('list returns certificates scoped to project / epic', () => {
  const { temp, processRunId } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository();
    const payload = makePayload();
    repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload,
      certificateHash: hashProcessOutcomeCertificatePayload(payload),
      authority: 'formalization_settlement_policy',
    });
    assert.equal(repo.list(1, null).length, 1);
    assert.equal(repo.list(1, 10).length, 1);
    assert.equal(repo.list(1, 99).length, 0);
    assert.equal(repo.list(2, null).length, 0);
  } finally { cleanup(temp); }
});

test('readByModuleRun resolves by (project, module, run)', () => {
  const { temp, processRunId } = fixture();
  try {
    const repo = new SqliteProcessOutcomeCertificateRepository();
    const payload = makePayload();
    const { record } = repo.issue({
      processRunId,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1, epicId: 10,
      payload,
      certificateHash: hashProcessOutcomeCertificatePayload(payload),
      authority: 'formalization_settlement_policy',
    });
    const found = repo.readByModuleRun(
      1, { name: 'solution-formalization', version: '1.0.0' }, processRunId,
    );
    assert.equal(found?.id, record.id);
  } finally { cleanup(temp); }
});
