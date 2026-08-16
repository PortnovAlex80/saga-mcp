// Operational control and observability endpoints.
import {
  existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import {
  withDb, withDbWrite,
  respondJson, readRequestFields, readJsonRequest,
  truncate, canonicalAllowedWorkerLogPath,
  resolveArtifactFile,
} from './shared.mjs';

// Lifecycle workers may be spawned while tracker-view runs under ESM; the
// inline `require('node:fs')` calls in handleWorkersActive were carried over
// verbatim from the monolith. createRequire lets us keep that exact shape
// (a fresh require call each time) without changing the code path.
const require = createRequire(import.meta.url);

export function createLifecycleEndpointsApi({
  sagaApplication,
  repositoryHandlers,
  workerLogRoots,
  isProcessAlive,
}) {
  // WORKER_LOG_ROOTS is computed once in tracker-view.mjs (canonical list of
  // allowed board-runs roots derived from runtimeConfig + the platform
  // default). We re-bind it here so handleWorkersActive's loop sees the same
  // array the canonicalAllowedWorkerLogPath helper honours.
  const WORKER_LOG_ROOTS = Array.isArray(workerLogRoots) ? workerLogRoots : [];

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
        } else {
          throw new Error(`Unknown operation ${operation}`);
        }
        respondJson(res, 200, { ok:true, result });
      } catch (error) {
        respondJson(res, 409, { ok:false, error:error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // --- Stage summary ---------------------------------------------------------
  // The /api/episode/stage-summary endpoint powers the "Что произошло на этой
  // стадии?" button in the UI. It returns one of:
  //   - { ok:true, status:'ready',      artifact_id, content, generated_at }
  //     // accepted summary artifact exists; .md body read off disk
  //   - { ok:true, status:'generating', task_id }  // artifact draft/in_review
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
        `SELECT e.id, e.project_id, e.name,
                COALESCE(
                  lr.current_stage_id,
                  lr.terminal_status,
                  CASE WHEN lr.status='created' THEN lr.entry_stage_id ELSE lr.status END
                ) AS current_stage
           FROM epics e
           LEFT JOIN factory_lifecycle_runs lr ON lr.id=(
             SELECT candidate.id
               FROM factory_lifecycle_runs candidate
              WHERE candidate.epic_id=e.id
              ORDER BY candidate.id DESC
              LIMIT 1
           )
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

  // --- Worker observation ----------------------------------------------------

  // GET /api/worker/tail?log_path=<path>&lines=8
  // Returns the last N events from a worker's stream-json JSONL log.
  // SECURITY: log_path must resolve inside the board-runs root (path traversal
  // guard). Each JSONL line is parsed minimally — we surface type, tool name
  // (for tool_use), and a short text snippet. Never return raw content.
  function handleWorkerTail(req, res, url) {
    const requestedPath = url.searchParams.get('log_path');
    const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 8, 1), 50);
    if (!requestedPath) return respondJson(res, 400, { ok:false, error:'log_path required' });

    if (!existsSync(path.resolve(requestedPath))) {
      return respondJson(res, 404, { ok:false, error:'log file not found (worker may not have written yet)' });
    }
    // Accept only the platform-configured orchestration log root and the
    // backwards-compatible board-runs root. realpath prevents symlink escape.
    const resolved = canonicalAllowedWorkerLogPath(requestedPath);
    if (!resolved) {
      return respondJson(res, 403, {
        ok:false,
        error:'log_path outside configured worker log roots',
      });
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

  // GET /api/workers/active?project_id=N
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
      const rows = withDb(db => db.prepare(
        `SELECT we.execution_id, we.task_id AS id, we.worker_id AS assigned_to,
                we.pid, we.machine_id, we.phase, we.started_at AS worker_started_at,
                we.log_path, t.title, t.status, t.task_kind, t.updated_at,
                e.name AS epic_name
         FROM worker_executions we
         LEFT JOIN tasks t ON t.id=we.task_id
         LEFT JOIN epics e ON e.id=we.epic_id
         WHERE we.project_id=? AND we.state IN ('running','cancel_requested')
         ORDER BY worker_started_at`,
      ).all(projectId))
        .filter(r => r.machine_id === os.hostname() && isProcessAlive(r.pid));
      // Resolve JSONL log path by scanning board-runs for a matching filename.
      // The newest matching file wins (workers reuse IDs across runs).
      const workers = rows.map(r => {
        const taskFilePattern = `task-${r.id}-${r.assigned_to.replace(/[^a-zA-Z0-9._-]+/g, '-')}.jsonl`;
        let logPath = r.log_path ? canonicalAllowedWorkerLogPath(r.log_path) : null;
        if (!logPath) {
          const runDirs = [];
          for (const logRoot of WORKER_LOG_ROOTS) {
            try {
              runDirs.push(...readdirSync(logRoot)
                .filter(d => d.startsWith(`board-${projectId}-`))
                .map(d => ({ full: path.join(logRoot, d), mtime: statSync(path.join(logRoot, d)).mtimeMs })));
            } catch { /* configured root missing or unreadable */ }
          }
          runDirs.sort((a, b) => b.mtime - a.mtime);
          for (const rd of runDirs) {
            const candidate = path.join(rd.full, taskFilePattern);
            const allowed = existsSync(candidate) ? canonicalAllowedWorkerLogPath(candidate) : null;
            if (allowed) { logPath = allowed; break; }
          }
        }
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

        // Token display: the authoritative source is the API-reported usage
        // in assistant/result events — these are CUMULATIVE counters, not
        // per-event deltas. thinking_tokens events carry small per-batch
        // deltas (26, 28, 33...) which are NOT totals; summing them from a
        // 128KB tail would miss most of the session. Instead we scan for
        // the LAST assistant/result event with a non-zero usage field.
        let tokens_per_sec = null;
        let total_tokens = null;
        if (logPath) {
          try {
            const fs2 = require('node:fs');
            const st2 = fs2.statSync(logPath);
            // Read up to 2MB tail — enough to find the last assistant event
            // even in long sessions with heavy tool_use logging
            const tailBytes2 = Math.min(st2.size, 2 * 1024 * 1024);
            const fd2 = fs2.openSync(logPath, 'r');
            const buf2 = Buffer.alloc(tailBytes2);
            fs2.readSync(fd2, buf2, 0, tailBytes2, Math.max(0, st2.size - tailBytes2));
            fs2.closeSync(fd2);
            const lines = buf2.toString('utf8').split('\n').filter(Boolean);

            // Priority: result.usage (definitive) > last assistant.message.usage
            // (cumulative from API) > thinking_tokens sum (rough estimate)
            let resultOutput = null;
            let resultInput = null;
            let lastAssistantOutput = null;
            let lastAssistantInput = null;
            let thinkingSum = 0;

            for (const line of lines) {
              try {
                const evt = JSON.parse(line);
                // result event: definitive usage at worker completion
                if (evt.type === 'result' && evt.usage) {
                  resultOutput = evt.usage.output_tokens ?? resultOutput;
                  resultInput = (evt.usage.input_tokens || 0)
                    + (evt.usage.cache_read_input_tokens || 0);
                }
                // assistant message: cumulative usage per API turn
                if (evt.type === 'assistant' && evt.message?.usage) {
                  const u = evt.message.usage;
                  if (u.output_tokens != null && u.output_tokens > 0) {
                    lastAssistantOutput = u.output_tokens;
                    lastAssistantInput = (u.input_tokens || 0)
                      + (u.cache_read_input_tokens || 0);
                  }
                }
                // thinking_tokens: per-event deltas, sum as fallback
                if (evt.type === 'system' && evt.subtype === 'thinking_tokens') {
                  thinkingSum += (evt.estimated_tokens || 0);
                }
              } catch { /* non-JSON */ }
            }

            // Pick the best available total (output tokens = what the model produced)
            const outputTokens = resultOutput ?? lastAssistantOutput
              ?? (thinkingSum > 0 ? thinkingSum : null);
            const inputTokens = resultInput ?? lastAssistantInput;

            if (outputTokens != null && outputTokens > 0) {
              total_tokens = outputTokens;
            } else {
              total_tokens = null;
            }

            // tokens_per_sec: output tokens / elapsed time
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

  // --- Engine control: thin HTTP adapter over EngineAdministration ---------

  function respondEngineError(res, error) {
    const code = error?.code;
    const status = code === 'epic_not_found' ? 404
      : (code === 'ambiguous_active_run' || code === 'active_run_mismatch') ? 409
      : (code === 'invalid_epic' || code === 'invalid_concurrency') ? 400
      : 500;
    respondJson(res, status, { ok: false, error: error?.message || String(error) });
  }

  function handleEngineStop(req, res) {
    readJsonRequest(req, fields => {
      try {
        const state = sagaApplication.stopEngine(Number(fields.epic_id));
        respondJson(res, 200, {
          ok: true,
          project_id: state.projectId,
          epic_id: state.epicId,
          running: state.running,
        });
      } catch (error) {
        respondEngineError(res, error);
      }
    });
  }

  function handleEngineConcurrency(req, res) {
    readJsonRequest(req, fields => {
      try {
        const state = sagaApplication.setEngineConcurrency(
          Number(fields.epic_id),
          Number(fields.concurrency),
        );
        respondJson(res, 200, {
          ok: true,
          epic_id: state.epicId,
          concurrency: state.concurrency,
        });
      } catch (error) {
        respondEngineError(res, error);
      }
    });
  }

  function handleEngineStatus(req, res, url) {
    try {
      const state = sagaApplication.getEngineStatus(
        Number(url.searchParams.get('epic_id')),
      );
      const route = withDb(db => db.prepare(
        `SELECT model_name AS model,
                model_provider AS provider,
                model_concurrency_limit AS model_limit
           FROM lifecycle_execution_controls WHERE epic_id=?`,
      ).get(state.epicId));
      // TB-3: a dead engine leaves its reason ONLY in
      // factory_launch_requests/factory_orders — surface the last failure so
      // the board shows WHY the factory is silent instead of a bare toggle.
      const launch = withDb(db => db.prepare(
        `SELECT l.state AS launch_state, l.error AS launch_error,
                l.completed_at AS launch_finished_at,
                o.state AS order_state, o.last_error AS order_error
           FROM factory_launch_requests l
           JOIN factory_orders o ON o.order_ref=l.order_ref
          WHERE l.project_id=(SELECT project_id FROM epics WHERE id=?)
          ORDER BY l.rowid DESC LIMIT 1`,
      ).get(state.epicId));
      // Antifreeze layer C: the raw engine_state (incl. 'failed_watchdog'),
      // its last_error, and the newest watchdog verdict — so the board shows
      // WHY a factory went silent after the supervisor exhausted its budget.
      // Guarded: an unmigrated DB has no watchdog table / last_error column.
      let control = null;
      let watchdog = null;
      try {
        control = withDb(db => db.prepare(
          `SELECT engine_state, last_error FROM lifecycle_execution_controls WHERE epic_id=?`,
        ).get(state.epicId));
        watchdog = withDb(db => db.prepare(
          `SELECT kind, reason, engine_pid, heartbeat_age_ms, created_at
             FROM factory_engine_watchdog_events
            WHERE epic_id=?
            ORDER BY rowid DESC LIMIT 1`,
        ).get(state.epicId));
      } catch { /* schema not migrated yet — stay with the legacy fields */ }
      respondJson(res, 200, {
        ok: true,
        epic_id: state.epicId,
        running: state.running,
        pid: state.pid,
        concurrency: state.concurrency,
        started_at: state.startedAt,
        alive: state.alive,
        engine_state: control?.engine_state ?? null,
        engine_error: control?.last_error ?? null,
        watchdog: watchdog ?? null,
        model: route?.model ?? null,
        provider: route?.provider ?? null,
        model_limit: route?.model_limit ?? null,
        last_launch: launch ? {
          state: launch.launch_state,
          error: launch.launch_error ?? launch.order_error ?? null,
          finished_at: launch.launch_finished_at,
          order_state: launch.order_state,
        } : null,
      });
    } catch (error) {
      respondEngineError(res, error);
    }
  }

  return {
    handleEngineStop,
    handleEngineConcurrency,
    handleEngineStatus,
    handleSagaOperation,
    handleWorkerTail,
    handleWorkersActive,
    handleStageSummary,
    STAGE_SUMMARY_CODE,
  };
}
