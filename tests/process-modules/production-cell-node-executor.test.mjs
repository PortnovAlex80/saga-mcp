import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteCellFinalAcceptance } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { ProductionCellNodeExecutor } from '../../dist/process-modules/application/node-executors/production-cell-node-executor.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

function checkPlan(id, phase = 'final') {
  const entries = [{
    check: { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST },
    parameters: {},
    environmentRef: null,
  }];
  const base = {
    checkPlanId: id,
    version: '1.0.0',
    entries,
    decisionPolicyRef: `test.${phase}.decision`,
    decisionPolicyDigest: sha(`${phase}.decision`),
    unknownErrorPolicy: 'fail-closed',
  };
  return { ...base, checkPlanDigest: sha(base) };
}

function cell({ fanout = false, review = false, effect = false } = {}) {
  return {
    id: fanout ? 'fanout-cell' : 'singleton-cell',
    inputSelectors: ['source'],
    materialization: fanout
      ? { sourceBinding: 'source', workKeySelector: 'items', completionPolicy: 'all' }
      : { completionPolicy: 'all' },
    author: { skillRef: 'author-profile', capabilityPreset: 'sandbox-code-author' },
    productContracts: [{
      binding: 'result', schemaRef: 'factory.test-product.v1', mediaType: 'application/json', cardinality: '1',
    }],
    authorGate: {
      gateId: 'author-gate', gatePhase: review ? 'author' : 'final', checkPlan: checkPlan('author-plan', 'author'),
    },
    review: review ? {
      reviewer: { skillRef: 'reviewer-profile', capabilityPreset: 'sandbox-code-reviewer' },
      verdictSchemaRef: 'factory.test-review-verdict.v1',
      payloadContract: {
        contractId: 'test.review-verdict-payload.v1',
        version: '1.0.0',
        contractDigest: sha('test-review-verdict-payload'),
      },
      finalGate: { gateId: 'final-gate', gatePhase: 'final', checkPlan: checkPlan('final-plan') },
    } : undefined,
    recovery: { maxAttempts: 2, onExhausted: 'fail' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
    ...(effect ? { postAcceptanceEffect: 'test-effect' } : {}),
  };
}

function harness(effectResult = null, authorCandidateCarryForward = undefined) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({ db, workplaceRepo, now: () => new Date() });
  const plans = [];
  const activations = [];
  const products = new Map();
  const dependencyBindings = [];
  const effectCalls = [];
  let id = 100;
  const persistence = {
    ensureExecutionPlan(input) {
      const prior = plans.find(entry => entry.input.task.generationKey === input.task.generationKey);
      if (prior) return { ...prior.result, replayed: true };
      const result = { intentId: id++, taskId: id++, replayed: false };
      plans.push({ input, result });
      return result;
    },
    bindProjectedTaskProcessContext(input) { plans.at(-1).binding = input; },
    readTaskProjectRepositoryId() { return 1; },
    readProcessInputHash() { return sha('factory-order'); },
    activateRoleTask(input) { activations.push(input); },
    concludeExecutionIntent() {},
    readExecutionReceipt(executionRef) {
      return executionRef.startsWith('factory-carry-forward-presenter:')
        ? null
        : { intentId: 1, taskId: 1, executionRef };
    },
    projectWorkplace() {},
    sealWorkplaceGraph(input) {
      dependencyBindings.push(...input.items.map(item => ({
        taskId: item.taskId,
        dependencyTaskIds: [...item.dependencyTaskIds],
      })));
    },
  };
  const executor = new ProductionCellNodeExecutor({
    coordinator,
    candidateSetRepo,
    gateRepo,
    persistence,
    postAcceptanceEffects: {
      run(effectId, input) {
        effectCalls.push({ effectId, input });
        if (effectId === 'test-effect' && effectResult) return effectResult;
        return {
          outcome: 'succeeded',
          receiptRef: `provider:${effectId}:${input.candidateSetRef}`,
          receiptDigest: sha({ effectId, candidateSetRef: input.candidateSetRef }),
        };
      },
    },
    finalAcceptance: new SqliteCellFinalAcceptance(db),
    productReader: { readExecutionProducts: ({ executionRef }) => products.get(executionRef) ?? [] },
    checkProviders: {
      resolve(providerId) {
        return providerId === PROVIDER
          ? { providerId: PROVIDER, version: '1.0.0', run: () => 'passed' }
          : null;
      },
    },
    resolveInstallationDigest: () => sha('installation'),
    authorCandidateCarryForward,
    now: () => new Date(),
  });
  return { db, workplaceRepo, coordinator, candidateSetRepo, gateRepo, executor, plans, activations, products, dependencyBindings, effectCalls };
}

