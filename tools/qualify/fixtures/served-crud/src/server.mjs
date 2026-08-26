/**
 * served-crud/src/server.mjs - the served CRUD product (todo/notes/operator/
 * expense families): a real HTTP server exposing the REST surfaces plus the
 * browser entry and frontend asset. `node src/server.js <port|0>` prints
 * "listening on <port>" (the WP-08 acceptance convention).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/** The validation the write surface enforces (the product's own contract). */
export function validateItem(body) {
  const errors = [];
  if (typeof body?.title !== 'string' || body.title.trim().length === 0) errors.push('title must be a nonempty string');
  if (body?.title !== undefined && body.title.length > 200) errors.push('title too long (max 200)');
  if (body?.done !== undefined && typeof body.done !== 'boolean') errors.push('done must be a boolean');
  return { valid: errors.length === 0, errors };
}

export function createApp(dataFile = join(ROOT, 'data', 'items.json')) {
  const store = createStore(dataFile);
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const readBody = (request) => new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      try { resolve({ ok: true, body: data.length === 0 ? {} : JSON.parse(data) }); }
      catch { resolve({ ok: false }); }
    });
  });
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const id = /^\/api\/items\/(\d+)$/.exec(url.pathname)?.[1];
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/api/items') return json(response, 200, { items: store.list() });
      if (request.method === 'POST' && url.pathname === '/api/items') {
        const body = await readBody(request);
        if (!body.ok) return json(response, 400, { error: 'invalid-json' });
        const check = validateItem(body.body);
        if (!check.valid) return json(response, 422, { error: 'validation', errors: check.errors });
        const item = store.create({ title: body.body.title, done: body.body.done === true });
        return json(response, 201, { created: item });
      }
      if (request.method === 'PATCH' && id !== undefined) {
        const body = await readBody(request);
        if (!body.ok) return json(response, 400, { error: 'invalid-json' });
        const check = validateItem({ title: body.body.title ?? 'kept-valid-title', done: body.body.done });
        if (!check.valid) return json(response, 422, { error: 'validation', errors: check.errors });
        const updated = store.update(Number(id), body.body);
        return updated === null ? json(response, 404, { error: 'not-found' }) : json(response, 200, { updated });
      }
      if (request.method === 'DELETE' && id !== undefined) {
        return store.remove(Number(id)) ? json(response, 200, { deleted: Number(id) }) : json(response, 404, { error: 'not-found' });
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
