// tests/infrastructure/capsule-invalidation-evidence.test.mjs
//
// K9 commit 2 — immutable invalidation evidence (ADR-080 §1–2).
//
//   1. The K8 payload-conflict fail-closed path now PERSISTS EVIDENCE FIRST:
//      one append-only row per conflicting capsule, cross-binding both
//      divergent payload hashes, attributed to the observing claim (and the
//      owning lifecycle via the stage-run ownership chain).
//   2. Evidence recording is idempotent per (capsule, reason, authority);
//      a drifted re-observation under the same authority fails closed
//      (CAPSULE_INVALIDATION_EVIDENCE_MISMATCH); a different authority
//      appends its own audit row.
//   3. Derived invalidity: ANY evidence row degrades the capsule to a typed
//      miss on every claim path (binder + repository resolution), with the
//      semantic key still frozen.
//   4. Successor binding is single-shot: the evidence row gains exactly one
//      successor_capsule_ref; a second different successor fails closed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  SqliteReplayCapsuleRepository,
} from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
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

function authorKey() {
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

test('K9/evidence: payload-conflict persists one append-only row per conflicting capsule before throwing', () => {
  const db = freshDb();
  seedProcessRun(db, 1000, 7, PKG);
  // Owning lifecycle for attribution (ownership chain via stage runs).
  db.prepare(
    `INSERT INTO factory_stage_runs (id, lifecycle_run_id, process_run_id, stage_id, status)
     VALUES (1, 25, 1000, 'formalization', 'completed')`,
  ).run();

  const key = authorKey();
  insertCapsule(db, {
    capsuleRef: 'cap-left', replayKey: key, projectId: 7, payloadHash: 'hash-left',
    payloadSnapshot: divergentPayloadSnapshot('approved'),
  });
  insertCapsule(db, {
    capsuleRef: 'cap-right', replayKey: key, projectId: 7, payloadHash: 'hash-right',
    payloadSnapshot: divergentPayloadSnapshot('rejected'),
  });

  seedExecution(db, 'exec-conflict', 81, 7);
  assert.throws(
    () => bindReplayToClaim(db, {
      task: makeTask(81, taskMetadata(1000)),
      executionId: 'exec-conflict',
      role: 'author',
    }),
    /REPLAY_KEY_PAYLOAD_CONFLICT/u,
    'the invariant violation remains a fail-closed alarm',
  );

  const repo = new SqliteReplayCapsuleRepository(db);
  const left = repo.readInvalidationsForCapsule('cap-left');
  const right = repo.readInvalidationsForCapsule('cap-right');
  assert.equal(left.length, 1, 'exactly one evidence row for the left capsule');
  assert.equal(right.length, 1, 'exactly one evidence row for the right capsule');
  assert.equal(left[0].reason, 'payload-conflict');
  assert.equal(left[0].observedDigest, 'hash-left');
  assert.equal(left[0].expectedDigest, 'hash-right', 'the divergent hashes are cross-bound');
  assert.equal(right[0].observedDigest, 'hash-right');
  assert.equal(right[0].expectedDigest, 'hash-left');
  assert.equal(left[0].lifecycleRunId, 25,
    'the evidence attributes the owning lifecycle via the ownership chain');
  assert.equal(left[0].authorityRef, 'replay-claim:exec-conflict');

  // The capsule rows themselves are untouched — evidence is append-only.
  const capsules = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_replay_capsules',
  ).get();
  assert.equal(capsules.n, 2);
});

