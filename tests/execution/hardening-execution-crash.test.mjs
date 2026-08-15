// tests/execution/hardening-execution-crash.test.mjs
//
// W12-A2 — ProcessRun / NodeRun / receipt / production crash-point tests.
// Wave 12 lane A2 · Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md §2 (lane A2).
// Task: docs/refactor-management/05-subagent-tasks/W12-a2.md
//
// WHAT THIS PROVES (spec §2 lane A2 + §5 test design principles)
//   A process death (SIGKILL / power loss) occurring BEFORE or AFTER every
//   durable boundary in the generic Process Module execution layer MUST be
//   resumable by reloading the EXACT persisted state from SQLite — never by
//   reconstructing mutable in-memory frames, never by "latest-execution" /
//   "process-scope" fallback heuristics, never by silently re-deriving a
//   certificate or production. The four durable boundaries lane A2 owns:
//
//     1. RECEIPT WRITE  — factory_managed_node_submissions
//                         (the immutable LM → kernel typed-product submission.
//                          No-UPDATE / no-DELETE triggers make it append-only:
//                          one worker execution gets one immutable value.)
//     2. PRODUCTION WRITE — factory_process_products
//                           (the content-addressed ProcessProduct row keyed by
//                            (schemaId, artifactRef, productHash). Replay of an
//                            identical envelope is benign; mutation is rejected.)
//     3. NODERUN COMPLETE — factory_node_runs
//                            output_* columns AND the v2 production_envelope +
//                            transition_cursor. The exact-cursor resume index
//                            (process_run_id, node_id, attempt) makes resume an
//                            equality probe, not a scan.)
//     4. PROCESSRUN TRANSITION — factory_process_runs
//                                (status transitions through the state machine
//                                 + write-once terminal outcome/output/
//                                 certificate. A crash mid-pipeline leaves the
//                                 row on its last committed status; resume
//                                 re-issues the SAME transition idempotently.)
//
// TEST-ONLY WAVE (spec §0.15.2 / §4 anti-scope)
//   This file does NOT modify production code. It uses the REAL infrastructure
//   (real better-sqlite3, real filesystem DB, real repositories) — no mocks.
//   Crashes are injected by simulating process death: close the DB handle,
//   clear the in-memory module singleton, reopen against the SAME file. The
//   reopened handle sees exactly what a fresh process booting from disk would
//   see. This is the spec §5 injection model ("close DB, clear in-memory state,
//   reopen").
//
// EXIT GATE (spec §3)
//   Across injected failures at every durable boundary the persisted state is
//   recovered byte-for-byte (content hashes match across crash boundaries), no
//   fallback paths activate (no epic-scope search, no latest-execution), and
//   replay is idempotent.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// ---------------------------------------------------------------------------
// REAL infrastructure imports (built dist/). better-sqlite3 is an existing
// production dependency; these adapters are exactly what production wires.
// ---------------------------------------------------------------------------
const { closeDb, getDb } = await import('../../dist/db.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { SqliteProcessProductRepositoryV2 } = await import(
  '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js'
);
const { SqliteManagedNodeSubmissionRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js'
);

// ===========================================================================
// Harness: a fresh, isolated, file-backed SQLite environment that mirrors a
// real process boot. getDb() applies the FULL schema (SCHEMA_SQL + migrations
// + every ensure*Schema), so worker_executions / tasks / factory_process_runs /
// factory_node_runs / factory_process_products / factory_managed_node_submissions
// all exist exactly as in production.
// ===========================================================================

/**
 * Create a fresh file-backed DB environment. Returns the db handle, the on-disk
 * path, and a cleanup hook. NEVER shares a file across tests (spec §5).
 *
 * @param {string} prefix
 * @returns {{ db: import('better-sqlite3').Database; dbPath: string; dir: string; cleanup: () => void }}
 */
