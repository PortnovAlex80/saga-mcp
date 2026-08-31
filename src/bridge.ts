#!/usr/bin/env node
// Saga5 bridge (M2): one host process that
//   - sweeps the kernel (timeout reaping, retry decisions, re-driving runs),
//   - claims queued executions and spawns worker processes (workers never
//     choose work — the bridge does, bounded by SAGA_MAX_WORKERS),
//   - serves the desk (desk/dist) and a small JSON API on one origin.
//
//   env: DB_PATH (required), SAGA_BRIDGE_PORT=4455, SAGA_SWEEP_MS=1000,
//        SAGA_MAX_WORKERS=4
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeDb, getDb } from './db.js';
import { getRun, tailEvents } from './events.js';
import { artifactBody, artifactIndex, runArtifacts } from './kernel/artifacts.js';
import { board, operatorQueue } from './kernel/board.js';
import { runGraph, resumeRun } from './kernel/runner.js';
import { sweep } from './kernel/sweep.js';
import { claimExecution } from './kernel/executions.js';
import { humanGateDecisions, kernelStats, queuedExecutionIds } from './kernel/stats.js';
import { liveWorkers, recentWorkers, workerStats } from './kernel/workers.js';
import { markDispatcherAlive } from './dispatcher.js';
import { limitsStamp, readLimits, writeLimits, type Limits } from './limits.js';
import { completeHumanTask, ensureHumanTask, resolveHumanGate, retryNode, submitOperatorMaterial } from './operator.js';
import { BUILTIN_SKILLS } from './skills.js';
import { DEFAULT_WORKSHOPS, ensureProductRepo, startWorkshop } from './workshops.js';
import type { Item } from './kernel/node-types.js';

