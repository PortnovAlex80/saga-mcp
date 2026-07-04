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

// Найти физический путь к .md файлу артефакта.
// path в БД может быть 'docs/.../01-SRS.md#FR-1' — якорь отбрасываем.
// Возвращает { abs, projectRoot } или null если файл не существует.
function resolveArtifactFile(artifactPath, projectName) {
  const cleanPath = artifactPath.split('#')[0];
  const candidates = [];
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
        <a class="tab" href="?project=${projectId}&tab=coverage">Покрытие</a>
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
        <a class="tab" href="?project=${projectId}&tab=coverage">Покрытие</a>
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
      SELECT a.*, e.name AS epic_name, p.name AS project_name, p.id AS project_id
        FROM artifacts a
        JOIN epics e ON e.id = a.epic_id
        JOIN projects p ON p.id = e.project_id
       WHERE a.id = ?`).get(artifactId));
  } catch { art = null; }
  if (!art) return page('Артефакт не найден', '<div class="empty-box"><h2>Артефакт не найден</h2></div>');

  const proj = allProjects.find(p => String(p.id) === String(art.project_id));
  const projColor = proj?.color || '#8b949e';
  const resolved = resolveArtifactFile(art.path, art.project_name);
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
          CASE WHEN t.target_type='artifact' THEN (SELECT a.code FROM artifacts a WHERE a.id=t.target_id) END AS target_code
          FROM artifact_traces t WHERE t.source_id=? ORDER BY t.link_type`).all(artifactId);
      const inc = db.prepare(`
        SELECT t.link_type, t.source_id,
          (SELECT a.code FROM artifacts a WHERE a.id=t.source_id) AS src_code,
          (SELECT a.type FROM artifacts a WHERE a.id=t.source_id) AS src_type
          FROM artifact_traces t WHERE t.target_type='artifact' AND t.target_id=? ORDER BY t.link_type`).all(artifactId);
      const parts = [];
      if (out.length) parts.push('<div class="tr-sec"><b>Исходящие:</b> ' + out.map(t =>
        `<span class="trace-badge" style="border-color:${LINK_COLORS[t.link_type]||'#8b949e'};color:${LINK_COLORS[t.link_type]||'#8b949e'}">${LINK_GLYPH[t.link_type]||t.link_type}: ${esc(t.target_code||('#'+t.target_id))}</span>`).join(' ') + '</div>');
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
      SELECT a.*, p.name AS project_name, p.id AS project_id
        FROM artifacts a JOIN epics e ON e.id=a.epic_id JOIN projects p ON p.id=e.project_id
       WHERE a.id = ?`).get(artifactId));
  } catch { art = null; }
  if (!art) return page('Артефакт не найден', '<div class="empty-box"><h2>Артефакт не найден</h2></div>');

  const resolved = resolveArtifactFile(art.path, art.project_name);
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
    .cov-epic-row td{background:#0d1117!important;font-weight:600;color:#58a6ff;font-size:12px;border-bottom:1px solid #30363d}
    .cov-epic-row .ep-count{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:10px;padding:0 7px;font-size:10px;margin-left:6px;font-weight:400}
    .cov-tasks{display:flex;flex-wrap:wrap;gap:4px}
    .cov-task{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:#21262d;border:1px solid #30363d;border-radius:3px;padding:1px 6px;text-decoration:none}
    .cov-task:hover{border-color:currentColor;text-decoration:underline}
    .cov-st{font-size:9px;opacity:.7;text-transform:uppercase}
    .cov-no{color:#484f58;font-style:italic;font-size:12px}
    .cov-legend{padding:10px 20px 30px;font-size:11px;color:#8b949e}
    .cov-gap-sample{background:rgba(231,76,60,.06);padding:1px 6px;border-radius:3px}

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
        SELECT a.*, p.name AS project_name FROM artifacts a
          JOIN epics e ON e.id=a.epic_id JOIN projects p ON p.id=e.project_id
         WHERE a.id=?`).get(id));
    } catch (e) { return respondJson(res, 500, { error: 'db: ' + e.message }); }
    if (!art) return respondJson(res, 404, { error: 'artifact not found' });

    const result = { ok: true, id, warnings: [] };

    // 1. Сохранение .md файла
    if (typeof fields.markdown === 'string') {
      const resolved = resolveArtifactFile(art.path, art.project_name);
      let absPath = resolved?.abs;
      if (!absPath) {
        // Файла нет — создадим по первому кандидату из PROJECT_REPO_MAP.
        const cleanPath = art.path.split('#')[0];
        const map = PROJECT_REPO_MAP[art.project_name] || [art.project_name];
        absPath = path.join(DEV_ROOT, map[0], cleanPath);
        result.warnings.push(`файл создан: ${absPath}`);
      }
      try {
        mkdirSync(path.dirname(absPath), { recursive: true });
        writeFileSync(absPath, fields.markdown, 'utf8');
        result.file = absPath;
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

  const types = ['PRD','SRS','UC','AC','FR','NFR','decision'];
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
      <tr class="cov-epic-row"><td colspan="5">${esc(epicName)} <span class="ep-count">${epicAcs.length}</span></td></tr>
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
    <div class="cov-table-wrap">
      <table class="cov-table">
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
    </div>`);
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
    </div>
    <script>
    async function postForm(form) {
      const data = new URLSearchParams(new FormData(form));
      const btn = form.querySelector('button[type=submit]');
      const action = data.get('action');
      const endpoint = action === 'project' ? '/api/project/create' : '/api/epic/create';
      btn.disabled = true; const oldTxt = btn.textContent; btn.textContent = 'Создание…';
      try {
        const r = await fetch(endpoint, { method:'POST', body:data });
        const j = await r.json();
        if (j.ok) {
          if (action === 'project') location.href = '/?created=' + encodeURIComponent('проект «'+(j.name||'')+'»');
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
  if (req.method === 'POST' && url.pathname === '/api/epic/create') {
    return handleEpicCreate(req, res);
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
