import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import {
  SqliteManagedNodeSubmissionRepository,
} from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import type { ToolHandler } from '../types.js';

let repository: SqliteManagedNodeSubmissionRepository | null = null;

function repo(): SqliteManagedNodeSubmissionRepository {
  if (!repository) {
    repository = new SqliteManagedNodeSubmissionRepository(getDb());
  }
  return repository;
}

export function _resetManagedNodeSubmissionRepositoryForTests(): void {
  repository = null;
}

function handleProcessNodeSubmit(args: Record<string, unknown>) {
  const schema = args.schema;
  if (typeof schema !== 'string' || schema.trim() === '') {
    throw new Error('schema is required (non-empty string)');
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'payload')) {
    throw new Error('payload is required');
  }
  const result = repo().submitForCurrentExecution({
    schema,
    payload: args.payload,
  });
  return {
    accepted: true,
    replayed: result.replayed,
    submission_ref: result.record.artifactRef,
    schema: result.record.schema,
    content_hash: result.record.contentHash,
    process_run_id: result.record.processRunId,
    module_ref: result.record.moduleRef,
    node_id: result.record.nodeId,
    intent_id: result.record.intentId,
    task_id: result.record.taskId,
    execution_id: result.record.executionId,
    _workflow_hint:
      'Typed node product accepted. Now call worker_done for this exact task/execution.',
  };
}

export const definitions: Tool[] = [
  {
    name: 'process_node_submit',
    description:
      'Submit the single typed JSON product of the current managed Process Module LM node. The server derives ProcessRun/module/node/intent/task/execution lineage from the live fence; callers cannot choose or rebind it. Equal replay is idempotent. A different second payload is rejected and requires a fresh execution. Call this before worker_done.',
    annotations: {
      title: 'Process Node: Submit Typed Product',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description:
            'Exact output schema declared by the current execution profile.',
        },
        payload: {
          description: 'The complete JSON product conforming to that schema.',
        },
      },
      required: ['schema', 'payload'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  process_node_submit: handleProcessNodeSubmit,
};
