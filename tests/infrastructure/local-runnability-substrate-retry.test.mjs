// tests/infrastructure/local-runnability-substrate-retry.test.mjs
//
// CC-GAP-9 / ADR-089 — bounded deterministic in-check substrate retry, then
// typed unknown (`warrant-blocked-environment`) and human_required
// blocked/resumable routing. Never a product-failed verdict.
//
// This file carries the CC-00C CC-GAP-9 BLOCKING MUTATIONS (a)-(e):
//   a. routing a DOCKER_UNAVAILABLE-class substrate failure directly to a
//      terminal product failure (complete-failed) fails routing — the real
//      gate driver + the real installed readiness plan must reduce the typed
//      unknown receipt to human_required → complete-blocked;
//   b. collapsing product-failed / oracle-insufficient / substrate-unavailable
//      into one outcome fails classification (including the exact Elite-6
//      shape: 'failed' + LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE);
//   c. skipping the bounded in-check retry (1 probe) or retrying unboundedly
//      (> the frozen bound) fails the frozen-policy proofs;
//   d. charging an exhausted retry to worker repair budget or CandidateSets
//      fails isolation — the exhausted path writes no receipts, creates no
//      candidate sets, and emits no seam repair issue (the repair router);
//   e. an earlier unknown receipt preventing/failing/annotating a later
//      passed receipt for the same criterion fails the no-poison rule.
//
// Plus the tracker rendering assertion: `unknown` is rendered neither as
// pass nor as product-failed on any surface (assertRenderedCheckOutcomeTruthful).
//
// Scope guards (CC-00C): CC-GAP-7 warrant execution is NOT implemented here
// (no oracle adapters, no VerificationWarrantRef execution); CC-GAP-8 ledger
// semantics are untouched (the no-poison proof rides the provider's own
// persisted-receipt replay seam).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { driveGateRun } from '../../dist/process-modules/application/gate-run-driver.js';
import { FactoryCheckProviderRegistry } from '../../dist/process-modules/application/standard-check-providers.js';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
} from '../../dist/modules/development/application/candidate-check-contracts.js';
import { createDevelopmentReadinessMonotonicityCheckProvider } from '../../dist/modules/development/application/development-check-providers.js';
import { createGitPort } from '../../dist/infrastructure/process-modules/git-machine-ports.js';
import { ReadinessExecutionError } from '../../dist/infrastructure/verification/readiness-executor.js';
import {
  installDockerInfoProbeForTests,
  isDockerAvailableForReadiness,
  peekDockerAvailabilityCacheForTests,
  resetDockerAvailabilityCache,
  seedDockerAvailabilityCacheForTests,
} from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  assertRenderedCheckOutcomeTruthful,
  classifyCheckOutcome,
  runBoundedSubstrateRetry,
  SUBSTRATE_PRECONDITION_CODES,
  SUBSTRATE_PRECONDITION_DIAGNOSTIC,
  SUBSTRATE_RETRY_POLICY,
} from '../../dist/infrastructure/verification/substrate-retry.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';

const PROCESS_RUN_ID = 41;
const CANDIDATE_HASH = 'e'.repeat(64);
const SOURCE_REF = `development-integrated-source-candidate:${PROCESS_RUN_ID}:${CANDIDATE_HASH}`;

// ---------------------------------------------------------------------------
// The frozen policy contract (CC-GAP-9 mutation c anchor).
// ---------------------------------------------------------------------------

test('frozen substrate retry policy: exactly two precondition codes, frozen bound and schedule', () => {
  assert.deepEqual([...SUBSTRATE_PRECONDITION_CODES], [
    'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
    'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX',
  ]);
  // The bound and schedule are frozen CODE constants — deterministic,
  // finite, positive. Anything env-driven, zero-bound (skip) or unbounded
  // would break this proof.
  assert.ok(SUBSTRATE_RETRY_POLICY.maxAttempts >= 2,
    'the bound must permit at least one genuine retry');
  assert.ok(Number.isSafeInteger(SUBSTRATE_RETRY_POLICY.maxAttempts));
  assert.ok(SUBSTRATE_RETRY_POLICY.retryDelayMs > 0);
  assert.equal(SUBSTRATE_PRECONDITION_DIAGNOSTIC, 'warrant-blocked-environment',
    'the ADR-089 typed unknown vocabulary is frozen verbatim');
});

