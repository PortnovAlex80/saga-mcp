// tests/infrastructure/local-runnability-warrant-oracle.test.mjs
//
// CC-GAP-7 (CONFORMANCE-CLOSURE-PLAN / CC-00C, provider 1.15.0) —
// verification-warrant oracle execution over the existing
// VerificationWarrantRef seam through package-declared oracle adapters.
//
// This file carries the CC-GAP-7 BLOCKING MUTATIONS:
//   1. MISSING ADAPTER — a non-waived execution-class register constraint
//      covered by no declared adapter yields the typed
//      `warrant-oracle-insufficient` unknown: never a pass, never a
//      product-failed verdict;
//   2. TRANSPORT-ONLY FALSE PASS (the CC-00C mutation) — substituting the
//      generic loopback health oracle (start + loopback HTTP probe + stop,
//      ALL PASSING) for the package-level oracle adapter must NOT pass the
//      browser-product claim: the outcome stays the typed unknown, and
//      rendering it as pass or as product-failed both fail classification
//      (assertRenderedCheckOutcomeTruthful);
//   3. WARRANT/CANDIDATE RETARGET — a warrant re-targeted at a different
//      certificate/case cross-bind, a different register, or against a case
//      whose inherited coverage relay names a different register is a TYPED
//      product failure (identity integrity, the m7 consumer discipline) —
//      never executed, never oracle-insufficient, never passed;
//   4. SUBSTITUTED ADAPTER — the receipt binds the EXECUTED adapter
//      identity/version: swapping the declared adapter changes the
//      content-addressed receipt digest, an adapter declared for other
//      constraints is never substituted for the uncovered claim, and the
//      engine runs exactly the declared command for exactly the declared
//      coverage (no product-type switch);
//   5. MISSING ENV BINDING — a warrant receipt observation without the
//      consumed derived environmentDigest is a typed red
//      (assertWarrantReceiptBindsEnvironment), and both the passed and the
//      oracle-insufficient receipts carry the derived environment identity.
//
// Plus the lawful-boundary proofs: the no-warrant LEGACY path is
// byte-identical (grandfathered), a typed waiver (A1 rule) needs no
// adapter, an unsupported claim (adapter naming a constraint absent from
// the register) is oracle-insufficient, orphaned declarations without a
// warrant are a typed submission/provider defect, an adapter evidence
// command failing against an observed-healthy substrate stays a genuine
// product failure (ADR-089/091 class split preserved inside warrant
// execution), and the certification gate routes the oracle-insufficient
// unknown to human_required (complete-blocked) — never complete-failed.
//
// NOT claimed (bounded scope, CC-GAP-7A): the CC-U2 semantic
// served-surface analysis; CC-GAP-8 ledger discharge semantics; a live
// docker substrate (the executor seam is faked hermetically, exactly like
// the CC-GAP-9/ADR-091 proofs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import { createLocalRunnabilityCheckProvider } from '../../dist/infrastructure/verification/local-runnability-check-provider.js';
import {
  assertWarrantReceiptBindsEnvironment,
  parseWarrantOracleDeclarations,
  planWarrantOracleExecution,
  warrantOracleInsufficientObservation,
  warrantReceiptObservation,
  waivedConstraintIdsFromWarrantDispositions,
  WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
} from '../../dist/infrastructure/verification/warrant-oracle-adapters.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../dist/modules/development/application/candidate-check-contracts.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION,
  developmentReadinessManifestPayloadContract,
} from '../../dist/modules/development/application/development-check-providers.js';
import {
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
} from '../../dist/modules/development/domain/development-schemas.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  assertRenderedCheckOutcomeTruthful,
  classifyCheckOutcome,
} from '../../dist/infrastructure/verification/substrate-retry.js';

const PROCESS_RUN_ID = 77;
const CANDIDATE_HASH = 'e'.repeat(64);
const SOURCE_REF = `development-integrated-source-candidate:${PROCESS_RUN_ID}:${CANDIDATE_HASH}`;
const DISCOVERY_CERTIFICATE_HASH = 'a'.repeat(64);
const FORMALIZATION_CASE_DIGEST = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Fixtures — the warrant authority (register + dispositions + certificate
// + case), sealed exactly the way production seals them.
// ---------------------------------------------------------------------------

/**
 * The register: ord-c-001 execution-class (the browser-product claim —
 * "install + start -> accessible running product"), ord-c-002 material
 * (WAIVED through the warrant dispositions, A1 rule), ord-c-003 human.
 */
function buildFixtureRegister() {
  const register = buildOrderConstraintRegisterV2({
    drafts: [
      {
        class: 'execution',
        text: 'the product must install, start, and present an accessible running browser page (canvas game)',
        evidence_ref: 'order:1',
        entrypoint_files: ['src/index.html'],
      },
      { class: 'material', text: 'the backend must be TypeScript', evidence_ref: 'order:2' },
      { class: 'human', text: 'the game must feel right in Chrome', evidence_ref: 'order:3' },
    ],
  });
  assert.ok(register, 'fixture register must build');
  return register;
}

/** The brief dispositions: ord-c-002 is TYPED-waived with a reason. */
const DISPOSITIONS = Object.freeze({
  'ord-c-002': { disposition: 'waived', reason: 'TypeScript mandate descoped by the order revision' },
  'ord-c-001': { disposition: 'accepted' },
  'ord-c-003': { disposition: 'accepted' },
});

function fixtureWarrant(register) {
  return {
    constraintRegisterRef: `constraint-register:${register.registerDigest}`,
    constraintRegisterDigest: register.registerDigest,
    dispositionsDigest: sha256Hex(DISPOSITIONS),
    dispositions: DISPOSITIONS,
    discoveryCertificateHash: DISCOVERY_CERTIFICATE_HASH,
    formalizationCaseDigest: FORMALIZATION_CASE_DIGEST,
  };
}

/** The honest oracle adapter declaration covering the browser claim. */
const BROWSER_SMOKE_ADAPTER = Object.freeze({
  adapterId: 'browser-smoke',
  adapterVersion: '1.0.0',
  coversConstraintIds: ['ord-c-001'],
  evidenceCommand: 'node scripts/browser-smoke.mjs',
});

function gitCli(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'saga-warrant-oracle-'));
  gitCli(root, 'init');
  gitCli(root, 'config', 'user.email', 'factory@example.test');
  gitCli(root, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(root, 'test.js'), 'process.exit(0);\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'warrant-fixture', version: '1.0.0', scripts: { test: 'node test.js' },
  }));
  gitCli(root, 'add', '.');
  gitCli(root, 'commit', '-m', 'fixture');
  return root;
}

