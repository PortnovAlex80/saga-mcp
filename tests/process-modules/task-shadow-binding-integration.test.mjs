// tests/process-modules/task-shadow-binding-integration.test.mjs
//
// TASK-SHADOW BINDING (SM-14/MM-3, RED-TEAM AUDIT Team-7 finding 1 / R3,
// ADR-053) — the integration regression the red team demanded: a REAL
// multi-task singleton workplace driving the REAL role-task projection, the
// REAL crash-attempt counting and the REAL executor recovery budget.
//
// The retired production port `readTaskForWorkplace`
// (src/app/product-lifecycle-runtime.ts, `SELECT id ... ORDER BY id DESC
// LIMIT 1`) selected the workplace's NEWEST task row. A singleton workplace
// accumulates author + reviewer task rows (reviewer generations are minted
// per accepted author set), so after the first review round the reviewer row
// — the author's NEIGHBOR on the same desk — permanently shadowed the author
// task. The recovery budget then read the shadow's clean executions and
// never engaged across real worker deaths (Elite-8: 15 deaths, rollover
// table empty, parking lost at 3x the limit). Every pre-existing unit test
// stubbed this port; this file is the un-stubbed counterexample.
//
// Scenarios:
//   S1 THE REGRESSION — author task (older) + reviewer task (newer) in one
//      singleton workplace, real author-task deaths, executor budget pass:
//      the deaths COUNT (epoch rollover row with baseline_terminal_executions
//      = 2). The retired newest-wins SQL is probed side-by-side and provably
//      picks the reviewer row (the shadow) whose execution count is 0 — the
//      exact Elite-8 signature the fix removes.
//   S2 NEGATIVE ambiguity — a duplicate role-task row (broken idempotence
//      fence) fails closed: the K7 reader throws
//      PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE through the executor's
//      budget path; no newest-wins tiebreak may ever pick silently.
//   S3 NEGATIVE missing binding — a workplace with no (or reviewer-only) task
//      rows resolves null for the author role: absence is exact, never a
//      recency fallback onto the neighbor row.
//   S4 F1 (Red-Team HIGH) — a LEGAL second review round (author +
//      reviewer#1(done) + reviewer#2(active)) drove the role-only uniqueness
//      claim to THROW on the real production path. The reviewer key is now
//      the exact CURRENT subject_candidate_set_ref (accepted-author authority
//      head): two review generations via author repair, then reviewer-side
//      deaths + reviewer-targeted repair_wait — no throw, the CURRENT
//      generation's deaths count, the superseded generation is ignored, and a
//      duplicate CURRENT subject row still throws.
//
// REAL components (nothing under test is stubbed):
//   SCHEMA_SQL, SqliteWorkplace/CandidateSet/Gate/FinalAcceptance/
//   AcceptedAuthorityHead/WorkplaceProductionRevision repositories,
//   ProductionCellCoordinator, ProductionCellNodeExecutor,
//   CommitAcceptedCandidate, TransitionObligation ledger+integrator,
//   createSqliteProductionCellProjectionPersistence (ensureExecutionPlan,
//   bindProjectedTaskProcessContext, readTaskProjectRepositoryId,
//   readProjectedRoleTask — the K7 exact-key read the production composition
//   root provides, generation-exact for the reviewer since F1),
//   activateProductionCellRoleTask, countTerminalExecutionsForTask,
//   countGateRejectedCandidateSets, and (F4) the PRODUCTION recovery-epoch
//   helpers from sqlite-recovery-epoch-ledger.ts.
// Stubbed (declared plumbing, not the seam under test): the worker
// productReader (no managed-production ledger), projectWorkplace projection
// fanout.

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
import { activateProductionCellRoleTask } from '../../dist/lifecycle/work-assignment-core.js';
import { countTerminalExecutionsForTask } from '../../dist/app/product-lifecycle-runtime.js';
import { serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import {
  readRecoveryEpochBaseline as readRecoveryEpochBaselineSql,
  recordRecoveryEpoch as recordRecoveryEpochSql,
} from '../../dist/infrastructure/workplace/sqlite-recovery-epoch-ledger.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  countGateRejectedCandidateSets,
  createSqliteProductionCellProjectionPersistence,
} from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sha = sha256Hex;
const PROVIDER = 'test.production-contract';
const PROVIDER_DIGEST = sha('provider');
// S4 — a second final-gate check whose deterministic failure targets the
// REVIEWER (reviewer-output validity): lets one final gate route round-1
// rejections to the author and round-2 rejections to the reviewer.
const REVIEW_PROVIDER = 'test.reviewer-output';
const REVIEW_PROVIDER_DIGEST = sha('review-provider');