const WORKER_PATH = fileURLToPath(new URL('./runtime/worker.js', import.meta.url));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESK_DIST = path.join(__dirname, '..', 'desk', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

export interface BridgeHandle {
  port: number;
  stop(opts?: { killWorkers?: boolean }): void;
}

export function startBridge(opts: {
  port?: number;
  sweepMs?: number;
  maxWorkers?: number;
} = {}): BridgeHandle {
  const db = getDb();
  const children = new Set<ChildProcess>();

  // Hiring throttle. The file beside the database is the source of truth, so
  // an operator (UI, MCP tool or editor) can retune a running factory; we
  // re-read it only when its mtime moves.
  let limits: Limits = readLimits(undefined, {
    max_workers: opts.maxWorkers ?? Number(process.env.SAGA_MAX_WORKERS ?? 4) ?? 4,
    min_spawn_interval_ms: Number(process.env.SAGA_MIN_SPAWN_INTERVAL_MS ?? 0) || 0,
  });
  let limitsSeenAt = limitsStamp();
  let lastSpawnAt = 0;

  function refreshLimits(): void {
    const stamp = limitsStamp();
    if (stamp !== limitsSeenAt) {
      limitsSeenAt = stamp;
      limits = readLimits(undefined, limits);
    }
  }

  function spawnPending(): void {
    const free = limits.max_workers - children.size;
    if (free <= 0) return;
    for (const id of queuedExecutionIds(db, free)) {
      if (children.size >= limits.max_workers) break;
      // Rate limit: at most one hire per interval, so a plan with a
      // requests-per-minute ceiling is respected even when the queue is deep.
      const now = Date.now();
      if (limits.min_spawn_interval_ms > 0 && now - lastSpawnAt < limits.min_spawn_interval_ms) break;
      const claim = claimExecution(db, id);
      if (!claim) continue;
      lastSpawnAt = now;
      const child = spawn(process.execPath, [WORKER_PATH, '--execution', id], {
        env: { ...process.env, SAGA_LEASE: claim.lease },
        stdio: ['ignore', 'ignore', 'pipe', 'ignore'],
      });
      children.add(child);
      child.stderr?.on('data', (chunk) => process.stderr.write(`[worker ${id.slice(0, 8)}] ${chunk}`));
      child.on('exit', () => children.delete(child));
    }
  }

  function projectHumanGates(): void {
    for (const decision of humanGateDecisions(db)) {
      try {
        ensureHumanTask(db, decision.run_id, decision.node_id, decision.revision_digest);
      } catch {
        // projection only — never break the sweep on board failures
      }
    }
  }

  function tick(): void {
    try {
      refreshLimits();
      // Сначала отмечаемся живыми, потом сметаем: очередь за нашим же лимитом
      // параллельности — это ожидание, а не крах.
      markDispatcherAlive();
      sweep(db, new Date(), { dispatcherAlive: true });
      spawnPending();
      projectHumanGates();
    } catch (error) {
      process.stderr.write(`[bridge] sweep error: ${error instanceof Error ? error.message : error}\n`);
    }
  }

  function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload, null, 2));
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 5 * 1024 * 1024) reject(new Error('body too large'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  function serveStatic(res: http.ServerResponse, urlPath: string): void {
    if (!existsSync(DESK_DIST)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('desk is not built: run `npm --prefix desk run build`');
      return;
    }
    const relative = urlPath === '/' ? '/index.html' : urlPath;
    const absolute = path.join(DESK_DIST, relative);
    const safe =
      path.resolve(absolute).startsWith(path.resolve(DESK_DIST)) && existsSync(absolute)
        ? absolute
        : path.join(DESK_DIST, 'index.html');
    const body = readFileSync(safe);
    const headers: Record<string, string> = {
      'Content-Type': MIME[path.extname(safe)] ?? 'application/octet-stream',
    };
    // index.html — always fresh (hashed assets are immutable anyway)
    if (safe.endsWith('.html')) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/api/graph') {
        const args = JSON.parse(await readBody(req)) as { name?: string; graph_json?: string };
        if (!args.graph_json) throw new Error('graph_json is required');
        // Host-layer default: effect nodes without a repo publish into the
        // product repo (same default the Discovery Desk uses).
        const doc = JSON.parse(String(args.graph_json)) as {
          nodes?: Record<string, { type: string; parameters?: Record<string, unknown> }>;
        };
        for (const node of Object.values(doc.nodes ?? {})) {
          if (node.type === 'effect' && node.parameters && !node.parameters.repo) {
            node.parameters.repo = ensureProductRepo();
          }
        }
        sendJson(res, 200, runGraph(db, JSON.stringify(doc), {
          name: args.name === undefined ? undefined : String(args.name),
        }));
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/events)?$/);
      if (req.method === 'GET' && runMatch) {
        const run = getRun(db, runMatch[1]);
        if (runMatch[2]) {
          sendJson(res, 200, { run, events: tailEvents(db, runMatch[1], Number(url.searchParams.get('limit') ?? 100)) });
        } else {
          sendJson(res, 200, { run });
        }
        return;
      }
      if (req.method === 'POST' && /^\/api\/runs\/([\w-]+)\/resume$/.test(url.pathname)) {
        sendJson(res, 200, resumeRun(db, url.pathname.split('/')[3] ?? ''));
        return;
      }
      // THE start path: one endpoint for every declared workshop.
      const startMatch = url.pathname.match(/^\/api\/workshops\/([\w-]+)\/start$/);
      if (req.method === 'POST' && startMatch) {
        const args = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        const input = (args.input as Record<string, unknown>) ?? args;
        sendJson(res, 200, startWorkshop(db, startMatch[1], input));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workers') {
        sendJson(res, 200, {
          limits,
          hired: children.size,
          stats: workerStats(db),
          live: liveWorkers(db),
          recent: recentWorkers(db, Number(url.searchParams.get('recent') ?? 12) || 12),
        });
        return;
      }
      if (url.pathname === '/api/limits' && (req.method === 'GET' || req.method === 'POST')) {
        if (req.method === 'POST') {
          const args = JSON.parse((await readBody(req)) || '{}') as Partial<Limits>;
          limits = writeLimits(args);
          limitsSeenAt = limitsStamp();
        }
        sendJson(res, 200, { limits, hired: children.size });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        sendJson(res, 200, url.searchParams.get('blocked_only')
          ? { queue: operatorQueue(db) }
          : board(db, {
              run_id: url.searchParams.get('run_id') ?? undefined,
              runs: url.searchParams.get('runs') ? Number(url.searchParams.get('runs')) : undefined,
              active_only: url.searchParams.get('active_only') === '1',
            }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifacts') {
        const runId = url.searchParams.get('run_id');
        sendJson(res, 200, runId
          ? runArtifacts(db, runId)
          : artifactIndex(db, {
              path: url.searchParams.get('path') ?? undefined,
              accepted_only: url.searchParams.get('accepted_only') === '1',
              runs: url.searchParams.get('runs') ? Number(url.searchParams.get('runs')) : undefined,
            }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        sendJson(res, 200, artifactBody(
          db,
          url.searchParams.get('run_id') ?? '',
          url.searchParams.get('node') ?? '',
          url.searchParams.get('digest') ?? '',
          Number(url.searchParams.get('index') ?? 0) || 0
        ));
        return;
      }
      const retryMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/nodes\/([^/]+)\/retry$/);
      if (req.method === 'POST' && retryMatch) {
        const args = JSON.parse((await readBody(req)) || '{}') as { note?: string };
        sendJson(res, 200, retryNode(db, retryMatch[1], decodeURIComponent(retryMatch[2]), args.note));
        return;
      }
      const submitMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/nodes\/([^/]+)\/submit$/);
      if (req.method === 'POST' && submitMatch) {
        const args = JSON.parse(await readBody(req)) as {
          text?: string; items?: Item[]; note?: string;
        };
        const items: Item[] = Array.isArray(args.items)
          ? args.items
          : [{ json: { text: String(args.text ?? '') } }];
        sendJson(res, 200, submitOperatorMaterial(
          db,
          submitMatch[1],
          decodeURIComponent(submitMatch[2]),
          items,
          args.note
        ));
        return;
      }
      if (req.method === 'POST' && /^\/api\/runs\/([\w-]+)\/resolve$/.test(url.pathname)) {
        const runId = url.pathname.split('/')[3] ?? '';
        const args = JSON.parse(await readBody(req)) as { node?: string; decision?: string; note?: string };
        if (!args.node) throw new Error('node is required');
        const decision = args.decision === 'reject' ? 'reject' : 'approve';
        const event = resolveHumanGate(db, runId, String(args.node), decision, args.note ? String(args.note) : undefined);
        completeHumanTask(db, runId, String(args.node), decision);
        sendJson(res, 200, event);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workshops') {
        // Цех отдаётся и как СПИСОК СТОЛОВ (то, из чего он собран), и как граф
        // (то, во что он развернулся): канвасу нужен граф, вкладке цехов — столы.
        sendJson(res, 200, Object.fromEntries(
          Object.entries(DEFAULT_WORKSHOPS).map(([name, workshop]) => [name, {
            title: workshop.title,
            inputs: workshop.inputs,
            graph: workshop.graph,
            // Нормализуем необязательные поля: читателю не должно доставаться
            // undefined там, где по смыслу пустой список.
            desks: workshop.spec.desks.map((desk) => ({
              ...desk,
              fanout: desk.fanout ?? false,
              tools: desk.tools ?? [],
              hooks: desk.hooks ?? {},
              checks: desk.checks ?? [],
            })),
            shape: Object.entries(workshop.graph.nodes).map(([node, def]) => ({
              node,
              type: def.type,
              next: (workshop.graph.connections[node]?.main?.[0] ?? []).map((target) => target.node),
            })),
          }])
        ));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        sendJson(res, 200, BUILTIN_SKILLS);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/state') {
        sendJson(res, 200, kernelStats(db));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(res, url.pathname);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const interval = setInterval(tick, Math.max(30, opts.sweepMs ?? 1000));
  server.listen(opts.port ?? Number(process.env.SAGA_BRIDGE_PORT ?? 4455));
  tick();

  return {
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : Number(process.env.SAGA_BRIDGE_PORT ?? 4455);
    },
    /** Диспетчер не владеет работой. Воркер держит собственный lease, сам
     *  бьётся сердцем и сам сдаёт материал, поэтому перезапуск моста НЕ
     *  обязан убивать то, что уже считается: убитая на 200-й секунде попытка
     *  — это выброшенные три минуты настоящей работы. Убиваем только по явной
     *  просьбе (уборка в тестах). */
    stop(opts: { killWorkers?: boolean } = {}): void {
      clearInterval(interval);
      if (opts.killWorkers) {
        for (const child of children) child.kill();
      } else {
        for (const child of children) child.unref();
      }
      server.close();
      closeDb();
    },
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => process.exit(0));
  }
  const handle = startBridge();
  const active = readLimits(undefined, {
    max_workers: Number(process.env.SAGA_MAX_WORKERS ?? 4) || 4,
    min_spawn_interval_ms: Number(process.env.SAGA_MIN_SPAWN_INTERVAL_MS ?? 0) || 0,
  });
  process.stderr.write(
    `Saga5 bridge on http://localhost:${handle.port} ` +
    `(sweep ${process.env.SAGA_SWEEP_MS ?? 1000}ms, max ${active.max_workers} workers, ` +
    `hire interval ${active.min_spawn_interval_ms}ms)\n`
  );
}
