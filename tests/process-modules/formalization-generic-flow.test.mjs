import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createFormalizationKernelHandlers,
  createFormalizationLifecycleOutputPayloadResolver,
  createFormalizationOutputResolver,
  FORMALIZATION_HANDLER_IDS,
  FORMALIZATION_MODULE_KEY,
} = await import(
  '../../dist/modules/formalization/application/formalization-installation.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { ReferenceFormalizationSettlementPolicy } = await import(
  '../../dist/modules/formalization/infrastructure/sqlite-formalization-kernel.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { KernelHandlerRegistry } = await import(
  '../../dist/process-modules/application/kernel-handler-registry.js'
);
const { KernelNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/kernel-node-executor.js'
);

const HASH = {
  brief: '1'.repeat(64),
  prd: '2'.repeat(64),
  fr: '3'.repeat(64),
  uc: '4'.repeat(64),
  ac: '5'.repeat(64),
  srs: '6'.repeat(64),
};

function artifact(id, epicId, type, contentHash) {
  return {
    id,
    projectId: 1,
    epicId,
    type,
    code: `${type}-${id}`,
    status: 'accepted',
    contentHash,
    acceptedHash: contentHash,
    driftState: 'clean',
    metadata: {},
  };
}

function trace(id, sourceArtifactId, targetId, linkType) {
  return {
    id,
    sourceArtifactId,
    targetType: 'artifact',
    targetId,
    linkType,
  };
}

function receipt(nodeId, runtimeStatus = 'completed') {
  const index = {
    'define-product-contract': 1,
    'model-use-cases': 2,
    'define-acceptance-contract': 3,
    'reconcile-what': 4,
    'define-architecture-contract': 5,
  }[nodeId];
  return {
    kind: 'task-execution',
    executorKind: 'lm',
    intentId: 100 + index,
    taskId: 200 + index,
    executionId: `exec-${index}`,
    runtimeStatus,
    replayed: false,
  };
}

