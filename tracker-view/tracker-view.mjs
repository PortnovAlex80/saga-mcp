// saga tracker viewer — мультипроектный канбан + мини-вики артефактов saga-mcp.
// Читает/пишет process.env.DB_PATH (ту же БД, что и сам saga-MCP; WAL → безопасно).
//   /                       → индекс всех проектов со счётчиками
//   /?project=<id>          → канбан конкретного saga-проекта
//   /?project=<id>&tab=artifacts → дерево артефактов с трассами
//   /?artifact=<id>         → wiki-просмотр артефакта (rendered markdown)
//   /artifact/<id>/edit     → wiki-редактор (.md + metadata)
//   /?registry=<TYPE>       → кросс-проектный реестр однотипных документов
//   /api/heartbeat          → JSON { last } — timestamp последней активности
//   POST /api/artifact/save → сохранить .md + metadata (JSON body)
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { handlers as dispatcherHandlers } from '../dist/tools/dispatcher.js';
import { handlers as repositoryHandlers } from '../dist/tools/repositories.js';
import { handlers as lifecycleHandlers } from '../dist/tools/lifecycle.js';
import { createClaudeBoardRunner } from './claude-runner.mjs';
import { isProcessAlive } from '../dist/worker-executions.js';
import { releaseExecutionAtomically } from '../dist/lifecycle/atomic-release.js';
import { getDb as ensureSagaDb, closeDb as closeSagaDb } from '../dist/db.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// better-sqlite3 уже стоит в node_modules форка (npm install). Берём оттуда.
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

// ОДИН источник данных — общая БД saga-mcp. Та же, что saga-MCP-сервер.
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH) {
  console.error('DB_PATH не задан. Укажите путь к saga.db (например, DB_PATH=C:/Users/<вы>/.zcode/saga.db).');
  process.exit(1);
}
// Файл saga.db создаётся лениво MCP-сервером при первом вызове инструмента.
// Если tracker-view запускается первым (свежая установка, ручной `npm run tracker`,
// или ZCode открыт до первого MCP-вызова) — файла ещё нет, и старый guard валил
// процесс, оставляя пустой фронт. Здесь мы инициализируем БД тем же путём, что и
// MCP-сервер (getDb из dist/db.js): полный SCHEMA_SQL + миграции + индексы, чтобы
// viewer и server видели идентичную схему. Идемпотентно — если файл есть, getDb
// просто открывает его.
if (!existsSync(DB_PATH)) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    ensureSagaDb();
    closeSagaDb();
    console.log(`saga.db не существовал — инициализирован: ${DB_PATH}`);
  } catch (e) {
    console.error(`Не удалось инициализировать saga.db по пути ${DB_PATH}: ${e.message}`);
    process.exit(1);
  }
}
const PORT = Number(process.env.PORT) || 4321;
const PID_FILE = path.join(__dirname, '.tracker-view.pid');
const RELOAD_SEC = Number(process.env.RELOAD_SEC) || 5;

const COLS = [
  { key: 'todo',               label: 'Backlog' },
  { key: 'in_progress',        label: 'In Progress' },
  { key: 'review',             label: 'Review (queue)' },
  { key: 'review_in_progress', label: 'Reviewing' },
  { key: 'done',               label: 'Done' },
  { key: 'blocked',            label: 'Blocked' },
];
const PROJECT_COLORS = ['#4f8cff','#16a085','#e67e22','#9b59b6','#e74c3c','#1abc9c','#f39c12','#34495e','#2ecc71','#e84393'];
const PRIO = { critical:'#c0392b', high:'#e67e22', medium:'#f1c40f', low:'#95a5a6' };

// --- Артефакты (REQ-NNN episode): типы, статусы, link_type ---
// type: PRD/SRS/UC/AC/FR/NFR/decision/theme/brief (9 литералов schema.ts).
// У decision-артефактов code обычно BRIEF-NNN — показываем как «BRIEF».
const TYPE_COLORS = {
  PRD:'#58a6ff', SRS:'#a371f7', UC:'#3fb950', AC:'#f1c40f',
  FR:'#e67e22', NFR:'#1abc9c', decision:'#9b59b6', theme:'#e84393', brief:'#f39c12'
};
const TYPE_LABEL = {
  PRD:'PRD', SRS:'SRS', UC:'UC', AC:'AC', FR:'FR', NFR:'NFR',
  decision:'BRIEF', theme:'ТЕМА', brief:'BRIEF'
};
const STATUS_LABEL = { draft:'draft', in_review:'review', accepted:'✓', superseded:'устарел' };
const STATUS_COLOR = { draft:'#8b949e', in_review:'#f39c12', accepted:'#3fb950', superseded:'#484f58' };
// link_type: covers/implements/derived_from/depends_on/verified_by/superseded_by
const LINK_COLORS = {
  implements:'#3fb950', verified_by:'#1abc9c', derived_from:'#8b949e',
  covers:'#a371f7', depends_on:'#f39c12', superseded_by:'#e74c3c'
};
const LINK_GLYPH = {
  implements:'↳ impl', verified_by:'↳ verify', derived_from:'↳ from',
  covers:'↳ covers', depends_on:'↳ dep', superseded_by:'↳ super'
};

