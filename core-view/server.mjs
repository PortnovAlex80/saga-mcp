// server.mjs — Factory Core View, пассивный наблюдатель за заводом (:4323).
//
// Только GET. Ни одного write-эндпоинта: БД открывается исключительно
// {readonly:true} и на каждый запрос (withCoreDb). Если БД недоступна —
// эндпоинт отвечает {ok:false, error} с кодом 200 (фронт показывает
// «завод недоступен», не падая).
//
// Статика: public/ с MIME-whitelist и защитой от traversal — подход
// tracker-view/lifecycle-pipeline/pipeline-api.mjs (containment + realpath).
//
// Запуск: node core-view/server.mjs  (порт 4323, bind 127.0.0.1;
// env CORE_VIEW_PORT, CORE_VIEW_DB). PID-файл core-view/.core-view.pid
// пишется на старте и удаляется на выходе. Порт 0 = ephemeral (для smoke).

import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_VIEW_DIR, resolveDbPath, dbAvailable, withCoreDb, buildSnapshot,
} from './core-snapshot.mjs';
import { buildProjects, buildHeartbeat } from './core-projects.mjs';
import { buildEvents } from './core-events.mjs';
import { buildCell } from './core-cell.mjs';
import { isProcessAlive } from './log-tail.mjs';

const DEFAULT_PORT = 4323;
const HOST = '127.0.0.1';
const PID_FILE = path.join(CORE_VIEW_DIR, '.core-view.pid');

// MIME-whitelist статики (SPEC): html,css,js,mjs,json,svg,png,ico
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function respondJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function respondNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

/** Обернуть сборщик ответа: любая ошибка → {ok:false,error} c кодом 200. */
function handleApi(res, dbPath, builder) {
  if (!dbAvailable(dbPath)) {
    respondJson(res, 200, { ok: false, error: `database unavailable: ${dbPath}` });
    return;
  }
  try {
    const payload = withCoreDb(dbPath, builder);
    respondJson(res, 200, payload);
  } catch (error) {
    respondJson(res, 200, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Статика из publicDir: containment + realpath (паттерн pipeline-api.mjs). */
function serveStatic(res, publicDir, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = 'index.html';
  if (rel.startsWith('/')) rel = rel.slice(1);
  if (!rel) return respondNotFound(res);

  const root = path.resolve(publicDir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return respondNotFound(res);
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext];
  if (!type) return respondNotFound(res);
  try {
    if (!existsSync(resolved) || !statSync(resolved).isFile()) return respondNotFound(res);
    const canonicalRoot = realpathSync(root);
    const canonicalFile = realpathSync(resolved);
    if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(canonicalRoot + path.sep)) {
      return respondNotFound(res);
    }
    const data = readFileSync(canonicalFile);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    respondNotFound(res);
  }
}

/**
 * Создать HTTP-сервер core-view. Возвращает {server, dbPath, port|promise}.
 * port=0 → ephemeral (фактический порт в server.address().port).
 */
export function createCoreViewServer({ port, dbPath, publicDir } = {}) {
  const actualDbPath = resolveDbPath(dbPath);
  const actualPublicDir = path.resolve(publicDir || path.join(CORE_VIEW_DIR, 'public'));

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
      res.end('method not allowed');
      return;
    }
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || HOST}`);
    } catch {
      return respondNotFound(res);
    }
    const { pathname } = url;

    if (pathname === '/api/core/heartbeat') {
      return handleApi(res, actualDbPath, db => buildHeartbeat(db, actualDbPath));
    }
    if (pathname === '/api/core/projects') {
      return handleApi(res, actualDbPath, buildProjects);
    }
    if (pathname === '/api/core/snapshot') {
      const projectParam = url.searchParams.get('project');
      const projectId = projectParam == null || projectParam === ''
        ? null
        : Number(projectParam);
      if (projectId != null && (!Number.isFinite(projectId) || projectId <= 0)) {
        return respondJson(res, 400, { ok: false, error: 'project must be a positive integer' });
      }
      return handleApi(res, actualDbPath, db => buildSnapshot(db, { projectId }));
    }
    if (pathname === '/api/core/events') {
      const since = url.searchParams.get('since');
      const limit = url.searchParams.get('limit');
      return handleApi(res, actualDbPath, db => buildEvents(db, { since, limit }));
    }
    if (pathname === '/api/core/cell') {
      const workplaceRef = url.searchParams.get('workplace');
      if (!workplaceRef) {
        return respondJson(res, 400, { ok: false, error: 'workplace required' });
      }
      return handleApi(res, actualDbPath, db => buildCell(db, { workplaceRef }));
    }
    if (pathname.startsWith('/api/')) {
      return respondJson(res, 404, { ok: false, error: `unknown endpoint: ${pathname}` });
    }
    return serveStatic(res, actualPublicDir, pathname);
  });

  return { server, dbPath: actualDbPath };
}

// --- PID-файл -----------------------------------------------------------------

function writePidFile() {
  try {
    if (existsSync(PID_FILE)) {
      const prev = Number(readFileSync(PID_FILE, 'utf8').trim());
      if (Number.isInteger(prev) && prev > 0 && prev !== process.pid && isProcessAlive(prev)) {
        console.error(`[core-view] another instance appears to be running (pid ${prev}, ${PID_FILE})`);
        process.exit(1);
      }
    }
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (error) {
    console.error('[core-view] pid file write failed:', error.message);
  }
}

function removePidFile() {
  try {
    if (existsSync(PID_FILE)) {
      const prev = Number(readFileSync(PID_FILE, 'utf8').trim());
      if (prev === process.pid) unlinkSync(PID_FILE);
    }
  } catch { /* best effort */ }
}

// --- Точка входа (node core-view/server.mjs) ----------------------------------

export function startCoreView({ port, dbPath } = {}) {
  const requestedPort = Number(port ?? process.env.CORE_VIEW_PORT ?? DEFAULT_PORT);
  const { server, dbPath: resolvedDb } = createCoreViewServer({ port: requestedPort, dbPath });

  writePidFile();
  // Windows: Ctrl+C = SIGINT, остановка консоли = SIGBREAK; SIGHUP — терминатор
  // терминала на *nix. Жёсткий TerminateProcess (taskkill /F) не даёт выполнить
  // обработчики — от этого защищает stale-PID детект в writePidFile.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(signal, () => {
      removePidFile();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
  process.on('exit', removePidFile);

  server.listen(Number.isFinite(requestedPort) ? requestedPort : DEFAULT_PORT, HOST, () => {
    const { port: actualPort } = server.address();
    console.log(`[core-view] listening on http://${HOST}:${actualPort}`);
    console.log(`[core-view] db: ${resolvedDb} (${dbAvailable(resolvedDb) ? 'available' : 'MISSING'})`);
    console.log('[core-view] projection only — наблюдение, не авторитет');
  });

  return server;
}

// Запуск как скрипт, но не как модуль (smoke импортирует createCoreViewServer).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startCoreView();
}
