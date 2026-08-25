/**
 * simple-server/src/server.js - the canonical dependency-light Node HTTP
 * server of the WP-08 Development corpus (plan EK-5 "canonical simple
 * product").
 *
 * ZERO external dependencies: node:http + node:fs only. The acceptance
 * contract (acceptance-contract.json) owns the browser entry, static
 * assets, bootstrap, build/start wiring and frontend/backend integration.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The deterministic API message (the integration value the frontend renders). */
export function deterministicMessage() {
  return { message: 'hello from simple-server', code: 7 };
}

/** The exact route table the acceptance contract owns. */
export const ROUTES = ['/healthz', '/api/message', '/', '/app.js'];

export function createApp() {
  return createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url === '/api/message') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(deterministicMessage()));
      return;
    }
    if (url === '/' || url === '/index.html') {
      try {
        const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('simple-server: browser entry missing');
      }
      return;
    }
    if (url === '/app.js') {
      try {
        const js = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(js);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('simple-server: static asset missing');
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', url }));
  });
}

/** CLI entry: `node src/server.js [port]` (port 0 = ephemeral). */
export async function main() {
  const port = Number.parseInt(process.argv[2] ?? '0', 10) || 0;
  const server = createApp().listen(port);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`simple-server listening on ${bound}\n`);
  return { server, port: bound };
}

// Run only when invoked directly (the verification hooks import createApp).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
