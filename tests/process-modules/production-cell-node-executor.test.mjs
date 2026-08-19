import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { SqliteCellFinalAcceptance } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { ProductionCellNodeExecutor } from '../../dist/process-modules/application/node-executors/production-cell-node-executor.js';
import { CommitAcceptedCandidate } from '../../dist/process-modules/application/commit-accepted-candidate.js';
import { TransitionObligationIntegrator } from '../../dist/process-modules/application/transition-obligation-integrator.js';
import { SqliteTransitionObligationLedger } from '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { recoveryEpochBackoffMs } from '../../dist/process-modules/domain/workplace/production-cell-definition.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import {
  countFailedAcceptanceEffectRepairs,
  countGateRejectedCandidateSets,
  readLastRepairRequiredDiagnosis,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';

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

function harness(effectResult = null, authorCandidateCarryForward = undefined, replayError = null) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({ db, workplaceRepo, authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db), now: () => new Date() });
  const plans = [];
  const activations = [];
  const products = new Map();
  const dependencyBindings = [];
  const effectCalls = [];
  const obligationLedger = new SqliteTransitionObligationLedger(db);
  const durableIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });
  const eagerLease = method => input => {
    let obligation = durableIntegrator[method](input);
    if (obligation.state === 'pending') {
      const fence = obligationLedger.allocateLeaseFence(obligation.obligationKey);
      obligationLedger.lease(obligation.obligationKey, 'node-executor-unit-test', fence);
      obligation = obligationLedger.get(obligation.obligationKey);
    }
    return obligation;
  };
  const obligationIntegrator = {
    onCandidateSetSealed: eagerLease('onCandidateSetSealed'),
    onGateAccepted: eagerLease('onGateAccepted'),
    onEffectsSettled: eagerLease('onEffectsSettled'),
    onProcessSettled: eagerLease('onProcessSettled'),
  };
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
    db,
    coordinator,
    // ADR-081 (K12) — the ONE proof-backed acceptance mutation service. Wired
    // exactly as production does; the executor has no other way to commit an
    // accepted candidate.
    authorityCommit: new CommitAcceptedCandidate({ gateRepo, coordinator }),
    candidateSetRepo,
    gateRepo,
    revisionRepo: new SqliteWorkplaceProductionRevisionRepository(db),
    sealedProductMaterials: { seal() {}, readExact() { throw new Error('not used'); } },
    obligationIntegrator,
    persistence,
    postAcceptanceEffects: {
      identity(effectId) {
        return { effectId, version: '1.0.0', effectDigest: sha(`effect:${effectId}`) };
      },
      run(effectId, input) {
        effectCalls.push({ effectId, input });
        if (effectId === 'replay-capture' && replayError) throw replayError;
        if (effectId === 'test-effect' && effectResult) return effectResult;
        return {
          outcome: 'succeeded',
          receiptRef: `provider:${effectId}:${input.candidateSetRef}`,
          receiptDigest: sha({ effectId, candidateSetRef: input.candidateSetRef }),
        };
      },
    },
    finalAcceptance: new SqliteCellFinalAcceptance(db),
    authorityHead: new SqliteAcceptedAuthorityHeadRepository(db),
    productReader: {
      readContributionProducts: ({ contributorRef }) => {
        const value = products.get(contributorRef);
        if (value instanceof Error) throw value;
        return value ?? [];
      },
      readContributionProductPayload: () => null,
    },
    checkProviders: {
      resolve(providerId) {
        return providerId === PROVIDER
          ? { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST, run: () => 'passed' }
          : null;
      },
    },
    resolveInstallationDigest: () => sha('installation'),
    authorCandidateCarryForward,
    now: () => new Date(),
  });
  return { db, workplaceRepo, coordinator, candidateSetRepo, gateRepo, executor, plans, activations, products, dependencyBindings, effectCalls, persistence };
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
  assert.equal(h.gateRepo.listDecisionsForWorkplace(ref).length, 1);
  const decision = h.gateRepo.listDecisionsForWorkplace(ref)[0];
  const appliedHead = h.db.prepare(
    `SELECT decision_key FROM factory_workplace_gate_decision_heads WHERE workplace_ref=?`,
  ).get(serializeWorkplaceRef(ref));
  assert.equal(appliedHead.decision_key, decision.decisionKey);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1);
  h.db.close();
});

