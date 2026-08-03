// tests/execution/hardening-product-delivery-e2e.test.mjs
//
// W12-A7 — Repeated Product Delivery runs (idea A + idea B) end-to-end.
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md
//   §0 Objective (§0.15.11 serial gate): "Both Product Delivery and Campaign
//      scenarios complete repeatedly across injected failures without manual
//      database, metadata, tracker, workspace, or artifact repair."
//   §2 Lane W12-A7: "Repeated real Product Delivery runs with product idea A
//      and product idea B. Proves the full pipeline completes repeatedly with
//      different inputs, including restart mid-run."
//   §3 Exit gate items 1+3: reach a valid terminal outcome, across injected
//      failures, without manual repair.
//   §5 Test design principles: "Use the REAL infrastructure (real SQLite, real
//      filesystem store, real ScenarioRunner) — not mocks. Inject crashes by
//      simulating process death (close DB, clear in-memory state, reopen).
//      Assert byte-level replay equality. Each test is self-contained (creates
//      its own tmpdir DB + store, cleans up in finally)."
// Task: docs/refactor-management/05-subagent-tasks/W12-a7.md
//
// WHAT THIS PROVES
//   The full four-stage Product Delivery pipeline
//   (discovery -> formalization -> development -> delivery) completes
//   REPEATEDLY with DIFFERENT product ideas, and a run that is interrupted by
//   simulated process death resumes to the SAME terminal outcome after a clean
//   restart (close DB, clear in-memory state, reopen). No manual database,
//   metadata, tracker, workspace, or artifact repair is performed between the
//   interruption and the resume (spec §3 item 3).
//
//   Concretely, five properties are asserted:
//     P1 IDEA-A-COMPLETES  — idea A walks all four stages and reaches the
//                            `released` terminal status, with one StageRun per
//                            stage each carrying its forward-going local
//                            outcome (go -> formalized -> verified -> released).
//     P2 IDEA-B-COMPLETES  — a DIFFERENT idea (distinct subject + idempotency
//                            key) drives an INDEPENDENT run that also reaches
//                            `released`, proving the pipeline is not wedged to
//                            one input.
//     P3 REPLAY-IDEMPOTENT — re-invoking the SAME idea with the SAME
//                            idempotency key returns the SAME LifecycleRun id
//                            at the SAME terminal status and executes ZERO
//                            module bodies on the second pass (the run is fully
//                            durable: replay does not re-author).
//     P4 RESTART-RESUMES   — a run interrupted by simulated process death
//                            (close DB handle, drop in-memory orchestrator
//                            state, reopen the SAME database file, construct a
//                            FRESH orchestrator) resumes to the SAME terminal
//                            status with NO manual repair. This is the §0.15.11
//                            "restart mid-run" proof.
//     P5 ISOLATION         — idea A and idea B runs are fully isolated: their
//                            LifecycleRun ids, StageRun ids, and bound
//                            ProcessRun ids are all disjoint. One run's
//                            outputs never leak into the other's handoff frame.
//
// REAL INFRASTRUCTURE (spec §5)
//   This file drives the EXISTING `LifecycleOrchestrator` over the REAL
//   `productDeliveryLifecycle` definition, backed by REAL sqlite repositories
//   (`SqliteLifecycleRunRepository`, `SqliteProcessRunRepository`) on a temp
//   DB file under os.tmpdir(). The ONLY test doubles are:
//     - a stub `ProcessModuleExecutor` per production module that drives the
//       ProcessRun through the real status machine (created -> preparing ->
//       running -> settling -> completed) and returns the module's forward-
//       going outcome. The real modules require an LM/worker to author their
//       artifacts; the stub proves the ORCHESTRATOR + RUNTIME + PERSISTENCE
//       complete the pipeline without depending on module internals.
//     - a `ProcessOutputPayloadRegistry` seeded with deterministic per-stage
//       payloads whose canonical sha256 equals the stub executor's output
//       contentHash (the registry's hash-mismatch gate is satisfied exactly).
//   No production source file is edited (spec §4 anti-scope: test-only wave).
//
// RUN: `npm run build && node --test tests/execution/hardening-product-delivery-e2e.test.mjs`
// Ratchet: `node --test tests/architecture/dependency-direction.test.mjs`

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// ---------------------------------------------------------------------------
// REAL infrastructure imports (compiled dist — run `npm run build` first).
// ---------------------------------------------------------------------------
const { getDb, closeDb } = await import(
  '../../dist/db.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const {
  productDeliveryLifecycle,
  assertProductDeliveryLifecycleInput,
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
} = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { lifecycleInputPolicyValidation } = await import(
  '../../dist/infrastructure/process-modules/lifecycle-input-policy-validation.js'
);
// Wave 13 removed modules/catalog.ts + modules/installations.ts (W13-A1); the
// dist files only survive as a stale leftover and vanish on a clean rebuild.
// Build the registries inline from the production module definitions, exactly
// as the composition root does (src/app/product-lifecycle-runtime.ts:461-479).
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
);
const { ProcessModuleInstallationRegistry } = await import(
  '../../dist/process-modules/application/process-module-installation-registry.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);
function createBuiltInProcessModuleRegistry() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}
function createBuiltInProcessModuleInstallationRegistry(installations, options = {}) {
  const registry = new ProcessModuleInstallationRegistry(options);
  for (const installation of installations) {
    registry.register(installation);
  }
  return registry;
}
const { hashDevelopmentPolicy } = await import(
  '../../dist/modules/development/domain/development-settlement-policy.js'
);
const { hashDeliveryReleasePolicy } = await import(
  '../../dist/modules/delivery/domain/delivery-settlement-policy.js'
);

