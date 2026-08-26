#!/usr/bin/env node
/**
 * workflow-kernel/composition/entry.ts - THE PRODUCTION ENTRYPOINT of the
 * event-projected kernel (EK-8, WP-12). This file replaces the retired
 * legacy MCP entrypoint (src/index.ts, DELETE per LEGACY-DELETION-MANIFEST
 * §B.1: "new production entrypoint routing to the new kernel composition
 * (WP-12); typed commands + KanbanCard read API").
 *
 * There is exactly ONE production orchestration composition (plan EK-8
 * exit): this entry arms it and nothing else.
 *
 * Usage:
 *   node dist/workflow-kernel/composition/entry.js --db <path> --status
 *   node dist/workflow-kernel/composition/entry.js --db <path> --drive          (consume the frontier)
 *   node dist/workflow-kernel/composition/entry.js --db <path> --console [port] (serve the command-only console)
 *
 * Every non-fresh database fails closed FACTORY_DATABASE_PROTOCOL_UNSUPPORTED
 * (no migration, no adoption). The cognition laws (claude-CLI prohibition,
 * settings tripwire) abort loudly; there is no fallback runtime.
 */

import { handleConsoleRequest } from './console.js';
import { serveConsole } from './console.js';
import { composeProduction, consoleAdapterDeps, compositionIdentityDigest } from './production.js';

interface CliArgs {
  readonly db: string;
  readonly mode: 'status' | 'drive' | 'console';
  readonly port: number;
}

function parseArgs(argv: readonly string[]): CliArgs | { readonly error: string } {
  let db = '';
  let mode: CliArgs['mode'] | undefined;
  let port = 8642;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') db = argv[++i] ?? '';
    else if (a === '--status') mode = 'status';
    else if (a === '--drive') mode = 'drive';
    else if (a === '--console') mode = 'console';
    else if (a === '--port') port = Number(argv[++i] ?? '0');
    else return { error: `unknown argument '${a}'` };
  }
  if (db === '') return { error: '--db <path> is required' };
  if (mode === undefined) return { error: 'one of --status | --drive | --console is required' };
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `invalid --port '${port}'` };
  return { db, mode, port };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`usage: entry.js --db <path> (--status | --drive | --console) [--port n]\nerror: ${parsed.error}\n`);
    return 2;
  }
  const composition = composeProduction({ dbPath: parsed.db });
  const identity = compositionIdentityDigest(composition);

  if (parsed.mode === 'status') {
    const world = composition.session.hydrateWorld();
    process.stdout.write(JSON.stringify({
      composition: 'event-projected-kernel/ek8',
      identity,
      db: composition.dbPath,
      workshops: composition.workshops.map((workshop) => ({ workshop: workshop.workshop, launchKinds: workshop.launchKinds, universeEqual: workshop.universeEqual })),
      heads: world.world.heads.size,
      openObligations: world.world.obligations.filter((obligation) => obligation.state === 'open').length,
      waits: world.world.waits.length,
      cards: composition.cards.count(),
    }, null, 2) + '\n');
    return 0;
  }

  if (parsed.mode === 'drive') {
    const result = composition.driveFrontier();
    composition.refreshBoard();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.status === 'idle' ? 0 : 1;
  }

  const server = await serveConsole(composition, consoleAdapterDeps(composition), parsed.port);
  process.stdout.write(`[ek8-console] listening on 127.0.0.1:${server.port} (command-only; identity ${identity.slice(0, 16)}…)\n`);
  // One self-check read so a broken composition fails at startup, not on
  // the first operator request.
  const probe = handleConsoleRequest(composition, consoleAdapterDeps(composition), { method: 'GET', path: '/api/kanban', query: new URLSearchParams() }, undefined);
  if (probe.status !== 200) {
    server.close();
    process.stderr.write(`[ek8-console] startup self-check failed: ${JSON.stringify(probe.body)}\n`);
    return 1;
  }
  return 0;
}

main().then((code) => {
  if (code !== 0) process.exit(code);
}, (error) => {
  process.stderr.write(`[ek8-entry] ${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
