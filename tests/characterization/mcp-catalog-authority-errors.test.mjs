import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL_MODULES = [
  'projects', 'epics', 'tasks', 'subtasks', 'notes', 'comments', 'templates',
  'dashboard', 'search', 'activity', 'export-import', 'dispatcher', 'artifacts',
  'repositories', 'lifecycle', 'observations', 'conflicts', 'providers',
  'products',
  'process-modules', 'process-node-submissions', 'delivery-approvals', 'lifecycle-runs',
];

async function catalog() {
  const modules = await Promise.all(
    TOOL_MODULES.map((name) => import(`../../dist/tools/${name}.js`)),
  );
  return modules.flatMap((module) => module.definitions);
}

test('catalog remains flat, well-shaped, duplicate-free, and contains no retired Discovery tools', async () => {
  const tools = await catalog();
  for (const descriptor of tools) {
    assert.equal(typeof descriptor.name, 'string');
    assert.equal(typeof descriptor.description, 'string');
    assert.equal(typeof descriptor.inputSchema, 'object');
  }
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const retired of [
    'proposal_submit', 'normalization_get', 'normalization_submit',
    'readiness_get', 'readiness_submit', 'diagnosis_get', 'diagnosis_submit',
  ]) {
    assert.equal(names.includes(retired), false, `${retired} is not an MCP gateway tool`);
  }
  assert.ok(names.includes('product_submit'));
  assert.ok(names.includes('process_node_submit'));
});

test('authority remains compatibility-open when unmanaged and fail-closed for malformed managed identity', async () => {
  const { authorizeSagaToolCall, visibleSagaToolNames } = await import(
    '../../dist/shared/authority/authorize-tool-call.js'
  );
  const db = new Database(':memory:');
  try {
    assert.deepEqual(authorizeSagaToolCall({ toolName: 'product_submit', db }), { allow: true });
    const malformed = authorizeSagaToolCall({
      toolName: 'product_submit', db, managedExecution: '1',
    });
    assert.equal(malformed.allow, false);
    assert.equal(malformed.code, 'AUTHORITY_CONTEXT_INVALID');
    assert.deepEqual(visibleSagaToolNames(db, { SAGA_MANAGED_EXECUTION: '1' }), new Set());
  } finally {
    db.close();
  }
});

test('universal actionable errors preserve structured fields and parameterized workflow hints', async () => {
  const api = await import('../../dist/application/actionable-tool-error.js');
  const error = api.buildActionableToolError({
    code: 'BAD_ARGUMENT',
    message: 'invalid payload',
    fieldPath: 'payload.name',
    expected: 'non-empty string',
    actual: null,
    trackerRef: 'docs/workshop/stage.md',
    checklistRef: 'skills/workshop/CHECKLIST.md',
    resumeStep: 'submit',
  });
  assert.equal(error.retry, 'retry');
  const envelope = api.serializeActionableToolError(error);
  assert.deepEqual(api.deserializeActionableToolError(JSON.parse(JSON.stringify(envelope))), error);
  const hint = api.renderWorkflowHint({
    trackerRef: 'docs/workshop/stage.md',
    checklistRef: 'skills/workshop/CHECKLIST.md',
    resumeStep: 'submit',
  });
  assert.match(hint, /docs\/workshop\/stage\.md/);
  assert.doesNotMatch(hint, /docs\/discovery/);
});

test('friendly database error translation remains gateway-owned', () => {
  const source = readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
  assert.match(source, /friendlyError/);
  assert.match(source, /FOREIGN KEY|UNIQUE|NOT NULL|no such table/i);
});
