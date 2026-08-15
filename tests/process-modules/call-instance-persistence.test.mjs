// tests/process-modules/call-instance-persistence.test.mjs
//
// W5-A2 — CallInstance persistence (SQL OWNER for factory_call_instances this wave).
//
// Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md §2.
// Task: docs/refactor-management/05-subagent-tasks/W05-a2.md.
//
// Coverage (per task "Verify" + spec §2 exit gate 4 + C028/C029/C030):
//   - Schema: factory_call_instances exists after the repo ctor, with every
//     column from spec §2 + the status CHECK enum + the step-ledger index.
//   - Schema: idempotent — constructing twice does not throw.
//   - createCallInstance (C028): materializes a row at status 'materialized'
//     BEFORE any submission, attempt 1 by default, with optional protocol/step/
//     workspace/draft fields.
//   - updateDraft: materialized/edited/failed → edited, attaches draft hash.
//   - validateCall: edited → validated; requires a draft (draft_content_hash).
//   - submitCall: validated → submitted.
//   - sealCall (C030): succeeded → sealed; requires a non-empty trimmed receipt;
//     stamps successful_receipt_ref + sealed_at.
//   - failCall: edited/validated/submitted/succeeded → failed; records error;
//     PRESERVES draft_content_hash (C029).
//   - retryCall (C029): failed → edited, on the SAME row, draft preserved.
//   - Full happy-path lifecycle: materialized → edited → validated → submitted
//     → succeeded (via raw set since the runtime owns the submitted→succeeded
//     receipt binding; the repo only seals) → sealed.
//   - State machine: illegal transitions throw CALL_INSTANCE_INVALID_TRANSITION
//     (e.g. sealCall on a non-succeeded row, submitCall on edited, retryCall on
//     edited). Missing row throws CALL_INSTANCE_MISSING.
//   - readCallInstance: returns the row or null. Crash-resume entry.
//   - listForStep: chronological (attempt, id) order for a step triple.
//   - Persistence: rows survive DB reopen (dual-placement idempotency).
//
// ISOLATION NOTE: W5-A2 is the single SQL owner. This test constructs
// SqliteCallInstanceRepository directly, which runs ensureFactoryCallInstanceSchema
// (fresh-DB path). The dual-placement in src/db.ts is exercised by the
// "persists across DB reopen" test via getDb()/closeDb(). FK enforcement is
// disabled for the temp DB (no factory_process_runs parent row is created).
//
// Note on submitted→succeeded: spec §2 lists 'succeeded' as the pre-seal state
// and sealCall as the terminal success. The runtime records the receipt when it
// flips a call to 'succeeded' (the repo does not expose a separate
// succeedCall() mutator — that binding is the runtime's job, owned by W5-A6).
// To exercise sealCall we set status='succeeded' via raw SQL, the same way the
// protocol-run test force-transitions a protocol to terminal.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteCallInstanceRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-call-instance-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function freshDb(prefix = 'saga-w5a2-') {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DB_PATH = path.join(temp, 'call-instance.db');
  const db = getDb();
  // factory_call_instances REFERENCES factory_process_runs; we test the call layer
  // in isolation (no parent row), so disable FK enforcement.
  db.pragma('foreign_keys = OFF');
  return { db, temp, previous };
}

function cleanup(temp, previous) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previous;
  }
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function indexNames(db, table) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
    .all(table)
    .map((r) => r.name);
}

// Force a call row to a status the runtime would set (e.g. 'succeeded'), so we
// can exercise sealCall without a separate succeedCall mutator.
function forceStatus(db, callInstanceId, status) {
  db.prepare('UPDATE factory_call_instances SET status=? WHERE id=?').run(
    status,
    callInstanceId,
  );
}

// ---------------------------------------------------------------------------
// Schema tests.
// ---------------------------------------------------------------------------

