import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { assertExecutionFence, updateExecutionPhase } from '../worker-executions.js';
import { reevaluateDownstream } from './tasks.js';
import type { Task, ToolHandler } from '../types.js';
import { generateNextForCompletedTask } from './workflow.js';
import { advanceReadyEpisodes } from './lifecycle.js';

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
// Exported so other handlers (e.g. task_update RMW sequence) can wrap their
// own read-modify-write critical sections in the same atomic boundary.
export function withImmediateTransaction<T>(db: Database.Database, fn: () => T): T {
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

type WorkerSkill = string;

/** Central workflow routing with a strict legacy fallback. */
function skillForTask(task: Task, sourceStatus: string): WorkerSkill {
  const review = sourceStatus === 'review' || sourceStatus === 'review_in_progress';
  if (review && task.review_skill) return task.review_skill;
  if (!review && task.execution_skill) return task.execution_skill;

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(task.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.filter((value): value is string => typeof value === 'string');
  } catch { /* malformed legacy tags: use status fallback */ }
  const explicit = tags.find(tag => tag.startsWith(review ? 'review-skill:' : 'skill:'));
  if (explicit) return explicit.slice(explicit.indexOf(':') + 1);
  if (!review) {
    const role = tags.find(tag => tag.startsWith('role:'))?.slice('role:'.length);
    if (role) return `saga-${role}`;
  }
  return review ? 'saga-reviewer' : 'saga-developer';
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
       WHERE e.project_id=? AND t.status IN ('in_progress','review_in_progress')
         AND t.assigned_to IS NOT NULL
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
  role?: string,
  epicId?: number,
  reservation?: {
    executionId: string;
    runId: string;
    machineId: string;
  },
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
  //
  //    role (опционально): фильтр по тегу `role:<name>` (например role:analyst).
  //    Теги хранятся JSON-массивом; json_each разворачивает, EXISTS проверяет.
  //    Без role — обратная совместимость: любой тег подходит.
  const excludeClause = excludeTaskId !== undefined ? 'AND t.id != ?' : '';
  const roleClause = role ? `AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?)` : '';
  const epicClause = epicId !== undefined ? 'AND t.epic_id = ?' : '';
  const selectSql = `
    SELECT t.* FROM tasks t
    WHERE t.status IN ('todo', 'review')
      AND (t.assigned_to IS NULL OR t.assigned_to = '')
      AND t.priority IN ('critical', 'high', 'medium')
      AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ?)
      ${epicClause}
      AND (
        t.workflow_stage IS NULL
        OR NOT EXISTS (SELECT 1 FROM episode_workflows ew WHERE ew.epic_id=t.epic_id)
        OR EXISTS (
          SELECT 1 FROM episode_workflows ew
          WHERE ew.epic_id=t.epic_id AND ew.stage=t.workflow_stage
        )
      )
      ${excludeClause}
      ${roleClause}
      AND t.current_execution_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM worker_executions we
        WHERE we.task_id=t.id AND we.state IN ('reserved','running','cancel_requested')
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id AND (
          dep.status != 'done'
          OR (
            dep.task_kind IS NOT NULL
            AND dep.execution_mode = 'git_change'
            AND dep.integration_state != 'merged'
          )
        )
      )
    ORDER BY ${PRIORITY_ORDER}, t.created_at
    LIMIT 1
  `;
  // Сбор параметров в порядке появления ? в SQL.
  const params: unknown[] = [projectId];
  if (epicId !== undefined) params.push(epicId);
  if (excludeTaskId !== undefined) params.push(excludeTaskId);
  if (role) params.push(`role:${role}`);
  const task = db.prepare(selectSql).get(...params) as Task | undefined;

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
         `UPDATE tasks SET status='in_progress', assigned_to=?, current_execution_id=?,
                           updated_at=datetime('now')
          WHERE id=? AND status='todo' AND (assigned_to IS NULL OR assigned_to = '')`,
       )
      .run(workerId, reservation?.executionId ?? null, task.id);
  } else {
    // Цикл ревью: задача из буфера review (ждёт ревьюера) переходит в
    // review_in_progress (ревьюер работает). Зеркало todo→in_progress для
    // ревью-фазы. assigned_to = reviewer.
    info = db
      .prepare(
         `UPDATE tasks SET status='review_in_progress', assigned_to=?, current_execution_id=?,
                           updated_at=datetime('now')
          WHERE id=? AND status='review' AND (assigned_to IS NULL OR assigned_to = '')`,
       )
      .run(workerId, reservation?.executionId ?? null, task.id);
  }

  // 3. Кто-то успел занять под носом — ищем следующего кандидата,
  //    с ограничением попыток (см. MAX_CLAIM_ATTEMPTS выше). projectId и role пробрасываем.
  if (info.changes !== 1) {
    return findNextClaimable(
      db, workerId, projectId, excludeTaskId, attempt + 1, role, epicId, reservation,
    );
  }

  if (reservation) {
    db.prepare(
      `INSERT INTO worker_executions
        (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,phase)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      reservation.executionId,
      reservation.runId,
      projectId,
      task.epic_id,
      task.id,
      workerId,
      reservation.machineId,
      task.status === 'review' ? 'reviewing' : 'executing',
    );
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
  repository?: {
    id: number;
    repository_id: number;
    name: string;
    local_path: string | null;
    role: string;
    integration_branch: string;
    default_branch: string;
  } | null;
  active_tasks?: Array<{
    task_id: number;
    title: string;
    assigned_to: string;
    status: string;
    branch: string;
    epic_name: string;
  }>;
  reason?: string;
  execution_id?: string;
} {
  const db = getDb();
  const workerId = args.worker_id as string;
  const machineId = args.machine_id == null ? null : String(args.machine_id);

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
  advanceReadyEpisodes(projectId);

  // role (опционально): фильтрует очередь по тегу `role:<name>` на задаче.
  // Применение: проект требований, где задачи тегированы role:product / role:analyst
  // / role:architect — каждый агент получает только свои задачи. Без role — любое.
  const role = args.role as string | undefined;
  const epicId = args.epic_id as number | undefined;
  if (epicId !== undefined) {
    const epic = db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId) as
      | { project_id: number }
      | undefined;
    if (!epic || epic.project_id !== projectId) {
      throw new Error(`epic_id ${epicId} does not belong to project ${projectId}`);
    }
  }
  const executionId = args.execution_id as string | undefined;
  const runId = args.run_id as string | undefined;
  if (executionId && !machineId) {
    throw new Error('machine_id is required when execution_id is provided');
  }
  const reservation = executionId
    ? {
        executionId,
        runId: runId ?? executionId,
        machineId: machineId ?? 'unknown',
      }
    : undefined;

  // BEGIN IMMEDIATE — write-lock всей БД с старта транзакции
  // (аналог SELECT FOR UPDATE, которого нет в SQLite). busy_timeout=5000 в db.ts.
  // db.transaction(fn) тут только DEFERRED, поэтому оборачиваем явно.
  const task = withImmediateTransaction(db, () =>
    findNextClaimable(db, workerId, projectId, undefined, 0, role, epicId, reservation),
  );

  // active_tasks — read-only снапшот параллельной работы. Берём ПОСЛЕ транзакции,
  // чтобы не держать write-lock дольше необходимого: видимость — best-effort,
  // minor staleness приемлем.
  const active_tasks = getActiveTasks(db, projectId);

  if (!task) return { task: null, skill: null, repository: null, active_tasks, reason: 'очередь пуста' };
  const repository = task.project_repository_id == null ? null : db.prepare(`
    SELECT pr.id, pr.repository_id, r.name,
           COALESCE(rc.local_path,pr.local_path) AS local_path, pr.role,
           pr.integration_branch, r.default_branch
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
      LEFT JOIN repository_checkouts rc
        ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
     WHERE pr.id=? AND pr.project_id=?
  `).get(machineId, task.project_repository_id, projectId) as {
    id: number; repository_id: number; name: string; local_path: string | null;
    role: string; integration_branch: string; default_branch: string;
  } | undefined;
  if (task.project_repository_id != null && !repository) {
    throw new Error(`Task ${task.id} targets missing or foreign project_repository_id=${task.project_repository_id}`);
  }
  return {
    task,
    skill: skillForTask(task, task.status),
    repository: repository ?? null,
    active_tasks,
    execution_id: executionId,
  };
}

function handleWorkerDone(args: Record<string, unknown>): {
  completed: number;
  completed_new_status: 'review' | 'done' | 'todo';
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
  workflow_generation?: unknown;
  workflow_generation_error?: string;
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
    const task = db
      .prepare('SELECT * FROM tasks WHERE id=? AND assigned_to=?')
      .get(taskId, workerId) as Task | undefined;
    if (!task) {
      throw new Error(`Task ${taskId} not assigned to ${workerId}`);
    }
    assertExecutionFence(
      db,
      task as Task & { current_execution_id?: string | null },
      args.execution_id,
    );

    // 2. Следующий статус по ТЕКУЩЕМУ статусу (он сам = флаг цикла) + verdict.
    let newStatus: 'review' | 'done' | 'todo';
    let newAssignedTo: string | null; // кому уходит задача после перевода
    if (task.status === 'in_progress') {
      newStatus = 'review';            // цикл разработки завершён → буфер ревью
      newAssignedTo = null;            // в очереди на ревью (без исполнителя)
    } else if (task.status === 'review_in_progress') {
      if (verdict === 'changes_requested') {
        newStatus = 'todo';            // single-use reviewer exits; a developer reclaims it
        newAssignedTo = null;
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
    if (newStatus === 'done' && task.task_kind === 'verification.ac') {
      const target = db.prepare(
        `SELECT a.id, a.accepted_hash
         FROM tasks t JOIN artifacts a ON a.id=t.verification_target_artifact_id
         WHERE t.id=? AND a.type='AC' AND a.status='accepted'`,
      ).get(taskId) as { id: number; accepted_hash: string | null } | undefined;
      const passed = target && db.prepare(
        `SELECT 1 FROM verification_evidence
         WHERE task_id=? AND artifact_id=? AND outcome='passed' AND content_hash=?`,
      ).get(taskId, target.id, target.accepted_hash);
      if (!target || !passed) {
        throw new Error(
          `Verification task ${taskId} cannot be approved without passing evidence for its canonical AC`,
        );
      }
    }

    const completeInfo = db
      .prepare(
        `UPDATE tasks SET status=?, assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND assigned_to=? AND
               (current_execution_id IS NULL OR current_execution_id=?)`,
      )
      .run(newStatus, newAssignedTo, taskId, workerId, args.execution_id ?? null);

    // Если ни одна строка не обновлена — assigned_to изменился между SELECT и
    // UPDATE. Не продолжать: иначе вставим comment для чужой задачи и вернём
    // completed_new_status, хотя статус не сдвинулся (wrong result).
    if (completeInfo.changes !== 1) {
      throw new Error(
        `Task ${taskId} assignment changed before completion (expected owner ${workerId})`,
      );
    }
    if (newStatus === 'done') {
      let taskTags: string[] = [];
      try { taskTags = JSON.parse(task.tags || '[]') as string[]; } catch { taskTags = []; }
      if (taskTags.includes('needs-human')) {
        db.prepare('UPDATE tasks SET tags=? WHERE id=?')
          .run(JSON.stringify(taskTags.filter(tag => tag !== 'needs-human')), taskId);
      }
    }
    updateExecutionPhase(
      db,
      taskId,
      workerId,
      args.execution_id,
      newStatus === 'done' && task.task_kind && task.execution_mode === 'git_change'
        ? 'integrating'
        : 'finishing',
    );

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
      if (task.task_kind && task.execution_mode === 'git_change') {
        const repository = task.project_repository_id == null ? undefined : db.prepare(
          'SELECT integration_branch FROM project_repositories WHERE id=?',
        ).get(task.project_repository_id) as { integration_branch: string } | undefined;
        const mergeTarget = repository?.integration_branch ?? INTEGRATION_BRANCH_DEFAULT;
        db.prepare(
          `UPDATE tasks
           SET integration_state='pending', integrated_at=NULL, integrated_commit=NULL,
               updated_at=datetime('now')
           WHERE id=?`,
        ).run(taskId);
        patchWorktreeMeta(db, taskId, {
          branch: worktreeBranch(taskId),
          path: worktreePath(taskId),
          merge_target: mergeTarget,
          merged_into: 'pending',
          merged_commit: null,
          merge_conflict: false,
        });
      } else {
        // Legacy and non-git tasks keep the historical done-is-ready behavior.
        db.prepare(
          `UPDATE tasks SET integration_state='not_required', updated_at=datetime('now') WHERE id=?`,
        ).run(taskId);
      }
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
  const completed = withImmediateTransaction(db, completeTask);
  const completedTask = db.prepare(
    'SELECT task_kind, execution_mode, integration_state FROM tasks WHERE id=?',
  ).get(taskId) as { task_kind: string | null; execution_mode: string; integration_state: string } | undefined;
  if (
    completed.completed_new_status === 'done'
    && (!completedTask?.task_kind || completedTask.execution_mode !== 'git_change')
  ) {
    try {
      const generated = generateNextForCompletedTask(taskId);
      if (generated) completed.workflow_generation = generated;
    } catch (error) {
      completed.workflow_generation_error = error instanceof Error ? error.message : String(error);
      logActivity(db, 'task', taskId, 'updated', 'workflow_generation', null, 'failed',
        `Automatic downstream generation failed: ${completed.workflow_generation_error}`);
    }
  }
  return completed;
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
    .prepare('SELECT id, title, tags, current_execution_id FROM tasks WHERE id=? AND assigned_to=?')
    .get(taskId, workerId) as
      | { id: number; title: string; tags: string; current_execution_id: string | null }
      | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not assigned to ${workerId} (cannot flag a task you don't hold)`);
  }
  assertExecutionFence(db, task, args.execution_id);

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
    .prepare('SELECT id, title, tags, current_execution_id FROM tasks WHERE id=? AND assigned_to=?')
    .get(taskId, workerId) as
      | { id: number; title: string; tags: string; current_execution_id: string | null }
      | undefined;
  if (!task) {
    throw new Error(`Task ${taskId} not assigned to ${workerId}`);
  }
  assertExecutionFence(db, task, args.execution_id);

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

