import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { createProductLifecycleRuntime } = await import(
  '../../dist/process-modules/composition/product-lifecycle-runtime.js'
);
const {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} = await import(
  '../../dist/process-modules/modules/development/development-settlement-policy.js'
);
const {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} = await import(
  '../../dist/process-modules/modules/delivery/delivery-settlement-policy.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-product-composition-'));
  process.env.DB_PATH = path.join(temp, 'composition.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function dependencies(db) {
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
    development: {
      taskGraph: {
        materializeValidatedTaskGraph: notExecuted,
      },
      implementationWorkset: { execute: notExecuted },
      candidateIntegration: { integrateAndFreeze: notExecuted },
      acceptanceVerification: { verify: notExecuted },
      settlementState: { buildSettlementInput: notExecuted },
      taskGraphPolicy: new ReferenceDevelopmentTaskGraphPolicy(),
      settlementPolicy: new ReferenceDevelopmentSettlementPolicy(),
    },
    delivery: {
      preflightState: { buildPreflightSnapshot: notExecuted },
      approval: { decide: notExecuted },
      publication: { publishAndDeploy: notExecuted },
      observation: { observe: notExecuted },
      settlementState: { buildSettlementInput: notExecuted },
      preflightPolicy: new ReferenceDeliveryPreflightPolicy(),
      settlementPolicy: new ReferenceDeliverySettlementPolicy(),
    },
  };
}

test('composition installs all module capabilities and refuses implicit input/provider defaults', async () => {
  const fx = fixture();
  try {
    const options = dependencies(fx.db);
    const runtime = createProductLifecycleRuntime(options);

    assert.deepEqual(
      runtime.installationRegistry.list().map(item => item.definition.identity.name),
      [
        'product-discovery',
        'solution-formalization',
        'solution-development',
        'delivery-release',
      ],
    );
    assert.equal(runtime.externalAdapters.list().length, 5);
    assert.equal(runtime.humanInteractions.list().length, 1);
    assert.deepEqual(
      [...runtime.outputPayloadRegistry.listSchemas()].sort(),
      [
        'saga3.release-record.v1',
        'saga3.solution-contract-certificate.v1',
        'saga3.verified-integration-bundle.v1',
      ].sort(),
    );
    await assert.rejects(
      runtime.engine.run({ projectId: 1, epicId: 10 }),
      /PRODUCT_LIFECYCLE_INPUT_REQUIRED/,
    );
    assert.equal(
      fx.db.prepare('SELECT COUNT(*) AS n FROM saga3_lifecycle_runs').get().n,
      0,
    );

    assert.throws(
      () => createProductLifecycleRuntime({
        ...options,
        delivery: { ...options.delivery, publication: null },
      }),
      /PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: delivery.publication/,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('composition supplies standard development mechanics and durable delivery approval', () => {
  const fx = fixture();
  try {
    const notExecuted = () => {
      throw new Error('test provider must not execute during composition');
    };
    const runtime = createProductLifecycleRuntime({
      db: fx.db,
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
    });

    assert.ok(runtime.runtimes.development);
    assert.ok(runtime.runtimes.delivery);
    assert.ok(runtime.interactions.deliveryApprovalInbox);
    assert.equal(runtime.humanInteractions.list().length, 1);
  } finally {
    cleanup(fx.temp);
  }
});