test('ADR-053 C6: gate-accepted obligation carries the EXACT GateDecision key (not a fabricated gate-final: string)', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:c6-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:c6', digest: sha('c6-product'),
  });
  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed');
  // The gate-accepted obligation source_ref MUST be the real GateDecision
  // decision_key (C6), not a fabricated workplace-scoped `gate-final:` string.
  const obl = h.db.prepare(
    `SELECT source_ref FROM factory_transition_obligations WHERE source_kind='gate-accepted'`,
  ).get();
  assert.ok(obl, 'a gate-accepted obligation was appended atomically with the transition');
  const dec = h.db.prepare(
    `SELECT decision_key FROM factory_gate_decisions WHERE verdict='accepted'`,
  ).get();
  assert.ok(dec, 'an accepted gate decision exists');
  assert.equal(
    obl.source_ref,
    dec.decision_key,
    'gate-accepted obligation source_ref must equal the real GateDecision.decisionKey',
  );
  assert.doesNotMatch(
    obl.source_ref,
    /^gate-final:/,
    'obligation must NOT use the fabricated gate-final: workplace key',
  );
  h.db.close();
});

test('ADR-053 C8: terminal(accepted) crash before FinalAcceptance is recovered on reconcile', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:c8-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:c8', digest: sha('c8-product'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 1);
  // Simulate a crash in the window between the gate-accept CAS transition and
  // recordFinalAcceptanceAndCapture: the FinalAcceptance row is absent. In
  // production a crash leaves it simply un-written; here the table is
  // append-only (no-delete trigger enforces immutability), so we drop that
  // trigger to model the post-crash "never recorded" state.
  h.db.prepare('DROP TRIGGER trg_factory_cell_final_acceptances_no_delete').run();
  h.db.prepare('DELETE FROM factory_cell_final_acceptances').run();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n, 0);
  // Re-reconcile the terminal(accepted) workplace → C8 recovery must idempotently
  // re-record FinalAcceptance (and run replay-capture) before returning.
  await h.executor.execute(ctx);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    1,
    'C8: terminal(accepted) reconcile must re-record FinalAcceptance after a crash',
  );
  // A second reconcile must NOT duplicate it (idempotent recovery).
  await h.executor.execute(ctx);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    1,
    'C8: recovery must be idempotent — no duplicate FinalAcceptance',
  );
  h.db.close();
});

test('ADR-067: malformed ingress creates no revision, CandidateSet, GateRun, or obligation', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:malformed-ingress', {
    schemaId: 'factory.test-product.v1', ref: 'product:bad', digest: sha('bad'),
  });
  h.products.set(
    'execution:malformed-ingress',
    new Error('PRODUCTION_INGRESS_DIGEST_MISMATCH'),
  );
  await assert.rejects(
    () => h.executor.execute(ctx),
    /PRODUCTION_INGRESS_DIGEST_MISMATCH/,
  );
  for (const table of [
    'factory_workplace_production_revisions',
    'factory_candidate_sets',
    'factory_gate_runs',
    'factory_transition_obligations',
  ]) {
    assert.equal(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  h.db.close();
});

test('ADR-053 C8: replay capture failure cannot create a false FinalAcceptance', async () => {
  const h = harness(null, undefined, new Error('REPLAY_AUTHOR_GATE_AUTHORITY_MISSING'));
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:c8-replay-fail', {
    schemaId: 'factory.test-product.v1', ref: 'product:c8-replay-fail', digest: sha('c8-replay-fail'),
  });
  await assert.rejects(() => h.executor.execute(ctx), /REPLAY_AUTHOR_GATE_AUTHORITY_MISSING/);
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    0,
    'mandatory replay evidence must precede FinalAcceptance',
  );
  h.db.close();
});

