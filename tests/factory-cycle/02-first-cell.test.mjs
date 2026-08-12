/**
 * Factory-cycle suite — Layer 1, test 2: ПЕРВЫЙ ЦЕХ (Production Cell).
 *
 * Цель: доказать, что один цех проходит полный цикл приёмки на реальной
 * SQLite-схеме через чистый ProductionCellCoordinator + репозитории + gate
 * driver. Без спавна воркера, без lifecycle — это «цех от материала до актa
 * приёмки ОТК».
 *
 * Цикл (Conveyor Mental Model §4):
 *   todo/idle
 *     → work-admitted         → in_progress/queued, author
 *     → worker-leased         → leased (+activeReservationRef)
 *     → worker-started        → running
 *     → candidate-sealed      → verifying (запечатан CandidateSet)
 *     → gate accepted (final) → done/terminal(accepted)   ← ПРИЁМКА
 *
 * Дополнительно проверяем инварианты приёмки (что делает её «честной»):
 *   - CAS на revision: переход со старой ревизией → applied=false.
 *   - CandidateSet seal-key идемпотентен: повтор с тем же digest → replayed=true.
 *   - CandidateSet с ДРУГИМ digest под тем же key → CANDIDATE_SET_REPLAY_MISMATCH.
 *   - GateDecision append-only: строку нельзя UPDATE/DELETE (триггеры в схеме).
 *   - Two-channel: crash (worker-crashed) меняет ТОЛЬКО loop, Kanban не откатывается.
 *   - Repair-цикл: gate repair_required → repair_wait → requeue → снова queued.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { assembleRevision, buildContribution } from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import {
  createStandardCheckProviderRegistry,
  buildProductContractCheckPlan,
} from '../../dist/process-modules/application/standard-check-providers.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Fixture: один материал-известный цех с product-contract gate.
// ---------------------------------------------------------------------------

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const coordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo: new SqliteAcceptedAuthorityHeadRepository(db),
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  const checkProviders = createStandardCheckProviderRegistry();

  const ref = asWorkplaceRef({
    processRunId: 1,
    moduleRef: 'product-discovery@3.0.2',
    productionCellId: 'produce-proposal',
    workKey: 'default',
  });
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  activeRevisionRepo = revisionRepo;
  return { db, workplaceRepo, candidateSetRepo, revisionRepo, gateRepo, coordinator, checkProviders, ref };
}

const SCHEMA = 'factory.discovery-proposal.v1';
const EXECUTION_REF = 'worker-execution:test-1';
// ADR-053 B-1 — registered by setup() so sealAuthor can append + seal atomically.
let activeRevisionRepo = null;

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Запечатать products как author CandidateSet. */
function sealAuthor(candidateSetRepo, ref, products) {
  const digest = sha({ ref: serializeWorkplaceRef(ref), exec: EXECUTION_REF, products });
  const members = products.map(p => ({
    productRef: p,
    origin: 'produced',
    sourceCandidateSetRef: null,
  }));
  // ADR-053 B-1 — build + persist the production revision and seal the
  // CandidateSet in ONE transaction; the set can never reference an absent
  // revision. (activeRevisionRepo is registered by setup().)
  const workplaceSerialized = serializeWorkplaceRef(ref);
  const contribution = buildContribution({
    workplaceRef: workplaceSerialized,
    contributorExecutionRef: EXECUTION_REF,
    sourceAdapter: 'typed-submission',
    operations: products.map(p => ({
      op: 'put',
      memberKey: `product/${p.schemaId}/${p.ref}`,
      productRef: p.ref,
      contentDigest: p.digest,
      sourceAdapter: 'typed-submission',
    })),
    parentContributionRef: null,
  });
  const revision = assembleRevision({
    workplaceRef: workplaceSerialized,
    parent: null,
    contributions: [contribution],
    presenterRef: EXECUTION_REF,
  });
  return activeRevisionRepo.transaction(() => {
    activeRevisionRepo.appendRevision(revision);
    return candidateSetRepo.seal({
      workplaceRef: ref,
      producerExecutionRef: EXECUTION_REF,
      productionRevisionRef: revision.revisionRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members,
      sealReceiptRef: `seal:${EXECUTION_REF}:author`,
      candidateSetDigest: digest,
      sealedAt: '2026-01-01T00:00:00.000Z',
    }).set;
  });
}

// ---------------------------------------------------------------------------
// 1. Happy-path: материал → терминал(accepted). Полный цикл цеха.
// ---------------------------------------------------------------------------

