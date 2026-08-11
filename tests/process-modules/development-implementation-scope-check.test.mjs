import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createDevelopmentImplementationScopeCheckProvider,
} = await import('../../dist/modules/development/application/development-check-providers.js');
const {
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
} = await import('../../dist/modules/development/domain/development-schemas.js');

function fixture({
  scopes = ['src/core/', 'src/types/'],
  changedFiles = ['src/core/calculator.ts', 'src/types/index.ts'],
  actualFiles = changedFiles,
  payloadBase = 'base-1',
  receiptBase = 'base-1',
} = {}) {
  const executionRef = 'worker-execution:scope-1';
  const candidateRef = 'candidate-set/77/solution-development/implement/item/execution/author';
  const digest = 'a'.repeat(64);
  const row = {
    payload_snapshot: JSON.stringify({
      repository: { baseCommit: payloadBase },
      snapshot: { commitSha: 'commit-2', changedFiles },
    }),
    content_hash: digest,
    metadata: JSON.stringify({ cell_input_item: { changeScopes: scopes } }),
    local_path: 'D:/repo',
    effective_base_commit: receiptBase,
  };
  const provider = createDevelopmentImplementationScopeCheckProvider({
    db: { prepare: () => ({ get: () => row }) },
    candidateSets: {
      read: ref => ref === candidateRef ? {
        candidateSetRef: candidateRef,
        role: 'author',
        workplaceRef: { processRunId: 77 },
        producerExecutionRef: executionRef,
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            ref: 'managed-node-submission:41',
            digest,
          },
        }],
      } : null,
    },
    git: {
      read: (_repo, args) => {
        assert.deepEqual(args, [
          'diff', '--name-only', '--diff-filter=ACDMRTUXB',
          `${receiptBase}..commit-2`,
        ]);
        return `${actualFiles.join('\n')}\n`;
      },
      ok: () => true,
    },
  });
  return provider.run({ subjectCandidateSetRef: candidateRef, parameters: { processRunId: 77 } });
}

test('implementation scope provider accepts an exact diff inside frozen scopes', () => {
  assert.equal(fixture(), 'passed');
});

test('implementation scope provider accepts typed changed-file objects from real workers', () => {
  assert.equal(fixture({
    changedFiles: [
      { path: 'src/core/calculator.ts', status: 'modified' },
      { path: 'src/types/index.ts', changeType: 'added', size: 120 },
    ],
    actualFiles: ['src/core/calculator.ts', 'src/types/index.ts'],
  }), 'passed');
});

test('implementation scope provider treats a normalized directory scope as its descendant tree', () => {
  assert.equal(fixture({
    scopes: ['src/core'],
    changedFiles: ['src/core/calculator.ts'],
  }), 'passed');
});

test('implementation scope provider rejects a changed-file object without a path', () => {
  assert.equal(fixture({
    changedFiles: [{ status: 'modified' }],
    actualFiles: ['src/core/calculator.ts'],
  }), 'error');
});

test('implementation scope provider rejects an undeclared build file before review', () => {
  assert.equal(fixture({
    changedFiles: ['package.json', 'src/core/calculator.ts'],
  }), 'failed');
});

test('implementation scope provider rejects claimed files that differ from Git', () => {
  assert.equal(fixture({
    changedFiles: ['src/core/calculator.ts'],
    actualFiles: ['src/core/calculator.ts', 'src/core/hidden.ts'],
  }), 'failed');
});

test('implementation scope provider rejects a model-selected base that differs from the desk receipt', () => {
  assert.equal(fixture({ payloadBase: 'stale-base' }), 'failed');
});

test('implementation scope provider rejects repository-control paths', () => {
  assert.equal(fixture({ scopes: ['.git/'], changedFiles: ['.git/config'] }), 'error');
});