test('ADR-053 C1: author acceptance atomically records the exact accepted-author authority head', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:c1-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:c1', digest: sha('c1-product'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  const wref = 'workplace/7/test-module@1.0.0/singleton-cell/singleton';
  // C1: the authority head must be recorded atomically with the author-gate
  // acceptance (same transaction as the CAS transition), pointing at the EXACT
  // accepted author CandidateSet + its GateDecision key — NOT reconstructible by
  // candidate_set_ref hash order.
  const head = h.db.prepare(
    `SELECT accepted_author_candidate_set_ref, accepted_author_gate_decision_key
       FROM factory_accepted_authority_head WHERE workplace_ref=?`,
  ).get(wref);
  assert.ok(head, 'C1: authority head must be recorded on author-gate acceptance');
  const cs = h.db.prepare(
    `SELECT role FROM factory_candidate_sets WHERE candidate_set_ref=?`,
  ).get(head.accepted_author_candidate_set_ref);
  assert.equal(cs.role, 'author', 'head points to an author CandidateSet');
  const dec = h.db.prepare(
    `SELECT verdict, gate_phase FROM factory_gate_decisions WHERE decision_key=?`,
  ).get(head.accepted_author_gate_decision_key);
  assert.equal(dec.verdict, 'accepted');
  assert.equal(dec.gate_phase, 'final');
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
  const h = harness({
    outcome: 'repair_required',
    reason: 'merge conflict',
    evidence: { conflictingPath: 'src/app.ts', expectedBase: 'abc123' },
  });
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
  const repair = h.db.prepare(
    `SELECT effect_id,effect_version,effect_digest,gate_decision_key,
            issue_snapshot,issue_digest,receipt_digest
       FROM factory_cell_effect_repair_issues`,
  ).get();
  assert.equal(repair.effect_id, 'test-effect');
  assert.equal(repair.effect_version, '1.0.0');
  assert.equal(repair.effect_digest, sha('effect:test-effect'));
  assert.ok(repair.gate_decision_key);
  const issue = JSON.parse(repair.issue_snapshot);
  assert.equal(issue.schemaVersion, 'factory.recovery-issue.v1');
  assert.equal(issue.disposition, 'repair');
  assert.equal(issue.summary, 'merge conflict');
  assert.equal(issue.context.evidence.conflictingPath, 'src/app.ts');
  assert.equal(repair.issue_digest, sha(issue));
  assert.equal(
    h.db.prepare(`SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE verdict='repair_required'`).get().n,
    0,
    'an effect repair must not fabricate or rewrite the accepted GateDecision',
  );
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
  const authorSet = h.candidateSetRepo.listForWorkplace(ref)
    .find(set => set.role === 'author');
  assert.ok(authorSet);
  assert.deepEqual(h.plans.at(-1).input.intent.authorityScope.payload_bindings, [{
    field: 'subject_candidate_set_ref',
    equals: authorSet.candidateSetRef,
  }]);
  assert.equal(
    h.plans.at(-1).input.task.metadata.subject_candidate_set_ref,
    authorSet.candidateSetRef,
  );
  assert.match(
    h.plans.at(-1).input.task.generationKey,
    /:reviewer:[a-f0-9]{64}$/,
  );
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

test('fan-out never reuses a singleton pre-projected task or WorkIntent across workplaces', async () => {
  const h = harness();
  const definition = cell({ fanout: true });
  const frame = {
    runInput: {}, receipts: {},
    productions: {
      source: {
        schema: 'factory.source.v1', artifactRef: 'source:prepared', contentHash: sha('source:prepared'),
        semanticDigest: sha('source:prepared'),
        bindings: { items: [{ key: 'a' }, { key: 'b' }] },
      },
    },
  };
  const ctx = context(definition, frame);
  ctx.input = { bindings: { preProjectedTaskId: 91, preProjectedIntentId: 92 } };
  await h.executor.execute(ctx);
  assert.equal(h.plans.length, 2);
  assert.equal(new Set(h.plans.map(plan => plan.result.taskId)).size, 2);
  assert.equal(h.plans.some(plan => plan.result.taskId === 91), false);
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

// ---------------------------------------------------------------------------
// ADR-053 C5-02 — at final author acceptance, bind the CURRENT workplace task
// onto the accepted-authority head. The authoritative source is the worker-
// execution→task binding (readExecutionReceipt): the EXACT task the accepted
// execution was launched for. This is carry-forward-safe — it is neither
// submission.task_id (the ORIGIN process's task) nor ORDER BY t.id DESC
// (recency). These tests prove the executor resolves the task from that
// authoritative source (not recency) and falls back to the durable author-task
// projection for a carry-forward presenter.
// ---------------------------------------------------------------------------

const C5_WREF = 'workplace/7/test-module@1.0.0/singleton-cell/singleton';

test('ADR-053 C5-02: author acceptance binds the worker-execution receipt task, not a recency-picked task', async () => {
  const h = harness();
  // The accepted execution was launched for task 42 — the authoritative worker-
  // execution→task binding.
  h.persistence.readExecutionReceipt = (executionRef) =>
    executionRef === 'execution:c5-author' ? { intentId: 1, taskId: 42 } : null;
  // A DECOY task with a HIGHER id for the SAME workplace. This is exactly what
  // `ORDER BY t.id DESC LIMIT 1` (the recency pole) would wrongly select.
  h.db.prepare(
    `INSERT INTO projects (id, name) VALUES (1, 'c5-decoy-project')`,
  ).run();
  h.db.prepare(
    `INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'c5-decoy-epic')`,
  ).run();
  h.db.prepare(
    `INSERT INTO tasks (id, epic_id, title, workplace_ref, status, execution_mode)
     VALUES (999, 1, 'decoy-recency-task', ?, 'todo', 'git_change')`,
  ).run(C5_WREF);

  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:c5-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:c5', digest: sha('c5-product'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');

  const head = h.db.prepare(
    `SELECT accepted_author_task_id AS task FROM factory_accepted_authority_head WHERE workplace_ref=?`,
  ).get(C5_WREF);
  assert.ok(head, 'C5-02: authority head must be recorded on author acceptance');
  // The head carries the receipt's task (42), NOT the decoy recency task (999).
  assert.equal(head.task, '42',
    'C5-02: task identity comes from the worker-execution receipt, not ORDER BY t.id DESC');
  h.db.close();
});

test('ADR-053 C5-02: a carry-forward presenter (no worker receipt) falls back to the durable author-task projection', async () => {
  const directive = {
    authorizationRef: 'author-carry-forward:c5',
    presenterRef: 'factory-carry-forward-presenter:author-carry-forward:c5',
    sourceCandidateSetRef: 'candidate-set:prior-author-c5',
    sourceCandidateSetDigest: sha('prior-author-c5'),
    products: [{
      schemaId: 'factory.test-product.v1',
      ref: 'managed-node-submission:prior-c5',
      digest: sha('prior-product-c5'),
    }],
  };
  const carry = { resolve: () => directive, consume: () => {} };
  const h = harness(null, carry);
  // A carry-forward presenter has NO worker receipt (readExecutionReceipt →
  // null). The fallback is the durable author-task projection for this
  // workplace — the current workplace's author task.
  h.persistence.readExecutionReceipt = (executionRef) =>
    executionRef.startsWith('factory-carry-forward-presenter:') ? null : { intentId: 1, taskId: 1 };
  h.persistence.readProjectedRoleTask = (_workplaceRef, role) =>
    role === 'author' ? { taskId: 77 } : null;

  const ctx = context(cell({ review: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  assert.equal(h.coordinator.readState(ref).nextRole, 'reviewer',
    'carry-forward author candidate was accepted (handed off to reviewer)');

  const head = h.db.prepare(
    `SELECT accepted_author_task_id AS task FROM factory_accepted_authority_head WHERE workplace_ref=?`,
  ).get(C5_WREF);
  assert.ok(head, 'C5-02: authority head must be recorded on carry-forward author acceptance');
  // No worker receipt → bound from the author-task projection (the current
  // workplace's author task), NOT submission.task_id (the origin task).
  assert.equal(head.task, '77',
    'C5-02: carry-forward acceptance binds the workplace author-task projection');
  h.db.close();
});

test('ADR-053: verifying desk with a lost exact presentation fails closed', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:1', digest: sha('product'),
  });
  // The verified live failure: the reservation pointer is cleared AFTER the
  // material is on the desk (engine-start machinery once did exactly this).
  h.db.prepare(
    'UPDATE factory_workplaces SET active_reservation_ref=NULL WHERE workplace_ref=?',
  ).run(serializeWorkplaceRef(ref));
  await assert.rejects(
    () => h.executor.execute(ctx),
    /PRESENTATION_AUTHORITY_MISSING/,
    'missing authority must never be reconstructed from latest execution rows',
  );
  const setCount = h.db.prepare(
    'SELECT COUNT(*) AS count FROM factory_candidate_sets WHERE workplace_ref=?',
  ).get(serializeWorkplaceRef(ref)).count;
  assert.equal(setCount, 0, 'no CandidateSet is created from guessed authority');
  h.db.close();
});

test('TB-12: a COMPLETED run-gate obligation falls through — the gate is re-driven, not parked', async () => {
  const h = harness();
  const ctx = context(cell());
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:1', digest: sha('product'),
  });
  // Crash-window residue: the obligation machinery reports the handoff as
  // already completed (the original episode decided the gate but died before
  // applying the verdict). The old `state !== 'in_progress'` check parked the
  // desk in pending forever on every redrive.
  const original = h.executor['opts'].obligationIntegrator.onCandidateSetSealed;
  h.executor['opts'].obligationIntegrator.onCandidateSetSealed = input => {
    const obligation = original.call(h.executor['opts'].obligationIntegrator, input);
    return { ...obligation, state: 'completed' };
  };

  const result = await h.executor.execute(ctx);
  assert.equal(result.runtimeEvent, 'completed', 'state machine proceeds past a completed handoff');
  assert.equal(h.coordinator.readState(ref).terminalReason, 'accepted');
  assert.ok(h.gateRepo.listDecisionsForWorkplace(ref).length >= 1, 'gate ran (replayed or fresh)');
  h.db.close();
});

