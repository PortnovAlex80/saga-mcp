import assert from 'node:assert/strict';
import test from 'node:test';

const { definitions, handlers } = await import('../../dist/tools/process-modules.js');

const toolNames = definitions.map(definition => definition.name);

test('MCP exposes Process Module catalog + ProcessRun lifecycle tools', () => {
  // Two namespaces: process_module_* (catalog, read-only) and process_run_*
  // (lifecycle, mutating). The split avoids name collisions in the flat MCP
  // tool namespace and keeps the read-only catalog separable from mutable runs.
  assert.deepEqual(toolNames.sort(), [
    'process_lifecycle_get',
    'process_module_get',
    'process_module_list',
    'process_module_validate',
    'process_run_cancel',
    'process_run_get',
    'process_run_list',
    'process_run_set',
    'process_run_start',
  ]);
  // Catalog tools are read-only; ProcessRun tools are not (start/set/cancel
  // mutate). get/list reads within process_run_* are still flagged non-
  // destructive but not readOnlyHint because they share the mutating namespace.
  const readOnly = new Set([
    'process_lifecycle_get', 'process_module_get',
    'process_module_list', 'process_module_validate',
    'process_run_get', 'process_run_list',
  ]);
  for (const definition of definitions) {
    assert.equal(definition.annotations.destructiveHint, false);
    if (readOnly.has(definition.name)) {
      assert.equal(definition.annotations.readOnlyHint, true,
        `${definition.name} should be readOnly`);
    }
  }
});

test('process_module_list returns the complete product lifecycle catalog', () => {
  const result = handlers.process_module_list({});
  assert.equal(result.count, 4);
  const refs = result.modules.map(
    module => `${module.identity.name}@${module.identity.version}`,
  );
  assert.deepEqual(refs.sort(), [
    'delivery-release@1.0.0',
    'product-discovery@3.0.2',
    'solution-development@1.3.1',
    'solution-formalization@1.0.0',
  ]);
  assert.ok(result.modules.every(module => module.valid === true));
});

test('process_module_get returns complete definition and validation', () => {
  const result = handlers.process_module_get({
    name: 'product-discovery',
    version: '3.0.2',
  });
  assert.equal(result.module.identity.kind, 'discovery');
  assert.equal(result.validation.valid, true);
  assert.ok(result.module.executionProfiles.length > 0);
});

test('process_module_validate fails closed for unknown module', () => {
  assert.throws(
    () => handlers.process_module_validate({ name: 'missing', version: '1.0.0' }),
    /not registered/,
  );
});

test('process_lifecycle_get exposes all valid product lifecycle Stage Bindings', () => {
  const result = handlers.process_lifecycle_get({});
  assert.equal(result.validation.valid, true, result.validation.errors.join('\n'));
  assert.deepEqual(
    result.lifecycle.stages.map(stage => stage.id),
    [
      'initial-discovery',
      'solution-formalization',
      'solution-development',
      'delivery-release',
    ],
  );
});
