/**
 * sqlite-inventory/src/server.mjs - the served SQLite inventory application
 * (plan EK-11 P13): real SQLite persistence behind an operator API.
 * `node src/server.mjs <port|0> [db-file]` prints "listening on <port>".
 */
import { createServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInventory } from './inventory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function validateItem(body) {
  const errors = [];
  if (typeof body?.sku !== 'string' || !/^[A-Z]{2,4}-[0-9]{3,5}$/.test(body.sku)) errors.push('sku must match /^[A-Z]{2,4}-[0-9]{3,5}$/');
  if (typeof body?.name !== 'string' || body.name.length === 0) errors.push('name must be a nonempty string');
  if (!Number.isInteger(body?.quantity) || body.quantity < 0) errors.push('quantity must be a nonnegative integer');
  return { valid: errors.length === 0, errors };
}

export function createApp(dbFile = join(ROOT, 'data', 'inventory.sqlite')) {
  const inventory = openInventory(dbFile);
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const readBody = (request) => new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; });
    request.on('end', () => {
      try { resolve({ ok: true, body: JSON.parse(data) }); } catch { resolve({ ok: false }); }
    });
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const sku = /^\/api\/inventory\/([A-Za-z0-9-]+)$/.exec(url.pathname)?.[1];
    const adjustSku = /^\/api\/inventory\/([A-Za-z0-9-]+)\/adjust$/.exec(url.pathname)?.[1];
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok', schema: inventory.schemaVersion() });
      if (request.method === 'GET' && url.pathname === '/api/inventory') return json(response, 200, { items: inventory.list() });
      if (request.method === 'POST' && url.pathname === '/api/inventory') {
        const body = await readBody(request);
        if (!body.ok) return json(response, 400, { error: 'invalid-json' });
        const check = validateItem(body.body);
        if (!check.valid) return json(response, 422, { error: 'validation', errors: check.errors });
        try {
          const id = inventory.add(body.body.sku, body.body.name, body.body.quantity);
          return json(response, 201, { created: { id, ...body.body } });
        } catch (error) {
          const text = `${String(error?.code ?? '')} ${String(error?.message ?? '')}`;
          if (text.includes('SQLITE_CONSTRAINT') || text.includes('UNIQUE constraint')) {
            return json(response, 409, { error: 'duplicate-sku' });
          }
          throw error;
        }
      }
      if (request.method === 'POST' && adjustSku !== undefined) {
        const body = await readBody(request);
        if (!body.ok || !Number.isInteger(body.body?.delta)) return json(response, 400, { error: 'invalid-delta' });
        const result = inventory.adjust(adjustSku, body.body.delta);
        if (result === null) return json(response, 404, { error: 'not-found' });
        if (result.refused !== undefined) return json(response, 409, { error: result.refused });
        return json(response, 200, result);
      }
      if (request.method === 'DELETE' && sku !== undefined) {
        return inventory.remove(sku) ? json(response, 200, { deleted: sku }) : json(response, 404, { error: 'not-found' });
      }
      return json(response, 404, { error: 'no-such-surface' });
    } catch (error) {
      return json(response, 500, { error: 'internal', detail: String(error?.message ?? error) });
    }
  });
  server.on('close', () => inventory.close());
  return server;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.argv[2] ?? '0', 10);
  const server = createApp(process.argv[3] !== undefined ? resolve(process.argv[3]) : undefined);
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`listening on ${server.address().port}\n`);
  });
}
