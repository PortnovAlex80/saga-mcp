// tests/process-modules/scope-widening-routing.test.mjs
//
// STAGE-13 — scope insufficiency as a LAWFUL TRANSITION: the executor
// repair_wait routing (successor of the retired re-plan mandate routing).
//
// When the finding-set trajectory of the role's last two rejections is
// SCOPE-IMPOSSIBLE (the same path-outside-authority key survived while the
// overall set spun or churned), the worker physically cannot write into the
// frozen scope it keeps offending. The route is a TYPED WIDENING REQUEST to
// the carve authority, decided on CONTENTION ONLY:
//   granted  → a wider scope revision is frozen (append-only ledger) and the
//              SAME workplace is re-staffed (requeue, budget-free);
//   refused  → terminal failed, the refusal row naming the LIVE holders.
//
// The finding shape is the REAL authority-check diagnostic
// (development-check-providers.ts path-outside-authority), with the
// stage-13 teaching suffix tolerated.
//
// Also covered: the worker-declared entry (worker_done outcome
// 'scope-insufficient' records a pending request; the next executor drive
// decides it before any budget arithmetic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { SqliteScopeWideningLedger } from '../../dist/infrastructure/workplace/sqlite-scope-widening-ledger.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  countGateRejectedCandidateSets,
  createSqliteProductionCellProjectionPersistence,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

function authorityViolation(path, scopes = 'package.json, src/game/, tests/') {
  return encodeCheckDiagnostic({
    code: 'path-outside-authority',
    message: `Git paths [${path}] are outside frozen changeScopes [${scopes}]. `
      + `If the acceptance criteria genuinely require these paths, conclude the attempt with `
      + `worker_done({ outcome: 'scope-insufficient', requested_scopes: [paths] }) instead of `
      + `writing them undeclared.`,
  });
}
function overlapDiagnostic(left, right) {
  return encodeCheckDiagnostic({
    code: 'implementation-scope-overlap',
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  });
}

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

function cell() {
  return {
    id: 'singleton-cell',
    inputSelectors: ['source'],
    materialization: { completionPolicy: 'all' },
    author: { skillRef: 'author-profile', capabilityPreset: 'sandbox-code-author' },
    productContracts: [{
      binding: 'result', schemaRef: 'factory.test-product.v1', mediaType: 'application/json', cardinality: '1',
    }],
    authorGate: {
      gateId: 'author-gate', gatePhase: 'final', checkPlan: checkPlan('author-plan'),
    },
    review: undefined,
    recovery: { maxAttempts: 2, onExhausted: 'requeue' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
  };
}

function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO projects (name) VALUES ('scope-widening-unit')`,
  ).run();
  db.prepare(
    `INSERT INTO epics (project_id, name) VALUES (1, 'scope-widening-unit-epic')`,
  ).run();
  // The re-plan mandate ledger table is lazily created by its repository; the
  // executor no longer mints mandates (stage-13 removed the trigger), so the
  // test creates it to assert NO row is minted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_replan_mandates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_lineage_key TEXT NOT NULL,
      workplace_ref TEXT NOT NULL,
      role TEXT NOT NULL,
      cycle_number INTEGER NOT NULL,
      surviving_keys TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workplace_ref, role)
    );`);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db, workplaceRepo, authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db), now: () => new Date(),
  });
  const products = new Map();
  const obligationLedger = new SqliteTransitionObligationLedger(db);
  const durableIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });
  const eagerLease = method => input => {
    let obligation = durableIntegrator[method](input);
    if (obligation.state === 'pending') {
      const fence = obligationLedger.allocateLeaseFence(obligation.obligationKey);
      obligationLedger.lease(obligation.obligationKey, 'scope-widening-unit-test', fence);
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
  let checkOutcome = { outcome: 'passed', evidenceRefs: [] };
  const persistence = {
    ensureExecutionPlan() { return { intentId: id++, taskId: id++, replayed: false }; },
    bindProjectedTaskProcessContext() {},
    readTaskProjectRepositoryId() { return 1; },
    readProcessInputHash() { return sha('factory-order'); },
    activateRoleTask() {},
    concludeExecutionIntent() {},
    readExecutionReceipt: executionRef => ({ intentId: 1, taskId: 1, executionRef }),
    projectWorkplace() {},
  };
  persistence.countGateRejectedCandidateSets = (ref, role) =>
    countGateRejectedCandidateSets(db, serializeWorkplaceRef(ref), role);
  // TASK-SHADOW FIX — the widening request binds through the REAL K7
  // exact-key role-task projection (metadata $.role + workplace_ref). The
  // retired stub reimplemented the production port's newest-wins SQL, which
  // in a multi-task singleton workplace binds the request to the newest
  // (neighbor/reviewer) task row.
  persistence.readProjectedRoleTask =
    createSqliteProductionCellProjectionPersistence(db).readProjectedRoleTask;
  persistence.countTerminalExecutionsForTask = () => 0;
  const executorOptions = {
    db,
    coordinator,
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
      run: (effectId, input) => ({
        outcome: 'succeeded',
        receiptRef: `provider:${effectId}:${input.candidateSetRef}`,
        receiptDigest: sha({ effectId, candidateSetRef: input.candidateSetRef }),
      }),
    },
    finalAcceptance: new SqliteCellFinalAcceptance(db),
    authorityHead: new SqliteAcceptedAuthorityHeadRepository(db),
    productReader: {
      readContributionProducts: ({ contributorRef }) => products.get(contributorRef) ?? [],
      readContributionProductPayload: () => null,
    },
    checkProviders: {
      resolve: providerId => (providerId === PROVIDER
        ? {
          providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST,
          run: () => checkOutcome,
        }
        : null),
    },
    resolveInstallationDigest: () => sha('installation'),
    now: () => new Date(),
  };
  const executor = new ProductionCellNodeExecutor(executorOptions);
  const setCheckDiagnostics = (outcome, diagnostics) => {
    checkOutcome = { outcome, evidenceRefs: diagnostics };
  };
  return {
    db, workplaceRepo, coordinator, candidateSetRepo, executor, executorOptions, products, persistence,
    setCheckDiagnostics,
  };
}

