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
import { closeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