// ---------------------------------------------------------------------------
// The bounded retry loop (hermetic; CC-GAP-9 mutation c).
// ---------------------------------------------------------------------------

test('retry loop: exhausted after exactly the frozen bound, schedule honored, attempts recorded', () => {
  const sleeps = [];
  const probes = [];
  const outcome = runBoundedSubstrateRetry({
    attempt: () => {
      probes.push(1);
      throw new ReadinessExecutionError(
        'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', 'daemon down (probe)',
      );
    },
    sleep: (ms) => sleeps.push(ms),
  });
  // BLOCKING MUTATION c (skipped retry): fewer probes than the frozen bound
  // (escalating on the first miss) fails here.
  assert.equal(probes.length, SUBSTRATE_RETRY_POLICY.maxAttempts,
    'exhaustion happens after EXACTLY the frozen attempt count — never fewer');
  // BLOCKING MUTATION c (unbounded retry): more probes than the bound
  // (a silent wait-until-up loop) would fail the length assertion above.
  assert.equal(outcome.status, 'exhausted');
  assert.equal(outcome.attempts.length, SUBSTRATE_RETRY_POLICY.maxAttempts);
  assert.deepEqual(
    outcome.attempts.map(attempt => attempt.code),
    Array.from({ length: SUBSTRATE_RETRY_POLICY.maxAttempts },
      () => 'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE'),
  );
  // Deterministic frozen schedule: the fixed delay between attempts, never
  // after the last one.
  assert.deepEqual(
    sleeps,
    Array.from({ length: SUBSTRATE_RETRY_POLICY.maxAttempts - 1 },
      () => SUBSTRATE_RETRY_POLICY.retryDelayMs),
  );
  assert.equal(outcome.attempts[0].attempt, 1);
  assert.equal(outcome.attempts[outcome.attempts.length - 1].attempt,
    SUBSTRATE_RETRY_POLICY.maxAttempts);
});

test('retry loop: recovery inside the bound satisfies without exhausting; both precondition codes retry', () => {
  for (const code of SUBSTRATE_PRECONDITION_CODES) {
    let probes = 0;
    const sleeps = [];
    const outcome = runBoundedSubstrateRetry({
      attempt: () => {
        probes += 1;
        if (probes < SUBSTRATE_RETRY_POLICY.maxAttempts) {
          throw new ReadinessExecutionError(code, 'transient');
        }
        return 'substrate-up';
      },
      sleep: (ms) => sleeps.push(ms),
    });
    assert.equal(outcome.status, 'satisfied');
    assert.equal(outcome.result, 'substrate-up');
    assert.equal(probes, SUBSTRATE_RETRY_POLICY.maxAttempts);
    assert.equal(sleeps.length, SUBSTRATE_RETRY_POLICY.maxAttempts - 1);
  }
});

test('retry loop: non-precondition failures propagate immediately — no retry widening', () => {
  // DOCKER_PULL_FAILED is a substrate-CONFIG failure, not a missing
  // environment precondition; command/product failures are plain Errors.
  // Widening the retry set (or blanket-retrying ReadinessExecutionError)
  // would make these probes count > 1 and fail this proof.
  for (const error of [
    new ReadinessExecutionError('LOCAL_RUNNABILITY_DOCKER_PULL_FAILED', 'pull failed'),
    new Error('npm test exited 1'),
  ]) {
    let probes = 0;
    assert.throws(
      () => runBoundedSubstrateRetry({
        attempt: () => {
          probes += 1;
          throw error;
        },
        sleep: () => { throw new Error('sleep must not run'); },
      }),
      error,
    );
    assert.equal(probes, 1, 'non-precondition failures are never retried');
  }
});

