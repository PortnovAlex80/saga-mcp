// tests/factory-contract/stale-fencing.test.mjs
// AC-29: terminal execution states rejected by authorization gateway.
import { test } from 'node:test';
import assert from 'node:assert';
import { authorizeSagaToolCall } from '../../dist/shared/authority/authorize-tool-call.js';
import { getDb } from '../../dist/db.js';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = 'a'.repeat(64);
const envelope = JSON.stringify({
  execution_context_hash: h,
  execution_context: {
    policy_version: 'v2', captured_at: '2026-01-01T00:00:00Z',
    executor_kind: 'claude-cli', model_route: { provider: 'anthropic' },
    work_intent_id: 1, task_id: 1, execution_id: 'exec-stale',
    node_id: 'n', module_ref: 'm@1.0.0', process_run_id: 1,
  },
});

test('AC-29: terminal execution states rejected', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-fence-'));
  process.env.DB_PATH = path.join(dir, 'fence.db');
  const db = getDb();

  // FK prerequisites
  db.prepare("INSERT OR IGNORE INTO projects (id, name, status) VALUES (1, 'fence-test', 'active')").run();
  db.prepare("INSERT OR IGNORE INTO epics (id, project_id, name, status) VALUES (1, 1, 'fence', 'planned')").run();
  db.prepare("INSERT OR IGNORE INTO tasks (id, epic_id, title, status, task_kind, execution_mode, metadata) VALUES (1, 1, 'fence', 'in_progress', 'test.work', 'tracker_only', ?)")
    .run(JSON.stringify({ work_intent_id: 1 }));

  for (const s of ['lost', 'terminated', 'exited', 'spawn_failed']) {
    db.prepare("INSERT OR REPLACE INTO worker_executions (execution_id, run_id, task_id, worker_id, project_id, epic_id, machine_id, state, phase, reserved_at, metadata) VALUES ('exec-stale', 'run-1', 1, 'w', 1, 1, 'test-host', ?, 'executing', '2026-01-01', ?)")
      .run(s, envelope);
    const d = authorizeSagaToolCall({ toolName: 'product_submit', db, executionId: 'exec-stale', managedExecution: '1', taskId: '1', workerId: 'w' });
    assert.ok(!d.allow, `state=${s} rejected`);
  }
});

test('AC-29b: absent execution rejected', () => {
  const d = authorizeSagaToolCall({ toolName: 'product_submit', db: getDb(), executionId: 'nonexistent', managedExecution: '1', taskId: '1', workerId: 'w' });
  assert.ok(!d.allow, 'absent execution rejected');
});
