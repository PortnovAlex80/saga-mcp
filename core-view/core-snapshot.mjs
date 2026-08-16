// core-snapshot.mjs — сборка снапшота ядра завода (GET /api/core/snapshot).
//
// Этот модуль также несёт общие low-level хелперы (withCoreDb / parseTs /
// toIso / placeholders), которые переиспользуют core-projects / core-events /
// core-cell — чтобы не плодить файлы вне списка исполнителя A.
//
// ЖЕЛЕЗНО: БД открывается better-sqlite3 строго {readonly:true} и на каждый
// запрос; никакие INSERT/UPDATE/CREATE в core-view не существуют в принципе.
// Схема-расхождения, найденные выборками на живом тестбеде (см. README):
//   * projects → lifecycle: factory_order_runs ПУСТА, актуальная связь —
//     factory_orders.lifecycle_run_id; берём последний lifecycle-ран проекта
//     (max id), что совпадает с руной актуального ордера на живых данных;
//   * factory_workplace_dependencies: колонок from/to нет — реальная пара
//     (workplace_ref, depends_on_workplace_ref) → {from: depends_on, to: workplace};
//   * factory_transition_obligations.kind ← handoff_kind (реальные значения
//     run-gate / run-effects / route-lifecycle / …, а не абстрактное "transition");
//   * obligations: лампе прогресса нужен АКТИВНЫЙ долг — берём последнюю по
//     updated_at запись с state != 'completed' (completed = долга нет).

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveRepairReason } from './core-cell.mjs';

import { isProcessAlive, statLog, computeTokPerSec } from './log-tail.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const CORE_VIEW_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(CORE_VIEW_DIR, '..');

/** Путь к БД: env CORE_VIEW_DB либо тестбед по умолчанию. */
export function resolveDbPath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CORE_VIEW_DB) return path.resolve(process.env.CORE_VIEW_DB);
  return path.join(REPO_ROOT, '.factory-testbed', 'factory.sqlite');
}

/** Открыта ли БД в принципе (существует файлом и не bak-снапшот). */
export function dbAvailable(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') return false;
  const base = path.basename(dbPath);
  if (base.includes('.bak-') || base.endsWith('.bak')) return false; // никогда не открывать бэкапы
  return existsSync(dbPath);
}

/** Открыть readonly-соединение на один запрос. fn(db) → результат.
 *  Бросает ошибку наружу — эндпоинт завернёт её в {ok:false,error}. */