function freshDbEnv(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'hardening.db');
  // getDb() reads DB_PATH. Set it before first call.
  process.env.DB_PATH = dbPath;
  const db = getDb();
  return {
    db,
    dbPath,
    dir,
    cleanup() {
      try { closeDb(); } catch { /* already closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    },
  };
}

/**
 * Simulate process death + restart: close the DB handle, drop the in-memory
 * singleton, and reopen against the SAME on-disk file. A subsequent getDb()
 * rebuilds the connection from disk exactly as a fresh process boot would.
 *
 * This is the spec §5 crash-injection primitive. Returns the reopened handle.
 *
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function crashAndReopen(dbPath) {
  // Close + clear singleton = the running process "dies". On-disk WAL is
  // checkpointed on close, so the file holds the last committed transaction.
  closeDb();
  process.env.DB_PATH = dbPath;
  return getDb();
}

/**
 * Seed the minimal COHERENT board rows a ProcessRun + managed execution need:
 * project, epic. Returns their ids. The ProcessRun row references project_id
 * (FK), and the managed-node-submission live-fence query JOINs
 * tasks ↔ worker_executions ↔ factory_process_runs, so all of these must hang off
 * the SAME project. getDb() turns foreign_keys = ON, so we create the project
 * BEFORE any row that references it.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ projectId: number; epicId: number }}
 */
function seedBoard(db) {
  const projectId = Number(
    db.prepare('INSERT INTO projects (name) VALUES (?)')
      .run(`w12-a2-proj-${randomUUID().slice(0, 8)}`).lastInsertRowid,
  );
  const epicId = Number(
    db.prepare('INSERT INTO epics (project_id, name) VALUES (?, ?)')
      .run(projectId, `w12-a2-epic`).lastInsertRowid,
  );
  return { projectId, epicId };
}

/**
 * Seed the task + worker_execution rows a managed execution needs, on top of an
 * existing project/epic. The task carries the process provenance in its
 * metadata — exactly what resolveManagedExecutionProvenance reads
 * (process_run_id, process_node_id, process_module_ref, process_input_hash,
 * work_intent_id). The worker_execution is state='running' so the live fence
 * passes.
 *
 * The provenance fields MUST match the ProcessRun row exactly —
 * resolveManagedExecutionProvenance cross-checks (project_id, epic_id,
 * module_ref_key, input_hash) against the factory_process_runs row, so we derive
 * them from the run record rather than inventing them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ run: { id: number; projectId: number; epicId: number | null; moduleRefKey: string; inputHash: string }; nodeId: string; executionId: string; workerId: string }} ctx
 * @returns {{ taskId: number; intentId: number }}
 */
function seedManagedFenceRow(db, ctx) {
  const intentId = 7700 + Math.floor(Math.random() * 1000);
  const metadata = JSON.stringify({
    process_run_id: ctx.run.id,
    process_node_id: ctx.nodeId,
    process_module_ref: ctx.run.moduleRefKey,
    process_input_hash: ctx.run.inputHash,
    work_intent_id: intentId,
  });
  const taskId = Number(
    db.prepare(
      `INSERT INTO tasks (epic_id, title, status, assigned_to,
                          current_execution_id, task_kind, workflow_stage, metadata)
       VALUES (?, ?, 'in_progress', ?, ?, 'development.code', 'development', ?)`,
    ).run(
      ctx.run.epicId,
      `w12-a2-task-${ctx.nodeId}`,
      ctx.workerId,
      ctx.executionId,
      metadata,
    ).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 'executing')`,
  ).run(
    ctx.executionId,
    `run-${ctx.executionId}`,
    ctx.run.projectId,
    ctx.run.epicId,
    taskId,
    ctx.workerId,
    'machine-w12a2',
  );
  return { taskId, intentId };
}

/**
 * Set the env vars resolveManagedExecutionProvenance reads. A managed
 * execution is announced via SAGA_MANAGED_EXECUTION=1 + SAGA_EXECUTION_ID (+ an
 * optional SAGA_TASK_ID cross-check). This mirrors how the real CLI worker
 * process enters its managed fence.
 *
 * @param {{ executionId: string; taskId: number }} ctx
 */
function enterManagedFence(ctx) {
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = ctx.executionId;
  process.env.SAGA_TASK_ID = String(ctx.taskId);
}

function leaveManagedFence() {
  delete process.env.SAGA_MANAGED_EXECUTION;
  delete process.env.SAGA_EXECUTION_ID;
  delete process.env.SAGA_TASK_ID;
}

/**
 * Start a ProcessRun and drive it to status='running' (the status the managed-
 * submission fence requires). Returns the run record. The start command mirrors
 * what process_run_start builds: caller-chosen idempotency_key + content-hash.
 *
 * @param {SqliteProcessRunRepository} repo
 * @param {{ projectId: number; epicId?: number | null; moduleRef?: { name: string; version: string }; idempotencyKey?: string }} opts
 * @returns {import('../../dist/process-modules/persistence/process-run.js').ProcessRunRecord}
 */
function startRunningProcessRun(repo, opts) {
  const o = opts ?? { projectId: 0 };
  const moduleRef = o.moduleRef ?? { name: 'product-development', version: '3.0.0' };
  const payload = { idea: 'w12-a2 crash-probe', seed: randomUUID() };
  const contentHash = sha256Hex(payload);
  const { record } = repo.start({
    moduleRef,
    input: { schema: 'factory.development-case.v1', payload, contentHash },
    executorKind: 'generic-flow',
    projectedStage: 'development',
    installationId: null,
    packageDigest: null,
    invocationContext: {
      projectId: o.projectId,
      epicId: o.epicId ?? null,
      initiatedBy: 'w12-a2-hardening',
      idempotencyKey: o.idempotencyKey ?? `idem-${randomUUID()}`,
    },
  });
  // created → preparing → running (the legal path to the running status the
  // managed-submission fence demands).
  repo.update(record.id, { status: 'preparing' });
  return repo.update(record.id, { status: 'running' });
}

/**
 * Build the canonical NodeProductionEnvelope a worker/kernel persists. Its
 * contentHash is the byte-for-byte oracle every crash-resume must match.
 *
 * @param {{ schemaId: string; artifactRef: string; body: unknown; predecessorNodeRunIds?: number[] }} p
 */
function buildProductionEnvelope({ schemaId, artifactRef, body, predecessorNodeRunIds = [] }) {
  const contentHash = sha256Hex(body);
  return {
    schema: schemaId,
    artifactRef,
    contentHash,
    bindings: body && typeof body === 'object' ? body : { value: body },
    schemaId: `${schemaId}.envelope`,
    productRef: { schemaId, ref: artifactRef, digest: contentHash },
    lineage: predecessorNodeRunIds.map((id) => ({ kind: 'node-run', ref: `node-run:${id}` })),
  };
}

// ===========================================================================
// Boundary 1 — RECEIPT WRITE (factory_managed_node_submissions)
// ===========================================================================
//
// The managed-node-submission is the immutable LM → kernel typed-product
// boundary. One (process_run_id, node_id, execution_id) triple gets exactly one
// immutable value. The table has BEFORE-UPDATE and BEFORE-DELETE triggers that
// RAISE(ABORT), so once a receipt row is committed it can NEVER be mutated or
// erased — a crash after the INSERT changes nothing about what resume reads.
//
// We prove:
//   - crash AFTER the receipt INSERT: resume reads the EXACT same payload +
//     content_hash (byte-for-byte), replayed=true on a second identical submit.
//   - crash BEFORE any receipt INSERT: resume sees NO row (the boundary was
//     not crossed) — a fresh submit then creates the row once.
//   - immutability: a second submit with a DIFFERENT payload is rejected
//     (MANAGED_NODE_SUBMISSION_ALREADY_FINAL), proving no crash can let a
//     second value slip in under the same execution.

test('boundary 1 (receipt write): crash AFTER managed-node-submission INSERT — resume reads exact receipt, replay is idempotent', () => {
  const env = freshDbEnv('w12a2-receipt-after-');
  try {
    // ── Arrange: a coherent board, a running ProcessRun, + a live fence. ─────
    const { projectId, epicId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId, epicId });
    const executionId = `exec-${randomUUID()}`;
    const workerId = `worker-${randomUUID()}`;
    const nodeId = 'development.plan';
    const { taskId } = seedManagedFenceRow(env.db, {
      run, nodeId, executionId, workerId,
    });
    const moduleRef = run.moduleRefKey;

    // ── Act: submit the receipt, then the process DIES. ────────────────────
    enterManagedFence({ executionId, taskId });
    const submissionRepo = new SqliteManagedNodeSubmissionRepository(env.db);
    const payload = {
      proposal: { tasks: [{ title: 'implement X', skill: 'dev' }] },
      manifest_version: 1,
    };
    const first = submissionRepo.submitForCurrentExecution({
      schema: 'factory.development-task-graph.v1',
      payload,
    });
    assert.equal(first.replayed, false, 'first submit is not a replay');
    leaveManagedFence();

    // ── CRASH: close + reopen from disk. ────────────────────────────────────
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteManagedNodeSubmissionRepository(reopened);

    // ── Assert: resume reads the EXACT receipt byte-for-byte. ───────────────
    const readBack = resumedRepo.readExact({
      processRunId: run.id,
      moduleRef,
      nodeId,
      // intentId/taskId/executionId are the resume key — no "latest" scan.
      intentId: first.record.intentId,
      taskId,
      executionId,
    });
    assert.ok(readBack, 'resume must find the receipt by exact key (no fallback scan)');
    assert.equal(readBack.contentHash, first.record.contentHash);
    assert.equal(canonicalJson(readBack.payload), canonicalJson(first.record.payload));
    assert.equal(readBack.schema, 'factory.development-task-graph.v1');
    assert.equal(readBack.submissionId, first.record.submissionId, 'row id stable across crash');

    // ── Assert: a second identical submit is a benign replay. ───────────────
    enterManagedFence({ executionId, taskId });
    const replayed = resumedRepo.submitForCurrentExecution({
      schema: 'factory.development-task-graph.v1',
      payload,
    });
    assert.equal(replayed.replayed, true, 'identical replay must be idempotent after crash');
    assert.equal(replayed.record.submissionId, first.record.submissionId);
    leaveManagedFence();
  } finally {
    leaveManagedFence();
    env.cleanup();
  }
});

test('boundary 1 (receipt write): crash BEFORE managed-node-submission INSERT — resume sees no row, fresh submit creates it once', () => {
  const env = freshDbEnv('w12a2-receipt-before-');
  try {
    const { projectId, epicId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId, epicId });
    const executionId = `exec-${randomUUID()}`;
    const workerId = `worker-${randomUUID()}`;
    const nodeId = 'development.plan';
    const moduleRef = run.moduleRefKey;
    const { taskId } = seedManagedFenceRow(env.db, {
      run, nodeId, executionId, workerId,
    });

    // ── CRASH happens BEFORE any receipt write: nothing committed. ──────────
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteManagedNodeSubmissionRepository(reopened);

    // Assert: no receipt row exists yet (boundary was not crossed).
    const absent = resumedRepo.readExact({
      processRunId: run.id, moduleRef, nodeId,
      intentId: 7777, taskId, executionId,
    });
    assert.equal(absent, null, 'no receipt before the boundary is crossed');

    // Resume then submits for the first time — creates the row exactly once.
    enterManagedFence({ executionId, taskId });
    const first = resumedRepo.submitForCurrentExecution({
      schema: 'factory.development-task-graph.v1',
      payload: { proposal: { tasks: [] } },
    });
    assert.equal(first.replayed, false, 'first post-crash submit creates the row');
    leaveManagedFence();
  } finally {
    leaveManagedFence();
    env.cleanup();
  }
});

test('boundary 1 (receipt write): a second DIFFERENT payload under the same execution is rejected — crash cannot let a second value slip in', () => {
  const env = freshDbEnv('w12a2-receipt-immut-');
  try {
    const { projectId, epicId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId, epicId });
    const executionId = `exec-${randomUUID()}`;
    const workerId = `worker-${randomUUID()}`;
    const nodeId = 'development.plan';
    const moduleRef = run.moduleRefKey;
    const { taskId } = seedManagedFenceRow(env.db, {
      run, nodeId, executionId, workerId,
    });

    enterManagedFence({ executionId, taskId });
    const submissionRepo = new SqliteManagedNodeSubmissionRepository(env.db);
    submissionRepo.submitForCurrentExecution({
      schema: 'factory.development-task-graph.v1',
      payload: { proposal: { tasks: [{ title: 'A' }] } },
    });
    leaveManagedFence();

    // CRASH + reopen.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteManagedNodeSubmissionRepository(reopened);

    // A DIFFERENT payload under the same execution MUST be rejected — the
    // receipt is immutable. The trigger + the equality check both enforce this.
    enterManagedFence({ executionId, taskId });
    assert.throws(
      () => resumedRepo.submitForCurrentExecution({
        schema: 'factory.development-task-graph.v1',
        payload: { proposal: { tasks: [{ title: 'B' }] } }, // different
      }),
      /MANAGED_NODE_SUBMISSION_ALREADY_FINAL/,
      'a second different value under the same execution must be rejected post-crash',
    );
    leaveManagedFence();
  } finally {
    leaveManagedFence();
    env.cleanup();
  }
});

// ===========================================================================
// Boundary 2 — PRODUCTION WRITE (factory_process_products)
// ===========================================================================
//
// The ProcessProduct row is content-addressed by (schemaId, artifactRef,
// productHash). recordProduct detects a replay by (schemaId, artifactRef) and
// asserts the productHash + payload match; any divergence throws
// PROCESS_PRODUCT_REPLAY_MISMATCH. A crash after the INSERT leaves the row
// immutable on disk; resume reads the EXACT same envelope (content hash equal)
// and a second recordProduct of the identical envelope is a benign replay.

test('boundary 2 (production write): crash AFTER process-product INSERT — resume reads exact envelope (content-hash equal), replay idempotent', () => {
  const env = freshDbEnv('w12a2-prod-after-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });

    const envelope = buildProductionEnvelope({
      schemaId: 'factory.development-task-graph.v1',
      artifactRef: 'task-graph:9101',
      body: { tasks: [{ title: 'implement AC-1', skill: 'dev' }] },
    });

    // Write the production, then CRASH.
    let productRepo = new SqliteProcessProductRepositoryV2(env.db);
    const first = productRepo.recordProduct(envelope, run.id, 'development.plan');
    assert.equal(first.replayed, false);

    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteProcessProductRepositoryV2(reopened);

    // ── Assert: exact-by-ProductRef read returns the byte-identical row. ─────
    // getByProductRef keys on the (schemaId, ref, digest) triple — NO epic-scope
    // scan, NO "latest" heuristic (spec §9.11).
    const byRef = resumedRepo.getByProductRef(envelope.productRef);
    assert.ok(byRef, 'resume must find the product by exact ProductRef');
    assert.equal(byRef.reference.hash, envelope.contentHash);
    assert.equal(canonicalJson(byRef.payload), canonicalJson(envelope.bindings));
    assert.equal(byRef.payloadHash, sha256Hex(envelope.bindings));
    assert.equal(byRef.nodeId, 'development.plan');

    // The reconstructed envelope (v2 row ⇒ node_id non-null) is byte-identical.
    assert.ok(byRef.envelope, 'v2 row must reconstruct the envelope');
    assert.equal(byRef.envelope.contentHash, envelope.contentHash);
    assert.equal(byRef.envelope.artifactRef, envelope.artifactRef);

    // ── Assert: re-recording the identical envelope is a benign replay. ──────
    const replayed = resumedRepo.recordProduct(envelope, run.id, 'development.plan');
    assert.equal(replayed.replayed, true, 'identical production replay is idempotent after crash');
    assert.equal(replayed.record.reference.hash, envelope.contentHash);
  } finally {
    env.cleanup();
  }
});

test('boundary 2 (production write): crash BEFORE production INSERT — resume sees no product, fresh record creates it once', () => {
  const env = freshDbEnv('w12a2-prod-before-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });

    const envelope = buildProductionEnvelope({
      schemaId: 'factory.development-task-graph.v1',
      artifactRef: 'task-graph:9102',
      body: { tasks: [] },
    });

    // CRASH before any production write.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteProcessProductRepositoryV2(reopened);

    // No row yet.
    assert.equal(
      resumedRepo.getByProductRef(envelope.productRef),
      null,
      'no product before the boundary is crossed',
    );

    // Fresh record after resume creates the row exactly once.
    const first = resumedRepo.recordProduct(envelope, run.id, 'development.plan');
    assert.equal(first.replayed, false);
  } finally {
    env.cleanup();
  }
});

test('boundary 2 (production write): replay of a DIFFERENT envelope under the same (schemaId, artifactRef) is rejected post-crash', () => {
  const env = freshDbEnv('w12a2-prod-mismatch-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });

    const original = buildProductionEnvelope({
      schemaId: 'factory.development-task-graph.v1',
      artifactRef: 'task-graph:9103',
      body: { tasks: [{ title: 'A' }] },
    });
    let productRepo = new SqliteProcessProductRepositoryV2(env.db);
    productRepo.recordProduct(original, run.id, 'development.plan');

    // CRASH + reopen.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteProcessProductRepositoryV2(reopened);

    // A DIFFERENT body under the same (schemaId, artifactRef) ⇒ different
    // contentHash ⇒ PROCESS_PRODUCT_REPLAY_MISMATCH. The crash cannot let a
    // mutated product overwrite the immutable one.
    const divergent = buildProductionEnvelope({
      schemaId: 'factory.development-task-graph.v1',
      artifactRef: 'task-graph:9103', // SAME ref
      body: { tasks: [{ title: 'B' }] }, // DIFFERENT body ⇒ different hash
    });
    assert.throws(
      () => resumedRepo.recordProduct(divergent, run.id, 'development.plan'),
      /PROCESS_PRODUCT_REPLAY_MISMATCH/,
      'a divergent production under the same identity must be rejected post-crash',
    );

    // The ORIGINAL row is untouched (immutability held through the crash).
    const intact = resumedRepo.getByProductRef(original.productRef);
    assert.ok(intact);
    assert.equal(intact.reference.hash, original.contentHash);
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// Boundary 3 — NODERUN COMPLETE (factory_node_runs)
// ===========================================================================
//
// + transition_cursor. The exact-cursor resume index on
// (process_run_id, node_id, attempt) makes readByExactCursor an equality probe.
// A crash after completeV2 leaves the row 'completed' with the full envelope;
// resume reads it back byte-for-byte and the kernel can settle from it WITHOUT
// reconstructing a mutable frame (spec §0.6.12 — content-addressed, not rebuilt).

test('boundary 3 (NodeRun complete): crash AFTER completeV2 — resume reads exact production envelope + receipt by exact cursor', () => {
  const env = freshDbEnv('w12a2-noderun-after-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });

    const nodeId = 'discovery.propose';
    const attempt = 1;
    const inputEnvelopeHash = sha256Hex({ run: run.id, node: nodeId, attempt });

    let nodeRunRepo = new SqliteNodeRunRepository(env.db);
    const started = nodeRunRepo.startV2({
      processRunId: run.id,
      nodeId,
      nodeKind: 'lm',
      inputEnvelopeHash,
      nodeRef: { nodeId, flowId: 'discovery.flow', flowVersion: '3.0.0' },
      packageRef: { name: 'factory-discovery', version: '3.0.0', digest: 'sha256:pkg-1' },
      predecessorNodeRunIds: [],
      definitionDigest: 'sha256:flow-def-1',
      transitionCursor: `${run.id}/${nodeId}#${attempt}`,
    });

    const production = buildProductionEnvelope({
      schemaId: 'factory.discovery-proposal.v1',
      artifactRef: `proposal:${run.id}`,
      body: { problemStatement: 'x', recommendedOutcome: 'go' },
    });
    const receipt = {
      executorKind: 'generic-flow',
      executionId: `exec-${randomUUID()}`,
      runtimeStatus: 'completed',
      replayed: false,
      adapterData: { board: { taskId: 8801 } },
    };
    const cursor = `${run.id}/${nodeId}#${attempt}`;
    nodeRunRepo.completeV2({
      id: started.id,
      event: 'node.resolved',
      outputRef: production.artifactRef,
      outputSchema: production.schema,
      outputHash: production.contentHash,
      outputBindings: production.bindings,
      executionReceipt: receipt,
      productionEnvelope: production,
      transitionCursor: cursor,
    });

    // CRASH + reopen.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteNodeRunRepository(reopened);

    // ── Assert: readByExactCursor returns the byte-identical v2 row. ─────────
    const resumed = resumedRepo.readByExactCursor(run.id, nodeId, attempt);
    assert.ok(resumed, 'resume must find the NodeRun by exact cursor');
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.transitionCursor, cursor);
    assert.equal(resumed.inputEnvelopeHash, inputEnvelopeHash);

    // The production envelope survived byte-for-byte — NO reconstruction.
    assert.ok(resumed.productionEnvelope, 'production envelope persisted through crash');
    assert.equal(resumed.productionEnvelope.contentHash, production.contentHash);
    assert.equal(
      canonicalJson(resumed.productionEnvelope),
      canonicalJson(production),
      'resumed production envelope byte-identical to pre-crash',
    );

    // The driver-neutral receipt survived too — board vocab still in adapterData.
    assert.ok(resumed.executionReceipt);
    assert.equal(
      canonicalJson(resumed.executionReceipt),
      canonicalJson(receipt),
      'resumed receipt byte-identical to pre-crash',
    );
    assert.deepEqual(resumed.executionReceipt.adapterData.board, { taskId: 8801 });

    // ── Assert: NO fallback path — exact cursor is an equality probe, not a
    //   scan. A nonexistent attempt returns null (no "latest" fallback). ───────
    assert.equal(
      resumedRepo.readByExactCursor(run.id, nodeId, attempt + 99),
      null,
      'nonexistent attempt must return null (no latest-execution fallback)',
    );
  } finally {
    env.cleanup();
  }
});