function context(definition) {
  return {
    projectId: 1,
    epicId: 1,
    processRunId: 7,
    module: {
      identity: { name: 'test-module', version: '1.0.0', kind: 'development' },
      executionProfiles: [
        { id: 'author-profile', taskKind: 'test.author', executionSkill: 'author-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
      ],
    },
    node: { id: 'cell-node', kind: 'production-cell', label: 'Cell', description: 'Test cell', cellDefinition: definition },
    input: { order: 'frozen' },
    frame: { productions: {}, receipts: {}, runInput: {} },
    heartbeat() {},
    initiatedBy: 'test',
  };
}

function workplaceRef() {
  return { processRunId: 7, moduleRef: 'test-module@1.0.0', productionCellId: 'singleton-cell', workKey: 'singleton' };
}

/**
 * The card row the executor's task binding resolves: original frozen scopes
 * [package.json, src/game/, tests/], the honest need src/physics/spacecraft.js.
 */
function seedTaskRow(h, ref, overrides = {}) {
  const serialized = serializeWorkplaceRef(ref);
  // role:'author' is the durable role binding the REAL projection writes
  // (activateProductionCellRoleTask/ensureExecutionPlan task metadata); the
  // exact-key reader resolves the card through it.
  const metadata = JSON.stringify({
    role: 'author',
    process_run_id: 7,
    cell_input_item: {
      key: overrides.key ?? 'singleton',
      changeScopes: overrides.scopes ?? ['package.json', 'src/game/', 'tests/'],
    },
  });
  const existing = h.db.prepare('SELECT id FROM tasks WHERE workplace_ref=?').get(serialized);
  if (existing) return existing.id;
  const info = h.db.prepare(
    `INSERT INTO tasks (title, status, epic_id, task_kind, workflow_stage, execution_mode, tags, metadata, workplace_ref)
     VALUES ('scope fixture', 'todo', 1, 'test.author', 'test', 'tracker_only', '[]', ?, ?)`,
  ).run(metadata, serialized);
  return Number(info.lastInsertRowid);
}

/** A second LIVE workplace holding a claim (for refusal). */
function seedHolderWorkplace(h, ref, holderScopes) {
  const holderRef = {
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: 'holder-card',
  };
  new SqliteWorkplaceRepository(h.db).materialize({
    processRunId: holderRef.processRunId,
    moduleRef: holderRef.moduleRef,
    productionCellId: holderRef.productionCellId,
    workKey: holderRef.workKey,
  });
  seedTaskRow(h, holderRef, { key: 'holder-card', scopes: holderScopes });
  return holderRef;
}

function finishRole(h, ref, executionRef, product) {
  const queued = h.workplaceRepo.read(ref);
  const leased = h.workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase,
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

function engineLogCapture() {
  const path = join(tmpdir(), `scope-widening-${process.pid}-${Date.now()}.log`);
  const prior = process.env.SAGA_ENGINE_LOG;
  process.env.SAGA_ENGINE_LOG = path;
  return {
    read() { return readFileSync(path, 'utf8'); },
    restore() {
      if (prior === undefined) delete process.env.SAGA_ENGINE_LOG;
      else process.env.SAGA_ENGINE_LOG = prior;
      rmSync(path, { force: true });
    },
  };
}

/**
 * STAGE-15 TASK 1 — the widening decision must be JOURNALLED evidence, not a
 * post-hoc database query. The capture mirrors engineLogCapture: pin
 * SAGA_RUN_JOURNAL to a temp file for the test's extent.
 */
function journalCapture() {
  const path = join(tmpdir(), `scope-widening-journal-${process.pid}-${Date.now()}.jsonl`);
  const prior = process.env.SAGA_RUN_JOURNAL;
  process.env.SAGA_RUN_JOURNAL = path;
  return {
    events(kind) {
      try {
        return readFileSync(path, 'utf8').split('\n').filter(Boolean)
          .map(line => JSON.parse(line)).filter(e => e.kind === kind);
      } catch { return []; }
    },
    restore() {
      if (prior === undefined) delete process.env.SAGA_RUN_JOURNAL;
      else process.env.SAGA_RUN_JOURNAL = prior;
      rmSync(path, { force: true });
    },
  };
}

async function rejectedAttempt(h, ctx, ref, label, diagnostics, executor = h.executor) {
  h.setCheckDiagnostics('failed', diagnostics);
  finishRole(h, ref, `execution:${label}`, {
    schemaId: 'factory.test-product.v1', ref: `product:${label}`, digest: sha(label),
  });
  await executor.execute(ctx);
  const state = h.coordinator.readState(ref);
  assert.equal(state.loopState, 'repair_wait', `attempt ${label} must be rejected into repair_wait`);
}

test('trajectory grant: scope-impossible routes to a widening GRANT, re-freezes a wider revision, requeues budget-free', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  seedTaskRow(h, ref);
  const log = engineLogCapture();
  const journal = journalCapture();
  try {
    await h.executor.execute(ctx); // hire the author
    await rejectedAttempt(h, ctx, ref, 'poa-1', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx); // below budget → requeue
    assert.equal(h.coordinator.readState(ref).loopState, 'queued');

    await rejectedAttempt(h, ctx, ref, 'poa-2', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    const result = await h.executor.execute(ctx); // THE routing decision

    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'queued',
      'the grant re-staffs the SAME workplace (queued), not a park, not terminal');
    assert.equal(state.terminalReason, null);
    assert.equal(result.runtimeEvent, 'paused',
      'a granted widening is scheduled production ("in flight"), not a human pause');
    assert.equal(result.pause?.kind, 'worker_active',
      'the node-level wait is typed worker_active — re-staffed work, not a park');

    const events = h.db.prepare(
      'SELECT event_kind, source, requested_scopes, granted_revision, granted_scopes, holders FROM factory_scope_widening_events ORDER BY id',
    ).all();
    assert.equal(events.length, 2, 'request + grant rows');
    assert.equal(events[0].event_kind, 'request');
    assert.equal(events[0].source, 'cell-trajectory');
    assert.deepEqual(JSON.parse(events[0].requested_scopes), ['src/physics/spacecraft.js']);
    assert.equal(events[1].event_kind, 'grant');
    assert.equal(events[1].granted_revision, 1);
    const granted = JSON.parse(events[1].granted_scopes);
    for (const scope of ['package.json', 'src/game/', 'tests/', 'src/physics/spacecraft.js']) {
      assert.ok(granted.includes(scope), `granted revision must contain ${scope}`);
    }

    const engineLine = log.read();
    assert.match(engineLine, /scope-widening\] GRANTED/);
    assert.doesNotMatch(engineLine, /ROLLOVER/, 'no epoch rollover may fire — the widening preempted the budget');

    // STAGE-15 TASK 1 — the decision is journalled evidence: correlation key
    // + resulting scope revision, readable without touching the DB.
    const grantedEvents = journal.events('scope_widening.granted');
    assert.equal(grantedEvents.length, 1, 'exactly one grant journal event');
    assert.equal(grantedEvents[0].workplace_ref, serializeWorkplaceRef(ref));
    assert.equal(grantedEvents[0].data.resulting_scope_revision, 1);
    assert.ok(
      grantedEvents[0].data.granted_scopes.includes('src/physics/spacecraft.js'),
      'the journalled grant carries the widened scopes',
    );
    assert.equal(journal.events('scope_widening.refused').length, 0);

    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs').get().n,
      0,
      'no recovery-epoch row — the budget never engaged',
    );
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_replan_mandates').get().n,
      0,
      'no re-plan mandate may be minted — one mechanism for one event',
    );

    // The widened authority is what the fence reads now.
    const effective = new SqliteScopeWideningLedger(h.db)
      .readEffectiveChangeScopes(h.db.prepare('SELECT id FROM tasks WHERE workplace_ref=?')
        .get(serializeWorkplaceRef(ref)).id, ['package.json', 'src/game/', 'tests/']);
    assert.ok(effective.includes('src/physics/spacecraft.js'));
  } finally {
    journal.restore();
    log.restore();
    h.db.close();
  }
});