export function withCoreDb(dbPath, fn) {
  if (!dbAvailable(dbPath)) {
    throw new Error('database unavailable: ' + dbPath);
  }
  const db = new Database(dbPath, { readonly: true, timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// --- Время -------------------------------------------------------------------
// В БД два формата: 'YYYY-MM-DD HH:MM:SS' (локальные таблицы; это UTC без T/Z —
// см. комментарий к parseTs в tracker-view/shared.mjs) и ISO с Z
// (worker_executions.heartbeat_at, candidate_sets.sealed_at). Всё нормализуем
// в ISO-строку с Z; при парсинге не падаем.

export function parseTs(value) {
  if (!value) return null;
  let s = String(value);
  if (s.indexOf('T') < 0) s = s.replace(' ', 'T');
  if (s.indexOf('Z') < 0 && /[+-]\d\d:?\d\d$/.test(s) === false) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export function toIso(value) {
  const ms = parseTs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export function ageMs(value, nowMs = Date.now()) {
  const ms = parseTs(value);
  return ms === null ? null : Math.max(0, nowMs - ms);
}

// --- Мелкие SQL-хелперы -------------------------------------------------------

export function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Безопасный JSON.parse → объект | null. */
export function parseJsonSafe(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}

function rowValue(row, key) { return row == null ? undefined : row[key]; }

// --- Выбор проекта ------------------------------------------------------------

/** id самого последнего активного проекта: max(worker_executions.heartbeat_at),
 *  при отсутствии executions — самый свежий lifecycle_runs.updated_at,
 *  иначе max(projects.id). */
export function pickDefaultProjectId(db) {
  const byHeartbeat = db.prepare(
    `SELECT project_id, max(heartbeat_at) AS hb
       FROM worker_executions GROUP BY project_id ORDER BY hb DESC LIMIT 1`,
  ).get();
  if (byHeartbeat && byHeartbeat.project_id != null && byHeartbeat.hb != null) {
    return byHeartbeat.project_id;
  }
  const byLifecycle = db.prepare(
    `SELECT project_id FROM factory_lifecycle_runs
      WHERE project_id IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).get();
  if (byLifecycle && byLifecycle.project_id != null) return byLifecycle.project_id;
  const anyProject = db.prepare('SELECT max(id) AS id FROM projects').get();
  return anyProject ? anyProject.id : null;
}

/** lifecycle-рана проекта: последняя по id (factory_orders.lifecycle_run_id
 *  указывает на неё же на живых данных; factory_order_runs пуста — см. шапку). */
export function fetchLifecycle(db, projectId) {
  const run = db.prepare(
    `SELECT id, status, current_stage_id, terminal_status, updated_at
       FROM factory_lifecycle_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(projectId);
  if (!run) return null;
  const stages = db.prepare(
    `SELECT id, stage_id, module_name, module_version, status, attempt,
            local_outcome, started_at, completed_at
       FROM factory_stage_runs WHERE lifecycle_run_id = ?
      ORDER BY ordinal, attempt, id`,
  ).all(run.id);
  return {
    runId: run.id,
    status: run.status ?? null,
    currentStageId: run.current_stage_id ?? null,
    terminalStatus: run.terminal_status ?? null,
    updatedAt: toIso(run.updated_at),
    stages: stages.map(s => ({
      stageRunId: s.id,
      stageId: s.stage_id,
      name: `${s.module_name}@${s.module_version}`,
      status: s.status,
      attempt: s.attempt ?? 1,
      outcome: s.local_outcome ?? null,
      startedAt: toIso(s.started_at),
      completedAt: toIso(s.completed_at),
    })),
  };
}

// --- Воркеры ------------------------------------------------------------------

const LIVE_WORKER_STATES = ['running', 'cancel_requested', 'reserved'];

/** Обогащение строки worker_executions до контракта workers[] из snapshot. */
export function decorateWorker(row, nowMs = Date.now()) {
  const startedAtMs = parseTs(row.started_at);
  const heartbeatAt = row.heartbeat_at ? toIso(row.heartbeat_at) : null;
  const heartbeatAge = heartbeatAt == null ? null : ageMs(row.heartbeat_at, nowMs);
  const localMachine = row.machine_id == null || row.machine_id === os.hostname();
  const alive = localMachine ? isProcessAlive(row.pid) : false;
  const logInfo = statLog(row.log_path);
  const logMtimeAgeMs = logInfo ? Math.max(0, nowMs - logInfo.mtimeMs) : null;
  const tokPerSec = row.state === 'exited'
    ? null
    : computeTokPerSec({ logPath: row.log_path, startedAtMs });
  // stale: лог молчит дольше 30 с (паттерн is_quiet из /api/workers/active);
  // null — лога нет/недоступен, честное «не знаем».
  const stale = logMtimeAgeMs == null ? null : logMtimeAgeMs > 30_000;
  return {
    executionId: row.execution_id,
    projectId: row.project_id ?? null,
    taskId: row.task_id ?? null,
    state: row.state ?? null,
    phase: row.phase ?? null,
    pid: row.pid ?? null,
    startedAt: toIso(row.started_at),
    heartbeatAt,
    heartbeatAgeMs: heartbeatAge,
    alive,
    tokPerSec,
    logPath: logInfo ? logInfo.path : (row.log_path ?? null),
    logMtimeAgeMs,
    stale,
  };
}

/** Компактный worker для карточки workplace (контракт snapshot.workplaces[].worker). */
export function workerForWorkplace(row, nowMs = Date.now()) {
  if (!row) return null;
  const full = decorateWorker(row, nowMs);
  return {
    executionId: full.executionId,
    state: full.state,
    phase: full.phase,
    pid: full.pid,
    heartbeatAt: full.heartbeatAt,
    heartbeatAgeMs: full.heartbeatAgeMs,
    alive: full.alive,
  };
}

// --- Обогащение workplaces (общее для snapshot и cell) -------------------------

/** Все executions проекта: map taskId → {live, last} (живой running/
 *  cancel_requested, иначе последний по started_at/rowid). */
function executionsByTask(db, projectId) {
  const rows = db.prepare(
    `SELECT * FROM worker_executions WHERE project_id = ? ORDER BY started_at, rowid`,
  ).all(projectId);
  const map = new Map();
  for (const row of rows) {
    const taskId = row.task_id;
    if (taskId == null) continue;
    const entry = map.get(taskId) || { live: null, last: null };
    if (LIVE_WORKER_STATES.includes(row.state)) entry.live = row;
    entry.last = row; // строки идут в порядке старта — последняя выигрывает
    map.set(taskId, entry);
  }
  return map;
}

/** Обогатить массив строк factory_workplaces до контракта snapshot.workplaces[]. */
export function decorateWorkplaces(db, workplaceRows) {
  if (!workplaceRows.length) {
    return { workplaces: [], dependencies: [] };
  }
  const refs = workplaceRows.map(w => w.workplace_ref);
  const nowMs = Date.now();
  const inRefs = placeholders(refs.length);

  // task_id ↔ workplace_ref. На живой БД есть ДВЕ связи:
  //  1) tasks.workplace_ref — каноническая, покрывает ВСЕ ячейки
  //     (например development-plan-task-graph/singleton ↔ task 71);
  //  2) factory_workplace_graph_items — только графы implementation-воркплейсов.
  // Берём (1) как основную, (2) как fallback; при нескольких задачах ячейки —
  // max(id) (актуальная).
  const taskRows = db.prepare(
    `SELECT workplace_ref, max(id) AS task_id
       FROM tasks
      WHERE workplace_ref IN (${inRefs}) GROUP BY workplace_ref`,
  ).all(...refs);
  const taskByRef = new Map(taskRows.map(r => [r.workplace_ref, r.task_id]));
  const graphTaskRows = db.prepare(
    `SELECT workplace_ref, max(task_id) AS task_id
       FROM factory_workplace_graph_items
      WHERE workplace_ref IN (${inRefs}) GROUP BY workplace_ref`,
  ).all(...refs);
  for (const r of graphTaskRows) {
    if (!taskByRef.has(r.workplace_ref) && r.task_id != null) taskByRef.set(r.workplace_ref, r.task_id);
  }

  // Активные обязательства: последняя по updated_at запись с state != 'completed'
  const obligationRows = db.prepare(
    `SELECT subject_ref, handoff_kind, state, attempt, lease_owner, last_error, updated_at
       FROM factory_transition_obligations
      WHERE subject_ref IN (${inRefs}) AND state != 'completed'
      ORDER BY updated_at`,
  ).all(...refs);
  const obligationByRef = new Map();
  for (const o of obligationRows) obligationByRef.set(o.subject_ref, o);

  // Гейты: агрегаты + последнее решение (max decided_at; при равенстве — rowid)
  const gateRows = db.prepare(
    `SELECT rowid, workplace_ref, gate_phase, verdict, decided_at,
            gate_run_ref, assessment_candidate_set_refs
       FROM factory_gate_decisions
      WHERE workplace_ref IN (${inRefs})
      ORDER BY decided_at, rowid`,
  ).all(...refs);
  const gateAgg = new Map(); // ref → { n, repairs, last }
  for (const g of gateRows) {
    const agg = gateAgg.get(g.workplace_ref) || { n: 0, repairs: 0, last: null, lastRepair: null };
    agg.n += 1;
    if (g.verdict === 'repair_required') { agg.repairs += 1; agg.lastRepair = g; }
    agg.last = g;
    gateAgg.set(g.workplace_ref, agg);
  }

  const candidateRows = db.prepare(
    `SELECT workplace_ref, count(*) AS n
       FROM factory_candidate_sets
      WHERE workplace_ref IN (${inRefs}) GROUP BY workplace_ref`,
  ).all(...refs);
  const candidateByRef = new Map(candidateRows.map(r => [r.workplace_ref, r.n]));

  // executions по задачам проекта (graph_items дают task_id, но executions
  // ссылаются на project_id — берём проект из строк workplaces)
  const processRunIds = [...new Set(workplaceRows.map(w => w.process_run_id).filter(id => id != null))];
  const execByTask = new Map();
  if (processRunIds.length) {
    // процесс-раны → project_id (уникальные, чтобы не перечитывать executions)
    const prRows = db.prepare(
      `SELECT DISTINCT project_id FROM factory_process_runs
        WHERE id IN (${placeholders(processRunIds.length)}) AND project_id IS NOT NULL`,
    ).all(...processRunIds);
    for (const pr of prRows) {
      for (const [taskId, entry] of executionsByTask(db, pr.project_id)) {
        execByTask.set(taskId, entry);
      }
    }
  }

  const workplaces = workplaceRows.map(w => {
    const taskId = taskByRef.get(w.workplace_ref) ?? null;
    const execEntry = taskId != null ? execByTask.get(taskId) : null;
    const workerRow = execEntry ? (execEntry.live || execEntry.last) : null;
    const obligationRow = obligationByRef.get(w.workplace_ref) || null;
    const gates = gateAgg.get(w.workplace_ref);
    const lastGateRow = gates ? gates.last : null;
    return {
      workplaceRef: w.workplace_ref,
      processRunId: w.process_run_id ?? null,
      moduleRef: w.module_ref ?? null,
      productionCellId: w.production_cell_id ?? null,
      workKey: w.work_key ?? null,
      taskId,
      kanbanPhase: w.kanban_phase ?? null,
      loopState: w.loop_state ?? null,
      nextRole: w.next_role ?? null,
      terminalReason: w.terminal_reason ?? null,
      revision: w.revision ?? 0,
      createdAt: toIso(w.created_at),
      updatedAt: toIso(w.updated_at),
      obligation: obligationRow ? {
        kind: obligationRow.handoff_kind ?? null,
        state: obligationRow.state ?? null,
        leaseOwner: obligationRow.lease_owner ?? null,
        attempt: obligationRow.attempt ?? null,
        lastError: obligationRow.last_error ?? null,
      } : null,
      worker: workerForWorkplace(workerRow, nowMs),
      lastRepair: gates && gates.lastRepair ? {
        at: toIso(gates.lastRepair.decided_at),
        reason: repairReasonShort(resolveRepairReason(db, gates.lastRepair)),
      } : null,
      lastGate: lastGateRow ? {
        gatePhase: lastGateRow.gate_phase ?? null,
        verdict: lastGateRow.verdict ?? null,
        decidedAt: toIso(lastGateRow.decided_at),
      } : null,
      stats: {
        candidateSets: candidateByRef.get(w.workplace_ref) ?? 0,
        gateDecisions: gates ? gates.n : 0,
        repairs: gates ? gates.repairs : 0,
      },
    };
  });

  // Рёбра DAG: обе вершины должны быть в этом проекте (иначе лента не рисуется)
  const refSet = new Set(refs);
  const depRows = db.prepare(
    `SELECT workplace_ref, depends_on_workplace_ref
       FROM factory_workplace_dependencies
      WHERE workplace_ref IN (${inRefs})`,
  ).all(...refs);
  const seen = new Set();
  const dependencies = [];
  for (const d of depRows) {
    if (!refSet.has(d.depends_on_workplace_ref)) continue;
    const key = `${d.depends_on_workplace_ref}→${d.workplace_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push({ from: d.depends_on_workplace_ref, to: d.workplace_ref });
  }

  return { workplaces, dependencies };
}

// --- Снапшот -------------------------------------------------------------------

/** GET /api/core/snapshot?project=<id> — главный ответ для L1. */
export function buildSnapshot(db, { projectId } = {}) {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  let pid = projectId;
  if (pid == null || !Number.isFinite(Number(pid))) {
    pid = pickDefaultProjectId(db);
  } else {
    pid = Number(pid);
  }
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(pid) || null;
  if (!project) {
    const error = `project not found: ${pid}`;
    return { ok: false, error };
  }

  const epicRow = db.prepare(
    'SELECT max(id) AS id FROM epics WHERE project_id = ?',
  ).get(project.id);

  const lifecycle = fetchLifecycle(db, project.id);

  const workplaceRows = db.prepare(
    `SELECT w.* FROM factory_workplaces w
       JOIN factory_process_runs pr ON pr.id = w.process_run_id
      WHERE pr.project_id = ?
      ORDER BY w.created_at, w.workplace_ref`,
  ).all(project.id);

  const { workplaces, dependencies } = decorateWorkplaces(db, workplaceRows);
  const refs = workplaces.map(w => w.workplaceRef);

  // Живые воркеры проекта (топ-уровень)
  const inRefs = refs.length ? placeholders(refs.length) : null;
  const liveWorkerRows = db.prepare(
    `SELECT * FROM worker_executions
      WHERE project_id = ? AND state IN ('running','cancel_requested','reserved')
      ORDER BY started_at`,
  ).all(project.id);
  const workers = liveWorkerRows.map(r => decorateWorker(r, nowMs));

  // Счётчики — в рамках проекта (capsules имеют project_id, остальное — через
  // множество workplaces проекта)
  const counters = {};
  const capsuleCount = db.prepare(
    'SELECT count(*) AS n FROM factory_replay_capsules WHERE project_id = ?',
  ).get(project.id);
  counters.replayCapsules = capsuleCount ? capsuleCount.n : 0;

  if (refs.length) {
    const acceptanceCount = db.prepare(
      `SELECT count(*) AS n FROM factory_cell_final_acceptances WHERE workplace_ref IN (${inRefs})`,
    ).get(...refs);
    counters.finalAcceptances = acceptanceCount ? acceptanceCount.n : 0;
    counters.candidateSets = db.prepare(
      `SELECT count(*) AS n FROM factory_candidate_sets WHERE workplace_ref IN (${inRefs})`,
    ).get(...refs).n;
    counters.gateDecisions = db.prepare(
      `SELECT count(*) AS n FROM factory_gate_decisions WHERE workplace_ref IN (${inRefs})`,
    ).get(...refs).n;
  } else {
    counters.finalAcceptances = 0;
    counters.candidateSets = 0;
    counters.gateDecisions = 0;
  }
  const recoveryCount = db.prepare(
    `SELECT count(*) AS n FROM factory_recovery_cases
      WHERE process_run_id IN (SELECT id FROM factory_process_runs WHERE project_id = ?)`,
  ).get(project.id);
  counters.recoveryCases = recoveryCount ? recoveryCount.n : 0;

  // Пульс: самый свежий из наблюдаемых маркеров активности проекта
  const heartbeatRow = db.prepare(
    'SELECT max(heartbeat_at) AS hb FROM worker_executions WHERE project_id = ?',
  ).get(project.id);
  const markers = [
    heartbeatRow ? heartbeatRow.hb : null,
    lifecycle ? lifecycle.updatedAt : null,
  ];
  let lastActivityAt = null;
  for (const w of workplaces) {
    markers.push(w.updatedAt);
    if (w.lastGate) markers.push(w.lastGate.decidedAt);
  }
  for (const m of markers) {
    const ms = parseTs(m);
    if (ms != null && (lastActivityAt == null || ms > lastActivityAt)) lastActivityAt = ms;
  }

  // activityPerMin: события последней минуты (гейты + запечатанные кандидаты).
  // decided_at и sealed_at в РАЗНЫХ форматах ('... HH:MM:SS' vs ISO-Z), поэтому
  // сравнение только в JS через parseTs — строковое сравнение в SQLite дало бы
  // ложные срабатывания ('T' > ' ').
  let activityPerMin = 0;
  if (refs.length) {
    const minuteAgoMs = nowMs - 60_000;
    const recentGates = db.prepare(
      `SELECT decided_at FROM factory_gate_decisions
        WHERE workplace_ref IN (${inRefs}) ORDER BY decided_at DESC LIMIT 100`,
    ).all(...refs);
    const recentCandidates = db.prepare(
      `SELECT sealed_at FROM factory_candidate_sets
        WHERE workplace_ref IN (${inRefs}) ORDER BY sealed_at DESC LIMIT 100`,
    ).all(...refs);
    for (const r of [...recentGates, ...recentCandidates]) {
      const ms = parseTs(r.decided_at ?? r.sealed_at);
      if (ms != null && ms >= minuteAgoMs) activityPerMin += 1;
    }
  }

  return {
    ok: true,
    now,
    project: {
      id: project.id,
      name: project.name,
      epicId: epicRow ? epicRow.id : null,
    },
    lifecycle,
    workplaces,
    dependencies,
    workers,
    counters,
    pulse: {
      lastActivityAt: lastActivityAt == null ? null : new Date(lastActivityAt).toISOString(),
      activityPerMin,
    },
  };
}

// Короткая причина возврата для тултипов (одна строка).
function repairReasonShort(r) {
  if (!r) return null;
  if (r.summary) return String(r.summary).slice(0, 160);
  if (r.source === 'review') return 'ревью: ' + (r.reviewVerdict || 'без текста');
  if (r.source === 'checks' && r.checksFailed) {
    return 'провален чек: ' + r.checksFailed.map(c => c.phrase || c.provider).join(', ').slice(0, 160);
  }
  return null;
}