// ---------------------------------------------------------------------------
// Provider seam (hermetic executor injection).
// ---------------------------------------------------------------------------

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'saga-substrate-retry-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), 'process.exit(0);\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'substrate-fixture', version: '1.0.0', scripts: { test: 'node test.js' },
  }));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'fixture');
  return root;
}

/** A ReadinessExecutor fake whose prepare throws the given typed code. */
function throwingExecutor(code, calls) {
  return {
    prepare() {
      calls.push(code);
      throw new ReadinessExecutionError(code, `${code}: simulated for proof`);
    },
    runCommand() { throw new Error('unreachable'); },
    runServed() { throw new Error('unreachable'); },
    describe() { return { substrate: 'docker', image: 'node:20-alpine' }; },
    dispose() { /* nothing owned */ },
  };
}

/** A passing docker-shaped executor fake (contract-faithful: a docker describe carries a well-formed baseImageDigest). */
function passingExecutor() {
  return {
    prepare() {},
    runCommand() {},
    runServed() { return { port: 1, stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64) }; },
    describe() {
      return {
        substrate: 'docker',
        image: 'node:20-alpine',
        baseImageDigest: `sha256:${'e'.repeat(64)}`,
      };
    },
    dispose() {},
  };
}

function substrateStore(root) {
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
  // The integrated-source candidate the readiness manifest binds to.
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

/** Insert a readiness-manifest submission whose profile declares docker. */
function insertDockerManifest(db, { id = 1, image = 'node:20-alpine' } = {}) {
  const manifest = {
    schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: { schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA, ref: SOURCE_REF, hash: CANDIDATE_HASH },
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'npm test' },
        environment: { image },
      },
    }],
  };
  const contentHash = 'f'.repeat(64);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, `worker-execution:substrate-${id}`,
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(manifest), contentHash,
  );
  return { manifestDigest: contentHash, submissionId: id };
}