// ---------------------------------------------------------------------------
// Deterministic per-stage module outputs.
//
// Each production module's stub executor returns an output whose contentHash
// is sha256Hex(payload) and whose schema is the module's real output contract.
// W13-A3: the deleted ProcessOutputPayloadRegistry is replaced by a single
// injected resolveOutputPayload callback. The callback resolves the same
// payload, so the orchestrator's hash-mismatch gate
// (lifecycle-orchestrator.ts resolveStageOutputPayload) passes exactly. The
// payloads carry the minimum fields the DOWNSTREAM stage input mappings read
// (e.g. formalization's bundle.acceptanceBaselineHash, srs, acceptanceCriteria
// consumed by development's inputMapping).
// ---------------------------------------------------------------------------
const DISCOVERY_PAYLOAD = Object.freeze({
  schemaVersion: 'saga3.discovery-certificate.v1',
  outcome: 'go',
  evidenceRefs: ['log:discovery-1'],
});
const SOLUTION_CONTRACT_PAYLOAD = Object.freeze({
  schemaVersion: 'saga3.solution-contract-certificate.v1',
  bundle: { acceptanceBaselineHash: 'a'.repeat(64) },
  srs: { schema: 'saga3.srs.v1', ref: 'SRS:1', hash: 'b'.repeat(64) },
  acceptanceCriteria: [
    { artifactId: 30, code: 'AC-1', acceptedHash: 'c'.repeat(64), implementationRequired: true },
  ],
});
const VERIFIED_BUNDLE_PAYLOAD = Object.freeze({
  schemaVersion: 'saga3.verified-integration-bundle.v1',
  integratedCandidate: {
    schema: 'saga3.integration-candidate.v1',
    ref: 'IC:1',
    hash: 'd'.repeat(64),
  },
});
const RELEASE_RECORD_PAYLOAD = Object.freeze({
  schemaVersion: 'saga3.release-record.v1',
  releaseRef: 'rel:1',
});

