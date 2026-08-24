// tests/process-modules/finding-trajectory-budget.test.mjs
//
// FINDING-TRAJECTORY BUDGET, unit 3 of 3 — the executor repair_wait
// integration (docs/architecture/FINDING-TRAJECTORY-BUDGET.md, variant d
// hybrid). The budget compares consecutive factory_gate_finding_set_chain
// rows of the (workplace, gate, role, check_plan_digest) scope:
//
//   T1 spinning  — an IDENTICAL finding set 3x exhausts the epoch budget
//                  exactly as today (the waiver never weakens the budget for
//                  non-convergence);
//   T2 converging— 15 -> strict 5 subset: attempt 3 does NOT exhaust the
//                  epoch budget (today it does — THE RED); the streak to the
//                  default chain ceiling 20 ends in an honest terminal failed
//                  whose engine-log diagnosis names the SURVIVING keys;
//   T5 crashes   — converging findings do NOT rescue a crash-exhausted
//                  budget: terminal executions still charge.
//
// All findings use the REAL stage-11 shape (development task-graph contract):
// 'implementation items X and Y overlap without a dependency order'.

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
import { recoveryEpochBackoffMs } from '../../dist/process-modules/domain/workplace/production-cell-definition.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  countGateRejectedCandidateSets,
  createSqliteProductionCellProjectionPersistence,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { countTerminalExecutionsForTask } from '../../dist/app/product-lifecycle-runtime.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');

