// tests/infrastructure/environment-derivation.test.mjs
//
// K19 train commits 2–3 core (ADR-083 §2.1/2.2) — the DERIVED EXECUTION
// ENVIRONMENT and the domain-free reproduction of the GDesign failure.
//
// The GDesign failure (WORKSHOP-CONTROL-TRACKING §1 L1(b)): the candidate
// declared `pip install numpy PyMuPDF openpyxl pytest`, the code imported
// `yaml`, the sterile container had no `pyyaml`, the run failed at the
// terminal — caught by luck, at the most expensive point. The negative test
// below reproduces the SHAPE domain-free: an invented package world, no
// Python, no pyyaml — a sealed tree whose source imports `orbital-mechanics`
// while every manifest and the declared install omit it. Derivation must
// catch it BEFORE any spawn, with the package named in a typed diagnostic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createLocalRunnabilityCheckProvider,
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  augmentInstallCommand,
  deriveExecutionEnvironment,
  installCommandPackages,
} from '../../dist/infrastructure/verification/environment-derivation.js';
import { INTEGRATED_CANDIDATE_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

async function withScrubbedTestContext(fn) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

const PROCESS_RUN_ID = 1;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/**
 * The domain-free GDesign shape. The artefact's source imports
 * `orbital-mechanics` (invented world — nothing from the real run); the
 * package.json declares other packages; the declared install names others
 * still. The need is real (the sealed bytes import it) and nobody declares
 * it — exactly the class the sterile container caught by luck.
 */
function undeclaredImportFixture() {
  const root = mkdtempSync(join(tmpdir(), 'saga-env-derivation-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', 'catalog.js'), [
    "// the artefact's honest need — no manifest declares it",
    "const orbital = require('orbital-mechanics');",
    'module.exports = { orbital };',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'tests', 'catalog.test.js'), [
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('catalog green', () => { assert.ok(true); });",
    '',
  ].join('\n'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'catalog-service', version: '1.0.0',
    dependencies: { 'chart-renderer': '^1.0.0' },
    scripts: { test: 'node --test tests/catalog.test.js' },
  }, null, 2));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'undeclared-import fixture');
  return root;
}

function minimalDb(root, candidateHash, readiness) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_repositories(id INTEGER PRIMARY KEY, local_path TEXT);
    CREATE TABLE factory_process_products(
      process_run_id INTEGER, product_kind TEXT, schema_id TEXT,
      artifact_ref TEXT, product_hash TEXT, payload_snapshot TEXT
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
  const commitSha = git(root, 'rev-parse', 'HEAD');
  const treeHash = git(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare('INSERT INTO project_repositories VALUES (?,?)').run(1, root);
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, schema_id, artifact_ref, product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID,
    'development.integrated-candidate',
    INTEGRATED_CANDIDATE_SCHEMA,
    `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
    candidateHash,
    JSON.stringify({
      candidateHash,
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
      readiness,
    }),
  );
  return db;
}

function readerFor(candidateHash) {
  return {
    read(ref) {
      if (ref !== 'candidate-set/test') return null;
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
            schemaId: INTEGRATED_CANDIDATE_SCHEMA,
            ref: `development-integrated-candidate:${PROCESS_RUN_ID}:${candidateHash}`,
            digest: candidateHash,
          },
          origin: 'produced', sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

const RUN_ARGS = {
  subjectCandidateSetRef: 'candidate-set/test', parameters: {},
  environmentRef: null, candidateSnapshot: {},
};

test('K19 derivation unit: the undeclared import is derived from the sealed bytes — orbital-mechanics named, manifests and install excluded', () => {
  const root = undeclaredImportFixture();
  try {
    const derived = deriveExecutionEnvironment({
      directory: root,
      installCommand: 'npm install chart-renderer telemetry-sink',
    });
    assert.ok(derived.scannedImports.includes('orbital-mechanics'),
      'the scanner derives the artefact\'s honest need from its bytes');
    assert.ok(derived.manifestPackages.includes('chart-renderer'));
    assert.deepEqual(derived.undeclaredImports, ['orbital-mechanics'],
      'exactly the GDesign gap: imported, declared nowhere');
    assert.match(derived.environmentDigest, /^[a-f0-9]{64}$/,
      'one immutable identity for the derived environment');
    // Additive augmentation: same runner, declared tokens verbatim, gap appended.
    assert.equal(
      augmentInstallCommand('npm install chart-renderer', ['orbital-mechanics']),
      'npm install chart-renderer orbital-mechanics',
    );
    assert.deepEqual(
      installCommandPackages('npm install chart-renderer telemetry-sink'),
      ['chart-renderer', 'telemetry-sink'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('K19 negative (domain-free GDesign): no install command + an undeclared import → caught BY DERIVATION before any spawn, typed and named', { timeout: 120000 }, async () => {
  const root = undeclaredImportFixture();
  const db = minimalDb(root, 'd'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: 'node --test tests/catalog.test.js' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('d'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'failed',
      'the undeclared need fails closed at derivation time');
    const diagnostic = result.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(diag => diag?.code === 'ENVIRONMENT_DERIVATION_UNDECLARED_NEED');
    assert.ok(diagnostic, 'the typed derivation diagnostic rides the evidence');
    assert.match(diagnostic.message, /orbital-mechanics/u,
      'the diagnostic NAMES the package the artefact needs and nobody declared');
    const environmentDiagnostic = result.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(diag => diag?.code === 'environment-derivation');
    assert.ok(environmentDiagnostic,
      'the derived environment identity rides the outcome as a decodable diagnostic');
    assert.match(environmentDiagnostic.message, /^derived environment [a-f0-9]{16}/u,
      'the immutable derived-environment identity is part of the evidence');
    assert.match(environmentDiagnostic.message, /orbital-mechanics/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('K19 negative, augment path: a declared install + an undeclared import → the derived environment AUGMENTS the install (additive), and the identity rides the outcome', { timeout: 120000 }, async () => {
  const root = undeclaredImportFixture();
  // The augmented install will run `npm install chart-renderer orbital-mechanics`
  // offline — it fails at the registry boundary, which is the honest outcome:
  // the derived environment TRIED to prepare the artefact's real need and the
  // environment could not provide it. The failure names the derivation.
  const db = minimalDb(root, 'e'.repeat(64), {
    kind: 'static',
    commands: { installCommand: 'npm install chart-renderer', testCommand: 'node --test tests/catalog.test.js' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('e'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'failed',
      'the augmented install fails honestly (the registry cannot provide the invented package) — the undeclared need was NOT hidden');
    const environmentDiagnostic = result.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(diag => diag?.code === 'environment-derivation');
    assert.ok(environmentDiagnostic);
    assert.match(environmentDiagnostic.message, /orbital-mechanics/u,
      'the derivation names the package the declaration omitted');
    assert.match(environmentDiagnostic.message, /install augmented to: npm install chart-renderer orbital-mechanics/u,
      'the augmentation is additive: declared tokens verbatim, the gap appended');
    const failure = result.evidenceRefs
      .map(decodeCheckDiagnostic)
      .find(diag => diag?.code === 'local-runnability');
    assert.ok(failure);
    assert.match(failure.message, /orbital-mechanics/u,
      'the executed (augmented) command and its real failure output are the outcome');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
