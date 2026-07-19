// Unit tests for the docs-graph snapshot builder.
// Run: node --test tests/docs-graph-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildGraphSnapshot } from '../tracker-view/docs-graph/lib/graph-snapshot.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

// Spin up an in-memory saga DB with the minimal schema the snapshot builder
// reads. Avoids the full SCHEMA_SQL — we only need projects/epics/artifacts/
// artifact_traces/tasks/project_repositories/repositories.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, description TEXT, status TEXT, tags TEXT, metadata TEXT);
    CREATE TABLE repositories (id INTEGER PRIMARY KEY, name TEXT, remote_url TEXT, default_branch TEXT, metadata TEXT);
    CREATE TABLE project_repositories (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      repository_id INTEGER NOT NULL,
      role TEXT, local_path TEXT, integration_branch TEXT DEFAULT 'dev',
      docs_root TEXT, status TEXT DEFAULT 'active', metadata TEXT
    );
    CREATE TABLE epics (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, status TEXT, branch TEXT);
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY,
      project_id INTEGER, epic_id INTEGER,
      type TEXT, code TEXT, title TEXT, path TEXT, status TEXT,
      parent_artifact_id INTEGER,
      content_hash TEXT, accepted_hash TEXT, drift_state TEXT,
      tags TEXT, updated_at TEXT
    );
    CREATE TABLE artifact_traces (
      id INTEGER PRIMARY KEY,
      source_id INTEGER, target_type TEXT, target_id INTEGER, link_type TEXT
    );
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, epic_id INTEGER, title TEXT, status TEXT);
  `);
  return db;
}

function seedProject(db, overrides = {}) {
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (?, ?, 'active')`).run(
    overrides.projectId ?? 1,
    overrides.projectName ?? 'Demo',
  );
  db.prepare(`INSERT INTO epics (id, project_id, name, status) VALUES (?, ?, ?, 'planned')`).run(
    overrides.epicId ?? 10,
    overrides.projectId ?? 1,
    overrides.epicName ?? 'REQ-001',
  );
}

function insertArtifact(db, { id, projectId = 1, epicId = 10, type, code, title, path, status = 'draft', parent = null, tags = null }) {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, epic_id, type, code, title, path, status, parent_artifact_id, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, epicId, type, code ?? null, title, path, status, parent, tags ? JSON.stringify(tags) : null);
}

function insertTrace(db, sourceId, targetType, targetId, linkType) {
  db.prepare(
    `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (?, ?, ?, ?)`,
  ).run(sourceId, targetType, targetId, linkType);
}

test('buildGraphSnapshot: missing project returns available:false', () => {
  const db = makeDb();
  try {
    const r = buildGraphSnapshot(db, 999);
    assert.equal(r.available, false);
    assert.equal(r.reason, 'project-not-found');
  } finally {
    db.close();
  }
});

test('buildGraphSnapshot: artifacts only (no repo binding) → parent edges + traces', () => {
  const db = makeDb();
  try {
    seedProject(db);
    insertArtifact(db, { id: 1, type: 'PRD', code: 'PRD-1', title: 'PRD one', path: 'docs/prd.md', status: 'accepted' });
    insertArtifact(db, { id: 2, type: 'UC', code: 'UC-1', title: 'UC one', path: 'docs/uc.md', parent: 1 });
    insertArtifact(db, { id: 3, type: 'AC', code: 'AC-1', title: 'AC one', path: 'docs/ac.md', parent: 2 });
    insertTrace(db, 3, 'artifact', 2, 'derived_from');

    const r = buildGraphSnapshot(db, 1);
    assert.equal(r.available, true);
    assert.equal(r.repository, null);
    assert.equal(r.nodes.length, 3);
    assert.equal(r.stats.artifactCount, 3);
    assert.equal(r.stats.docCount, 0);

    // parent spine: PRD→UC, UC→AC. derived_from: AC→UC.
    assert.equal(r.edges.length, 3);
    const linkTypes = r.edges.map((e) => e.linkType).sort();
    assert.deepEqual(linkTypes, ['derived_from', 'parent', 'parent']);
  } finally {
    db.close();
  }
});

test('buildGraphSnapshot: traces to tasks promote task nodes into graph', () => {
  const db = makeDb();
  try {
    seedProject(db);
    insertArtifact(db, { id: 5, type: 'AC', code: 'AC-9', title: 'AC nine', path: 'docs/ac9.md', status: 'accepted' });
    db.prepare(`INSERT INTO tasks (id, epic_id, title, status) VALUES (?, ?, ?, ?)`).run(42, 10, 'Implement AC-9', 'todo');
    insertTrace(db, 5, 'task', 42, 'implements');

    const r = buildGraphSnapshot(db, 1);
    const taskNode = r.nodes.find((n) => n.kind === 'task');
    assert.ok(taskNode, 'expected a task node');
    assert.equal(taskNode.taskId, 42);
    const impl = r.edges.find((e) => e.linkType === 'implements');
    assert.ok(impl, 'expected an implements edge');
  } finally {
    db.close();
  }
});

test('buildGraphSnapshot: repo binding — .md not bound to artifact becomes a doc node', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-graph-snap-'));
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'prd.md'), '---\nstatus: accepted\n---\n# PRD one\n');
    writeFileSync(path.join(root, 'docs', 'readme.md'), '# Orphan readme\n');
    writeFileSync(path.join(root, 'notes.md'), '# Loose notes\n');

    const db = makeDb();
    seedProject(db);
    // Bind repo.
    db.prepare(`INSERT INTO repositories (id, name, default_branch) VALUES (?, ?, ?)`).run(7, 'demo', 'main');
    db.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_id, local_path, integration_branch, docs_root, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    ).run(11, 1, 7, root, 'dev', null);

    // One artifact points to docs/prd.md.
    insertArtifact(db, { id: 1, type: 'PRD', code: 'PRD-1', title: 'PRD one', path: 'docs/prd.md', status: 'accepted' });

    const r = buildGraphSnapshot(db, 1);
    assert.equal(r.available, true);
    assert.ok(r.repository, 'expected repo binding');
    assert.equal(r.repository.scanRoot, path.resolve(root));

    const docNodes = r.nodes.filter((n) => n.kind === 'doc');
    const docPaths = docNodes.map((n) => n.path).sort();
    assert.deepEqual(docPaths, ['docs/readme.md', 'notes.md']);
    assert.equal(r.stats.artifactCount, 1);
    assert.equal(r.stats.docCount, 2);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildGraphSnapshot: docs_root narrows the scanner', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-graph-root-'));
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    mkdirSync(path.join(root, 'blog'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n');
    writeFileSync(path.join(root, 'docs', 'b.md'), '# B\n');
    writeFileSync(path.join(root, 'blog', 'post.md'), '# Post\n');
    writeFileSync(path.join(root, 'top.md'), '# Top\n');

    const db = makeDb();
    seedProject(db);
    db.prepare(`INSERT INTO repositories (id, name, default_branch) VALUES (?, ?, ?)`).run(7, 'demo', 'main');
    db.prepare(
      `INSERT INTO project_repositories (id, project_id, repository_id, local_path, integration_branch, docs_root, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    ).run(11, 1, 7, root, 'dev', 'docs');

    const r = buildGraphSnapshot(db, 1);
    const docPaths = r.nodes.filter((n) => n.kind === 'doc').map((n) => n.path).sort();
    // Only files under docs/ — blog/ and top.md are outside docs_root.
    assert.deepEqual(docPaths, ['a.md', 'b.md']);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