/** Candidate-set reader over the manifest submission (the certifier's sealed set). */
function manifestCandidateSets({ submissionId, manifestDigest }) {
  const subjectRef = `candidate-set/substrate-${submissionId}`;
  return {
    subjectRef,
    readCount: 0,
    reads: [],
    read(ref) {
      this.reads.push(ref);
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

const RUN_ARGS = (subjectRef) => ({
  subjectCandidateSetRef: subjectRef, parameters: {},
  environmentRef: null, candidateSnapshot: {},
});

function decodeDiagnostics(result) {
  return result.evidenceRefs
    .map(ref => decodeCheckDiagnostic(ref))
    .filter(diag => diag !== null);
}

test('provider: exhausted docker-unavailable retry → typed unknown with attempt evidence and NO seam repair issue', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  const prepareCalls = [];
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => throwingExecutor('LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', prepareCalls),
      substrateRetrySleep: () => { /* hermetic instant schedule */ },
    });
    const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));

    // The typed unknown — never failed, never passed (ADR-089 §3).
    assert.equal(result.outcome, 'unknown');

    // Exactly the frozen bound of executor preparations (mutation c anchor).
    assert.equal(prepareCalls.length, SUBSTRATE_RETRY_POLICY.maxAttempts);

    // The frozen diagnostic vocabulary + attempt evidence ride the receipt.
    const diagnostics = decodeDiagnostics(result);
    const warrant = diagnostics.find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
    assert.ok(warrant, 'the warrant-blocked-environment diagnostic must ride the receipt');
    assert.match(warrant.message, /LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE/u);
    assert.match(warrant.message, new RegExp(`${SUBSTRATE_RETRY_POLICY.maxAttempts} in-check attempts`, 'u'));
    assert.match(warrant.message, /outcome is unknown, not failed/u);

    // The observation digest content includes the frozen-policy attempt
    // evidence — prove it through the receipt shape: the first evidence ref
    // is the content-addressed local-readiness proof.
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);

    // NO seam repair issue: a substrate precondition is not a product
    // defect; nothing may route to a repair round (ADR-089 Red Team #3).
    assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'an exhausted substrate retry must not emit a seam repair issue');

    // BLOCKING MUTATION d (isolation): the provider wrote no receipts (the
    // Gate driver writes receipts, never the check), and the candidate-set
    // reader was only READ.
    const receipts = db.prepare('SELECT COUNT(*) AS n FROM factory_check_receipts').get();
    assert.equal(receipts.n, 0,
      'the provider never writes receipts — no budget/candidate accounting side effects');
    assert.ok(candidateSets.reads.length > 0);
    assert.ok(candidateSets.reads.every(ref => typeof ref === 'string'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider: DOCKER_NOT_LINUX is the same precondition class (typed unknown, frozen bound)', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  const prepareCalls = [];
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => throwingExecutor('LOCAL_RUNNABILITY_DOCKER_NOT_LINUX', prepareCalls),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));
    assert.equal(result.outcome, 'unknown');
    assert.equal(prepareCalls.length, SUBSTRATE_RETRY_POLICY.maxAttempts);
    const warrant = decodeDiagnostics(result)
      .find(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
    assert.ok(warrant);
    assert.match(warrant.message, /LOCAL_RUNNABILITY_DOCKER_NOT_LINUX/u);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider: genuine non-precondition failures stay product-`failed` with their seam repair issue (no widening)', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  const prepareCalls = [];
  // ADR-091: a non-precondition executor failure is classified by the
  // mechanical re-probe — pin the observed daemon HEALTHY so this proof
  // pins the available+linux direction (bad image/tag stays product
  // `failed`) on every machine, daemon or no daemon.
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  try {
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => throwingExecutor('LOCAL_RUNNABILITY_DOCKER_PULL_FAILED', prepareCalls),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));
    // A pull failure with the daemon OBSERVED healthy is a deterministic
    // substrate-config failure, NOT a missing environment precondition: the
    // existing fail-closed 'failed' semantics are preserved exactly (single
    // attempt, seam issue rides).
    assert.equal(result.outcome, 'failed');
    assert.equal(prepareCalls.length, 1,
      'only the two frozen precondition codes are retried');
    const diagnostics = decodeDiagnostics(result);
    assert.equal(diagnostics[0].code, 'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED');
    assert.match(diagnostics[0].message, /ADR-091 mid-check re-probe observed docker available \+ linux/u,
      'the healthy re-probe observation rides the failure evidence');
    assert.ok(result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'genuine failures keep their typed seam repair issue');
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CC-GAP-9 follow-up — the residual cache hole (start-of-check invalidation).
//
// The retry loop already invalidated the docker availability cache BETWEEN
// attempts, but the FIRST attempt of every check reused the process-lifetime
// cache: a stale POSITIVE left by a previous check in the same engine process
// masked a down daemon (the precondition probe "passed", the subsequent pull
// failed) → LOCAL_RUNNABILITY_DOCKER_PULL_FAILED → 'failed' + upstream →
// complete-failed — the exact Elite-6 machine-fault-as-product-verdict shape,
// one diagnostic code over, with NO retry at all. A stale NEGATIVE was
// replayed as attempt-1 evidence without any genuine probe.
// ---------------------------------------------------------------------------

