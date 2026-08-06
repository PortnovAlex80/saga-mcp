import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
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

function cell({ fanout = false, review = false } = {}) {
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
      finalGate: { gateId: 'final-gate', gatePhase: 'final', checkPlan: checkPlan('final-plan') },
    } : undefined,
    recovery: { maxAttempts: 2, onExhausted: 'fail' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
  };
}

function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({ db, workplaceRepo, now: () => new Date() });
  const plans = [];
  const activations = [];
  const products = new Map();
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
    projectWorkplace() {},
  };
  const executor = new ProductionCellNodeExecutor({
    coordinator,
    candidateSetRepo,
    gateRepo,
    persistence,
    productReader: { readExecutionProducts: ({ executionRef }) => products.get(executionRef) ?? [] },
    checkProviders: {
      resolve(providerId) {
        return providerId === PROVIDER
          ? { providerId: PROVIDER, version: '1.0.0', run: () => 'passed' }
          : null;
      },
    },
    resolveInstallationDigest: () => sha('installation'),
    now: () => new Date(),
  });
  return { db, workplaceRepo, coordinator, candidateSetRepo, gateRepo, executor, plans, activations, products };
}

function context(definition, frame = { productions: {}, receipts: {}, runInput: {} }) {
  return {
    projectId: 1,
    epicId: 1,
    processRunId: 7,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'development' },
      executionProfiles: [
        { id: 'author-profile', taskKind: 'test.author', executionSkill: 'author-skill', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
        { id: 'reviewer-profile', taskKind: 'test.review', executionSkill: 'review-skill', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
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
