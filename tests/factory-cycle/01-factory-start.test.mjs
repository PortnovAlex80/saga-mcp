/**
 * Factory-cycle suite — Layer 1, test 1: ЗАВОД-ЗАПУСК.
 *
 * Цель: доказать, что шов завод-запуска (factory launch) честно работает на
 * реальных репозиториях + реальной SQLite-схеме. До lifecycle, до цехов — это
 * «оператор нажал кнопку ПУСК».
 *
 * Что проверяем (каждый — отдельный invariant Conveyor Mental Model):
 *   1. Полный happy-path: request → claim → markRunning → finish(completed).
 *      Заказ доходит до state='completed', launch до 'completed'.
 *   2. Capability-token fencing: повторный finish с ДРУГИМ токеном →
 *      FACTORY_LAUNCH_FENCE_LOST. Знание project/epic намеренно недостаточном
 *      (Conveyor §22).
 *   3. Durable idempotency (Conveyor v4.3 §3, PART 8): тот же idempotency-key
 *      после того как launch терминализован → возвращает ТОТ же launch_ref.
 *      Source bytes НЕ идемпотентность.
 *   4. Один активный launch на заказ: конкурентный start с другим ключом →
 *      FACTORY_LAUNCH_ACTIVE_REQUEST_MISMATCH.
 *   5. Resume-mode требует lifecycle_run_id, совпадающий с заказом.
 *
 * Идемпотентность теста: чистая in-memory DB, полный пересозданием на каждом
 * кейсе. ~50 мс на весь файл.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  requestFactoryLaunch,
  claimFactoryLaunch,
  markFactoryLaunchRunning,
  finishFactoryLaunch,
} from '../../dist/infrastructure/factory/sqlite-factory-launch-repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedProjectEpic(db, projectId = 1, epicId = 1) {
  db.prepare(
    `INSERT INTO projects (id, name, status) VALUES (?, ?, 'active')`,
  ).run(projectId, `project-${projectId}`);
  db.prepare(
    `INSERT INTO epics (id, project_id, name, status) VALUES (?, ?, ?, 'planned')`,
  ).run(epicId, projectId, `epic-${epicId}`);
}

/** Заводской заказ (factory_orders) — min набор NOT NULL колонок. */
function seedOrder(db, orderRef, projectId, epicId, state = 'provisioned') {
  db.prepare(
    `INSERT INTO factory_orders
       (order_ref, project_id, epic_id, source_kind, state)
     VALUES (?, ?, ?, 'idea_url', ?)`,
  ).run(orderRef, projectId, epicId, state);
}

