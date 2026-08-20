// tests/process-modules/readiness-profile-monotonicity.test.mjs
//
// CERTIFICATION-GAMING-REMEDY step 2 — M1-a monotonicity ratchet + D2
// declaration-diff escalation.
//
// The declared verification surface of a readiness manifest may never SHRINK
// relative to a previous readiness manifest of the SAME sourceCandidate, and
// any change of readiness.commands.* on the same sourceCandidate is an
// ESCALATION (human_required), never a silent retry. A shrink is not a gate
// failure — the worker did nothing malformed — so the verdict must be
// human_required (the cell's complete-blocked transition), typed
// READINESS_PROFILE_NARROWED with the diff named; a non-shrinking change is
// typed READINESS_DECLARATION_CHANGED (D2).
//
// The stage-11 shape this pins: rounds 1-3 declared opaque `npm test` on
// sourceCandidate 50f712ef…; round 4 declared the 7-of-9 enumeration
// (excluding exactly tests/renderer.test.js and tests/websocket-server.test.js
// with zero code change) and the gate ran it silently. With this provider in
// the READINESS plan that round is a human_required escalation.
//
// Boundary (deliberate, closes only with the derived-canonical step 4): a
// manifest for a DIFFERENT sourceCandidate is not compared — narrowing across
// a candidate change may be legitimate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  createDevelopmentReadinessMonotonicityCheckProvider,
  DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID,
} from '../../dist/modules/development/application/development-check-providers.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const PROCESS_RUN_ID = 3;
const SOURCE_HASH = '50f712ef48f7f0b0db16cc5502161c0086c69e34085bfe54ed9d0f4e853ac8d0';
const SOURCE_REF = `development-integrated-source:${PROCESS_RUN_ID}:${SOURCE_HASH}`;
const COMMIT_SHA = 'e'.repeat(40);

const SEVEN_FILE_COMMAND = 'node --test tests/physics.test.js tests/input.test.js tests/station.test.js tests/simulation-state.test.js tests/collision.test.js tests/game-loop.test.js tests/automated-docking.test.js';
const NINE_FILES = [
  'tests/physics.test.js', 'tests/input.test.js', 'tests/station.test.js',
  'tests/simulation-state.test.js', 'tests/collision.test.js',
  'tests/game-loop.test.js', 'tests/automated-docking.test.js',
  'tests/renderer.test.js', 'tests/websocket-server.test.js',
];

function manifestPayload({ installCommand = null, testCommand }, sourceHash = SOURCE_HASH) {
  return {
    schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: {
      hash: sourceHash,
      ref: `development-integrated-source:${PROCESS_RUN_ID}:${sourceHash}`,
      schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
    },
    targets: [{
      key: 'primary',
      readiness: { kind: 'static', commands: { installCommand, testCommand } },
    }],
  };
}

