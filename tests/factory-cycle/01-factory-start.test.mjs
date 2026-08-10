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

// ---------------------------------------------------------------------------
// 7. paused: lifecycle suspended WITHOUT converging (typed wait / stall).
//    The launch settles as 'paused' (NOT 'completed'), the order settles as
//    'paused' (NOT 'completed'/'start_failed'), completed_at is stamped
//    (terminal-for-this-launch), and the default orderState derives correctly
//    from the launch state. This is the false-green defence: a host that reads
//    launch.state cannot mistake a paused launch for a converged one.
// ---------------------------------------------------------------------------

test('запуск: finish(paused) ставит launch и order в paused (не completed)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-paused', 1, 1);
  const ref = requestFactoryLaunch({
    orderRef: 'order-paused', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-paused', concurrency: 1,
  }, db);
  const tok = 'tok-paused';
  claimFactoryLaunch(ref, tok, db);
  seedLifecycleRun(db, 7);
  markFactoryLaunchRunning(ref, tok, 7, db);

  // Default orderState must derive to 'paused' from launch state 'paused'.
  // Pass undefined for orderState to exercise the default-parameter derivation.
  finishFactoryLaunch(ref, tok, 'paused', null, undefined, db);

  assert.equal(readLaunch(db, ref).state, 'paused',
    'paused launch must NOT be marked completed');
  assert.equal(readOrder(db, 'order-paused').state, 'paused',
    'paused order must NOT be marked completed or start_failed');
  assert.equal(readOrder(db, 'order-paused').last_error, null);

  // completed_at is stamped — paused is terminal for THIS LaunchRequest.
  const settled = db.prepare(
    'SELECT completed_at FROM factory_launch_requests WHERE launch_ref=?',
  ).get(ref);
  assert.ok(settled.completed_at, 'paused launch must stamp completed_at');

  db.close();
});

// ---------------------------------------------------------------------------
// 8. paused frees the one-active-launch slot: a later resume can create a
//    fresh launch under the same order (with a NEW idempotency key — the
//    prior paused launch remains immutable evidence).
// ---------------------------------------------------------------------------

test('запуск: после paused можно создать новый launch на тот же order', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-resume', 1, 1);

  const ref1 = requestFactoryLaunch({
    orderRef: 'order-resume', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-resume-1', concurrency: 1,
  }, db);
  const tok1 = 'tok-resume-1';
  claimFactoryLaunch(ref1, tok1, db);
  seedLifecycleRun(db, 9);
  markFactoryLaunchRunning(ref1, tok1, 9, db);
  finishFactoryLaunch(ref1, tok1, 'paused', null, 'paused', db);
  assert.equal(readLaunch(db, ref1).state, 'paused');

  // Resume with a NEW idempotency key — must succeed (slot freed by paused).
  const ref2 = requestFactoryLaunch({
    orderRef: 'order-resume', mode: 'resume', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-resume-2', concurrency: 1,
    lifecycleRunId: 9,
  }, db);
  assert.notEqual(ref2, ref1, 'resume creates a NEW launch_ref');
  assert.ok(ref2.startsWith('launch-'), `resume launch_ref prefix: ${ref2}`);

  // Two launch rows for one order — the prior paused one is immutable evidence.
  const rows = db.prepare(
    `SELECT launch_ref, state FROM factory_launch_requests
      WHERE order_ref=? ORDER BY created_at`,
  ).all('order-resume');
  assert.equal(rows.length, 2, 'one paused launch + one fresh resume launch');
  assert.equal(rows[0].state, 'paused');
  assert.equal(rows[1].state, 'requested');

  db.close();
});

// ---------------------------------------------------------------------------
// 9. paused is NOT idempotency-replayable as completed: the same idempotency
//    key after a paused launch returns the SAME (paused) launch_ref — it does
//    NOT silently promote to completed, and it does NOT create a new launch.
//    A new intentional Start after pause MUST use a new key.
// ---------------------------------------------------------------------------

test('запуск: тот же idempotency-key после paused возвращает тот же launch_ref в состоянии paused', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-idem-paused', 1, 1);
  const key = 'durable-key-paused';

  const ref1 = requestFactoryLaunch({
    orderRef: 'order-idem-paused', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
  }, db);
  const tok = 'tok-idem';
  claimFactoryLaunch(ref1, tok, db);
  seedLifecycleRun(db, 11);
  markFactoryLaunchRunning(ref1, tok, 11, db);
  finishFactoryLaunch(ref1, tok, 'paused', null, 'paused', db);

  // Retry той же команды после paused — должен вернуть ТОТ же launch_ref,
  // остаться в paused. Никакого молчаливого повышения до completed.
  const ref1b = requestFactoryLaunch({
    orderRef: 'order-idem-paused', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: key, concurrency: 1,
  }, db);
  assert.equal(ref1b, ref1, 'durable idempotency preserves launch_ref after paused');
  assert.equal(readLaunch(db, ref1b).state, 'paused',
    'replay must not promote paused to completed');

  const rows = db.prepare(
    'SELECT launch_ref FROM factory_launch_requests WHERE idempotency_key=?',
  ).all(key);
  assert.equal(rows.length, 1, 'only one launch row per idempotency key');

  db.close();
});

// ---------------------------------------------------------------------------
// 10. paused preserves the capability-token fence: a second finish with the
//     WRONG token is rejected (FACTORY_LAUNCH_FENCE_LOST), and a second
//     finish with the RIGHT token on an already-settled launch is also
//     rejected — paused is terminal-for-this-launch, the CAS fence holds.
// ---------------------------------------------------------------------------

test('запуск: finish(paused) сохраняет capability-fence (второй finish отклонён)', () => {
  const db = freshDb();
  seedProjectEpic(db);
  seedOrder(db, 'order-fence', 1, 1);
  const ref = requestFactoryLaunch({
    orderRef: 'order-fence', mode: 'new', projectId: 1, epicId: 1,
    initiatedBy: 'op', idempotencyKey: 'key-fence', concurrency: 1,
  }, db);
  const tok = 'tok-fence-right';
  claimFactoryLaunch(ref, tok, db);
  seedLifecycleRun(db, 13);
  markFactoryLaunchRunning(ref, tok, 13, db);
  finishFactoryLaunch(ref, tok, 'paused', null, 'paused', db);
  assert.equal(readLaunch(db, ref).state, 'paused');

  // Чужой токен отклонён.
  assert.throws(
    () => finishFactoryLaunch(ref, 'WRONG-tok', 'paused', null, 'paused', db),
    /FACTORY_LAUNCH_FENCE_LOST/,
  );
  // Повторный finish с правильным токеном тоже отклонён — paused уже терминален
  // для этой launch-записи (CAS-condition state IN ('claimed','running') больше
  // не матчит).
  assert.throws(
    () => finishFactoryLaunch(ref, tok, 'completed', null, 'completed', db),
    /FACTORY_LAUNCH_FENCE_LOST/,
  );
  // Состояние не изменилось — чужак/повтор не испортили запись.
  assert.equal(readLaunch(db, ref).state, 'paused');

  db.close();
});
