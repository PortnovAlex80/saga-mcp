// Board + page rendering extracted from tracker-view.mjs (T10 step 7).
//
// This module owns the HTML surface for the kanban board and its tabs, the
// index page, the task detail card, the stage-detail page, the document
// registry, the coverage matrix, the acceptance registry, AND the page()
// HTML wrapper (which carries the full CSS for the whole tracker UI).
//
//  1.  renderIndex(projects, flash)             — index page with all projects
//  2.  engineControlStateForEpic(epicId)        — reads engine control state from DB
//  3.  resolveWorkerModel()                     — reads ~/.claude/settings.json
//  4.  WORKER_MODEL                             — resolved model name constant
//  5.  renderBoard(projectId, allProjects)      — kanban board (the big one)
//  6.  renderTaskView(taskId, allProjects)      — task detail card (Jira-style)
//  7.  page(title, body)                        — HTML page wrapper (ALL the CSS)
//  8.  STAGE_DESCRIPTIONS                       — stage metadata object
//  9.  renderRegistry(type, allProjects)        — cross-project document registry
//  10. loadCoverageMatrix(projectId)            — DB query for coverage data
//  11. renderStageDescriptionBlock(stageName)   — small helper
//  12. renderStageDetailPage(epicId, stageName, allProjects)
//  13. renderCoverage(projectId, allProjects)   — coverage matrix tab
//  14. loadAcceptanceRegistry(projectId)        — DB query for acceptance data
//  15. computeAcceptance(traces)                — pure acceptance computation
//  16. renderAcceptance(projectId, allProjects) — acceptance registry tab
//
// Pattern: factory injection — like the already-extracted step 1-6 modules.
// createBoardRenderApi({ deps }) returns all 16 functions/consts bound to the
// injected dependencies.
//
// Deps strategy:
//   - node:fs helpers (readFileSync / writeFileSync) are imported directly at
//     the top of this file — they are stateless stdlib functions.
//   - node:os / node:path are imported directly.
//   - shared.mjs helpers (withDb / esc / extractDiv / inTableHasHeader /
//     truncate / ageClass / ageText) are imported directly.
//   - tracker-view-specific deps come in via deps:
//       deps.RELOAD_SEC  — auto-refresh interval constant (number)
//       deps.loadBoard   — function: loads board data via sagaApplication
//       deps.theme       — { COLS, PROJECT_COLORS, PRIO, TYPE_COLORS,
//                            TYPE_LABEL, STATUS_LABEL, STATUS_COLOR,
//                            LINK_COLORS, LINK_GLYPH } color/label maps
//       deps.modelApi    — model management API object (ZAI_MODELS /
//                          LMSTUDIO_MODELS / LMSTUDIO_ONLINE) used by renderBoard
//       deps.runtimeConfig — tracker runtime config (currently unused but kept
//                          for symmetry with sibling factories)
//   - page() is module-internal: the other 15 functions in this file call it
//     directly (no deps round-trip), and it is also returned from the factory
//     so tracker-view.mjs (and artifact-render.mjs via tracker-view) can use it.
//   - WORKER_MODEL is module-internal and computed once via resolveWorkerModel();
//     returned from the factory so tracker-view.mjs can pass it to modelApi.
//   - renderMarkdown comes from artifact-render.mjs and is wired via
//     setRenderMarkdown() (two-phase init) to break the circular dep:
//       board-render needs renderMarkdown (for renderTaskView); artifact-render
//       needs page (from board-render). So we construct boardApi first, then
//     artifactApi (receiving boardApi.page), then call
//     boardApi.setRenderMarkdown(artifactApi.renderMarkdown).
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  withDb,
  esc,
  extractDiv,
  inTableHasHeader,
  truncate,
  ageClass,
  ageText,
} from './shared.mjs';

