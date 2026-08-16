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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { handlers as repositoryHandlers } from '../dist/tools/repositories.js';
import {
  artifactFallbackDocument,
  orderedArtifactTypes,
} from './artifact-presentation.mjs';
import { isProcessAlive } from '../dist/worker-executions.js';
import { getDb as ensureSagaDb, closeDb as closeSagaDb } from '../dist/db.js';
import {
  initShared,
  withDb, withDbWrite,
  ageClass, ageText,
  esc, extractDiv, inTableHasHeader, truncate,
  respondJson, readJsonRequest,
  DEV_ROOT, PROJECT_REPO_MAP,
  resolveArtifactFile,
} from './shared.mjs';
import { createModelManagementApi } from './model-management.mjs';
import { createAdminEndpointsApi } from './admin-endpoints.mjs';
import { createEngineSupervisor } from './engine-supervisor.mjs';
import { createLifecycleEndpointsApi } from './lifecycle-endpoints.mjs';
import { createArtifactRenderApi } from './artifact-render.mjs';
import { createBoardRenderApi } from './board-render.mjs';
import { createSagaControlApplication } from '../dist/app/composition-root.js';
import { loadSagaRuntimeConfig } from '../dist/runtime/saga-runtime-config.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// better-sqlite3 уже стоит в node_modules форка (npm install). Берём оттуда.
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

// ОДИН источник конфигурации для tracker/runtime adapters.
const runtimeConfig = loadSagaRuntimeConfig(process.env);
const DB_PATH = runtimeConfig.dbPath;
const DEFAULT_WORKER_LOG_ROOT = path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
const WORKER_LOG_ROOTS = [...new Set(
  [runtimeConfig.orchestrationLogRoot, DEFAULT_WORKER_LOG_ROOT]
    .filter(Boolean)
    .map(root => path.resolve(root)),
)];

// Inject DB_PATH + Database + log roots into the shared helpers so the
// extracted withDb/withDbWrite/canonicalAllowedWorkerLogPath can reference them
// without tracker-view.mjs having to re-declare their logic.
initShared({ dbPath: DB_PATH, Database, workerLogRoots: WORKER_LOG_ROOTS });

// Файл saga.db создаётся лениво MCP-сервером при первом вызове инструмента.
// Если tracker-view запускается первым, инициализируем ту же schema/migrations.
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

const PORT = runtimeConfig.trackerPort;
const PID_FILE = path.join(__dirname, '.tracker-view.pid');
const RELOAD_SEC = runtimeConfig.trackerReloadSec;
const sagaApplication = createSagaControlApplication(process.env);

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

// Все saga-проекты и канбан читаются через стабильную application projection.
function listProjects() {
  return sagaApplication.listProjects();
}

function getProject(id) {
  return withDb(db => db.prepare('SELECT * FROM projects WHERE id=?').get(id));
}

function loadBoard(projectId) {
  return sagaApplication.loadProjectBoard(Number(projectId));
}

// --- Lifecycle Pipeline (Saga 3 process-modules) ---------------------------
// Generic, data-driven pipeline adapter. All business logic lives in the
// application layer (dist/process-modules/application/lifecycle-pipeline-query.js);
// this wiring is the only seam that touches the monolith. The concrete Sqlite
// repo is constructed at this boundary (dependency inversion: the query service
// accepts the repository INTERFACE, never this concrete class).
import { createLifecyclePipelineApi } from './lifecycle-pipeline/pipeline-api.mjs';
import { SqliteLifecycleRunRepository } from '../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
const lifecyclePipelineApi = createLifecyclePipelineApi({
  repo: new SqliteLifecycleRunRepository(),
  resolveProjectId: (epicId) => withDb(db => {
    const row = db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId);
    return row ? row.project_id : null;
  }),
});

// esc / DEV_ROOT / PROJECT_REPO_MAP / projectFolderTag / resolveProjectWorkspace
// live in ./shared.mjs now (imported above).
// resolveArtifactFile also lives in ./shared.mjs now (imported above).

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

// Board rendering API (T10 step 7): renderIndex / renderBoard / renderTaskView /
// page / renderRegistry / renderCoverage / renderAcceptance / renderStageDetailPage
// + the engineControlStateForEpic / resolveWorkerModel / loadCoverageMatrix /
// loadAcceptanceRegistry / computeAcceptance / renderStageDescriptionBlock helpers
// + STAGE_DESCRIPTIONS and WORKER_MODEL — all extracted into
// tracker-view/board-render.mjs. Constructed FIRST so it can vend page() to
// the artifact API (T10 step 6) and WORKER_MODEL to the model API (T10 step 3)
// without forward references.
const boardApi = createBoardRenderApi({
  RELOAD_SEC,
  loadBoard,
  theme: { COLS, PROJECT_COLORS, PRIO, TYPE_COLORS, TYPE_LABEL, STATUS_LABEL, STATUS_COLOR, LINK_COLORS, LINK_GLYPH },
  runtimeConfig,
});
// renderBoard reads modelApi.ZAI_MODELS / LMSTUDIO_MODELS / LMSTUDIO_ONLINE at
// request time (inside the IIFE that builds the model optgroup), not at
// construction time, so the late binding below is safe.

