// tests/infrastructure/local-runnability-derived-canonical.test.mjs
//
// CERTIFICATION-GAMING-REMEDY M1-b (rollout step 4) — DERIVED-CANONICAL
// EXECUTED CHECK SET. The executed set is derived from the order (the sealed
// tree); the candidate's declaration is ADDITIVE ONLY — it may add test
// files, never remove or replace the canonical ones.
//
// THE NEGATIVE TEST THAT DEFINES DONE: a declaration enumerating 7 of 9 test
// files, excluding exactly the two red ones, zero code change — the stage-11
// gaming shape verbatim. Before step 4 this PASSED (the M2-2 report made it
// visible but enforced nothing). After step 4 it MUST NOT PASS: the gate
// derives the executed command by extending the declaration's own runner
// with the excluded canonical files, they run, and the check fails on their
// real red output.
//
// Domain-free fixture note: the file universe is the stage-11 docking corpus
// shape (tests/*.test.js under node --test) — the DERIVATION itself knows
// nothing about node or npm beyond the declared runner string; the surgery
// preserves whatever runner the declaration states.

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

// HARNESS SCRUB — see local-runnability-coverage-report.test.mjs: an
// inherited NODE_TEST_CONTEXT would turn the provider-spawned `node --test`
// into a silent child (red files, exit 0) — precisely the masking this
// anti-gaming work exists to expose.
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
const RED_FILES = ['tests/renderer.test.js', 'tests/websocket-server.test.js'];
const SEVEN_GREEN = ALL_NINE.filter(file => !RED_FILES.includes(file));
const GAMING_TEST_COMMAND = `node --test ${SEVEN_GREEN.join(' ')}`;

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

function fixture({ twoRed, scriptsTest }) {
  const root = mkdtempSync(join(tmpdir(), 'saga-readiness-derived-canonical-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const file of ALL_NINE) {
    const name = file.split('/').pop();
    const red = twoRed && RED_FILES.includes(file);
    writeFileSync(join(root, file), red ? redTestFile(name) : greenTestFile(name));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'docking-simulation', version: '1.0.0',
    scripts: { test: scriptsTest ?? `node --test ${ALL_NINE.join(' ')}` },
  }, null, 2));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'derived-canonical fixture candidate');
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

function coverageDiagnostic(result) {
  for (const ref of result.evidenceRefs) {
    const diag = decodeCheckDiagnostic(ref);
    if (diag && diag.code === 'readiness-test-coverage') return diag;
  }
  return null;
}
function failureDiagnostic(result) {
  for (const ref of result.evidenceRefs) {
    const diag = decodeCheckDiagnostic(ref);
    if (diag && diag.code === 'local-runnability') return diag;
  }
  return null;
}

