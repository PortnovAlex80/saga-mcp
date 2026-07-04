// saga tracker viewer — мультипроектный канбан для ОДНОЙ общей БД saga-mcp.
// Читает process.env.DB_PATH (ту же БД, что и сам saga-MCP) и показывает
// все saga-проекты как пункты навигации. Read-only.
//   /                       → индекс всех проектов со счётчиками
//   /?project=<id>          → канбан конкретного saga-проекта
//   /api/heartbeat          → JSON { last } — timestamp последней активности
import http from 'node:http';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// better-sqlite3 уже стоит в node_modules форка (npm install). Берём оттуда.
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

// ОДИН источник данных — общая БД saga-mcp. Та же, что saga-MCP-сервер.
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH || !existsSync(DB_PATH)) {
  console.error('DB_PATH не задан или не существует. Saga-MCP должен запустить tracker-view с правильным DB_PATH.');
  process.exit(1);
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

// Возраст timestamp'а → класс кружка (green/yellow/red)
function ageClass(iso) {
  if (!iso) return 'red';
  const ago = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (ago < 15) return 'green';
  if (ago < 60) return 'yellow';
  return 'red';
}
function ageText(iso) {
  if (!iso) return '?';
  const ago = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
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
      SELECT id, name, project_id FROM epics WHERE project_id=? ORDER BY id
    `).all(projectId);
    if (epicRows.length === 0) return { empty: true, reason: 'no-epics' };
    const epicIds = epicRows.map(e => e.id);
    const tasks = db.prepare(`
      SELECT * FROM tasks WHERE epic_id IN (${epicIds.map(() => '?').join(',')})
      ORDER BY sort_order, id
    `).all(...epicIds);
    const epicById = Object.fromEntries(epicRows.map(e => [e.id, e]));
    return { epics: epicRows, epicById, tasks };
  });
}

function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

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
//     decision(BRIEF) → PRD → {SRS, UC, FR, NFR}; AC → UC (иногда → PRD).
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
function renderIndex(projects) {
  const withData = projects.filter(p => p.total > 0);
  const empty    = projects.filter(p => !p.total || p.total === 0);
  withData.sort((a,b) => b.total - a.total);

  const totalTasks = projects.reduce((s,p) => s + (p.total||0), 0);
  const totalProj  = projects.length;
  const rowHtml = (p) => `<a class="prow${!p.total?' empty':''}" href="?project=${p.id}">
    <span class="pdot" style="background:${p.color}"></span>
    <span class="pname">${esc(p.name)}</span>
    <span class="pstats">${p.total ? `<b>${p.total}</b> задач · <span class="ip">${p.in_progress} in progress</span>${p.reviewing ? ` · <span class="ip">${p.reviewing} reviewing</span>` : ''}` : '<span class="muted">пусто</span>'}</span>
    <span class="arrow">→</span>
  </a>`;

  const active = withData.map(rowHtml).join('');
  const empties = empty.map(rowHtml).join('');

  return page('Все проекты', `
    <div class="summary">
      <div class="sum-item"><b>${totalProj}</b><span>проектов</span></div>
      <div class="sum-item"><b>${totalTasks}</b><span>всего задач</span></div>
      <div class="sum-item"><b>${withData.length}</b><span>с задачами</span></div>
      <div class="sum-item" style="flex:0;min-width:120px"><div class="heartbeat" style="justify-content:center"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div></div>
    </div>
    <div class="searchbar">
      <input id="q" placeholder="🔍 поиск проекта по имени..." autocomplete="off">
    </div>
    <div class="section-title">Активные</div>
    <div class="plist" id="active">${active || '<div class="empty-hint">Нет проектов с задачами.</div>'}</div>
    ${empty.length ? `<details class="empty-section"><summary>Пустые проекты (${empty.length})</summary><div class="plist">${empties}</div></details>` : ''}
    <script>
      const q=document.getElementById('q');
      q.oninput=()=>{ const v=q.value.toLowerCase(); document.querySelectorAll('.prow').forEach(r=>{ r.style.display = r.textContent.toLowerCase().includes(v)?'':'none'; }); };
      setTimeout(()=>location.reload(), ${RELOAD_SEC * 1000});
    </script>
  `);
}

// --- HTML: канбан одного проекта ---
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
      </div>
      <span style="flex:1"></span>
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
      <div class="card${c.needsHuman ? ' needs-human' : ''}" data-epic="${c.epicId}" style="border-left:6px solid ${proj.color}">
        <div class="card-head">
          <span class="prio" style="background:${c.prio}">${esc(c.t.priority)}</span>
          ${c.t.assigned_to ? `<span class="assigned" title="assigned_to">${esc(c.t.assigned_to)}</span>` : ''}
          ${c.needsHuman ? '<span class="ask-flag" title="needs human answer">⚠ needs human</span>' : ''}
          <span style="flex:1"></span>
          <span class="hb-dot ${ageClass(c.t.updated_at)}" title="${ageText(c.t.updated_at)} назад"></span>
        </div>
        <div class="card-title">${esc(c.t.title)}</div>
        <div class="card-meta">${esc(c.epicName)} · #${c.t.id}</div>
      </div>`).join('');
    return `<div class="col">
      <div class="col-head"><span>${col.label}</span><span class="count">${items.length}</span></div>
      <div class="col-body">${cardsHtml || '<div class="col-empty">—</div>'}</div>
    </div>`;
  }).join('');

  return page(proj.name, `${header}
    <div class="filter-bar">
      <span class="filter-label">Эпики:</span>
      <button class="chip active" data-filter="__all__">Все</button>
      ${epicChips}
    </div>
    <div class="board">${columnsHtml}</div>
    <script>
    let activeFilter = '__all__';
    function applyFilter() {
      document.querySelectorAll('.card').forEach(card => {
        card.style.display = (activeFilter === '__all__' || card.dataset.epic === activeFilter) ? '' : 'none';
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
    async function refreshBoard() {
      try {
        const r = await fetch('?project=${projectId}&partial=1');
        if (!r.ok) return;
        const html = await r.text();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const oldBoard = document.querySelector('.board');
        const newBoard = tmp.querySelector('.board');
        if (oldBoard && newBoard) oldBoard.replaceWith(newBoard);
        applyFilter();
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
  const typeOrder = ['PRD','SRS','UC','AC','FR','NFR','decision','theme','brief'];
  const summaryChips = typeOrder
    .filter(t => byType[t])
    .map(t => `<span class="tchip" style="border-color:${TYPE_COLORS[t]};color:${TYPE_COLORS[t]}">${TYPE_LABEL[t]||t}: ${byType[t]}</span>`)
    .join('');

  // Сироты: нет родителя И нет исходящих трасс И не являются чьим-то родителем.
  const parentIds = new Set(artifacts.filter(a => a.parent_artifact_id != null).map(a => a.parent_artifact_id));
  const isParent = new Set(parentIds);
  const orphans = artifacts.filter(a => a.parent_artifact_id == null && !isParent.has(a.id) && !tracesBySource[a.id]);
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
    const childrenHtml = children.length
      ? `<div class="children">${children.map(c => renderNode(c, depth + 1)).join('')}</div>`
      : '';
    return `<div class="anode" data-depth="${depth}">
      <div class="anode-head">
        <span class="atype" style="background:${typeColor}">${typeLabel}</span>
        <span class="acode">${code}</span>
        <span class="atitle">${esc(art.title)}</span>
        <span class="astatus" style="color:${stColor}" title="${esc(art.status)}">${stLabel}</span>
      </div>
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
        return `${projBadge}<span class="tg" style="color:${tcolor}">#${task.id}<span class="tg-st"> ${esc(task.status)}</span></span>`;
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
    <div class="episodes">${episodesHtml}${orphansHtml}</div>
    <script>
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
    .section-title{padding:8px 20px;font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
    .plist{padding:0 20px 20px;display:flex;flex-direction:column;gap:6px}
    .prow{display:flex;align-items:center;gap:12px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 14px;transition:border-color .15s}
    .prow:hover{border-color:#58a6ff} .prow.empty{opacity:.55}
    .pdot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
    .pname{flex:1;font-weight:600;font-size:14px}
    .pstats{font-size:12px;color:#8b949e} .pstats b{color:#e6edf3} .ip{color:#3fb950}
    .muted{color:#484f58} .arrow{color:#484f58}
    .empty-section{padding:0 20px 20px} .empty-section summary{cursor:pointer;color:#8b949e;padding:8px;font-size:13px}
    .empty-hint{padding:24px;text-align:center;color:#484f58;font-size:13px}

    /* доска */
    .board-head{display:flex;align-items:center;gap:12px;padding:14px 20px;background:#161b22;border-bottom:1px solid #30363d}
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
    .card-title{font-size:13px;line-height:1.35}
    .card-meta{font-size:11px;color:#8b949e;margin-top:6px}

    /* фильтр-бар */
    .filter-bar{display:flex;align-items:center;gap:6px;padding:10px 20px;background:#161b22;border-bottom:1px solid #30363d;flex-wrap:wrap}
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
    .hb-dot.green{background:#3fb950;animation:pulse 1s infinite}
    .hb-dot.yellow{background:#f1c40f}
    .hb-dot.red{background:#e74c3c}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

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
    .atype{font-size:10px;font-weight:700;color:#0d1117;padding:2px 6px;border-radius:3px;letter-spacing:.3px}
    .acode{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#58a6ff;font-weight:600;min-width:42px}
    .atitle{flex:1;font-size:13px;color:#e6edf3;line-height:1.35}
    .astatus{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
    .anode.shallow{padding:4px 0} .anode.shallow .atitle{font-size:12px;color:#8b949e}

    /* бейджи трасс под листом AC */
    .traces{margin:4px 0 4px 22px;display:flex;flex-direction:column;gap:3px}
    .trace-badge{font-size:11px;border:1px solid;border-radius:4px;padding:2px 7px;display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.02);width:fit-content}
    .tg{font-family:ui-monospace,Consolas,monospace;font-size:11px}
    .tg-st{font-size:9px;opacity:.7;text-transform:uppercase}
    .tg-proj{font-size:10px;background:rgba(88,166,255,.12);border:1px solid #58a6ff;color:#58a6ff;border-radius:3px;padding:0 4px;margin-right:3px}

    /* сироты — сетка по типам */
    .orphan-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
    .orphan-group{display:flex;flex-direction:column;gap:4px}
    .orphan-type{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid #30363d}
  </style></head>
  <body>${body}
  <script>
  // Heartbeat — индикатор активности агентов (по activity_log общей БД)
  (function(){
    const dot=document.getElementById('hb-dot');
    const txt=document.getElementById('hb-txt');
    if(!dot) return;
    function update(){
      fetch('/api/heartbeat').then(r=>r.json()).then(d=>{
        if(!d.last){ dot.className='hb-dot red'; txt.textContent='нет данных'; return; }
        const ago=Math.floor((Date.now()-new Date(d.last+'Z').getTime())/1000);
        if(ago<15){ dot.className='hb-dot green'; txt.textContent=ago+'с назад'; }
        else if(ago<60){ dot.className='hb-dot yellow'; txt.textContent=ago+'с назад'; }
        else{ dot.className='hb-dot red'; txt.textContent=Math.floor(ago/60)+'м назад'; }
      }).catch(()=>{ dot.className='hb-dot red'; txt.textContent='ошибка'; });
    }
    update(); setInterval(update,3000);
  })();
  </script></body></html>`;
}

// --- роутинг ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/heartbeat') {
    let last = null;
    try {
      last = withDb(db => db.prepare('SELECT MAX(created_at) as last FROM activity_log').get()?.last || null);
    } catch { /* БД занята/нет таблицы — вернём null */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ last }));
  }

  const projectId = url.searchParams.get('project');
  const tab = url.searchParams.get('tab');
  const partial = url.searchParams.get('partial');
  const projects = listProjects();
  let html;
  if (projectId && tab === 'artifacts') {
    html = renderArtifacts(projectId, projects);
  } else if (projectId) {
    html = renderBoard(projectId, projects);
  } else {
    html = renderIndex(projects);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // partial=1: только .board (AJAX-рефреш канбана).
  if (partial === '1' && projectId) {
    const frag = extractDiv(html, 'board');
    res.end(frag || html);
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
    // Открываем браузер ТОЛЬКО если мы реально забиндились (порт был свободен).
    // В spawn-режиме pre-check выше гарантировал, что мы первые; в ручном режиме
    // EADDRINUSE-блок убил stale процесс, и этот listen — свежий, открываем.
    const open = process.platform === 'win32' ? `start ${u}` : process.platform === 'darwin' ? `open ${u}` : `xdg-open ${u}`;
    try { require('node:child_process').exec(open); } catch {}
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

process.on('exit',  () => { try { unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => { try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on('SIGTERM',() => { try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