test('follow-up: the check invalidates the availability cache BEFORE the first attempt — no attempt ever observes a stale process-level entry', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  try {
    // A previous check in this process observed docker UP; that observation
    // is now stale. Without the start-of-check invalidation every prepare
    // below would observe the seeded entry instead of null.
    seedDockerAvailabilityCacheForTests({ available: true, linux: true });
    const cacheObservedAtPrepare = [];
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => ({
        prepare() {
          cacheObservedAtPrepare.push(peekDockerAvailabilityCacheForTests());
          throw new ReadinessExecutionError(
            'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', 'stale-cache ordering proof',
          );
        },
        runCommand() { throw new Error('unreachable'); },
        runServed() { throw new Error('unreachable'); },
        describe() { return { substrate: 'docker', image: 'node:20-alpine' }; },
        dispose() {},
      }),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));
    assert.equal(result.outcome, 'unknown');
    assert.equal(cacheObservedAtPrepare.length, SUBSTRATE_RETRY_POLICY.maxAttempts);
    // THE follow-up invariant: EVERY attempt — the first included — starts
    // from a genuinely empty observation (null), never a stale cached entry.
    assert.deepEqual(
      cacheObservedAtPrepare,
      Array.from({ length: SUBSTRATE_RETRY_POLICY.maxAttempts }, () => null),
      'attempt 1 must genuinely re-probe: the stale process-level availability'
        + ' entry is invalidated at the start of every check, not only between retries',
    );
    // And nothing re-populated the cache behind the fake executors' backs.
    assert.equal(peekDockerAvailabilityCacheForTests(), null);
  } finally {
    resetDockerAvailabilityCache();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('follow-up BLOCKING: a stale POSITIVE cache over a genuinely down daemon never becomes a product failure (no Elite-6 poisoning through the pull path)', {
  timeout: 60_000,
  skip: isDockerAvailableForReadiness()
    ? 'docker daemon is available — the stale-positive proof needs the daemon genuinely down'
    : false,
}, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  try {
    // A previous check in this engine process observed docker UP; the daemon
    // has since gone down. Without the start-of-check invalidation the
    // precondition probe trusts the stale cache, the pull then fails against
    // the dead daemon, and the check records LOCAL_RUNNABILITY_DOCKER_
    // PULL_FAILED → 'failed' (upstream-owned verdict; the flow routes it through settlement) with zero retries.
    seedDockerAvailabilityCacheForTests({ available: true, linux: true });
    // The REAL production executor selector (no injection): the profile
    // declares environment.image, so DockerReadinessExecutor.prepare is the
    // genuine probe path.
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(candidateSets.subjectRef));

    assert.equal(result.outcome, 'unknown',
      'a stale positive cache must not mask the missing precondition as a product failure');
    const diagnostics = decodeDiagnostics(result);
    assert.ok(diagnostics.some(diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC),
      'the typed unknown carries the warrant-blocked-environment diagnostic');
    assert.ok(!diagnostics.some(diag => diag.code === 'LOCAL_RUNNABILITY_DOCKER_PULL_FAILED'),
      'the down daemon must surface as the retried DOCKER_UNAVAILABLE precondition,'
        + ' never as the non-retried pull failure (the Elite-6 shape one code over)');
    assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'a substrate precondition is not a product defect — no seam repair issue');

    // The stale positive was replaced by GENUINE probe observations: the
    // daemon is down, so the post-check cache holds the honest result of the
    // last real probe, not the seeded lie.
    assert.deepEqual(peekDockerAvailabilityCacheForTests(), { available: false, linux: false });
  } finally {
    resetDockerAvailabilityCache();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION a — routing: the real gate driver over the real
// installed readiness plan reduces the typed unknown to human_required
// (complete-blocked), never failed (complete-failed).
// ---------------------------------------------------------------------------

const CERTIFY_NODE = developmentProcessModule.flow.nodes
  .find(node => node.id === 'certify-product-readiness');
const CERTIFY_PLAN = CERTIFY_NODE.cellDefinition.authorGate.checkPlan;

test('installed plan contract: runnability unknown routes human-required to complete-blocked; genuine failures stay upstream→failed verdict→settlement', () => {
  const runnabilityEntry = CERTIFY_PLAN.entries
    .find(entry => entry.check.providerId === 'factory.local-runnability.v1');
  assert.ok(runnabilityEntry, 'the readiness plan owns local runnability');
  // BLOCKING MUTATION a (static arm): dropping the human-required
  // disposition (back to author repair, or to a failure route) fails here —
  // an unknown substrate receipt must STOP THE LINE, not repair, not fail.
  assert.equal(runnabilityEntry.indeterminateDisposition, 'human-required');
  // Genuine product failures keep the upstream escalation at the GATE: a
  // deterministic red check is a producer verdict ('failed'), never a
  // workplace-local repair round.
  assert.equal(runnabilityEntry.failureOwnership, 'upstream');
  // The cell routes human_required to the blocked/resumable terminal.
  assert.equal(CERTIFY_NODE.cellDefinition.transitions.humanRequired, 'complete-blocked');
  // CC-GAP-8 terminal accounting: the failed verdict routes through the
  // settlement kernel (NOT the bare complete-failed emitter) — the ledger is
  // open by then, so only settlement may terminalize the run. Settlement's
  // X3 failed-receipt read decides blocked / candidate-missing /
  // local-readiness-failed and records the terminal-route facts; the gate
  // verdict 'failed' (asserted by the control test below) is what feeds it.
  assert.equal(CERTIFY_NODE.cellDefinition.transitions.failed, 'settle-development');
  assert.equal(CERTIFY_NODE.cellDefinition.transitions.accepted, 'bind-runnable-candidate');
  // The flow table agrees with the cell declaration — the post-ledger
  // failure edge targets settlement on both surfaces.
  assert.ok(developmentProcessModule.flow.transitions.some(transition =>
    transition.from === 'certify-product-readiness'
      && transition.on === 'domain.failed'
      && transition.to === 'settle-development'));
  // The blocked outcome is a truthful non-failure terminal (Development
  // outcomes: verified | blocked | failed) — resumable through the
  // continuation machinery, distinct from the failed terminal.
  const blockedOutcome = developmentProcessModule.outcomes
    .find(outcome => outcome.code === 'blocked');
  const failedOutcome = developmentProcessModule.outcomes
    .find(outcome => outcome.code === 'failed');
  assert.ok(blockedOutcome.terminal && failedOutcome.terminal);
  assert.notEqual(blockedOutcome, failedOutcome);
  // Plan identity: the v3 bump is the honest identity/digest change for the
  // CC-GAP-9 routing contract.
  assert.equal(CERTIFY_PLAN.checkPlanId, 'development.readiness-certification.final.v4');
});

test('BLOCKING MUTATION a: substrate-exhausted certification gate → human_required (complete-blocked), never failed (complete-failed)', { timeout: 120_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  const prepareCalls = [];
  try {
    const registry = new FactoryCheckProviderRegistry();
    registry.register(createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets, git: createGitPort(),
    }));
    registry.register(createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => throwingExecutor('LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', prepareCalls),
      substrateRetrySleep: () => {},
    }));
    const gateRepo = new SqliteGateRepository(db);
    const result = await driveGateRun(gateRepo, registry, {
      workplaceRef: {
        processRunId: PROCESS_RUN_ID,
        moduleRef: 'solution-development',
        productionCellId: 'development-readiness-certification',
        workKey: 'singleton',
      },
      subjectCandidateSetRef: candidateSets.subjectRef,
      checkPlan: CERTIFY_PLAN,
      gatePhase: 'final',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'gate-lease:substrate-retry',
      installationDigest: 'installation:substrate-retry-proof',
      checkParameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null,
      presentationRef: 'worker-execution:substrate-retry-proof',
    });

    // THE routing assertion (ADR-089 §4): the typed unknown stops the line
    // as human_required — the Elite-6 shape (failed → domain.failed →
    // complete-failed terminal) must be unreachable for a substrate miss.
    assert.equal(result.decision.verdict, 'human_required',
      'a substrate-unavailable receipt must reduce to human_required (complete-blocked), never failed');
    assert.equal(result.decision.repairTargetRole, null,
      'no repair round: a machine fault has no product defect to remove');

    const runnabilityReceipt = result.receipts.find(
      receipt => receipt.check.providerId === 'factory.local-runnability.v1');
    assert.ok(runnabilityReceipt);
    assert.equal(runnabilityReceipt.outcome, 'unknown');
    const warrant = runnabilityReceipt.evidenceRefs
      .map(ref => decodeCheckDiagnostic(ref))
      .find(diag => diag !== null && diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC);
    assert.ok(warrant, 'the receipt carries the warrant-blocked-environment diagnostic');
    assert.equal(prepareCalls.length, SUBSTRATE_RETRY_POLICY.maxAttempts,
      'the gate saw exactly the frozen in-check retry bound');

    // BLOCKING MUTATION d (budget isolation at the gate seam): one gate run,
    // one receipt per provider entry — no repair epochs, no extra candidate
    // sets, no WorkerExecution was created by the retry (the in-check retry
    // is observation-retry grammar, §21, not recovery, §17).
    const receiptRows = db.prepare(
      'SELECT COUNT(*) AS n FROM factory_check_receipts WHERE check_run_ref=?',
    ).get(result.decision.gateRunRef);
    assert.equal(receiptRows.n, CERTIFY_PLAN.entries.length);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('control: a genuine product failure still escalates failed (upstream) through the same gate', { timeout: 120_000 }, async () => {
  // Preserve genuine product failures as failed/upstream: the runnability
  // provider deterministically refutes the product (red test command output)
  // → receipt 'failed' → verdict 'failed'. This control proves the CC-GAP-9
  // routing change did not soften product-failure semantics AT THE GATE. The
  // cell's failed transition then routes that verdict through
  // settle-development (CC-GAP-8: only settlement terminalizes a post-ledger
  // run), where the X3 failed-receipt read settles blocked /
  // candidate-missing / local-readiness-failed — pinned by the
  // verification-ledger suite's certify-failed settlement test.
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  // ADR-091: the failing docker-executor test step is classified by the
  // mechanical re-probe — pin the observed daemon HEALTHY so this control
  // pins the product-failure direction (available+linux → original failure)
  // on every machine, daemon or no daemon.
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  try {
    const failing = {
      prepare() {},
      runCommand() { throw new Error('npm test exited 1: product is red'); },
      runServed() { throw new Error('unreachable'); },
      describe() { return { substrate: 'docker', image: 'node:20-alpine' }; },
      dispose() {},
    };
    const registry = new FactoryCheckProviderRegistry();
    registry.register(createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets, git: createGitPort(),
    }));
    registry.register(createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => failing,
      substrateRetrySleep: () => {},
    }));
    const result = await driveGateRun(new SqliteGateRepository(db), registry, {
      workplaceRef: {
        processRunId: PROCESS_RUN_ID,
        moduleRef: 'solution-development',
        productionCellId: 'development-readiness-certification',
        workKey: 'singleton',
      },
      subjectCandidateSetRef: candidateSets.subjectRef,
      checkPlan: CERTIFY_PLAN,
      gatePhase: 'final',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'gate-lease:product-failure-control',
      installationDigest: 'installation:product-failure-control',
      checkParameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null,
      presentationRef: 'worker-execution:product-failure-control',
    });
    assert.equal(result.decision.verdict, 'failed',
      'genuine product failures keep the upstream failed verdict at the gate');
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION e — no-poison: an earlier unknown receipt never
// prevents, fails, or annotates a later pass of the same criterion.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION e: an earlier unknown receipt never poisons a later pass (no-poison)', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = substrateStore(root);
  const { manifestDigest, submissionId } = insertDockerManifest(db);
  const candidateSets = manifestCandidateSets({ submissionId, manifestDigest });
  try {
    // Round 1 — the substrate is missing: typed unknown (hermetic).
    const prepareCalls = [];
    const missing = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => throwingExecutor('LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE', prepareCalls),
      substrateRetrySleep: () => {},
    });
    const unknown = await missing.run(RUN_ARGS(candidateSets.subjectRef));
    assert.equal(unknown.outcome, 'unknown');

    // Persist the unknown receipt EXACTLY as the gate driver would (the
    // provider only reads this table; the driver writes it). The REAL
    // provider identity is used so the replay lookup genuinely considers
    // this row and must exclude it by the outcome filter — proving the
    // no-poison mechanism, not a digest-mismatch artifact.
    db.prepare(
      `INSERT INTO factory_check_receipts
         (check_receipt_ref, check_run_ref, subject_candidate_set_ref,
          provider_id, provider_version, provider_digest, environment_ref,
          outcome, evidence_refs, receipt_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'receipt:substrate:round-1', 'gate-run:substrate', candidateSets.subjectRef,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_ID, 'test', LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
      null, 'unknown', JSON.stringify(unknown.evidenceRefs), 'digest:unknown:round-1',
    );

    // Round 2 — the substrate recovered: the same criterion executes again
    // under current authority and PASSES. The earlier unknown is append-only
    // history: it must not replay, not conflict, not annotate, not fail.
    const recovered = createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => passingExecutor(),
      substrateRetrySleep: () => {},
    });
    const laterPass = await recovered.run(RUN_ARGS(candidateSets.subjectRef));
    assert.equal(laterPass.outcome, 'passed',
      'an earlier unknown receipt must never poison a later pass of the same criterion');
    // And the honest pass carries no warrant-blocked-environment stain.
    assert.ok(!decodeDiagnostics(laterPass).some(
      diag => diag.code === SUBSTRATE_PRECONDITION_DIAGNOSTIC),
      'the later pass is not annotated by the earlier unknown');
    // The unknown receipt row remains append-only history.
    const outcomes = db.prepare(
      'SELECT outcome FROM factory_check_receipts ORDER BY check_receipt_ref',
    ).all().map(row => row.outcome);
    assert.deepEqual(outcomes, ['unknown']);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BLOCKING MUTATION b — classification: the three classes never collapse;
// plus the tracker rendering assertion.
// ---------------------------------------------------------------------------

test('BLOCKING MUTATION b + tracker rendering: unknown is neither pass nor product-failed; the Elite-6 flattening shape fails classification', () => {
  // The honest post-fix shapes classify and render cleanly.
  assert.equal(classifyCheckOutcome({
    outcome: 'unknown', diagnosticCode: 'warrant-blocked-environment',
  }), 'substrate-unavailable');
  assert.equal(classifyCheckOutcome({
    outcome: 'failed', diagnosticCode: 'local-runnability',
  }), 'product-failed');
  assert.equal(classifyCheckOutcome({ outcome: 'unknown' }), 'oracle-insufficient');
  assert.equal(classifyCheckOutcome({ outcome: 'passed' }), 'passed');
  assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
    receiptOutcome: 'unknown',
    diagnosticCode: 'warrant-blocked-environment',
    renderedAs: 'unknown',
  }));
  assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
    receiptOutcome: 'failed', diagnosticCode: 'local-runnability', renderedAs: 'failed',
  }));
  assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
    receiptOutcome: 'passed', renderedAs: 'pass',
  }));

  // The EXACT Elite-6 defect shape: the pre-fix provider emitted
  // evidence('failed', …, LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE) — a
  // substrate precondition riding a product-failed receipt. Classification
  // must fail closed on this collapse (and on its DOCKER_NOT_LINUX twin).
  for (const code of SUBSTRATE_PRECONDITION_CODES) {
    assert.throws(
      () => assertRenderedCheckOutcomeTruthful({
        receiptOutcome: 'failed', diagnosticCode: code, renderedAs: 'failed',
      }),
      /CHECK_OUTCOME_CLASS_COLLAPSE/u,
    );
  }

  // Tracker rendering assertion: unknown rendered as pass (poison-green)…
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'unknown',
      diagnosticCode: 'warrant-blocked-environment',
      renderedAs: 'pass',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
  // …or as product-failed (the flattening) both fail.
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'unknown',
      diagnosticCode: 'warrant-blocked-environment',
      renderedAs: 'failed',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
  // A product-failed receipt rendered as pass fails too (class honesty).
  assert.throws(
    () => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'failed', diagnosticCode: 'local-runnability', renderedAs: 'pass',
    }),
    /CHECK_OUTCOME_RENDER_COLLAPSE/u,
  );
});