test('boundary 3 (NodeRun complete): crash AFTER startV2 BEFORE completeV2 — resume reads a running row, completion proceeds exactly once', () => {
  const env = freshDbEnv('w12a2-noderun-mid-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });
    const nodeId = 'discovery.propose';
    const attempt = 1;

    let nodeRunRepo = new SqliteNodeRunRepository(env.db);
    const started = nodeRunRepo.startV2({
      processRunId: run.id,
      nodeId,
      nodeKind: 'lm',
      inputEnvelopeHash: sha256Hex({ run: run.id, node: nodeId }),
      transitionCursor: `${run.id}/${nodeId}#${attempt}`,
    });
    // CRASH after start, before complete — the row is 'running', not yet a
    // durable completion. This is the crash window where the worker was
    // mid-flight.

    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteNodeRunRepository(reopened);

    // Resume reads the running row by exact cursor.
    const resumed = resumedRepo.readByExactCursor(run.id, nodeId, attempt);
    assert.ok(resumed);
    assert.equal(resumed.status, 'running', 'crash after start leaves the row running');
    assert.equal(resumed.productionEnvelope, null, 'no production before completion');

    // The kernel/worker re-issues completeV2 — this is the crash-resume step.
    const production = buildProductionEnvelope({
      schemaId: 'factory.discovery-proposal.v1',
      artifactRef: `proposal:${run.id}`,
      body: { problemStatement: 'y', recommendedOutcome: 'clarify' },
    });
    resumedRepo.completeV2({
      id: resumed.id,
      event: 'node.resolved',
      outputRef: production.artifactRef,
      outputSchema: production.schema,
      outputHash: production.contentHash,
      outputBindings: production.bindings,
      productionEnvelope: production,
      transitionCursor: `${run.id}/${nodeId}#${attempt}`,
    });

    // The row is now completed and the envelope is byte-exact.
    const settled = resumedRepo.readByExactCursor(run.id, nodeId, attempt);
    assert.equal(settled.status, 'completed');
    assert.equal(settled.productionEnvelope.contentHash, production.contentHash);
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// Boundary 4 — PROCESSRUN TRANSITION (factory_process_runs)
// ===========================================================================
//
// The ProcessRun state machine is created → preparing → running → (settling →
// completed) | (paused → ...) | (failed | cancelled). Terminal rows are
// write-once on outcome/output/certificate (enforced by COALESCE guards + an
// explicit equality check). A crash mid-pipeline leaves the row on its last
// committed status; resume re-issues the SAME transition. We prove:
//   - crash after each non-terminal transition: resume reads the exact status,
//     and re-issuing the next transition proceeds.
//   - crash in the settling→completed window: the terminal write-once fields
//     (outcome/output/certificate) survive byte-for-byte; replaying the SAME
//     terminal update is a no-op (write-once equality), while a DIFFERENT
//     terminal value is rejected.

test('boundary 4 (ProcessRun transition): crash after each non-terminal transition — resume reads exact status, transition proceeds', () => {
  const env = freshDbEnv('w12a2-prun-nonterm-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const created = startCreatedProcessRun(repo, { projectId });

    // We deliberately drive one transition at a time, crashing between each,
    // to prove each committed status is the resume point.
    // created → preparing
    repo.update(created.id, { status: 'preparing' });
    let reopened = crashAndReopen(env.dbPath);
    let resumedRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRepo.read(created.id).status, 'preparing');

    // preparing → running
    resumedRepo.update(created.id, { status: 'running' });
    reopened = crashAndReopen(env.dbPath);
    resumedRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRepo.read(created.id).status, 'running');

    // running → settling
    resumedRepo.update(created.id, { status: 'settling' });
    reopened = crashAndReopen(env.dbPath);
    resumedRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRepo.read(created.id).status, 'settling');

    // Idempotent re-issue of the SAME status is a no-op (status === current).
    resumedRepo.update(created.id, { status: 'settling' });
    assert.equal(resumedRepo.read(created.id).status, 'settling');
  } finally {
    env.cleanup();
  }
});