/** Minimal store: submissions + sealed source product + repository binding. */
function monotonicityDb({ sealedPackageJsonScriptsTest = null } = {}) {
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
  `);
  db.prepare('INSERT INTO project_repositories VALUES (1,?)').run('C:/repos/product');
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
      repositories: [{ projectRepositoryId: 1, commitSha: COMMIT_SHA, treeHash: 'a'.repeat(40) }],
    }),
  );
  // The sealed package.json of the exact source candidate (git show
  // <commitSha>:package.json): scripts.test enumerates the 9 files — the
  // frozen enumeration the stage-11 worker copied from and then trimmed.
  const packageJson = sealedPackageJsonScriptsTest === null
    ? null
    : JSON.stringify({
      name: 'docking-simulation', version: '1.0.0',
      scripts: { test: sealedPackageJsonScriptsTest },
    });
  const git = {
    read(repoPath, args) {
      assert.equal(repoPath, 'C:/repos/product');
      if (args.join(' ') === `show ${COMMIT_SHA}:package.json`) return packageJson;
      return null;
    },
    ok: () => true,
  };
  return { db, git };
}

function insertManifestSubmission(db, id, payload) {
  const digest = `${id}`.padStart(64, '0').slice(0, 63) + 'f';
  db.prepare(
    'INSERT INTO factory_managed_node_submissions VALUES (?,?,?,?,?)',
  ).run(id, PROCESS_RUN_ID, DEVELOPMENT_READINESS_MANIFEST_SCHEMA, digest, JSON.stringify(payload));
  return digest;
}

function readerForCurrent(digest) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/current') return null;
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
            ref: `managed-node-submission:10`,
            digest,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

function runArgs() {
  return {
    subjectCandidateSetRef: 'candidate-set/current',
    parameters: { processRunId: PROCESS_RUN_ID },
    environmentRef: null,
    candidateSnapshot: {},
  };
}

function decodedCode(result) {
  for (const ref of result.evidenceRefs ?? []) {
    const diag = decodeCheckDiagnostic(ref);
    if (diag) return diag;
  }
  return null;
}

/** Providers may return a bare outcome string ('passed') — normalize. */
function outcomeOf(result) {
  return typeof result === 'string' ? result : result.outcome;
}

test('M1-a: opaque npm test -> 7-of-9 enumeration on the same sourceCandidate escalates READINESS_PROFILE_NARROWED with the dropped files named', () => {
  // The exact stage-11 round-4 transition: rounds 1-3 declared `npm test`
  // (v1.1 manifest shape), round 4 declared the 7-file enumeration with zero
  // code change. The opaque prior resolves through the sealed package.json
  // (9 files) -> the narrowing is mechanical: 9 -> 7, renderer + websocket
  // dropped.
  const { db, git } = monotonicityDb({
    sealedPackageJsonScriptsTest: `node --test ${NINE_FILES.join(' ')}`,
  });
  insertManifestSubmission(db, 1, manifestPayload({ installCommand: 'npm install', testCommand: 'npm test' }));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'unknown', 'a shrink is an escalation (human_required), not a pass and not a failure');
    const diag = decodedCode(result);
    assert.ok(diag);
    assert.equal(diag.code, 'READINESS_PROFILE_NARROWED');
    assert.match(diag.message, /tests\/renderer\.test\.js/u);
    assert.match(diag.message, /tests\/websocket-server\.test\.js/u);
  } finally {
    db.close();
  }
});

test('M1-a: explicit 9-file -> explicit 7-file enumeration escalates READINESS_PROFILE_NARROWED', () => {
  const { db, git } = monotonicityDb({ sealedPackageJsonScriptsTest: `node --test ${NINE_FILES.join(' ')}` });
  insertManifestSubmission(db, 1, manifestPayload({ testCommand: `node --test ${NINE_FILES.join(' ')}` }));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'unknown');
    const diag = decodedCode(result);
    assert.ok(diag);
    assert.equal(diag.code, 'READINESS_PROFILE_NARROWED');
    assert.match(diag.message, /tests\/renderer\.test\.js/u);
  } finally {
    db.close();
  }
});

test('D2: a command change that is NOT a shrink still escalates READINESS_DECLARATION_CHANGED — never a silent retry', () => {
  // Even widening (prior 7 files -> current 9 files) is a declaration change
  // on the same sourceCandidate: D2 demands a human looks at it, because the
  // worker changed what the gate will execute without changing the bytes.
  const { db, git } = monotonicityDb({ sealedPackageJsonScriptsTest: `node --test ${NINE_FILES.join(' ')}` });
  insertManifestSubmission(db, 1, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: `node --test ${NINE_FILES.join(' ')}` }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'unknown');
    const diag = decodedCode(result);
    assert.ok(diag);
    assert.equal(diag.code, 'READINESS_DECLARATION_CHANGED');
  } finally {
    db.close();
  }
});

test('identical commands on the same sourceCandidate pass (a byte-identical resubmission is not an escalation)', () => {
  const { db, git } = monotonicityDb({ sealedPackageJsonScriptsTest: `node --test ${NINE_FILES.join(' ')}` });
  insertManifestSubmission(db, 1, manifestPayload({ testCommand: 'npm test' }));
  insertManifestSubmission(db, 2, manifestPayload({ testCommand: 'npm test' }));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: 'npm test' }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'passed');
  } finally {
    db.close();
  }
});

test('a manifest for a DIFFERENT sourceCandidate is not compared (first certification of new bytes)', () => {
  // Documented boundary: narrowing across a sourceCandidate change may be
  // legitimate (the code changed); only the derived-canonical step 4 closes
  // it. Same workplace history, different bytes -> no comparison.
  const { db, git } = monotonicityDb({ sealedPackageJsonScriptsTest: `node --test ${NINE_FILES.join(' ')}` });
  const otherHash = 'c'.repeat(64);
  insertManifestSubmission(db, 1, manifestPayload({ testCommand: `node --test ${NINE_FILES.join(' ')}` }, otherHash));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'passed');
  } finally {
    db.close();
  }
});

test('the first readiness manifest ever (no priors) passes', () => {
  const { db, git } = monotonicityDb();
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'passed');
  } finally {
    db.close();
  }
});

test('deterministic without git: an unreadable sealed package.json still catches the change via declaration-diff', () => {
  // git.show fails (null): the opaque prior cannot be resolved, so NARROWED
  // is not provable — but the commands still CHANGED on the same
  // sourceCandidate, and D2 catches that deterministically. The belt does
  // not depend on the substrate being readable.
  const { db, git } = monotonicityDb({ sealedPackageJsonScriptsTest: null });
  insertManifestSubmission(db, 1, manifestPayload({ testCommand: 'npm test' }));
  const currentDigest = insertManifestSubmission(db, 10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }));
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets: readerForCurrent(currentDigest), git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'unknown');
    const diag = decodedCode(result);
    assert.ok(diag);
    assert.equal(diag.code, 'READINESS_DECLARATION_CHANGED');
  } finally {
    db.close();
  }
});

test('a subject that is not a single readiness-manifest author set fails typed, not silently', () => {
  const { db, git } = monotonicityDb();
  try {
    const result = createDevelopmentReadinessMonotonicityCheckProvider({
      db,
      candidateSets: {
        read: (ref) => ref === 'candidate-set/current' ? {
          candidateSetRef: ref,
          role: 'reviewer',
          workplaceRef: {
            processRunId: PROCESS_RUN_ID, moduleRef: 'm',
            productionCellId: 'c', workKey: 'w',
          },
          members: [],
        } : null,
      },
      git,
    }).run(runArgs());
    assert.equal(outcomeOf(result), 'error');
    assert.ok(decodedCode(result), 'the error must carry a decodable diagnostic');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// GATE INTEGRATION — the REAL readiness-certification check plan (from the
// installed process module) drives the escalation to a human_required verdict
// through the real gate-run driver and receipt store.
// ---------------------------------------------------------------------------

test('the REAL certify-product-readiness plan escalates the narrowed round to verdict human_required', { timeout: 120000 }, async () => {
  const { SCHEMA_SQL } = await import('../../dist/schema.js');
  const { SqliteGateRepository } = await import('../../dist/infrastructure/workplace/sqlite-gate-repository.js');
  const { driveGateRun } = await import('../../dist/process-modules/application/gate-run-driver.js');
  const { FactoryCheckProviderRegistry } = await import('../../dist/process-modules/application/standard-check-providers.js');
  const { createLocalRunnabilityCheckProvider } = await import('../../dist/infrastructure/verification/local-runnability-check-provider.js');
  const { createGitPort } = await import('../../dist/infrastructure/process-modules/git-machine-ports.js');
  const { developmentProcessModule } = await import('../../dist/process-modules/modules/development/development-process-module.js');

  // Real product repo: 9 test files (renderer + websocket-server red), sealed
  // package.json scripts.test enumerating all 9 — the honest universe.
  const gitCli = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const root = mkdtempSync(join(tmpdir(), 'saga-monotonicity-gate-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of NINE_FILES) {
    const red = file === 'tests/renderer.test.js' || file === 'tests/websocket-server.test.js';
    writeFileSync(join(root, file), red
      ? "const { test } = require('node:test');\ntest('red', () => { throw new Error('red'); });\n"
      : "const { test } = require('node:test');\ntest('green', () => {});\n");
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'docking-simulation', version: '1.0.0',
    scripts: { test: `node --test ${NINE_FILES.join(' ')}` },
  }, null, 2));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'candidate');
  const commitSha = gitCli(root, 'rev-parse', 'HEAD');
  const treeHash = gitCli(root, 'rev-parse', 'HEAD^{tree}');

  // Full factory schema (gate runs, receipts, decisions, submissions).
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  // The product/submission stores create their own tables via their ensure
  // functions (not part of SCHEMA_SQL); the providers read exactly these
  // shapes. project_repositories requires its project binding column.
  const { ensureFactoryProcessProductSchema } = await import('../../dist/process-modules/persistence/sqlite-process-product-repository.js');
  const { ensureManagedNodeSubmissionSchema } = await import('../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js');
  ensureFactoryProcessProductSchema(db);
  ensureManagedNodeSubmissionSchema(db);
  db.prepare('INSERT INTO project_repositories (id, project_id, repository_id, local_path) VALUES (1, 1, 1, ?)').run(root);
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
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
    }),
    SOURCE_HASH,
  );
  // Full-schema submissions carry the managed-execution provenance columns
  // (NOT NULL in the real DDL; inert here — the gate path never reads them).
  const insertFullSubmission = (id, payload) => {
    const digest = `${id}`.padStart(64, '0').slice(0, 63) + 'f';
    db.prepare(
      `INSERT INTO factory_managed_node_submissions
         (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
          schema_version, payload_snapshot, content_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
      1, 1, `worker-execution:round-${id}`,
      DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(payload), digest,
    );
    return digest;
  };
  insertFullSubmission(1, manifestPayload({ installCommand: 'npm install', testCommand: 'npm test' }));
  const currentDigest = insertFullSubmission(
    10, manifestPayload({ testCommand: SEVEN_FILE_COMMAND }),
  );
  // The current manifest's author candidate set (stub reader; the providers
  // resolve members through it exactly as in production wiring).
  const candidateSets = {
    read: (ref) => ref === 'candidate-set/current' ? {
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
          ref: 'managed-node-submission:10',
          digest: currentDigest,
        },
        origin: 'produced', sourceCandidateSetRef: null,
      }],
    } : null,
  };

  const registry = new FactoryCheckProviderRegistry();
  registry.register(createDevelopmentReadinessMonotonicityCheckProvider({
    db, candidateSets, git: createGitPort(),
  }));
  registry.register(createLocalRunnabilityCheckProvider({ db, candidateSets }));

  // THE REAL PLAN of the installed development module's certification cell.
  const node = developmentProcessModule.flow.nodes.find(n => n.id === 'certify-product-readiness');
  assert.ok(node?.cellDefinition?.authorGate?.checkPlan, 'the certification cell must expose its check plan');
  const plan = node.cellDefinition.authorGate.checkPlan;
  assert.ok(plan.entries.some(e => e.check.providerId === DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID),
    'the monotonicity provider must sit in the REAL readiness-certification plan');

  // Scrub the outer runner's child-context var so the provider-spawned
  // `node --test` behaves as in production (see the coverage-report tests).
  const savedContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let decision;
  let receipts;
  try {
    const gateRepo = new SqliteGateRepository(db);
    const driven = driveGateRun(gateRepo, registry, {
      workplaceRef: {
        processRunId: PROCESS_RUN_ID,
        moduleRef: 'solution-development',
        productionCellId: 'development-readiness-certification',
        workKey: 'singleton',
      },
      subjectCandidateSetRef: 'candidate-set/current',
      checkPlan: plan,
      gatePhase: 'final',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'gate-lease:test',
      installationDigest: 'installation:test',
      checkParameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null,
      presentationRef: 'worker-execution:test',
    });
    decision = driven.decision;
    receipts = driven.receipts;
  } finally {
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
  }

  assert.equal(decision.verdict, 'human_required',
    'the narrowed round must ESCALATE to human_required (complete-blocked), not pass and not fail');
  const monotonicityReceipt = receipts.find(
    r => r.check.providerId === DEVELOPMENT_READINESS_MONOTONICITY_CHECK_PROVIDER_ID);
  assert.ok(monotonicityReceipt, 'the monotonicity receipt must exist in the plan run');
  assert.equal(monotonicityReceipt.outcome, 'unknown');
  const diag = decodedCode(monotonicityReceipt);
  assert.ok(diag);
  assert.equal(diag.code, 'READINESS_PROFILE_NARROWED');

  db.close();
  rmSync(root, { recursive: true, force: true });
});