test('цех: полный цикл todo/idle → done/terminal(accepted)', () => {
  const { coordinator, ref, workplaceRepo, candidateSetRepo, gateRepo, checkProviders } = setup();

  // Materialize → todo/idle.
  coordinator.materializeCell({
    processRunId: 1, moduleRef: 'product-discovery@3.0.2',
    productionCellId: 'produce-proposal', workKey: 'default',
  });
  let s = workplaceRepo.read(ref);
  assert.equal(s.kanbanPhase, 'todo');
  assert.equal(s.loopState, 'idle');
  assert.equal(s.revision, 0);

  // admit → in_progress/queued, author.
  coordinator.admitWork(ref);
  s = workplaceRepo.read(ref);
  assert.equal(s.kanbanPhase, 'in_progress');
  assert.equal(s.loopState, 'queued');
  assert.equal(s.nextRole, 'author');

  // lease + start (диспетчер нанял рабочего) → leased → running.
  // Реально эту работу делает dispatcher через ConveyorRuntime.reserveWorkplace,
  // но coordinator не предоставляет отдельных шагов — используем repo напрямую
  // с теми же event'ами, что использует ConveyorRuntime.
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'leased', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: workplaceRepo.read(ref).revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  s = workplaceRepo.read(ref);
  assert.equal(s.loopState, 'running');
  assert.equal(workplaceRepo.readActiveActors(ref).activeReservationRef, EXECUTION_REF);

  // Worker сдал products → seal CandidateSet → verifying.
  const products = [{
    schemaId: SCHEMA, ref: 'proposal:1', digest: sha256Hex({ outcome: 'go' }),
  }];
  coordinator.sealCandidateSet(ref);
  s = workplaceRepo.read(ref);
  assert.equal(s.loopState, 'verifying', 'sealCandidateSet должен перевести в verifying');

  // ОТК: gate run → accepted.
  const candidate = sealAuthor(candidateSetRepo, ref, products);
  const checkPlan = buildProductContractCheckPlan('discovery.author-gate');
  const { decision } = driveGateRun(gateRepo, checkProviders, {
    workplaceRef: ref,
    subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [],
    checkPlan,
    gatePhase: 'author',
    expectedWorkplaceRevision: s.revision,
    gateLeaseRef: `gate-lease:${candidate.candidateSetRef}`,
    installationDigest: 'pkg-digest-test',
    checkParameters: { processRunId: 1, moduleRef: 'product-discovery@3.0.2' },
    environmentRef: null,
  });
  assert.equal(decision.verdict, 'accepted');

  // Apply → terminal(accepted). ЭТО ПРИЁМКА.
  coordinator.applyGateDecision(ref, { verdict: 'accepted', isFinal: true });
  s = workplaceRepo.read(ref);
  assert.equal(s.loopState, 'terminal');
  assert.equal(s.terminalReason, 'accepted');
  assert.equal(s.kanbanPhase, 'done');
});

// ---------------------------------------------------------------------------
// 2. CAS-инвариант: переход со старой ревизией не применяется.
// ---------------------------------------------------------------------------

test('цех: CAS на revision — переход со старой ревизией отклонён', () => {
  const { coordinator, ref, workplaceRepo } = setup();
  coordinator.materializeCell({
    processRunId: 1, moduleRef: 'product-discovery@3.0.2',
    productionCellId: 'produce-proposal', workKey: 'default',
  });
  coordinator.admitWork(ref);
  const after = workplaceRepo.read(ref);
  assert.equal(after.revision, 1);

  // Пытаемся применить transition со СТАРОЙ ревизией (0) — должен быть CAS miss.
  const result = workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: 0, // устарела
    kanbanPhase: 'in_progress', loopState: 'leased', nextRole: 'author',
    terminalReason: null,
  });
  assert.equal(result.applied, false, 'CAS miss должен дать applied=false');
  // Состояние не изменилось.
  assert.equal(workplaceRepo.read(ref).loopState, 'queued');
  assert.equal(workplaceRepo.read(ref).revision, 1);
});

// ---------------------------------------------------------------------------
// 3. CandidateSet seal-key идемпотентен.
// ---------------------------------------------------------------------------

test('цех: повторный seal с тем же digest → replayed=true (идемпотентность)', () => {
  const { ref, workplaceRepo, candidateSetRepo } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  const products = [{
    schemaId: SCHEMA, ref: 'proposal:2', digest: sha256Hex({ x: 1 }),
  }];
  const first = sealAuthor(candidateSetRepo, ref, products);
  const second = sealAuthor(candidateSetRepo, ref, products);
  assert.equal(second.candidateSetRef, first.candidateSetRef);
  // В БД осталась одна строка для этого seal-key.
  const rows = candidateSetRepo.listForWorkplace(ref).filter(s => s.role === 'author');
  assert.equal(rows.length, 1);
});

