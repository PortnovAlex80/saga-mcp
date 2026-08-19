// tests/infrastructure/local-runnability-coverage-report.test.mjs
//
// CERTIFICATION-GAMING-REMEDY M2-2 — ADDITIVE COVERAGE REPORT (report only,
// never enforcing).
//
// The empirical gaming this closes (stage-11, round 4): a certification
// candidate declared its own testCommand enumerating 7 of 9 test files —
// excluding exactly tests/renderer.test.js and tests/websocket-server.test.js
// — with zero code change; the gate ran the declaration, exit 0, accepted.
//
// These tests pin the M2-2 contract:
//   1. the provider reports which test files the canonical set contains
//      (derived from the SEALED tree: tests/** plus the sealed package.json
//      scripts.test enumeration) and which the DECLARATION actually runs;
//   2. an opaque `npm test` declaration resolves through the SEALED
//      package.json of the exact candidate (never the declaration's word);
//   3. the report is ADDITIVE ONLY — the outcome never changes because of
//      coverage (the 7-of-9 gaming still passes the check; the report makes
//      it visible instead);
//   4. an unresolvable opaque declaration reports "opaque" and fabricates no
//      executed/not-executed claims.
//
// The fixture reproduces the stage-11 shape: 9 test files under tests/, two of
// them red; the declaration enumerates the 7 green ones verbatim from the
// golden corpus fixture
// tests/fixtures/golden-corpus/stage11-docking-full/products/
// certify-product-readiness.factory.development-readiness-manifest.v1.2.json.

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
import { INTEGRATED_CANDIDATE_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

// HARNESS SCRUB — the outer node:test runner exports NODE_TEST_CONTEXT for the
// file it is executing; inherited by any provider-spawned `node --test`, that
// var turns the inner runner into a silent child (red files, exit 0, no
// output) — precisely the failure-masking this anti-gaming work exists to
// expose. The factory orchestrator never runs under node:test, so this is a
// TEST-HARNESS artifact only: scrub it around each provider invocation and
// restore it afterwards so the outer runner's own per-test reporting wiring
// stays intact.
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
const PRODUCT_KIND = 'development.integrated-candidate';

// The exact 7-of-9 testCommand of the stage-11 gaming manifest (verbatim,
// long line kept to mirror the fixture bytes).
const GAMING_TEST_COMMAND = 'node --test tests/physics.test.js tests/input.test.js tests/station.test.js tests/simulation-state.test.js tests/collision.test.js tests/game-loop.test.js tests/automated-docking.test.js';

const ALL_NINE = [
  'tests/physics.test.js',
  'tests/input.test.js',
  'tests/station.test.js',
  'tests/simulation-state.test.js',
  'tests/collision.test.js',
  'tests/game-loop.test.js',
  'tests/automated-docking.test.js',
  'tests/renderer.test.js',
  'tests/websocket-server.test.js',
];

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function greenTestFile(name) {
  return [
    `// ${name}`,
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    `test('${name} green', () => { assert.equal(1 + 1, 2); });`,
    '',
  ].join('\n');
}

function redTestFile(name) {
  return [
    `// ${name} — red on the merged bytes (stage-11: never green anywhere)`,
    "const { test } = require('node:test');",
    `test('${name} red', () => { throw new Error('${name} fails on the merged bytes'); });`,
    '',
  ].join('\n');
}

/**
 * Seed the stage-11 shaped product repo: 9 test files under tests/ (renderer +
 * websocket-server red when `twoRed`), a package.json whose scripts.test
 * enumerates exactly the 9 files (the frozen enumeration the worker copied
 * from), committed as the sealed candidate.
 */
function stage11Fixture({ twoRed = true, scriptsTest = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saga-readiness-coverage-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of ALL_NINE) {
    const name = file.split('/').pop();
    const red = twoRed && (file === 'tests/renderer.test.js'
      || file === 'tests/websocket-server.test.js');
    writeFileSync(join(root, file), red ? redTestFile(name) : greenTestFile(name));
  }
  const testScript = scriptsTest ?? `node --test ${ALL_NINE.join(' ')}`;
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'docking-simulation', version: '1.0.0',
    scripts: { test: testScript },
  }, null, 2));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'stage-11 shaped candidate');
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
    PRODUCT_KIND,
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