function overlapDiagnostic(left, right) {
  return encodeCheckDiagnostic({
    code: 'implementation-scope-overlap',
    message: `implementation items '${left}' and '${right}' overlap without a dependency order`,
  });
}

function verdictDiagnostic() {
  return encodeCheckDiagnostic({
    code: 'review-verdict-invalid',
    message: 'reviewer verdict payload failed its frozen contract decoder',
  });
}

function checkPlan(id, phase, entries) {
  const planEntries = entries ?? [{
    check: { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST },
    parameters: {},
    environmentRef: null,
  }];
  const base = {
    checkPlanId: id,
    version: '1.0.0',
    entries: planEntries,
    decisionPolicyRef: `test.${phase}.decision`,
    decisionPolicyDigest: sha(`${phase}.decision`),
    unknownErrorPolicy: 'fail-closed',
  };
  return { ...base, checkPlanDigest: sha(base) };
}

function cell({ review = true, reviewerTargetedFinalGate = false } = {}) {
  return {
    id: 'singleton-cell',
    inputSelectors: ['source'],
    materialization: { completionPolicy: 'all' },
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
      finalGate: {
        gateId: 'final-gate',
        gatePhase: 'final',
        checkPlan: reviewerTargetedFinalGate
          ? checkPlan('final-plan', 'final', [
            // Round router: entry 1 failures repair the AUTHOR (defect in the
            // product), entry 2 failures repair the REVIEWER (defective
            // verdict) — one plan, two lawful repair targets.
            {
              check: { providerId: PROVIDER, version: '1.0.0', providerDigest: PROVIDER_DIGEST },
              parameters: {},
              environmentRef: null,
              repairTargetRoleOnFailure: 'author',
            },
            {
              check: { providerId: REVIEW_PROVIDER, version: '1.0.0', providerDigest: REVIEW_PROVIDER_DIGEST },
              parameters: {},
              environmentRef: null,
              repairTargetRoleOnFailure: 'reviewer',
            },
          ])
          : checkPlan('final-plan', 'final'),
      },
    } : undefined,
    recovery: { maxAttempts: 2, onExhausted: 'requeue' },
    transitions: { accepted: 'next', humanRequired: 'blocked', failed: 'failed' },
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
        { id: 'author-profile', workIntentKind: 'test.author', taskKind: 'test.author', executionSkill: 'author-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
        { id: 'reviewer-profile', workIntentKind: 'test.review', taskKind: 'test.review', executionSkill: 'review-skill', executionMode: 'tracker_only', allowedTools: ['Read'], retryPolicy: { maxAttempts: 2 } },
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
 * The integration harness: REAL persistence for the whole task-binding and
 * budget-accounting surface. `ensureExecutionPlan`, `bindProjectedTaskProcess
 * Context`, `readTaskProjectRepositoryId` and the K7 `readProjectedRoleTask`
 * come from the REAL projection persistence factory; `activateRoleTask` is
 * the REAL kanban projection; `readExecutionReceipt` and `concludeExecution
 * Intent` are the REAL production SQL (backed by real worker_executions +
 * factory_work_intents rows); `countTerminalExecutionsForTask` and
 * `countGateRejectedCandidateSets` are the REAL production counters.
 */
function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (name) VALUES ('task-shadow-integration')`).run();
  db.prepare(`INSERT INTO epics (project_id, name) VALUES (1, 'task-shadow-epic')`).run();

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
      obligationLedger.lease(obligation.obligationKey, 'task-shadow-integration-test', fence);
      obligation = durableIntegrator[method](input);
    }
    return obligation;
  };
  const obligationIntegrator = {
    onCandidateSetSealed: eagerLease('onCandidateSetSealed'),
    onGateAccepted: eagerLease('onGateAccepted'),
    onEffectsSettled: eagerLease('onEffectsSettled'),
    onProcessSettled: eagerLease('onProcessSettled'),
  };

  const projectionPersistence = createSqliteProductionCellProjectionPersistence(db);
  let checkOutcome = { outcome: 'passed', evidenceRefs: [] };
  let reviewCheckOutcome = { outcome: 'passed', evidenceRefs: [] };
  const persistence = {
    // REAL projection persistence: the same factory the composition root
    // spreads into the executor (ensureExecutionPlan, bindProjectedTask
    // ProcessContext, readTaskProjectRepositoryId, readProjectedRoleTask).
    ...projectionPersistence,
    // Plumbing (not the seam under test): the process input hash comes from
    // factory_process_runs, a db.ts runtime migration that a bare SCHEMA_SQL
    // database does not carry — same convention as the sibling harnesses.
    readProcessInputHash() { return sha('factory-order'); },
    activateRoleTask: ({ taskId, intentId, workplaceRef: ref, role, executionProfileId }) => {
      activateProductionCellRoleTask(db, {
        taskId,
        intentId,
        workplaceRef: serializeWorkplaceRef(ref),
        role,
        executionProfileId,
      });
    },
    concludeExecutionIntent: executionRef => {
      db.prepare(
        `UPDATE factory_work_intents
            SET status='concluded', updated_at=datetime('now')
          WHERE projected_task_id=(
            SELECT task_id FROM worker_executions WHERE execution_id=?
          ) AND status IN ('open','executing','paused')`,
      ).run(executionRef);
    },
    readExecutionReceipt: executionRef => {
      const row = db.prepare(
        `SELECT we.task_id AS taskId, wi.id AS intentId
           FROM worker_executions we
           JOIN factory_work_intents wi ON wi.projected_task_id=we.task_id
          WHERE we.execution_id=?`,
      ).get(executionRef);
      return row ?? null;
    },
    projectWorkplace() {},
  };
  persistence.countGateRejectedCandidateSets = (ref, role) =>
    countGateRejectedCandidateSets(db, serializeWorkplaceRef(ref), role);
  persistence.countTerminalExecutionsForTask = taskId =>
    countTerminalExecutionsForTask(db, taskId);
  // REAL epoch table wiring — TASK-SHADOW F4: through the PRODUCTION helpers
  // (infrastructure/workplace/sqlite-recovery-epoch-ledger.ts), the same
  // code the composition root closures call; no duplicated inline SQL.
  persistence.readRecoveryEpochBaseline = (ref, role) =>
    readRecoveryEpochBaselineSql(db, serializeWorkplaceRef(ref), role);
  persistence.recordRecoveryEpoch = input =>
    recordRecoveryEpochSql(db, {
      workplaceRef: serializeWorkplaceRef(input.workplaceRef),
      role: input.role,
      epoch: input.epoch,
      baselineRejectedSets: input.baselineRejectedSets,
      baselineTerminalExecutions: input.baselineTerminalExecutions,
      baselineEffectRepairs: input.baselineEffectRepairs,
      exhaustedAttempts: input.exhaustedAttempts,
      maxAttempts: input.maxAttempts,
      totalAttemptsCap: input.totalAttemptsCap,
      lastDiagnosis: input.lastDiagnosis,
    });

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
        : providerId === REVIEW_PROVIDER
          ? {
            providerId: REVIEW_PROVIDER, version: '1.0.0', providerDigest: REVIEW_PROVIDER_DIGEST,
            run: () => reviewCheckOutcome,
          }
          : null),
    },
    resolveInstallationDigest: () => sha('installation'),
    now: () => new Date(),
  });
  const setCheckOutcome = (outcome, evidenceRefs = [], providerId = PROVIDER) => {
    if (providerId === REVIEW_PROVIDER) reviewCheckOutcome = { outcome, evidenceRefs };
    else checkOutcome = { outcome, evidenceRefs };
  };
  const roleTaskRows = () => db.prepare(
    "SELECT id, workplace_ref, json_extract(metadata, '$.role') AS role, status FROM tasks "
      + 'WHERE workplace_ref=? ORDER BY id',
  ).all(serializeWorkplaceRef(workplaceRef()));
  return {
    db, workplaceRepo, coordinator, candidateSetRepo, executor, products, persistence,
    projectionPersistence, setCheckOutcome, roleTaskRows,
  };
}

/** Present a role's work: real lease transitions + a real worker_executions
 *  row for the presenter (the receipt the acceptance commit resolves). */
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
  h.db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        launcher,state,phase)
     VALUES (?,?,?,?,?,?,?,'claude_cli','running',?)`,
  ).run(
    executionRef,
    `run:${executionRef}`,
    1,
    1,
    h.persistence.readProjectedRoleTask(ref, queued.nextRole).taskId,
    `worker:${executionRef}`,
    'task-shadow-integration-test',
    queued.nextRole === 'reviewer' ? 'reviewing' : 'executing',
  );
  h.products.set(executionRef, [product]);
  h.coordinator.sealCandidateSet(ref);
}

