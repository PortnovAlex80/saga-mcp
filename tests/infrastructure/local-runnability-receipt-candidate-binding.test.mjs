// tests/infrastructure/local-runnability-receipt-candidate-binding.test.mjs
//
// CERTIFICATION-GAMING-REMEDY step 3 (D1) — the sourceCandidate-keyed receipt
// invariant: a check receipt is bound to the candidate BYTES it was produced
// against.
//
// Today the durable replay lookup keys receipts by the manifest's candidate-set
// ref — and every repair round seals a NEW manifest (new content = new ref),
// so changing the manifest manufactures a "new subject" and no conflict ever
// fires. D1 keys the persisted receipts by the sourceCandidate identity
// (candidateHash + commitSha + treeHash, embedded in every receipt's evidence
// as local-readiness-subject:<hash>:<commit>:<tree>):
//
//   - a receipt for the same bytes REPLAYS across manifest rounds — the
//     round-4 gaming manifest hits the round-1 failed receipt and the
//     narrowed command is never even executed;
//   - same bytes + previously failed + now passed (zero tracked-file diff —
//     the identical commit/tree in the binding IS the zero-diff proof) is a
//     structurally impossible honest outcome → typed
//     READINESS_RECEIPT_CANDIDATE_CONFLICT, outcome failed;
//   - different bytes (the worker fixed the code → new commit/tree) are a
//     genuinely new subject: fresh run, no replay, no conflict.
//
// The receipt history this models is the stage-11 live DB: sourceCandidate
// 50f712ef… carried failed receipts from rounds 1-3 AND the gamed passed
// receipt of round 4 — invisible today, a typed conflict with D1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createLocalRunnabilityCheckProvider,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const PROCESS_RUN_ID = 3;
const SOURCE_HASH = '50f712ef48f7f0b0db16cc5502161c0086c69e34085bfe54ed9d0f4e853ac8d0';
const SOURCE_REF = `development-integrated-source:${PROCESS_RUN_ID}:${SOURCE_HASH}`;

const NINE_FILES = [
  'tests/physics.test.js', 'tests/input.test.js', 'tests/station.test.js',
  'tests/simulation-state.test.js', 'tests/collision.test.js',
  'tests/game-loop.test.js', 'tests/automated-docking.test.js',
  'tests/renderer.test.js', 'tests/websocket-server.test.js',
];
const SEVEN_FILE_COMMAND = `node --test ${NINE_FILES.slice(0, 7).join(' ')}`;

// The outer runner's child-context var would silently mask red files inside
// any provider-spawned `node --test` (see the coverage-report tests); the
// factory orchestrator never runs under node:test. Scrub around each run.
async function withScrubbedTestContext(fn) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** The stage-11 shaped product repo: 9 test files, renderer + websocket red. */
function stage11Repo({ twoRed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saga-receipt-binding-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of NINE_FILES) {
    const red = twoRed && (file === 'tests/renderer.test.js'
      || file === 'tests/websocket-server.test.js');
    writeFileSync(join(root, file), red
      ? "const { test } = require('node:test');\ntest('red', () => { throw new Error('red on the merged bytes'); });\n"
      : "const { test } = require('node:test');\ntest('green', () => {});\n");
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'docking-simulation', version: '1.0.0',
    scripts: { test: `node --test ${NINE_FILES.join(' ')}` },
  }, null, 2));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'candidate');
  return root;
}

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_repositories(id INTEGER PRIMARY KEY, local_path TEXT);
    CREATE TABLE factory_process_products(
      process_run_id INTEGER, product_kind TEXT, schema_id TEXT,
      artifact_ref TEXT, product_hash TEXT, payload_snapshot TEXT
    );
    CREATE TABLE factory_managed_node_submissions(
      id INTEGER PRIMARY KEY, process_run_id INTEGER, schema_version TEXT,
      content_hash TEXT, payload_snapshot TEXT
    );
    CREATE TABLE factory_check_receipts(
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/** Seal the integrated-source product for the given commit of the repo. */
function insertSourceProduct(db, root) {
  const commitSha = gitCli(root, 'rev-parse', 'HEAD');
  const treeHash = gitCli(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (1,?)').run(root);
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    'development.integrated-source-candidate',
    INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
    SOURCE_REF,
    SOURCE_HASH,
    JSON.stringify({
      sourceHash: SOURCE_HASH,
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
    }),
  );
  return { commitSha, treeHash };
}

function insertManifestSubmission(db, id, { installCommand = null, testCommand }) {
  const digest = `${id}`.padStart(64, '0').slice(0, 63) + 'f';
  db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?)').run(
    id, PROCESS_RUN_ID, DEVELOPMENT_READINESS_MANIFEST_SCHEMA, digest,
    JSON.stringify({
      schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
      sourceCandidate: {
        hash: SOURCE_HASH, ref: SOURCE_REF, schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
      },
      targets: [{
        key: 'primary',
        readiness: { kind: 'static', commands: { installCommand, testCommand } },
      }],
    }),
  );
  return digest;
}