// --- DB helpers (одна общая БД, read-only, открываем на каждый запрос —
//     overhead минимален, зато всегда свежие данные и нет гонок с saga-MCP) ---
function withDb(fn) {
  const db = new Database(DB_PATH, { readonly: true, timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Read-write соединение для save-handler. WAL-режим БД saga-mcp позволяет
// конкурентную запись (один писатель + много читателей) — безопасно с saga-MCP.
function withDbWrite(fn) {
  const db = new Database(DB_PATH, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Парсинг timestamp из БД saga. SQLite `datetime('now')` возвращает **UTC** в
// формате 'YYYY-MM-DD HH:MM:SS' (без T, без Z). Старый комментарий утверждал,
// что это локальное время — НЕВЕРНО; именно это заблуждение и плодит tz-баги
// (на UTC+3 распарсенный timestamp уезжает на -3ч, возрасты растут на 180 мин).
// Поэтому нормализуем в ISO с Z и парсим как UTC. Уже-ISO значения (с T/Z)
// проходят как есть.
function parseTs(iso) {
  if (!iso) return null;
  let s = String(iso);
  if (s.indexOf('T') < 0) s = s.replace(' ', 'T');
  if (s.indexOf('Z') < 0 && /[+-]\d\d:?\d\d$/.test(s) === false) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// Возраст timestamp'а → класс кружка (green/yellow/red)
function ageClass(iso) {
  const t = parseTs(iso);
  if (t === null) return 'red';
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 15) return 'green';
  if (ago < 60) return 'yellow';
  return 'red';
}
function ageText(iso) {
  const t = parseTs(iso);
  if (t === null) return '?';
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 60) return ago + 'с';
  if (ago < 3600) return Math.floor(ago / 60) + 'м';
  return Math.floor(ago / 3600) + 'ч';
}

// Все saga-проекты (id, name, status) + счётчики задач.
// archived исключаем — нечего показывать на канбане.
function listProjects() {
  return withDb(db => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.status,
        COUNT(t.id) AS total,
        SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN t.status='review_in_progress' THEN 1 ELSE 0 END) AS reviewing
      FROM projects p
      LEFT JOIN epics e ON e.project_id = p.id
      LEFT JOIN tasks t ON t.epic_id = e.id
      WHERE p.status != 'archived'
      GROUP BY p.id
      ORDER BY p.name COLLATE NOCASE
    `).all();
    return rows.map((r, i) => ({ ...r, color: PROJECT_COLORS[i % PROJECT_COLORS.length] }));
  });
}

function getProject(id) {
  return withDb(db => db.prepare('SELECT * FROM projects WHERE id=?').get(id));
}

// Полный рендер канбана одного saga-проекта.
function loadBoard(projectId) {
  return withDb(db => {
    const epicRows = db.prepare(`
      SELECT e.id, e.name, e.project_id, ew.stage AS episode_stage,
        json_extract(ew.metadata,'$.last_gate_error') AS gate_error,
        json_extract(ew.metadata,'$.needs-human') AS needs_human,
        json_extract(ew.metadata,'$.pause_reason') AS pause_reason,
        (SELECT count(*) FROM artifacts a WHERE a.epic_id=e.id AND a.status='accepted' AND a.drift_state='drifted') AS drift_count,
        (SELECT count(*) FROM verification_evidence v JOIN artifacts a ON a.id=v.artifact_id
          WHERE a.epic_id=e.id AND v.outcome='passed') AS evidence_count
      FROM epics e LEFT JOIN episode_workflows ew ON ew.epic_id=e.id
      WHERE e.project_id=? ORDER BY e.id
    `).all(projectId);
    if (epicRows.length === 0) return { empty: true, reason: 'no-epics' };
    const epicIds = epicRows.map(e => e.id);
    const tasks = db.prepare(`
      SELECT t.*,
        (SELECT r.name FROM project_repositories pr JOIN repositories r ON r.id=pr.repository_id
          WHERE pr.id=t.project_repository_id) AS repository_name,
        (SELECT group_concat('#' || dep.id || ' ' ||
          CASE WHEN dep.status!='done' THEN dep.status ELSE dep.integration_state END, ', ')
         FROM task_dependencies d JOIN tasks dep ON dep.id=d.depends_on_task_id
         WHERE d.task_id=t.id AND (
           dep.status!='done' OR
           (dep.task_kind IS NOT NULL AND dep.execution_mode='git_change' AND dep.integration_state!='merged')
         )) AS blocked_reason
      FROM tasks t WHERE epic_id IN (${epicIds.map(() => '?').join(',')})
      ORDER BY sort_order, id
    `).all(...epicIds);
    const epicById = Object.fromEntries(epicRows.map(e => [e.id, e]));
    return { epics: epicRows, epicById, tasks };
  });
}

function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// --- Repo-root resolver: проект saga → физический репо, где лежат .md файлы ---
// Конвенция folder:тега ненадёжна (проекты с артефактами его не имеют),
// поэтому map строим по факту где docs/requirements/<epic> реально существует.
// PROJECT_REPO_MAP — hardcoded приоритеты; resolveRepoFile обходит кандидатов.
const DEV_ROOT = 'D:/Development';
const PROJECT_REPO_MAP = {
  granite: ['Stone'],
  Geosophia: ['geosophia'],
  TestLasGPU: ['TestLasGPU'],
  'kickstart-impl': ['Harmess', 'saga-mcp'],
  'deposit-calc-simple': ['Harmess', 'deposit-calc-simple'],
  requirements: ['Harmess'],
  'ODN-MVP': ['GDesign', 'Harmess'],
  harmess: ['Harmess'],
  femdriver: ['femdriver'],
  GazPenetration: ['GazPenetration'],
};

function projectFolderTag(project) {
  try {
    const tags = JSON.parse(project.tags || '[]');
    const tag = tags.find(value => typeof value === 'string' && value.startsWith('folder:'));
    return tag ? tag.slice('folder:'.length) : null;
  } catch {
    return null;
  }
}

function resolveProjectWorkspace(project) {
  const candidates = [];
  try {
    const bindings = withDb(db => db.prepare(
      `SELECT local_path FROM project_repositories
        WHERE project_id=? AND status='active'
        ORDER BY CASE role WHEN 'control' THEN 0 ELSE 1 END, id`,
    ).all(project.id));
    for (const binding of bindings) {
      if (binding.local_path) candidates.push(binding.local_path);
    }
  } catch {}
  const folderTag = projectFolderTag(project);
  if (folderTag) candidates.push(path.join(DEV_ROOT, folderTag));
  for (const folder of PROJECT_REPO_MAP[project.name] || []) {
    candidates.push(path.join(DEV_ROOT, folder));
  }
  candidates.push(path.join(DEV_ROOT, project.name));

  try {
    for (const entry of readdirSync(DEV_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(DEV_ROOT, entry.name);
      const marker = path.join(root, 'projectname.txt');
      if (!existsSync(marker)) continue;
      if (readFileSync(marker, 'utf8').trim() === project.name) candidates.push(root);
    }
  } catch {}

  return candidates.find(candidate => existsSync(candidate)) || null;
}

function getRunnerTaskState(taskId) {
  return withDb(db =>
    db.prepare('SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?').get(taskId),
  );
}

function recoverRunnerAssignment({ taskId, workerId, originalStatus, executionId, reason }) {
  // Slice 1 (ADR-010/011, blueprint §16:829-845): the recovery path now
  // delegates fenced releases to the single atomic terminalization+release
  // function in src/lifecycle/atomic-release.ts. This removes the duplicate
  // recovery SQL that existed between tracker-view and orchestrate.ts
  // (blueprint §22:1199) and collapses the close/reconciler race
  // (blueprint §16:844): the function's fence CAS means only one of the two
  // callers wins; the other no-ops.
  //
  // Legacy (pre-ADR-009, unfenced) assignments still need the old code path
  // because there is no execution row to terminalize — only a stale
  // assigned_to to clear.
  return withDbWrite(db => {
    const task = db.prepare(
      'SELECT id, title, status, assigned_to, tags, current_execution_id FROM tasks WHERE id=?',
    ).get(taskId);
    if (!task || task.assigned_to !== workerId) return false;
    let tags = [];
    try { tags = JSON.parse(task.tags || '[]'); } catch {}
    if (tags.includes('needs-human')) return false;

    // Fenced task: delegate to the atomic release path. The fence CAS inside
    // protects against the close/reconciler race — if orchestrate.ts already
    // released, this call no-ops on the task row (still terminalizes nothing
    // because execution is already terminal).
    if (executionId && task.current_execution_id === executionId) {
      const terminalState = reason && /exit\s*code/i.test(String(reason)) ? 'exited' : 'lost';
      const outcome = releaseExecutionAtomically(db, {
        executionId,
        terminalState,
        exitCode: null,
        reason: `runner recovery: ${reason}`,
      });
      if (outcome.taskReleased) {
        db.prepare(
          `INSERT INTO activity_log
            (entity_type, entity_id, action, field_name, old_value, new_value, summary)
           VALUES ('task', ?, 'status_changed', 'status', ?, ?, ?)`,
        ).run(taskId, task.status, outcome.restoredStatus,
          `Board runner recovered task '${task.title}' (atomic): ${reason}`);
      }
      return outcome.taskReleased;
    }

    // Legacy path: pre-ADR-009 unfenced assignment. Keep the old SQL — there
    // is no execution to terminalize.
    let restoredStatus = originalStatus === 'review' ? 'review' : 'todo';
    if (originalStatus === 'review' && task.status === 'in_progress') restoredStatus = 'todo';
    const info = db.prepare(
      `UPDATE tasks SET status=?, assigned_to=NULL, current_execution_id=NULL,
         updated_at=datetime('now')
       WHERE id=? AND assigned_to=?
         AND (current_execution_id IS NULL OR current_execution_id=?)`,
    ).run(restoredStatus, taskId, workerId, executionId ?? null);
    if (info.changes === 1) {
      db.prepare(
        `INSERT INTO activity_log
          (entity_type, entity_id, action, field_name, old_value, new_value, summary)
         VALUES ('task', ?, 'status_changed', 'status', ?, ?, ?)`,
      ).run(taskId, task.status, restoredStatus, `Board runner recovered task '${task.title}': ${reason}`);
    }
    return info.changes === 1;
  });
}

const boardRunner = createClaudeBoardRunner({
  claimTask: args => dispatcherHandlers.worker_next(args),
  getProject: projectId => withDb(db => db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)),
  getTaskState: getRunnerTaskState,
  recoverAssignment: recoverRunnerAssignment,
  resolveWorkspace: resolveProjectWorkspace,
  dbPath: DB_PATH,
  sagaEntry: path.join(__dirname, '..', 'dist', 'index.js'),
  sagaSkillRoot: path.join(__dirname, '..', 'skills'),
});

// Найти физический путь к .md файлу артефакта.
// path в БД может быть 'docs/.../01-SRS.md#FR-1' — якорь отбрасываем.
// Возвращает { abs, projectRoot } или null если файл не существует.
function resolveArtifactFile(artifactPath, projectName, repositoryPath = null) {
  const cleanPath = artifactPath.split('#')[0];
  // Workers sometimes write absolute paths (D:\Development\moscito\docs\...md)
  // despite the skill template saying 'docs/...'. On Windows, path.join with
  // an absolute second arg produces garbage like:
  //   D:\Development\moscito\D:Developmentmoscitodocs...md
  // Detect absolute paths and use them directly instead of joining with root.
  // This is a defensive fix — the proper fix is in artifact_create handler
  // (src/tools/artifacts.ts) which normalises absolute → relative at write time.
  const looksAbsolute = /^([A-Za-z]:[\\/]|[\\/]|\\\\[^?])/.test(cleanPath);
  if (looksAbsolute) {
    return existsSync(cleanPath)
      ? { abs: cleanPath, projectRoot: path.dirname(cleanPath) }
      : null;
  }
  const candidates = [];
  if (repositoryPath) candidates.push(repositoryPath);
  const map = PROJECT_REPO_MAP[projectName] || [];
  for (const sub of map) candidates.push(path.join(DEV_ROOT, sub));
  // Fallback: если проекта нет в map, ищем по имени в DEV_ROOT
  if (!map.length) candidates.push(path.join(DEV_ROOT, projectName));
  for (const root of candidates) {
    const abs = path.join(root, cleanPath);
    if (existsSync(abs)) return { abs, projectRoot: root };
  }
  return null;
}

// --- Markdown → HTML (минимальный рендер, без зависимостей) ---
// Поддержка: заголовки #..####, списки -/*, код ```, параграфы, жирный **,
// таблицы | a | b |. Этого достаточно для PRD/SRS/UC/AC артефактов saga.
function renderMarkdown(md) {
  if (!md) return '<p class="muted">пусто</p>';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, inList = false, inTable = false, para = [];
  const flushPara = () => {
    if (para.length) {
      let t = para.join(' ');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
           .replace(/`([^`]+)`/g, '<code>$1</code>');
      html += `<p>${t}</p>`;
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // code fence
    if (/^```/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      if (inTable) { html += '</table>'; inTable = false; }
      if (para.length) flushPara();
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    // таблица
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (para.length) flushPara();
      if (inList) { html += '</ul>'; inList = false; }
      if (!inTable) { html += '<table>'; inTable = true; }
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      // separator row |---|---|
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      const tag = (i > 0 && lines[i-1].trim().startsWith('|')) && !inTableHasHeader(html) ? 'td' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${esc(c)}</${tag}>`).join('') + '</tr>';
      continue;
    } else if (inTable) { html += '</table>'; inTable = false; }
    // заголовки
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      if (para.length) flushPara();
      if (inList) { html += '</ul>'; inList = false; }
      const lvl = hm[1].length;
      html += `<h${lvl}>${esc(hm[2])}</h${lvl}>`;
      continue;
    }
    // список
    if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) flushPara();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${esc(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
      continue;
    } else if (inList && line.trim() === '') { html += '</ul>'; inList = false; }
    // пустая строка → конец параграфа
    if (line.trim() === '') { flushPara(); continue; }
    para.push(esc(line));
  }
  if (inCode) html += '</code></pre>';
  if (inList) html += '</ul>';
  if (inTable) html += '</table>';
  flushPara();
  return html;
}
function inTableHasHeader(htmlTail) { return /<\/th>/.test(htmlTail.slice(-200)); }

// Извлечь первый <div class="<cls>">…</div> по балансу тегов (надёжнее regex при
// глубокой вложенности — .episodes содержит много вложенных </div>).
// Возвращает подстроку включая открывающий/закрывающий тег, или '' если не найден.
function extractDiv(html, cls) {
  const open = html.indexOf(`<div class="${cls}">`);
  if (open < 0) return '';
  let depth = 0, i = open;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return '';
}

// Загрузка всех артефактов проекта + их исходящих трасс (для вкладки Артефакты).
// Структура данных (по exploration):
//   parent_artifact_id = «позвоночник» дерева, max depth 3:
//     decision(BRIEF) → PRD → {FR, NFR, RULE, UC, SRS}; AC → UC (иногда → PRD).
//     Pipeline order (ADR-014): PRD → UC → AC → Reconcile → SRS(+§D).
//   artifact_traces = кросс-режущие рёбра, НЕ часть дерева:
//     implements (AC→DEV-таск), verified_by, derived_from (AC→FR), covers (UC→FR).
//   28 трасс кросс-проектные (AC в requirements → DEV-таск в builders-проекте).
// Возвращает { unavailable } если таблицы artifacts нет в БД (старая saga-mcp).
function loadArtifactsTree(projectId) {
  return withDb(db => {
    // Guard: старые БД (как Harmess .tracker.db) не имеют таблицы artifacts.
    let hasTable;
    try {
      hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    } catch { return { unavailable: true }; }
    if (!hasTable) return { unavailable: true };

    const artifacts = db.prepare(`
      SELECT a.id, a.epic_id, a.type, a.code, a.title, a.status,
             a.parent_artifact_id, a.tags, a.updated_at, e.name AS epic_name
        FROM artifacts a
        JOIN epics e ON e.id = a.epic_id
       WHERE e.project_id = ?
       ORDER BY a.epic_id, a.parent_artifact_id NULLS FIRST, a.type, a.code
    `).all(projectId);

    if (artifacts.length === 0) return { empty: true, reason: 'no-artifacts' };

    const artIds = artifacts.map(a => a.id);
    // Исходящие трассы + статус/код цели. Колонки tasks.project_id нет —
    // проект таска получаем отдельным запросом ниже через tasks.epic_id.
    const traces = db.prepare(`
      SELECT t.source_id, t.target_type, t.target_id, t.link_type,
        CASE WHEN t.target_type='artifact'
             THEN (SELECT a.status FROM artifacts a WHERE a.id=t.target_id)
             ELSE (SELECT tk.status FROM tasks tk WHERE tk.id=t.target_id) END AS target_status,
        CASE WHEN t.target_type='artifact'
             THEN (SELECT a.code FROM artifacts a WHERE a.id=t.target_id)
             ELSE NULL END AS target_code
        FROM artifact_traces t
       WHERE t.source_id IN (${artIds.map(() => '?').join(',')})
       ORDER BY t.source_id, t.link_type
    `).all(...artIds);

    // Таски-цели (для implements/verified_by) — название, статус, проект-владелец.
    const taskTargets = traces.filter(t => t.target_type === 'task').map(t => t.target_id);
    const tasksById = {};
    const projectById = {};
    if (taskTargets.length) {
      const uniq = [...new Set(taskTargets)];
      const taskRows = db.prepare(`
        SELECT tk.id, tk.title, tk.status, tk.epic_id, e.project_id
          FROM tasks tk JOIN epics e ON e.id = tk.epic_id
         WHERE tk.id IN (${uniq.map(() => '?').join(',')})
      `).all(...uniq);
      // Имена проектов для кросс-проектных бейджей.
      const projIds = [...new Set(taskRows.map(r => r.project_id))];
      if (projIds.length) {
        const projRows = db.prepare(`SELECT id, name FROM projects WHERE id IN (${projIds.map(()=>'?').join(',')})`).all(...projIds);
        for (const p of projRows) projectById[p.id] = p.name;
      }
      for (const r of taskRows) tasksById[r.id] = r;
    }

    return { artifacts, traces, tasksById, projectById };
  });
}

// --- HTML: индекс всех saga-проектов ---
function renderIndex(projects, flash = null) {
  const withData = projects.filter(p => p.total > 0);
  const empty    = projects.filter(p => !p.total || p.total === 0);
  withData.sort((a,b) => b.total - a.total);

  const totalTasks = projects.reduce((s,p) => s + (p.total||0), 0);
  const totalProj  = projects.length;
  // Two row buttons per project: 📦 archive (soft) and 🗑 delete (hard, cascade).
  // data-pid / data-pname feed the click handler at the bottom of the page.
  // preventDefault+stopPropagation on click so the parent <a> navigation is
  // suppressed — otherwise clicking 🗑 would also open the project page.
  const rowHtml = (p) => `<a class="prow${!p.total?' empty':''}" href="?project=${p.id}">
    <span class="pdot" style="background:${p.color}"></span>
    <span class="pname">${esc(p.name)}</span>
    <span class="pstats">${p.total ? `<b>${p.total}</b> задач · <span class="ip">${p.in_progress} in progress</span>${p.reviewing ? ` · <span class="ip">${p.reviewing} reviewing</span>` : ''}` : '<span class="muted">пусто</span>'}</span>
    <button class="row-btn archive-btn" data-pid="${p.id}" data-pname="${esc(p.name)}" type="button"
            title="Архивировать (скрыть из списка, данные сохранятся — восстановимо через SQL)">📦</button>
    <button class="row-btn delete-btn" data-pid="${p.id}" data-pname="${esc(p.name)}" type="button"
            title="Удалить навсегда (cascade-delete всех эпиков/задач/артефактов — НЕ восстановимо)">🗑</button>
    <span class="arrow">→</span>
  </a>`;

  const active = withData.map(rowHtml).join('');
  const empties = empty.map(rowHtml).join('');

  const flashHtml = flash
    ? `<div class="flash flash-${flash.kind}">${esc(flash.text)}</div>`
    : '';

  return page('Все проекты', `
    ${flashHtml}
    <div class="summary">
      <div class="sum-item"><b>${totalProj}</b><span>проектов</span></div>
      <div class="sum-item"><b>${totalTasks}</b><span>всего задач</span></div>
      <div class="sum-item"><b>${withData.length}</b><span>с задачами</span></div>
      <div class="sum-item" style="flex:0;min-width:120px"><div class="heartbeat" style="justify-content:center"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div></div>
    </div>
    <div class="searchbar">
      <input id="q" placeholder="🔍 поиск проекта по имени..." autocomplete="off">
    </div>
    <div class="nav-regs">
      <span class="muted small">Реестры документов:</span>
      <a class="chip" href="?registry=PRD">PRD</a>
      <a class="chip" href="?registry=SRS">SRS</a>
      <a class="chip" href="?registry=AC">AC</a>
      <a class="chip" href="?registry=UC">UC</a>
      <a class="chip" href="?registry=FR">FR</a>
      <a class="chip" href="?registry=NFR">NFR</a>
      <a class="chip" href="?registry=decision">BRIEF</a>
      <span style="flex:1"></span>
      <a class="chip admin-link" href="/admin" title="Создать проект/эпик из GUI">⚙ Администрирование</a>
    </div>
    <div class="section-title">Активные</div>
    <div class="plist" id="active">${active || '<div class="empty-hint">Нет проектов с задачами.</div>'}</div>
    ${empty.length ? `<details class="empty-section"><summary>Пустые проекты (${empty.length})</summary><div class="plist">${empties}</div></details>` : ''}
    <script>
      const q=document.getElementById('q');
      q.oninput=()=>{ const v=q.value.toLowerCase(); document.querySelectorAll('.prow').forEach(r=>{ r.style.display = r.textContent.toLowerCase().includes(v)?'':'none'; }); };
      setTimeout(()=>location.reload(), ${RELOAD_SEC * 1000});

      // Row-button handler (event delegation — one listener for all .row-btn).
      // confirm() -> fetch POST -> alert/redirect. Mirrors postOperation helper
      // used elsewhere in this file (engine start/stop, model switch).
      document.addEventListener('click', async (e) => {
        const btn = e.target.closest('.row-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const pid = Number(btn.dataset.pid);
        const pname = btn.dataset.pname || ('project '+pid);
        try {
          if (btn.classList.contains('archive-btn')) {
            if (!confirm('Архивировать проект «'+pname+'»?\\nОн исчезнет из списка, но данные сохранятся в БД. Восстановить можно через SQL (UPDATE projects SET status=\\'active\\').')) return;
            const r = await fetch('/api/project/archive', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project_id: pid }) });
            const d = await r.json();
            if (!r.ok || !d.ok) return alert('Архивирование не удалось: ' + (d.error || r.statusText));
            location.href = '/?archived=' + encodeURIComponent(pname);
          } else if (btn.classList.contains('delete-btn')) {
            const msg = 'УДАЛИТЬ НАВСЕГДА проект «'+pname+'»?\\n\\n' +
                        'Будут удалены: все эпики, задачи, артефакты, трассировки, worker_executions, repository bindings.\\n\\n' +
                        'activity_log и .md файлы артефактов сохранятся (audit trail).\\n\\n' +
                        'ОТМЕНИТЬ НЕЛЬЗЯ. Продолжить?';
            if (!confirm(msg)) return;
            const r = await fetch('/api/project/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ project_id: pid }) });
            const d = await r.json();
            if (!r.ok || !d.ok) return alert('Удаление не удалось: ' + (d.error || r.statusText));
            let alertMsg = 'Проект «'+pname+'» удалён.';
            if (d.deregistered_checkouts && d.deregistered_checkouts.length) {
              alertMsg += '\\n\\nОстались файлы на диске (machine checkouts):\\n' +
                          d.deregistered_checkouts.map(c => '  '+c.machine_id+': '+c.local_path).join('\\n') +
                          '\\n\\nУдалите их вручную, если нужно.';
            }
            alert(alertMsg);
            location.href = '/?deleted=' + encodeURIComponent(pname);
          }
        } catch (err) {
          alert('Сетевая ошибка: ' + (err && err.message ? err.message : err));
        }
      });
    </script>
  `);
}

// --- HTML: канбан одного проекта ---

/**
 * Read engine_concurrency from any of the project's episode_workflows rows.
 * The engine writes this on start (orchestrate.ts writeEpisodeMeta), so the
 * UI selector can pre-select the actual current value. Falls back to null
 * (caller defaults) when the engine has never run for this project.
 */
function engineConcurrencyForProject(projectId) {
  try {
    const row = withDb(db => db.prepare(
      `SELECT json_extract(ew.metadata, '$.engine_concurrency') AS c
       FROM episode_workflows ew
       JOIN epics e ON e.id=ew.epic_id
       WHERE e.project_id=?
       ORDER BY ew.updated_at DESC LIMIT 1`,
    ).get(projectId));
    const c = row?.c;
    return (typeof c === 'number' && c >= 1 && c <= 10) ? c : null;
  } catch { return null; }
}

/**
 * Read the persisted engine_running flag for a project's most-recent episode.
 * Used by the kanban render to decide whether the Start/Pause button shows ▶
 * (stopped) or ⏸ (running). Falls back to false (stopped) — safer default,
 * prevents accidental UI hint that an engine is running when it isn't.
 */
function engineRunningForProject(projectId) {
  try {
    const row = withDb(db => db.prepare(
      `SELECT json_extract(ew.metadata, '$.engine_running') AS r
       FROM episode_workflows ew
       JOIN epics e ON e.id=ew.epic_id
       WHERE e.project_id=?
       ORDER BY ew.updated_at DESC LIMIT 1`,
    ).get(projectId));
    return row?.r === 1 || row?.r === true;
  } catch { return false; }
}

/**
 * Read the user's chosen model for a project's most-recent episode from saga.db
 * ($.active_model). Used by the kanban render to pre-select the model selector
 * — so F5 (page reload) preserves the choice, instead of resetting to the
 * process-wide WORKER_MODEL constant.
 *
 * Returns null when no model has been set for this project (caller falls back
 * to the process-wide WORKER_MODEL resolved from ~/.claude/settings.json).
 */
function activeModelForProject(projectId) {
  try {
    const row = withDb(db => db.prepare(
      `SELECT json_extract(ew.metadata, '$.active_model') AS m
       FROM episode_workflows ew
       JOIN epics e ON e.id=ew.epic_id
       WHERE e.project_id=?
       ORDER BY ew.updated_at DESC LIMIT 1`,
    ).get(projectId));
    const m = row?.m;
    return (typeof m === 'string' && m.length > 0) ? m : null;
  } catch { return null; }
}

/**
 * Resolve the REAL model running under claude's --model alias. z.ai and other
 * proxies remap the Anthropic alias ('opus', 'sonnet', 'haiku') to their own
 * backend models via ~/.claude/settings.json env vars
 * (ANTHROPIC_DEFAULT_*_MODEL). Without this the UI would say 'opus' while the
 * real model is glm-5.2[1m]. Returns a short label like 'glm-5.2[1m]'.
 */
function resolveWorkerModel() {
  try {
    const home = os.homedir();
    const raw = readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const s = JSON.parse(raw);
    const alias = s.model || 'opus';
    const envKey = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
    const real = s.env && s.env[envKey];
    return real ? real : alias;
  } catch { return 'opus'; }
}
const WORKER_MODEL = resolveWorkerModel();

function renderBoard(projectId, allProjects) {
  const proj = allProjects.find(p => String(p.id) === String(projectId));
  if (!proj) return page('Проект не найден', '<div class="empty-box"><h2>Проект не найден</h2></div>');

  const data = loadBoard(projectId);

  const opts = allProjects.map(p => `<option value="${p.id}"${String(p.id)===String(projectId)?' selected':''}>${esc(p.name)}</option>`).join('');
  const header = `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <select id="psel" onchange="location='?project='+this.value">${opts}</select>
      <span class="cur-proj" style="color:${proj.color}">${esc(proj.name)}</span>
      <div class="tabs">
        <a class="tab active" href="?project=${projectId}">Канбан</a>
        <a class="tab" href="?project=${projectId}&tab=artifacts">Артефакты</a>
        <a class="tab" href="?project=${projectId}&tab=coverage">Покрытие</a>
        <a class="tab" href="?project=${projectId}&tab=acceptance">Приёмка</a>
      </div>
      <span style="flex:1"></span>
      <div class="agent-runner" id="agent-runner" title="Управление движком эпизода. ▶ старт / ⏸ пауза.">
        <span class="agent-icon">🤖</span>
        <button id="agent-engine-toggle" class="engine-toggle${
          engineRunningForProject(projectId) ? ' engine-running' : ''
        }" type="button" aria-label="Запуск / пауза движка" title="Запуск / пауза движка этого эпизода">${
          engineRunningForProject(projectId) ? '⏸' : '▶'
        }</button>
        <select id="agent-concurrency" aria-label="Количество одновременных воркеров движка">
          ${Array.from({ length: 32 }, (_, i) => {
            // Pre-select the option matching the engine's current concurrency,
            // read from episode_workflows.metadata.engine_concurrency. Without
            // this, hot-reload of tracker-view loses the user's last choice —
            // selector defaults to 1, and any change would restart the engine
            // at concurrency=1, killing the parallel cohort mid-flight.
            const conc = engineConcurrencyForProject(projectId) || 4;
            return `<option value="${i + 1}"${i + 1 === conc ? ' selected' : ''}>${i + 1}</option>`;
          }).join('')}
        </select>
        <select id="agent-model-select" title="Модель для НОВЫХ воркеров. Активные доработают на старой. Лимит модели — потолок concurrency. Опция «↻ LM Studio» — обновить список локальных моделей.">
          ${(function() {
            // Read the per-epic choice from saga.db so F5 preserves it.
            // Without this the selector reset to the process-wide WORKER_MODEL
            // constant on every page reload, losing the user's last selection.
            const chosen = activeModelForProject(projectId) || WORKER_MODEL;
            const zaiOpts = ZAI_MODELS.map(m =>
              `<option value="${m.id}" data-limit="${m.limit}" data-provider="zai"${m.id === chosen ? ' selected' : ''}>${m.id} (×${m.limit}${m.note ? ' · ' + m.note : ''})</option>`
            ).join('');
            // LM Studio group: real loaded models if online, else a single
            // disabled "офлайн" hint + the refresh sentinel option.
            const lmOn = LMSTUDIO_ONLINE && LMSTUDIO_MODELS.length > 0;
            const lmBody = lmOn
              ? LMSTUDIO_MODELS.map(m =>
                  `<option value="${m.id}" data-limit="${m.limit}" data-provider="lmstudio"${m.id === chosen ? ' selected' : ''}>${m.id} (×${m.limit} · локально)</option>`
                ).join('')
              : `<option value="" disabled>офлайн — запустите LM Studio</option>`;
            const lmGroup = `<optgroup label="LM Studio (локально)">${lmBody}<option value="__lmstudio_refresh" data-provider="refresh">↻ обновить список</option></optgroup>`;
            return `<optgroup label="Z.ai (облако, подписка)">${zaiOpts}</optgroup>${lmGroup}`;
          })()}
        </select>
        <span id="agent-run-status" class="agent-run-status">движок: …</span>
      </div>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  if (data.empty) {
    return page(proj.name, `${header}
      <div class="empty-box">
        <div class="empty-icon">📋</div>
        <h2>В проекте нет эпиков</h2>
        <p>Создай эпик и задачи через saga-mcp (epic_create / task_create).</p>
      </div>`);
  }

  const { epicById, tasks } = data;
  // Чипсы-фильтры по эпикам (внутри одного saga-проекта)
  const epicChips = Object.values(epicById).map(e =>
    `<button class="chip active" data-filter="${e.id}">${esc(e.name)}</button>`
  ).join('');
  const repositoryOptions = [...new Map(
    tasks.filter(t => t.project_repository_id).map(t => [t.project_repository_id, t.repository_name || `repo #${t.project_repository_id}`]),
  )].map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  const stageOptions = [...new Set(tasks.map(t => t.workflow_stage).filter(Boolean))]
    .sort().map(stage => `<option value="${esc(stage)}">${esc(stage)}</option>`).join('');
  const kindOptions = [...new Set(tasks.map(t => t.task_kind).filter(Boolean))]
    .sort().map(kind => `<option value="${esc(kind)}">${esc(kind)}</option>`).join('');
  const episodeProgress = Object.values(epicById).map(e => `
    <div class="episode-progress"><b>${esc(e.name)}</b>
      <span class="task-badge stage">${esc(e.episode_stage || 'legacy')}</span>
      ${e.drift_count ? `<span class="task-badge" style="color:#f85149">drift ${e.drift_count}</span>` : ''}
      ${e.evidence_count ? `<span class="task-badge" style="color:#3fb950">evidence ${e.evidence_count}</span>` : ''}
      ${e.gate_error ? `<span class="task-badge" style="color:#f85149" title="${esc(e.gate_error)}">gate blocked</span>` : ''}
      ${e.needs_human === 1 ? `
        <span class="task-badge" style="color:#f85149;background:rgba(231,76,60,.15)" title="${esc(e.pause_reason || 'engine paused')}">⚠ engine paused</span>
        <button type="button" class="btn episode-resume" data-epic="${e.id}" title="Снять needs-human — движок продолжит">▶ Resume</button>
      ` : ''}
    </div>`).join('');
  const repoBindings = withDb(db => db.prepare(`
    SELECT pr.id,r.name,pr.status FROM project_repositories pr
    JOIN repositories r ON r.id=pr.repository_id
    WHERE pr.project_id=? ORDER BY r.name
  `).all(projectId));
  const bootstrapOptions = repoBindings.map(r =>
    `<option value="${r.id}">${esc(r.name)} (${esc(r.status)})</option>`).join('');
  const nextStage = {
    formalization:'planning', planning:'development',
    development:'verification', verification:'integration', integration:'completed',
  };
  const transitionButtons = Object.values(epicById).map(e => {
    const next = nextStage[e.episode_stage];
    return next
      ? `<button type="button" class="episode-advance btn" data-epic="${e.id}" data-to="${next}">${esc(e.name)}: ${esc(e.episode_stage)} → ${next}</button>`
      : '';
  }).join('');

  const cards = tasks.map(t => {
    const e = epicById[t.epic_id];
    // needs-human флаг — задача ждёт ответа человека, мигает красным
    let needsHuman = false;
    try { needsHuman = JSON.parse(t.tags || '[]').includes('needs-human'); } catch {}
    return {
      t, e,
      epicName: e ? e.name : '?',
      epicId: t.epic_id,
      prio: PRIO[t.priority] || '#95a5a6',
      needsHuman,
    };
  });
  const byStatus = {};
  for (const c of cards) (byStatus[c.t.status] ||= []).push(c);

  const columnsHtml = COLS.map(col => {
    const items = byStatus[col.key] || [];
    const cardsHtml = items.map(c => `
      <div class="card${c.needsHuman ? ' needs-human' : ''}" data-epic="${c.epicId}" data-task="${c.t.id}" data-repo="${c.t.project_repository_id || ''}" data-stage="${esc(c.t.workflow_stage || '')}" data-kind="${esc(c.t.task_kind || '')}" style="border-left:6px solid ${proj.color}">
        <div class="card-head">
          <span class="prio" style="background:${c.prio}">${esc(c.t.priority)}</span>
          ${c.t.assigned_to ? `<span class="assigned" title="assigned_to">${esc(c.t.assigned_to)}</span>` : ''}
          ${c.needsHuman ? '<span class="ask-flag" title="needs human answer">⚠ needs human</span>' : ''}
          <span style="flex:1"></span>
          <span class="card-id">#${c.t.id}</span>
          ${(c.t.status === 'done' || c.t.status === 'blocked')
            ? ''
            : `<span class="hb-dot ${ageClass(c.t.updated_at)}" title="${ageText(c.t.updated_at)} назад"></span>`}
        </div>
        <a class="card-title" href="/?task=${c.t.id}" title="Открыть карточку задачи">${esc(c.t.title)}</a>
        <div class="task-badges">
          ${c.t.repository_name ? `<span class="task-badge repo">${esc(c.t.repository_name)}</span>` : ''}
          ${c.t.workflow_stage ? `<span class="task-badge stage">${esc(c.t.workflow_stage)}</span>` : ''}
          ${c.t.task_kind ? `<span class="task-badge kind">${esc(c.t.task_kind)}</span>` : ''}
          ${c.t.generated_from_task_id ? `<a class="task-badge" href="/?task=${c.t.generated_from_task_id}">from #${c.t.generated_from_task_id}</a>` : ''}
          ${c.t.integration_state && c.t.integration_state !== 'not_required' ? `<span class="task-badge">${esc(c.t.integration_state)}</span>` : ''}
        </div>
        <div class="card-meta">${esc(c.epicName)}</div>
        ${c.t.blocked_reason ? `<div class="card-meta" style="color:#f85149">blocked by ${esc(c.t.blocked_reason)}</div>` : ''}
      </div>`).join('');
    return `<div class="col">
      <div class="col-head"><span>${col.label}</span><span class="count">${items.length}</span></div>
      <div class="col-body">${cardsHtml || '<div class="col-empty">—</div>'}</div>
    </div>`;
  }).join('');

  return page(proj.name, `${header}
    <div class="episode-progress-bar">${episodeProgress}</div>
    <details class="board-ops">
      <summary>Repository and episode operations</summary>
      <div class="board-ops-grid">
        <form id="repo-register-form" class="inline-op">
          <input type="text" name="name" required placeholder="repository name">
          <input type="text" name="local_path" placeholder="local path (optional)">
          <input type="text" name="remote_url" placeholder="remote URL (optional)">
          <select name="status"><option value="active">active</option><option value="planned">planned</option></select>
          <button class="btn" type="submit">Register repository</button>
        </form>
        <form id="repo-bootstrap-form" class="inline-op">
          <select name="project_repository_id" required>${bootstrapOptions}</select>
          <input type="text" name="machine_id" required value="${esc(os.hostname())}" placeholder="machine id">
          <input type="text" name="local_path" required placeholder="empty clone destination">
          <button class="btn" type="submit">Clone & register checkout</button>
        </form>
        <div class="inline-op episode-ops">${transitionButtons || '<span class="muted">No manual transition available</span>'}</div>
      </div>
    </details>
    <div class="filter-bar">
      <span class="filter-label">Эпики:</span>
      <button class="chip active" data-filter="__all__">Все</button>
      ${epicChips}
      <span class="filter-label">Репо:</span>
      <select id="repo-filter"><option value="__all__">Все</option>${repositoryOptions}</select>
      <span class="filter-label">Стадия:</span>
      <select id="stage-filter"><option value="__all__">Все</option>${stageOptions}</select>
      <span class="filter-label">Kind:</span>
      <select id="kind-filter"><option value="__all__">All</option>${kindOptions}</select>
    </div>
    <div class="board">${columnsHtml}</div>
    <script>
    window.__sagaEpicId = ${Object.values(epicById)[0]?.id || 'null'};
    let activeFilter = '__all__';
    let activeRepo = '__all__';
    let activeStage = '__all__';
    let activeKind = '__all__';
    function applyFilter() {
      document.querySelectorAll('.card').forEach(card => {
        const epicOk = activeFilter === '__all__' || card.dataset.epic === activeFilter;
        const repoOk = activeRepo === '__all__' || card.dataset.repo === activeRepo;
        const stageOk = activeStage === '__all__' || card.dataset.stage === activeStage;
        const kindOk = activeKind === '__all__' || card.dataset.kind === activeKind;
        card.style.display = epicOk && repoOk && stageOk && kindOk ? '' : 'none';
      });
      document.querySelectorAll('.col').forEach(col => {
        const visible = col.querySelectorAll('.card:not([style*="display: none"])').length;
        const cnt = col.querySelector('.count');
        if (cnt) cnt.textContent = visible;
      });
    }
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeFilter = chip.dataset.filter;
        applyFilter();
      });
    });
    document.getElementById('repo-filter').addEventListener('change', e => { activeRepo=e.target.value; applyFilter(); });
    document.getElementById('stage-filter').addEventListener('change', e => { activeStage=e.target.value; applyFilter(); });
    document.getElementById('kind-filter').addEventListener('change', e => { activeKind=e.target.value; applyFilter(); });
    async function postOperation(endpoint, payload, confirmText) {
      if (confirmText && !confirm(confirmText)) return;
      const response = await fetch(endpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'operation failed');
      location.reload();
    }
    document.getElementById('repo-register-form').addEventListener('submit', async e => {
      e.preventDefault();
      const p=Object.fromEntries(new FormData(e.target)); p.project_id=${Number(projectId)};
      if (!p.local_path) delete p.local_path; if (!p.remote_url) delete p.remote_url;
      try { await postOperation('/api/repository/register',p); } catch(err){ alert(err.message); }
    });
    document.getElementById('repo-bootstrap-form').addEventListener('submit', async e => {
      e.preventDefault();
      const p=Object.fromEntries(new FormData(e.target));
      p.project_repository_id=Number(p.project_repository_id);
      try { await postOperation('/api/repository/bootstrap',p,'This will run git clone into the explicit destination. Continue?'); } catch(err){ alert(err.message); }
    });
    document.querySelectorAll('.episode-advance').forEach(button => button.addEventListener('click', async () => {
      try {
        await postOperation('/api/episode/transition',{
          epic_id:Number(button.dataset.epic),to_stage:button.dataset.to,
        },'Advance this episode through its hard gate?');
      } catch(err) { alert('Gate rejected: '+err.message); }
    }));
    document.querySelectorAll('.episode-resume').forEach(button => button.addEventListener('click', async () => {
      try {
        const epicId = Number(button.dataset.epic);
        const r = await fetch('/api/episode/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epic_id: epicId }),
        });
        const j = await r.json();
        if (j.ok) {
          if (j.was_paused) {
            alert('Флаг needs-human снят. Если движок запущен — он продолжит в течение 10 сек.');
          } else {
            alert('Флаг needs-human уже был снят. Если движок не запущен — запусти orchestrate-cli вручную.');
          }
          location.reload();
        } else {
          alert('Ошибка: ' + (j.error || 'неизвестная'));
        }
      } catch (err) { alert('Сеть: ' + err.message); }
    }));
    const runnerConcurrency = document.getElementById('agent-concurrency');
    const runnerStatus = document.getElementById('agent-run-status');
    function applyRunnerState(run) {
      const active = run?.active?.length || 0;
      // In v3 the agent-runner block is concurrency-only (no start/stop
      // buttons — the engine owns pumping). Show worker throughput here
      // so the header still reflects activity.
      runnerConcurrency.disabled = false;
      if (!run) runnerStatus.textContent = 'движок работает';
      else if (run.status === 'running') runnerStatus.textContent = active + '/' + run.concurrency + ' воркеров · ✓' + run.completed + (run.failed ? ' · ✕' + run.failed : '');
      else if (run.status === 'completed') runnerStatus.textContent = 'готово · ✓' + run.completed;
      else if (run.status === 'failed') runnerStatus.textContent = 'ошибка движка: ' + (run.last_error || '?');
      if (run?.last_error) runnerStatus.title = run.last_error;
      // In-process runner workers (legacy path when tracker-view started the
      // run itself). Cross-process workers come via refreshDbWorkers() below.
      if (run && run.active && run.active.length > 0) renderWorkersList(run.active);
    }
    async function refreshDbWorkers() {
      try {
        const r = await fetch('/api/workers/active?project_id=${projectId}');
        const j = await r.json();
        if (j.ok && j.workers) renderWorkersList(j.workers);
      } catch {}
    }
    refreshDbWorkers();
    setInterval(refreshDbWorkers, 2000);

    // === Monitor panel: live workers + pipeline ===
    // Tracks expanded worker rows across refreshes (worker_id → true).
    const expandedWorkers = new Set();
    // task_id → { log_mtime_ms, worker_id }: shared between the sidebar
    // (renderWorkersList) and the kanban cards (applyStreamingDots). The
    // kanban is re-rendered server-side every RELOAD_SEC and replaceWith'd,
    // so the dots need a stable place to read "is this card's worker
    // streaming right now?" — a window global survives the swap.
    if (!window.__activeWorkers) window.__activeWorkers = new Map();
    // Render worker rows from a list of {task_id,title,worker_id,log_path,started_at,log_mtime_ms}.
    function renderWorkersList(active) {
      const list = document.getElementById('workers-list');
      const countEl = document.getElementById('worker-count');
      if (!list || !countEl) return;
      countEl.textContent = active.length;
      // Refresh the task_id → streaming-state map used by the kanban dot.
      // Rebuilt from scratch each tick: workers come and go, and a stale
      // entry would keep a dead worker's dot pulsing forever.
      const next = new Map();
      for (const w of active) {
        if (w.task_id == null) continue;
        next.set(Number(w.task_id), {
          log_mtime_ms: w.log_mtime_ms || null,
          worker_id: w.worker_id || '',
          is_stale: w.is_stale === true,
        });
      }
      window.__activeWorkers = next;
      applyStreamingDots();
      // Recovery banner: show only when at least one recovery.heal worker is
      // active. Hidden otherwise. Single line at the bottom of sidebar — no
      // separate section, no modal, no new color in the main UI.
      const banner = document.getElementById('recovery-banner');
      const bannerText = document.getElementById('recovery-text');
      const healers = active.filter(w => w.task_kind === 'recovery.heal');
      if (banner && bannerText) {
        if (healers.length > 0) {
          const h = healers[0];
          // Date.parse handles both SQLite format (no tz, treated as local)
          // and ISO Z (from worker_started_at). Avoid string concat with 'Z'
          // which produces Invalid Date for already-Z-terminated ISO strings.
          const startedMs = Date.parse(h.started_at);
          const ageMin = Number.isNaN(startedMs) ? 0 : Math.max(0, Math.round((Date.now() - startedMs) / 60000));
          bannerText.textContent = 'recovery #' + h.task_id + ' · ' + ageMin + 'm' + (healers.length > 1 ? ' +' + (healers.length - 1) : '');
          banner.style.display = 'flex';
        } else {
          banner.style.display = 'none';
        }
      }
      if (active.length === 0) {
        list.innerHTML = '<div class="worker-empty">нет активных воркеров</div>';
        return;
      }
      // Remove the empty placeholder if present (initial server-rendered HTML
      // and the 0-workers branch above both leave .worker-empty in DOM;
      // adding rows on top without removing it shows both at once).
      list.querySelectorAll('.worker-empty').forEach(el => el.remove());
      // Preserve expansion + tail content across re-render by reusing DOM nodes.
      const existing = new Map();
      list.querySelectorAll('.worker-row').forEach(el => existing.set(el.dataset.worker, el));
      const seen = new Set();
      for (const w of active) {
        seen.add(w.worker_id);
        // Date.parse handles both formats: SQLite 'YYYY-MM-DD HH:MM:SS' (local
        // tz, from updated_at fallback) and ISO '...Z' (from worker_started_at).
        const wStartedMs = Date.parse(w.started_at);
        const ageMin = Number.isNaN(wStartedMs) ? 0 : Math.max(0, Math.round((Date.now() - wStartedMs) / 60000));
        let row = existing.get(w.worker_id);
        if (!row) {
          row = document.createElement('div');
          row.className = 'worker-row';
          row.dataset.worker = w.worker_id;
          row.dataset.logPath = w.log_path || '';
          // Icon by task_kind: recovery tasks get a wrench to distinguish
          // self-healing from normal work. Avoids a separate UI lane.
          const icon = (w.task_kind === 'recovery.heal') ? '🔧' : '🤖';
          if (w.task_kind === 'recovery.heal') row.classList.add('is-recovery');
          row.innerHTML =
            '<div class="wr-head">' +
              '<span class="wr-icon">' + icon + '</span>' +
              '<span class="wr-title"></span>' +
              '<span class="wr-age"></span>' +
            '</div>' +
            '<div class="wr-sub"></div>' +
            '<div class="worker-tail"></div>';
          row.addEventListener('click', () => toggleWorker(row));
          list.appendChild(row);
        }
        row.dataset.logPath = w.log_path || '';
        // Update icon if task_kind changed across renders (shouldn't happen
        // for a given task_id, but cheap to keep consistent).
        const iconNow = (w.task_kind === 'recovery.heal') ? '🔧' : '🤖';
        const iconEl = row.querySelector('.wr-icon');
        if (iconEl && iconEl.textContent !== iconNow) iconEl.textContent = iconNow;
        row.classList.toggle('is-recovery', w.task_kind === 'recovery.heal');
        row.querySelector('.wr-title').textContent = '#' + w.task_id + ' ' + (w.title || '').slice(0, 60);
        row.querySelector('.wr-age').textContent = ageMin + 'm';
        // Worker subtitle: show token speed (tok/s) if available, else worker_id.
        // tok/s = total thinking_tokens / elapsed_seconds — a live throughput
        // indicator. Helps spot slow models vs fast ones at a glance.
        const tps = w.tokens_per_sec;
        const tt = w.total_tokens;
        if (tps != null && tt != null) {
          row.querySelector('.wr-sub').textContent = tps + ' tok/s · ' + (tt > 1000 ? (tt / 1000).toFixed(1) + 'k' : tt) + ' total';
        } else {
          row.querySelector('.wr-sub').textContent = w.worker_id;
        }
        if (expandedWorkers.has(w.worker_id)) row.classList.add('expanded');
      }
      // Remove rows for workers no longer active.
      for (const [wid, el] of existing) {
        if (!seen.has(wid)) { el.remove(); expandedWorkers.delete(wid); }
      }
    }
    async function toggleWorker(row) {
      const wid = row.dataset.worker;
      const isExpanded = expandedWorkers.has(wid);
      if (isExpanded) {
        expandedWorkers.delete(wid);
        row.classList.remove('expanded');
      } else {
        expandedWorkers.add(wid);
        row.classList.add('expanded');
        await loadWorkerTail(row);
      }
    }
    async function loadWorkerTail(row) {
      const logPath = row.dataset.logPath;
      const tailEl = row.querySelector('.worker-tail');
      if (!logPath || !tailEl) return;
      tailEl.innerHTML = '<div class="evt">загрузка…</div>';
      try {
        const r = await fetch('/api/worker/tail?log_path=' + encodeURIComponent(logPath) + '&lines=10');
        const j = await r.json();
        if (!j.ok) { tailEl.innerHTML = '<div class="evt system"><span class="evt-tag">err</span>' + esc(j.error || 'failed') + '</div>'; return; }
        if (!j.events || j.events.length === 0) {
          tailEl.innerHTML = '<div class="evt"><span class="evt-tag">empty</span>воркер ещё не писал</div>';
          return;
        }
        tailEl.innerHTML = j.events.map(e => {
          const cls = e.kind || e.type || 'raw';
          let tag = e.type || 'raw';
          let body = '';
          if (e.kind === 'tool') body = (e.tool || '') + ' ' + (e.snippet || '');
          else if (e.kind === 'text') body = e.snippet || '';
          else if (e.kind === 'tool_result') body = '→ ' + (e.snippet || '');
          else if (e.kind === 'result') body = 'turns=' + (e.num_turns||'?') + ' cost=$' + (e.cost_usd||0).toFixed(4) + ' ' + (e.subtype||'');
          else if (e.kind === 'system') body = 'subtype=' + (e.subtype||'?');
          else body = e.snippet || '';
          const sub = e.subagent ? '<span class="evt-sub">subagent</span>' : '';
          return '<div class="evt ' + cls + '"><span class="evt-tag">' + tag + '</span>' + esc(body).slice(0, 200) + sub + '</div>';
        }).join('');
      } catch (err) {
        tailEl.innerHTML = '<div class="evt system"><span class="evt-tag">net</span>' + esc(err.message) + '</div>';
      }
    }
    // Auto-refresh expanded worker tails every 3s.
    setInterval(() => {
      document.querySelectorAll('.worker-row.expanded').forEach(row => loadWorkerTail(row));
    }, 3000);

    // Pipeline bar — refresh every RELOAD_SEC.
    async function refreshPipeline() {
      const stagesEl = document.getElementById('pipeline-stages');
      if (!stagesEl) return;
      const epicId = window.__sagaEpicId;
      if (!epicId) return;
      try {
        const r = await fetch('/api/episode/pipeline?epic_id=' + epicId);
        const j = await r.json();
        if (!j.ok) { stagesEl.innerHTML = '<span class="worker-empty">' + esc(j.error || 'err') + '</span>'; return; }
        const icons = { completed:'✓', in_progress:'●', needs_human:'⚠', pending:'○' };
        icons.failed = 'x';
        // Clickable stages: completed / in_progress / needs_human.
        // Pending is muted and not clickable (no data-stage, no click handler).
        stagesEl.innerHTML = j.stages.map((s, i) => {
          const cls = s.status;
          const icon = icons[s.status] || '?';
          const name = s.name.charAt(0).toUpperCase() + s.name.slice(1);
          const dur = s.duration_s != null ? formatDur(s.duration_s) : '';
          const clickable = s.status !== 'pending';
          const attrs = clickable ? (' data-stage="' + esc(s.name) + '" title="Click for stage detail"') : '';
          const stage = '<div class="pipeline-stage ' + cls + '"' + attrs + '>' +
            '<span class="ps-icon">' + icon + '</span>' +
            '<span class="ps-name">' + name + '</span>' +
            '<span class="ps-dur">' + dur + '</span>' +
          '</div>';
          const arrow = (i < j.stages.length - 1) ? '<div class="pipeline-arrow">→</div>' : '';
          return stage + arrow;
        }).join('');
        // Wire click handlers on clickable stages (event delegation would also
        // work, but attaching once per refresh is cheap and survives the
        // innerHTML swap cleanly).
        stagesEl.querySelectorAll('.pipeline-stage[data-stage]').forEach(el => {
          el.addEventListener('click', () => {
            // Open stage detail as a separate page (new tab). More reliable
            // than overlay — no z-index/DOM timing issues.
            const epicId = window.__sagaEpicId;
            if (epicId) window.open('/stage?epic=' + epicId + '&stage=' + el.dataset.stage, '_blank');
          });
        });
      } catch {}
    }
    // --- Stage detail overlay (clickable pipeline) ---
    // Shows a stage SUMMARY (markdown) generated on demand by a summary.stage
    // worker task. First click for a stage spawns the task; subsequent clicks
    // either show the accepted summary or poll until the worker finishes.
    // Backend: GET /api/episode/stage-summary?epic_id=N&stage=X returns one of:
    //   { ok, status:'ready',     artifact_id, content, generated_at }
    //   { ok, status:'generating', task_id }
    //   { ok, status:'queued',     task_id }
    const sdoOverlay = document.getElementById('stage-detail-overlay');
    const sdoTitle = document.getElementById('sdo-title');
    const sdoDur = document.getElementById('sdo-dur');
    const sdoDesc = document.getElementById('sdo-desc');
    const sdoBody = document.getElementById('sdo-body');
    const sdoClose = document.getElementById('sdo-close');
    // One poller at a time per overlay. We tag the poll with a token so a
    // rapid click on a different stage (or closing the panel) cancels the
    // previous poll cleanly.
    let sdoPollToken = 0;
    function hideStageDetail() {
      if (sdoOverlay) sdoOverlay.classList.remove('visible');
      sdoPollToken++; // invalidate any in-flight poller
    }
    async function openStageDetail(stage) {
      if (!sdoOverlay) return;
      const epicId = window.__sagaEpicId;
      if (!epicId || !stage) return;
      // Render shell immediately so the user sees the panel slide in while the
      // fetch is in flight. Title is known client-side.
      const titleMap = { discovery:'Открытие', formalization:'Формализация', planning:'Планирование', development:'Разработка', verification:'Верификация', integration:'Интеграция', completed:'Завершено' };
      if (sdoTitle) sdoTitle.textContent = titleMap[stage] || stage;
      if (sdoDur) sdoDur.textContent = '';
      if (sdoDesc) sdoDesc.textContent = 'Stage summary — generated on demand by a worker task.';
      if (sdoBody) sdoBody.innerHTML = '<div class="sdo-loading">loading…</div>';
      sdoOverlay.classList.add('visible');
      const myToken = ++sdoPollToken;
      await pollStageSummary(epicId, stage, myToken);
    }
    // Poll loop: fetch the endpoint; if status is 'ready' render and stop; if
    // 'queued' or 'generating' show the progress message and retry in 3s.
    // The token cancels the loop if the user closed the overlay or opened a
    // different stage.
    async function pollStageSummary(epicId, stage, token) {
      while (true) {
        if (token !== sdoPollToken) return; // cancelled
        let j;
        try {
          const r = await fetch('/api/episode/stage-summary?epic_id=' + encodeURIComponent(epicId) + '&stage=' + encodeURIComponent(stage));
          j = await r.json();
        } catch (e) {
          if (sdoBody && token === sdoPollToken) sdoBody.innerHTML = '<div class="sdo-err">' + esc(String(e && e.message || e)) + '</div>';
          return;
        }
        if (token !== sdoPollToken) return; // cancelled mid-fetch
        if (!j.ok) {
          if (sdoBody) sdoBody.innerHTML = '<div class="sdo-err">' + esc(j.error || 'failed to load') + '</div>';
          return;
        }
        if (j.status === 'ready') {
          renderStageSummary(stage, j);
          return;
        }
        // queued or generating — show progress, schedule next poll.
        const label = j.status === 'generating' ? 'догенерируется' : 'в очереди';
        const taskId = j.task_id != null ? (' (task #' + esc(j.task_id) + ')') : '';
        if (sdoBody) sdoBody.innerHTML = '<div class="sdo-loading">Резюме ' + esc(label) + taskId + '…</div>';
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    // Render the accepted summary: minimal markdown -> HTML. No external lib:
    // split on blank lines into paragraphs; **bold** -> <strong>; lines
    // starting with - or * become <ul><li>. Headings (#) get <strong> too.
    function renderStageSummary(stage, j) {
      if (sdoDur && j.generated_at) {
        sdoDur.textContent = 'generated ' + j.generated_at;
      } else if (sdoDur) {
        sdoDur.textContent = '';
      }
      const md = String(j.content || '').trim();
      if (!md) {
        if (sdoBody) sdoBody.innerHTML = '<div class="sdo-empty">summary artifact is empty</div>';
        return;
      }
      if (sdoBody) sdoBody.innerHTML = renderSummaryMarkdown(md);
    }
    // Minimal markdown renderer for stage summaries. Supports:
    //   - blank-line separated paragraphs
    //   - "- " / "* " bulleted lists (consecutive lines grouped into <ul>)
    //   - **bold** inline
    //   - "# heading" / "## heading" -> <strong> (single line)
    // Anything else is escaped and treated as a paragraph. No HTML is passed
    // through raw — every text node goes through esc().
    function renderSummaryMarkdown(md) {
      // All regex here use new RegExp() instead of literal /.../ syntax because
      // this entire JS block lives inside a template literal (backtick string).
      // In a template literal, backslash-r and backslash-n are interpreted as
      // actual CR/LF characters, not as regex escape sequences — which produces
      // "Invalid regular expression: missing /" in the browser.
      var reCRLF = new RegExp('\\\\r\\\\n', 'g');
      var reSplitBlocks = new RegExp('\\\\n{2,}');
      var reTrimNl = new RegExp('^\\\\n+|\\\\n+$', 'g');
      var reHeading = new RegExp('^#{1,4}\\\\s+');
      var reListLine = new RegExp('^\\\\s*[-*]\\\\s+');
      var reStripList = new RegExp('^\\\\s*[-*]\\\\s+');
      var reStripHash = new RegExp('^#{1,4}\\\\s+');
      var blocks = String(md).replace(reCRLF, '\\n').split(reSplitBlocks);
      var out = [];
      for (var bi = 0; bi < blocks.length; bi++) {
        var block = blocks[bi].replace(reTrimNl, '');
        if (!block) continue;
        var lines = block.split('\\n');
        if (lines.length === 1 && reHeading.test(lines[0])) {
          var text = lines[0].replace(reStripHash, '');
          out.push('<p class="sdo-md-h">' + renderSummaryInline(text) + '</p>');
          continue;
        }
        var allList = true;
        for (var li = 0; li < lines.length; li++) {
          if (!reListLine.test(lines[li])) { allList = false; break; }
        }
        if (lines.length > 0 && allList) {
          var items = lines.map(function(l) { return '<li>' + renderSummaryInline(l.replace(reStripList, '')) + '</li>'; }).join('');
          out.push('<ul class="sdo-md-ul">' + items + '</ul>');
          continue;
        }
        var para = lines.map(function(l) { return l.trim(); }).filter(Boolean).join(' ');
        out.push('<p class="sdo-md-p">' + renderSummaryInline(para) + '</p>');
      }
      return out.join('');
    }
    function renderSummaryInline(text) {
      var esc2 = window.esc(text);
      var BT = String.fromCharCode(96);
      var reCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
      var reBold = new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g');
      return esc2
        .replace(reBold, '<strong>$1</strong>')
        .replace(reCode, '<code>$1</code>');
    }
    // Close handlers: close button, click on backdrop (not on panel itself),
    // and Esc key. The panel stops propagation so clicks inside it don't close.
    if (sdoClose) sdoClose.addEventListener('click', hideStageDetail);
    if (sdoOverlay) {
      sdoOverlay.addEventListener('click', e => { if (e.target === sdoOverlay) hideStageDetail(); });
      sdoOverlay.querySelector('.stage-detail-panel')?.addEventListener('click', e => e.stopPropagation());
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && sdoOverlay && sdoOverlay.classList.contains('visible')) hideStageDetail(); });
    function formatDur(sec) {
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60); const s = sec % 60;
      if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
      const h = Math.floor(m / 60);
      return h + 'h' + (m % 60) + 'm';
    }
    setInterval(refreshPipeline, ${RELOAD_SEC * 1000});
    refreshPipeline();

    async function fetchRunnerStatus() {
      try {
        const r = await fetch('/api/board-run/status?project_id=${projectId}');
        if (r.ok) applyRunnerState((await r.json()).run);
      } catch {}
    }
    // Concurrency selector — on change, restart engine with new value.
    // Engine state (tasks, artifacts, episode stage) is preserved across
    // restart because everything lives in the shared SQLite DB.
    runnerConcurrency.addEventListener('change', async () => {
      const newConc = Number(runnerConcurrency.value);
      // Concurrency change is now a PURE METADATA WRITE — no kill, no spawn.
      // The engine's pump loop re-reads $.engine_concurrency every cycle and
      // converges to the new target naturally (active workers finish, no
      // replacements spawn above the new ceiling, OR new ones spawn to fill
      // up if raised). Same semantics as the model selector. Rate-limit
      // scheduler in the engine already handles 429 backoff/recovery on top.
      runnerStatus.textContent = 'concurrency=' + newConc + ' (плавно)';
      runnerConcurrency.disabled = true;
      try {
        const r = await fetch('/api/engine/concurrency', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({epic_id: window.__sagaEpicId, concurrency: newConc})
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'не удалось сохранить');
        runnerStatus.textContent = 'concurrency=' + data.concurrency + ' ✓';
      } catch (e) {
        alert('Смена concurrency: ' + e.message);
        runnerStatus.textContent = 'ошибка';
        syncConcurrencyFromEngine();
      } finally {
        runnerConcurrency.disabled = false;
      }
    });
    // --- Engine Start/Pause toggle button ---
    //▶ starts the engine (spawn orchestrate-cli with current concurrency).
    //⏸ stops the engine + workers (kill tree, no respawn). Persists
    // $.engine_running in episode_workflows.metadata so the next page load
    // shows the right icon. Token-safety: the engine only starts when the
    // user explicitly presses ▶ — never automatically.
    const engineToggle = document.getElementById('agent-engine-toggle');
    if (engineToggle) {
      engineToggle.addEventListener('click', async () => {
        const epicId = window.__sagaEpicId;
        if (!epicId) return;
        // Read current state to decide direction.
        let running = engineToggle.classList.contains('engine-running');
        if (running) {
          if (!confirm('Остановить движок этого эпизода? Активные воркеры будут убиты. Задачи останутся в очереди.')) return;
          engineToggle.disabled = true;
          runnerStatus.textContent = 'остановка…';
          try {
            const r = await fetch('/api/engine/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ epic_id: epicId }),
            });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || 'не удалось остановить');
            syncEngineToggleButton(false);
            runnerStatus.textContent = 'движок остановлен';
          } catch (e) {
            alert('Стоп движка: ' + e.message);
            runnerStatus.textContent = 'ошибка';
          } finally {
            engineToggle.disabled = false;
          }
        } else {
          const conc = Number(runnerConcurrency?.value) || 4;
          if (!confirm('Запустить движок с concurrency=' + conc + '? Будут созданы воркеры (claude -p), расходующие токены.')) return;
          engineToggle.disabled = true;
          runnerStatus.textContent = 'старт…';
          try {
            const r = await fetch('/api/engine/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ epic_id: epicId, concurrency: conc }),
            });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || 'не удалось запустить');
            syncEngineToggleButton(true);
            runnerStatus.textContent = 'concurrency=' + d.concurrency + ' (pid ' + d.engine_pid + ')';
          } catch (e) {
            alert('Старт движка: ' + e.message);
            runnerStatus.textContent = 'ошибка';
          } finally {
            engineToggle.disabled = false;
          }
        }
      });
    }
    // Helper: sync the toggle button visual + aria from a running=true/false.
    function syncEngineToggleButton(running) {
      if (!engineToggle) return;
      engineToggle.textContent = running ? '⏸' : '▶';
      engineToggle.classList.toggle('engine-running', running);
      engineToggle.title = running
        ? 'Движок работает. Нажми для паузы.'
        : 'Движок остановлен. Нажми для запуска.';
    }
    async function syncEngineStatus() {
      const epicId = window.__sagaEpicId;
      if (!epicId || !engineToggle) return;
      try {
        const r = await fetch('/api/engine/status?epic_id=' + epicId);
        const state = await r.json();
        if (!r.ok || !state.ok) return;
        syncEngineToggleButton(state.running && state.alive);
        if (state.running && state.alive) {
          runnerStatus.textContent = 'Saga 3 running (pid ' + state.pid + ')';
        } else if (state.engine_last_error) {
          runnerStatus.textContent = 'stopped: ' + state.engine_last_error;
        } else {
          runnerStatus.textContent = 'Saga 3 stopped';
        }
      } catch {}
    }
    syncEngineStatus();
    setInterval(syncEngineStatus, 5000);
    // Model selector: change the worker model. PATCHes ~/.claude/settings.json
    // so NEW workers (spawned after this call) read the new model. Active
    // workers keep the old model — they have already started claude -p. NO
    // engine restart, NO worker kill. The model limit is a CEILING for the
    // engine pump loop (min(concurrency, active_model_limit)); old workers
    // die naturally, new ones spawn on the new model, concurrency converges.
    const modelSelect = document.getElementById('agent-model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', async () => {
        const modelId = modelSelect.value;
        // Sentinel "↻ обновить список": probe LM Studio and reload the page so
        // the optgroup re-renders with the live model list. No model switch.
        if (modelId === '__lmstudio_refresh') {
          runnerStatus.textContent = 'опрос LM Studio…';
          try {
            const r = await fetch('/api/lmstudio/models');
            const d = await r.json();
            runnerStatus.textContent = d.online
              ? 'LM Studio: ' + d.models.length + ' мод. — перезагрузка…'
              : 'LM Studio офлайн (' + (d.error || '?') + ')';
            setTimeout(() => location.reload(), 700);
          } catch (e) {
            alert('Опрос LM Studio: ' + e.message);
            runnerStatus.textContent = 'ошибка опроса';
          }
          return;
        }
        const limit = Number(modelSelect.options[modelSelect.selectedIndex].dataset.limit);
        const provider = modelSelect.options[modelSelect.selectedIndex].dataset.provider || 'zai';
        if (!modelId) return;
        const where = provider === 'lmstudio' ? ' (локально, LM Studio)' : ' (облако Z.ai)';
        if (!confirm('Сменить модель на ' + modelId + where + '? Активные воркеры доработают на старой модели. Новые воркеры пойдут на ' + modelId + '.')) {
          return;
        }
        runnerStatus.textContent = 'смена модели…';
        modelSelect.disabled = true;
        try {
          const r = await fetch('/api/model/set', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({model: modelId, epic_id: window.__sagaEpicId}),
          });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || 'смена не удалась');
          // The model limit is a CEILING, not a forced value — only clamp the
          // concurrency selector down if the user's current pick exceeds the
          // new model's limit. Otherwise leave it alone.
          runnerStatus.textContent = data.model + ' ×' + data.limit;
        } catch (e) {
          alert('Смена модели: ' + e.message);
          runnerStatus.textContent = 'ошибка';
        } finally {
          modelSelect.disabled = false;
        }
      });
    }
    // Sync selector + status from engine state in episode_workflows.metadata.
    async function syncConcurrencyFromEngine() {
      try {
        const epicId = window.__sagaEpicId;
        if (!epicId) return;
        const r = await fetch('/api/episode/pipeline?epic_id=' + epicId);
        const j = await r.json();
        // engine_concurrency comes through pipeline endpoint via metadata.
        // We didn't expose it explicitly — read via a quick raw meta fetch.
      } catch {}
      // Direct DB read via a tiny endpoint is overkill; instead use the
      // workers/active count as a proxy signal that engine is alive, and
      // keep the selector at whatever the user picked. Engine_concurrency
      // is persisted in episode_workflows.metadata.engine_concurrency but
      // we don't expose it through pipeline yet — leave as TBD.
    }
    // Apply initial status: read from a one-shot endpoint would be cleanest,
    // but for now just mark "engine running" if workers come back non-empty
    // via refreshDbWorkers (already running every 2s).
    runnerStatus.textContent = 'concurrency=' + (runnerConcurrency?.value || '1');
    fetchRunnerStatus();
    setInterval(fetchRunnerStatus, 2000);
    // Apply the streaming pulse to kanban cards whose worker is actively
    // writing to its JSONL log. Called (a) from renderWorkersList whenever
    // /api/workers/active returns fresh data, and (b) from refreshBoard
    // after the .board DOM was swapped — because replaceWith drops the
    // classes we previously added to the old .hb-dot nodes. A dot is
    // Card status dot recoloured from REAL worker activity, not DB row mtimes.
    // Same 3-colour scheme the user is used to (green/yellow/red by age), but
    // the age is measured from the worker's last JSONL write (log_mtime_ms),
    // so an actively-streaming worker stays green even when task.updated_at
    // hasn't moved for minutes.
    function applyStreamingDots() {
      const map = window.__activeWorkers;
      if (!map || map.size === 0) return;
      const now = Date.now();
      document.querySelectorAll('.card').forEach(card => {
        const taskId = Number(card.dataset.task);
        if (!taskId) return;
        const w = map.get(taskId);
        if (!w) return;
        const dot = card.querySelector('.hb-dot');
        if (!dot) return;
        if (w.log_mtime_ms == null) return;
        const ageS = Math.max(0, Math.floor((now - w.log_mtime_ms) / 1000));
        // Backend flags the worker as stale when log hasn't grown for >30s —
        // likely a dead subprocess without a fired close event. Show instant
        // red (no pulse, no yellow transition) so the user sees the death
        // immediately instead of watching yellow for 30 seconds.
        let cls, pulse;
        if (w.is_stale) { cls = 'red'; pulse = ''; }
        else if (ageS < 5) { cls = 'green'; pulse = 'pulse-fast'; }
        else if (ageS < 15) { cls = 'green'; pulse = 'pulse-med'; }
        else if (ageS < 30) { cls = 'yellow'; pulse = 'pulse-med'; }
        else { cls = 'yellow'; pulse = 'pulse-slow'; }
        dot.classList.remove('green', 'yellow', 'red', 'streaming', 'pulse-fast', 'pulse-med', 'pulse-slow');
        dot.classList.add(cls);
        if (pulse) dot.classList.add(pulse);
        dot.title = (w.is_stale ? 'STALE ' : '') + ageS + 's ago (' + (w.worker_id || '?') + ')';
      });
    }
    async function refreshBoard() {
      try {
        const r = await fetch('?project=${projectId}&partial=1');
        if (!r.ok) return;
        const html = await r.text();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        // Swap the kanban columns...
        const oldBoard = document.querySelector('.board');
        const newBoard = tmp.querySelector('.board');
        if (oldBoard && newBoard) oldBoard.replaceWith(newBoard);
        // ...and the episode-progress-bar (so Resume button / needs-human
        // badge / gate-blocked badge update without a full page reload).
        const oldBar = document.querySelector('.episode-progress-bar');
        const newBar = tmp.querySelector('.episode-progress-bar');
        if (oldBar && newBar) {
          oldBar.replaceWith(newBar);
          // Re-bind click handlers on the freshly inserted Resume buttons
          // (replaceWith drops any listeners attached to the old nodes).
          document.querySelectorAll('.episode-resume').forEach(button => button.addEventListener('click', async () => {
            try {
              const epicId = Number(button.dataset.epic);
              const r2 = await fetch('/api/episode/resume', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({epic_id: epicId}),
              });
              const j2 = await r2.json();
              if (j2.ok) {
                alert(j2.was_paused
                  ? 'Флаг needs-human снят. Движок продолжит в течение 10 сек.'
                  : 'Флаг уже снят.');
              } else { alert('Ошибка: ' + (j2.error||'?')); }
            } catch (err) { alert('Сеть: ' + err.message); }
          }));
        }
        applyFilter();
        // .board was just swapped — re-stamp streaming dots on the fresh
        // .hb-dot nodes (their classes were lost with the old DOM).
        applyStreamingDots();
      } catch {}
    }
    setInterval(refreshBoard, ${RELOAD_SEC * 1000});
    </script>`);
}

// --- HTML: дерево артефактов одного проекта (вкладка Артефакты) ---
// Header переиспользуется из renderBoard + переключатель табов.
// Тело: сводка по типам → дерево по эпикам (parent_artifact_id) → бейджи трасс
// под листьями (implements/verified_by/derived_from) → секция «Несвязанные».
function renderArtifacts(projectId, allProjects) {
  const proj = allProjects.find(p => String(p.id) === String(projectId));
  if (!proj) return page('Проект не найден', '<div class="empty-box"><h2>Проект не найден</h2></div>');

  const data = loadArtifactsTree(projectId);
  const opts = allProjects.map(p => `<option value="${p.id}"${String(p.id)===String(projectId)?' selected':''}>${esc(p.name)}</option>`).join('');

  // Header с переключателем табов. Текущий таб — artifacts.
  const header = `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <select id="psel" onchange="location='?project='+this.value+'&tab=artifacts'">${opts}</select>
      <span class="cur-proj" style="color:${proj.color}">${esc(proj.name)}</span>
      <div class="tabs">
        <a class="tab" href="?project=${projectId}">Канбан</a>
        <a class="tab active" href="?project=${projectId}&tab=artifacts">Артефакты</a>
        <a class="tab" href="?project=${projectId}&tab=coverage">Покрытие</a>
        <a class="tab" href="?project=${projectId}&tab=acceptance">Приёмка</a>
      </div>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  if (data.unavailable) {
    return page(proj.name + ' · Артефакты', `${header}
      <div class="empty-box">
        <div class="empty-icon">📐</div>
        <h2>Артефакты недоступны</h2>
        <p>В этой БД нет таблицы <code>artifacts</code> (старая версия saga-mcp).</p>
        <p>Запусти saga-mcp сервер против этой БД — он применит миграцию.</p>
      </div>`);
  }
  if (data.empty) {
    return page(proj.name + ' · Артефакты', `${header}
      <div class="empty-box">
        <div class="empty-icon">📐</div>
        <h2>В проекте нет артефактов</h2>
        <p>Артефакты (PRD/SRS/UC/AC/FR/NFR) создаются через saga-mcp<br>в эпизодах REQ-NNN (artifact_create).</p>
      </div>`);
  }

  const { artifacts, traces, tasksById, projectById } = data;

  // Индексы: дети по parent_artifact_id, трассы по source_id.
  const byParent = {};
  const tracesBySource = {};
  for (const a of artifacts) {
    const pid = a.parent_artifact_id;
    if (pid != null) (byParent[pid] ||= []).push(a);
    else (byParent['__root__'] ||= []).push(a);
  }
  for (const t of traces) (tracesBySource[t.source_id] ||= []).push(t);

  // Сводка по типам (chips).
  const byType = {};
  for (const a of artifacts) byType[a.type] = (byType[a.type] || 0) + 1;
  // Pipeline order (ADR-014): PRD → UC → AC → Reconcile → SRS. FR/NFR/RULE
  // are children of PRD now; SRS sits after the AC baseline. Chips display
  // in canonical pipeline order, not the pre-reorder PRD/SRS/UC sequence.
  const typeOrder = ['PRD','FR','NFR','RULE','UC','AC','SRS','decision','theme','brief'];
  const summaryChips = typeOrder
    .filter(t => byType[t])
    .map(t => `<span class="tchip" style="border-color:${TYPE_COLORS[t]};color:${TYPE_COLORS[t]}">${TYPE_LABEL[t]||t}: ${byType[t]}</span>`)
    .join('');

  // Сироты: нет родителя И нет исходящих трасс И не являются чьим-то родителем
  // И не являются target ни одной trace (например BRIEF — корень discovery,
  // не имеет parent_artifact_id, но PRD→BRIEF derived_from связывает его).
  //
  // ИСКЛЮЧЕНИЯ: summary-stage bookkeeping артефакты (STAGE-DISCOVERY-SUMMARY,
  // STAGE-FORMALIZATION-SUMMARY и т.д.) не являются частью traceability графа
  // по дизайну — это отчёты о завершении стадии. Они никогда не имеют parent
  // или traces, и не должны помечаться как «несвязанные» в UI.
  const parentIds = new Set(artifacts.filter(a => a.parent_artifact_id != null).map(a => a.parent_artifact_id));
  const isParent = new Set(parentIds);
  const tracesByTarget = new Set(traces.filter(t => t.target_type === 'artifact').map(t => t.target_id));
  const isStageSummary = (a) => a.type === 'decision' && typeof a.code === 'string'
    && /^STAGE-[A-Z]+-(SUMMARY|COMPLETED)$/i.test(a.code);
  const orphans = artifacts.filter(a =>
    a.parent_artifact_id == null
    && !isParent.has(a.id)
    && !tracesBySource[a.id]
    && !tracesByTarget.has(a.id)
    && !isStageSummary(a));
  const treeArts = artifacts.filter(a => !orphans.includes(a));

  // Группировка дерева по эпикам (REQ-NNN episode). Корни — без parent_artifact_id.
  const treeByEpic = {};
  for (const a of treeArts) (treeByEpic[a.epic_id] ||= []).push(a);
  const epicOrder = [...new Set(treeArts.map(a => a.epic_id))].sort((x, y) => x - y);

  function renderNode(art, depth) {
    const children = byParent[art.id] || [];
    const isLeaf = children.length === 0;
    const typeColor = TYPE_COLORS[art.type] || '#8b949e';
    const typeLabel = TYPE_LABEL[art.type] || art.type;
    const stColor = STATUS_COLOR[art.status] || '#8b949e';
    const stLabel = STATUS_LABEL[art.status] || art.status;
    const code = art.code ? esc(art.code) : '—';
    const tracesHtml = isLeaf ? renderTraces(art.id, tracesBySource, tasksById, projectById, projectId) : '';
    // ✎-карандаш → прямой переход в /artifact/<id>/edit (wiki-редактор).
    // Дублируется в обе ветки (узел с детьми + лист), чтобы редактор был
    // доступен из любого узла дерева без промежуточной страницы просмотра.
    const editLink = `<a class="aedit" href="/artifact/${art.id}/edit" title="Редактировать .md">✎</a>`;
    // collapse: узлы с детьми сворачиваются через <details>. Иконка-чип типа —
    // всегда видна (даже свёрнуто), title кликабелен → wiki-просмотр.
    const toggle = children.length
      ? `<details class="anode-det" data-id="${art.id}"><summary class="anode-head">
           <span class="atype" style="background:${typeColor}">${typeLabel}</span>
           <span class="acode">${code}</span>
           <a class="atitle" href="/?artifact=${art.id}">${esc(art.title)}</a>
           <span class="astatus" style="color:${stColor}" title="${esc(art.status)}">${stLabel}</span>
           ${editLink}
           <span class="collapse-hint">${children.length}↓</span>
         </summary>`
      : `<div class="anode-head leaf">
           <span class="atype" style="background:${typeColor}">${typeLabel}</span>
           <span class="acode">${code}</span>
           <a class="atitle" href="/?artifact=${art.id}">${esc(art.title)}</a>
           <span class="astatus" style="color:${stColor}" title="${esc(art.status)}">${stLabel}</span>
           ${editLink}
         </div>`;
    const childrenHtml = children.length
      ? `<div class="children">${children.map(c => renderNode(c, depth + 1)).join('')}</div></details>`
      : '';
    return `<div class="anode" data-depth="${depth}">
      ${toggle}
      ${tracesHtml}
      ${childrenHtml}
    </div>`;
  }

  function renderTraces(artId, bySrc, tasks, projs, currentProjectId) {
    const ts = bySrc[artId];
    if (!ts || !ts.length) return '';
    // Группируем по link_type, внутри — по target (артефакт-code или таск-id).
    const byLink = {};
    for (const t of ts) (byLink[t.link_type] ||= []).push(t);
    const badges = Object.keys(byLink).map(link => {
      const color = LINK_COLORS[link] || '#8b949e';
      const glyph = LINK_GLYPH[link] || link;
      const targets = byLink[link].map(t => {
        if (t.target_type === 'artifact') {
          return `<span class="tg">${esc(t.target_code || ('#'+t.target_id))}</span>`;
        }
        // task
        const task = tasks[t.target_id];
        if (!task) return `<span class="tg">#${t.target_id}?</span>`;
        const tcolor = task.status === 'done' ? '#3fb950'
          : task.status === 'in_progress' ? '#f1c40f'
          : task.status === 'review' || task.status === 'review_in_progress' ? '#a371f7'
          : task.status === 'blocked' ? '#e74c3c'
          : '#8b949e';
        // Кросс-проектный бейдж (AC → DEV-таск в другом проекте).
        const projBadge = String(task.project_id) !== String(currentProjectId) && projs[task.project_id]
          ? `<span class="tg-proj" title="задача в проекте ${esc(projs[task.project_id])}">↤ ${esc(projs[task.project_id])}</span>`
          : '';
        // ФИЧА C: #id → кликабельная ссылка на /?task=N (был текст).
        return `${projBadge}<a class="tg tg-link" href="/?task=${task.id}" style="color:${tcolor}">#${task.id}<span class="tg-st"> ${esc(task.status)}</span></a>`;
      }).join(' ');
      return `<span class="trace-badge" style="border-color:${color};color:${color}">${glyph}: ${targets}</span>`;
    }).join(' ');
    return `<div class="traces">${badges}</div>`;
  }

  // Эпизоды (REQ-NNN) — верхний уровень дерева, разворачиваются по умолчанию.
  const epicByName = {};
  for (const a of artifacts) if (a.epic_name) epicByName[a.epic_id] = a.epic_name;
  const episodesHtml = epicOrder.map(eid => {
    const roots = (treeByEpic[eid] || []).filter(a => a.parent_artifact_id == null);
    if (!roots.length) return '';
    const name = epicByName[eid] || ('epic #' + eid);
    const nodes = roots.map(r => renderNode(r, 0)).join('');
    return `<details class="episode" open>
      <summary><span class="ep-name">${esc(name)}</span> <span class="ep-count">${(treeByEpic[eid]||[]).length}</span></summary>
      <div class="tree-root">${nodes}</div>
    </details>`;
  }).join('');

  // Сироты — отдельная секция внизу.
  const orphansByType = {};
  for (const o of orphans) (orphansByType[o.type] ||= []).push(o);
  const orphansHtml = orphans.length ? `<details class="episode orphans">
    <summary><span class="ep-name">Несвязанные</span> <span class="ep-count">${orphans.length}</span></summary>
    <div class="tree-root orphan-grid">
      ${typeOrder.filter(t => orphansByType[t]).map(t =>
        `<div class="orphan-group"><div class="orphan-type" style="color:${TYPE_COLORS[t]}">${TYPE_LABEL[t]||t}</div>${
          orphansByType[t].map(o => `<div class="anode shallow"><div class="anode-head">
            <span class="atype" style="background:${TYPE_COLORS[t]}">${TYPE_LABEL[t]||t}</span>
            <span class="acode">${o.code?esc(o.code):'—'}</span>
            <span class="atitle">${esc(o.title)}</span>
          </div></div>`).join('')
        }</div>`).join('')}
    </div>
  </details>` : '';

  return page(proj.name + ' · Артефакты', `${header}
    <div class="tree-summary">
      <div class="ts-stats">
        <span><b>${artifacts.length}</b> артефактов</span>
        <span><b>${traces.length}</b> трасс</span>
        <span><b>${epicOrder.length}</b> эпизодов</span>
      </div>
      <div class="ts-types">${summaryChips}</div>
    </div>
    <div class="tree-toolbar">
      <span class="tt-label">Дерево:</span>
      <button class="chip" id="expand-all" title="Развернуть все узлы">▸ Развернуть всё</button>
      <button class="chip" id="collapse-all" title="Свернуть все узлы (кроме эпизодов)">▾ Свернуть всё</button>
    </div>
    <div class="episodes">${episodesHtml}${orphansHtml}</div>
    <script>
    // Expand/collapse-all: переключает open у всех <details> внутри .episodes.
    // Эпизоды (REQ-NNN) при «свернуть всё» остаются открытыми — иначе дерево
    // превратится в набор невидимых заголовков; пользователь сворачивает узлы-артефакты.
    function detailsAll(open) {
      document.querySelectorAll('.episodes details').forEach(d => {
        if (open) d.open = true;
        else if (!d.classList.contains('episode')) d.open = false;
      });
    }
    document.getElementById('expand-all').addEventListener('click', () => detailsAll(true));
    document.getElementById('collapse-all').addEventListener('click', () => detailsAll(false));
    // Auto-refresh дерева через ?partial=2 (только .episodes).
    async function refreshTree() {
      try {
        const r = await fetch('?project=${projectId}&tab=artifacts&partial=2');
        if (!r.ok) return;
        const html = await r.text();
        const tmp = document.createElement('div'); tmp.innerHTML = html;
        const oldE = document.querySelector('.episodes');
        const newE = tmp.querySelector('.episodes');
        if (oldE && newE) {
          // Сохраняем состояние <details open> по первому summary тексту.
          const openKeys = new Set([...oldE.querySelectorAll('details[open]')].map(d => d.querySelector('summary')?.textContent?.trim()));
          oldE.replaceWith(newE);
          newE.querySelectorAll('details').forEach(d => {
            const k = d.querySelector('summary')?.textContent?.trim();
            if (openKeys.has(k)) d.open = true;
          });
        }
      } catch {}
    }
    setInterval(refreshTree, ${RELOAD_SEC * 1000});
    </script>`);
}