/**
 * The warrant substrate: in-memory factory schema + the four authority
 * tables the provider reads DB-only (products, submissions, outcome
 * certificates, process runs).
 */
function warrantStore(root, { register = buildFixtureRegister() } = {}) {
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
    CREATE TABLE IF NOT EXISTS factory_process_outcome_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      epic_id INTEGER,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      rationale TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      certificate_payload TEXT NOT NULL,
      certificate_hash TEXT NOT NULL UNIQUE,
      authority TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS factory_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      epic_id INTEGER,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      module_ref_key TEXT NOT NULL,
      status TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      input_snapshot TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      executor_kind TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      lease_owner TEXT,
      lease_expires_at TEXT
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
  // The discovery settlement certificate the warrant is cross-bound to: the
  // register rides the immutable certificate payload, frozen with it.
  const certificatePayload = {
    schemaVersion: 'factory.discovery-outcome-certificate.v2',
    decision: 'accepted',
    reasonCodes: [],
    rationale: 'fixture settlement',
    inputHash: '0'.repeat(64),
    constraintRegister: register,
    lifecycleBinding: { lifecycleRunId: 1, terminalClassifications: [], definitionHash: '1'.repeat(64) },
  };
  db.prepare(
    `INSERT INTO factory_process_outcome_certificates
       (process_run_id, project_id, epic_id, module_name, module_version,
        module_ref_key, schema_version, decision, reason_codes, rationale,
        input_hash, certificate_payload, certificate_hash, authority)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    5, 1, 1, 'discovery', '1.0.0', 'discovery', certificatePayload.schemaVersion,
    'accepted', '[]', 'fixture settlement', certificatePayload.inputHash,
    JSON.stringify(certificatePayload), DISCOVERY_CERTIFICATE_HASH,
    'discovery-settlement-policy',
  );
  // The DevelopmentCase: the subject process run's frozen input (the same
  // input frame.runInput is parsed from), carrying the AUTHORITATIVE
  // expected cross-bind identities and the inherited coverage relay.
  const developmentCase = {
    schemaVersion: 'factory.development-case.v1',
    projectId: 1,
    epicId: 1,
    solutionContractPayload: {
      discoveryCertificateHash: DISCOVERY_CERTIFICATE_HASH,
      formalizationCaseDigest: FORMALIZATION_CASE_DIGEST,
      constraintRegisterCoverage: {
        constraintRegisterRef: `constraint-register:${register.registerDigest}`,
        constraintRegisterDigest: register.registerDigest,
        entries: register.constraints.map(entry => ({
          id: entry.id,
          class: entry.class,
          ...(entry.entrypointFiles ? { entrypointFiles: [...entry.entrypointFiles] } : {}),
        })),
        waivedIds: ['ord-c-002'],
      },
    },
  };
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        status, input_schema, input_snapshot, input_hash, idempotency_key, executor_kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    PROCESS_RUN_ID, 1, 1, 'solution-development', '1.0.0', 'development',
    'settled', 'factory.development-case.v1', JSON.stringify(developmentCase),
    sha256Hex(developmentCase), `warrant-fixture:${PROCESS_RUN_ID}`, 'kernel',
  );
  return db;
}

/** Insert a readiness-manifest submission; returns { submissionId, manifestDigest }. */
function insertWarrantManifest(db, { warrant, oracles, served = false }) {
  const manifest = {
    schema: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: { schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA, ref: SOURCE_REF, hash: CANDIDATE_HASH },
    targets: [{
      key: 'primary',
      readiness: served
        ? {
          kind: 'served',
          commands: { installCommand: null, testCommand: 'npm test' },
          serve: { startCommand: 'node server.js' },
        }
        : { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' } },
    }],
    ...(warrant === undefined ? {} : { warrantRef: warrant }),
    ...(oracles === undefined ? {} : { warrantOracles: oracles }),
  };
  const id = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS next FROM factory_managed_node_submissions').get().next;
  const contentHash = sha256Hex(manifest);
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id, process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        schema_version, payload_snapshot, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, PROCESS_RUN_ID, 'solution-development', 'certify-product-readiness',
    1, 1, `worker-execution:warrant-${id}`,
    DEVELOPMENT_READINESS_MANIFEST_SCHEMA, JSON.stringify(manifest), contentHash,
  );
  return { submissionId: id, manifestDigest: contentHash };
}

/** Candidate-set reader over one manifest submission. */
function manifestCandidateSets({ submissionId, manifestDigest }) {
  const subjectRef = `candidate-set/warrant-${submissionId}`;
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

const RUN_ARGS = (subjectRef) => ({
  subjectCandidateSetRef: subjectRef, parameters: {},
  environmentRef: null, candidateSnapshot: {},
});

/** A recording host-substrate executor fake (no daemon dependency: the
 *  ADR-091 re-probe never fires for host steps). */
function hostExecutor(commands, { failCommand = null } = {}) {
  return {
    prepare() { commands.push('prepare'); },
    runCommand(command) {
      commands.push(command);
      if (command === failCommand) {
        throw new Error(`command failed (node ${command}): adapter evidence exited 1`);
      }
    },
    runServed() {
      commands.push('serve');
      return { port: 1, stdoutDigest: '0'.repeat(64), stderrDigest: '0'.repeat(64) };
    },
    describe() { return { substrate: 'host' }; },
    dispose() {},
  };
}

function decodeDiagnostics(result) {
  return result.evidenceRefs
    .map(ref => decodeCheckDiagnostic(ref))
    .filter(diag => diag !== null);
}

// ---------------------------------------------------------------------------
// The pure contract core.
// ---------------------------------------------------------------------------

test('warrant oracle vocabulary: the typed diagnostic is frozen; the A1 waiver rule mirror holds', () => {
  assert.equal(WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC, 'warrant-oracle-insufficient');
  // A waiver counts ONLY with disposition='waived' AND a non-empty reason.
  assert.deepEqual(
    waivedConstraintIdsFromWarrantDispositions(DISPOSITIONS),
    ['ord-c-002'],
  );
  assert.deepEqual(
    waivedConstraintIdsFromWarrantDispositions({
      'ord-c-002': { disposition: 'waived', reason: '   ' },
      'ord-c-001': { disposition: 'accepted' },
    }),
    [],
    'an empty-reason waiver and an accepted disposition are NOT waivers',
  );
});

test('provider decoder independently enforces the same closed adapter shape as the submission contract', () => {
  for (const declaration of [
    { ...BROWSER_SMOKE_ADAPTER, productType: 'browser' },
    { ...BROWSER_SMOKE_ADAPTER, adapterId: 'Browser Smoke' },
    { ...BROWSER_SMOKE_ADAPTER, coversConstraintIds: ['ord-c-001', 'ord-c-001'] },
    { ...BROWSER_SMOKE_ADAPTER, coversConstraintIds: ['not-a-register-id'] },
  ]) {
    const parsed = parseWarrantOracleDeclarations([declaration]);
    assert.equal(parsed.status, 'invalid');
    assert.match(parsed.reason, /WARRANT_ORACLE_DECLARATIONS_INVALID/u);
  }
});

test('plan algebra: execution-class coverage, waivers, and the unsupported-claim fence (transport-only is never coverage)', () => {
  const register = buildFixtureRegister();
  // No adapters at all: the execution-class claim is uncovered — the served
  // loopback phases are transport-only and NEVER count as coverage.
  const uncovered = planWarrantOracleExecution({
    register, declarations: [], waivedIds: ['ord-c-002'],
  });
  assert.equal(uncovered.status, 'oracle-insufficient');
  assert.deepEqual(uncovered.uncoveredIds, ['ord-c-001']);
  assert.deepEqual(uncovered.unsupportedIds, []);
  // The honest adapter covers the claim.
  const executable = planWarrantOracleExecution({
    register, declarations: [BROWSER_SMOKE_ADAPTER], waivedIds: ['ord-c-002'],
  });
  assert.equal(executable.status, 'executable');
  assert.deepEqual(executable.executionClassIds, ['ord-c-001']);
  assert.equal(executable.adapters.length, 1);
  // A typed waiver needs no adapter: waive ord-c-001 too → executable with
  // zero adapters.
  const waived = planWarrantOracleExecution({
    register, declarations: [], waivedIds: ['ord-c-001', 'ord-c-002'],
  });
  assert.equal(waived.status, 'executable');
  assert.deepEqual(waived.adapters, []);
  // UNSUPPORTED CLAIM: an adapter naming a constraint absent from the
  // register never proves anything — even with ord-c-001 covered.
  const unsupported = planWarrantOracleExecution({
    register,
    declarations: [
      BROWSER_SMOKE_ADAPTER,
      { ...BROWSER_SMOKE_ADAPTER, adapterId: 'phantom', coversConstraintIds: ['ord-c-999'] },
    ],
    waivedIds: ['ord-c-002'],
  });
  assert.equal(unsupported.status, 'oracle-insufficient');
  assert.deepEqual(unsupported.uncoveredIds, []);
  assert.deepEqual(unsupported.unsupportedIds, ['ord-c-999']);
});

// ---------------------------------------------------------------------------
// Provider seam — the positive path first.
// ---------------------------------------------------------------------------

test('provider: executable warrant passes; the adapter evidence command runs; the receipt digest changes with the warrant', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  try {
    const withWarrant = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [BROWSER_SMOKE_ADAPTER],
    });
    const commands = [];
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(withWarrant),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(`candidate-set/warrant-${withWarrant.submissionId}`));
    assert.equal(result.outcome, 'passed');
    assert.match(result.evidenceRefs[0], /^local-readiness:[a-f0-9]{64}$/u);
    // The adapter's evidence command executed in the prepared environment
    // (no product-type switch: exactly the declared command).
    assert.ok(commands.includes('node scripts/browser-smoke.mjs'),
      'the declared adapter evidence command must run');
    // The derived environment identity rides the passed receipt.
    assert.ok(decodeDiagnostics(result).some(diag => diag.code === 'environment-derivation'));

    // RECEIPT SENSITIVITY: the same candidate bytes WITHOUT a warrant (the
    // legacy manifest) produce a DIFFERENT receipt digest — the warrant
    // observation is inside the content-addressed receipt.
    const legacy = insertWarrantManifest(db, {});
    const legacyCommands = [];
    const legacyProvider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(legacy),
      executorSelector: () => hostExecutor(legacyCommands),
      substrateRetrySleep: () => {},
    });
    const legacyResult = await legacyProvider.run(RUN_ARGS(`candidate-set/warrant-${legacy.submissionId}`));
    assert.equal(legacyResult.outcome, 'passed');
    assert.notEqual(legacyResult.evidenceRefs[0], result.evidenceRefs[0],
      'a warrant-executing receipt is a different receipt over the same bytes');
    assert.ok(!legacyCommands.includes('node scripts/browser-smoke.mjs'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BLOCKING MUTATION missing adapter: an uncovered execution-class claim is the typed oracle-insufficient unknown — never pass, never product-failed, no seam issue', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  try {
    const submission = insertWarrantManifest(db, { warrant: fixtureWarrant(register) });
    const commands = [];
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`));
    // NEVER passed (install/test/serve all pass), NEVER product-failed.
    assert.equal(result.outcome, 'unknown');
    const diagnostics = decodeDiagnostics(result);
    const oracle = diagnostics.find(diag => diag.code === WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC);
    assert.ok(oracle, 'the warrant-oracle-insufficient diagnostic must ride the receipt');
    assert.match(oracle.message, /ord-c-001/u);
    assert.match(oracle.message, /transport-only evidence/u);
    assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'an uncovered claim is not a product defect — no seam repair issue');
    // Classification (ADR-089 §1): the three classes stay distinct — this
    // unknown is ORACLE-INSUFFICIENT, not substrate-unavailable.
    assert.equal(classifyCheckOutcome({
      outcome: 'unknown', diagnosticCode: WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
    }), 'oracle-insufficient');
    assert.notEqual(classifyCheckOutcome({
      outcome: 'unknown', diagnosticCode: WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
    }), 'substrate-unavailable');
    // The derived environment identity binds the unknown receipt too.
    assert.ok(diagnostics.some(diag => diag.code === 'environment-derivation'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BLOCKING MUTATION transport-only false pass: the generic loopback health oracle must NOT prove the browser-product claim — no silent fallback, and rendering the unknown as pass or product-failed both fail', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  try {
    // SERVED profile with NO adapter: the pre-warrant code would have
    // proven this claim by start + loopback HTTP probe + clean shutdown
    // (the exact "substitute loopback health for the package-level browser
    // oracle" mutation). The warrant-executing provider must NOT fall back
    // to that generic oracle: the claim stays unproven and the executor is
    // never even invoked as a substitute verdict basis.
    const submission = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [],
      served: true,
    });
    const commands = [];
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`));
    assert.equal(commands.length, 0,
      'a present warrant cannot silently fall back to the generic loopback oracle — no serve/transport phase runs as a substitute verdict basis');
    assert.equal(result.outcome, 'unknown',
      'loopback transport health is never adapter coverage — the claim is not passed');
    assert.ok(!result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')));
    const oracle = decodeDiagnostics(result)
      .find(diag => diag.code === WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC);
    assert.ok(oracle);
    // The control: the SAME served shape WITHOUT a warrant proves
    // transport runnability and passes (the grandfathered legacy path) —
    // proving the unknown above is the WARRANT's verdict, not a served-profile rejection.
    const legacy = insertWarrantManifest(db, { served: true });
    const legacyCommands = [];
    const legacyProvider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(legacy),
      executorSelector: () => hostExecutor(legacyCommands),
      substrateRetrySleep: () => {},
    });
    const legacyResult = await legacyProvider.run(RUN_ARGS(`candidate-set/warrant-${legacy.submissionId}`));
    assert.equal(legacyResult.outcome, 'passed');
    assert.ok(legacyCommands.includes('serve'),
      'the no-warrant legacy path still proves served transport runnability');
    // Rendering the unknown as pass (poison-green) fails the truth guard…
    assert.throws(
      () => assertRenderedCheckOutcomeTruthful({
        receiptOutcome: 'unknown',
        diagnosticCode: WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
        renderedAs: 'pass',
      }),
      /CHECK_OUTCOME_RENDER_COLLAPSE/u,
    );
    // …and rendering it as product-failed (the flattening) fails too.
    assert.throws(
      () => assertRenderedCheckOutcomeTruthful({
        receiptOutcome: 'unknown',
        diagnosticCode: WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
        renderedAs: 'failed',
      }),
      /CHECK_OUTCOME_RENDER_COLLAPSE/u,
    );
    // The only lawful render is unknown/blocked.
    assert.doesNotThrow(() => assertRenderedCheckOutcomeTruthful({
      receiptOutcome: 'unknown',
      diagnosticCode: WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC,
      renderedAs: 'unknown',
    }));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BLOCKING MUTATION warrant/candidate retarget: a re-targeted warrant is a typed product failure — never executed, never oracle-insufficient, never passed', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  const commands = [];
  const runWith = async (warrant) => {
    const submission = insertWarrantManifest(db, { warrant });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    return {
      result: await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`)),
    };
  };
  try {
    // (a) forged certificate cross-bind identity.
    const forgedCertificate = await runWith({
      ...fixtureWarrant(register),
      discoveryCertificateHash: 'c'.repeat(64),
    });
    assert.equal(forgedCertificate.result.outcome, 'failed');
    assert.equal(decodeDiagnostics(forgedCertificate.result)[0].code, 'WARRANT_ORACLE_CROSS_BIND_MISMATCH');

    // (b) forged case cross-bind identity.
    const forgedCase = await runWith({
      ...fixtureWarrant(register),
      formalizationCaseDigest: 'd'.repeat(64),
    });
    assert.equal(forgedCase.result.outcome, 'failed');
    assert.equal(decodeDiagnostics(forgedCase.result)[0].code, 'WARRANT_ORACLE_CROSS_BIND_MISMATCH');

    // (c) a DIFFERENT register under an honest-looking self-consistent
    // warrant: the certificate's frozen register digest is the authority —
    // a warrant naming any other digest never matches it.
    const otherRegister = buildOrderConstraintRegisterV2({
      drafts: [{
        class: 'execution',
        text: 'a different product claim entirely',
        evidence_ref: 'order:9',
      }],
    });
    const substitutedRegister = await runWith({
      constraintRegisterRef: `constraint-register:${otherRegister.registerDigest}`,
      constraintRegisterDigest: otherRegister.registerDigest,
      dispositionsDigest: sha256Hex(DISPOSITIONS),
      dispositions: DISPOSITIONS,
      discoveryCertificateHash: DISCOVERY_CERTIFICATE_HASH,
      formalizationCaseDigest: FORMALIZATION_CASE_DIGEST,
    });
    assert.equal(substitutedRegister.result.outcome, 'failed');
    assert.equal(
      decodeDiagnostics(substitutedRegister.result)[0].code,
      'WARRANT_ORACLE_REGISTER_MISMATCH',
    );

    // (d) dispositions digest tampering (self-consistency).
    const tamperedDispositions = await runWith({
      ...fixtureWarrant(register),
      dispositionsDigest: 'f'.repeat(64),
    });
    assert.equal(tamperedDispositions.result.outcome, 'failed');
    assert.equal(
      decodeDiagnostics(tamperedDispositions.result)[0].code,
      'WARRANT_ORACLE_IDENTITY_INVALID',
    );

    // (e) a self-consistent but newly forged waiver cannot expand the
    // waiver authority frozen on the DevelopmentCase coverage relay.
    const forgedWaiverDispositions = {
      ...DISPOSITIONS,
      'ord-c-001': { disposition: 'waived', reason: 'candidate invented waiver' },
    };
    const forgedWaiver = await runWith({
      ...fixtureWarrant(register),
      dispositions: forgedWaiverDispositions,
      dispositionsDigest: sha256Hex(forgedWaiverDispositions),
    });
    assert.equal(forgedWaiver.result.outcome, 'failed');
    assert.equal(
      decodeDiagnostics(forgedWaiver.result)[0].code,
      'WARRANT_ORACLE_CASE_COVERAGE_MISMATCH',
    );

    // No adapter evidence command ever ran for any re-targeted warrant.
    assert.ok(!commands.includes('node scripts/browser-smoke.mjs'));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BLOCKING MUTATION substituted adapter: the receipt binds the EXECUTED adapter identity — a swapped adapter is a different receipt, and an adapter for other constraints is never substituted', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  try {
    // (a) provider-level: swap the declared adapter identity over the SAME
    // candidate bytes → a different content-addressed receipt digest.
    const a = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [BROWSER_SMOKE_ADAPTER],
    });
    const commandsA = [];
    const providerA = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(a),
      executorSelector: () => hostExecutor(commandsA),
      substrateRetrySleep: () => {},
    });
    const receiptA = await providerA.run(RUN_ARGS(`candidate-set/warrant-${a.submissionId}`));
    assert.equal(receiptA.outcome, 'passed');

    const b = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [{ ...BROWSER_SMOKE_ADAPTER, adapterId: 'canvas-smoke', adapterVersion: '2.0.0' }],
    });
    const commandsB = [];
    const providerB = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(b),
      executorSelector: () => hostExecutor(commandsB),
      substrateRetrySleep: () => {},
    });
    const receiptB = await providerB.run(RUN_ARGS(`candidate-set/warrant-${b.submissionId}`));
    assert.equal(receiptB.outcome, 'passed');
    assert.notEqual(receiptA.evidenceRefs[0], receiptB.evidenceRefs[0],
      'a substituted adapter (different identity/version) must change the receipt digest');

    // (b) engine-level: an adapter declared for OTHER constraints never
    // substitutes for the uncovered claim (ord-c-001 stays uncovered — the
    // waived material entry ord-c-002 is not execution-class, and covering
    // it proves nothing about ord-c-001).
    const decoy = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [{
        adapterId: 'decoy',
        adapterVersion: '1.0.0',
        coversConstraintIds: ['ord-c-002'],
        evidenceCommand: 'node scripts/decoy.mjs',
      }],
    });
    const commandsC = [];
    const providerC = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(decoy),
      executorSelector: () => hostExecutor(commandsC),
      substrateRetrySleep: () => {},
    });
    const receiptC = await providerC.run(RUN_ARGS(`candidate-set/warrant-${decoy.submissionId}`));
    assert.equal(receiptC.outcome, 'unknown',
      'an adapter covering a waived non-execution entry never proves the execution-class claim');
    assert.ok(!commandsC.includes('node scripts/decoy.mjs') || receiptC.outcome === 'unknown');
    assert.ok(decodeDiagnostics(receiptC).some(
      diag => diag.code === WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC));

    // (c) observation-level digest sensitivity (non-circular): the receipt
    // frame changes when the executed adapter identity/version changes.
    const register2 = buildFixtureRegister();
    const warrant2 = fixtureWarrant(register2);
    const planFor = (adapter) => planWarrantOracleExecution({
      register: register2, declarations: [adapter], waivedIds: ['ord-c-002'],
    });
    const frame = (observation) => sha256Hex({
      providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
      candidateHash: CANDIDATE_HASH,
      observation,
    });
    const first = frame(warrantReceiptObservation({
      warrant: warrant2, plan: planFor(BROWSER_SMOKE_ADAPTER), environmentDigest: '1'.repeat(64),
    }));
    const substitutedVersion = frame(warrantReceiptObservation({
      warrant: warrant2,
      plan: planFor({ ...BROWSER_SMOKE_ADAPTER, adapterVersion: '1.0.1' }),
      environmentDigest: '1'.repeat(64),
    }));
    assert.notEqual(first, substitutedVersion,
      'an adapter version bump alone changes the warrant receipt digest');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('BLOCKING MUTATION missing env binding: a warrant receipt observation without the consumed environmentDigest is a typed red; honest observations bind it', () => {
  const register = buildFixtureRegister();
  const warrant = fixtureWarrant(register);
  const plan = planWarrantOracleExecution({
    register, declarations: [BROWSER_SMOKE_ADAPTER], waivedIds: ['ord-c-002'],
  });
  assert.equal(plan.status, 'executable');
  // The honest observation binds the derived digest and passes the guard.
  const honest = warrantReceiptObservation({
    warrant, plan, environmentDigest: '1'.repeat(64),
  });
  assert.doesNotThrow(() => assertWarrantReceiptBindsEnvironment(honest));
  assert.equal(honest.warrant.environmentDigest, '1'.repeat(64));
  // Stripping the binding is a typed red…
  const stripped = structuredClone(honest);
  delete stripped.warrant.environmentDigest;
  assert.throws(() => assertWarrantReceiptBindsEnvironment(stripped),
    /WARRANT_ORACLE_ENVIRONMENT_BINDING_MISSING/u);
  // …and so is a malformed digest.
  const malformed = structuredClone(honest);
  malformed.warrant.environmentDigest = 'not-a-digest';
  assert.throws(() => assertWarrantReceiptBindsEnvironment(malformed),
    /WARRANT_ORACLE_ENVIRONMENT_BINDING_MISSING/u);
  // The oracle-insufficient observation binds the environment too (the
  // identity the check would have certified under).
  const insufficient = planWarrantOracleExecution({
    register, declarations: [], waivedIds: ['ord-c-002'],
  });
  assert.equal(insufficient.status, 'oracle-insufficient');
  const insufficientObservation = warrantOracleInsufficientObservation({
    warrant, plan: insufficient, environmentDigest: '2'.repeat(64),
  });
  assert.doesNotThrow(() => assertWarrantReceiptBindsEnvironment(insufficientObservation));
  // The adapter never authorizes environment identity: the warrant block
  // carries ONLY the consumed digest — no image/toolchain authority fields.
  assert.deepEqual(
    Object.keys(honest.warrant).sort(),
    ['adapters', 'environmentDigest', 'waivedConstraintIds', 'constraintRegisterDigest', 'dispositionsDigest', 'provedExecutionConstraintIds'].sort(),
  );
});

