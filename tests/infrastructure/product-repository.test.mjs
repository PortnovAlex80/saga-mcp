/**
 * SqliteProductRepository tests (Conveyor v4, step 2.3).
 *
 * Target contract: REG-11 (Изделие) + REG-08-AC-03 (fence enforcement).
 *
 * Covers the hardening over the prototype:
 *   - internal canonicalization (no caller-supplied digest).
 *   - fence enforcement: unknown / non-active execution rejected.
 *   - lineage validation: unknown lineage ref rejected.
 *   - idempotent replay returns the same ProductRef.
 *   - readProduct returns the submitted content + hash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { SqliteProductRepository } from '../../dist/infrastructure/workplace/sqlite-product-repository.js';
import {
  STALE_EXECUTION_CANNOT_SUBMIT,
  LINEAGE_REF_NOT_IN_READ_SET,
} from '../../dist/process-modules/application/product-repository-port.js';
// Lazy schema creators — factory_process_runs / factory_process_products are
// ensured lazily by repository constructors in production (db.ts wires them
// via getDb). Tests call them directly on the in-memory DB.
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteProcessProductRepositoryV2 } from '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Ensure the lazy tables the product repository depends on, by constructing
  // their owning repositories (same as production db.ts does via getDb()).
  ensureFactoryProcessRunSchema(db);
  new SqliteProcessProductRepositoryV2(db);
  return db;
}

function seedFixtures(db) {
  db.prepare(`INSERT INTO projects (id, name) VALUES (1, ?)`).run('p');
  db.prepare(`INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)`).run('e');
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, current_execution_id, metadata)
     VALUES (1, 1, ?, ?, ?)`,
  ).run('t', 'exec-1', JSON.stringify({ process_run_id: 1, process_node_id: 'node-1' }));
  // Insert a factory_process_runs row directly (its lazy-ensure schema differs
  // from the old SCHEMA_SQL block — the columns are module_name/version, not
  // lifecycle_name/version). The product repository's FK on
  // factory_process_products(process_run_id) needs this row.
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot,
        input_hash, status)
     VALUES (1, 1, ?, ?, ?, ?, 'generic-flow', ?, ?, ?, 'created')`,
  ).run('test-module', '1.0.0', 'test-module@1.0.0', 'k', 's', '{}', 'h');
}

function seedActiveExecution(db, executionId = 'exec-1', state = 'running') {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase)
     VALUES (?, 'run-1', 1, 1, 1, 'w-1', 'host', ?, 'executing')`,
  ).run(executionId, state);
}

test('REG-11-AC-01: submitProduct canonicalizes internally (no caller digest)', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db);
  const repo = new SqliteProductRepository(db);
  const content = { body: 'hello' };
  const { productRef } = repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 'factory.test.v1',
    content,
  });
  // The digest MUST be the repository's own sha256, not anything the caller
  // might have supplied.
  assert.equal(productRef.digest, sha256Hex(content));
  db.close();
});

test('REG-08-AC-03: unknown execution rejected', () => {
  const db = freshDb();
  // No worker_executions row for 'exec-x'.
  const repo = new SqliteProductRepository(db);
  assert.throws(
    () => repo.submitProduct({
      workplaceRef: null,
      executionRef: 'exec-x',
      schemaRef: 's',
      content: {},
    }),
    new RegExp(STALE_EXECUTION_CANNOT_SUBMIT),
  );
  db.close();
});

test('REG-08-AC-03: non-active execution rejected', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db, 'exec-2', 'exited'); // terminal state
  const repo = new SqliteProductRepository(db);
  assert.throws(
    () => repo.submitProduct({
      workplaceRef: null,
      executionRef: 'exec-2',
      schemaRef: 's',
      content: {},
    }),
    new RegExp(STALE_EXECUTION_CANNOT_SUBMIT),
  );
  db.close();
});

test('REG-12-AC-03: unknown lineage ref rejected', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db);
  const repo = new SqliteProductRepository(db);
  assert.throws(
    () => repo.submitProduct({
      workplaceRef: null,
      executionRef: 'exec-1',
      schemaRef: 's',
      content: { x: 1 },
      lineageRefs: [{ schemaId: 's', ref: 'unknown', digest: '0'.repeat(64) }],
    }),
    new RegExp(LINEAGE_REF_NOT_IN_READ_SET),
  );
  db.close();
});

test('REG-12-AC-01: replay returns the same ProductRef', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db);
  const repo = new SqliteProductRepository(db);
  const r1 = repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 's',
    content: { a: 1 },
  });
  const r2 = repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 's',
    content: { a: 1 },
  });
  assert.equal(r1.replayed, false);
  assert.equal(r2.replayed, true);
  assert.equal(r2.productRef.digest, r1.productRef.digest);
  db.close();
});

test('REG-11-AC-03: readProduct returns submitted content + hash', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db);
  const repo = new SqliteProductRepository(db);
  const content = { hello: 'world' };
  const { productRef } = repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 'factory.test.v1',
    content,
  });
  const read = repo.readProduct(productRef);
  assert.ok(read);
  assert.deepEqual(read.content, content);
  assert.equal(read.contentHash, sha256Hex(content));
  db.close();
});

test('REG-11-AC-03: readProduct returns null for unknown ref', () => {
  const db = freshDb();
  const repo = new SqliteProductRepository(db);
  assert.equal(
    repo.readProduct({ schemaId: 's', ref: 'nope', digest: '0'.repeat(64) }),
    null,
  );
  db.close();
});

test('valid lineage ref (prior submitted product) accepted', () => {
  const db = freshDb();
  seedFixtures(db);
  seedActiveExecution(db);
  const repo = new SqliteProductRepository(db);
  // First product — no lineage. Use a distinct schemaRef so the v1 table's
  // UNIQUE(process_run_id, product_kind) does not reject the second product.
  const r1 = repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 'factory.first.v1',
    content: { first: true },
  });
  // Second product cites the first as lineage — must pass.
  assert.doesNotThrow(() => repo.submitProduct({
    workplaceRef: null,
    executionRef: 'exec-1',
    schemaRef: 'factory.second.v1',
    content: { second: true },
    lineageRefs: [r1.productRef],
  }));
  db.close();
});
