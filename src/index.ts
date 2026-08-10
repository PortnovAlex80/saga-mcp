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
import { definitions as lifecycleDefs, handlers as lifecycleHandlers } from './tools/lifecycle.js';
import { definitions as observationDefs, handlers as observationHandlers } from './tools/observations.js';
import { definitions as conflictDefs, handlers as conflictHandlers } from './tools/conflicts.js';
import { definitions as providerDefs, handlers as providerHandlers } from './tools/providers.js';
import { definitions as productDefs, handlers as productHandlers } from './tools/products.js';
import {
  definitions as processModuleDefs,
  handlers as processModuleHandlers,
} from './tools/process-modules.js';
import {
  definitions as processNodeSubmissionDefs,
  handlers as processNodeSubmissionHandlers,
} from './tools/process-node-submissions.js';
import {
  definitions as deliveryApprovalDefs,
  handlers as deliveryApprovalHandlers,
} from './tools/delivery-approvals.js';
import {
  definitions as lifecycleRunDefs,
  handlers as lifecycleRunHandlers,
} from './tools/lifecycle-runs.js';
import {
  definitions as settlementDebugDefs,
  handlers as settlementDebugHandlers,
} from './tools/settlement-debug.js';
import {
  authorizeSagaToolCall,
  visibleSagaToolNames,
} from './shared/authority/authorize-tool-call.js';
import { closeDb, getDb } from './db.js';
import { registerProductPayloadContract } from './process-modules/application/product-payload-contract.js';
import { developmentVerificationPayloadContract } from './modules/development/application/development-check-providers.js';

// The worker MCP host is a separate process from the lifecycle orchestrator.
// Install the same executable payload contracts at this composition boundary;
// durable WorkIntent pins still reject any id/version/digest drift.
registerProductPayloadContract(developmentVerificationPayloadContract);

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

/**
 * Saga4 exposes one worker-production desk for every workshop:
 *
 *   product_submit / product_read / candidate_read
 *
 * Discovery-specific proposal/normalization/readiness submit protocols are no
 * longer registered on the MCP surface. Discovery compatibility tables may
 * still exist as deterministic kernel/read-model projections behind
 * `product_submit`, but a worker cannot select another persistence protocol by
 * choosing a module-specific tool.
 */
const INTERNAL_ONLY_TOOL_NAMES = new Set([
  'project_create',
  'project_resolve_by_name',
  'epic_create',
  'process_run_start',
  'process_run_set',
  'process_run_cancel',
]);

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
  ...lifecycleDefs,
  ...observationDefs,
  ...conflictDefs,
  ...providerDefs,
  ...productDefs,
  ...processModuleDefs,
  ...processNodeSubmissionDefs,
  ...deliveryApprovalDefs,
  ...lifecycleRunDefs,
  ...settlementDebugDefs,
].filter(tool => !INTERNAL_ONLY_TOOL_NAMES.has(tool.name));

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
  ...lifecycleHandlers,
  ...observationHandlers,
  ...conflictHandlers,
  ...providerHandlers,
  ...productHandlers,
  ...processModuleHandlers,
  ...processNodeSubmissionHandlers,
  ...deliveryApprovalHandlers,
  ...lifecycleRunHandlers,
  ...settlementDebugHandlers,
};
for (const name of INTERNAL_ONLY_TOOL_NAMES) delete ALL_HANDLERS[name];

const server = new Server(
  { name: 'tracker', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const visibleNames = visibleSagaToolNames(getDb());
  return {
    tools: visibleNames === null
      ? ALL_TOOLS
      : ALL_TOOLS.filter(tool => visibleNames.has(tool.name)),
  };
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
    const decision = authorizeSagaToolCall({ toolName: name, db: getDb() });
    if (!decision.allow) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ code: decision.code, ...decision.details }, null, 2),
        }],
        isError: true,
      };
    }
    if (decision.advisory) {
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
      content: [{ type: 'text', text: `Error: ${friendly}` }],
      isError: true,
    };
  }
});

async function main() {
  assertManagedExecutionIdentity();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Tracker MCP Server running on stdio');

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
            TRACKER_SPAWNED: '1',
          },
        });
        child.unref();
        console.error(`Tracker view → http://localhost:${trackerPort} (set TRACKER_AUTOSTART=0 to disable)`);
      }
    } catch (err) {
      console.error('Tracker view failed to start (non-fatal):', err instanceof Error ? err.message : err);
    }
  }

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
      console.error('Docs graph failed to start (non-fatal):', err instanceof Error ? err.message : String(err));
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