const OVERLAP_CODE = 'implementation-scope-overlap';
function overlapDiagnostic(left, right) {
  return encodeCheckDiagnostic({
    code: OVERLAP_CODE,
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  });
}
// C(8,2) = 28 stable item pairs — attempts expose a shrinking PREFIX, so every
// consecutive pair of attempts is a strict key-subset chain.
const EIGHT_ITEMS = ['auth', 'billing', 'cart', 'deck', 'email', 'files', 'guest', 'hooks'];
const ALL_PAIRS = [];
for (let i = 0; i < EIGHT_ITEMS.length; i += 1) {
  for (let j = i + 1; j < EIGHT_ITEMS.length; j += 1) {
    ALL_PAIRS.push([EIGHT_ITEMS[i], EIGHT_ITEMS[j]]);
  }
}
// The stage-11 first attempt: ALL C(6,2) = 15 pairs of six items; the second:
// a strict 5-pair subset of exactly those pairs.
const SIX_ITEMS = ['auth', 'billing', 'cart', 'deck', 'email', 'files'];
const STAGE_ELEVEN_FIRST = [];
for (let i = 0; i < SIX_ITEMS.length; i += 1) {
  for (let j = i + 1; j < SIX_ITEMS.length; j += 1) {
    STAGE_ELEVEN_FIRST.push([SIX_ITEMS[i], SIX_ITEMS[j]]);
  }
}
const STAGE_ELEVEN_SECOND = [
  ['auth', 'billing'], ['auth', 'email'], ['billing', 'email'], ['cart', 'deck'], ['email', 'files'],
];

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
  db.prepare(`INSERT INTO projects (name) VALUES ('budget-unit')`).run();
  db.prepare(`INSERT INTO epics (project_id, name) VALUES (1, 'budget-unit-epic')`).run();
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
      obligationLedger.lease(obligation.obligationKey, 'budget-unit-test', fence);
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
  // TASK-SHADOW FIX — the crash-attempt binding resolves through the REAL K7
  // exact-key role-task projection (metadata $.role + workplace_ref), backed
  // by a REAL tasks row; the retired stub returned a constant task id and the
  // retired production port picked the newest row of the workplace.
  const authorTaskId = db.prepare(
    `INSERT INTO tasks
       (epic_id,title,description,status,priority,task_kind,workflow_stage,
        execution_mode,tags,metadata,workplace_ref)
     VALUES (1,'budget author','budget author','todo','high','test.author',
             'test','tracker_only','[]',?,?)`,
  ).run(
    JSON.stringify({ role: 'author' }),
    serializeWorkplaceRef({
      processRunId: 7, moduleRef: 'test-module@1.0.0',
      productionCellId: 'singleton-cell', workKey: 'singleton',
    }),
  );
  const authorTaskRowId = Number(authorTaskId.lastInsertRowid);
  persistence.readProjectedRoleTask =
    createSqliteProductionCellProjectionPersistence(db).readProjectedRoleTask;
  persistence.countTerminalExecutionsForTask = taskId =>
    countTerminalExecutionsForTask(db, taskId);
  const executor = new ProductionCellNodeExecutor({
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
  });
  const setCheckDiagnostics = (outcome, diagnostics) => {
    checkOutcome = { outcome, evidenceRefs: diagnostics };
  };
  // Real terminal (lost) executions on the AUTHOR task row — counted by the
  // REAL countTerminalExecutionsForTask SQL, exactly what the dispatch loop's
  // crash accounting observes in production.
  const setCrashes = count => {
    for (let index = 0; index < count; index += 1) {
      db.prepare(
        `INSERT INTO worker_executions
           (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
            launcher,state,phase)
         VALUES (?,?,?,?,?,?,?,'claude_cli','lost','executing')`,
      ).run(
        `execution:crash-${count}-${index}`,
        `run:crash-${count}-${index}`,
        1,
        1,
        authorTaskRowId,
        `worker:crash-${count}-${index}`,
        'budget-unit-test',
      );
    }
  };
  return {
    db, workplaceRepo, coordinator, candidateSetRepo, executor, products, persistence,
    setCheckDiagnostics, setCrashes,
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

// Capture engineLog (SAGA_ENGINE_LOG) into a per-test temp file.
function engineLogCapture() {
  const dir = mkdtempSync(join(tmpdir(), 'finding-trajectory-'));
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

async function rejectedAttempt(h, ctx, ref, label, diagnostics) {
  h.setCheckDiagnostics('failed', diagnostics);
  finishRole(h, ref, `execution:${label}`, {
    schemaId: 'factory.test-product.v1', ref: `product:${label}`, digest: sha(label),
  });
  await h.executor.execute(ctx);
  const state = h.coordinator.readState(ref);
  assert.equal(state.loopState, 'repair_wait', `attempt ${label} must be rejected into repair_wait`);
}

test("T1 spinning: an IDENTICAL finding set 3x exhausts the epoch budget exactly as today (no weakening)", async () => {
  const h = harness();
  wireEpochAccounting(h);
  const definition = cell();
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire the author

    await rejectedAttempt(h, ctx, ref, 'spin-1', STAGE_ELEVEN_FIRST.map(([a, b]) => overlapDiagnostic(a, b)));
    await h.executor.execute(ctx); // 1 < maxAttempts(2) → requeue
    assert.equal(h.coordinator.readState(ref).loopState, 'queued');

    await rejectedAttempt(h, ctx, ref, 'spin-2', STAGE_ELEVEN_FIRST.map(([a, b]) => overlapDiagnostic(a, b)));
    // Identical 15-key set = SPINNING: charged, ADR-075 rollover fires exactly
    // as before the trajectory budget existed.
    await h.executor.execute(ctx);
    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait',
      'a byte-identical finding set must still exhaust the epoch budget (ROLLOVER)');
    const epochRow = h.db.prepare(
      'SELECT epoch, baseline_rejected_sets, exhausted_attempts FROM factory_workplace_recovery_epochs '
      + 'WHERE workplace_ref=? ORDER BY epoch DESC',
    ).get(serialized);
    assert.ok(epochRow, 'the spin exhaustion wrote the immutable epoch rollover row');
    assert.equal(epochRow.epoch, 1);
    assert.equal(epochRow.exhausted_attempts, 2);
    assert.match(log.read(), /ROLLOVER/, 'the ADR-075 rollover log line fired');
    assert.doesNotMatch(log.read(), /CONVERGING/,
      'no convergence waiver may fire for an identical finding set');
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_gate_finding_set_chain WHERE workplace_ref=?').get(serialized).n,
      2,
      'both spin rejections are durably on the chain (audit only — no waiver)',
    );
  } finally {
    log.restore();
    h.db.close();
  }
});

test('T2 RED: 15 -> strict 5 subset — attempt 3 does NOT exhaust the epoch budget (today it does)', async () => {
  const h = harness();
  wireEpochAccounting(h);
  const definition = cell();
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire the author

    await rejectedAttempt(h, ctx, ref, 'conv-1', STAGE_ELEVEN_FIRST.map(([a, b]) => overlapDiagnostic(a, b)));
    await h.executor.execute(ctx); // 1 < 2 → requeue
    assert.equal(h.coordinator.readState(ref).loopState, 'queued');

    // Attempt 2 (the 5-key strict subset): today this EXHAUSTS the epoch
    // budget (2 >= maxAttempts 2) into a ROLLOVER; with the trajectory budget
    // it is recognized as converging work and requeued with NO epoch row.
    await rejectedAttempt(h, ctx, ref, 'conv-2', STAGE_ELEVEN_SECOND.map(([a, b]) => overlapDiagnostic(a, b)));
    await h.executor.execute(ctx); // THE budget decision
    assert.equal(h.coordinator.readState(ref).loopState, 'queued',
      'attempt 3 is minted: a converging rejection must NOT exhaust the epoch budget');
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?').get(serialized).n,
      0,
      'no epoch rollover row — the budget did not exhaust',
    );
    const engineLine = log.read();
    assert.match(engineLine, /CONVERGING 15→5 keys/,
      'the waiver logs the chain, not the bare count');
    assert.match(engineLine, /streak=1\/20/);
    assert.match(engineLine, /rejectedSets waived — crashes\/effects still charge/);
    assert.doesNotMatch(engineLine, /ROLLOVER/);
  } finally {
    log.restore();
    h.db.close();
  }
});

