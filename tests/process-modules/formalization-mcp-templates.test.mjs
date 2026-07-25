import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('artifact_create template uses the real MCP argument names and embeds provenance in metadata', () => {
  const template = readJson('tool-templates/formalization/artifact-create-call-template.json');
  assert.equal(template.tool, 'artifact_create');
  assert.deepEqual(
    Object.keys(template.arguments).sort(),
    ['code', 'epic_id', 'metadata', 'parent_artifact_id', 'path', 'project_id', 'status', 'title', 'type'],
  );
  assert.equal(template.arguments.metadata.process_module_ref, 'solution-formalization@1.0.0');
  assert.ok('execution_id' in template.arguments.metadata);
  assert.ok('input_snapshot_hash' in template.arguments.metadata);
});

test('trace_add template matches the real MCP contract exactly', () => {
  const template = readJson('tool-templates/formalization/trace-add-call-template.json');
  assert.equal(template.tool, 'trace_add');
  assert.deepEqual(
    Object.keys(template.arguments).sort(),
    ['link_type', 'source_id', 'target_id', 'target_type'],
  );
  assert.equal(template.arguments.target_type, 'artifact');
  assert.equal(template.call_provenance.process_module_ref, 'solution-formalization@1.0.0');
});

test('worker_done template matches fenced single-use completion contract', () => {
  const template = readJson('tool-templates/formalization/worker-done-call-template.json');
  assert.equal(template.tool, 'worker_done');
  assert.deepEqual(
    Object.keys(template.arguments).sort(),
    ['execution_id', 'result', 'task_id', 'worker_id'],
  );
  assert.equal(template.completion_assertions.no_unresolved_FILL_placeholders, true);
});
