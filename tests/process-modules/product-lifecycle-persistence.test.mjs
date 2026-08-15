import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteDevelopmentOutputRepository } = await import(
  '../../dist/modules/development/infrastructure/development-persistence.js'
);
const { SqliteDeliveryOutputRepository } = await import(
  '../../dist/modules/delivery/infrastructure/delivery-persistence.js'
);
const {
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const { RELEASE_RECORD_SCHEMA } = await import(
  '../../dist/modules/delivery/domain/delivery-schemas.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-product-output-'));
  process.env.DB_PATH = path.join(temp, 'output.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  return {
    temp,
    db,
    processRepo: new SqliteProcessRunRepository(db),
    developmentRepo: new SqliteDevelopmentOutputRepository(db),
    deliveryRepo: new SqliteDeliveryOutputRepository(db),
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startProcess(processRepo, moduleRef, key) {
  const payload = { case: key };
  return processRepo.start({
    moduleRef,
    executorKind: 'generic-flow',
    projectedStage: moduleRef.name,
    input: {
      schema: `test.${moduleRef.name}.input.v1`,
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey: key,
    },
  }).record;
}

test('Development output is canonical, write-once and bound to its exact ProcessRun', () => {
  const fx = fixture();
  try {
    const run = startProcess(
      fx.processRepo,
      { name: 'solution-development', version: '1.4.2' },
      'development-output',
    );
    const payload = {
      schemaVersion: VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      bundleHash: 'bundle-a',
      integratedCandidate: { hash: 'candidate-a' },
    };
    const first = fx.developmentRepo.persist({
      processRunId: run.id,
      projectId: 1,
      epicId: 10,
      payload,
    });
    const replay = fx.developmentRepo.persist({
      processRunId: run.id,
      projectId: 1,
      epicId: 10,
      payload,
    });

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.artifactRef, first.record.artifactRef);
    assert.equal(first.record.contentHash, sha256Hex(payload));
    assert.deepEqual(fx.developmentRepo.readByProcessRun(run.id).payload, payload);
    assert.throws(
      () => fx.developmentRepo.persist({
        processRunId: run.id,
        projectId: 1,
        epicId: 10,
        payload: { ...payload, bundleHash: 'bundle-b' },
      }),
      /DEVELOPMENT_OUTPUT_ALREADY_PERSISTED/,
    );
    assert.throws(
      () => fx.db.prepare(
        `UPDATE factory_development_outputs SET content_hash='tampered' WHERE process_run_id=?`,
      ).run(run.id),
      /DEVELOPMENT_OUTPUT_IMMUTABLE/,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('Development output accepts an explicitly installed continuation module', () => {
  const fx = fixture();
  try {
    const moduleRef = {
      name: 'solution-development-verification-continuation',
      version: '1.0.0',
    };
    const run = startProcess(fx.processRepo, moduleRef, 'verification-continuation-output');
    const repository = new SqliteDevelopmentOutputRepository(fx.db, [moduleRef]);
    const payload = {
      schemaVersion: VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      bundleHash: 'bundle-continuation',
      integratedCandidate: { hash: 'candidate-continuation' },
    };
    const persisted = repository.persist({
      processRunId: run.id,
      projectId: 1,
      epicId: 10,
      payload,
    });
    assert.equal(persisted.replayed, false);
    assert.deepEqual(persisted.record.payload, payload);
  } finally {
    cleanup(fx.temp);
  }
});

test('Delivery output rejects wrong module binding and detects stored-content tampering', () => {
  const fx = fixture();
  try {
    const wrongRun = startProcess(
      fx.processRepo,
      { name: 'solution-development', version: '1.0.0' },
      'wrong-delivery-output',
    );
    const payload = {
      schemaVersion: RELEASE_RECORD_SCHEMA,
      recordHash: 'release-a',
      destinations: [],
    };
    assert.throws(
      () => fx.deliveryRepo.persist({
        processRunId: wrongRun.id,
        projectId: 1,
        epicId: 10,
        payload,
      }),
      /DELIVERY_OUTPUT_PROCESS_RUN_BINDING_MISMATCH/,
    );

    const run = startProcess(
      fx.processRepo,
      { name: 'delivery-release', version: '1.0.0' },
      'delivery-output',
    );
    const persisted = fx.deliveryRepo.persist({
      processRunId: run.id,
      projectId: 1,
      epicId: 10,
      payload,
    });
    assert.equal(persisted.record.contentHash, sha256Hex(payload));

    fx.db.exec('DROP TRIGGER trg_factory_delivery_outputs_no_update');
    fx.db.prepare(
      `UPDATE factory_delivery_outputs SET content_hash=? WHERE process_run_id=?`,
    ).run('0'.repeat(64), run.id);
    assert.throws(
      () => fx.deliveryRepo.readByProcessRun(run.id),
      /DELIVERY_OUTPUT_INTEGRITY_MISMATCH/,
    );
  } finally {
    cleanup(fx.temp);
  }
});