function context(definition, frame = { productions: {}, receipts: {}, runInput: {} }) {
  return {
    projectId: 1,
    epicId: 1,
    processRunId: 7,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'development' },
      executionProfiles: [
        { id: 'author-profile', taskKind: 'test.author', executionSkill: 'author-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
        { id: 'reviewer-profile', taskKind: 'test.review', executionSkill: 'review-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
      ],
    },
    node: { id: 'cell-node', kind: 'production-cell', label: 'Cell', description: 'Test cell', cellDefinition: definition },
    input: { order: 'frozen' },
    frame,
    heartbeat() {},
    initiatedBy: 'test',
  };
}

function workplaceRef(cellId, workKey = 'singleton') {
  return { processRunId: 7, moduleRef: 'test-module@1.0.0', productionCellId: cellId, workKey };
}

function finishRole(h, ref, executionRef, product) {
  const queued = h.workplaceRepo.read(ref);
  const leased = h.workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase === 'review' ? 'review_in_progress' : queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: executionRef,
  });
  assert.equal(leased.applied, true);
  const started = h.workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: executionRef,
  });
  assert.equal(started.applied, true);
  h.products.set(executionRef, [product]);
  h.coordinator.sealCandidateSet(ref);
}

test('reconciler projects work and never launches a worker itself', async () => {
  const h = harness();
  const result = await h.executor.execute(context(cell()));
  assert.equal(result.runtimeEvent, 'paused');
  assert.equal(h.plans.length, 1);
  assert.equal(h.activations.length, 1);
  assert.equal(h.plans[0].binding.processInputHash, sha('factory-order'));
  assert.match(h.plans[0].binding.nodeInputHash, /^[a-f0-9]{64}$/);
  assert.equal(h.coordinator.readState(workplaceRef('singleton-cell')).loopState, 'queued');
  h.db.close();
});

test('author product is sealed, gated, and completed with exact provenance', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:1', digest: sha('product'),
  });
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  assert.equal(h.candidateSetRepo.listForWorkplace(ref)[0].producerExecutionRef, 'execution:author');
  assert.equal(h.gateRepo.listDecisionsForWorkplace(ref).length, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1);
  h.db.close();
});

test('required effect settles before final acceptance and replay certification', async () => {
  const h = harness();
  const ctx = context(cell({ effect: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:effect-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:effect', digest: sha('effect-product'),
  });
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  assert.deepEqual(h.effectCalls.map(call => call.effectId), ['test-effect', 'replay-capture']);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1);
  h.db.close();
});

test('effect conflict returns the same Workplace to author repair without certification', async () => {
  const h = harness({ outcome: 'repair_required', reason: 'merge conflict' });
  const ctx = context(cell({ effect: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:conflicted-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:conflict', digest: sha('conflict-product'),
  });
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'paused');
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');
  assert.equal(h.coordinator.readState(ref).nextRole, 'author');
  assert.deepEqual(h.effectCalls.map(call => call.effectId), ['test-effect']);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_effect_receipts').get().n, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 0);
  h.db.close();
});