// Model management API (T10 step 3): /api/models + /api/lmstudio/models +
// /api/model/set, plus the ~/.claude/settings.json two-state template switching
// (cloud ↔ LM Studio). Injected with the same runtimeConfig, the shared DB
// helpers + respondJson/readJsonRequest, and the process-wide workerModel
// fallback (now owned by boardApi) so handleModelsList can mirror the
// pre-extraction behaviour.
const modelApi = createModelManagementApi({
  runtimeConfig,
  withDb,
  withDbWrite,
  respondJson,
  readJsonRequest,
  workerModel: boardApi.WORKER_MODEL,
});
boardApi.setModelApi(modelApi);

// Engine supervisor (antifreeze layer C): periodic stale-heartbeat watchdog
// + single-engine sweep at every spawn gate. Constructed BEFORE adminApi (the
// factory-start gateway calls sweepBeforeSpawn before each engine spawn) and
// started immediately — SAGA_ENGINE_SUPERVISOR=0 disables it entirely.
const engineSupervisor = createEngineSupervisor({
  withDb,
  withDbWrite,
  sagaApplication,
});
engineSupervisor.start();

// Admin endpoints API (T10 step 4): /admin HTML page + /api/project/create,
// /api/project/archive, /api/project/delete, /api/admin/purge-all-projects,
// /api/epic/create, and the sole /api/factory/start gateway. Injected with the same
// runtimeConfig + DB_PATH, and the page(title, body) HTML wrapper (now owned
// by boardApi) so renderAdmin can emit the full HTML document.
// Route strings stay here as test anchors; the handlers live in the factory.
const adminApi = createAdminEndpointsApi({
  runtimeConfig,
  dbPath: DB_PATH,
  page: boardApi.page,
  sagaApplication,
  engineSupervisor,
});

// Operational control and observability endpoints.
const lifecycleApi = createLifecycleEndpointsApi({
  sagaApplication,
  repositoryHandlers,
  workerLogRoots: WORKER_LOG_ROOTS,
  isProcessAlive,
});

// T10 step 6: artifact rendering (renderMarkdown / renderArtifacts /
// renderArtifactView / renderArtifactEdit / handleArtifactSave) was extracted
// into tracker-view/artifact-render.mjs. Injected: the page wrapper (now owned
// by boardApi), the loadArtifactsTree DB loader (still owned here), RELOAD_SEC
// for the tree auto-refresh interval, and the theme (type/status/link
// colour+label maps).
const artifactApi = createArtifactRenderApi({
  page: boardApi.page,
  RELOAD_SEC,
  loadArtifactsTree,
  theme: { TYPE_COLORS, TYPE_LABEL, STATUS_LABEL, STATUS_COLOR, LINK_COLORS, LINK_GLYPH },
});
// Two-phase init (T10 step 7): board-render's renderTaskView calls
// renderMarkdown (owned by artifact-render) at request time. Wire it now that
// artifactApi exists. Before this call renderTaskView would render empty
// markdown blocks; no request can arrive before the server listens below.
boardApi.setRenderMarkdown(artifactApi.renderMarkdown);

// respondJson / readRequestFields are imported from ./shared.mjs.

// handleBoardRunStart / handleBoardRunStop / handleSagaOperation live in
// ./lifecycle-endpoints.mjs now (exposed via lifecycleApi above).

// Lifecycle endpoints (T10 step 5): handleStageSummary / findSummaryTask /
// readSummaryMarkdown / createSummaryTask / STAGE_SUMMARY_CODE / handleWorkerTail /
// handleWorkersActive / respondEngineError / handleEngineStart / handleEngineStop /
// handleEngineConcurrency / handleEngineStatus / handleEngineRestart all live in
// ./lifecycle-endpoints.mjs now (exposed via lifecycleApi above).


