#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { definitions as projectDefs, handlers as projectHandlers } from './tools/projects.js';
import { definitions as epicDefs, handlers as epicHandlers } from './tools/epics.js';
import { definitions as taskDefs, handlers as taskHandlers } from './tools/tasks.js';
import { definitions as subtaskDefs, handlers as subtaskHandlers } from './tools/subtasks.js';
import { definitions as noteDefs, handlers as noteHandlers } from './tools/notes.js';
import { definitions as dashboardDefs, handlers as dashboardHandlers } from './tools/dashboard.js';
import { definitions as searchDefs, handlers as searchHandlers } from './tools/search.js';
import { definitions as activityDefs, handlers as activityHandlers } from './tools/activity.js';
import { definitions as commentDefs, handlers as commentHandlers } from './tools/comments.js';
import { definitions as templateDefs, handlers as templateHandlers } from './tools/templates.js';
import { definitions as exportImportDefs, handlers as exportImportHandlers } from './tools/export-import.js';
import { definitions as dispatcherDefs, handlers as dispatcherHandlers } from './tools/dispatcher.js';
import { definitions as artifactDefs, handlers as artifactHandlers } from './tools/artifacts.js';
import { definitions as repositoryDefs, handlers as repositoryHandlers } from './tools/repositories.js';
import { definitions as workflowDefs, handlers as workflowHandlers } from './tools/workflow.js';
import { definitions as lifecycleDefs, handlers as lifecycleHandlers } from './tools/lifecycle.js';
import { definitions as observationDefs, handlers as observationHandlers } from './tools/observations.js';
import { definitions as conflictDefs, handlers as conflictHandlers } from './tools/conflicts.js';
import { definitions as providerDefs, handlers as providerHandlers } from './tools/providers.js';
import { createSaga3ProposalHandlers } from './tools/saga3-proposals.js';
import { createSaga3NormalizationHandlers } from './tools/saga3-normalization.js';
import { createSaga3ReadinessHandlers } from './tools/saga3-readiness.js';
import { authorizeSagaToolCall } from './saga3/authority/authorize-saga-tool-call.js';
import { closeDb, getDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function assertManagedExecutionIdentity(env: NodeJS.ProcessEnv = process.env): void {
  const marker = env.SAGA_MANAGED_EXECUTION;
  const executionId = env.SAGA_EXECUTION_ID;
  if (marker !== undefined && marker !== '0' && marker !== '1') {
    throw new Error(`AUTHORITY_CONTEXT_INVALID: invalid SAGA_MANAGED_EXECUTION='${marker}'`);
  }
  if (marker === '1' && !executionId) {
    throw new Error('AUTHORITY_CONTEXT_INVALID: managed MCP child is missing SAGA_EXECUTION_ID');
  }
  if (marker !== '1' && executionId) {
    throw new Error('AUTHORITY_CONTEXT_INVALID: SAGA_EXECUTION_ID requires SAGA_MANAGED_EXECUTION=1');
  }
}

// Saga 3 proposal submission boundary (D1). A factory so the composition can
// inject a repository / model-route reader; here it uses the default SQLite
// wiring that reads the shared saga DB directly.
const saga3Proposals = createSaga3ProposalHandlers();
const saga3Normalization = createSaga3NormalizationHandlers();
const saga3Readiness = createSaga3ReadinessHandlers();

const ALL_TOOLS: Tool[] = [
  ...projectDefs,
  ...epicDefs,
  ...taskDefs,
  ...subtaskDefs,
  ...noteDefs,
  ...commentDefs,
  ...templateDefs,
  ...dashboardDefs,
  ...searchDefs,
  ...activityDefs,
  ...exportImportDefs,
  ...dispatcherDefs,
  ...artifactDefs,
  ...repositoryDefs,
  ...workflowDefs,
  ...lifecycleDefs,
  ...observationDefs,
  ...conflictDefs,
  ...providerDefs,
  ...saga3Proposals.definitions,
  ...saga3Normalization.definitions,
  ...saga3Readiness.definitions,
];

const ALL_HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  ...projectHandlers,
  ...epicHandlers,
  ...taskHandlers,
  ...subtaskHandlers,
  ...noteHandlers,
  ...commentHandlers,
  ...templateHandlers,
  ...dashboardHandlers,
  ...searchHandlers,
  ...activityHandlers,
  ...exportImportHandlers,
  ...dispatcherHandlers,
  ...artifactHandlers,
  ...repositoryHandlers,
  ...workflowHandlers,
  ...lifecycleHandlers,
  ...observationHandlers,
  ...conflictHandlers,
  ...providerHandlers,
  ...saga3Proposals.handlers,
  ...saga3Normalization.handlers,
  ...saga3Readiness.handlers,
};

