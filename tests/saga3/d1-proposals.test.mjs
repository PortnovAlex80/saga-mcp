/**
 * D1 — Saga 3 Discovery Edition unit tests.
 *
 * Two layers, both deterministic (no LM, no real worker spawn):
 *   1. validateDiscoveryProposal — the kernel's deterministic structural gate.
 *      This is the FIRST thing the kernel checks; a malformed proposal must be
 *      rejected without any LM call (roadmap §8.D2 ordering, but enforced here
 *      as the D1 floor).
 *   2. proposal_submit handler — the MCP submission boundary. Validates the
 *      full chain: intent exists + kind matches + task is the projected task +
 *      execution fence live + schema version owned by kernel + provenance
 *      captured automatically.
 *
 * These tests build a fresh temp SQLite DB with the saga schema so the handler
 * can read/write saga3_work_intents, saga3_proposals, tasks, worker_executions
 * without touching the real development database.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
// closeDb releases the getDb() singleton's handle so rmSync can delete the
// temp DB file on Windows (better-sqlite3 keeps the file open otherwise).
// getDb is the same singleton the handler uses, so seeding + handler share one
// handle that closeDb() can release cleanly.
const { closeDb, getDb } = await import('../../dist/db.js');

// Pure-domain imports — no DB needed.
const { validateDiscoveryProposal, DISCOVERY_OUTCOMES } = await import(
  '../../dist/saga3/domain/discovery-proposal.js'
);
const {
  DISCOVERY_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} = await import('../../dist/saga3/domain/work-intent.js');
const { DISCOVERY_PROPOSAL_SCHEMA } = await import(
  '../../dist/saga3/domain/discovery-proposal.js'
);
const { buildExecutionContext } = await import('../../dist/saga3/authority/build-execution-context.js');
const { executionContextHash } = await import('../../dist/saga3/domain/execution-context.js');

// ---------------------------------------------------------------------------
// 1. validateDiscoveryProposal — deterministic structural gate.
// ---------------------------------------------------------------------------

function validPayload(overrides = {}) {
  return {
    problem_statement: 'Build a mini 3D CAD for prototyping.',
    observed_context: 'Empty workspace; no prior artifacts.',
    stakeholders_or_actors: ['hobbyist prototypers'],
    assumptions: ['Browser-based delivery is acceptable.'],
    unknowns: ['Whether WebGL is required.'],
    risks: ['Scope creep into full CAD.'],
    candidate_scope: 'A minimal mesh editor with primitive shapes.',
    evidence_refs: ['workspace/README.md'],
    recommended_outcome: 'go',
    rationale: 'Clear idea, bounded scope, one main unknown.',
    ...overrides,
  };
}

test('validateDiscoveryProposal: a well-formed payload is valid', () => {
  const r = validateDiscoveryProposal(validPayload());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateDiscoveryProposal: non-object payload is rejected', () => {
  for (const bad of [null, [], 'string', 42, true]) {
    const r = validateDiscoveryProposal(bad);
    assert.equal(r.valid, false, `payload ${JSON.stringify(bad)} must be invalid`);
    assert.match(r.errors.join(';'), /payload must be a JSON object/);
  }
});

test('validateDiscoveryProposal: every required string field is enforced', () => {
  for (const field of ['problem_statement', 'observed_context', 'candidate_scope', 'rationale']) {
    // missing
    const p1 = validPayload();
    delete p1[field];
    assert.equal(validateDiscoveryProposal(p1).valid, false, `missing ${field} invalid`);
    // empty string
    const p2 = validPayload({ [field]: '   ' });
    const r2 = validateDiscoveryProposal(p2);
    assert.equal(r2.valid, false, `blank ${field} invalid`);
    assert.match(r2.errors.join(';'), new RegExp(`'${field}'`));
    // wrong type
    const p3 = validPayload({ [field]: 5 });
    assert.equal(validateDiscoveryProposal(p3).valid, false, `non-string ${field} invalid`);
  }
});

test('validateDiscoveryProposal: array fields must be arrays of strings', () => {
  for (const field of ['stakeholders_or_actors', 'assumptions', 'unknowns', 'risks', 'evidence_refs']) {
    const p1 = validPayload({ [field]: 'not an array' });
    assert.equal(validateDiscoveryProposal(p1).valid, false, `non-array ${field} invalid`);
    const p2 = validPayload({ [field]: [1, 2] });
    assert.equal(validateDiscoveryProposal(p2).valid, false, `non-string-element ${field} invalid`);
  }
  // Empty arrays are allowed (unknowns=[] is a smell, but structurally valid).
  assert.equal(validateDiscoveryProposal(validPayload({ unknowns: [] })).valid, true);
});

test('validateDiscoveryProposal: recommended_outcome must be one of the six', () => {
  // Every enumerated outcome is accepted.
  for (const outcome of DISCOVERY_OUTCOMES) {
    assert.equal(
      validateDiscoveryProposal(validPayload({ recommended_outcome: outcome })).valid,
      true,
      `outcome '${outcome}' valid`,
    );
  }
  // Anything else is rejected.
  const r = validateDiscoveryProposal(validPayload({ recommended_outcome: 'maybe' }));
  assert.equal(r.valid, false);
  assert.match(r.errors.join(';'), /recommended_outcome/);
  assert.equal(validateDiscoveryProposal(validPayload({ recommended_outcome: 'GO' })).valid, false,
    'recommended_outcome is case-sensitive');
});

// ---------------------------------------------------------------------------
// 2. proposal_submit handler — full submission boundary.
// ---------------------------------------------------------------------------

// Build a temp DB with the saga schema and seed a project/epic/episode/intent/
// task/execution so the handler has a valid fence to check. Uses the saga
// getDb() singleton (not a raw handle) so closeDb() releases the WAL handle
// cleanly — a raw handle would leak and rmSync would EPERM on Windows.
function makeFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-d1-'));
  process.env.DB_PATH = path.join(temp, 'd1.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'REQ-10')`).run();
  db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
  return { temp, dbPath: process.env.DB_PATH };
}

function seedIntentAndTask(db, { intentId = 1, taskId = 100, executionId = 'exec-1', liveExecution = true, workIntentId = 1, model = 'qwen-test', provider = 'lmstudio', effort = 'high', genKey = 'k', workerId = 'w-1' } = {}) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, task_kind, workflow_stage,
        execution_skill, execution_mode, generation_key, metadata)
     VALUES (?, 10, 'Discovery', 'in_progress', 'discovery.work', 'discovery',
        'saga-discovery-worker', 'tracker_only', ?, ?)`,
  ).run(taskId, genKey, JSON.stringify({ work_intent_id: workIntentId }));
  const authorityScope = {
    snapshot_ref: 'episode:10',
    scope: 'discovery',
    allowed_tools: ['proposal_submit', 'worker_done'],
    enforcement: 'runtime',
  };
  db.prepare(
    `INSERT INTO saga3_work_intents
       (id, epic_id, kind, objective, authority_scope, output_schema,
        token_budget, retry_budget, projected_task_id, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'executing')`,
  ).run(intentId, 10, DISCOVERY_INTENT_KIND, 'investigate the idea',
    JSON.stringify(authorityScope), DISCOVERY_WORK_INTENT_SCHEMA, 0, 0, taskId);
  db.prepare(`UPDATE tasks SET current_execution_id=? WHERE id=?`).run(executionId, taskId);
  const workIntent = {
    id: intentId,
    epic_id: 10,
    kind: DISCOVERY_INTENT_KIND,
    objective: 'investigate the idea',
    authority_scope: authorityScope,
    output_schema: DISCOVERY_WORK_INTENT_SCHEMA,
    token_budget: 0,
    retry_budget: 0,
    projected_task_id: taskId,
    status: 'executing',
    created_at: '2026-07-24T00:00:00.000Z',
  };
  const execution_context = buildExecutionContext({
    modelRoute: { model, provider, effort },
    workIntent,
    capturedAt: '2026-07-24T00:00:00.000Z',
  });
  const metadata = JSON.stringify({
    execution_context,
    execution_context_hash: executionContextHash(execution_context),
  });
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase, metadata)
     VALUES (?, 'run-1', 1, 10, ?, ?, 'm-1', ?, 'executing', ?)`,
  ).run(executionId, taskId, workerId, liveExecution ? 'running' : 'exited', metadata);
  return { intentId, taskId, executionId };
}

test('proposal_submit: valid submission records the proposal with provenance from execution snapshot', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb());

    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { Saga3ProposalRepository } = await import('../../dist/saga3/persistence/saga3-proposal-repository.js');
    const repo = new Saga3ProposalRepository();
    const { handlers } = createSaga3ProposalHandlers();

    const result = handlers.proposal_submit({
      intent_id: intentId, task_id: taskId, execution_id: executionId,
      kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
      payload: validPayload(),
    });
    assert.equal(typeof result.proposal_id, 'number');
    assert.match(result.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(result.status, 'submitted');
    assert.equal(result.replayed, false);

    // Provenance is read from the launch-time execution snapshot
    // (model=qwen-test, captured at claim), NOT from current episode config.
    const rec = repo.readLatestProposalForIntent(intentId);
    assert.equal(rec.provenance.model, 'qwen-test');
    assert.equal(rec.provenance.provider, 'lmstudio');
    assert.equal(rec.provenance.worker_id, 'w-1');
    assert.equal(rec.provenance.execution_id, executionId);
    assert.equal(rec.payload.recommended_outcome, 'go');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: exact replay returns the same proposal id with replayed=true (idempotent)', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb());
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();

    const payload = validPayload();
    const first = handlers.proposal_submit({
      intent_id: intentId, task_id: taskId, execution_id: executionId,
      kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA, payload,
    });
    // Exact same submission → same proposal_id, replayed=true, no duplicate.
    const replay = handlers.proposal_submit({
      intent_id: intentId, task_id: taskId, execution_id: executionId,
      kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA, payload,
    });
    assert.equal(replay.proposal_id, first.proposal_id);
    assert.equal(replay.content_hash, first.content_hash);
    assert.equal(replay.replayed, true);

    const { Saga3ProposalRepository } = await import('../../dist/saga3/persistence/saga3-proposal-repository.js');
    const repo = new Saga3ProposalRepository();
    const count = getDb().prepare('SELECT COUNT(*) c FROM saga3_proposals WHERE intent_id=?').get(intentId).c;
    assert.equal(count, 1, 'replay must not create a duplicate proposal row');
    // Replay must also be idempotent for the visibility side-effect: exactly one
    // saga3-kernel comment, not one per submission (review P1).
    const commentCount = getDb().prepare(
      "SELECT COUNT(*) c FROM comments WHERE task_id=? AND author='saga3-kernel'",
    ).get(taskId).c;
    assert.equal(commentCount, 1, 'replay must not create a duplicate visibility comment');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: fence rejects execution that owns a different task', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    // Two tasks, two executions — worker tries to submit against task A while
    // holding execution for task B.
    const seed = getDb();
    seedIntentAndTask(seed, { taskId: 100, executionId: 'exec-A' });
    seedIntentAndTask(seed, { intentId: 2, taskId: 200, executionId: 'exec-B', workIntentId: 2, genKey: 'k2', workerId: 'w-2' });
    // Make intent 2 point at task 200. Then forge task 200's fence to claim it
    // holds exec-A (so the task-fence check passes), while exec-A actually owns
    // task 100 — the execution-ownership check must catch this.
    seed.prepare('UPDATE saga3_work_intents SET projected_task_id=200 WHERE id=2').run();
    seed.prepare('UPDATE tasks SET current_execution_id=? WHERE id=?').run('exec-A', 200);
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: 2, task_id: 200, execution_id: 'exec-A',
        kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA, payload: validPayload(),
      }),
      /owns task 100, not 200/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: fence rejects cancel_requested execution state', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const seed = getDb();
    const { intentId, taskId, executionId } = seedIntentAndTask(seed, { liveExecution: false });
    // Override to cancel_requested specifically (not a plain terminal state).
    seed.prepare("UPDATE worker_executions SET state='cancel_requested' WHERE execution_id=?").run(executionId);
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: taskId, execution_id: executionId,
        kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA, payload: validPayload(),
      }),
      /not live.*cancel_requested/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: wrong kind is rejected', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb());
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: taskId, execution_id: executionId,
        kind: 'formalization', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
        payload: validPayload(),
      }),
      /unsupported kind 'formalization'/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: schema version mismatch is rejected (kernel owns the contract)', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb());
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: taskId, execution_id: executionId,
        kind: 'discovery', schema_version: 'saga3.discovery-proposal.v2',
        payload: validPayload(),
      }),
      /schema_version mismatch/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: execution fence failure is rejected', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId } = seedIntentAndTask(getDb(), { executionId: 'exec-1' });
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    // Worker claims a DIFFERENT execution id than the task's fence.
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: taskId, execution_id: 'exec-IMPOSTOR',
        kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
        payload: validPayload(),
      }),
      /execution fence failed/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: dead execution is rejected', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb(), { liveExecution: false });
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: taskId, execution_id: executionId,
        kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
        payload: validPayload(),
      }),
      /not live/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit: task not projected from the intent is rejected', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, executionId } = seedIntentAndTask(getDb(), { taskId: 100 });
    // A second, unrelated task with its own execution.
    dbInsertTask(getDb(), 200, 'exec-2');
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    assert.throws(
      () => handlers.proposal_submit({
        intent_id: intentId, task_id: 200, execution_id: 'exec-2',
        kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
        payload: validPayload(),
      }),
      /not the projected task/,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('proposal_submit D2: malformed semantic payload is preserved and requests normalization', async () => {
  const { temp, dbPath } = makeFixture();
  try {
    const { intentId, taskId, executionId } = seedIntentAndTask(getDb());
    const { createSaga3ProposalHandlers } = await import('../../dist/tools/saga3-proposals.js');
    const { handlers } = createSaga3ProposalHandlers();
    const result = handlers.proposal_submit({
      intent_id: intentId, task_id: taskId, execution_id: executionId,
      kind: 'discovery', schema_version: DISCOVERY_PROPOSAL_SCHEMA,
      payload: { problem_statement: 'x' }, // valid JSON, missing semantic fields
    });
    assert.equal(result.status, 'normalization_required');
    assert.equal(result.proposal_id, null, 'normalizer has not produced a canonical Proposal yet');
    assert.equal(typeof result.raw_submission_id, 'number');
    assert.ok(result.validation_errors.length > 0);
    const raw = getDb().prepare('SELECT status, raw_payload FROM saga3_raw_submissions WHERE id=?')
      .get(result.raw_submission_id);
    assert.equal(raw.status, 'normalization_required');
    assert.equal(JSON.parse(raw.raw_payload).problem_statement, 'x');
    const proposalCount = getDb().prepare('SELECT COUNT(*) c FROM saga3_proposals WHERE intent_id=?')
      .get(intentId).c;
    assert.equal(proposalCount, 0, 'raw ambiguous response must not become a canonical Proposal');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

// helper: insert an unrelated task + execution
function dbInsertTask(db, taskId, executionId) {
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, task_kind, workflow_stage,
        execution_skill, execution_mode, current_execution_id)
     VALUES (?, 10, 'Other', 'in_progress', 'other', 'discovery', 'x', 'tracker_only', ?)`,
  ).run(taskId, executionId);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase)
     VALUES (?, 'run-2', 1, 10, ?, 'w-2', 'm-1', 'running', 'executing')`,
  ).run(executionId, taskId);
}
