// tests/app/factory-redevelopment.test.mjs
//
// STAGE-19 — the redevelopment entry: re-enter solution-development with the
// STANDARD development module, consuming the parent's frozen formalization
// capsule, after a terminal development failure. Live-shaped: it runs against
// a TEMP COPY of the stopped stage-15 database — the exact parent class this
// entry exists for (lifecycle 1: failed@solution-development, discovery 'go',
// formalization 'formalized'). On a machine without that sandbox the test
// skips (declared precondition, not a crash).
//
// The mirror-image negative: the same DB with the parent mutated away from
// the exact terminal boundary must fail closed.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { prepareDevelopmentRedevelopment } from '../../dist/app/factory-redevelopment.js';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const sourcePath = '.factory-sandboxes/stage15-db/factory.sqlite';
const missingSource = existsSync(sourcePath)
  ? undefined
  : `live source database is unavailable (${sourcePath})`;

async function tempCopy() {
  const root = mkdtempSync(join(tmpdir(), 'saga-redevelopment-'));
  const target = join(root, 'factory.sqlite');
  const source = new Database(sourcePath, { readonly: true });
  await source.backup(target);
  source.close();
  const db = new Database(target);
  db.pragma('foreign_keys=ON');
  db.exec(SCHEMA_SQL);
  // Launch pre-step (the supervision reap): the operator stop kills the
  // worker PROCESS; the row may still read 'running'. Redevelopment — like
  // the managed continuation — requires zero active executions.
  db.prepare(
    `UPDATE worker_executions SET state='lost'
      WHERE state IN ('reserved','running','cancel_requested')`,
  ).run();
  return { root, db };
}

/**
 * The live-parent positive fixture existed only between the stage-19 entry
 * (cbdfe972) and the real launch: the redevelop run appended a child
 * lifecycle to the order chain and consumed the parent's continuation
 * authorization, so lifecycle 1 is no longer the active leaf and CANNOT be
 * re-authorized (CONTINUATION_PARENT_NOT_ACTIVE_LEAF — the eligibility rule
 * working as designed). The append-only guards (immutable order runs,
 * no-delete authorizations) rightly forbid restoring the pre-launch chain
 * shape even in a copy. The authorization behavior this test proved is now
 * proven STRONGER by the real stage-19 run — see
 * docs/factory-run/stage19/RUN-TRACKER.md (TERMINAL seal 17dd3916:
 * childLifecycleRunId, capsuleHash == the frozen input_hash, STANDARD
 * solution-development@1.4.4, additive capsule mapping).
 */
function liveParentFixtureSpent(db) {
  const leaf = db.prepare(
    `SELECT forl.lifecycle_run_id AS leaf
       FROM factory_order_runs forl
       JOIN factory_orders o ON o.order_ref = forl.order_ref
      WHERE o.lifecycle_run_id = 1
      ORDER BY forl.ordinal DESC LIMIT 1`,
  ).get();
  return leaf?.leaf !== 1;
}

function orderRefOf(db, lifecycleRunId) {
  const row = db.prepare(
    `SELECT COALESCE(
              (SELECT chain.order_ref FROM factory_order_runs chain
                WHERE chain.lifecycle_run_id=:id),
              (SELECT root.order_ref FROM factory_orders root
                WHERE root.lifecycle_run_id=:id)
            ) AS order_ref`,
  ).get({ id: lifecycleRunId });
  if (!row?.order_ref) throw new Error(`no root FactoryOrder for lifecycle ${lifecycleRunId}`);
  return row.order_ref;
}