/** Real terminal (lost) worker executions on a task — the crash-accounting
 *  input the budget must count. */
function seedTerminalExecutions(h, taskId, count, prefix) {
  for (let index = 0; index < count; index += 1) {
    h.db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase)
       VALUES (?,?,?,?,?,?,?,'claude_cli','lost','executing')`,
    ).run(
      `execution:${prefix}-death-${index}`,
      `run:${prefix}-death-${index}`,
      1,
      1,
      taskId,
      `worker:${prefix}-death-${index}`,
      'task-shadow-integration-test',
    );
  }
}

/** Terminalize a presenter execution after its gate settled — the production
 *  supervisor's fact (an OS exit is recorded on the execution row). Keeps the
 *  one-ACTIVE-execution-per-task partial unique index satisfiable across
 *  multi-round hires; 'exited' is NOT a crash state, so it never pollutes
 *  countTerminalExecutionsForTask (lost/terminated/spawn_failed only). */
function completeExecution(h, executionRef) {
  h.db.prepare(
    `UPDATE worker_executions
        SET state='exited', finished_at=datetime('now')
      WHERE execution_id=? AND state='running'`,
  ).run(executionRef);
}

function engineLogCapture() {
  const dir = mkdtempSync(join(tmpdir(), 'task-shadow-'));
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

// ---------------------------------------------------------------------------
// S1 — THE regression: neighbor (reviewer) task shadowing + budget accounting.
// ---------------------------------------------------------------------------
test('S1: author deaths count against the AUTHOR task despite the newer reviewer row — the budget engages', async () => {
  const h = harness();
  const definition = cell({ review: true });
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    // Round 1 — the author presents and the author gate ACCEPTS.
    await h.executor.execute(ctx); // hire the author: REAL task projection
    let rows = h.roleTaskRows();
    assert.equal(rows.length, 1, 'the singleton workplace projects exactly one author task');
    const authorTaskId = rows[0].id;
    assert.equal(rows[0].role, 'author');

    finishRole(h, ref, 'execution:author-1', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-1', digest: sha('author-1'),
    });
    h.setCheckOutcome('passed');
    await h.executor.execute(ctx); // author gate accepted → reviewer desk

    // THE MULTI-TASK SINGLETON: the reviewer task row is NEWER than the
    // author's. From this moment on, every newest-wins read of this
    // workplace resolves the REVIEWER card.
    rows = h.roleTaskRows();
    assert.equal(rows.length, 2, 'author + reviewer task rows coexist on the singleton desk');
    const reviewerTaskId = rows[1].id;
    assert.equal(rows[1].role, 'reviewer');
    assert.ok(reviewerTaskId > authorTaskId, 'the reviewer row is the NEWEST (the shadow)');
    assert.equal(h.coordinator.readState(ref).nextRole, 'reviewer');

    // ADR-053 C5-02 — the accepted-authority head bound the AUTHOR task
    // identity (the exact-key read in action at acceptance time).
    assert.equal(
      new SqliteAcceptedAuthorityHeadRepository(h.db).readAuthorTaskId(serialized),
      String(authorTaskId),
      'the authority head records the exact author task, never the newest row',
    );

    // Round 1 review — the final gate REJECTS with the author as repair
    // target: the workplace returns to the author in repair_wait.
    finishRole(h, ref, 'execution:reviewer-1', {
      schemaId: 'factory.test-review-verdict.v1', ref: 'product:review-1', digest: sha('review-1'),
    });
    h.setCheckOutcome('failed', [overlapDiagnostic('auth', 'billing')]);
    await h.executor.execute(ctx);
    const rejected = h.coordinator.readState(ref);
    assert.equal(rejected.loopState, 'repair_wait');
    assert.equal(rejected.nextRole, 'author');

    // THE AUTHOR DIES twice on the author task (crash accounting input).
    seedTerminalExecutions(h, authorTaskId, 2, 'author');

    // SHADOW REPRO (read-level): the retired newest-wins SQL — the exact
    // production selector this fix removed — picks the REVIEWER row, whose
    // terminal-execution count is ZERO. Under the retired port the budget
    // input was therefore max(rejectedSets=1, terminalExecutions=0) = 1 <
    // maxAttempts=2: NO exhaustion, NO rollover — the Elite-8 signature.
    const newestRow = h.db.prepare(
      'SELECT id AS taskId FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
    ).get(serialized);
    assert.equal(newestRow.taskId, reviewerTaskId,
      'the retired newest-wins selector resolves the reviewer (neighbor) row');
    assert.equal(
      h.persistence.countTerminalExecutionsForTask(newestRow.taskId),
      0,
      'the shadow row carries ZERO terminal executions — under the retired port the author deaths were invisible',
    );

    // FIXED (integration-level): the budget pass counts the author task's
    // real deaths through the exact role-key binding and ENGAGES — the
    // ADR-075 rollover row exists and baselines the deaths it counted.
    await h.executor.execute(ctx); // THE budget decision
    const state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait',
      'the crash+rejection exhausted budget parks the line in the rollover backoff window');
    const epochRow = h.db.prepare(
      'SELECT epoch, baseline_rejected_sets, baseline_terminal_executions, exhausted_attempts '
        + 'FROM factory_workplace_recovery_epochs WHERE workplace_ref=? AND role=? '
        + 'ORDER BY epoch DESC LIMIT 1',
    ).get(serialized, 'author');
    assert.ok(epochRow, 'the rollover row EXISTS (Elite-8 counterfactual: the table stayed empty)');
    assert.equal(epochRow.epoch, 1);
    assert.equal(epochRow.baseline_terminal_executions, 2,
      'the rollover baselined BOTH author-task deaths — the exact-key binding counted them');
    assert.equal(epochRow.baseline_rejected_sets, 1);
    assert.equal(epochRow.exhausted_attempts, 2);
    assert.match(log.read(), /ROLLOVER/, 'the ADR-075 rollover log line fired');
  } finally {
    log.restore();
    h.db.close();
  }
});

// ---------------------------------------------------------------------------
// S2 — NEGATIVE: ambiguity fails closed (broken idempotence fence).
// ---------------------------------------------------------------------------
test('S2 NEGATIVE: a duplicate role-task row fails closed through the budget path — no newest-wins tiebreak', async () => {
  const h = harness();
  const definition = cell({ review: false });
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  try {
    await h.executor.execute(ctx); // hire the author (real projection)
    finishRole(h, ref, 'execution:author-dup', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-dup', digest: sha('author-dup'),
    });
    h.setCheckOutcome('failed', [overlapDiagnostic('auth', 'billing')]);
    await h.executor.execute(ctx); // author gate (final) rejects → repair_wait
    assert.equal(h.coordinator.readState(ref).loopState, 'repair_wait');

    // Simulate a BROKEN idempotence fence: a second author-role row on the
    // same workplace. The reader must THROW, never silently pick.
    h.db.prepare(
      `INSERT INTO tasks
         (epic_id,title,description,status,priority,task_kind,workflow_stage,
          execution_mode,tags,metadata,workplace_ref)
       VALUES (1,'broken fence duplicate','duplicate','todo','high','test.author',
               'test','tracker_only','[]',?,?)`,
    ).run(JSON.stringify({ role: 'author' }), serialized);

    // Read-level fail-closed (K7 fence).
    assert.throws(
      () => h.persistence.readProjectedRoleTask(ref, 'author'),
      /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/,
    );
    // Executor-level fail-closed: the budget path propagates the fence
    // instead of quietly counting the executions of one arbitrary row.
    await assert.rejects(
      () => h.executor.execute(ctx),
      /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/,
    );
  } finally {
    h.db.close();
  }
});

// ---------------------------------------------------------------------------
// S3 — NEGATIVE: a missing binding is exact null, never a recency fallback.
// ---------------------------------------------------------------------------
test('S3 NEGATIVE: no author-role row resolves null — never the reviewer/neighbor row, never a newest row', async () => {
  const h = harness();
  const definition = cell({ review: true });
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  try {
    // A reviewer-ONLY desk: no author row was ever projected.
    h.workplaceRepo.materialize({
      processRunId: ref.processRunId,
      moduleRef: ref.moduleRef,
      productionCellId: ref.productionCellId,
      workKey: ref.workKey,
    });
    h.db.prepare(
      `INSERT INTO tasks
         (epic_id,title,description,status,priority,task_kind,workflow_stage,
          execution_mode,tags,metadata,workplace_ref)
       VALUES (1,'reviewer only','reviewer only','review','high','test.review',
               'test','tracker_only','[]',?,?)`,
    ).run(JSON.stringify({ role: 'reviewer' }), serialized);
    const newestRow = h.db.prepare(
      'SELECT id AS taskId FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
    ).get(serialized);
    assert.ok(newestRow, 'a newest row exists — the recency temptation is real');

    // The exact-key read returns NULL for the author role: absence is the
    // answer, not the neighbor's card. (Under the retired newest-wins port
    // this exact shape bound the author budget to the reviewer task.)
    assert.equal(h.persistence.readProjectedRoleTask(ref, 'author'), null);
    assert.equal(h.persistence.readProjectedRoleTask(ref, 'reviewer').taskId, newestRow.taskId);

    // And a workplace with NO task rows at all: null for both roles — the
    // budget falls back to CandidateSet-only accounting, never a foreign row.
    const emptyRef = {
      processRunId: 7, moduleRef: 'test-module@1.0.0',
      productionCellId: 'singleton-cell', workKey: 'empty-desk',
    };
    h.workplaceRepo.materialize({
      processRunId: emptyRef.processRunId,
      moduleRef: emptyRef.moduleRef,
      productionCellId: emptyRef.productionCellId,
      workKey: emptyRef.workKey,
    });
    assert.equal(h.persistence.readProjectedRoleTask(emptyRef, 'author'), null);
    assert.equal(h.persistence.readProjectedRoleTask(emptyRef, 'reviewer'), null);
    void ctx;
  } finally {
    h.db.close();
  }
});

// ---------------------------------------------------------------------------
// S4 — TASK-SHADOW F1 (Red-Team HIGH): a LEGAL second review round.
//
// Reviewer generations are minted per accepted author set, so the production
// path legitimately reaches: author + reviewer#1(done) + reviewer#2(active).
// The retired role-only uniqueness claim threw
// PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE from
// readProjectedRoleTask(workplace,'reviewer') INSIDE the budget pass — a
// legal state killed the line. The exact generation key is the CURRENT
// subject_candidate_set_ref (the accepted-author authority head).
//
// Drive: two review generations via author repair, then reviewer-side
// deaths + reviewer-targeted repair_wait. No throw; the CURRENT reviewer
// generation's deaths count; the superseded generation is ignored; a
// duplicate CURRENT subject row still throws.
// ---------------------------------------------------------------------------
test('S4: two legal reviewer generations — budget resolves the exact current generation, no throw, superseded ignored', async () => {
  const h = harness();
  const definition = cell({ review: true, reviewerTargetedFinalGate: true });
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  const log = engineLogCapture();
  try {
    // ---- Round 1: author A1 accepted → reviewer generation #1 (subject A1).
    await h.executor.execute(ctx); // hire the author (real projection)
    finishRole(h, ref, 'execution:author-r1', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-r1', digest: sha('author-r1'),
    });
    h.setCheckOutcome('passed');
    await h.executor.execute(ctx); // author gate accepts → reviewer#1 desk
    completeExecution(h, 'execution:author-r1');
    let rows = h.roleTaskRows();
    assert.equal(rows.length, 2, 'author + reviewer#1 after the first review round');
    const reviewer1TaskId = rows[1].id;

    // Round 1 verdict: final gate entry 1 (author-targeted) FAILS → the
    // author must repair; entry 2 (reviewer-output) passes.
    finishRole(h, ref, 'execution:reviewer-r1', {
      schemaId: 'factory.test-review-verdict.v1', ref: 'product:review-r1', digest: sha('review-r1'),
    });
    h.setCheckOutcome('failed', [overlapDiagnostic('auth', 'billing')]);
    h.setCheckOutcome('passed', [], REVIEW_PROVIDER);
    await h.executor.execute(ctx);
    completeExecution(h, 'execution:reviewer-r1');
    let state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait');
    assert.equal(state.nextRole, 'author');

    // Author budget: 1 rejection < 2 → requeue + rehire (same execute pass).
    await h.executor.execute(ctx);
    state = h.coordinator.readState(ref);
    assert.equal(state.nextRole, 'author');

    // ---- Round 2: author repair A2 accepted → head moves → reviewer
    // generation #2 (subject A2). THE LEGAL F1 STATE: 3 task rows.
    finishRole(h, ref, 'execution:author-r2', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-r2', digest: sha('author-r2'),
    });
    h.setCheckOutcome('passed');
    await h.executor.execute(ctx); // author gate accepts → reviewer#2 minted
    completeExecution(h, 'execution:author-r2');
    rows = h.roleTaskRows();
    assert.equal(rows.length, 3,
      'author + reviewer#1(done) + reviewer#2(active) — the legal second review round');
    const reviewerRows = rows.filter(row => row.role === 'reviewer');
    assert.equal(reviewerRows.length, 2, 'role ALONE is genuinely ambiguous now (F1)');
    state = h.coordinator.readState(ref);
    assert.equal(state.nextRole, 'reviewer');

    // The exact-generation read resolves the CURRENT reviewer task through
    // the accepted-author authority head — no throw, no newest inference.
    const reviewer2TaskId = h.persistence.readProjectedRoleTask(ref, 'reviewer').taskId;
    assert.notEqual(reviewer2TaskId, reviewer1TaskId,
      'the head-bound CURRENT generation is resolved');
    // Explicit superseded subject → the OLD generation (probing history is
    // legal; it is just not what the budget binds to).
    const reviewer1Subject = h.db.prepare(
      "SELECT json_extract(metadata, '$.subject_candidate_set_ref') AS subject FROM tasks WHERE id=?",
    ).get(reviewer1TaskId).subject;
    assert.ok(reviewer1Subject, 'the superseded generation carries its subject binding');
    assert.equal(
      h.persistence.readProjectedRoleTask(ref, 'reviewer', reviewer1Subject)?.taskId,
      reviewer1TaskId,
      'an explicit superseded subject resolves the superseded generation',
    );
    // Absent subject → exact null, never a newest-row fallback.
    assert.equal(h.persistence.readProjectedRoleTask(ref, 'reviewer', 'candidate-set:never-sealed'), null);

    // ---- Reviewer-side crash accounting on the CURRENT generation only.
    seedTerminalExecutions(h, reviewer2TaskId, 2, 'reviewer-current');
    seedTerminalExecutions(h, reviewer1TaskId, 1, 'reviewer-superseded');

    // Round 2 verdict: final gate entry 2 (reviewer-targeted) FAILS →
    // reviewer-side repair_wait.
    finishRole(h, ref, 'execution:reviewer-r2', {
      schemaId: 'factory.test-review-verdict.v1', ref: 'product:review-r2', digest: sha('review-r2'),
    });
    h.setCheckOutcome('passed');
    h.setCheckOutcome('failed', [verdictDiagnostic()], REVIEW_PROVIDER);
    await h.executor.execute(ctx);
    state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait');
    assert.equal(state.nextRole, 'reviewer',
      'the reviewer itself is the repair target (invalid verdict)');

    // ---- THE BUDGET PASS: no throw (the F1 counterfactual threw here), the
    // CURRENT generation's 2 deaths engage the budget, the superseded
    // generation's 1 death is IGNORED.
    await h.executor.execute(ctx);
    const epochRow = h.db.prepare(
      'SELECT epoch, baseline_rejected_sets, baseline_terminal_executions, exhausted_attempts '
        + 'FROM factory_workplace_recovery_epochs WHERE workplace_ref=? AND role=? '
        + 'ORDER BY epoch DESC LIMIT 1',
    ).get(serialized, 'reviewer');
    assert.ok(epochRow, 'the reviewer-role rollover row EXISTS (budget engaged)');
    assert.equal(epochRow.epoch, 1);
    assert.equal(epochRow.baseline_terminal_executions, 2,
      'EXACTLY the CURRENT generation\'s 2 deaths — the superseded death (1) is ignored');
    assert.equal(epochRow.baseline_rejected_sets, 1);
    assert.equal(epochRow.exhausted_attempts, 2);
    assert.match(log.read(), /ROLLOVER cell=singleton-cell/, 'the ADR-075 rollover log fired');
    state = h.coordinator.readState(ref);
    assert.equal(state.loopState, 'repair_wait',
      'the rollover backoff window holds the reviewer line in repair_wait');
  } finally {
    log.restore();
    h.db.close();
  }
});

// S4 NEGATIVE — a duplicate of the EXACT CURRENT generation (broken
// idempotence fence) still throws; superseded generations never masked it.
test('S4 NEGATIVE: duplicate CURRENT subject reviewer row fails closed — superseded generations do not dilute the fence', async () => {
  const h = harness();
  const definition = cell({ review: true, reviewerTargetedFinalGate: true });
  const ctx = context(definition);
  const ref = workplaceRef();
  const serialized = serializeWorkplaceRef(ref);
  try {
    // Compress the drive: reach the two-generation state as in S4.
    await h.executor.execute(ctx);
    finishRole(h, ref, 'execution:author-n1', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-n1', digest: sha('author-n1'),
    });
    h.setCheckOutcome('passed');
    await h.executor.execute(ctx);
    completeExecution(h, 'execution:author-n1');
    finishRole(h, ref, 'execution:reviewer-n1', {
      schemaId: 'factory.test-review-verdict.v1', ref: 'product:review-n1', digest: sha('review-n1'),
    });
    h.setCheckOutcome('failed', [overlapDiagnostic('auth', 'billing')]);
    h.setCheckOutcome('passed', [], REVIEW_PROVIDER);
    await h.executor.execute(ctx);
    completeExecution(h, 'execution:reviewer-n1');
    await h.executor.execute(ctx);
    finishRole(h, ref, 'execution:author-n2', {
      schemaId: 'factory.test-product.v1', ref: 'product:author-n2', digest: sha('author-n2'),
    });
    h.setCheckOutcome('passed');
    await h.executor.execute(ctx);
    completeExecution(h, 'execution:author-n2');
    const rows = h.roleTaskRows();
    assert.equal(rows.length, 3, 'two reviewer generations exist (legal)');

    // Read-level: the exact CURRENT generation is still unique → no throw.
    const current = h.persistence.readProjectedRoleTask(ref, 'reviewer');
    assert.ok(current, 'the exact current generation resolves');

    // Break the fence ONLY for the CURRENT subject: a second row with the
    // same (workplace, reviewer, subject) key.
    const currentSubject = h.db.prepare(
      'SELECT json_extract(metadata, \'$.subject_candidate_set_ref\') AS subject FROM tasks WHERE id=?',
    ).get(current.taskId).subject;
    h.db.prepare(
      `INSERT INTO tasks
         (epic_id,title,description,status,priority,task_kind,workflow_stage,
          execution_mode,tags,metadata,workplace_ref)
       VALUES (1,'broken fence duplicate','duplicate','todo','high','test.review',
               'test','tracker_only','[]',?,?)`,
    ).run(
      JSON.stringify({ role: 'reviewer', subject_candidate_set_ref: currentSubject }),
      serialized,
    );

    // The exact-generation read throws; the two SUPERSEDED rows are not the
    // trigger (they were legal in S4).
    assert.throws(
      () => h.persistence.readProjectedRoleTask(ref, 'reviewer'),
      /PRODUCTION_CELL_ROLE_TASK_PROJECTION_NOT_UNIQUE/,
    );
    void ctx;
  } finally {
    h.db.close();
  }
});