// --- HTML: wiki-просмотр артефакта (один документ) ---
// Маршрут: /?artifact=<id>. Рендерит .md файл артефакта + metadata (title/status/
// tags) + трассы. Кнопка «Редактировать» → /artifact/<id>/edit.
function renderArtifactView(artifactId, allProjects) {
  let art;
  try {
    art = withDb(db => db.prepare(`
      SELECT a.*, e.name AS epic_name, p.name AS project_name, p.id AS project_id,
        (SELECT pr.local_path FROM project_repositories pr WHERE pr.id=a.project_repository_id) AS repository_path
        FROM artifacts a
        JOIN epics e ON e.id = a.epic_id
        JOIN projects p ON p.id = e.project_id
       WHERE a.id = ?`).get(artifactId));
  } catch { art = null; }
  if (!art) return page('Артефакт не найден', '<div class="empty-box"><h2>Артефакт не найден</h2></div>');

  const proj = allProjects.find(p => String(p.id) === String(art.project_id));
  const projColor = proj?.color || '#8b949e';
  const resolved = resolveArtifactFile(art.path, art.project_name, art.repository_path);
  let md = '', mdError = '';
  if (resolved) {
    try { md = readFileSync(resolved.abs, 'utf8'); }
    catch (e) { mdError = `Ошибка чтения файла: ${e.message}`; }
  } else {
    mdError = `Файл не найден в репо проекта «${esc(art.project_name)}». Путь в БД: <code>${esc(art.path)}</code>`;
  }

  // Трассы (входящие + исходящие) для этого артефакта
  let tracesHtml = '';
  try {
    tracesHtml = withDb(db => {
      const out = db.prepare(`
        SELECT t.link_type, t.target_type, t.target_id,
          CASE WHEN t.target_type='artifact' THEN (SELECT a.code FROM artifacts a WHERE a.id=t.target_id) END AS target_code,
          CASE WHEN t.target_type='task' THEN (SELECT tk.status FROM tasks tk WHERE tk.id=t.target_id) END AS target_status
          FROM artifact_traces t WHERE t.source_id=? ORDER BY t.link_type`).all(artifactId);
      const inc = db.prepare(`
        SELECT t.link_type, t.source_id,
          (SELECT a.code FROM artifacts a WHERE a.id=t.source_id) AS src_code,
          (SELECT a.type FROM artifacts a WHERE a.id=t.source_id) AS src_type
          FROM artifact_traces t WHERE t.target_type='artifact' AND t.target_id=? ORDER BY t.link_type`).all(artifactId);
      const parts = [];
      // Исходящие traces. Для task-целей #id → кликабельная ссылка на /?task=N
      // (ФИЧА B): замыкаем цикл «док → задача»). Цвет ссылки по статусу задачи.
      if (out.length) parts.push('<div class="tr-sec"><b>Исходящие:</b> ' + out.map(t => {
        const lc = LINK_COLORS[t.link_type] || '#8b949e';
        let inner;
        if (t.target_type === 'task') {
          const tsc = t.target_status === 'done' ? '#3fb950'
            : t.target_status === 'in_progress' ? '#f1c40f'
            : (t.target_status === 'review' || t.target_status === 'review_in_progress') ? '#a371f7'
            : t.target_status === 'blocked' ? '#e74c3c' : '#8b949e';
          inner = `<a class="tg-link" href="/?task=${t.target_id}" style="color:${tsc}">#${t.target_id}${t.target_status ? `<span class="tg-st"> ${esc(t.target_status)}</span>` : ''}</a>`;
        } else {
          inner = esc(t.target_code || ('#'+t.target_id));
        }
        return `<span class="trace-badge" style="border-color:${lc};color:${lc}">${LINK_GLYPH[t.link_type]||t.link_type}: ${inner}</span>`;
      }).join(' ') + '</div>');
      if (inc.length) parts.push('<div class="tr-sec"><b>Входящие:</b> ' + inc.map(t =>
        `<a class="trace-badge" href="?artifact=${t.source_id}" style="border-color:${LINK_COLORS[t.link_type]||'#8b949e'};color:${LINK_COLORS[t.link_type]||'#8b949e'}">${LINK_GLYPH[t.link_type]||t.link_type} ← ${esc(t.src_code||('#'+t.source_id))}</a>`).join(' ') + '</div>');
      return parts.join('');
    });
  } catch {}

  const statusOpts = ['draft','in_review','accepted','superseded']
    .map(s => `<option value="${s}"${s===art.status?' selected':''}>${s}</option>`).join('');
  const typeColor = TYPE_COLORS[art.type] || '#8b949e';

  const header = `
    <div class="board-head">
      <a href="/?project=${art.project_id}&tab=artifacts" class="back">← Дерево</a>
      <a href="/?project=${art.project_id}" class="back" style="margin-left:-4px">Канбан</a>
      <span class="atype" style="background:${typeColor}">${TYPE_LABEL[art.type]||art.type}</span>
      <span class="acode">${esc(art.code || '—')}</span>
      <span class="atitle-top">${esc(art.title)}</span>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  const bodyHtml = `
    <div class="wiki-meta">
      <div class="wm-row"><span class="wm-label">Проект</span><span class="wm-val" style="color:${projColor}">${esc(art.project_name)}</span></div>
      <div class="wm-row"><span class="wm-label">Эпизод</span><span class="wm-val">${esc(art.epic_name||'—')}</span></div>
      <div class="wm-row"><span class="wm-label">Статус</span><span class="wm-val"><span class="astatus" style="color:${STATUS_COLOR[art.status]||'#8b949e'}">${STATUS_LABEL[art.status]||art.status}</span></span></div>
      <div class="wm-row"><span class="wm-label">Файл</span><span class="wm-val mono">${resolved ? esc(resolved.abs) : '<span class="muted">'+mdError+'</span>'}</span></div>
      <div class="wm-row"><span class="wm-label">Обновлён</span><span class="wm-val">${esc(art.updated_at)}</span></div>
      <div class="wm-actions">
        <a class="btn" href="/artifact/${artifactId}/edit">✎ Редактировать</a>
      </div>
    </div>
    ${tracesHtml ? `<div class="wiki-traces">${tracesHtml}</div>` : ''}
    <div class="wiki-content">
      ${mdError && !resolved ? `<div class="md-error">${mdError}</div>` : renderMarkdown(md)}
    </div>`;

  return page(`${art.code || art.type} · ${art.title}`, header + bodyHtml);
}

// --- HTML: wiki-редактор артефакта ---
// GET /artifact/<id>/edit — форма (textarea + поля metadata).
// POST /api/artifact/save — сохранение (см. роутинг).
function renderArtifactEdit(artifactId, allProjects, flash) {
  let art;
  try {
    art = withDb(db => db.prepare(`
      SELECT a.*, p.name AS project_name, p.id AS project_id,
        (SELECT pr.local_path FROM project_repositories pr WHERE pr.id=a.project_repository_id) AS repository_path
        FROM artifacts a JOIN epics e ON e.id=a.epic_id JOIN projects p ON p.id=e.project_id
       WHERE a.id = ?`).get(artifactId));
  } catch { art = null; }
  if (!art) return page('Артефакт не найден', '<div class="empty-box"><h2>Артефакт не найден</h2></div>');

  const resolved = resolveArtifactFile(art.path, art.project_name, art.repository_path);
  let md = '';
  if (resolved) { try { md = readFileSync(resolved.abs, 'utf8'); } catch {} }
  const typeColor = TYPE_COLORS[art.type] || '#8b949e';
  const statusOpts = ['draft','in_review','accepted','superseded']
    .map(s => `<option value="${s}"${s===art.status?' selected':''}>${s}</option>`).join('');
  // tags хранится как JSON-массив строк
  let tagsArr = [];
  try { tagsArr = JSON.parse(art.tags || '[]'); } catch {}
  const tagsStr = tagsArr.join(', ');

  const header = `
    <div class="board-head">
      <a href="/?artifact=${artifactId}" class="back">← Просмотр</a>
      <span class="atype" style="background:${typeColor}">${TYPE_LABEL[art.type]||art.type}</span>
      <span class="acode">${esc(art.code || '—')}</span>
      <span class="atitle-top">Редактирование</span>
    </div>`;

  return page(`Edit · ${art.code || art.type}`, `
    ${header}
    ${flash ? `<div class="flash ${flash.kind||'ok'}">${esc(flash.msg)}</div>` : ''}
    <form class="editor" method="POST" action="/api/artifact/save">
      <input type="hidden" name="id" value="${artifactId}">
      <div class="ed-meta">
        <label class="ed-field"><span>Заголовок</span><input type="text" name="title" value="${esc(art.title)}"></label>
        <label class="ed-field ed-status"><span>Статус</span><select name="status">${statusOpts}</select></label>
        <label class="ed-field ed-tags"><span>Теги (через запятую)</span><input type="text" name="tags" value="${esc(tagsStr)}"></label>
      </div>
      <div class="ed-md-wrap">
        <label class="ed-md-label">Содержимое документа (.md)
          ${resolved ? `<span class="muted mono small">→ ${esc(resolved.abs)}</span>` : `<span class="warn">файл не существует — будет создан</span>`}
        </label>
        <textarea name="markdown" class="ed-md" spellcheck="false">${esc(md)}</textarea>
      </div>
      <div class="ed-actions">
        <button type="submit" class="btn primary">💾 Сохранить</button>
        <a class="btn" href="/?artifact=${artifactId}">Отмена</a>
      </div>
    </form>
    <script>
    // Progressive enhancement: форма сабмитится через fetch → JSON.
    // Успех → редирект на просмотр. Ошибка → flash-сообщение.
    document.querySelector('form.editor').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const data = new URLSearchParams(new FormData(f));
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Сохранение…';
      try {
        const r = await fetch('/api/artifact/save', { method:'POST', body:data });
        const j = await r.json();
        if (j.ok) { location.href = '/?artifact=${artifactId}'; }
        else {
          btn.disabled = false; btn.textContent = '💾 Сохранить';
          alert('Ошибка сохранения: ' + (j.error || 'неизвестная'));
        }
      } catch (err) {
        btn.disabled = false; btn.textContent = '💾 Сохранить';
        alert('Сеть: ' + err.message);
      }
    });
    </script>`);
}
// --- HTML: карточка задачи (Jira-style detail view) ---
// Маршрут: /?task=<id>. Полная карточка одной saga-задачи: описание (markdown),
// метаданные, worktree-статус ветки/мержа, комментарии (read-only), subtasks,
// зависимости (depends_on / blocks), обратные traces к артефактам (AC/FR).
// Замыкает цикл «задача → док»: каждая implements trace кликабельна → /?artifact=N,
// каждая зависимость — → /?task=N. source_ref парсится; если есть обратная trace
// implements, показываем кликабельную ссылку прямо на wiki AC-документа.
function renderTaskView(taskId, allProjects) {
  let task;
  try {
    task = withDb(db => db.prepare(`
      SELECT t.*, e.name AS epic_name, e.project_id, p.name AS project_name
        FROM tasks t
        JOIN epics e ON e.id = t.epic_id
        JOIN projects p ON p.id = e.project_id
       WHERE t.id = ?`).get(taskId));
  } catch { task = null; }
  if (!task) return page('Задача не найдена', '<div class="empty-box"><h2>Задача не найдена</h2></div>');

  const proj = allProjects.find(p => String(p.id) === String(task.project_id));
  const projColor = proj?.color || '#8b949e';

  // парсинг JSON-колонок tasks (metadata, source_ref, tags)
  let meta = {}, sourceRef = null, worktree = null, tagsArr = [];
  try { meta = JSON.parse(task.metadata || '{}'); } catch {}
  try { sourceRef = JSON.parse(task.source_ref || 'null'); } catch {}
  worktree = meta && meta.worktree ? meta.worktree : null;
  try { tagsArr = JSON.parse(task.tags || '[]'); } catch {}

  // один проход по БД: comments + subtasks + зависимости + обратные traces.
  const extra = withDb(db => {
    let comments = [], subtasks = [], dependsOn = [], blocks = [], reverseTraces = [];
    try { comments = db.prepare('SELECT * FROM comments WHERE task_id=? ORDER BY created_at').all(taskId); } catch {}
    try { subtasks = db.prepare('SELECT * FROM subtasks WHERE task_id=? ORDER BY sort_order, id').all(taskId); } catch {}
    // task_dependencies(task_id, depends_on_task_id): task_id=N → «зависит от»,
    // depends_on_task_id=N → «блокирует».
    try {
      dependsOn = db.prepare(`
        SELECT d.depends_on_task_id AS id, tk.title, tk.status
          FROM task_dependencies d JOIN tasks tk ON tk.id = d.depends_on_task_id
         WHERE d.task_id = ? ORDER BY d.depends_on_task_id`).all(taskId);
      blocks = db.prepare(`
        SELECT d.task_id AS id, tk.title, tk.status
          FROM task_dependencies d JOIN tasks tk ON tk.id = d.task_id
         WHERE d.depends_on_task_id = ? ORDER BY d.task_id`).all(taskId);
    } catch {}
    // обратные traces: артефакты (AC/FR/...), ссылающиеся на эту задачу через
    // implements/verified_by. Каждая — кликабельная ссылка на /?artifact=N.
    try {
      reverseTraces = db.prepare(`
        SELECT t.link_type, a.id, a.code, a.type, a.title
          FROM artifact_traces t JOIN artifacts a ON a.id = t.source_id
         WHERE t.target_type='task' AND t.target_id = ?
         ORDER BY t.link_type, a.code`).all(taskId);
    } catch {}
    return { comments, subtasks, dependsOn, blocks, reverseTraces };
  });

  const statusColor = (s) => s === 'done' ? '#3fb950'
    : s === 'in_progress' ? '#f1c40f'
    : (s === 'review' || s === 'review_in_progress') ? '#a371f7'
    : s === 'blocked' ? '#e74c3c'
    : '#8b949e';
  const prioColor = PRIO[task.priority] || '#95a5a6';
  const sColor = statusColor(task.status);

  // source_ref → путь к AC-документу. Если есть обратная trace implements,
  // делаем кликабельную ссылку на wiki этого AC.
  const implTrace = extra.reverseTraces.find(t => t.link_type === 'implements');
  let sourceRefHtml = '';
  if (sourceRef && sourceRef.file) {
    if (implTrace) {
      sourceRefHtml = `<a class="tc-sref" href="/?artifact=${implTrace.id}" title="${esc(implTrace.title)}">${esc(sourceRef.file)} → ${esc(implTrace.code || ('#'+implTrace.id))}</a>`;
    } else {
      sourceRefHtml = `<span class="tc-sref mono">${esc(sourceRef.file)}</span>`;
    }
  }

  // worktree-блок — для dev-задач показывает слита ли ветка / есть ли конфликт.
  let worktreeHtml = '';
  if (worktree) {
    const conflict = worktree.merge_conflict || worktree.merged_into === 'conflict';
    const merged = worktree.merged_into && worktree.merged_into !== 'conflict' && worktree.merged_into !== 'pending';
    const wtColor = conflict ? '#e74c3c' : merged ? '#3fb950' : '#f39c12';
    const wtState = conflict ? '⚠ конфликт мержа'
      : merged ? `✓ слит в ${esc(worktree.merged_into || '')}`
      : (worktree.merged_into === 'pending' ? '⏳ ждёт интеграции' : '⏳ не слит');
    worktreeHtml = `<div class="tc-wt" style="border-color:${wtColor}">
      <div class="tc-wt-head" style="color:${wtColor}">🌳 Worktree · ${wtState}</div>
      <div class="tc-wt-grid">
        ${worktree.branch ? `<div><span class="wm-label">ветка</span><span class="tc-wt-val mono">${esc(worktree.branch)}</span></div>` : ''}
        ${worktree.path ? `<div><span class="wm-label">путь</span><span class="tc-wt-val mono">${esc(worktree.path)}</span></div>` : ''}
        ${worktree.merge_target ? `<div><span class="wm-label">merge target</span><span class="tc-wt-val mono">${esc(worktree.merge_target)}</span></div>` : ''}
        ${worktree.merged_into ? `<div><span class="wm-label">merged into</span><span class="tc-wt-val mono">${esc(worktree.merged_into)}</span></div>` : ''}
      </div>
    </div>`;
  }

  // комментарии (read-only — форма добавления в этой итерации не делается).
  const commentsHtml = extra.comments.length ? extra.comments.map(c => `
    <div class="tc-comment">
      <div class="tc-com-head">
        <span class="tc-com-author">${esc(c.author || 'аноним')}</span>
        <span class="tc-com-date muted small">${esc((c.created_at||'').slice(0,16))}</span>
      </div>
      <div class="tc-com-body">${renderMarkdown(c.content)}</div>
    </div>`).join('') : '<div class="muted small">нет комментариев</div>';

  // subtasks — чек-лист (галочка/кружок по status done/todo/in_progress).
  const subtasksHtml = extra.subtasks.length ? extra.subtasks.map(s => `
    <div class="tc-subtask">
      <span class="tc-check ${s.status === 'done' ? 'done' : (s.status === 'in_progress' ? 'wip' : '')}">${s.status === 'done' ? '✓' : (s.status === 'in_progress' ? '◐' : '○')}</span>
      <span class="tc-sub-title ${s.status === 'done' ? 'done' : ''}">${esc(s.title)}</span>
    </div>`).join('') : '<div class="muted small">нет подзадач</div>';

  // зависимости: depends_on + blocks, каждая кликабельна → /?task=N.
  const depHtml = (label, items, emptyMsg) => {
    if (!items.length) return `<div class="tc-dep-group"><span class="wm-label">${label}</span><span class="muted small">${emptyMsg}</span></div>`;
    return `<div class="tc-dep-group"><span class="wm-label">${label}</span>${
      items.map(d => `<a class="tc-dep-link" href="/?task=${d.id}" style="color:${statusColor(d.status)}">#${d.id} <span class="tc-dep-title">${esc(d.title)}</span></a>`).join('')
    }</div>`;
  };

  // обратные traces → артефакты (AC/FR), кликабельны → /?artifact=N.
  let tracesHtml;
  if (extra.reverseTraces.length) {
    const byLink = {};
    for (const t of extra.reverseTraces) (byLink[t.link_type] ||= []).push(t);
    tracesHtml = Object.entries(byLink).map(([link, items]) => {
      const color = LINK_COLORS[link] || '#8b949e';
      return `<div class="tc-trace-group">
        <span class="tc-trace-label" style="color:${color}">${LINK_GLYPH[link] || link}</span>
        ${items.map(a => `<a class="tc-trace-link" href="/?artifact=${a.id}">
          <span class="tc-trace-type" style="background:${TYPE_COLORS[a.type]||'#8b949e'}">${TYPE_LABEL[a.type]||a.type}</span>
          <span class="tc-trace-code">${esc(a.code || '—')}</span>
          <span class="tc-trace-title">${esc(a.title)}</span>
        </a>`).join('')}
      </div>`;
    }).join('');
  } else {
    tracesHtml = '<div class="muted small">нет связанных артефактов</div>';
  }

  const header = `
    <div class="board-head">
      <a href="/?project=${task.project_id}" class="back">← ${esc(task.project_name)}</a>
      <span class="tc-id">#${task.id}</span>
      <span class="atitle-top">${esc(task.title)}</span>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  const bodyHtml = `
    <div class="task-card">
      <div class="tc-main">
        <div class="tc-header-row">
          <span class="tc-status-chip" style="background:${sColor}22;border-color:${sColor};color:${sColor}">${esc(task.status)}</span>
          <span class="prio" style="background:${prioColor}">${esc(task.priority)}</span>
          ${task.assigned_to ? `<span class="assigned" title="assigned_to">@${esc(task.assigned_to)}</span>` : ''}
          ${tagsArr.includes('needs-human') ? '<span class="ask-flag">⚠ needs human</span>' : ''}
        </div>
        <div class="tc-section">
          <div class="tc-sec-title">Описание</div>
          <div class="tc-description wiki-content">${renderMarkdown(task.description)}</div>
        </div>
        ${sourceRefHtml ? `<div class="tc-section"><div class="tc-sec-title">Source ref</div>${sourceRefHtml}</div>` : ''}
        ${worktreeHtml}
      </div>
      <div class="tc-sidebar">
        <div class="tc-section">
          <div class="tc-sec-title">Метаданные</div>
          <div class="tc-meta-grid">
            <div class="tc-meta-row"><span class="wm-label">Проект</span><a href="/?project=${task.project_id}" style="color:${projColor}">${esc(task.project_name)}</a></div>
            <div class="tc-meta-row"><span class="wm-label">Эпик</span><span>${esc(task.epic_name || '—')}</span></div>
            <div class="tc-meta-row"><span class="wm-label">Создана</span><span>${esc((task.created_at||'').slice(0,16))}</span></div>
            <div class="tc-meta-row"><span class="wm-label">Обновлена</span><span>${esc((task.updated_at||'').slice(0,16))}</span></div>
            ${task.due_date ? `<div class="tc-meta-row"><span class="wm-label">Дедлайн</span><span>${esc(task.due_date)}</span></div>` : ''}
            ${task.estimated_hours != null ? `<div class="tc-meta-row"><span class="wm-label">Оценка</span><span>${task.estimated_hours}ч</span></div>` : ''}
            ${task.actual_hours != null ? `<div class="tc-meta-row"><span class="wm-label">Фактически</span><span>${task.actual_hours}ч</span></div>` : ''}
            ${tagsArr.length ? `<div class="tc-meta-row"><span class="wm-label">Теги</span><span class="tc-tags">${tagsArr.map(t=>`<span class="tc-tag">${esc(t)}</span>`).join('')}</span></div>` : ''}
          </div>
        </div>
        <div class="tc-section">
          <div class="tc-sec-title">Связанные артефакты</div>
          ${tracesHtml}
        </div>
        <div class="tc-section">
          <div class="tc-sec-title">Зависимости</div>
          ${depHtml('зависит от', extra.dependsOn, 'нет')}
          ${depHtml('блокирует', extra.blocks, 'никого')}
        </div>
      </div>
    </div>
    <div class="task-card-lower">
      <div class="tc-section tc-half">
        <div class="tc-sec-title">Подзадачи</div>
        ${subtasksHtml}
      </div>
      <div class="tc-section tc-half">
        <div class="tc-sec-title">Комментарии (${extra.comments.length})</div>
        ${commentsHtml}
      </div>
    </div>`;

  return page(`#${task.id} · ${task.title}`, header + bodyHtml);
}

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Saga Tracker</title>
  <style>
    *{box-sizing:border-box} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e6edf3}
    a{color:inherit;text-decoration:none}

    /* индекс */
    .summary{display:flex;gap:12px;padding:16px 20px;background:#161b22;border-bottom:1px solid #30363d}
    .sum-item{flex:1;background:#21262d;border:1px solid #30363d;border-radius:8px;padding:12px;text-align:center}
    .sum-item b{display:block;font-size:22px;color:#58a6ff} .sum-item span{font-size:11px;color:#8b949e}
    .searchbar{padding:14px 20px} .searchbar input{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:8px;padding:12px 14px;font-size:14px}
    .nav-regs{padding:0 20px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .section-title{padding:8px 20px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
    .plist{padding:0 20px 20px;display:flex;flex-direction:column;gap:6px}
    .prow{display:flex;align-items:center;gap:12px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 14px;transition:border-color .15s}
    .prow:hover{border-color:#58a6ff} .prow.empty{opacity:.55}
    /* Per-row action buttons (📦 archive, 🗑 delete). Hidden by default,
       shown on row hover. Stop-propagation in JS prevents the parent <a>
       navigation. delete-btn red on hover as a final visual warning. */
    .row-btn{background:none;border:none;font-size:15px;cursor:pointer;padding:2px 6px;border-radius:4px;opacity:.35;transition:opacity .1s,background .1s;line-height:1}
    .prow:hover .row-btn{opacity:.85}
    .row-btn:hover{opacity:1!important;background:rgba(255,255,255,.08)}
    .delete-btn:hover{background:rgba(231,76,60,.18)}
    .pstats{flex:1}
    .pdot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
    .pname{flex:1;font-weight:600;font-size:14px}
    .pstats{font-size:12px;color:#8b949e} .pstats b{color:#e6edf3} .ip{color:#3fb950}
    .muted{color:#484f58} .arrow{color:#484f58}
    .empty-section{padding:0 20px 20px} .empty-section summary{cursor:pointer;color:#8b949e;padding:8px;font-size:13px}
    .empty-hint{padding:24px;text-align:center;color:#484f58;font-size:13px}

    /* доска */
    .board-head{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#161b22;border-bottom:1px solid #30363d}
    .agent-runner{display:flex;align-items:center;gap:5px;padding:3px 6px;background:#21262d;border:1px solid #30363d;border-radius:8px;min-height:28px}
    .agent-icon{font-size:16px;line-height:1}
    .agent-runner select{width:42px;padding:3px 4px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;font-size:12px}
    .agent-runner select#agent-model-select{width:auto;min-width:130px;max-width:200px;font-size:10px}
    /* Engine Start/Pause toggle. Green ▶ when stopped (action available),
       amber ⏸ when running (click to pause). Disabled shows greyed-out. */
    .engine-toggle{padding:2px 8px;background:#16a34a;color:#fff;border:1px solid #138a4a;border-radius:5px;font-size:13px;line-height:1.4;cursor:pointer;font-weight:600;min-width:28px;transition:background .12s}
    .engine-toggle:hover{background:#158b3d}
    .engine-toggle.engine-running{background:#b8821f;border-color:#99671a;color:#fff}
    .engine-toggle.engine-running:hover{background:#a9741a}
    .engine-toggle:disabled{opacity:.5;cursor:wait}
    .agent-run-btn,.agent-stop-btn{width:27px;height:25px;padding:0;border:1px solid #3d4855;border-radius:5px;background:#238636;color:white;cursor:pointer;font-size:11px}
    .agent-run-btn:hover{background:#2ea043}.agent-stop-btn{background:#b62324}.agent-stop-btn:hover{background:#da3633}
    .agent-run-btn:disabled,.agent-stop-btn:disabled{opacity:.5;cursor:default}
    .agent-run-status{color:#8b949e;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0}
    .agent-model{color:#d2a8ff;font-size:10px;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;padding:0 4px}
    .back{color:#58a6ff;font-size:13px} .back:hover{text-decoration:underline}
    #psel{background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px 12px;font-size:13px;max-width:260px}
    .cur-proj{font-weight:700;font-size:15px}
    .board{display:flex;gap:14px;padding:16px;overflow-x:auto;min-height:calc(100vh - 56px)}
    .col{min-width:240px;flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column}
    .col-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #30363d;font-size:13px;font-weight:600}
    .count{background:#21262d;color:#8b949e;border-radius:10px;padding:1px 8px;font-size:11px}
    .col-body{padding:10px;display:flex;flex-direction:column;gap:8px;overflow-y:auto} .col-empty{color:#30363d;text-align:center;padding:20px;font-size:20px}
    .card{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px}
    .card.needs-human{border-color:#e74c3c;animation:card-pulse 1.2s infinite;box-shadow:0 0 0 1px #e74c3c}
    @keyframes card-pulse{0%,100%{box-shadow:0 0 0 1px #e74c3c,0 0 6px rgba(231,76,60,.4)}50%{box-shadow:0 0 0 2px #e74c3c,0 0 14px rgba(231,76,60,.7)}}
    .ask-flag{font-size:10px;color:#e74c3c;font-weight:700;background:rgba(231,76,60,.12);border:1px solid #e74c3c;padding:1px 6px;border-radius:3px}
    .card-head{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px}
    .prio{font-size:10px;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:3px;color:#0d1117}
    .assigned{font-size:10px;background:#21262d;border:1px solid #30363d;color:#8b949e;padding:1px 6px;border-radius:3px;font-family:monospace}
    .card-title{font-size:13px;line-height:1.35;display:block;text-decoration:none;color:#e6edf3;cursor:pointer}
    .card-title:hover{color:#58a6ff;text-decoration:underline}
    .card-id{font-size:10px;color:#484f58;font-family:ui-monospace,Consolas,monospace}
    .card-meta{font-size:11px;color:#8b949e;margin-top:6px}
    .task-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
    .task-badge{font-size:9px;padding:2px 5px;border-radius:8px;background:#21262d;color:#8b949e;border:1px solid #30363d}
    .task-badge.repo{color:#58a6ff}.task-badge.stage{color:#a371f7}.task-badge.kind{color:#3fb950}
    .filter-bar select{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:5px;padding:4px 7px;font-size:11px}

    /* фильтр-бар */
    .filter-bar{display:flex;align-items:center;gap:6px;padding:10px 20px;background:#161b22;border-bottom:1px solid #30363d;flex-wrap:wrap}
    .episode-progress-bar{display:flex;gap:8px;overflow:auto;padding:8px 20px;background:#0d1117;border-bottom:1px solid #21262d}
    .episode-progress{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:11px;color:#c9d1d9}
    .board-ops{padding:8px 20px;background:#0d1117;border-bottom:1px solid #30363d}
    .board-ops>summary{cursor:pointer;color:#8b949e;font-size:12px}
    .board-ops-grid{display:grid;gap:8px;margin-top:8px}
    .inline-op{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .inline-op input,.inline-op select{background:#161b22;border:1px solid #30363d;color:#c9d1d9;border-radius:5px;padding:6px}
    .filter-label{font-size:12px;color:#8b949e;margin-right:4px}
    .chip{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:14px;padding:4px 12px;font-size:12px;cursor:pointer;transition:all .15s}
    .chip:hover{border-color:#8b949e;color:#e6edf3}
    .chip.active{border-color:#58a6ff;color:#58a6ff;background:#0d1117;font-weight:600}
    .card[style*="display: none"]{display:none!important}

    .empty-box{text-align:center;padding:80px 20px;color:#8b949e}
    .empty-icon{font-size:48px;margin-bottom:12px} .empty-box h2{color:#e6edf3;margin:0 0 8px}

    /* heartbeat-индикатор активности */
    .heartbeat{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e}
    .hb-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;transition:background .3s}
    .hb-dot.green{background:#3fb950;animation:hb-pulse 0.9s infinite}
    .hb-dot.yellow{background:#f1c40f;animation:hb-pulse 1.8s infinite}
    .hb-dot.red{background:#e74c3c}
    /* Pulse tempo tied to freshness: faster blink = newer event.
       applyStreamingDots adds .pulse-fast/.pulse-med/.pulse-slow alongside
       the colour class so the dot 'breathes' at a rate proportional to the
       worker's last activity. No pulse class on red (stalled = static red). */
    .hb-dot.pulse-fast{animation:hb-pulse 0.5s infinite !important}
    .hb-dot.pulse-med{animation:hb-pulse 1.1s infinite !important}
    .hb-dot.pulse-slow{animation:hb-pulse 2.2s infinite !important}
    /* streaming: worker subprocess is actively writing to its JSONL log.
       Slow blue pulse (3s) — calmer than the 1s green "DB just touched"
       pulse, so the two states stay visually distinct and the streaming
       one doesn't fight for attention. */
    // (streaming dot CSS removed — kept the 3-colour ageClass scheme the user
    // is used to, just rebound to worker log_mtime_ms; see applyStreamingDots)
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    /* Strong, visible pulse — this is a liveness signal, not decoration.
       Dot goes fully dark at nadir so 'alive' is unmistakable. */
    @keyframes hb-pulse{0%,100%{opacity:1;transform:scale(1.15);box-shadow:0 0 6px currentColor}50%{opacity:.25;transform:scale(.7);box-shadow:0 0 0 currentColor}}

    /* переключатель табов Канбан/Артефакты */
    .tabs{display:flex;gap:4px;margin-left:12px}
    .tab{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;transition:all .15s}
    .tab:hover{border-color:#8b949e;color:#e6edf3}
    .tab.active{border-color:#58a6ff;color:#58a6ff;background:#0d1117;font-weight:600}

    /* вкладка Артефакты — сводка + дерево */
    .tree-summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;background:#161b22;border-bottom:1px solid #30363d;flex-wrap:wrap}
    .ts-stats{display:flex;gap:18px;font-size:13px;color:#8b949e} .ts-stats b{color:#e6edf3;font-size:15px}
    .ts-types{display:flex;gap:6px;flex-wrap:wrap}
    .tchip{font-size:11px;border:1px solid;border-radius:10px;padding:2px 9px;font-weight:600}

    .episodes{padding:14px 20px 40px;display:flex;flex-direction:column;gap:12px}
    .episode{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
    .episode > summary{cursor:pointer;padding:12px 14px;background:#21262d;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;list-style:none}
    .episode > summary::-webkit-details-marker{display:none}
    .episode > summary::before{content:'▸';color:#8b949e;transition:transform .15s;font-size:10px;width:10px;display:inline-block}
    .episode[open] > summary::before{transform:rotate(90deg)}
    .ep-name{flex:1;color:#e6edf3}
    .ep-count{background:#0d1117;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:1px 8px;font-size:11px}
    .episode.orphans{border-style:dashed;border-color:#484f58} .episode.orphans > summary{color:#8b949e}

    .tree-root{padding:10px 14px}
    .anode{padding:6px 0;border-left:2px solid transparent}
    .anode[data-depth="0"]{border-left-color:#30363d}
    .children{margin-left:16px;padding-left:14px;border-left:1px solid #30363d}
    .anode-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .anode-head.leaf{padding-left:18px}
    .atype{font-size:10px;font-weight:700;color:#0d1117;padding:2px 6px;border-radius:3px;letter-spacing:.3px;flex-shrink:0}
    .acode{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#58a6ff;font-weight:600;min-width:42px;flex-shrink:0}
    .atitle{flex:1;font-size:13px;color:#e6edf3;line-height:1.35;text-decoration:none;cursor:pointer}
    .atitle:hover{color:#58a6ff;text-decoration:underline}
    .astatus{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;flex-shrink:0}
    /* collapse <details> для узлов с детьми */
    .anode-det > summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .anode-det > summary::-webkit-details-marker{display:none}
    .anode-det > summary::before{content:'▸';color:#8b949e;font-size:10px;width:12px;display:inline-block;transition:transform .15s}
    .anode-det[open] > summary::before{transform:rotate(90deg)}
    .collapse-hint{font-size:10px;color:#484f58;background:#21262d;border:1px solid #30363d;border-radius:8px;padding:0 5px;flex-shrink:0}
    /* ✎-карандаш — прямой переход в wiki-редактор из любого узла дерева */
    .aedit{font-size:13px;color:#484f58;text-decoration:none;padding:0 3px;flex-shrink:0;line-height:1;cursor:pointer;transition:color .15s}
    .aedit:hover{color:#58a6ff}
    /* тулбар «развернуть/свернуть всё» над деревом */
    .tree-toolbar{display:flex;align-items:center;gap:6px;padding:8px 20px;background:#161b22;border-bottom:1px solid #30363d}
    .tt-label{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-right:4px}
    .anode.shallow{padding:4px 0} .anode.shallow .atitle{font-size:12px;color:#8b949e}

    /* бейджи трасс под листом AC */
    .traces{margin:4px 0 4px 22px;display:flex;flex-direction:column;gap:3px}
    .trace-badge{font-size:11px;border:1px solid;border-radius:4px;padding:2px 7px;display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.02);width:fit-content}
    .tg{font-family:ui-monospace,Consolas,monospace;font-size:11px}
    .tg-st{font-size:9px;opacity:.7;text-transform:uppercase}
    .tg-link{text-decoration:none;cursor:pointer}
    .tg-link:hover{text-decoration:underline}
    .tg-proj{font-size:10px;background:rgba(88,166,255,.12);border:1px solid #58a6ff;color:#58a6ff;border-radius:3px;padding:0 4px;margin-right:3px}

    /* сироты — сетка по типам */
    .orphan-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
    .orphan-group{display:flex;flex-direction:column;gap:4px}
    .orphan-type{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid #30363d}

    /* wiki-просмотр артефакта */
    .atitle-top{font-weight:700;font-size:15px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .wiki-meta{display:flex;flex-wrap:wrap;gap:8px 18px;padding:12px 20px;background:#161b22;border-bottom:1px solid #30363d;align-items:center}
    .wm-row{display:flex;gap:6px;align-items:center;font-size:12px}
    .wm-label{color:#8b949e;text-transform:uppercase;font-size:10px;letter-spacing:.4px}
    .wm-val{color:#e6edf3} .wm-val.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8b949e}
    .wm-actions{margin-left:auto}
    .wiki-traces{padding:8px 20px;background:#161b22;border-bottom:1px solid #30363d;display:flex;flex-direction:column;gap:6px}
    .tr-sec{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .wiki-content{padding:24px 28px;max-width:900px;line-height:1.6}
    .wiki-content h1{font-size:22px;margin:18px 0 8px;border-bottom:1px solid #30363d;padding-bottom:6px}
    .wiki-content h2{font-size:18px;margin:16px 0 6px;color:#58a6ff}
    .wiki-content h3{font-size:15px;margin:14px 0 4px;color:#a371f7}
    .wiki-content p{margin:8px 0}
    .wiki-content ul{margin:8px 0;padding-left:24px}
    .wiki-content li{margin:3px 0}
    .wiki-content code{background:#21262d;padding:1px 5px;border-radius:3px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
    .wiki-content pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;overflow-x:auto;margin:10px 0}
    .wiki-content pre code{background:none;padding:0}
    .wiki-content table{border-collapse:collapse;margin:10px 0;font-size:12px}
    .wiki-content th,.wiki-content td{border:1px solid #30363d;padding:5px 9px;text-align:left}
    .wiki-content th{background:#21262d;font-weight:600}
    .md-error{background:rgba(231,76,60,.1);border:1px solid #e74c3c;color:#e74c3c;padding:12px;border-radius:6px;font-size:13px}
    .flash{padding:10px 20px;font-size:13px}
    .flash.ok{background:rgba(63,185,80,.1);color:#3fb950} .flash.err{background:rgba(231,76,60,.1);color:#e74c3c}
    .flash-warn{background:rgba(224,154,55,.12);color:#d2a8ff}

    /* кнопки */
    .btn{display:inline-block;background:#21262d;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;text-decoration:none;transition:all .15s}
    .btn:hover{border-color:#58a6ff;color:#58a6ff}
    .btn.primary{background:#238636;border-color:#238636;color:#fff;font-weight:600}
    .btn.primary:hover{background:#2ea043;border-color:#2ea043;color:#fff}
    .btn:disabled{opacity:.6;cursor:wait}

    /* wiki-редактор */
    .editor{padding:16px 20px 40px;max-width:1000px}
    .ed-meta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .ed-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px}
    .ed-field > span{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.3px}
    .ed-field input,.ed-field select{background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:8px 10px;font-size:13px}
    .ed-status{flex:0 0 140px} .ed-tags{flex:2}
    .ed-md-wrap{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
    .ed-md-label{display:flex;gap:8px;align-items:baseline;font-size:12px;color:#8b949e}
    .ed-md{width:100%;min-height:420px;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:12px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.5;resize:vertical}
    .ed-md:focus{outline:none;border-color:#58a6ff}
    .ed-actions{display:flex;gap:10px}
    .small{font-size:11px} .warn{color:#f39c12}

    /* вкладка Coverage (матрица покрытия AC) */
    .cov-summary{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;background:#161b22;border-bottom:1px solid #30363d;flex-wrap:wrap}
    .cov-stats{display:flex;gap:20px;font-size:13px;color:#8b949e;flex-wrap:wrap}
    .cov-stats b{color:#e6edf3;font-size:15px}
    .cov-ok b{color:#3fb950} .cov-bad b{color:#e74c3c}
    .cov-bar-wrap{display:flex;align-items:center;gap:10px;min-width:200px}
    .cov-bar-label{font-size:12px;color:#8b949e;white-space:nowrap}
    .cov-bar{flex:1;height:10px;background:#21262d;border:1px solid #30363d;border-radius:5px;overflow:hidden;min-width:120px}
    .cov-bar-fill{height:100%;transition:width .3s,background .3s;border-radius:4px}
    .cov-table-wrap{padding:0 20px 20px;overflow-x:auto}
    .cov-table{width:100%;border-collapse:collapse;font-size:13px}
    .cov-table th{text-align:left;background:#21262d;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.3px;padding:9px 10px;border-bottom:1px solid #30363d}
    .cov-table td{padding:8px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
    .cov-table tr:hover td{background:#161b22}
    .cov-gap td{background:rgba(231,76,60,.06)}
    .cov-gap:hover td{background:rgba(231,76,60,.1)}
    .cov-epic-row td{background:#0d1117!important;font-weight:600;color:#58a6ff;font-size:12px;border-bottom:1px solid #30363d;cursor:pointer;user-select:none}
    .cov-epic-row:hover td{color:#79c0ff}
    .cov-epic-row .ep-toggle{display:inline-block;width:12px;color:#8b949e;transition:transform .15s;font-size:10px}
    .cov-epic-row.collapsed .ep-toggle{transform:rotate(-90deg)}
    .cov-epic-row .ep-count{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:0 7px;font-size:10px;margin-left:6px;font-weight:400}
    /* строка скрыта, если её родительская эпик-строка свёрнута */
    .cov-table tr.ac-hidden{display:none}
    .cov-toolbar{display:flex;align-items:center;gap:8px;padding:8px 20px;background:#161b22;border-bottom:1px solid #30363d}
    .cov-toolbar .tt-btn{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer}
    .cov-toolbar .tt-btn:hover{border-color:#58a6ff;color:#58a6ff}
    .cov-toolbar .tt-label{font-size:11px;color:#484f58}
    .cov-tasks{display:flex;flex-wrap:wrap;gap:4px}
    .cov-task{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:#21262d;border:1px solid #30363d;border-radius:3px;padding:1px 6px;text-decoration:none}
    .cov-task:hover{border-color:currentColor;text-decoration:underline}
    .cov-st{font-size:9px;opacity:.7;text-transform:uppercase}
    .cov-no{color:#484f58;font-style:italic;font-size:12px}
    .cov-legend{padding:10px 20px 30px;font-size:11px;color:#8b949e}
    .cov-gap-sample{background:rgba(231,76,60,.06);padding:1px 6px;border-radius:3px}

    /* реестр приёмочных испытаний (?project=N&tab=acceptance) */
    .acc-table .acc-title{max-width:340px}
    .acc-verdict{font-size:12px;white-space:nowrap;font-weight:600}
    .acc-icon{font-size:14px}
    .ac-parent{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#3fb950}
    .ac-parent:hover{text-decoration:underline}
    .ac-note{font-size:11px;color:#8b949e;display:block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .acc-note-cell{max-width:240px}

    /* страница администрирования (создание проекта/эпика) */
    .admin-link{border-color:#484f58;color:#484f58;font-size:11px}
    .admin-link:hover{border-color:#f39c12;color:#f39c12}
    .admin-wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;padding:20px;max-width:1100px}
    .admin-form{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:18px;display:flex;flex-direction:column;gap:12px}
    .admin-card-head{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:#e6edf3;padding-bottom:8px;border-bottom:1px solid #30363d}
    .admin-ic{font-size:18px}
    .admin-hint{font-size:11px;color:#8b949e;background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:6px 10px}
    .admin-form .ed-field{flex-direction:column}
    .admin-form .ed-field input,.admin-form .ed-field select{width:100%}

    /* реестр документов */
    .registry-wrap{padding:14px 20px}
    .reg-summary{font-size:13px;color:#8b949e;margin-bottom:12px} .reg-summary b{color:#e6edf3}
    .registry{width:100%;border-collapse:collapse;font-size:13px}
    .registry th{text-align:left;background:#21262d;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.3px;padding:8px 10px;border-bottom:1px solid #30363d}
    .registry td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
    .registry tr:hover td{background:#161b22}
    .reg-code{font-family:ui-monospace,Consolas,monospace;color:#58a6ff;font-weight:600}
    .reg-epic{color:#8b949e;font-size:12px} .reg-link:hover .reg-code{text-decoration:underline}

    /* карточка задачи (Jira-style detail view /?task=N) */
    .task-card{display:grid;grid-template-columns:1fr 320px;gap:16px;padding:16px 20px;max-width:1400px}
    .task-card-lower{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 20px 40px;max-width:1400px}
    @media(max-width:980px){ .task-card,.task-card-lower{grid-template-columns:1fr} }
    .tc-main,.tc-sidebar,.task-card-lower .tc-section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
    .tc-header-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #30363d}
    .tc-id{font-family:ui-monospace,Consolas,monospace;color:#8b949e;font-size:13px;font-weight:600}
    .tc-status-chip{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.3px;border:1px solid;border-radius:4px;padding:2px 8px}
    .tc-section{margin-bottom:16px} .tc-section:last-child{margin-bottom:0}
    .tc-sec-title{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;font-weight:600}
    .tc-description{font-size:14px} .tc-description.wiki-content{padding:0;max-width:none}
    .tc-sref{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#58a6ff;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:4px 8px;display:inline-block}
    .tc-sref:hover{text-decoration:underline;border-color:#58a6ff}
    /* worktree-блок */
    .tc-wt{background:#0d1117;border:1px solid;border-radius:6px;padding:10px 12px;margin-top:4px}
    .tc-wt-head{font-size:12px;font-weight:600;margin-bottom:8px}
    .tc-wt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px}
    .tc-wt-val{font-size:11px;color:#e6edf3}
    /* метаданные */
    .tc-meta-grid{display:flex;flex-direction:column;gap:8px}
    .tc-meta-row{display:flex;justify-content:space-between;gap:8px;font-size:12px;align-items:baseline}
    .tc-meta-row > span:last-child{color:#e6edf3;text-align:right}
    .tc-tags{display:flex;flex-wrap:wrap;gap:3px;justify-content:flex-end}
    .tc-tag{font-size:10px;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:3px;padding:1px 6px}
    /* подзадачи */
    .tc-subtask{display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:13px}
    .tc-check{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;line-height:1}
    .tc-check.done{color:#3fb950} .tc-check.wip{color:#f1c40f}
    .tc-sub-title.done{text-decoration:line-through;color:#8b949e}
    /* комментарии */
    .tc-comment{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px 12px;margin-bottom:8px}
    .tc-com-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .tc-com-author{font-size:12px;font-weight:600;color:#58a6ff;font-family:ui-monospace,Consolas,monospace}
    .tc-com-date{font-size:11px}
    .tc-com-body{font-size:13px;line-height:1.5} .tc-com-body p{margin:5px 0} .tc-com-body code{background:#21262d;padding:1px 4px;border-radius:3px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
    /* зависимости */
    .tc-dep-group{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
    .tc-dep-link{font-size:12px;text-decoration:none;display:flex;gap:6px;align-items:baseline}
    .tc-dep-link:hover{text-decoration:underline}
    .tc-dep-title{color:#8b949e;font-size:11px}
    /* обратные traces → артефакты */
    .tc-trace-group{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
    .tc-trace-label{font-size:11px;font-weight:600;margin-bottom:2px}
    .tc-trace-link{display:flex;align-items:center;gap:6px;font-size:12px;text-decoration:none;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px}
    .tc-trace-link:hover{border-color:#58a6ff}
    .tc-trace-type{font-size:9px;font-weight:700;color:#0d1117;padding:1px 5px;border-radius:3px}
    .tc-trace-code{font-family:ui-monospace,Consolas,monospace;color:#58a6ff;font-weight:600;font-size:11px}
    .tc-trace-title{color:#e6edf3;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tc-half{align-self:start}

    /* === Monitor panel (right sidebar) — pipeline + live workers === */
    .monitor-panel{position:fixed;top:0;right:0;width:360px;height:100vh;background:#161b22;border-left:1px solid #30363d;display:flex;flex-direction:column;z-index:100;font-size:12px}
    body.with-monitor{padding-right:360px}
    @media (max-width:1200px){.monitor-panel{display:none}body.with-monitor{padding-right:0}}
    .monitor-panel .mp-section{padding:10px 14px;border-bottom:1px solid #30363d}
    .monitor-panel .mp-section-title{color:#8b949e;text-transform:uppercase;font-size:10px;letter-spacing:.5px;margin-bottom:8px;font-weight:600}
    .monitor-panel .mp-pipeline{flex-shrink:0}
    .monitor-panel .mp-workers{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px}

    /* pipeline bar */
    .pipeline-bar{display:flex;align-items:center;gap:0;overflow-x:auto;padding:2px 0}
    .pipeline-stage{display:flex;flex-direction:column;align-items:center;padding:5px 6px;border-radius:6px;min-width:54px;font-size:10px;color:#8b949e;flex-shrink:0;text-align:center}
    .pipeline-stage .ps-icon{font-size:13px;line-height:1}
    .pipeline-stage .ps-name{margin-top:2px;font-weight:500}
    .pipeline-stage .ps-dur{margin-top:1px;font-size:9px;opacity:.7}
    .pipeline-stage.completed{color:#3fb950}
    .pipeline-stage.in_progress{color:#58a6ff}
    .pipeline-stage.in_progress .ps-icon{animation:mp-pulse-blue 2s infinite}
    .pipeline-stage.needs_human{color:#f85149}
    .pipeline-stage.failed{color:#f85149}
    .pipeline-stage.needs_human .ps-icon{animation:mp-pulse-red 1s infinite}
    .pipeline-stage.pending{opacity:.35}
    /* Clickable stages: completed / in_progress / needs_human are interactive;
       pending is muted and not clickable. Subtle hover bg signals clickability. */
    .pipeline-stage.completed,.pipeline-stage.in_progress,.pipeline-stage.needs_human{cursor:pointer;transition:background .12s}
    .pipeline-stage.completed:hover,.pipeline-stage.in_progress:hover,.pipeline-stage.needs_human:hover{background:rgba(88,166,255,.10)}
    .pipeline-arrow{color:#30363d;flex-shrink:0;padding:0 1px;font-size:11px;align-self:center;margin-top:-7px}
    @keyframes mp-pulse-blue{0%,100%{opacity:1}50%{opacity:.4}}
    @keyframes mp-pulse-red{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.15)}}

    /* === Stage detail overlay (clickable pipeline) ===
       Fixed full-viewport overlay with a semi-transparent backdrop so the
       kanban remains visible. Panel sits on the right under the monitor sidebar
       (z-index:200 — above monitor-panel's 100). Scrollable if the section list
       overflows. */
    .stage-detail-overlay{position:fixed;inset:0;background:rgba(1,4,9,.55);z-index:200;display:none;align-items:flex-start;justify-content:flex-end}
    .stage-detail-overlay.visible{display:flex;animation:sdo-fade .12s ease-out}
    @keyframes sdo-fade{from{opacity:0}to{opacity:1}}
    .stage-detail-panel{width:440px;max-width:90vw;max-height:calc(100vh - 40px);margin:20px 20px 20px 0;background:#161b22;border:1px solid #30363d;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .stage-detail-panel .sdo-head{padding:14px 18px;border-bottom:1px solid #30363d;display:flex;align-items:flex-start;gap:10px}
    .stage-detail-panel .sdo-titlewrap{flex:1;min-width:0}
    .stage-detail-panel .sdo-title{font-size:15px;font-weight:600;color:#e6edf3}
    .stage-detail-panel .sdo-dur{font-size:11px;color:#8b949e;margin-top:2px}
    .stage-detail-panel .sdo-desc{font-size:12px;color:#8b949e;padding:10px 18px 0;line-height:1.5}
    .stage-detail-panel .sdo-close{flex-shrink:0;background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:3px 9px;font-size:14px;line-height:1;cursor:pointer}
    .stage-detail-panel .sdo-close:hover{background:#30363d;color:#e6edf3}
    .stage-detail-panel .sdo-body{overflow-y:auto;padding:8px 18px 18px}
    .stage-detail-panel .sdo-loading{color:#8b949e;font-size:12px;padding:18px 0;text-align:center}
    .stage-detail-panel .sdo-err{color:#f85149;font-size:12px;padding:14px 0}
    .stage-detail-panel .sdo-empty{color:#8b949e;font-size:12px;padding:14px 0;text-align:center}
    .stage-detail-panel .sdo-section{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid rgba(48,54,61,.4)}
    .stage-detail-panel .sdo-section:last-child{border-bottom:none}
    .stage-detail-panel .sdo-label{flex-shrink:0;width:120px;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.3px;font-weight:600;padding-top:1px;word-break:break-word}
    .stage-detail-panel .sdo-value{flex:1;color:#e6edf3;font-size:12px;line-height:1.45;word-break:break-word;min-width:0}
    .stage-detail-panel .sdo-badge{flex-shrink:0;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:.3px;margin-top:1px}
    .stage-detail-panel .sdo-badge.accepted{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
    .stage-detail-panel .sdo-badge.draft{background:rgba(139,148,158,.12);color:#8b949e;border:1px solid rgba(139,148,158,.3)}
    .stage-detail-panel .sdo-badge.in_review{background:rgba(243,156,18,.12);color:#f39c12;border:1px solid rgba(243,156,18,.3)}
    .stage-detail-panel .sdo-badge.failed{background:rgba(248,81,73,.12);color:#f85149;border:1px solid rgba(248,81,73,.3)}
    /* markdown summary content (rendered from accepted summary artifact) */
    .stage-detail-panel .sdo-md-h{font-size:13px;font-weight:600;color:#e6edf3;margin:14px 0 6px}
    .stage-detail-panel .sdo-md-h:first-child{margin-top:0}
    .stage-detail-panel .sdo-md-p{font-size:12px;color:#c9d1d9;line-height:1.55;margin:6px 0}
    .stage-detail-panel .sdo-md-p strong{color:#e6edf3}
    .stage-detail-panel .sdo-md-ul{margin:6px 0;padding-left:20px;font-size:12px;color:#c9d1d9;line-height:1.55}
    .stage-detail-panel .sdo-md-ul li{margin:2px 0}
    .stage-detail-panel .sdo-md-p code,.stage-detail-panel .sdo-md-ul code{background:#21262d;padding:1px 4px;border-radius:3px;font-size:11px}
    @media (max-width:1200px){.stage-detail-overlay{justify-content:center}.stage-detail-panel{margin:20px}}

    /* worker mini-rows */
    .worker-row{padding:7px 9px;border-radius:6px;cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s}
    .worker-row:hover{background:#21262d}
    .worker-row.expanded{background:#21262d;border-color:#30363d}
    /* Recovery worker: subtle amber left-border to flag self-healing without
       a separate UI lane. Pipelines with active healing pulse softly. */
    .worker-row.is-recovery{border-left:3px solid #d29922;padding-left:6px}
    .recovery-banner{padding:6px 12px;background:rgba(210,153,34,.08);
      border-top:1px solid rgba(210,153,34,.3);color:#d29922;font-size:11px;
      display:flex;align-items:center;gap:6px}
    .recovery-banner .rb-pulse{width:7px;height:7px;border-radius:50%;
      background:#d29922;animation:rb-pulse 1.5s infinite}
    @keyframes rb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.3)}}
    .worker-row .wr-head{display:flex;align-items:center;gap:6px}
    .worker-row .wr-icon{font-size:13px}
    .worker-row .wr-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6edf3}
    .worker-row .wr-age{color:#8b949e;font-size:10px;flex-shrink:0}
    .worker-row .wr-sub{font-size:10px;color:#8b949e;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .worker-tail{display:none;margin-top:6px;max-height:200px;overflow-y:auto;background:#0d1117;padding:6px 8px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.4}
    .worker-row.expanded .worker-tail{display:block}
    .worker-tail .evt{padding:1px 0;color:#8b949e;border-bottom:1px solid rgba(48,54,61,.3)}
    .worker-tail .evt:last-child{border-bottom:none}
    .worker-tail .evt-tag{display:inline-block;min-width:54px;color:#58a6ff;font-weight:600}
    .worker-tail .evt.tool .evt-tag{color:#d2a8ff}
    .worker-tail .evt.text .evt-tag{color:#a5d6ff}
    .worker-tail .evt.result .evt-tag{color:#3fb950}
    .worker-tail .evt.system .evt-tag{color:#f85149}
    .worker-tail .evt-sub{font-size:9px;color:#f85149;margin-left:6px}
    .worker-empty{color:#8b949e;font-size:11px;padding:8px 0;text-align:center}
  </style></head>
  <body class="with-monitor">${body}
  <aside class="monitor-panel" id="monitor-panel">
    <div class="mp-section mp-pipeline">
      <div class="mp-section-title">Pipeline</div>
      <div id="pipeline-stages" class="pipeline-bar"><span class="worker-empty">выбери эпик</span></div>
    </div>
    <div class="mp-section mp-workers">
      <div class="mp-section-title">Workers (<span id="worker-count">0</span>)</div>
      <div id="workers-list"><div class="worker-empty">нет активных воркеров</div></div>
    </div>
    <div class="recovery-banner" id="recovery-banner" style="display:none">
      <span class="rb-pulse"></span>
      <span id="recovery-text">recovery</span>
    </div>
  </aside>
  <div class="stage-detail-overlay" id="stage-detail-overlay">
    <div class="stage-detail-panel" role="dialog" aria-modal="true">
      <div class="sdo-head">
        <div class="sdo-titlewrap">
          <div class="sdo-title" id="sdo-title">Stage</div>
          <div class="sdo-dur" id="sdo-dur"></div>
        </div>
        <button class="sdo-close" id="sdo-close" aria-label="Close stage detail">×</button>
      </div>
      <div class="sdo-desc" id="sdo-desc"></div>
      <div class="sdo-body" id="sdo-body"><div class="sdo-loading">loading…</div></div>
    </div>
  </div>
  <script>
  // Global HTML-escape helper for inline JS (e.g. monitor panel rendering).
  // The server-side esc() at l.183 is not available in browser context.
  window.esc = function(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); };
  // Heartbeat — индикатор активности агентов (по activity_log общей БД)
  (function(){
    const dot=document.getElementById('hb-dot');
    const txt=document.getElementById('hb-txt');
    if(!dot) return;
    function update(){
      fetch('/api/heartbeat').then(r=>r.json()).then(d=>{
        if(!d.last){ dot.className='hb-dot red'; txt.textContent='нет данных'; return; }
        // SQLite datetime('now') returns UTC; normalise to ISO Z before parsing
        // so the browser treats it as UTC (otherwise local-tz interpretation
        // shifts the timestamp by the tz offset, inflating 'ago' values).
        // Inline the parseTs logic — the server-side parseTs is not available
        // in browser context.
        let hs = String(d.last);
        if (hs.indexOf('T') < 0) hs = hs.replace(' ', 'T');
        if (hs.indexOf('Z') < 0) hs += 'Z';
        const ts = new Date(hs).getTime();
        if(isNaN(ts)){ dot.className='hb-dot red'; txt.textContent='?'; return; }
        const ago=Math.floor((Date.now()-ts)/1000);
        if(ago<15){ dot.className='hb-dot green'; txt.textContent=ago+'с назад'; }
        else if(ago<60){ dot.className='hb-dot yellow'; txt.textContent=ago+'с назад'; }
        else{ dot.className='hb-dot red'; txt.textContent=Math.floor(ago/60)+'м назад'; }
      }).catch(()=>{ dot.className='hb-dot red'; txt.textContent='ошибка'; });
    }
    update(); setInterval(update,3000);
  })();
  </script></body></html>`;
}

// --- POST /api/artifact/save: сохранение .md + metadata артефакта ---
// Тело: application/x-www-form-urlencoded (из формы) или JSON.
// Записывает файл (создаёт родительские директории) + UPDATE artifacts.
function handleArtifactSave(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const id = Number(fields.id);
    if (!id) return respondJson(res, 400, { error: 'id required' });

    // Загрузим артефакт, чтобы знать path и project_name.
    let art;
    try {
      art = withDb(db => db.prepare(`
        SELECT a.*, p.name AS project_name,
          (SELECT pr.local_path FROM project_repositories pr WHERE pr.id=a.project_repository_id) AS repository_path
          FROM artifacts a
          JOIN epics e ON e.id=a.epic_id JOIN projects p ON p.id=e.project_id
         WHERE a.id=?`).get(id));
    } catch (e) { return respondJson(res, 500, { error: 'db: ' + e.message }); }
    if (!art) return respondJson(res, 404, { error: 'artifact not found' });

    const result = { ok: true, id, warnings: [] };

    // 1. Сохранение .md файла
    if (typeof fields.markdown === 'string') {
      const resolved = resolveArtifactFile(art.path, art.project_name, art.repository_path);
      let absPath = resolved?.abs;
      if (!absPath) {
        // Файла нет — создадим по первому кандидату из PROJECT_REPO_MAP.
        const cleanPath = art.path.split('#')[0];
        const map = PROJECT_REPO_MAP[art.project_name] || [art.project_name];
        absPath = art.repository_path
          ? path.join(art.repository_path, cleanPath)
          : path.join(DEV_ROOT, map[0], cleanPath);
        result.warnings.push(`файл создан: ${absPath}`);
      }
      try {
        mkdirSync(path.dirname(absPath), { recursive: true });
        writeFileSync(absPath, fields.markdown, 'utf8');
        result.file = absPath;
        result.content_hash = createHash('sha256').update(Buffer.from(fields.markdown, 'utf8')).digest('hex');
      } catch (e) {
        result.ok = false;
        result.error = 'file write: ' + e.message;
        return respondJson(res, 500, result);
      }
    }

    // 2. Обновление metadata в БД (title/status/tags). updated_at — ручная.
    try {
      withDbWrite(db => {
        const sets = [];
        const vals = [];
        if (typeof fields.title === 'string' && fields.title.trim()) {
          sets.push('title = ?'); vals.push(fields.title.trim());
        }
        if (['draft','in_review','accepted','superseded'].includes(fields.status)) {
          sets.push('status = ?'); vals.push(fields.status);
        }
        if (typeof fields.tags === 'string') {
          const tags = fields.tags.split(',').map(s => s.trim()).filter(Boolean);
          sets.push('tags = ?'); vals.push(JSON.stringify(tags));
        }
        if (result.content_hash) {
          sets.push('content_hash = ?'); vals.push(result.content_hash);
          if (fields.status === 'accepted') {
            sets.push('accepted_hash = ?'); vals.push(result.content_hash);
            sets.push("drift_state = 'clean'");
          } else if (art.accepted_hash) {
            sets.push('drift_state = ?');
            vals.push(art.accepted_hash === result.content_hash ? 'clean' : 'drifted');
          }
        }
        if (sets.length) {
          sets.push("updated_at = datetime('now')");
          vals.push(id);
          db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id=?`).run(...vals);
        }
      });
      result.metadata = true;
    } catch (e) {
      result.ok = false;
      result.error = 'db update: ' + e.message;
      return respondJson(res, 500, result);
    }

    respondJson(res, 200, result);
  });
}

function respondJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readRequestFields(req, callback) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    try {
      const fields = contentType.includes('application/json')
        ? JSON.parse(raw || '{}')
        : Object.fromEntries(new URLSearchParams(raw));
      callback(null, fields);
    } catch (error) {
      callback(error);
    }
  });
}

function handleBoardRunStart(req, res) {
  readRequestFields(req, (parseError, fields) => {
    if (parseError) return respondJson(res, 400, { ok:false, error:'invalid request body' });
    const projectId = Number(fields.project_id);
    const concurrency = Number(fields.concurrency);
    if (!Number.isInteger(projectId) || projectId < 1) {
      return respondJson(res, 400, { ok:false, error:'project_id must be a positive integer' });
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      return respondJson(res, 400, { ok:false, error:'concurrency must be an integer from 1 to 32' });
    }
    try {
      const run = boardRunner.start({ projectId, concurrency });
      respondJson(res, 200, { ok:true, run });
    } catch (error) {
      respondJson(res, 409, { ok:false, error:error instanceof Error ? error.message : String(error) });
    }
  });
}

function handleBoardRunStop(req, res) {
  readRequestFields(req, (parseError, fields) => {
    if (parseError) return respondJson(res, 400, { ok:false, error:'invalid request body' });
    const projectId = Number(fields.project_id);
    const run = boardRunner.stop(projectId);
    if (!run) return respondJson(res, 404, { ok:false, error:`No board run for project ${projectId}` });
    respondJson(res, 200, { ok:true, run });
  });
}

function handleSagaOperation(req, res, operation) {
  readRequestFields(req, (parseError, fields) => {
    if (parseError) return respondJson(res, 400, { ok:false, error:'invalid request body' });
    try {
      let result;
      if (operation === 'repository_register') {
        result = repositoryHandlers.repository_register({
          ...fields,
          project_id: Number(fields.project_id),
        });
      } else if (operation === 'repository_bootstrap') {
        result = repositoryHandlers.repository_checkout_bootstrap({
          ...fields,
          project_repository_id: Number(fields.project_repository_id),
        });
      } else if (operation === 'episode_transition') {
        result = lifecycleHandlers.episode_transition({
          epic_id: Number(fields.epic_id),
          to_stage: fields.to_stage,
        });
      } else {
        throw new Error(`Unknown operation ${operation}`);
      }
      respondJson(res, 200, { ok:true, result });
    } catch (error) {
      respondJson(res, 409, { ok:false, error:error instanceof Error ? error.message : String(error) });
    }
  });
}

// --- HTML: кросс-проектный реестр однотипных документов (?registry=PRD) ---
// Показывает все артефакты выбранного типа по всем проектам — таблицей.
// Цель: «все PRD», «все AC», «все SRS» — быстрый поиск однотипных документов.
function renderRegistry(type, allProjects) {
  const T = (type || 'PRD').toUpperCase();
  let arts = [];
  try {
    arts = withDb(db => db.prepare(`
      SELECT a.id, a.code, a.title, a.status, a.updated_at,
             e.name AS epic_name, p.name AS project_name, p.id AS project_id
        FROM artifacts a JOIN epics e ON e.id=a.epic_id JOIN projects p ON p.id=e.project_id
       WHERE a.type = ?
       ORDER BY p.name, a.code`).all(T));
  } catch { arts = []; }

  const types = ['PRD','FR','NFR','RULE','UC','AC','SRS','decision'];
  const typeChips = types.map(t =>
    `<a class="chip${t===T?' active':''}" href="?registry=${t}">${TYPE_LABEL[t]||t}</a>`).join('');
  const projColor = (pid) => {
    const p = allProjects.find(x => String(x.id) === String(pid));
    return p?.color || '#8b949e';
  };

  const rows = arts.map(a => `<tr>
    <td><a class="reg-link" href="/?artifact=${a.id}"><span class="reg-code">${esc(a.code||'—')}</span></a></td>
    <td><span class="pdot" style="background:${projColor(a.project_id)}"></span>${esc(a.project_name)}</td>
    <td class="reg-epic">${esc(a.epic_name||'—')}</td>
    <td>${esc(a.title)}</td>
    <td><span class="astatus" style="color:${STATUS_COLOR[a.status]||'#8b949e'}">${STATUS_LABEL[a.status]||a.status}</span></td>
    <td class="muted small">${esc((a.updated_at||'').slice(0,16))}</td>
  </tr>`).join('');

  return page(`Реестр · ${T}`, `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <span class="cur-proj">📚 Реестр: ${T}</span>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>
    <div class="filter-bar">${typeChips}</div>
    <div class="registry-wrap">
      <div class="reg-summary"><b>${arts.length}</b> документов типа <b>${T}</b> по всем проектам</div>
      ${arts.length ? `<table class="registry"><thead><tr>
        <th>Code</th><th>Проект</th><th>Эпизод</th><th>Заголовок</th><th>Статус</th><th>Обновлён</th>
      </tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-box"><h2>Нет документов типа '+T+'</h2></div>'}
    </div>`);
}

// --- Загрузка coverage-матрицы для проекта ---
// Read-only запрос: все AC проекта + для каждой — есть ли implements/verified_by
// трассы к dev-задачам. Переиспользует логику handleArtifactCoverage (src/tools/
// artifacts.ts:387), но расширяет: показывает implements + verified_by + статус
// связанных задач. Возвращает { unavailable } если таблицы artifacts нет.
function loadCoverageMatrix(projectId) {
  return withDb(db => {
    let hasTable;
    try {
      hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    } catch { return { unavailable: true }; }
    if (!hasTable) return { unavailable: true };

    // Все AC проекта (упорядочены по эпизоду, затем по коду).
    const acs = db.prepare(`
      SELECT a.id, a.code, a.title, a.status, a.epic_id, e.name AS epic_name
        FROM artifacts a JOIN epics e ON e.id = a.epic_id
       WHERE e.project_id = ? AND a.type = 'AC'
       ORDER BY a.epic_id, a.code`).all(projectId);

    if (acs.length === 0) return { empty: true, reason: 'no-ac' };

    const acIds = acs.map(a => a.id);
    // implements + verified_by трассы к задачам, со статусом задачи.
    const traces = db.prepare(`
      SELECT t.source_id, t.link_type, t.target_id AS task_id,
             tk.title AS task_title, tk.status AS task_status, tk.epic_id AS task_epic_id
        FROM artifact_traces t
        LEFT JOIN tasks tk ON tk.id = t.target_id AND t.target_type = 'task'
       WHERE t.source_id IN (${acIds.map(() => '?').join(',')})
         AND t.target_type = 'task'
         AND t.link_type IN ('implements','verified_by')
       ORDER BY t.source_id, t.link_type`).all(...acIds);

    // Группируем трассы по source_id.
    const tracesBySrc = {};
    for (const t of traces) (tracesBySrc[t.source_id] ||= []).push(t);

    return { acs, tracesBySrc };
  });
}

// --- HTML: вкладка Coverage (матрица покрытия AC × implements/verified_by) ---
// Маршрут: /?project=<id>&tab=coverage. Read-only таблица: каждая строка = одна AC,
// --- HTML: страница stage detail (/stage?epic=N&stage=X) ---
// Отдельная страница (не overlay) — надёжнее, можно открыть в новой вкладке.
// Polling: если summary ещё не готов (queued/generating) — обновляем каждые 3 сек.

// Статические описания стадий пайплайна (на русском).
// Цель: чтобы читатель страницы понимал суть этапа — за что отвечает, что
// принимает на вход, что делает внутри, что отдаёт и кто работает — даже до
// того, как worker сгенерирует summary.
const STAGE_DESCRIPTIONS = {
  discovery: {
    name: 'Открытие',
    responsibility: 'Первая стадия пайплайна: превращает сырую идею пользователя в принятый бриф с обоснованным решением о дальнейшей судьбе эпизода. Проводит триаж идеи тремя независимыми ассесорами (продукт / система / риск), проверяет полноту входных данных через completeness-gate и выбирает ветку решения на decision-fork.',
    inputs: [
      'Идея пользователя одной фразой',
      'Прикреплённые документы (брифы, ссылки, контекст)',
      'Контрольная БД saga-mcp для completeness-gate'
    ],
    does: [
      'Триаж тремя ассесорами: product / system / risk',
      'Completeness-gate: проверка достаточности входа',
      'Decision-fork: выбор ветки решения',
      'Формирование brief-артефакта с обоснованным вердиктом'
    ],
    outputs: [
      'Brief artifact с decision ∈ {go, fast-track, clarify, reject}',
      'Обоснование решения (rationale) для последующих стадий'
    ],
    roles: ['saga-kickstart']
  },
  formalization: {
    name: 'Формализация',
    responsibility: 'Превращает принятый бриф в формальные требования и приёмочные критерии. Разделена на две части (ADR-014): Часть 1 — ЧТО (PRD с FR/NFR/RULE, UC, AC, reconciliation и фиксация AC baseline); Часть 2 — КАК (SRS после AC: архитектор видит замороженные AC + brief complexity и выбирает стиль по таблице complexity→architecture, затем пишет §D Decomposition для планировщика).',
    inputs: [
      'Принятый brief с decision=go из стадии Discovery',
      'complexity.tshirt / topology_hint / shared_mutation_risk из brief',
      'Документы и контекст пользователя'
    ],
    does: [
      'Часть 1 (ЧТО): PRD с FR/NFR/RULE, UC, AC, reconciliation, фиксация AC baseline',
      'Reconciliation: сверка трасс PRD ↔ UC ↔ AC (SRS ещё не существует)',
      'Часть 2 (КАК): SRS после baseline — архитектор выбирает стиль по complexity→architecture таблице',
      'Архитектор пишет §D Decomposition (машино-читаемый per-AC map для планировщика)'
    ],
    outputs: [
      'Accepted AC artifacts — baseline для стадии Planning',
      'Accepted SRS с §D — контракт для saga-planner',
      'Связная иерархия: PRD(+FR/NFR/RULE) → UC → AC и PRD → SRS(+§D) с трассами'
    ],
    roles: ['saga-product (PRD+FR/NFR/RULE)', 'saga-analyst (UC+AC)', 'saga-reconciler', 'saga-architect (SRS+§D, после AC)']
  },
  planning: {
    name: 'Планирование',
    responsibility: 'Раскладывает принятый baseline AC на конкретные задачи разработки и верификации. Для каждой AC создаёт development-задачи (с трассой implements) и verification-задачи, проверяет конфликтные ключи (file_path / schema / public_protocol / integration_branch) и при необходимости генерирует scaffold-задачу (Pattern B).',
    inputs: [
      'Принятый baseline AC из стадии Formalization',
      'Трассы между AC и UC/FR для контекста'
    ],
    does: [
      'Декомпозиция AC в development tasks',
      'Создание verification tasks с трассами verified_by',
      'Вычисление conflict keys и проверка коллизий',
      'Генерация scaffold task (Pattern B) при конфликтах'
    ],
    outputs: [
      'Scaffold task (Pattern B) — если требуется',
      'Body tasks — задачи реализации',
      'Verify tasks — задачи верификации'
    ],
    roles: ['saga-planner']
  },
  development: {
    name: 'Разработка',
    responsibility: 'Реализует запланированные задачи в коде. Воркеры работают в изолированных worktree-ветках, проходят цикл написания кода → ревью → merge в dev-ветку репозитория. Каждая задача оставляет трассы implements к AC.',
    inputs: [
      'Scaffold + body tasks из стадии Planning',
      'Принятые AC как контракт реализации',
      'Worktree репозитория проекта'
    ],
    does: [
      'Воркеры пишут код в изолированных worktrees',
      'Проходят ревью и протокол merge в dev',
      'Поддерживают трассы implements AC → task',
      'Self-healing при сбоях (recovery-воркеры)'
    ],
    outputs: [
      'Merged dev branch с реализацией всех AC',
      'Обновлённые metadata.worktree.merged_into="dev"'
    ],
    roles: ['saga-worker (development.code)']
  },
  verification: {
    name: 'Верификация',
    responsibility: 'Независимо проверяет реализацию каждой AC через property/behavioral тесты, сгенерированные из замороженного контракта AC (НЕ из тестов разработчика). Для каждого passed-вердикта создаётся verification_evidence с outcome=passed, что прокидывает трассу verified_by.',
    inputs: [
      'Merged code из стадии Development',
      'Accepted ACs как замороженный контракт',
      'Трассы implements для поиска соответствующих задач'
    ],
    does: [
      'Генерация L3 property tests из AC-контракта',
      'Behavioral checks против замороженного AC',
      'Запись verification_evidence с 4-значным вердиктом',
      'Прокидывание verified_by трассы AC → evidence'
    ],
    outputs: [
      'verification_evidence (outcome=passed) для каждого AC',
      'Failed / unknown вердикты возвращают эпизод на доработку'
    ],
    roles: ['saga-verifier (verification.ac)']
  },
  integration: {
    name: 'Интеграция',
    responsibility: 'Финальная сборка эпизода: после того как все verification evidence прошли, проверяет L0 gate (базовая целостность) и завершает merge в основную ветку продукта. Переводит эпизод в статус completed.',
    inputs: [
      'Все verification evidence с outcome=passed',
      'Merged dev branch из Development',
      'L0 gate: контракты типов / сборки'
    ],
    does: [
      'Финальная проверка L0 gate',
      'Полный merge эпизода в основную ветку',
      'Закрытие эпизода и переход в completed'
    ],
    outputs: [
      'Completed episode с интегрированным кодом',
      'Готовность к стадии Completed'
    ],
    roles: ['saga-worker (integration.merge)']
  },
  completed: {
    name: 'Завершено',
    responsibility: 'Пост-интеграционная стадия: обновление документации продукта, финализация проектных skills, артефактов и заметок. Эпизод полностью закрыт, продукт готов к использованию.',
    inputs: [
      'Интегрированный кодбейз из стадии Integration',
      'Все AC приняты и верифицированы'
    ],
    does: [
      'Обновление post-integration documentation',
      'Финализация project skills',
      'Архивирование заметок и решений'
    ],
    outputs: [
      'Готовый продукт с закрытым эпизодом',
      'Актуальная документация'
    ],
    roles: ['(post-integration)']
  }
};

// Отрисовать статический блок описания стадии (на русском) — отображается
// ВЫШЕ динамического summary, генерируемого воркером. Блок живёт в отдельном
// div и не перетирается polling-циклом #stage-content.
function renderStageDescriptionBlock(stageName) {
  const d = STAGE_DESCRIPTIONS[stageName];
  if (!d) return '';
  const li = (arr) => arr.map(x => `<li>${esc(x)}</li>`).join('');
  return `
    <style>
      .stage-desc{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:22px 24px;margin-bottom:16px}
      .stage-desc-title{margin:0 0 6px;font-size:20px;font-weight:600;color:#e6edf3;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
      .stage-desc-key{font-size:12px;color:#8b949e;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .stage-desc-resp{margin:0 0 16px;color:#c9d1d9;font-size:14px;line-height:1.6}
      .stage-desc-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px}
      @media (max-width:720px){.stage-desc-grid{grid-template-columns:1fr}}
      .stage-desc-section{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px 14px}
      .stage-desc-h{font-size:11px;color:#58a6ff;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:8px}
      .stage-desc-ul{margin:0;padding-left:18px;color:#c9d1d9;font-size:13px;line-height:1.55}
      .stage-desc-ul li{margin:3px 0}
      .stage-desc-ul.stage-desc-roles{padding-left:0;list-style:none}
      .stage-desc-ul.stage-desc-roles li{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#7ee787}
    </style>
    <div class="stage-desc">
      <h2 class="stage-desc-title">${esc(d.name)} <span class="stage-desc-key">${esc(stageName)}</span></h2>
      <p class="stage-desc-resp">${esc(d.responsibility)}</p>
      <div class="stage-desc-grid">
        <div class="stage-desc-section">
          <div class="stage-desc-h">Что принимает на вход</div>
          <ul class="stage-desc-ul">${li(d.inputs)}</ul>
        </div>
        <div class="stage-desc-section">
          <div class="stage-desc-h">Что делает внутри</div>
          <ul class="stage-desc-ul">${li(d.does)}</ul>
        </div>
        <div class="stage-desc-section">
          <div class="stage-desc-h">Что отдаёт</div>
          <ul class="stage-desc-ul">${li(d.outputs)}</ul>
        </div>
        <div class="stage-desc-section">
          <div class="stage-desc-h">Кто работает</div>
          <ul class="stage-desc-ul stage-desc-roles">${li(d.roles)}</ul>
        </div>
      </div>
    </div>`;
}

function renderStageDetailPage(epicId, stageName, allProjects) {
  const epic = withDb(db => db.prepare('SELECT id, name, project_id FROM epics WHERE id=?').get(Number(epicId)));
  const projName = epic ? (allProjects.find(p => String(p.id) === String(epic.project_id)) || {}).name : '?';
  const stageDesc = STAGE_DESCRIPTIONS[stageName];
  // Русское название стадии для шапки/заголовка; fallback — capitalize(key).
  const stageRuName = stageDesc ? stageDesc.name : (stageName.charAt(0).toUpperCase() + stageName.slice(1));
  const stageTitle = stageRuName;
  const header = `
    <div class="board-head">
      <a href="/?project=${epic ? epic.project_id : ''}" class="back">← ${esc(projName)}</a>
      <span class="cur-proj">📋 ${esc(stageRuName)} — этап пайплайна</span>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;
  return page(stageTitle + ' — этап пайплайна', `
    ${header}
    <div style="max-width:900px;margin:0 auto;padding:20px">
      ${renderStageDescriptionBlock(stageName)}
      <div style="font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin:4px 0 8px;padding:0 4px">Резюме стадии (генерируется воркером)</div>
      <div id="stage-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;min-height:120px">
        <div style="color:#8b949e;font-size:14px">Загрузка…</div>
      </div>
    </div>
    <script>
    window.esc = function(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); };
    (function(){
      const dot=document.getElementById('hb-dot');
      const txt=document.getElementById('hb-txt');
      if(!dot) return;
      function update(){
        fetch('/api/heartbeat').then(r=>r.json()).then(d=>{
          if(!d.last){ dot.className='hb-dot red'; txt.textContent='нет данных'; return; }
          let hs = String(d.last);
          if (hs.indexOf('T') < 0) hs = hs.replace(' ', 'T');
          if (hs.indexOf('Z') < 0) hs += 'Z';
          const ts = new Date(hs).getTime();
          if(isNaN(ts)){ dot.className='hb-dot red'; txt.textContent='?'; return; }
          const ago=Math.floor((Date.now()-ts)/1000);
          if(ago<15){ dot.className='hb-dot green'; txt.textContent=ago+'с назад'; }
          else if(ago<60){ dot.className='hb-dot yellow'; txt.textContent=ago+'с назад'; }
          else{ dot.className='hb-dot red'; txt.textContent=Math.floor(ago/60)+'м назад'; }
        }).catch(()=>{ dot.className='hb-dot red'; txt.textContent='ошибка'; });
      }
      update(); setInterval(update,3000);
    })();
    // Minimal client-side markdown -> HTML renderer for stage summaries.
    // Supports: # / ## headings, **bold**, backtick-code, "- "/ "* " lists,
    // blank-line separated paragraphs. ALL regex use new RegExp() — never
    // literal /.../ syntax — because this JS block lives inside page()'s
    // template literal (backtick string), where \\r and \\n would become
    // actual CR/LF chars and produce "Invalid regular expression" in the
    // browser. NOTE: literal backticks are avoided in comments/code because
    // they would terminate the template literal; String.fromCharCode(96) is
    // used instead.
    function renderMd(md) {
      // ALL regex here use new RegExp + String.fromCharCode because this code
      // lives inside a template literal where backslash escapes break.
      var NL = String.fromCharCode(10);
      var CR = String.fromCharCode(13);
      var S = String.fromCharCode(92, 115); // backslash-s (whitespace in regex)
      var DASH = String.fromCharCode(45);   // dash for --- (horizontal rule)
      var text = String(md || '').replace(new RegExp(CR + NL, 'g'), NL).trim();
      if (!text) return '<p style="color:#8b949e">empty</p>';
      var blocks = text.split(new RegExp(NL + '{2,}'));
      var out = [];
      var reHeading = new RegExp('^(#{1,6})[ ]+(.*)$');
      var reHr = new RegExp('^' + DASH + '{3,}[ ]*$');
      var reListTest = new RegExp('^[' + S + ']*[-*][ ]+');
      var reListStrip = new RegExp('^[' + S + ']*[-*][ ]+');
      for (var bi = 0; bi < blocks.length; bi++) {
        var block = blocks[bi].replace(new RegExp('^' + NL + '+|' + NL + '+$', 'g'), '');
        if (!block) continue;
        var lines = block.split(NL);
        var nonEmpty = lines.filter(function(l) { return l.trim(); });
        // Process line-by-line: headings and horizontal rules can appear
        // anywhere in a block, not just as single-line blocks.
        var lineHtml = [];
        var pendingPara = [];
        function flushPara() {
          if (pendingPara.length > 0) {
            var p = pendingPara.map(function(l) { return l.trim(); }).join(' ');
            if (p) lineHtml.push('<p style="margin:6px 0;line-height:1.6">' + renderMdInline(p) + '</p>');
            pendingPara = [];
          }
        }
        var allList = nonEmpty.length > 0;
        for (var li = 0; li < nonEmpty.length; li++) {
          if (!reListTest.test(nonEmpty[li])) { allList = false; break; }
        }
        // Check headings/hr per line
        for (var li2 = 0; li2 < lines.length; li2++) {
          var line = lines[li2];
          if (!line.trim()) continue;
          // Horizontal rule (---)
          if (reHr.test(line.trim())) { flushPara(); lineHtml.push('<hr style="border:0;border-top:1px solid #30363d;margin:12px 0">'); continue; }
          // Heading (any level)
          var hm = reHeading.exec(line.trim());
          if (hm) {
            flushPara();
            var level = Math.min(hm[1].length, 4) + 1;
            lineHtml.push('<h' + level + ' style="color:#58a6ff;margin:12px 0 6px">' + renderMdInline(hm[2]) + '</h' + level + '>');
            continue;
          }
          pendingPara.push(line);
        }
        flushPara();
        if (allList) {
          // Override: entire block is a list
          lineHtml = [];
          var items = nonEmpty.map(function(l) {
            return '<li>' + renderMdInline(l.replace(reListStrip, '')) + '</li>';
          }).join('');
          lineHtml.push('<ul style="margin:6px 0;padding-left:20px">' + items + '</ul>');
        }
        if (lineHtml.length > 0) {
          out.push(lineHtml.join(NL));
        }
      }
      return out.join(NL);
    }
    function renderMdInline(text) {
      var esc2 = window.esc(text);
      var BT = String.fromCharCode(96);
      var BS = String.fromCharCode(92); // backslash for regex escape
      var ST = BS + String.fromCharCode(42); // escaped asterisk: \*
      var reCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
      var reBold = new RegExp(ST + ST + '([^' + ST + ']+)' + ST + ST, 'g');
      return esc2
        .replace(reBold, '<strong>$1</strong>')
        .replace(reCode, '<code>$1</code>');
    }
    // Stage summary fetch + poll
    async function loadStage() {
      const el = document.getElementById('stage-content');
      const epicId = ${Number(epicId)};
      const stage = '${esc(stageName)}';
      try {
        const r = await fetch('/api/episode/stage-summary?epic_id=' + epicId + '&stage=' + stage);
        const j = await r.json();
        if (!j.ok) {
          el.innerHTML = '<div style="color:#f85149">Ошибка: ' + window.esc(j.error || '?') + '</div>';
          return;
        }
        if (j.status === 'ready') {
          // Render markdown content as HTML (was: raw escaped text via
          // white-space:pre-wrap, which showed literal # / ** / - on the page).
          const md = j.content || '(empty)';
          el.innerHTML = '<div style="color:#8b949e;font-size:11px;margin-bottom:6px">Сгенерировано: ' + window.esc(j.generated_at || '?') + '</div>' +
            '<div class="stage-md" style="color:#e6edf3;line-height:1.6;font-size:14px">' + renderMd(md) + '</div>';
        } else if (j.status === 'queued') {
          el.innerHTML = '<div style="color:#d2a822;font-size:14px">⏳ Резюме в очереди (task #' + j.task_id + '). Воркер подберёт задачу и напишет резюме.</div>' +
            '<div style="color:#8b949e;font-size:11px;margin-top:8px">Страница обновится автоматически.</div>';
          setTimeout(loadStage, 3000);
        } else if (j.status === 'generating') {
          el.innerHTML = '<div style="color:#58a6ff;font-size:14px">🔄 Резюме генерируется (task #' + j.task_id + ')…</div>' +
            '<div style="color:#8b949e;font-size:11px;margin-top:8px">Страница обновится автоматически.</div>';
          setTimeout(loadStage, 3000);
        }
      } catch (e) {
        el.innerHTML = '<div style="color:#f85149">Сеть: ' + window.esc(e.message) + '</div>';
      }
    }
    loadStage();
    </script>`);
}

// колонки: код, заголовок, эпизод, implements (есть/нет + статусы задач),
// verified_by (есть/нет). AC без implements — красная строка (gap в реализации).
// Решает боль «какие AC не реализованы» (backlog идея #2, паттерн P4).
function renderCoverage(projectId, allProjects) {
  const proj = allProjects.find(p => String(p.id) === String(projectId));
  if (!proj) return page('Проект не найден', '<div class="empty-box"><h2>Проект не найден</h2></div>');

  const data = loadCoverageMatrix(projectId);
  const opts = allProjects.map(p => `<option value="${p.id}"${String(p.id)===String(projectId)?' selected':''}>${esc(p.name)}</option>`).join('');

  const header = `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <select id="psel" onchange="location='?project='+this.value+'&tab=coverage'">${opts}</select>
      <span class="cur-proj" style="color:${proj.color}">${esc(proj.name)}</span>
      <div class="tabs">
        <a class="tab" href="?project=${projectId}">Канбан</a>
        <a class="tab" href="?project=${projectId}&tab=artifacts">Артефакты</a>
        <a class="tab active" href="?project=${projectId}&tab=coverage">Покрытие</a>
        <a class="tab" href="?project=${projectId}&tab=acceptance">Приёмка</a>
      </div>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  if (data.unavailable) {
    return page(proj.name + ' · Покрытие', `${header}
      <div class="empty-box"><div class="empty-icon">📐</div>
        <h2>Артефакты недоступны</h2>
        <p>В этой БД нет таблицы <code>artifacts</code> (старая версия saga-mcp).</p></div>`);
  }
  if (data.empty) {
    return page(proj.name + ' · Покрытие', `${header}
      <div class="empty-box"><div class="empty-icon">📐</div>
        <h2>В проекте нет AC</h2>
        <p>Acceptance criteria создаются через saga-mcp (artifact_create type:'AC').<br>
        Coverage-matrix показывает реализованы ли AC dev-задачами.</p></div>`);
  }

  const { acs, tracesBySrc } = data;

  // Сводка покрытия.
  let withImpl = 0, withoutImpl = 0, withVerify = 0;
  for (const ac of acs) {
    const ts = tracesBySrc[ac.id] || [];
    const hasImpl = ts.some(t => t.link_type === 'implements');
    const hasVerify = ts.some(t => t.link_type === 'verified_by');
    if (hasImpl) withImpl++; else withoutImpl++;
    if (hasVerify) withVerify++;
  }
  const pct = acs.length ? Math.round((withImpl / acs.length) * 100) : 0;
  const barColor = pct >= 80 ? '#3fb950' : pct >= 50 ? '#f1c40f' : '#e74c3c';

  // Группировка AC по эпизодам.
  const byEpic = {};
  for (const ac of acs) (byEpic[ac.epic_id] ||= []).push(ac);

  function renderTaskBadges(traces, linkType) {
    const filtered = traces.filter(t => t.link_type === linkType);
    if (!filtered.length) return `<span class="cov-no">— нет —</span>`;
    return filtered.map(t => {
      const color = t.task_status === 'done' ? '#3fb950'
        : t.task_status === 'in_progress' ? '#f1c40f'
        : (t.task_status === 'review' || t.task_status === 'review_in_progress') ? '#a371f7'
        : t.task_status === 'blocked' ? '#e74c3c'
        : '#8b949e';
      return `<a class="cov-task" href="?project=${projectId}" title="${esc(t.task_title||'')}" style="color:${color}">#${t.task_id} <span class="cov-st">${esc(t.task_status||'?')}</span></a>`;
    }).join(' ');
  }

  const rowsHtml = Object.entries(byEpic).map(([eid, epicAcs]) => {
    const epicName = epicAcs[0].epic_name || ('epic #' + eid);
    const acRows = epicAcs.map(ac => {
      const ts = tracesBySrc[ac.id] || [];
      const hasImpl = ts.some(t => t.link_type === 'implements');
      const gap = !hasImpl;
      const stColor = STATUS_COLOR[ac.status] || '#8b949e';
      return `<tr class="${gap ? 'cov-gap' : ''}">
        <td><a class="reg-code" href="/?artifact=${ac.id}">${esc(ac.code||'—')}</a></td>
        <td>${esc(ac.title)}</td>
        <td><span class="astatus" style="color:${stColor}">${STATUS_LABEL[ac.status]||ac.status}</span></td>
        <td class="cov-tasks">${renderTaskBadges(ts, 'implements')}</td>
        <td class="cov-tasks">${renderTaskBadges(ts, 'verified_by')}</td>
      </tr>`;
    }).join('');
    return `<tbody>
      <tr class="cov-epic-row" data-epic="${eid}"><td colspan="5"><span class="ep-toggle">▼</span> ${esc(epicName)} <span class="ep-count">${epicAcs.length}</span></td></tr>
      ${acRows}
    </tbody>`;
  }).join('');

  return page(proj.name + ' · Покрытие', `${header}
    <div class="cov-summary">
      <div class="cov-stats">
        <span><b>${acs.length}</b> AC всего</span>
        <span class="cov-ok"><b>${withImpl}</b> реализовано (implements)</span>
        <span class="cov-bad"><b>${withoutImpl}</b> без implements ${withoutImpl ? '⚠' : ''}</span>
        <span><b>${withVerify}</b> верифицировано</span>
      </div>
      <div class="cov-bar-wrap">
        <div class="cov-bar-label">Покрытие: ${pct}%</div>
        <div class="cov-bar"><div class="cov-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      </div>
    </div>
    <div class="cov-toolbar">
      <span class="tt-label">Эпизоды:</span>
      <button class="tt-btn" id="expand-all">▼ Развернуть всё</button>
      <button class="tt-btn" id="collapse-all">▲ Свернуть всё</button>
    </div>
    <div class="cov-table-wrap">
      <table class="cov-table" id="cov-matrix">
        <thead><tr>
          <th>AC</th><th>Заголовок</th><th>Статус</th><th>Implements (dev-задачи)</th><th>Verified by</th>
        </tr></thead>
        ${rowsHtml}
      </table>
    </div>
    <div class="cov-legend">
      <span class="cov-no">— нет —</span> = нет трассы (gap) ·
      строка <span class="cov-gap-sample">подсвечена</span> = AC без implements ·
      цвета задач: <span style="color:#3fb950">done</span> ·
      <span style="color:#f1c40f">in_progress</span> ·
      <span style="color:#a371f7">review</span> ·
      <span style="color:#e74c3c">blocked</span>
    </div>
    <script>
    (function(){
      const tbl = document.getElementById('cov-matrix');
      if (!tbl) return;
      // Каждая эпик-строка управляет видимостью следующих за ней строк до след. эпик-строки.
      const epicRows = [...tbl.querySelectorAll('tr.cov-epic-row')];
      function rowsAfter(epicRow){
        let r = epicRow.nextElementSibling, out = [];
        while (r && !r.classList.contains('cov-epic-row')) { out.push(r); r = r.nextElementSibling; }
        return out;
      }
      function collapse(epicRow){ epicRow.classList.add('collapsed'); rowsAfter(epicRow).forEach(r => r.classList.add('ac-hidden')); }
      function expand(epicRow){ epicRow.classList.remove('collapsed'); rowsAfter(epicRow).forEach(r => r.classList.remove('ac-hidden')); }
      epicRows.forEach(er => er.addEventListener('click', () => er.classList.contains('collapsed') ? expand(er) : collapse(er)));
      document.getElementById('collapse-all').addEventListener('click', () => epicRows.forEach(collapse));
      document.getElementById('expand-all').addEventListener('click', () => epicRows.forEach(expand));
    })();
    </script>`);
}

// --- HTML: реестр приёмочных испытаний (?project=N&tab=acceptance) ---
// ФИЧА D — аналог Almirah/StrictDoc test registry, интегрированный с saga-задачами.
// Каждая AC = строка приёмочного испытания. Вычисляем результат приёмки по статусам
// связанных задач (implements=DEV, verified_by=VERIFY) и merge-статусу worktree.
//   ✅ passed   = DEV done И (VERIFY done ИЛИ нет VERIFY)
//   ⏳ running  = DEV в работе (in_progress/review*)
//   ❌ failed   = DEV blocked ИЛИ merge_conflict в metadata.worktree
//   ⚪ unverified = нет implements (AC не реализована)
// Сводка сверху: N из M прошли (X%) + progress-bar. Фильтр по статусу (JS, client-side).
function loadAcceptanceRegistry(projectId) {
  return withDb(db => {
    let hasTable;
    try {
      hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    } catch { return { unavailable: true }; }
    if (!hasTable) return { unavailable: true };

    // Все AC проекта + parent UC (если есть) для контекста.
    const acs = db.prepare(`
      SELECT a.id, a.code, a.title, a.status, a.epic_id, a.parent_artifact_id,
             e.name AS epic_name,
             pa.code AS parent_code, pa.type AS parent_type, pa.title AS parent_title
        FROM artifacts a
        JOIN epics e ON e.id = a.epic_id
        LEFT JOIN artifacts pa ON pa.id = a.parent_artifact_id
       WHERE e.project_id = ? AND a.type = 'AC'
       ORDER BY a.epic_id, a.code`).all(projectId);

    if (acs.length === 0) return { empty: true, reason: 'no-ac' };

    const acIds = acs.map(a => a.id);
    // implements + verified_by трассы к задачам + полная информация о задаче
    // (status, title, metadata для проверки merge_conflict).
    const traces = db.prepare(`
      SELECT t.source_id AS ac_id, t.link_type, t.target_id AS task_id,
             tk.title AS task_title, tk.status AS task_status, tk.metadata AS task_metadata
        FROM artifact_traces t
        LEFT JOIN tasks tk ON tk.id = t.target_id AND t.target_type = 'task'
       WHERE t.source_id IN (${acIds.map(() => '?').join(',')})
         AND t.target_type = 'task'
         AND t.link_type IN ('implements','verified_by')
       ORDER BY t.source_id, t.link_type`).all(...acIds);

    // Последний комментарий к DEV-задаче (примечание приёмки) — опционально.
    const devTaskIds = [...new Set(traces.filter(t => t.link_type === 'implements' && t.task_id).map(t => t.task_id))];
    const lastCommentByTask = {};
    if (devTaskIds.length) {
      const rows = db.prepare(`
        SELECT task_id, content, author, created_at FROM comments
         WHERE task_id IN (${devTaskIds.map(() => '?').join(',')})
         ORDER BY task_id, created_at DESC`).all(...devTaskIds);
      for (const r of rows) {
        if (!lastCommentByTask[r.task_id]) lastCommentByTask[r.task_id] = r;
      }
    }

    const tracesByAc = {};
    for (const t of traces) (tracesByAc[t.ac_id] ||= []).push(t);

    return { acs, tracesByAc, lastCommentByTask };
  });
}

// Вычислить результат приёмки для одной AC по её трассам.
// Возвращает { status, label, icon, color }.
function computeAcceptance(traces) {
  const impl = traces.filter(t => t.link_type === 'implements');
  const verify = traces.filter(t => t.link_type === 'verified_by');
  if (impl.length === 0) {
    return { status: 'unverified', label: 'не верифицирована', icon: '⚪', color: '#8b949e' };
  }
  // проверка merge_conflict в metadata.worktree любой DEV-задачи
  for (const t of impl) {
    let conflict = false;
    try { const m = JSON.parse(t.task_metadata || '{}'); conflict = m?.worktree?.merge_conflict || m?.worktree?.merged_into === 'conflict'; } catch {}
    if (conflict) return { status: 'failed', label: 'конфликт мержа', icon: '❌', color: '#e74c3c' };
  }
  const devBlocked = impl.some(t => t.task_status === 'blocked');
  if (devBlocked) return { status: 'failed', label: 'заблокирована', icon: '❌', color: '#e74c3c' };
  const devDone = impl.every(t => t.task_status === 'done');
  if (devDone) {
    // VERIFY: если есть, должна быть done; если нет — passed.
    if (verify.length === 0) return { status: 'passed', label: 'пройдена', icon: '✅', color: '#3fb950' };
    const verifyDone = verify.every(t => t.task_status === 'done');
    if (verifyDone) return { status: 'passed', label: 'пройдена + верифицирована', icon: '✅', color: '#3fb950' };
    return { status: 'running', label: 'на верификации', icon: '⏳', color: '#f1c40f' };
  }
  const devRunning = impl.some(t => ['in_progress', 'review', 'review_in_progress'].includes(t.task_status));
  if (devRunning) return { status: 'running', label: 'в разработке', icon: '⏳', color: '#f1c40f' };
  // DEV существует, но не done и не running (todo) — ожидание
  return { status: 'running', label: 'запланирована', icon: '⏳', color: '#f39c12' };
}

function renderAcceptance(projectId, allProjects) {
  const proj = allProjects.find(p => String(p.id) === String(projectId));
  if (!proj) return page('Проект не найден', '<div class="empty-box"><h2>Проект не найден</h2></div>');

  const data = loadAcceptanceRegistry(projectId);
  const opts = allProjects.map(p => `<option value="${p.id}"${String(p.id)===String(projectId)?' selected':''}>${esc(p.name)}</option>`).join('');

  const header = `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <select id="psel" onchange="location='?project='+this.value+'&tab=acceptance'">${opts}</select>
      <span class="cur-proj" style="color:${proj.color}">${esc(proj.name)}</span>
      <div class="tabs">
        <a class="tab" href="?project=${projectId}">Канбан</a>
        <a class="tab" href="?project=${projectId}&tab=artifacts">Артефакты</a>
        <a class="tab" href="?project=${projectId}&tab=coverage">Покрытие</a>
        <a class="tab active" href="?project=${projectId}&tab=acceptance">Приёмка</a>
      </div>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;

  if (data.unavailable) {
    return page(proj.name + ' · Приёмка', `${header}
      <div class="empty-box"><div class="empty-icon">🧪</div>
        <h2>Артефакты недоступны</h2>
        <p>В этой БД нет таблицы <code>artifacts</code> (старая версия saga-mcp).</p></div>`);
  }
  if (data.empty) {
    return page(proj.name + ' · Приёмка', `${header}
      <div class="empty-box"><div class="empty-icon">🧪</div>
        <h2>В проекте нет AC</h2>
        <p>Acceptance criteria создаются через saga-mcp (artifact_create type:'AC').<br>
        Реестр приёмки показывает статус прохождения каждой AC.</p></div>`);
  }

  const { acs, tracesByAc, lastCommentByTask } = data;

  // вычисляем результат приёмки для каждой AC + сводку
  const rows = acs.map(ac => {
    const ts = tracesByAc[ac.id] || [];
    const verdict = computeAcceptance(ts);
    const dev = ts.filter(t => t.link_type === 'implements');
    const verify = ts.filter(t => t.link_type === 'verified_by');
    const lastCom = dev[0] && lastCommentByTask[dev[0].task_id];
    return { ac, dev, verify, verdict, lastCom };
  });

  const counts = { passed: 0, running: 0, failed: 0, unverified: 0 };
  for (const r of rows) counts[r.verdict.status]++;
  const total = rows.length;
  const passed = counts.passed;
  const pct = total ? Math.round((passed / total) * 100) : 0;
  const barColor = pct >= 80 ? '#3fb950' : pct >= 50 ? '#f1c40f' : '#e74c3c';

  const taskColor = (s) => s === 'done' ? '#3fb950'
    : s === 'in_progress' ? '#f1c40f'
    : (s === 'review' || s === 'review_in_progress') ? '#a371f7'
    : s === 'blocked' ? '#e74c3c' : '#8b949e';

  // группировка по эпизодам (REQ-NNN)
  const byEpic = {};
  for (const r of rows) (byEpic[r.ac.epic_id] ||= []).push(r);

  const renderTaskCell = (tasks) => {
    if (!tasks.length) return `<span class="cov-no">—</span>`;
    return tasks.map(t => `<a class="cov-task" href="/?task=${t.task_id}" title="${esc(t.task_title||'')}" style="color:${taskColor(t.task_status)}">#${t.task_id} <span class="cov-st">${esc(t.task_status||'?')}</span></a>`).join(' ');
  };

  const rowsHtml = Object.entries(byEpic).map(([eid, epicRows]) => {
    const epicName = epicRows[0].ac.epic_name || ('epic #' + eid);
    const acRows = epicRows.map(r => {
      const v = r.verdict;
      const stColor = STATUS_COLOR[r.ac.status] || '#8b949e';
      const parentHtml = r.ac.parent_type === 'UC' && r.ac.parent_code
        ? `<a class="ac-parent" href="/?artifact=${r.ac.parent_artifact_id}" title="${esc(r.ac.parent_title||'')}">${esc(r.ac.parent_code)}</a>`
        : '<span class="muted">—</span>';
      const noteHtml = r.lastCom
        ? `<span class="ac-note" title="${esc((r.lastCom.created_at||'').slice(0,10))}">${esc((r.lastCom.content||'').slice(0, 80))}${(r.lastCom.content||'').length > 80 ? '…' : ''}</span>`
        : '<span class="muted">—</span>';
      return `<tr class="acc-row" data-verdict="${v.status}">
        <td><a class="reg-code" href="/?artifact=${r.ac.id}">${esc(r.ac.code||'—')}</a></td>
        <td class="acc-title">${esc(r.ac.title)}</td>
        <td>${parentHtml}</td>
        <td class="cov-tasks">${renderTaskCell(r.dev)}</td>
        <td class="cov-tasks">${renderTaskCell(r.verify)}</td>
        <td class="acc-verdict"><span class="acc-icon">${v.icon}</span> <span style="color:${v.color}">${esc(v.label)}</span></td>
        <td class="acc-note-cell">${noteHtml}</td>
      </tr>`;
    }).join('');
    return `<tbody>
      <tr class="cov-epic-row" data-epic="${eid}"><td colspan="7"><span class="ep-toggle">▼</span> ${esc(epicName)} <span class="ep-count">${epicRows.length}</span></td></tr>
      ${acRows}
    </tbody>`;
  }).join('');

  // фильтр-чипы по статусу приёмки (client-side JS фильтрация строк)
  const filterChips = [
    { k: '__all__', label: 'Все', n: total },
    { k: 'passed', label: '✅ Пройдено', n: counts.passed },
    { k: 'running', label: '⏳ В работе', n: counts.running },
    { k: 'failed', label: '❌ Провал/блок', n: counts.failed },
    { k: 'unverified', label: '⚪ Не реализ.', n: counts.unverified },
  ].map(c => `<button class="chip${c.k==='__all__'?' active':''}" data-verdict="${c.k}">${esc(c.label)} <span class="count">${c.n}</span></button>`).join('');

  return page(proj.name + ' · Приёмка', `${header}
    <div class="cov-summary">
      <div class="cov-stats">
        <span><b>${total}</b> AC всего</span>
        <span class="cov-ok"><b>${passed}</b> прошли приёмку</span>
        <span class="cov-bad"><b>${counts.failed}</b> провал/блок</span>
        <span><b>${counts.running}</b> в работе</span>
        <span><b>${counts.unverified}</b> не реализованы</span>
      </div>
      <div class="cov-bar-wrap">
        <div class="cov-bar-label">Приёмка: ${pct}%</div>
        <div class="cov-bar"><div class="cov-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      </div>
    </div>
    <div class="filter-bar">${filterChips}</div>
    <div class="cov-toolbar">
      <span class="tt-label">Эпизоды:</span>
      <button class="tt-btn" id="expand-all">▼ Развернуть всё</button>
      <button class="tt-btn" id="collapse-all">▲ Свернуть всё</button>
    </div>
    <div class="cov-table-wrap">
      <table class="cov-table acc-table" id="acc-table">
        <thead><tr>
          <th>AC</th><th>Критерий приёмки</th><th>UC</th><th>DEV (implements)</th><th>VERIFY</th><th>Результат</th><th>Примечание</th>
        </tr></thead>
        ${rowsHtml}
      </table>
    </div>
    <div class="cov-legend">
      <b>Легенда:</b>
      ✅ passed = DEV done (и VERIFY done если есть) ·
      ⏳ = DEV в работе / на верификации ·
      ❌ = DEV blocked или merge_conflict ·
      ⚪ = нет implements (AC не реализована).
      Аналог Almirah / StrictDoc / OSRMT test-registry, но интегрирован с saga-mcp задачами.
    </div>
    <script>
    // Две ортогональные механики скрытия строк:
    //  (1) collapse по эпизоду — добавляет класс .ac-hidden (через CSS display:none).
    //  (2) фильтр по verdict — ставит row.style.display напрямую.
    // Применяем обе: строка видна только если не ac-hidden И фильтр разрешает.
    let vFilter = '__all__';
    function rowPassesFilter(row){
      return vFilter === '__all__' || row.dataset.verdict === vFilter;
    }
    function applyVisibility(){
      document.querySelectorAll('#acc-table .acc-row').forEach(row => {
        const hidden = row.classList.contains('ac-hidden');
        row.style.display = (!hidden && rowPassesFilter(row)) ? '' : 'none';
      });
    }
    document.querySelectorAll('.filter-bar .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-bar .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        vFilter = chip.dataset.verdict;
        applyVisibility();
      });
    });
    // collapse эпизодов (как в coverage)
    const tbl = document.getElementById('acc-table');
    const epicRows = [...tbl.querySelectorAll('tr.cov-epic-row')];
    function rowsAfter(epicRow){
      let r = epicRow.nextElementSibling, out = [];
      while (r && !r.classList.contains('cov-epic-row')) { out.push(r); r = r.nextElementSibling; }
      return out;
    }
    function collapse(epicRow){ epicRow.classList.add('collapsed'); rowsAfter(epicRow).forEach(r => r.classList.add('ac-hidden')); applyVisibility(); }
    function expand(epicRow){ epicRow.classList.remove('collapsed'); rowsAfter(epicRow).forEach(r => r.classList.remove('ac-hidden')); applyVisibility(); }
    epicRows.forEach(er => er.addEventListener('click', () => er.classList.contains('collapsed') ? expand(er) : collapse(er)));
    document.getElementById('collapse-all').addEventListener('click', () => epicRows.forEach(collapse));
    document.getElementById('expand-all').addEventListener('click', () => epicRows.forEach(expand));
    </script>`);
}

// --- HTML: страница администрирования (создание проекта/эпика) ---
// GET /admin — две формы: «Создать проект» и «Создать эпик».
// POST сабмитится через fetch → /api/project/create | /api/epic/create.
// Только INSERT в projects/epics (schema НЕ трогается) — безопасно, обратимо.
// На ошибку UNIQUE name / неверный project_id → flash без краша.
function renderAdmin(projects, flash) {
  const opts = projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const header = `
    <div class="board-head">
      <a href="/" class="back">← Все проекты</a>
      <span class="cur-proj">⚙ Администрирование</span>
      <span style="flex:1"></span>
      <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
    </div>`;
  return page('Администрирование', `
    ${header}
    ${flash ? `<div class="flash ${flash.kind||'ok'}">${esc(flash.msg)}</div>` : ''}
    <div class="admin-wrap">
      <form class="admin-form" id="proj-form">
        <input type="hidden" name="action" value="project">
        <div class="admin-card-head"><span class="admin-ic">📦</span> Создать проект</div>
        <label class="ed-field"><span>Имя проекта *</span><input type="text" name="name" required placeholder="напр. my-new-product" autocomplete="off"></label>
        <label class="ed-field"><span>Описание</span><input type="text" name="description" placeholder="короткое описание (опц.)" autocomplete="off"></label>
        <div class="admin-hint">Статус по умолчанию: <code>active</code>. Имя должно быть уникальным среди всех проектов.</div>
        <button type="submit" class="btn primary">➕ Создать проект</button>
      </form>
      <form class="admin-form" id="epic-form">
        <input type="hidden" name="action" value="epic">
        <div class="admin-card-head"><span class="admin-ic">🎯</span> Создать эпик</div>
        <label class="ed-field"><span>Проект *</span><select name="project_id" required>${opts}</select></label>
        <label class="ed-field"><span>Имя эпика *</span><input type="text" name="name" required placeholder="напр. REQ-001-feature" autocomplete="off"></label>
        <label class="ed-field"><span>Описание</span><input type="text" name="description" placeholder="опц." autocomplete="off"></label>
        <label class="ed-field"><span>Ветка (branch, опц.)</span><input type="text" name="branch" placeholder="напр. feature/x" autocomplete="off"></label>
        <div class="admin-hint">Статус: <code>planned</code>, приоритет <code>medium</code>.</div>
        <button type="submit" class="btn primary">➕ Создать эпик</button>
      </form>
      <form class="admin-form" id="idea-form">
        <input type="hidden" name="action" value="idea">
        <label class="ed-field"><span>Worker concurrency / available GPUs</span><select name="concurrency">${Array.from({length:32},(_,i)=>i+1).map(n => `<option value="${n}"${n===1?' selected':''}>${n}</option>`).join('')}</select></label>
        <div class="admin-card-head"><span class="admin-ic">🚀</span> Idea → Engine (3.0)</div>
        <label class="ed-field"><span>Имя проекта *</span><input type="text" name="name" required placeholder="напр. water-cannon" autocomplete="off"></label>
        <label class="ed-field"><span>Идея (одной фразой) *</span><textarea name="idea" required rows="3" placeholder="напр. мини автокад 3д для прототипирования" autocomplete="off"></textarea></label>
        <label class="ed-field"><span>Локальный путь (опц.)</span><input type="text" name="local_path" placeholder="по умолч. D:/Development/&lt;name&gt;" autocomplete="off"></label>
        <div class="admin-hint">
          Создаёт project + repo + epic + discovery.kickstart задачу одной транзакцией.
          При <code>SAGA_ORCHESTRATION_MODE=v3</code> запускает автономный движок в background
          (он сам прогонит kickstart → PRD → UC/AC → SRS → planning → dev → verify → integration, ADR-014).
          При <code>v2</code> движок не стартует — воркеры запускаются вручную через board-run.
        </div>
        <button type="submit" class="btn primary">🚀 Создать и запустить</button>
      </form>
    </div>
    <script>
    async function postForm(form) {
      const data = new URLSearchParams(new FormData(form));
      const btn = form.querySelector('button[type=submit]');
      const action = data.get('action');
      const endpoint = action === 'project' ? '/api/project/create'
        : action === 'idea' ? '/api/project/create-from-idea'
        : '/api/epic/create';
      btn.disabled = true; const oldTxt = btn.textContent; btn.textContent = 'Создание…';
      try {
        const r = await fetch(endpoint, { method:'POST', body:data });
        const j = await r.json();
        if (j.ok) {
          if (action === 'project') location.href = '/?created=' + encodeURIComponent('проект «'+(j.name||'')+'»');
          else if (action === 'idea') {
            const mode = j.orchestration_mode || 'v3';
            const engineMsg = mode === 'v3'
              ? (j.engine_spawned ? 'движок запущен (pid=' + j.engine_pid + ')' : 'движок НЕ запущен — проверь лог')
              : 'движок не стартует в v2 режиме — запусти board-run вручную';
            alert('Проект создан. project=' + j.project_id + ' epic=' + j.epic_id + ' task=' + j.task_id + '\\n' + engineMsg);
            location.href = '?project=' + j.project_id + '&created=' + encodeURIComponent('idea → ' + engineMsg);
          }
          else location.href = '?project=' + j.project_id + '&created=' + encodeURIComponent('эпик «'+(j.name||'')+'»');
        } else {
          btn.disabled = false; btn.textContent = oldTxt;
          alert('Ошибка: ' + (j.error || 'неизвестная'));
        }
      } catch (err) {
        btn.disabled = false; btn.textContent = oldTxt;
        alert('Сеть: ' + err.message);
      }
    }
    document.getElementById('proj-form').addEventListener('submit', e => { e.preventDefault(); postForm(e.target); });
    document.getElementById('epic-form').addEventListener('submit', e => { e.preventDefault(); postForm(e.target); });
    document.getElementById('idea-form').addEventListener('submit', e => { e.preventDefault(); postForm(e.target); });
    </script>`);
}

// --- POST /api/project/create: INSERT нового saga-проекта ---
// Тело: application/x-www-form-urlencoded (форма) или JSON. Поля: name (обяз.),
// description (опц.). Только INSERT в projects (status='active'). Валидация:
// name непустой + уникальный (БД не форсирует UNIQUE — проверяем запросом).
// activity_log: фиксируем создание, как project_create в saga-mcp.
function handleProjectCreate(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const name = (fields.name || '').toString().trim();
    const description = (fields.description || '').toString().trim();
    if (!name) return respondJson(res, 400, { ok:false, error: 'name обязательное поле' });

    try {
      const result = withDbWrite(db => {
        const dup = db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(name);
        if (dup) return { dup: true };
        const info = db.prepare(
          "INSERT INTO projects (name, description, status) VALUES (?, ?, 'active')"
        ).run(name, description || null);
        const newId = Number(info.lastInsertRowid);
        db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', ?, 'created', ?)"
        ).run(newId, `Создан проект «${name}» через tracker-view admin`);
        return { id: newId };
      });
      if (result.dup) return respondJson(res, 409, { ok:false, error: `Проект «${name}» уже существует` });
      respondJson(res, 200, { ok:true, id: result.id, name });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- POST /api/project/archive: soft-delete (status='archived') ---
// Тело: { project_id }. Не трогает cascade — только переводит проект в
// 'archived'. listProjects() фильтрует по status != 'archived', так что
// проект исчезает из канбана, но все данные сохраняются. Это CGAD-P2-
// совместимый путь. Восстановление — через SQL (UPDATE status='active').
function handleProjectArchive(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const projectId = Number(fields.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return respondJson(res, 400, { ok:false, error: 'project_id обязателен и должен быть положительным целым' });
    }
    try {
      const result = withDbWrite(db => {
        const row = db.prepare('SELECT name, status FROM projects WHERE id=?').get(projectId);
        if (!row) return { notFound: true };
        if (row.status === 'archived') return { alreadyArchived: true, name: row.name };
        db.prepare("UPDATE projects SET status='archived', updated_at=datetime('now') WHERE id=?")
          .run(projectId);
        db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', ?, 'archived', ?)"
        ).run(projectId, `Проект «${row.name}» архивирован через tracker-view admin`);
        return { name: row.name };
      });
      if (result.notFound) return respondJson(res, 404, { ok:false, error: `Проект ${projectId} не найден` });
      if (result.alreadyArchived) return respondJson(res, 200, { ok:true, id: projectId, name: result.name, already_archived: true });
      respondJson(res, 200, { ok:true, id: projectId, name: result.name });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- POST /api/project/delete: hard-delete (cascade) ---
// Тело: { project_id }. Полное удаление со всеми эпиками, задачами,
// артефактами, трассировками, worker_executions, repository bindings.
// Возвращает deregistered_checkouts — список (machine_id, local_path),
// которые были отвязаны, чтобы оператор мог подчистить диск отдельно.
//
// Safety: rejects (409) если engine_running=1 для любого эпика проекта.
// Не трогает: repositories rows (P17), activity_log (P12), command_receipts,
// on-disk .md artifact files.
function handleProjectDelete(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const projectId = Number(fields.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return respondJson(res, 400, { ok:false, error: 'project_id обязателен и должен быть положительным целым' });
    }
    try {
      const result = withDbWrite(db => {
        const row = db.prepare('SELECT name FROM projects WHERE id=?').get(projectId);
        if (!row) return { notFound: true };

        // Engine guard: reject if any epic has engine_running=1.
        const running = db.prepare(
          `SELECT ew.epic_id FROM episode_workflows ew
            JOIN epics e ON e.id = ew.epic_id
           WHERE e.project_id = ?
             AND json_extract(ew.metadata, '$.engine_running') = 1`,
        ).all(projectId);
        if (running.length > 0) {
          return { engineRunning: running.map(r => r.epic_id) };
        }

        // Capture checkouts before delete (return value).
        const checkouts = db.prepare(
          `SELECT rc.machine_id, rc.local_path
             FROM repository_checkouts rc
             JOIN project_repositories pr ON pr.id = rc.project_repository_id
            WHERE pr.project_id = ?`,
        ).all(projectId);

        // work_attempts.execution_id → worker_executions (no CASCADE).
        // Clean first, otherwise DELETE FROM worker_executions trips FK.
        db.prepare(
          `DELETE FROM work_attempts
            WHERE execution_id IN (
              SELECT execution_id FROM worker_executions WHERE project_id=?
            )`
        ).run(projectId);
        // worker_executions has no FK on project_id — manual cleanup.
        db.prepare('DELETE FROM worker_executions WHERE project_id=?').run(projectId);
        // DELETE FROM projects triggers every ON DELETE CASCADE.
        db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
        db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', ?, 'deleted', ?)"
        ).run(projectId, `Проект «${row.name}» (id=${projectId}) удалён через tracker-view admin`);
        return { name: row.name, checkouts };
      });
      if (result.notFound) return respondJson(res, 404, { ok:false, error: `Проект ${projectId} не найден` });
      if (result.engineRunning) {
        return respondJson(res, 409, {
          ok:false,
          error: `Сначала остановите движок для эпика(ов): ${result.engineRunning.join(', ')}`,
          running_epics: result.engineRunning,
        });
      }
      respondJson(res, 200, {
        ok:true, id: projectId, name: result.name,
        deregistered_checkouts: result.checkouts,
      });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- POST /api/epic/create: INSERT нового эпика ---
// Поля: project_id (обяз.), name (обяз.), description (опц.), branch (опц.).
// INSERT в epics (status='planned', priority='medium'). FK project_id проверяется.
function handleEpicCreate(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const projectId = Number(fields.project_id);
    const name = (fields.name || '').toString().trim();
    const description = (fields.description || '').toString().trim();
    const branch = (fields.branch || '').toString().trim();
    if (!projectId) return respondJson(res, 400, { ok:false, error: 'project_id обязательное поле' });
    if (!name) return respondJson(res, 400, { ok:false, error: 'name обязательное поле' });

    try {
      const result = withDbWrite(db => {
        const proj = db.prepare('SELECT id, name FROM projects WHERE id=?').get(projectId);
        if (!proj) return { missing: true };
        const info = db.prepare(
          "INSERT INTO epics (project_id, name, description, branch, status, priority) VALUES (?, ?, ?, ?, 'planned', 'medium')"
        ).run(projectId, name, description || null, branch || null);
        const newId = Number(info.lastInsertRowid);
        db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('epic', ?, 'created', ?)"
        ).run(newId, `Создан эпик «${name}» в проекте «${proj.name}» через tracker-view admin`);
        return { id: newId };
      });
      if (result.missing) return respondJson(res, 404, { ok:false, error: `Проект #${projectId} не найден` });
      respondJson(res, 200, { ok:true, id: result.id, project_id: projectId, name });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- POST /api/project/create-from-idea: one-shot bootstrap для 3.0 engine ---
// Поля: name (обяз.), idea (обяз.), local_path (опц., по умолчанию DEV_ROOT/<name>).
//
// Атомарно (одна withDbWrite транзакция) создаёт:
//   1. project (status=active)
//   2. repository_register (control repo, local_path, default_branch=main, integration_branch=dev)
//   3. epic (REQ-001-<name>, status=planned, priority=high)
//   4. episode_workflows row (stage=discovery) — INSERT OR IGNORE
//   5. discovery.kickstart task (workflow_stage=discovery, exec=saga-kickstart,
//      tracker_only, priority=critical)
// Затем, если SAGA_ORCHESTRATION_MODE !== 'v2', spawn'ит orchestrate-cli.js
// как detached background process. v2 режим — движок не запускается (поведение
// v2 не меняется, ADR-008/plan §Feature flag).
//
// Git init НЕ делается здесь — saga-kickstart воркер сам создаст коммит после
// регистрации brief artifact (см. saga-kickstart SKILL). Это сознательное
// упрощение: идея может быть уточнена/отклонена на discovery, тогда git init
// не нужен.
function handleProjectCreateFromIdea(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const name = (fields.name || '').toString().trim();
    const idea = (fields.idea || '').toString().trim();
    if (!name) return respondJson(res, 400, { ok:false, error: 'name обязательное поле' });
    if (!idea) return respondJson(res, 400, { ok:false, error: 'idea обязательное поле' });
    const localPath = (fields.local_path || '').toString().trim()
      || path.join(DEV_ROOT, name);

    try {
      const result = withDbWrite(db => {
        const dup = db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(name);
        if (dup) return { dup: true };

        // 1. project
        const projInfo = db.prepare(
          "INSERT INTO projects (name, description, status) VALUES (?, ?, 'active')"
        ).run(name, idea);
        const projectId = Number(projInfo.lastInsertRowid);

        // 2. repository — register control repo. Two INSERTs matching
        //    repository_register in src/tools/repositories.ts (repositories +
        //    project_repositories). project_repositories has no `name` column —
        //    name lives on `repositories`. We inline so the whole bootstrap is
        //    one atomic transaction (no half-created project on partial failure).
        const repoInfo = db.prepare(
          `INSERT INTO repositories (name, default_branch) VALUES (?, 'main')`,
        ).run(name);
        const repoId = Number(repoInfo.lastInsertRowid);
        db.prepare(
          `INSERT INTO project_repositories
             (project_id, repository_id, role, local_path,
              integration_branch, status)
           VALUES (?, ?, 'control', ?, 'dev', 'active')`,
        ).run(projectId, repoId, localPath);

        // 3. epic
        const epicInfo = db.prepare(
          "INSERT INTO epics (project_id, name, description, status, priority) VALUES (?, ?, ?, 'planned', 'high')"
        ).run(projectId, `REQ-001-${name}`, `Discovery: ${idea}`);
        const epicId = Number(epicInfo.lastInsertRowid);

        // 4. episode_workflows — discovery stage
        db.prepare('INSERT OR IGNORE INTO episode_workflows (epic_id) VALUES (?)').run(epicId);

        // 5. kickstart task — tracker_only so worker_done auto-fires brief_accepted
        //    (dispatcher.ts:608-611 gates generation on execution_mode !== git_change).
        const taskInfo = db.prepare(
          `INSERT INTO tasks
             (epic_id, title, description, status, priority, task_kind, workflow_stage,
              execution_skill, review_skill, execution_mode, tags, metadata)
           VALUES (?, ?, ?, 'todo', 'critical', 'discovery.kickstart', 'discovery',
                   'saga-kickstart', 'saga-requirements-reviewer', 'tracker_only', ?, '{}')`,
        ).run(
          epicId,
          `Discovery: ${idea}`,
          JSON.stringify({ idea }),
          JSON.stringify(['stage:discovery', 'kind:discovery.kickstart', 'role:discovery']),
        );
        const taskId = Number(taskInfo.lastInsertRowid);

        db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', ?, 'created', ?)"
        ).run(projectId, `Создан проект «${name}» через веб-форму idea → engine`);

        return { projectId, repoId, epicId, taskId };
      });

      if (result.dup) {
        return respondJson(res, 409, { ok:false, error: `Проект «${name}» уже существует` });
      }

      // Создаём директорию репозитория (если её нет) — без git init.
      try {
        if (!existsSync(localPath)) mkdirSync(localPath, { recursive: true });
      } catch (e) {
        // Не блокируем ответ — ворер kickstart получит осмысленную ошибку при старте.
        console.error(`[create-from-idea] mkdir ${localPath} failed: ${e.message}`);
      }

      // Spawn движка, если включён v3 режим.
      const mode = (process.env.SAGA_ORCHESTRATION_MODE || 'v3').toLowerCase();
      const selectedConcurrency = Number(fields.concurrency);
      const concurrency = Number.isInteger(selectedConcurrency) && selectedConcurrency >= 1 && selectedConcurrency <= 32
        ? selectedConcurrency : 1;
      let engineSpawned = false;
      let enginePid = null;
      if (mode === 'v3') {
        try {
          const child = spawnEngine(result.projectId, result.epicId, concurrency);
          setEngineMeta(result.epicId, {
            controller_version: 'v3', engine_running: 1, engine_pid: child.pid,
            engine_concurrency: concurrency, engine_started_at: new Date().toISOString(),
          });
          engineSpawned = true;
          enginePid = child.pid;
        } catch (e) {
          console.error(`[create-from-idea] engine spawn failed: ${e.message}`);
        }
      }

      respondJson(res, 200, {
        ok: true,
        project_id: result.projectId,
        repo_id: result.repoId,
        epic_id: result.epicId,
        task_id: result.taskId,
        orchestration_mode: mode,
        engine_spawned: engineSpawned,
        engine_pid: enginePid,
        local_path: localPath,
      });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- POST /api/episode/resume: снять needs-human флаг эпизода ---
// Плане §4 (Risks): когда episode_workflows.metadata.needs-human === true,
// движок остановился и ждёт. Эта ручка снимает флаг — движок (если запущен)
// на следующем poll'е (10 сек) увидит изменение и продолжит.
// Если движок не запущен (paused_timeout / процесс убит), endpoint НЕ
// перезапускает его — пользователь должен запустить orchestrate-cli вручную
// или пересоздать через веб-форму.
function handleEpisodeResume(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { fields = JSON.parse(raw); } catch { fields = {}; }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
    const epicId = Number(fields.epic_id);
    if (!epicId) return respondJson(res, 400, { ok:false, error: 'epic_id обязательное поле' });

    try {
      const changes = withDbWrite(db => {
        const before = db.prepare(
          `SELECT json_extract(metadata,'$.needs-human') AS nh FROM episode_workflows WHERE epic_id=?`,
        ).get(epicId);
        db.prepare(
          `UPDATE episode_workflows
             SET metadata=json_remove(metadata, '$.needs-human', '$.pause_reason', '$.paused_at'),
                 updated_at=datetime('now')
           WHERE epic_id=?`,
        ).run(epicId);
        return { was_paused: before?.nh === 1 };
      });
      respondJson(res, 200, { ok:true, epic_id: epicId, ...changes });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
    }
  });
}

// --- GET /api/episode/pipeline?epic_id=N ---
// Pipeline progress data per docs/saga-mcp-3.0-pipeline-ui-spec.md.
// Computes per-stage status + timestamps FROM activity_log (no new tables).
// activity_log rows are written by lifecycle.ts:150 on every episode_transition
// (field_name='episode_stage', old_value=<from>, new_value=<to>).
function handleEpisodePipeline(req, res, url) {
  const epicId = Number(url.searchParams.get('epic_id'));
  if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
  try {
    const STAGES = ['discovery','formalization','planning','development','verification','integration','completed'];
    const ew = withDb(db => db.prepare('SELECT stage, metadata, created_at FROM episode_workflows WHERE epic_id=?').get(epicId));
    if (!ew) return respondJson(res, 404, { ok:false, error:'episode not found' });

    // Find all stage transitions from activity_log, oldest first.
    const transitions = withDb(db => db.prepare(
      `SELECT old_value, new_value, created_at FROM activity_log
       WHERE entity_type='epic' AND entity_id=? AND field_name='episode_stage'
       ORDER BY created_at ASC`
    ).all(epicId));

    const meta = (() => { try { return JSON.parse(ew.metadata || '{}'); } catch { return {}; } })();
    if (meta.controller_version === 'v3') {
      let spec = null;
      let rows = [];
      try {
        spec = withDb(db => db.prepare(
          `SELECT id FROM saga3_episode_specs WHERE epic_id=? ORDER BY generation DESC LIMIT 1`,
        ).get(epicId));
        rows = spec ? withDb(db => db.prepare(
          `SELECT condition_type, status, updated_at
             FROM saga3_condition_instances WHERE episode_spec_id=?`,
        ).all(spec.id)) : [];
      } catch {}
      const byType = new Map(rows.map(row => [row.condition_type, row]));
      const groups = [
        ['discovery', ['MandatePresent','ConstitutionReady']],
        ['formalization', ['ContractConsistent','BaselineFrozen']],
        ['architecture', ['ArchitectureReady']],
        ['planning', ['PlanReady']],
        ['development', ['ImplementationComplete']],
        ['verification', ['VerificationCurrent']],
        ['integration', ['IntegrationComplete']],
        ['release', ['ReleaseReady','ReleaseCompleted']],
        ['observation', ['ObservationHealthy']],
      ];
      let firstOpen = groups.findIndex(([, conditions]) =>
        !conditions.every(type => byType.get(type)?.status === 'True'));
      if (firstOpen < 0) firstOpen = groups.length;
      const stages = groups.map(([name, conditions], index) => {
        const conditionRows = conditions.map(type => byType.get(type)).filter(Boolean);
        const failed = conditionRows.some(row => row.status === 'False');
        const status = index < firstOpen ? 'completed'
          : index === firstOpen ? (failed ? 'failed' : 'in_progress') : 'pending';
        return {
          name, status,
          started_at: conditionRows[0]?.updated_at ?? null,
          completed_at: status === 'completed' ? conditionRows.at(-1)?.updated_at ?? null : null,
          duration_s: null,
          conditions: conditions.map(type => ({ type, status: byType.get(type)?.status ?? 'Unknown' })),
        };
      });
      stages.push({
        name: 'completed', status: firstOpen === groups.length ? 'completed' : 'pending',
        started_at: null, completed_at: null, duration_s: null, conditions: [],
      });
      return respondJson(res, 200, {
        ok: true, epic_id: epicId, controller_version: 'v3',
        episode_spec_id: spec?.id ?? null,
        stage: firstOpen < groups.length ? groups[firstOpen][0] : 'completed',
        stages, needs_human: false, last_gate_error: meta.engine_last_error || null,
      });
    }
    const needsHuman = meta['needs-human'] === true || meta['needs-human'] === 1;
    const gateError = meta.last_gate_error || null;

    const currentIdx = STAGES.indexOf(ew.stage);
    const stages = STAGES.map((name, i) => {
      // Entry transition: first time activity_log shows new_value=<name>.
      // For the initial stage (no enter record — episode_workflows was
      // INSERT-OR-IGNORE'd at creation, no activity_log entry), fall back
      // to episode_workflows.created_at as the enter timestamp.
      const enter = transitions.find(t => t.new_value === name)
        || (name === STAGES[0] ? { created_at: ew.created_at } : null);
      // Exit transition: first time activity_log shows old_value=<name>.
      const exit = transitions.find(t => t.old_value === name);
      // For the current stage with no exit yet, duration is "running" — show
      // time elapsed since enter so the user sees live progress.
      let status = 'pending';
      if (i < currentIdx) status = 'completed';
      else if (i === currentIdx) {
        // 'completed' and 'cancelled' are terminal stages — once entered,
        // they ARE the end state, not "in progress". Without this exception
        // the pipeline bar shows the final stage as a pulsing blue ● forever,
        // because there is no next stage for it to advance to.
        if (ew.stage === 'completed' || ew.stage === 'cancelled') {
          status = needsHuman ? 'needs_human' : 'completed';
        } else {
          status = needsHuman ? 'needs_human' : 'in_progress';
        }
      }
      // cancelled stage is mutually exclusive; treat as terminal-pending unless stage===cancelled
      let duration_s = null;
      if (enter && exit) {
        duration_s = Math.round((new Date(exit.created_at + 'Z') - new Date(enter.created_at + 'Z')) / 1000);
      } else if (enter && i === currentIdx) {
        // Live duration for current stage (time since enter until now).
        duration_s = Math.round((Date.now() - new Date(enter.created_at + 'Z').getTime()) / 1000);
      }
      return {
        name,
        status,
        started_at: enter?.created_at || null,
        completed_at: exit?.created_at || null,
        duration_s,
      };
    });

    respondJson(res, 200, {
      ok: true,
      epic_id: epicId,
      stage: ew.stage,
      stages,
      needs_human: needsHuman,
      last_gate_error: gateError,
    });
  } catch (e) {
    respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
  }
}

// --- GET /api/episode/stage-summary?epic_id=N&stage=formalization ---
// Stage-summary-via-task-spawn: when the user clicks a pipeline stage, this
// endpoint returns the markdown body of an accepted `summary` artifact for
// that stage; if no such artifact exists yet, it spawns a `summary.stage`
// worker task that writes one. Duplicate clicks return the existing task_id
// (the INSERT is idempotent on generation_key).
//
// Three response shapes:
//   - { ok:true, status:'ready',     artifact_id, content, generated_at }
//   - { ok:true, status:'generating', task_id }   // summary artifact exists but is draft/in_review
//   - { ok:true, status:'queued',     task_id }   // no artifact yet; task created OR reused
//
// The summary task's workflow_stage is the episode's CURRENT stage so that
// worker_next can claim it from the live queue. The task is tracker_only
// (no git worktree), critical priority (immediate pickup), and is NOT a gate
// task — episode transitions are unaffected.
const STAGE_SUMMARY_CODE = (stage) => 'STAGE-' + String(stage).toUpperCase() + '-SUMMARY';
function handleStageSummary(req, res, url) {
  const epicId = Number(url.searchParams.get('epic_id'));
  const stage = String(url.searchParams.get('stage') || '');
  if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
  const STAGES = ['discovery','formalization','planning','development','verification','integration','completed'];
  if (!STAGES.includes(stage)) {
    return respondJson(res, 400, { ok:false, error:'unknown stage: ' + stage });
  }
  const code = STAGE_SUMMARY_CODE(stage);
  try {
    // Resolve epic -> project_id + name + current_stage (needed to build the
    // artifact path and to give the worker the right workflow_stage).
    const epicRow = withDb(db => db.prepare(
      `SELECT e.id, e.project_id, e.name, ew.stage AS current_stage
         FROM epics e LEFT JOIN episode_workflows ew ON ew.epic_id=e.id
        WHERE e.id=?`
    ).get(epicId));
    if (!epicRow) return respondJson(res, 404, { ok:false, error:'epic not found' });

    // --- 1) Existing summary artifact for this stage? ---
    // Match by code (STAGE-<STAGE>-SUMMARY), not by type — the saga artifact
    // type catalog doesn't include 'summary' yet, so the worker may have
    // fallen back to 'decision' or another type. The code is unique per
    // stage-summary, so it's the reliable identifier.
    const existing = withDb(db => db.prepare(
      `SELECT a.id, a.status, a.path, a.project_repository_id, a.updated_at,
              p.name AS project_name
         FROM artifacts a JOIN projects p ON p.id=a.project_id
        WHERE a.epic_id=? AND a.code=?`
    ).get(epicId, code));

    if (existing) {
      if (existing.status === 'accepted') {
        const content = readSummaryMarkdown(existing.path, existing.project_name, existing.project_repository_id);
        return respondJson(res, 200, {
          ok: true, status: 'ready',
          artifact_id: existing.id,
          content,
          generated_at: existing.updated_at,
        });
      }
      // draft / in_review — recover the in-flight task id if we can.
      const inflight = findSummaryTask(epicId, stage);
      return respondJson(res, 200, {
        ok: true, status: 'generating',
        task_id: inflight?.id || null,
      });
    }

    // --- 2) No artifact yet. Already a queued/running task? ---
    const queued = findSummaryTask(epicId, stage);
    if (queued) {
      return respondJson(res, 200, { ok:true, status:'queued', task_id: queued.id });
    }

    // --- 3) Spawn a fresh task (idempotent on generation_key). ---
    const taskRow = createSummaryTask(epicRow, stage, code);
    return respondJson(res, 200, { ok:true, status:'queued', task_id: taskRow.id });
  } catch (e) {
    respondJson(res, 500, { ok:false, error: 'stage-summary: ' + e.message });
  }
}

// Find an existing summary.stage task for one epic+stage (any non-done status,
// so we don't duplicate-spawn on rapid clicks). Done tasks are ignored — a
// completed summary task with no accepted artifact means the worker failed,
// and we want a fresh task rather than a dead reference.
function findSummaryTask(epicId, stage) {
  return withDb(db => db.prepare(
    `SELECT id, status, metadata FROM tasks
      WHERE epic_id=? AND task_kind='summary.stage'
        AND status IN ('todo','in_progress','review','review_in_progress','blocked')
        AND json_extract(metadata,'$.stage')=?`
  ).get(epicId, stage)) || null;
}

// Read the .md body of a summary artifact off disk. Returns the raw markdown
// (the frontend renders it minimally — paragraphs, bold, lists). Falls back to
// an empty string if the file is not yet present (worker still writing).
function readSummaryMarkdown(artifactPath, projectName, projectRepositoryId) {
  let repositoryPath = null;
  if (projectRepositoryId) {
    const row = withDb(db => db.prepare(
      'SELECT local_path FROM project_repositories WHERE id=?'
    ).get(projectRepositoryId));
    repositoryPath = row?.local_path || null;
  }
  const resolved = resolveArtifactFile(artifactPath, projectName, repositoryPath);
  if (!resolved) return '';
  try { return readFileSync(resolved.abs, 'utf8'); }
  catch { return ''; }
}

// INSERT a summary.stage task. The description is the inline prompt the worker
// follows verbatim. workflow_stage = episode's CURRENT stage (so worker_next
// claims it from the live queue). generation_key makes the INSERT idempotent
// per (epic, stage) — concurrent calls collapse onto the existing row via the
// UNIQUE(epic_id, generation_key) index declared in src/schema.ts.
function createSummaryTask(epicRow, stage, code) {
  const epicId = epicRow.id;
  const projectId = epicRow.project_id;
  const epicName = String(epicRow.name || ('REQ-' + epicId));
  const currentStage = epicRow.current_stage || stage;
  const slug = epicName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('req-' + epicId);
  const artifactPath = 'docs/requirements/' + slug + '/stage-' + stage + '-summary.md';
  const titleCase = stage.charAt(0).toUpperCase() + stage.slice(1);

  const prompt = [
    'ЗАДАЧА: РЕЗЮМЕ СТАДИИ. Стадия: ' + stage + '. Эпизод: ' + epicId + '.',
    '',
    'ВАЖНО: Пиши резюме НА ЧИСТОМ РУССКОМ ЯЗЫКЕ. Без английских терминов.',
    'Если встречаешь английский термин (PRD, SRS, baseline, reconciliation, scaffold и т.д.) —',
    'объясняй его простыми словами на русском, как студенту.',
    'Например: НЕ «затем сверяет их на reconciliation и сводит к принятому baseline AC»,',
    'А «затем сравнивает техзадание и сценарии использования, устраняет противоречия',
    'и формирует итоговый набор критериев приёмки (AC — условия, которым должен соответствовать продукт)».',
    '',
    'Прочитай все артефакты и задачи этой стадии через mcp__saga__ tools:',
    '- artifact_list({epic_id, type:\'PRD\'}), artifact_list({epic_id, type:\'SRS\'}) и т.д.',
    '- task_list({epic_id}) — отфильтруй по workflow_stage.',
    '',
    'Напиши краткое понятное резюме (3-5 абзацев) на русском:',
    '1. Какова была цель этой стадии — простыми словами',
    '2. Какие документы (артефакты) созданы — названия, ключевые решения',
    '3. Какие задачи выполнялись и их результаты',
    '4. Важные решения, конфликты или компромиссы',
    '5. Что эта стадия даёт следующему этапу',
    '',
    'Сохрани резюме как артефакт:',
    '  artifact_create({',
    '    project_id: ' + projectId + ', epic_id: ' + epicId + ', type:\'summary\',',
    '    code:\'' + code + '\', title:\'' + titleCase + ' Summary\',',
    '    path:\'' + artifactPath + '\',',
    '    status:\'accepted\'',
    '  })',
    'Также запиши .md файл на диск по указанному пути.',
    '',
    'Вызови worker_done после завершения.',
  ].join('\n');

  const genKey = 'summary.stage:' + stage;
  const tagsJson = JSON.stringify(['role:summary', 'stage:' + stage]);
  const metaJson = JSON.stringify({ stage, target: 'artifact', spawned_for: stage });

  // INSERT — then re-SELECT by (epic_id, generation_key) so a concurrent click
  // that hit the UNIQUE constraint still recovers the original task_id.
  let insertErr = null;
  try {
    withDbWrite(db => db.prepare(
      `INSERT INTO tasks (epic_id, title, description, status, priority, task_kind,
                          workflow_stage, execution_skill, execution_mode,
                          tags, metadata, generation_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      epicId,
      'Summary: ' + stage,
      prompt,
      'todo',
      'critical',
      'summary.stage',
      currentStage,
      'saga-worker',
      'tracker_only',
      tagsJson,
      metaJson,
      genKey,
    ));
  } catch (e) {
    insertErr = e; // Expected on race; fall through to SELECT below.
  }
  const created = withDb(db => db.prepare(
    'SELECT id FROM tasks WHERE epic_id=? AND generation_key=? ORDER BY id DESC LIMIT 1'
  ).get(epicId, genKey));
  if (!created) throw new Error('failed to create summary task: ' + (insertErr?.message || 'unknown'));
  return created;
}

// --- GET /api/worker/tail?log_path=<path>&lines=8 ---
// Returns the last N events from a worker's stream-json JSONL log.
// SECURITY: log_path must resolve inside the board-runs root (path traversal
// guard). Each JSONL line is parsed minimally — we surface type, tool name
// (for tool_use), and a short text snippet. Never return raw content.
function handleWorkerTail(req, res, url) {
  const logRoot = path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
  const requestedPath = url.searchParams.get('log_path');
  const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 8, 1), 50);
  if (!requestedPath) return respondJson(res, 400, { ok:false, error:'log_path required' });

  // Resolve and verify the path is contained under logRoot.
  const resolved = path.resolve(requestedPath);
  const resolvedRoot = path.resolve(logRoot);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return respondJson(res, 403, { ok:false, error:'log_path outside board-runs root' });
  }
  if (!existsSync(resolved)) {
    return respondJson(res, 404, { ok:false, error:'log file not found (worker may not have written yet)' });
  }

  try {
    // Read tail of file, but scan DEEP enough to find `lines` MEANINGFUL
    // events (non-thinking_tokens). Workers in deep reasoning can emit
    // thousands of thinking_tokens events consecutively — taking the last
    // N lines naively returns only thinking noise after filtering.
    //
    // Strategy: read backwards in 256KB chunks, parse all lines, filter out
    // thinking_tokens, until we collect `lines` meaningful events or hit
    // start of file. Cap at 2MB to bound work.
    const stat = statSync(resolved);
    const CHUNK = 256 * 1024;
    const MAX_BYTES = 2 * 1024 * 1024;
    const readBytes = Math.min(stat.size, MAX_BYTES);
    const fd = openSync(resolved, 'r');
    const buf = Buffer.alloc(readBytes);
    readSync(fd, buf, 0, readBytes, Math.max(0, stat.size - readBytes));
    closeSync(fd);
    const allLines = buf.toString('utf8').split('\n').filter(Boolean);
    // Walk from the end, parse, keep only meaningful events, stop when we
    // have `lines` of them (or run out of buffer).
    const collected = [];
    for (let i = allLines.length - 1; i >= 0 && collected.length < lines; i -= 1) {
      const raw = allLines[i];
      try {
        const evt = JSON.parse(raw);
        // Skip noise events that clutter the tail view.
        if (evt.type === 'system' && evt.subtype === 'thinking_tokens') continue;
        if (evt.type === 'system' && (evt.subtype === 'hook_started' || evt.subtype === 'hook_progress' || evt.subtype === 'hook_response')) continue;
        collected.unshift({ raw, evt });
      } catch {
        // Non-JSON line — skip raw stderr noise (connectors warnings etc).
        if (raw.length > 5 && !raw.startsWith('⚠') && !raw.includes('connectors are disabled')) {
          collected.unshift({ raw, evt: null });
        }
      }
    }
    const lastLines = collected.map(c => c.raw);

    const events = lastLines.map(raw => {
      try {
        const evt = JSON.parse(raw);
        const type = evt.type || 'unknown';
        // Extract a short label depending on event type.
        if (type === 'assistant' && evt.message?.content) {
          const blocks = evt.message.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_use') {
                return { type, kind: 'tool', tool: b.name, snippet: truncate(JSON.stringify(b.input || {}), 80), subagent: !!evt.parent_tool_use_id };
              }
              if (b.type === 'text' && typeof b.text === 'string') {
                return { type, kind: 'text', snippet: truncate(b.text, 100), subagent: !!evt.parent_tool_use_id };
              }
            }
          }
          return { type, kind: 'empty' };
        }
        if (type === 'user' && evt.message?.content) {
          const blocks = evt.message.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_result') {
                const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
                return { type, kind: 'tool_result', snippet: truncate(c, 80) };
              }
            }
          }
          return { type, kind: 'user_msg' };
        }
        if (type === 'system') {
          // Skip thinking_tokens noise: stream-json emits one event per token
          // increment (thousands per turn). Also skip hook lifecycle events
          // (hook_started/hook_progress/hook_response) — internal plumbing.
          // Surface only meaningful system events: init, api_retry, plugin_install.
          if (evt.subtype === 'thinking_tokens') return null;
          if (evt.subtype === 'hook_started' || evt.subtype === 'hook_progress' || evt.subtype === 'hook_response') return null;
          if (evt.subtype === 'api_retry') {
            const attempt = evt.attempt || '?';
            const status = evt.error_status || '?';
            const err = evt.error || '?';
            const delay = evt.retry_delay_ms ? Math.round(evt.retry_delay_ms / 1000) + 's' : '?';
            return { type, kind: 'system', subtype: 'api_retry',
              snippet: `retry ${attempt}/${evt.max_retries||'?'} ${status} ${err} wait ${delay}` };
          }
          return { type, kind: 'system', subtype: evt.subtype || null };
        }
        if (type === 'result') {
          return {
            type, kind: 'result',
            cost_usd: evt.total_cost_usd ?? null,
            duration_ms: evt.duration_ms ?? null,
            num_turns: evt.num_turns ?? null,
            subtype: evt.subtype || null,
          };
        }
        return { type };
      } catch {
        // Non-JSON line (e.g. stray stderr output) — surface as raw snippet.
        return { type: 'raw', snippet: truncate(raw, 100) };
      }
    });

    respondJson(res, 200, { ok:true, log_path: resolved, events: events.filter(Boolean) });
  } catch (e) {
    respondJson(res, 500, { ok:false, error: 'read: ' + e.message });
  }
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// --- GET /api/workers/active?project_id=N ---
// Returns live workers for a project, sourced from the DB (NOT from the
// in-memory boardRunner singleton). This works across processes: the engine
// (orchestrate-cli.js) spawns workers into its own runner instance, which
// tracker-view cannot see. But both share the SQLite DB — so we read
// active tasks (status in_progress/review_in_progress with assigned_to),
// and resolve each worker's JSONL log path by convention.
//
// Log path convention (claude-runner.mjs:313):
//   <logRoot>/board-<projectId>-<timestamp>/task-<taskId>-<workerId>.jsonl
// logRoot default: ~/.zcode/cli/board-runs
function handleWorkersActive(req, res, url) {
  const projectId = Number(url.searchParams.get('project_id'));
  if (!projectId) return respondJson(res, 400, { ok:false, error:'project_id required' });
  try {
    const logRoot = path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
    const rows = withDb(db => db.prepare(
      `SELECT we.execution_id, we.task_id AS id, we.worker_id AS assigned_to,
              we.pid, we.machine_id, we.phase, we.started_at AS worker_started_at,
              we.log_path,
              COALESCE(json_extract(we.metadata,'$.condition_type'), t.title) AS title,
              t.status, t.task_kind, t.updated_at,
              e.name AS epic_name
       FROM worker_executions we
       LEFT JOIN tasks t ON t.id=we.task_id
       LEFT JOIN epics e ON e.id=we.epic_id
       WHERE we.project_id=? AND we.state IN ('running','cancel_requested')
       UNION ALL
       SELECT 'legacy-task-' || t.id AS execution_id, t.id,
              COALESCE(t.assigned_to,'legacy-orphan-' || t.id) AS assigned_to,
              json_extract(t.metadata,'$.worker_pid') AS pid,
              ? AS machine_id, 'legacy' AS phase,
              json_extract(t.metadata,'$.worker_started_at') AS worker_started_at,
              NULL AS log_path, t.title, t.status, t.task_kind, t.updated_at,
              e.name AS epic_name
         FROM tasks t
         JOIN epics e ON e.id=t.epic_id
        WHERE e.project_id=?
          AND (
            t.status IN ('in_progress','review_in_progress')
            OR (t.status='review' AND t.assigned_to IS NOT NULL AND t.assigned_to!='')
          )
          AND t.current_execution_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM worker_executions active
             WHERE active.task_id=t.id
               AND active.state IN ('reserved','running','cancel_requested')
          )
       ORDER BY worker_started_at`,
    ).all(projectId, os.hostname(), projectId))
      .filter(r => r.machine_id === os.hostname() && isProcessAlive(r.pid));
    // Resolve JSONL log path by scanning board-runs for a matching filename.
    // The newest matching file wins (workers reuse IDs across runs).
    const workers = rows.map(r => {
      const taskFilePattern = `task-${r.id}-${r.assigned_to.replace(/[^a-zA-Z0-9._-]+/g, '-')}.jsonl`;
      let logPath = r.log_path || null;
      try {
        const runDirs = readdirSync(logRoot)
          .filter(d => d.startsWith(`board-${projectId}-`))
          .map(d => ({ d, full: path.join(logRoot, d), mtime: statSync(path.join(logRoot, d)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        for (const rd of runDirs) {
          const candidate = path.join(rd.full, taskFilePattern);
          if (existsSync(candidate)) { logPath = candidate; break; }
        }
      } catch { /* logRoot missing or unreadable */ }
      // Prefer worker_started_at (written by claude-runner.mjs on spawn)
      // over updated_at — the latter bumps on any status/metadata change
      // and doesn't reflect when the current worker subprocess started.
      // Normalise to ISO Z so the frontend Date.parse() doesn't mis-treat
      // the SQLite 'YYYY-MM-DD HH:MM:SS' format as local time (browser
      // timezone shifts the parsed timestamp by ±hours, making ages drift
      // by the timezone offset — e.g. 200m instead of 20m at UTC+3).
      const startedRaw = r.worker_started_at || r.updated_at;
      const startedIso = startedRaw && startedRaw.indexOf('T') < 0
        ? startedRaw.replace(' ', 'T') + 'Z'
        : startedRaw;
      // mtime of the JSONL log — drives the streaming pulse on the kanban
      // dot. If the log grew within the last few seconds, the worker is
      // actively streaming regardless of when the DB row was last touched.
      let log_mtime_ms = null;
      if (logPath) {
        try { log_mtime_ms = statSync(logPath).mtimeMs; } catch { /* gone */ }
      }
      // Worker is 'stale' if its log hasn't grown for >30s. Most likely the
      // subprocess died without firing a close event (OOM, network drop,
      // kill -9) and the task is stranded in in_progress/review_in_progress.
      // Frontend shows this as instant red (no pulse) — clearer signal than
      // waiting for the age-based yellow→red gradient to reach 60s.
      const QUIET_AFTER_MS = 30 * 1000;
      const is_quiet = log_mtime_ms != null && (Date.now() - log_mtime_ms) > QUIET_AFTER_MS;

      // Token speed: scan the last ~32KB of JSONL for thinking_tokens events
      // (stream-json emits them per-token with estimated_tokens_delta). Count
      // deltas within the last 10 seconds of log mtime → tokens/sec.
      // This is a live throughput indicator — how fast the model is producing.
      let tokens_per_sec = null;
      let total_tokens = null;
      if (logPath) {
        try {
          const fs2 = require('node:fs');
          const st2 = fs2.statSync(logPath);
          const tailBytes2 = Math.min(st2.size, 128 * 1024);
          const fd2 = fs2.openSync(logPath, 'r');
          const buf2 = Buffer.alloc(tailBytes2);
          fs2.readSync(fd2, buf2, 0, tailBytes2, Math.max(0, st2.size - tailBytes2));
          fs2.closeSync(fd2);
          const lines = buf2.toString('utf8').split('\n').filter(Boolean);
          // Try thinking_tokens first (smart models stream real token counts).
          // If they're all 1 (z.ai proxy for flash models), fall back to
          // counting assistant output characters as a throughput proxy.
          let lastTotal = 0;
          let totalChars = 0;
          let assistantBlocks = 0;
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'system' && evt.subtype === 'thinking_tokens') {
                lastTotal = Math.max(lastTotal, evt.estimated_tokens || 0);
              }
              if (evt.type === 'assistant' && evt.message?.content) {
                for (const b of evt.message.content) {
                  if (b.type === 'text' && b.text) { totalChars += b.text.length; assistantBlocks++; }
                  if (b.type === 'tool_use') { totalChars += JSON.stringify(b.input || {}).length; assistantBlocks++; }
                }
              }
            } catch { /* non-JSON */ }
          }
          // Use thinking_tokens if they're real (> 1). Otherwise use assistant
          // output chars / 4 as rough token estimate (~4 chars per token).
          if (lastTotal > 1) {
            total_tokens = lastTotal;
          } else if (totalChars > 0) {
            total_tokens = Math.round(totalChars / 4);
          } else {
            total_tokens = null;
          }
          // tokens_per_sec: divide total tokens by the worker's running time.
          const startMs = startedRaw ? new Date(startedIso).getTime() : null;
          if (startMs && total_tokens != null && total_tokens > 0) {
            const elapsedSec = Math.max(1, (Date.now() - startMs) / 1000);
            tokens_per_sec = Math.round(total_tokens / elapsedSec * 10) / 10;
          }
        } catch { /* stat/read fail */ }
      }
      return {
        task_id: r.id,
        title: r.title,
        status: r.status,
        task_kind: r.task_kind,
        worker_id: r.assigned_to,
        execution_id: r.execution_id,
        pid: r.pid,
        process_phase: r.phase,
        epic_name: r.epic_name,
        started_at: startedIso,
        log_mtime_ms,
        is_stale: false,
        is_quiet,
        tokens_per_sec,
        total_tokens,
        log_path: logPath,
      };
    });
    respondJson(res, 200, { ok:true, project_id: projectId, workers });
  } catch (e) {
    respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
  }
}

// --- Engine control: start / stop / status / restart ---
//
// The kanban board exposes explicit ▶ Start / ⏸ Pause buttons per epic.
// This prevents accidental auto-start of every project's engine, which
// would burn tokens (each running engine spawns `claude -p` workers).
//
// State machine:
//   - The engine process is matched by command line (project_id + epic_id).
//   - Persisted flag $.engine_running in episode_workflows.metadata records
//     the user's last intent. On page reload the UI reads this flag to
//     render the correct button label (▶ if stopped, ⏸ if running).
//   - Start = kill any existing engine for this epic + spawn fresh.
//   - Stop  = kill engine + workers, NO respawn.
//   - Restart = alias of Start (back-compat for the concurrency selector).
//
// Concurrency selector change:
//   - If engine is RUNNING → restart with new concurrency (old behaviour).
//   - If engine is STOPPED → just persist the new value; do NOT auto-start.
//     The user must press ▶ explicitly. This is the audit fix for the
//     "tokens burned by accidental auto-start" risk.

/**
 * Kill the engine process tree + orphan workers for a given (projectId, epicId).
 * Returns the list of PIDs that were targeted (best-effort; some may already
 * be dead). Synchronous: uses spawnSync.
 *
 * Strategy:
 *   1. Find all `orchestrate-cli.js <projectId> <epicId>` node.exe engines.
 *   2. For each, walk the CIM process tree recursively and collect descendants
 *      (claude.exe workers + their MCP node.exe children + conhost.exe).
 *   3. Also catch orphan claude.exe workers whose command line mentions
 *      project_id=<projectId> (survived a prior kill).
 *   4. taskkill /F every collected PID.
 *   5. Synchronous 1s pause so the OS finishes cleanup before any respawn.
 */
function killEngineTree(projectId, epicId) {
  const state = readEngineState(epicId);
  if (state.pid && isProcessAlive(Number(state.pid))) {
    try {
      const inspection = require('child_process').spawnSync(
        'powershell',
        ['-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(state.pid)}").CommandLine`],
        { encoding: 'utf8' },
      );
      const commandLine = (inspection.stdout || '').toLowerCase();
      if (commandLine.includes('saga3') && commandLine.includes('cli.js')) {
        require('child_process').spawnSync(
          'taskkill', ['/F', '/T', '/PID', String(Number(state.pid))],
          { encoding: 'utf8', stdio: 'ignore' },
        );
      }
    } catch (e) {
      console.error(`[engine-control] stored pid kill failed pid=${state.pid}:`, e.message);
    }
  }
  // IMPORTANT: the PowerShell parameter MUST NOT be named $pid — that is a
  // read-only automatic variable in PowerShell (the current shell's PID).
  // Declaring a function parameter with that name throws
  // SessionStateUnauthorizedAccessException → the function body never runs
  // → descendants are not collected → only the engine itself gets killed,
  // not the claude.exe workers under it. Use $procId instead.
  //
  // CRITICAL: do NOT put `#` comments inside the -Command string. In
  // -Command mode PowerShell treats the whole argument as a single line,
  // and `#` starts a comment that swallows the REST of the script. Every
  // statement after the first `#` silently never executes — taskkill
  // included. That was the real reason the Pause button didn't kill: the
  // script found the engine but the `# Dedup and kill` comment ate the
  // taskkill loop. Keep this script comment-free.
  //
  // The template literal is a JS backtick string. `$foo` (without braces) is
  // NOT interpolation in JS — only `${foo}` is. So `$kids`, `$toKill`, etc.
  // pass through to PowerShell verbatim, as intended. No escaping needed.
  try {
    require('child_process').spawnSync(
      'powershell',
      ['-Command',
       `function Get-Descendants($procId) { ` +
       `  $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId"; ` +
       `  foreach ($k in $kids) { ,($k.ProcessId); Get-Descendants $k.ProcessId } ` +
       `} ; ` +
       `$toKill = @(); ` +
       `$engines = Get-CimInstance Win32_Process -Filter "name='node.exe'" | ` +
       `  Where-Object { $_.CommandLine -like '*orchestrate-cli.js ${projectId} ${epicId}*' }; ` +
       `foreach ($e in $engines) { ` +
       `  $toKill += $e.ProcessId; ` +
       `  $toKill += Get-Descendants $e.ProcessId ` +
       `} ; ` +
       `$orphans = Get-CimInstance Win32_Process -Filter "name='claude.exe'" | ` +
       `  Where-Object { $_.CommandLine -like '*project_id=${projectId}*' } ; ` +
       `foreach ($o in $orphans) { $toKill += $o.ProcessId } ; ` +
       `$toKill = $toKill | Sort-Object -Unique; ` +
       `foreach ($p in $toKill) { taskkill /F /PID $p 2>$null }`],
      { encoding: 'utf8' }
    );
    // SYNCHRONOUS pause — setTimeout was a no-op here (it schedules but
    // doesn't block). Without this wait the fresh engine spawns while OS
    // is still terminating the old one, leaving both alive in a race.
    try { require('child_process').spawnSync('timeout', ['/T', '1', '/NOBREAK'], { encoding: 'utf8', stdio: 'ignore' }); } catch {}
  } catch (e) {
    console.error(`[engine-control] kill failed for project=${projectId} epic=${epicId}:`, e.message);
  }
}

/**
 * Spawn a fresh orchestrate-cli.js engine for (projectId, epicId) with the
 * given concurrency. Returns the child process (unref'd).
 */
function spawnEngine(projectId, epicId, concurrency) {
  const cliPath = path.join(__dirname, '..', 'dist', 'saga3', 'app', 'cli.js');
  // Read the mandate from the epic's discovery brief or task title.
  const epicRow = withDb(db => db.prepare(
    'SELECT name, description FROM epics WHERE id=?',
  ).get(epicId));
  const mandate = epicRow?.description || epicRow?.name || 'Continue episode';
  const child = spawn('node', [cliPath, mandate], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DB_PATH: process.env.DB_PATH,
      SAGA3_WORKSPACE: resolveProjectWorkspace({ id: projectId, name: withDb(db => db.prepare('SELECT name FROM projects WHERE id=?').get(projectId))?.name || '' }) || process.cwd(),
      SAGA3_PROJECT_ID: String(projectId),
      SAGA3_EPIC_ID: String(epicId),
      SAGA3_MAX_CONCURRENCY: String(concurrency),
    },
  });
  child.unref();
  return child;
}

/**
 * Read the persisted engine-running flag + last-known pid/concurrency for an
 * epic. Returns { running, pid, concurrency, started_at }. `running` is the
 * USER'S LAST INTENT (persisted), not a live process check — the UI uses this
 * to render the correct button on page load.
 *
 * Live liveness is best-effort: we check whether any node.exe's command line
 * mentions this epic. That's expensive, so callers should prefer the
 * persisted flag for render-time decisions.
 */
function readEngineState(epicId) {
  const row = withDb(db => db.prepare(
    `SELECT json_extract(metadata, '$.engine_running')    AS running,
            json_extract(metadata, '$.engine_pid')         AS pid,
            json_extract(metadata, '$.engine_concurrency') AS concurrency,
            json_extract(metadata, '$.engine_started_at') AS started_at,
            json_extract(metadata, '$.engine_last_error') AS engine_last_error,
            json_extract(metadata, '$.controller_version') AS controller_version
       FROM episode_workflows WHERE epic_id=?`,
  ).get(epicId));
  return {
    running: row?.running === 1 || row?.running === true,
    pid: row?.pid ?? null,
    concurrency: row?.concurrency ?? null,
    started_at: row?.started_at ?? null,
    engine_last_error: row?.engine_last_error ?? null,
    controller_version: row?.controller_version ?? null,
  };
}

/**
 * Live-check whether an engine process for (projectId, epicId) is currently
 * running on the OS. Used by /api/engine/status to reconcile the persisted
 * flag with reality (e.g. engine crashed → flag lies).
 */
function isEngineAlive(projectId, epicId) {
  const state = readEngineState(epicId);
  if (state.pid && isProcessAlive(Number(state.pid))) return true;
  try {
    const r = require('child_process').spawnSync(
      'powershell',
      ['-Command',
       `$es = Get-CimInstance Win32_Process -Filter "name='node.exe'" | ` +
       `  Where-Object { $_.CommandLine -like '*orchestrate-cli.js ${projectId} ${epicId}*' }; ` +
       `if ($es) { 'alive' } else { 'dead' }`],
      { encoding: 'utf8' },
    );
    return (r.stdout || '').trim() === 'alive';
  } catch {
    return false;
  }
}

function setEngineMeta(epicId, patch) {
  // Build a json_set chain for each key in patch.
  // json_set accepts (json, path, value, path, value, ...) so we expand.
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  let sql = `UPDATE episode_workflows SET metadata=COALESCE(metadata,'{}'), updated_at=datetime('now')`;
  const params = [];
  // Re-read current metadata, merge, write back — simpler than chained json_set
  // when patch has multiple keys.
  const current = withDb(db => db.prepare(
    'SELECT metadata FROM episode_workflows WHERE epic_id=?',
  ).get(epicId));
  const meta = JSON.parse(current?.metadata || '{}');
  for (const k of keys) meta[k] = patch[k];
  sql = `UPDATE episode_workflows SET metadata=?, updated_at=datetime('now') WHERE epic_id=?`;
  params.push(JSON.stringify(meta), epicId);
  withDbWrite(db => db.prepare(sql).run(...params));
}

// --- POST /api/engine/start ---
// Body: { epic_id, concurrency? }. If concurrency omitted, uses the value
// persisted in $.engine_concurrency (or falls back to 4).
// Always kills any existing engine for this epic first, then spawns fresh.
// Sets $.engine_running=1 so the UI renders ⏸ on next load.
function handleEngineStart(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    try { fields = JSON.parse(raw); } catch { fields = {}; }
    const epicId = Number(fields.epic_id);
    if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
    const epic = withDb(db => db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId));
    if (!epic) return respondJson(res, 404, { ok:false, error:'epic not found' });
    const projectId = epic.project_id;

    const state = readEngineState(epicId);
    let concurrency = Number(fields.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      concurrency = Number(state.concurrency) || 4;
    }
    killEngineTree(projectId, epicId);

    try {
      const child = spawnEngine(projectId, epicId, concurrency);
      setEngineMeta(epicId, {
        engine_running: 1,
        engine_pid: child.pid,
        engine_concurrency: concurrency,
        engine_started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        engine_last_error: null,
        terminal_outcome: null,
      });
      respondJson(res, 200, {
        ok: true, project_id: projectId, epic_id: epicId,
        concurrency, engine_pid: child.pid, running: true,
      });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'spawn: ' + e.message });
    }
  });
}

// --- POST /api/engine/stop ---
// Body: { epic_id }. Kill engine + workers for this epic, NO respawn.
// Sets $.engine_running=0 so the UI renders ▶ on next load.
// Idempotent: stopping an already-stopped engine is a no-op success.
function handleEngineStop(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    try { fields = JSON.parse(raw); } catch { fields = {}; }
    const epicId = Number(fields.epic_id);
    if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
    const epic = withDb(db => db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId));
    if (!epic) return respondJson(res, 404, { ok:false, error:'epic not found' });
    const projectId = epic.project_id;

    killEngineTree(projectId, epicId);
    setEngineMeta(epicId, {
      engine_running: 0,
      engine_stopped_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    respondJson(res, 200, { ok: true, project_id: projectId, epic_id: epicId, running: false });
  });
}

// --- POST /api/engine/concurrency ---
// Body: { epic_id, concurrency }. Pure metadata write — NO kill, NO spawn.
// The engine's pump loop re-reads $.engine_concurrency every RATE_LIMIT_SCAN_TICKS
// cycle and uses it as the new target (capped by $.active_model_limit if set).
// Active workers finish their cycle naturally; the engine converges to the
// new target as the active count drops. Same semantics as /api/model/set.
//
// This is the per-epic engine control fix: changing concurrency must NOT
// auto-restart the engine. Restart burns tokens (kills active workers + spawns
// a fresh cohort). A pure metadata write + pump-loop convergence respects
// the rate-limit-aware scheduler the engine already implements.
function handleEngineConcurrency(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    try { fields = JSON.parse(raw); } catch { fields = {}; }
    const epicId = Number(fields.epic_id);
    const concurrency = Number(fields.concurrency);
    if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      return respondJson(res, 400, { ok:false, error:'concurrency must be 1..32' });
    }
    try {
      setEngineMeta(epicId, {
        engine_concurrency: concurrency,
        engine_concurrency_changed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      respondJson(res, 200, { ok: true, epic_id: epicId, concurrency });
    } catch (e) {
      respondJson(res, 500, { ok:false, error: 'metadata write failed: ' + e.message });
    }
  });
}

// --- GET /api/engine/status?epic_id=N ---
// Returns { running, pid, concurrency, started_at, alive }.
// `running` = persisted user intent. `alive` = live OS process check
// (reconciles a lying flag if the engine crashed without us knowing).
function handleEngineStatus(req, res, url) {
  const epicId = Number(url.searchParams.get('epic_id'));
  if (!epicId) return respondJson(res, 400, { ok:false, error:'epic_id required' });
  const epic = withDb(db => db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId));
  if (!epic) return respondJson(res, 404, { ok:false, error:'epic not found' });
  const state = readEngineState(epicId);
  const alive = isEngineAlive(epic.project_id, epicId);
  // If persisted flag says running but process is dead, reconcile the flag.
  if (state.running && !alive) {
    setEngineMeta(epicId, { engine_running: 0 });
    state.running = false;
  }
  respondJson(res, 200, { ok: true, epic_id: epicId, ...state, alive });
}

// --- POST /api/engine/restart (back-compat alias for /api/engine/start) ---
// Kept so the concurrency selector's change-handler continues to work; new
// UI calls /api/engine/start directly. Behaviour is identical to start.
function handleEngineRestart(req, res) {
  handleEngineStart(req, res);
}

// --- Known models catalog with concurrency limits ---
// Source of truth: Z.ai GLM Coding Plan FAQ (docs.z.ai/devpack/faq):
//   "All plans support GLM-5.2, GLM-5-Turbo and GLM-4.7."
// Other models (glm-4-plus / glm-4.5* / glm-4.7-flash*) are NOT exposed on
// the Coding Plan endpoint — selecting them produces api_retry "unknown"
// errors from z.ai. Limit values reflect z.ai's documented rate multipliers:
// GLM-5.2 counts x3 in peak hours, x2 off-peak; the others are x1.
// The limit here is the per-epic concurrency ceiling saga uses; it is NOT
// the prompt quota (that's tracked by z.ai on their side, 80/400/1600 per 5h).
// Z.ai cloud models (subscription). Source: Z.ai GLM Coding Plan FAQ
// (docs.z.ai/devpack/faq): all plans support GLM-5.2, GLM-5-Turbo, GLM-4.7.
// Other GLM variants are NOT exposed on the Coding Plan endpoint. Limit values
// reflect z.ai's documented rate multipliers: GLM-5.2 counts x3 in peak hours,
// x2 off-peak; the others are x1. The limit is the per-epic concurrency
// ceiling saga uses; NOT the prompt quota (tracked by z.ai, 80/400/1600 per 5h).
const ZAI_MODELS = [
  { id: 'glm-5.2',         limit: 3,  tier: 'flagship', provider: 'zai', note: 'Opus-level, x3 peak rate' },
  { id: 'glm-5-turbo',     limit: 5,  tier: 'flagship', provider: 'zai', note: 'Opus-level, x1 rate' },
  { id: 'glm-4.7',         limit: 10, tier: 'sonnet',   provider: 'zai', note: 'Sonnet-level, x1 rate — recommended default' },
];

// LM Studio local models (no subscription, runs on this machine). Populated
// lazily from GET <LMSTUDIO_URL>/models (Anthropic+OpenAI-compatible server
// built into LM Studio on port 1234). Empty until first probe — the UI shows
// "LM Studio (офлайн)" while LMSTUDIO_ONLINE is false.
// NOTE: this URL keeps the /v1 suffix for the /models PROBE (LM Studio's
// OpenAI-compatible list endpoint). The settings.json ANTHROPIC_BASE_URL we
// write for claude v2 is derived by stripping /v1 (see handleModelSet) —
// claude v2 appends /v1 itself, so keeping it here would yield /v1/v1.
const LMSTUDIO_URL = (process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');
// Snapshot of the user's original cloud settings.json — captured BEFORE the
// first LM Studio activation, restored when switching back to zai. Path next
// to settings.json so it travels with the user profile.
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
// Two-state switching (no in-place patching of settings.json, no one-shot
// backups): keep TWO permanent canonical templates alongside settings.json
// and switch = copy a template onto settings.json atomically. The templates
// are write-once: cloud is captured the first time we see a real cloud
// settings.json, lmstudio is a generated constant. Neither is ever rewritten
// by saga afterwards, so the cloud AUTH_TOKEN (the secret) cannot be lost to
// a botched toggle. This replaces the old in-place patch + lazy-backup model
// which silently corrupted tokens when settings.json was already on localhost
// at snapshot time.
const CLAUDE_SETTINGS_CLOUD_TPL    = path.join(os.homedir(), '.claude', 'settings.cloud.json');
const CLAUDE_SETTINGS_LMSTUDIO_TPL = path.join(os.homedir(), '.claude', 'settings.lmstudio.json');
// Z.ai cloud endpoint (subscription). Used as a fallback when no cloud
// template exists yet (saga started on LM Studio config or the user never
// had a cloud session). The endpoint is a Z.ai-wide constant; only the
// AUTH_TOKEN is user-specific.
const ZAI_DEFAULT_BASE_URL = process.env.SAGA_ZAI_BASE_URL || 'https://api.z.ai/api/anthropic';
// Local models have no cloud rate limit, so allow a generous concurrency.
const LMSTUDIO_DEFAULT_LIMIT = 4;
let LMSTUDIO_MODELS = [];     // [{ id, limit, tier:'local', provider:'lmstudio' }]
let LMSTUDIO_ONLINE = false;

/**
 * Probe LM Studio's /v1/models endpoint. Updates LMSTUDIO_MODELS + LMSTUDIO_ONLINE.
 * Returns the fresh state. Idempotent; safe to call on every GET /api/lmstudio/models.
 * 3s timeout — LM Studio is local; longer means it's not running.
 */
async function probeLmstudioModels() {
  const url = LMSTUDIO_URL + '/models';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { LMSTUDIO_ONLINE = false; LMSTUDIO_MODELS = []; return { online: false, error: `HTTP ${r.status}` }; }
    const body = await r.json();
    // OpenAI shape: { data: [{ id }] }. Tolerate { models: [{ id }] } too.
    const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : []);
    const ids = list.map(m => m?.id).filter(id => typeof id === 'string' && id.length);
    LMSTUDIO_MODELS = ids.map(id => ({ id, limit: LMSTUDIO_DEFAULT_LIMIT, tier: 'local', provider: 'lmstudio' }));
    LMSTUDIO_ONLINE = true;
    return { online: true, models: LMSTUDIO_MODELS };
  } catch (e) {
    LMSTUDIO_ONLINE = false;
    LMSTUDIO_MODELS = [];
    return { online: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)) };
  }
}

// All selectable models (cloud + local). Used by handleModelsList, handleModelSet, UI.
function allModels() { return [...ZAI_MODELS, ...LMSTUDIO_MODELS]; }

// --- GET /api/lmstudio/models ---
// Probe LM Studio and return its live model list. The UI calls this on page
// load (to populate the LM Studio optgroup) and on "↻ обновить" click.
async function handleLmstudioModelsList(req, res) {
  const result = await probeLmstudioModels();
  respondJson(res, 200, { ok: true, lmstudio_url: LMSTUDIO_URL, ...result });
}

// --- GET /api/models ---
function handleModelsList(req, res) {
  // current: the most recently chosen model across all episodes, read live from
  // saga.db. Falls back to the process-wide WORKER_MODEL (resolved from
  // ~/.claude/settings.json at startup) when no episode has a chosen model.
  // Without this live read the selector would show a stale start-of-process
  // value after the user switches models, since WORKER_MODEL is a const.
  let current = WORKER_MODEL;
  try {
    const row = withDb(db => db.prepare(
      `SELECT json_extract(metadata, '$.active_model') AS m
       FROM episode_workflows
       WHERE json_extract(metadata, '$.active_model') IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    ).get());
    if (typeof row?.m === 'string' && row.m.length > 0) current = row.m;
  } catch { /* DB busy / no row → keep fallback */ }
  respondJson(res, 200, {
    ok: true,
    current,
    models: allModels(),
    lmstudio_online: LMSTUDIO_ONLINE,
    lmstudio_url: LMSTUDIO_URL,
  });
}

/**
 * Atomically write ~/.claude/settings.json and WAIT until the bytes are
 * durably on disk and re-readable. Returns true on success, throws on failure.
 *
 * Why this exists: the spawned claude CLI reads settings.json immediately on
 * startup, and on Windows the default fs.writeFile can return before the OS
 * has flushed the file — the next process then reads a half-written or stale
 * version and fails with 401 / unknown-model errors. The sequence below is
 * the canonical "write → fsync → readback verify" pattern:
 *
 *   1. open(path, 'w')            — truncate, get fd
 *   2. fd.write(json)             — stage bytes
 *   3. fd.sync (fsync)            — force kernel → disk
 *   4. fd.close
 *   5. read back, JSON.parse, assert the auth-relevant key matches what we
 *      wrote. If not → throw (caller surfaces 500).
 *
 * The verify step is the contract: by the time this returns, ANY process that
 * opens settings.json will see exactly what we wrote.
 */
function atomicSettingsWrite(payload) {
  const fs = require('node:fs');
  const json = JSON.stringify(payload, null, 2);
  // Step 1-4: write + fsync + close. Synchronous file ops are fine here — the
  // file is small (~2 KB) and the worker pump only fires one model/set at a
  // time. The whole point is to block until durable.
  const fd = fs.openSync(CLAUDE_SETTINGS_PATH, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);  // kernel → disk
  } finally {
    fs.closeSync(fd);
  }
  // Step 5: readback verify — the auth-relevant env values must round-trip
  // exactly. This catches torn writes and partial flushes.
  const readBack = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  const rb = readBack?.env || {};
  const pv = payload?.env || {};
  const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
                'CLAUDE_CODE_ATTRIBUTION_HEADER', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
  for (const k of keys) {
    const a = rb[k], b = pv[k];
    // Treat present-but-undefined and absent as equal (both → undefined).
    if ((a ?? undefined) !== (b ?? undefined)) {
      throw new Error(`settings.json verify failed for ${k}: wrote ${JSON.stringify(b)}, read ${JSON.stringify(a)}`);
    }
  }
  return true;
}

/**
 * Get the canonical cloud template (settings.cloud.json). Creates it on first
 * call from the LIVE settings.json — but ONLY if that live settings.json is
 * actually a cloud config (BASE_URL not pointing at localhost). This is the
 * single moment in saga's lifetime when the user's real cloud AUTH_TOKEN is
 * captured into a permanent template; thereafter the template is never
 * overwritten, so the token cannot be lost to a later bad toggle.
 *
 * If the live settings.json is already on localhost and no cloud template
 * exists, returns null — caller decides what to do (typically: refuse to
 * switch to cloud until the user provides a token, or fall back to
 * ZAI_DEFAULT_BASE_URL with no token).
 */
function getOrCreateCloudTemplate() {
  const fs = require('node:fs');
  if (fs.existsSync(CLAUDE_SETTINGS_CLOUD_TPL)) {
    try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_CLOUD_TPL, 'utf8')); }
    catch { /* corrupt template — fall through and try to recreate */ }
  }
  // Capture from live settings.json — but only if it's a cloud config.
  const live = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
  const base = (live?.env?.ANTHROPIC_BASE_URL || '').toLowerCase();
  const isLocal = base.startsWith('http://127.') || base.startsWith('http://localhost') || base.startsWith('http://[');
  if (isLocal) return null;  // can't capture a cloud template from a localhost config
  // Persist the template ONCE. Future calls short-circuit at the top.
  fs.writeFileSync(CLAUDE_SETTINGS_CLOUD_TPL, JSON.stringify(live, null, 2), 'utf8');
  return live;
}

/**
 * Get the canonical LM Studio template (settings.lmstudio.json). Persistent
 * file — written ONCE from the frontend selector, then never overwritten by
 * saga. No model defaults: model env vars are added by handleModelSet from
 * the frontend-supplied modelId. If settings.lmstudio.json does not exist,
 * returns a minimal skeleton with ONLY the LM Studio endpoint + auth token
 * and NO model slots (a caller that needs a model MUST set it explicitly).
 *
 * We deliberately DO NOT inherit the live settings.json env here — that was
 * the old bug: stale models from a previous run leaked into the LM Studio
 * template and overrode the frontend selector.
 */
function getOrCreateLmstudioTemplate() {
  const fs = require('node:fs');
  let tpl = null;
  try { tpl = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_LMSTUDIO_TPL, 'utf8')); } catch { /* not yet */ }
  if (tpl) {
    // Always refresh the endpoint (SAGA_LMSTUDIO_URL may have changed), but
    // leave model slots alone — they are owned by the frontend selector.
    tpl.env = tpl.env || {};
    tpl.env.ANTHROPIC_BASE_URL = LMSTUDIO_URL.replace(/\/v\d+\/?$/, '').replace(/\/+$/, '');
    tpl.env.ANTHROPIC_AUTH_TOKEN = 'lm-studio';
    tpl.env.ANTHROPIC_API_KEY = 'lm-studio';
    tpl.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    return tpl;
  }
  // First-time skeleton: endpoint + auth only. NO ANTHROPIC_DEFAULT_*_MODEL —
  // those are set strictly from the frontend selector in handleModelSet.
  // Without a model, claude will error out, which is the intended "no default"
  // behaviour if someone switches provider to lmstudio without picking a model.
  return {
    env: {
      ANTHROPIC_BASE_URL: LMSTUDIO_URL.replace(/\/v\d+\/?$/, '').replace(/\/+$/, ''),
      ANTHROPIC_AUTH_TOKEN: 'lm-studio',
      ANTHROPIC_API_KEY: 'lm-studio',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    permissions: { allow: ['*'] },
  };
}

// --- POST /api/model/set ---
// Patch ~/.claude/settings.json so NEW workers (spawned after this call) read
// the new model. Active workers keep the old model — they've already started
// `claude -p` and won't re-read settings.json. NO engine kill, NO spawn, NO
// restart. We only persist the model info into episode_workflows.metadata; the
// engine's pump loop reads `active_model_limit` and uses min(concurrency, limit)
// as the effective ceiling, so concurrency naturally converges to the new
// model's limit as old workers finish and new ones spawn.
function handleModelSet(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let fields;
    try { fields = JSON.parse(raw); } catch { fields = {}; }
    const modelId = (fields.model || '').toString().trim();
    const epicId = Number(fields.epic_id);
    if (!modelId) return respondJson(res, 400, { ok:false, error:'model required' });
    const model = allModels().find(m => m.id === modelId);
    if (!model) return respondJson(res, 400, { ok:false, error:'unknown model: ' + modelId });
    const provider = model.provider || 'zai';

    // 1. Switch ~/.claude/settings.json between the two canonical templates so
    //    NEW workers (spawned after this call) read the new model/provider.
    //    Active workers keep the old config.
    //
    //    Two-state model: settings.cloud.json and settings.lmstudio.json are
    //    PERMANENT templates, written once and never overwritten by saga. A
    //    switch = atomicSettingsWrite(template → settings.json) with fsync +
    //    readback verify. This replaces the old in-place-patch + lazy-backup
    //    design, which silently corrupted the cloud AUTH_TOKEN when
    //    settings.json was already on localhost at snapshot time. The cloud
    //    template captures the user's real token the first time we see a real
    //    cloud settings.json and then freezes it forever.
    //
    //    NOTE on claude CLI v2.x (regression, anthropics/claude-code#8500):
    //    spawn-env ANTHROPIC_BASE_URL no longer overrides settings.json, and
    //    claude v2 appends '/v1' itself — so the LM Studio base URL must be
    //    WITHOUT /v1. This makes the main interactive ZCode agent follow the
    //    same provider as the episode while it runs — known side effect, no
    //    isolation possible in v2.
    try {
      let payload;
      if (provider === 'lmstudio') {
        // Before we destroy the live cloud config, freeze it into the cloud
        // template (no-op if already frozen). This is the ONLY capture point.
        getOrCreateCloudTemplate();
        payload = getOrCreateLmstudioTemplate();
      } else {
        // zai: switch back to the canonical cloud template. If it exists,
        // apply the chosen cloud model alias on top. If it doesn't (saga
        // started on a localhost settings.json and no cloud session ever ran),
        // fall back to ZAI_DEFAULT_BASE_URL with no token — workers will 401
        // and the user has to populate the cloud template manually.
        const cloudTpl = getOrCreateCloudTemplate();
        if (cloudTpl) {
          payload = cloudTpl;
          delete payload.env.ANTHROPIC_API_KEY;
          delete payload.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
        } else {
          // No cloud template and live settings.json is on localhost — desync.
          // Build a minimal cloud config so the user isn't stranded; the AUTH
          // token will be missing and must be set in settings.cloud.json.
          const fs = require('node:fs');
          payload = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
          payload.env = payload.env || {};
          payload.env.ANTHROPIC_BASE_URL = ZAI_DEFAULT_BASE_URL;
          if (payload.env.ANTHROPIC_AUTH_TOKEN === 'lm-studio') delete payload.env.ANTHROPIC_AUTH_TOKEN;
          delete payload.env.ANTHROPIC_API_KEY;
          delete payload.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
        }
      }
      // HARD RULE: the model from the selector is authoritative. No defaults,
      // no inheritance, no "leave whatever was there". All four claude model
      // slots get EXACTLY modelId. If modelId is somehow empty we already 400'd
      // above, so here it is guaranteed non-empty.
      payload.env = payload.env || {};
      payload.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
      payload.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
      payload.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
      payload.env.CLAUDE_CODE_SUBAGENT_MODEL = modelId;
      // Persist the LM Studio template so the chosen model survives a tracker-
      // view restart. cloud template is already frozen separately and must not
      // be touched here.
      if (provider === 'lmstudio') {
        try {
          const fs = require('node:fs');
          fs.writeFileSync(CLAUDE_SETTINGS_LMSTUDIO_TPL, JSON.stringify(payload, null, 2), 'utf8');
        } catch (e) {
          console.error('[model/set] lmstudio template persist failed:', e.message);
        }
      }
      // Block until durable + verified. Throws on torn write → 500 to caller.
      atomicSettingsWrite(payload);
    } catch (e) {
      return respondJson(res, 500, { ok:false, error:'settings.json switch failed: ' + e.message });
    }

    // 2. Persist model info into episode_workflows.metadata. The engine's pump
    //    loop reads $.active_model_limit on every cycle and uses
    //    min(opts.concurrency, active_model_limit) as the effective ceiling —
    //    active workers keep running on the old model, but no NEW workers spawn
    //    until the active count drops below the new limit.
    //    $.active_provider tells claude-runner whether to add LM Studio env to
    //    the spawn ('lmstudio') or keep the z.ai legacy path ('zai').
    if (epicId) {
      try {
        withDbWrite(db => db.prepare(
          `UPDATE episode_workflows
             SET metadata=json_set(COALESCE(metadata,'{}'),
                   '$.active_model', ?,
                   '$.active_model_limit', ?,
                   '$.active_provider', ?,
                   '$.model_changed_at', datetime('now')),
                 updated_at=datetime('now')
             WHERE epic_id=?`
        ).run(modelId, model.limit, provider, epicId));
      } catch (e) {
        return respondJson(res, 500, { ok:false, error:'metadata write failed: ' + e.message });
      }
    }

    const note = provider === 'lmstudio'
      ? `LM Studio (${LMSTUDIO_URL}). settings.json switched to the LM Studio template (atomic + fsync). Cloud config frozen in settings.cloud.json. The whole machine routes to LM Studio until you switch back to a cloud model.`
      : 'settings.json switched to the cloud template (atomic + fsync). New workers will use this model. Active workers keep the old one.';
    respondJson(res, 200, { ok: true, model: modelId, provider, limit: model.limit, note });
  });
}


// --- роутинг ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // POST-маршруты (запись): /api/artifact/save, /api/project/create, /api/epic/create
  if (req.method === 'POST' && url.pathname === '/api/artifact/save') {
    return handleArtifactSave(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/project/create') {
    return handleProjectCreate(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/project/archive') {
    return handleProjectArchive(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/project/delete') {
    return handleProjectDelete(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/epic/create') {
    return handleEpicCreate(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/project/create-from-idea') {
    return handleProjectCreateFromIdea(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/episode/resume') {
    return handleEpisodeResume(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/board-run/start') {
    return handleBoardRunStart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/board-run/stop') {
    return handleBoardRunStop(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/repository/register') {
    return handleSagaOperation(req, res, 'repository_register');
  }
  if (req.method === 'POST' && url.pathname === '/api/repository/bootstrap') {
    return handleSagaOperation(req, res, 'repository_bootstrap');
  }
  if (req.method === 'POST' && url.pathname === '/api/episode/transition') {
    return handleSagaOperation(req, res, 'episode_transition');
  }
  if (req.method === 'GET' && url.pathname === '/api/board-run/status') {
    const projectId = Number(url.searchParams.get('project_id'));
    return respondJson(res, 200, { ok:true, run:boardRunner.status(projectId) });
  }
  if (req.method === 'GET' && url.pathname === '/api/episode/pipeline') {
    return handleEpisodePipeline(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/episode/stage-summary') {
    return handleStageSummary(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/worker/tail') {
    return handleWorkerTail(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/workers/active') {
    return handleWorkersActive(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/engine/restart') {
    return handleEngineRestart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/engine/start') {
    return handleEngineStart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/engine/stop') {
    return handleEngineStop(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/engine/status') {
    return handleEngineStatus(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/engine/concurrency') {
    return handleEngineConcurrency(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/models') {
    return handleModelsList(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/lmstudio/models') {
    return handleLmstudioModelsList(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/model/set') {
    return handleModelSet(req, res);
  }

  if (url.pathname === '/api/heartbeat') {
    let last = null;
    try {
      last = withDb(db => db.prepare('SELECT MAX(created_at) as last FROM activity_log').get()?.last || null);
    } catch { /* БД занята/нет таблицы — вернём null */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ last }));
  }

  const projects = listProjects();

  // /artifact/<id>/edit — wiki-редактор
  const editMatch = url.pathname.match(/^\/artifact\/(\d+)\/edit$/);
  if (editMatch) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderArtifactEdit(editMatch[1], projects, null));
  }

  // ?artifact=<id> — wiki-просмотр
  const artifactId = url.searchParams.get('artifact');
  if (artifactId) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderArtifactView(artifactId, projects));
  }

  // /stage?epic=N&stage=X — stage detail page (separate page, not overlay)
  const stageEpic = url.searchParams.get('epic');
  const stageName = url.searchParams.get('stage');
  if (stageEpic && stageName) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderStageDetailPage(stageEpic, stageName, projects));
  }

  // ?task=<id> — карточка задачи (Jira-style detail view)
  const taskId = url.searchParams.get('task');
  if (taskId) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderTaskView(taskId, projects));
  }

  // ?registry=<TYPE> — кросс-проектный реестр
  const registryType = url.searchParams.get('registry');
  if (registryType) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderRegistry(registryType, projects));
  }

  // /admin — страница администрирования (создание проекта/эпика из GUI)
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderAdmin(projects, null));
  }

  const projectId = url.searchParams.get('project');
  const tab = url.searchParams.get('tab');
  const partial = url.searchParams.get('partial');
  let html;
  if (projectId && tab === 'artifacts') {
    html = renderArtifacts(projectId, projects);
  } else if (projectId && tab === 'coverage') {
    html = renderCoverage(projectId, projects);
  } else if (projectId && tab === 'acceptance') {
    html = renderAcceptance(projectId, projects);
  } else if (projectId) {
    html = renderBoard(projectId, projects);
  } else {
    // Read flash message from query (set by archive/delete redirects).
    let flash = null;
    const archived = url.searchParams.get('archived');
    const deleted = url.searchParams.get('deleted');
    if (deleted) flash = { kind: 'warn', text: `Проект «${deleted}» удалён навсегда.` };
    else if (archived) flash = { kind: 'ok', text: `Проект «${archived}» архивирован (status='archived').` };
    html = renderIndex(projects, flash);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // partial=1: episode-progress-bar + .board (AJAX-рефреш).
  // episode-progress-bar включён чтобы кнопка Resume / needs-human badge /
  // gate-blocked badge обновлялись без F5. frontend (refreshBoard) находит
  // оба элемента в ответе и replaceWith'ит их по отдельности.
  if (partial === '1' && projectId) {
    const bar = extractDiv(html, 'episode-progress-bar');
    const board = extractDiv(html, 'board');
    res.end((bar || '') + (board || '') || html);
  // partial=2: только .episodes (AJAX-рефреш дерева артефактов).
  } else if (partial === '2' && projectId && tab === 'artifacts') {
    const frag = extractDiv(html, 'episodes');
    res.end(frag || html);
  } else {
    res.end(html);
  }
});

// Pre-check: занят ли уже порт? Если да и мы spawn'уты saga-MCP (TRACKER_SPAWNED=1) —
// значит другой tracker-view уже бежит и браузер открыт. Тихо выходим, не открываем
// второе окно и не трогаем рабочий процесс. Это чинит «3 окна ZCode = 3 браузера».
// Ручной запуск (npm run tracker, без маркера) доходит до EADDRINUSE-блока ниже —
// там старое поведение (убить stale PID, перезапуститься, открыть браузер).
function isPortTaken(port) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));   // порт занят
    tester.once('listening', () => { tester.close(() => resolve(false)); }); // свободен
    tester.listen(port);
  });
}

const SPAWNED = process.env.TRACKER_SPAWNED === '1';

(async () => {
  if (SPAWNED) {
    const taken = await isPortTaken(PORT);
    if (taken) {
      console.log(`tracker-view: port ${PORT} already in use — another instance is running. Exiting quietly (no browser, no kill).`);
      process.exit(0);
    }
  }

  server.listen(PORT, () => {
    try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
    const u = `http://localhost:${PORT}`;
    console.log(`saga tracker → ${u}  (DB: ${DB_PATH})`);
    console.log(`PID: ${process.pid}`);
    // Background probe of LM Studio so the model selector's "LM Studio" group
    // is populated on first page load (and stays fresh). Fire-and-forget: a
    // down/unreachable LM Studio is normal (server just shows "офлайн").
    probeLmstudioModels().then(r => {
      console.log(`LM Studio (${LMSTUDIO_URL}): ${r.online ? `${LMSTUDIO_MODELS.length} models` : 'offline'}`);
    }).catch(() => {});
    setInterval(() => { probeLmstudioModels().catch(() => {}); }, 30000);
    // Открываем браузер ТОЛЬКО если мы реально забиндились (порт был свободен).
    // В spawn-режиме pre-check выше гарантировал, что мы первые; в ручном режиме
    // EADDRINUSE-блок убил stale процесс, и этот listen — свежий, открываем.
    if (process.env.TRACKER_NO_BROWSER !== '1') {
      const open = process.platform === 'win32' ? `start ${u}` : process.platform === 'darwin' ? `open ${u}` : `xdg-open ${u}`;
      try { require('node:child_process').exec(open); } catch {}
    }
  });

  // EADDRINUSE: только ручной запуск (без TRACKER_SPAWNED). Убиваем stale PID и
  // перезапускаем listen. saga-MCP spawn'ы сюда не доходят — они выходят в pre-check.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && existsSync(PID_FILE)) {
      try {
        const oldPid = readFileSync(PID_FILE, 'utf8').trim();
        if (oldPid && oldPid !== String(process.pid)) {
          const { execSync } = require('node:child_process');
          try { execSync(`taskkill /PID ${oldPid} /F`, { stdio: 'ignore' }); console.log(`Убит старый tracker-view PID ${oldPid}`); } catch {}
        }
        unlinkSync(PID_FILE);
      } catch {}
      setTimeout(() => server.listen(PORT), 500);
    } else {
      console.error('tracker-view error:', err.message);
      process.exit(1);
    }
  });
})();

process.on('exit',  () => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on('SIGTERM',() => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