test('redevelopment authorizes the STANDARD development module with the capsule mapping (live parent)',
  async () => {
  if (missingSource) return test.skip(missingSource);
  const probe = new Database(sourcePath, { readonly: true });
  const spent = liveParentFixtureSpent(probe);
  probe.close();
  if (spent) {
    return test.skip(
      'live-parent fixture spent by the REAL stage-19 redevelop launch '
      + '(2026-08-20): lifecycle 1 is no longer the order-chain leaf and the '
      + 'append-only guards forbid restoring the chain shape. The '
      + 'authorization proof now lives in the run itself — '
      + 'docs/factory-run/stage19/RUN-TRACKER.md (TERMINAL seal 17dd3916).');
  }
  const { root, db } = await tempCopy();
  try {
    const before = db.prepare('SELECT COUNT(*) c FROM factory_lifecycle_runs').get().c;
    const prepared = prepareDevelopmentRedevelopment(db, {
      orderRef: orderRefOf(db, 1),
      parentLifecycleRunId: 1,
      actorId: 'stage-19-pre-flight',
      reason: 'redevelopment entry: standard module, workshops-1/2 capsule',
    });
    assert.equal(prepared.childLifecycleRunId, before + 1, 'exactly one child lifecycle run');
    assert.equal(prepared.projectId, 1);
    assert.equal(prepared.epicId, 1);

    // The capsule hash is the EXACT frozen input_hash of the failed dev run.
    const devRun = db.prepare(
      `SELECT input_hash FROM factory_process_runs WHERE id=3`,
    ).get();
    assert.equal(prepared.capsuleHash, devRun.input_hash,
      'the capsule consumed is the exact hashed bytes formalization produced');

    // The child's definition pins the STANDARD module (not the managed
    // recovery variant) and the additive capsule mapping on the stage.
    const child = db.prepare(
      'SELECT definition_snapshot FROM factory_lifecycle_runs WHERE id=?',
    ).get(prepared.childLifecycleRunId);
    const definition = JSON.parse(child.definition_snapshot);
    const stage = definition.stages.find(s => s.id === 'solution-development');
    assert.deepEqual(stage.moduleRef, { name: 'solution-development', version: '1.4.4' },
      'the STANDARD development module — the planner re-carves, real gates stand');
    assert.equal(stage.inputMapping.srs,
      '$.continuation.externalBaseline.redevelopment.srs',
      'the srs input is fed from the capsule');
    assert.equal(stage.inputMapping.acceptanceCriteria,
      '$.continuation.externalBaseline.redevelopment.acceptanceCriteria',
      'the acceptance criteria are fed from the capsule');
    assert.equal(stage.inputMapping['formalizationCertificate.hash'],
      '$.continuation.externalBaseline.redevelopment.formalizationCertificate.hash',
      'the formalization certificate identity is fed from the capsule');
    assert.equal(stage.inputMapping.repositories,
      '$.continuation.externalBaseline.redevelopment.repositories',
      'the repositories input is fed from the capsule');

    // Idempotency: authorizing the SAME parent again through a fresh
    // repository instance is rejected (the authorization is consumed once).
    assert.throws(
      () => prepareDevelopmentRedevelopment(db, {
        orderRef: orderRefOf(db, 1),
        parentLifecycleRunId: 1,
        actorId: 'stage-19-pre-flight',
        reason: 'second authorization of the same parent must not pass',
      }),
      /CONTINUATION_|REDEVELOPMENT_|already/i,
      'a second authorization of the same consumed parent fails closed',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('redevelopment fails closed on a non-exact parent (paused, not terminal)', { skip: missingSource }, async () => {
  const { root, db } = await tempCopy();
  try {
    db.prepare(`UPDATE factory_lifecycle_runs SET status='paused', current_stage_id='solution-development' WHERE id=1`).run();
    assert.throws(
      () => prepareDevelopmentRedevelopment(db, {
        orderRef: orderRefOf(db, 1),
        parentLifecycleRunId: 1,
        actorId: 'negative',
        reason: 'must fail closed',
      }),
      /DEVELOPMENT_REDEVELOPMENT_PARENT_NOT_EXACT/,
      'a paused run is not a terminal failure and must not be redeveloped',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('redevelopment fails closed on a capsule hash mismatch (tampered snapshot)', { skip: missingSource }, async () => {
  const { root, db } = await tempCopy();
  try {
    // Corrupt the frozen snapshot WITHOUT touching input_hash: the capsule
    // must be consumed only as the exact bytes formalization produced.
    const row = db.prepare('SELECT input_snapshot FROM factory_process_runs WHERE id=3').get();
    const tampered = JSON.parse(row.input_snapshot);
    tampered.srs = { ...tampered.srs, tampered: true };
    db.prepare('UPDATE factory_process_runs SET input_snapshot=? WHERE id=3')
      .run(JSON.stringify(tampered));
    assert.notEqual(
      sha256Hex(JSON.stringify(tampered)),
      sha256Hex(row.input_snapshot),
      'sanity: the tampered bytes genuinely differ from the frozen snapshot',
    );
    assert.throws(
      () => prepareDevelopmentRedevelopment(db, {
        orderRef: orderRefOf(db, 1),
        parentLifecycleRunId: 1,
        actorId: 'negative',
        reason: 'must fail closed',
      }),
      /DEVELOPMENT_REDEVELOPMENT_CAPSULE_HASH_MISMATCH/,
      'a capsule whose bytes no longer hash to the frozen input_hash is refused',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
