// tests/factory-contract/third-lifecycle-capsule-scenario.test.mjs
//
// K9 commit 5 — the canonical third-lifecycle scenario (ADR-080, M2 exit
// gate): N, N+1, N+2 lifecycles over one epic/workplace family.
//
//   Lifecycle N    — the work is produced and accepted; a replay capsule is
//                    sealed (key-derived ref, real payload snapshot).
//   Lifecycle N+1  — the same semantic work claims and HITS the N capsule
//                    (exact semantic identity, no re-execution).
//   Lifecycle N+2  — the module package changed under stable logicalIds
//                    (the K5 restart-required verdict): the bridge
//                    invalidates the N capsule as append-only evidence, the
//                    claim degrades to a typed miss, regeneration seals a
//                    NEW capsule under the new package identity, and the
//                    successor binding links old → new.
//
// Termination invariants asserted at every step:
//   - the OLD capsule row and its acceptance history stay byte-identical;
//   - the new capsule is a NEW key (package identity is in the key);
//   - the evidence set is complete, typed, and append-only;
//   - no recency selector participates (all lookups by exact key);
//   - no manual repair is performed anywhere in the scenario.
//
// Two legs (the exit gate requires clean AND upgraded databases):
//   CLEAN    — everything springs into existence from an empty schema.
//   UPGRADED — the capsule rows predate the invalidations table (the K8
//              world): the table is dropped after seeding, then re-created
//              by the ensure upgrade path; the theorem must hold on top of
//              pre-existing accepted history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  SqliteReplayCapsuleRepository,
  ensureReplayCapsuleSchema,
  recordPackageChangedInvalidations,
} from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';

const PROJECT_ID = 7;
const RUN_N = 2001;
const RUN_N1 = 2002;
const RUN_N2 = 2003;
const OLD_PKG = 'pkg-lifecycle-n';
const NEW_PKG = 'pkg-lifecycle-n2';

function keyFor(packageDigest) {
  return computeReplayKey({
    projectId: PROJECT_ID,
    moduleRef: 'm@1.0.0',
    nodeId: 'node-produce',
    productionCellId: 'cell-x',
    workKey: 'work-1',
    role: 'author',
    packageDigest,
    semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
}

function seedProcessRun(db, id, packageDigest) {
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash)
     VALUES (?,?,'m','1.0.0','m@1.0.0',?,'generic-flow','in.v1','{}',
             '0000000000000000000000000000000000000000000000000000000000000000')`,
  ).run(id, PROJECT_ID, `idem-${id}`);
  db.prepare('UPDATE factory_process_runs SET package_digest=? WHERE id=?')
    .run(packageDigest, id);
}

function seedClaimExecution(db, executionId, taskId) {
  // The full schema enforces UNIQUE(worker_id): each claim execution runs
  // under its own worker identity.
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, phase, metadata)
     VALUES (?,?,?,?,?,?, 'm', 'executing', ?)`,
  ).run(executionId, `run-${executionId}`, PROJECT_ID, 1, taskId, `worker-${executionId}`,
    JSON.stringify({
      execution_context: { selected_route: 'route-N' },
      execution_context_hash: 'seed',
    }));
}

function taskMeta(processRunId) {
  return JSON.stringify({
    process_run_id: processRunId,
    process_node_id: 'node-produce',
    process_module_ref: 'm@1.0.0',
    production_cell_id: 'cell-x',
    work_key: 'work-1',
    semantic_input_digest: 'a'.repeat(64),
  });
}

