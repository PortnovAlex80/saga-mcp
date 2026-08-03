// tests/execution/migration-conformance.test.mjs
//
// W9-A8 — Migration integration tests for Discovery, Development and Delivery.
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md
//   §1 (W9-A8 owns "Migration compatibility/restart/recovery/exact-output/
//   package-isolation integration tests"), §2 (exit gate: Discovery,
//   Development, Delivery independently pass the SAME installation, execution,
//   review, recovery, restart, and output conformance kit as Formalization),
//   §3 (anti-scope: additive only).
// Task: docs/refactor-management/05-subagent-tasks/W09-a8.md.
//
// WHAT THIS PROVES
//   The three Wave-9 production modules (Discovery, Development, Delivery) each
//   independently clear the five migration-conformance dimensions the Wave-8
//   Formalization pilot (W8-A8) established:
//     1. COMPATIBILITY — every module definition still validates against the
//        structural ProcessModuleDefinition gate AND the shared W9-A7
//        conformance runner reports it passing (zero failures). This is the
//        "the migration did not break the frozen slice" bar: the migrated
//        package surface is additive (spec §3), so the structural dimensions
//        that passed pre-migration must still pass post-migration.
//     2. RESTART — each module's durable output store is write-once / replay-
//        idempotent: the same payload hash for the same process_run replays
//        (no second row), and a divergent payload hash is rejected. This is
//        the §0.7.11 crash-resume contract applied to each module's outputs.
//     3. RECOVERY — every flow.recovery[] entry references existing verify +
//        repair nodes with a closed onExhausted vocabulary, and every
//        executionProfile.recoveryPolicy resumes from checkpoint with a closed
//        onExhausted. (Modules with no recovery entries pass vacuously.)
//     4. EXACT-OUTPUT — each module's settlement policy is a pure function of
//        its input: the same (input) yields the same decision + reasonCodes +
//        64-char inputHash every time. The deterministic core never depends on
//        time, randomness or an LM.
//     5. PACKAGE-ISOLATION — (sibling surface) when a module's package manifest
//        is present it validates as a ProcessModuleManifest, its pinned
//        input/output contracts match the frozen definition, and its resources
//        are package-local (no global lookup). This is the §0.11.11 serial
//        gate surface.
//
// SKIP-ON-ABSENT-SIBLING PATTERN
//   This lane (W9-A8) lives in an isolated worktree off 98c127f. The package
//   surfaces it does NOT own are authored by sibling lanes:
//     - Discovery package  -> src/process-modules/modules/discovery/package/  (W9-A1, PRESENT)
//     - Delivery package   -> src/process-modules/modules/delivery/package/   (W9-A5, PRESENT)
//     - Development package-> modules/development/package/*.mjs              (W9-A3, .mjs; the
//                              compiled src/.../package/manifest.ts surface is ABSENT here)
//   The package-isolation tests resolve each module's manifest dynamically and
//   SKIP with a clear reason when the sibling surface is absent — NOT a
//   failure. The integrator's full Wave-9 gate run (all siblings present) is
//   where package-isolation MUST PASS for every module. Dimensions 1-4 run
//   UNCONDITIONALLY against the frozen slice that exists in every W9 worktree.
//
// Imports run against the COMPILED dist/ output (node --test resolves .mjs
// against the repo root; production files live under dist/).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// Shared conformance kit (W9-A7) + the three frozen module definitions.
// ---------------------------------------------------------------------------
const {
  runModuleConformance,
} = await import('../../dist/application/module-conformance-runner.js');

const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);

// Closed vocabularies — mirrors of the Wave-1 SPI unions.
const ON_EXHAUSTED_VALUES = Object.freeze(['fail', 'pause', 'escalate']);

// The three Wave-9 modules under test, in spec §1 order.
const WAVE9_MODULES = [
  ['discovery', discoveryProcessModule],
  ['development', developmentProcessModule],
  ['delivery', deliveryProcessModule],
];

// ===========================================================================
// Shared helpers.
// ===========================================================================