function fixture() {
  const artifacts = [
    artifact(1, 50, 'brief', HASH.brief),
    artifact(10, 100, 'PRD', HASH.prd),
    artifact(11, 100, 'FR', HASH.fr),
    artifact(20, 100, 'UC', HASH.uc),
    artifact(30, 100, 'AC', HASH.ac),
    artifact(40, 100, 'SRS', HASH.srs),
    // Distractor: accepted and newer, but not in any exact execution ledger.
    artifact(999, 100, 'PRD', '9'.repeat(64)),
  ];
  const traces = [
    trace(101, 10, 1, 'derived_from'),
    trace(102, 20, 10, 'derived_from'),
    trace(103, 20, 11, 'covers'),
    trace(104, 30, 11, 'derived_from'),
    trace(105, 30, 20, 'derived_from'),
    trace(106, 40, 10, 'derived_from'),
  ];
  const artifactById = new Map(artifacts.map(row => [row.id, row]));
  const traceById = new Map(traces.map(row => [row.id, row]));
  const missingTraceIds = new Set();
  const graph = {
    readArtifactsByIds(ids) {
      return [...new Set(ids)].map(id => artifactById.get(id)).filter(Boolean)
        .sort((a, b) => a.id - b.id);
    },
    readTracesByIds(ids) {
      return [...new Set(ids)].filter(id => !missingTraceIds.has(id))
        .map(id => traceById.get(id)).filter(Boolean)
        .sort((a, b) => a.id - b.id);
    },
    readOutgoingArtifactTraces(sourceIds) {
      const sources = new Set(sourceIds);
      return traces.filter(row => sources.has(row.sourceArtifactId));
    },
  };

  const nodeWrites = {
    'define-product-contract': { artifacts: [10, 11], traces: [101] },
    'model-use-cases': { artifacts: [20], traces: [102, 103] },
    'define-acceptance-contract': { artifacts: [30], traces: [104, 105] },
    'reconcile-what': { artifacts: [], traces: [] },
    'define-architecture-contract': { artifacts: [40], traces: [106] },
  };
  const queries = [];
  // WAVE 6 CUTOVER: the fake ledger is keyed by the DURABLE node-scope channel
  // (listArtifactsForNodeInProcessRun / listTracesForNodeInProcessRun), which is
  // now the AUTHORITATIVE product-resolution path (CGAD P18) and the only one
  // readExecutionWrites actually calls. The execution-scoped methods were
  // removed; the task-scope variants remain for single-task diagnostics and
  // delegate to the node-scope storage (every node has a single producer task
  // in these unit tests, so task-scope and node-scope return the same writes —
  // mirroring the real SQLite ledger's behavior for a one-producer node).
  const ledger = {
    listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId) {
      queries.push({ kind: 'artifact', processRunId, moduleRef, nodeId });
      const ids = nodeWrites[nodeId]?.artifacts ?? [];
      return ids.map((id, offset) => {
        const row = artifactById.get(id);
        return {
          ledgerId: 1000 + id + offset,
          processRunId,
          moduleRef,
          nodeId,
          artifactId: id,
          artifactType: row.type,
          artifactStatus: row.status,
          contentHash: row.contentHash,
          operation: 'create',
          recordedAt: '2026-01-01T00:00:00.000Z',
        };
      });
    },
    listTracesForNodeInProcessRun(processRunId, moduleRef, nodeId) {
      queries.push({ kind: 'trace', processRunId, moduleRef, nodeId });
      const ids = nodeWrites[nodeId]?.traces ?? [];
      return ids.map((id, offset) => {
        const row = traceById.get(id);
        return {
          ledgerId: 2000 + id + offset,
          processRunId,
          moduleRef,
          nodeId,
          traceId: id,
          sourceId: row.sourceArtifactId,
          targetType: row.targetType,
          targetId: row.targetId,
          linkType: row.linkType,
          traceHash: sha256Hex({
            sourceId: row.sourceArtifactId,
            targetType: row.targetType,
            targetId: row.targetId,
            linkType: row.linkType,
          }),
          recordedAt: '2026-01-01T00:00:00.000Z',
        };
      });
    },
    listArtifactsForTaskInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
      _taskId,
    ) {
      // Single-producer-per-node fixture: task-scope matches node-scope.
      return this.listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId);
    },
    listTracesForTaskInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
      _taskId,
    ) {
      return this.listTracesForNodeInProcessRun(processRunId, moduleRef, nodeId);
    },
    // Epic-scope recovery fallback (commit ec3123d): when a process-run has no
    // ledger entries for a node (repair worker reused accepted artifacts from a
    // prior run), the resolver borrows from the epic-wide node scope. The fake
    // is single-processRun, so epic-scope == node-scope here.
    listArtifactsForNodeInEpic(
      _projectId,
      _epicId,
      moduleRef,
      nodeId,
    ) {
      return this.listArtifactsForNodeInProcessRun(77, moduleRef, nodeId);
    },
    listTracesForNodeInEpic(
      _projectId,
      _epicId,
      moduleRef,
      nodeId,
    ) {
      return this.listTracesForNodeInProcessRun(77, moduleRef, nodeId);
    },
  };
  let baselineRecord = null;
  const baselineRepository = {
    freeze(payload) {
      const snapshotHash = sha256Hex(payload);
      if (baselineRecord && baselineRecord.snapshotHash !== snapshotHash) {
        throw new Error('different baseline');
      }
      const replayed = baselineRecord !== null;
      baselineRecord ??= {
        id: 1,
        processRunId: payload.processRunId,
        formalizationEpicId: payload.formalizationEpicId,
        payload,
        baselineHash: payload.baselineHash,
        snapshotHash,
        artifactRef: 'formalization-baseline:1',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      return { record: baselineRecord, replayed };
    },
    readByProcessRun(processRunId) {
      return baselineRecord?.processRunId === processRunId ? baselineRecord : null;
    },
  };

  let solutionRecord = null;
  let certificateRecord = null;
  const acceptanceCalls = [];
  const solutionContractRepository = {
    persist(payload) {
      const contentHash = sha256Hex(payload);
      if (solutionRecord && solutionRecord.contentHash !== contentHash) {
        throw new Error('different solution contract');
      }
      const replayed = solutionRecord !== null;
      solutionRecord ??= {
        id: 1,
        processRunId: payload.processRunId,
        formalizationEpicId: payload.formalizationEpicId,
        payload,
        contentHash,
        artifactRef: 'formalization-solution-contract:1',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      return { record: solutionRecord, replayed };
    },
    readByProcessRun(processRunId) {
      return solutionRecord?.processRunId === processRunId ? solutionRecord : null;
    },
  };
  const deps = {
    ledger,
    graph,
    baselineRepository,
    solutionContractRepository,
    settlementPolicy: new ReferenceFormalizationSettlementPolicy(),
    candidateAcceptance: {
      accept(command) {
        acceptanceCalls.push(command);
        for (const candidate of command.candidates) {
          const row = artifactById.get(candidate.artifactId);
          if (row) {
            row.status = 'accepted';
            row.acceptedHash = candidate.contentHash;
            row.driftState = 'clean';
          }
        }
        return {
          schemaVersion: 'factory.exact-candidate-acceptance.v2',
          decisionId: acceptanceCalls.length,
          idempotencyKey: command.idempotencyKey,
          requestHash: sha256Hex(command),
          candidateSetHash: sha256Hex(command.candidates),
          decisionHash: sha256Hex({
            idempotencyKey: command.idempotencyKey,
            candidates: command.candidates,
          }),
          lineage: command.lineage,
          requireApprovedReview: command.requireApprovedReview,
          producerCompletionReceiptCommandId: 'producer:approved',
          producerCompletionReceiptHash: 'e'.repeat(64),
          approvedReviewReceiptCommandId: 'review:approved',
          approvedReviewReceiptHash: 'f'.repeat(64),
          authority: command.authority,
          reasonCode: command.reasonCode,
          items: command.candidates.map(candidate => ({
            ...candidate,
            ledgerId: 1,
            disposition: 'already-accepted',
            priorStatus: 'accepted',
            priorAcceptedHash: candidate.contentHash,
            priorDriftState: 'clean',
            finalStatus: 'accepted',
            finalAcceptedHash: candidate.contentHash,
            finalDriftState: 'clean',
          })),
          decidedAt: '2026-01-01T00:00:00.000Z',
          replayed: false,
        };
      },
      findByIdempotencyKey() {
        return null;
      },
      isAcceptedExact() {
        return true;
      },
    },
    // Wave 4 (Uncle Bob): the settlement kernel now issues its own
    // ProcessOutcomeCertificate and emits an explicit ModuleCompletion whose
    // certificateRef points at the issued row. This fake mirrors the
    // idempotency contract of SqliteProcessOutcomeCertificateRepository:
    // re-issuing the SAME hash returns the existing row (replayed=true).
    certificateRepo: {
      issue(command) {
        const replayed = certificateRecord !== null;
        certificateRecord ??= {
          id: 909,
          processRunId: command.processRunId,
          moduleRef: command.moduleRef,
          moduleRefKey: `${command.moduleRef.name}@${command.moduleRef.version}`,
          projectId: command.projectId,
          epicId: command.epicId,
          schemaVersion: command.payload.schemaVersion,
          decision: command.payload.decision,
          reasonCodes: command.payload.reasonCodes,
          rationale: command.payload.rationale,
          inputHash: command.payload.inputHash,
          certificatePayload: command.payload,
          certificateHash: command.certificateHash,
          authority: command.authority,
          issuedAt: '2026-01-01T00:00:00.000Z',
        };
        return { record: certificateRecord, replayed };
      },
      read(id) {
        return certificateRecord?.id === id ? certificateRecord : null;
      },
      readByProcessRun(processRunId) {
        return certificateRecord?.processRunId === processRunId ? certificateRecord : null;
      },
      readByHash(hash) {
        return certificateRecord?.certificateHash === hash ? certificateRecord : null;
      },
      list() {
        return certificateRecord === null ? [] : [certificateRecord];
      },
      readByModuleRun() {
        return certificateRecord;
      },
    },
  };
  return {
    deps,
    artifacts,
    artifactById,
    traces,
    traceById,
    missingTraceIds,
    nodeWrites,
    queries,
    acceptanceCalls,
    getBaseline: () => baselineRecord,
    getSolution: () => solutionRecord,
    getCertificate: () => certificateRecord,
  };
}

function flowFrame() {
  const discoveryProposalPayload = {
    schemaVersion: 'factory.discovery-proposal.v1',
    subject: 'A bounded test product',
    problem: 'Students need a deterministic learning aid.',
  };
  return {
    runInput: {
      schemaVersion: 'factory.formalization-case.v1',
      discoveryEpicId: 50,
      formalizationEpicId: 100,
      discoveryCertificateRef: 'certificate:7',
      discoveryCertificateHash: 'd'.repeat(64),
      discoveryOutcome: 'go',
      discoveryProposalRef: 'discovery-proposal:test:1',
      discoveryProposalHash: sha256Hex(discoveryProposalPayload),
      discoveryProposalPayload,
      initiativeSubject: 'Build a bounded test product',
      initiatedBy: 'test',
    },
    productions: {},
    receipts: {},
  };
}

function context(nodeId, input, frame) {
  return {
    projectId: 1,
    epicId: 100,
    processRunId: 77,
    node: {
      id: nodeId,
      label: nodeId,
      kind: 'kernel',
      description: nodeId,
      handler: 'test',
    },
    input,
    frame,
    initiatedBy: 'test',
  };
}

function executorContext(nodeId, input, frame) {
  const node = formalizationProcessModule.flow.nodes.find(candidate =>
    candidate.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  return {
    projectId: 1,
    epicId: 100,
    processRunId: 77,
    module: formalizationProcessModule,
    node,
    input,
    frame,
    heartbeat() {},
    initiatedBy: 'test',
  };
}

function store(frame, nodeId, result) {
  frame.productions[nodeId] = result.production;
  return result;
}

function runThroughSettlement(fx, productRuntimeStatus = 'completed') {
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const frame = flowFrame();

  const product = store(frame, 'resolve-product-contract', handlers[
    FORMALIZATION_HANDLER_IDS.resolveProduct
  ](context('resolve-product-contract', receipt('define-product-contract', productRuntimeStatus), frame)));
  assert.equal(product.event, 'completed', JSON.stringify(product));

  const useCases = store(frame, 'resolve-use-cases', handlers[
    FORMALIZATION_HANDLER_IDS.resolveUseCases
  ](context('resolve-use-cases', receipt('model-use-cases'), frame)));
  assert.equal(useCases.event, 'completed');

  const acceptance = store(frame, 'resolve-acceptance-contract', handlers[
    FORMALIZATION_HANDLER_IDS.resolveAcceptance
  ](context('resolve-acceptance-contract', receipt('define-acceptance-contract'), frame)));
  assert.equal(acceptance.event, 'completed');

  const reconciliation = store(frame, 'resolve-reconciliation', handlers[
    FORMALIZATION_HANDLER_IDS.resolveReconciliation
  ](context('resolve-reconciliation', receipt('reconcile-what'), frame)));
  assert.equal(reconciliation.event, 'reconciled');

  const baseline = store(frame, 'freeze-acceptance-baseline', handlers[
    FORMALIZATION_HANDLER_IDS.freezeBaseline
  ](context('freeze-acceptance-baseline', reconciliation.production, frame)));
  assert.equal(baseline.event, 'frozen', JSON.stringify(baseline));

  const architecture = store(frame, 'resolve-architecture-contract', handlers[
    FORMALIZATION_HANDLER_IDS.resolveArchitecture
  ](context('resolve-architecture-contract', receipt('define-architecture-contract'), frame)));
  assert.equal(architecture.event, 'completed');

  const settlement = handlers[FORMALIZATION_HANDLER_IDS.settle](
    context('settle-formalization', architecture.production, frame),
  );
  return { frame, product, reconciliation, baseline, architecture, settlement };
}

test('descriptor routes universal Production Cells directly through domain events', () => {
  const flow = formalizationProcessModule.flow;
  const acceptedTargetByCell = new Map([
    ['define-product-contract', 'model-use-cases'],
    ['model-use-cases', 'define-acceptance-contract'],
    ['define-acceptance-contract', 'reconcile-what'],
    ['reconcile-what', 'freeze-acceptance-baseline'],
    ['define-architecture-contract', 'settle-formalization'],
  ]);
  for (const [cell, acceptedTarget] of acceptedTargetByCell) {
    assert.equal(flow.nodes.find(node => node.id === cell)?.kind, 'production-cell');
    assert.ok(
      flow.transitions.some(edge => edge.from === cell
        && edge.to === acceptedTarget && edge.on === 'domain.accepted'),
      `${cell} must route domain.accepted to ${acceptedTarget}`,
    );
    assert.ok(
      flow.transitions.some(edge => edge.from === cell
        && edge.to === 'complete-failed' && edge.on === 'domain.failed'),
      `${cell} must route domain.failed to complete-failed`,
    );
  }
  assert.ok(flow.transitions.every(edge =>
    edge.on === '*' || edge.on.startsWith('runtime.') || edge.on.startsWith('domain.')));
  assert.deepEqual(
    new Set(flow.nodes.filter(node => node.kind === 'kernel').map(node => node.handler)),
    new Set([
      FORMALIZATION_HANDLER_IDS.freezeBaseline,
      FORMALIZATION_HANDLER_IDS.settle,
      'process-outcome-emitter',
    ]),
  );
});

test('architecture resolver ignores superseded drafts from the same workplace', () => {
  const fx = fixture();
  const obsolete = [
    { ...artifact(38, 100, 'SRS', '7'.repeat(64)), status: 'superseded' },
    { ...artifact(39, 100, 'SRS', '8'.repeat(64)), status: 'superseded' },
  ];
  for (const row of obsolete) fx.artifactById.set(row.id, row);
  fx.nodeWrites['define-architecture-contract'].artifacts.unshift(38, 39);

  const { architecture: result } = runThroughSettlement(fx);

  assert.equal(result.event, 'completed', JSON.stringify(result));
  assert.equal(result.production.bindings.srsArtifactId, 40);
});

test('architecture resolver adopts the latest singular revision after a stale trace was deleted', () => {
  const fx = fixture();
  const prior = artifact(39, 100, 'SRS', '8'.repeat(64));
  fx.artifactById.set(prior.id, prior);
  fx.nodeWrites['define-architecture-contract'].artifacts.unshift(39);
  // The append-only ledger still records the author's deleted defective trace.
  // It is absent from the canonical graph and must not hide the corrected SRS.
  const staleTrace = trace(199, 39, 10, 'derived_from');
  fx.traces.push(staleTrace);
  fx.traceById.set(staleTrace.id, staleTrace);
  fx.missingTraceIds.add(staleTrace.id);
  fx.nodeWrites['define-architecture-contract'].traces.unshift(staleTrace.id);

  const { architecture: result } = runThroughSettlement(fx);

  assert.equal(result.event, 'completed', JSON.stringify(result));
  assert.equal(result.production.bindings.srsArtifactId, 40);
});

test('exact ledger flow settles and persists a durable SolutionContract', () => {
  const fx = fixture();
  const result = runThroughSettlement(fx);
  assert.equal(result.settlement.event, 'formalized');
  assert.equal(result.settlement.production.bindings.authority, 'formalization_settlement_policy');
  // WAVE 5 CUTOVER: the certificate envelope is no longer carried in
  // `production.bindings`. The settlement kernel issues its own certificate
  // (fx.getCertificate()) and emits an explicit ModuleCompletion whose
  // `outputEnvelope.certificateRef.digest` is the content-addressed pointer.
  // The certificate hash is still the sha256 of the certificate payload —
  // read from the issued certificate record (the sole source of truth).
  assert.ok(result.settlement.completion, 'settlement must emit an explicit ModuleCompletion');
  const issuedCert = fx.getCertificate();
  assert.ok(issuedCert, 'settlement must issue a ProcessOutcomeCertificate');
  assert.equal(
    result.settlement.completion.outputEnvelope.certificateRef.digest,
    issuedCert.certificateHash,
    'completion certificateRef digest must match the issued certificate hash',
  );
  assert.equal(
    issuedCert.certificateHash,
    sha256Hex(issuedCert.certificatePayload),
    'issued certificate hash must be the sha256 of the certificate payload',
  );
  assert.equal(
    result.settlement.completion.outputEnvelope.certificateRef.schemaId,
    issuedCert.schemaVersion,
    'completion certificateRef schemaId must match the issued certificate schema',
  );
  assert.equal(result.reconciliation.production.bindings.artifactIds.includes(999), false);
  assert.deepEqual(
    new Set(fx.queries.map(query => query.moduleRef)),
    new Set([FORMALIZATION_MODULE_KEY]),
  );
  assert.ok(fx.getBaseline());
  assert.ok(fx.getSolution());
  assert.deepEqual(fx.getSolution().payload.srs, {
    schema: 'factory.srs.v1',
    ref: 'artifact:40',
    hash: HASH.srs,
  });
  assert.deepEqual(fx.getSolution().payload.acceptanceCriteria, [{
    artifactId: 30,
    code: 'AC-30',
    acceptedHash: HASH.ac,
    implementationRequired: true,
    // criticality: read from AC tags (default 'blocker' when no tag). This is
    // advisory metadata — the Development settlement gate does not yet branch
    // on it. See formalization-installation.ts readCriticalityFromTags.
    criticality: 'blocker',
  }]);

  const resolveOutput = createFormalizationOutputResolver(fx.deps.solutionContractRepository);
  const output = resolveOutput(
    formalizationProcessModule,
    'formalized',
    { runtimeEvent: 'completed', production: result.settlement.production },
    {
      projectId: 1,
      epicId: 100,
      processRunId: 77,
      inputPayload: result.frame.runInput,
      inputHash: 'a'.repeat(64),
      initiatedBy: 'test',
    },
  );
  assert.deepEqual(output, {
    schema: 'factory.solution-contract-certificate.v1',
    artifactRef: 'formalization-solution-contract:1',
    contentHash: fx.getSolution().contentHash,
  });

  const resolveLifecyclePayload = createFormalizationLifecycleOutputPayloadResolver(
    fx.deps.solutionContractRepository,
  );
  assert.equal(resolveLifecyclePayload({
    processRunId: 77,
    moduleRef: { name: 'solution-formalization', version: '1.0.0' },
    projectId: 1,
    epicId: 100,
    output,
  }), fx.getSolution().payload);
  assert.throws(
    () => resolveLifecyclePayload({
      processRunId: 77,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      projectId: 1,
      epicId: 100,
      output: { ...output, artifactRef: 'formalization-solution-contract:999' },
    }),
    /does not resolve to the exact SolutionContract/,
  );
});

test('formalization compatibility resolvers accept exact draft PRD, UC, AC and SRS candidate sets', () => {
  const fx = fixture();
  for (const id of [10, 11, 20, 30, 40]) {
    const row = fx.artifactById.get(id);
    row.status = 'draft';
    row.acceptedHash = null;
    row.driftState = 'unknown';
  }
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const frame = flowFrame();
  const resolveAndAccept = (nodeId, handlerId, sourceNodeId) => {
    const result = handlers[handlerId](
      context(nodeId, receipt(sourceNodeId), frame),
    );
    assert.equal(result.event, 'completed', JSON.stringify(result));
    assert.ok(result.exactCandidateAcceptance, JSON.stringify(result));
    fx.deps.candidateAcceptance.accept(
      result.exactCandidateAcceptance.command,
    );
    return store(frame, nodeId, result);
  };
  resolveAndAccept(
    'resolve-product-contract',
    FORMALIZATION_HANDLER_IDS.resolveProduct,
    'define-product-contract',
  );
  resolveAndAccept(
    'resolve-use-cases',
    FORMALIZATION_HANDLER_IDS.resolveUseCases,
    'model-use-cases',
  );
  resolveAndAccept(
    'resolve-acceptance-contract',
    FORMALIZATION_HANDLER_IDS.resolveAcceptance,
    'define-acceptance-contract',
  );
  const reconciliation = store(frame, 'resolve-reconciliation', handlers[
    FORMALIZATION_HANDLER_IDS.resolveReconciliation
  ](context('resolve-reconciliation', receipt('reconcile-what'), frame)));
  assert.equal(reconciliation.event, 'reconciled');
  const baseline = store(frame, 'freeze-acceptance-baseline', handlers[
    FORMALIZATION_HANDLER_IDS.freezeBaseline
  ](context('freeze-acceptance-baseline', reconciliation.production, frame)));
  assert.equal(baseline.event, 'frozen', JSON.stringify(baseline));
  resolveAndAccept(
    'resolve-architecture-contract',
    FORMALIZATION_HANDLER_IDS.resolveArchitecture,
    'define-architecture-contract',
  );
  assert.equal(fx.acceptanceCalls.length, 4);
  assert.deepEqual(
    fx.acceptanceCalls.map(call => call.candidates.map(item => item.artifactType)),
    [['PRD', 'FR'], ['UC'], ['AC'], ['SRS']],
  );
  for (const id of [10, 11, 20, 30, 40]) {
    assert.equal(fx.artifactById.get(id).status, 'accepted');
    assert.equal(fx.artifactById.get(id).driftState, 'clean');
  }
});

test('product supporting artifacts stay outside the exact contract and gate', () => {
  const fx = fixture();
  for (const [id, type, hash] of [
    [12, 'hypothesis', '7'.repeat(64)],
    [13, 'business_metric', '8'.repeat(64)],
  ]) {
    const row = artifact(id, 100, type, hash);
    row.status = 'draft';
    row.acceptedHash = null;
    row.driftState = 'unknown';
    fx.artifacts.push(row);
    fx.artifactById.set(id, row);
    fx.nodeWrites['define-product-contract'].artifacts.push(id);
  }
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context(
      'resolve-product-contract',
      receipt('define-product-contract'),
      flowFrame(),
    ),
  );
  assert.equal(resolved.event, 'completed');
  assert.deepEqual(resolved.production.bindings.artifactIds, [10, 11]);
  assert.deepEqual(resolved.production.bindings.supportingArtifactIds, [12, 13]);
  assert.deepEqual(
    resolved.exactCandidateAcceptance.command.candidates.map(item => item.artifactId),
    [10, 11],
  );
});

test('reconciliation pauses on an unaccepted artifact owned by an upstream gate', () => {
  const fx = fixture();
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const frame = flowFrame();

  for (const [resolverNodeId, handlerId, sourceNodeId] of [
    ['resolve-product-contract', FORMALIZATION_HANDLER_IDS.resolveProduct, 'define-product-contract'],
    ['resolve-use-cases', FORMALIZATION_HANDLER_IDS.resolveUseCases, 'model-use-cases'],
    ['resolve-acceptance-contract', FORMALIZATION_HANDLER_IDS.resolveAcceptance, 'define-acceptance-contract'],
  ]) {
    store(
      frame,
      resolverNodeId,
      handlers[handlerId](context(resolverNodeId, receipt(sourceNodeId), frame)),
    );
  }

  const ac = fx.artifactById.get(30);
  ac.status = 'draft';
  ac.acceptedHash = null;
  ac.driftState = 'unknown';

  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveReconciliation](
    context(
      'resolve-reconciliation',
      receipt('reconcile-what'),
      frame,
    ),
  );

  assert.equal(resolved.event, 'repair-required');
  assert.equal(resolved.recoveryIssue.policyId, 'repair-reconciliation');
  assert.equal(resolved.recoveryIssue.disposition, 'human');
  assert.deepEqual(
    resolved.recoveryIssue.findings[0].actual.unacceptedArtifactIds,
    [30],
  );
});