test('цех: seal с ДРУГИМ digest под тем же key → REPLAY_MISMATCH', () => {
  const { ref, workplaceRepo, candidateSetRepo } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  const products1 = [{
    schemaId: SCHEMA, ref: 'proposal:3', digest: sha256Hex({ x: 1 }),
  }];
  const first = sealAuthor(candidateSetRepo, ref, products1);

  // ADR-053: seal-key теперь (workplace + productionRevisionRef + role). Тот же
  // key (та же ревизия), но ДРУГОЙ digest → REPLAY_MISMATCH.
  assert.throws(
    () => candidateSetRepo.seal({
      workplaceRef: ref,
      producerExecutionRef: EXECUTION_REF,
      productionRevisionRef: first.productionRevisionRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members: products1.map(p => ({ productRef: p, origin: 'produced', sourceCandidateSetRef: null })),
      sealReceiptRef: `seal:${EXECUTION_REF}:author`,
      candidateSetDigest: sha({ other: 'digest' }),
      sealedAt: '2026-01-01T00:00:00.000Z',
    }),
    /CANDIDATE_SET_REPLAY_MISMATCH/,
  );
});

// ---------------------------------------------------------------------------
// 4. GateDecision append-only: UPDATE/DELETE блокируется триггером.
// ---------------------------------------------------------------------------

test('цех: GateDecision нельзя UPDATE (append-only, REG-18)', () => {
  const { db, ref, workplaceRepo, candidateSetRepo, gateRepo, checkProviders } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  // Загоняем в verifying, чтобы driveGateRun имел валидный revision для gate.
  const s = moveToVerifying({ workplaceRepo, candidateSetRepo, ref });

  const candidate = candidateSetRepo.listForWorkplace(ref)[0];
  const checkPlan = buildProductContractCheckPlan('discovery.author-gate');
  driveGateRun(gateRepo, checkProviders, {
    workplaceRef: ref, subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [], checkPlan, gatePhase: 'author',
    expectedWorkplaceRevision: s.revision, gateLeaseRef: 'gl',
    installationDigest: 'pkg', checkParameters: {}, environmentRef: null,
  });

  // UPDATE должен быть заблокирован триггером.
  assert.throws(
    () => db.prepare("UPDATE factory_gate_decisions SET verdict='failed' WHERE 1").run(),
    /v4 gate decisions are immutable/,
  );
  // DELETE тоже.
  assert.throws(
    () => db.prepare('DELETE FROM factory_gate_decisions WHERE 1').run(),
    /v4 gate decisions are immutable/,
  );
});

// ---------------------------------------------------------------------------
// 5. Two-channel: worker-crashed меняет ТОЛЬКО loop, Kanban остаётся.
// ---------------------------------------------------------------------------

test('цех: worker-crashed → repair_wait, Kanban НЕ откатывается (REG-28-AC-02)', () => {
  const { coordinator, ref, workplaceRepo } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  coordinator.admitWork(ref);
  // Загоняем в running.
  let s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'leased', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });

  // Crash.
  coordinator.recordWorkerCrash(ref);
  s = workplaceRepo.read(ref);
  assert.equal(s.loopState, 'repair_wait', 'loop → repair_wait');
  assert.equal(s.kanbanPhase, 'in_progress', 'Kanban остался in_progress, НЕ todo');
});

// ---------------------------------------------------------------------------
// 6. Repair-цикл: repair_required → repair_wait → requeue → queued.
// ---------------------------------------------------------------------------