test('boundary 4 (ProcessRun transition): crash in settling→completed window — terminal outcome/output/certificate survive byte-for-byte, replay is a no-op', () => {
  const env = freshDbEnv('w12a2-prun-terminal-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });
    repo.update(run.id, { status: 'settling' });

    // The terminal write: outcome + output + certificate all set atomically.
    const output = {
      schema: 'factory.development-result.v1',
      artifactRef: `result:${run.id}`,
      contentHash: sha256Hex({ delivered: true }),
    };
    const certificate = {
      schema: 'factory.development-certificate.v1',
      certificateRef: `cert:${run.id}`,
      certificateHash: sha256Hex({ verified: true }),
    };
    repo.update(run.id, {
      status: 'completed',
      localOutcome: 'delivered',
      authority: 'kernel-gate',
      output,
      certificate,
    });

    // CRASH in the terminal window — but the UPDATE already committed.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteProcessRunRepository(reopened);
    const resumed = resumedRepo.read(run.id);

    // ── Assert: terminal fields survived byte-for-byte. ─────────────────────
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.localOutcome, 'delivered');
    assert.equal(resumed.authority, 'kernel-gate');
    assert.equal(resumed.completedAt != null, true, 'completed_at stamped on terminal transition');
    assert.deepEqual(
      { schema: resumed.outputSchema, ref: resumed.outputRef, hash: resumed.outputHash },
      { schema: output.schema, ref: output.artifactRef, hash: output.contentHash },
    );
    assert.deepEqual(
      {
        schema: resumed.certificateSchema,
        ref: resumed.certificateRef,
        hash: resumed.certificateHash,
      },
      {
        schema: certificate.schema,
        ref: certificate.certificateRef,
        hash: certificate.certificateHash,
      },
    );

    // ── Assert: replaying the IDENTICAL terminal update is a no-op. ──────────
    // The write-once equality guard treats same-value as allowed.
    resumedRepo.update(run.id, {
      status: 'completed', // same status — no transition
      localOutcome: 'delivered',
      authority: 'kernel-gate',
      output,
      certificate,
    });
    const afterReplay = resumedRepo.read(run.id);
    assert.equal(afterReplay.outputHash, output.contentHash, 'replay does not mutate terminal output');

    // ── Assert: a DIFFERENT terminal value is rejected (write-once). ─────────
    assert.throws(
      () => resumedRepo.update(run.id, {
        output: {
          schema: 'factory.development-result.v1',
          artifactRef: `result:${run.id}`,
          contentHash: sha256Hex({ delivered: false }), // DIFFERENT
        },
      }),
      /cannot change|terminal/i,
      'a divergent terminal output must be rejected (write-once through crash)',
    );
  } finally {
    env.cleanup();
  }
});

