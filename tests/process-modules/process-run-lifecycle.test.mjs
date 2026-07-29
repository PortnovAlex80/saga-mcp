// P0 tests for the generic ProcessRun envelope.
//
// Covers (v2 corrections applied):
//   - schema creation is idempotent (constructor safe to call repeatedly)
//   - start is idempotent on (project_id, module_name, module_version, idempotency_key)
//   - replay returns the SAME record, never creates a duplicate
//   - reusing an idempotency_key with a DIFFERENT input_hash throws
//     IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT
//   - a different idempotency_key (same input) creates a NEW run
//   - status transitions respect ALLOWED_TRANSITIONS
//   - illegal transitions throw with a clear message
//   - terminal rows are write-once on outcome/output/certificate
//   - read by id and by idempotency key (project-scoped)
//   - list by project / by project+epic
//   - MCP handler wrappers (start/get/set/cancel) work against the same SQLite wiring
//
// NOTE: pause/resume are NOT in P0 (they depend on executor capabilities, P1).
// The process_run_set primitive can still drive status='paused' on the
// repository directly — but there is no dedicated MCP tool for it yet.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { handlers, _resetProcessRunRepositoryForTests } = await import('../../dist/tools/process-modules.js');

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-prun-'));
  process.env.DB_PATH = path.join(temp, 'process-runs.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (2,'P2','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E1')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (11,1,'E2')`).run();
  return { temp, db };
}
function cleanup(temp) {
  closeDb();
  _resetProcessRunRepositoryForTests();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function hashPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function discoveryCommand({ idempotencyKey = 'k1', payload = { subject: 'geo' } } = {}) {
  return {
    moduleRef: { name: 'product-discovery', version: '3.0.0' },
    executorKind: 'legacy-adapter',
    input: { schema: 'saga3.discovery-case.v1', payload, contentHash: hashPayload(payload) },
    projectedStage: 'discovery',
    invocationContext: {
      projectId: 1, epicId: 10, initiatedBy: 'operator', idempotencyKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Schema + constructor
// ---------------------------------------------------------------------------

test('schema creation is idempotent — constructor safe to call twice', () => {
  const { temp, db } = fixture();
  try {
    const repo1 = new SqliteProcessRunRepository(db);
    const repo2 = new SqliteProcessRunRepository(db);
    assert.equal(repo1.list(1, null).length, 0);
    assert.equal(repo2.list(1, null).length, 0);
    const cols = db.prepare('PRAGMA table_info(saga3_process_runs)').all().map(c => c.name);
    assert.ok(cols.includes('module_ref_key'));
    assert.ok(cols.includes('input_hash'));
    assert.ok(cols.includes('idempotency_key'));
    assert.ok(cols.includes('status'));
    assert.ok(cols.includes('local_outcome'));
    assert.ok(cols.includes('certificate_hash'));
    // The idempotency unique index is scoped to (project, module, key).
    const idx = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_saga3_process_runs_idem'`,
    ).get();
    assert.match(idx.sql, /project_id/);
    assert.match(idx.sql, /module_name/);
    assert.match(idx.sql, /module_version/);
    assert.match(idx.sql, /idempotency_key/);
    assert.doesNotMatch(idx.sql, /input_hash/);
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// Idempotent start
// ---------------------------------------------------------------------------

test('start is idempotent on (project_id, module, idempotency_key) when input_hash matches', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const cmd = discoveryCommand();
    const first = repo.start(cmd);
    assert.equal(first.replayed, false);
    assert.equal(first.record.status, 'created');
    assert.equal(first.record.moduleRefKey, 'product-discovery@3.0.0');

    const second = repo.start(cmd);
    assert.equal(second.replayed, true);
    assert.equal(second.record.id, first.record.id);
    assert.deepEqual(second.record, first.record);
  } finally { cleanup(temp); }
});

test('reusing an idempotency_key with a DIFFERENT input_hash throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    repo.start(discoveryCommand({ idempotencyKey: 'shared-key', payload: { subject: 'geo' } }));
    assert.throws(
      () => repo.start(discoveryCommand({ idempotencyKey: 'shared-key', payload: { subject: 'ballistic' } })),
      /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT/,
    );
    // The original run is untouched.
    assert.equal(repo.list(1, null).length, 1);
  } finally { cleanup(temp); }
});

test('a different idempotency_key for the same input creates a NEW run', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const a = repo.start(discoveryCommand({ idempotencyKey: 'k1' }));
    const b = repo.start(discoveryCommand({ idempotencyKey: 'k2' }));
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.inputHash, b.record.inputHash);
    assert.equal(repo.list(1, null).length, 2);
  } finally { cleanup(temp); }
});