/** Seal a capsule the way the capture path does: key-derived ref + payload. */
function sealCapsule(db, packageDigest, payloadHash) {
  const replayKey = keyFor(packageDigest);
  const capsuleRef = `replay-capsule:${replayKey}:${payloadHash}`;
  db.prepare(
    `INSERT OR IGNORE INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(capsuleRef, replayKey, PROJECT_ID, `exec-n`, `cs-n`, payloadHash,
    JSON.stringify({
      schemaVersion: 'factory.replay-capsule.v1',
      key: {
        projectId: PROJECT_ID, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
        productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
        packageDigest, semanticInputDigest: 'a'.repeat(64),
        subjectProductionDigest: null,
      },
      replayKey,
      inputBindings: [], typedProducts: [], artifacts: [], traces: [], git: {},
    }));
  return capsuleRef;
}

function snapshotRow(db, table, key, value) {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value));
}

/**
 * The canonical N / N+1 / N+2 walk. `mode` selects the leg:
 *   'clean'    — ensure runs before any data exists;
 *   'upgraded' — capsule data is seeded FIRST (the K8 world), the
 *                invalidations table is dropped, and the ensure upgrade
 *                re-creates it on top of pre-existing history.
 */
function runThirdLifecycleScenario(mode) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);

  seedProcessRun(db, RUN_N, OLD_PKG);
  seedProcessRun(db, RUN_N1, OLD_PKG);
  seedProcessRun(db, RUN_N2, NEW_PKG);

  // --- Lifecycle N: produced, accepted, sealed -----------------------------
  ensureReplayCapsuleSchema(db);
  const nCapsuleRef = sealCapsule(db, OLD_PKG, 'payload-n');
  const repo = new SqliteReplayCapsuleRepository(db);

  if (mode === 'upgraded') {
    // Rewind to the K8 world: the invalidations table did not exist when
    // this capsule was sealed. The ensure upgrade must re-create it and
    // the theorem must hold on top of the pre-existing accepted history.
    db.exec('DROP TABLE factory_replay_capsule_invalidations');
    ensureReplayCapsuleSchema(db);
  }

  const nCapsuleBefore = snapshotRow(db, 'factory_replay_capsules', 'capsule_ref', nCapsuleRef);
  assert.ok(nCapsuleBefore, 'lifecycle N sealed a capsule');

  // --- Lifecycle N+1: same semantic work → exact replay hit ----------------
  seedClaimExecution(db, 'exec-n1', 301);
  const n1 = bindReplayToClaim(db, {
    task: { id: 301, epic_id: 1, metadata: taskMeta(RUN_N1), workplace_ref: null },
    executionId: 'exec-n1',
    role: 'author',
  });
  assert.ok(n1, 'the N+1 claim resolves');
  assert.equal(n1.capsuleRef, nCapsuleRef,
    'lifecycle N+1 HITS the exact lifecycle-N capsule — semantic identity, no re-execution');

  // --- Lifecycle N+2: package changed → invalidation + regeneration ---------
  // The restart-required verdict bridges: old-package capsules get evidence.
  const invalidatedCount = recordPackageChangedInvalidations(db, {
    moduleName: 'm',
    moduleVersion: '1.0.0',
    oldPackageDigest: OLD_PKG,
    attemptedPackageDigest: NEW_PKG,
  });
  assert.equal(invalidatedCount, 1, 'the N capsule is selected by its frozen package identity');

  // The claim for the old work now degrades to a typed miss (regeneration
  // through the normal production path).
  seedClaimExecution(db, 'exec-n2-miss', 302);
  const n2Miss = bindReplayToClaim(db, {
    task: { id: 302, epic_id: 1, metadata: taskMeta(RUN_N), workplace_ref: null },
    executionId: 'exec-n2-miss',
    role: 'author',
  });
  assert.equal(n2Miss.capsuleRef, null,
    'the invalidated capsule is a typed miss for the old key');

  // Regeneration: the new package produces new work; new acceptance seals a
  // NEW capsule (new key — the package identity is in the key).
  const n2CapsuleRef = sealCapsule(db, NEW_PKG, 'payload-n2');
  assert.notEqual(n2CapsuleRef, nCapsuleRef, 'regeneration is a NEW capsule');
  repo.recordSuccessor({
    capsuleRef: nCapsuleRef,
    successorCapsuleRef: n2CapsuleRef,
    authorityRef: `module-installation:m@1.0.0:${NEW_PKG}`,
  });

  // The new work claims its own capsule under the new package identity.
  seedClaimExecution(db, 'exec-n2-hit', 303);
  const n2Hit = bindReplayToClaim(db, {
    task: { id: 303, epic_id: 1, metadata: taskMeta(RUN_N2), workplace_ref: null },
    executionId: 'exec-n2-hit',
    role: 'author',
  });
  assert.equal(n2Hit.capsuleRef, n2CapsuleRef,
    'lifecycle N+2 resolves the regenerated capsule for the new package identity');

  // --- Termination invariants ----------------------------------------------
  assert.equal(
    snapshotRow(db, 'factory_replay_capsules', 'capsule_ref', nCapsuleRef),
    nCapsuleBefore,
    'the OLD capsule row is byte-identical after invalidation + regeneration',
  );
  const evidence = repo.readInvalidationsForCapsule(nCapsuleRef);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason, 'package-changed');
  assert.equal(evidence[0].observedDigest, NEW_PKG);
  assert.equal(evidence[0].expectedDigest, OLD_PKG);
  assert.equal(evidence[0].successorCapsuleRef, n2CapsuleRef,
    'the successor binding links old → regenerated');
  return { nCapsuleRef, n2CapsuleRef };
}

test('K9/third-lifecycle: canonical N/N+1/N+2 scenario converges from a CLEAN database', () => {
  const refs = runThirdLifecycleScenario('clean');
  assert.ok(refs.nCapsuleRef && refs.n2CapsuleRef);
});

test('K9/third-lifecycle: canonical N/N+1/N+2 scenario converges from an UPGRADED database', () => {
  const refs = runThirdLifecycleScenario('upgraded');
  assert.ok(refs.nCapsuleRef && refs.n2CapsuleRef);
});
