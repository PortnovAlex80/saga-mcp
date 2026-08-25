// tests/infrastructure/local-runnability-human-gate.test.mjs
//
// HUMAN-GATE-CONSOLE (docs/architecture/HUMAN-GATE-CONSOLE.md) — the 1.16.0
// wake-source contract of the local-runnability provider:
//
//   1. a typed `unknown` (warrant-blocked-environment) with NO resolution
//      row keeps the 1.15 behavior verbatim (fail-closed, unknown);
//   2. an ACCEPT resolution for the SAME workplace + candidate bytes
//      converts to `passed`, citing the resolution (id + actor) as check
//      evidence and RETAINING the original unknown diagnostic for audit;
//   3. a REJECT resolution (the LATEST row wins) converts to `failed` with
//      the operator feedback in the diagnostic;
//   4. the bytes guard: a resolution answered for DIFFERENT candidate bytes
//      never converts — different bytes are a fresh question (unknown).
//
// Hermetic: the docker executor fake throws the frozen precondition code;
// no docker, no network, no model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  ensureHumanGateResolutionSchema,
} from '../../dist/app/human-gate-resolution.js';
import { ReadinessExecutionError } from '../../dist/infrastructure/verification/readiness-executor.js';
import {
  seedDockerAvailabilityCacheForTests,
} from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';

const PROCESS_RUN_ID = 71;
const CANDIDATE_HASH = 'a'.repeat(64);
const SOURCE_REF = `development-integrated-source-candidate:${PROCESS_RUN_ID}:${CANDIDATE_HASH}`;
const WORKPLACE_REF = `workplace/${PROCESS_RUN_ID}/solution-development/development-readiness-certification/singleton`;

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'saga-human-gate-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), 'process.exit(0);\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'human-gate-fixture', version: '1.0.0', scripts: { test: 'node test.js' },
  }));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'fixture');
  return root;
}