test('boundary 4 (ProcessRun transition): crash before terminal write — resume sees settling status, terminal write then commits exactly once', () => {
  const env = freshDbEnv('w12a2-prun-preterm-');
  try {
    const { projectId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId });
    repo.update(run.id, { status: 'settling' });

    // CRASH before the terminal write — row is still 'settling'.
    const reopened = crashAndReopen(env.dbPath);
    const resumedRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRepo.read(run.id).status, 'settling', 'pre-terminal crash leaves row settling');

    // Resume issues the terminal write once.
    const output = {
      schema: 'factory.development-result.v1',
      artifactRef: `result:${run.id}`,
      contentHash: sha256Hex({ delivered: true }),
    };
    resumedRepo.update(run.id, {
      status: 'completed',
      localOutcome: 'delivered',
      authority: 'kernel-gate',
      output,
    });
    const settled = resumedRepo.read(run.id);
    assert.equal(settled.status, 'completed');
    assert.equal(settled.outputHash, output.contentHash);
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// Cross-boundary: a full LM→kernel handoff survives a crash at the LAST
// committed boundary. This is the spec §0.6.12 contract in motion: the worker
// completed (NodeRun complete + production + receipt all durable), then the
// process died before the ProcessRun reached 'completed'. Resume loads the
// EXACT state from the three durable rows and finishes the transition.
// ===========================================================================

test('cross-boundary: worker fully durable (NodeRun complete + production + receipt) then crash before ProcessRun completed — resume finishes from exact state', () => {
  const env = freshDbEnv('w12a2-cross-');
  try {
    const { projectId, epicId } = seedBoard(env.db);
    let repo = new SqliteProcessRunRepository(env.db);
    const run = startRunningProcessRun(repo, { projectId, epicId });

    const executionId = `exec-${randomUUID()}`;
    const workerId = `worker-${randomUUID()}`;
    const nodeId = 'development.plan';
    const moduleRef = run.moduleRefKey;
    const { taskId } = seedManagedFenceRow(env.db, {
      run, nodeId, executionId, workerId,
    });

    // The worker emits ALL THREE durable artifacts WHILE the run is 'running'
    // (the managed-submission live fence requires pr.status='running'). The
    // kernel only later advances running → settling → completed.
    const production = buildProductionEnvelope({
      schemaId: 'factory.development-task-graph.v1',
      artifactRef: `task-graph:${run.id}`,
      body: { tasks: [{ title: 'implement AC-1', skill: 'dev' }] },
    });
    const receipt = {
      executorKind: 'generic-flow',
      executionId,
      runtimeStatus: 'completed',
      replayed: false,
      adapterData: { board: { taskId } },
    };

    // 1. Receipt write (managed submission).
    enterManagedFence({ executionId, taskId });
    let submissionRepo = new SqliteManagedNodeSubmissionRepository(env.db);
    const submitted = submissionRepo.submitForCurrentExecution({
      schema: 'factory.development-task-graph.v1',
      payload: production.bindings,
    });
    leaveManagedFence();

    // 2. Production write.
    let productRepo = new SqliteProcessProductRepositoryV2(env.db);
    productRepo.recordProduct(production, run.id, nodeId);

    // 3. NodeRun complete (dual-write).
    let nodeRunRepo = new SqliteNodeRunRepository(env.db);
    const started = nodeRunRepo.startV2({
      processRunId: run.id,
      nodeId,
      nodeKind: 'lm',
      inputEnvelopeHash: sha256Hex({ run: run.id, node: nodeId }),
      transitionCursor: `${run.id}/${nodeId}#1`,
    });
    nodeRunRepo.completeV2({
      id: started.id,
      event: 'node.resolved',
      outputRef: production.artifactRef,
      outputSchema: production.schema,
      outputHash: production.contentHash,
      outputBindings: production.bindings,
      executionReceipt: receipt,
      productionEnvelope: production,
      transitionCursor: `${run.id}/${nodeId}#1`,
    });

    // The kernel advances running → settling (the worker's durable writes are
    // already committed by this point).
    repo.update(run.id, { status: 'settling' });

    // ── CRASH: the ProcessRun is 'settling' (the terminal transition to
    //   'completed' did not commit). The three durable rows ARE committed. ────
    const reopened = crashAndReopen(env.dbPath);

    // ── Assert: resume loads ALL THREE exactly, then finishes the run. ───────
    const resumedSubmission = new SqliteManagedNodeSubmissionRepository(reopened).readExact({
      processRunId: run.id, moduleRef, nodeId,
      intentId: submitted.record.intentId, taskId, executionId,
    });
    assert.ok(resumedSubmission);
    assert.equal(resumedSubmission.contentHash, submitted.record.contentHash);

    const resumedProduct = new SqliteProcessProductRepositoryV2(reopened)
      .getByProductRef(production.productRef);
    assert.ok(resumedProduct);
    assert.equal(resumedProduct.reference.hash, production.contentHash);

    const resumedNodeRun = new SqliteNodeRunRepository(reopened)
      .readByExactCursor(run.id, nodeId, 1);
    assert.ok(resumedNodeRun);
    assert.equal(resumedNodeRun.status, 'completed');
    assert.equal(resumedNodeRun.productionEnvelope.contentHash, production.contentHash);

    // The ProcessRun is still settling — resume finishes the terminal write.
    const resumedRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRepo.read(run.id).status, 'settling');
    resumedRepo.update(run.id, {
      status: 'completed',
      localOutcome: 'delivered',
      authority: 'kernel-gate',
      output: {
        schema: production.schema,
        artifactRef: production.artifactRef,
        contentHash: production.contentHash,
      },
    });
    const final = resumedRepo.read(run.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.outputHash, production.contentHash);

    // ── Spec §0.6.12 oracle: the production the kernel settles on equals the
    //   production the worker persisted — content-addressed, NOT reconstructed.
    assert.equal(
      resumedNodeRun.productionEnvelope.contentHash,
      resumedProduct.reference.hash,
      'kernel settlement reads the SAME content-addressed production the worker wrote',
    );
  } finally {
    leaveManagedFence();
    env.cleanup();
  }
});

