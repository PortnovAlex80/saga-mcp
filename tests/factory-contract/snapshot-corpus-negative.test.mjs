// tests/factory-contract/snapshot-corpus-negative.test.mjs
//
// Negative (fail-closed) cases for the stage-11 snapshot corpus port —
// the adversarial half of snapshot-reach-development.test.mjs. Each test
// proves the harness/factory REJECTS a corrupted or stale input instead of
// silently adopting decoy material:
//
//   SNAPSHOT-NEG-0  pristine-corpus invariant — every committed corpus byte
//                   still verifies against the manifest. This is the
//                   deliberate-mutation tripwire: corrupting any committed
//                   corpus byte turns this suite RED with the typed error.
//   SNAPSHOT-NEG-1  corrupted corpus material -> typed SNAPSHOT_CORPUS_DRIFT
//                   (digest pair in the message; no decoy bytes returned).
//   SNAPSHOT-NEG-2  missing package bytes (manifest references a file that
//                   is gone) -> typed SNAPSHOT_CORPUS_FILE_MISSING.
//   SNAPSHOT-NEG-3  invalid transition order: the downstream tape cells
//                   (acceptance/architecture) fail closed when the
//                   product-contract predecessor has not sealed the brief —
//                   the harness never invents dispositions or coverage ids.
//   SNAPSHOT-NEG-4  stale authority identity: a captured reviewer verdict
//                   presented against a fresh runtime with its ORIGINAL
//                   (stale/foreign-run) subject ref is rejected by the REAL
//                   review-verdict check provider — no decoy adoption. The
//                   identical payload with the ref rebound to the current
//                   author candidate passes; a corrupted submission row
//                   (digest mismatch) is rejected too.
//
// Style: gate-repair-target.test.mjs — real dist code, throwaway SQLite DB,
// typed fail-closed outcomes. No LLM, no network, no orchestrate spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  createCorpusAccess,
  coveredConstraintIdsFromBrief,
  deriveArchitectureSrsText,
} from './snapshot-stage11-scenarios.mjs';
import { createReviewVerdictCheckProvider } from '../../dist/process-modules/application/review-verdict-check-provider.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'golden-corpus', 'stage11-docking');

const pristine = createCorpusAccess(CORPUS_ROOT);

function corpusCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-corpus-neg-'));
  cpSync(CORPUS_ROOT, path.join(dir, 'stage11-docking'), { recursive: true });
  return { dir, root: path.join(dir, 'stage11-docking') };
}

// SNAPSHOT-NEG-0 — pristine-corpus invariant (the mutation tripwire).
test('SNAPSHOT-NEG-0: every committed corpus document and product verifies against the manifest', () => {
  assert.ok(pristine.manifest.counts.documents >= 12, 'manifest documents count sanity');
  for (const doc of pristine.manifest.documents) {
    assert.doesNotThrow(
      () => pristine.documentFor(doc.source),
      `committed corpus document must verify: ${doc.source}`,
    );
  }
  for (const product of pristine.manifest.products) {
    assert.doesNotThrow(
      () => pristine.productFile(product.nodeId, product.schemaId, product.ordinal),
      `committed corpus product must verify: ${product.file}`,
    );
  }
});