/** Вставить минимальную lifecycle_runs строку, чтобы FK на factory_orders прошёл. */
function seedLifecycleRun(db, runId, projectId = 1, epicId = 1, status = 'running') {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id, epic_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        status, entry_stage_id)
     VALUES (?, 'lf', '1', 'lf@1', 'd', '', '{}', 'h', ?, ?, 'op', 'ik',
             's', '{}', 'ih', ?, 'e')`,
  ).run(runId, projectId, epicId, status);
}

function readLaunch(db, launchRef) {
  return db.prepare(
    `SELECT state, claim_token, lifecycle_run_id, error
       FROM factory_launch_requests WHERE launch_ref=?`,
  ).get(launchRef);
}

function readOrder(db, orderRef) {
  return db.prepare(
    `SELECT state, lifecycle_run_id, last_error FROM factory_orders WHERE order_ref=?`,
  ).get(orderRef);
}

// ---------------------------------------------------------------------------
// 1. Happy path: request → claim → markRunning → finish(completed)
// ---------------------------------------------------------------------------

test('запуск: request → claim → running → completed проходит до терминала', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-1', 1, 1);

  const launchRef = requestFactoryLaunch({
    orderRef: 'order-1',
    mode: 'new',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'operator',
    idempotencyKey: 'key-start-1',
    concurrency: 2,
    lifecycleInput: { initiative: { subject: 'test' } },
    lifecycleInputSchema: 'factory.product-delivery-lifecycle.v1',
  }, db);
  assert.ok(launchRef.startsWith('launch-'), `launch_ref prefix: ${launchRef}`);
  assert.equal(readLaunch(db, launchRef).state, 'requested');

  const claimToken = 'tok-aaa';
  const ticket = claimFactoryLaunch(launchRef, claimToken, db);
  assert.equal(ticket.claimToken, claimToken);
  assert.equal(ticket.projectId, 1);
  assert.equal(ticket.epicId, 1);
  assert.equal(readLaunch(db, launchRef).state, 'claimed');

  seedLifecycleRun(db, 42);
  markFactoryLaunchRunning(launchRef, claimToken, 42, db);
  assert.equal(readLaunch(db, launchRef).state, 'running');
  assert.equal(readLaunch(db, launchRef).lifecycle_run_id, 42);
  assert.equal(readOrder(db, 'order-1').state, 'running');
  assert.equal(readOrder(db, 'order-1').lifecycle_run_id, 42);

  finishFactoryLaunch(launchRef, claimToken, 'completed', null, 'completed', db);
  assert.equal(readLaunch(db, launchRef).state, 'completed');
  assert.equal(readOrder(db, 'order-1').state, 'completed');

  db.close();
});

// ---------------------------------------------------------------------------
// 2. Capability-token fencing
// ---------------------------------------------------------------------------

test('запуск: finish с чужим claim-token отклонён (FACTORY_LAUNCH_FENCE_LOST)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-2', 1, 1);
  const ref = requestFactoryLaunch({
    orderRef: 'order-2', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-2', concurrency: 1,
  }, db);
  claimFactoryLaunch(ref, 'right-token', db);
  seedLifecycleRun(db, 7);
  markFactoryLaunchRunning(ref, 'right-token', 7, db);

  // Знание launch_ref намеренно НЕдостаточно — нужен capability.
  assert.throws(
    () => finishFactoryLaunch(ref, 'WRONG-token', 'completed', null, 'completed', db),
    /FACTORY_LAUNCH_FENCE_LOST/,
  );
  // launch остался running — чужак не испортил состояние.
  assert.equal(readLaunch(db, ref).state, 'running');
  db.close();
});

test('запуск: markFactoryLaunchRunning с чужим токеном отклонён', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-2b', 1, 1);
  const ref = requestFactoryLaunch({
    orderRef: 'order-2b', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-2b', concurrency: 1,
  }, db);
  claimFactoryLaunch(ref, 'right', db);
  assert.throws(
    () => markFactoryLaunchRunning(ref, 'wrong', 99, db),
    /FACTORY_LAUNCH_FENCE_LOST/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 3. Durable idempotency (Conveyor v4.3 §3, PART 8)
// ---------------------------------------------------------------------------

test('запуск: тот же idempotency-key после терминала возвращает тот же launch_ref', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-3', 1, 1);
  const key = 'durable-key-3';

  const ref1 = requestFactoryLaunch({
    orderRef: 'order-3', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
  }, db);
  const tok = 'tok-3';
  claimFactoryLaunch(ref1, tok, db);
  seedLifecycleRun(db, 100);
  markFactoryLaunchRunning(ref1, tok, 100, db);
  finishFactoryLaunch(ref1, tok, 'completed', null, 'completed', db);

  // Retry той же команды после completed — должен вернуть ТОТ же launch_ref,
  // НЕ создать новый. Durable, не только для активных состояний.
  const ref1b = requestFactoryLaunch({
    orderRef: 'order-3', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
  }, db);
  assert.equal(ref1b, ref1, 'durable idempotency preserves launch_ref');
  // Только одна строка launch для этого ключа.
  const rows = db.prepare(
    'SELECT launch_ref FROM factory_launch_requests WHERE idempotency_key=?',
  ).all(key);
  assert.equal(rows.length, 1);
  db.close();
});

test('запуск: тот же ключ с другим order_ref отклонён (IDEMPOTENT_REQUEST_MISMATCH)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-3a', 1, 1);
  seedOrder(db, 'order-3b', 1, 1);
  const key = 'shared-key-3';
  requestFactoryLaunch({
    orderRef: 'order-3a', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
  }, db);
  // Тот же ключ, но ДРУГОЙ заказ — это конфликт, не идемпотентность.
  assert.throws(
    () => requestFactoryLaunch({
      orderRef: 'order-3b', mode: 'new', projectId: 1, epicId: 1,
      initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
    }, db),
    /FACTORY_LAUNCH_IDEMPOTENT_REQUEST_MISMATCH/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 4. Один активный launch на заказ
// ---------------------------------------------------------------------------

test('запуск: конкурентный start того же заказа с другим ключом отклонён', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-4', 1, 1);
  requestFactoryLaunch({
    orderRef: 'order-4', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-4a', concurrency: 1,
  }, db);
  // Вторая попытка с ДРУГИМ ключом пока первая ещё активна.
  assert.throws(
    () => requestFactoryLaunch({
      orderRef: 'order-4', mode: 'new', projectId: 1, epicId: 1,
      initiatedBy: 'op', idempotencyKey: 'key-4b', concurrency: 1,
    }, db),
    /FACTORY_LAUNCH_ACTIVE_REQUEST_MISMATCH/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// 5. Resume-mode требует lifecycle_run_id
// ---------------------------------------------------------------------------

test('запуск: resume-mode с lifecycle_run_id не совпадающим с заказом отклонён (SCOPE_MISMATCH)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-5', 1, 1); // lifecycle_run_id = NULL
  // Заказ не ссылается ни на какой run, а resume требует run=999.
  assert.throws(
    () => requestFactoryLaunch({
      orderRef: 'order-5', mode: 'resume', projectId: 1, epicId: 1,
      initiatedBy: 'op', idempotencyKey: 'key-5', concurrency: 1,
      lifecycleRunId: 999,
    }, db),
    /FACTORY_LAUNCH_ORDER_SCOPE_MISMATCH/,
  );
  db.close();
});

test('запуск: resume-mode с lifecycle_run_id проходит, когда заказ ссылается на тот же run', () => {
  const db = freshDb();
  seedProjectEpic(db);
  // Заказ С lifecycle_run_id (как бывает после markFactoryLaunchRunning).
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name,
        description, definition_snapshot, definition_hash, project_id, epic_id,
        initiated_by, idempotency_key, input_schema, input_snapshot, input_hash,
        status, entry_stage_id)
     VALUES (555, 'lf', '1', 'lf@1', 'd', '', '{}', 'h', 1, 1, 'op', 'ik',
             's', '{}', 'ih', 'paused', 'e')`,
  ).run();
  seedOrder(db, 'order-6', 1, 1);
  db.prepare(
    'UPDATE factory_orders SET lifecycle_run_id=555 WHERE order_ref=?',
  ).run('order-6');

  const ref = requestFactoryLaunch({
    orderRef: 'order-6', mode: 'resume', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-6', concurrency: 1,
    lifecycleRunId: 555,
  }, db);
  assert.ok(ref.startsWith('launch-'));
  db.close();
});

// ---------------------------------------------------------------------------
// 6. Ошибка запуска каскадирует на заказ как start_failed
// ---------------------------------------------------------------------------

test('запуск: finish(failed) ставит заказ в start_failed с last_error', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-7', 1, 1);
  const ref = requestFactoryLaunch({
    orderRef: 'order-7', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-7', concurrency: 1,
  }, db);
  const tok = 'tok-7';
  claimFactoryLaunch(ref, tok, db);
  seedLifecycleRun(db, 1);
  markFactoryLaunchRunning(ref, tok, 1, db);
  finishFactoryLaunch(ref, tok, 'failed', 'lifecycle crashed', 'start_failed', db);

  assert.equal(readLaunch(db, ref).state, 'failed');
  assert.equal(readOrder(db, 'order-7').state, 'start_failed');
  assert.equal(readOrder(db, 'order-7').last_error, 'lifecycle crashed');
  db.close();
});
