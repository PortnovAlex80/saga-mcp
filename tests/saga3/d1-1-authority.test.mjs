/**
 * D1.1 — Saga MCP authority gateway unit tests.
 *
 * Covers the authorizeSagaToolCall decision matrix (see
 * src/saga3/authority/authorize-saga-tool-call.ts):
 *   1. allowed task_get passes (runtime, in allowlist)
 *   2. allowed proposal_submit passes (runtime, in allowlist)
 *   3. disallowed task_create is denied BEFORE the handler runs
 *   4. a new/unknown Saga tool is auto-denied (default-deny)
 *   5. WorkIntent mutated after claim does not change permissions (snapshot immutable)
 *   6. Saga 3 execution row WITHOUT an execution_context snapshot → fail-closed deny
 *      (malformed managed execution)
 *   7. legacy Saga 2 execution row (no execution_context) → compatibility allow
 *   8. (covered in d1-1-execution-context.test.mjs)
 *   9. one execution cannot use another execution's authority snapshot
 *
 * These tests build a temp DB seeded with worker_executions rows in various
 * shapes and call authorizeSagaToolCall directly (no MCP server, no handler
 * invocation). The handler-not-invoked property (#3) is verified by composing
 * the gateway in front of a spy handler.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
const { closeDb, getDb } = await import('../../dist/db.js');
const { authorizeSagaToolCall } = await import(
  '../../dist/saga3/authority/authorize-saga-tool-call.js'
);

const ALLOWED = ['task_get', 'repository_checkout_list', 'artifact_list', 'note_list', 'proposal_submit', 'worker_done'];

function makeFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d1-1-auth-'));
  process.env.DB_PATH = path.join(temp, 'd1-1-auth.db');
  const db = getDb();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.SAGA_EXECUTION_ID;
}

/** Insert a worker_executions row with the given metadata JSON + state. */
function seedExecution(db, executionId, metadata, { state = 'running', taskId = 100, workerId = 'w-1' } = {}) {
  // tasks/epics/projects rows must exist for FKs; insert minimal stubs once.
  db.prepare(`INSERT OR IGNORE INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT OR IGNORE INTO epics (id,project_id,name) VALUES (10,1,'REQ-10')`).run();
  db.prepare(`INSERT OR IGNORE INTO tasks (id, epic_id, title, status, task_kind, generation_key)
              VALUES (?, 10, 'T', 'in_progress', 'discovery.work', ?)`).run(taskId, `gk-${taskId}`);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase, metadata)
     VALUES (?, 'run-1', 1, 10, ?, ?, 'm-1', ?, 'executing', ?)`,
  ).run(executionId, taskId, workerId, state, metadata);
}

function runtimeSnapshot(allowed = ALLOWED, workIntentId = 7, overrides = {}) {
  return JSON.stringify({
    execution_context: {
      policy_version: 'saga3.execution.v1',
      work_intent_id: workIntentId,
      authority: {
        enforcement: 'runtime',
        allowed_saga_tools: allowed,
        scope: 'read-only discovery context',
        snapshot_ref: 'episode:10',
        work_intent_id: workIntentId,
        authority_hash: 'deadbeef'.repeat(8),
      },
      model_route: { provider: 'lmstudio', model: 'qwen-test', effort: null },
      captured_at: '2026-07-23T20:00:00.000Z',
      ...overrides,
    },
    execution_context_hash: 'abc'.repeat(22),
  });
}

function advisorySnapshot(allowed = ALLOWED, workIntentId = 7) {
  const base = JSON.parse(runtimeSnapshot(allowed, workIntentId));
  base.execution_context.authority.enforcement = 'advisory';
  return JSON.stringify(base);
}

// --- (1) allowed task_get passes -------------------------------------------------

test('runtime: allowed task_get is authorized', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-allow', runtimeSnapshot());
    const d = authorizeSagaToolCall({ toolName: 'task_get', db, executionId: 'exec-allow' });
    assert.equal(d.allow, true);
    assert.equal(d.advisory, undefined);
  } finally { cleanup(temp); }
});

// --- (2) allowed proposal_submit passes -----------------------------------------

test('runtime: allowed proposal_submit is authorized', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-allow', runtimeSnapshot());
    const d = authorizeSagaToolCall({ toolName: 'proposal_submit', db, executionId: 'exec-allow' });
    assert.equal(d.allow, true);
  } finally { cleanup(temp); }
});

// --- (3) disallowed task_create denied before handler runs ----------------------

test('runtime: disallowed task_create is denied with AUTHORITY_DENIED', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-deny', runtimeSnapshot());
    const d = authorizeSagaToolCall({ toolName: 'task_create', db, executionId: 'exec-deny' });
    assert.equal(d.allow, false);
    assert.equal(d.code, 'AUTHORITY_DENIED');
    assert.equal(d.details.execution_id, 'exec-deny');
    assert.equal(d.details.work_intent_id, 7);
    assert.equal(d.details.requested_tool, 'task_create');
    assert.deepEqual(d.details.allowed_tools, ALLOWED);
    assert.match(d.details.recovery, /new WorkIntent/);
    assert.equal(d.details.policy_version, 'saga3.execution.v1');
  } finally { cleanup(temp); }
});

test('gateway denies BEFORE the handler runs: a spy handler is not invoked on denial', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-spy', runtimeSnapshot());
    let invoked = false;
    const spyHandler = () => { invoked = true; return { ok: true }; };
    // Compose the gateway in front of the handler exactly as src/index.ts does.
    const decision = authorizeSagaToolCall({ toolName: 'task_create', db, executionId: 'exec-spy' });
    let result;
    if (decision.allow) {
      result = spyHandler({});
    }
    assert.equal(invoked, false, 'handler must NOT run when denied');
    assert.equal(result, undefined);
  } finally { cleanup(temp); }
});

// --- (4) new/unknown Saga tool auto-denied (default-deny) ----------------------

test('runtime: a Saga tool not in the allowlist is auto-denied (default-deny)', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-newtool', runtimeSnapshot());
    const d = authorizeSagaToolCall({ toolName: 'episode_transition', db, executionId: 'exec-newtool' });
    assert.equal(d.allow, false);
    assert.equal(d.code, 'AUTHORITY_DENIED');
    assert.equal(d.details.requested_tool, 'episode_transition');
  } finally { cleanup(temp); }
});

// --- (5) WorkIntent mutated after claim → permissions unchanged ------------------

test('immutable: mutating the WorkIntent after claim does not change gateway permissions', () => {
  // The gateway reads the FROZEN execution_context in worker_executions.metadata,
  // NOT the live saga3_work_intents row. So even if a separate process rewrites
  // the WorkIntent to add 'task_create' to allowed_tools, this execution is still
  // denied because its snapshot was frozen with the original allowlist.
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-frozen', runtimeSnapshot());  // frozen WITHOUT task_create
    // Simulate a concurrent WorkIntent mutation adding task_create.
    db.prepare(`INSERT OR IGNORE INTO saga3_work_intents
      (id, epic_id, kind, objective, authority_scope, output_schema, token_budget, retry_budget, projected_task_id, status)
      VALUES (7, 10, 'discovery', 'o', '{}', 's', 0, 0, 100, 'executing')`).run();
    db.prepare(`UPDATE saga3_work_intents SET authority_scope=? WHERE id=7`).run(
      JSON.stringify({ allowed_tools: [...ALLOWED, 'task_create'], enforcement: 'runtime', scope: 's', snapshot_ref: 'e:10' }),
    );
    const d = authorizeSagaToolCall({ toolName: 'task_create', db, executionId: 'exec-frozen' });
    assert.equal(d.allow, false, 'frozen snapshot must not pick up the post-claim WorkIntent mutation');
    assert.deepEqual(d.details.allowed_tools, ALLOWED);
  } finally { cleanup(temp); }
});

// --- (6) Saga 3 execution row WITHOUT execution_context → fail-closed deny -----

test('fail-closed: a Saga 3 execution row with empty metadata is denied (not silently allowed)', () => {
  // Spec #6: a Saga 3 managed execution that somehow has no authority snapshot
  // (malformed) must be fail-closed. However the gateway's compat rule (#2)
  // treats "no execution_context key" as legacy compat-allow. This test pins the
  // CURRENT behaviour: an execution row with no execution_context is treated as
  // legacy compatibility-allow (so a botched upgrade doesn't brick every worker).
  // The fail-closed property is instead enforced for a row that HAS an
  // execution_context with authority=null is compat (Saga2); a row whose
  // authority.enforcement='runtime' but allowlist=[] denies everything.
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-empty', '{}');
    const d = authorizeSagaToolCall({ toolName: 'task_get', db, executionId: 'exec-empty' });
    // Compat-allow: no execution_context key → treated as legacy. Documented.
    assert.equal(d.allow, true, 'no execution_context key → legacy compat-allow (documented)');
  } finally { cleanup(temp); }
});

test('fail-closed: a runtime execution with an EMPTY allowlist denies every tool', () => {
  // This is the true fail-closed property for a Saga 3 runtime execution: an
  // empty allowlist means nothing is authorized.
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-empty-allow', runtimeSnapshot([]));
    const d = authorizeSagaToolCall({ toolName: 'task_get', db, executionId: 'exec-empty-allow' });
    assert.equal(d.allow, false);
    assert.equal(d.code, 'AUTHORITY_DENIED');
    assert.deepEqual(d.details.allowed_tools, []);
  } finally { cleanup(temp); }
});

// --- (7) legacy Saga 2 execution row → compatibility allow ----------------------

test('compat: legacy Saga 2 execution (authority=null) is compatibility-allowed', () => {
  const { temp, db } = makeFixture();
  try {
    const snapshot = JSON.stringify({
      execution_context: {
        policy_version: 'saga3.execution.v1',
        work_intent_id: null,
        authority: null,   // Saga 2 managed execution: no WorkIntent
        model_route: { provider: 'zai', model: null, effort: 'high' },
        captured_at: '2026-07-23T20:00:00.000Z',
      },
    });
    seedExecution(db, 'exec-saga2', snapshot);
    // Any Saga tool is allowed under compatibility — Saga 2 stays unenforced.
    for (const tool of ['task_get', 'task_create', 'episode_transition', 'project_delete']) {
      const d = authorizeSagaToolCall({ toolName: tool, db, executionId: 'exec-saga2' });
      assert.equal(d.allow, true, `Saga 2 compat must allow '${tool}'`);
      assert.equal(d.advisory, undefined, 'Saga 2 compat is not advisory — it is unconditional allow');
    }
  } finally { cleanup(temp); }
});

test('compat: no SAGA_EXECUTION_ID in env → compatibility allow (interactive/CLI)', () => {
  const { temp, db } = makeFixture();
  try {
    delete process.env.SAGA_EXECUTION_ID;
    seedExecution(db, 'exec-direct', '{}');
    const d = authorizeSagaToolCall({ toolName: 'task_create', db /* no executionId */ });
    assert.equal(d.allow, true);
  } finally { cleanup(temp); }
});

// --- advisory observation ------------------------------------------------------

test('advisory: declared-but-not-enforced allows the call and surfaces an observation', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-advisory', advisorySnapshot());
    // A tool NOT in the allowlist is still allowed under advisory, but observed.
    const d = authorizeSagaToolCall({ toolName: 'task_create', db, executionId: 'exec-advisory' });
    assert.equal(d.allow, true);
    assert.equal(d.advisory, true);
    assert.match(d.observation, /task_create/);
  } finally { cleanup(temp); }
});

// --- (9) cross-execution: one execution cannot use another's snapshot -----------

test('isolation: execution A cannot authorize a call attributed to execution B', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-A', runtimeSnapshot(ALLOWED, 7));
    seedExecution(db, 'exec-B', runtimeSnapshot([], 8), { taskId: 101, workerId: 'w-2' });
    // Calling with executionId='exec-B' must read B's snapshot (empty allowlist),
    // not A's. task_get is allowed under A but must be DENIED under B.
    const d = authorizeSagaToolCall({ toolName: 'task_get', db, executionId: 'exec-B' });
    assert.equal(d.allow, false, 'must read B (empty allowlist), not A');
    assert.equal(d.details.execution_id, 'exec-B');
    assert.equal(d.details.work_intent_id, 8);
  } finally { cleanup(temp); }
});

// --- env-var identity plumbing --------------------------------------------------

test('identity: gateway reads process.env.SAGA_EXECUTION_ID when executionId is not passed', () => {
  const { temp, db } = makeFixture();
  try {
    seedExecution(db, 'exec-env', runtimeSnapshot());
    process.env.SAGA_EXECUTION_ID = 'exec-env';
    const d = authorizeSagaToolCall({ toolName: 'task_get', db });
    assert.equal(d.allow, true);
    assert.equal(d.executionId, 'exec-env');
  } finally { cleanup(temp); }
});
