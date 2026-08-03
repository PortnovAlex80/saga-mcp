// Admin endpoints API extracted from tracker-view.mjs (T10 step 4).
//
// This module owns everything related to the /admin HTML page and the
// project/epic CRUD HTTP endpoints exposed under /api/project/*, /api/epic/*,
// and /api/admin/*. Concretely:
//   - renderAdmin(projects, flash)         — renders the admin HTML page
//   - handleProjectCreate                  — POST /api/project/create
//   - handleProjectArchive                 — POST /api/project/archive
//   - handleProjectDelete                  — POST /api/project/delete
//   - handleAdminPurgeAllProjects          — POST /api/admin/purge-all-projects
//   - handleEpicCreate                     — POST /api/epic/create
//   - handleProjectCreateFromIdea          — POST /api/project/create-from-idea
//   - rollbackCreatedProjectAggregate()    — internal helper for idea bootstrap
//
// It depends only on:
//   - ./shared.mjs (withDb / withDbWrite / respondJson / esc / DEV_ROOT)
//   - ./git-bootstrap.mjs (ensureInitializedGitRepository)
//   - the dist lifecycle starters (requiresBackgroundEngine,
//     startProductLifecycleFromIdea, createSpawnCliLifecycleRunStarter)
//   - the injected runtimeConfig + DB_PATH (composition root in tracker-view.mjs)
//   - the injected page(title, body) HTML wrapper (still owned by tracker-view.mjs)
//
// No HTTP server, no routing — the route strings stay in tracker-view.mjs as
// test anchors.
import path from 'node:path';

import {
  withDb, withDbWrite,
  respondJson,
  esc,
  DEV_ROOT,
} from './shared.mjs';
import { ensureInitializedGitRepository } from './git-bootstrap.mjs';
import { requiresBackgroundEngine } from '../dist/runtime/orchestration-mode.js';
import { startProductLifecycleFromIdea } from '../dist/app/start-product-lifecycle-from-idea.js';
import { createSpawnCliLifecycleRunStarter } from '../dist/app/product-lifecycle-run-starter.js';

