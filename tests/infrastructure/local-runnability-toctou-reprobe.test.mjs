// tests/infrastructure/local-runnability-toctou-reprobe.test.mjs
//
// CC-GAP-9 RESIDUAL / ADR-091 — readiness-substrate TOCTOU re-probe:
// after any Docker executor/compose operation failure, the provider
// invalidates the cached availability probe and mechanically re-probes the
// daemon; ONLY the observed re-probe result routes —
//   - observed unavailable/not-linux re-enters the EXISTING ADR-089 bounded
//     in-check substrate retry and, on exhaustion, the typed unknown
//     `warrant-blocked-environment` outcome (never product `failed`);
//   - observed available+linux keeps the ORIGINAL product failure (bad
//     image/tag, invalid compose config, failing product command — never
//     re-routed to unknown/substrate, never retried as substrate);
//   - classification NEVER reads the failed command's stderr text.
//
// This file carries the ADR-091 BLOCKING MUTATIONS (a)-(f):
//   a. daemon-death-mid-check + observed-unavailable re-probe yields the
//      ADR-089 path (bounded retry → typed unknown) — routing it to product
//      `failed` is red;
//   b. the same failing step with an observed available+linux re-probe stays
//      product `failed` — routing it to unknown/substrate is red;
//   c. daemon-shaped stderr + healthy re-probe classifies product `failed`,
//      and clean stderr + unavailable re-probe classifies substrate — any
//      stderr-sensitive routing is red;
//   d. collapse guard: routing every executor/compose failure to unknown (or
//      all to `failed`) fails classification — the SAME failing step yields
//      the two DISTINCT classes under the two observations;
//   e. compose truths: invalid `compose config` with the CLI present and the
//      daemon observed healthy is product `failed`; a failed `down` after a
//      passed `up` leaves the pass green; a failed `down` after a failed `up`
//      never masks the up failure or its class; ENOENT CLI-missing stays
//      LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE (never re-classified, never
//      re-probed into the substrate route);
//   f. version/digest fence: the provider presents `1.12.0`; the
//      trusted_providers row migrates from the exact `1.11.0` baseline with
//      the `built-in:<provider digest>` trust basis; an unmigrated trust row
//      and a receipt from a foreign provider digest are both rejected; the
//      obligation compiler pins `factory.local-runnability.v1` @ `1.12.0`.
//
// Repair arms (2026-08-22 audit):
//   (a) not-linux arm — a mid-check re-probe observing available:true,
//      linux:false routes DOCKER_NOT_LINUX through the SAME bounded
//      typed-unknown path, never conflated with DOCKER_UNAVAILABLE;
//   host-executor control — a failing HOST runCommand triggers ZERO docker
//      probes (no start probe, no re-probe) and stays product `failed` even
//      on a daemon-less machine (host steps have no daemon dependency);
//   determinism — the mid-check classification evidence carries NO
//      wall-clock: identical runs produce byte-equal receipts in both
//      directions (trusted_providers determinism='full').
//
// Hermeticity: the daemon OBSERVATION is scripted through the TEST-ONLY
// installDockerInfoProbeForTests seam (the probe mechanics — bounded
// `docker info`, cache invalidation, typed observation — stay frozen in
// production code); executor and compose substrates are the provider's
// existing injectable seams. No docker daemon is required.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  createLocalRunnabilityCheckProvider,
  ensureLocalRunnabilityProviderTrust,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import { ReadinessExecutionError } from '../../dist/infrastructure/verification/readiness-executor.js';
import {
  installDockerInfoProbeForTests,
  isDockerAvailableForReadiness,
  peekDockerAvailabilityCacheForTests,
  resetDockerAvailabilityCache,
} from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import {
  assertRenderedCheckOutcomeTruthful,
  classifyCheckOutcome,
  SUBSTRATE_PRECONDITION_DIAGNOSTIC,
  SUBSTRATE_RETRY_POLICY,
} from '../../dist/infrastructure/verification/substrate-retry.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import { decodeSeamRepairIssue } from '../../dist/process-modules/domain/workplace/seam-repair-issue.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { ACCEPTANCE_OBLIGATION_CONTRACTS } from '../factory-proof/obligation-contracts.mjs';
import {
  assertProtectionSetEquality,
  readInstalledProtections,
} from '../factory-proof/installed-protection-reader.mjs';

const PROCESS_RUN_ID = 77;
const CANDIDATE_HASH = 'b'.repeat(64);
const SOURCE_REF = `development-integrated-source-candidate:${PROCESS_RUN_ID}:${CANDIDATE_HASH}`;

// ---------------------------------------------------------------------------
// Hermetic harness (mirrors local-runnability-substrate-retry.test.mjs).
// ---------------------------------------------------------------------------

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'saga-toctou-reprobe-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), 'process.exit(0);\n');
  writeFileSync(join(root, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'toctou-fixture', version: '1.0.0', scripts: { test: 'node test.js' },
  }));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'fixture');
  return root;
}

function toctouStore(root) {
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
  return db;
}

