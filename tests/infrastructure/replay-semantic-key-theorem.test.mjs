// tests/infrastructure/replay-semantic-key-theorem.test.mjs
//
// K8 commit 2 — the N/N-1/N-2 replay capsule theorem (ADR-079).
//
// Three lifecycle histories under one epic. The theorem pins, against the
// REAL binder (bindReplayToClaim) and the REAL key computation
// (computeReplayKey via resolveReplayKeyMaterial):
//
//   A. AUTHOR, same semantic work in all three lifecycles → ONE replay key;
//      recapture is idempotent at the row level (the capsule ref is
//      key-derived, INSERT OR IGNORE) and UNIQUE(replay_key, payload_hash)
//      makes a duplicate row UNPERSISTABLE — newest-wins selection over
//      duplicates is not representable.
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
// Fixtures live in ./lib/replay-binder-fixture.mjs (shared with the
// dispatch-routing tests).

import assert from 'node:assert/strict';
import test from 'node:test';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import {
  freshDb,
  seedProcessRun,
  seedExecution,
  makeTask,
  taskMetadata,
  insertCapsule,
  divergentPayloadSnapshot,
} from './lib/replay-binder-fixture.mjs';

const PKG = 'pkg-digest-stable';

function authorKeyFor() {
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
  // Divergence must be SEMANTIC (2fee5c6e): raw-hash-only divergence over
  // run-scoped identity is a legal alias, not a conflict.
  insertCapsule(db, {
    capsuleRef: 'old', replayKey: key, projectId: 7, payloadHash: 'pay-old',
    payloadSnapshot: divergentPayloadSnapshot('approved'),
  });
  insertCapsule(db, {
    capsuleRef: 'new', replayKey: key, projectId: 7, payloadHash: 'pay-new',
    payloadSnapshot: divergentPayloadSnapshot('rejected'),
  });

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
