// tests/infrastructure/previous-attempt-desk.test.mjs
//
// REPAIR-CODE-PRESERVATION (docs/architecture/REPAIR-CODE-PRESERVATION.md):
// the code of a rejected attempt is NOT lost (branches live in shared refs)
// but the author is BLIND — nobody tells the worker the previous code exists.
// The reviewer sees it (readAcceptedSourceCommit); the author gets nothing.
// The agreed cure: at repair-provisioning (managed_review_rejections > 0) the
// provisioner writes previous-attempt.{json,patch} into the execution
// workspace (next to recovery-feedback.json), derived as
// `git diff <merge-base>..<previousAttemptHead>`.
//
// "See it, but do not be bound": the patch is a VIEW (no auto-merge, no
// rebase — frozen-base contract intact, anchoring bias avoided). These tests
// pin the physical desk mechanics; the prompt line is pinned separately in
// tests/worker-prompt-assembly.test.mjs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RepositoryDeskProvisioner } from
  '../../dist/infrastructure/workers/repository-desk-provisioner.js';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function setupBaseRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(path.join(root, 'product.txt'), 'base-content\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', '-M', 'dev');
  return root;
}

function commitFile(worktree, file, content, message) {
  writeFileSync(path.join(worktree, file), content);
  git(worktree, 'add', '--', file);
  git(worktree, 'commit', '-m', message);
  return git(worktree, 'rev-parse', 'HEAD');
}

function authorInput(root, taskId, executionRef, extra = {}) {
  return {
    repositoryRoot: root,
    taskId,
    executionRef,
    integrationBranch: 'dev',
    projectRepositoryId: 1,
    ...extra,
  };
}

