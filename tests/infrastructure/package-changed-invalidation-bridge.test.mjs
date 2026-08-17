// tests/infrastructure/package-changed-invalidation-bridge.test.mjs
//
// K9 commit 3 — regeneration through the normal production path
// (ADR-080 §2–4).
//
// When a module's handler implementations change under stable logicalIds
// (the K5 restart-required verdict), production-install must invalidate —
// as append-only evidence — every capsule sealed under the OLD package.
// The old capsule and its acceptance history stay immutable; the next
// claim for the work resolves a typed miss and takes the normal selected
// route: THAT is regeneration. There is no capsule-mutation lane.
//
//   1. The bridge selects capsules by the payload's frozen key material
//      package digest (json_extract), records package-changed evidence,
//      and the evidenced capsule degrades to a miss on the claim path.
//   2. Re-running the bridge for the SAME attempted digest is idempotent;
//      a LATER change (different attempted digest) appends its own
//      evidence rows instead of colliding.
//   3. SOURCE-PINNED: production-install's restart-required branch calls
//      the bridge BEFORE refusing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindReplayToClaim } from '../../dist/infrastructure/replay/replay-claim-binder.js';
import { computeReplayKey } from '../../dist/infrastructure/replay/replay-key-material.js';
import {
  SqliteReplayCapsuleRepository,
  recordPackageChangedInvalidations,
} from '../../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';
import {
  freshDb,
  seedProcessRun,
  seedExecution,
  makeTask,
  taskMetadata,
} from './lib/replay-binder-fixture.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const OLD_PKG = 'old-package-digest';
const NEW_PKG = 'new-package-digest';

function seedCapsuleWithPackage(db, replayKey, packageDigest, payloadHash) {
  const capsuleRef = `replay-capsule:${replayKey}:${payloadHash}`;
  const payload = {
    schemaVersion: 'factory.replay-capsule.v1',
    key: {
      projectId: 7,
      moduleRef: 'm@1.0.0',
      nodeId: 'node-produce',
      productionCellId: 'cell-x',
      workKey: 'work-1',
      role: 'author',
      packageDigest,
      semanticInputDigest: 'a'.repeat(64),
      subjectProductionDigest: null,
    },
    replayKey,
    inputBindings: [],
    typedProducts: [],
    artifacts: [],
    traces: [],
    git: {},
  };
  db.prepare(
    `INSERT INTO factory_replay_capsules
       (capsule_ref, replay_key, project_id, source_execution_ref,
        source_candidate_set_ref, payload_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(capsuleRef, replayKey, 7, 'exec-src', 'cs-src', payloadHash,
    JSON.stringify(payload));
  return capsuleRef;
}

test('K9/bridge: old-package capsules get package-changed evidence and degrade to a miss', () => {
  const db = freshDb();
  const oldKey = computeReplayKey({
    projectId: 7, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
    productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
    packageDigest: OLD_PKG, semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  const capsuleRef = seedCapsuleWithPackage(db, oldKey, OLD_PKG, 'p1');

  const invalidated = recordPackageChangedInvalidations(db, {
    moduleName: 'm',
    moduleVersion: '1.0.0',
    oldPackageDigest: OLD_PKG,
    attemptedPackageDigest: NEW_PKG,
  });
  assert.equal(invalidated, 1, 'the old-package capsule is selected by its frozen key material');

  const repo = new SqliteReplayCapsuleRepository(db);
  const evidence = repo.readInvalidationsForCapsule(capsuleRef);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason, 'package-changed');
  assert.equal(evidence[0].observedDigest, NEW_PKG);
  assert.equal(evidence[0].expectedDigest, OLD_PKG);
  assert.equal(evidence[0].authorityRef, `module-installation:m@1.0.0:${NEW_PKG}`);

  // Regeneration = normal production: the old run's claim now misses.
  seedProcessRun(db, 1100, 7, OLD_PKG);
  seedExecution(db, 'exec-regen', 91, 7);
  const selection = bindReplayToClaim(db, {
    task: makeTask(91, taskMetadata(1100)),
    executionId: 'exec-regen',
    role: 'author',
  });
  assert.equal(selection.capsuleRef, null,
    'the evidenced capsule degrades to a typed miss — the work regenerates '
    + 'through the normal production path');

  // The capsule row itself is untouched.
  const rows = db.prepare(
    'SELECT payload_hash FROM factory_replay_capsules WHERE capsule_ref=?',
  ).get(capsuleRef);
  assert.equal(rows.payload_hash, 'p1');
});

test('K9/bridge: idempotent per attempted digest; a later change appends', () => {
  const db = freshDb();
  const oldKey = computeReplayKey({
    projectId: 7, moduleRef: 'm@1.0.0', nodeId: 'node-produce',
    productionCellId: 'cell-x', workKey: 'work-1', role: 'author',
    packageDigest: OLD_PKG, semanticInputDigest: 'a'.repeat(64),
    subjectProductionDigest: null,
  });
  const capsuleRef = seedCapsuleWithPackage(db, oldKey, OLD_PKG, 'p1');
  const repo = new SqliteReplayCapsuleRepository(db);

  recordPackageChangedInvalidations(db, {
    moduleName: 'm', moduleVersion: '1.0.0',
    oldPackageDigest: OLD_PKG, attemptedPackageDigest: NEW_PKG,
  });
  recordPackageChangedInvalidations(db, {
    moduleName: 'm', moduleVersion: '1.0.0',
    oldPackageDigest: OLD_PKG, attemptedPackageDigest: NEW_PKG,
  });
  assert.equal(repo.readInvalidationsForCapsule(capsuleRef).length, 1,
    'same attempted digest → idempotent');

  const LATER_PKG = 'later-package-digest';
  recordPackageChangedInvalidations(db, {
    moduleName: 'm', moduleVersion: '1.0.0',
    oldPackageDigest: OLD_PKG, attemptedPackageDigest: LATER_PKG,
  });
  assert.equal(repo.readInvalidationsForCapsule(capsuleRef).length, 2,
    'a later change appends its own evidence row');
});

test('K9/bridge: production-install records evidence BEFORE refusing restart-required', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'src', 'process-modules', 'installation', 'production-install.ts'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
  const branchAt = source.indexOf('error.code === MODULE_INSTALLATION_RESTART_REQUIRED');
  assert.ok(branchAt >= 0, 'the restart-required branch exists');
  const throwAt = source.indexOf('PRODUCTION_RESUME_RESTART_REQUIRED', branchAt);
  const bridgeAt = source.indexOf('recordPackageChangedInvalidations(db, {', branchAt);
  assert.ok(throwAt > 0, 'the refusal is thrown');
  assert.ok(bridgeAt > 0, 'the bridge is invoked in the branch');
  assert.ok(
    bridgeAt < throwAt,
    'evidence is recorded BEFORE the refusal — the alarm always lands on persisted audit',
  );
});