test('review hand-off creates a distinct reviewer desk before returning', async () => {
  const h = harness();
  const ctx = context(cell({ review: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:author', digest: sha('author'),
  });
  const awaitingReview = await h.executor.execute(ctx);
  assert.equal(awaitingReview.runtimeEvent, 'paused');
  assert.equal(h.activations.at(-1).role, 'reviewer');
  assert.deepEqual(h.plans.at(-1).input.intent.authorityScope.payload_contract, {
    contractId: 'test.review-verdict-payload.v1',
    version: '1.0.0',
    contractDigest: sha('test-review-verdict-payload'),
  });
  assert.equal(h.coordinator.readState(ref).nextRole, 'reviewer');
  finishRole(h, ref, 'execution:reviewer', {
    schemaId: 'factory.test-review-verdict.v1', ref: 'product:review', digest: sha('review'),
  });
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(h.candidateSetRepo.listForWorkplace(ref).filter(set => set.role === 'reviewer').length, 1);
  h.db.close();
});

test('fan-out materializes every stable item and completes only after all pass', async () => {
  const h = harness();
  const definition = cell({ fanout: true });
  const frame = {
    runInput: {}, receipts: {},
    productions: {
      source: {
        schema: 'factory.source.v1', artifactRef: 'source:1', contentHash: sha('source'),
        semanticDigest: sha('source'), // cross-run-stable semantic identity (§5-6)
        bindings: { items: [{ key: 'a' }, { key: 'b' }] },
      },
    },
  };
  const ctx = context(definition, frame);
  const first = await h.executor.execute(ctx);
  assert.equal(first.runtimeEvent, 'paused');
  assert.equal(h.activations.length, 2);
  const rows = h.db.prepare("SELECT workplace_ref FROM factory_workplaces WHERE production_cell_id='fanout-cell' ORDER BY workplace_ref").all();
  assert.equal(rows.length, 2);
  for (const [index, row] of rows.entries()) {
    const serialized = row.workplace_ref.split('/');
    const ref = workplaceRef('fanout-cell', serialized.at(-1));
    finishRole(h, ref, `execution:${index}`, {
      schemaId: 'factory.test-product.v1', ref: `product:${index}`, digest: sha(`product:${index}`),
    });
  }
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(result.production.bindings.items.length, 2);
  assert.ok(result.production.bindings.items.every(item => item.accepted));
  h.db.close();
});

test('fan-out dependencies are projected to the Kanban before dispatch', async () => {
  const h = harness();
  const definition = cell({ fanout: true });
  definition.materialization.dependencySelector = 'dependsOnKeys';
  const frame = {
    runInput: {}, receipts: {},
    productions: {
      source: {
        schema: 'factory.source.v1', artifactRef: 'source:dag', contentHash: sha('source:dag'),
        semanticDigest: sha('source:dag'), // cross-run-stable semantic identity (§5-6)
        bindings: {
          items: [
            { key: 'foundation', dependsOnKeys: [] },
            { key: 'feature', dependsOnKeys: ['foundation'] },
          ],
        },
      },
    },
  };
  await h.executor.execute(context(definition, frame));
  assert.equal(h.plans.length, 2);
  const taskByItem = new Map(h.plans.map(entry => [
    entry.input.task.metadata.cell_input_item.key,
    entry.result.taskId,
  ]));
  assert.deepEqual(h.dependencyBindings, [
    { taskId: taskByItem.get('foundation'), dependencyTaskIds: [] },
    { taskId: taskByItem.get('feature'), dependencyTaskIds: [taskByItem.get('foundation')] },
  ]);
  const states = h.db.prepare(
    `SELECT loop_state,COUNT(*) AS n FROM factory_workplaces
      WHERE production_cell_id='fanout-cell' GROUP BY loop_state ORDER BY loop_state`,
  ).all();
  assert.deepEqual(states, [
    { loop_state: 'idle', n: 1 },
    { loop_state: 'queued', n: 1 },
  ]);
  h.db.close();
});

test('authorized author production is carried into a new current CandidateSet and current gate', async () => {
  const consumed = [];
  const directive = {
    authorizationRef: 'author-carry-forward:test',
    presenterRef: 'factory-carry-forward-presenter:author-carry-forward:test',
    sourceCandidateSetRef: 'candidate-set:prior-author',
    sourceCandidateSetDigest: sha('prior-author'),
    products: [{
      schemaId: 'factory.test-product.v1',
      ref: 'managed-node-submission:prior',
      digest: sha('prior-product'),
    }],
  };
  const carry = {
    resolve() { return directive; },
    consume(input) { consumed.push(input); },
  };
  const h = harness(null, carry);
  const ctx = context(cell({ review: true }));
  const result = await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  assert.equal(result.runtimeEvent, 'paused');
  assert.equal(h.coordinator.readState(ref).loopState, 'queued');
  assert.equal(h.coordinator.readState(ref).nextRole, 'reviewer');
  const author = h.candidateSetRepo.listForWorkplace(ref)
    .find(set => set.role === 'author');
  assert.ok(author);
  assert.equal(author.producerExecutionRef, directive.presenterRef);
  assert.equal(author.members[0].origin, 'carried-forward');
  assert.equal(author.members[0].sourceCandidateSetRef, directive.sourceCandidateSetRef);
  assert.equal(h.gateRepo.listDecisionsForWorkplace(ref).length, 1);
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].candidateSetRef, author.candidateSetRef);
  assert.equal(h.activations.filter(item => item.role === 'reviewer').length, 1);
  assert.equal(h.products.size, 0, 'no author worker product reader was used');
  finishRole(h, ref, 'execution:current-reviewer', {
    schemaId: 'factory.test-review-verdict.v1', ref: 'product:current-review', digest: sha('current-review'),
  });
  const completed = await h.executor.execute(ctx);
  assert.equal(completed.runtimeEvent, 'completed');
  assert.equal(completed.production.bindings.items[0].producerExecutionRef, directive.presenterRef);
  assert.equal(completed.production.bindings.items[0].execution, null,
    'a kernel presenter is provenance, not a fabricated WorkerExecution receipt');
  h.db.close();
});

test('invalid fan-out cycle leaves every Workplace idle and unclaimable', async () => {
  const h = harness();
  const definition = cell({ fanout: true });
  definition.materialization.dependencySelector = 'dependsOnKeys';
  const frame = {
    runInput: {}, receipts: {},
    productions: {
      source: {
        schema: 'factory.source.v1', artifactRef: 'source:cycle', contentHash: sha('source:cycle'),
        semanticDigest: sha('source:cycle'),
        bindings: {
          items: [
            { key: 'a', dependsOnKeys: ['b'] },
            { key: 'b', dependsOnKeys: ['a'] },
          ],
        },
      },
    },
  };
  await assert.rejects(
    h.executor.execute(context(definition, frame)),
    /dependency graph contains a cycle/,
  );
  assert.deepEqual(
    h.db.prepare(
      `SELECT DISTINCT loop_state FROM factory_workplaces
        WHERE production_cell_id='fanout-cell'`,
    ).all(),
    [{ loop_state: 'idle' }],
  );
  h.db.close();
});
