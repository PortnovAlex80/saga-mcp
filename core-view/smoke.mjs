// smoke.mjs — самопроверка core-view на ephemeral порту (НЕ 4323).
//
// Поднимает реальный сервер (тот же код, что и в проде), дёргает все эндпоинты,
// проверяет форму ответов по SPEC, печатает сводку и выходит. Если живой БД нет —
// проверяет деградацию ({ok:false,error} с кодом 200), не падает.
//
// Запуск из корня репо: node core-view/smoke.mjs

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCoreViewServer } from './server.mjs';
import { dbAvailable, resolveDbPath } from './core-snapshot.mjs';

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function requireKeys(obj, keys) {
  const missing = keys.filter(k => !(k in obj));
  return missing.length ? `missing keys: ${missing.join(',')}` : null;
}

function isIsoOrNull(v) {
  return v == null || (typeof v === 'string' && !isNaN(Date.parse(v)));
}

async function getJson(base, query) {
  const res = await fetch(base + query, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json, text };
}

async function main() {
  const dbPath = resolveDbPath();
  const dbOk = dbAvailable(dbPath);
  console.log(`[smoke] db: ${dbPath} (${dbOk ? 'live' : 'missing — проверяем деградацию'})`);

  const { server } = createCoreViewServer({ port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] server on ephemeral port ${port}`);

  let failed = 0;
  const finish = (name, cond, detail) => {
    record(name, cond, detail);
    if (!cond) failed += 1;
  };

  try {
    // --- heartbeat ---
    {
      const { status, json } = await getJson(base, '/api/core/heartbeat');
      const shapeOk = status === 200 && json && typeof json.ok === 'boolean'
        && json.db && typeof json.db.path === 'string' && typeof json.db.exists === 'boolean'
        && typeof json.projects === 'number' && typeof json.now === 'string';
      const semanticsOk = !dbOk || (json.ok === true && json.projects > 0);
      finish('GET /api/core/heartbeat', shapeOk && (dbOk ? semanticsOk && json.ok === true : json.ok === false),
        json ? `projects=${json.projects} db.exists=${json.db?.exists}` : `status=${status}`);
    }

    // --- projects ---
    let firstProjectId = null;
    {
      const { status, json } = await getJson(base, '/api/core/projects');
      let shapeOk = status === 200 && json && json.ok === true && Array.isArray(json.projects);
      if (shapeOk && json.projects.length) {
        const p = json.projects[0];
        shapeOk = !requireKeys(p, ['id', 'name', 'lifecycle', 'tasks', 'lastHeartbeatAt'])
          && !requireKeys(p.tasks, ['total', 'done'])
          && (p.lifecycle == null || !requireKeys(p.lifecycle, ['runId', 'status', 'currentStageId', 'terminalStatus', 'updatedAt']));
        firstProjectId = json.projects[0].id;
      }
      finish('GET /api/core/projects', dbOk ? shapeOk && json.ok === true : json.ok === false,
        json && Array.isArray(json.projects) ? `${json.projects.length} projects, first id=${json.projects[0]?.id}` : `status=${status}`);
    }

    // --- snapshot (default project) ---
    let sampleWorkplaceRef = null;
    let snapshotCounts = '';
    {
      const { status, json } = await getJson(base, '/api/core/snapshot');
      let shapeOk = status === 200 && json && json.ok === true
        && !requireKeys(json, ['now', 'project', 'lifecycle', 'workplaces', 'dependencies', 'workers', 'counters', 'pulse'])
        && !requireKeys(json.project, ['id', 'name', 'epicId'])
        && Array.isArray(json.workplaces) && Array.isArray(json.dependencies) && Array.isArray(json.workers);
      if (shapeOk && json.lifecycle) {
        shapeOk = !requireKeys(json.lifecycle, ['runId', 'status', 'currentStageId', 'terminalStatus', 'updatedAt', 'stages'])
          && Array.isArray(json.lifecycle.stages);
        const st = json.lifecycle.stages[0];
        if (st) shapeOk = shapeOk && !requireKeys(st, ['stageRunId', 'stageId', 'name', 'status', 'attempt', 'outcome', 'startedAt', 'completedAt']);
      }
      if (shapeOk && json.workplaces.length) {
        const w = json.workplaces[0];
        shapeOk = !requireKeys(w, ['workplaceRef', 'processRunId', 'moduleRef', 'productionCellId', 'workKey', 'taskId',
          'kanbanPhase', 'loopState', 'nextRole', 'terminalReason', 'revision', 'createdAt', 'updatedAt',
          'obligation', 'worker', 'lastGate', 'stats'])
          && !requireKeys(w.stats, ['candidateSets', 'gateDecisions', 'repairs'])
          && (w.worker == null || !requireKeys(w.worker, ['executionId', 'state', 'phase', 'pid', 'heartbeatAt', 'heartbeatAgeMs', 'alive']))
          && (w.obligation == null || !requireKeys(w.obligation, ['kind', 'state', 'leaseOwner', 'attempt', 'lastError']))
          && (w.lastGate == null || !requireKeys(w.lastGate, ['gatePhase', 'verdict', 'decidedAt']))
          && isIsoOrNull(w.updatedAt);
        sampleWorkplaceRef = w.workplaceRef;
      }
      if (shapeOk && json.workers.length) {
        shapeOk = !requireKeys(json.workers[0], ['executionId', 'projectId', 'taskId', 'state', 'phase', 'pid',
          'startedAt', 'heartbeatAt', 'heartbeatAgeMs', 'alive', 'tokPerSec', 'logPath', 'logMtimeAgeMs', 'stale']);
      }
      if (shapeOk) {
        shapeOk = !requireKeys(json.counters, ['replayCapsules', 'finalAcceptances', 'recoveryCases', 'candidateSets', 'gateDecisions'])
          && !requireKeys(json.pulse, ['lastActivityAt', 'activityPerMin']);
      }
      snapshotCounts = json ? `project=${json.project?.id}(${json.project?.name}) workplaces=${json.workplaces?.length} deps=${json.dependencies?.length} workers=${json.workers?.length} counters=${JSON.stringify(json.counters)}` : '';
      finish('GET /api/core/snapshot (default)', dbOk ? shapeOk && json.ok === true : json?.ok === false, snapshotCounts);
    }

    // --- snapshot?project=<id> ---
    if (firstProjectId != null) {
      const { status, json } = await getJson(base, `/api/core/snapshot?project=${firstProjectId}`);
      finish('GET /api/core/snapshot?project=' + firstProjectId,
        status === 200 && json?.ok === true && json?.project?.id === firstProjectId,
        `workplaces=${json?.workplaces?.length}`);
    }

    // --- snapshot?project=<bad> ---
    {
      const { status, json } = await getJson(base, '/api/core/snapshot?project=abc');
      finish('GET /api/core/snapshot?project=abc (bad param)',
        status === 400 && json?.ok === false, `status=${status}`);
    }

    // --- events ---
    {
      const { status, json } = await getJson(base, '/api/core/events');
      let shapeOk = status === 200 && json && json.ok === true && Array.isArray(json.events) && typeof json.now === 'string';
      if (shapeOk && json.events.length) {
        shapeOk = json.events.every(e => 'key' in e && 'at' in e && 'kind' in e && 'title' in e
          && 'detail' in e && 'entityType' in e && 'entityId' in e
          && ['activity', 'gate', 'transition'].includes(e.kind)
          && !isNaN(Date.parse(e.at)));
      }
      const kinds = {};
      if (json?.events) for (const e of json.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      finish('GET /api/core/events', dbOk ? shapeOk && json.ok === true : json?.ok === false,
        json ? `${json.events.length} events ${JSON.stringify(kinds)}` : `status=${status}`);
    }

    // --- events?since=<ISO-1h>&limit=5 ---
    {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { status, json } = await getJson(base, `/api/core/events?since=${encodeURIComponent(since)}&limit=5`);
      const shapeOk = status === 200 && json?.ok === true && Array.isArray(json?.events)
        && json.events.length <= 5;
      finish('GET /api/core/events?since=…&limit=5', shapeOk, `returned=${json?.events?.length}`);
    }

    // --- cell ---
    if (sampleWorkplaceRef) {
      const { status, json } = await getJson(base, `/api/core/cell?workplace=${encodeURIComponent(sampleWorkplaceRef)}`);
      let shapeOk = status === 200 && json && json.ok === true
        && !requireKeys(json, ['now', 'workplace', 'candidates', 'gates', 'executions', 'recovery', 'effects', 'finalAcceptance', 'logTail'])
        && json.workplace?.workplaceRef === sampleWorkplaceRef
        && Array.isArray(json.candidates) && Array.isArray(json.gates) && Array.isArray(json.executions)
        && Array.isArray(json.recovery) && Array.isArray(json.effects);
      if (shapeOk && json.candidates.length) {
        shapeOk = !requireKeys(json.candidates[0], ['candidateSetRef', 'role', 'digest', 'sealedAt', 'members']);
      }
      if (shapeOk && json.gates.length) {
        shapeOk = !requireKeys(json.gates[0], ['gateRunRef', 'gatePhase', 'verdict', 'repairTargetRole', 'decidedAt']);
      }
      if (shapeOk && json.executions.length) {
        shapeOk = !requireKeys(json.executions[0], ['executionId', 'state', 'workerId', 'pid', 'startedAt', 'finishedAt', 'logPath', 'meta']);
      }
      finish('GET /api/core/cell?workplace=…', shapeOk,
        `candidates=${json?.candidates?.length} gates=${json?.gates?.length} executions=${json?.executions?.length} effects=${json?.effects?.length} logTail=${json?.logTail ? json.logTail.lines.length + ' lines' : 'null'}`);
    }

    // --- cell without param ---
    {
      const { status, json } = await getJson(base, '/api/core/cell');
      finish('GET /api/core/cell (no param)', status === 400 && json?.ok === false, `status=${status}`);
    }

    // --- static: / и traversal ---
    {
      const indexExists = existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html'));
      const res1 = await fetch(base + '/', { signal: AbortSignal.timeout(10_000) });
      const staticOk = indexExists ? (res1.status === 200 && (res1.headers.get('content-type') || '').includes('text/html'))
        : res1.status === 404;
      finish('GET / (static)', staticOk, `public/index.html ${indexExists ? 'exists' : 'absent (ожидаем 404)'}, status=${res1.status}`);
      await res1.text();

      const res2 = await fetch(base + '/%2e%2e/server.mjs', { signal: AbortSignal.timeout(10_000) });
      const traversalOk = res2.status === 404;
      finish('GET /../server.mjs (traversal guard)', traversalOk, `status=${res2.status}`);
      await res2.text();

      const res3 = await fetch(base + '/api/core/nope', { signal: AbortSignal.timeout(10_000) });
      finish('GET /api/core/nope (unknown)', res3.status === 404, `status=${res3.status}`);
      await res3.text();
    }
  } catch (error) {
    record('unhandled smoke error', false, error.message);
    failed += 1;
  } finally {
    server.close();
  }

  const passed = results.length - failed;
  console.log(`\n[smoke] ${passed}/${results.length} checks passed (db ${dbOk ? 'live' : 'missing'})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('[smoke] fatal:', error);
  process.exit(1);
});
