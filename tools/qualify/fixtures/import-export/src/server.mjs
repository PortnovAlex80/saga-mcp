/**
 * import-export/src/server.mjs - the import/export application with a
 * recovery path (plan EK-11 P18): POST /import accepts a dataset, GET
 * /export returns it; a corrupted store is detected and POST /recover
 * restores from the last good snapshot (the recovery path is part of the
 * product's own contract). `node src/server.mjs <port|0>` prints
 * "listening on <port>".
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Validate an import payload (typed refusals). */
export function validateImport(body) {
  const errors = [];
  if (typeof body?.dataset !== 'string' || body.dataset.length === 0) errors.push('dataset must be a nonempty string');
  if (!Array.isArray(body?.records) || body.records.some((record) => typeof record !== 'object' || record === null)) errors.push('records must be an array of objects');
  if (body?.records !== undefined && body.records.length > 1000) errors.push('records too many (max 1000)');
  return { valid: errors.length === 0, errors };
}

export function createStore(dataDir = join(ROOT, 'data')) {
  const live = join(dataDir, 'current.json');
  const snapshot = join(dataDir, 'last-good.json');
  const writeAtomic = (file, value) => {
    mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    rmSync(file, { force: true });
    copyFileSync(temp, file);
    rmSync(temp, { force: true });
  };
  return {
    state: () => {
      if (!existsSync(live)) return { status: 'empty' };
      try {
        return { status: 'ok', document: JSON.parse(readFileSync(live, 'utf8')) };
      } catch {
        return { status: 'corrupt' };
      }
    },
    import: (document) => {
      writeAtomic(live, document);
      writeAtomic(snapshot, document);
      return { imported: document.records.length };
    },
    export: () => {
      const current = existsSync(live) ? (() => { try { return JSON.parse(readFileSync(live, 'utf8')); } catch { return null; } })() : null;
      if (current === null) return { refused: 'corrupt' };
      return current;
    },
    recover: () => {
      if (!existsSync(snapshot)) return { recovered: false, reason: 'no-snapshot' };
      const good = JSON.parse(readFileSync(snapshot, 'utf8'));
      writeAtomic(live, good);
      return { recovered: true, records: good.records.length };
    },
  };
}

export function createApp(dataDir = join(ROOT, 'data')) {
  const store = createStore(dataDir);
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
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/import') {
        const body = await readBody(request);
        if (!body.ok) return json(response, 400, { error: 'invalid-json' });
        const check = validateImport(body.body);
        if (!check.valid) return json(response, 422, { error: 'validation', errors: check.errors });
        return json(response, 200, store.import({ dataset: body.body.dataset, records: body.body.records }));
      }
      if (request.method === 'GET' && url.pathname === '/export') {
        const state = store.state();
        if (state.status === 'empty') return json(response, 200, { status: 'empty' });
        if (state.status === 'corrupt') return json(response, 409, { error: 'corrupt-store', recovery: 'POST /recover' });
        return json(response, 200, state.document);
      }
      if (request.method === 'POST' && url.pathname === '/recover') {
        const result = store.recover();
        return json(response, result.recovered ? 200 : 409, result);
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
