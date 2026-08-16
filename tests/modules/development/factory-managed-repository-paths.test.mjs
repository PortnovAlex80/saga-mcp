// Workshop fix A: the Factory writes desk/execution trackers under
// docs/<...>/executions/** and the .saga-bootstrap.md note into the product
// repo. These paths must be carve-out-able from BOTH sides of the
// implementation-scope equality so committing or declaring them cannot break
// the exact-set check (killed projects 9/snake and 6/themes).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isFactoryManagedRepositoryPath,
  partitionFactoryManagedPaths,
} = await import(
  '../../../dist/modules/development/domain/factory-managed-repository-paths.js'
);

test('predicate: recognizes the real factory execution-doc layout at any depth', () => {
  assert.equal(isFactoryManagedRepositoryPath(
    'docs/formalization/projects/3/executions/node-define-architecture-contract/worker-execution_x/tracker.md',
  ), true);
  assert.equal(isFactoryManagedRepositoryPath(
    'docs/development/projects/9/executions/node-implement/item/tracker.md',
  ), true);
  assert.equal(isFactoryManagedRepositoryPath(
    'docs/development/executions/node-x/tracker.md',
  ), true);
});

test('predicate: recognizes .saga-bootstrap.md in any directory', () => {
  assert.equal(isFactoryManagedRepositoryPath('.saga-bootstrap.md'), true);
  assert.equal(isFactoryManagedRepositoryPath('sub/dir/.saga-bootstrap.md'), true);
});

test('predicate: tolerates backslash separators and a leading ./', () => {
  assert.equal(isFactoryManagedRepositoryPath(
    'docs\\development\\projects\\1\\executions\\tracker.md',
  ), true);
  assert.equal(isFactoryManagedRepositoryPath('./.saga-bootstrap.md'), true);
});

test('predicate: rejects product paths that merely live under docs/', () => {
  assert.equal(isFactoryManagedRepositoryPath('docs/README.md'), false);
  assert.equal(isFactoryManagedRepositoryPath('docs/architecture/guide.md'), false);
  // docs/ then ZERO intermediate segments then executions/ is NOT the factory
  // layout (factory always writes docs/<stage>/.../executions/).
  assert.equal(isFactoryManagedRepositoryPath('docs/executions/tracker.md'), false);
  // A file named executions.md is not an executions/ segment.
  assert.equal(isFactoryManagedRepositoryPath('docs/design/executions.md'), false);
  assert.equal(isFactoryManagedRepositoryPath('src/index.html'), false);
  assert.equal(isFactoryManagedRepositoryPath('package.json'), false);
});

test('partition: splits a mixed list deterministically, preserving order', () => {
  const { productPaths, factoryManagedPaths } = partitionFactoryManagedPaths([
    'src/core/calculator.ts',
    '.saga-bootstrap.md',
    'docs/development/projects/9/executions/node-x/tracker.md',
    'src/types/index.ts',
  ]);
  assert.deepEqual(productPaths, ['src/core/calculator.ts', 'src/types/index.ts']);
  assert.deepEqual(factoryManagedPaths, [
    '.saga-bootstrap.md',
    'docs/development/projects/9/executions/node-x/tracker.md',
  ]);
});