test('trajectory refusal: a LIVE holder blocks the grant — terminal failed, holders named', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  seedTaskRow(h, ref);
  seedHolderWorkplace(h, ref, ['src/physics/']);
  const log = engineLogCapture();
  const journal = journalCapture();
  try {
    await h.executor.execute(ctx);
    await rejectedAttempt(h, ctx, ref, 'ref-1', [authorityViolation('src/physics/spacecraft.js')]);
    await h.executor.execute(ctx);
    await rejectedAttempt(h, ctx, ref, 'ref-2', [authorityViolation('src/physics/spacecraft.js')]);
    const result = await h.executor.execute(ctx);

    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'terminal', 'a refused widening is terminal');
    assert.equal(state.terminalReason, 'failed', 'the honest terminal outcome');
    assert.equal(result.runtimeEvent, 'completed');
    assert.equal(result.domainEvent, 'failed');

    const refusal = h.db.prepare(
      "SELECT holders FROM factory_scope_widening_events WHERE event_kind='refusal'",
    ).get();
    assert.ok(refusal, 'a refusal row exists');
    const holders = JSON.parse(refusal.holders);
    assert.equal(holders.length, 1);
    assert.equal(holders[0].workKey, 'holder-card', 'the refusal NAMES the contending holder');
    assert.equal(holders[0].scope, 'src/physics/');
    assert.match(log.read(), /scope-widening\] REFUSED.*holder-card/);

    // STAGE-15 TASK 1 — the refusal is journalled with the named holders.
    const refusedEvents = journal.events('scope_widening.refused');
    assert.equal(refusedEvents.length, 1, 'exactly one refusal journal event');
    assert.equal(refusedEvents[0].workplace_ref, serializeWorkplaceRef(ref));
    assert.equal(refusedEvents[0].data.holders.length, 1);
    assert.equal(refusedEvents[0].data.holders[0].scope, 'src/physics/');
    assert.equal(journal.events('scope_widening.granted').length, 0);
  } finally {
    journal.restore();
    log.restore();
    h.db.close();
  }
});

