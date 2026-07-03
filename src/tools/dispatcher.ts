import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { reevaluateDownstream } from './tasks.js';
import type { Task, ToolHandler } from '../types.js';

// ============================================================================
// Dispatcher: saga раздаёт задачи агентам.
//
// Две ручки поверх существующих 31 тулз saga (старые НЕ трогаем):
//   worker_next({worker_id})          — взять следующую свободную задачу
//   worker_done({task_id,worker_id,result}) — завершить текущую + получить следующую
//
// Принцип: assigned_to (нативное поле saga) = флаг занятости задачи.
// Очередь = status IN ('todo','review') AND assigned_to IS NULL.
// Ревью-цикл не заходит в in_progress: статус остаётся review, назначается
// только assigned_to. Так worker_done отличает циклы по ТЕКУЩЕМУ статусу задачи.
// ============================================================================

const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";

// Верхняя граница попыток claim в findNextClaimable. Под IMMEDIATE-локом retry
// срабатывает крайне редко (мы держим эксклюзивный lock), но лимит страховает
// от livelock и от удержания глобального write-lock'а сколь угодно долго.
const MAX_CLAIM_ATTEMPTS = 10;

// better-sqlite3 db.transaction(fn) всегда DEFERRED и не принимает mode (типы
// @types/better-sqlite3 в форке: transaction<F>(fn: F): Transaction<F>). Нам же
// нужен BEGIN IMMEDIATE — write-lock всей БД с старта транзакции (аналог
// SELECT FOR UPDATE, которого нет в SQLite), чтобы сериализовать писателей.
// Поэтому оборачиваем логику в явные BEGIN IMMEDIATE / COMMIT / ROLLBACK.
function withImmediateTransaction<T>(db: Database.Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // Если транзакция ещё активна — откатить. ROLLBACK без активной tx бросит
    // ошибку, глотаем её (мы и так в пути ошибки).
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore — tx could not be active */
    }
    throw err;
  }
}

type WorkerSkill = 'saga-developer' | 'saga-reviewer';

/** Скилл, который агент должен применить для задачи с этим исходным статусом. */
function skillForStatus(sourceStatus: string): WorkerSkill {
  return (sourceStatus === 'review' || sourceStatus === 'review_in_progress')
    ? 'saga-reviewer'
    : 'saga-developer';
}

// ============================================================================
// Worktree-изоляция: каждый воркер работает в своём git worktree на ветке
// task/<id>. Имя ветки и путь детерминированы из ID задачи (конвенция), поэтому
// active_tasks вычисляет их на лету — отдельное хранилище не нужно. В metadata
// хранится ТОЛЬКО исход интеграции (written worker_merge_release): pending /
// dev / conflict. Так worker_health отличает «done но не слито» от «слито».
// ============================================================================

const WORKTREE_META_KEY = 'worktree';
export const INTEGRATION_BRANCH_DEFAULT = 'dev';
// Merge-lock считается протухшим и может быть отнят — страховка от zombie-воркера,
// который acquire'нул и умер не успев release. 10 минут = больше любого реального
// merge; меньше — риск отобрать живому воркеру.
const MERGE_LOCK_STALE_MIN = 10;
const MERGE_LOCK_RETRY_MS = 3000;

/** Ветвь и путь worktree задачи — по конвенции из ID. */
export function worktreeBranch(taskId: number): string {
  return `task/${taskId}`;
}
export function worktreePath(taskId: number): string {
  return `.worktrees/task-${taskId}`;
}

/** Распарсить metadata задачи в объект (защита от мусора/null). */
function readMetadata(db: Database.Database, taskId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId) as
    | { metadata?: string }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Записать патч в metadata.worktree (merge поверх существующих полей). */
