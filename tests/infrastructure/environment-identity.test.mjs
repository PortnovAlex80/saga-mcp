// tests/infrastructure/environment-identity.test.mjs
//
// K19 image/dependency identity remainder (ADR-083 §2.1, train commit 3
// digest remainder + commit 5 drift proofs) — the AUTHORITATIVE environment
// identity evidence:
//
//   - the base image identity is the OCI REGISTRY MANIFEST DIGEST
//     (`sha256:<64hex>` from the pulled image's RepoDigests), NEVER the
//     declared floating tag and NEVER the local image id (the local config
//     digest `docker image inspect {{.Id}}` reports). A locally built/loaded
//     image has no registry provenance — that is MISSING identity evidence
//     and fails closed;
//   - the dependency lock identity (`dependencyLockDigest`) is the sha256
//     over the sealed tree's EXACT lock material. Two trees that differ only
//     in lock bytes are DIFFERENT environments — a drifted lock must not
//     reuse an identity (and must not ride a prior receipt's digest);
//   - both identities bind the deterministic receipt/digest fence: the
//     content-addressed `local-readiness:<digest>` evidence ref is a function
//     of the observed identities. Substituting one authoritative field while
//     holding the rest constant MUST change the receipt (mutation oracle);
//   - K19 owns identity, ADR-091 owns availability (ADR-083 §6 split): an
//     image-IDENTITY failure is a product `failed` with a typed diagnostic —
//     never the ADR-089 substrate `unknown` — even when the daemon is
//     observed available+linux.
//
// RED (pre-implementation, exact semantic reasons): the dependency-lock
// oracle fails because environmentDigest ignores lock bytes; the receipt
// oracle fails because the observation drops the executor's
// baseImageDigest (the receipt keeps binding only the mutable tag). The
// resolver battery fails because the authority does not exist. Everything
// else is a ratchet: it passes before AND after (the proof universe only
// grows).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import { deriveExecutionEnvironment } from '../../dist/infrastructure/verification/environment-derivation.js';
import * as dockerExecutorModule from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import { ReadinessExecutionError } from '../../dist/infrastructure/verification/readiness-executor.js';
import {
  installDockerInfoProbeForTests,
  resetDockerAvailabilityCache,
} from '../../dist/infrastructure/verification/docker-readiness-executor.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';

const PROCESS_RUN_ID = 91;
const CANDIDATE_HASH = '7'.repeat(64);
const SOURCE_REF = `development-integrated-source-candidate:${PROCESS_RUN_ID}:${CANDIDATE_HASH}`;
const IMAGE = 'node:20-alpine';
const MANIFEST_A = `sha256:${'a'.repeat(64)}`;
const MANIFEST_B = `sha256:${'b'.repeat(64)}`;

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/**
 * The sealed artefact fixture: a static product with a docker-substrate
 * readiness profile. Optionally carries exact npm lock material.
 */
function fixtureRepo({ lockContent } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'saga-env-identity-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), 'process.exit(0);\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'env-identity-fixture', version: '1.0.0', scripts: { test: 'node test.js' },
  }));
  if (lockContent !== undefined) {
    writeFileSync(join(root, 'package-lock.json'), lockContent);
  }
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'fixture');
  return root;
}

function identityStore(root) {
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
        commands: { installCommand: null, testCommand: 'node test.js' },
        environment: { image: IMAGE },
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
    1, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, 'worker-execution:identity-1',
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(manifest), contentHash,
  );
  return db;
}

function manifestCandidateSets() {
  const subjectRef = 'candidate-set/identity-1';
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
            ref: 'managed-node-submission:1',
            digest: 'c'.repeat(64),
          },
          origin: 'produced',
          sourceCandidateSetRef: null,
        }],
      };
    },
  };
}

/**
 * A docker-executor fake faithful to the DockerReadinessExecutor identity
 * contract: it OBSERVED a registry manifest digest for the declared image and
 * reports it through describe(). prepare() may throw a typed identity error.
 */
