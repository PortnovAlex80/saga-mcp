import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { waitForLifecycleStartReceipt, createFactoryLaunchStarter } = await import(
  '../../dist/app/product-lifecycle-run-starter.js'
);
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);

class FakeChild extends EventEmitter {
  unref() {}
  // Intentionally NO stdout/stderr: with stdio ['ignore','ignore','pipe'] the
  // real child exposes no stdout at all — the starter must not depend on it.
}

test('spawn starter waits for a positive durable LifecycleRun receipt', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-start-receipt-'));
  const receiptPath = path.join(dir, 'receipt.json');
  const child = new FakeChild();
  try {
    setTimeout(() => {
      writeFileSync(receiptPath, JSON.stringify({
        lifecycleRunId: 42,
        status: 'created',
        createdAt: new Date().toISOString(),
        acknowledgedAt: new Date().toISOString(),
      }));
    }, 10);
    const result = await waitForLifecycleStartReceipt({
      child,
      receiptPath,
      timeoutMs: 1_000,
      pollMs: 5,
    });
    assert.deepEqual(result, { lifecycleRunId: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn starter rejects child exit before durable acknowledgement', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-start-exit-'));
  const receiptPath = path.join(dir, 'receipt.json');
  const child = new FakeChild();
  try {
    setTimeout(() => child.emit('exit', 1, null), 10);
    await assert.rejects(
      waitForLifecycleStartReceipt({
        child,
        receiptPath,
        timeoutMs: 1_000,
        pollMs: 5,
      }),
      /LIFECYCLE_START_CHILD_EXITED_BEFORE_RECEIPT/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('factory launch starter spawns the engine WITHOUT a stdout pipe (antifreeze layer A)', async () => {
  // Regression test for the stdout-backpressure freeze class: the engine's
  // stdout used to be a pipe drained by the panel's event loop. A stalled
  // panel fills the pipe buffer and the engine's next blocking stdout
  // write freezes its main thread forever. The engine now logs to
  // $SAGA_ENGINE_LOG (file-only) and stdout must be 'ignore'. Startup
  // success is proven by the receipt FILE, never by stdout.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-start-stdio-'));
  const dbPath = path.join(dir, 'test.db');
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  const spawnCalls = [];
  let db = null;
  try {
    const { getDb } = await import('../../dist/db.js');
    db = getDb();
    db.prepare("INSERT INTO projects (id,name) VALUES (7,'p7')").run();
    db.prepare("INSERT INTO epics (id,project_id,name) VALUES (7,7,'e7')").run();
    db.prepare(
      `INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state)
       VALUES ('ord-stdio', 7, 7, 'idea_url', 'provisioned')`,
    ).run();

    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      const child = new FakeChild();
      // Emulate the engine's durable start receipt (written to the FILE the
      // starter waits for — not to stdout).
      const receiptPath = options.env.SAGA_LIFECYCLE_START_RECEIPT;
      setTimeout(() => {
        writeFileSync(receiptPath, JSON.stringify({ lifecycleRunId: 11 }));
      }, 5);
      return child;
    };

    const starter = createFactoryLaunchStarter({
      dbPath,
      spawnProcess: fakeSpawn,
      startReceiptTimeoutMs: 2_000,
      startReceiptPollMs: 5,
    });
    const result = await starter.start({
      orderRef: 'ord-stdio',
      projectId: 7,
      epicId: 7,
      lifecycleInput: { idea: 'stdio-antifreeze' },
      lifecycleInputSchema: 'product-delivery@test',
      initiatedBy: 'stdio-test',
      concurrency: 1,
      idempotencyKey: 'stdio-test-1',
    });
    assert.deepEqual(result, { lifecycleRunId: 11 });
    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    assert.equal(call.cmd, 'node');
    // THE antifreeze invariant: stdout (and stdin) are 'ignore'; only stderr
    // stays piped for crash diagnostics.
    assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'pipe']);
    assert.equal(call.options.detached, true);
    // The engine child must receive the file-only log target.
    assert.ok(call.options.env.SAGA_ENGINE_LOG, 'SAGA_ENGINE_LOG must be set for the engine child');
    assert.ok(call.options.env.SAGA_LIFECYCLE_START_RECEIPT);
    assert.equal(call.options.env.DB_PATH, dbPath);
  } finally {
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    const leakedEngineLog = spawnCalls[0]?.options?.env?.SAGA_ENGINE_LOG;
    if (leakedEngineLog) {
      try { unlinkSync(leakedEngineLog); } catch { /* stream may still hold it */ }
    }
    try { db?.close(); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold WAL locks briefly */ }
  }
});

test('Discovery is a real gate: only go routes to Formalization', () => {
  // Commit 12b4390 "Discovery is permissive": Discovery is an idea-STRENGTH
  // gate, not a build gate. The outcome strength is recorded in the discovery
  // certificate and carried forward; it must NOT block the conveyor. Every
  // Discovery outcome now forwards to Formalization (the real go/no-go gate),
  // not to terminal. Regression test:
  // tests/characterization/lifecycle-routing-mapping-lock.test.mjs:758-775.
  const discovery = productDeliveryLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  assert.deepEqual(discovery.outcomeRoutes.go, {
    type: 'stage',
    stageId: 'solution-formalization',
  });
  // 'defer'/'inconclusive' were deleted with their routes (5cbbb1ff — no
  // runtime producer, W9-04-UNREACHABLE-EDGE-EVIDENCE): the producible
  // vocabulary is go/clarify/reject plus the runtime-only 'failed'.
  for (const outcome of ['clarify', 'reject', 'failed']) {
    assert.deepEqual(discovery.outcomeRoutes[outcome], {
      type: 'stage',
      stageId: 'solution-formalization',
    });
  }
});
