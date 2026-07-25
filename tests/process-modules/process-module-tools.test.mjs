import assert from 'node:assert/strict';
import test from 'node:test';

const { definitions, handlers } = await import('../../dist/tools/process-modules.js');

const toolNames = definitions.map(definition => definition.name);

test('MCP exposes read-only Process Module catalog tools', () => {
  assert.deepEqual(toolNames.sort(), [
    'process_lifecycle_get',
    'process_module_get',
    'process_module_list',
    'process_module_validate',
  ]);
  for (const definition of definitions) {
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
  }
});

test('process_module_list returns Discovery and Formalization', () => {
  const result = handlers.process_module_list({});
  assert.equal(result.count, 2);
  const refs = result.modules.map(
    module => `${module.identity.name}@${module.identity.version}`,
  );
  assert.deepEqual(refs.sort(), ['product-discovery@3.0.0', 'solution-formalization@1.0.0']);
  assert.ok(result.modules.every(module => module.valid === true));
});

test('process_module_get returns complete definition and validation', () => {
  const result = handlers.process_module_get({
    name: 'product-discovery',
    version: '3.0.0',
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

test('process_lifecycle_get exposes valid Discovery-to-Formalization Stage Bindings', () => {
  const result = handlers.process_lifecycle_get({});
  assert.equal(result.validation.valid, true, result.validation.errors.join('\n'));
  assert.deepEqual(
    result.lifecycle.stages.map(stage => stage.id),
    ['initial-discovery', 'solution-formalization'],
  );
});
