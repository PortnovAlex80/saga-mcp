// tests/process-modules/accepted-head-parity-and-race.test.mjs
//
// K13 (M3, card commit 2) — the release-card scenarios that live with the
// head extension:
//
//   * CONCURRENT ACCEPTANCE RACE — two repositories on two connections over
//     one database file (the supervision-lease-concurrency pattern). Exactly
//     ONE identity can win a revision; every competing write at that
//     revision fails typed (AUTHORITY_HEAD_IDENTITY_CONFLICT), a lower
//     revision fails typed (AUTHORITY_HEAD_REGRESSION), and the winner's
//     identity is what persists.
//   * DUPLICATE ACKNOWLEDGEMENT — the same full identity replayed at the
//     same revision converges without touching the row.
//   * CLEAN AND UPGRADED SCHEMA PARITY — a database born from the current
//     SCHEMA_SQL and a database upgraded from the pre-K13 six-column shape
//     (repository-constructor ensure) accept and refuse EXACTLY the same
//     K13-era writes. Pre-K13 rows survive the upgrade with NULL identity
//     (the documented legacy meaning) and are superseded, not mutated.
//
// The legacy DDL below is the v6..v14 shape of the table (schema history in
// src/db.ts) — it is a fixture of record, not a living definition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';

const WP = 'workplace/1/m@1.0.0/cell/work-1';

const PRE_K13_HEAD_DDL = `
CREATE TABLE factory_accepted_authority_head (
  workplace_ref                        TEXT PRIMARY KEY,
  accepted_author_candidate_set_ref    TEXT NOT NULL,
  accepted_author_gate_decision_key    TEXT NOT NULL,
  revision                             INTEGER NOT NULL,
  recorded_at                          TEXT NOT NULL,
  accepted_author_task_id              TEXT
);
`;

function recordFull(revision, drift = {}) {
  return {
    workplaceRef: WP,
    acceptedAuthorCandidateSetRef: drift.candidateSetRef ?? 'candidate-set/A',
    acceptedAuthorGateDecisionKey: drift.gateDecisionKey ?? 'decision/A',
    revision,
    acceptedAuthorTaskId: drift.taskId !== undefined ? drift.taskId : 'task-1',
    checkPlanDigest: drift.checkPlanDigest ?? 'sha256:check-plan/A',
    packageFingerprint: drift.packageFingerprint ?? 'sha256:installation/A',
    productionRevisionRef: drift.productionRevisionRef ?? 'workplace-production-revision/A',
    productRefs: drift.productRefs ?? ['product/alpha@1'],
    baselineWorkplaceRevision: drift.baselineWorkplaceRevision ?? 6,
    now: () => new Date('2026-08-18T00:00:00Z'),
  };
}

function fileFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-head-race-'));
  const dbPath = path.join(dir, 'head.db');
  const connect = () => {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = OFF');
    db.exec(SCHEMA_SQL);
    return db;
  };
  return { dir, dbA: connect(), dbB: connect() };
}

