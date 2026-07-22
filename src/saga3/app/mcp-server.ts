#!/usr/bin/env node
/**
 * Saga 3 LM-facing MCP transport.
 *
 * This adapter does not write product files, evidence, conditions, assignments,
 * or WorkIntent state directly. It maps MCP calls to AcceptWorkerSubmission,
 * which is the single application authority for worker completion.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcceptWorkerSubmission } from '../control/application/accept-worker-submission.js';
import type { OracleAuthorizationPolicy } from '../control/ports/worker-submission-ports.js';
import { PIPELINE_CONDITIONS } from '../domain/pipeline-contracts.js';
import { initSaga3Schema } from '../domain/schema.js';
import {
  CommandOraclePort,
  ProdIds,
  RealClock,
} from '../adapters/prod-ports.js';
import { WorkspaceArtifactWriter } from '../infrastructure/filesystem/workspace-artifact-writer.js';
import { SqliteWorkerSubmissionRepository } from '../infrastructure/sqlite/sqlite-worker-submission-repository.js';

let repository: SqliteWorkerSubmissionRepository;
let application: AcceptWorkerSubmission;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the Saga 3 MCP server.`);
  return value;
}

function assignedExecutionId(): string {
  return requiredEnv('SAGA3_EXECUTION_ID');
}

function assertEpisodeScope(episodeSpecId: string): void {
  const assigned = requiredEnv('SAGA3_EPISODE_SPEC_ID');
  if (assigned !== episodeSpecId) {
    throw new Error(`Worker is scoped to episode ${assigned}, not ${episodeSpecId}.`);
  }
}

function assertConditionScope(conditionType: string): void {
  const assigned = process.env.SAGA3_CONDITION;
  if (assigned && assigned !== conditionType) {
    throw new Error(`Worker is scoped to condition ${assigned}, not ${conditionType}.`);
  }
}

interface ProposeArtifactInput {
  episode_spec_id: string;
  kind: string;
  path: string;
  content: string;
  digest?: string;
}

function handleProposeArtifact(input: ProposeArtifactInput) {
  assertEpisodeScope(input.episode_spec_id);
  return application.proposeArtifact({
    executionId: assignedExecutionId(),
    kind: input.kind,
    path: input.path,
    content: input.content,
    digest: input.digest,
  });
}

interface ProposeVerificationInput {
  episode_spec_id: string;
  condition_type: string;
  oracle_id: string;
  oracle_version: string;
  command: string;
  diagnostic_summary?: string;
}

function handleProposeVerification(input: ProposeVerificationInput) {
  assertEpisodeScope(input.episode_spec_id);
  assertConditionScope(input.condition_type);
  return application.proposeVerification({
    executionId: assignedExecutionId(),
    oracleId: input.oracle_id,
    oracleVersion: input.oracle_version,
    command: input.command,
    diagnosticSummary: input.diagnostic_summary,
  });
}

interface CompleteInput {
  episode_spec_id: string;
  condition_type: string;
  result: 'completed' | 'failed';
}

async function handleComplete(input: CompleteInput) {
  assertEpisodeScope(input.episode_spec_id);
  assertConditionScope(input.condition_type);
  return application.complete({
    executionId: assignedExecutionId(),
    workerDeclaredResult: input.result,
  });
}

interface ReadArtifactsInput {
  episode_spec_id?: string;
  path?: string;
}

function handleReadArtifacts(input: ReadArtifactsInput) {
  if (input.episode_spec_id) assertEpisodeScope(input.episode_spec_id);
  return {
    artifacts: repository.listArtifacts({
      episodeSpecId: input.episode_spec_id,
      path: input.path,
    }),
  };
}

interface ReadConditionsInput {
  episode_spec_id: string;
}

function handleReadConditions(input: ReadConditionsInput) {
  assertEpisodeScope(input.episode_spec_id);
  return { conditions: repository.listConditions(input.episode_spec_id) };
}

const TOOLS: Tool[] = [
  {
    name: 'saga3_propose_artifact',
    description:
      'Submit an artifact proposal to the durable Saga 3 worker inbox. The MCP transport does not write the file or mutate authoritative state. Acceptance occurs only when saga3_complete is authorized.',
    annotations: {
      title: 'Saga3: Propose Artifact',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string' },
        kind: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        digest: { type: 'string' },
      },
      required: ['episode_spec_id', 'kind', 'path', 'content'],
    },
  },
  {
    name: 'saga3_propose_verification',
    description:
      'Submit a verification procedure. The worker does not submit an authoritative verdict. On completion Saga 3 executes the authorized oracle command and creates evidence from the real observation.',
    annotations: {
      title: 'Saga3: Propose Verification',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string' },
        condition_type: { type: 'string' },
        oracle_id: { type: 'string' },
        oracle_version: { type: 'string' },
        command: { type: 'string' },
        diagnostic_summary: { type: 'string' },
      },
      required: [
        'episode_spec_id',
        'condition_type',
        'oracle_id',
        'oracle_version',
        'command',
      ],
    },
  },
  {
    name: 'saga3_read_artifacts',
    description: 'Read accepted Saga 3 artifact manifest rows.',
    annotations: {
      title: 'Saga3: Read Artifacts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string' },
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'saga3_read_conditions',
    description: 'Read the Saga 3 condition projection for the assigned episode.',
    annotations: {
      title: 'Saga3: Read Conditions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: { episode_spec_id: { type: 'string' } },
      required: ['episode_spec_id'],
    },
  },
  {
    name: 'saga3_complete',
    description:
      'Request acceptance of the current worker submissions. Saga 3 validates assignment authority, applies accepted artifacts, executes the required oracle, attaches provenance, and updates the condition from evidence.',
    annotations: {
      title: 'Saga3: Complete Assignment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string' },
        condition_type: { type: 'string' },
        result: { type: 'string', enum: ['completed', 'failed'] },
      },
      required: ['episode_spec_id', 'condition_type', 'result'],
    },
  },
];

interface ToolHandlerEntry {
  readonly handler: (input: Record<string, unknown>) => unknown | Promise<unknown>;
  readonly required: readonly string[];
}

const HANDLERS: Record<string, ToolHandlerEntry> = {
  saga3_propose_artifact: {
    handler: (input) => handleProposeArtifact(input as unknown as ProposeArtifactInput),
    required: ['episode_spec_id', 'kind', 'path', 'content'],
  },
  saga3_propose_verification: {
    handler: (input) => handleProposeVerification(input as unknown as ProposeVerificationInput),
    required: ['episode_spec_id', 'condition_type', 'oracle_id', 'oracle_version', 'command'],
  },
  saga3_read_artifacts: {
    handler: (input) => handleReadArtifacts(input as unknown as ReadArtifactsInput),
    required: [],
  },
  saga3_read_conditions: {
    handler: (input) => handleReadConditions(input as unknown as ReadConditionsInput),
    required: ['episode_spec_id'],
  },
  saga3_complete: {
    handler: (input) => handleComplete(input as unknown as CompleteInput),
    required: ['episode_spec_id', 'condition_type', 'result'],
  },
};

function friendlyError(message: string): string {
  if (message.includes('UNIQUE constraint failed')) return 'The submission was already recorded.';
  if (message.includes('FOREIGN KEY constraint failed')) return 'Referenced Saga 3 authority was not found.';
  if (message.includes('no such table')) return 'Saga 3 schema is not initialized.';
  return message;
}

function openDb(): Database.Database {
  const db = new Database(requiredEnv('DB_PATH'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSaga3Schema(db);
  return db;
}

function buildOraclePolicy(): OracleAuthorizationPolicy {
  return {
    requiredOracle(conditionType) {
      const contract = PIPELINE_CONDITIONS.find(
        (candidate) => candidate.conditionType === conditionType,
      );
      if (!contract) return null;
      return {
        oracleId: contract.oracleRequired,
        oracleVersion: '1',
        trustClass: 'deterministic',
      };
    },
  };
}

export async function startSaga3McpServer(): Promise<void> {
  const db = openDb();
  const workspace = process.env.SAGA3_WORKSPACE ?? process.cwd();
  repository = new SqliteWorkerSubmissionRepository(db);
  application = new AcceptWorkerSubmission({
    submissions: repository,
    artifacts: new WorkspaceArtifactWriter(workspace),
    oracle: new CommandOraclePort(workspace),
    clock: new RealClock(),
    ids: new ProdIds(),
    oraclePolicy: buildOraclePolicy(),
  });

  const server = new Server(
    { name: 'saga3', version: '1.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const entry = HANDLERS[request.params.name];
      if (!entry) throw new Error(`Unknown tool: ${request.params.name}`);
      const input = request.params.arguments ?? {};
      const missing = entry.required.filter(
        (key) => input[key] === undefined || input[key] === null,
      );
      if (missing.length > 0) {
        throw new Error(`Missing required field(s): ${missing.join(', ')}`);
      }
      const result = await entry.handler(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${friendlyError(message)}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error('Saga3 MCP submission transport running on stdio');
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (isMainModule()) {
  startSaga3McpServer().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