test('runtime.failed still resolves when exact durable writes committed', () => {
  const fx = fixture();
  const result = runThroughSettlement(fx, 'failed');
  assert.equal(result.product.event, 'completed');
  assert.equal(result.product.production.bindings.sourceRuntimeStatus, 'failed');
  assert.equal(result.settlement.event, 'formalized');
});

test('missing product writes create exact repair feedback, never latest-by-epic', () => {
  const fx = fixture();
  fx.nodeWrites['define-product-contract'] = { artifacts: [], traces: [] };
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const frame = flowFrame();
  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context('resolve-product-contract', receipt('define-product-contract'), frame),
  );
  assert.equal(resolved.event, 'repair-required');
  assert.match(resolved.production.bindings.reason, /no canonical product artifacts/);
  assert.equal(resolved.recoveryIssue.policyId, 'repair-product-contract');
  assert.equal(resolved.recoveryIssue.disposition, 'repair');
  assert.equal(resolved.recoveryIssue.context.originalEvent, 'clarification-required');
});

test('ledger/canonical hash mismatch fails the resolver closed', () => {
  const fx = fixture();
  // WAVE 6 CUTOVER: readExecutionWrites reads via the durable node-scope
  // channel, so the mismatch is injected there.
  const original = fx.deps.ledger.listArtifactsForNodeInProcessRun.bind(fx.deps.ledger);
  fx.deps.ledger.listArtifactsForNodeInProcessRun = (processRunId, moduleRef, nodeId) =>
    original(processRunId, moduleRef, nodeId).map(row =>
      row.artifactId === 10 ? { ...row, contentHash: 'f'.repeat(64) } : row);
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context('resolve-product-contract', receipt('define-product-contract'), flowFrame()),
  );
  assert.equal(resolved.event, 'failed');
  assert.match(resolved.production.bindings.reason, /does not match its canonical row/);
});