function readRepositoryMetadata(db: Database.Database, bindingId: number): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM project_repositories WHERE id=?').get(bindingId) as
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
    const task = db.prepare(
      `SELECT t.id, t.title, t.status, t.task_kind, t.project_repository_id,
              t.current_execution_id,
              pr.integration_branch
       FROM tasks t
       LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
       WHERE t.id=?`,
    ).get(taskId) as
      | { id: number; title: string; status: string; task_kind: string | null; project_repository_id: number | null; integration_branch: string | null; current_execution_id: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'done') {
      throw new Error(
        `Task ${taskId} status is '${task.status}' — merge-lock is only for tasks that reached 'done' (APPROVED). Wait until review is complete.`,
      );
    }
    assertExecutionFence(db, task, args.execution_id);

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project (epic missing)`);

    const repositoryScoped = task.task_kind != null && task.project_repository_id != null;
    const meta = repositoryScoped
      ? readRepositoryMetadata(db, task.project_repository_id!)
      : readProjectMetadata(db, projectId);
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
      if (repositoryScoped) {
        db.prepare('UPDATE project_repositories SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(meta), task.project_repository_id);
      } else {
        db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(meta), projectId);
      }
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
    const task = db.prepare(
      `SELECT t.id, t.title, t.status, t.tags, t.task_kind, t.project_repository_id,
              t.current_execution_id,
              pr.integration_branch
       FROM tasks t
       LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
       WHERE t.id=?`,
    ).get(taskId) as
      | { id: number; title: string; status: string; tags: string; task_kind: string | null; project_repository_id: number | null; integration_branch: string | null; current_execution_id: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    assertExecutionFence(db, task, args.execution_id);

    const projectIdRow = db
      .prepare('SELECT project_id FROM epics e JOIN tasks t ON t.epic_id=e.id WHERE t.id=?')
      .get(taskId) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    if (projectId == null) throw new Error(`Task ${taskId} has no project`);

    // Снять merge_lock, но ТОЛЬКО если он мой. Иначе чужой lock мог быть уже
    // отобран stale-логикой и передан другому — я не должен его трогать.
    const repositoryScoped = task.task_kind != null && task.project_repository_id != null;
    const meta = repositoryScoped
      ? readRepositoryMetadata(db, task.project_repository_id!)
      : readProjectMetadata(db, projectId);
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
    if (repositoryScoped) {
      db.prepare('UPDATE project_repositories SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(meta), task.project_repository_id);
    } else {
      db.prepare('UPDATE projects SET metadata=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(meta), projectId);
    }

    // Резолвим merged_into и (при конфликте) флагаем needs-human.
    if (outcome === 'merged') {
      const mergeTarget = task.integration_branch ?? INTEGRATION_BRANCH_DEFAULT;
      patchWorktreeMeta(db, taskId, { merged_into: mergeTarget, merged_commit: commitSha, merge_conflict: false });
      db.prepare(
        `UPDATE tasks
         SET integration_state='merged', integrated_at=datetime('now'), integrated_commit=?,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(commitSha, taskId);
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
      db.prepare(
        `UPDATE tasks
         SET integration_state='conflict', integrated_at=NULL, integrated_commit=NULL,
             updated_at=datetime('now')
         WHERE id=?`,
      ).run(taskId);
      // needs-human (как в worker_ask_need): задача остаётся done, но пульсирует
      // красным на канбане — человек разруливает мерж-конфликт руками.
      addTag(db, taskId, NEEDS_HUMAN_TAG);
    }

    logActivity(db, 'task', taskId, 'updated', 'merge_release', null, outcome,
      `Merge ${outcome === 'merged' ? `completed${commitSha ? ` (${commitSha.slice(0, 7)})` : ''}` : 'CONFLICT (flagged needs-human)'} by ${workerId} for task '${task.title}'`);
    updateExecutionPhase(db, taskId, workerId, args.execution_id, 'finishing');
    if (outcome === 'merged') {
      reevaluateDownstream(db, taskId);
    }
  });

  if (outcome === 'merged') {
    try {
      generateNextForCompletedTask(taskId);
    } catch (error) {
      logActivity(db, 'task', taskId, 'updated', 'workflow_generation', null, 'failed',
        `Automatic downstream generation after merge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
      'Claim the next available task for a worker WITHIN A PROJECT. Finds a free task (status todo or review, unassigned, no unmet dependencies, priority medium or above) in the given project only, atomically assigns it to the worker, and returns the task plus the skill the agent should use. Low-priority tasks are NOT handed out automatically (raise their priority to medium+ to make them claimable). Other projects in the shared DB are never touched. project_id is REQUIRED — resolve it once from ./projectname.txt via project_resolve_by_name, then pass it on every call. Optional `role` filters the queue to tasks tagged `role:<name>` (e.g. role:"analyst") — used in the requirements project to split work between saga-product / saga-analyst / saga-architect. Returns {task: null} when the project queue is empty.',
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
        role: {
          type: 'string',
          description:
            'Optional role filter — only return tasks carrying the tag `role:<value>` (e.g. pass "analyst" to match tag "role:analyst"). Used in the requirements project to dispatch to specialized agents (product/analyst/architect). Omit for any-tag (builders project default).',
        },
        machine_id: {
          type: 'string',
          description: 'Optional machine identifier used to resolve a machine-specific repository checkout.',
        },
        epic_id: { type: 'integer', description: 'Optional epic scope for an orchestration engine.' },
        execution_id: { type: 'string', description: 'Managed-runner execution fencing token.' },
        run_id: { type: 'string', description: 'Managed board-run identifier.' },
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
      'Complete the held task and free its assignment. Marks the task done by this worker (in_progress->review buffer, or review_in_progress->done on APPROVED), records the result as a comment, and clears assigned_to. Does NOT claim or return the next task — the response carries stop:true. For typed git_change tasks, approval records integration_state=pending: dependencies and downstream generation remain gated until worker_merge_release(result="merged"). Legacy and non-git tasks retain done-is-ready behavior. For a task in review_in_progress, verdict="changes_requested" returns it to the unassigned todo queue for a fresh developer execution.',
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
            "Only relevant when the task is in review. 'approved' (default) advances it to done. 'changes_requested' returns it to unassigned todo for a fresh developer execution; the task/<id> branch and worktree survive the re-work loop. For an in_progress task this param is ignored.",
        },
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
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
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
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
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
      },
      required: ['task_id', 'worker_id'],
    },
  },
  {
    name: 'worker_merge_acquire',
    description:
      'Acquire the merge-lock before integrating task/<id>. Typed repository tasks lock only their project_repository and use its integration_branch, so different repositories may merge concurrently. Legacy tasks retain the project-level dev lock. The lock auto-expires after 10 minutes.',
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
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
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
        execution_id: { type: 'string', description: 'Required fencing token for managed CLI tasks.' },
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