// --- роутинг ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Factory creation/resume has exactly one public write gateway below.
  if (req.method === 'POST' && url.pathname === '/api/project/archive') {
    return adminApi.handleProjectArchive(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/project/delete') {
    return adminApi.handleProjectDelete(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/purge-all-projects') {
    return adminApi.handleAdminPurgeAllProjects(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/factory/start') {
    return adminApi.handleFactoryStart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/repository/register') {
    return lifecycleApi.handleSagaOperation(req, res, 'repository_register');
  }
  if (req.method === 'POST' && url.pathname === '/api/repository/bootstrap') {
    return lifecycleApi.handleSagaOperation(req, res, 'repository_bootstrap');
  }
  // Saga 3 lifecycle pipeline (process-modules).
  if (req.method === 'GET' && url.pathname === '/api/lifecycle/pipeline') {
    return lifecyclePipelineApi.handlePipeline(req, res, url);
  }
  // Static client assets for the lifecycle-pipeline widget (CSS/JS/HTML).
  if (req.method === 'GET' && url.pathname.startsWith('/lifecycle-pipeline/')) {
    return lifecyclePipelineApi.handleStatic(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/episode/stage-summary') {
    return lifecycleApi.handleStageSummary(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/worker/tail') {
    return lifecycleApi.handleWorkerTail(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/workers/active') {
    return lifecycleApi.handleWorkersActive(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/factory/stop') {
    return lifecycleApi.handleEngineStop(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/factory/status') {
    return lifecycleApi.handleEngineStatus(req, res, url);
  }
  if (req.method === 'POST' && url.pathname === '/api/factory/concurrency') {
    return lifecycleApi.handleEngineConcurrency(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/models') {
    return modelApi.handleModelsList(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/lmstudio/models') {
    return modelApi.handleLmstudioModelsList(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/model/set') {
    return modelApi.handleModelSet(req, res);
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

  // ?artifact=<id> — wiki-просмотр
  const artifactId = url.searchParams.get('artifact');
  if (artifactId) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(artifactApi.renderArtifactView(artifactId, projects));
  }

  // /stage?epic=N&stage=X — stage detail page (separate page, not overlay)
  const stageEpic = url.searchParams.get('epic');
  const stageName = url.searchParams.get('stage');
  if (stageEpic && stageName) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(boardApi.renderStageDetailPage(stageEpic, stageName, projects));
  }

  // ?task=<id> — карточка задачи (Jira-style detail view)
  const taskId = url.searchParams.get('task');
  if (taskId) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(boardApi.renderTaskView(taskId, projects));
  }

  // ?registry=<TYPE> — кросс-проектный реестр
  const registryType = url.searchParams.get('registry');
  if (registryType) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(boardApi.renderRegistry(registryType, projects));
  }

  // /admin — страница администрирования (создание проекта/эпика из GUI)
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(adminApi.renderAdmin(projects, null));
  }

  const projectId = url.searchParams.get('project');
  const tab = url.searchParams.get('tab');
  const partial = url.searchParams.get('partial');
  let html;
  if (projectId && tab === 'artifacts') {
    html = artifactApi.renderArtifacts(projectId, projects);
  } else if (projectId && tab === 'coverage') {
    html = boardApi.renderCoverage(projectId, projects);
  } else if (projectId && tab === 'acceptance') {
    html = boardApi.renderAcceptance(projectId, projects);
  } else if (projectId) {
    html = boardApi.renderBoard(projectId, projects);
  } else {
    // Read flash message from query (set by archive/delete redirects).
    let flash = null;
    const archived = url.searchParams.get('archived');
    const deleted = url.searchParams.get('deleted');
    if (deleted) flash = { kind: 'warn', text: `Проект «${deleted}» удалён навсегда.` };
    else if (archived) flash = { kind: 'ok', text: `Проект «${archived}» архивирован (status='archived').` };
    html = boardApi.renderIndex(projects, flash);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // partial=1: episode-progress-bar + .board (AJAX-рефреш).
  // episode-progress-bar включён чтобы needs-human badge / gate-blocked
  // badge обновлялись без F5. frontend (refreshBoard) находит оба элемента
  // в ответе и replaceWith'ит их по отдельности.
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

const SPAWNED = runtimeConfig.trackerSpawned;

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
    modelApi.probeLmstudioModels().then(r => {
      console.log(`LM Studio (${modelApi.lmstudioUrl}): ${r.online ? `${modelApi.LMSTUDIO_MODELS.length} models` : 'offline'}`);
    }).catch(() => {});
    setInterval(() => { modelApi.probeLmstudioModels().catch(() => {}); }, 30000);
    // Открываем браузер ТОЛЬКО если мы реально забиндились (порт был свободен).
    // В spawn-режиме pre-check выше гарантировал, что мы первые; в ручном режиме
    // EADDRINUSE-блок убил stale процесс, и этот listen — свежий, открываем.
    if (!runtimeConfig.trackerNoBrowser) {
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

process.on('exit',  () => { sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => { sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on('SIGTERM',() => { sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
