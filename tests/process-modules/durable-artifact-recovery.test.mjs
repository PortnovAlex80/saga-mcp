// CGAD P18 — Artifact Durability Invariant regression test.
//
// PROVES: the formalization acceptance kernel gate reads managed artifacts by
// DURABLE node-scope (processRunId + moduleRef + nodeId), NOT by the transient
// task in the LM receipt. This is the invariant that prevents the infinite
// repair-loop documented in docs/BUGS-2026-07-30.md (БАГА #1/#2) and the
// 2026-07-28 characterization fixture `execution-scoped-read`.
//
// Reproduction of the original failure:
//   - Recovery mints a NEW task per repair attempt (lm-node-executor.ts).
//   - The acceptance gate's receipt therefore carries taskId = NEW_TASK.
//   - The AC artifacts were written under the ORIGINAL producer task.
//   - A task-scoped read (listArtifactsForTaskInProcessRun(NEW_TASK)) returns
//     EMPTY -> the gate emits blind "no canonical AC artifacts" feedback ->
//     the model cannot converge -> infinite repair loop.
//
// Under CGAD P18 the gate reads via listArtifactsForNodeInProcessRun (no task
// filter), so it sees the durable ACs regardless of which task the receipt
// names. This test runs ONLY the acceptance gate (upstream product/use-case
// productions are seeded directly into the frame), feeding it a RECOVERY-task
// receipt while the ACs live under the producer task. It asserts the gate
// emits `completed`, not blind `clarification-required`.
//
// A regression that reintroduces `listArtifactsForTaskInProcessRun` +
// `matchesTaskFence` inside `readExecutionWrites` makes this test fail: the
// gate would see zero AC artifacts under the recovery task.
//
// Run: node --test tests/process-modules/durable-artifact-recovery.test.mjs
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const {
  createFormalizationKernelHandlers,
  FORMALIZATION_HANDLER_IDS,
} = await import(
  '../../dist/modules/formalization/application/formalization-installation.js'
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROCESS_RUN_ID = 77;
const PROJECT_ID = 1;
const EPIC_ID = 100;
const MODULE_REF = 'solution-formalization@1.0.0';

// The ORIGINAL producer task that wrote the ACs (and their traces).
const ACCEPTANCE_PRODUCER_TASK = 203;
// A RECOVERY task the LM receipt names on repair attempt 2/3. It wrote
// NOTHING — the model edited existing ACs, it did not recreate them.
const ACCEPTANCE_RECOVERY_TASK = 206;
const ACCEPTANCE_NODE = 'define-acceptance-contract';

// ---------------------------------------------------------------------------
// Artifact + trace fixtures: a complete, trace-complete acceptance contract.
// Every AC derives from FR + UC. All accepted + clean, so only the read-scope
// decides gate visibility.
// ---------------------------------------------------------------------------

function artifact(id, type, code) {
  return {
    id,
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    type,
    code,
    title: code,
    path: `docs/x/${code}.md`,
    status: 'accepted',
    parentArtifactId: null,
    projectRepositoryId: null,
    contentHash: sha256Hex(`${type}-${id}`),
    acceptedHash: sha256Hex(`${type}-${id}`),
    driftState: 'clean',
    evidenceStatus: null,
    tags: [],
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const PRD = artifact(10, 'PRD', 'PRD-1');
const FR = artifact(11, 'FR', 'FR-1');
const UC = artifact(20, 'UC', 'UC-1');
const ACS = Array.from({ length: 12 }, (_, i) => artifact(30 + i, 'AC', `AC-${i + 1}`));
const artifacts = [PRD, FR, UC, ...ACS];
const artifactById = new Map(artifacts.map(a => [a.id, a]));
const artifactHashes = Object.fromEntries(artifacts.map(a => [String(a.id), a.contentHash]));

function trace(id, srcId, targetId, link) {
  return {
    id,
    sourceArtifactId: srcId,
    targetType: 'artifact',
    targetId,
    linkType: link,
  };
}
// AC -> FR, AC -> UC for every AC (trace-complete acceptance contract).
const traces = ACS.flatMap((ac, i) => [
  trace(104 + i * 2, ac.id, FR.id, 'derived_from'),
  trace(105 + i * 2, ac.id, UC.id, 'derived_from'),
]);
const traceById = new Map(traces.map(t => [t.id, t]));

// ---------------------------------------------------------------------------
// Durable ledger writes for the acceptance node: produced ONCE under the
// producer task. The recovery task wrote nothing (regression condition).
// ---------------------------------------------------------------------------

function artifactWrite(artifactId, taskId, ledgerId) {
  const a = artifactById.get(artifactId);
  return {
    ledgerId,
    processRunId: PROCESS_RUN_ID,
    moduleRef: MODULE_REF,
    nodeId: ACCEPTANCE_NODE,
    intentId: taskId,
    taskId,
    executionId: `exec-${taskId}`,
    artifactId,
    artifactType: a.type,
    artifactStatus: a.status,
    contentHash: a.contentHash,
    operation: 'create',
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}
function traceWrite(traceId, taskId, ledgerId) {
  const t = traceById.get(traceId);
  return {
    ledgerId,
    processRunId: PROCESS_RUN_ID,
    moduleRef: MODULE_REF,
    nodeId: ACCEPTANCE_NODE,
    intentId: taskId,
    taskId,
    executionId: `exec-${taskId}`,
    traceId,
    sourceId: t.sourceArtifactId,
    targetType: t.targetType,
    targetId: t.targetId,
    linkType: t.linkType,
    traceHash: sha256Hex({
      sourceId: t.sourceArtifactId,
      targetType: t.targetType,
      targetId: t.targetId,
      linkType: t.linkType,
    }),
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

const acWrites = ACS.map((a, i) => artifactWrite(a.id, ACCEPTANCE_PRODUCER_TASK, 3000 + i));
const acTraceWrites = traces.map((t, i) => traceWrite(t.id, ACCEPTANCE_PRODUCER_TASK, 3100 + i));

const nodeScopeCalls = [];
const taskScopeCalls = [];

const ledger = {
  // DURABLE node-scope: returns the durable AC writes regardless of task.
  // Per CGAD P18 this is the authoritative channel for product resolvers.
  listArtifactsForNodeInProcessRun() {
    nodeScopeCalls.push({ kind: 'artifact' });
    return acWrites;
  },
  listTracesForNodeInProcessRun() {
    nodeScopeCalls.push({ kind: 'trace' });
    return acTraceWrites;
  },
  // TASK-scope: returns the AC writes ONLY for the producer task. For the
  // recovery task this is EMPTY — the regression condition.
  listArtifactsForTaskInProcessRun(processRunId, moduleRef, nodeId, taskId) {
    taskScopeCalls.push({ kind: 'artifact', taskId });
    return taskId === ACCEPTANCE_PRODUCER_TASK ? acWrites : [];
  },
  listTracesForTaskInProcessRun(processRunId, moduleRef, nodeId, taskId) {
    taskScopeCalls.push({ kind: 'trace', taskId });
    return taskId === ACCEPTANCE_PRODUCER_TASK ? acTraceWrites : [];
  },
  // WAVE 6 CUTOVER: listArtifactsForExecution / listTracesForExecution were
  // removed (execution-scoped product lookup). The acceptance gate reads ONLY
  // the durable node-scope channel above, so no execution-scoped stub remains.
};

const graph = {
  readArtifactsByIds(ids) { return ids.map(id => artifactById.get(id)).filter(Boolean); },
  readTracesByIds(ids) { return ids.map(id => traceById.get(id)).filter(Boolean); },
  readOutgoingArtifactTraces(ids) {
    const set = new Set(ids);
    return traces.filter(t => set.has(t.sourceArtifactId));
  },
};

const deps = {
  ledger,
  graph,
  baselineRepository: { readByProcessRun() { return null; } },
  solutionContractRepository: { readByProcessRun() { return null; } },
  settlementPolicy: { settle() { return { decision: 'formalized' }; } },
  candidateAcceptance: {
    accept(command) {
      return {
        schemaVersion: 'factory.exact-candidate-acceptance.v2',
        decisionId: 1,
        idempotencyKey: command.idempotencyKey,
        requestHash: sha256Hex(command),
        candidateSetHash: sha256Hex(command.candidates),
        decisionHash: sha256Hex({ idempotencyKey: command.idempotencyKey, candidates: command.candidates }),
        lineage: command.lineage,
        requireApprovedReview: command.requireApprovedReview,
        producerCompletionReceiptCommandId: 'producer:approved',
        producerCompletionReceiptHash: 'e'.repeat(64),
        approvedReviewReceiptCommandId: 'review:approved',
        approvedReviewReceiptHash: 'f'.repeat(64),
        authority: command.authority,
        reasonCode: command.reasonCode,
        items: command.candidates.map(c => ({ ...c, ledgerId: 1, disposition: 'accepted', priorStatus: 'accepted', priorAcceptedHash: c.contentHash, priorDriftState: 'clean', finalStatus: 'accepted', finalAcceptedHash: c.contentHash, finalDriftState: 'clean' })),
        decidedAt: '2026-01-01T00:00:00.000Z',
        replayed: false,
      };
    },
    findByIdempotencyKey() { return null; },
    isAcceptedExact() { return true; },
  },
};

const handlers = createFormalizationKernelHandlers(deps);

// ---------------------------------------------------------------------------
// Frame: upstream product + use-case productions seeded directly, so the
// acceptance gate finds them without running the upstream gates. Each carries
// the artifactIds + artifactHashes the acceptance gate reads.
// ---------------------------------------------------------------------------

function production(nodeId, ids) {
  const hashes = {};
  for (const id of ids) hashes[String(id)] = artifactById.get(id).contentHash;
  return {
    artifactRef: `formalization-node-product:${PROCESS_RUN_ID}:${nodeId}:${sha256Hex(nodeId)}`,
    schema: 'factory.formalization-node-product.v1',
    contentHash: sha256Hex(ids),
    bindings: { artifactIds: ids, artifactHashes: hashes },
  };
}

function flowFrame() {
  return {
    runInput: {
      schemaVersion: 'factory.formalization-case.v1',
      discoveryEpicId: 50,
      formalizationEpicId: EPIC_ID,
      discoveryCertificateRef: 'certificate:7',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go',
      initiatedBy: 'test',
    },
    productions: {
      'resolve-product-contract': production('define-product-contract', [PRD.id, FR.id]),
      'resolve-use-cases': production('model-use-cases', [UC.id]),
    },
    receipts: {},
  };
}

// A receipt naming the RECOVERY task — exactly what the LM executor hands the
// gate on repair attempt 2. The ACs were produced under the producer task.
function recoveryReceipt() {
  return {
    kind: 'task-execution',
    executorKind: 'lm',
    intentId: ACCEPTANCE_RECOVERY_TASK,
    taskId: ACCEPTANCE_RECOVERY_TASK,
    executionId: `exec-${ACCEPTANCE_RECOVERY_TASK}`,
    runtimeStatus: 'completed',
    replayed: false,
  };
}

function gateContext() {
  return {
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    processRunId: PROCESS_RUN_ID,
    node: {
      id: 'resolve-acceptance-contract',
      label: 'resolve-acceptance-contract',
      kind: 'kernel',
      description: 'resolve-acceptance-contract',
      handler: FORMALIZATION_HANDLER_IDS.resolveAcceptance,
    },
    input: recoveryReceipt(),
    frame: flowFrame(),
    initiatedBy: 'test',
  };
}

// ---------------------------------------------------------------------------
// THE INVARIANT TESTS
// ---------------------------------------------------------------------------

test('CGAD P18: acceptance gate sees durable ACs when the receipt names a recovery task that wrote nothing', () => {
  const result = handlers[FORMALIZATION_HANDLER_IDS.resolveAcceptance](gateContext());
  const bindings = result.production?.bindings ?? {};
  const seenAcIds = Array.isArray(bindings.acArtifactIds) ? bindings.acArtifactIds : [];
  // THE INVARIANT: the gate MUST see all 12 durable ACs through the recovery
  // task receipt. Under CGAD P18 it reads via node-scope, so the transient task
  // in the receipt cannot blind it. A regression to task-scope reads would
  // leave acArtifactIds EMPTY and emit blind `clarification-required`.
  assert.equal(
    seenAcIds.length,
    12,
    `gate must see all 12 durable ACs through the recovery task; saw ${seenAcIds.length} (event=${result.event})`,
  );
  // The gate must NOT have taken the blind path. `clarification-required` with
  // "no canonical AC artifacts" is the regression signature.
  assert.notEqual(
    result.event,
    'clarification-required',
    'gate must not emit blind clarification-required (regression signature)',
  );
  // And it MUST have used the durable node-scope read.
  assert.ok(
    nodeScopeCalls.some(c => c.kind === 'artifact'),
    'gate must read artifacts via listArtifactsForNodeInProcessRun (durable node-scope)',
  );
});

test('CGAD P18 regression guard: the recovery task genuinely has no task-scoped writes', () => {
  // Prove the mock reproduces the original failure condition: the recovery
  // task wrote nothing, so a task-scope-only gate would be blinded.
  const recoveryReads = ledger.listArtifactsForTaskInProcessRun(
    PROCESS_RUN_ID, MODULE_REF, ACCEPTANCE_NODE, ACCEPTANCE_RECOVERY_TASK,
  );
  assert.equal(recoveryReads.length, 0, 'recovery task must have no task-scoped writes');
  // ... while the durable node-scope read returns all 12 ACs.
  const durable = ledger.listArtifactsForNodeInProcessRun(
    PROCESS_RUN_ID, MODULE_REF, ACCEPTANCE_NODE,
  );
  assert.equal(durable.length, 12, 'node-scope must return the 12 durable ACs');
});
