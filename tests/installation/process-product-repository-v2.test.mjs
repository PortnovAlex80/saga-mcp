// tests/installation/process-product-repository-v2.test.mjs
//
// W3-A4 — ProcessProductRepository v2 (exact-by-ProductRef) conformance.
// Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md §7.
//
// These tests prove the §7 contract and the §9.11 invariant: queries are
// EXACT-by-ProductRef with NO epic-scope / "latest-in-run" fallback. A missing
// or mismatched product returns null (callers translate that to
// UPSTREAM_PRODUCT_NOT_FOUND); a byte-different payload under the same
// content-addressed identity throws.
//
// The fixture mirrors tests/process-modules/external-effect-ledger.test.mjs:
// temp DB, seed project + epic + a ProcessRun (so process_run_id is a valid FK),
// then exercise the v2 adapter directly.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessProductRepositoryV2 } = await import(
  '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js'
);
const {
  PROCESS_PRODUCT_REPLAY_MISMATCH,
  PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID,
  PROCESS_PRODUCT_FIELD_REQUIRED,
} = await import(
  '../../dist/process-modules/persistence/process-product-repository-v2.js'
);

const MODULE_REF = { name: 'software-delivery', version: '1.0.0' };

// Build a NodeProductionEnvelope with content-addressed fields. contentHash is
// sha256Hex(bindings) so the (schema, ref, digest) triple is internally
// consistent — exactly what a real node executor would produce.
//
// ProductRef semantic (SPI §W1-A6): ProductRef.schemaId is the schema identity
// of the PRODUCT = the wrapped production's schema (= envelope.schema), NOT the
// envelope wrapper's schemaId. The envelope carries both:
//   - envelope.schema     = production schema  (persisted in schema_id column)
//   - envelope.schemaId   = wrapper schema     (persisted in product_kind column)
// ProductRef points at the product, so productRef.schemaId = envelope.schema.
function makeEnvelope({ schema, artifactRef, bindings, schemaId, lineage = [] }) {
  const body = { ...bindings };
  const contentHash = sha256Hex(body);
  return {
    schema,
    artifactRef,
    contentHash,
    bindings: body,
    schemaId,
    productRef: { schemaId: schema, ref: artifactRef, digest: contentHash },
    lineage,
  };
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-product-v2-'));
  process.env.DB_PATH = path.join(temp, 'product-v2.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')`).run();
  const processRepo = new SqliteProcessRunRepository(db);
  const input = { releaseCandidateRef: 'candidate:abc' };
  const processRun = processRepo.start({
    moduleRef: MODULE_REF,
    executorKind: 'generic-flow',
    input: {
      schema: 'saga3.delivery-case.v1',
      payload: input,
      contentHash: sha256Hex(input),
    },
    projectedStage: 'delivery',
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'operator',
      idempotencyKey: 'product-v2-run-1',
    },
  }).record;
  return {
    temp,
    db,
    processRunId: processRun.id,
    repo: new SqliteProcessProductRepositoryV2(db),
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

test('recordProduct persists a NodeProductionEnvelope and returns replayed:false', () => {
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.delivery-preflight.v1',
      artifactRef: 'preflight:42',
      bindings: { ok: true, checks: 7 },
      schemaId: 'saga3.delivery-preflight-envelope.v1',
      lineage: [{ kind: 'node-run', ref: 'node-run:99' }],
    });
    const res = repo.recordProduct(envelope, processRunId, 'node.preflight');
    assert.equal(res.replayed, false);
    assert.equal(res.record.processRunId, processRunId);
    assert.equal(res.record.nodeId, 'node.preflight');
    assert.equal(res.record.reference.schema, 'saga3.delivery-preflight.v1');
    assert.equal(res.record.reference.ref, 'preflight:42');
    assert.equal(res.record.reference.hash, envelope.contentHash);
    assert.equal(res.record.payloadHash, sha256Hex(envelope.bindings));
    assert.deepEqual(res.record.payload, envelope.bindings);
    // Envelope is reconstructed on the v2 path (nodeId non-null).
    assert.ok(res.record.envelope, 'envelope must be reconstructed for v2 rows');
    assert.equal(res.record.envelope.schema, envelope.schema);
    assert.equal(res.record.envelope.productRef.digest, envelope.contentHash);
  } finally {
    cleanup(temp);
  }
});

test('getByProductRef returns the EXACT product matching (schemaId, ref, digest)', () => {
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.readiness-assessment.v1',
      artifactRef: 'readiness:77',
      bindings: { ready: true },
      schemaId: 'saga3.readiness-envelope.v1',
    });
    repo.recordProduct(envelope, processRunId, 'node.readiness');

    const found = repo.getByProductRef(envelope.productRef);
    assert.ok(found, 'exact ProductRef must resolve');
    assert.equal(found.reference.ref, 'readiness:77');
    assert.equal(found.reference.hash, envelope.contentHash);
    assert.equal(found.nodeId, 'node.readiness');
  } finally {
    cleanup(temp);
  }
});

test('§9.11 invariant: getByProductRef with a WRONG digest returns null (no fallback)', () => {
  // This is the core §9.11 proof: a ProductRef whose digest does not match the
  // stored product_hash must NOT resolve. The old listArtifactsForNodeInEpic
  // path would have returned the nearest epic-scope match; the v2 port returns
  // null so callers raise UPSTREAM_PRODUCT_NOT_FOUND instead.
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.normalization-proposal.v1',
      artifactRef: 'proposal:5',
      bindings: { problem: 'x' },
      schemaId: 'saga3.normalization-envelope.v1',
    });
    repo.recordProduct(envelope, processRunId, 'node.normalize');

    const wrongDigest = {
      schemaId: envelope.productRef.schemaId,
      ref: envelope.productRef.ref,
      digest: '0'.repeat(64), // wrong digest — content-addressed miss
    };
    assert.equal(repo.getByProductRef(wrongDigest), null);
  } finally {
    cleanup(temp);
  }
});

test('§9.11 invariant: getByProductRef for a MISSING product returns null (no epic-scope fallback)', () => {
  const { temp, repo } = fixture();
  try {
    const absent = {
      schemaId: 'saga3.never-persisted.v1',
      ref: 'nope:1',
      digest: 'a'.repeat(64),
    };
    assert.equal(repo.getByProductRef(absent), null);
  } finally {
    cleanup(temp);
  }
});

test('§9.11 invariant: getByProductRef does NOT match a different schemaId with the same ref+digest', () => {
  // Even if ref and digest collide, a different schemaId is a different
  // product. No fuzzy cross-schema matching.
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.diagnosis-report.v1',
      artifactRef: 'diag:3',
      bindings: { verdict: 'go' },
      schemaId: 'saga3.diagnosis-envelope.v1',
    });
    repo.recordProduct(envelope, processRunId, 'node.diagnose');

    const crossSchema = {
      schemaId: 'saga3.different-schema.v1',
      ref: envelope.productRef.ref,
      digest: envelope.productRef.digest,
    };
    assert.equal(repo.getByProductRef(crossSchema), null);
  } finally {
    cleanup(temp);
  }
});

test('replay: same envelope twice returns replayed:true with an equal record', () => {
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.settlement-input.v1',
      artifactRef: 'settle:9',
      bindings: { outcome: 'completed' },
      schemaId: 'saga3.settlement-envelope.v1',
    });
    const first = repo.recordProduct(envelope, processRunId, 'node.settle');
    const second = repo.recordProduct(envelope, processRunId, 'node.settle');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.record.reference, first.record.reference);
    assert.equal(second.record.payloadHash, first.record.payloadHash);
  } finally {
    cleanup(temp);
  }
});

test('replay mismatch: same (schema, ref) with a different digest throws', () => {
  // Immutability: a content-addressed identity is write-once. Trying to record
  // a byte-different body under the same (schema, artifactRef) is a violation.
  const { temp, repo, processRunId } = fixture();
  try {
    const e1 = makeEnvelope({
      schema: 'saga3.candidate.v1',
      artifactRef: 'cand:1',
      bindings: { v: 1 },
      schemaId: 'saga3.candidate-envelope.v1',
    });
    repo.recordProduct(e1, processRunId, 'node.candidate');

    // Same (schema, artifactRef), different bindings → different contentHash.
    const e2 = makeEnvelope({
      schema: 'saga3.candidate.v1',
      artifactRef: 'cand:1',
      bindings: { v: 2 },
      schemaId: 'saga3.candidate-envelope.v1',
    });
    assert.throws(
      () => repo.recordProduct(e2, processRunId, 'node.candidate'),
      (err) => {
        assert.ok(
          err.message.startsWith(PROCESS_PRODUCT_REPLAY_MISMATCH),
          `expected ${PROCESS_PRODUCT_REPLAY_MISMATCH}, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    cleanup(temp);
  }
});