// ---------------------------------------------------------------------------
// Worker feedback loop map — Fix-3 (budget) + Fix-1 (park reason) + Fix-2
// (effect-repair marker). The stopwatch scenario: 1 rejected attempt, 1
// ACCEPTED attempt, then the post-acceptance effect asks for repair. The
// accepted attempt must NOT consume recovery budget (the old attemptCount
// counted every sealed set → immediate park with no reason).
// ---------------------------------------------------------------------------

function wireRejectionAccounting(h) {
  h.persistence.countGateRejectedCandidateSets = (ref, role) =>
    countGateRejectedCandidateSets(h.db, serializeWorkplaceRef(ref), role);
  h.persistence.readLastRepairRequiredDiagnosis = (ref, role) =>
    readLastRepairRequiredDiagnosis(h.db, serializeWorkplaceRef(ref), role);
}

function setAuthorCheckOutcome(h, outcome) {
  h.executor['opts'].checkProviders.resolve = providerId =>
    (providerId === PROVIDER
      ? { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST, run: () => outcome }
      : null);
}

test('Fix-3: an ACCEPTED attempt does not consume the recovery budget (stopwatch scenario)', async () => {
  const h = harness({
    outcome: 'repair_required',
    reason: 'PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task 187 submitted 86e28119 but branch is 793c0704',
  });
  wireRejectionAccounting(h);
  const definition = cell({ effect: true });
  definition.recovery = { maxAttempts: 2, onExhausted: 'pause' };
  const ctx = context(definition);
  const ref = workplaceRef('singleton-cell');

  // Attempt 1: the gate rejects the candidate.
  await h.executor.execute(ctx);
  setAuthorCheckOutcome(h, 'failed');
  finishRole(h, ref, 'execution:rejected-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:rejected', digest: sha('rejected'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');
  await h.executor.execute(ctx); // requeue within budget
  assert.equal(h.coordinator.readState(ref).loopState, 'queued');

  // Attempt 2: the gate ACCEPTS; the post-acceptance effect fails.
  setAuthorCheckOutcome(h, 'passed');
  finishRole(h, ref, 'execution:accepted-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:accepted', digest: sha('accepted'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait',
    'effect repair returns the workplace to the author');
  assert.equal(h.coordinator.readState(ref).nextRole, 'author');

  // The budget branch: rejected attempts = 1 (the accepted one is free),
  // 1 < maxAttempts(2) → requeue instead of the stopwatch park.
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'queued',
    'an accepted attempt must not exhaust the recovery budget');
  assert.notEqual(h.coordinator.readState(ref).loopState, 'paused');
  h.db.close();
});

test('QA-E16: a repeating accept→effect-fail cycle stays durably bounded', async () => {
  const h = harness({
    outcome: 'repair_required',
    reason: 'PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH: task 9 submitted aaa but branch is bbb',
  });
  wireRejectionAccounting(h);
  h.persistence.countFailedAcceptanceEffectRepairs = (ref) =>
    countFailedAcceptanceEffectRepairs(h.db, serializeWorkplaceRef(ref));
  const definition = cell({ effect: true });
  definition.recovery = { maxAttempts: 1, onExhausted: 'pause' };
  const ctx = context(definition);
  const ref = workplaceRef('singleton-cell');
  const serialized = serializeWorkplaceRef(ref);

  // The gate accepts on the very first attempt: rejected attempts = 0.
  await h.executor.execute(ctx); // hire the author
  setAuthorCheckOutcome(h, 'passed');
  finishRole(h, ref, 'execution:accepted-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:accepted', digest: sha('accepted'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait',
    'the failed post-acceptance effect returns the author to repair');

  // One exact effect-repair issue is the durable bound. Accepted Gate attempts
  // themselves remain free; only failed settlement consumes this budget.
  await h.executor.execute(ctx);
  const state = h.coordinator.readState(ref);
  assert.equal(state.loopState, 'paused',
    'one failed integration ≥ maxAttempts(1) must park, not requeue forever');
  const reason = h.db.prepare(
    'SELECT reason_code FROM factory_workplace_park_reasons WHERE workplace_ref=?',
  ).get(serialized);
  assert.equal(reason.reason_code, 'RECOVERY_BUDGET_EXHAUSTED');
  h.db.close();
});

test('Fix-1: exhausting the budget parks WITH an append-only reason and a live pointer', async () => {
  const h = harness();
  wireRejectionAccounting(h);
  const definition = cell();
  definition.recovery = { maxAttempts: 1, onExhausted: 'pause' };
  const ctx = context(definition);
  const ref = workplaceRef('singleton-cell');

  await h.executor.execute(ctx);
  setAuthorCheckOutcome(h, 'failed');
  finishRole(h, ref, 'execution:only-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:only', digest: sha('only'),
  });
  await h.executor.execute(ctx); // gate rejects → repair_wait
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');

  // Next reconcile: 1 rejected attempt ≥ maxAttempts(1) → human park with a reason.
  await h.executor.execute(ctx);
  const state = h.coordinator.readState(ref);
  assert.equal(state.loopState, 'paused');
  assert.equal(state.kanbanPhase, 'blocked');

  const serialized = serializeWorkplaceRef(ref);
  const reasons = h.db.prepare(
    'SELECT id,reason_code,message FROM factory_workplace_park_reasons WHERE workplace_ref=?',
  ).all(serialized);
  assert.equal(reasons.length, 1, 'exactly one park reason row (idempotent reconcile)');
  assert.equal(reasons[0].reason_code, 'RECOVERY_BUDGET_EXHAUSTED');
  assert.match(reasons[0].message, /1 unsuccessful attempt\(s\) for role 'author'/);
  assert.match(reasons[0].message, /test\.production-contract/,
    'the decoded findings of the last rejection ride along');

  const workplace = h.db.prepare(
    'SELECT active_recovery_case_ref FROM factory_workplaces WHERE workplace_ref=?',
  ).get(serialized);
  assert.equal(workplace.active_recovery_case_ref, `workplace-park-reason:${reasons[0].id}`,
    'the parked workplace points at its reason');
  h.db.close();
});

test('Fix-2: an effect-repair transition points at the exact immutable repair issue', async () => {
  const h = harness({ outcome: 'repair_required', reason: 'integration blocked' });
  wireRejectionAccounting(h);
  const definition = cell({ effect: true });
  const ctx = context(definition);
  const ref = workplaceRef('singleton-cell');
  const serialized = serializeWorkplaceRef(ref);

  await h.executor.execute(ctx);
  finishRole(h, ref, 'execution:effect-fail-author', {
    schemaId: 'factory.test-product.v1', ref: 'product:effect-fail', digest: sha('effect-fail'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');

  const workplace = h.db.prepare(
    'SELECT active_recovery_case_ref FROM factory_workplaces WHERE workplace_ref=?',
  ).get(serialized);
  assert.match(workplace.active_recovery_case_ref, /^cell-effect-repair:[a-f0-9]{64}$/,
    'the effect-repair transition points to its exact immutable repair issue');
  const issue = h.db.prepare(
    'SELECT effect_repair_ref,issue_snapshot FROM factory_cell_effect_repair_issues WHERE workplace_ref=?',
  ).get(serialized);
  assert.equal(issue.effect_repair_ref, workplace.active_recovery_case_ref);
  assert.equal(JSON.parse(issue.issue_snapshot).summary, 'integration blocked');
  h.db.close();
});

// ---------------------------------------------------------------------------
// ADR-075 — no-human quality loop: recovery.onExhausted='requeue'.
// ---------------------------------------------------------------------------
function wireEpochAccounting(h) {
  h.persistence.readRecoveryEpochBaseline = (ref, role) => {
    const row = h.db.prepare(
      `SELECT epoch, baseline_rejected_sets, baseline_terminal_executions,
              baseline_effect_repairs, created_at
         FROM factory_workplace_recovery_epochs
        WHERE workplace_ref=? AND role=?
        ORDER BY epoch DESC LIMIT 1`,
    ).get(serializeWorkplaceRef(ref), role);
    if (!row) return null;
    return {
      epoch: row.epoch,
      baselineRejectedSets: row.baseline_rejected_sets,
      baselineTerminalExecutions: row.baseline_terminal_executions,
      baselineEffectRepairs: row.baseline_effect_repairs,
      rolledBackoffUntilMs: h.epochBackoffOverride ?? (
        Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
        + recoveryEpochBackoffMs(row.epoch)
      ),
    };
  };
  h.persistence.recordRecoveryEpoch = (input) => {
    h.db.prepare(
      `INSERT OR IGNORE INTO factory_workplace_recovery_epochs
         (workplace_ref, role, epoch,
          baseline_rejected_sets, baseline_terminal_executions,
          baseline_effect_repairs, exhausted_attempts,
          max_attempts, total_attempts_cap, last_diagnosis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      serializeWorkplaceRef(input.workplaceRef),
      input.role,
      input.epoch,
      input.baselineRejectedSets,
      input.baselineTerminalExecutions,
      input.baselineEffectRepairs,
      input.exhaustedAttempts,
      input.maxAttempts,
      input.totalAttemptsCap,
      input.lastDiagnosis,
    );
  };
}

test("ADR-075: onExhausted='requeue' rolls the budget into immutable recovery epochs, never parks", async () => {
  const h = harness({
    outcome: 'repair_required',
    reason: 'AC-9 Violation: lap capture while paused',
  });
  wireRejectionAccounting(h);
  wireEpochAccounting(h);
  h.epochBackoffOverride = undefined;
  const definition = cell();
  definition.recovery = { maxAttempts: 1, onExhausted: 'requeue', totalAttempts: 2 };
  const ctx = context(definition);
  const ref = workplaceRef('singleton-cell');
  const serialized = serializeWorkplaceRef(ref);

  // Attempt 1: rejected → repair_wait.
  await h.executor.execute(ctx);
  setAuthorCheckOutcome(h, 'failed');
  finishRole(h, ref, 'execution:rejected-1', {
    schemaId: 'factory.test-product.v1', ref: 'product:r1', digest: sha('r1'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');

  // Exhaustion of epoch 0 → ROLLOVER: one immutable epoch row is appended and
  // the workplace STAYS in repair_wait (no park, no human).
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait',
    'a requeue cell never parks at budget exhaustion');
  const epochRow = h.db.prepare(
    'SELECT epoch, baseline_rejected_sets, exhausted_attempts, total_attempts_cap '
    + 'FROM factory_workplace_recovery_epochs WHERE workplace_ref=? ORDER BY epoch DESC',
  ).get(serialized);
  assert.equal(epochRow.epoch, 1);
  assert.equal(epochRow.baseline_rejected_sets, 1, 'the baseline freezes the all-time counter');
  assert.equal(epochRow.exhausted_attempts, 1);
  assert.equal(epochRow.total_attempts_cap, 2);

  // The inter-epoch backoff window holds the line in repair_wait.
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait',
    'backoff window keeps the workplace waiting before the fresh epoch starts');

  // After the backoff expires, the epoch-relative budget is empty → requeue.
  h.epochBackoffOverride = 0;
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'queued',
    'after backoff the fresh epoch requeues the role');

  // Attempt 2 rejected again: total (2) ≥ totalAttempts cap → honest terminal
  // failed — the non-human circuit breaker, never an anonymous infinite loop.
  setAuthorCheckOutcome(h, 'failed');
  finishRole(h, ref, 'execution:rejected-2', {
    schemaId: 'factory.test-product.v1', ref: 'product:r2', digest: sha('r2'),
  });
  await h.executor.execute(ctx);
  assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');
  await h.executor.execute(ctx);
  const finalState = h.coordinator.readState(ref);
  assert.equal(finalState.loopState, 'terminal');
  assert.equal(finalState.terminalReason, 'failed',
    'the total cap converts a persistent failure into a terminal outcome');
  assert.equal(
    h.db.prepare(
      'SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?',
    ).get(serialized).n,
    1,
    'the cap fires before a second rollover row is written',
  );
  h.db.close();
});

// ===========================================================================
// BLINDSIGHT C6 — reviewer round visibility. The reviewer prompt must carry
// the round number, prior verdicts and the rejected author candidates, so
// «the author cosmetically patches and resubmits» becomes structurally
// visible to the only actor who can call it out.
// ===========================================================================
test('reviewer objective carries round number, prior verdicts and rejected candidates', async () => {
  const h = harness();
  h.persistence.readReviewerRoundHistory = () => ({
    round: 3,
    priorVerdicts: [
      { round: 1, subjectCandidateSetRef: 'candidate-set/a1', verdict: 'changes_requested', findings: ['widget broken'], submittedAt: '2026-08-01T00:00:00Z' },
      { round: 2, subjectCandidateSetRef: 'candidate-set/a2', verdict: 'changes_requested', findings: ['widget still broken'], submittedAt: '2026-08-02T00:00:00Z' },
    ],
    rejectedCandidateSetRefs: ['candidate-set/a1', 'candidate-set/a2'],
  });
  const ctx = context(cell({ review: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:author', digest: sha('author'),
  });
  await h.executor.execute(ctx);
  const reviewerPlan = h.plans.at(-1);
  assert.equal(reviewerPlan.input.intent.outputSchema, 'factory.test-review-verdict.v1');
  const objective = reviewerPlan.input.intent.objective;
  assert.match(objective, /REVIEW HISTORY/, 'C6: the history block must be delivered');
  assert.match(objective, /round 3/, 'the round number must be visible');
  assert.match(objective, /widget still broken/, 'prior verdict findings must be visible');
  assert.match(objective, /candidate-set\/a2/, 'rejected author candidates must be visible');
  assert.match(objective, /cosmetic/i, 'the block must tell the reviewer what to watch for');
  h.db.close();
});

test('round-1 reviewer objective has no REVIEW HISTORY block', async () => {
  const h = harness();
  h.persistence.readReviewerRoundHistory = () => ({
    round: 1, priorVerdicts: [], rejectedCandidateSetRefs: [],
  });
  const ctx = context(cell({ review: true }));
  await h.executor.execute(ctx);
  const ref = workplaceRef('singleton-cell');
  finishRole(h, ref, 'execution:author', {
    schemaId: 'factory.test-product.v1', ref: 'product:author', digest: sha('author'),
  });
  await h.executor.execute(ctx);
  const objective = h.plans.at(-1).input.intent.objective;
  assert.doesNotMatch(objective, /REVIEW HISTORY/,
    'a first review round carries no stale history');
  h.db.close();
});

test('carry-forward failure context is delivered to the child author task (blindsight C3)', async () => {
  const bound = [];
  const directive = {
    authorizationRef: 'author-carry-forward:c3',
    presenterRef: 'factory-carry-forward-presenter:author-carry-forward:c3',
    sourceCandidateSetRef: 'candidate-set:prior-author',
    sourceCandidateSetDigest: sha('prior-author'),
    eligibleFailureCode: 'review-output-schema-mismatch',
    parentFailureError:
      "review verdict contract expected exactly one 'factory.development-review-verdict.v1', received 0",
    products: [{
      schemaId: 'factory.test-product.v1', ref: 'managed-node-submission:prior', digest: sha('prior-product'),
    }],
  };
  const carry = { resolve: () => directive, consume() {} };
  const h = harness(null, carry);
  h.persistence.readProjectedRoleTask = () => ({ taskId: 4242 });
  h.persistence.bindCarryForwardFailureContext = input => bound.push(input);
  const ctx = context(cell({ review: true }));
  await h.executor.execute(ctx);
  assert.equal(bound.length, 1,
    'C3: the typed parent failure reason must be bound to the child author task');
  assert.equal(bound[0].taskId, 4242);
  assert.equal(bound[0].eligibleFailureCode, 'review-output-schema-mismatch');
  assert.match(bound[0].parentError, /review verdict contract expected exactly one/);
  assert.equal(bound[0].authorizationRef, 'author-carry-forward:c3');
  h.db.close();
});
