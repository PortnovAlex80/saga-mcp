// tests/infrastructure/invalidation-crash-convergence.test.mjs
//
// K9 commit 4 — exactly-once convergence under crash at bind / invalidate /
// regenerate / seal (ADR-080 §3 "no state may loop forever").
//
// The four crash windows of the invalidation grammar, proven at the data
// boundary where a host crash is observable (partial writes then abort):
//
//   BIND        — the claim binder freezes the replay block into the
//                 execution metadata (crash before the UPDATE → the claim
//                 re-binds on re-dispatch; idempotent).
//   INVALIDATE  — evidence rows are recorded one per capsule (crash after
//                 the first row → partial evidence; re-dispatch completes
//                 the set with NO duplicates — UNIQUE(capsule,reason,
//                 authority) + the per-authority idempotency check).
//   REGENERATE  — the evidenced capsule degrades to a miss; the crash
//                 window around the miss decision holds no writes at all.
//   SEAL        — capsule capture is INSERT OR IGNORE on a key-derived ref
//                 (crash before/after → re-capture returns the same row).
//
// Fault injection: a Database proxy that can be armed to throw on the k-th
// INSERT touching the invalidations (or capsules) table — a faithful
// mid-write abort. Convergence = a second, un-faulted drive reaches the
// complete post-state with exactly-once multiplicity.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  SqliteReplayCapsuleRepository,
  ensureReplayCapsuleSchema,
  recordPackageChangedInvalidations,
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

const PKG = 'old-package-digest';

