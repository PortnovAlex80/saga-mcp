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
  DELIVERY_PROCESS_MODULE_REF,
} = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
const {
  DELIVERY_RELEASE_CASE_SCHEMA,
} = await import(
  '../../dist/modules/delivery/domain/delivery-schemas.js'
);
const {
  hashDeliveryReleasePolicy,
} = await import(
  '../../dist/modules/delivery/domain/delivery-settlement-policy.js'
);
const {
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const lifecycleRunTools = await import('../../dist/tools/lifecycle-runs.js');

const deliveryOnlyLifecycle = {
  identity: {
    name: 'delivery-resume-test',
    version: '1.0.0',
    displayName: 'Delivery Resume Test',
    description: 'Exercises a durable Delivery approval pause and resume.',
  },
  entryStageId: 'delivery',
  stages: [{
    id: 'delivery',
    displayName: 'Delivery',
    moduleRef: DELIVERY_PROCESS_MODULE_REF,
    inputMapping: {
      schemaVersion: '$.schemaVersion',
      projectId: '$.projectId',
      epicId: '$.epicId',
      developmentCertificate: '$.developmentCertificate',
      verifiedIntegrationBundle: '$.verifiedIntegrationBundle',
      integratedCandidate: '$.integratedCandidate',
      deliveryMode: '$.deliveryMode',
      policy: '$.policy',
      operatorAuthorization: '$.operatorAuthorization',
      deferredProfile: '$.deferredProfile',
      initiatedBy: '$.initiatedBy',
    },
    outcomeRoutes: {
      released: { type: 'terminal', status: 'released' },
      'approval-required': {
        type: 'terminal',
        status: 'approval-required',
      },
      blocked: { type: 'terminal', status: 'blocked' },
      failed: { type: 'terminal', status: 'failed' },
    },
    entryConditions: ['A verified candidate and release policy exist'],
    exitConditions: ['The exact desired state is observed'],
  }],
};

test('delivery pause resumes the same lifecycle and applies one external effect', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-delivery-resume-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(temp, 'delivery.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
    const addProvider = db.prepare(
      `INSERT INTO trusted_providers
        (id,project_id,name,version,category,trust_basis,determinism,scope,status)
       VALUES (?,?,?,?,?,'test fixture','none','delivery','active')`,
    );
    addProvider.run(1, 1, 'preflight', '1', 'deterministic_evidence');
    addProvider.run(2, 1, 'deployer', '1', 'authoritative_state');
    addProvider.run(3, 1, 'release-owner', '1', 'authorized_decision');

    const candidateHash = sha256Hex({ candidate: 'circle-v1' });
    const desiredStateHash = sha256Hex({ deployed: 'circle-v1' });
    const action = {
      actionId: 'deploy-school-circle',
      kind: 'deployment',
      target: 'school-circle-production',
      desiredStateHash,
      payloadHash: sha256Hex({ artifact: 'circle-v1' }),
      required: true,
    };
    const policyBody = {
      id: 'release-policy',
      version: '1',
      contentHash: '',
      channel: 'production',
      releaseVersion: '1.0.0',
      releaseTag: 'v1.0.0',
      humanApprovalRequired: true,
      requiredPreflightCheckIds: ['candidate-integrity'],
      actions: [action],
    };
    const policy = {
      ...policyBody,
      contentHash: hashDeliveryReleasePolicy(policyBody),
    };
    const deliveryCase = {
      schemaVersion: DELIVERY_RELEASE_CASE_SCHEMA,
      projectId: 1,
      epicId: 10,
      developmentCertificate: {
        schema: DEVELOPMENT_CERTIFICATE_SCHEMA,
        ref: 'development-certificate:circle-v1',
        hash: sha256Hex({ certificate: 'circle-v1' }),
        decision: 'verified',
      },
      verifiedIntegrationBundle: {
        schema: VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
        ref: 'verified-bundle:circle-v1',
        hash: sha256Hex({ bundle: 'circle-v1' }),
      },
      integratedCandidate: {
        schema: INTEGRATED_CANDIDATE_SCHEMA,
        ref: 'integrated-candidate:circle-v1',
        hash: candidateHash,
      },
      deliveryMode: 'authorized',
      policy,
      operatorAuthorization: {
        schema: 'saga3.operator-authorization.v1',
        ref: 'operator-authorization:circle-v1',
        hash: sha256Hex({ operator: 'release-owner', candidateHash }),
        requestedBy: 'release-owner',
        releasePolicyHash: policy.contentHash,
        candidateScope: {
          mode: 'exact',
          candidateHash,
        },
      },
      deferredProfile: null,
      initiatedBy: 'test',
    };

    let applied = false;
    let executionCount = 0;
    const runtime = createProductLifecycleRuntime({
      db,
      workerExecutorFactory: () => {
        throw new Error('Delivery-only lifecycle must not start an LM worker');
      },
      resolveWorkerContext: () => {
        throw new Error('Delivery-only lifecycle must not resolve an LM worker');
      },
      delivery: {
        providers: {
          preflight: {
            evaluate: ({ checkId }) => ({
              outcome: 'passed',
              evidence: {
                schema: 'saga3.preflight-evidence.v1',
                ref: `preflight:${checkId}:${candidateHash}`,
                hash: sha256Hex({ checkId, candidateHash, outcome: 'passed' }),
              },
              provider: {
                providerId: 1,
                name: 'preflight',
                version: '1',
                category: 'deterministic_evidence',
              },
            }),
          },
          actionProviders: {
            deployment: {
              namespace: 'test-deployer',
              identity: {
                providerId: 2,
                name: 'deployer',
                version: '1',
                category: 'authoritative_state',
              },
              async execute() {
                executionCount += 1;
                applied = true;
                return {
                  outcome: 'succeeded',
                  externalRef: 'deployment:school-circle-production',
                  resultHash: desiredStateHash,
                };
              },
              async observe({ actionKey }) {
                const observedStateHash = applied
                  ? desiredStateHash
                  : sha256Hex({ deployed: null });
                return {
                  outcome: applied ? 'matched' : 'mismatched',
                  observedStateHash,
                  observation: {
                    schema: 'saga3.deployment-observation.v1',
                    ref: `deployment-observation:${actionKey}:${observedStateHash}`,
                    hash: sha256Hex({ actionKey, observedStateHash }),
                  },
                };
              },
            },
          },
          observeCurrentCandidateHash: () => candidateHash,
        },
      },
    });

    const command = {
      projectId: 1,
      epicId: 10,
      inputSchema: DELIVERY_RELEASE_CASE_SCHEMA,
      inputPayload: deliveryCase,
      initiatedBy: 'test',
      idempotencyKey: 'delivery-circle-v1',
    };
    const paused = await runtime.orchestrator.run(
      deliveryOnlyLifecycle,
      command,
    );
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pausedAtStageId, 'delivery');
    assert.equal(executionCount, 0);

    const [request] = runtime.interactions.deliveryApprovalInbox.listOpen(1);
    assert.ok(request);
    runtime.interactions.deliveryApprovalInbox.recordDecision({
      requestId: request.requestId,
      status: 'approved',
      decidedBy: 'release-owner',
      rationale: 'Exact candidate and policy reviewed.',
      providerId: 3,
    });

    const resumed = await runtime.orchestrator.run(
      deliveryOnlyLifecycle,
      { ...command, resumePaused: true },
    );
    assert.equal(resumed.lifecycleRun.id, paused.lifecycleRun.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.terminalStatus, 'released');
    assert.equal(executionCount, 1);

    const listed = lifecycleRunTools.handlers.lifecycle_run_list({
      project_id: 1,
      epic_id: 10,
    });
    assert.equal(listed.count, 1);
    assert.equal(listed.runs[0].id, paused.lifecycleRun.id);
    const inspected = lifecycleRunTools.handlers.lifecycle_run_get({
      lifecycle_run_id: paused.lifecycleRun.id,
    });
    assert.equal(inspected.run.status, 'completed');
    assert.equal(inspected.stages.length, 1);
    assert.equal(inspected.transitions.length, 1);
    assert.equal(inspected.transitions[0].target.status, 'released');

    const replay = await runtime.orchestrator.run(
      deliveryOnlyLifecycle,
      command,
    );
    assert.equal(replay.lifecycleRun.id, paused.lifecycleRun.id);
    assert.equal(replay.status, 'completed');
    assert.equal(executionCount, 1);
  } finally {
    lifecycleRunTools._resetLifecycleRunRepositoryForTests();
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
  }
});
