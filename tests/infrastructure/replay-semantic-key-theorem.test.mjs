// tests/infrastructure/replay-semantic-key-theorem.test.mjs
//
// K8 commit 2 — the N/N-1/N-2 replay capsule theorem (ADR-079).
//
// Three lifecycle histories under one epic. The theorem pins, against the
// REAL binder (bindReplayToClaim) and the REAL key computation
// (computeReplayKey via resolveReplayKeyMaterial):
//
//   A. AUTHOR, same semantic work in all three lifecycles → ONE replay key;
//      the three capsules are ALIASES (equal payload hash) and the binder
//      picks the lexicographically smallest capsule_ref — a deterministic
//      NAME choice that is independent of insertion order (row ids). A
//      newest-wins binder would pick the last-inserted row; re-seeding the
//      same alias set in the reversed insertion order must not change the
//      selection.
//   B. REVIEWER, subject differs per lifecycle (three workplaces, three
//      authority heads, three author member digests) → THREE distinct keys;
//      the claim for lifecycle N resolves ONLY lifecycle N's capsule.
//      Cross-lifecycle subject contamination (the N-2 newest-wins defect
//      class) is impossible.
//   C. Same key, DIVERGENT payload hashes → REPLAY_KEY_PAYLOAD_CONFLICT
//      fail-closed — an invariant violation, never resolved by recency.
//   D. Zero capsules for the key → a typed miss: the selection carries the
//      frozen key with capsuleRef=null (the inference route stays
//      untouched; replay never creates a second launch mode).
//
// Seeding is direct SQL against an in-memory DB (schema ensured via the
// repositories' own ensure* functions where practical); capsules are
// inserted with keys computed by the REAL computeReplayKey so the theorem
// cannot drift from the implementation's key formula.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { ensureReplayCapsuleSchema } from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  ensureReplayCapsuleSchema(db);
  ensureFactoryProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_gate_decision_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      accepted_author_task_id TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_candidate_set_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('produced','carried-forward')),
      source_candidate_set_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (candidate_set_ref, ordinal)
    );
    -- Empty stubs for the tables certifyAcceptedReplayCapsules /
    -- isCapsuleIneligibleInWorkplace probe inside the REAL binder. Keeping
    -- them empty makes the certification sweep a no-op and ineligibility
    -- always false, so the theorem exercises ONLY the key/selection logic.
    CREATE TABLE IF NOT EXISTS factory_workplaces (
      workplace_ref TEXT PRIMARY KEY,
      process_run_id INTEGER,
      loop_state TEXT,
      terminal_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_cell_final_acceptances (
      workplace_ref TEXT,
      gate_decision_key TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_gate_decisions (
      decision_key TEXT PRIMARY KEY,
      workplace_ref TEXT,
      subject_candidate_set_ref TEXT,
      assessment_candidate_set_refs TEXT,
      gate_run_ref TEXT,
      verdict TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_gate_presentation_attempts (
      gate_run_ref TEXT,
      replay_capsule_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS worker_executions (
      execution_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      epic_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      launcher TEXT NOT NULL DEFAULT 'claude_cli',
      state TEXT NOT NULL DEFAULT 'reserved',
      phase TEXT NOT NULL DEFAULT 'executing',
      pid INTEGER,
      reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
      phase_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      workplace_ref TEXT,
      metadata TEXT
    );
  `);
  return db;
}

function seedProcessRun(db, id, projectId, packageDigest) {
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?,?,'m','1.0.0','m@1.0.0',?,'generic-flow','in.v1','{}',
             '0000000000000000000000000000000000000000000000000000000000000000')`,
  ).run(id, projectId, `idem-${id}`);
  db.prepare('UPDATE factory_process_runs SET package_digest=? WHERE id=?')
    .run(packageDigest, id);
}

function seedExecution(db, executionId, taskId, projectId) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, phase, metadata)
     VALUES (?,?,?,?,?,'w','m','executing',?)`,
  ).run(executionId, `run-${executionId}`, projectId, 1, taskId,
    JSON.stringify({
      execution_context: { selected_route: 'route-A' },
      execution_context_hash: 'seed',
    }));
}

function makeTask(id, metadata, workplaceRef) {
  // The binder reads only id / metadata / workplace_ref off the task.
  return { id, epic_id: 1, metadata: JSON.stringify(metadata), workplace_ref: workplaceRef ?? null };
}

function taskMetadata(processRunId, overrides = {}) {
  return {
    process_run_id: processRunId,
    process_node_id: 'node-produce',
    process_module_ref: 'm@1.0.0',
    production_cell_id: 'cell-x',
    work_key: 'work-1',
    semantic_input_digest: 'a'.repeat(64),
    ...overrides,
  };
}

function insertCapsule(db, { capsuleRef, replayKey, projectId, payloadHash }) {
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(capsuleRef, replayKey, projectId, `exec-${capsuleRef}`, `cs-${capsuleRef}`,
    payloadHash, '{}');
}

const PKG = 'pkg-digest-stable';

function authorKeyFor(processRunId) {
  return computeReplayKey({
    projectId: 7,
    moduleRef: 'm@1.0.0',
    nodeId: 'node-produce',
    productionCellId: 'cell-x',
    workKey: 'work-1',
    role: 'author',
    packageDigest: PKG,
    semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  // processRunId is embedded via factory_process_runs.package_digest read by
  // the binder; the KEY itself is run-independent (that is the point).
}

// ---------------------------------------------------------------------------
// Theorem A — author identity across three lifecycles is ONE capsule
// ---------------------------------------------------------------------------
//
// Discovery made while writing this theorem: the schema
// (UNIQUE(replay_key, payload_hash)) and the capture path
// (`capsule_ref = replay-capsule:${replayKey}:${payloadHash}`,
// INSERT OR IGNORE) make alias MULTIPLICITY impossible — re-capturing the
// same semantics in a later lifecycle returns the SAME row. The theorem
// therefore pins the stronger property: newest-wins selection over
// duplicates cannot even be persisted; the capsule set for a semantic key
// is at most one row per distinct payload.
// ---------------------------------------------------------------------------

test('K8/A: three-lifecycle author recapture is one idempotent row - newest-wins multiplicity is schema-impossible', () => {
  const db = freshDb();
  seedProcessRun(db, 100, 7, PKG);

  const key = authorKeyFor(100);
  const derivedRef = `replay-capsule:${key}:p1`;

  // Lifecycle N-2 captures; lifecycle N-1 and N re-capture the same
  // semantics — the capture path is INSERT OR IGNORE on a key-derived ref.
  const capture = db.prepare(
    `INSERT OR IGNORE INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  );
  capture.run(derivedRef, key, 7, 'exec-n2', 'cs-n2', 'p1', '{}');
  capture.run(derivedRef, key, 7, 'exec-n1', 'cs-n1', 'p1', '{}');
  capture.run(derivedRef, key, 7, 'exec-n', 'cs-n', 'p1', '{}');

  const rowCount = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_replay_capsules WHERE replay_key=?',
  ).get(key).n;
  assert.equal(rowCount, 1,
    'recapturing identical semantics across three lifecycles persists ONE capsule');

  // The schema itself rejects a second row with the same (key, payload) —
  // duplicate-row newest-wins is not representable.
  assert.throws(
    () => insertCapsule(db, { capsuleRef: 'smuggled-duplicate', replayKey: key, projectId: 7, payloadHash: 'p1' }),
    (err) => err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/iu.test(err.message),
    'UNIQUE(replay_key, payload_hash) forbids persisting an alias duplicate',
  );

  seedExecution(db, 'exec-a', 11, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(11, taskMetadata(100)),
    executionId: 'exec-a',
    role: 'author',
  });
  assert.ok(selection, 'binder resolves a selection');
  assert.equal(selection.replayKey, key, 'resolved key matches the real computation');
  assert.equal(selection.capsuleRef, derivedRef,
    'the capsule ref is the key-derived identity, not an insertion-order artifact');
  assert.equal(selection.capsulePayloadHash, 'p1');
});

