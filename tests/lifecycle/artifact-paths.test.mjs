// Tests for artifact path normalisation (absolute → relative).
//
// Workers sometimes write absolute paths (D:\Development\moscito\docs\...)
// despite the skill template saying 'docs/...'. The artifact_create handler
// (src/tools/artifacts.ts) normalises absolute → relative by stripping the
// project_repository.local_path prefix. This test verifies that behaviour
// and the resolveArtifactFile helper in tracker-view that handles the
// residual absolute paths (the handler cannot fix paths when the worker
// omitted project_repository_id).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import test, { after } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-art-paths-'));
process.env.DB_PATH = path.join(temp, 'art-paths.db');

const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: artifacts } = await import('../../dist/tools/artifacts.js');
const { handlers: repositories } = await import('../../dist/tools/repositories.js');
const { closeDb, getDb } = await import('../../dist/db.js');

// We need path.* but 'path' is shadowed by the artifact.path arg name. Use nodePath.
import path from 'node:path';

after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function makeFixture(repoName = 'path-test-repo') {
  const project = projects.project_create({ name: `Path-Test-${Date.now()}-${Math.random().toString(36).slice(2,6)}` });
  const repoDir = path.join(temp, repoName);
  mkdirSync(repoDir, { recursive: true });
  // Seed a markdown file so artifactDiskHash can read it.
  const docsDir = path.join(repoDir, 'docs', 'requirements', 'REQ-001-test');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, 'PRD.md'), '# PRD\n\nTest content');
  const repo = repositories.repository_register({
    project_id: project.id, name: repoName, local_path: repoDir,
  });
  const epic = epics.epic_create({ project_id: project.id, name: 'REQ-001-test' });
  return { project, repo, epic, repoDir, docsDir };
}

// ---------------------------------------------------------------------------
// Test 1: absolute path under repo root is normalised to relative.
// ---------------------------------------------------------------------------

test('artifact_create: normalises absolute path under repo root to relative', () => {
  const { project, repo, epic, repoDir } = makeFixture('normalise-test');
  const absPath = path.join(repoDir, 'docs', 'requirements', 'REQ-001-test', 'PRD.md');

  const art = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id,
    type: 'PRD', title: 'PRD',
    path: absPath,            // worker wrote absolute — handler should normalise
    project_repository_id: repo.id,
  });

  // The stored path MUST be relative.
  assert.equal(art.path, 'docs/requirements/REQ-001-test/PRD.md',
    'absolute path should be normalised to relative by stripping local_path prefix');

  // content_hash should be populated (handler reads the file from the resolved path).
  assert.ok(art.content_hash, 'content_hash populated from disk via normalised path');
});

// ---------------------------------------------------------------------------
// Test 2: absolute path NOT under repo root is kept as-is + tagged.
// ---------------------------------------------------------------------------

test('artifact_create: tags absolute path not under repo root', () => {
  const { project, repo, epic } = makeFixture('not-under-root');
  // An absolute path that does NOT start with repo.local_path.
  const weirdPath = process.platform === 'win32'
    ? 'Z:\\foreign\\repo\\docs\\PRD.md'
    : '/foreign/repo/docs/PRD.md';

  const art = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id,
    type: 'PRD', title: 'PRD',
    path: weirdPath,
    project_repository_id: repo.id,
  });

  // Path is kept as-is (cannot be normalised), but metadata carries a warning.
  assert.equal(art.path, weirdPath, 'path kept as-is when not under repo root');
  const meta = typeof art.metadata === 'string' ? JSON.parse(art.metadata) : art.metadata;
  assert.equal(meta.path_warning, 'absolute_path_not_under_repo_root',
    'metadata tagged with path_warning for triage');
});

// ---------------------------------------------------------------------------
// Test 3: absolute path with no project_repository_id is kept + tagged.
// ---------------------------------------------------------------------------

test('artifact_create: tags absolute path when no repo binding', () => {
  const project = projects.project_create({ name: 'NoRepoBinding-' + Date.now() });
  const epic = epics.epic_create({ project_id: project.id, name: 'REQ-nr' });
  const weirdPath = process.platform === 'win32'
    ? 'D:\\Development\\foo\\docs\\PRD.md'
    : '/tmp/foo/docs/PRD.md';

  const art = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id,
    type: 'PRD', title: 'PRD',
    path: weirdPath,
    // project_repository_id omitted
  });

  assert.equal(art.path, weirdPath);
  const meta = typeof art.metadata === 'string' ? JSON.parse(art.metadata) : art.metadata;
  assert.equal(meta.path_warning, 'absolute_path_no_repo_binding');
});