export function createBoardRenderApi({
  RELOAD_SEC,
  loadBoard,
  theme,
  modelApi: initialModelApi,
  runtimeConfig,
}) {
  const {
    COLS,
    PROJECT_COLORS,
    PRIO,
    TYPE_COLORS,
    TYPE_LABEL,
    STATUS_LABEL,
    STATUS_COLOR,
    LINK_COLORS,
    LINK_GLYPH,
  } = theme;

  // Late-bound markdown renderer (set via setRenderMarkdown after artifactApi
  // is constructed). Referenced inside renderTaskView only.
  let _renderMarkdown = null;
  // Late-bound model management API. renderBoard reads ZAI_MODELS /
  // LMSTUDIO_MODELS / LMSTUDIO_ONLINE at request time (inside the IIFE that
  // builds the model optgroup), not at construction time. tracker-view.mjs
  // constructs boardApi BEFORE modelApi (because modelApi needs
  // boardApi.WORKER_MODEL), so modelApi is wired in via setModelApi() after
  // the model factory has run.
  let _modelApi = initialModelApi || null;

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
   * Read state owned by one episode. The control panel must not infer it from
   * another, more recently updated epic in the same project.
   */
  function engineControlStateForEpic(epicId) {
    try {
      const row = withDb(db => db.prepare(
        `SELECT concurrency AS concurrency,
                engine_state AS running_state,
                model_name AS model
           FROM lifecycle_execution_controls WHERE epic_id=?`,
      ).get(epicId));
      return {
        concurrency: Number.isInteger(row?.concurrency) && row.concurrency >= 1 && row.concurrency <= 10
          ? row.concurrency : 4,
        running: row?.running_state === 'running',
        model: typeof row?.model === 'string' && row.model ? row.model : null,
      };
    } catch {
      return { concurrency: 4, running: false, model: null };
    }
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
    const controlEpics = Object.values(data.epicById || {}).sort((a, b) => Number(b.id) - Number(a.id));
    const controlEpic = controlEpics.find(epic => engineControlStateForEpic(epic.id).running)
      || controlEpics[0]
      || null;
    const controlState = engineControlStateForEpic(controlEpic?.id);
    const controlEpicOptions = controlEpics.map(epic =>
      `<option value="${epic.id}"${epic.id === controlEpic?.id ? ' selected' : ''}>#${epic.id} ${esc(epic.name)}</option>`
    ).join('');

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
          <select id="agent-epic-select" aria-label="Epic controlled by this panel"${controlEpic ? '' : ' disabled'}>
            ${controlEpicOptions || '<option value="">no epics</option>'}
          </select>
          <button id="agent-engine-toggle" class="engine-toggle${
            controlState.running ? ' engine-running' : ''
          }" type="button"${controlEpic ? '' : ' disabled'} aria-label="Запуск / пауза движка" title="Запуск / пауза движка этого эпизода. Пауза — дожин: ограда очереди, активные воркеры доработают.">${
            controlState.running ? '⏸' : '▶'
          }</button>
          <button id="agent-engine-hardstop" class="engine-hardstop" type="button"${
            controlEpic ? '' : ' disabled'
          } aria-label="Стоп немедленно" title="Жёсткий стоп (backstop): убить движок и воркеров немедленно. Только для зависшего дожина — обычная пауза это ⏸.">⏹</button>
          <select id="agent-concurrency" aria-label="Количество одновременных воркеров движка">
            ${Array.from({ length: 10 }, (_, i) => {
              // Pre-select the option matching the engine's current concurrency,
              // read from lifecycle_execution_controls.concurrency. Without
              // this, hot-reload of tracker-view loses the user's last choice —
              // selector defaults to 1, and any change would restart the engine
              // at concurrency=1, killing the parallel cohort mid-flight.
              const conc = controlState.concurrency;
              return `<option value="${i + 1}"${i + 1 === conc ? ' selected' : ''}>${i + 1}</option>`;
            }).join('')}
          </select>
          <select id="agent-model-select" title="Модель для НОВЫХ воркеров. Активные доработают на старой. Лимит модели — потолок concurrency. Опция «↻ LM Studio» — обновить список локальных моделей.">
            ${(function() {
              // Read the per-epic choice from saga.db so F5 preserves it.
              // Without this the selector reset to the process-wide WORKER_MODEL
              // constant on every page reload, losing the user's last selection.
              const chosen = controlState.model || WORKER_MODEL;
              const zaiOpts = _modelApi.ZAI_MODELS.map(m =>
                `<option value="${m.id}" data-limit="${m.limit}" data-provider="zai"${m.id === chosen ? ' selected' : ''}>${m.id} (×${m.limit}${m.note ? ' · ' + m.note : ''})</option>`
              ).join('');
              // LM Studio group: real loaded models if online, else a single
              // disabled "офлайн" hint + the refresh sentinel option.
              const lmOn = _modelApi.LMSTUDIO_ONLINE && _modelApi.LMSTUDIO_MODELS.length > 0;
              const lmBody = lmOn
                ? _modelApi.LMSTUDIO_MODELS.map(m =>
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
        <span class="task-badge stage">${esc(e.episode_stage || 'unassigned')}</span>
        ${e.drift_count ? `<span class="task-badge" style="color:#f85149">drift ${e.drift_count}</span>` : ''}
        ${e.evidence_count ? `<span class="task-badge" style="color:#3fb950">evidence ${e.evidence_count}</span>` : ''}
        ${e.gate_error ? `<span class="task-badge" style="color:#f85149" title="${esc(e.gate_error)}">gate blocked</span>` : ''}
        ${e.needs_human === 1 ? `
          <span class="task-badge" style="color:#f85149;background:rgba(231,76,60,.15)" title="${esc(e.pause_reason || 'engine paused')}">⚠ engine paused</span>
        ` : ''}
        ${Number(e.active_workers || 0) > 0 ? `
          <span class="task-badge" style="color:#3fb950;background:rgba(46,160,67,.15)" title="Lifecycle ждёт результаты активных исполнителей">● рабочие работают: ${Number(e.active_workers)}</span>
        ` : ''}
      </div>`).join('');
    const repoBindings = withDb(db => db.prepare(`
      SELECT pr.id,r.name,pr.status FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
      WHERE pr.project_id=? ORDER BY r.name
    `).all(projectId));
    const bootstrapOptions = repoBindings.map(r =>
      `<option value="${r.id}">${esc(r.name)} (${esc(r.status)})</option>`).join('');

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
      <div class="board-pipeline">
        <div class="bp-title">Pipeline</div>
        <div id="pipeline-stages" class="pipeline-bar"><span class="worker-empty">выбери эпик</span></div>
      </div>
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
      window.__sagaEpicId = ${controlEpic?.id || 'null'};
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
        window.dispatchEvent(new CustomEvent('saga:active-workers-changed', {
          detail: { count: active.length },
        }));
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
          // Worker subtitle: show output token speed + cumulative output tokens.
          // tok/s = output_tokens / elapsed_seconds — the model's live
          // production rate from the API-reported cumulative usage.
          const tps = w.tokens_per_sec;
          const tt = w.total_tokens;
          if (tps != null && tt != null) {
            const fmt = n => n > 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
            row.querySelector('.wr-sub').textContent = tps + ' tok/s · ' + fmt(tt) + ' out';
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
      // Pipeline polling: the lifecycle controller is the SOLE poller for the
      // It renders the lifecycle bar for epics with a LifecycleRun and an explicit
      // empty state otherwise. Dynamic import() works from a classic script.
      import('/lifecycle-pipeline/mount.js').then(mod => {
        window.__lifecyclePipeline = mod; // expose for the epic-switch handler
        mod.mountLifecyclePipeline(window.__sagaEpicId, ${RELOAD_SEC * 1000});
      }).catch(() => {
        console.error('lifecycle-pipeline/mount.js failed to load');
      });

      async function fetchEngineStatus() {
        const epicId = window.__sagaEpicId;
        if (!epicId) {
          runnerStatus.textContent = 'нет эпика';
          return;
        }
        try {
          const r = await fetch('/api/factory/status?epic_id=' + epicId);
          const state = await r.json();
          if (!r.ok || !state.ok) throw new Error(state.error || 'status unavailable');
          // B-006 guard: the controls row is written only by the PANEL start
          // path — engines launched via scripts/factory.mjs have no
          // engine_pid there, so state.running&&alive reads false while the
          // factory demonstrably works. Live worker executions are the
          // process-independent truth (shared DB); when they exist and the
          // controls row is blind, DISABLE the toggle entirely: Play would
          // spawn a duplicate engine (lease collision), Stop would kill the
          // live workers. The user WILL press the button — it must be dead,
          // not merely discouraged.
          let blindLive = 0;
          try {
            const w = await fetch('/api/workers/active?project_id=' + (window.__sagaProjectId || ${projectId}));
            const wj = await w.json();
            if (wj.ok && Array.isArray(wj.workers)) {
              blindLive = wj.workers.filter(x => x.phase !== 'exited').length;
            }
          } catch { /* workers probe unavailable — fall through to controls */ }
          const panelSeesEngine = state.running && state.alive;
          if (!panelSeesEngine && blindLive > 0) {
            // B-006 v3 truth, PAUSE-DESIGN update: the durable project hold
            // is ENGINE-AGNOSTIC — ⏸ works even for a blind-controls engine
            // (the queue fence lives in the shared DB, not in the controls
            // row). The engine drains active turns and self-parks (exit-2
            // 'paused'). Killing a blind engine stays CLI-only: the panel
            // stop matchers cannot see this engine (fence+void+rewind+holds
            // live in factory.mjs stop).
            engineToggle.disabled = false;
            engineToggle.textContent = '⏸';
            engineToggle.classList.add('engine-running');
            engineToggle.title = 'Пауза-дожин: ограда очереди держится в БД и не зависит от панели. Движок сам припаркуется после дожина; для убийства — CLI: node scripts/factory.mjs stop <db> --project N';
            runnerStatus.textContent = 'завод работает (вне панели) · воркеров: ' + blindLive
              + ' · ⏸ доступен (дожин): движок сам припаркуется после дожина; для убийства — CLI';
          } else {
            engineToggle.disabled = false;
            syncEngineToggleButton(panelSeesEngine);
            const effective = state.model_limit
              ? Math.min(state.concurrency || 1, state.model_limit)
              : state.concurrency;
            runnerStatus.textContent = (panelSeesEngine ? 'работает' : 'остановлен')
              + ' · concurrency=' + state.concurrency
              + (effective !== state.concurrency ? ' (effective ' + effective + ')' : '');
          }
          if (runnerConcurrency && state.concurrency) {
            runnerConcurrency.value = String(state.concurrency);
          }
          if (modelSelect && state.model) modelSelect.value = state.model;
        } catch (error) {
          runnerStatus.textContent = 'статус недоступен';
        }
      }
      const epicSelect = document.getElementById('agent-epic-select');
      if (epicSelect) {
        epicSelect.addEventListener('change', () => {
          window.__sagaEpicId = Number(epicSelect.value) || null;
          fetchEngineStatus();
          // Remount the lifecycle controller for the newly-selected epic. If the
          // module is still loading or absent, this is a safe no-op (mount is a
          if (window.__lifecyclePipeline) {
            window.__lifecyclePipeline.mountLifecyclePipeline(window.__sagaEpicId, ${RELOAD_SEC * 1000});
          }
        });
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
          const r = await fetch('/api/factory/concurrency', {
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
          fetchEngineStatus();
        } finally {
          runnerConcurrency.disabled = false;
        }
      });
      // --- Engine Start/Pause toggle button ---
      //▶ starts/resumes the engine (resume now also releases operator holds —
      //   the unpark — before spawning, see /api/factory/start).
      //⏸ GRACEFUL-DRAIN PAUSE (docs/architecture/PAUSE-DESIGN): places ONE
      //   durable project-scope operator hold (POST /api/factory/pause) and
      //   kills NOTHING. The queue fence lets every active turn finish; the
      //   engine self-parks via its 3-streak exit-2 'paused' path. The status
      //   line enters two-phase drain mode (⏳ waiting on workers → paused).
      //⏹ (separate button) is the explicit hard-stop backstop for a hung
      //   drain — confirm-gated, legacy /api/factory/stop.
      const engineToggle = document.getElementById('agent-engine-toggle');
      // Two-phase drain: after the hold is placed, poll /api/workers/active
      // until 0, then show the paused state. ▶ stays available the whole
      // time (start releases the hold — aborting the drain is legitimate).
      let drainTimer = null;
      function stopDrainPolling() {
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      }
      function drainModePoll(lastActive, queuedCards) {
        stopDrainPolling();
        syncEngineToggleButton(false);
        const projectId = window.__sagaProjectId || ${projectId};
        const tick = async () => {
          let active = lastActive;
          try {
            const w = await fetch('/api/workers/active?project_id=' + projectId);
            const wj = await w.json();
            if (wj.ok && Array.isArray(wj.workers)) {
              active = wj.workers.filter(x => x.phase !== 'exited').length;
            }
          } catch { /* probe unavailable — keep the last count */ }
          if (active > 0) {
            runnerStatus.textContent = '⏳ дожидаемся ' + active + ' воркер(ов) — новых наймов нет (ограда очереди)';
            drainTimer = setTimeout(tick, ${RELOAD_SEC * 1000});
            return;
          }
          drainTimer = null;
          runnerStatus.textContent = 'на паузе (' + (queuedCards > 0
            ? queuedCards + ' карт в очереди'
            : 'очередь пуста') + ') · ▶ снимет ограду и продолжит';
        };
        tick();
      }
      if (engineToggle) {
        engineToggle.addEventListener('click', async () => {
          const epicId = window.__sagaEpicId;
          if (!epicId) return;
          // Read current state to decide direction.
          let running = engineToggle.classList.contains('engine-running');
          if (running) {
            // Pause = one durable hold. Immediate on click, no confirm: the
            // hold is reversible (▶ releases it) and hurts nothing in flight.
            engineToggle.disabled = true;
            runnerStatus.textContent = 'пауза: ставим ограду очереди…';
            try {
              const r = await fetch('/api/factory/pause', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // epic_id, not project_id: the engine panel is epic-scoped;
                // the endpoint normalizes it.
                body: JSON.stringify({ epic_id: epicId }),
              });
              const d = await r.json();
              if (!r.ok || !d.ok) throw new Error(d.error || 'не удалось поставить паузу');
              drainModePoll(d.active_workers ?? 0, d.queued_cards ?? 0);
            } catch (e) {
              alert('Пауза: ' + e.message);
              runnerStatus.textContent = 'ошибка';
            } finally {
              engineToggle.disabled = false;
            }
          } else {
            stopDrainPolling();
            if (!confirm('Продолжить завод с последней durable-точки? Будут созданы воркеры, расходующие токены.')) return;
            engineToggle.disabled = true;
            runnerStatus.textContent = 'старт…';
            try {
              const r = await fetch('/api/factory/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // epic_id, not project_id: the engine panel is epic-scoped
                // (same as the pause branch); the endpoint normalizes it.
                body: JSON.stringify({ epic_id: epicId }),
              });
              const d = await r.json();
              if (!r.ok || !d.ok) throw new Error(d.error || 'не удалось запустить');
              syncEngineToggleButton(true);
              runnerStatus.textContent = 'resume lifecycle=' + d.lifecycle_run_id
                + ' (pid ' + d.engine_pid + ')'
                + (d.holds_released > 0 ? ' · ограда снята (' + d.holds_released + ')' : '');
            } catch (e) {
              alert('Старт движка: ' + e.message);
              runnerStatus.textContent = 'ошибка';
            } finally {
              engineToggle.disabled = false;
            }
          }
        });
      }
      // --- Hard-stop backstop (drain deadline) ---
      // The EXPLICIT second action for a hung drain: confirm-gated, legacy
      // kill path (/api/factory/stop). Never the default — the default pause
      // is ⏸ (graceful drain, zero token loss).
      const engineHardstop = document.getElementById('agent-engine-hardstop');
      if (engineHardstop) {
        engineHardstop.addEventListener('click', async () => {
          const epicId = window.__sagaEpicId;
          if (!epicId) return;
          if (!confirm('Остановить немедленно? Активные воркеры будут убиты, их текущий ход потерян. Задачи останутся в очереди. Сначала попробуйте ⏸ (дожин без потерь).')) return;
          engineHardstop.disabled = true;
          stopDrainPolling();
          runnerStatus.textContent = 'жёсткий стоп…';
          try {
            const r = await fetch('/api/factory/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ epic_id: epicId }),
            });
            const d = await r.json();
            if (!r.ok || !d.ok) throw new Error(d.error || 'не удалось остановить');
            syncEngineToggleButton(false);
            runnerStatus.textContent = 'движок остановлен (жёстко)';
          } catch (e) {
            alert('Жёсткий стоп: ' + e.message);
            runnerStatus.textContent = 'ошибка';
          } finally {
            engineHardstop.disabled = false;
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
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({model: modelId, epic_id: window.__sagaEpicId}),
            });
            const data = await r.json();
            if (!r.ok || !data.ok) throw new Error(data.error || 'смена не удалась');
            // The model limit is a CEILING, not a forced value — only clamp the
            // concurrency selector down if the user's current pick exceeds the
            // new model's limit. Otherwise leave it alone.
            if (runnerConcurrency) {
              const cur = Number(runnerConcurrency.value) || 1;
              if (cur > limit) runnerConcurrency.value = String(limit);
            }
            runnerStatus.textContent = data.model + ' ×' + data.limit;
          } catch (e) {
            alert('Смена модели: ' + e.message);
            runnerStatus.textContent = 'ошибка';
          } finally {
            modelSelect.disabled = false;
          }
        });
      }
      fetchEngineStatus();
      setInterval(fetchEngineStatus, 2000);
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
          // ...and the episode-progress-bar (so the needs-human badge /
          // gate-blocked badge update without a full page reload).
          const oldBar = document.querySelector('.episode-progress-bar');
          const newBar = tmp.querySelector('.episode-progress-bar');
          if (oldBar && newBar) {
            oldBar.replaceWith(newBar);
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
        <div class="tc-com-body">${_renderMarkdown ? _renderMarkdown(c.content) : ''}</div>
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
            <div class="tc-description wiki-content">${_renderMarkdown ? _renderMarkdown(task.description) : ''}</div>
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
      .monitor-panel .mp-workers{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px}

      /* === Pipeline: full-width strip under the board header ===
         Moved out of the cramped 360px right sidebar so the lifecycle
         stages are readable at a glance. Sits between .board-head and
         .episode-progress-bar. Horizontally scrollable when many stages. */
      .board-pipeline{display:flex;align-items:flex-start;gap:14px;padding:12px 20px;background:#0d1117;border-bottom:1px solid #30363d}
      .board-pipeline .bp-title{color:#8b949e;text-transform:uppercase;font-size:10px;letter-spacing:.5px;font-weight:600;padding-top:7px;flex-shrink:0}
      .board-pipeline .pipeline-bar{flex:1;min-width:0;padding:4px 0;align-items:flex-start}
      .board-pipeline .pipeline-stage{min-width:78px;padding:6px 8px}
      .board-pipeline .pipeline-stage .ps-name{font-size:11px}
      .board-pipeline .pipeline-arrow{margin-top:0}

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
    </style>
    <link rel="stylesheet" href="/lifecycle-pipeline/pipeline.css"></head>
    <body class="with-monitor">${body}
    <aside class="monitor-panel" id="monitor-panel">
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

  // Two-phase init: artifactApi is constructed AFTER boardApi (it needs page),
  // then tracker-view.mjs calls boardApi.setRenderMarkdown(artifactApi.renderMarkdown)
  // so renderTaskView can call the real markdown renderer at request time.
  function setRenderMarkdown(fn) { _renderMarkdown = fn; }
  // Two-phase init: modelApi is constructed AFTER boardApi (modelApi needs
  // WORKER_MODEL, which lives here). tracker-view.mjs calls
  // boardApi.setModelApi(modelApi) once modelApi exists. renderBoard reads it
  // at request time only.
  function setModelApi(api) { _modelApi = api; }

  return {
    renderIndex,
    engineControlStateForEpic,
    resolveWorkerModel,
    WORKER_MODEL,
    renderBoard,
    renderTaskView,
    page,
    STAGE_DESCRIPTIONS,
    renderRegistry,
    loadCoverageMatrix,
    renderStageDescriptionBlock,
    renderStageDetailPage,
    renderCoverage,
    loadAcceptanceRegistry,
    computeAcceptance,
    renderAcceptance,
    setRenderMarkdown,
    setModelApi,
  };
}
