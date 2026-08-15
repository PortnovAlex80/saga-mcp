import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import type { ToolHandler } from '../types.js';

let repository: SqliteLifecycleRunRepository | null = null;

function repo(): SqliteLifecycleRunRepository {
  repository ??= new SqliteLifecycleRunRepository();
  return repository;
}

export function _resetLifecycleRunRepositoryForTests(): void {
  repository = null;
}

function requiredInteger(
  args: Record<string, unknown>,
  key: string,
): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${key} is required (positive integer)`);
  }
  return Number(value);
}

const handleGet: ToolHandler = args => {
  const lifecycleRunId = requiredInteger(args, 'lifecycle_run_id');
  const run = repo().read(lifecycleRunId);
  if (!run) {
    throw new Error(`LIFECYCLE_RUN_NOT_FOUND: ${lifecycleRunId}`);
  }
  return {
    run,
    stages: repo().listStageRuns(lifecycleRunId),
    transitions: repo().listTransitions(lifecycleRunId),
    next_action: run.status === 'paused'
      ? 'Resolve the exact pending human interaction, then resume the same '
        + 'LifecycleRun with the same input and idempotency key.'
      : null,
  };
};

const handleList: ToolHandler = args => {
  const projectId = requiredInteger(args, 'project_id');
  const epicId = args.epic_id === undefined
    ? undefined
    : requiredInteger(args, 'epic_id');
  const runs = repo().list(projectId, epicId);
  return {
    runs,
    count: runs.length,
  };
};

export const definitions: Tool[] = [
  {
    name: 'lifecycle_run_get',
    description:
      'Read one durable LifecycleRun with its ordered StageRuns and immutable '
      + 'cross-module transitions. Read-only.',
    annotations: {
      title: 'Lifecycle Run: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        lifecycle_run_id: { type: 'integer', minimum: 1 },
      },
      required: ['lifecycle_run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lifecycle_run_list',
    description:
      'List durable LifecycleRuns for one project, optionally narrowed to an '
      + 'epic. Read-only.',
    annotations: {
      title: 'Lifecycle Run: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', minimum: 1 },
        epic_id: { type: 'integer', minimum: 1 },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  lifecycle_run_get: handleGet,
  lifecycle_run_list: handleList,
};