function patchWorktreeMeta(
  db: Database.Database,
  taskId: number,
  patch: Record<string, unknown>,
): void {
  const meta = readMetadata(db, taskId);
  const wt = (meta[WORKTREE_META_KEY] as Record<string, unknown> | undefined) ?? {};
  meta[WORKTREE_META_KEY] = { ...wt, ...patch };
  db.prepare('UPDATE tasks SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(JSON.stringify(meta), taskId);
}

/**
 * Снапшот активной параллельной работы — read-only. Соседние воркеры видят, кто
 * над чем в каком worktree прямо сейчас. НЕ под write-локом: это обзор, minor
 * staleness приемлем; гонок не создаёт (чистый SELECT).
 */
function getActiveTasks(db: Database.Database, projectId: number): Array<{
  task_id: number;
  title: string;
  assigned_to: string;
  status: string;
  branch: string;
  epic_name: string;
}> {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.assigned_to, t.status, e.name AS epic_name
       FROM tasks t JOIN epics e ON e.id = t.epic_id
       WHERE e.project_id=? AND t.status IN ('in_progress','review') AND t.assigned_to IS NOT NULL
       ORDER BY t.id`,
    )
    .all(projectId) as Array<{
      id: number;
      title: string;
      assigned_to: string;
      status: string;
      epic_name: string;
    }>;
  return rows.map((r) => ({
    task_id: r.id,
    title: r.title,
    assigned_to: r.assigned_to,
    status: r.status,
    branch: worktreeBranch(r.id),
    epic_name: r.epic_name,
  }));
}

/** Добавить тег задаче (merge в существующий JSON-массив тегов). */
function addTag(db: Database.Database, taskId: number, tag: string): void {
  const row = db.prepare('SELECT tags FROM tasks WHERE id=?').get(taskId) as
    | { tags: string }
    | undefined;
  const tags = parseTags(row?.tags);
  if (!tags.has(tag)) {
    tags.add(tag);
    db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify([...tags]), taskId);
  }
}



// ============================================================================
// findNextClaimable — общий helper для worker_next (раздача задач).
// Находит свободную задачу и атомарно занимает её за workerId.
// Внутри транзакции BEGIN IMMEDIATE (вызывается из claim() в handler'ах).
//
// Две ветви conditional-UPDATE по исходному статусу найденной задачи:
//   todo    → status='in_progress', assigned_to=workerId   (цикл разработки)
//   review  → только assigned_to=workerId, статус НЕ трогаем (цикл ревью)
//
// excludeTaskId — чтобы worker_done не отдал тому же агенту только что
// закрытую задачу на ревью (anti-self-review).
// ============================================================================
function findNextClaimable(
  db: Database.Database,
  workerId: string,
  projectId: number,
  excludeTaskId?: number,
  attempt: number = 0,
): Task | null {
  // Стоп через MAX_CLAIM_ATTEMPTS: под IMMEDIATE-локом контентция редка, но
  // бесконечная рекурсия могла бы livelock'нуть глобальный write-lock.
  if (attempt >= MAX_CLAIM_ATTEMPTS) return null;
  // 1. SELECT кандидата: статус todo/review, свободна, без невыполненных deps.
  //    Шаблон NOT EXISTS сверен с tasks.ts:139-145 и blocked_by_count (tasks.ts:279-281).
  //    project-фильтр через tasks.epic_id → epics.project_id (precedent в dashboard.ts).
  //    Готовые индексы: idx_tasks_epic_id, idx_epics_project_id.
  //    low-приоритет НЕ раздаётся автоматически — ждёт ручного решения (повысить
  //    приоритет / взять вручную). Применяется к todo И review единообразно.
  const excludeClause = excludeTaskId !== undefined ? 'AND t.id != ?' : '';
  const selectSql = `
    SELECT t.* FROM tasks t
    WHERE t.status IN ('todo', 'review')
      AND (t.assigned_to IS NULL OR t.assigned_to = '')
      AND t.priority IN ('critical', 'high', 'medium')
      AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ?)
      ${excludeClause}
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id AND dep.status != 'done'
      )
    ORDER BY ${PRIORITY_ORDER}, t.created_at
    LIMIT 1
  `;
  const task = (
    excludeTaskId !== undefined
      ? db.prepare(selectSql).get(projectId, excludeTaskId)
      : db.prepare(selectSql).get(projectId)
  ) as Task | undefined;

  if (!task) return null;

  // 2. Conditional-UPDATE — защита от гонок (defence in depth):
  //    даже если SELECT вернул кандидата, другой процесс мог занять его
  //    между SELECT и UPDATE. WHERE ... AND assigned_to IS NULL|'' это отсечёт.
  //    Tolerant к пустой строке (saga-API может записать '' вместо NULL при
  //    ручном обновлении; инвариант todo/done ⇒ NULL ловит основную массу,
  //    это — страховка на случай stale-данных).
  let info: Database.RunResult;
  if (task.status === 'todo') {
    // Цикл разработки: задача уходит в работу.
    info = db
      .prepare(
        `UPDATE tasks SET status='in_progress', assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND status='todo' AND (assigned_to IS NULL OR assigned_to = '')`,
      )
      .run(workerId, task.id);
  } else {
    // Цикл ревью: задача из буфера review (ждёт ревьюера) переходит в
    // review_in_progress (ревьюер работает). Зеркало todo→in_progress для
    // ревью-фазы. assigned_to = reviewer.
    info = db
      .prepare(
        `UPDATE tasks SET status='review_in_progress', assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND status='review' AND (assigned_to IS NULL OR assigned_to = '')`,
      )
      .run(workerId, task.id);
  }

  // 3. Кто-то успел занять под носом — ищем следующего кандидата,
  //    с ограничением попыток (см. MAX_CLAIM_ATTEMPTS выше). projectId пробрасываем.
  if (info.changes !== 1) {
    return findNextClaimable(db, workerId, projectId, excludeTaskId, attempt + 1);
  }

  // logActivity на назначение. Оба цикла (dev: todo→in_progress, review:
  // review→review_in_progress) меняют статус — логируем как status_changed.
  const newClaimedStatus = task.status === 'todo' ? 'in_progress' : 'review_in_progress';
  logActivity(
    db,
    'task',
    task.id,
    'status_changed',
    'status',
    task.status,
    newClaimedStatus,
    `Task '${task.title}' claimed by ${workerId} (from ${task.status} to ${newClaimedStatus})`,
  );

  return task;
}

// ============================================================================
// Handlers
// ============================================================================

function handleWorkerNext(args: Record<string, unknown>): {
  task: Task | null;
  skill: WorkerSkill | null;
  active_tasks?: Array<{
    task_id: number;
    title: string;
    assigned_to: string;
    status: string;
    branch: string;
    epic_name: string;
  }>;
  reason?: string;
} {
  const db = getDb();
  const workerId = args.worker_id as string;

  // project_id REQUIRED — иначе в общей БД агенту подсовывается чужая задача.
  // Бросаем actionable-ошибку (НЕ через required inputSchema): так агент
  // получает полное решение, что делать, а не generic "validation failed".
  const projectId = args.project_id as number | undefined;
  if (projectId == null) {
    throw new Error(
      [
        'project_id is missing — cannot dispatch work without knowing the project.',
        'HOW TO GET project_id (do this ONCE, then retry worker_next):',
        '1. Read ./projectname.txt.',
        '2. If it exists: call project_resolve_by_name({ name: "<file contents>" }) and use its project_id.',
        '3. If it does NOT exist: ask the user "What is the saga project name for this folder?",',
        '   create ./projectname.txt with that single line as its only contents,',
        '   then call project_resolve_by_name({ name: "<that name>" }).',
        'Then retry: worker_next({ worker_id, project_id }).',
      ].join('\n'),
    );
  }
  const exists = db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId);
  if (!exists) {
    throw new Error(`project_id ${projectId} not found. Run project_list to see valid IDs, or project_resolve_by_name to (re)create by name from ./projectname.txt.`);
  }

  // BEGIN IMMEDIATE — write-lock всей БД с старта транзакции
  // (аналог SELECT FOR UPDATE, которого нет в SQLite). busy_timeout=5000 в db.ts.
  // db.transaction(fn) тут только DEFERRED, поэтому оборачиваем явно.
  const task = withImmediateTransaction(db, () =>
    findNextClaimable(db, workerId, projectId),
  );

  // active_tasks — read-only снапшот параллельной работы. Берём ПОСЛЕ транзакции,
  // чтобы не держать write-lock дольше необходимого: видимость — best-effort,
  // minor staleness приемлем.
  const active_tasks = getActiveTasks(db, projectId);

  if (!task) return { task: null, skill: null, active_tasks, reason: 'очередь пуста' };
  return { task, skill: skillForStatus(task.status), active_tasks };
}

function handleWorkerDone(args: Record<string, unknown>): {
  completed: number;
  completed_new_status: 'review' | 'done' | 'in_progress';
  active_tasks?: Array<{
    task_id: number;
    title: string;
    assigned_to: string;
    status: string;
    branch: string;
    epic_name: string;
  }>;
  // Сигнал воркеру: задача закрыта, цикл окончен — завершайся. worker_done больше
  // не раздаёт следующую задачу (см. протокол 09-...), а чтобы воркер не гадал,
  // что делать дальше — saga явно говорит ему остановиться.
  stop: true;
  stop_reason: string;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const result = args.result as string;
  // verdict — только для задач в review. По умолчанию 'approved' (обратная
  // совместимость: старые вызовы без verdict ведут себя как раньше — review→done).
  // 'changes_requested' возвращает задачу в in_progress: ветка task/<id> и её
  // worktree НЕ трогаются (переживают re-work loop), assigned_to возвращается
  // этому же воркеру.
  const verdict = (args.verdict as 'approved' | 'changes_requested' | undefined) ?? 'approved';
  if (verdict !== 'approved' && verdict !== 'changes_requested') {
    throw new Error(`verdict must be 'approved' or 'changes_requested', got '${verdict}'`);
  }

  const completeTask = (): ReturnType<typeof handleWorkerDone> => {
    // Чья задача закрывается — зависит от фазы:
    //  - in_progress: замок владельца. Только assigned_to = worker_id может закрыть
    //    активную разработку (защита от кражи часов чужого кодинга).
    //  - review_in_progress: вердикт от ЛЮБОГО воркера. assigned_to в
    //    review_in_progress — это запись «ревьюер взял», не замок от чужого
    //    вердикта. Любой воркер, доставивший APPROVED/CHANGES REQUESTED в result,
    //    продвигает задачу. APPROVED → done, CHANGES REQUESTED → обратно в
    //    in_progress (та же ветка/worktree живут дальше).
    //  - review (без assigned_to, буфер): НЕТ — сначала claim через worker_next.
    let task: Task | undefined;
    // Сначала пробуем как владельца (для in_progress и review_in_progress с моим assigned_to).
    task = db
      .prepare('SELECT * FROM tasks WHERE id=? AND assigned_to=?')
      .get(taskId, workerId) as Task | undefined;
    // Не мой, но в review_in_progress? Любой воркер может закрыть вердиктом.
    if (!task) {
      const reviewTask = db
        .prepare("SELECT * FROM tasks WHERE id=? AND status='review_in_progress'")
        .get(taskId) as Task | undefined;
      if (reviewTask) {
        task = reviewTask;
      } else {
        throw new Error(`Task ${taskId} not assigned to ${workerId}`);
      }
    }

    // 2. Следующий статус по ТЕКУЩЕМУ статусу (он сам = флаг цикла) + verdict.
    let newStatus: 'review' | 'done' | 'in_progress';
    let newAssignedTo: string | null; // кому уходит задача после перевода
    if (task.status === 'in_progress') {
      newStatus = 'review';            // цикл разработки завершён → буфер ревью
      newAssignedTo = null;            // в очереди на ревью (без исполнителя)
    } else if (task.status === 'review_in_progress') {
      if (verdict === 'changes_requested') {
        newStatus = 'in_progress';     // обратно в работу
        newAssignedTo = workerId;      // замок возвращается ревьюеру (он теперь дев)
      } else {
        newStatus = 'done';            // цикл ревью завершён (APPROVED)
        newAssignedTo = null;
      }
    } else {
      throw new Error(
        `Task ${taskId} status '${task.status}' — nothing to complete. ` +
        `If it's in 'review', claim it via worker_next first (it will move to 'review_in_progress').`,
      );
    }

    // 3. Перевод статуса + assigned_to — атомарно, одной командой.
    //    - in_progress→review:           замок владельца (assigned_to=?),    assigned→NULL.
    //    - review_in_progress→done:      любой воркер (status='review_in_progress'), assigned→NULL.
    //    - review_in_progress→in_progress: любой воркер (status='review_in_progress'), assigned→workerId.
    //    Гонок нет: BEGIN IMMEDIATE + info.changes===1.
    const completeInfo = db
      .prepare(
        `UPDATE tasks SET status=?, assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND (assigned_to=? OR status='review_in_progress')`,
      )
      .run(newStatus, newAssignedTo, taskId, workerId);

    // Если ни одна строка не обновлена — assigned_to изменился между SELECT и
    // UPDATE. Не продолжать: иначе вставим comment для чужой задачи и вернём
    // completed_new_status, хотя статус не сдвинулся (wrong result).
    if (completeInfo.changes !== 1) {
      throw new Error(
        `Task ${taskId} assignment changed before completion (expected owner ${workerId})`,
      );
    }

    // 4. Comment с результатом воркера (author = worker_id).
    //    created_at авто из DEFAULT в schema (как в comments.ts:47).
    db.prepare(
      'INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)',
    ).run(taskId, workerId, result);

    // 5. Разблокировка downstream ТОЛЬКО при done (нативная механика saga).
    if (newStatus === 'done') {
      // Worktree-интеграция: APPROVED → задача done, НО код ещё не слит в dev.
      // Ставим merged_into:"pending" — значит «принят, ждёт интеграции». Воркер
      // затем берёт merge-lock, мержит, и worker_merge_release резолвит pending→dev
      // (или →conflict). worker_health отличит «done но не слито» по этому полю.
      // Для изменений цикла CHANGES_REQUESTED (review→in_progress) НЕ трогаем —
      // worktree живёт, метка не нужна.
      patchWorktreeMeta(db, taskId, {
        branch: worktreeBranch(taskId),
        path: worktreePath(taskId),
        merge_target: INTEGRATION_BRANCH_DEFAULT,
        merged_into: 'pending',
        merged_commit: null,
        merge_conflict: false,
      });
      reevaluateDownstream(db, taskId); // tasks.ts:167
    }

    // 6. logActivity на переход статуса.
    logActivity(
      db,
      'task',
      taskId,
      'status_changed',
      'status',
      task.status,
      newStatus,
      `Task '${task.title}' completed by ${workerId}: ${task.status} -> ${newStatus}${verdict !== 'approved' ? ` (verdict=${verdict})` : ''}`,
    );

    // 7. active_tasks — read-only снапшот параллельной работы, для осведомлённости
    //    воркера о соседях. projectId выводим из epic_id текущей задачи
    //    (worker_done не принимает project_id параметром — он знает task_id,
    //    и проект тот же).
    //
    //    NOTE: worker_done больше НЕ делает авто-claim следующей задачи.
    //    Раньше тут вызывался findNextClaimable(...) и возвращался next_task —
    //    это создавало zombies в модели «одна задача = один запуск»: воркер
    //    умирал, а следующая задача уже была назначена на его мёртвый id.
    //    Теперь за следующей задачей воркер явно идёт через worker_next.
    const projectIdRow = db
      .prepare('SELECT project_id FROM epics WHERE id=?')
      .get(task.epic_id) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    const active_tasks = projectId != null ? getActiveTasks(db, projectId) : [];

    return {
      completed: taskId,
      completed_new_status: newStatus,
      active_tasks,
      // Явный сигнал воркеру: работа завершена, завершайся. worker_done не
      // отдаёт следующую задачу — без этого сигнала воркер мог бы попытаться
      // продолжить цикл. Сага говорит чётко: стоп.
      stop: true,
      stop_reason: 'task completed — stop now and return your summary',
    };
  }; // end completeTask

  // BEGIN IMMEDIATE — сериализация писателей (db.transaction тут DEFERRED,
  // поэтому оборачиваем явно).
  return withImmediateTransaction(db, completeTask);
}