test('цех: gate repair_required → repair_wait → requeue(author) → queued', () => {
  const { coordinator, ref, workplaceRepo, candidateSetRepo, gateRepo, checkProviders } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  coordinator.admitWork(ref);
  const s = moveToVerifying({ workplaceRepo, candidateSetRepo, ref });

  // Регистрируем check-provider, который всегда fail'ит.
  const failingProvider = {
    providerId: 'test.failing-check.v1',
    version: '1.0.0',
    run: () => 'failed',
  };
  checkProviders.register(failingProvider);
  const checkPlan = buildCheckPlanCustom('discovery.author-gate', [{
    providerId: 'test.failing-check.v1', version: '1.0.0',
    providerDigest: sha({ id: 'failing' }),
  }]);

  const candidate = candidateSetRepo.listForWorkplace(ref)[0];
  const { decision } = driveGateRun(gateRepo, checkProviders, {
    workplaceRef: ref, subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [], checkPlan, gatePhase: 'author',
    expectedWorkplaceRevision: s.revision, gateLeaseRef: 'gl-repair',
    installationDigest: 'pkg', checkParameters: {}, environmentRef: null,
  });
  assert.equal(decision.verdict, 'repair_required');

  coordinator.applyGateDecision(ref, {
    verdict: 'repair_required', isFinal: false, repairTargetRole: 'author',
  });
  let post = workplaceRepo.read(ref);
  assert.equal(post.loopState, 'repair_wait');
  assert.equal(post.nextRole, 'author');
  assert.equal(post.kanbanPhase, 'in_progress', 'Kanban не откатился');

  // Requeue — новый воркер придёт.
  coordinator.requeue(ref, 'author');
  post = workplaceRepo.read(ref);
  assert.equal(post.loopState, 'queued');
  assert.equal(post.kanbanPhase, 'in_progress');
});

// ---------------------------------------------------------------------------
// 7. GateDecision идемпотентна по decision_key.
// ---------------------------------------------------------------------------

test('цех: повторная запись той же GateDecision идемпотентна (decision_key UNIQUE)', () => {
  const { db, ref, workplaceRepo, candidateSetRepo, gateRepo, checkProviders } = setup();
  coordinatorMaterialize(workplaceRepo, ref);
  const s = moveToVerifying({ workplaceRepo, candidateSetRepo, ref });
  const candidate = candidateSetRepo.listForWorkplace(ref)[0];
  const checkPlan = buildProductContractCheckPlan('discovery.author-gate');
  const drive = () => driveGateRun(gateRepo, checkProviders, {
    workplaceRef: ref, subjectCandidateSetRef: candidate.candidateSetRef,
    assessmentCandidateSetRefs: [], checkPlan, gatePhase: 'author',
    expectedWorkplaceRevision: s.revision, gateLeaseRef: 'gl',
    installationDigest: 'pkg', checkParameters: {}, environmentRef: null,
  });
  const first = drive();
  const second = drive();
  assert.equal(second.decision.decisionKey, first.decision.decisionKey);
  assert.equal(second.decision.verdict, first.decision.verdict);
  // В БД осталась ровно одна decision для этого gate-run.
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE gate_run_ref=?',
  ).get(first.decision.gateRunRef);
  assert.equal(count.n, 1);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coordinatorMaterialize(workplaceRepo, ref) {
  // coordinator.materializeCell ходит через workplaceRepo.materialize; чтобы не
  // дублировать, зовём через репозиторий напрямую с тем же ref.
  workplaceRepo.materialize({
    processRunId: ref.processRunId,
    moduleRef: ref.moduleRef,
    productionCellId: ref.productionCellId,
    workKey: ref.workKey,
  });
}

function moveToVerifying({ workplaceRepo, candidateSetRepo, ref }) {
  // admit → leased → running → verifying + seal author set.
  let s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'queued', nextRole: 'author',
    terminalReason: null,
  });
  s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'leased', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  s = workplaceRepo.read(ref);
  workplaceRepo.applyTransition({
    workplaceRef: ref, expectedRevision: s.revision,
    kanbanPhase: 'in_progress', loopState: 'verifying', nextRole: 'author',
    terminalReason: null, activeReservationRef: EXECUTION_REF,
  });
  // Author CandidateSet нужен для gate subject.
  const products = [{
    schemaId: SCHEMA, ref: `proposal:${Math.random()}`, digest: sha256Hex({ v: Math.random() }),
  }];
  sealAuthor(candidateSetRepo, ref, products);
  return workplaceRepo.read(ref);
}

function buildCheckPlanCustom(checkPlanId, checks) {
  // Собираем CheckPlan вручную с ТОЛЬКО кастомными checks (без product-contract),
  // чтобы failing-check был единственным и решал вердикт.
  const entries = checks.map(c => ({
    check: {
      providerId: c.providerId, version: c.version, providerDigest: c.providerDigest,
    },
    parameters: c.parameters ?? {},
    environmentRef: null,
  }));
  return {
    checkPlanId,
    version: '1.0.0',
    checkPlanDigest: sha256Hex({ checkPlanId, version: '1.0.0', entries }),
    entries,
    decisionPolicyRef: 'factory.fail-closed.v1',
    decisionPolicyDigest: sha256Hex({ ref: 'factory.fail-closed.v1' }),
    unknownErrorPolicy: 'fail-closed',
  };
}
