/**
 * webhook-receiver/src/server.mjs - the webhook receiver with validation
 * (plan EK-11 P07): accepts POST /hook deliveries, validates the envelope,
 * persists them to an append-only JSONL log, and exposes GET /hooks (the
 * received list) + GET /healthz. `node src/server.mjs <port|0>` prints
 * "listening on <port>".
 */
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The webhook envelope contract (the receiver's own validation). */
export function validateWebhook(body) {
  const errors = [];
  if (typeof body?.event !== 'string' || body.event.length === 0) errors.push('event must be a nonempty string');
  if (typeof body?.source !== 'string' || !/^[\w.-]+$/.test(body.source)) errors.push('source must match /^[\\w.-]+$/');
  if (!Number.isInteger(body?.seq) || body.seq < 1) errors.push('seq must be a positive integer');
  if (body?.payload !== undefined && typeof body.payload !== 'object') errors.push('payload must be an object');
  return { valid: errors.length === 0, errors };
}

export function createApp(logFile = join(ROOT, 'data', 'webhooks.jsonl')) {
  const json = (response, status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const received = () => {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
  };
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/hooks') {
      const all = received();
      return json(response, 200, { count: all.length, hooks: all.map(({ event, source, seq }) => ({ event, source, seq })) });
    }
    if (request.method === 'POST' && url.pathname === '/hook') {
      let data = '';
      request.on('data', (chunk) => { data += chunk; });
      request.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { return json(response, 400, { error: 'invalid-json' }); }
        const check = validateWebhook(body);
        if (!check.valid) return json(response, 422, { error: 'validation', errors: check.errors });
        const record = { receivedAtSeq: received().length + 1, ...body };
        mkdirSync(dirname(logFile), { recursive: true });
        appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
        return json(response, 202, { accepted: record.receivedAtSeq });
      });
      return undefined;
    }
    return json(response, 404, { error: 'no-such-surface' });
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
