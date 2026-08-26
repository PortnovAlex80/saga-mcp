/**
 * metrics-dashboard/src/server.mjs - the read-only metrics dashboard (plan
 * EK-11 P11): a served API with deterministic metrics computed from a frozen
 * input window, plus the browser dashboard page. NO write surface exists
 * (the read-only product's own contract). `node src/server.mjs <port|0>`
 * prints "listening on <port>".
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
/** The frozen input window (a read-only dashboard never reads the clock). */
const WINDOW = { from: 20260801, to: 20260831, series: 'dashboard' };

/** The deterministic metrics document (pure arithmetic over the window). */
export function metricsDocument() {
  const rows = [];
  for (let day = WINDOW.from; day <= WINDOW.to; day += 1) {
    let state = day % 2147483647;
    const next = () => { state = (state * 48271) % 2147483647; return state; };
    rows.push({ day, requests: next() % 5000, errors: next() % 40, latencyMs: 5 + (next() % 60) });
  }
  const totals = rows.reduce(
    (acc, row) => ({ requests: acc.requests + row.requests, errors: acc.errors + row.errors, latencySum: acc.latencySum + row.latencyMs }),
    { requests: 0, errors: 0, latencySum: 0 },
  );
  return {
    kind: 'metrics-dashboard.document.v1',
    window: WINDOW,
    totals: { ...totals, meanLatencyMs: Number((totals.latencySum / rows.length).toFixed(3)), errorRate: Number((totals.errors / totals.requests).toFixed(5)) },
    series: rows,
  };
}

export function createApp() {
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/api/metrics') return json(response, 200, metricsDocument());
      if (request.method === 'GET' && url.pathname === '/api/metrics/summary') {
        const document = metricsDocument();
        return json(response, 200, { kind: 'metrics-dashboard.summary.v1', window: document.window, totals: document.totals });
      }
      /* The read-only contract: every write attempt is refused, typed. */
      if (url.pathname.startsWith('/api/') && request.method !== 'GET') {
        return json(response, 405, { error: 'read-only', detail: 'the dashboard exposes GET surfaces only' });
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/style.css')) {
        const file = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
        const bytes = await readFile(join(ROOT, file));
        response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain' });
        return response.end(bytes);
      }
      return json(response, 404, { error: 'no-such-surface' });
    } catch (error) {
      return json(response, 500, { error: 'internal', detail: String(error?.message ?? error) });
    }
  });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.argv[2] ?? '0', 10);
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`listening on ${server.address().port}\n`);
  });
}