test('getByArtifactRef resolves by the opaque artifact_ref string', () => {
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.publication.v1',
      artifactRef: 'pub:abc',
      bindings: { released: true },
      schemaId: 'saga3.publication-envelope.v1',
    });
    repo.recordProduct(envelope, processRunId, 'node.publish');

    const found = repo.getByArtifactRef('pub:abc');
    assert.ok(found);
    assert.equal(found.reference.ref, 'pub:abc');
    assert.equal(found.nodeId, 'node.publish');

    // Empty string is a no-op (defensive).
    assert.equal(repo.getByArtifactRef(''), null);
    // Absent ref returns null.
    assert.equal(repo.getByArtifactRef('pub:missing'), null);
  } finally {
    cleanup(temp);
  }
});

test('recordProduct rejects an invalid processRunId', () => {
  const { temp, repo } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.observation.v1',
      artifactRef: 'obs:1',
      bindings: { k: 1 },
      schemaId: 'saga3.observation-envelope.v1',
    });
    assert.throws(
      () => repo.recordProduct(envelope, 0, 'node.obs'),
      (err) => {
        assert.equal(err.message, PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID);
        return true;
      },
    );
  } finally {
    cleanup(temp);
  }
});

test('recordProduct rejects an empty required field', () => {
  const { temp, repo, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.observation.v1',
      artifactRef: 'obs:2',
      bindings: { k: 1 },
      schemaId: 'saga3.observation-envelope.v1',
    });
    assert.throws(
      () => repo.recordProduct(envelope, processRunId, '   '),
      (err) => {
        assert.ok(err.message.startsWith(PROCESS_PRODUCT_FIELD_REQUIRED));
        return true;
      },
    );
  } finally {
    cleanup(temp);
  }
});