test('K9/evidence: recording is idempotent per authority and fails closed on drift', () => {
  const db = freshDb();
  seedProcessRun(db, 1001, 7, PKG);
  const key = authorKey();
  const ref = `replay-capsule:${key}:p1`;
  insertCapsule(db, { capsuleRef: ref, replayKey: key, projectId: 7, payloadHash: 'p1' });
  const repo = new SqliteReplayCapsuleRepository(db);

  repo.recordInvalidation({
    capsuleRef: ref,
    reason: 'package-changed',
    observedDigest: 'pkg-new',
    expectedDigest: PKG,
    lifecycleRunId: 30,
    authorityRef: 'production-resume:1001',
  });
  // Same authority, same observation → idempotent no-op.
  repo.recordInvalidation({
    capsuleRef: ref,
    reason: 'package-changed',
    observedDigest: 'pkg-new',
    expectedDigest: PKG,
    lifecycleRunId: 30,
    authorityRef: 'production-resume:1001',
  });
  assert.equal(repo.readInvalidationsForCapsule(ref).length, 1);

  // Same authority, drifted observation → fail closed.
  assert.throws(
    () => repo.recordInvalidation({
      capsuleRef: ref,
      reason: 'package-changed',
      observedDigest: 'pkg-drifted',
      expectedDigest: PKG,
      authorityRef: 'production-resume:1001',
    }),
    /CAPSULE_INVALIDATION_EVIDENCE_MISMATCH/u,
  );

  // Different authority → its own audit row.
  repo.recordInvalidation({
    capsuleRef: ref,
    reason: 'package-changed',
    observedDigest: 'pkg-new',
    expectedDigest: PKG,
    authorityRef: 'operator:manual-audit',
  });
  assert.equal(repo.readInvalidationsForCapsule(ref).length, 2);
});

test('K9/evidence: any evidence row degrades the capsule to a typed miss on both claim paths', () => {
  const db = freshDb();
  seedProcessRun(db, 1002, 7, PKG);
  const key = authorKey();
  const ref = `replay-capsule:${key}:p1`;
  insertCapsule(db, { capsuleRef: ref, replayKey: key, projectId: 7, payloadHash: 'p1' });
  const repo = new SqliteReplayCapsuleRepository(db);
  repo.recordInvalidation({
    capsuleRef: ref,
    reason: 'package-changed',
    observedDigest: 'pkg-new',
    expectedDigest: PKG,
    authorityRef: 'production-resume:1002',
  });

  seedExecution(db, 'exec-after-invalidation', 82, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(82, taskMetadata(1002)),
    executionId: 'exec-after-invalidation',
    role: 'author',
  });
  assert.ok(selection, 'the claim still resolves');
  assert.equal(selection.capsuleRef, null,
    'an evidenced capsule is a typed miss — regeneration is a dispatch decision');
  assert.equal(selection.replayKey, key, 'the semantic key stays frozen');

  const repoResolution = repo.resolveClaim(
    makeTask(82, taskMetadata(1002)),
    'author',
  );
  assert.equal(repoResolution.capsuleRef, null,
    'the repository claim path applies the same derived invalidity');

  assert.equal(repo.hasInvalidation(ref), true);
});

test('K9/evidence: successor binding is single-shot and exact', () => {
  const db = freshDb();
  seedProcessRun(db, 1003, 7, PKG);
  const key = authorKey();
  const ref = `replay-capsule:${key}:p1`;
  insertCapsule(db, { capsuleRef: ref, replayKey: key, projectId: 7, payloadHash: 'p1' });
  const repo = new SqliteReplayCapsuleRepository(db);
  repo.recordInvalidation({
    capsuleRef: ref,
    reason: 'package-changed',
    observedDigest: 'pkg-new',
    expectedDigest: PKG,
    authorityRef: 'production-resume:1003',
  });

  const successorRef = `replay-capsule:${key}:p2`;
  repo.recordSuccessor({
    capsuleRef: ref,
    successorCapsuleRef: successorRef,
    authorityRef: 'production-resume:1003',
  });
  assert.equal(repo.readInvalidationsForCapsule(ref)[0].successorCapsuleRef, successorRef);

  // A second, DIFFERENT successor under the same authority fails closed.
  assert.throws(
    () => repo.recordSuccessor({
      capsuleRef: ref,
      successorCapsuleRef: `replay-capsule:${key}:p3`,
      authorityRef: 'production-resume:1003',
    }),
    /CAPSULE_INVALIDATION_SUCCESSOR_BIND_FAILED/u,
    'regeneration authority binds exactly one successor',
  );
});