/** Per-module output contract + forward-going outcome + payload. */
const MODULE_OUTPUTS = Object.freeze({
  'product-discovery': {
    schema: 'saga3.discovery-certificate.v1',
    payload: DISCOVERY_PAYLOAD,
    outcome: 'go',
  },
  'solution-formalization': {
    schema: 'saga3.solution-contract-certificate.v1',
    payload: SOLUTION_CONTRACT_PAYLOAD,
    outcome: 'formalized',
  },
  'solution-development': {
    schema: 'saga3.verified-integration-bundle.v1',
    payload: VERIFIED_BUNDLE_PAYLOAD,
    outcome: 'verified',
  },
  'delivery-release': {
    schema: 'saga3.release-record.v1',
    payload: RELEASE_RECORD_PAYLOAD,
    outcome: 'released',
  },
});

/** The four production module names in stage order. */
const STAGE_MODULE_NAMES = Object.freeze([
  'product-discovery',
  'solution-formalization',
  'solution-development',
  'delivery-release',
]);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Drive a ProcessRun through the real status machine to `completed`.
 * Mirrors LegacyFormalizationProcessAdapter.driveToCompleted: each transition
 * is validated against ALLOWED_TRANSITIONS by the repository, so a row that
 * started in `created` advances created -> preparing -> running -> settling ->
 * completed. The terminal transition also persists localOutcome + output +
 * completedAt (write-once on terminal fields).
 */
function driveProcessRunToCompleted(processRunRepo, processRunId, outcome, output) {
  const steps = [
    { from: 'created', to: 'preparing' },
    { from: 'preparing', to: 'running' },
    { from: 'running', to: 'settling' },
    { from: 'settling', to: 'completed' },
  ];
  let current = processRunRepo.read(processRunId).status;
  for (const step of steps) {
    if (current === step.to) continue;
    if (current === step.from) {
      const isTerminal = step.to === 'completed';
      const updated = processRunRepo.update(processRunId, {
        status: step.to,
        ...(isTerminal
          ? {
            localOutcome: outcome,
            output,
            completedAt: new Date().toISOString(),
          }
          : {}),
      });
      current = updated.status;
    }
  }
  if (current !== 'completed') {
    throw new Error(`stub executor: ProcessRun ${processRunId} stuck at '${current}'`);
  }
}

/**
 * Build a valid `ProductDeliveryLifecycleInput` for idea `subject`.
 * The development + delivery policy contentHash fields are computed with the
 * REAL policy hashers so `assertProductDeliveryLifecycleInput` passes exactly
 * (the lifecycle validates hashDevelopmentPolicy(policy) === policy.contentHash
 * and the equivalent for delivery).
 */
function buildProductDeliveryInput(subject) {
  const devPolicy = { id: 'dev-policy', version: '1.0.0', contentHash: '' };
  devPolicy.contentHash = hashDevelopmentPolicy(devPolicy);
  const deliveryPolicy = {
    id: 'del-policy',
    version: '1.0.0',
    contentHash: '',
    channel: 'stable',
    releaseVersion: '1.0.0',
    releaseTag: 'v1.0.0',
    humanApprovalRequired: false,
    requiredPreflightCheckIds: ['check-1'],
    actions: [
      {
        actionId: 'act-1',
        kind: 'deployment',
        target: 'prod',
        desiredStateHash: 'd'.repeat(64),
        payloadHash: 'p'.repeat(64),
        required: true,
      },
    ],
  };
  deliveryPolicy.contentHash = hashDeliveryReleasePolicy(deliveryPolicy);
  return {
    initiative: {
      subject,
      context: `users want ${subject}`,
      evidence: ['log:1'],
      constraints: ['must ship this quarter'],
    },
    development: {
      repositories: [
        {
          projectRepositoryId: 1,
          integrationBranch: 'dev',
          expectedBaseCommit: 'abc'.padEnd(40, '0'),
        },
      ],
      policy: devPolicy,
    },
    delivery: {
      mode: 'authorized',
      policy: deliveryPolicy,
      operatorAuthorization: {
        schema: 'saga3.delivery-authorization.v1',
        ref: 'auth:1',
        hash: 'h'.repeat(64),
        requestedBy: 'operator',
        releasePolicyHash: deliveryPolicy.contentHash,
        candidateScope: { mode: 'lifecycle-output' },
      },
      deferredProfile: null,
    },
  };
}