test('CGAD P18: ledger rows from another (recovery) task are accepted — artifact identity is durable', () => {
  // The old "another task fails the resolver closed" asserted a task-equality
  // fence. CGAD P18 reverses that: a managed artifact is a durable aggregate
  // whose identity survives recovery cycles, so a ledger row written by a
  // DIFFERENT task of the same node MUST be accepted (that is exactly the
  // recovery case — the repair task edits artifacts created by the producer
  // task). This test now proves the gate accepts the cross-task durable row
  // instead of failing closed.
  const fx = fixture();
  const ledger = fx.deps.ledger;
  const originalNode = ledger.listArtifactsForNodeInProcessRun.bind(ledger);
  ledger.listArtifactsForNodeInProcessRun = (processRunId, moduleRef, nodeId) =>
    originalNode(processRunId, moduleRef, nodeId).map(row =>
      row.artifactId === 10 ? { ...row, taskId: 999 } : row);
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context('resolve-product-contract', receipt('define-product-contract'), flowFrame()),
  );
  // Under P18 a cross-task row is durable, not a fence violation.
  assert.equal(resolved.event, 'completed',
    `cross-task durable row must be accepted (P18); got ${resolved.event}`);
});

test('ledger trace digests are verified before accepting canonical traces', () => {
  const fx = fixture();
  // WAVE 6 CUTOVER: readExecutionWrites reads traces via the durable node-scope
  // channel, so the digest mutation is injected there.
  const original = fx.deps.ledger.listTracesForNodeInProcessRun.bind(fx.deps.ledger);
  fx.deps.ledger.listTracesForNodeInProcessRun = (processRunId, moduleRef, nodeId) =>
    original(processRunId, moduleRef, nodeId).map(row =>
      row.traceId === 101 ? { ...row, traceHash: 'f'.repeat(64) } : row);
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const resolved = handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context('resolve-product-contract', receipt('define-product-contract'), flowFrame()),
  );
  assert.equal(resolved.event, 'failed');
  assert.match(resolved.production.bindings.reason, /does not match its canonical row/);
});

