// Integration test for the Phase C docs merge flow.
// Run: node --test tests/docs-graph-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const docsWorktree = require(path.join(__dirname, '..', 'dist', 'lifecycle', 'docs-worktree.js'));

/** Set up a temp git repo with a `main` and a `dev` integration branch. */
function setupRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'docs-merge-'));
  const git = (args) =>
    spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 'T']);
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs', 'existing.md'), '# Existing\noriginal\n');
  writeFileSync(path.join(repo, 'README.md'), '# Readme\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  // Integration branch dev off main.
  git(['branch', 'dev', 'main']);
  return { repo, git };
}

test('mergeDocsBranch: clean merge → merged + integration branch has new content', () => {
  const { repo, git } = setupRepo();
  try {
    // Create a docs change that adds a new file + modifies an existing one.
    const wt = docsWorktree.createChange(repo, { changeId: 'feat-1', baseRef: 'dev' });
    docsWorktree.writeFile(wt.worktreePath, 'docs/new.md', '# New\n');
    docsWorktree.writeFile(wt.worktreePath, 'docs/existing.md', '# Existing\nupdated\n');
    docsWorktree.commit(wt.worktreePath, 'docs: feat-1 changes');

    const result = docsWorktree.mergeDocsBranch(repo, 'feat-1', 'dev');
    assert.equal(result.kind, 'merged');
    assert.match(result.mergeCommitSha, /^[0-9a-f]{40}$/);

    // After merge, dev branch must contain the new content.
    const showNew = git(['show', 'dev:docs/new.md']).stdout;
    assert.match(showNew, /# New/);
    const showExisting = git(['show', 'dev:docs/existing.md']).stdout;
    assert.match(showExisting, /updated/);

    // And the merge commit carries our trailer.
    const log = git(['log', '-1', '--format=%B', 'dev']).stdout;
    assert.match(log, /Saga-Docs-Change: feat-1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeDocsBranch: idempotent — second call reports already_merged', () => {
  const { repo } = setupRepo();
  try {
    const wt = docsWorktree.createChange(repo, { changeId: 'idem-1', baseRef: 'dev' });
    docsWorktree.writeFile(wt.worktreePath, 'docs/a.md', 'A\n');
    docsWorktree.commit(wt.worktreePath, 'add a.md');
    const r1 = docsWorktree.mergeDocsBranch(repo, 'idem-1', 'dev');
    assert.equal(r1.kind, 'merged');
    const r2 = docsWorktree.mergeDocsBranch(repo, 'idem-1', 'dev');
    assert.equal(r2.kind, 'already_merged');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeDocsBranch: conflict on concurrent edits to same file', () => {
  const { repo, git } = setupRepo();
  try {
    // Start the docs branch off dev.
    const wt = docsWorktree.createChange(repo, { changeId: 'conf-1', baseRef: 'dev' });
    docsWorktree.writeFile(wt.worktreePath, 'docs/existing.md', '# Existing\nfrom docs branch\n');
    docsWorktree.commit(wt.worktreePath, 'edit existing from docs');

    // Meanwhile, commit a conflicting edit directly to dev.
    git(['checkout', '-q', 'dev']);
    writeFileSync(path.join(repo, 'docs', 'existing.md'), '# Existing\nfrom dev directly\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'dev edit']);
    // Return to main so subsequent worktree ops don't trip on a checked-out branch.
    git(['checkout', '-q', 'main']);

    const result = docsWorktree.mergeDocsBranch(repo, 'conf-1', 'dev');
    assert.equal(result.kind, 'conflict');
    assert.ok(result.conflictFiles.some((f) => f.endsWith('existing.md')));
    // Target branch must NOT have absorbed the docs branch content — the
    // conflict aborted the merge, so dev still carries the dev-side edit only.
    const devContent = git(['show', 'dev:docs/existing.md']).stdout;
    assert.match(devContent, /from dev directly/);
    assert.doesNotMatch(devContent, /from docs branch/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeDocsBranch: source_missing when branch does not exist', () => {
  const { repo } = setupRepo();
  try {
    const result = docsWorktree.mergeDocsBranch(repo, 'never-created', 'dev');
    assert.equal(result.kind, 'source_missing');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('mergeDocsBranch: base_advanced when caller-supplied expected sha is stale', () => {
  const { repo, git } = setupRepo();
  try {
    const wt = docsWorktree.createChange(repo, { changeId: 'adv-1', baseRef: 'dev' });
    docsWorktree.writeFile(wt.worktreePath, 'docs/x.md', 'x\n');
    docsWorktree.commit(wt.worktreePath, 'add x');

    const devBefore = git(['rev-parse', 'dev']).stdout;
    // Dev advances after the caller captured `devBefore`.
    git(['checkout', '-q', 'dev']);
    writeFileSync(path.join(repo, 'docs', 'y.md'), 'y\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'separate dev commit']);
    git(['checkout', '-q', 'main']);

    const result = docsWorktree.mergeDocsBranch(repo, 'adv-1', 'dev', {
      expectedTargetSha: devBefore,
    });
    assert.equal(result.kind, 'base_advanced');
    assert.equal(result.expectedTargetSha, devBefore);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('filesTouchedBetween: lists files between two shas', () => {
  const { repo, git } = setupRepo();
  try {
    const devTip = git(['rev-parse', 'dev']).stdout.trim();
    const wt = docsWorktree.createChange(repo, { changeId: 'files-1', baseRef: 'dev' });
    docsWorktree.writeFile(wt.worktreePath, 'docs/added.md', 'new\n');
    docsWorktree.writeFile(wt.worktreePath, 'docs/existing.md', '# Existing\nchanged\n');
    docsWorktree.commit(wt.worktreePath, 'edits');

    const branchTip = git(['rev-parse', 'docs/files-1']).stdout.trim();
    const files = docsWorktree.filesTouchedBetween(repo, devTip, branchTip).sort();
    assert.deepEqual(files, ['docs/added.md', 'docs/existing.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