/** Author candidate-set reader over one manifest submission. */
function manifestReader(submissionId, digest) {
  return {
    read(ref) {
      if (ref !== `candidate-set/manifest-${submissionId}`) return null;
      return {
        candidateSetRef: ref,
        role: 'author',
        workplaceRef: {
          processRunId: PROCESS_RUN_ID,
          moduleRef: 'solution-development',
          productionCellId: 'development-readiness-certification',
          workKey: 'singleton',
        },
        members: [{
          productRef: {
            schemaId: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
            ref: `managed-node-submission:${submissionId}`,
            digest,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

/** Record a receipt the way the gate-run driver does after a provider run. */
function recordReceipt(db, { subjectRef, outcome, evidenceRefs, receiptRef }) {
  db.prepare(
    `INSERT INTO factory_check_receipts
       (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
        assessment_candidate_set_refs, provider_id, provider_version,
        provider_digest, environment_ref, outcome, evidence_refs, receipt_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    receiptRef,
    `gate-run:${receiptRef}`,
    subjectRef,
    '[]',
    LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
    '1.7.0',
    LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    null,
    outcome,
    JSON.stringify(evidenceRefs),
    `digest:${receiptRef}`,
  );
}

function providerRun(db, reader, subjectRef) {
  return withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
    db, candidateSets: reader,
  }).run({
    subjectCandidateSetRef: subjectRef,
    parameters: {},
    environmentRef: null,
    candidateSnapshot: {},
  }));
}

function subjectBindingRef(result) {
  return result.evidenceRefs.find(ref => ref.startsWith('local-readiness-subject:'));
}

test('D1: a failed receipt for the same bytes REPLAYS across manifest rounds — the narrowed command never executes', { timeout: 120000 }, async () => {
  // Round 1 (v1.1 shape): opaque npm test runs the honest 9-file suite; the
  // two red files fail it; the receipt (bound to the candidate bytes) lands.
  // Round 4 (v1.2 gaming shape): a NEW manifest with the 7-file enumeration
  // and the same sourceCandidate. The provider must return the PERSISTED
  // failed receipt verbatim — the gaming command is not executed at all, so
  // there is no exit-0 path left to hide behind.
  const root = stage11Repo({ twoRed: true });
  const db = newDb();
  const { commitSha, treeHash } = insertSourceProduct(db, root);
  const round1Digest = insertManifestSubmission(db, 1, { installCommand: 'npm install', testCommand: 'npm test' });
  const round4Digest = insertManifestSubmission(db, 10, { testCommand: SEVEN_FILE_COMMAND });
  try {
    const round1 = await providerRun(db, manifestReader(1, round1Digest), 'candidate-set/manifest-1');
    assert.equal(round1.outcome, 'failed', 'the honest 9-file run fails on the red bytes');
    const binding = subjectBindingRef(round1);
    assert.ok(binding, 'every real result must carry the subject binding');
    assert.equal(binding,
      `local-readiness-subject:${SOURCE_HASH}:${commitSha}:${treeHash}`);
    recordReceipt(db, {
      subjectRef: 'candidate-set/manifest-1',
      outcome: round1.outcome,
      evidenceRefs: [...round1.evidenceRefs],
      receiptRef: 'receipt:gate-run-1:1:provider',
    });

    // The gaming round: same bytes, new manifest ref.
    const round4 = await providerRun(db, manifestReader(10, round4Digest), 'candidate-set/manifest-10');
    assert.equal(round4.outcome, 'failed',
      'the receipt for the same bytes replays — certification cannot pass by rewriting the manifest');
    assert.deepEqual(round4.evidenceRefs, [...round1.evidenceRefs],
      'the replay must return the round-1 evidence verbatim (the narrowed command was never executed)');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1: same bytes with a failed AND a passed receipt is a typed structurally-impossible conflict -> failed', { timeout: 120000 }, async () => {
  // The stage-11 receipt history: rounds 1-3 failed for source 50f712ef…,
  // round 4 gamed a passed receipt for the SAME bytes. With receipts bound to
  // the candidate bytes, that history is visible and fails closed.
  const root = stage11Repo({ twoRed: true });
  const db = newDb();
  const { commitSha, treeHash } = insertSourceProduct(db, root);
  const round1Digest = insertManifestSubmission(db, 1, { testCommand: 'npm test' });
  const round4Digest = insertManifestSubmission(db, 10, { testCommand: SEVEN_FILE_COMMAND });
  try {
    const round1 = await providerRun(db, manifestReader(1, round1Digest), 'candidate-set/manifest-1');
    assert.equal(round1.outcome, 'failed');
    recordReceipt(db, {
      subjectRef: 'candidate-set/manifest-1',
      outcome: 'failed',
      evidenceRefs: [...round1.evidenceRefs],
      receiptRef: 'receipt:gate-run-1:1:provider',
    });
    // The historical gamed outcome: a PASSED receipt for the same bytes
    // under a different manifest ref (as the stage-11 DB held).
    recordReceipt(db, {
      subjectRef: 'candidate-set/manifest-10',
      outcome: 'passed',
      evidenceRefs: [
        'local-readiness:gamed-proof-bytes',
        `local-readiness-subject:${SOURCE_HASH}:${commitSha}:${treeHash}`,
      ],
      receiptRef: 'receipt:gate-run-4:1:provider',
    });

    const result = await providerRun(db, manifestReader(10, round4Digest), 'candidate-set/manifest-10');
    assert.equal(result.outcome, 'failed',
      'same bytes + previously failed + now passed must FAIL, not replay the pass');
    const diag = result.evidenceRefs.map(decodeCheckDiagnostic).find(d => d !== null);
    assert.ok(diag, 'the conflict must carry a decodable diagnostic');
    assert.equal(diag.code, 'READINESS_RECEIPT_CANDIDATE_CONFLICT');
    assert.match(diag.message, /structurally impossible/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1: different bytes are a genuinely new subject — a fixed candidate runs fresh and passes', { timeout: 120000 }, async () => {
  // The honest path out: the worker FIXES the code (new commit + tree, same
  // test universe). The bytes differ -> the binding differs -> no replay, no
  // conflict; the provider executes the fresh candidate's honest run.
  const root = stage11Repo({ twoRed: true });
  const db = newDb();
  const { commitSha, treeHash } = insertSourceProduct(db, root);
  const round1Digest = insertManifestSubmission(db, 1, { testCommand: 'npm test' });
  try {
    const round1 = await providerRun(db, manifestReader(1, round1Digest), 'candidate-set/manifest-1');
    assert.equal(round1.outcome, 'failed');
    recordReceipt(db, {
      subjectRef: 'candidate-set/manifest-1',
      outcome: 'failed',
      evidenceRefs: [...round1.evidenceRefs],
      receiptRef: 'receipt:gate-run-1:1:provider',
    });

    // The fix: make the two red files green, commit. A NEW source product for
    // the fixed bytes (the freeze kernel would seal a new candidate).
    for (const file of ['tests/renderer.test.js', 'tests/websocket-server.test.js']) {
      writeFileSync(join(root, file), "const { test } = require('node:test');\ntest('fixed green', () => {});\n");
    }
    gitCli(root, 'add', '.');
    gitCli(root, 'commit', '-m', 'fix the red tests');
    const fixedHash = '6'.repeat(64);
    const fixedCommit = gitCli(root, 'rev-parse', 'HEAD');
    const fixedTree = gitCli(root, 'rev-parse', 'HEAD^{tree}');
    assert.notEqual(fixedCommit, commitSha);
    db.prepare(
      `INSERT INTO factory_process_products
         (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      PROCESS_RUN_ID,
      'development.integrated-source-candidate',
      INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
      `development-integrated-source:${PROCESS_RUN_ID}:${fixedHash}`,
      fixedHash,
      JSON.stringify({
        sourceHash: fixedHash,
        repositories: [{ projectRepositoryId: 1, commitSha: fixedCommit, treeHash: fixedTree }],
      }),
    );
    const fixedDigest = (() => {
      const digest = '9'.repeat(64);
      db.prepare('INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?)').run(
        20, PROCESS_RUN_ID, DEVELOPMENT_READINESS_MANIFEST_SCHEMA, digest,
        JSON.stringify({
          schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
          sourceCandidate: {
            hash: fixedHash,
            ref: `development-integrated-source:${PROCESS_RUN_ID}:${fixedHash}`,
            schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
          },
          targets: [{
            key: 'primary',
            readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' } },
          }],
        }),
      );
      return digest;
    })();

    const fixed = await providerRun(db, manifestReader(20, fixedDigest), 'candidate-set/manifest-20');
    assert.equal(fixed.outcome, 'passed',
      'different bytes = new subject: the fixed candidate runs fresh and passes');
    const fixedBinding = subjectBindingRef(fixed);
    assert.ok(fixedBinding);
    assert.match(fixedBinding, new RegExp(fixedCommit));
    assert.notEqual(fixedBinding, `local-readiness-subject:${SOURCE_HASH}:${commitSha}:${treeHash}`);
    assert.equal(treeHash.length, 40); // shape sanity for the sealed triple
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
