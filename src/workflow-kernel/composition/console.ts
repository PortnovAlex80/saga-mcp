/**
 * workflow-kernel/composition/console.ts - the COMMAND-ONLY OPERATOR
 * CONSOLE over the projection read API (EK-8, WP-12; successor of the
 * deleted tracker-view UI).
 *
 * EK-7/EK-8 laws implemented here:
 *   - READS come from the disposable Kanban projection (store.all) and the
 *     authoritative kernel world (obligations, waits, heads, terminal
 *     proofs) - both read-only surfaces; no console read is ever a
 *     workflow DECISION input;
 *   - WRITES go ONLY through the command-only adapters (dispatchUiAction):
 *     every action is a typed kernel command of the frozen universe. There
 *     is NO card-status endpoint, NO direct `tasks`-scheduling surface and
 *     NO board-write passthrough of any kind - the retired
 *     `/api/project/*`, `/api/factory/start|pause|stop`, `/api/model/set`,
 *     `/api/repository/*` write endpoints are NOT re-implemented; the
 *     corresponding operator intents are typed commands (stop/resume) or
 *     explicit typed refusals;
 *   - the action payload carries NO field for selecting a role, skill, tool
 *     set, completion command or prompt budget (the adapters' closed
 *     shape); the console DISPLAYS the pinned role-contract digest for
 *     diagnosis and never selects one;
 *   - the model intent is the single typed operator command
 *     `model.set-route` whose LAW 3 guard refuses unless
 *     SAGA_MODEL_SWITCH_SKIP_CLAUDE_SETTINGS is pinned in the environment;
 *     this runtime never touches ~/.claude/settings.json.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dispatchUiAction, UI_ACTION_NAMES } from '../projection/adapters.js';
import type { UiAction, UiAdapterDeps, UiActionResult } from '../projection/adapters.js';
import { rebuildProjection } from '../projection/projector.js';
import { projectKanban } from '../projection/projector.js';
import { assertModelSwitchSkipsClaudeSettings } from './laws.js';
import { PRODUCTION_ROUTE_PIN } from './pins.js';
import type { ProductionComposition } from './production.js';

/** The typed refusal every non-command write intent receives. */
export interface ConsoleRefusal {
  readonly refused: true;
  readonly code:
    | 'COMMAND_ONLY_CONSOLE'
    | 'UNKNOWN_ACTION'
    | 'MALFORMED_BODY'
    | 'FORBIDDEN_PAYLOAD_FIELD'
    | 'MODEL_SWITCH_SETTINGS_GUARD';
  readonly detail: string;
}

/** Payload fields no action may ever carry (the selection-authority law). */
const FORBIDDEN_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  'role', 'skill', 'skills', 'toolSet', 'toolsetId', 'completionCommand', 'promptBudget', 'model', 'executor',
]);

export interface ConsoleRoute {
  readonly method: string;
  readonly path: string;
}

/** The closed route table (reads + the command endpoint; nothing else). */
export const CONSOLE_ROUTES: readonly ConsoleRoute[] = Object.freeze([
  { method: 'GET', path: '/api/kanban' },
  { method: 'GET', path: '/api/world' },
  { method: 'GET', path: '/api/identity' },
  { method: 'POST', path: '/api/command' },
  { method: 'POST', path: '/api/projection/rebuild' },
]);

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * Handle one console request (pure handler over the composition; the HTTP
 * server below is a thin wrapper). Exported for tests so the LAWS are
 * provable without a socket.
 */
