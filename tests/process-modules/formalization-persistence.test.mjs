import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const {
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} = await import(
  '../../dist/process-modules/modules/formalization/formalization-persistence.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-formalization-persistence-'));
  process.env.DB_PATH = path.join(temp, 'formalization.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'Formalization')`).run();
  const runRepository = new SqliteProcessRunRepository(db);
  const { record } = runRepository.start({
    moduleRef: { name: 'solution-formalization', version: '1.0.0' },
    executorKind: 'generic-flow',
    input: {
      schema: 'saga3.formalization-case.v1',
      payload: { formalizationEpicId: 10 },
      contentHash: createHash('sha256')
        .update(JSON.stringify({ formalizationEpicId: 10 }))
        .digest('hex'),
    },
    projectedStage: 'formalization',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey: 'formalization-persistence',
    },
  });
  return { temp, db, processRunId: record.id };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function baselinePayload(processRunId, overrides = {}) {
  return {
    schemaVersion: 'saga3.acceptance-baseline-snapshot.v1',
    processRunId,
    formalizationEpicId: 10,
    sourceReconciliationRef: 'formalization-node-product:reconciliation',
    sourceReconciliationHash: 'a'.repeat(64),
    acArtifactIds: [30],
    acArtifactHashes: { 30: 'b'.repeat(64) },
    baselineHash: 'c'.repeat(64),
    ...overrides,
  };
}

function solutionPayload(processRunId, baselineRecord, overrides = {}) {
  return {
    schemaVersion: 'saga3.solution-contract-certificate.v1',
    processRunId,
    formalizationEpicId: 10,
    discoveryCertificateRef: 'process-outcome-certificate:1',
    discoveryCertificateHash: 'd'.repeat(64),
    bundle: {
      schemaVersion: 'saga3.solution-contract-certificate.v1',
      formalizationEpicId: 10,
      prdArtifactId: 10,
      frArtifactIds: [11],
      nfrArtifactIds: [12],
      ruleArtifactIds: [],
      ucArtifactIds: [20],
      acArtifactIds: [30],
      acceptanceBaselineHash: 'c'.repeat(64),
      srsArtifactId: 40,
      bundleHash: 'e'.repeat(64),
    },
    artifactHashes: {
      10: '1'.repeat(64),
      11: '2'.repeat(64),
      12: '3'.repeat(64),
      20: '4'.repeat(64),
      30: '5'.repeat(64),
      40: '6'.repeat(64),
    },
    traceIds: [101, 102, 103],
    traceDigest: '7'.repeat(64),
    baselineSnapshotRef: baselineRecord.artifactRef,
    baselineSnapshotHash: baselineRecord.snapshotHash,
    srs: {
      schema: 'saga3.srs.v1',
      ref: 'artifact:40',
      hash: '6'.repeat(64),
    },
    acceptanceCriteria: [{
      artifactId: 30,
      code: 'AC-30',
      acceptedHash: '5'.repeat(64),
      implementationRequired: true,
    }],
    ...overrides,
  };
}

test('formalization baseline and SolutionContract are durable, replayable, and write-once', () => {
  const fx = fixture();
  try {
    const baselineRepository = new SqliteFormalizationBaselineRepository(fx.db);
    const solutionRepository = new SqliteFormalizationSolutionContractRepository(fx.db);

    const firstBaseline = baselineRepository.freeze(baselinePayload(fx.processRunId));
    assert.equal(firstBaseline.replayed, false);
    assert.equal(firstBaseline.record.artifactRef, 'formalization-baseline:1');
    assert.deepEqual(
      baselineRepository.readByProcessRun(fx.processRunId),
      firstBaseline.record,
    );

    const replayedBaseline = baselineRepository.freeze(baselinePayload(fx.processRunId));
    assert.equal(replayedBaseline.replayed, true);
    assert.equal(replayedBaseline.record.id, firstBaseline.record.id);
    assert.throws(
      () => baselineRepository.freeze(
        baselinePayload(fx.processRunId, { baselineHash: 'f'.repeat(64) }),
      ),
      /FORMALIZATION_BASELINE_ALREADY_FROZEN/,
    );

    const firstSolution = solutionRepository.persist(
      solutionPayload(fx.processRunId, firstBaseline.record),
    );
    assert.equal(firstSolution.replayed, false);
    assert.equal(firstSolution.record.artifactRef, 'formalization-solution-contract:1');
    assert.deepEqual(
      solutionRepository.readByProcessRun(fx.processRunId),
      firstSolution.record,
    );

    const replayedSolution = solutionRepository.persist(
      solutionPayload(fx.processRunId, firstBaseline.record),
    );
    assert.equal(replayedSolution.replayed, true);
    assert.equal(replayedSolution.record.id, firstSolution.record.id);
    assert.throws(
      () => solutionRepository.persist(
        solutionPayload(fx.processRunId, firstBaseline.record, {
          traceDigest: '8'.repeat(64),
        }),
      ),
      /FORMALIZATION_SOLUTION_CONTRACT_ALREADY_PERSISTED/,
    );
  } finally {
    cleanup(fx.temp);
  }
});