function buildStore(root) {
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
      payload_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    'INSERT INTO project_repositories (id, project_id, repository_id, local_path) VALUES (1, 1, 1, ?)',
  ).run(root);
  const commitSha = gitCli(root, 'rev-parse', 'HEAD');
  const treeHash = gitCli(root, 'rev-parse', 'HEAD^{tree}');
  db.prepare(
    `INSERT INTO factory_process_products
       (process_run_id, product_kind, product_key, schema_id, artifact_ref,
        product_hash, payload_snapshot)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID, 'development.integrated-source-candidate', '',
    INTEGRATED_SOURCE_CANDIDATE_SCHEMA, SOURCE_REF, CANDIDATE_HASH,
    JSON.stringify({
      sourceHash: CANDIDATE_HASH,
      repositories: [{ projectRepositoryId: 1, commitSha, treeHash }],
    }),
  );
  const manifest = {
    schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: { schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA, ref: SOURCE_REF, hash: CANDIDATE_HASH },
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'npm test' },
        environment: { image: 'node:20-alpine' },
      },
    }],
  };
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    1, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, 'worker-execution:human-gate-1',
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(manifest), 'f'.repeat(64),
  );
  ensureHumanGateResolutionSchema(db);
  const subjectBinding = `local-readiness-subject:${CANDIDATE_HASH}:${commitSha}:${treeHash}`;
  return { db, subjectBinding };
}

const SUBJECT_REF = 'candidate-set/human-gate-subject';

function candidateSets() {
  return {
    read(ref) {
      if (ref !== SUBJECT_REF) return null;
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
            ref: 'managed-node-submission:1',
            digest: 'f'.repeat(64),
          },
        }],
      };
    },
  };
}

/** Executor fake whose docker prepare always throws the frozen precondition. */
function dockerDownExecutor() {
  return {
    prepare() {
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', 'daemon down (human-gate proof)');
    },
    runCommand() { throw new Error('unreachable'); },
    runServed() { throw new Error('unreachable'); },
    describe() { return { substrate: 'docker', image: 'node:20-alpine' }; },
    dispose() {},
  };
}

function insertResolution(db, { resolution, subjectBinding, feedback = null }) {
  return db.prepare(
    `INSERT INTO factory_human_gate_resolutions
       (workplace_ref, process_run_id, park_reason_id, gate_decision_key,
        subject_binding, provider_id, resolution, feedback, actor_id)
     VALUES (?, ?, 1, ?, ?, 'factory.local-runnability.v1', ?, ?, 'operator-test')`,
  ).run(
    WORKPLACE_REF, PROCESS_RUN_ID, 'decision:gate-run:' + '1'.repeat(64),
    subjectBinding, resolution, feedback,
  ).lastInsertRowid;
}

test('human gate: unknown without resolution keeps 1.15 fail-closed behavior', { timeout: 60_000 }, () => {
  const root = fixtureRepo();
  try {
    const { db } = buildStore(root);
    seedDockerAvailabilityCacheForTests({ available: false, platform: 'linux' });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSets(),
      executorSelector: () => dockerDownExecutor(),
      substrateRetrySleep: () => {},
    });
    const result = provider.run({ subjectCandidateSetRef: SUBJECT_REF, parameters: {} });
    assert.equal(result.outcome, 'unknown');
    const diag = result.evidenceRefs.map(decodeCheckDiagnostic).find(Boolean);
    assert.equal(diag?.code, 'warrant-blocked-environment');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human gate: ACCEPT for the same bytes converts unknown → passed citing the resolution', { timeout: 60_000 }, () => {
  const root = fixtureRepo();
  try {
    const { db, subjectBinding } = buildStore(root);
    seedDockerAvailabilityCacheForTests({ available: false, platform: 'linux' });
    insertResolution(db, { resolution: 'accept', subjectBinding });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSets(),
      executorSelector: () => dockerDownExecutor(),
      substrateRetrySleep: () => {},
    });
    const result = provider.run({ subjectCandidateSetRef: SUBJECT_REF, parameters: {} });
    assert.equal(result.outcome, 'passed');
    assert.ok(result.evidenceRefs.includes('human-gate-resolution:1'),
      'the passed receipt cites the resolution row');
    assert.ok(result.evidenceRefs.some(e => typeof e === 'string' && e.startsWith('local-readiness-subject:')),
      'the bytes binding still rides the receipt');
    const citation = result.evidenceRefs
      .map(ref => { try { return decodeCheckDiagnostic(ref); } catch { return null; } })
      .find(d => d && d.code === 'human-gate-resolution-accept');
    assert.ok(citation, 'a typed accept citation diagnostic is present');
    assert.match(citation.message, /operator-test ACCEPTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human gate: REJECT (latest row wins) converts unknown → failed with operator feedback', { timeout: 60_000 }, () => {
  const root = fixtureRepo();
  try {
    const { db, subjectBinding } = buildStore(root);
    seedDockerAvailabilityCacheForTests({ available: false, platform: 'linux' });
    insertResolution(db, { resolution: 'accept', subjectBinding });
    insertResolution(db, { resolution: 'reject', subjectBinding, feedback: 'the map is useless without UX zoom' });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSets(),
      executorSelector: () => dockerDownExecutor(),
      substrateRetrySleep: () => {},
    });
    const result = provider.run({ subjectCandidateSetRef: SUBJECT_REF, parameters: {} });
    assert.equal(result.outcome, 'failed');
    const citation = result.evidenceRefs
      .map(ref => { try { return decodeCheckDiagnostic(ref); } catch { return null; } })
      .find(d => d && d.code === 'human-gate-resolution-reject');
    assert.ok(citation, 'a typed reject citation diagnostic is present');
    assert.match(citation.message, /the map is useless without UX zoom/,
      'the operator feedback rides the diagnostic the producer workshop reads');
    assert.ok(result.evidenceRefs.includes('human-gate-resolution:2'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human gate: bytes guard — a resolution for DIFFERENT bytes never converts', { timeout: 60_000 }, () => {
  const root = fixtureRepo();
  try {
    const { db, subjectBinding } = buildStore(root);
    seedDockerAvailabilityCacheForTests({ available: false, platform: 'linux' });
    // The operator answered a DIFFERENT candidate (e.g. an earlier frozen
    // candidate): the current bytes are a fresh question.
    insertResolution(db, {
      resolution: 'accept',
      subjectBinding: `local-readiness-subject:${'b'.repeat(64)}:${'c'.repeat(40)}:${'d'.repeat(40)}`,
    });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: candidateSets(),
      executorSelector: () => dockerDownExecutor(),
      substrateRetrySleep: () => {},
    });
    const result = provider.run({ subjectCandidateSetRef: SUBJECT_REF, parameters: {} });
    assert.equal(result.outcome, 'unknown',
      `binding mismatch must keep the unknown (resolved other bytes, current ${subjectBinding.slice(0, 40)}…)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
