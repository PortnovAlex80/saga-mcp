// tests/architecture/artifact-drift-chain.test.mjs
//
// BLINDSIGHT F6 (persistence layer, PREVENTIVE-HUNT «Слепота по слоям»):
// artifacts.drift_state is a MUTABLE column overwritten on every re-hash
// (refreshArtifactHash) and on every deliberate accept. The transition
// HISTORY was destroyed at each write: when an accepted artifact flipped
// clean -> drifted -> clean, the drifted episode — the durable fact that
// the material DID drift at some point — vanished. Consumers reading the
// current column can never distinguish "never drifted" from "drifted and
// repaired", and T-5/T-6 consumers lose the last-known-good evidence.
//
// This suite pins the honest repair: every drift_state TRANSITION (old value
// differs from new) appends one immutable row to
// factory_artifact_drift_events (old + new = a recoverable chain), written
// in the SAME statement batch as the overwrite. Same-state re-reads append
// nothing (no noise). The chain is exposed via readArtifactDriftChain and
// is protected by no-update/no-delete triggers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SCHEMA_SQL } from '../../dist/schema.js';

const { refreshArtifactHash } = await import('../../dist/helpers/artifact-file.js');
const {
  appendArtifactDriftTransition,
  readArtifactDriftChain,
} = await import('../../dist/shared/artifact-drift-events.js');

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(content = 'accepted bytes') {
  const repo = path.join(os.tmpdir(), `saga-drift-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'doc.md'), content);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(`INSERT INTO repositories (id,name) VALUES (1,'r')`).run();
  db.prepare(
    `INSERT INTO project_repositories
       (id,project_id,repository_id,role,local_path,integration_branch,status)
     VALUES (1,1,1,'component',?,'dev','active')`,
  ).run(repo);
  const contentHash = hash(content);
  db.prepare(
    `INSERT INTO artifacts
       (id,project_id,epic_id,type,code,title,path,status,content_hash,
        accepted_hash,drift_state,project_repository_id,storage_kind,tags,metadata)
     VALUES (50,1,1,'SRS',NULL,'doc','doc.md','accepted',?,?,?,1,'file_backed','[]','{}')`,
  ).run(contentHash, contentHash, 'clean', );
  return { db, repo, artifactId: 50, contentHash };
}

test('F6: a clean -> drifted -> clean cycle leaves a RECOVERABLE append-only chain', () => {
  const { db, repo, artifactId, contentHash } = fixture();
  void contentHash;

  // Same-state re-read: no transition, no event (no noise).
  refreshArtifactHash(db, artifactId);
  assert.equal(readArtifactDriftChain(db, artifactId).length, 0,
    'a clean re-read of unchanged bytes appends nothing');

  // The file is mutated behind the ledger's back -> drifted (event 1).
  writeFileSync(path.join(repo, 'doc.md'), 'MUTATED behind the ledger');
  refreshArtifactHash(db, artifactId);
  let chain = readArtifactDriftChain(db, artifactId);
  assert.equal(chain.length, 1, 'clean -> drifted is appended once');
  assert.equal(chain[0].fromState, 'clean');
  assert.equal(chain[0].toState, 'drifted');
  assert.ok(chain[0].observedContentHash);
  assert.ok(chain[0].observedAt);
  assert.ok(chain[0].cause);

  // The file is restored -> clean again (event 2). The chain now PROVES the
  // drift episode happened — the mutable column alone cannot.
  writeFileSync(path.join(repo, 'doc.md'), 'accepted bytes');
  refreshArtifactHash(db, artifactId);
  chain = readArtifactDriftChain(db, artifactId);
  assert.equal(chain.length, 2);
  assert.deepEqual(
    chain.map(event => [event.fromState, event.toState]),
    [['clean', 'drifted'], ['drifted', 'clean']],
    'old + new form a recoverable chain in order',
  );

  const row = db.prepare('SELECT drift_state FROM artifacts WHERE id=50').get();
  assert.equal(row.drift_state, 'clean', 'the column stays the latest projection');

  db.close();
});

test('F6: the drift-event chain is immutable (append-only enforced by triggers)', () => {
  const { db, repo, artifactId } = fixture();
  writeFileSync(path.join(repo, 'doc.md'), 'MUTATED');
  refreshArtifactHash(db, artifactId);
  assert.equal(readArtifactDriftChain(db, artifactId).length, 1);

  assert.throws(
    () => db.prepare(`UPDATE factory_artifact_drift_events SET to_state='clean' WHERE id=1`).run(),
    /IMMUTABLE|immutable/i,
  );
  assert.throws(
    () => db.prepare(`DELETE FROM factory_artifact_drift_events WHERE id=1`).run(),
    /FORBIDDEN|forbidden|IMMUTABLE|immutable/i,
  );
  db.close();
});

test('F6: a same-state write appends nothing; a deliberate transition appends with its cause', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO artifacts
       (id,project_id,epic_id,type,code,title,path,status,drift_state,
        project_repository_id,storage_kind,tags,metadata)
     VALUES (51,1,1,'AC','AC-1','ac','ac.md','accepted','unknown',NULL,'db_native','[]','{}')`,
  ).run();

  // Same-state (unknown -> unknown): not a transition.
  appendArtifactDriftTransition(db, {
    artifactId: 51, fromState: 'unknown', toState: 'unknown',
    observedContentHash: null, acceptedHash: null,
    cause: 'artifact-update', observedBy: 'test',
  });
  assert.equal(readArtifactDriftChain(db, 51).length, 0);

  // Real transition (unknown -> clean at acceptance): appended with cause.
  appendArtifactDriftTransition(db, {
    artifactId: 51, fromState: 'unknown', toState: 'clean',
    observedContentHash: 'h1', acceptedHash: 'h1',
    cause: 'formalization-acceptance', observedBy: 'test',
  });
  const chain = readArtifactDriftChain(db, 51);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].cause, 'formalization-acceptance');
  assert.equal(chain[0].fromState, 'unknown');
  assert.equal(chain[0].toState, 'clean');
  db.close();
});

test('F6 wiring: the schema carries the append-only drift-event table (additive, live-DB safe)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  // SCHEMA_SQL runs on EVERY db open (CREATE TABLE IF NOT EXISTS) — existing
  // live factory DBs must receive the new table without a version bump.
  db.exec(SCHEMA_SQL);
  db.exec(SCHEMA_SQL);
  const table = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='factory_artifact_drift_events'`,
  ).get();
  assert.ok(table, 'factory_artifact_drift_events exists in the core schema');
  db.close();
});
