// tests/process-modules/readiness-gaming-red-replay.test.mjs
//
// THE negative test that defines TASK 2 done (stage-12 brief): replay the
// ACTUAL stage-11 certification gaming — verbatim golden-corpus manifest
// bytes — against the fixed certification path, with zero code change.
//
// The gaming (golden corpus README, "THIS IS A RED FIXTURE"): round 4 sealed
// a readiness manifest whose testCommand enumerates 7 of 9 test files —
// excluding exactly tests/renderer.test.js and
// tests/websocket-server.test.js, the two failing ones — for the SAME
// sourceCandidate 50f712ef…; the gate executed the declaration, exit 0,
// accepted. Rounds 1-3 had declared opaque `npm test`.
//
// WHAT THIS REPLAY ASSERTS (exactly what rollout steps 1-3 guarantee, no
// more):
//   Phase A — step 1 (M2-2, report-only): on a fresh store the narrowed
//   declaration still PASSES the runnability check itself (no enforcement by
//   design) but the coverage report is now decodable evidence: "executed 7 of
//   9", both excluded files named.
//   Phase B — steps 2+3 through the REAL certify-product-readiness plan:
//   round 1 (the v1.1 `npm test` fixture) runs the honest 9-file suite and
//   the gate verdict is FAILED (the red bytes fail); round 4 (the v1.2 gaming
//   fixture, same sourceCandidate, zero code change) does NOT pass
//   certification: the verdict is HUMAN_REQUIRED with a typed
//   READINESS_PROFILE_NARROWED receipt naming the dropped files, and the
//   runnability receipt is the REPLAYED round-1 FAILED receipt bound to the
//   same candidate bytes — the narrowed command is never executed.
//
// WHAT THIS REPLAY DELIBERATELY DOES NOT CLAIM: the runnability provider
// still executes a fresh declaration verbatim on fresh bytes (Phase A proves
// the report-only boundary). The derived-canonical core (rollout step 4,
// reserved to the architect): the executed command will be derived from the
// order/sealed tree, not the candidate's declaration, and manifest
// declarations become additive-only — until then a FIRST-submission narrowed
// declaration on never-before-checked bytes passes with the gap only
// REPORTED (visible), which is exactly the step-1 contract.
//
// Fixture provenance: the two manifest files are the ACTUAL harvested bytes
// (tests/fixtures/golden-corpus/stage11-docking-full/products/). The sealed
// source TREE is a stage-11-shaped reconstruction (9 test files, the two
// excluded ones red, package.json scripts.test enumerating all 9) — the
// original product repository is not part of the corpus; the manifests'
// sourceCandidate ref/hash are used verbatim and the source product binds
// them to the reconstructed tree's commit/tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { FactoryCheckProviderRegistry } from '../../dist/process-modules/application/standard-check-providers.js';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import { createDevelopmentReadinessMonotonicityCheckProvider, DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID } from '../../dist/modules/development/application/development-check-providers.js';
import { createGitPort } from '../../dist/infrastructure/process-modules/git-machine-ports.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const CORPUS = join('tests', 'fixtures', 'golden-corpus', 'stage11-docking-full', 'products');
const PRIOR_MANIFEST = JSON.parse(readFileSync(
  join(CORPUS, 'certify-product-readiness.factory.development-readiness-manifest.v1.1.json'),
  'utf8',
));
const GAMING_MANIFEST = JSON.parse(readFileSync(
  join(CORPUS, 'certify-product-readiness.factory.development-readiness-manifest.v1.2.json'),
  'utf8',
));

const PROCESS_RUN_ID = 3;
const SOURCE_HASH = GAMING_MANIFEST.sourceCandidate.hash;
const SOURCE_REF = GAMING_MANIFEST.sourceCandidate.ref;

const NINE_FILES = [
  'tests/physics.test.js', 'tests/input.test.js', 'tests/station.test.js',
  'tests/simulation-state.test.js', 'tests/collision.test.js',
  'tests/game-loop.test.js', 'tests/automated-docking.test.js',
  'tests/renderer.test.js', 'tests/websocket-server.test.js',
];

// Fixture sanity: the gaming manifest is the 7-of-9 shape the brief names.
assert.equal(GAMING_MANIFEST.targets[0].readiness.commands.testCommand,
  `node --test ${NINE_FILES.slice(0, 7).join(' ')}`,
  'the golden v1.2 fixture must enumerate exactly the 7 green files');
