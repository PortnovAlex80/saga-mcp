import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { waitForLifecycleStartReceipt } = await import(
  '../../dist/app/product-lifecycle-run-starter.js'
);
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);

class FakeChild extends EventEmitter {
  unref() {}
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

test('Discovery is a real gate: only go routes to Formalization', () => {
  const discovery = productDeliveryLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  assert.deepEqual(discovery.outcomeRoutes.go, {
    type: 'stage',
    stageId: 'solution-formalization',
  });
  for (const outcome of ['clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.equal(discovery.outcomeRoutes[outcome].type, 'terminal');
  }
});