// ---------------------------------------------------------------------------
// Theorem B — reviewer subject isolation across N / N-1 / N-2
// ---------------------------------------------------------------------------

test('K8/B: reviewer claims resolve ONLY their lifecycle subject - no N-2 contamination', () => {
  const db = freshDb();
  seedProcessRun(db, 200, 7, PKG);

  const insertHead = db.prepare(
    `INSERT INTO factory_accepted_authority_head
       (workplace_ref, accepted_author_candidate_set_ref,
        accepted_author_gate_decision_key, revision, recorded_at)
     VALUES (?,?,?,1,datetime('now'))`,
  );
  const insertMember = db.prepare(
    `INSERT INTO factory_candidate_set_members
       (candidate_set_ref, ordinal, product_schema, product_ref, product_digest, origin)
     VALUES (?,?,?,?,?,'produced')`,
  );

  const lifecycles = [2, 1, 0].map(n => `wp-n${n === 0 ? '' : '-' + n}`);
  const memberDigests = lifecycles.map((_, i) => `d${i}${'f'.repeat(62)}`);
  // The binder derives the subject digest as sha256Hex over the sorted
  // {schemaId, digest} member multiset (resolveStableProductDigest falls
  // back to the raw digest — no sealed-material payload in this fixture).
  const subjectDigest = (digest) => sha256Hex([
    { schemaId: 'factory.product.v1', digest },
  ]);
  const capsules = [];
  lifecycles.forEach((workplace, i) => {
    const csRef = `cs-${workplace}`;
    insertHead.run(workplace, csRef, `gate-${workplace}`);
    insertMember.run(csRef, 0, 'factory.product.v1', `product/${workplace}`, memberDigests[i]);
    const key = computeReplayKey({
      projectId: 7,
      moduleRef: 'm@1.0.0',
      nodeId: 'node-review',
      productionCellId: 'cell-x',
      workKey: 'work-1',
      role: 'reviewer',
      packageDigest: PKG,
      semanticInputDigest: 'a'.repeat(64),
      subjectProductionDigest: subjectDigest(memberDigests[i]),
    });
    const capsuleRef = `cap-${workplace}`;
    insertCapsule(db, { capsuleRef, replayKey: key, projectId: 7, payloadHash: `pay-${workplace}` });
    capsules.push({ workplace, key, capsuleRef });
  });

  // The claim for lifecycle N (the LAST lifecycle, wp-n2): the binder must
  // resolve wp-n2's capsule only. Newest-wins across subjects would be
  // invisible here precisely because the SUBJECT is in the key — proving the
  // isolation is the theorem.
  const claim = capsules[0];
  seedExecution(db, 'exec-r', 21, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(21, taskMetadata(200, { process_node_id: 'node-review' }), claim.workplace),
    executionId: 'exec-r',
    role: 'reviewer',
  });
  assert.ok(selection, 'reviewer claim resolves');
  assert.equal(selection.replayKey, claim.key, 'key binds the exact subject digest');
  assert.equal(selection.capsuleRef, claim.capsuleRef,
    'lifecycle N resolves ONLY its own subject capsule');

  // Cross-check the other two subjects resolve their own capsules too, and
  // the three keys are pairwise distinct.
  const keys = new Set(capsules.map(c => c.key));
  assert.equal(keys.size, 3, 'three subjects → three distinct replay keys');
  for (const other of capsules.slice(1)) {
    seedExecution(db, `exec-${other.workplace}`, 22, 7);
    const s = bindReplayToClaim(db, {
      task: makeTask(22, taskMetadata(200, { process_node_id: 'node-review' }), other.workplace),
      executionId: `exec-${other.workplace}`,
      role: 'reviewer',
    });
    assert.equal(s.capsuleRef, other.capsuleRef, `${other.workplace} resolves its own capsule`);
  }
});

