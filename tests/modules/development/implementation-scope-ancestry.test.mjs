// Workshop fix B (+A integration): ancestry and branch discipline for the
// implementation-scope provider. A worker commit that does NOT descend from
// the frozen effective base (e.g. after git reset onto unrelated history)
// used to pass silently, and rejected commits could leak onto the
// integration branch and be frozen as the next base. These tests run the
// provider against a REAL temp git repository through the production
// createGitPort() so merge-base semantics are exercised for real.
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

function makeRow(repoPath, { base, commit, changedFiles, branch }) {
  return {
    payload_snapshot: JSON.stringify({
      // Since provider v2.1.0 the payload key must equal the author task's
      // kernel-authoritative cell_input_item.key.
      workItemKey: 'item/core',
      repository: { baseCommit: base },
      snapshot: { commitSha: commit, changedFiles },
      ...(branch === undefined ? {} : { source: { branch } }),
    }),
    content_hash: DIGEST,
    metadata: JSON.stringify({ cell_input_item: { key: 'item/core', changeScopes: ['src/', 'docs/'] } }),
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-ancestry-'));
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# ancestry\n');
  git(repoPath, 'init');
  git(repoPath, 'config user.email t@t');
  git(repoPath, 'config user.name t');
  git(repoPath, 'add -A');
  git(repoPath, 'commit -m base');
  const defaultBranch = git(repoPath, 'symbolic-ref --short HEAD');
  return { dir, repoPath, base: git(repoPath, 'rev-parse HEAD'), defaultBranch };
}

function commitFile(repoPath, relativePath, content, message) {
  mkdirSync(path.join(repoPath, path.dirname(relativePath)), { recursive: true });
  writeFileSync(path.join(repoPath, relativePath), content);
  git(repoPath, `add -A`);
  git(repoPath, `commit -m ${JSON.stringify(message)}`);
  return git(repoPath, 'rev-parse HEAD');
}

test('scope provider passes a commit that descends from the frozen base on the task branch', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      changedFiles: ['src/core/calculator.ts'],
      branch: 'task/implement',
    }));
    assert.equal(outcome(result), 'passed');
    assert.equal(result, 'passed', 'a clean pass carries no note evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider rejects a commit on a side line that never contained the frozen base', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    // Divergent lines: main advanced base -> sibling, the desk froze the
    // sibling as the effective base, but the worker reset its branch onto
    // the ORIGINAL base commit and worked there. The commit descends from
    // the repository history yet NOT from the frozen base.
    const root = base;
    const sibling = commitFile(repoPath, 'docs/note.md', 'sibling\n', 'sibling');
    git(repoPath, `checkout -b task/side ${root}`);
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'side work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base: sibling,
      commit,
      changedFiles: ['src/core/calculator.ts'],
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.equal(diagnostic.code, 'commit-not-descended-from-base');
    assert.match(diagnostic.message, /does not descend from the frozen effective base/);
    assert.match(diagnostic.message, new RegExp(root.slice(0, 7)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider fails closed with the typed error when ancestry is indeterminate', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    // An orphan commit shares no history with the base: merge-base exits
    // non-zero, the ancestry is UNDETERMINABLE, and the provider must fail
    // closed — never skip the check.
    git(repoPath, 'checkout --orphan unrelated');
    git(repoPath, 'rm -rf .');
    writeFileSync(path.join(repoPath, 'src.ts'), 'export {};\n');
    git(repoPath, 'add -A');
    git(repoPath, 'commit -m orphan');
    const orphan = git(repoPath, 'rev-parse HEAD');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit: orphan,
      changedFiles: ['src.ts'],
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.equal(diagnostic.code, 'commit-not-descended-from-base');
    assert.match(diagnostic.message, /could not be determined/);
    assert.match(diagnostic.message, /failing closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider rejects a declared task branch whose head cannot reach the commit', () => {
  const { dir, repoPath, base, defaultBranch } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'one\n', 'work');
    // The worker declares the WRONG branch: the default branch has never
    // carried the work.
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      changedFiles: ['src/core/calculator.ts'],
      branch: defaultBranch,
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.equal(diagnostic.code, 'commit-not-on-task-branch');
    assert.match(diagnostic.message, /not reachable from the declared task branch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider: committing factory-managed docs no longer breaks equality (carve-out)', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    // The worker commits the factory desk tracker and bootstrap note
    // alongside real work...
    commitFile(
      repoPath,
      'docs/development/projects/9/executions/node-implement/worker-execution_x/tracker.md',
      'desk material\n',
      'work + desk docs',
    );
    mkdirSync(path.join(repoPath, 'src/core'), { recursive: true });
    writeFileSync(path.join(repoPath, 'src/core/calculator.ts'), 'export {};\n');
    git(repoPath, 'add -A');
    git(repoPath, 'commit -m code');
    writeFileSync(path.join(repoPath, '.saga-bootstrap.md'), 'bootstrap note\n');
    git(repoPath, 'add -A');
    git(repoPath, 'commit -m bootstrap');
    const head = git(repoPath, 'rev-parse HEAD');
    // ...and declares only the product file: the carve-out must neutralize
    // BOTH factory-managed diff entries and produce a PASS with a note.
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit: head,
      changedFiles: ['src/core/calculator.ts'],
    }));
    assert.equal(outcome(result), 'passed');
    const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
    assert.equal(diagnostic.code, 'factory-managed-paths-excluded');
    assert.match(diagnostic.message, /executions/);
    assert.match(diagnostic.message, /\.saga-bootstrap\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scope provider: changed-files-mismatch carries the repair recipe', () => {
  const { dir, repoPath, base } = setupRepo();
  try {
    git(repoPath, 'checkout -b task/implement');
    const commit = commitFile(repoPath, 'src/core/calculator.ts', 'export {};\n', 'work');
    const result = makeProvider(repoPath, makeRow(repoPath, {
      base,
      commit,
      // Declares a file the diff does not contain (and omits nothing else).
      changedFiles: ['src/core/calculator.ts', 'src/core/ghost.ts'],
    }));
    assert.equal(outcome(result), 'failed');
    const diagnostic = firstDiagnostic(result);
    assert.equal(diagnostic.code, 'changed-files-mismatch');
    assert.match(diagnostic.message, /git diff --name-only/);
    assert.match(diagnostic.message, /declare exactly that set/);
    assert.match(diagnostic.message, /excluded automatically/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
