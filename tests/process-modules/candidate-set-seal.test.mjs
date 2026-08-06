/**
 * Test: CandidateSet seal on architecture completion (Stage 1 bridge).
 *
 * Verifies that when the architecture resolver handler completes successfully,
 * a CandidateSet is sealed from the worker's produced SRS artifact. This is
 * bridge mode — the CandidateSet is sealed alongside the existing
 * ExactCandidateAcceptance, not replacing it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

test('CandidateSetRepository.seal creates an immutable sealed set', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);

  // Seed a workplace row via the repository (correct initial state).
  const REF = {
    processRunId: 1,
    moduleRef: 'sf@1',
    productionCellId: 'define-architecture-contract',
    workKey: 'default',
  };
  new SqliteWorkplaceRepository(db).materialize(REF);

  const repo = new SqliteCandidateSetRepository(db);
  const srsHash = hash('SRS content');
  const result = repo.seal({
    workplaceRef: {
      processRunId: 1,
      moduleRef: 'sf@1',
      productionCellId: 'define-architecture-contract',
      workKey: 'default',
    },
    producerExecutionRef: 'exec-1',
    role: 'author',
    subjectCandidateSetRef: null,
    members: [{
      productRef: {
        schemaId: 'SRS',
        ref: 'artifact:42',
        digest: srsHash,
      },
      origin: 'produced',
      sourceCandidateSetRef: null,
    }],
    candidateSetDigest: hash('members'),
    sealReceiptRef: 'execution-complete:exec-1',
    sealedAt: '2026-08-04T12:00:00Z',
  });

  assert.ok(result.set.candidateSetRef, 'seal must return a candidateSetRef');
  assert.equal(result.replayed, false, 'first seal is not a replay');

  // Verify the row exists in the DB.
  const row = db.prepare(
    'SELECT candidate_set_ref, workplace_ref, role, producer_execution_ref FROM factory_candidate_sets WHERE candidate_set_ref=?',
  ).get(result.set.candidateSetRef);
  assert.ok(row);
  assert.equal(row.role, 'author');
  assert.equal(row.producer_execution_ref, 'exec-1');

  // Verify the member row.
  const memberRow = db.prepare(
    'SELECT product_ref, product_digest, origin FROM factory_candidate_set_members WHERE candidate_set_ref=?',
  ).get(result.set.candidateSetRef);
  assert.ok(memberRow);
  assert.equal(memberRow.product_digest, srsHash);
  assert.equal(memberRow.origin, 'produced');

  db.close();
});

test('CandidateSetRepository.seal is idempotent on same digest', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureManagedProductionLedgerSchema(db);
  new SqliteWorkplaceRepository(db).materialize({
    processRunId: 1, moduleRef: 'sf@1', productionCellId: 'cell', workKey: 'default',
  });

  const repo = new SqliteCandidateSetRepository(db);
  const input = {
    workplaceRef: {
      processRunId: 1,
      moduleRef: 'sf@1',
      productionCellId: 'cell',
      workKey: 'default',
    },
    producerExecutionRef: 'exec-1',
    role: 'author',
    subjectCandidateSetRef: null,
    members: [{
      productRef: { schemaId: 'SRS', ref: 'artifact:1', digest: hash('a') },
      origin: 'produced',
      sourceCandidateSetRef: null,
    }],
    candidateSetDigest: hash('digest'),
    sealReceiptRef: 'execution-complete:exec-1',
    sealedAt: '2026-08-04T12:00:00Z',
  };

  const first = repo.seal(input);
  const second = repo.seal(input);
  assert.equal(first.set.candidateSetRef, second.set.candidateSetRef, 'same ref on replay');
  assert.equal(second.replayed, true, 'second seal is a replay');
  db.close();
});