const server = new Server(
  { name: 'tracker', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: ALL_TOOLS };
});

function friendlyError(msg: string): string {
  if (msg.includes('UNIQUE constraint failed')) {
    const match = msg.match(/UNIQUE constraint failed: \w+\.(\w+)/);
    return match ? `A record with that ${match[1]} already exists.` : 'A record with that value already exists.';
  }
  if (msg.includes('NOT NULL constraint failed')) {
    const match = msg.match(/NOT NULL constraint failed: \w+\.(\w+)/);
    return match ? `Missing required field: ${match[1]}.` : 'A required field is missing.';
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return 'Referenced record not found. Check that the parent item exists.';
  }
  if (msg.includes('no such table')) {
    return 'Database not initialized. Run tracker_init first.';
  }
  return msg;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
    const handler = ALL_HANDLERS[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // D1.1: authority gateway. Enforces the frozen execution_context snapshot
    // captured at claim against this Saga tool call. The gateway is the ONLY
    // runtime enforcement point for Saga 3 authority — the skill prompt and
    // --disallowedTools are not the authority source. Saga 3 runtime executions
    // are fail-closed (default-deny: an unlisted tool is denied); legacy Saga 2
    // and non-managed calls are compatibility-allowed.
    const decision = authorizeSagaToolCall({ toolName: name, db: getDb() });
    if (!decision.allow) {
      // Handler must NOT run — return the actionable denial without invoking it.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ code: decision.code, ...decision.details }, null, 2),
          },
        ],
        isError: true,
      };
    }
    if (decision.advisory) {
      // Declared-but-not-enforced: log the observation, still run the handler.
      console.error(`[saga-authority] advisory ${decision.observation} (execution=${decision.executionId ?? '-'})`);
    }

    const result = handler(args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const friendly = friendlyError(msg);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${friendly}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  assertManagedExecutionIdentity();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Tracker MCP Server running on stdio');

  // Автозапуск веб-канбана tracker-view как detached child-процесса.
  // stdio:'ignore' — КРИТИЧНО: MCP-протокол saga идёт по stdio родителя,
  // любой вывод child'а сюда сломал бы протокол. detached + unref — child
  // живёт независимо и не держит родительский процесс при выходе.
  // TRACKER_AUTOSTART=0 → не запускать (headless/CI/тихий режим).
  if (process.env.TRACKER_AUTOSTART !== '0' && process.env.DB_PATH) {
    try {
      const trackerPath = path.join(__dirname, '..', 'tracker-view', 'tracker-view.mjs');
      if (existsSync(trackerPath)) {
        const trackerPort = process.env.TRACKER_PORT || '4321';
        const child = spawn('node', [trackerPath], {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            PORT: trackerPort,
            DB_PATH: process.env.DB_PATH,
            // Маркер: «я spawn'ут saga-MCP». В этом режиме tracker-view при
            // занятом порту ТИХО выходит (уже бежит другой — браузер открыт),
            // не убивает старый процесс и не открывает второе окно.
            // Ручной `npm run tracker` (без маркера) сохраняет старое поведение
            // — перезапуск + открытие браузера.
            TRACKER_SPAWNED: '1',
          },
        });
        child.unref();
        console.error(`Tracker view → http://localhost:${trackerPort} (set TRACKER_AUTOSTART=0 to disable)`);
      }
    } catch (err) {
      // Tracker view не критичен для MCP-сервера — логируем и продолжаем.
      console.error('Tracker view failed to start (non-fatal):', err instanceof Error ? err.message : err);
    }
  }

  // Автозапуск docs-graph viewer (унифицированный граф артефактов + .md).
  // Тот же паттерн, что и tracker-view: detached + stdio:'ignore' (MCP-протокол
  // родителя нельзя трогать), unref — child живёт независимо. Порт 4322 по
  // умолчанию. DOCS_GRAPH_AUTOSTART=0 → не запускать.
  if (process.env.DOCS_GRAPH_AUTOSTART !== '0' && process.env.DB_PATH) {
    try {
      const docsGraphPath = path.join(__dirname, '..', 'tracker-view', 'docs-graph', 'server.mjs');
      if (existsSync(docsGraphPath)) {
        const docsPort = process.env.DOCS_GRAPH_PORT || '4322';
        const child = spawn('node', [docsGraphPath], {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            DOCS_GRAPH_PORT: docsPort,
            DB_PATH: process.env.DB_PATH,
          },
        });
        child.unref();
        console.error(`Docs graph   → http://localhost:${docsPort} (set DOCS_GRAPH_AUTOSTART=0 to disable)`);
      }
    } catch (err) {
      console.error('Docs graph failed to start (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
}

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