// ===========================================================================
// No-fallback ratchet: a resume MUST NOT fabricate state via epic-scope search,
// latest-execution, or magic binding. We assert the read primitives return null
// for unknown keys rather than inventing a row. (Spec §5: "Assert NO fallback
// paths activate".)
// ===========================================================================

test('no-fallback: resume primitives return null for unknown keys (no epic-scope / latest-execution / magic-binding fabrication)', () => {
  const env = freshDbEnv('w12a2-no-fallback-');
  try {
    const { projectId } = seedBoard(env.db);
    const run = startRunningProcessRun(new SqliteProcessRunRepository(env.db), { projectId });

    const reopened = crashAndReopen(env.dbPath);
    const productRepo = new SqliteProcessProductRepositoryV2(reopened);
    const nodeRunRepo = new SqliteNodeRunRepository(reopened);
    const submissionRepo = new SqliteManagedNodeSubmissionRepository(reopened);

    // Unknown ProductRef ⇒ null (no fuzzy/artifactRef-only fallback that could
    // pull in an unrelated product).
    const unknownRef = {
      schemaId: 'factory.development-task-graph.v1',
      ref: 'task-graph:does-not-exist',
      digest: '0'.repeat(64),
    };
    assert.equal(productRepo.getByProductRef(unknownRef), null);
    // getByArtifactRef with empty string ⇒ null (guard against empty-key scan).
    assert.equal(productRepo.getByArtifactRef(''), null);

    // Unknown NodeRun cursor ⇒ null.
    assert.equal(nodeRunRepo.readByExactCursor(run.id, 'no.such.node', 1), null);

    // Unknown managed submission ⇒ null.
    assert.equal(
      submissionRepo.readExact({
        processRunId: run.id, moduleRef: 'product-development@3.0.0',
        nodeId: 'no.such.node', intentId: 1, taskId: 1, executionId: 'no-such-exec',
      }),
      null,
    );

    // Unknown ProcessRun id ⇒ null (no row invention). Rebuild the repo on the
    // reopened handle — the pre-crash repo's connection is closed.
    const resumedRunRepo = new SqliteProcessRunRepository(reopened);
    assert.equal(resumedRunRepo.read(999999999), null);
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// Helper used only by the non-terminal ProcessRun transition test: start a run
// and leave it in 'created' (the legal resume starting point).
// ===========================================================================
/**
 * Start a ProcessRun and return it in status='created' (no transitions driven).
 *
 * @param {SqliteProcessRunRepository} repo
 * @param {{ projectId: number }} opts
 */
function startCreatedProcessRun(repo, opts) {
  const payload = { idea: 'w12-a2 transition-probe', seed: randomUUID() };
  const { record } = repo.start({
    moduleRef: { name: 'product-development', version: '3.0.0' },
    input: { schema: 'factory.development-case.v1', payload, contentHash: sha256Hex(payload) },
    executorKind: 'generic-flow',
    projectedStage: 'development',
    installationId: null,
    packageDigest: null,
    invocationContext: {
      projectId: opts.projectId,
      epicId: null,
      initiatedBy: 'w12-a2-hardening',
      idempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return record;
}