assert.equal(PRIOR_MANIFEST.targets[0].readiness.commands.testCommand, 'npm test');
assert.equal(PRIOR_MANIFEST.sourceCandidate.hash, SOURCE_HASH,
  'the prior v1.1 fixture names the SAME sourceCandidate (zero code change)');

// The outer runner's child-context var would silently mask red files inside
// any provider-spawned `node --test`; the factory orchestrator never runs
// under node:test. Scrub around every provider/gate invocation.
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

/** The stage-11 shaped sealed tree: 9 test files, renderer + websocket RED. */
function stage11Tree() {
  const root = mkdtempSync(join(tmpdir(), 'saga-gaming-replay-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of NINE_FILES) {
    const red = file === 'tests/renderer.test.js' || file === 'tests/websocket-server.test.js';
    writeFileSync(join(root, file), red
      ? "const { test } = require('node:test');\ntest('red', () => { throw new Error('red on the merged bytes'); });\n"
      : "const { test } = require('node:test');\ntest('green', () => {});\n");
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'docking-simulation', version: '1.0.0',
    scripts: { test: `node --test ${NINE_FILES.join(' ')}` },
  }, null, 2));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'stage-11 shaped candidate');
  return root;
}

/** Full factory schema + the product/submission store shapes. */
function fullSchemaDb(root) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      product_kind TEXT NOT NULL,
      product_key TEXT NOT NULL DEFAULT '',
      schema_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      product_hash TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (process_run_id, product_kind, product_key)
    );
    CREATE TABLE IF NOT EXISTS factory_managed_node_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (process_run_id, node_id, execution_id)
    );
  `);
  db.prepare(
    'INSERT INTO project_repositories (id, project_id, repository_id, local_path) VALUES (1, 1, 1, ?)',
  ).run(root);
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, product_key, schema_id, artifact_ref,
        product_hash, payload_snapshot, payload_hash)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID, 'development.integrated-source-candidate',
    'development.integrated-source-candidate',
    INTEGRATED_SOURCE_CANDIDATE_SCHEMA, SOURCE_REF, SOURCE_HASH,
    JSON.stringify({
      sourceHash: SOURCE_HASH,
      repositories: [{
        projectRepositoryId: 1,
        commitSha: gitCli(root, 'rev-parse', 'HEAD'),
        treeHash: gitCli(root, 'rev-parse', 'HEAD^{tree}'),
      }],
    }),
    SOURCE_HASH,
  );
  return db;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function insertManifestSubmission(db, id, manifest) {
  const digest = sha256(manifest);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, `worker-execution:round-${id}`,
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    JSON.stringify(manifest),
    digest,
  );
  return digest;
}

function manifestReader(submissionId, digest) {
  const subjectRef = `candidate-set/manifest-${submissionId}`;
  return {
    subjectRef,
    read(ref) {
      if (ref !== subjectRef) return null;
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

const CERTIFY_PLAN = developmentProcessModule.flow.nodes
  .find(node => node.id === 'certify-product-readiness')
  .cellDefinition.authorGate.checkPlan;

function driveCertificationGate(db, candidateSets, subjectRef) {
  const registry = new FactoryCheckProviderRegistry();
  registry.register(createDevelopmentReadinessMonotonicityCheckProvider({
    db, candidateSets, git: createGitPort(),
  }));
  registry.register(createLocalRunnabilityCheckProvider({ db, candidateSets }));
  return withScrubbedTestContext(() => driveGateRun(new SqliteGateRepository(db), registry, {
    workplaceRef: {
      processRunId: PROCESS_RUN_ID,
      moduleRef: 'solution-development',
      productionCellId: 'development-readiness-certification',
      workKey: 'singleton',
    },
    subjectCandidateSetRef: subjectRef,
    checkPlan: CERTIFY_PLAN,
    gatePhase: 'final',
    expectedWorkplaceRevision: 1,
    gateLeaseRef: `gate-lease:${subjectRef}`,
    installationDigest: 'installation:test',
    checkParameters: { processRunId: PROCESS_RUN_ID },
    environmentRef: null,
    presentationRef: `worker-execution:${subjectRef}`,
  }));
}

test('RED replay: the golden 7-of-9 gaming manifest cannot pass certification — it escalates and replays the failed receipt', { timeout: 180000 }, async () => {
  const root = stage11Tree();
  try {
    // -----------------------------------------------------------------
    // Phase A — step 1 only (fresh store, no receipts): the narrowed
    // declaration passes the runnability check itself (report-only, by
    // design) and the coverage gap is decodable evidence naming both files.
    // -----------------------------------------------------------------
    {
      const db = fullSchemaDb(root);
      const digest = insertManifestSubmission(db, 10, GAMING_MANIFEST);
      const reader = manifestReader(10, digest);
      const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
        db, candidateSets: reader,
      }).run({
        subjectCandidateSetRef: reader.subjectRef,
        parameters: {}, environmentRef: null, candidateSnapshot: {},
      }));
      assert.equal(result.outcome, 'passed',
        'M2-2 is report-only: on never-before-checked bytes the narrowed run passes the check itself');
      const coverage = result.evidenceRefs
        .map(decodeCheckDiagnostic)
        .find(diag => diag?.code === 'readiness-test-coverage');
      assert.ok(coverage, 'the coverage report must ride the gaming outcome');
      assert.match(coverage.message, /executed 7 of 9/u);
      assert.match(coverage.message, /tests\/renderer\.test\.js/u);
      assert.match(coverage.message, /tests\/websocket-server\.test\.js/u);
      db.close();
    }

    // -----------------------------------------------------------------
    // Phase B — the full certification path with the real history:
    // round 1 (v1.1 `npm test`) runs the honest suite and FAILS the gate;
    // round 4 (the v1.2 gaming manifest, same sourceCandidate, zero code
    // change) must NOT pass certification.
    // -----------------------------------------------------------------
    const db = fullSchemaDb(root);
    const round1Digest = insertManifestSubmission(db, 1, PRIOR_MANIFEST);

    // Round 1: the honest 9-file suite over red bytes. (Round 4's submission
    // is sealed only AFTER this gate has run — chronological, as in the real
    // run; the ratchet reads submission history by id order.)
    const round1 = manifestReader(1, round1Digest);
    const round1Decision = await driveCertificationGate(db, round1, round1.subjectRef);
    assert.equal(round1Decision.decision.verdict, 'failed',
      'the honest full run fails the gate on the red bytes (upstream-owned failure)');
    const round1Runnability = round1Decision.receipts.find(
      receipt => receipt.check.providerId === 'factory.local-runnability.v1');
    assert.equal(round1Runnability.outcome, 'failed');

    // Round 4: the gaming replay — same bytes, new narrowed manifest.
    const round4Digest = insertManifestSubmission(db, 10, GAMING_MANIFEST);
    const round4 = manifestReader(10, round4Digest);
    const round4Decision = await driveCertificationGate(db, round4, round4.subjectRef);

    // Step 2 — the ESCALATION: human_required, never accepted, never a plain
    // failure the worker could "repair" by rewriting the manifest again.
    assert.equal(round4Decision.decision.verdict, 'human_required',
      'the narrowed round must ESCALATE (complete-blocked), not pass');
    const narrowing = round4Decision.receipts.find(
      receipt => receipt.check.providerId === DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID);
    assert.ok(narrowing, 'the monotonicity receipt must exist in the plan run');
    assert.equal(narrowing.outcome, 'unknown');
    const narrowingDiag = narrowing.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(diag => diag !== null);
    assert.equal(narrowingDiag.code, 'READINESS_PROFILE_NARROWED');
    assert.match(narrowingDiag.message, /tests\/renderer\.test\.js/u);
    assert.match(narrowingDiag.message, /tests\/websocket-server\.test\.js/u);
    assert.match(narrowingDiag.message, /submission 1/u,
      'the diff names the prior declaration it narrowed against');

    // Step 3 — the receipt bound to the bytes: the round-4 runnability
    // receipt is the REPLAYED round-1 FAILED receipt (evidence identical),
    // so the narrowed command was never executed and no exit-0 evidence for
    // these bytes can exist.
    const round4Runnability = round4Decision.receipts.find(
      receipt => receipt.check.providerId === 'factory.local-runnability.v1');
    assert.equal(round4Runnability.outcome, 'failed',
      'same candidate bytes: the round-1 failed receipt replays (D1)');
    assert.deepEqual(round4Runnability.evidenceRefs, round1Runnability.evidenceRefs,
      'the replay is verbatim — the gaming command never ran');
    assert.ok(round1Runnability.evidenceRefs.some(
      ref => ref.startsWith(`local-readiness-subject:${SOURCE_HASH}:`)),
      'the round-1 receipt carries the candidate-bytes binding');

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