export function createAdminEndpointsApi({ runtimeConfig, dbPath, page }) {
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
          <div class="admin-card-head"><span class="admin-ic">🚀</span> Idea → Engine (3.0)</div>
          <label class="ed-field"><span>Имя проекта *</span><input type="text" name="name" required placeholder="напр. water-cannon" autocomplete="off"></label>
          <label class="ed-field"><span>Идея (одной фразой) *</span><textarea name="idea" required rows="3" placeholder="напр. мини автокад 3д для прототипирования" autocomplete="off"></textarea></label>
          <label class="ed-field"><span>Локальный путь (опц.)</span><input type="text" name="local_path" placeholder="по умолч. D:/Development/&lt;name&gt;" autocomplete="off"></label>
          <div class="admin-hint">
            Создаёт project + repo + epic + discovery.kickstart задачу одной транзакцией.
            Запускает автономный движок в background — он сам прогонит
            kickstart → PRD → UC/AC → SRS → planning → dev → verify → integration, ADR-014.
            (После cutover saga4 существует один режим <code>saga3-lifecycle</code>;
            движок стартует всегда.)
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
              const mode = j.orchestration_mode || 'saga3-lifecycle';
              // Mirrors server-side requiresBackgroundEngine(): after the saga4
              // cutover there is exactly ONE mode ('saga3-lifecycle') and it
              // always spawns the background engine. Display-only; the server is
              // the authority on whether the engine actually started.
              const hasBgEngine = true;
              const engineMsg = hasBgEngine
                ? (j.engine_spawned ? 'движок запущен (' + mode + ', pid=' + j.engine_pid + ')' : 'движок НЕ запущен — проверь лог')
                : '';
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
  // Safety: rejects (409) while a durable Product Lifecycle is created/running.
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

          // Saga4 guard: LifecycleRun is the execution authority. Do not
          // delete a project while an orchestrator may still own its ProcessRuns.
          const running = db.prepare(
            `SELECT DISTINCT epic_id
               FROM saga3_lifecycle_runs
              WHERE project_id = ?
                AND status IN ('created','running')`,
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
            error: `Сначала завершите или отмените Product Lifecycle для scope: ${result.engineRunning.map(id => id ?? '<project>').join(', ')}`,
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

  // --- POST /api/admin/purge-all-projects: cascade-delete EVERY project ---
  // Admin/operator escape hatch for resetting the board to empty (test fixtures,
  // clean D-slice smoke runs). Iterates every project and runs the SAME cascade
  // cleanup as /api/project/delete (work_attempts → worker_executions → projects
  // CASCADE, which also drops saga3_work_intents/saga3_proposals via epic/task
  // CASCADE). Returns the per-project outcome + the global seed rows preserved.
  //
  // Safety:
  //   - rejects (409) if ANY durable Product Lifecycle is created/running —
  //     operator must complete or cancel it before destructive cleanup;
  //   - never deletes platform_policies / global trusted_providers (NULL
  //     project_id) — saga needs those at bootstrap;
  //   - does NOT touch on-disk .md files or machine checkouts; returns the list
  //     of deregistered checkouts so the operator can rm them separately.
  //
  // NOT touched (by design, mirrors /api/project/delete):
  //   repositories rows (P17 resource), activity_log (P12 audit), command_receipts
  //   (idempotency ledger), on-disk artifact docs.
  function handleAdminPurgeAllProjects(req, res) {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const result = withDbWrite(db => {
          // Global Saga4 guard: lifecycle state, not episode metadata, owns
          // whether destructive cleanup is safe.
          const running = db.prepare(
            `SELECT DISTINCT epic_id, project_id
               FROM saga3_lifecycle_runs
              WHERE status IN ('created','running')`,
          ).all();
          if (running.length > 0) {
            return { engineRunning: running };
          }

          const projects = db.prepare('SELECT id, name FROM projects ORDER BY id').all();
          const checkouts = [];
          const deleted = [];
          for (const p of projects) {
            // Capture this project's checkouts before delete.
            const pco = db.prepare(
              `SELECT rc.machine_id, rc.local_path
                 FROM repository_checkouts rc
                 JOIN project_repositories pr ON pr.id = rc.project_repository_id
                WHERE pr.project_id = ?`,
            ).all(p.id);
            checkouts.push(...pco);

            // Same manual cleanup as handleProjectDelete (no-FK columns first).
            db.prepare(
              `DELETE FROM work_attempts
                WHERE execution_id IN (
                  SELECT execution_id FROM worker_executions WHERE project_id=?
                )`
            ).run(p.id);
            db.prepare('DELETE FROM worker_executions WHERE project_id=?').run(p.id);
            // DELETE FROM projects fires every ON DELETE CASCADE: epics → tasks →
            // (subtasks, deps, comments, conflict_keys, verification_evidence,
            //  task_work_items, human_requests, integration_intents), epics →
            // artifacts → traces, epics → episode_workflows, epics →
            // runtime_observations, epics → saga3_work_intents → saga3_proposals,
            // project_repositories → repository_checkouts, trusted_providers
            // (project-scoped only; global NULL-project_id rows survive).
            db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
            deleted.push({ id: p.id, name: p.name });
          }

          // Audit the bulk purge as one entry.
          db.prepare(
            "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', 0, 'purge_all', ?)"
          ).run(`Каскадное удаление всех проектов через /api/admin/purge-all-projects: ${deleted.length} проект(ов) [${deleted.map(d => d.name).join(', ')}]`);

          return { deleted, checkouts };
        });

        if (result.engineRunning) {
          const list = result.engineRunning.map(r => `epic ${r.epic_id} (project ${r.project_id})`).join(', ');
          return respondJson(res, 409, {
            ok:false,
            error: `Сначала остановите все движки: ${list}`,
            running: result.engineRunning,
          });
        }
        respondJson(res, 200, {
          ok: true,
          deleted: result.deleted,
          deregistered_checkouts: result.checkouts,
          note: 'platform_policies и глобальные trusted_providers сохранены. .md-файлы и machine checkouts на диске не тронуты.',
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


  // --- POST /api/project/create-from-idea: one-shot bootstrap для Saga4 ---
  // Поля: name (обяз.), idea (обяз.), local_path (опц., по умолчанию DEV_ROOT/<name>).
  //
  // Создаёт project/repository/epic, инициализирует реальный Git checkout с
  // первым commit (если HEAD ещё отсутствует), затем запускает единственный
  // Product Lifecycle runtime. `episode_workflows` здесь не создаётся: durable
  // LifecycleRun является единственной записью оркестрации нового проекта.
  function rollbackCreatedProjectAggregate({ projectId, repoId }) {
    withDbWrite(db => {
      db.prepare(
        "DELETE FROM activity_log WHERE entity_type='project' AND entity_id=?",
      ).run(projectId);
      db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      db.prepare(
        `DELETE FROM repositories
          WHERE id=?
            AND NOT EXISTS (
              SELECT 1 FROM project_repositories WHERE repository_id=?
            )`,
      ).run(repoId, repoId);
    });
  }

  function handleProjectCreateFromIdea(req, res) {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
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
             VALUES (?, ?, 'control', ?, 'main', 'active')`,
          ).run(projectId, repoId, localPath);

          // 3. epic
          const epicInfo = db.prepare(
            "INSERT INTO epics (project_id, name, description, status, priority) VALUES (?, ?, ?, 'planned', 'high')"
          ).run(projectId, `REQ-001-${name}`, `Discovery: ${idea}`);
          const epicId = Number(epicInfo.lastInsertRowid);

          // No episode_workflows row and no legacy discovery.kickstart task.
          // The Product Lifecycle owns orchestration state and task projection.
          // Activity is recorded only after the durable LifecycleRun has started,
          // so a failed bootstrap leaves no successful-creation audit record.
          return { projectId, repoId, epicId, taskId: null };
        });

        if (result.dup) {
          return respondJson(res, 409, { ok:false, error: `Проект «${name}» уже существует` });
        }

        // Lifecycle input pins a real Git HEAD before Discovery starts.
        try {
          ensureInitializedGitRepository(localPath, name);
        } catch (e) {
          // The aggregate is unusable without a repository capability. Remove
          // project/epic/binding and the now-unreferenced repository registry row.
          try {
            rollbackCreatedProjectAggregate(result);
          } catch (cleanupError) {
            console.error(
              `[create-from-idea] rollback project ${result.projectId} failed: ${cleanupError.message}`,
            );
          }
          return respondJson(res, 500, {
            ok: false,
            error: `git bootstrap: ${e.message}`,
          });
        }

        // The bare idea is assembled into a validated Product Delivery input,
        // including the real repository binding/current Git HEAD and an explicit
        // deferred Delivery profile. The spawn starter acknowledges only after
        // the LifecycleRun has been durably persisted.
        const mode = runtimeConfig.orchestrationMode;
        let lifecycleStarted = false;
        let lifecycleRunId = null;
        if (requiresBackgroundEngine(mode)) {
          try {
            const starter = createSpawnCliLifecycleRunStarter({
              dbPath,
              baseEnv: process.env,
            });
            const started = await startProductLifecycleFromIdea({
              projectId: result.projectId,
              epicId: result.epicId,
              idea,
              initiatedBy: `create-from-idea:${result.projectId}`,
              concurrency: 4,
              starter,
            });
            lifecycleStarted = true;
            lifecycleRunId = started.lifecycleRunId;
          } catch (e) {
            console.error(`[create-from-idea] lifecycle start failed: ${e.message}`);
            try {
              rollbackCreatedProjectAggregate(result);
            } catch (cleanupError) {
              console.error(
                `[create-from-idea] rollback project ${result.projectId} failed: ${cleanupError.message}`,
              );
            }
            return respondJson(res, 500, {
              ok: false,
              error: `lifecycle start: ${e.message}`,
            });
          }
        }

        withDbWrite(db => db.prepare(
          "INSERT INTO activity_log (entity_type, entity_id, action, summary) VALUES ('project', ?, 'created', ?)",
        ).run(
          result.projectId,
          `Создан проект «${name}» через веб-форму idea → Product Lifecycle`,
        ));

        respondJson(res, 200, {
          ok: true,
          project_id: result.projectId,
          repo_id: result.repoId,
          epic_id: result.epicId,
          task_id: result.taskId,
          orchestration_mode: mode,
          lifecycle_started: lifecycleStarted,
          lifecycle_run_id: lifecycleRunId,
          start_error: null,
          local_path: localPath,
        });
      } catch (e) {
        respondJson(res, 500, { ok:false, error: 'db: ' + e.message });
      }
    });
  }

  return {
    handleProjectCreate,
    handleProjectArchive,
    handleProjectDelete,
    handleAdminPurgeAllProjects,
    handleEpicCreate,
    handleProjectCreateFromIdea,
    renderAdmin,
  };
}
