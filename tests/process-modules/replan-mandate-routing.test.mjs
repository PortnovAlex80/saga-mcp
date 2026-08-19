// tests/process-modules/replan-mandate-routing.test.mjs
//
// RE-PLAN CYCLE (REPLAN-CYCLE-TZ §1 step 2) — the executor repair_wait
// routing, unit T2 of 9. When the finding-set trajectory of the role's last
// two rejections is SCOPE-IMPOSSIBLE (the same path-outside-authority key
// survived while the overall set spun or churned), the budget arithmetic is
// moot: the worker physically cannot write into the frozen scope it keeps
// offending. The route is a TYPED RE-PLAN MANDATE —
//   NOT terminal failed (the defect is a planning carve error, not a worker
//                       failure),
//   NOT a requeue (another attempt is impossible, not slow).
//
// The finding shape is the REAL stage-11 authority check:
//   <provider>:path-outside-authority
//   :: Git paths [src/physics/spacecraft.js] are outside frozen changeScopes
//      [package.json, src/game/, tests/].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  countGateRejectedCandidateSets,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

// The REAL stage-11 authority-violation diagnostic (development-check-providers
// path-outside-authority): the physics worker keeps touching
// src/physics/spacecraft.js while its frozen scope owns only
// [package.json, src/game/, tests/].
function authorityViolation(path, scopes = 'package.json, src/game/, tests/') {
  return encodeCheckDiagnostic({
    code: 'path-outside-authority',
    message: `Git paths [${path}] are outside frozen changeScopes [${scopes}].`,
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
      obligationLedger.lease(obligation.obligationKey, 'replan-unit-test', fence);
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
  persistence.readTaskForWorkplace = () => ({ taskId: 1 });
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
  const dir = mkdtempSync(join(tmpdir(), 'replan-routing-'));
  const path = join(dir, 'engine.log');
  const prior = process.env.SAGA_ENGINE_LOG;
  process.env.SAGA_ENGINE_LOG = path;
  return {
    read() { return readFileSync(path, 'utf8'); },
    restore() {
      if (prior === undefined) delete process.env.SAGA_ENGINE_LOG;
      else process.env.SAGA_ENGINE_LOG = prior;
      rmSync(dir, { recursive: true, force: true });
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

test('T2 RED: scope-impossible routes repair_wait to a re-plan mandate (parked REPLAN_MANDATED — not terminal, not requeue)', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire the author

    // Attempt 1: the physics worker touched src/physics/spacecraft.js outside
    // its frozen scope [package.json, src/game/, tests/].
    await rejectedAttempt(h, ctx, ref, 'poa-1', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx); // below budget → requeue
    assert.equal(h.coordinator.readState(ref).loopState, 'queued',
      'the FIRST authority violation alone still requeues — one burn is not yet scope-impossible');

    // Attempt 2: the SAME path-outside-authority key returns byte-identical
    // (spinning overall). Budget would say 2/2 = ROLLOVER; the trajectory says
    // the repair is IMPOSSIBLE — the mandate must preempt the budget.
    await rejectedAttempt(h, ctx, ref, 'poa-2', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    const result = await h.executor.execute(ctx); // THE routing decision

    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'paused',
      'scope-impossible parks the workplace under a re-plan mandate');
    assert.equal(state.terminalReason, null,
      'the mandate is NOT a terminal failed — the defect is a carve error, not a worker failure');
    assert.notEqual(state.loopState, 'queued', 'the mandate is NOT a requeue');
    assert.equal(result.runtimeEvent, 'paused');
    assert.equal(result.pause?.kind, 'replan_required',
      'the node-level pause is TYPED — a re-plan wait, distinguishable from worker_active and human_required');

    const park = h.db.prepare(
      'SELECT reason_code, message FROM factory_workplace_park_reasons ORDER BY id DESC LIMIT 1',
    ).get();
    assert.equal(park.reason_code, 'REPLAN_MANDATED',
      'the park reason row carries the typed mandate code');
    assert.match(park.message, /src\/physics\/spacecraft\.js/,
      'the park diagnosis NAMES the offending path');

    const engineLine = log.read();
    assert.match(engineLine, /REPLAN-MANDATE/);
    assert.match(engineLine, /path-outside-authority/);
    assert.doesNotMatch(engineLine, /ROLLOVER/,
      'no epoch rollover may fire — the mandate preempted the budget arithmetic');
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?').get(serialized).n,
      0,
      'no recovery-epoch row — the budget never engaged',
    );
  } finally {
    log.restore();
    h.db.close();
  }
});

test('T8 executor companion: a ratchet denial parks REPLAN_CYCLE_RATCHET (human_required), not a mandate', async () => {
  const h = harness();
  const POLICY_KEY = 'development-case:run:7:test-module@1.0.0';
  const SPACECRAFT_KEY = `${PROVIDER}:path-outside-authority`
    + '::Git paths [src/physics/spacecraft.js] are outside frozen changeScopes '
    + '[package.json, src/game/, tests/].';
  // The ledger-backed policy with one prior mandate of the SAME lineage that
  // already burned this exact key (the run row is absent → run-scoped lineage).
  const ledgerTable = `
    CREATE TABLE IF NOT EXISTS factory_replan_mandates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_lineage_key TEXT NOT NULL,
      workplace_ref TEXT NOT NULL,
      role TEXT NOT NULL,
      cycle_number INTEGER NOT NULL,
      surviving_keys TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workplace_ref, role)
    );`;
  h.db.exec(ledgerTable);
  h.db.prepare(
    'INSERT INTO factory_replan_mandates (case_lineage_key, workplace_ref, role, cycle_number, surviving_keys) '
    + "VALUES (?, 'workplace/prior-cycle', 'author', 2, ?)",
  ).run(POLICY_KEY, JSON.stringify([SPACECRAFT_KEY]));
  const { SqliteReplanMandateLedger } = await import(
    '../../dist/infrastructure/workplace/sqlite-replan-mandate-ledger.js'
  );
  const policyExecutor = new ProductionCellNodeExecutor({
    ...h.executorOptions,
    replanCyclePolicy: new SqliteReplanMandateLedger(h.db),
  });
  const ctx = context(cell());
  const ref = workplaceRef();
  const log = engineLogCapture();
  try {
    await policyExecutor.execute(ctx); // hire the author
    await rejectedAttempt(h, ctx, ref, 'ratchet-1', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ], policyExecutor);
    await policyExecutor.execute(ctx);
    // The SAME key returns: scope-impossible, but the ratchet sees it already
    // burned the prior mandate of this lineage — no cycle 3.
    await rejectedAttempt(h, ctx, ref, 'ratchet-2', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ], policyExecutor);
    const result = await policyExecutor.execute(ctx);
    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'paused',
      'the ratchet denial parks the workplace for a human decision');
    assert.equal(state.terminalReason, null);
    assert.equal(result.pause?.kind, 'human_required',
      'a ratchet denial is a HUMAN wait — no replan_required, no new cycle');
    const park = h.db.prepare(
      'SELECT reason_code, message FROM factory_workplace_park_reasons ORDER BY id DESC LIMIT 1',
    ).get();
    assert.equal(park.reason_code, 'REPLAN_CYCLE_RATCHET');
    assert.match(park.message, /src\/physics\/spacecraft\.js/,
      'the full diagnosis names the reproduced burn');
    assert.match(log.read(), /REPLAN-RATCHET/);
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_replan_mandates').get().n,
      1,
      'the denied trigger minted NO new mandate row',
    );
  } finally {
    log.restore();
    h.db.close();
  }
});

test('T2 companion: one authority violation then a RESOLVED key stays ordinary budget flow (no false mandate)', async () => {
  const h = harness();
  const ctx = context(cell());
  const ref = workplaceRef();
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx);
    await rejectedAttempt(h, ctx, ref, 'burn-1', [
      authorityViolation('src/physics/spacecraft.js'),
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx);
    assert.equal(h.coordinator.readState(ref).loopState, 'queued');
    // Attempt 2 moved the file inside its scope: the authority key is GONE
    // from latest (strict subset, still-converging) — not scope-impossible.
    await rejectedAttempt(h, ctx, ref, 'burn-2-resolved', [
      overlapDiagnostic('auth', 'billing'),
    ]);
    await h.executor.execute(ctx);
    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'queued',
      'a resolved authority violation is converging work — the waiver holds, no mandate');
    assert.doesNotMatch(log.read(), /REPLAN-MANDATE/);
  } finally {
    log.restore();
    h.db.close();
  }
});