test('previous-attempt: repair provisioning writes patch + typed descriptor next to each other', () => {
  const root = setupBaseRepo();
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-ws-'));
  try {
    const provisioner = new RepositoryDeskProvisioner();

    // Attempt 1: the rejected execution's desk (branch lives in shared refs).
    const firstDesk = provisioner.provisionAuthorDesk(
      authorInput(root, 16, 'exec-rejected-1'),
    );
    const rejectedHead = commitFile(
      firstDesk.executionPath,
      'feature.ts',
      'export const attemptOne = true; // REJECTED-ATTEMPT-MARKER\n',
      'attempt one (rejected by reviewer)',
    );

    // Attempt 2: repair execution provisioned with the previous attempt.
    const repairDesk = provisioner.provisionAuthorDesk(authorInput(
      root, 16, 'exec-repair-2', {
        previousAttempt: {
          branch: firstDesk.git.branch,
          commitSha: rejectedHead,
          patchDirectory: workspaceDir,
        },
      },
    ));

    const descriptorPath = path.join(workspaceDir, 'previous-attempt.json');
    const patchPath = path.join(workspaceDir, 'previous-attempt.patch');
    assert.ok(existsSync(descriptorPath), 'previous-attempt.json must be on the desk');
    assert.ok(existsSync(patchPath), 'previous-attempt.patch must be on the desk');
    assert.equal(path.dirname(descriptorPath), path.dirname(patchPath),
      'patch and descriptor live in the SAME directory (next to recovery-feedback.json)');

    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    assert.deepEqual(descriptor, { branch: firstDesk.git.branch, commitSha: rejectedHead },
      'descriptor is exactly the typed {branch, commitSha} provenance');

    const patch = readFileSync(patchPath, 'utf8');
    assert.ok(patch.includes('diff --git'), 'patch is a unified git diff');
    assert.ok(patch.includes('+export const attemptOne = true; // REJECTED-ATTEMPT-MARKER'),
      'patch carries the rejected attempt change relative to the merge-base');
    assert.ok(!patch.includes('-export const attemptOne'),
      'patch must not diff against anything but the merge-base');

    // The desk carries the typed previousAttempt provenance for settlement.
    assert.equal(repairDesk.previousAttempt.branch, firstDesk.git.branch);
    assert.equal(repairDesk.previousAttempt.commitSha, rejectedHead);
    assert.equal(repairDesk.previousAttempt.mergeBaseCommit,
      git(root, 'merge-base', git(root, 'rev-parse', 'refs/heads/dev'), rejectedHead),
      'merge-base is recorded on the desk');

    // The repair branch itself is untouched: see-but-not-bound.
    assert.notEqual(repairDesk.git.branch, firstDesk.git.branch,
      'repair desk is a NEW branch — no inheritance of the rejected code');
    assert.equal(repairDesk.git.headCommit, git(root, 'rev-parse', 'refs/heads/dev'),
      'repair desk still starts clean from the frozen base');
  } finally {
    execFileSync('git', ['-C', root, 'worktree', 'list'], { encoding: 'utf8' });
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('previous-attempt: merge-base semantics — integration drift between attempts stays OUT of the patch', () => {
  const root = setupBaseRepo();
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-ws-'));
  try {
    const provisioner = new RepositoryDeskProvisioner();
    const firstDesk = provisioner.provisionAuthorDesk(
      authorInput(root, 21, 'exec-rejected-1'),
    );
    const rejectedHead = commitFile(
      firstDesk.executionPath,
      'feature.ts',
      'attempt-one\n',
      'attempt one',
    );

    // Between attempts the integration branch advanced (another cell landed).
    writeFileSync(path.join(root, 'unrelated.txt'), 'landed-by-another-cell\n');
    git(root, 'add', '--', 'unrelated.txt');
    git(root, 'commit', '-m', 'integration advanced');

    provisioner.provisionAuthorDesk(authorInput(root, 21, 'exec-repair-2', {
      previousAttempt: {
        branch: firstDesk.git.branch,
        commitSha: rejectedHead,
        patchDirectory: workspaceDir,
      },
    }));

    const patch = readFileSync(path.join(workspaceDir, 'previous-attempt.patch'), 'utf8');
    assert.ok(patch.includes('+attempt-one'),
      'the rejected attempt change is present');
    assert.ok(!patch.includes('landed-by-another-cell'),
      'integration drift since the attempt is NOT part of the previous-attempt diff');
  } finally {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('previous-attempt: absent input leaves the workspace untouched (first pass stays blind-free)', () => {
  const root = setupBaseRepo();
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-ws-'));
  try {
    const provisioner = new RepositoryDeskProvisioner();
    provisioner.provisionAuthorDesk(authorInput(root, 33, 'exec-first'));
    assert.ok(!existsSync(path.join(workspaceDir, 'previous-attempt.json')));
    assert.ok(!existsSync(path.join(workspaceDir, 'previous-attempt.patch')));
  } finally {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('previous-attempt: idempotent re-provision rewrites byte-identical materials', () => {
  const root = setupBaseRepo();
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-ws-'));
  try {
    const provisioner = new RepositoryDeskProvisioner();
    const firstDesk = provisioner.provisionAuthorDesk(
      authorInput(root, 44, 'exec-rejected-1'),
    );
    const rejectedHead = commitFile(firstDesk.executionPath, 'f.txt', 'one\n', 'attempt');

    const input = authorInput(root, 44, 'exec-repair-2', {
      previousAttempt: {
        branch: firstDesk.git.branch,
        commitSha: rejectedHead,
        patchDirectory: workspaceDir,
      },
    });
    provisioner.provisionAuthorDesk(input);
    const patch1 = readFileSync(path.join(workspaceDir, 'previous-attempt.patch'), 'utf8');
    const json1 = readFileSync(path.join(workspaceDir, 'previous-attempt.json'), 'utf8');

    // Crash-retry: the same desk is provisioned again (idempotent reuse path).
    provisioner.provisionAuthorDesk(input);
    const patch2 = readFileSync(path.join(workspaceDir, 'previous-attempt.patch'), 'utf8');
    const json2 = readFileSync(path.join(workspaceDir, 'previous-attempt.json'), 'utf8');
    assert.equal(patch1, patch2, 'patch rewrite is byte-stable');
    assert.equal(json1, json2, 'descriptor rewrite is byte-stable');
  } finally {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('previous-attempt: FAIL-CLOSED on descriptor/branch mismatch — never write an unverifiable patch', () => {
  const root = setupBaseRepo();
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'saga-prev-attempt-ws-'));
  try {
    const provisioner = new RepositoryDeskProvisioner();
    const firstDesk = provisioner.provisionAuthorDesk(
      authorInput(root, 55, 'exec-rejected-1'),
    );
    const rejectedHead = commitFile(firstDesk.executionPath, 'f.txt', 'one\n', 'attempt');
    const staleSha = git(root, 'rev-parse', 'refs/heads/dev');

    assert.throws(
      () => provisioner.provisionAuthorDesk(authorInput(root, 55, 'exec-repair-2', {
        previousAttempt: {
          branch: firstDesk.git.branch,
          commitSha: staleSha,
          patchDirectory: workspaceDir,
        },
      })),
      /REPOSITORY_DESK_PREVIOUS_ATTEMPT_MISMATCH/,
      'a commitSha that is not the branch head must abort provisioning loudly',
    );
    assert.ok(!existsSync(path.join(workspaceDir, 'previous-attempt.patch')),
      'no patch may be written from unverifiable coordinates');

    assert.throws(
      () => provisioner.provisionAuthorDesk(authorInput(root, 55, 'exec-repair-3', {
        previousAttempt: {
          branch: 'saga/task/55/execution/nonexistent0000000000',
          commitSha: rejectedHead,
          patchDirectory: workspaceDir,
        },
      })),
      /REPOSITORY_DESK_PREVIOUS_ATTEMPT_REF_MISSING/,
      'a missing previous branch must abort provisioning loudly',
    );
    assert.ok(!existsSync(path.join(workspaceDir, 'previous-attempt.json')));
  } finally {
    execFileSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
