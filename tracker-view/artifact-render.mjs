// Artifact rendering extracted from tracker-view.mjs (T10 step 6).
//
// This module owns the artifact-facing HTML surface:
//   - renderMarkdown          (minimal markdown -> HTML; reused by step-7 board-render)
//   - renderArtifacts         (the artifact tree tab)
//   - renderArtifactView      (wiki view of one artifact)
//   - renderArtifactEdit      (wiki editor form)
//   - handleArtifactSave      (POST /api/artifact/save)
//
// Pattern: factory injection — like the already-extracted step 1-5 modules.
// createArtifactRenderApi({ deps }) returns the 5 functions bound to the
// injected dependencies.
//
// Deps strategy:
//   - node:fs helpers (readFileSync / writeFileSync / mkdirSync) are imported
//     directly at the top of this file — they are stateless stdlib functions.
//   - shared.mjs helpers (withDb / withDbWrite / esc / inTableHasHeader /
//     resolveArtifactFile / respondJson / DEV_ROOT / PROJECT_REPO_MAP) are
//     imported directly.
//   - artifact-presentation.mjs (artifactFallbackDocument / orderedArtifactTypes)
//     imported directly.
//   - tracker-view-specific deps come in via deps:
//       deps.page        — HTML page wrapper (still lives in tracker-view.mjs)
//       deps.RELOAD_SEC  — auto-refresh interval constant
//       deps.loadArtifactsTree — DB loader owned by tracker-view.mjs (used by renderArtifacts)
//       deps.theme       — { TYPE_COLORS, TYPE_LABEL, STATUS_LABEL, STATUS_COLOR,
//                           LINK_COLORS, LINK_GLYPH } color/label maps
//   - renderMarkdown is module-internal: the other 4 functions in this file
//     call it directly (no deps round-trip), and it is also returned from the
//     factory so tracker-view.mjs can re-export it for step-7 board-render.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  withDb, withDbWrite,
  esc, inTableHasHeader,
  respondJson,
  DEV_ROOT, PROJECT_REPO_MAP,
  resolveArtifactFile,
} from './shared.mjs';
import {
  artifactFallbackDocument,
  orderedArtifactTypes,
} from './artifact-presentation.mjs';

export function createArtifactRenderApi({
  page,
  RELOAD_SEC,
  loadArtifactsTree,
  theme,
}) {
  const {
    TYPE_COLORS,
    TYPE_LABEL,
    STATUS_LABEL,
    STATUS_COLOR,
    LINK_COLORS,
    LINK_GLYPH,
  } = theme;

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
  // inTableHasHeader / extractDiv are imported from ./shared.mjs.

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
    const typeOrder = orderedArtifactTypes(artifacts);
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
            return `<a class="tg tg-link" href="/?artifact=${t.target_id}">${esc(t.target_code || ('#'+t.target_id))}</a>`;
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
            <a class="atitle" href="/?artifact=${o.id}">${esc(o.title)}</a>
            <span class="astatus" style="color:${STATUS_COLOR[o.status]||'#8b949e'}">${STATUS_LABEL[o.status]||o.status}</span>
            <a class="aedit" href="/artifact/${o.id}/edit" title="Редактировать .md">✎</a>
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
    let md = '', mdError = '', fallbackSource = '';
    if (resolved) {
      try { md = readFileSync(resolved.abs, 'utf8'); }
      catch (e) { mdError = `Ошибка чтения файла: ${e.message}`; }
    } else {
      const fallback = artifactFallbackDocument(art);
      md = fallback.markdown;
      fallbackSource = fallback.source;
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
      ${mdError && !resolved
        ? `<div class="flash-warn">${mdError}. Showing ${esc(fallbackSource)}.</div>${renderMarkdown(md)}`
        : mdError
          ? `<div class="md-error">${esc(mdError)}</div>`
          : renderMarkdown(md)}
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

  // respondJson / readRequestFields are imported from ./shared.mjs.

  return {
    renderMarkdown,
    renderArtifacts,
    renderArtifactView,
    renderArtifactEdit,
    handleArtifactSave,
  };
}