test('T2 ceiling: the streak to the default chain ceiling 20 ends in an honest terminal naming the SURVIVING keys', async () => {
  const h = harness();
  wireEpochAccounting(h);
  const definition = cell();
  const ctx = context(definition);
  const ref = workplaceRef();
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire the author

    // 22 rejections: 26 -> 25 -> ... -> 5 keys (every step a strict subset).
    // Steps 1..20 are waived; the 21st consecutive converging step exceeds
    // the DEFAULT ceiling 20 -> terminal failed with the 5 surviving keys.
    for (let attempt = 1; attempt <= 22; attempt += 1) {
      const pairCount = 27 - attempt;
      await rejectedAttempt(
        h, ctx, ref, `ceiling-${attempt}`,
        ALL_PAIRS.slice(0, pairCount).map(([a, b]) => overlapDiagnostic(a, b)),
      );
      await h.executor.execute(ctx); // budget pass
      const state = h.coordinator.readState(ref);
      if (attempt < 22) {
        assert.equal(state.loopState, 'queued',
          `converging attempt ${attempt} (streak ${attempt - 1} <= 20) is waived and requeued`);
      } else {
        assert.equal(state.loopState, 'terminal',
          'the 21st consecutive converging step terminates the line honestly');
        assert.equal(state.terminalReason, 'failed');
      }
    }
    const engineLine = log.read();
    assert.match(engineLine, /CONVERGENCE-CEILING/);
    assert.match(engineLine, /streak=21\/20/);
    assert.match(engineLine, /5 surviving finding key\(s\)/);
    assert.match(engineLine, /implementation items 'auth' and 'billing' overlap without a dependency order/,
      'the terminal diagnosis NAMES a surviving key');
    assert.match(engineLine, /CONVERGING 26→25 keys/, 'the first waiver rendered the chain head');
    // The absolute epoch budget never exhausted: no rollover row exists.
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs').get().n,
      0,
      'the ceiling terminal fired before any epoch rollover — the waiver held the whole chain',
    );
  } finally {
    log.restore();
    h.db.close();
  }
});

test('T5: converging findings do NOT rescue a crash-exhausted budget — terminal executions still charge', async () => {
  const h = harness();
  wireEpochAccounting(h);
  const definition = cell();
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    await h.executor.execute(ctx); // hire the author
    // Two workers died on this desk before any gate ran.
    h.setCrashes(2);

    await rejectedAttempt(h, ctx, ref, 'conv-crash-1', STAGE_ELEVEN_FIRST.map(([a, b]) => overlapDiagnostic(a, b)));
    await h.executor.execute(ctx); // budget pass
    // Even though NO second rejection exists yet, the crash counters alone
    // (2 >= maxAttempts 2) exhaust the epoch: the workplace parks in the
    // rollover backoff, exactly the ADR-075 behavior.
    assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait',
      'crash accounting exhausts the budget on its own');

    // A genuinely converging second rejection (15 -> 5) must NOT waive the
    // crash charge: terminalExecutions (2) still >= maxAttempts (2).
    await rejectedAttempt(h, ctx, ref, 'conv-crash-2', STAGE_ELEVEN_SECOND.map(([a, b]) => overlapDiagnostic(a, b)));
    await h.executor.execute(ctx);
    const state = h.coordinator.readState(ref);
    assert.notEqual(state.loopState, 'queued',
      'a converging cell with dying workers does not spin for free');
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_recovery_epochs WHERE workplace_ref=?').get(serialized).n >= 1,
      true,
      'the crash-exhausted budget rolled over (or terminated) despite convergence',
    );
    assert.doesNotMatch(log.read(), /CONVERGING 15→5/,
      'no waiver may fire when crashes alone exhausted the epoch budget');
  } finally {
    log.restore();
    h.db.close();
  }
});
