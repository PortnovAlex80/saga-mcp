// Tracker-view administration and the one-shot "idea on a napkin" factory
// bootstrap. The factory start endpoint creates the durable aggregate, freezes
// the model route, and only then starts Product Delivery.

import path from 'node:path';

import {
  withDbWrite,
  respondJson,
  esc,
  DEV_ROOT,
} from './shared.mjs';
import { ensureInitializedGitRepository } from './git-bootstrap.mjs';
import { requiresBackgroundEngine } from '../dist/runtime/orchestration-mode.js';
import { startProductLifecycleFromIdea } from '../dist/app/start-product-lifecycle-from-idea.js';
import { createSpawnCliLifecycleRunStarter } from '../dist/app/product-lifecycle-run-starter.js';

const FACTORY_MODELS = Object.freeze([
  Object.freeze({
    id: 'glm-4.7',
    label: 'GLM 4.7 — рекомендуется для первого запуска',
    provider: 'zai',
    effort: 'high',
    limit: 10,
  }),
  Object.freeze({
    id: 'glm-5-turbo',
    label: 'GLM 5 Turbo',
    provider: 'zai',
    effort: 'high',
    limit: 5,
  }),
  Object.freeze({
    id: 'glm-5.2',
    label: 'GLM 5.2',
    provider: 'zai',
    effort: 'high',
    limit: 3,
  }),
]);
const DEFAULT_FACTORY_MODEL = 'glm-4.7';
const DEFAULT_FACTORY_CONCURRENCY = 4;

function factoryModel(modelId) {
  return FACTORY_MODELS.find(model => model.id === modelId) ?? null;
}

function modelEnvironment(modelId) {
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    CLAUDE_CODE_SUBAGENT_MODEL: modelId,
  };
}

function configureFactoryControl(db, epicId, model, concurrency) {
  db.prepare(
    `INSERT INTO lifecycle_execution_controls
       (epic_id, engine_state, concurrency, model_provider, model_name,
        model_effort, model_concurrency_limit)
     VALUES (?, 'stopped', ?, ?, ?, ?, ?)
     ON CONFLICT(epic_id) DO UPDATE SET
       concurrency=excluded.concurrency,
       model_provider=excluded.model_provider,
       model_name=excluded.model_name,
       model_effort=excluded.model_effort,
       model_concurrency_limit=excluded.model_concurrency_limit,
       updated_at=datetime('now')`,
  ).run(
    epicId,
    concurrency,
    model.provider,
    model.id,
    model.effort,
    model.limit,
  );
}

function parseRequest(req, callback) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      try {
        callback(JSON.parse(raw));
      } catch {
        callback({});
      }
      return;
    }
    callback(Object.fromEntries(new URLSearchParams(raw)));
  });
}