function dockerExecutorFake(calls, { baseImageDigest, prepareError } = {}) {
  return {
    prepare() {
      calls.prepare += 1;
      if (prepareError) throw prepareError;
    },
    runCommand() { calls.runCommand += 1; },
    runServed() { throw new Error('unreachable in this proof'); },
    describe() {
      return {
        substrate: 'docker',
        image: IMAGE,
        ...(baseImageDigest !== undefined ? { baseImageDigest } : {}),
      };
    },
    dispose() { calls.dispose += 1; },
  };
}

async function runIdentityCase({ executor, root }) {
  // MUTATION ORACLE DISCIPLINE: when a caller supplies the root, every arm of
  // a fence-mutation proof runs against the EXACT SAME sealed subject (same
  // commit/tree bytes). Receipts may then differ ONLY through the one
  // authoritative field the test substitutes — never through incidental
  // subject identity (a fresh repo would mint a fresh commitSha and make the
  // oracle vacuously green).
  const fixtureRoot = root
    ?? fixtureRepo({ lockContent: '{"lockfileVersion":3,"packages":{}}\n' });
  const db = identityStore(fixtureRoot);
  const candidateSets = manifestCandidateSets();
  let out;
  try {
    out = {
      result: await createLocalRunnabilityCheckProvider({
        db,
        candidateSets,
        executorSelector: () => executor,
        substrateRetrySleep: () => { /* hermetic instant schedule */ },
      }).run({
        subjectCandidateSetRef: candidateSets.subjectRef, parameters: {},
        environmentRef: null, candidateSnapshot: {},
      }),
    };
  } finally {
    if (!out) db.close();
  }
  db.close();
  if (root === undefined) rmSync(fixtureRoot, { recursive: true, force: true });
  return out.result;
}

// ---------------------------------------------------------------------------
// Dependency lock identity (ADR-083 §2.1 dependencyLockDigest).
// ---------------------------------------------------------------------------