test('schema is idempotent: the node_id column + index survive a second construction', () => {
  // Constructing the adapter twice (and calling ensureSchema twice) must not
  // error — CREATE INDEX IF NOT EXISTS + the PRAGMA-guarded ALTER are no-ops on
  // the second pass. This guards the migration path for existing DB files.
  const { temp, db, processRunId } = fixture();
  try {
    const envelope = makeEnvelope({
      schema: 'saga3.idempotent.v1',
      artifactRef: 'idem:1',
      bindings: { n: 1 },
      schemaId: 'saga3.idempotent-envelope.v1',
    });
    const repo1 = new SqliteProcessProductRepositoryV2(db);
    repo1.recordProduct(envelope, processRunId, 'node.a');
    // Second construction on the SAME db — must not throw, must not drop data.
    const repo2 = new SqliteProcessProductRepositoryV2(db);
    const found = repo2.getByProductRef(envelope.productRef);
    assert.ok(found, 'data must survive a second schema ensure');
    assert.equal(found.nodeId, 'node.a');

    // node_id column is present (additive ALTER happened exactly once).
    const cols = db.prepare('PRAGMA table_info(saga3_process_products)').all()
      .map((c) => c.name);
    assert.ok(cols.includes('node_id'), 'node_id column must exist');

    // The exact-lookup index is present.
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_saga3_process_products_schema_ref_hash'",
    ).get();
    assert.ok(idx, 'v2 exact-lookup index must exist');
  } finally {
    cleanup(temp);
  }
});

test('multiple distinct products coexist in one run and each resolves by exact ref', () => {
  // A real module run emits several products (preflight, approval,
  // publication...). Each has its own (schema, ref, digest) and must resolve
  // independently — no "one product per run" limit leaks through the v2 port.
  const { temp, repo, processRunId } = fixture();
  try {
    const envs = [
      makeEnvelope({
        schema: 'saga3.delivery-preflight.v1',
        artifactRef: 'preflight:1',
        bindings: { ok: true },
        schemaId: 'saga3.delivery-preflight-envelope.v1',
      }),
      makeEnvelope({
        schema: 'saga3.delivery-approval.v1',
        artifactRef: 'approval:1',
        bindings: { status: 'approved' },
        schemaId: 'saga3.delivery-approval-envelope.v1',
      }),
      makeEnvelope({
        schema: 'saga3.delivery-publication.v1',
        artifactRef: 'publication:1',
        bindings: { released: true },
        schemaId: 'saga3.delivery-publication-envelope.v1',
      }),
    ];
    for (const e of envs) {
      repo.recordProduct(e, processRunId, `node.${e.artifactRef}`);
    }
    for (const e of envs) {
      const found = repo.getByProductRef(e.productRef);
      assert.ok(found, `${e.artifactRef} must resolve`);
      assert.equal(found.nodeId, `node.${e.artifactRef}`);
    }
  } finally {
    cleanup(temp);
  }
});