// ---------------------------------------------------------------------------
// Test 4: relative path is unchanged (no warning).
// ---------------------------------------------------------------------------

test('artifact_create: relative path is unchanged', () => {
  const { project, repo, epic } = makeFixture('relative-test');
  const art = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id,
    type: 'PRD', title: 'PRD',
    path: 'docs/requirements/REQ-001-test/PRD.md',
    project_repository_id: repo.id,
  });

  assert.equal(art.path, 'docs/requirements/REQ-001-test/PRD.md');
  const meta = typeof art.metadata === 'string' ? JSON.parse(art.metadata) : art.metadata;
  assert.equal(meta.path_warning, undefined, 'no path_warning for relative path');
});

// ---------------------------------------------------------------------------
// Test 5: anchor suffix (#AC-N) preserved through normalisation.
// ---------------------------------------------------------------------------

test('artifact_create: anchor suffix preserved through normalisation', () => {
  const { project, repo, epic, repoDir, docsDir } = makeFixture('anchor-test');
  writeFileSync(path.join(docsDir, 'AC.md'), '# AC\n\n## AC-1\n\ngiven');
  const absPath = path.join(repoDir, 'docs', 'requirements', 'REQ-001-test', 'AC.md') + '#AC-1';

  const art = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id,
    type: 'AC', code: 'AC-1', title: 'AC-1',
    path: absPath,
    project_repository_id: repo.id,
  });

  assert.equal(art.path, 'docs/requirements/REQ-001-test/AC.md#AC-1',
    'anchor suffix preserved after normalisation');
  assert.ok(art.content_hash, 'content_hash computed from file (anchor stripped)');
});

// ---------------------------------------------------------------------------
// Test 6: resolveArtifactFile (tracker-view helper) handles absolute path.
// Simulated — we test the regex pattern, since tracker-view is not ESM-importable.
// ---------------------------------------------------------------------------

test('resolveArtifactFile: regex detects absolute paths (Windows + POSIX)', () => {
  // Mirror the regex from tracker-view resolveArtifactFile.
  const looksAbsolute = (p) => /^([A-Za-z]:[\\/]|[\\/]|\\\\[^?])/.test(p.split('#')[0]);

  // Windows absolute
  assert.equal(looksAbsolute('D:\\Development\\moscito\\docs\\PRD.md'), true);
  assert.equal(looksAbsolute('D:/Development/moscito/docs/PRD.md'), true);
  // POSIX absolute
  assert.equal(looksAbsolute('/home/user/repo/docs/PRD.md'), true);
  // UNC
  assert.equal(looksAbsolute('\\\\server\\share\\docs\\PRD.md'), true);
  // Relative — should NOT match
  assert.equal(looksAbsolute('docs/requirements/REQ-001/PRD.md'), false);
  assert.equal(looksAbsolute('docs\\requirements\\PRD.md'), false);
  // Anchor suffix with absolute base
  assert.equal(looksAbsolute('D:\\dev\\repo\\docs\\AC.md#AC-1'), true);
  // Anchor suffix with relative base
  assert.equal(looksAbsolute('docs/AC.md#AC-1'), false);
});

// ---------------------------------------------------------------------------
// Test 7: path.join sanity — verify the bug we are fixing.
// ---------------------------------------------------------------------------

test('regression: path.join(root, absPath) on Windows produces garbage', () => {
  // This test documents WHY the absolute-path detection exists.
  // path.join('D:/Development/moscito', 'D:\\Development\\moscito\\docs\\PRD.md')
  // returns a non-existent path on Windows. We do not assert exact output
  // (it varies by platform); we just assert the result does NOT exist as a file.
  const root = process.platform === 'win32' ? 'D:/Development/moscito' : '/tmp/moscito';
  const absPath = process.platform === 'win32'
    ? 'D:\\Development\\moscito\\docs\\PRD.md'
    : '/tmp/moscito/docs/PRD.md';
  const joined = path.join(root, absPath);
  // The joined path either doesn't exist OR exists only if a real file happens
  // to be there. We cannot assert "doesn't exist" deterministically, so we
  // assert the join produced something different from the clean absPath —
  // which proves the path was NOT used as-is.
  assert.notEqual(joined, absPath,
    'path.join with absolute second arg mangles the path');
});