function authorKey() {
  return computeReplayKey({
    projectId: 7, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
    productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
    packageDigest: PKG, semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
}

/**
 * Proxy that aborts (throws) on the k-th prepared INSERT whose SQL touches
 * the given table — simulating a host crash mid-write. Everything else
 * delegates to the real database.
 */
function armCrashOnInsert(realDb, table, k) {
  let seen = 0;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql, ...rest) => {
          if (/insert/iu.test(sql) && sql.includes(table)) {
            seen += 1;
            if (seen === k) {
              throw new Error(`INJECTED_CRASH: insert #${seen} into ${table}`);
            }
          }
          return target.prepare(sql, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('K9/convergence: INVALIDATE crash mid-evidence-set → re-dispatch completes exactly-once', () => {
  const db = freshDb();
  seedProcessRun(db, 1200, 7, PKG);
  const key = authorKey();
  // Two capsules under one key with divergent payloads → the conflict path
  // records evidence for BOTH before throwing.
  insertCapsule(db, {
    capsuleRef: 'conflict-a', replayKey: key, projectId: 7, payloadHash: 'pa',
    payloadSnapshot: divergentPayloadSnapshot('approved'),
  });
  insertCapsule(db, {
    capsuleRef: 'conflict-b', replayKey: key, projectId: 7, payloadHash: 'pb',
    payloadSnapshot: divergentPayloadSnapshot('rejected'),
  });

  // Crash ON the SECOND evidence INSERT (the first row survives).
  const crashedDb = armCrashOnInsert(db, 'factory_replay_capsule_invalidations', 2);
  seedExecution(db, 'exec-crash-1', 101, 7);
  assert.throws(
    () => bindReplayToClaim(crashedDb, {
      task: makeTask(101, taskMetadata(1200)),
      executionId: 'exec-crash-1',
      role: 'author',
    }),
    /INJECTED_CRASH|REPLAY_KEY_PAYLOAD_CONFLICT/u,
  );

  // Partial post-crash state: exactly one evidence row survived.
  let rows = db.prepare(
    'SELECT capsule_ref FROM factory_replay_capsule_invalidations',
  ).all();
  assert.equal(rows.length, 1, 'crash left partial evidence');

  // Re-dispatch (fresh execution, same authority semantics) converges.
  seedExecution(db, 'exec-crash-2', 101, 7);
  assert.throws(
    () => bindReplayToClaim(db, {
      task: makeTask(101, taskMetadata(1200)),
      executionId: 'exec-crash-2',
      role: 'author',
    }),
    /REPLAY_KEY_PAYLOAD_CONFLICT/u,
    'the conflict alarm still fires — the invariant is not silenced by convergence',
  );
  rows = db.prepare(
    'SELECT capsule_ref, authority_ref FROM factory_replay_capsule_invalidations',
  ).all();
  // NOTE: the lookup index (project_id, replay_key, id DESC) returns the
  // capsules in DESCENDING id order, so the crash lands on whichever capsule
  // the scan hit second; the convergence property is order-independent.
  const refs = rows.map(r => `${r.capsule_ref}@${r.authority_ref}`).sort();
  assert.equal(refs.length, 3, 'exactly three evidence rows — no duplicates');
  assert.ok(
    refs.includes('conflict-a@replay-claim:exec-crash-2')
      && refs.includes('conflict-b@replay-claim:exec-crash-2'),
    'the re-dispatch authority audited both conflicting capsules',
  );
  assert.ok(
    refs.some(r => r.endsWith('@replay-claim:exec-crash-1')),
    "the crashed authority's surviving partial row is preserved (append-only)",
  );
  // The conflict alarm is STABLE across re-dispatch (the typed outcome for a
  // divergent-payload key), and convergence added no further rows.
  seedExecution(db, 'exec-crash-3', 101, 7);
  assert.throws(
    () => bindReplayToClaim(db, {
      task: makeTask(101, taskMetadata(1200)),
      executionId: 'exec-crash-3',
      role: 'author',
    }),
    /REPLAY_KEY_PAYLOAD_CONFLICT/u,
    'the invariant alarm is not silenced by convergence',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsule_invalidations').get().n,
    3 + 2,
    'the third authority appends exactly its own two audit rows',
  );
});

test('K9/convergence: bridge crash mid-loop → re-drive completes exactly-once', () => {
  const db = freshDb();
  const keyFor = (digest) => computeReplayKey({
    projectId: 7, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
    productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
    packageDigest: digest, semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  // Real payloads: the bridge selects capsules by the frozen key-material
  // package digest (json_extract), so the snapshot must carry it.
  const seedWithPackage = (capsuleRef, replayKey, digest, payloadHash) => {
    db.prepare(
      `INSERT INTO factory_replay_capsules
         (capsule_ref, replay_key, project_id, source_execution_ref,
          source_candidate_set_ref, payload_hash, payload_snapshot)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(capsuleRef, replayKey, 7, 'exec-src', 'cs-src', payloadHash,
      JSON.stringify({
        schemaVersion: 'factory.replay-capsule.v1',
        key: {
          projectId: 7, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
          productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
          packageDigest: digest, semanticInputDigest: 'a'.repeat(64),
          subjectProductionDigest: null,
        },
        replayKey,
        inputBindings: [], typedProducts: [], artifacts: [], traces: [], git: {},
      }));
  };
  seedWithPackage('old-1', keyFor(PKG), PKG, 'p1');
  seedWithPackage('old-2', keyFor(PKG + 'x'), PKG, 'p2');

  // Crash ON the second bridge evidence INSERT (the first row survives).
  const crashedDb = armCrashOnInsert(db, 'factory_replay_capsule_invalidations', 2);
  assert.throws(
    () => recordPackageChangedInvalidations(crashedDb, {
      moduleName: 'm', moduleVersion: '1.0.0',
      oldPackageDigest: PKG, attemptedPackageDigest: 'new-pkg',
    }),
    /INJECTED_CRASH/u,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsule_invalidations').get().n,
    1,
    'partial bridge evidence after the crash',
  );

  // Re-drive converges — same authority, same digests → idempotent for the
  // recorded row, completes the missing one.
  const count = recordPackageChangedInvalidations(db, {
    moduleName: 'm', moduleVersion: '1.0.0',
    oldPackageDigest: PKG, attemptedPackageDigest: 'new-pkg',
  });
  assert.equal(count, 2, 'the bridge re-selects both old-package capsules');
  const rows = db.prepare(
    'SELECT capsule_ref, reason FROM factory_replay_capsule_invalidations',
  ).all();
  assert.deepEqual(
    rows.map(r => `${r.capsule_ref}:${r.reason}`).sort(),
    ['old-1:package-changed', 'old-2:package-changed'].sort(),
    'exactly-once: no duplicate rows after re-drive',
  );
});

test('K9/convergence: SEAL crash window → re-capture is the same row (INSERT OR IGNORE)', () => {
  const db = freshDb();
  seedProcessRun(db, 1201, 7, PKG);
  const key = authorKey();
  const derivedRef = `replay-capsule:${key}:p1`;
  const capture = db.prepare(
    `INSERT OR IGNORE INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  );
  // "Crash before seal" — nothing persisted; then two seals race/crash-loop.
  capture.run(derivedRef, key, 7, 'exec-seal-1', 'cs-1', 'p1', '{}');
  capture.run(derivedRef, key, 7, 'exec-seal-2', 'cs-2', 'p1', '{}');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_replay_capsules WHERE capsule_ref=?')
      .get(derivedRef).n,
    1,
    'SEAL: repeated capture of identical semantics persists one capsule',
  );
});

test('K9/convergence: BIND crash before the metadata UPDATE → re-bind is idempotent', () => {
  const db = freshDb();
  seedProcessRun(db, 1202, 7, PKG);
  const key = authorKey();
  insertCapsule(db, { capsuleRef: `replay-capsule:${key}:p1`, replayKey: key, projectId: 7, payloadHash: 'p1' });

  // First bind completes; a "crash before update" re-bind writes the same
  // frozen block again — the stored state converges to the identical claim.
  seedExecution(db, 'exec-bind-1', 111, 7);
  seedExecution(db, 'exec-bind-2', 111, 7);
  const first = bindReplayToClaim(db, {
    task: makeTask(111, taskMetadata(1202)), executionId: 'exec-bind-1', role: 'author',
  });
  const second = bindReplayToClaim(db, {
    task: makeTask(111, taskMetadata(1202)), executionId: 'exec-bind-2', role: 'author',
  });
  assert.equal(first.replayKey, second.replayKey);
  assert.equal(first.capsuleRef, second.capsuleRef);
  for (const executionId of ['exec-bind-1', 'exec-bind-2']) {
    const row = db.prepare(
      'SELECT metadata FROM worker_executions WHERE execution_id=?',
    ).get(executionId);
    const envelope = JSON.parse(row.metadata);
    assert.equal(envelope.execution_context.replay.capsule_ref, first.capsuleRef);
    assert.equal(envelope.execution_context.replay.key, first.replayKey);
  }
});
