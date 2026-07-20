/**
 * ADR-013 Phase 4.2 — integration executor consumer loop wiring.
 *
 * Source: docs/architecture/decisions/013-lifecycle-fix-execution-plan.md §4.2.
 *
 * Coverage:
 *   1. processIntegrationIntent on a missing intent → outcome='skipped'.
 *   2. processIntegrationIntent on already-processed intent → 'skipped'.
 *   3. processPendingIntegrationIntents summary: empty queue → zero counts.
 *   4. End-to-end with a real git repo: create intent, drain, observe 'merged'.
 *   5. End-to-end conflict scenario: target has conflicting change → 'conflict'.
 *   6. Idempotency: re-drain after success → already_merged.
 *
 * These tests exercise the deterministic executor directly. They do NOT test
 * the worker_merge_release → intent bridge (that wiring is coexistence-only
 * in Phase 4.2 — the worker still drives the merge itself).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb } from '../../dist/db.js';
import { handlers as projects } from '../../dist/tools/projects.js';
import { handlers as epics } from '../../dist/tools/epics.js';
import { handlers as tasks } from '../../dist/tools/tasks.js';
import { handlers as repositories } from '../../dist/tools/repositories.js';
import {
  findOrCreateIntent,
  processIntegrationIntent,
  processPendingIntegrationIntents,
} from '../../dist/lifecycle/integration-executor.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-iexec-'));
process.env.DB_PATH = path.join(temp, 'iexec.db');
const machineId = os.hostname();

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers — set up a git repo with a target branch + a feature branch.
// ---------------------------------------------------------------------------

function makeGitRepoWithBranches() {
  const repoPath = path.join(temp, `repo-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@saga'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'saga-test'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repoPath });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();
  return { repoPath, baseSha };
}

function makeFeatureBranch(repoPath, baseSha, content) {
  const branchName = `task/feature-${Math.random().toString(36).slice(2, 6)}`;
  execFileSync('git', ['checkout', '-b', branchName, baseSha], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'feature.txt'), content);
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'feature'], { cwd: repoPath });
  const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();
  execFileSync('git', ['checkout', 'dev'], { cwd: repoPath });
  return { featureBranch: branchName, featureSha };
}

function registerProjectWithRepo(repoPath) {
  const product = projects.project_create({ name: `IE ${Math.random().toString(36).slice(2, 6)}` });
  const repo = repositories.repository_register({
    project_id: product.id, name: 'r', local_path: repoPath,
    default_branch: 'dev', integration_branch: 'dev',
  });
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: machineId, local_path: repoPath,
  });
  const epic = epics.epic_create({ project_id: product.id, name: 'E' });
  return { product, repo, epic };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('iexec: processIntegrationIntent on missing intent → skipped', () => {
  const result = processIntegrationIntent(getDb(), 'i-does-not-exist', machineId);
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.task_id, -1);
});

test('iexec: processPendingIntegrationIntents on empty queue → all zero', () => {
  const summary = processPendingIntegrationIntents(getDb(), machineId);
  assert.equal(summary.processed, 0);
  assert.equal(summary.merged, 0);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.errors, 0);
});

test('iexec: end-to-end merge — create intent, drain, observe merged', () => {
  const { repoPath, baseSha } = makeGitRepoWithBranches();
  const { featureBranch, featureSha } = makeFeatureBranch(repoPath, baseSha, 'feature content\n');
  const { repo, epic } = registerProjectWithRepo(repoPath);
  const t = tasks.task_create({
    epic_id: epic.id, title: 'T', task_kind: 'development.code',
    execution_mode: 'git_change', priority: 'high',
    project_repository_id: repo.id,
  });

  const intent = findOrCreateIntent(getDb(), {
    integrationId: `iim-${t.id}-${Math.random().toString(36).slice(2, 6)}`,
    originatingCommandId: `test:${t.id}`,
    taskId: t.id,
    projectRepositoryId: repo.id,
    sourceBranch: featureBranch,
    reviewedSourceSha: featureSha,
    targetBranch: 'dev',
    expectedTargetSha: baseSha,
  });

  const result = processIntegrationIntent(getDb(), intent.integration_id, machineId);
  assert.equal(result.outcome, 'merged', `expected merged, got ${result.outcome}: ${result.message}`);
  assert.ok(result.merge_commit, 'merge_commit returned');

  // Verify the git side: dev branch advanced past baseSha.
  const newDevSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'dev']).toString().trim();
  assert.notEqual(newDevSha, baseSha, 'dev branch advanced');
  // The merge commit should be the new dev HEAD.
  assert.equal(newDevSha, result.merge_commit);
});

test('iexec: idempotent re-drain — already_merged on second pass', () => {
  const { repoPath, baseSha } = makeGitRepoWithBranches();
  const { featureBranch, featureSha } = makeFeatureBranch(repoPath, baseSha, 'idempotent feature\n');
  const { repo, epic } = registerProjectWithRepo(repoPath);
  const t = tasks.task_create({
    epic_id: epic.id, title: 'T2', task_kind: 'development.code',
    execution_mode: 'git_change', priority: 'high',
    project_repository_id: repo.id,
  });

  const intent = findOrCreateIntent(getDb(), {
    integrationId: `iim2-${t.id}-${Math.random().toString(36).slice(2, 6)}`,
    originatingCommandId: `test2:${t.id}`,
    taskId: t.id,
    projectRepositoryId: repo.id,
    sourceBranch: featureBranch,
    reviewedSourceSha: featureSha,
    targetBranch: 'dev',
    expectedTargetSha: baseSha,
  });

  // First drain: performs the merge.
  const first = processIntegrationIntent(getDb(), intent.integration_id, machineId);
  assert.equal(first.outcome, 'merged');

  // Second drain on the same (now 'merged') intent: short-circuits as skipped
  // because state is no longer 'pending'/'retryable'.
  const second = processIntegrationIntent(getDb(), intent.integration_id, machineId);
  assert.equal(second.outcome, 'skipped', `expected skipped, got ${second.outcome}`);
  assert.equal(second.merge_commit, first.merge_commit, 'result preserved');
});

test('iexec: conflict scenario — target has overlapping change → conflict', () => {
  const { repoPath, baseSha } = makeGitRepoWithBranches();
  // Create a feature branch that modifies README.md.
  const featureBranch = `task/conflict-${Math.random().toString(36).slice(2, 6)}`;
  execFileSync('git', ['checkout', '-b', featureBranch, baseSha], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'README.md'), 'CONFLICTING content from feature\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'feature'], { cwd: repoPath });
  const featureSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath }).toString().trim();
  execFileSync('git', ['checkout', 'dev'], { cwd: repoPath });

  // Advance dev with a conflicting change to the SAME file.
  writeFileSync(path.join(repoPath, 'README.md'), 'CONFLICTING content from dev\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'dev advance'], { cwd: repoPath });
  const newDevSha = execFileSync('git', ['rev-parse', 'dev'], { cwd: repoPath }).toString().trim();

  const { repo, epic } = registerProjectWithRepo(repoPath);
  const t = tasks.task_create({
    epic_id: epic.id, title: 'T3', task_kind: 'development.code',
    execution_mode: 'git_change', priority: 'high',
    project_repository_id: repo.id,
  });

  const intent = findOrCreateIntent(getDb(), {
    integrationId: `iim3-${t.id}-${Math.random().toString(36).slice(2, 6)}`,
    originatingCommandId: `test3:${t.id}`,
    taskId: t.id,
    projectRepositoryId: repo.id,
    sourceBranch: featureBranch,
    reviewedSourceSha: featureSha,
    targetBranch: 'dev',
    // Pass the new dev sha so observeRepository returns 'ready_to_merge'
    // and performMerge runs into the conflicting content.
    expectedTargetSha: newDevSha,
  });

  const result = processIntegrationIntent(getDb(), intent.integration_id, machineId);
  assert.equal(
    result.outcome, 'conflict',
    `expected conflict, got ${result.outcome}: ${result.message}`,
  );
  assert.ok(result.conflict_files && result.conflict_files.length > 0,
    'conflict file list populated');
});