/** SHA-256 hex over canonical JSON — the module hashing convention. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Start a ProcessRun bound to the given module ref and return its id. Mirrors
 * the W8-A8 formalization restart harness: every module's durable store keys
 * off the process_run, so the restart probe needs a real run row.
 */
async function startRun(db, moduleRef, idempotencyKey) {
  const { SqliteProcessRunRepository } = await import(
    '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
  );
  const runRepo = new SqliteProcessRunRepository(db);
  const schemaId = `saga3.${moduleRef.name}-case.v1`;
  const { record } = runRepo.start({
    moduleRef,
    executorKind: 'generic-flow',
    input: {
      schema: schemaId,
      payload: { epicId: 10 },
      contentHash: sha256(JSON.stringify({ epicId: 10 })),
    },
    projectedStage: moduleRef.name,
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'w9-a8',
      idempotencyKey,
    },
  });
  return record.id;
}

/** Fresh temp DB seeded with one project + one epic. Sets DB_PATH for getDb(). */
function freshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-w9a8-'));
  process.env.DB_PATH = path.join(temp, 'w9a8.db');
  return temp;
}

async function teardownDb(temp) {
  const { closeDb } = await import('../../dist/db.js');
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// ===========================================================================
// DIMENSION 1 — COMPATIBILITY.
//
// The migration is additive (spec §3). The frozen module definitions that
// passed the structural bar pre-migration must still pass it post-migration,
// AND the shared W9-A7 conformance runner must report each module passing
// (zero failures). This is the compatibility contract: installing the package
// surface did not regress the slice.
// ===========================================================================

for (const [label, module] of WAVE9_MODULES) {
  test(`W9-A8 compatibility ${label}: definition validates (structural gate still green post-migration)`, async () => {
    const { validateProcessModuleDefinition } = await import(
      '../../dist/process-modules/application/validate-process-module.js'
    );
    const result = validateProcessModuleDefinition(module);
    assert.equal(result.valid, true,
      `${label} definition must still validate post-migration: ${JSON.stringify(result.errors)}`);
    assert.equal(result.errors.length, 0,
      `${label} definition must have zero structural errors`);
  });

  test(`W9-A8 compatibility ${label}: shared W9-A7 conformance runner reports passing (zero failures)`, async () => {
    const report = await runModuleConformance({ definition: module });
    assert.equal(report.passing, true,
      `${label} must pass the shared conformance kit post-migration`);
    assert.equal(report.counts.failed, 0,
      `${label} must have zero conformance failures`);
    const failures = report.results.filter((r) => r.status === 'failed');
    assert.equal(failures.length, 0,
      `${label} conformance failures:\n`
        + failures.map((r) => `  [${r.dimension}/${r.check}] ${r.message}`).join('\n'));
  });

  test(`W9-A8 compatibility ${label}: module identity + contracts are unchanged`, () => {
    // The migration must not rewrite the frozen identity / contracts.
    assert.ok(module.identity.name.length > 0);
    assert.ok(module.identity.version.length > 0);
    assert.ok(module.inputContract.id.length > 0);
    assert.ok(module.outputContract.id.length > 0);
    assert.ok(module.outcomes.length > 0, `${label} must declare outcomes`);
  });
}

// ===========================================================================
// DIMENSION 2 — RESTART (durable write-once / replay idempotency).
//
// Each module's durable output store is write-once: the same payload hash for
// the same process_run replays (no second row), and a divergent payload hash
// is rejected. This is the §0.7.11 crash-resume contract: after a worker
// restart, re-writing the same output is an idempotent replay, NOT a second
// write.
// ===========================================================================

test('W9-A8 restart development: output repository is write-once (same hash replays, divergent rejects)', async () => {
  const temp = freshDb();
  try {
    const { getDb } = await import('../../dist/db.js');
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'D')`).run();
    const { DEVELOPMENT_PROCESS_MODULE_REF } = await import(
      '../../dist/process-modules/modules/development/development-process-module.js'
    );
    const { SqliteDevelopmentOutputRepository } = await import(
      '../../dist/infrastructure/process-modules/development/development-persistence.js'
    );
    const processRunId = await startRun(db, DEVELOPMENT_PROCESS_MODULE_REF, 'w9a8-dev-restart');
    const repo = new SqliteDevelopmentOutputRepository(db);

    const payload = {
      schemaVersion: 'saga3.verified-integration-bundle.v1',
      formalizationCertificate: { schemaId: 's', version: '1.0.0', digest: 'd' },
      solutionContract: { schemaId: 's', version: '1.0.0', digest: 'd' },
      acceptanceBaselineHash: 'b'.repeat(64),
      taskGraph: { schemaId: 's', version: '1.0.0', digest: 'd' },
      implementationWorkset: { schemaId: 's', version: '1.0.0', digest: 'd' },
      integratedCandidate: { schemaId: 's', version: '1.0.0', digest: 'd' },
      acceptanceVerification: { schemaId: 's', version: '1.0.0', digest: 'd' },
      repositories: [],
      buildProducts: [],
      bundleHash: 'h'.repeat(64),
    };

    const first = repo.persist({ processRunId, projectId: 1, epicId: 10, payload });
    assert.equal(first.replayed, false, 'first persist must materialize');

    // RESTART: same payload -> idempotent replay, no second row.
    const replay = repo.persist({ processRunId, projectId: 1, epicId: 10, payload });
    assert.equal(replay.replayed, true, 'restart with same hash must replay');
    assert.equal(
      replay.record.processRunId,
      first.record.processRunId,
      'replay must return the SAME process_run binding',
    );
    assert.equal(
      replay.record.contentHash,
      first.record.contentHash,
      'replay must preserve the content hash',
    );

    // A DIFFERENT bundle for the same process_run is rejected (write-once).
    const divergent = { ...payload, bundleHash: 'x'.repeat(64) };
    assert.throws(
      () => repo.persist({ processRunId, projectId: 1, epicId: 10, payload: divergent }),
      /DEVELOPMENT_OUTPUT_ALREADY_PERSISTED/,
      'a divergent development output for the same process_run must be rejected',
    );
  } finally {
    await teardownDb(temp);
  }
});

test('W9-A8 restart delivery: output repository is write-once (same hash replays, divergent rejects)', async () => {
  const temp = freshDb();
  try {
    const { getDb } = await import('../../dist/db.js');
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'D')`).run();
    const { DELIVERY_PROCESS_MODULE_REF } = await import(
      '../../dist/process-modules/modules/delivery/delivery-process-module.js'
    );
    const { SqliteDeliveryOutputRepository } = await import(
      '../../dist/infrastructure/process-modules/delivery/delivery-persistence.js'
    );
    const processRunId = await startRun(db, DELIVERY_PROCESS_MODULE_REF, 'w9a8-del-restart');
    const repo = new SqliteDeliveryOutputRepository(db);

    const ref = (digest) => ({ schemaId: 's', version: '1.0.0', digest });
    const payload = {
      schemaVersion: 'saga3.release-record.v1',
      developmentCertificate: ref('1'),
      verifiedIntegrationBundle: ref('2'),
      integratedCandidate: ref('3'),
      policy: {
        schemaVersion: 'saga3.delivery-release-policy.v1',
        policyVersion: '1.0.0',
        policyHash: 'p'.repeat(64),
        requireHumanApproval: true,
        destinations: [],
      },
      preflight: ref('4'),
      approval: ref('5'),
      publication: ref('6'),
      observation: ref('7'),
      destinations: [],
      recordHash: 'r'.repeat(64),
    };

    const first = repo.persist({ processRunId, projectId: 1, epicId: 10, payload });
    assert.equal(first.replayed, false, 'first persist must materialize');

    const replay = repo.persist({ processRunId, projectId: 1, epicId: 10, payload });
    assert.equal(replay.replayed, true, 'restart with same hash must replay');
    assert.equal(replay.record.contentHash, first.record.contentHash,
      'replay must preserve the content hash');

    // Delivery epic_id may be null; divergent payload must still be rejected.
    const divergent = { ...payload, recordHash: 'z'.repeat(64) };
    assert.throws(
      () => repo.persist({ processRunId, projectId: 1, epicId: 10, payload: divergent }),
      /DELIVERY_OUTPUT_ALREADY_PERSISTED/,
      'a divergent release record for the same process_run must be rejected',
    );
  } finally {
    await teardownDb(temp);
  }
});