function legacyWorkAttemptsExist(db) {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='work_attempts'`,
  ).get());
}

export function createAdminEndpointsApi({ runtimeConfig, dbPath, page }) {
  function renderAdmin(projects, flash) {
    const projectOptions = projects
      .map(project => `<option value="${project.id}">${esc(project.name)}</option>`)
      .join('');
    const modelOptions = FACTORY_MODELS.map(model =>
      `<option value="${esc(model.id)}"${model.id === DEFAULT_FACTORY_MODEL ? ' selected' : ''}>${esc(model.label)} · max ${model.limit}</option>`)
      .join('');
    const concurrencyOptions = [1, 2, 3, 4, 5, 6, 8, 10]
      .map(value => `<option value="${value}"${value === DEFAULT_FACTORY_CONCURRENCY ? ' selected' : ''}>${value}</option>`)
      .join('');
    const header = `
      <div class="board-head">
        <a href="/" class="back">← Все проекты</a>
        <span class="cur-proj">⚙ Администрирование</span>
        <span style="flex:1"></span>
        <div class="heartbeat"><span id="hb-dot" class="hb-dot red"></span><span id="hb-txt">…</span></div>
      </div>`;

    return page('Администрирование', `
      ${header}
      ${flash ? `<div class="flash ${flash.kind || 'ok'}">${esc(flash.msg)}</div>` : ''}
      <div class="admin-wrap">
        <form class="admin-form" id="proj-form">
          <input type="hidden" name="action" value="project">
          <div class="admin-card-head"><span class="admin-ic">📦</span> Создать проект</div>
          <label class="ed-field"><span>Имя проекта *</span><input type="text" name="name" required placeholder="напр. my-new-product" autocomplete="off"></label>
          <label class="ed-field"><span>Описание</span><input type="text" name="description" placeholder="короткое описание (опц.)" autocomplete="off"></label>
          <div class="admin-hint">Статус по умолчанию: <code>active</code>. Имя должно быть уникальным.</div>
          <button type="submit" class="btn primary">➕ Создать проект</button>
        </form>

        <form class="admin-form" id="epic-form">
          <input type="hidden" name="action" value="epic">
          <div class="admin-card-head"><span class="admin-ic">🎯</span> Создать эпик</div>
          <label class="ed-field"><span>Проект *</span><select name="project_id" required>${projectOptions}</select></label>
          <label class="ed-field"><span>Имя эпика *</span><input type="text" name="name" required placeholder="напр. REQ-001-feature" autocomplete="off"></label>
          <label class="ed-field"><span>Описание</span><input type="text" name="description" placeholder="опц." autocomplete="off"></label>
          <label class="ed-field"><span>Ветка (опц.)</span><input type="text" name="branch" placeholder="напр. feature/x" autocomplete="off"></label>
          <div class="admin-hint">Создаёт только эпик. Завод автоматически не запускается.</div>
          <button type="submit" class="btn primary">➕ Создать эпик</button>
        </form>

        <form class="admin-form" id="idea-form">
          <input type="hidden" name="action" value="idea">
          <div class="admin-card-head"><span class="admin-ic">🏭</span> Идея на салфетке → запустить завод</div>
          <label class="ed-field"><span>Имя продукта *</span><input type="text" name="name" required placeholder="напр. water-cannon" autocomplete="off"></label>
          <label class="ed-field"><span>Идея / проблема *</span><textarea name="idea" required rows="4" placeholder="Опишите одной-двумя фразами, что нужно получить и для кого. Формальные требования не нужны." autocomplete="off"></textarea></label>
          <label class="ed-field"><span>Локальный путь (опц.)</span><input type="text" name="local_path" placeholder="по умолчанию D:/Development/&lt;name&gt;" autocomplete="off"></label>
          <label class="ed-field"><span>Модель первого и последующих workers *</span><select name="model" required>${modelOptions}</select></label>
          <label class="ed-field"><span>Параллельных workers *</span><select name="concurrency" required>${concurrencyOptions}</select></label>
          <div class="admin-hint">
            Кнопка создаёт project + repository + epic, фиксирует выбранную модель,
            материализует immutable lifecycle input и запускает один Product Delivery Lifecycle:
            <code>Discovery → Formalization → Development → Delivery</code>.
            Новая стартовая task вручную не создаётся: каждый цех сам материализует
            свои рабочие места. Завод продолжает работу, пока текущий цех не выпустит
            свой продукт либо не вернёт явный terminal/pause/human-required outcome.
          </div>
          <button type="submit" class="btn primary">🏭 Создать и запустить завод</button>
        </form>
      </div>

      <script>
      async function postForm(form) {
        const data = new URLSearchParams(new FormData(form));
        const button = form.querySelector('button[type=submit]');
        const action = data.get('action');
        const endpoint = action === 'project'
          ? '/api/project/create'
          : action === 'idea'
            ? '/api/project/create-from-idea'
            : '/api/epic/create';
        button.disabled = true;
        const oldText = button.textContent;
        button.textContent = action === 'idea' ? 'Запуск завода…' : 'Создание…';
        try {
          const response = await fetch(endpoint, { method:'POST', body:data });
          const result = await response.json();
          if (!result.ok) {
            button.disabled = false;
            button.textContent = oldText;
            alert('Ошибка: ' + (result.error || 'неизвестная'));
            return;
          }
          if (action === 'project') {
            location.href = '/?created=' + encodeURIComponent('проект «' + (result.name || '') + '»');
            return;
          }
          if (action === 'idea') {
            const lifecycle = result.lifecycle_run_id == null
              ? 'не подтверждён'
              : '#' + result.lifecycle_run_id;
            const message = 'Завод запущен. project=' + result.project_id
              + ' epic=' + result.epic_id
              + ' lifecycle=' + lifecycle
              + '\\nmodel=' + result.model
              + ' concurrency=' + result.concurrency;
            alert(message);
            location.href = '?project=' + result.project_id
              + '&created=' + encodeURIComponent(message);
            return;
          }
          location.href = '?project=' + result.project_id
            + '&created=' + encodeURIComponent('эпик «' + (result.name || '') + '»');
        } catch (error) {
          button.disabled = false;
          button.textContent = oldText;
          alert('Сеть: ' + error.message);
        }
      }
      document.getElementById('proj-form').addEventListener('submit', event => { event.preventDefault(); postForm(event.target); });
      document.getElementById('epic-form').addEventListener('submit', event => { event.preventDefault(); postForm(event.target); });
      document.getElementById('idea-form').addEventListener('submit', event => { event.preventDefault(); postForm(event.target); });
      </script>`);
  }

  function handleProjectCreate(req, res) {
    parseRequest(req, fields => {
      const name = (fields.name || '').toString().trim();
      const description = (fields.description || '').toString().trim();
      if (!name) {
        return respondJson(res, 400, { ok:false, error:'name обязательное поле' });
      }
      try {
        const result = withDbWrite(db => {
          const duplicate = db.prepare(
            'SELECT id FROM projects WHERE name=? COLLATE NOCASE',
          ).get(name);
          if (duplicate) return { duplicate:true };
          const info = db.prepare(
            "INSERT INTO projects (name,description,status) VALUES (?,?,'active')",
          ).run(name, description || null);
          const id = Number(info.lastInsertRowid);
          db.prepare(
            "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',?,'created',?)",
          ).run(id, `Создан проект «${name}» через tracker-view admin`);
          return { id };
        });
        if (result.duplicate) {
          return respondJson(res, 409, { ok:false, error:`Проект «${name}» уже существует` });
        }
        respondJson(res, 200, { ok:true, id:result.id, name });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
      }
    });
  }

  function handleProjectArchive(req, res) {
    parseRequest(req, fields => {
      const projectId = Number(fields.project_id);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        return respondJson(res, 400, { ok:false, error:'project_id должен быть положительным целым' });
      }
      try {
        const result = withDbWrite(db => {
          const project = db.prepare(
            'SELECT name,status FROM projects WHERE id=?',
          ).get(projectId);
          if (!project) return { notFound:true };
          if (project.status === 'archived') {
            return { alreadyArchived:true, name:project.name };
          }
          db.prepare(
            "UPDATE projects SET status='archived',updated_at=datetime('now') WHERE id=?",
          ).run(projectId);
          db.prepare(
            "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',?,'archived',?)",
          ).run(projectId, `Проект «${project.name}» архивирован`);
          return { name:project.name };
        });
        if (result.notFound) {
          return respondJson(res, 404, { ok:false, error:`Проект ${projectId} не найден` });
        }
        respondJson(res, 200, {
          ok:true,
          id:projectId,
          name:result.name,
          already_archived:Boolean(result.alreadyArchived),
        });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
      }
    });
  }

  function handleProjectDelete(req, res) {
    parseRequest(req, fields => {
      const projectId = Number(fields.project_id);
      if (!Number.isInteger(projectId) || projectId <= 0) {
        return respondJson(res, 400, { ok:false, error:'project_id должен быть положительным целым' });
      }
      try {
        const result = withDbWrite(db => {
          const project = db.prepare('SELECT name FROM projects WHERE id=?')
            .get(projectId);
          if (!project) return { notFound:true };

          const live = db.prepare(
            `SELECT DISTINCT epic_id
               FROM saga3_lifecycle_runs
              WHERE project_id=?
                AND status IN ('created','running','paused')`,
          ).all(projectId);
          if (live.length > 0) {
            return { lifecycleActive:live.map(row => row.epic_id) };
          }

          const checkouts = db.prepare(
            `SELECT rc.machine_id,rc.local_path
               FROM repository_checkouts rc
               JOIN project_repositories pr
                 ON pr.id=rc.project_repository_id
              WHERE pr.project_id=?`,
          ).all(projectId);
          if (legacyWorkAttemptsExist(db)) {
            db.prepare(
              `DELETE FROM work_attempts
                WHERE execution_id IN (
                  SELECT execution_id FROM worker_executions WHERE project_id=?
                )`,
            ).run(projectId);
          }
          db.prepare('DELETE FROM worker_executions WHERE project_id=?')
            .run(projectId);
          db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
          db.prepare(
            "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',?,'deleted',?)",
          ).run(projectId, `Проект «${project.name}» удалён`);
          return { name:project.name, checkouts };
        });
        if (result.notFound) {
          return respondJson(res, 404, { ok:false, error:`Проект ${projectId} не найден` });
        }
        if (result.lifecycleActive) {
          return respondJson(res, 409, {
            ok:false,
            error:'Сначала завершите или отмените Product Lifecycle. Paused run нужно resume, а не удалять.',
            running_epics:result.lifecycleActive,
          });
        }
        respondJson(res, 200, {
          ok:true,
          id:projectId,
          name:result.name,
          deregistered_checkouts:result.checkouts,
        });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
      }
    });
  }

  function handleAdminPurgeAllProjects(req, res) {
    parseRequest(req, () => {
      try {
        const result = withDbWrite(db => {
          const live = db.prepare(
            `SELECT DISTINCT epic_id,project_id
               FROM saga3_lifecycle_runs
              WHERE status IN ('created','running','paused')`,
          ).all();
          if (live.length > 0) return { lifecycleActive:live };

          const projects = db.prepare(
            'SELECT id,name FROM projects ORDER BY id',
          ).all();
          const checkouts = [];
          const deleted = [];
          const hasLegacyAttempts = legacyWorkAttemptsExist(db);
          for (const project of projects) {
            checkouts.push(...db.prepare(
              `SELECT rc.machine_id,rc.local_path
                 FROM repository_checkouts rc
                 JOIN project_repositories pr
                   ON pr.id=rc.project_repository_id
                WHERE pr.project_id=?`,
            ).all(project.id));
            if (hasLegacyAttempts) {
              db.prepare(
                `DELETE FROM work_attempts
                  WHERE execution_id IN (
                    SELECT execution_id FROM worker_executions WHERE project_id=?
                  )`,
              ).run(project.id);
            }
            db.prepare('DELETE FROM worker_executions WHERE project_id=?')
              .run(project.id);
            db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
            deleted.push({ id:project.id, name:project.name });
          }
          db.prepare(
            "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',0,'purge_all',?)",
          ).run(`Удалены все проекты: ${deleted.map(item => item.name).join(', ')}`);
          return { deleted, checkouts };
        });
        if (result.lifecycleActive) {
          return respondJson(res, 409, {
            ok:false,
            error:'Нельзя очищать доску при created/running/paused lifecycle.',
            running:result.lifecycleActive,
          });
        }
        respondJson(res, 200, {
          ok:true,
          deleted:result.deleted,
          deregistered_checkouts:result.checkouts,
          note:'Глобальные policies/providers и файлы рабочих копий не удалены.',
        });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
      }
    });
  }

  function handleEpicCreate(req, res) {
    parseRequest(req, fields => {
      const projectId = Number(fields.project_id);
      const name = (fields.name || '').toString().trim();
      const description = (fields.description || '').toString().trim();
      const branch = (fields.branch || '').toString().trim();
      if (!projectId) {
        return respondJson(res, 400, { ok:false, error:'project_id обязательное поле' });
      }
      if (!name) {
        return respondJson(res, 400, { ok:false, error:'name обязательное поле' });
      }
      try {
        const result = withDbWrite(db => {
          const project = db.prepare('SELECT id,name FROM projects WHERE id=?')
            .get(projectId);
          if (!project) return { missing:true };
          const info = db.prepare(
            "INSERT INTO epics (project_id,name,description,branch,status,priority) VALUES (?,?,?,?,'planned','medium')",
          ).run(projectId, name, description || null, branch || null);
          const id = Number(info.lastInsertRowid);
          db.prepare(
            "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('epic',?,'created',?)",
          ).run(id, `Создан эпик «${name}» в проекте «${project.name}»`);
          return { id };
        });
        if (result.missing) {
          return respondJson(res, 404, { ok:false, error:`Проект #${projectId} не найден` });
        }
        respondJson(res, 200, { ok:true, id:result.id, project_id:projectId, name });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
      }
    });
  }

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
    parseRequest(req, async fields => {
      const name = (fields.name || '').toString().trim();
      const idea = (fields.idea || '').toString().trim();
      const modelId = (fields.model || DEFAULT_FACTORY_MODEL)
        .toString()
        .trim();
      const selectedModel = factoryModel(modelId);
      const requestedConcurrency = Number(
        fields.concurrency || DEFAULT_FACTORY_CONCURRENCY,
      );
      if (!name) {
        return respondJson(res, 400, { ok:false, error:'name обязательное поле' });
      }
      if (!idea) {
        return respondJson(res, 400, { ok:false, error:'idea обязательное поле' });
      }
      if (!selectedModel) {
        return respondJson(res, 400, { ok:false, error:`Неизвестная модель: ${modelId}` });
      }
      if (
        !Number.isInteger(requestedConcurrency)
        || requestedConcurrency < 1
        || requestedConcurrency > 10
      ) {
        return respondJson(res, 400, { ok:false, error:'concurrency должен быть целым 1..10' });
      }
      const concurrency = Math.min(
        requestedConcurrency,
        selectedModel.limit,
      );
      const localPath = (fields.local_path || '').toString().trim()
        || path.join(DEV_ROOT, name);

      try {
        const result = withDbWrite(db => {
          const duplicate = db.prepare(
            'SELECT id FROM projects WHERE name=? COLLATE NOCASE',
          ).get(name);
          if (duplicate) return { duplicate:true };

          const projectInfo = db.prepare(
            "INSERT INTO projects (name,description,status) VALUES (?,?,'active')",
          ).run(name, idea);
          const projectId = Number(projectInfo.lastInsertRowid);

          const repoInfo = db.prepare(
            "INSERT INTO repositories (name,default_branch) VALUES (?,'main')",
          ).run(name);
          const repoId = Number(repoInfo.lastInsertRowid);
          db.prepare(
            `INSERT INTO project_repositories
               (project_id,repository_id,role,local_path,integration_branch,status)
             VALUES (?,?,'control',?,'main','active')`,
          ).run(projectId, repoId, localPath);

          const epicInfo = db.prepare(
            "INSERT INTO epics (project_id,name,description,status,priority) VALUES (?,?,?,'planned','high')",
          ).run(projectId, `REQ-001-${name}`, `Discovery: ${idea}`);
          const epicId = Number(epicInfo.lastInsertRowid);

          // The model route is durable before any LM task becomes claimable.
          configureFactoryControl(
            db,
            epicId,
            selectedModel,
            concurrency,
          );
          return { projectId, repoId, epicId, taskId:null };
        });

        if (result.duplicate) {
          return respondJson(res, 409, { ok:false, error:`Проект «${name}» уже существует` });
        }

        try {
          ensureInitializedGitRepository(localPath, name);
        } catch (error) {
          try {
            rollbackCreatedProjectAggregate(result);
          } catch (cleanupError) {
            console.error(
              `[create-from-idea] rollback project ${result.projectId} failed: ${cleanupError.message}`,
            );
          }
          return respondJson(res, 500, {
            ok:false,
            error:`git bootstrap: ${error.message}`,
          });
        }

        const mode = runtimeConfig.orchestrationMode;
        let lifecycleStarted = false;
        let lifecycleRunId = null;
        if (requiresBackgroundEngine(mode)) {
          try {
            const starter = createSpawnCliLifecycleRunStarter({
              dbPath,
              // Keep model selection scoped to this engine. Every worker also
              // receives the durable model route captured at claim time.
              baseEnv: {
                ...process.env,
                ...modelEnvironment(selectedModel.id),
              },
            });
            const started = await startProductLifecycleFromIdea({
              projectId:result.projectId,
              epicId:result.epicId,
              idea,
              initiatedBy:`create-from-idea:${result.projectId}`,
              concurrency,
              starter,
            });
            lifecycleStarted = true;
            lifecycleRunId = started.lifecycleRunId;
          } catch (error) {
            console.error(
              `[create-from-idea] lifecycle start failed: ${error.message}`,
            );
            try {
              rollbackCreatedProjectAggregate(result);
            } catch (cleanupError) {
              console.error(
                `[create-from-idea] rollback project ${result.projectId} failed: ${cleanupError.message}`,
              );
            }
            return respondJson(res, 500, {
              ok:false,
              error:`lifecycle start: ${error.message}`,
            });
          }
        }

        withDbWrite(db => db.prepare(
          "INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',?,'created',?)",
        ).run(
          result.projectId,
          `Создан завод «${name}»: model=${selectedModel.id}, concurrency=${concurrency}`,
        ));

        respondJson(res, 200, {
          ok:true,
          project_id:result.projectId,
          repo_id:result.repoId,
          epic_id:result.epicId,
          task_id:result.taskId,
          orchestration_mode:mode,
          lifecycle_started:lifecycleStarted,
          lifecycle_run_id:lifecycleRunId,
          start_error:null,
          local_path:localPath,
          model:selectedModel.id,
          model_provider:selectedModel.provider,
          model_limit:selectedModel.limit,
          requested_concurrency:requestedConcurrency,
          concurrency,
        });
      } catch (error) {
        respondJson(res, 500, { ok:false, error:'db: ' + error.message });
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