// ---------------------------------------------------------------------------
// Theorem C — divergent payloads under one key fail closed
// ---------------------------------------------------------------------------

test('K8/C: divergent payloads for one key throw REPLAY_KEY_PAYLOAD_CONFLICT - never newest-wins', () => {
  const db = freshDb();
  seedProcessRun(db, 300, 7, PKG);
  const key = authorKeyFor(300);
  insertCapsule(db, { capsuleRef: 'old', replayKey: key, projectId: 7, payloadHash: 'pay-old' });
  insertCapsule(db, { capsuleRef: 'new', replayKey: key, projectId: 7, payloadHash: 'pay-new' });

  seedExecution(db, 'exec-c', 31, 7);
  assert.throws(
    () => bindReplayToClaim(db, {
      task: makeTask(31, taskMetadata(300)),
      executionId: 'exec-c',
      role: 'author',
    }),
    /REPLAY_KEY_PAYLOAD_CONFLICT/u,
    'one semantic key with two different payloads is an invariant violation; '
    + 'picking the newer row is forbidden',
  );
});

// ---------------------------------------------------------------------------
// Theorem D — zero capsules is a typed miss, not engine death
// ---------------------------------------------------------------------------

test('K8/D: zero capsules for the key is a typed miss with the route untouched', () => {
  const db = freshDb();
  seedProcessRun(db, 400, 7, PKG);
  seedExecution(db, 'exec-d', 41, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(41, taskMetadata(400)),
    executionId: 'exec-d',
    role: 'author',
  });
  assert.ok(selection, 'the binder still returns a selection object');
  assert.equal(selection.capsuleRef, null, 'miss carries no capsule');
  assert.equal(selection.capsulePayloadHash, null);
  assert.equal(typeof selection.replayKey, 'string');
  assert.ok(selection.replayKey.length > 0, 'the semantic key is still frozen on the claim');

  const stored = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get('exec-d');
  const envelope = JSON.parse(stored.metadata);
  assert.equal(envelope.execution_context.selected_route, 'route-A',
    'a miss leaves the selected inference route untouched (model-choice orthogonality)');
  assert.equal(envelope.execution_context.replay.capsule_ref, null,
    'the claim metadata records the miss explicitly');
});