// SNAPSHOT-NEG-1 — corrupted material fails closed with the typed digest error.
test('SNAPSHOT-NEG-1: corrupted corpus material fails closed with SNAPSHOT_CORPUS_DRIFT (no decoy bytes)', () => {
  const { dir, root } = corpusCopy();
  try {
    const access = createCorpusAccess(root);

    // Corrupt ONE document byte: flip a character inside the brief body.
    const briefEntry = access.manifest.documents.find(doc => doc.source.endsWith('01-brief.md'));
    const briefPath = path.join(root, briefEntry.file);
    writeFileSync(briefPath, readFileSync(briefPath, 'utf8').replace('Physics', 'Pyhsics'));
    assert.throws(
      () => access.documentFor(briefEntry.source),
      error => error instanceof Error
        && /SNAPSHOT_CORPUS_DRIFT/.test(error.message)
        && error.message.includes(briefEntry.file)
        && /\b[a-f0-9]{64}\b.*\b[a-f0-9]{64}\b/.test(error.message),
      'a corrupted document byte must fail closed with the typed digest error (both digests in the message)',
    );

    // Corrupt ONE product byte (parseable JSON, one value changed): the
    // canonical re-hash no longer matches the captured payload hash.
    const productEntry = access.manifest.products.find(
      product => product.nodeId === 'assess-readiness',
    );
    const productPath = path.join(root, productEntry.file);
    const payload = JSON.parse(readFileSync(productPath, 'utf8'));
    const probe = JSON.stringify(payload);
    const key = Object.keys(payload).find(k => typeof payload[k] === 'string' && payload[k].length > 2);
    payload[key] = payload[key].slice(0, -1) + (payload[key].endsWith('x') ? 'y' : 'x');
    writeFileSync(productPath, JSON.stringify(payload, null, 2) + '\n');
    assert.ok(JSON.stringify(payload) !== probe, 'product mutation must change bytes');
    assert.throws(
      () => access.productFile(productEntry.nodeId, productEntry.schemaId, productEntry.ordinal),
      error => error instanceof Error && /SNAPSHOT_CORPUS_DRIFT/.test(error.message),
      'a corrupted product byte must fail closed with the typed digest error',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SNAPSHOT-NEG-2 — missing package bytes fail closed with the typed error.
test('SNAPSHOT-NEG-2: missing corpus package bytes fail closed with SNAPSHOT_CORPUS_FILE_MISSING', () => {
  const { dir, root } = corpusCopy();
  try {
    const access = createCorpusAccess(root);

    // Remove a document the manifest still references.
    const briefEntry = access.manifest.documents.find(doc => doc.source.endsWith('01-brief.md'));
    rmSync(path.join(root, briefEntry.file));
    assert.throws(
      () => access.documentFor(briefEntry.source),
      error => error instanceof Error && /SNAPSHOT_CORPUS_FILE_MISSING/.test(error.message),
      'a missing document file must fail closed with the typed missing-file error (not a raw ENOENT)',
    );

    // Remove a product file the manifest still references (package bytes gone).
    const productEntry = access.manifest.products.find(
      product => product.nodeId === 'produce-proposal',
    );
    rmSync(path.join(root, productEntry.file));
    assert.throws(
      () => access.productFile(productEntry.nodeId, productEntry.schemaId, productEntry.ordinal),
      error => error instanceof Error && /SNAPSHOT_CORPUS_FILE_MISSING/.test(error.message),
      'a missing product file must fail closed with the typed missing-file error (not a raw ENOENT)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SNAPSHOT-NEG-3 — invalid transition order: downstream cells fail closed
// without their sealed predecessor material.
test('SNAPSHOT-NEG-3: downstream tape cells fail closed without the sealed brief (no invented dispositions)', async () => {
  // Case A: no accepted brief at all — the product-contract cell has not
  // sealed. The acceptance/architecture derivations must refuse to run.
  const emptyClient = { callJson: async () => ({ artifacts: [] }) };
  await assert.rejects(
    () => coveredConstraintIdsFromBrief(emptyClient, 1),
    error => error instanceof Error
      && /SNAPSHOT_DERIVED_COVERAGE_INVALID/.test(error.message),
    'running the acceptance relay before the product-contract cell sealed the brief must fail closed',
  );

  // Case B: accepted briefs exist but carry no constraint dispositions (the
  // pre-ADR-090 capture shape). Still fail-closed — never invented.
  const legacyClient = {
    callJson: async () => ({
      artifacts: [{ id: 1, type: 'brief', metadata: JSON.stringify({ brief_payload: {} }) }],
    }),
  };
  await assert.rejects(
    () => coveredConstraintIdsFromBrief(legacyClient, 1),
    error => error instanceof Error && /SNAPSHOT_DERIVED_COVERAGE_INVALID/.test(error.message),
    'a brief without constraint dispositions must not be coerced into coverage ids',
  );

  // Case C: the derived-SRS relay itself refuses empty coverage (the same
  // discipline one level down).
  assert.throws(
    () => deriveArchitectureSrsText('# SRS\n\n- ac: something\n', []),
    error => error instanceof Error && /SNAPSHOT_DERIVED_SRS_INVALID/.test(error.message),
    'an empty coverage list must not produce a derived SRS',
  );
});

// SNAPSHOT-NEG-4 — stale authority identity: the REAL review-verdict check
// provider rejects a verdict whose subject ref belongs to a stale/foreign
// run, and a corrupted submission row, while the rebound verdict passes.
test('SNAPSHOT-NEG-4: stale authority identity is rejected by the real verdict provider (no decoy adoption)', () => {
  // The REAL captured verdict bytes — material byte-exact, subject ref
  // belonging to the CAPTURED (now foreign) run.
  const capturedVerdict = pristine.productFile(
    'define-product-contract', 'factory.review-verdict.v1', 1,
  );
  const RUNTIME_AUTHOR_REF = 'cset:runtime-author:0001';
  const STALE_REF = capturedVerdict.subject_candidate_set_ref;
  assert.ok(typeof STALE_REF === 'string' && STALE_REF.length > 0,
    'captured verdict carries a subject ref to use as the stale identity');

  const drive = ({ subjectRefInPayload, rowHash, memberDigest }) => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY, schema_version TEXT, payload_snapshot TEXT, content_hash TEXT
    )`);
    db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, workplace_ref TEXT, metadata TEXT)`);
    db.exec(`CREATE TABLE factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_task_id TEXT
    )`);
    const payload = { ...capturedVerdict, subject_candidate_set_ref: subjectRefInPayload };
    const digest = rowHash ?? 'verdict-digest-1';
    db.prepare(`INSERT INTO factory_managed_node_submissions
      (id,schema_version,payload_snapshot,content_hash) VALUES (1,?,?,?)`)
      .run('factory.review-verdict.v1', JSON.stringify(payload), digest);
    const candidateSets = {
      read(ref) {
        if (ref !== 'review-set') return null;
        return {
          role: 'reviewer',
          subjectCandidateSetRef: RUNTIME_AUTHOR_REF,
          workplaceRef: {
            processRunId: 1,
            moduleRef: 'solution-formalization@1.0.0',
            productionCellId: 'formalization-product-contract',
            workKey: 'singleton',
          },
          members: [{
            productRef: {
              schemaId: 'factory.review-verdict.v1',
              ref: 'managed-node-submission:1',
              digest: memberDigest ?? digest,
            },
          }],
        };
      },
    };
    const provider = createReviewVerdictCheckProvider({ db, candidateSets });
    const outcome = provider.run({
      subjectCandidateSetRef: RUNTIME_AUTHOR_REF,
      parameters: {
        assessmentCandidateSetRefs: ['review-set'],
        verdictSchemaRef: 'factory.review-verdict.v1',
      },
      environmentRef: null,
      candidateSnapshot: {},
    });
    db.close();
    return outcome;
  };

  // Stale/foreign subject ref (the captured run's identity): fail closed —
  // the provider answers 'unknown', never 'passed'. No decoy adoption: the
  // verdict cannot be applied against a candidate it does not name.
  const staleOutcome = drive({ subjectRefInPayload: STALE_REF });
  assert.equal(staleOutcome, 'unknown',
    'a verdict bound to a stale/foreign candidate ref must fail closed (unknown), not pass');

  // Control: the SAME captured material with the subject ref rebound to the
  // current runtime author candidate is accepted by the provider.
  const reboundOutcome = drive({ subjectRefInPayload: RUNTIME_AUTHOR_REF });
  assert.ok(reboundOutcome === 'passed' || reboundOutcome?.outcome === 'failed',
    'the rebound captured verdict must be evaluated on its material (not rejected as stale)');

  // Corrupted submission row (stored digest no longer matches the member
  // digest the candidate set sealed): fail closed too.
  const corruptedOutcome = drive({
    subjectRefInPayload: RUNTIME_AUTHOR_REF,
    rowHash: 'tampered-digest',
    memberDigest: 'verdict-digest-1',
  });
  assert.equal(corruptedOutcome, 'unknown',
    'a submission row whose stored digest diverges from the sealed member digest must fail closed');
});