/** Insert a readiness manifest; readiness defaults to a docker profile. */
function insertManifest(db, { id = 1, readiness } = {}) {
  const manifest = {
    schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: { schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA, ref: SOURCE_REF, hash: CANDIDATE_HASH },
    targets: [{
      key: 'primary',
      readiness: readiness ?? {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'npm test' },
        environment: { image: 'node:20-alpine' },
      },
    }],
  };
  const contentHash = 'c'.repeat(64);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, `worker-execution:toctou-${id}`,
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(manifest), contentHash,
  );
  return { manifestDigest: contentHash, submissionId: id };
}

function manifestCandidateSets({ submissionId, manifestDigest }) {
  const subjectRef = `candidate-set/toctou-${submissionId}`;
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
            digest: manifestDigest,
          },
          origin: 'produced',
          sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

const RUN_ARGS = subjectRef => ({
  subjectCandidateSetRef: subjectRef, parameters: {},
  environmentRef: null, candidateSnapshot: {},
});

function decodeDiagnostics(result) {
  return result.evidenceRefs
    .map(ref => decodeCheckDiagnostic(ref))
    .filter(diag => diag !== null);
}

/**
 * Script the OBSERVED daemon lifecycle: each genuine probe (start-of-check,
 * between-attempt, mid-check re-probe) consumes the next scripted
 * observation; when the script is exhausted, the last observation repeats.
 */
function scriptDaemonObservations(observations) {
  const probed = [];
  let last = observations[observations.length - 1];
  installDockerInfoProbeForTests(() => {
    const next = observations.length > 0 ? observations.shift() : last;
    last = next;
    probed.push(next);
    return next;
  });
  return probed;
}

/**
 * A docker-executor fake faithful to the DockerReadinessExecutor contract:
 * prepare genuinely probes availability (the test seam observes the script)
 * and throws the typed precondition the OBSERVATION dictates — mirroring the
 * production executor's ensureDockerAvailable two-code split (!available →
 * LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE; available+not-linux →
 * LOCAL_RUNNABILITY_DOCKER_NOT_LINUX; the two codes never conflate). The
 * mid-check step behavior is scripted per test.
 */
function dockerExecutorFake(calls, { prepareError, runCommandError } = {}) {
  return {
    prepare() {
      calls.prepare += 1;
      const ready = isDockerAvailableForReadiness();
      const observed = peekDockerAvailabilityCacheForTests();
      if (!ready) {
        const notLinux = observed !== null && observed.available;
        throw new ReadinessExecutionError(
          notLinux
            ? 'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX'
            : 'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
          notLinux
            ? 'environment.image is declared but the docker daemon OSType is not linux (probe)'
            : 'environment.image is declared but the docker daemon is not available (probe)',
        );
      }
      if (prepareError) throw prepareError;
    },
    runCommand() {
      calls.runCommand += 1;
      if (runCommandError) throw runCommandError;
    },
    runServed() { throw new Error('unreachable in this proof'); },
    describe() { return { substrate: 'docker', image: 'node:20-alpine' }; },
    dispose() { calls.dispose += 1; },
  };
}

/** A host-substrate executor fake (no daemon dependency). */
function hostExecutorFake(calls, { runCommandError } = {}) {
  return {
    prepare() { calls.prepare += 1; },
    runCommand() {
      calls.runCommand += 1;
      if (runCommandError) throw runCommandError;
    },
    runServed() { return { port: 1, stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64) }; },
    describe() { return { substrate: 'host' }; },
    dispose() {},
  };
}

function composeRunnerFake(calls, { config, up, down } = {}) {
  return {
    configValidate(directory, declaration) {
      calls.compose.push(['config', declaration.file]);
      return config ? config() : { step: 'compose-config', status: 'passed' };
    },
    up(directory, declaration, timeoutMs) {
      calls.compose.push(['up', timeoutMs]);
      return up ? up() : { step: 'compose-up', status: 'passed' };
    },
    down(directory, declaration) {
      calls.compose.push(['down']);
      if (down) down();
    },
  };
}

const COMPOSE_STATIC_READINESS = {
  kind: 'static',
  commands: { installCommand: null, testCommand: 'npm test' },
  compose: { file: 'compose.yaml' },
};

