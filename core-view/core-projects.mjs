// core-projects.mjs — сводка всех проектов для L0 (GET /api/core/projects).
//
// Расхождение с экспресс-проверкой №4 из WORKSHOP-STATUS.md, найденное на живой
// БД: factory_order_runs ПУСТА (0 строк), поэтому join через неё даёт NULL.
// Актуальная связь — factory_orders.lifecycle_run_id; итог тот же, что в
// проверке №4, но без пустой таблицы: lifecycle = последний рун проекта
// (max factory_lifecycle_runs.id).

import { fetchLifecycle, toIso, parseTs } from './core-snapshot.mjs';

/** GET /api/core/projects — [{id,name,lifecycle,tasks,lastHeartbeatAt}]. */
export function buildProjects(db) {
  const now = new Date().toISOString();

  const rows = db.prepare(
    `SELECT p.id, p.name,
            (SELECT max(heartbeat_at) FROM worker_executions we WHERE we.project_id = p.id) AS hb
       FROM projects p
      ORDER BY p.id`,
  ).all();

  const projects = rows.map(p => {
    const lifecycle = fetchLifecycle(db, p.id);

    // Эпик = последний эпик проекта (та же конвенция, что в экспресс-проверке №4)
    const epic = db.prepare(
      'SELECT max(id) AS id FROM epics WHERE project_id = ?',
    ).get(p.id);
    let tasks = { total: 0, done: 0 };
    if (epic && epic.id != null) {
      const t = db.prepare(
        `SELECT count(*) AS total,
                sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
           FROM tasks WHERE epic_id = ?`,
      ).get(epic.id);
      if (t) tasks = { total: t.total ?? 0, done: t.done ?? 0 };
    }

    return {
      id: p.id,
      name: p.name,
      lifecycle,
      tasks,
      lastHeartbeatAt: parseTs(p.hb) == null ? null : toIso(p.hb),
    };
  });

  return { ok: true, now, projects };
}

/** GET /api/core/heartbeat — {ok, now, db:{path,exists}, projects:n}. */
export function buildHeartbeat(db, dbPath) {
  const now = new Date().toISOString();
  const row = db.prepare('SELECT count(*) AS n FROM projects').get();
  return {
    ok: true,
    now,
    db: { path: dbPath, exists: true },
    projects: row ? row.n : 0,
  };
}
