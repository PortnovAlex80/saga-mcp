// tests/process-modules/formalization-package-ports.test.mjs
//
// W8-A6 — Formalization package ports + handler adapters conformance.
// Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W08-a6.md
//
// Verifies:
//   1. The package ports file is dependency-clean (no db.ts, no better-sqlite3,
//      no persistence adapter imports) — the whole point of the port.
//      logic: readPrdRoot, already-rooted short-circuit, provision-create,
//      provision-link-existing, idempotency.
//   3. The managed-production adapter bridges to the shared ledger correctly.
//   4. The handler adapter drives brief provisioning through the injected port
//      (no getDb()) and stamps the outcome on the result.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// 1. Dependency-cleanliness: the ports file must not import the substrate.
// ---------------------------------------------------------------------------

const PORTS_FILE = path.join(
  REPO_ROOT,
  'src/process-modules/modules/formalization/package/ports/formalization-package-ports.ts',
);

function relativeImports(source) {
  const out = [];
  const re = /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

test('W8-A6: FormalizationPackagePorts file imports no substrate (db.ts, better-sqlite3, persistence)', () => {
  const src = readFileSync(PORTS_FILE, 'utf8');
  const imports = relativeImports(src);
  // The ports file may import only its own module's kernel-ports (already
  // dependency-clean) — never db.ts, never a sqlite-* adapter, never
  // better-sqlite3, never infrastructure/.
  for (const spec of imports) {
    assert.ok(
      !spec.includes('db.js'),
      `ports file must not import db.js (found ${spec})`,
    );
    assert.ok(
      !/sqlite-/.test(spec),
      `ports file must not import a sqlite-* adapter (found ${spec})`,
    );
    assert.ok(
      !/persistence\//.test(spec),
      `ports file must not import persistence/ (found ${spec})`,
    );
  }
  // And no bare better-sqlite3 import either.
  assert.ok(
    !/from\s+['"]better-sqlite3['"]/.test(src),
    'ports file must not import better-sqlite3',
  );
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  SqliteFormalizationBriefProvisioning,
  SqliteFormalizationManagedProduction,
  buildSqliteFormalizationPackagePorts,
} = await import(
  '../../dist/modules/formalization/infrastructure/sqlite-formalization-package-adapters.js'
);

function briefFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-formalization-ports-'));
  process.env.DB_PATH = path.join(temp, 'ports.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'Formalization')`).run();
  // A PRD with an accepted hash.
  const prdHash = 'a'.repeat(64);
  const info = db.prepare(
    `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status,
                            content_hash, accepted_hash, drift_state, tags, metadata)
     VALUES (1, 10, 'PRD', 'PRD-1', 'PRD', 'docs/p.md', 'accepted', ?, ?, 'clean', '[]', '{}')`,
  ).run(prdHash, prdHash);
  return { temp, db, prdId: Number(info.lastInsertRowid) };
}

function briefCleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('W8-A6: SqliteFormalizationBriefProvisioning readPrdRoot returns empty when PRD has no root', () => {
  const { temp, provisioning, prdId } = (() => {
    const f = briefFixture();
    return {
      temp: f.temp,
      prdId: f.prdId,
      provisioning: new SqliteFormalizationBriefProvisioning(f.db),
    };
  })();
  try {
    const read = provisioning.readPrdRoot(prdId);
    assert.deepEqual(read.derivedFromTargetIds, []);
    assert.deepEqual(read.acceptedRootArtifactIds, []);
  } finally {
    briefCleanup(temp);
  }
});

test('W8-A6: SqliteFormalizationBriefProvisioning readPrdRoot detects an accepted non-product root', () => {
  const { temp, db, prdId } = briefFixture();
  try {
    // Insert an accepted brief + a derived_from PRD -> brief trace.
    const briefHash = 'b'.repeat(64);
    const briefInfo = db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status,
                              content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (1, 10, 'brief', 'BRIEF-1', 'Brief', 'docs/b.md', 'accepted', ?, ?, 'clean', '[]', '{}')`,
    ).run(briefHash, briefHash);
    const briefId = Number(briefInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO artifact_traces (source_id, target_type, target_id, link_type)
       VALUES (?, 'artifact', ?, 'derived_from')`,
    ).run(prdId, briefId);

    const provisioning = new SqliteFormalizationBriefProvisioning(db);
    const read = provisioning.readPrdRoot(prdId);
    assert.deepEqual(read.derivedFromTargetIds, [briefId]);
    assert.deepEqual(read.acceptedRootArtifactIds, [briefId]);
  } finally {
    briefCleanup(temp);
  }
});

test('W8-A6: provisionBriefRoot creates a synthetic brief + trace when none exists', () => {
  const { temp, db, prdId } = briefFixture();
  try {
    const provisioning = new SqliteFormalizationBriefProvisioning(db);
    const outcome = provisioning.provisionBriefRoot({
      projectId: 1,
      epicId: 10,
      processRunId: 42,
      prdArtifactId: prdId,
    });
    assert.equal(outcome.status, 'root-attached');
    assert.equal(outcome.newlyCreated, true);
    const briefId = outcome.briefArtifactId;

    // A brief artifact row was created.
    const brief = db.prepare(`SELECT type, status, accepted_hash FROM artifacts WHERE id=?`)
      .get(briefId);
    assert.equal(brief.type, 'brief');
    assert.equal(brief.status, 'accepted');
    assert.equal(typeof brief.accepted_hash, 'string');
    assert.equal(brief.accepted_hash.length, 64);

    // The derived_from trace was attached.
    const trace = db.prepare(
      `SELECT link_type, target_type, target_id FROM artifact_traces
        WHERE source_id=? AND link_type='derived_from'`,
    ).get(prdId);
    assert.equal(trace.link_type, 'derived_from');
    assert.equal(trace.target_type, 'artifact');
    assert.equal(trace.target_id, briefId);
  } finally {
    briefCleanup(temp);
  }
});

test('W8-A6: provisionBriefRoot is idempotent (already-rooted on second call)', () => {
  const { temp, db, prdId } = briefFixture();
  try {
    const provisioning = new SqliteFormalizationBriefProvisioning(db);
    const first = provisioning.provisionBriefRoot({
      projectId: 1, epicId: 10, processRunId: 42, prdArtifactId: prdId,
    });
    assert.equal(first.status, 'root-attached');
    const second = provisioning.provisionBriefRoot({
      projectId: 1, epicId: 10, processRunId: 42, prdArtifactId: prdId,
    });
    // Second call sees the now-accepted brief root and short-circuits.
    assert.equal(second.status, 'already-rooted');
    assert.equal(second.rootArtifactId, first.briefArtifactId);

    // Still exactly one brief in the epic and one trace from the PRD.
    const briefCount = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE epic_id=10 AND type='brief'`).get().n;
    assert.equal(briefCount, 1);
    const traceCount = db.prepare(
      `SELECT COUNT(*) AS n FROM artifact_traces WHERE source_id=? AND link_type='derived_from'`,
    ).get(prdId).n;
    assert.equal(traceCount, 1);
  } finally {
    briefCleanup(temp);
  }
});

test('W8-A6: provisionBriefRoot reuses a pre-existing accepted brief in the epic', () => {
  const { temp, db, prdId } = briefFixture();
  try {
    // Pre-create an accepted brief with NO trace to the PRD yet.
    const briefHash = 'c'.repeat(64);
    const briefInfo = db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status,
                              content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (1, 10, 'brief', 'BRIEF-1', 'Brief', 'docs/b.md', 'accepted', ?, ?, 'clean', '[]', '{}')`,
    ).run(briefHash, briefHash);
    const existingBriefId = Number(briefInfo.lastInsertRowid);

    const provisioning = new SqliteFormalizationBriefProvisioning(db);
    const outcome = provisioning.provisionBriefRoot({
      projectId: 1, epicId: 10, processRunId: 42, prdArtifactId: prdId,
    });
    assert.equal(outcome.status, 'root-attached');
    assert.equal(outcome.newlyCreated, false);
    assert.equal(outcome.briefArtifactId, existingBriefId);

    // No new brief created.
    const briefCount = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE epic_id=10 AND type='brief'`).get().n;
    assert.equal(briefCount, 1);
  } finally {
    briefCleanup(temp);
  }
});

// ---------------------------------------------------------------------------
// 3. Managed-production adapter bridges to the shared ledger.
// ---------------------------------------------------------------------------

test('W8-A6: SqliteFormalizationManagedProduction delegates to the shared ledger', () => {
  // WAVE 6 CUTOVER: the adapter's execution-scoped methods
  // (listArtifactsForExecution / listTracesForExecution) were removed alongside
  // the shared ledger's. The adapter now exposes ONLY the durable node-scope
  // reads (canonical product-resolution channel, CGAD P18) and the task-scope
  // reads (single-task diagnostics). This test proves the adapter is a pure
  // pass-through that forwards each surviving method to the shared ledger and
  // normalizes records to the module-local write shape. No DB needed.
  const calls = [];
  const stubLedger = {
    listArtifactsForTaskInProcessRun(pr, mod, node, task) {
      calls.push(['artifacts-task', pr, mod, node, task]);
      return [];
    },
    listTracesForTaskInProcessRun(pr, mod, node, task) {
      calls.push(['traces-task', pr, mod, node, task]);
      return [];
    },
    listArtifactsForNodeInProcessRun(pr, mod, node) {
      calls.push(['artifacts-run', pr, mod, node]);
      return [{
        ledgerId: 1, processRunId: pr, moduleRef: mod,
        nodeId: node, intentId: 11, taskId: 22,
        executionId: 'exec-1', artifactId: 100, artifactType: 'PRD',
        artifactStatus: 'accepted', contentHash: 'a'.repeat(64),
        operation: 'create', recordedAt: 't',
      }];
    },
    listTracesForNodeInProcessRun(pr, mod, node) {
      calls.push(['traces-run', pr, mod, node]);
      return [{
        ledgerId: 2, processRunId: pr, moduleRef: mod,
        nodeId: node, intentId: 11, taskId: 22,
        executionId: 'exec-1', traceId: 200, sourceId: 100,
        targetType: 'artifact', targetId: 50, linkType: 'derived_from',
        traceHash: 'b'.repeat(64), recordedAt: 't',
      }];
    },
  };
  const adapter = new SqliteFormalizationManagedProduction(stubLedger);
  // The durable node-scope channel is the AUTHORITATIVE product-resolution
  // path. Drive it with a concrete (processRunId, moduleRef, nodeId).
  const processRunId = 7;
  const moduleRef = 'solution-formalization@1.0.0';
  const nodeId = 'define-product-contract';
  const arts = adapter.listArtifactsForNodeInProcessRun(processRunId, moduleRef, nodeId);
  const traces = adapter.listTracesForNodeInProcessRun(processRunId, moduleRef, nodeId);
  adapter.listArtifactsForTaskInProcessRun(7, 'm', 'n', 22);
  adapter.listTracesForTaskInProcessRun(7, 'm', 'n', 22);

  // The node-scope calls forwarded the arguments verbatim.
  assert.equal(calls[0][0], 'artifacts-run');
  assert.equal(calls[0][1], 7);
  assert.equal(calls[0][2], moduleRef);
  assert.equal(calls[0][3], nodeId);
  assert.equal(calls[1][0], 'traces-run');

  // Records were normalized to the module-local write shape.
  assert.equal(arts.length, 1);
  assert.equal(arts[0].artifactId, 100);
  assert.equal(arts[0].contentHash, 'a'.repeat(64));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].traceId, 200);
  assert.equal(traces[0].linkType, 'derived_from');

  // The task-scoped diagnostics forwarded too.
  assert.equal(calls[2][0], 'artifacts-task');
  assert.equal(calls[3][0], 'traces-task');
});

test('W8-A6: buildSqliteFormalizationPackagePorts wires all three ports', () => {
  const { temp, db, prdId } = briefFixture();
  try {
    const stubLedger = {
      listArtifactsForTaskInProcessRun: () => [],
      listTracesForTaskInProcessRun: () => [],
      listArtifactsForNodeInProcessRun: () => [],
      listTracesForNodeInProcessRun: () => [],
    };
    const stubGraph = {
      readOutgoingArtifactTraces: () => [],
      readArtifactsByIds: () => [],
    };
    const ports = buildSqliteFormalizationPackagePorts(stubGraph, db, stubLedger);
    assert.ok(ports.graph === stubGraph, 'graph forwarded');
    assert.ok(ports.managedProduction instanceof SqliteFormalizationManagedProduction);
    assert.ok(ports.briefProvisioning instanceof SqliteFormalizationBriefProvisioning);

    // The brief provisioning port is functional against the real DB.
    const read = ports.briefProvisioning.readPrdRoot(prdId);
    assert.deepEqual(read.derivedFromTargetIds, []);
  } finally {
    briefCleanup(temp);
  }
});
