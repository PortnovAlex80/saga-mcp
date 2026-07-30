// Helper child process for development-task-graph-machine-fill-e2e.test.mjs.
// Runs in its own process with its own DB_PATH so the getDb() singleton is
// hermetic. Reads the materialized task-graph-submit-call.json and prints it.
//
// Mode 1 ("fresh"): the execution directory does not exist yet -> the
// materializer emits a fresh placeholder that the machine-fill overwrites.
//
// Mode 2 ("carry"): a pre-existing task-graph-submit-call.json is placed in the
// execution directory before the materializer runs -> the machine-fill must
// preserve it.
//
// Args: <mode> <workspaceRoot> <projectId> <epicId>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareProcessExecutionWorkspace } from '../../../dist/process-modules/application/process-execution-workspace.js';

const mode = process.argv[2];
const workspaceRoot = process.argv[3];
const projectId = Number(process.argv[4]);
const epicId = Number(process.argv[5]);
const taskId = mode === 'carry' ? 4243 : 4242;

const resourceDir = path.join(workspaceRoot, 'resources');
mkdirSync(resourceDir, { recursive: true });

writeFileSync(
  path.join(resourceDir, 'task-graph-submit-call-template.json'),
  JSON.stringify({
    tool: 'process_node_submit',
    arguments: {
      schema: 'saga3.development-task-graph-proposal.v1',
      payload: {
        schemaVersion: 'saga3.development-task-graph-proposal.v1',
        implementationItems: [{
          key: 'FILL_STABLE_IMPLEMENTATION_KEY',
          projectRepositoryId: 'FILL_INTEGER_BOUND_REPOSITORY_ID',
          acceptanceCriterionIds: ['FILL_INTEGER_ACCEPTANCE_ARTIFACT_ID'],
        }],
      },
    },
  }, null, 2),
);
writeFileSync(path.join(resourceDir, 'tracker.md'), '# Tracker\n');
writeFileSync(path.join(resourceDir, 'checklist.md'), '# Checklist\n');

if (mode === 'carry') {
  // Pre-place a carry-over draft in the execution directory so the materializer
  // sees the target as existing and the machine-fill leaves it untouched.
  const execDir = path.join(
    workspaceRoot,
    'docs/development/projects/' + epicId + '/executions/task-' + taskId,
  );
  mkdirSync(execDir, { recursive: true });
  writeFileSync(
    path.join(execDir, 'task-graph-submit-call.json'),
    JSON.stringify({ machine_filled: false, preserved_carry_over: true }),
  );
}

const ws = prepareProcessExecutionWorkspace({
  workspaceRoot,
  module: {
    identity: {
      name: 'solution-development',
      version: '1.0.0',
      kind: 'development',
    },
  },
  profile: {
    id: 'development-task-graph-planner',
    allowedTools: [],
    trackerTemplate: 'resources/tracker.md',
    workspaceTemplates: [
      'resources/task-graph-submit-call-template.json',
      'resources/checklist.md',
    ],
    callTemplates: ['resources/task-graph-submit-call-template.json'],
    checklists: ['resources/checklist.md'],
    outputSchema: { id: 'saga3.development-task-graph-proposal.v1' },
    retryPolicy: { maxAttempts: 2 },
  },
  projectId,
  epicId,
  task: { id: taskId, metadata: {} },
  executionId: 'exec-1',
  workerId: 'worker-1',
});

const absCallPath = path.join(workspaceRoot, ws.executionDirectory, 'task-graph-submit-call.json');
process.stdout.write(readFileSync(absCallPath, 'utf8'));