/** Find the decodable 'readiness-test-coverage' diagnostic in a result. */
function coverageDiagnostic(result) {
  for (const ref of result.evidenceRefs) {
    const diag = decodeCheckDiagnostic(ref);
    if (diag && diag.code === 'readiness-test-coverage') return diag;
  }
  return null;
}

test('M2-2: the 7-of-9 gaming passes the check but the coverage report names both unexecuted files', { timeout: 120000 }, async () => {
  // THE empirical shape: two red test files exist in the sealed tree; the
  // declaration enumerates exactly the 7 green ones (verbatim golden v1.2
  // testCommand). Report-only: the outcome stays 'passed' — M2-2 never
  // enforces — but the evidence now carries an X-of-Y report naming the two
  // excluded files. This alone would have made the stage-11 gaming visible.
  const root = stage11Fixture({ twoRed: true });
  const db = minimalDb(root, '5'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: GAMING_TEST_COMMAND },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('5'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'passed',
      'M2-2 is report-only: the narrowed run itself still passes (enforcement is later rollout steps)');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage, 'a decodable readiness-test-coverage diagnostic must ride the evidence');
    assert.match(coverage.message, /executed 7 of 9/u);
    assert.match(coverage.message, /tests\/renderer\.test\.js/u);
    assert.match(coverage.message, /tests\/websocket-server\.test\.js/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M2-2: an opaque "npm test" declaration resolves through the sealed package.json (9 of 9)', { timeout: 120000 }, async () => {
  // Round 1-3 of stage-11 declared opaque `npm test`. The canonical universe
  // and the executed set both derive from the SEALED tree (tests/** union the
  // sealed package.json scripts.test enumeration) — never from the
  // declaration's word. All 9 run and pass → 9 of 9, none missing.
  const root = stage11Fixture({ twoRed: false });
  const db = minimalDb(root, '6'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: 'npm test' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('6'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'passed');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage);
    assert.match(coverage.message, /executed 9 of 9/u);
    assert.match(coverage.message, /\(none\)/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M2-2: the report never enforces — a full 9-of-9 run of red bytes still fails for the command reason', { timeout: 120000 }, async () => {
  // The honest counterpart: the declaration runs ALL 9 (node --test over the
  // sealed enumeration), two are red → outcome 'failed' exactly as before.
  // The coverage report still rides the evidence (9 of 9) — additive on the
  // failure path too, changing nothing about the outcome.
  const root = stage11Fixture({ twoRed: true });
  const db = minimalDb(root, '7'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: `node --test ${ALL_NINE.join(' ')}` },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('7'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'failed');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage, 'the coverage report must also ride failed outcomes');
    assert.match(coverage.message, /executed 9 of 9/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M2-2: an unresolvable opaque declaration reports opaque and fabricates no coverage claims', { timeout: 60000 }, async () => {
  // `echo ok` executes no test file and cannot be resolved to one; the sealed
  // tree still contains 9 canonical test files. The report must SAY the
  // declaration is opaque and list the universe — it must not invent an
  // executed/not-executed diff it cannot know. The outcome stays 'passed'
  // (echo ok exits 0): report-only, again.
  const root = stage11Fixture({ twoRed: false });
  const db = minimalDb(root, '8'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: 'echo ok' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('8'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'passed');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage);
    assert.match(coverage.message, /opaque/u);
    assert.doesNotMatch(coverage.message, /executed \d+ of \d+/u,
      'an opaque declaration must not claim an executed count');
    assert.match(coverage.message, /9/u, 'the sealed-tree universe is still reported');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