export function handleConsoleRequest(
  composition: ProductionComposition,
  deps: UiAdapterDeps,
  route: { readonly method: string; readonly path: string; readonly query: URLSearchParams },
  body: unknown,
): { readonly status: number; readonly body: unknown } {
  const { method, path } = route;

  // ---- reads (projection + authoritative world) -------------------------
  if (method === 'GET' && path === '/api/kanban') {
    return { status: 200, body: { cards: composition.cards.all(), disposable: true } };
  }
  if (method === 'GET' && path === '/api/world') {
    const world = composition.session.hydrateWorld();
    return {
      status: 200,
      body: {
        heads: [...world.world.heads.values()],
        obligations: world.world.obligations.map((obligation) => ({
          kind: obligation.kind, state: obligation.state, target: (obligation as { target?: string }).target,
        })),
        waits: world.world.waits.map((wait) => ({ kind: (wait as { kind?: string }).kind, state: (wait as { state?: string }).state })),
        proofs: world.world.proofs.length,
      },
    };
  }
  if (method === 'GET' && path === '/api/identity') {
    const image = projectKanban(composition.session);
    return {
      status: 200,
      body: {
        composition: 'event-projected-kernel/ek8',
        workshops: composition.workshops.map((workshop) => ({
          workshop: workshop.workshop,
          launchKinds: workshop.launchKinds,
          universeEqual: workshop.universeEqual,
        })),
        route: PRODUCTION_ROUTE_PIN,
        projectedSequence: image.sequence,
      },
    };
  }

  // ---- the projection rebuild command (disposable by construction) ------
  if (method === 'POST' && path === '/api/projection/rebuild') {
    const sequence = rebuildProjection(composition.session, composition.cards);
    return { status: 200, body: { rebuilt: true, sequence } };
  }

  // ---- the ONE command surface ------------------------------------------
  if (method === 'POST' && path === '/api/command') {
    if (typeof body !== 'object' || body === null || typeof (body as { action?: unknown }).action !== 'string') {
      return { status: 400, body: { refused: true, code: 'MALFORMED_BODY', detail: 'expected {action, ...} with a string action' } satisfies ConsoleRefusal };
    }
    const action = (body as { action: string }).action;
    if (action === 'model.set-route') {
      // The single model intent; LAW 3 guard applies before anything else.
      try {
        assertModelSwitchSkipsClaudeSettings();
      } catch (error) {
        return {
          status: 409,
          body: { refused: true, code: 'MODEL_SWITCH_SETTINGS_GUARD', detail: (error as Error).message } satisfies ConsoleRefusal,
        };
      }
      return {
        status: 200,
        body: { note: 'route is composition-pinned; the guard passed', route: PRODUCTION_ROUTE_PIN },
      };
    }
    if (!UI_ACTION_NAMES.includes(action)) {
      return {
        status: 400,
        body: { refused: true, code: 'UNKNOWN_ACTION', detail: `action '${action}' is outside the closed vocabulary ${UI_ACTION_NAMES.join('|')} (+ model.set-route behind its guard)` } satisfies ConsoleRefusal,
      };
    }
    for (const field of FORBIDDEN_PAYLOAD_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        return {
          status: 400,
          body: { refused: true, code: 'FORBIDDEN_PAYLOAD_FIELD', detail: `payload field '${field}' may never select a role, skill, tool set, completion command, prompt budget or executor (the pinned role contract comes from the one resolution path)` } satisfies ConsoleRefusal,
        };
      }
    }
    const result: UiActionResult = dispatchUiAction(deps, body as unknown as UiAction);
    return { status: result.status === 'refused' ? 409 : 200, body: result };
  }

  // ---- everything else is the command-only law --------------------------
  return {
    status: 404,
    body: {
      refused: true,
      code: 'COMMAND_ONLY_CONSOLE',
      detail: `${method} ${path} is not a console route. This console reads the disposable projection and issues typed commands only (${CONSOLE_ROUTES.map((r) => `${r.method} ${r.path}`).join(', ')}). Board writes, card-status endpoints and direct task scheduling died with the EK-8 legacy purge.`,
    } satisfies ConsoleRefusal,
  };
}

/** Serve the console on an HTTP server (the tracker UI successor). */
export function serveConsole(composition: ProductionComposition, deps: UiAdapterDeps, port: number, host = '127.0.0.1'): Promise<{ close: () => void; port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { refused: true, code: 'MALFORMED_BODY', detail: 'body is not JSON' });
          return;
        }
      }
      const result = handleConsoleRequest(composition, deps, { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams }, body);
      json(res, result.status, result.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ close: () => server.close(), port: (server.address() as { port: number }).port });
    });
  });
}