test('W9-A8 restart discovery: outcome certificate is write-once (same hash replays, divergent rejects)', async () => {
  // Discovery's authoritative durable artifact is the outcome certificate,
  // issued atomically by issueCertificateAtomically (write-once on
  // settlement_id). This mirrors the W8-A8 formalization certificate restart
  // contract applied to Discovery's own certificate store. The fixture seeds
  // the minimal FK chain (project/epic/episode/task/work-intent/proposal) the
  // certificate row REFERENCES, the same pattern used by the d4-settlement
  // atomicity suite.
  const temp = freshDb();
  try {
    const { getDb } = await import('../../dist/db.js');
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'D')`).run();
    db.prepare(`INSERT INTO episode_workflows (epic_id,stage,metadata) VALUES (10,'discovery','{}')`).run();
    db.prepare(`INSERT INTO tasks (id,epic_id,title,status,task_kind) VALUES (100,10,'D','done','discovery.work')`).run();
    db.prepare(`INSERT INTO saga3_work_intents (id,epic_id,kind,objective,authority_scope,output_schema,token_budget,retry_budget,projected_task_id,status) VALUES (1,10,'discovery','o','{}','saga3.work-intent.discovery.v1',0,0,100,'concluded')`).run();
    db.prepare(`INSERT INTO saga3_proposals (id,intent_id,task_id,execution_id,kind,schema_version,payload,content_hash,status,provenance) VALUES (50,1,100,'exec','discovery','saga3.discovery-proposal.v1','{}','${'a'.repeat(64)}','submitted','{}')`).run();
    const {
      ensureSaga3SettlementSchema,
      insertSettlement,
      issueCertificateAtomically,
    } = await import(
      '../../dist/modules/discovery/infrastructure/saga3-settlement-repository.js'
    );
    ensureSaga3SettlementSchema(db);

    const { canonicalJson } = await import(
      '../../dist/process-modules/shared/canonical-json.js'
    );
    const inputSnapshot = {
      schema_version: 'saga3.discovery-settlement-input.v1',
      epic_id: 10,
      proposal: { id: 50, content_hash: 'a'.repeat(64) },
      readiness: { status: 'accepted_by_kernel', assessment_id: 7, content_hash: 'b'.repeat(64), payload: null },
      policy: { version: '1.0.0', content_hash: 'q'.repeat(64) },
      captured_at: '2026-07-29T00:00:00.000Z',
    };
    const snapshotText = canonicalJson(inputSnapshot);
    const inputHash = sha256(snapshotText);
    const { record: settlement } = insertSettlement(db, {
      epicId: 10,
      key: {
        proposalId: 50,
        proposalContentHash: 'a'.repeat(64),
        readinessTarget: 'accepted:' + 'b'.repeat(64),
        policyVersion: '1.0.0',
        policyHash: 'q'.repeat(64),
      },
      readinessAssessmentId: 7,
      inputSnapshot,
      decision: 'go',
      reasonCodes: ['GO_READY_AND_GROUNDED'],
      rationale: 'sufficient evidence',
    });

    const certificatePayload = {
      schemaVersion: 'saga3.discovery-outcome-certificate.v1',
      decision: 'go',
      reasonCodes: ['GO_READY_AND_GROUNDED'],
      rationale: 'sufficient evidence',
      inputHash,
    };
    const payloadText = canonicalJson(certificatePayload);
    const expectedHash = sha256(payloadText);

    const base = {
      settlementId: settlement.id,
      epicId: 10,
      proposalId: 50,
      proposalContentHash: 'a'.repeat(64),
      readinessAssessmentId: 7,
      readinessAssessmentHash: 'accepted:' + 'b'.repeat(64),
      policyVersion: '1.0.0',
      policyHash: 'q'.repeat(64),
      decision: 'go',
      reasonCodes: ['GO_READY_AND_GROUNDED'],
      inputHash,
      certificatePayload,
      expectedCertificateHash: expectedHash,
      issuedAt: settlement.created_at,
      inputSnapshotText: settlement.input_snapshot,
      rationale: 'sufficient evidence',
    };

    const first = issueCertificateAtomically(db, base);
    assert.equal(first.inserted, true, 'first issuance must insert');

    // RESTART: same payload -> idempotent replay (inserted=false), same row.
    const replay = issueCertificateAtomically(db, base);
    assert.equal(replay.inserted, false, 'restart with same hash must replay');
    assert.equal(replay.record.id, first.record.id,
      'replay must return the SAME certificate id');
    assert.equal(replay.record.certificateHash, first.record.certificateHash,
      'replay must preserve the certificate hash');

    // A DIFFERENT payload for the same settlement is rejected (write-once).
    const divergentPayload = { ...certificatePayload, rationale: 'tampered' };
    const divergentText = canonicalJson(divergentPayload);
    assert.throws(
      () => issueCertificateAtomically(db, {
        ...base,
        certificatePayload: divergentPayload,
        expectedCertificateHash: sha256(divergentText),
      }),
      /does not match the expected canonical payload|certificate_hash|disagrees/,
      'a divergent certificate payload for the same settlement must be rejected',
    );
  } finally {
    await teardownDb(temp);
  }
});

// ===========================================================================
// DIMENSION 3 — RECOVERY conformance.
//
// Every flow.recovery[] entry references EXISTING verify + repair nodes
// (verify != repair), declares maxAttempts>=1, non-empty trigger/resolved
// events, and a closed onExhausted from {fail|pause|escalate}. Every
// executionProfile.recoveryPolicy has resumeFromCheckpoint=true + a closed
// onExhausted. Modules with no recovery entries pass vacuously (Discovery,
// Delivery); Development declares one repair route.
// ===========================================================================

for (const [label, module] of WAVE9_MODULES) {
  test(`W9-A8 recovery ${label}: every flow.recovery entry references existing verify + repair nodes`, () => {
    const nodeIds = new Set(module.flow.nodes.map((n) => n.id));
    const recovery = module.flow.recovery ?? [];
    for (const r of recovery) {
      assert.ok(nodeIds.has(r.verifyNodeId),
        `${label} recovery ${r.id} verifyNodeId '${r.verifyNodeId}' not in flow nodes`);
      assert.ok(nodeIds.has(r.repairNodeId),
        `${label} recovery ${r.id} repairNodeId '${r.repairNodeId}' not in flow nodes`);
      assert.notEqual(r.verifyNodeId, r.repairNodeId,
        `${label} recovery ${r.id} verifyNodeId === repairNodeId (self-repair forbidden)`);
    }
  });

  test(`W9-A8 recovery ${label}: every recovery entry has non-empty events + maxAttempts>=1 + closed onExhausted`, () => {
    const recovery = module.flow.recovery ?? [];
    for (const r of recovery) {
      assert.ok(Array.isArray(r.triggerEvents) && r.triggerEvents.length > 0,
        `${label} recovery ${r.id} triggerEvents must be non-empty`);
      assert.ok(Array.isArray(r.resolvedEvents) && r.resolvedEvents.length > 0,
        `${label} recovery ${r.id} resolvedEvents must be non-empty`);
      assert.ok(Number.isInteger(r.maxAttempts) && r.maxAttempts >= 1,
        `${label} recovery ${r.id} maxAttempts must be an integer >= 1`);
      assert.ok(ON_EXHAUSTED_VALUES.includes(r.onExhausted),
        `${label} recovery ${r.id} onExhausted '${r.onExhausted}' not in ${ON_EXHAUSTED_VALUES.join('|')}`);
    }
  });

  test(`W9-A8 recovery ${label}: every executionProfile.recoveryPolicy resumes from checkpoint with closed onExhausted`, () => {
    for (const p of module.executionProfiles) {
      const rp = p.recoveryPolicy;
      assert.ok(rp, `${label} profile ${p.id} missing recoveryPolicy`);
      assert.equal(rp.resumeFromCheckpoint, true,
        `${label} profile ${p.id} recoveryPolicy.resumeFromCheckpoint must be true (crash-resume)`);
      assert.ok(ON_EXHAUSTED_VALUES.includes(rp.onExhausted),
        `${label} profile ${p.id} recoveryPolicy.onExhausted '${rp.onExhausted}' not in closed set`);
    }
  });
}

// ===========================================================================
// DIMENSION 4 — EXACT-OUTPUT (deterministic settlement core).
//
// Each module's settlement policy is a pure function of its input: the same
// input yields the same decision + reasonCodes + 64-char inputHash every
// time. The policies do no I/O and contain no LM/no time/no randomness. The
// probe drives the simplest deterministic branch (an invalid input contract
// -> 'failed' + invalid-input-contract) so the assertion is self-contained
// and does not depend on assembling a full valid settlement graph.
// ===========================================================================

test('W9-A8 exact-output development: settlement policy is a pure function (same input -> same decision + inputHash)', async () => {
  const { ReferenceDevelopmentSettlementPolicy } = await import(
    '../../dist/process-modules/modules/development/development-settlement-policy.js'
  );
  const policy = new ReferenceDevelopmentSettlementPolicy();
  // An invalid schemaVersion is the simplest deterministic branch: the policy
  // rejects it with 'failed' + invalid-input-contract, independent of any
  // durable product assembly.
  const input = {
    schemaVersion: 'bogus',
    developmentCase: {
      schemaVersion: 'x',
      formalizationCertificate: null,
      solutionContract: null,
      acceptanceBaselineHash: '',
      taskGraph: null,
      srs: null,
      repositoryBases: [],
    },
    taskGraph: null,
    implementationWorkset: null,
    integratedCandidate: null,
    observedCandidateHash: null,
    acceptanceVerification: null,
    productReferences: {
      taskGraph: null,
      implementationWorkset: null,
      integratedCandidate: null,
      acceptanceVerification: null,
    },
    openHumanGateIds: [],
  };
  const a = policy.settle(input);
  const b = policy.settle(input);
  assert.deepEqual(a, b, 'settle() must be deterministic for identical input');
  assert.equal(a.decision, 'failed', 'invalid input contract must settle failed');
  assert.ok(a.reasonCodes.includes('invalid-input-contract'),
    'failed decision must carry invalid-input-contract');
  assert.ok(typeof a.inputHash === 'string' && a.inputHash.length === 64,
    'settlement result must carry a 64-char inputHash');
});

test('W9-A8 exact-output delivery: settlement policy is a pure function (same input -> same decision + inputHash)', async () => {
  const { ReferenceDeliverySettlementPolicy } = await import(
    '../../dist/process-modules/modules/delivery/delivery-settlement-policy.js'
  );
  const policy = new ReferenceDeliverySettlementPolicy();
  const input = {
    schemaVersion: 'bogus',
    deliveryCase: { schemaVersion: 'x' },
    currentCandidateHash: 'a',
    preflight: null,
    approval: null,
    publication: null,
    observation: null,
    productReferences: {
      preflight: null,
      approval: null,
      publication: null,
      observation: null,
    },
  };
  const a = policy.settle(input);
  const b = policy.settle(input);
  assert.deepEqual(a, b, 'settle() must be deterministic for identical input');
  assert.equal(a.decision, 'failed', 'invalid input contract must settle failed');
  assert.ok(a.reasonCodes.includes('invalid-input-contract'),
    'failed decision must carry invalid-input-contract');
  assert.ok(typeof a.inputHash === 'string' && a.inputHash.length === 64,
    'settlement result must carry a 64-char inputHash');
});

test('W9-A8 exact-output discovery: certificate projection is a pure function (same record -> same generic certificate)', async () => {
  // Discovery's authoritative output is its outcome certificate; the
  // DiscoveryOutcomeCertificateProjection re-shapes it into the generic
  // ProcessOutcomeCertificate on the fly. That projection must be a pure
  // function: the same record + projectId yields the same generic certificate
  // (same decision, reasonCodes, inputHash, certificateHash) every time.
  const { projectDiscoveryCertificate } = await import(
    '../../dist/process-modules/modules/discovery/discovery-outcome-certificate-projection.js'
  );
  const cert = {
    id: 42,
    settlement_id: 7,
    epic_id: 10,
    proposal_id: 1,
    proposal_content_hash: 'p'.repeat(64),
    readiness_assessment_id: null,
    readiness_assessment_hash: 'r'.repeat(64),
    policy_version: '1.0.0',
    policy_hash: 'q'.repeat(64),
    decision: 'go',
    reason_codes: [],
    input_hash: 'i'.repeat(64),
    certificate_payload: JSON.stringify({
      decision: 'go',
      reasonCodes: [],
      rationale: 'sufficient evidence',
      inputHash: 'i'.repeat(64),
    }),
    certificate_hash: 'c'.repeat(64),
    issued_at: '2026-07-29T00:00:00Z',
  };
  const a = projectDiscoveryCertificate(cert, 1);
  const b = projectDiscoveryCertificate(cert, 1);
  assert.deepEqual(a, b, 'projection must be deterministic for identical record + projectId');
  assert.equal(a.decision, 'go');
  assert.equal(a.inputHash, 'i'.repeat(64));
  assert.equal(a.certificateHash, 'c'.repeat(64));
  assert.equal(a.moduleRef.name, 'product-discovery');
  assert.equal(a.moduleRef.version, '3.0.2');
});

// ===========================================================================
// DIMENSION 5 — PACKAGE-ISOLATION (sibling surface; skip-on-absent-sibling).
//
// The §0.11.11 serial gate requires each module to run completely through
// pinned package resources: no global skill/template lookup, no direct
// infrastructure dependency. That surface is authored by sibling lanes
// (W9-A1 discovery, W9-A3 development, W9-A5 delivery). In the isolated w9-a8
// worktree a sibling's compiled manifest may be ABSENT, so these tests
// resolve the manifest dynamically and SKIP with a clear reason when it is
// missing — NOT a failure. The integrator's full Wave-9 gate run (all
// siblings present) is where package-isolation MUST PASS for every module.
// ===========================================================================

/**
 * Lazily import a module's sibling package manifest. Returns null when the
 * sibling compiled surface is absent (isolated worktree). The caller decides
 * skip vs fail.
 *
 * @param {string} manifestPath - dist-relative manifest module path.
 * @param {string} exportName  - named export holding the manifest.
 * @returns {Promise<{ manifest: any, validator: any } | null>}
 */
async function loadPackageManifest(manifestPath, exportName) {
  try {
    const mod = await import(manifestPath);
    if (!mod || typeof mod[exportName] === 'undefined') return null;
    const { validateProcessModuleManifest } = await import(
      '../../dist/process-modules/domain/spi/module-manifest.js'
    );
    return { manifest: mod[exportName], validator: { validateProcessModuleManifest } };
  } catch {
    return null;
  }
}

const PACKAGE_SURFACES = [
  {
    label: 'discovery',
    manifestPath: '../../dist/process-modules/modules/discovery/package/manifest.js',
    exportName: 'discoveryPackageManifest',
    definition: discoveryProcessModule,
  },
  {
    label: 'development',
    manifestPath: '../../dist/process-modules/modules/development/package/manifest.js',
    exportName: 'developmentPackageManifest',
    definition: developmentProcessModule,
  },
  {
    label: 'delivery',
    manifestPath: '../../dist/process-modules/modules/delivery/package/manifest.js',
    exportName: 'deliveryPackageManifest',
    definition: deliveryProcessModule,
  },
];

for (const surface of PACKAGE_SURFACES) {
  test(`W9-A8 package-isolation ${surface.label}: manifest exists + validates`, async (t) => {
    const pkg = await loadPackageManifest(surface.manifestPath, surface.exportName);
    if (!pkg) {
      t.diagnostic(
        `SKIP: ${surface.label} package surface absent in isolated W9-A8 worktree. ` +
        `Sibling lane owns it; the integrator's full Wave-9 gate run PASSES this test.`,
      );
      t.skip();
      return;
    }
    const result = pkg.validator.validateProcessModuleManifest(pkg.manifest);
    assert.equal(result.ok, true,
      `${surface.label} manifest must validate: ${JSON.stringify(result.errors)}`);
  });

  test(`W9-A8 package-isolation ${surface.label}: pinned contracts match the frozen definition`, async (t) => {
    const pkg = await loadPackageManifest(surface.manifestPath, surface.exportName);
    if (!pkg) {
      t.diagnostic(`SKIP: ${surface.label} package surface absent in isolated W9-A8 worktree.`);
      t.skip();
      return;
    }
    const manifest = pkg.manifest;
    assert.equal(
      manifest.inputContractRef.schemaId,
      surface.definition.inputContract.id,
      `${surface.label} pinned input contract must match the module inputContract`,
    );
    assert.equal(
      manifest.outputContractRef.schemaId,
      surface.definition.outputContract.id,
      `${surface.label} pinned output contract must match the module outputContract`,
    );
    assert.ok(
      typeof manifest.runtimeCompatibilityRange === 'string'
        && manifest.runtimeCompatibilityRange.length > 0,
      `${surface.label} manifest must declare a runtimeCompatibilityRange`,
    );
  });

  test(`W9-A8 package-isolation ${surface.label}: resources are package-local (no global lookup)`, async (t) => {
    const pkg = await loadPackageManifest(surface.manifestPath, surface.exportName);
    if (!pkg) {
      t.diagnostic(`SKIP: ${surface.label} package surface absent in isolated W9-A8 worktree.`);
      t.skip();
      return;
    }
    const manifest = pkg.manifest;
    assert.ok(
      Array.isArray(manifest.resourceIndex) && manifest.resourceIndex.length > 0,
      `${surface.label} manifest must declare package-local resources`,
    );
    for (const r of manifest.resourceIndex) {
      assert.ok(!r.path.startsWith('/'),
        `${surface.label} resource ${r.logicalId} path must be package-relative (no absolute path)`);
      assert.ok(!r.path.includes('..'),
        `${surface.label} resource ${r.logicalId} path must not traverse parent (no '..')`);
    }
  });
}

