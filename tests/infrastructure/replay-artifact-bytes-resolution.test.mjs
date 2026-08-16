// tests/infrastructure/replay-artifact-bytes-resolution.test.mjs
//
// Regression: REPLAY_CAPTURE_FILE_BYTES_MISSING on replay certification when
// the artifact row carries NO per-artifact repository binding
// (project_repository_id IS NULL — the normal shape of worker-authored
// formulation documents). readArtifactBytes must fall back to the project's
// active CONTROL repository instead of resolving the relative docs/ path
// against the engine's cwd (where the file never exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { readArtifactBytes } from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'saga-replay-bytes-'));
  const repoPath = path.join(dir, 'project-repo');
  const docsDir = path.join(repoPath, 'docs', 'requirements');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, '02-use-cases.md'), '# Use Cases\n\nUC-1 body\n');

  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'p','active')").run();
  db.prepare("INSERT INTO repositories (id,name,default_branch) VALUES (1,'r','main')").run();
  db.prepare(
    `INSERT INTO project_repositories (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'control',?, 'main','active')`,
  ).run(repoPath);
  return { db, dir };
}

test('unbound artifact resolves bytes via the project control repository', () => {
  const { db, dir } = fixture();
  try {
    const bytes = readArtifactBytes(db, {
      path: 'docs/requirements/02-use-cases.md#UC-1',
      project_id: 1,
      project_repository_id: null,
    });
    assert.ok(bytes, 'bytes must resolve through the control-repo fallback');
    assert.equal(bytes.encoding, 'base64');
    assert.match(Buffer.from(bytes.bytes, 'base64').toString('utf8'), /UC-1 body/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit artifact repository binding still wins over the fallback', () => {
  const { db, dir } = fixture();
  const otherRepo = path.join(dir, 'other-repo');
  mkdirSync(path.join(otherRepo, 'docs', 'requirements'), { recursive: true });
  writeFileSync(path.join(otherRepo, 'docs', 'requirements', '02-use-cases.md'), 'OTHER REPO\n');
  db.prepare("INSERT INTO repositories (id,name,default_branch) VALUES (2,'r2','main')").run();
  db.prepare(
    `INSERT INTO project_repositories (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (2,1,2,'component',?, 'dev','active')`,
  ).run(otherRepo);
  try {
    const bytes = readArtifactBytes(db, {
      path: 'docs/requirements/02-use-cases.md#UC-1',
      project_id: 1,
      project_repository_id: 2,
    });
    assert.match(
      Buffer.from(bytes.bytes, 'base64').toString('utf8'),
      /OTHER REPO/,
      'the artifact binding resolves before the control fallback',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing file still returns null (fail-closed bytes, no guessing)', () => {
  const { db, dir } = fixture();
  try {
    const bytes = readArtifactBytes(db, {
      path: 'docs/requirements/does-not-exist.md',
      project_id: 1,
      project_repository_id: null,
    });
    assert.equal(bytes, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