test('the same idempotency_key is reusable across DIFFERENT modules in the same project', () => {
  // The unique key is (project_id, module_name, module_version, idempotency_key).
  // The same idempotency_key can name runs of different modules in one project.
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const a = repo.start(discoveryCommand({ idempotencyKey: 'shared' }));
    const cmd2 = discoveryCommand({ idempotencyKey: 'shared' });
    cmd2.moduleRef = { name: 'solution-formalization', version: '1.0.0' };
    // registry.require is not invoked by the repository — the repo is
    // module-agnostic. We can insert a formalization-named row directly.
    const b = repo.start(cmd2);
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.idempotencyKey, b.record.idempotencyKey);
    assert.notEqual(a.record.moduleRefKey, b.record.moduleRefKey);
    assert.equal(repo.list(1, null).length, 2);
  } finally { cleanup(temp); }
});

test('the same idempotency_key is reusable across DIFFERENT projects', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const a = repo.start(discoveryCommand({ idempotencyKey: 'shared' }));
    const cmd2 = discoveryCommand({ idempotencyKey: 'shared' });
    cmd2.invocationContext.projectId = 2;
    cmd2.invocationContext.epicId = null;
    const b = repo.start(cmd2);
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.projectId, 1);
    assert.equal(b.record.projectId, 2);
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test('happy path lifecycle: created → preparing → running → settling → completed', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());

    let r = repo.update(record.id, { status: 'preparing' });
    assert.equal(r.status, 'preparing');

    r = repo.update(record.id, {
      status: 'running',
      executorRunRef: 'work-intent:42',
    });
    assert.equal(r.status, 'running');
    assert.equal(r.executorRunRef, 'work-intent:42');

    r = repo.update(record.id, { status: 'settling' });
    assert.equal(r.status, 'settling');

    r = repo.update(record.id, {
      status: 'completed',
      localOutcome: 'go',
      output: {
        schema: 'saga3.discovery-outcome-certificate.v1',
        artifactRef: 'certificate:23',
        contentHash: 'c'.repeat(64),
      },
      certificate: {
        schema: 'saga3.discovery-outcome-certificate.v1',
        certificateRef: 'certificate:23',
        certificateHash: 'c'.repeat(64),
      },
    });
    assert.equal(r.status, 'completed');
    assert.equal(r.localOutcome, 'go');
    assert.equal(r.outputRef, 'certificate:23');
    assert.equal(r.certificateHash, 'c'.repeat(64));
    assert.ok(r.completedAt, 'completed_at must be auto-set when going terminal');
  } finally { cleanup(temp); }
});

test('illegal transition created → completed throws', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());
    assert.throws(
      () => repo.update(record.id, { status: 'completed' }),
      /transition 'created' -> 'completed' is not allowed/,
    );
  } finally { cleanup(temp); }
});

test('illegal transition completed → running throws (no outgoing from terminal)', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());
    repo.update(record.id, { status: 'preparing' });
    repo.update(record.id, { status: 'running' });
    repo.update(record.id, { status: 'failed' });
    assert.throws(
      () => repo.update(record.id, { status: 'running' }),
      /transition 'failed' -> 'running' is not allowed/,
    );
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// Write-once terminal fields
// ---------------------------------------------------------------------------

test('terminal row: outcome cannot be changed after completion', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());
    repo.update(record.id, { status: 'preparing' });
    repo.update(record.id, { status: 'running' });
    repo.update(record.id, { status: 'completed', localOutcome: 'go' });
    assert.throws(
      () => repo.update(record.id, { localOutcome: 'clarify' }),
      /terminal .* local_outcome cannot change/,
    );
  } finally { cleanup(temp); }
});