test('worker-declared: a pending request is decided on the next drive, before budget arithmetic', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  const taskId = seedTaskRow(h, ref);
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire → queued

    // A worker leases and starts the attempt, then concludes it with the
    // typed outcome; the tool layer records the request and releases the
    // execution 'declared' (running → repair_wait).
    const queued = h.workplaceRepo.read(ref);
    const leased = h.workplaceRepo.applyTransition({
      workplaceRef: ref,
      expectedRevision: queued.revision,
      kanbanPhase: queued.kanbanPhase,
      loopState: 'leased',
      nextRole: queued.nextRole,
      terminalReason: null,
      activeReservationRef: 'execution:declared-1',
    });
    assert.equal(leased.applied, true);
    const started = h.workplaceRepo.applyTransition({
      workplaceRef: ref,
      expectedRevision: leased.revision,
      kanbanPhase: leased.state.kanbanPhase,
      loopState: 'running',
      nextRole: leased.state.nextRole,
      terminalReason: null,
      activeReservationRef: 'execution:declared-1',
    });
    assert.equal(started.applied, true);
    new SqliteScopeWideningLedger(h.db).recordRequest({
      workplaceRef: serialized,
      taskId,
      role: 'author',
      source: 'worker-declared',
      requestedScopes: ['src/physics/spacecraft.js'],
      requestedByExecution: 'execution:declared-1',
    });
    h.coordinator.applyEvent(ref, { kind: 'scope-declared' });
    let state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait', 'the declaration parks the attempt lawfully');

    const result = await h.executor.execute(ctx); // THE decision drive
    state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'queued', 'uncontended declaration → grant → re-staffed');
    assert.equal(result.runtimeEvent, 'paused');
    assert.equal(result.pause?.kind, 'worker_active');

    const events = h.db.prepare(
      'SELECT event_kind, source FROM factory_scope_widening_events ORDER BY id',
    ).all();
    assert.equal(events.length, 2);
    assert.equal(events[0].source, 'worker-declared');
    assert.equal(events[1].event_kind, 'grant');
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs').get().n,
      0,
      'no budget engagement for a lawful transition',
    );
  } finally {
    log.restore();
    h.db.close();
  }
});

test('trajectory companion: one violation then a RESOLVED key stays ordinary budget flow (no false widening)', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  seedTaskRow(h, ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx);
    await rejectedAttempt(h, ctx, ref, 'burn-1', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx);
    assert.equal(h.coordinator.readState(ref).loopState, 'queued');
    await rejectedAttempt(h, ctx, ref, 'burn-2-resolved', [
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx);
    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'queued',
      'a resolved authority violation is converging work — no widening request');
    assert.doesNotMatch(log.read(), /scope-widening/);
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_scope_widening_events').get().n,
      0,
    );
  } finally {
    log.restore();
    h.db.close();
  }
});