test('schema: creates factory_call_instances after ctor', () => {
  const ctx = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteCallInstanceRepository(ctx.db);

    const cols = new Set(tableColumns(ctx.db, 'factory_call_instances'));
    for (const c of [
      'id', 'process_run_id', 'protocol_run_id', 'step_id',
      'tool_contract_ref', 'attempt', 'workspace_path', 'draft_content_hash',
      'status', 'last_error_json', 'successful_receipt_ref',
      'created_at', 'updated_at', 'sealed_at',
    ]) {
      assert.ok(cols.has(c), `column ${c} must exist`);
    }

    const idx = indexNames(ctx.db, 'factory_call_instances');
    assert.ok(
      idx.includes('idx_factory_call_instances_step'),
      'step-ledger index must exist',
    );

    // The status CHECK enum rejects an unknown value.
    assert.throws(
      () => ctx.db.prepare(
        "INSERT INTO factory_call_instances (process_run_id, tool_contract_ref, status) VALUES (1, 't', 'bogus')",
      ).run(),
      /CHECK/i,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('schema: ensureFactoryCallInstanceSchema is idempotent (ctor twice does not throw)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new
      new SqliteCallInstanceRepository(ctx.db);
    });
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    assert.equal(call.status, 'materialized');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// createCallInstance (C028).
// ---------------------------------------------------------------------------

test('createCallInstance (C028): materializes a row BEFORE submission', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 7,
      protocolRunId: 42,
      stepId: 's1',
      toolContractRef: 'tool.write',
      workspacePath: '/ws/proj',
      draftContentHash: 'sha:abc',
    });
    assert.equal(call.processRunId, 7);
    assert.equal(call.protocolRunId, 42);
    assert.equal(call.stepId, 's1');
    assert.equal(call.toolContractRef, 'tool.write');
    assert.equal(call.attempt, 1);
    assert.equal(call.workspacePath, '/ws/proj');
    assert.equal(call.draftContentHash, 'sha:abc');
    assert.equal(call.status, 'materialized');
    assert.equal(call.lastErrorJson, null);
    assert.equal(call.successfulReceiptRef, null);
    assert.equal(call.sealedAt, null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('createCallInstance: defaults — attempt 1, nullables null, no draft', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    assert.equal(call.attempt, 1);
    assert.equal(call.protocolRunId, null);
    assert.equal(call.stepId, null);
    assert.equal(call.workspacePath, null);
    assert.equal(call.draftContentHash, null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('createCallInstance: rejects invalid inputs', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    assert.throws(
      () => repo.createCallInstance({ processRunId: 0, toolContractRef: 't' }),
      /CALL_PROCESSRUNID_INVALID/,
    );
    assert.throws(
      () => repo.createCallInstance({ processRunId: 1, toolContractRef: '' }),
      /CALL_TOOLCONTRACTREF_INVALID/,
    );
    assert.throws(
      () => repo.createCallInstance({ processRunId: 1, toolContractRef: ' t ' }),
      /CALL_TOOLCONTRACTREF_INVALID/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// updateDraft + validateCall + submitCall.
// ---------------------------------------------------------------------------

test('updateDraft: materialized → edited, attaches draft hash', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    const edited = repo.updateDraft({
      callInstanceId: call.id,
      draftContentHash: 'sha:draft1',
    });
    assert.equal(edited.status, 'edited');
    assert.equal(edited.draftContentHash, 'sha:draft1');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('updateDraft: re-editing an edited row keeps it edited (idempotent re-edit)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    const again = repo.updateDraft({
      callInstanceId: call.id,
      draftContentHash: 'sha:d2',
    });
    assert.equal(again.status, 'edited');
    assert.equal(again.draftContentHash, 'sha:d2');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('validateCall: edited → validated; requires a draft', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    // No draft attached → validateCall must refuse.
    assert.throws(
      () => repo.validateCall(call.id),
      /CALL_DRAFT_REQUIRED/,
    );
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    const validated = repo.validateCall(call.id);
    assert.equal(validated.status, 'validated');
    assert.equal(validated.draftContentHash, 'sha:d1');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('submitCall: validated → submitted', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    const submitted = repo.submitCall(call.id);
    assert.equal(submitted.status, 'submitted');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// sealCall (C030).
// ---------------------------------------------------------------------------

test('sealCall (C030): succeeded → sealed; stamps receipt + sealed_at', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    // The runtime flips submitted → succeeded when it records the receipt; the
    // repo only seals. Force to succeeded to exercise sealCall.
    forceStatus(ctx.db, call.id, 'succeeded');
    const sealed = repo.sealCall(call.id, 'receipt:abc123');
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.successfulReceiptRef, 'receipt:abc123');
    assert.ok(sealed.sealedAt, 'sealed_at must be set');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('sealCall (C030): rejects an empty / untrimmed receipt', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    forceStatus(ctx.db, call.id, 'succeeded');
    assert.throws(
      () => repo.sealCall(call.id, ''),
      /CALL_RECEIPT_REQUIRED/,
    );
    assert.throws(
      () => repo.sealCall(call.id, ' r '),
      /CALL_RECEIPT_REQUIRED/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// failCall (C029 draft preservation) + retryCall (C029 progressive correction).
// ---------------------------------------------------------------------------

test('failCall: submitted → failed, records error, PRESERVES draft (C029)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    const failed = repo.failCall({
      callInstanceId: call.id,
      lastErrorJson: '{"code":"E_TOOL","msg":"boom"}',
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.lastErrorJson, '{"code":"E_TOOL","msg":"boom"}');
    // C029 — the draft MUST be preserved across the failure.
    assert.equal(failed.draftContentHash, 'sha:d1');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('failCall: requires a non-empty lastErrorJson', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    assert.throws(
      () => repo.failCall({ callInstanceId: call.id, lastErrorJson: '' }),
      /CALL_LAST_ERROR_REQUIRED/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('retryCall (C029): failed → edited on the SAME row, draft preserved', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    repo.failCall({
      callInstanceId: call.id,
      lastErrorJson: '{"code":"E_TOOL"}',
    });
    const retried = repo.retryCall(call.id);
    assert.equal(retried.status, 'edited');
    assert.equal(retried.id, call.id, 'retry MUST reuse the same row (C029)');
    // C029 — the prior draft is preserved so the model can correct over it.
    assert.equal(retried.draftContentHash, 'sha:d1');
    // The prior error is also kept so the runtime can see why it failed.
    assert.equal(retried.lastErrorJson, '{"code":"E_TOOL"}');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('retryCall: full progressive-correction loop (fail → retry → re-edit → succeed)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    repo.failCall({ callInstanceId: call.id, lastErrorJson: '{"e":1}' });

    // Retry: re-open the same draft, correct it, re-submit, succeed, seal.
    repo.retryCall(call.id);
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d2' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    forceStatus(ctx.db, call.id, 'succeeded');
    const sealed = repo.sealCall(call.id, 'receipt:ok');
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.draftContentHash, 'sha:d2');
    assert.equal(sealed.successfulReceiptRef, 'receipt:ok');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// State machine: illegal transitions + missing rows.
// ---------------------------------------------------------------------------

test('state machine: submitCall on an edited row is rejected', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    assert.throws(
      () => repo.submitCall(call.id),
      /CALL_INSTANCE_INVALID_TRANSITION.*submitCall/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('state machine: sealCall on a submitted (not succeeded) row is rejected', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    assert.throws(
      () => repo.sealCall(call.id, 'receipt:r'),
      /CALL_INSTANCE_INVALID_TRANSITION.*sealCall/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('state machine: retryCall on an edited (not failed) row is rejected', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    assert.throws(
      () => repo.retryCall(call.id),
      /CALL_INSTANCE_INVALID_TRANSITION.*retryCall/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('state machine: a sealed row accepts no further transitions', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    repo.submitCall(call.id);
    forceStatus(ctx.db, call.id, 'succeeded');
    repo.sealCall(call.id, 'receipt:r');
    // Every mutator on a sealed row must be rejected.
    assert.throws(
      () => repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d2' }),
      /CALL_INSTANCE_INVALID_TRANSITION/,
    );
    assert.throws(
      () => repo.failCall({ callInstanceId: call.id, lastErrorJson: '{"e":1}' }),
      /CALL_INSTANCE_INVALID_TRANSITION/,
    );
    assert.throws(
      () => repo.retryCall(call.id),
      /CALL_INSTANCE_INVALID_TRANSITION/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

test('state machine: missing row throws CALL_INSTANCE_MISSING', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    assert.throws(
      () => repo.updateDraft({ callInstanceId: 999, draftContentHash: 'sha:d1' }),
      /CALL_INSTANCE_MISSING/,
    );
    assert.throws(
      () => repo.validateCall(999),
      /CALL_INSTANCE_MISSING/,
    );
    assert.throws(
      () => repo.failCall({ callInstanceId: 999, lastErrorJson: '{"e":1}' }),
      /CALL_INSTANCE_MISSING/,
    );
    assert.equal(repo.readCallInstance(999), null);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// abandonCall (terminal escape).
// ---------------------------------------------------------------------------

test('abandonCall: non-terminal → abandoned; terminal rows rejected', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const call = repo.createCallInstance({
      processRunId: 1,
      toolContractRef: 'tool.x',
    });
    const abandoned = repo.abandonCall(call.id);
    assert.equal(abandoned.status, 'abandoned');
    // Abandoning an already-terminal row is rejected.
    assert.throws(
      () => repo.abandonCall(call.id),
      /CALL_INSTANCE_INVALID_TRANSITION/,
    );
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// readCallInstance + crash-resume.
// ---------------------------------------------------------------------------

test('readCallInstance: returns the row or null (crash-resume entry)', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    assert.equal(repo.readCallInstance(1), null);
    const call = repo.createCallInstance({
      processRunId: 1,
      stepId: 's1',
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    // Simulate a crash: no further writes. On restart the runtime reads the
    // call to resume.
    const resumed = repo.readCallInstance(call.id);
    assert.ok(resumed);
    assert.equal(resumed.status, 'validated');
    assert.equal(resumed.draftContentHash, 'sha:d1');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// listForStep.
// ---------------------------------------------------------------------------

test('listForStep: returns rows in (attempt, id) order for a step triple', () => {
  const ctx = freshDb();
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    const a1 = repo.createCallInstance({
      processRunId: 1,
      stepId: 's1',
      toolContractRef: 'tool.x',
      attempt: 1,
    });
    // A different tool for the same step coexists.
    repo.createCallInstance({
      processRunId: 1,
      stepId: 's1',
      toolContractRef: 'tool.y',
      attempt: 1,
    });
    // A second attempt of tool.x at the same step.
    const a2 = repo.createCallInstance({
      processRunId: 1,
      stepId: 's1',
      toolContractRef: 'tool.x',
      attempt: 2,
    });
    // A different process run is excluded.
    repo.createCallInstance({
      processRunId: 2,
      stepId: 's1',
      toolContractRef: 'tool.x',
      attempt: 1,
    });

    const calls = repo.listForStep(1, 's1', 'tool.x');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, a1.id);
    assert.equal(calls[0].attempt, 1);
    assert.equal(calls[1].id, a2.id);
    assert.equal(calls[1].attempt, 2);
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});

// ---------------------------------------------------------------------------
// Persistence across DB reopen (dual-placement idempotency).
// ---------------------------------------------------------------------------

test('persistence: call rows survive DB reopen', () => {
  const ctx = freshDb();
  let call;
  try {
    const repo = new SqliteCallInstanceRepository(ctx.db);
    call = repo.createCallInstance({
      processRunId: 1,
      stepId: 's1',
      toolContractRef: 'tool.x',
    });
    repo.updateDraft({ callInstanceId: call.id, draftContentHash: 'sha:d1' });
    repo.validateCall(call.id);
    closeDb();
    // Reopen: getDb() runs the dual-placement in src/db.ts (guarded on
    // factory_process_runs existing) — it must be a no-op for our table.
    const db2 = getDb();
    db2.pragma('foreign_keys = OFF');
    const repo2 = new SqliteCallInstanceRepository(db2);
    const resumed = repo2.readCallInstance(call.id);
    assert.ok(resumed);
    assert.equal(resumed.id, call.id);
    assert.equal(resumed.status, 'validated');
    assert.equal(resumed.draftContentHash, 'sha:d1');
  } finally {
    cleanup(ctx.temp, ctx.previous);
  }
});