test('terminal row: setting the SAME outcome is a no-op (idempotent terminal write)', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());
    repo.update(record.id, { status: 'preparing' });
    repo.update(record.id, { status: 'running' });
    repo.update(record.id, { status: 'completed', localOutcome: 'go' });
    const r = repo.update(record.id, { localOutcome: 'go' });
    assert.equal(r.localOutcome, 'go');
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

test('readByIdempotencyKey returns the row by its (project, module, key)', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    const { record } = repo.start(discoveryCommand());
    const found = repo.readByIdempotencyKey(
      record.projectId, record.moduleRefKey, record.idempotencyKey,
    );
    assert.equal(found?.id, record.id);
    const missing = repo.readByIdempotencyKey(
      record.projectId, record.moduleRefKey, 'no-such-key',
    );
    assert.equal(missing, null);
    // Wrong project returns null even with the right key.
    const wrongProject = repo.readByIdempotencyKey(
      2, record.moduleRefKey, record.idempotencyKey,
    );
    assert.equal(wrongProject, null);
  } finally { cleanup(temp); }
});

test('list by project returns all; list by epic narrows', () => {
  const { temp } = fixture();
  try {
    const repo = new SqliteProcessRunRepository();
    repo.start(discoveryCommand({
      idempotencyKey: 'e1', payload: { subject: 'a' },
    }));
    const cmd2 = discoveryCommand({
      idempotencyKey: 'e2', payload: { subject: 'b' },
    });
    cmd2.invocationContext.epicId = 11;
    repo.start(cmd2);

    assert.equal(repo.list(1, null).length, 2);
    assert.equal(repo.list(1, 10).length, 1);
    assert.equal(repo.list(1, 11).length, 1);
    assert.equal(repo.list(2, null).length, 0);
  } finally { cleanup(temp); }
});

// ---------------------------------------------------------------------------
// MCP handler wrappers
// ---------------------------------------------------------------------------

test('process_run_start handler persists a run and rejects unknown modules', () => {
  const { temp } = fixture();
  try {
    const out = handlers.process_run_start({
      module_name: 'product-discovery',
      module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { subject: 'geo' },
      input_hash: hashPayload({ subject: 'geo' }),
      project_id: 1,
      epic_id: 10,
      initiated_by: 'operator',
      idempotency_key: 'mcp-1',
    });
    assert.equal(out.status, 'created');
    assert.equal(out.replayed, false);
    assert.ok(out.process_run_id > 0);

    const out2 = handlers.process_run_start({
      module_name: 'product-discovery',
      module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { subject: 'geo' },
      input_hash: hashPayload({ subject: 'geo' }),
      project_id: 1,
      epic_id: 10,
      initiated_by: 'operator',
      idempotency_key: 'mcp-1',
    });
    assert.equal(out2.replayed, true);
    assert.equal(out2.process_run_id, out.process_run_id);

    assert.throws(
      () => handlers.process_run_start({
        module_name: 'no-such-module',
        module_version: '9.9.9',
        executor_kind: 'legacy-adapter',
        input_schema: 'x',
        input_payload: {},
        input_hash: '0'.repeat(64),
        project_id: 1,
        initiated_by: 'op',
        idempotency_key: 'x',
      }),
      /not registered/,
    );

    // Reusing the same idempotency_key with a different input throws.
    assert.throws(
      () => handlers.process_run_start({
        module_name: 'product-discovery',
        module_version: '3.0.2',
        executor_kind: 'legacy-adapter',
        input_schema: 'saga3.discovery-case.v1',
        input_payload: { subject: 'ballistic' },
        input_hash: hashPayload({ subject: 'ballistic' }),
        project_id: 1,
        epic_id: 10,
        initiated_by: 'operator',
        idempotency_key: 'mcp-1',
      }),
      /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT/,
    );
  } finally { cleanup(temp); }
});