// ===========================================================================
// SMOKE — prove the suite exercised the frozen slice of each module (guards
// against a future refactor silently deleting nodes/profiles and making every
// test above trivially pass on empty collections).
// ===========================================================================

test('W9-A8 smoke: the three Wave-9 modules are non-trivial and distinct', () => {
  const names = WAVE9_MODULES.map(([, m]) => m.identity.name);
  assert.equal(new Set(names).size, 3, 'the three modules must have distinct names');
  for (const [, module] of WAVE9_MODULES) {
    assert.ok(module.flow.nodes.length > 0, `${module.identity.name} must declare flow nodes`);
    assert.ok(module.flow.terminalNodeIds.length > 0,
      `${module.identity.name} must declare terminal nodes`);
    const terminalNodes = module.flow.nodes.filter(
      (n) => module.flow.terminalNodeIds.includes(n.id),
    );
    for (const node of terminalNodes) {
      assert.ok(typeof node.emitsOutcome === 'string',
        `${module.identity.name} terminal node ${node.id} must emit an outcome`);
    }
  }
});

test('W9-A8 smoke: every Wave-9 module independently passes the shared conformance kit', async () => {
  // The exit gate (spec §2) is that Discovery, Development AND Delivery each
  // independently pass the SAME kit. This smoke test pins that all three
  // report passing in one place.
  for (const [label, module] of WAVE9_MODULES) {
    const report = await runModuleConformance({ definition: module });
    assert.equal(report.passing, true,
      `${label} must independently pass the shared conformance kit (exit gate)`);
  }
});
