import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { createProductLifecycleRuntime } = await import(
  '../../dist/app/product-lifecycle-runtime.js'
);
const {
  ReferenceDevelopmentSettlementPolicy,
  ReferenceDevelopmentTaskGraphPolicy,
} = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const {
  ReferenceDeliveryPreflightPolicy,
  ReferenceDeliverySettlementPolicy,
} = await import(
  '../../dist/modules/delivery/domain/delivery-settlement-policy.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-product-composition-'));
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
        'solution-development-verification-continuation',
        'solution-development-managed',
        'delivery-release',
      ],
    );
    // externalAdapters removed in saga4 cutover (external node kind deleted);
    // delivery publish-deploy/observe-release are now kernel handlers.
    assert.equal(runtime.humanInteractions.list().length, 1);
    // W13-A3: the deleted ProcessOutputPayloadRegistry is replaced by a single
    // injected resolveOutputPayload callback. The three module output schemas
    // are still wired (formalization/development/delivery); an unknown schema
    // is rejected by the dispatch closure, and the orchestrator re-checks the
    // returned payload hash itself.
    const resolveOutputPayload = runtime.resolveOutputPayload;
    assert.equal(typeof resolveOutputPayload, 'function');
    for (const schema of [
      'factory.release-record.v1',
      'factory.solution-contract-certificate.v1',
      'factory.verified-integration-bundle.v1',
    ]) {
      // Each registered schema is accepted (dispatch finds a resolver); the
      // per-module resolver then validates the ref against storage and throws
      // because the artifact does not exist in this empty fixture DB. The
      // key assertion: it is NOT the dispatch "is not registered" error.
      let dispatchError = false;
      try {
        await resolveOutputPayload({
          processRunId: 999,
          moduleRef: { name: 'any', version: '1.0.0' },
          projectId: 1,
          epicId: 10,
          output: { schema, artifactRef: 'no-such-artifact', contentHash: '0'.repeat(64) },
        });
      } catch (err) {
        dispatchError = /is not registered/.test(err.message);
      }
      assert.equal(
        dispatchError,
        false,
        `schema '${schema}' must be wired to a per-module resolver (not the dispatch error)`,
      );
    }
    // An unknown schema is rejected by the dispatch closure itself.
    await assert.rejects(
      async () => resolveOutputPayload({
        processRunId: 999,
        moduleRef: { name: 'any', version: '1.0.0' },
        projectId: 1,
        epicId: 10,
        output: { schema: 'factory.unknown.v1', artifactRef: 'x', contentHash: '0'.repeat(64) },
      }),
      /no output payload resolver/,
    );
    await assert.rejects(
      runtime.engine.run({ projectId: 1, epicId: 10 }),
      /PRODUCT_LIFECYCLE_INPUT_REQUIRED/,
    );
    assert.equal(
      fx.db.prepare('SELECT COUNT(*) AS n FROM factory_lifecycle_runs').get().n,
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