test('baseline drift after freeze blocks architecture as inconsistent', () => {
  const fx = fixture();
  const handlers = createFormalizationKernelHandlers(fx.deps);
  const frame = flowFrame();
  store(frame, 'resolve-product-contract', handlers[FORMALIZATION_HANDLER_IDS.resolveProduct](
    context('resolve-product-contract', receipt('define-product-contract'), frame),
  ));
  store(frame, 'resolve-use-cases', handlers[FORMALIZATION_HANDLER_IDS.resolveUseCases](
    context('resolve-use-cases', receipt('model-use-cases'), frame),
  ));
  store(frame, 'resolve-acceptance-contract', handlers[FORMALIZATION_HANDLER_IDS.resolveAcceptance](
    context('resolve-acceptance-contract', receipt('define-acceptance-contract'), frame),
  ));
  const reconciliation = store(
    frame,
    'resolve-reconciliation',
    handlers[FORMALIZATION_HANDLER_IDS.resolveReconciliation](
      context('resolve-reconciliation', receipt('reconcile-what'), frame),
    ),
  );
  store(frame, 'freeze-acceptance-baseline', handlers[FORMALIZATION_HANDLER_IDS.freezeBaseline](
    context('freeze-acceptance-baseline', reconciliation.production, frame),
  ));
  fx.artifactById.get(30).contentHash = '8'.repeat(64);
  fx.artifactById.get(30).driftState = 'drifted';

  const architecture = handlers[FORMALIZATION_HANDLER_IDS.resolveArchitecture](
    context('resolve-architecture-contract', receipt('define-architecture-contract'), frame),
  );
  assert.equal(architecture.event, 'inconsistent');
  assert.deepEqual(architecture.production.bindings.baselineDriftArtifactIds, [30]);
});