// ---------------------------------------------------------------------------
// Lawful-boundary proofs.
// ---------------------------------------------------------------------------

test('provider: the no-warrant LEGACY path is grandfathered byte-identical — no warrant phases, no warrant diagnostics', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const db = warrantStore(root);
  try {
    const submission = insertWarrantManifest(db, {});
    const commands = [];
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`));
    assert.equal(result.outcome, 'passed');
    assert.ok(decodeDiagnostics(result).every(diag =>
      diag.code !== WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC));
    assert.ok(commands.every(command => !command.startsWith('node scripts/')),
      'no oracle adapter evidence command runs without a warrant');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider: a typed waiver (A1 rule) needs no adapter; an unsupported claim is oracle-insufficient; orphaned declarations are a typed failure', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  const commands = [];
  const runWith = async ({ warrant, oracles }) => {
    const submission = insertWarrantManifest(db, { warrant, oracles });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor(commands),
      substrateRetrySleep: () => {},
    });
    return await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`));
  };
  try {
    // Waived execution-class claim: dispositions waive ord-c-001 with a
    // typed reason → executable with zero adapters → passed.
    const waivedAll = {
      constraintRegisterRef: `constraint-register:${register.registerDigest}`,
      constraintRegisterDigest: register.registerDigest,
      dispositionsDigest: sha256Hex({
        ...DISPOSITIONS,
        'ord-c-001': { disposition: 'waived', reason: 'browser surface descoped by the operator' },
      }),
      dispositions: {
        ...DISPOSITIONS,
        'ord-c-001': { disposition: 'waived', reason: 'browser surface descoped by the operator' },
      },
      discoveryCertificateHash: DISCOVERY_CERTIFICATE_HASH,
      formalizationCaseDigest: FORMALIZATION_CASE_DIGEST,
    };
    // A waiver is lawful only when the frozen DevelopmentCase coverage relay
    // carries the same waiver set. The manifest cannot mint a later waiver.
    const frozenCaseRow = db.prepare(
      'SELECT input_snapshot FROM factory_process_runs WHERE id=?',
    ).get(PROCESS_RUN_ID);
    const frozenCase = JSON.parse(frozenCaseRow.input_snapshot);
    const waivedCase = structuredClone(frozenCase);
    waivedCase.solutionContractPayload.constraintRegisterCoverage.waivedIds = [
      'ord-c-001', 'ord-c-002',
    ];
    db.prepare(
      'UPDATE factory_process_runs SET input_snapshot=?, input_hash=? WHERE id=?',
    ).run(JSON.stringify(waivedCase), sha256Hex(waivedCase), PROCESS_RUN_ID);
    const waived = await runWith({ warrant: waivedAll, oracles: [] });
    assert.equal(waived.outcome, 'passed',
      'a typed waiver discharges the adapter requirement — the A1 rule rides the warrant dispositions');

    db.prepare(
      'UPDATE factory_process_runs SET input_snapshot=?, input_hash=? WHERE id=?',
    ).run(JSON.stringify(frozenCase), sha256Hex(frozenCase), PROCESS_RUN_ID);

    // Unsupported claim: the adapter names a constraint absent from the
    // register — oracle-insufficient, never a silent ignore, never a pass.
    const unsupported = await runWith({
      warrant: fixtureWarrant(register),
      oracles: [{
        adapterId: 'phantom',
        adapterVersion: '1.0.0',
        coversConstraintIds: ['ord-c-999'],
        evidenceCommand: 'node scripts/phantom.mjs',
      }],
    });
    assert.equal(unsupported.outcome, 'unknown');
    const oracle = decodeDiagnostics(unsupported)
      .find(diag => diag.code === WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC);
    assert.ok(oracle);
    assert.match(oracle.message, /ord-c-999/u);
    assert.match(oracle.message, /absent from the warrant register/u);
    assert.ok(!commands.includes('node scripts/phantom.mjs'),
      'a phantom-claim adapter never executes');

    // Orphaned declarations: warrantOracles without a warrantRef is a typed
    // product failure at the provider fence (and at the submission
    // contract — asserted below).
    const orphaned = await runWith({ warrant: undefined, oracles: [BROWSER_SMOKE_ADAPTER] });
    assert.equal(orphaned.outcome, 'failed');
    assert.equal(
      decodeDiagnostics(orphaned)[0].code,
      'WARRANT_ORACLE_ORPHANED_DECLARATIONS',
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider: an adapter evidence command failing against an observed-healthy substrate stays a genuine product failure (ADR-089/091 class split preserved inside warrant execution)', { timeout: 60_000 }, async () => {
  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  try {
    const submission = insertWarrantManifest(db, {
      warrant: fixtureWarrant(register),
      oracles: [BROWSER_SMOKE_ADAPTER],
    });
    const provider = createLocalRunnabilityCheckProvider({
      db,
      candidateSets: manifestCandidateSets(submission),
      executorSelector: () => hostExecutor([], {
        failCommand: 'node scripts/browser-smoke.mjs',
      }),
      substrateRetrySleep: () => {},
    });
    const result = await provider.run(RUN_ARGS(`candidate-set/warrant-${submission.submissionId}`));
    // The adapter exercised the product with the substrate healthy (host
    // executor: no daemon dependency) and the product was wanting — a
    // product verdict, never unknown, never retried as substrate.
    assert.equal(result.outcome, 'failed');
    assert.match(decodeDiagnostics(result)[0].message, /browser-smoke/u);
    assert.ok(result.evidenceRefs.some(ref => ref.startsWith('factory-seam-repair-issue/')),
      'a failing evidence command keeps its typed seam repair issue');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The submission-boundary contract (the lawful declaration seam).
// ---------------------------------------------------------------------------

test('submission contract: warrantOracles validate beside a present warrant and reject orphans/malformations (contract 1.2.0)', () => {
  assert.equal(DEVELOPMENT_READINESS_MANIFEST_PAYLOAD_CONTRACT_VERSION, '1.2.0',
    'the manifest payload contract bump is the honest identity of the new declaration seam');
  const manifestOf = (extra) => ({
    schemaVersion: DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    sourceCandidate: {
      schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA, ref: SOURCE_REF, hash: CANDIDATE_HASH,
    },
    targets: [{ key: 'primary', readiness: { kind: 'static', commands: { installCommand: null, testCommand: 'npm test' } } }],
    ...extra,
  });
  const register = buildFixtureRegister();
  const warrant = fixtureWarrant(register);
  // Honest declaration validates clean.
  assert.deepEqual(developmentReadinessManifestPayloadContract.validate(
    manifestOf({ warrantRef: warrant, warrantOracles: [BROWSER_SMOKE_ADAPTER] }),
  ), []);
  // Orphaned declarations are a typed submission defect.
  assert.match(
    developmentReadinessManifestPayloadContract.validate(
      manifestOf({ warrantOracles: [BROWSER_SMOKE_ADAPTER] }),
    ).join('\n'),
    /warrantOracles requires a present warrantRef/u,
  );
  // Malformed declarations fail closed.
  assert.match(
    developmentReadinessManifestPayloadContract.validate(
      manifestOf({
        warrantRef: warrant,
        warrantOracles: [{ adapterId: 'x', adapterVersion: 'not-semver', coversConstraintIds: [], evidenceCommand: '' }],
      }),
    ).join('\n'),
    /adapterVersion must be semver/u,
  );
  // Unknown fields never ride the closed vocabulary.
  assert.match(
    developmentReadinessManifestPayloadContract.validate(
      manifestOf({
        warrantRef: warrant,
        warrantOracles: [{ ...BROWSER_SMOKE_ADAPTER, productType: 'browser' }],
      }),
    ).join('\n'),
    /unknown field 'productType'/u,
    'the adapter vocabulary is closed — a productType switch is exactly what must NOT exist',
  );
});

// ---------------------------------------------------------------------------
// Gate wiring — the oracle-insufficient receipt routes blocked/resumable.
// ---------------------------------------------------------------------------

test('gate wiring: the certification plan still routes the runnability unknown human-required (complete-blocked) — the warrant oracle unknown inherits the blocked/resumable route, never complete-failed', { timeout: 120_000 }, async () => {
  const { SqliteGateRepository } = await import('../../dist/infrastructure/workplace/sqlite-gate-repository.js');
  const { driveGateRun } = await import('../../dist/process-modules/application/gate-run-driver.js');
  const { FactoryCheckProviderRegistry } = await import('../../dist/process-modules/application/standard-check-providers.js');
  const { createDevelopmentReadinessMonotonicityCheckProvider } = await import('../../dist/modules/development/application/development-check-providers.js');
  const { createGitPort } = await import('../../dist/infrastructure/process-modules/git-machine-ports.js');
  const { developmentProcessModule } = await import('../../dist/process-modules/modules/development/development-process-module.js');

  const root = fixtureRepo();
  const register = buildFixtureRegister();
  const db = warrantStore(root, { register });
  const certifyNode = developmentProcessModule.flow.nodes
    .find(node => node.id === 'certify-product-readiness');
  const certifyPlan = certifyNode.cellDefinition.authorGate.checkPlan;
  const submission = insertWarrantManifest(db, { warrant: fixtureWarrant(register) });
  const candidateSets = manifestCandidateSets(submission);
  try {
    const registry = new FactoryCheckProviderRegistry();
    registry.register(createDevelopmentReadinessMonotonicityCheckProvider({
      db, candidateSets, git: createGitPort(),
    }));
    registry.register(createLocalRunnabilityCheckProvider({
      db,
      candidateSets,
      executorSelector: () => hostExecutor([]),
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
      checkPlan: certifyPlan,
      gatePhase: 'final',
      expectedWorkplaceRevision: 1,
      gateLeaseRef: 'gate-lease:warrant-oracle-proof',
      installationDigest: 'installation:warrant-oracle-proof',
      checkParameters: { processRunId: PROCESS_RUN_ID },
      environmentRef: null,
      presentationRef: 'worker-execution:warrant-oracle-proof',
    });
    // The oracle-insufficient unknown STOPs the line as human_required —
    // an outstanding obligation, never a product verdict (the plan entry's
    // indeterminateDisposition is the same human-required route the
    // ADR-089 substrate unknown rides).
    assert.equal(result.decision.verdict, 'human_required',
      'the warrant oracle unknown must route blocked/resumable, never failed');
    const runnability = result.receipts.find(
      receipt => receipt.check.providerId === LOCAL_RUNNABILITY_CHECK_PROVIDER_ID);
    assert.ok(runnability);
    assert.equal(runnability.outcome, 'unknown');
    assert.ok(runnability.evidenceRefs
      .map(ref => decodeCheckDiagnostic(ref))
      .some(diag => diag !== null && diag.code === WARRANT_ORACLE_INSUFFICIENT_DIAGNOSTIC));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Identity/version fence.
// ---------------------------------------------------------------------------

test('identity fence: the provider presents 1.15.0 (the honest CC-GAP-7 identity bump)', () => {
  assert.equal(LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION, '1.15.0');
  assert.match(LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST, /^[a-f0-9]{64}$/u);
});