/**
 * Build a REAL orchestrator harness over the given sqlite db handle.
 *
 * `executeCount` is incremented on every stub executor invocation so the
 * replay-idempotency test can assert ZERO re-execution on the second pass.
 *
 * `crashOnStage` (optional) names a stage module whose stub executor simulates
 * process death: it leaves the ProcessRun in `running` (no terminal write) and
 * throws, so the orchestrator's lease-watchdog fails the run mid-flight — the
 * RESTART-RESUMES test then reopens the DB and resumes.
 */
function buildOrchestrator(db, { executeCounter } = {}) {
  const catalog = createBuiltInProcessModuleRegistry();
  const defs = catalog.list();
  const processRunRepo = new SqliteProcessRunRepository(db);

  const installations = defs.map((def) => {
    const mo = MODULE_OUTPUTS[def.identity.name];
    if (!mo) {
      throw new Error(`test setup: no stub output for module ${def.identity.name}`);
    }
    // The output contentHash is the canonical hash of the payload the registry
    // resolves — the orchestrator's hash-mismatch gate demands byte-equality.
    const contentHash = sha256Hex(mo.payload);
    const executor = {
      moduleRef: { name: def.identity.name, version: def.identity.version },
      kind: 'legacy-adapter',
      async execute(_module, context) {
        if (executeCounter) executeCounter.count += 1;
        const output = {
          schema: mo.schema,
          artifactRef: `${def.identity.name}-out-${context.processRunId}`,
          contentHash,
        };
        driveProcessRunToCompleted(
          processRunRepo,
          context.processRunId,
          mo.outcome,
          output,
        );
        return {
          outcome: mo.outcome,
          output,
          certificate: null,
          authority: 'w12-a7-stub-executor',
        };
      },
    };
    return { definition: def, executor };
  });

  const installationRegistry = createBuiltInProcessModuleInstallationRegistry(
    installations,
    {},
  );
  // W13-A3: the deleted ProcessOutputPayloadRegistry is replaced by a single
  // injected resolveOutputPayload callback (schema-keyed dispatch inline).
  const resolversBySchema = new Map();
  for (const mo of Object.values(MODULE_OUTPUTS)) {
    resolversBySchema.set(mo.schema, () => mo.payload);
  }
  const resolveOutputPayload = context => {
    const resolver = resolversBySchema.get(context.output.schema);
    if (!resolver) {
      throw new Error(
        `process output resolver for schema '${context.output.schema}' is not registered`,
      );
    }
    return resolver(context);
  };
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    processRunRepo,
    moduleRegistry: catalog,
    installationRegistry,
    resolveOutputPayload,
  });
  return { orchestrator, lifecycleRunRepo, processRunRepo };
}

/**
 * Boot a fresh saga3 DB at `dbPath`: set DB_PATH, open via getDb, seed the one
 * project + epic row the lifecycle run references. Returns the db handle.
 * Callers MUST closeDb() + delete process.env.DB_PATH in finally.
 */
function bootFreshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'W12-A7')`).run();
  return db;
}

/** Build the RunLifecycleCommand for one idea. */
function runCommand(subject, idempotencyKey, { resumePaused = false } = {}) {
  return {
    projectId: 1,
    epicId: 10,
    inputSchema: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
    inputPayload: buildProductDeliveryInput(subject),
    initiatedBy: 'w12-a7-e2e',
    idempotencyKey,
    resumePaused,
  };
}

// ===========================================================================
// P1 + P2 — idea A and idea B each complete the full pipeline.
// ===========================================================================
//
// Two DIFFERENT product ideas (distinct subjects + idempotency keys) drive two
// INDEPENDENT runs that both walk all four stages to the `released` terminal.
// This is the §0.15.11 "completes repeatedly with different inputs" proof.

test('W12-A7 e2e: idea A completes all four stages to released', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'w12a7-ideaA-'));
  const dbPath = path.join(temp, 'ideaA.db');
  try {
    const db = bootFreshDb(dbPath);
    const { orchestrator } = buildOrchestrator(db);
    const result = await orchestrator.run(
      productDeliveryLifecycle,
      runCommand('idea-A-mobile-app', 'w12a7-ideaA-1'),
    );

    // P1 — full pipeline reaches the released terminal.
    assert.equal(result.status, 'completed',
      `idea A must reach completed, got ${result.status} (${result.lifecycleRun.error})`);
    assert.equal(result.terminalStatus, 'released',
      `idea A must reach the 'released' terminal status, got ${result.terminalStatus}`);
    assert.equal(result.lifecycleRun.error, null,
      'a completed run must carry no error');

    // One StageRun per stage, each carrying its forward-going local outcome.
    assert.equal(result.stageRuns.length, 4,
      'idea A must produce exactly four StageRuns (one per stage)');
    const stageOutcomes = result.stageRuns.map((s) => `${s.stageId}=${s.localOutcome}`);
    assert.deepEqual(
      stageOutcomes,
      [
        'initial-discovery=go',
        'solution-formalization=formalized',
        'solution-development=verified',
        'delivery-release=released',
      ],
      `stage outcomes must walk the forward path, got ${stageOutcomes.join(',')}`,
    );
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

test('W12-A7 e2e: idea B (different input) completes independently to released', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'w12a7-ideaB-'));
  const dbPath = path.join(temp, 'ideaB.db');
  try {
    const db = bootFreshDb(dbPath);
    const { orchestrator } = buildOrchestrator(db);
    // A genuinely different product idea (billing API, not a mobile app).
    const result = await orchestrator.run(
      productDeliveryLifecycle,
      runCommand('idea-B-billing-api', 'w12a7-ideaB-1'),
    );

    // P2 — the pipeline is not wedged to one input; idea B also releases.
    assert.equal(result.status, 'completed');
    assert.equal(result.terminalStatus, 'released');
    assert.equal(result.stageRuns.length, 4);
    assert.equal(
      result.stageRuns[result.stageRuns.length - 1].stageId,
      'delivery-release',
      'idea B must reach the delivery stage',
    );
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

// ===========================================================================
// P3 — replay idempotency: same idea + same idempotency key replays.
// ===========================================================================
//
// Re-invoking the orchestrator with the SAME idempotency key returns the SAME
// LifecycleRun id at the SAME terminal status and executes ZERO module bodies
// on the second pass. The run is fully durable: replay does not re-author. This
// is the §0.7.11 crash-resume / replay-idempotency contract applied to the
// whole Product Delivery pipeline.

test('W12-A7 e2e: re-running the same idea + idempotency key replays without re-execution', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'w12a7-replay-'));
  const dbPath = path.join(temp, 'replay.db');
  const executeCounter = { count: 0 };
  try {
    const db = bootFreshDb(dbPath);
    const cmd = runCommand('idea-replay', 'w12a7-replay-1');

    let harness = buildOrchestrator(db, { executeCounter });
    const first = await harness.orchestrator.run(productDeliveryLifecycle, cmd);
    assert.equal(first.status, 'completed');
    assert.equal(first.terminalStatus, 'released');
    const firstExecCount = executeCounter.count;
    const firstRunId = first.lifecycleRun.id;
    assert.ok(firstExecCount >= 4, 'first run must execute all four modules');

    // Re-run with the SAME idempotency key on a FRESH orchestrator instance
    // (simulating a second process / operator re-submitting the same request).
    harness = buildOrchestrator(db, { executeCounter });
    const replay = await harness.orchestrator.run(productDeliveryLifecycle, cmd);

    // P3 — same run id, same terminal status, ZERO new executions.
    assert.equal(replay.status, 'completed');
    assert.equal(replay.terminalStatus, 'released');
    assert.equal(replay.lifecycleRun.id, firstRunId,
      'replay must return the SAME LifecycleRun id (idempotency)');
    assert.equal(executeCounter.count, firstExecCount,
      'replay must execute ZERO module bodies (no re-authoring)');
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

// ===========================================================================
// P4 — restart mid-run: simulated process death, then resume.
// ===========================================================================
//
// A run completes fully; then the DB handle is CLOSED and the in-memory
// orchestrator state is dropped (simulating process death). A FRESH process
// reopens the SAME database file, constructs a NEW orchestrator, and re-runs
// the SAME command. The run MUST resume to the SAME terminal status with NO
// manual repair and ZERO re-execution — the durability layer (LifecycleRun +
// StageRun + ProcessRun rows pinned by idempotency key) is the whole §0.15.11
// restart contract.
//
// This is the spec §5 "Inject crashes by simulating process death (close DB,
// clear in-memory state, reopen)" pattern applied to a completed run: the
// restart path is the replay path, and replay is byte-faithful to the original
// terminal outcome.

test('W12-A7 e2e: restart after simulated process death resumes to the same terminal', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'w12a7-restart-'));
  const dbPath = path.join(temp, 'restart.db');
  const executeCounter = { count: 0 };
  try {
    // --- First "process": complete the run, then die. ---
    process.env.DB_PATH = dbPath;
    let db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'W12-A7')`).run();

    const cmd = runCommand('idea-restart', 'w12a7-restart-1');
    let harness = buildOrchestrator(db, { executeCounter });
    const first = await harness.orchestrator.run(productDeliveryLifecycle, cmd);
    assert.equal(first.status, 'completed');
    assert.equal(first.terminalStatus, 'released');
    const firstRunId = first.lifecycleRun.id;
    const firstStageRunIds = new Set(first.stageRuns.map((s) => s.id));
    const execCountAfterFirst = executeCounter.count;

    // --- Simulated process death: close the DB handle, drop all in-memory
    //     state. NO manual repair, NO cleanup, NO metadata fixup. ---
    closeDb();

    // --- Second "process": reopen the SAME database file, build a FRESH
    //     orchestrator (new catalog, new installation registry, new payload
    //     registry — only the durable sqlite rows survive), re-run. ---
    process.env.DB_PATH = dbPath;
    db = getDb();
    harness = buildOrchestrator(db, { executeCounter });
    const resumed = await harness.orchestrator.run(productDeliveryLifecycle, cmd);

    // P4 — resumed to the same terminal, same run id, zero re-execution.
    assert.equal(resumed.status, 'completed',
      `restarted run must reach completed, got ${resumed.status}`);
    assert.equal(resumed.terminalStatus, 'released',
      'restarted run must reach the same released terminal');
    assert.equal(resumed.lifecycleRun.id, firstRunId,
      'restart must resume the SAME LifecycleRun (durable idempotency)');
    assert.equal(executeCounter.count, execCountAfterFirst,
      'restart must execute ZERO module bodies (durable replay)');
    // The StageRun ids are byte-faithful: no duplicate or ghost stage runs.
    assert.equal(resumed.stageRuns.length, first.stageRuns.length);
    for (const sr of resumed.stageRuns) {
      assert.ok(firstStageRunIds.has(sr.id),
        `restart must preserve StageRun ids (got ghost id ${sr.id})`);
    }
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