test('K13/race: exactly one identity wins a revision; every competitor fails typed', () => {
  const { dir, dbA, dbB } = fileFixture();
  try {
    const repoA = new SqliteAcceptedAuthorityHeadRepository(dbA);
    const repoB = new SqliteAcceptedAuthorityHeadRepository(dbB);
    repoA.record(recordFull(5));
    // Process B accepted the SAME revision with a DIFFERENT identity: the
    // only acceptable outcome is a typed failure — never a silent swallow,
    // never an overwrite.
    assert.throws(
      () => repoB.record(recordFull(5, { checkPlanDigest: 'sha256:check-plan/B' })),
      /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    );
    assert.throws(
      () => repoB.record(recordFull(4, { candidateSetRef: 'candidate-set/STALE' })),
      /AUTHORITY_HEAD_REGRESSION/u,
    );
    // Duplicate acknowledgement from the competitor side: same identity.
    repoB.record(recordFull(5));
    const head = repoA.read(WP);
    assert.equal(head.acceptanceId, repoB.read(WP).acceptanceId);
    assert.equal(head.revision, 5);
  } finally {
    dbA.close(); dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('K13/duplicate-ack: the same identity at the same revision is a true no-op', () => {
  const { dir, dbA, dbB } = fileFixture();
  try {
    const repoA = new SqliteAcceptedAuthorityHeadRepository(dbA);
    const repoB = new SqliteAcceptedAuthorityHeadRepository(dbB);
    repoA.record(recordFull(5));
    const before = repoB.read(WP);
    repoB.record(recordFull(5));
    const after = repoA.read(WP);
    assert.equal(after.acceptanceId, before.acceptanceId);
    assert.equal(after.recordedAt, before.recordedAt, 'an identical replay does not even touch recorded_at');
  } finally {
    dbA.close(); dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('K13/parity: clean and upgraded databases accept and refuse the same K13-era writes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-head-parity-'));
  try {
    // CLEAN leg — born from the current SCHEMA_SQL.
    const clean = new Database(':memory:');
    clean.pragma('foreign_keys = OFF');
    clean.exec(SCHEMA_SQL);

    // UPGRADED leg — born pre-K13, seeded with a legacy row, then upgraded
    // by the repository constructor's idempotent ensure.
    const upgraded = new Database(':memory:');
    upgraded.pragma('foreign_keys = OFF');
    upgraded.exec(PRE_K13_HEAD_DDL);
    upgraded.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref,
          accepted_author_gate_decision_key, revision, recorded_at,
          accepted_author_task_id)
       VALUES (?, 'candidate-set/LEGACY', 'decision/LEGACY', 7, ?, 'task-legacy')`,
    ).run(WP, '2026-08-01T00:00:00.000Z');

    const cleanRepo = new SqliteAcceptedAuthorityHeadRepository(clean);
    const upgradedRepo = new SqliteAcceptedAuthorityHeadRepository(upgraded);

    // The legacy row survived the upgrade and reads as pre-K13 (NULL identity
    // as a COMPLETE set — never a torn row).
    const legacy = upgradedRepo.read(WP);
    assert.equal(legacy.revision, 7);
    assert.equal(legacy.acceptanceId, null);
    assert.equal(legacy.productRefs, null);
    // Legacy replay by pointer triple stays idempotent; a drifted pointer
    // still conflicts; a lower revision still regresses.
    upgradedRepo.record({
      workplaceRef: WP,
      acceptedAuthorCandidateSetRef: 'candidate-set/LEGACY',
      acceptedAuthorGateDecisionKey: 'decision/LEGACY',
      revision: 7,
      acceptedAuthorTaskId: 'task-legacy',
      checkPlanDigest: 'sha256:check-plan/LEGACY',
      packageFingerprint: 'sha256:installation/LEGACY',
      productionRevisionRef: 'workplace-production-revision/LEGACY',
      productRefs: ['product/legacy@1'],
      baselineWorkplaceRevision: 6,
    });
    assert.equal(upgradedRepo.read(WP).revision, 7, 'same revision, same pointer: no-op even with identity supplied');
    assert.throws(
      () => upgradedRepo.record(recordFull(7, { gateDecisionKey: 'decision/OTHER' })),
      /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    );
    assert.throws(
      () => upgradedRepo.record(recordFull(3)),
      /AUTHORITY_HEAD_REGRESSION/u,
    );

    // K13-era writes behave IDENTICALLY on both legs.
    for (const repo of [cleanRepo, upgradedRepo]) {
      repo.record(recordFull(9));
      const head = repo.read(WP);
      assert.match(head.acceptanceId, /^authority-acceptance:[0-9a-f]{64}$/u);
      assert.equal(head.checkPlanDigest, 'sha256:check-plan/A');
      assert.throws(
        () => repo.record(recordFull(9, { packageFingerprint: 'sha256:installation/DRIFT' })),
        /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
      );
    }

    // The upgraded leg's new write superseded the legacy row in place.
    const after = upgradedRepo.read(WP);
    assert.equal(after.revision, 9);
    assert.equal(after.productionRevisionRef, 'workplace-production-revision/A');

    clean.close(); upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