async function runToctouCase({ readiness, executorFactory, composeRunner }) {
  const root = fixtureRepo();
  const db = toctouStore(root);
  const { manifestDigest, submissionId } = insertManifest(db, { readiness });
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  let out;
  try {
    out = {
      result: await createLocalRunnabilityCheckProvider({
        db,
        candidateSets,
        ...(executorFactory ? { executorSelector: executorFactory } : {}),
        ...(composeRunner ? { composeRunner } : {}),
        substrateRetrySleep: () => { /* hermetic instant schedule */ },
      }).run(RUN_ARGS(candidateSets.subjectRef)),
      db,
    };
  } finally {
    if (!out) db.close();
  }
  rmSync(root, { recursive: true, force: true });
  return out;
}

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (a) — daemon dies mid-check after a PASSED start-of-check
// probe: the failing executor/compose step plus an observed-unavailable
// re-probe yields the ADR-089 path — never product `failed`.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (a): daemon death mid-check after a passed start-of-check probe → bounded retry → typed unknown, never product failed', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  // The observed daemon lifecycle: healthy at the start-of-check probe
  // (attempt-1 prepare), GONE at the mid-check re-probe (after the failing
  // run step), still gone at the attempt-2/3 prepare probes.
  const probes = scriptDaemonObservations([
    { available: true, linux: true },
    { available: false, linux: false },
    { available: false, linux: false },
    { available: false, linux: false },
  ]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        runCommandError: new Error(
          'docker run 3f2a... sh -c npm test exited 1: product test output',
        ),
      }),
    });
    try {
      // THE (a) assertion: the observed-unavailable re-probe routes into the
      // ADR-089 machinery — the typed unknown, never the product `failed`
      // the pre-ADR-091 flattening would have recorded.
      assert.equal(result.outcome, 'unknown',
        'a daemon death mid-check must never write a product verdict');

      // The whole ADR-089 machinery ran: exactly the frozen bound of
      // attempts; the mid-check failure re-entered the retry (attempt 2/3
      // observed the precondition at prepare).
      assert.equal(calls.prepare, SUBSTRATE_RETRY_POLICY.maxAttempts);
      assert.equal(calls.runCommand, 1, 'the mid-check step failed exactly once');

      // The probe sequence is the TOCTOU story: healthy → (step fails) →
      // unavailable → unavailable → unavailable.
      assert.equal(probes.length, 4);
      assert.deepEqual(probes[0], { available: true, linux: true });
      assert.deepEqual(probes.slice(1), [
        { available: false, linux: false },
        { available: false, linux: false },
        { available: false, linux: false },
      ]);

      // The re-probe genuinely INVALIDATED the cached observation: the cache
      // now holds the honest re-probe result, never a stale positive.
      assert.deepEqual(peekDockerAvailabilityCacheForTests(), { available: false, linux: false });

      // Exactly one typed unknown with the frozen diagnostic and NO seam
      // repair issue (a machine fault has no product defect to repair).
      const warrant = decodeDiagnostics(result)
        .find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
      assert.ok(warrant, 'the warrant-blocked-environment diagnostic rides the receipt');
      assert.match(warrant.message, /LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE/u);
      assert.match(warrant.message, /outcome is unknown, not failed/u);
      assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
        'no seam repair issue: a substrate death is not a product defect');

      // Budget isolation (ADR-089 mutation d, re-proven on the re-probe
      // path): the provider wrote no receipts and charged nothing.
      const receipts = db.prepare('SELECT COUNT(*) AS n FROM factory_check_receipts').get();
      assert.equal(receipts.n, 0);
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (a), compose arm: a mid-check compose up failure with an observed-unavailable re-probe rides the ADR-089 path', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  // Host executor (its steps are NOT daemon-dependent and must not be
  // re-probed); the compose up failure is the mid-check failure, and the
  // re-probe observes the daemon gone on every classification.
  const probes = scriptDaemonObservations([
    { available: false, linux: false },
    { available: false, linux: false },
    { available: false, linux: false },
  ]);
  try {
    const { result, db } = await runToctouCase({
      readiness: COMPOSE_STATIC_READINESS,
      executorFactory: () => hostExecutorFake(calls),
      composeRunner: composeRunnerFake(calls, {
        up: () => ({ step: 'compose-up', status: 'failed', detail: 'compose up timed out waiting for health' }),
      }),
    });
    try {
      assert.equal(result.outcome, 'unknown',
        'a compose failure whose re-probe observes the daemon gone is substrate-unavailable');
      // The failed compose step re-entered the bounded retry: the whole body
      // (prepare → test → compose) re-ran per attempt; the up step failed
      // and was classified on every attempt.
      const ups = calls.compose.filter(call => call[0] === 'up');
      assert.equal(ups.length, SUBSTRATE_RETRY_POLICY.maxAttempts);
      assert.equal(calls.prepare, SUBSTRATE_RETRY_POLICY.maxAttempts);
      assert.equal(probes.length, SUBSTRATE_RETRY_POLICY.maxAttempts,
        'exactly one mechanical re-probe per failed up — no more, no less');
      const warrant = decodeDiagnostics(result)
        .find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
      assert.ok(warrant);
      assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')));
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (a), not-linux arm — the mid-check re-probe observes the
// daemon REACHABLE but on a NON-LINUX runtime (available:true, linux:false):
// the failure routes DOCKER_NOT_LINUX through the SAME bounded typed-unknown
// path, never conflated with DOCKER_UNAVAILABLE, never product `failed`.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (a), not-linux arm: mid-check re-probe observing available+not-linux → DOCKER_NOT_LINUX rides the bounded typed-unknown path, never conflated with unavailable', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  // The observed daemon lifecycle: healthy at the start-of-check probe
  // (attempt-1 prepare), reachable-but-not-linux at the mid-check re-probe
  // (the runtime flipped after the probe passed — the second TOCTOU truth),
  // and still not-linux at the attempt-2/3 prepare probes.
  const probes = scriptDaemonObservations([
    { available: true, linux: true },
    { available: true, linux: false },
    { available: true, linux: false },
    { available: true, linux: false },
  ]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        runCommandError: new Error(
          'docker run 3f2a... sh -c npm test failed: operating system is not supported',
        ),
      }),
    });
    try {
      // THE not-linux assertion: an observed available+not-linux re-probe
      // rides the ADR-089 machinery as DOCKER_NOT_LINUX — the typed unknown,
      // never the product `failed` the flattening would record.
      assert.equal(result.outcome, 'unknown',
        'a runtime flip mid-check must never write a product verdict');

      // The bounded retry genuinely re-entered: exactly the frozen bound of
      // attempts; the mid-check step failed exactly once (never re-run).
      assert.equal(calls.prepare, SUBSTRATE_RETRY_POLICY.maxAttempts);
      assert.equal(calls.runCommand, 1);

      // The probe sequence is the runtime-flip story: healthy → (step fails)
      // → available+not-linux → not-linux → not-linux.
      assert.equal(probes.length, 4);
      assert.deepEqual(probes[0], { available: true, linux: true });
      assert.deepEqual(probes[1], { available: true, linux: false },
        'the mid-check mechanical re-probe observed the daemon reachable but not linux');
      assert.deepEqual(probes.slice(2), [
        { available: true, linux: false },
        { available: true, linux: false },
      ]);

      const warrant = decodeDiagnostics(result)
        .find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
      assert.ok(warrant, 'the warrant-blocked-environment diagnostic rides the receipt');
      // NOT-LINUX is its own typed truth — never conflated with unavailable:
      // the warrant names exactly the not-linux code and never the
      // unavailable code.
      assert.match(warrant.message, /LOCAL_RUNNABILITY_DOCKER_NOT_LINUX/u);
      assert.ok(
        !warrant.message.includes('LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE'),
        'available+not-linux must never be recorded as DOCKER_UNAVAILABLE (distinct typed truths)',
      );
      assert.match(warrant.message, new RegExp(`${SUBSTRATE_RETRY_POLICY.maxAttempts} in-check attempts`, 'u'));
      // The rendered attempt detail is the not-linux TRUTH (the retry
      // prepares observed the daemon reachable but not linux) — never the
      // unavailable text. The mid-check classifier's own typed observation
      // message ('observed available=true, linux=false') is attempt-1
      // evidence; the warrant renders the last attempt's detail.
      assert.match(warrant.message, /OSType is not linux/u);
      assert.ok(!warrant.message.includes('not available'),
        'the not-linux arm never records the unavailable truth');
      assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
        'no seam repair issue: a substrate runtime flip is not a product defect');

      const receipts = db.prepare('SELECT COUNT(*) AS n FROM factory_check_receipts').get();
      assert.equal(receipts.n, 0);
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (b) — the SAME failing step with an observed
// available+linux re-probe stays product `failed`: never unknown, never
// retried as substrate.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (b): bad image/tag (pull failure) + healthy re-probe stays product `failed` — single attempt, typed code, seam issue', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  // Probe 1: the attempt-1 prepare availability probe (healthy). Probe 2:
  // the mechanical re-probe the pull failure triggers (healthy — the daemon
  // did NOT die; the image/tag is bad).
  const probes = scriptDaemonObservations([
    { available: true, linux: true },
    { available: true, linux: true },
  ]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        prepareError: new ReadinessExecutionError(
          'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED',
          'docker image pull failed for "node:99-does-not-exist": manifest unknown',
        ),
      }),
    });
    try {
      assert.equal(result.outcome, 'failed',
        'a bad image/tag against an observed-healthy substrate is a product failure');
      assert.equal(calls.prepare, 1,
        'a product failure is never retried as substrate');
      assert.equal(probes.length, 2,
        'prepare probed once; exactly ONE mechanical re-probe classified the failure');
      assert.deepEqual(probes[1], { available: true, linux: true });
      const diagnostics = decodeDiagnostics(result);
      assert.equal(diagnostics[0].code, 'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED',
        'the ORIGINAL typed code survives — the healthy observation never rewrites the failure');
      assert.match(diagnostics[0].message, /manifest unknown/u);
      assert.match(diagnostics[0].message, /ADR-091 mid-check re-probe observed docker available \+ linux/u,
        'the healthy observation rides the evidence (pre-mortem race detection)');
      assert.ok(!diagnostics.some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC),
        'never re-routed to unknown');
      assert.ok(result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
        'the product failure keeps its typed seam repair issue');
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (b), product command arm: failing product test step + healthy re-probe stays product `failed`', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  scriptDaemonObservations([{ available: true, linux: true }]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        runCommandError: new Error('docker run sh -c npm test exited 1: 3 failing tests'),
      }),
    });
    try {
      assert.equal(result.outcome, 'failed');
      assert.equal(calls.runCommand, 1, 'never retried as substrate');
      assert.ok(!decodeDiagnostics(result).some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC),
        'a failing product command is never routed to unknown');
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// HOST-EXECUTOR CONTROL — the ADR-091 re-probe is a DOCKER-executor/compose
// mechanism only. A failing HOST runCommand has no daemon dependency: it must
// trigger ZERO docker probes (no start probe, no re-probe — the daemon is
// never consulted at all) and stay product `failed` even on a daemon-less
// machine, where any wrongly-added re-probe would observe `unavailable` and
// misroute the host product failure into the substrate unknown path.
// ---------------------------------------------------------------------------