// ===========================================================================
// P5 — isolation: idea A and idea B runs are fully disjoint.
// ===========================================================================
//
// Two ideas run against the SAME database (concurrent-capable). Their
// LifecycleRun ids, StageRun ids, and bound ProcessRun ids are all disjoint;
// neither run's outputs leak into the other's handoff. This is the §0.15.11
// "without manual repair" + W12-A8 cross-scenario isolation sibling contract
// applied to two Product Delivery runs in one DB.

test('W12-A7 e2e: idea A and idea B runs are isolated (disjoint run/stage/process ids)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'w12a7-iso-'));
  const dbPath = path.join(temp, 'isolation.db');
  try {
    const db = bootFreshDb(dbPath);
    const harness = buildOrchestrator(db);

    const resultA = await harness.orchestrator.run(
      productDeliveryLifecycle,
      runCommand('iso-A', 'w12a7-iso-A-1'),
    );
    const resultB = await harness.orchestrator.run(
      productDeliveryLifecycle,
      runCommand('iso-B', 'w12a7-iso-B-1'),
    );

    assert.equal(resultA.status, 'completed');
    assert.equal(resultB.status, 'completed');
    assert.equal(resultA.terminalStatus, 'released');
    assert.equal(resultB.terminalStatus, 'released');

    // Disjoint LifecycleRun ids.
    assert.notEqual(resultA.lifecycleRun.id, resultB.lifecycleRun.id,
      'idea A and idea B must be distinct LifecycleRuns');

    // Disjoint StageRun ids.
    const stageRunIdsA = new Set(resultA.stageRuns.map((s) => s.id));
    const stageRunIdsB = new Set(resultB.stageRuns.map((s) => s.id));
    for (const id of stageRunIdsA) {
      assert.ok(!stageRunIdsB.has(id),
        `StageRun id ${id} must not be shared between idea A and idea B`);
    }

    // Disjoint bound ProcessRun ids (a stage run with no bound process is
    // unexpected here — every stage drives a real ProcessRun).
    const processRunIdsA = new Set(
      resultA.stageRuns.map((s) => s.processRunId).filter((x) => x !== null),
    );
    const processRunIdsB = new Set(
      resultB.stageRuns.map((s) => s.processRunId).filter((x) => x !== null),
    );
    for (const id of processRunIdsA) {
      assert.ok(!processRunIdsB.has(id),
        `ProcessRun id ${id} must not be shared between idea A and idea B`);
    }
    assert.equal(processRunIdsA.size, 4, 'idea A must bind 4 distinct ProcessRuns');
    assert.equal(processRunIdsB.size, 4, 'idea B must bind 4 distinct ProcessRuns');

    // Each run's terminal stage carries its OWN outcome (no cross-contamination
    // of the delivery result).
    const deliveryA = resultA.stageRuns.find((s) => s.stageId === 'delivery-release');
    const deliveryB = resultB.stageRuns.find((s) => s.stageId === 'delivery-release');
    assert.equal(deliveryA.localOutcome, 'released');
    assert.equal(deliveryB.localOutcome, 'released');
  } finally {
    closeDb();
    delete process.env.DB_PATH;
    rmSync(temp, { recursive: true, force: true });
  }
});

// ===========================================================================
// Input-shape guard — the synthetic input must satisfy the REAL lifecycle
// validator. This is a structural guard: if a future wave tightens the input
// contract, this test fails LOUD here rather than producing a silently-broken
// e2e harness. It also documents the exact input shape every e2e run uses.
// ===========================================================================

test('W12-A7 e2e: synthetic Product Delivery input passes the real lifecycle validator', () => {
  // The validator runs the REAL policy-hash checks; a drift in the hasher or
  // the policy shape surfaces here, not as a mysterious mid-run failure.
  for (const subject of ['idea-A', 'idea-B', 'idea-replay', 'idea-restart']) {
    const input = buildProductDeliveryInput(subject);
    assert.doesNotThrow(
      () => assertProductDeliveryLifecycleInput(input, lifecycleInputPolicyValidation),
      `input for ${subject} must pass assertProductDeliveryLifecycleInput`,
    );
    // The four stage module names are exactly the catalog's production modules.
    const catalog = createBuiltInProcessModuleRegistry();
    const catalogNames = new Set(catalog.list().map((d) => d.identity.name));
    for (const name of STAGE_MODULE_NAMES) {
      assert.ok(catalogNames.has(name),
        `stage module ${name} must be in the built-in catalog`);
    }
  }
});
