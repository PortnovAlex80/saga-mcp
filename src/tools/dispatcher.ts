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
  return sourceStatus === 'review' ? 'saga-reviewer' : 'saga-developer';
}

// ============================================================================
// findNextClaimable — общий helper для worker_next и worker_done.
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
      AND t.assigned_to IS NULL
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
  //    между SELECT и UPDATE. WHERE ... AND assigned_to IS NULL это отсечёт.
  let info: Database.RunResult;
  if (task.status === 'todo') {
    // Цикл разработки: задача уходит в работу.
    info = db
      .prepare(
        `UPDATE tasks SET status='in_progress', assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND status='todo' AND assigned_to IS NULL`,
      )
      .run(workerId, task.id);
  } else {
    // Цикл ревью: статус НЕ трогаем (остаётся review) — иначе потеряем признак цикла.
    info = db
      .prepare(
        `UPDATE tasks SET assigned_to=?, updated_at=datetime('now')
         WHERE id=? AND status='review' AND assigned_to IS NULL`,
      )
      .run(workerId, task.id);
  }

  // 3. Кто-то успел занять под носом — ищем следующего кандидата,
  //    с ограничением попыток (см. MAX_CLAIM_ATTEMPTS выше). projectId пробрасываем.
  if (info.changes !== 1) {
    return findNextClaimable(db, workerId, projectId, excludeTaskId, attempt + 1);
  }

  // logActivity на назначение (вне цикла: статус/исполнитель сменились)
  const action = task.status === 'todo' ? 'status_changed' : 'updated';
  logActivity(
    db,
    'task',
    task.id,
    action,
    task.status === 'todo' ? 'status' : 'assigned_to',
    task.status === 'todo' ? task.status : null,
    task.status === 'todo' ? 'in_progress' : workerId,
    `Task '${task.title}' claimed by ${workerId} (from ${task.status})`,
  );

  return task;
}

// ============================================================================
// Handlers
// ============================================================================

function handleWorkerNext(args: Record<string, unknown>): {
  task: Task | null;
  skill: WorkerSkill | null;
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

  if (!task) return { task: null, skill: null, reason: 'очередь пуста' };
  return { task, skill: skillForStatus(task.status) };
}

function handleWorkerDone(args: Record<string, unknown>): {
  completed: number;
  completed_new_status: 'review' | 'done';
  next_task: Task | null;
  next_skill: WorkerSkill | null;
} {
  const db = getDb();
  const taskId = args.task_id as number;
  const workerId = args.worker_id as string;
  const result = args.result as string;

  const completeAndNext = (): ReturnType<typeof handleWorkerDone> => {
    // 1. Это моя задача? (assigned_to = worker_id)
    const task = db
      .prepare('SELECT * FROM tasks WHERE id=? AND assigned_to=?')
      .get(taskId, workerId) as Task | undefined;
    if (!task) {
      throw new Error(`Task ${taskId} not assigned to ${workerId}`);
    }

    // 2. Следующий статус по ТЕКУЩЕМУ статусу (он сам = флаг цикла).
    let newStatus: 'review' | 'done';
    if (task.status === 'in_progress') {
      newStatus = 'review'; // цикл разработки завершён
    } else if (task.status === 'review') {
      newStatus = 'done'; // цикл ревью завершён
    } else {
      throw new Error(
        `Task ${taskId} status '${task.status}' — nothing to complete`,
      );
    }

    // 3. Перевод статуса + очистка assigned_to — атомарно, одной командой.
    //    Так флаг занятости не «забудем» снять (риск из обсуждения).
    const completeInfo = db
      .prepare(
        `UPDATE tasks SET status=?, assigned_to=NULL, updated_at=datetime('now')
         WHERE id=? AND assigned_to=?`,
      )
      .run(newStatus, taskId, workerId);

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
      `Task '${task.title}' completed by ${workerId}: ${task.status} -> ${newStatus}`,
    );

    // 7. Сразу следующая задача — с excludeTaskId=taskId (anti-self-review).
    //    projectId выводим из epic_id текущей задачи (worker_done не принимает
  //    project_id параметром — он знает task_id, и проект тот же).
    const projectIdRow = db
      .prepare('SELECT project_id FROM epics WHERE id=?')
      .get(task.epic_id) as { project_id: number } | undefined;
    const projectId = projectIdRow?.project_id;
    const next =
      projectId != null
        ? findNextClaimable(db, workerId, projectId, taskId)
        : null;

    return {
      completed: taskId,
      completed_new_status: newStatus,
      next_task: next,
      next_skill: next ? skillForStatus(next.status) : null,
    };
  }; // end completeAndNext

  // BEGIN IMMEDIATE — сериализация писателей (db.transaction тут DEFERRED,
  // поэтому оборачиваем явно).
  return withImmediateTransaction(db, completeAndNext);
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
      'Complete the current task and get the next one in a single call. Marks the task done by this worker (in_progress->review, or review->done), records the result as a comment, frees the assignment, then claims and returns the next available task. When the task reaches done, downstream dependencies are auto-unblocked. Returns next_task: null when the queue is empty.',
    annotations: {
      title: 'Worker: Complete + Next',
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
      },
      required: ['task_id', 'worker_id', 'result'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  worker_next: handleWorkerNext,
  worker_done: handleWorkerDone,
};