test('HOST-EXECUTOR CONTROL: a failing host runCommand triggers ZERO docker re-probes and stays product `failed` on a daemon-less machine', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  // The standing observation a daemon-less machine would give IF probed.
  // The counting probe seam proves the daemon is NEVER consulted: zero
  // probes, and the process-level availability cache is never even
  // populated.
  const probes = scriptDaemonObservations([{ available: false, linux: false }]);
  try {
    const { result, db } = await runToctouCase({
      // A HOST profile: no environment.image, no compose declaration.
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'npm test' },
      },
      executorFactory: () => hostExecutorFake(calls, {
        runCommandError: new Error('npm test exited 1: host product is red'),
      }),
    });
    try {
      // THE control assertion: the host failure is a product verdict…
      assert.equal(result.outcome, 'failed',
        'a failing host product command stays product `failed` — no daemon involved');
      const diagnostics = decodeDiagnostics(result);
      assert.equal(diagnostics[0].code, 'local-runnability',
        'the plain host command failure keeps its default typed code');
      assert.ok(!diagnostics.some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC),
        'a host failure must never be re-routed to the substrate unknown path');
      // …and ZERO docker probes ran: no start-of-check probe (host substrate
      // never consults the daemon), no mid-check re-probe (host steps have no
      // daemon dependency). An implementation re-probing "every executor
      // failure" would consult the scripted daemon-less observation here and
      // misroute this product failure to unknown — red.
      assert.equal(probes.length, 0,
        'a failing host step triggers ZERO docker info observations — no re-probe, no start probe');
      assert.equal(peekDockerAvailabilityCacheForTests(), null,
        'no docker availability observation was ever cached for a host-substrate check');
      // Single attempt: the host failure is never retried as substrate.
      assert.equal(calls.prepare, 1);
      assert.equal(calls.runCommand, 1);
      // The product failure keeps its typed seam repair issue, localized to
      // the HOST substrate.
      const issue = result.evidenceRefs
        .map(ref => decodeSeamRepairIssue(ref))
        .find(decoded => decoded !== null);
      assert.ok(issue, 'the product failure keeps its typed seam repair issue');
      assert.equal(issue.localization.substrate, 'host',
        'the seam issue is localized to the host substrate, never docker');
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (c) — no stderr guessing. The classifier's sole input is
// the observed re-probe; daemon-shaped stderr paired with a healthy
// observation must classify product `failed`, and clean stderr paired with an
// unavailable observation must classify substrate.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (c): daemon-shaped stderr + observed-healthy re-probe classifies product `failed` (stderr is never a classification input)', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  scriptDaemonObservations([{ available: true, linux: true }]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        runCommandError: new Error([
          'docker run sh -c npm test failed with:',
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
          'Is the docker daemon running?',
          'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/json": dial unix /var/run/docker.sock: connect: no such file or directory',
        ].join('\n')),
      }),
    });
    try {
      // THE (c) assertion: the stderr SCREAMS daemon, but the OBSERVATION
      // says healthy — the mechanical re-probe is the only decider, so this
      // stays the original product failure. Any stderr-sensitive routing
      // (matching "Cannot connect", "error during connect", "Is the docker
      // daemon running") would classify unknown/substrate and turn red here.
      assert.equal(result.outcome, 'failed',
        'daemon-shaped stderr must never override an observed-healthy re-probe');
      assert.equal(calls.runCommand, 1);
      assert.ok(!decodeDiagnostics(result).some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC));
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (c), mirror arm: clean stderr + observed-unavailable re-probe classifies substrate', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  scriptDaemonObservations([
    { available: true, linux: true },
    { available: false, linux: false },
    { available: false, linux: false },
    { available: false, linux: false },
  ]);
  try {
    const { result, db } = await runToctouCase({
      executorFactory: () => dockerExecutorFake(calls, {
        // Clean, product-shaped stderr with zero daemon-shaped text.
        runCommandError: new Error('exit status 1: 2 tests failed'),
      }),
    });
    try {
      // The clean stderr says nothing about the daemon, but the OBSERVATION
      // says gone — the failure classifies substrate. An implementation
      // keying on stderr text would call this a product failure and turn red.
      assert.equal(result.outcome, 'unknown');
      const warrant = decodeDiagnostics(result)
        .find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
      assert.ok(warrant);
      assert.match(warrant.message, /LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE/u);
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (determinism) — the mid-check re-probe evidence carries
// NO wall-clock clock reading. The provider is trusted as
// deterministic_evidence with determinism='full'; the classification evidence
// rides the receipt bytes in BOTH directions (the healthy-note append is
// hashed into the failed receipt's content-addressed `local-readiness:`
// digest; the typed precondition message rides the unknown receipt's warrant
// diagnostic). Two identical runs over the SAME sealed subject must produce
// BYTE-EQUAL receipts in both directions, and no evidence ref may contain an
// ISO-8601 timestamp.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (determinism): identical mid-check classified runs produce byte-equal receipts — no wall-clock in the evidence (determinism=full)', { timeout: 120_000 }, async () => {
  const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u;
  // One sealed subject (same fixture repo, same store): two genuinely
  // executed checks with identical scripts must agree byte-for-byte.
  const root = fixtureRepo();
  const db = toctouStore(root);
  try {
    const { manifestDigest, submissionId } = insertManifest(db);
    const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
    const runTwice = async observations => {
      const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
      scriptDaemonObservations(observations);
      try {
        const provider = createLocalRunnabilityCheckProvider({
          db,
          candidateSets,
          executorSelector: () => dockerExecutorFake(calls, {
            runCommandError: new Error('docker run sh -c npm test exited 1: product test output'),
          }),
          substrateRetrySleep: () => { /* hermetic instant schedule */ },
        });
        const first = await provider.run(RUN_ARGS(candidateSets.subjectRef));
        const second = await provider.run(RUN_ARGS(candidateSets.subjectRef));
        return { first, second, calls };
      } finally {
        installDockerInfoProbeForTests(null);
        resetDockerAvailabilityCache();
      }
    };

    // Healthy direction (product `failed`): the re-probe observation is
    // appended to the failure reason that feeds the content-addressed
    // digest — the two receipts must be byte-equal.
    const healthy = await runTwice([
      { available: true, linux: true },
      { available: true, linux: true },
      { available: true, linux: true },
      { available: true, linux: true },
    ]);
    assert.equal(healthy.first.outcome, 'failed');
    assert.deepEqual(healthy.second.evidenceRefs, healthy.first.evidenceRefs,
      'two identical healthy-reprobe runs must produce byte-equal failed receipts'
        + ' — a wall-clock stamp in the classification note would fork the digest');

    // Unavailable direction (typed `unknown`): the typed message rides the
    // warrant diagnostic — the two receipts must again be byte-equal. The
    // script carries TWO full lifecycles (healthy start, gone re-probe, two
    // gone retry prepares) so both runs classify the SAME mid-check failure.
    const gone = await runTwice([
      { available: true, linux: true },
      { available: false, linux: false },
      { available: false, linux: false },
      { available: false, linux: false },
      { available: true, linux: true },
      { available: false, linux: false },
      { available: false, linux: false },
      { available: false, linux: false },
    ]);
    assert.equal(gone.first.outcome, 'unknown');
    assert.deepEqual(gone.second.evidenceRefs, gone.first.evidenceRefs,
      'two identical unavailable-reprobe runs must produce byte-equal unknown receipts');

    // And no receipt byte carries an ISO-8601 wall-clock stamp in either
    // direction.
    for (const receipt of [healthy.first, healthy.second, gone.first, gone.second]) {
      for (const ref of receipt.evidenceRefs) {
        assert.ok(!ISO_TIMESTAMP.test(ref),
          `wall-clock timestamp leaked into protected deterministic evidence: ${ref.slice(0, 120)}`);
      }
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (d) — collapse guard. The SAME failing step under the two
// observations yields the two DISTINCT typed classes; routing every
// executor/compose failure to unknown (or all to `failed`) fails here.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (d): collapse guard — the same failing step yields the two distinct classes under the two observations', { timeout: 120_000 }, async () => {
  const stepFailureText = 'docker run sh -c npm test exited 1';
  const outcomes = [];
  for (const observation of [
    { available: false, linux: false }, // substrate observation
    { available: true, linux: true },   // healthy observation
  ]) {
    const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
    // Healthy start (attempt-1 prepare passes), then the scripted
    // observation for every subsequent probe (re-probe + retry prepares).
    scriptDaemonObservations([
      { available: true, linux: true },
      observation, observation, observation,
    ]);
    try {
      const run = await runToctouCase({
        executorFactory: () => dockerExecutorFake(calls, {
          runCommandError: new Error(stepFailureText),
        }),
      });
      outcomes.push({ observation, outcome: run.result.outcome, result: run.result });
      run.db.close();
    } finally {
      installDockerInfoProbeForTests(null);
      resetDockerAvailabilityCache();
    }
  }
  const [substrateRun, productRun] = outcomes;
  // The two classes are distinct and correct — an implementation routing
  // EVERY failure to unknown fails the second pair; all to `failed` fails
  // the first (the exact Elite-6 collapse and its mirror).
  assert.equal(substrateRun.outcome, 'unknown');
  assert.equal(productRun.outcome, 'failed');
  assert.notEqual(substrateRun.outcome, productRun.outcome,
    'substrate-unavailable and product-failed never collapse');
  // The classes classify and render truthfully on every surface (ADR-089 §1).
  assert.equal(classifyCheckOutcome({
    outcome: substrateRun.outcome,
    diagnosticCode: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
  }), 'substrate-unavailable');
  assert.equal(classifyCheckOutcome({
    outcome: productRun.outcome,
    diagnosticCode: 'local-runnability',
  }), 'product-failed');
  assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
    receiptOutcome: 'unknown',
    diagnosticCode: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
    renderedAs: 'unknown',
  }));
  assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
    receiptOutcome: 'failed', diagnosticCode: 'local-runnability', renderedAs: 'failed',
  }));
  // The collapse shapes stay red: the substrate class rendered as a product
  // verdict (the Elite-6 flattening) or as poison-green (ADR-089 §7).
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'unknown',
      diagnosticCode: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
      renderedAs: 'failed',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'unknown',
      diagnosticCode: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
      renderedAs: 'pass',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'failed',
      diagnosticCode: 'local-runnability',
      renderedAs: 'pass',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (e) — compose truths: down is best-effort with no