test('process_run_set handler drives the lifecycle end-to-end', () => {
  const { temp } = fixture();
  try {
    const start = handlers.process_run_start({
      module_name: 'product-discovery',
        module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { s: 1 },
      input_hash: hashPayload({ s: 1 }),
      project_id: 1,
      epic_id: 10,
      initiated_by: 'op',
      idempotency_key: 'lifecycle-1',
    });
    const id = start.process_run_id;

    let r = handlers.process_run_set({ process_run_id: id, status: 'preparing' });
    assert.equal(r.record.status, 'preparing');

    r = handlers.process_run_set({ process_run_id: id, status: 'running' });
    assert.equal(r.record.status, 'running');

    r = handlers.process_run_set({ process_run_id: id, status: 'settling' });
    assert.equal(r.record.status, 'settling');

    r = handlers.process_run_set({
      process_run_id: id,
      status: 'completed',
      local_outcome: 'go',
      output: {
        schema: 'saga3.discovery-outcome-certificate.v1',
        artifact_ref: 'certificate:99',
        content_hash: 'd'.repeat(64),
      },
    });
    assert.equal(r.record.status, 'completed');
    assert.equal(r.record.localOutcome, 'go');
    assert.equal(r.record.outputRef, 'certificate:99');
  } finally { cleanup(temp); }
});

test('process_run_cancel on a running run records reason and is idempotent on terminal', () => {
  const { temp } = fixture();
  try {
    const start = handlers.process_run_start({
      module_name: 'product-discovery',
      module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { s: 2 },
      input_hash: hashPayload({ s: 2 }),
      project_id: 1,
      initiated_by: 'op',
      idempotency_key: 'cancel-1',
    });
    const id = start.process_run_id;
    handlers.process_run_set({ process_run_id: id, status: 'preparing' });
    handlers.process_run_set({ process_run_id: id, status: 'running' });

    const cancelled = handlers.process_run_cancel({
      process_run_id: id, reason: 'operator aborted',
    });
    assert.equal(cancelled.record.status, 'cancelled');
    assert.equal(cancelled.record.error, 'operator aborted');

    const again = handlers.process_run_cancel({ process_run_id: id });
    assert.equal(again.already_terminal, true);
    assert.equal(again.record.status, 'cancelled');
  } finally { cleanup(temp); }
});

test('process_run_get reads by id and by (project, module, idempotency_key)', () => {
  const { temp } = fixture();
  try {
    const start = handlers.process_run_start({
      module_name: 'product-discovery',
      module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { s: 3 },
      input_hash: hashPayload({ s: 3 }),
      project_id: 1,
      initiated_by: 'op',
      idempotency_key: 'getrun-1',
    });
    const id = start.process_run_id;

    const byId = handlers.process_run_get({ process_run_id: id });
    assert.equal(byId.record.id, id);

    const byKey = handlers.process_run_get({
      project_id: 1,
      module_name: 'product-discovery',
      module_version: '3.0.2',
      idempotency_key: 'getrun-1',
    });
    assert.equal(byKey.record.id, id);

    assert.throws(
      () => handlers.process_run_get({ process_run_id: 999999 }),
      /not found/,
    );
  } finally { cleanup(temp); }
});

test('process_run_list returns all runs for a project, optionally narrowed by epic', () => {
  const { temp } = fixture();
  try {
    handlers.process_run_start({
      module_name: 'product-discovery', module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { s: 'a' }, input_hash: hashPayload({ s: 'a' }),
      project_id: 1, epic_id: 10,
      initiated_by: 'op', idempotency_key: 'list-1',
    });
    handlers.process_run_start({
      module_name: 'product-discovery', module_version: '3.0.2',
      executor_kind: 'legacy-adapter',
      input_schema: 'saga3.discovery-case.v1',
      input_payload: { s: 'b' }, input_hash: hashPayload({ s: 'b' }),
      project_id: 1, epic_id: 11,
      initiated_by: 'op', idempotency_key: 'list-2',
    });

    const all = handlers.process_run_list({ project_id: 1 });
    assert.equal(all.count, 2);

    const onEpic = handlers.process_run_list({ project_id: 1, epic_id: 10 });
    assert.equal(onEpic.count, 1);
    assert.equal(onEpic.runs[0].idempotencyKey, 'list-1');
  } finally { cleanup(temp); }
});
