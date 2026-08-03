// CGAD P18 — centralized node-products regression test.
//
// PROVES: the GenericFlowExecutor's resolveNodeProducts seam reads the
// workplace's (node's) durable worker products by node-scope
// (processRunId + moduleRef + nodeId), NEVER by task. This is the centralized
// guarantee that no kernel handler can be blinded to a prior worker's product.
//
// The development gate (resolve-task-graph) previously read the planner
// submission by transient taskId (`readLatestForTask`), so when recovery
// minted a new task the gate saw nothing → "task-graph-missing". After the fix,
// the gate reads `ctx.nodeProducts.submission` (centralized node-scope) first.
//
// Run: node --test tests/process-modules/centralized-node-products.test.mjs
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDevelopmentKernelHandlers,
  DEVELOPMENT_NODE_IDS,
} = await import(
  '../../dist/modules/development/application/development-installation.js'
);
const { DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA } = await import(
  '../../dist/modules/development/domain/development-schemas.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

const PROCESS_RUN_ID = 77;
const PROJECT_ID = 1;
const EPIC_ID = 100;
const MODULE_REF = 'solution-development@1.0.0';
const PLANNER_NODE = DEVELOPMENT_NODE_IDS.planner;

// A valid planner submission produced by the ORIGINAL producer task.
const producerSubmission = {
  submissionId: 9001,
  processRunId: PROCESS_RUN_ID,
  moduleRef: MODULE_REF,
  nodeId: PLANNER_NODE,
  intentId: 5,
  taskId: 5,
  executionId: 'exec-producer-5',
  schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  payload: {
    schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
    implementationItems: [],
    integrationTargets: [],
    verificationItems: [],
  },
  contentHash: sha256Hex('planner-proposal'),
  artifactRef: 'planner-submission:5',
  submittedAt: '2026-01-01T00:00:00.000Z',
};

// Mock that simulates the regression condition: task-scoped read returns EMPTY
// for the recovery task (it wrote nothing), but node-scoped read returns the
// producer's submission. The centralized seam must surface the node-scoped one.
const plannerSubmissions = {
  readLatestForNode(processRunId, moduleRef, nodeId) {
    if (processRunId === PROCESS_RUN_ID && moduleRef === MODULE_REF && nodeId === PLANNER_NODE) {
      return producerSubmission;
    }
    return null;
  },
  readLatestForTask() {
    // Recovery task wrote nothing — this returns null (regression condition).
    return null;
  },
};

const deps = {
  plannerSubmissions,
  taskGraph: {
    materializeValidatedTaskGraph() {
      throw new Error('materialize must not be called when submission is null');
    },
  },
  taskGraphPolicy: { validate() { return { ok: true }; } },
  implementationWorkset: { execute() { throw new Error('not reached'); } },
  candidateIntegration: { integrateAndFreeze() { throw new Error('not reached'); } },
  acceptanceVerification: { verify() { throw new Error('not reached'); } },
  settlementState: { buildSettlementInput() { throw new Error('not reached'); } },
  outputRepository: { persist() { throw new Error('not reached'); }, readByProcessRun() { return null; } },
};

const handlers = createDevelopmentKernelHandlers(deps);

function gateContext() {
  return {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    processRunId: PROCESS_RUN_ID,
    node: {
      id: 'resolve-task-graph',
      label: 'resolve-task-graph',
      kind: 'kernel',
      description: 'resolve-task-graph',
      handler: 'development-resolve-task-graph',
    },
    input: {
      kind: 'task-execution',
      executorKind: 'lm',
      intentId: 6,
      taskId: 6, // RECOVERY task — wrote nothing
      executionId: 'exec-recovery-6',
      runtimeStatus: 'completed',
      replayed: false,
    },
    frame: {
      runInput: {
        schemaVersion: 'saga3.development-case.v1',
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        developmentCertificate: { decision: 'verified', hash: 'd'.repeat(64), ref: 'cert:1', schema: 'saga3.development-certificate.v1' },
        solutionContract: { hash: 'c'.repeat(64), ref: 'contract:1', schema: 'saga3.formalization-solution-contract.v1' },
        acceptanceBaselineHash: 'a'.repeat(64),
        repositories: [],
        policy: { id: 'reference-development-policy', version: '1', contentHash: 'p'.repeat(64) },
      },
      productions: {},
      receipts: {},
    },
    initiatedBy: 'test',
  };
}

// ---------------------------------------------------------------------------
// THE INVARIANT TESTS
// ---------------------------------------------------------------------------

test('CGAD P18: development gate sees the producer submission via node-scoped products (not the empty recovery task)', () => {
  // ctx.nodeProducts carries the centralized node-scoped submission (the producer's).
  // The receipt names the RECOVERY task (6) which wrote nothing. The gate MUST
  // resolve the producer's submission via ctx.nodeProducts, not be blinded.
  const ctx = gateContext();
  ctx.nodeProducts = {
    artifacts: [],
    traces: [],
    submission: producerSubmission,
  };
  const result = handlers['development-resolve-task-graph'](ctx);
  // NOT 'clarification-required'/'missing' — the gate saw the submission.
  assert.notEqual(result.event, 'clarification-required',
    `gate must see the producer submission via nodeProducts; got ${result.event}`);
});

test('CGAD P18: centralized readLatestForNode returns the workplace product regardless of task', () => {
  // The SPI node-scoped read is the canonical P18 read. It returns the
  // producer's submission for the workplace, independent of task identity.
  const byNode = plannerSubmissions.readLatestForNode(PROCESS_RUN_ID, MODULE_REF, PLANNER_NODE);
  assert.equal(byNode?.submissionId, producerSubmission.submissionId);
  // The task-scoped read (recovery task 6) returns nothing — the regression.
  const byTask = plannerSubmissions.readLatestForTask({
    processRunId: PROCESS_RUN_ID, moduleRef: MODULE_REF, nodeId: PLANNER_NODE, taskId: 6,
  });
  assert.equal(byTask, null, 'recovery task must have no task-scoped submission (regression condition)');
});