// ============================================================================
// worker_ask_need / worker_ask_done — сигнал «жду ответа от человека».
// Агент упёрся в реальный блокер (нужна инфа/решение от человека), но контекст
// задачи дорогой (часы понимания кода) — дешевле ответить на вопрос, чем
// перезапускать задачу с нуля. Поэтому:
//   - assigned_to НЕ трогаем (агент держит задачу, не уходит на другую)
//   - статус НЕ трогаем (задача остаётся in_progress — визуально «в работе, но ждёт»)
//   - тег needs-human → мигает красным ⚠️ на канбане
// Workflow агента: worker_ask_need → AskUserQuestion (в UI ZCode) → worker_ask_done → continue.
// Редкие случаи; agent-idle терпим.
// ============================================================================

const NEEDS_HUMAN_TAG = 'needs-human';

/** Разобрать JSON-массив тегов задачи в Set. */
function parseTags(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((t) => typeof t === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function handleWorkerAskNeed(args: Record<string, unknown>): {
  task_id: number;
  blocking: true;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const reason = (args.reason as string | undefined) ?? null;

  // Это моя задача? (assigned_to = worker_id) — нельзя мигать чужой.
  const task = db
    .prepare('SELECT id, title, tags FROM tasks WHERE id=? AND assigned_to=?')
    .get(taskId, workerId) as { id: number; title: string; tags: string } | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not assigned to ${workerId} (cannot flag a task you don't hold)`);
  }

  const tags = parseTags(task.tags);
  const alreadyBlocking = tags.has(NEEDS_HUMAN_TAG);
  if (!alreadyBlocking) {
    tags.add(NEEDS_HUMAN_TAG);
    db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify([...tags]), taskId);
  }

  // Опциональный reason → comment (человек видит ЧТО спрашивают, не только что мигает).
  if (reason) {
    db.prepare('INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)')
      .run(taskId, workerId, `ASK: ${reason}`);
  }

  logActivity(db, 'task', taskId, 'updated', 'ask_need', null, NEEDS_HUMAN_TAG,
    `Task '${task.title}' flagged needs-human by ${workerId}${reason ? `: ${reason}` : ''}`);

  return { task_id: taskId, blocking: true };
}

function handleWorkerAskDone(args: Record<string, unknown>): {
  task_id: number;
  blocking: false;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;

  const task = db
    .prepare('SELECT id, title, tags FROM tasks WHERE id=? AND assigned_to=?')
    .get(taskId, workerId) as { id: number; title: string; tags: string } | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not assigned to ${workerId}`);
  }

  const tags = parseTags(task.tags);
  if (tags.has(NEEDS_HUMAN_TAG)) {
    tags.delete(NEEDS_HUMAN_TAG);
    db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify([...tags]), taskId);
  }

  logActivity(db, 'task', taskId, 'updated', 'ask_done', NEEDS_HUMAN_TAG, null,
    `Task '${task.title}' needs-human cleared by ${workerId}`);

  return { task_id: taskId, blocking: false };
}

// ============================================================================
// worker_merge_acquire / worker_merge_release — сериализация слияний веток
// задач (task/<id>) в интеграционную ветку (dev). ЗАЧЕМ: несколько процессов
// saga-mcp обслуживают разных воркеров параллельно; единственная общая
// поверхность координации между ними — SQLite-БД (уже сериализуется через
// BEGIN IMMEDIATE). Поэтому merge-lock хранится в metadata проекта и берётся
// под тем же write-локом. Workflow скилла: worker_done (done) → loop acquire →
// git merge → release.
// ============================================================================

function readProjectMetadata(db: Database.Database, projectId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM projects WHERE id=?').get(projectId) as
    | { metadata?: string }
    | undefined;
  if (!row?.metadata) return {};
  try {
    const parsed = JSON.parse(row.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function handleWorkerMergeAcquire(args: Record<string, unknown>): {
  granted: boolean;
  held_by?: { task_id: number; worker_id: string; age_min: number };
  retry_after_ms?: number;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;

  const grant = withImmediateTransaction(db, () => {
    const task = db.prepare('SELECT id, title, status FROM tasks WHERE id=?').get(taskId) as
      | { id: number; title: string; status: string }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'done') {
      throw new Error(
        `Task ${taskId} status is '${task.status}' — merge-lock is only for tasks that reached 'done' (APPROVED). Wait until review is complete.`,
      );
    }

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project (epic missing)`);

    const meta = readProjectMetadata(db, projectId);
    const lock = meta.merge_lock as
      | { task_id: number; worker_id: string; acquired_at: string }
      | null
      | undefined;

    const now = Date.now();
    // Stale-safe: lock протух MERGE_LOCK_STALE_MIN назад — отбираем (zombie
    // воркер acquire'нул и умер). Иначе никто не смержит, пока человек не придёт.
    const isStale = (() => {
      if (!lock?.acquired_at) return true;
      const ageMs = now - new Date(lock.acquired_at + 'Z').getTime();
      return ageMs > MERGE_LOCK_STALE_MIN * 60_000;
    })();

    if (!lock || isStale) {
      const acquiredAt = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
      meta.merge_lock = { task_id: taskId, worker_id: workerId, acquired_at: acquiredAt };
      db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(meta), projectId);
      logActivity(db, 'task', taskId, 'updated', 'merge_lock', lock ? 'stale' : null, workerId,
        `Merge lock ${lock ? 'reclaimed from stale' : 'acquired by'} ${workerId} for task '${task.title}'`);
      return { granted: true as const };
    }

    // Занято живым воркером — отдаём who/age, пусть коллега подождёт.
    const ageMin = Math.max(
      0, Math.round((now - new Date(lock.acquired_at + 'Z').getTime()) / 60_000),
    );
    return {
      granted: false as const,
      held_by: { task_id: lock.task_id, worker_id: lock.worker_id, age_min: ageMin },
      retry_after_ms: MERGE_LOCK_RETRY_MS,
    };
  });

  return grant;
}