test('K19 dependency lock identity: the EXACT lock material binds the derived environment — one drifted lock byte is a DIFFERENT environment', () => {
  const lockA = '{"lockfileVersion":3,"packages":{"":{"name":"env-identity-fixture","version":"1.0.0"}}}\n';
  const lockB = '{"lockfileVersion":3,"packages":{"":{"name":"env-identity-fixture","version":"1.0.1"}}}\n';
  const rootA = fixtureRepo({ lockContent: lockA });
  const rootB = fixtureRepo({ lockContent: lockB });
  try {
    const a = deriveExecutionEnvironment({ directory: rootA, installCommand: null });
    const b = deriveExecutionEnvironment({ directory: rootB, installCommand: null });
    // ORACLE: same sources, same manifests, same install — only the resolved
    // lock material drifted. The environment identity MUST move with it.
    assert.notEqual(a.environmentDigest, b.environmentDigest,
      'a changed dependency lock is a DIFFERENT environment identity (never a reused one)');
    assert.ok(a.dependencyLock,
      'the derivation states the dependency lock identity explicitly');
    assert.deepEqual(a.dependencyLock.files.map(f => f.file), ['package-lock.json']);
    assert.match(a.dependencyLock.dependencyLockDigest, /^[a-f0-9]{64}$/u);
    assert.notEqual(a.dependencyLock.dependencyLockDigest, b.dependencyLock.dependencyLockDigest);
    // Determinism: the same bytes derive the same identity.
    const a2 = deriveExecutionEnvironment({ directory: rootA, installCommand: null });
    assert.equal(a.environmentDigest, a2.environmentDigest,
      'the derivation is a pure function of the sealed bytes');
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('K19 dependency lock honesty: a tree with NO lock material derives an identity that says so — never a fabricated lock', () => {
  const root = fixtureRepo();
  try {
    const derived = deriveExecutionEnvironment({ directory: root, installCommand: null });
    assert.deepEqual(derived.dependencyLock.files, [],
      'no lock material in the sealed tree is reported as exactly that');
    assert.match(derived.dependencyLock.dependencyLockDigest, /^[a-f0-9]{64}$/u,
      'the lock identity is still a deterministic statement (the empty lock is a fact, not a gap)');
    const again = deriveExecutionEnvironment({ directory: root, installCommand: null });
    assert.equal(derived.environmentDigest, again.environmentDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Registry manifest digest resolution (ADR-083 §2.1 baseImageDigest; §3
// floating-tag prohibition). Pure unit battery over the exported resolver.
// ---------------------------------------------------------------------------

test('K19 base image identity: the authority exists — resolveRegistryManifestDigest is exported', () => {
  assert.equal(typeof dockerExecutorModule.resolveRegistryManifestDigest, 'function',
    'the executor exports the OCI registry manifest digest resolver (the authority that refuses tags and local image ids)');
});

test('K19 base image identity: a tag reference resolves to the OBSERVED registry manifest digest (RepoDigests), across reference normalizations', () => {
  const resolve = dockerExecutorModule.resolveRegistryManifestDigest;
  const observed = [`node@${MANIFEST_A}`];
  assert.equal(resolve('node:20-alpine', observed), MANIFEST_A,
    'a floating tag resolves to the immutable registry manifest digest actually pulled');
  assert.equal(resolve('node', observed), MANIFEST_A);
  assert.equal(resolve('docker.io/library/node:20-alpine', observed), MANIFEST_A,
    'docker.io/library normalization matches the RepoDigest repo name');
  assert.equal(
    resolve('ghcr.io/acme/app:1.2.3', [`ghcr.io/acme/app@${MANIFEST_B}`]),
    MANIFEST_B,
    'a fully-qualified foreign-registry reference matches its own repo',
  );
});

/** Assert a typed ReadinessExecutionError code (the code, not the prose message). */
function assertTypedCode(fn, code) {
  assert.throws(
    fn,
    error => error instanceof ReadinessExecutionError && error.code === code,
    `expected the typed identity failure ${code}`,
  );
}

test('K19 base image identity: a digest-pinned reference is honored — and a substituted content under the pin fails closed', () => {
  const resolve = dockerExecutorModule.resolveRegistryManifestDigest;
  assert.equal(resolve(`node@${MANIFEST_A}`, [`node@${MANIFEST_A}`]), MANIFEST_A);
  assertTypedCode(
    () => resolve(`node@${MANIFEST_A}`, [`node@${MANIFEST_B}`]),
    'ENVIRONMENT_IMAGE_IDENTITY_PIN_MISMATCH',
  );
});

test('K19 base image identity fail-closed: missing registry provenance (local-only image), malformed evidence, substituted repo, stale ambiguity — each typed, each named', () => {
  const resolve = dockerExecutorModule.resolveRegistryManifestDigest;
  assertTypedCode(
    () => resolve('node:20-alpine', []),
    'ENVIRONMENT_IMAGE_IDENTITY_MISSING',
  );
  assertTypedCode(
    () => resolve('node:20-alpine', ['node@sha256:not-a-digest']),
    'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED',
  );
  assertTypedCode(
    () => resolve('node:20-alpine', null),
    'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED',
  );
  assertTypedCode(
    () => resolve('node:20-alpine', [`other-repo@${MANIFEST_A}`]),
    'ENVIRONMENT_IMAGE_IDENTITY_REPO_MISMATCH',
  );
  assertTypedCode(
    () => resolve('node:20-alpine', [`node@${MANIFEST_A}`, `node@${MANIFEST_B}`]),
    'ENVIRONMENT_IMAGE_IDENTITY_AMBIGUOUS',
  );
});

// ---------------------------------------------------------------------------
// Receipt/digest fence binding (ADR-083 §2.6 — the receipt binds the
// environment it ran under). Hermetic provider proof through the executor
// seam; the mutation oracle holds every input constant except ONE
// authoritative identity field.
// ---------------------------------------------------------------------------

test('K19 receipt fence: a docker-substrate receipt binds the observed registry manifest digest — substituting it changes the receipt', { timeout: 60_000 }, async () => {
  // ONE sealed subject for both arms: identical candidate bytes, commit, tree,
  // profile, commands and coverage. The ONLY difference is the observed
  // registry manifest digest of the declared image.
  const root = fixtureRepo({ lockContent: '{"lockfileVersion":3,"packages":{}}\n' });
  try {
    const receiptA = await runIdentityCase({
      root,
      executor: dockerExecutorFake({ prepare: 0, runCommand: 0, dispose: 0 }, { baseImageDigest: MANIFEST_A }),
    });
    const receiptB = await runIdentityCase({
      root,
      executor: dockerExecutorFake({ prepare: 0, runCommand: 0, dispose: 0 }, { baseImageDigest: MANIFEST_B }),
    });
    assert.equal(receiptA.outcome, 'passed');
    assert.equal(receiptB.outcome, 'passed');
    assert.match(receiptA.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
    // ORACLE: the content-addressed receipt digest is a function of the
    // authoritative image identity. Holding everything else constant, one
    // substituted manifest digest MUST produce a different receipt — the fence
    // detects the substitution instead of reusing the tag-bound receipt.
    assert.notEqual(receiptA.evidenceRefs[0], receiptB.evidenceRefs[0],
      'the receipt fence binds baseImageDigest — an image substitution cannot ride the prior receipt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('K19 receipt fence: the derived environment identity (with its dependency lock) rides the PASSED receipt as decodable evidence', { timeout: 60_000 }, async () => {
  const receipt = await runIdentityCase({
    executor: dockerExecutorFake({ prepare: 0, runCommand: 0, dispose: 0 }, { baseImageDigest: MANIFEST_A }),
  });
  const diagnostics = receipt.evidenceRefs
    .map(ref => decodeCheckDiagnostic(ref))
    .filter(diag => diag !== null);
  const environment = diagnostics.find(diag => diag.code === 'environment-derivation');
  assert.ok(environment, 'the derived-environment diagnostic rides the passed outcome');
  assert.match(environment.message, /^derived environment [a-f0-9]{16}/u);
  assert.match(environment.message, /package-lock\.json/u,
    'the lock material the identity binds is named in the evidence');
});

// ---------------------------------------------------------------------------
// K19 owns identity, ADR-091 owns availability (ADR-083 §6): an identity
// failure never rides the substrate-unknown path, even under a healthy daemon
// observation — and it is not retried as a substrate precondition.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// K19 repair after REJECT — blocker 3: the PROVIDER-BOUNDARY identity fence.
// A docker executor description that reaches the receipt boundary without a
// well-formed sha256 baseImageDigest is a typed K19 PRODUCT failure — never
// `passed` (a receipt without identity), never the ADR-089 `unknown`, never
// retried as a substrate precondition. Exact outcome/reason/call-count
// oracle.
// ---------------------------------------------------------------------------

test('K19 provider boundary: a docker describe WITHOUT baseImageDigest fails typed as a product failure — never passed, never unknown, never retried', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0 };
  try {
    const receipt = await runIdentityCase({
      executor: {
        prepare() { calls.prepare += 1; },
        runCommand() { calls.runCommand += 1; },
        runServed() { throw new Error('unreachable in this proof'); },
        // A docker executor whose description carries NO baseImageDigest —
        // the shape a skipped/failed identity resolution (or a foreign
        // executor) presents at the provider boundary.
        describe() { return { substrate: 'docker', image: IMAGE }; },
        dispose() { calls.dispose += 1; },
      },
    });
    // ORACLE — outcome: product `failed`, never `passed` (the pre-fix
    // behavior: a receipt with no image identity at all).
    assert.equal(receipt.outcome, 'failed',
      'a docker receipt never exists without a base image identity (ADR-083 §2.1/§3)');
    // ORACLE — reason: the typed K19 identity code, decodable.
    const diagnostics = receipt.evidenceRefs
      .map(ref => decodeCheckDiagnostic(ref))
      .filter(diag => diag !== null);
    assert.ok(diagnostics.some(diag => diag.code === 'ENVIRONMENT_IMAGE_IDENTITY_MISSING'),
      'the typed identity diagnostic names the missing boundary identity');
    // ORACLE — never the substrate unknown, never `passed`:
    assert.ok(!diagnostics.some(diag => diag.code === 'warrant-blocked-environment'),
      'a boundary identity failure is NOT the ADR-089 typed-unknown substrate outcome');
    // ORACLE — call-count: the substrate steps executed EXACTLY once — the
    // boundary failure is terminal for the check, never retried as a
    // substrate precondition (identity is K19-owned; ADR-083 §6 split).
    assert.equal(calls.prepare, 1);
    assert.equal(calls.runCommand, 1);
    assert.equal(calls.dispose, 1);
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('K19 provider boundary: a docker describe with a MALFORMED baseImageDigest fails typed ENVIRONMENT_IMAGE_IDENTITY_MALFORMED — same fence, same counts', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0 };
  try {
    const receipt = await runIdentityCase({
      executor: {
        prepare() { calls.prepare += 1; },
        runCommand() { calls.runCommand += 1; },
        runServed() { throw new Error('unreachable in this proof'); },
        // A digest-shaped string that is NOT a well-formed sha256:<64hex>.
        describe() {
          return { substrate: 'docker', image: IMAGE, baseImageDigest: 'sha256:not-a-digest' };
        },
        dispose() { calls.dispose += 1; },
      },
    });
    assert.equal(receipt.outcome, 'failed');
    const diagnostics = receipt.evidenceRefs
      .map(ref => decodeCheckDiagnostic(ref))
      .filter(diag => diag !== null);
    assert.ok(diagnostics.some(diag => diag.code === 'ENVIRONMENT_IMAGE_IDENTITY_MALFORMED'),
      'a malformed boundary digest gets its own typed identity code');
    assert.ok(!diagnostics.some(diag => diag.code === 'warrant-blocked-environment'));
    assert.equal(calls.prepare, 1);
    assert.equal(calls.runCommand, 1);
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});

test('K19 identity failure is a product `failed` with the typed diagnostic — never substrate `unknown`, never retried (ADR-083 §6 split)', { timeout: 60_000 }, async () => {
  const calls = { prepare: 0, runCommand: 0, dispose: 0 };
  installDockerInfoProbeForTests(() => ({ available: true, linux: true }));
  resetDockerAvailabilityCache();
  try {
    const receipt = await runIdentityCase({
      executor: dockerExecutorFake(calls, {
        prepareError: new ReadinessExecutionError(
          'ENVIRONMENT_IMAGE_IDENTITY_MISSING',
          `image "${IMAGE}" has no registry manifest digest (RepoDigests empty — a locally built or loaded image); refusing a tag/local-id as environment identity`,
        ),
      }),
    });
    assert.equal(receipt.outcome, 'failed',
      'missing image identity is the declaration\'s defect — a product verdict');
    const diagnostics = receipt.evidenceRefs
      .map(ref => decodeCheckDiagnostic(ref))
      .filter(diag => diag !== null);
    assert.ok(diagnostics.some(diag => diag.code === 'ENVIRONMENT_IMAGE_IDENTITY_MISSING'),
      'the typed identity diagnostic rides the failure evidence');
    assert.ok(!diagnostics.some(diag => diag.code === 'warrant-blocked-environment'),
      'an identity failure is NOT the ADR-089 typed-unknown substrate outcome');
    assert.equal(calls.prepare, 1,
      'an identity failure is not a substrate precondition — no in-check substrate retry is consumed');
  } finally {
    installDockerInfoProbeForTests(null);
    resetDockerAvailabilityCache();
  }
});