// outcome; invalid config with the CLI present and a healthy daemon is a
// product defect; ENOENT CLI-missing keeps its typed substrate code.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (e): invalid compose config with the CLI present and the daemon observed healthy is product `failed`', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  const probes = scriptDaemonObservations([{ available: true, linux: true }]);
  try {
    const { result, db } = await runToctouCase({
      readiness: COMPOSE_STATIC_READINESS,
      executorFactory: () => hostExecutorFake(calls),
      composeRunner: composeRunnerFake(calls, {
        config: () => ({
          step: 'compose-config',
          status: 'failed',
          detail: 'service "web" has neither an image nor a build context specified',
        }),
      }),
    });
    try {
      assert.equal(result.outcome, 'failed',
        'an invalid compose declaration against a healthy substrate is the product\'s defect');
      const configs = calls.compose.filter(call => call[0] === 'config');
      assert.equal(configs.length, 1, 'a product failure is never retried as substrate');
      assert.equal(probes.length, 1, 'exactly one mechanical re-probe classified the step');
      assert.ok(!decodeDiagnostics(result).some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC));
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (e): a failed down after a PASSED up never turns the pass red', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  let downCalls = 0;
  try {
    const { result, db } = await runToctouCase({
      readiness: COMPOSE_STATIC_READINESS,
      executorFactory: () => hostExecutorFake(calls),
      composeRunner: composeRunnerFake(calls, {
        down() { downCalls += 1; throw new Error('docker compose down failed: network busy'); },
      }),
    });
    try {
      assert.equal(result.outcome, 'passed',
        'down is best-effort cleanup with NO outcome — a failed down must not revoke a passed up');
      assert.equal(downCalls, 1, 'down ran exactly once after the passed up');
      assert.ok(result.evidenceRefs.length > 0, 'the pass carries its evidence');
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (e): a failed down after a FAILED up never masks the up failure or its class', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  scriptDaemonObservations([{ available: true, linux: true }]);
  try {
    const { result, db } = await runToctouCase({
      readiness: COMPOSE_STATIC_READINESS,
      executorFactory: () => hostExecutorFake(calls),
      composeRunner: composeRunnerFake(calls, {
        up: () => ({ step: 'compose-up', status: 'failed', detail: 'timeout waiting for container healthy' }),
        down() { throw new Error('docker compose down failed: network busy'); },
      }),
    });
    try {
      // The check still FAILS (the failed down did not manufacture a pass)…
      assert.equal(result.outcome, 'failed');
      // …and the failure is the UP failure with its own class — never the
      // down cleanup error, never a substrate reclassification.
      const issue = result.evidenceRefs
        .map(ref => decodeSeamRepairIssue(ref))
        .find(decoded => decoded !== null);
      assert.ok(issue, 'the typed seam repair issue rides the failure');
      assert.equal(issue.seamKind, 'compose-up', 'the UP failure owns the outcome');
      assert.equal(issue.localization.phase, 'compose-up');
      assert.match(issue.evidence.summary, /timeout waiting for container healthy/u,
        'the up detail survives — the failed down never masks it');
      assert.ok(!issue.evidence.summary.includes('network busy'),
        'the down cleanup error never replaces the up failure');
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (e): ENOENT CLI-missing stays LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE — never re-classified, never re-probed', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  const probes = scriptDaemonObservations([{ available: false, linux: false }]);
  try {
    const { result, db } = await runToctouCase({
      readiness: COMPOSE_STATIC_READINESS,
      executorFactory: () => hostExecutorFake(calls),
      composeRunner: composeRunnerFake(calls, {
        config: () => {
          throw new ReadinessExecutionError(
            'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE',
            'compose is declared but the docker compose CLI is unavailable: spawn docker ENOENT',
          );
        },
      }),
    });
    try {
      assert.equal(result.outcome, 'failed');
      const diagnostic = decodeDiagnostics(result)[0];
      assert.equal(diagnostic.code, 'LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE',
        'the ENOENT typed substrate code stays verbatim (ADR-091 §5)');
      // Even though the (scripted) daemon would observe unavailable, the
      // ENOENT failure is NOT re-classified and NOT re-probed: zero probes,
      // one config call, no substrate retry.
      assert.equal(probes.length, 0,
        'ENOENT CLI-missing is already typed — the mechanical re-probe never runs for it');
      assert.equal(calls.compose.filter(call => call[0] === 'config').length, 1);
      assert.equal(calls.prepare, 1, 'no substrate retry consumed');
      assert.ok(!decodeDiagnostics(result).some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC));
    } finally {
      db.close();
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION (f) — version/digest fence at 1.12.0: provider version,
// trusted_providers migration from the exact 1.11.0 baseline, foreign-digest
// receipt rejection, unmigrated trust row rejection, and the obligation
// compiler pin factory.local-runnability.v1 @ 1.12.0.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION (f): the provider presents 1.12.0 with the digest fence intact', async () => {
  assert.equal(LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION, '1.12.0',
    'the ADR-091 landing pins the provider at 1.12.0');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  try {
    const candidateSets = { read: () => null };
    const provider = createLocalRunnabilityCheckProvider({ db, candidateSets });
    assert.equal(provider.version, '1.12.0');
    assert.equal(provider.providerDigest, LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST);
    assert.equal(provider.providerId, 'factory.local-runnability.v1');
  } finally {
    db.close();
  }
});

test('BLOCKING MUTATION (f): the trusted_providers migration accepts the exact 1.11.0 baseline and installs 1.12.0 with the built-in digest basis', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trusted_providers(
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
      category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
    );
  `);
  // The recorded trustworthy baseline: a row last migrated by the 1.11.0
  // landing (its recorded digest basis), category/determinism/scope/status
  // exactly as the trusted policy demands.
  db.prepare(
    `INSERT INTO trusted_providers
       (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES(NULL,'factory.local-runnability.v1','1.11.0','deterministic_evidence',
       'built-in:legacy-1.11.0-digest','full','local-runnability','active')`,
  ).run();
  try {
    ensureLocalRunnabilityProviderTrust(db);
    const row = db.prepare(
      'SELECT version, trust_basis, category, determinism, scope, status FROM trusted_providers WHERE name=?',
    ).get('factory.local-runnability.v1');
    assert.equal(row.version, '1.12.0', 'the row migrates 1.11.0 → 1.12.0 in place');
    assert.equal(row.trust_basis, `built-in:${LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST}`,
      'the trust basis is the CURRENT provider digest — the digest fence stands');
    assert.equal(row.status, 'active');
    // Idempotent: re-running over the migrated row is a no-op.
    ensureLocalRunnabilityProviderTrust(db);
  } finally {
    db.close();
  }
});

test('BLOCKING MUTATION (f): an unmigrated/foreign trust row is rejected (fail closed)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trusted_providers(
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, version TEXT,
      category TEXT, trust_basis TEXT, determinism TEXT, scope TEXT, status TEXT
    );
  `);
  // A version outside the recorded trustworthy baseline (never shipped by
  // this provider lineage) — the migration must refuse, never silently
  // re-trust an unknown row.
  db.prepare(
    `INSERT INTO trusted_providers
       (project_id,name,version,category,trust_basis,determinism,scope,status)
     VALUES(NULL,'factory.local-runnability.v1','0.9.0','deterministic_evidence',
       'built-in:foreign','full','local-runnability','active')`,
  ).run();
  try {
    assert.throws(
      () => ensureLocalRunnabilityProviderTrust(db),
      /LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT/u,
      'an unmigrated trust row fails closed — the 1.12.0 ship without the migration is fenced out',
    );
  } finally {
    db.close();
  }
});

test('BLOCKING MUTATION (f): a receipt from a foreign provider digest is rejected — never replayed', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0, compose: [] };
  try {
    const root = fixtureRepo();
    const db = toctouStore(root);
    const { manifestDigest, submissionId } = insertManifest(db);
    const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
    try {
      // A 'passed' receipt for this exact subject, but written by a FOREIGN
      // provider digest (a swapped implementation). Without the digest fence
      // the provider would replay it verbatim.
      db.prepare(
        `INSERT INTO factory_check_receipts
           (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
            provider_id, provider_version, provider_digest, environment_ref,
            outcome, evidence_refs, receipt_digest)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'receipt:toctou:foreign', 'gate-run:toctou', candidateSets.subjectRef,
        'factory.local-runnability.v1', '0.0.0-foreign', 'sha256:foreign-implementation-digest',
        null, 'passed', '[]', 'digest:foreign',
      );
      const provider = createLocalRunnabilityCheckProvider({
        db,
        candidateSets,
        executorSelector: () => dockerExecutorFake(calls, {
          prepareError: new ReadinessExecutionError(
            'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED', 'pull failed (proof)',
          ),
        }),
        substrateRetrySleep: () => {},
      });
      scriptDaemonObservations([{ available: true, linux: true }]);
      const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));
      // The foreign receipt did NOT replay: the provider genuinely executed
      // (and failed) under its own identity.
      assert.equal(result.outcome, 'failed',
        'a foreign-digest receipt is fenced out — the check re-executes');
      assert.equal(calls.prepare, 1);
      assert.equal(decodeDiagnostics(result)[0].code, 'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED');
    } finally {
      installDockerInfoProbeForTests(null);
      resetDockerAvailabilityCache();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('BLOCKING MUTATION (f): the obligation compiler pins factory.local-runnability.v1 @ 1.12.0 (norm and manifest move together)', async () => {
  const contract = ACCEPTANCE_OBLIGATION_CONTRACTS
    .find(entry => entry.obligationId === 'factory.local-runnability');
  assert.ok(contract, 'the factory.local-runnability obligation exists');
  assert.equal(contract.version, '1.12.0', 'the obligation pin is 1.12.0');
  assert.equal(contract.expectedProtection.logicalId, 'factory.local-runnability.v1');
  assert.equal(contract.expectedProtection.version, '1.12.0',
    'the expected protection pins the installed provider at 1.12.0');
  assert.match(contract.protectedProperty, /mechanical daemon re-probe/u,
    'the protected property states the ADR-091 contract');
  // The compiler reconciles the norm against the INSTALLED protection
  // surface: any version divergence (norm ≠ manifest) fires
  // PROTECTION_VERSION_DIVERGENCE — the atomic-bump guard.
  const installed = await readInstalledProtections();
  assert.doesNotThrow(() => assertProtectionSetEquality(ACCEPTANCE_OBLIGATION_CONTRACTS, installed),
    'the obligation pin and the installed 1.12.0 provider move in the SAME change');
  const installedRunnability = installed.find(
    protection => protection.kind === 'check-provider'
      && protection.logicalId === 'factory.local-runnability.v1',
  );
  assert.equal(installedRunnability.version, '1.12.0');
});
