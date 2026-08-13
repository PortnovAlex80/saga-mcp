import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRepositoryFilePath,
  parseRepositoryScope,
  repositoryScopeContainsPath,
  repositoryScopesOverlap,
} from '../../dist/shared/repository-scope.js';

test('scope kind is explicit: trailing slash is a directory, otherwise exact file', () => {
  assert.deepEqual(parseRepositoryScope('src/core/'), {
    kind: 'directory-prefix', path: 'src/core',
  });
  assert.deepEqual(parseRepositoryScope('package.json'), {
    kind: 'exact-file', path: 'package.json',
  });
  assert.equal(repositoryScopeContainsPath(parseRepositoryScope('src/core/'), 'src/core/a.ts'), true);
  assert.equal(repositoryScopeContainsPath(parseRepositoryScope('src/core'), 'src/core/a.ts'), false);
});

test('scope containment is independent of scope order', () => {
  const scopes = ['build.gradle.kts', 'gradle/', 'gradlew', 'gradlew.bat', 'src/main/'];
  const candidates = ['gradle/wrapper/gradle-wrapper.properties', 'gradlew.bat', 'src/main/App.kt'];
  for (const candidate of candidates) {
    for (let offset = 0; offset < scopes.length; offset += 1) {
      const permutation = [...scopes.slice(offset), ...scopes.slice(0, offset)];
      assert.equal(
        permutation.map(parseRepositoryScope)
          .some(scope => repositoryScopeContainsPath(scope, candidate)),
        true,
      );
    }
  }
});

test('overlap is symmetric for exact files and directory prefixes', () => {
  const pairs = [
    ['src/', 'src/a.ts', true],
    ['src/a.ts', 'src/', true],
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/a/', 'src/ab/', false],
    ['src/a/', 'src/a/b/', true],
  ];
  for (const [left, right, expected] of pairs) {
    assert.equal(repositoryScopesOverlap(left, right), expected, `${left} <> ${right}`);
  }
});

test('repository authority rejects traversal, roots, Git internals and directory file paths', () => {
  for (const value of ['../x', '/x', 'C:/x', '.git/', 'src//x']) {
    assert.throws(() => parseRepositoryScope(value));
  }
  assert.throws(() => parseRepositoryFilePath('src/'));
  assert.throws(() => parseRepositoryFilePath('.git/config'));
});
