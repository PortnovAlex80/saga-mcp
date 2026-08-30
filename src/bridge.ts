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
import { runGraph, resumeRun } from './kernel/runner.js';
import { sweep } from './kernel/sweep.js';
import { claimExecution } from './kernel/executions.js';
import { handlers as factoryHandlers } from './tools/factory.js';
import { completeHumanTask, ensureHumanTask, resolveHumanGate } from './operator.js';
import { DEFAULT_WORKSHOPS, ensureProductRepo, startDiscovery } from './workshops.js';

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
  stop(): void;
}

export function startBridge(opts: {
  port?: number;
  sweepMs?: number;
  maxWorkers?: number;
} = {}): BridgeHandle {
  const db = getDb();
  const children = new Set<ChildProcess>();

  function spawnPending(): void {
    const queued = db
      .prepare("SELECT id FROM executions WHERE status = 'new' ORDER BY created_at LIMIT ?")
      .all(opts.maxWorkers ?? 4) as Array<{ id: string }>;
    for (const { id } of queued) {
      if (children.size >= (opts.maxWorkers ?? 4)) break;
      const claim = claimExecution(db, id);
      if (!claim) continue;
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
    const decisions = db
      .prepare(
        "SELECT run_id, payload_json FROM events WHERE type = 'gate.decided' AND payload_json LIKE '%\"verdict\":\"human_required\"%'"
      )
      .all() as Array<{ run_id: string; payload_json: string }>;
    for (const row of decisions) {
      const payload = JSON.parse(row.payload_json) as { node_id: string; revision_digest?: string };
      try {
        ensureHumanTask(db, row.run_id, payload.node_id, payload.revision_digest);
      } catch {
        // projection only — never break the sweep on board failures
      }
    }
  }

  function tick(): void {
    try {
      sweep(db);
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
      if (req.method === 'POST' && url.pathname === '/api/discovery') {
        const args = JSON.parse(await readBody(req)) as { idea?: string; repo?: string; mode?: string };
        if (!args.idea) throw new Error('idea is required: напишите идею в стартовый узел');
        sendJson(res, 200, startDiscovery(db, {
          idea: String(args.idea),
          repo: args.repo === undefined ? undefined : String(args.repo),
          mode: args.mode === undefined ? undefined : (String(args.mode) as 'echo' | 'opencode'),
        }));
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
        sendJson(res, 200, DEFAULT_WORKSHOPS);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/state') {
        sendJson(res, 200, factoryHandlers.factory_status({}));
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
    stop(): void {
      clearInterval(interval);
      for (const child of children) child.kill();
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
  process.stderr.write(
    `Saga5 bridge on http://localhost:${handle.port} (sweep ${process.env.SAGA_SWEEP_MS ?? 1000}ms, max ${process.env.SAGA_MAX_WORKERS ?? 4} workers)\n`
  );
}
