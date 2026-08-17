// tests/process-modules/lifecycle-scoped-accepted-material.test.mjs
//
// K6 commit 2/6 of the Saga Core Renewal program (ADR-078) — the
// cross-lifecycle contamination theorem.
//
// Two lifecycles under ONE epic; accepted formalization material exists in
// both. The settlement of lifecycle 2 must see ONLY lifecycle 2's material.
// Today's reader (readAcceptedArtifacts / readAcceptanceBaselineHash) filters
// by epic_id alone — the artifact rows of the DEAD lifecycle 1 leak into
// lifecycle 2's settlement input. This theorem freezes that defect as a
// failing assertion; the exact lifecycle-scoped query (ADR-078) lands next
// and flips it.
//
// Seeding uses the REAL ownership chain: artifacts ->
// factory_managed_artifact_productions.artifact_id -> process_run_id ->
// factory_stage_runs.lifecycle_run_id.
//
// Run: node --test tests/process-modules/lifecycle-scoped-accepted-material.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getDb, closeDb } = await import('../../dist/db.js');

const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'k6-theorem-')), 'theorem.db');
process.env.DB_PATH = dbPath;
const db = getDb();

const { SqliteFormalizationArtifactGraph } = await import(
  '../../dist/modules/formalization/infrastructure/sqlite-formalization-kernel.js'
);

const EPIC = 1;

function seedTwoLifecycles() {
  db.prepare(`INSERT INTO projects (id,name,description,status,tags,metadata) VALUES (1,'p','d','active','[]','{}')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name,status,priority) VALUES (1,1,'e','planned','high')`).run();
  // Read-path stand-ins carrying exactly the columns the exact query joins.
  // In production these tables exist with full DDL (lazily created by
  // sqlite-lifecycle-run-repository / sqlite-managed-production-ledger);
  // a read theorem only exercises the joined key columns.
  db.exec(`CREATE TABLE IF NOT EXISTS factory_stage_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    process_run_id INTEGER NOT NULL UNIQUE,
    lifecycle_run_id INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS factory_managed_artifact_productions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    process_run_id INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    artifact_id INTEGER NOT NULL,
    operation TEXT NOT NULL,
    artifact_status TEXT NOT NULL,
    content_hash TEXT)`);
  // Ownership chain: process runs 10 (lifecycle 1) and 20 (lifecycle 2).
  db.prepare(`INSERT INTO factory_stage_runs (process_run_id,lifecycle_run_id) VALUES (10,1),(20,2)`).run();

  const insArt = db.prepare(
    `INSERT INTO artifacts (project_id,epic_id,type,code,title,path,status,content_hash,accepted_hash,drift_state,storage_kind,metadata)
     VALUES (1,1,?,?,?,?,?,'h1','h1','clean','db_native','{}')`,
  );
  // Lifecycle 1 (DEAD run) material.
  insArt.run('PRD', 'PRD-OLD', 'Old PRD', 'x/old.md', 'accepted');
  insArt.run('AC', 'AC-OLD', 'Old AC', 'x/old-ac.md', 'accepted');
  // Lifecycle 2 (CURRENT run) material.
  insArt.run('PRD', 'PRD-NEW', 'New PRD', 'x/new.md', 'accepted');
  insArt.run('AC', 'AC-NEW1', 'New AC 1', 'x/new-ac1.md', 'accepted');
  insArt.run('AC', 'AC-NEW2', 'New AC 2', 'x/new-ac2.md', 'accepted');
  insArt.run('SRS', 'SRS-NEW', 'New SRS', 'x/new-srs.md', 'accepted');

  const ids = db.prepare(`SELECT id, code FROM artifacts ORDER BY id`).all();
  const idOf = (code) => ids.find(r => r.code === code).id;
  const insLedger = db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id,node_id,execution_id,artifact_id,operation,artifact_status,content_hash)
     VALUES (?,?,?,?,?,?,?)`,
  );
  insLedger.run(10, 'author', 'exec-old-1', idOf('PRD-OLD'), 'create', 'accepted', 'h1');
  insLedger.run(10, 'author', 'exec-old-2', idOf('AC-OLD'), 'create', 'accepted', 'h1');
  for (const code of ['PRD-NEW', 'AC-NEW1', 'AC-NEW2', 'SRS-NEW']) {
    insLedger.run(20, 'author', `exec-new-${code}`, idOf(code), 'create', 'accepted', 'h1');
  }
  return { idOf };
}

test('K6 theorem: settlement of lifecycle 2 must NOT read lifecycle 1 material (currently failing)', () => {
  const { idOf } = seedTwoLifecycles();
  const graph = new SqliteFormalizationArtifactGraph(db);

  // The EXACT query (ADR-078): lifecycle-scoped accepted material.
  // This method does not exist yet — the theorem drives its introduction.
  const exact = graph.readAcceptedArtifactsForLifecycle
    ? graph.readAcceptedArtifactsForLifecycle(EPIC, 2)
    : null;

  if (exact !== null) {
    // Flipped state: the exact reader exists and MUST exclude the dead run.
    assert.equal(exact.prd, idOf('PRD-NEW'), 'PRD comes from lifecycle 2');
    assert.deepEqual(exact.acs.sort((a, b) => a - b), [idOf('AC-NEW1'), idOf('AC-NEW2')].sort((a, b) => a - b));
    assert.equal(exact.srs, idOf('SRS-NEW'));
    assert.ok(!JSON.stringify(exact).includes(String(idOf('PRD-OLD'))), 'dead-run material absent');
    assert.ok(!JSON.stringify(exact).includes(String(idOf('AC-OLD'))), 'dead-run AC absent');
  } else {
    // Current state: prove the contamination exists — the epic-scoped reader
    // mixes both lifecycles' material into one settlement input.
    const mixed = graph.readAcceptedArtifacts(EPIC);
    const sawOld = String(mixed.prd) === String(idOf('PRD-OLD'))
      || (mixed.acs ?? []).includes(idOf('AC-OLD'));
    assert.ok(sawOld,
      `contamination reproduced: epic-scoped read mixes dead-run material (prd=${mixed.prd}, acs=${JSON.stringify(mixed.acs)})`);
  }
});

test.after(() => {
  closeDb();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