// STAGE-23 (2026-08-24) — the double-redevelop loop kill: the conflict
// handler's promise "the next execution resolves to an ordinary miss" was
// broken by the selection reading ALL capsule rows regardless of persisted
// evidence — two divergent capsules under one key re-conflicted forever
// (live: child-3 plan desk poisoned on every cycle). Corruption-class
// evidence must exclude the capsule from the SELECTION.
test('K9/loop-kill: after a payload-conflict, the NEXT bind resolves as an ordinary miss (no eternal loop)', t => {
  const journalDir = mkdtempSync(join(tmpdir(), 'saga-replay-loop-kill-'));
  const journalPath = join(journalDir, 'factory-run-journal.jsonl');
  const priorJournal = process.env.SAGA_RUN_JOURNAL;
  process.env.SAGA_RUN_JOURNAL = journalPath;
  const db = freshDb();
  t.after(() => {
    db.close();
    if (priorJournal === undefined) delete process.env.SAGA_RUN_JOURNAL;
    else process.env.SAGA_RUN_JOURNAL = priorJournal;
    rmSync(journalDir, { recursive: true, force: true });
  });
  seedProcessRun(db, 1000, 7, PKG);
  db.prepare(
    `INSERT INTO factory_stage_runs (id, lifecycle_run_id, process_run_id, stage_id, status)
     VALUES (1, 25, 1000, 'formalization', 'completed')`,
  ).run();
  const key = authorKey();
  insertCapsule(db, {
    capsuleRef: 'cap-left', replayKey: key, projectId: 7, payloadHash: 'hash-left',
    payloadSnapshot: divergentPayloadSnapshot('approved'),
  });
  insertCapsule(db, {
    capsuleRef: 'cap-right', replayKey: key, projectId: 7, payloadHash: 'hash-right',
    payloadSnapshot: divergentPayloadSnapshot('rejected'),
  });
  seedExecution(db, 'exec-conflict', 81, 7);
  assert.throws(
    () => bindReplayToClaim(db, {
      task: makeTask(81, taskMetadata(1000)),
      executionId: 'exec-conflict',
      role: 'author',
    }),
    /REPLAY_KEY_PAYLOAD_CONFLICT/u,
    'first bind on divergent capsules fails closed and persists evidence',
  );
  // The second bind on a FRESH execution must see NO selectable capsule
  // (both carry corruption-class evidence) and resolve as an ordinary miss —
  // before the fix this threw the same conflict forever (live child-3 loop).
  seedExecution(db, 'exec-miss', 81, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(81, taskMetadata(1000)),
    executionId: 'exec-miss',
    role: 'author',
  });
  assert.ok(selection, 'the post-conflict claim resolves');
  assert.equal(selection.capsuleRef, null,
    'the post-conflict bind is an exact ordinary miss, never a replay hit');

  const execution = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get('exec-miss');
  const replay = JSON.parse(execution.metadata).execution_context.replay;
  assert.equal(replay.invalidation.capsuleRef, 'cap-left',
    'the deterministic first poisoned alias remains the typed route subject');
  assert.equal(replay.invalidation.reason, 'payload-conflict');
  assert.equal(replay.invalidation.classification, 'integrity-suspect');

  const journal = readFileSync(journalPath, 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const escalation = journal.find(event =>
    event.kind === 'replay.invalidation.integrity-suspect'
    && event.data?.capsule_ref === 'cap-left');
  assert.ok(escalation, 'the exact poisoned capsule is journalled');
  assert.equal(escalation.data.reason, 'payload-conflict');
  assert.equal(escalation.data.route, 'typed-miss+operator-escalation');

});