function handleWorkerMergeRelease(args: Record<string, unknown>): {
  task_id: number;
  result: 'merged' | 'conflict';
  merged_commit?: string | null;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const outcome = args.result as 'merged' | 'conflict';
  if (outcome !== 'merged' && outcome !== 'conflict') {
    throw new Error(`result must be 'merged' or 'conflict', got '${outcome}'`);
  }
  const commitSha = (args.commit_sha as string | undefined) ?? null;

  withImmediateTransaction(db, () => {
    const task = db.prepare('SELECT id, title, status, tags FROM tasks WHERE id=?').get(taskId) as
      | { id: number; title: string; status: string; tags: string }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project`);

    // Снять merge_lock, но ТОЛЬКО если он мой. Иначе чужой lock мог быть уже
    // отобран stale-логикой и передан другому — я не должен его трогать.
    const meta = readProjectMetadata(db, projectId);
    const lock = meta.merge_lock as
      | { task_id: number; worker_id: string; acquired_at: string }
      | null
      | undefined;
    if (lock && (lock.task_id !== taskId || lock.worker_id !== workerId)) {
      throw new Error(
        `Merge lock for task ${taskId} is held by ${lock.worker_id} (task ${lock.task_id}), not by ${workerId}. Only the holder may release.`,
      );
    }
    meta.merge_lock = null;
    db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify(meta), projectId);

    // Резолвим merged_into и (при конфликте) флагаем needs-human.
    if (outcome === 'merged') {
      patchWorktreeMeta(db, taskId, { merged_into: INTEGRATION_BRANCH_DEFAULT, merged_commit: commitSha, merge_conflict: false });
      // Если раньше был conflict (тег needs-human висит) — теперь всё слито,
      // человек больше не нужен. Снимаем тег (mirror of worker_ask_done).
      const tags = parseTags(task.tags);
      if (tags.has(NEEDS_HUMAN_TAG)) {
        tags.delete(NEEDS_HUMAN_TAG);
        db.prepare('UPDATE tasks SET tags=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify([...tags]), taskId);
      }
    } else {
      patchWorktreeMeta(db, taskId, { merged_into: 'conflict', merged_commit: null, merge_conflict: true });
      // needs-human (как в worker_ask_need): задача остаётся done, но пульсирует
      // красным на канбане — человек разруливает мерж-конфликт руками.
      addTag(db, taskId, NEEDS_HUMAN_TAG);
    }

    logActivity(db, 'task', taskId, 'updated', 'merge_release', null, outcome,
      `Merge ${outcome === 'merged' ? `completed${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}` : 'CONFLICT (flagged needs-human)'} by ${workerId} for task '${task.title}'`);
  });

  return { task_id: taskId, result: outcome, merged_commit: outcome === 'merged' ? commitSha : null };
}

// ============================================================================
// worker_health — read-only поиск застрявших worktree'ов: zombie (in_progress
// давно без движения), never-merged (done, но merged_into IS NULL/pending),
// stuck-merge (merged_into='conflict'). Saga сама ничего не удаляет — в worktree
// может быть чужая незакоммиченная работа; watcher/человек решает.
// ============================================================================

function handleWorkerHealth(args: Record<string, unknown>): {
  zombies: Array<{ task_id: number; title: string; assigned_to: string; branch: string; path: string; stale_min: number }>;
  never_merged: Array<{ task_id: number; title: string; branch: string; path: string; merged_into: string | null }>;
  stuck_merges: Array<{ task_id: number; title: string; branch: string; path: string }>;
} {
  const db = getDb();
  const projectId = args.project_id as number | undefined;
  if (projectId == null) {
    throw new Error(
      'project_id is required. Resolve it once from ./projectname.txt via project_resolve_by_name, then pass it here.',
    );
  }

  const projClause = 'AND e.project_id=?';
  const params = [projectId];

  // Zombies: активная работа без движения > 30 мин. И in_progress (разработка),
  // и review_in_progress (ревьюер работает) — оба могут зависнуть.
  const zombieRows = db.prepare(
    `SELECT t.id, t.title, t.assigned_to, t.updated_at
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND t.status IN ('in_progress', 'review_in_progress')
       AND t.updated_at < datetime('now','-30 minutes')`,
  ).all(...params) as Array<{ id: number; title: string; assigned_to: string; updated_at: string }>;
  const zombies = zombieRows.map((r) => ({
    task_id: r.id,
    title: r.title,
    assigned_to: r.assigned_to,
    branch: worktreeBranch(r.id),
    path: worktreePath(r.id),
    stale_min: Math.max(0, Math.round((Date.now() - new Date(r.updated_at + 'Z').getTime()) / 60_000)),
  }));

  // Never-merged: done, но worktree-метка merged_into пустая или pending
  // (APPROVED, но код не слит в dev). Это главный сигнал «работа может потеряться».
  const neverRows = db.prepare(
    `SELECT t.id, t.title, t.metadata
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND t.status='done'
       AND json_extract(t.metadata,'$.worktree.merged_into') IS NULL
      OR (e.project_id=? AND t.status='done'
          AND json_extract(t.metadata,'$.worktree.merged_into')='pending')`,
  ).all(projectId, projectId) as Array<{ id: number; title: string; metadata: string }>;
  const never_merged = neverRows.map((r) => {
    let mergedInto: string | null = null;
    try {
      mergedInto = (JSON.parse(r.metadata)?.worktree?.merged_into ?? null) as string | null;
    } catch { /* ignore */ }
    return {
      task_id: r.id,
      title: r.title,
      branch: worktreeBranch(r.id),
      path: worktreePath(r.id),
      merged_into: mergedInto,
    };
  });

  // Stuck merges: merged_into='conflict' (мерж конфликтовал, ждёт человека).
  const stuckRows = db.prepare(
    `SELECT t.id, t.title
     FROM tasks t JOIN epics e ON e.id=t.epic_id
     WHERE 1=1 ${projClause}
       AND json_extract(t.metadata,'$.worktree.merged_into')='conflict'`,
  ).all(...params) as Array<{ id: number; title: string }>;
  const stuck_merges = stuckRows.map((r) => ({
    task_id: r.id,
    title: r.title,
    branch: worktreeBranch(r.id),
    path: worktreePath(r.id),
  }));

  return { zombies, never_merged, stuck_merges };
}

// ============================================================================
// Definitions
// ============================================================================

export const definitions: Tool[] = [
  {
    name: 'worker_next',
    description:
      'Claim the next available task for a worker WITHIN A PROJECT. Finds a free task (status todo or review, unassigned, no unmet dependencies, priority medium or above) in the given project only, atomically assigns it to the worker, and returns the task plus the skill the agent should use. Low-priority tasks are NOT handed out automatically (raise their priority to medium+ to make them claimable). Other projects in the shared DB are never touched. project_id is REQUIRED — resolve it once from ./projectname.txt via project_resolve_by_name, then pass it on every call. Returns {task: null} when the project queue is empty.',
    annotations: {
      title: 'Worker: Next Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: {
          type: 'string',
          description:
            'Worker identifier (e.g. "agent-1"). Stored in task.assigned_to so the board shows who is working on what.',
        },
        project_id: {
          type: 'integer',
          description:
            'ID of the project to claim work from (REQUIRED). Get it once via project_resolve_by_name from the name in ./projectname.txt. Tasks from other projects are never returned.',
        },
      },
      required: ['worker_id'],
      // NOTE: project_id is intentionally NOT in `required`. If it were, the
      // MCP SDK would reject the call with a generic "inputSchema validation"
      // error BEFORE the handler runs, leaving the agent with no clue what to
      // do. Instead we let the call reach the handler, which throws an
      // actionable English error with the full resolution steps.
    },
  },
  {
    name: 'worker_done',
    description:
      'Complete the held task and free its assignment. Marks the task done by this worker (in_progress->review buffer, or review_in_progress->done on APPROVED), records the result as a comment, and clears assigned_to. Does NOT claim or return the next task — the response carries stop:true, a signal to stop work immediately. When the task reaches done, downstream dependencies are auto-unblocked and metadata.worktree.merged_into is set to "pending" (awaiting integration — the agent should then acquire the merge-lock via worker_merge_acquire, merge the task/<id> branch into the integration branch, and call worker_merge_release). For a task in review_in_progress, pass verdict="changes_requested" to return it to in_progress (the branch and its worktree stay in place for re-work) instead of approving it. Response includes active_tasks[]: a read-only snapshot of every other task currently in_progress or review, with its worker_id and worktree branch, so you know what your neighbours are doing.',
    annotations: {
      title: 'Worker: Complete',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task being completed' },
        worker_id: {
          type: 'string',
          description: 'Worker identifier (must match the task.assigned_to).',
        },
        result: {
          type: 'string',
          description:
            'What the worker did — recorded as a comment on the task (author = worker_id).',
        },
        verdict: {
          type: 'string',
          enum: ['approved', 'changes_requested'],
          description:
            "Only relevant when the task is in review. 'approved' (default) advances it to done. 'changes_requested' returns it to in_progress — the reviewer becomes the developer; the task/<id> branch and its worktree are NOT touched and survive the re-work loop. For an in_progress task this param is ignored.",
        },
      },
      required: ['task_id', 'worker_id', 'result'],
    },
  },
  {
    name: 'worker_ask_need',
    description:
      "Signal that you are blocked on a task and need a human answer BEFORE continuing. Use this RIGHT BEFORE calling the host's AskUserQuestion tool. Flags the task with the 'needs-human' tag so it pulses red (⚠) on the kanban board — the human sees which task is waiting. The task STAYS with you (assigned_to unchanged, status unchanged) — do NOT release it, do NOT take another task; your in-task context is expensive to rebuild. Pass an optional 'reason' to record what you're asking as a comment. After the human answers, call worker_ask_done to clear the flag and continue.",
    annotations: {
      title: 'Worker: Ask Human (block)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task you hold and are blocked on.' },
        worker_id: { type: 'string', description: 'Your worker_id (must match task.assigned_to).' },
        reason: {
          type: 'string',
          description: 'Optional: the question you are about to ask the human. Recorded as a comment (prefix "ASK:") so it is visible on the task, not only in the AskUserQuestion UI.',
        },
      },
      required: ['task_id', 'worker_id'],
    },
  },
  {
    name: 'worker_ask_done',
    description:
      "Clear the 'needs-human' flag after the human answered your question. Call this RIGHT AFTER receiving the answer (before resuming work). The task was never released — you keep working on it. After this, finish the task normally with worker_done.",
    annotations: {
      title: 'Worker: Ask Human (clear)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task you hold.' },
        worker_id: { type: 'string', description: 'Your worker_id (must match task.assigned_to).' },
      },
      required: ['task_id', 'worker_id'],
    },
  },
  {
    name: 'worker_merge_acquire',
    description:
      'Acquire the global merge-lock for this project so you can merge a task\'s task/<id> branch into the integration branch (dev) without colliding with another worker merging at the same time. Call this AFTER worker_done returns completed_new_status="done" (APPROVED) and BEFORE running git merge. Only ONE worker per project holds the lock at a time; if it is busy, returns granted:false with held_by (who holds it and for how long) and retry_after_ms — loop with a small sleep until granted. The lock auto-expires after 10 minutes (reclaimable if a worker died holding it). Saga itself does NOT run git — you run the merge in your own process once granted.',
    annotations: {
      title: 'Worker: Merge Lock (acquire)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the done task whose branch you are about to merge.' },
        worker_id: { type: 'string', description: 'Your worker_id.' },
      },
      required: ['task_id', 'worker_id'],
    },
  },
  {
    name: 'worker_merge_release',
    description:
      'Release the merge-lock you hold and record the outcome of integrating task/<id> into the integration branch. Call this AFTER running git merge (success: result="merged", pass the resulting commit sha) or after a merge CONFLICT (result="conflict", abort the merge first). On "merged", sets metadata.worktree.merged_into="dev" — work is integrated. On "conflict", sets merged_into="conflict" and flags the task needs-human (it pulses red on the board); the task stays done, the worktree and branch are kept so a human can resolve. Only the lock holder may release. If you crashed mid-merge, the lock will expire after 10 minutes and another worker can reclaim it.',
    annotations: {
      title: 'Worker: Merge Lock (release)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'ID of the task whose branch you merged (or failed to merge).' },
        worker_id: { type: 'string', description: 'Your worker_id (must match the merge-lock holder).' },
        result: { type: 'string', enum: ['merged', 'conflict'], description: 'Outcome of the git merge.' },
        commit_sha: { type: 'string', description: 'Optional: the merge commit sha when result="merged" (recorded for audit).' },
      },
      required: ['task_id', 'worker_id', 'result'],
    },
  },
  {
    name: 'worker_health',
    description:
      'Read-only check for stuck worktrees in a project. Returns three lists: zombies (in_progress tasks idle > 30 min — a worker may have died holding them), never_merged (done tasks whose branch was never merged into dev, or is still "pending" — work that could be lost), and stuck_merges (done tasks whose merge conflicted and need human resolution). Use this from a watcher/orchestrator, or a worker noticing the queue stalled, to find orphaned worktrees. Saga does NOT delete anything — worktrees may hold another worker\'s uncommitted work; a human decides.',
    annotations: {
      title: 'Worker: Health (stuck worktrees)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project to scan. Resolve it once via project_resolve_by_name from ./projectname.txt.' },
      },
      required: ['project_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  worker_next: handleWorkerNext,
  worker_done: handleWorkerDone,
  worker_ask_need: handleWorkerAskNeed,
  worker_ask_done: handleWorkerAskDone,
  worker_merge_acquire: handleWorkerMergeAcquire,
  worker_merge_release: handleWorkerMergeRelease,
  worker_health: handleWorkerHealth,
};