test('M1-b step 4: the 7-of-9 gaming declaration MUST NOT PASS — the gate derives the canonical set and the excluded red files run', { timeout: 120000 }, async () => {
  // THE defining negative test. The declaration enumerates exactly the 7
  // green files and excludes exactly the 2 red ones, zero code change.
  // Before step 4: passed (report-only). After: the executed command is the
  // declaration's own runner EXTENDED with tests/renderer.test.js and
  // tests/websocket-server.test.js; they run, they fail, the check fails on
  // their real output, and the evidence names both the derivation and the
  // failure.
  const root = fixture({ twoRed: true });
  const db = minimalDb(root, 'a'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: GAMING_TEST_COMMAND },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('a'.repeat(64)),
    }).run(RUN_ARGS));
    assert.notEqual(result.outcome, 'passed',
      'a declaration excluding exactly the red canonical files must not pass');
    assert.equal(result.outcome, 'failed');
    const failure = failureDiagnostic(result);
    assert.ok(failure, 'the failure rides a decodable diagnostic');
    assert.match(failure.message, /renderer/u,
      'the real red output of an excluded file must be part of the failure');
    assert.match(failure.message, /websocket-server/u);
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage);
    assert.match(coverage.message, /gate DERIVED the executed command from the sealed tree/u);
    assert.match(coverage.message, /tests\/renderer\.test\.js/u);
    assert.match(coverage.message, /tests\/websocket-server\.test\.js/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M1-b step 4: additive declarations are honored — enumerating all 9 passes, and an EXTRA declared file beyond canonical still runs', { timeout: 120000 }, async () => {
  // Additivity is the honest half of the rule: a declaration that covers the
  // canonical set (or adds a NEW file the tree also contains) is executed
  // VERBATIM — its own runner, its own order — and passes on green bytes.
  const root = fixture({ twoRed: false });
  // The extra file exists in the sealed tree but NOT in the canonical
  // universe's default derivation? tests/** IS canonical — so use an extra
  // file under tests/ (canonical by tree) and one the declaration adds that
  // canonical already includes; the point is the full-enumeration case.
  const db = minimalDb(root, 'b'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: `node --test ${ALL_NINE.join(' ')}` },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('b'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'passed',
      'a full-coverage enumeration is honored verbatim');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage);
    assert.doesNotMatch(coverage.message, /gate DERIVED/u,
      'no derivation — the declaration was honored as stated');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CC-GLOB-SURFACE: a whole-tree tests glob declaration is honored verbatim — directory coverage, executed 21 of 21, NO duplicate explicit appends', { timeout: 120000 }, async () => {
  // The Elite-6 shape, live: the declaration AND the sealed package.json
  // scripts.test both state `node --test tests/**/*.test.js`; the sealed
  // tree holds 21 green test files under tests/. The glob already denotes
  // the whole tests tree, so:
  //   - the declaration resolves to whole-directory coverage (never a
  //     phantom literal nonexistent file),
  //   - the durable coverage observation is truthful: executed 21 of 21,
  //     not-executed (none) — pre-fix this rode as the durable lie
  //     "executed 1 of 22",
  //   - the executed command is the declaration VERBATIM: no canonical file
  //     is appended after the glob as a duplicate explicit addition.
  const root = mkdtempSync(join(tmpdir(), 'saga-readiness-glob-surface-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'factory@example.test');
  git(root, 'config', 'user.name', 'Factory Test');
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (let i = 1; i <= 21; i += 1) {
    const name = `gs-${String(i).padStart(2, '0')}.test.js`;
    writeFileSync(join(root, 'tests', name), greenTestFile(name));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'glob-surface-candidate', version: '1.0.0',
    scripts: { test: 'node --test tests/**/*.test.js' },
  }, null, 2));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'glob-surface fixture candidate');
  const db = minimalDb(root, 'd'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: 'node --test tests/**/*.test.js' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('d'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'passed',
      'a whole-tree glob over green bytes passes on its real output');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage, 'the coverage diagnostic must ride the evidence');
    assert.match(coverage.message, /executed 21 of 21/u,
      'the durable coverage observation must be truthful, not "executed 1 of 22"');
    assert.match(coverage.message, /not executed: \(none\)/u,
      'every canonical file underneath the tree glob is covered');
    assert.doesNotMatch(coverage.message, /gate DERIVED/u,
      'directory coverage needs no derivation — and no phantom literal');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('M1-b step 4: an npm-test declaration whose SEALED script enumerates 7 of 9 is derived too — the artefact cannot smuggle a narrow script', { timeout: 120000 }, async () => {
  // The hole one level deeper: the candidate declares opaque `npm test` (no
  // direct surface to narrow) but the SEALED package.json scripts.test
  // enumerates 7 of 9. The canonical universe still contains all 9 (the
  // tree), the script covers 7 — the gate derives over the SEALED script's
  // own tokens and the 2 red files run.
  const root = fixture({
    twoRed: true,
    scriptsTest: `node --test ${SEVEN_GREEN.join(' ')}`,
  });
  const db = minimalDb(root, 'c'.repeat(64), {
    kind: 'static',
    commands: { installCommand: null, testCommand: 'npm test' },
  });
  try {
    const result = await withScrubbedTestContext(() => createLocalRunnabilityCheckProvider({
      db, candidateSets: readerFor('c'.repeat(64)),
    }).run(RUN_ARGS));
    assert.equal(result.outcome, 'failed',
      'a narrow sealed script under an opaque npm-test declaration must not pass either');
    const coverage = coverageDiagnostic(result);
    assert.ok(coverage);
    assert.match(coverage.message, /gate DERIVED/u);
    assert.match(coverage.message, /tests\/renderer\.test\.js/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
