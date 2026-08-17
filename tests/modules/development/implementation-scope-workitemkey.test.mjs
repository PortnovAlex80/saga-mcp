// Workshop fix (в) — root fix at the author gate: the implementation result
// payload's LM-authored workItemKey must equal the kernel-authoritative
// cell_input_item.key of the accepted author task. Previously the gate only
// required "non-empty string", so a re-hired worker stamping the 24-hex
// workplace work_key passed acceptance and the settlement workset matcher
// dropped the item (units epic-8 cert#37, tips epic-5 cert#40 died on
// failed/implementation-workset-hash-invalid). The gate now fails closed
// with a decodable work-item-key-mismatch diagnostic and a repair recipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  createDevelopmentImplementationScopeCheckProvider,
} = await import('../../../dist/modules/development/application/development-check-providers.js');
const {
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
} = await import('../../../dist/modules/development/domain/development-schemas.js');
const { createGitPort } = await import(
  '../../../dist/infrastructure/process-modules/git-machine-ports.js'
);
const { decodeCheckDiagnostic } = await import(
  '../../../dist/process-modules/domain/workplace/check-diagnostic.js'
);

const CANDIDATE_REF = 'candidate-set/77/solution-development/implement/item/execution/author';
const DIGEST = 'a'.repeat(64);
const ITEM_KEY = 'item/core';
// The mis-key the killed runs actually carried: the workplace work_key
// (24-hex) stamped into the payload's workItemKey field.
const WORK_KEY = 'f'.repeat(24);

function git(repoPath, command) {
  return execSync(`git ${command}`, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  }).trim();
}

function makeProvider(repoPath, row) {
  return createDevelopmentImplementationScopeCheckProvider({
    db: { prepare: () => ({ get: () => row }) },
    candidateSets: {
      read: ref => ref === CANDIDATE_REF ? {
        candidateSetRef: CANDIDATE_REF,
        role: 'author',
        workplaceRef: { processRunId: 77 },
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            ref: 'managed-node-submission:41',
            digest: DIGEST,
          },
        }],
      } : null,
    },
    git: createGitPort(),
  }).run({ subjectCandidateSetRef: CANDIDATE_REF, parameters: { processRunId: 77 } });
}

function makeRow(repoPath, { base, commit, changedFiles, workItemKey }) {
  return {
    payload_snapshot: JSON.stringify({
      workItemKey,
      repository: { baseCommit: base },
      snapshot: { commitSha: commit, changedFiles },
    }),
    content_hash: DIGEST,
    metadata: JSON.stringify({
      cell_input_item: { key: ITEM_KEY, changeScopes: ['src/', 'docs/'] },
    }),
    local_path: repoPath,
    effective_base_commit: base,
  };
}

function outcome(result) {
  return typeof result === 'string' ? result : result.outcome;
}

function firstDiagnostic(result) {
  assert.equal(typeof result, 'object', 'result carries evidence');
  return decodeCheckDiagnostic(result.evidenceRefs[0]);
}

function setupRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-itemkey-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# itemkey\n');
  git(repoPath, 'init');
  git(repoPath, 'config user.email t@t');
  git(repoPath, 'config user.name t');
  git(repoPath, 'add -A');
  git(repoPath, 'commit -m base');
  return { dir, repoPath, base: git(repoPath, 'rev-parse HEAD') };
}

function commitFile(repoPath, relativePath, content, message) {
  mkdirSync(path.join(repoPath, path.dirname(relativePath)), { recursive: true });
  writeFileSync(path.join(repoPath, relativePath), content);
  git(repoPath, `add -A`);
  git(repoPath, `commit -m ${JSON.stringify(message)}`);
  return git(repoPath, 'rev-parse HEAD');
}

test('scope provider fails closed when workItemKey is the workplace work_key instead of cell_input_item.key', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      changedFiles: ['src/core/calculator.ts'],
      workItemKey: WORK_KEY,
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.ok(diagnostic, 'evidence must be a decodable check diagnostic');
    assert.equal(diagnostic.code, 'work-item-key-mismatch');
    assert.match(diagnostic.message, new RegExp(WORK_KEY));
    assert.match(diagnostic.message, new RegExp(ITEM_KEY));
    assert.match(diagnostic.message, /workItemKey must equal cell_input_item\.key/);
    assert.match(diagnostic.message, /work_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider fails closed when workItemKey is absent while cell_input_item.key exists', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      changedFiles: ['src/core/calculator.ts'],
      workItemKey: undefined,
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.equal(diagnostic.code, 'work-item-key-mismatch');
    assert.match(diagnostic.message, /cell_input_item\.key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider regression: exact workItemKey === cell_input_item.key still passes', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      changedFiles: ['src/core/calculator.ts'],
      workItemKey: ITEM_KEY,
    }));
    assert.equal(result, 'passed', 'the happy path must stay a bare pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
