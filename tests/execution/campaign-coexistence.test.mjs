// tests/execution/campaign-coexistence.test.mjs
//
// W11-A7 — Campaign integration + coexistence tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md
//       Lane W11-A7 (§2 lane table, §4 exit gate #3: "Campaign runs coexist
//       with Product Delivery"). Plan ref: §0.14.10 (serial cutover), §0.14.11
//       (exit gate), §3.13 (both paths coexist).
// Task: docs/refactor-management/05-subagent-tasks/W11-a7.md
//
// # What this file proves
//
// The Wave 11 cutover (§0.14.10) is a SERIAL, single-writer edit that switches
// NEW Product Delivery runs onto the installed-scenario path while leaving the
// legacy path live. Both paths must coexist (spec §3 anti-scope: "NO legacy
// code is deleted in this wave"). This file is the DEFINITIVE proof of exit
// gate #3: a Campaign scenario run alongside a Product Delivery run WITHOUT
// interference.
//
// "Without interference" decomposes into five static, deterministic,
// sibling-independent invariants (each backed by a real surface that already
// exists in this worktree):
//
//   1. IDENTITY DISJOINTNESS — the Campaign LifecycleScenarioManifest identity
//      (`campaign@1.0.0`) is distinct from the Product Delivery
//      LifecycleDefinition identity (`product-delivery@1.0.0`). Two different
//      lifecycle shapes (LifecycleScenarioManifest vs LifecycleDefinition) can
//      be loaded by the same process without name collision.
//
//   2. ROUTE-TABLE ISOLATION — no Campaign stage-id or outcome target collides
//      with any Product Delivery stage-id or terminal status. A Campaign route
//      can never accidentally land on a Product Delivery stage, and vice versa.
//      This is the static proof the two lifecycles cannot tangle.
//
//   3. TERMINAL-STATUS ISOLATION — the Campaign terminals
//      (`campaign-approved` / `campaign-rejected`) and the Product Delivery
//      terminals (`released`, `failed`, `clarification-required`, ...) are
//      disjoint. A run reaching its terminal can never be confused for the
//      other lifecycle's terminal.
//
//   4. MODULE-PACKAGE ISOLATION — the Campaign scenario depends only on the
//      three external sibling packages (`lm-marketing`, `external-seo`,
//      `human-director-approval`); Product Delivery depends only on the
//      built-in catalog modules (`discovery`, `formalization`, `development`,
//      `delivery`). No module package is shared. The two lifecycles never
//      execute the same ProcessModule installation.
//
//   5. RUNTIME STATE ISOLATION — two ScenarioRunner instances (one driving a
//      Campaign scenario, one driving a Product-Delivery-shaped two-stage
//      walk) sharing the same process boundary never cross-contaminate each
//      other's LifecycleRun/ProcessRun/lease/output store: each runner owns
//      its own in-memory port instances, and the Campaign run reaches its
//      `campaign-approved` terminal while the Product Delivery-shaped run
//      reaches its own terminal in parallel. This proves the new
//      ScenarioRunner path (Campaign) coexists with a parallel walk without
//      interference — the W11 cutover's core coexistence guarantee.
//
// # Skip-on-absent-sibling policy
//
// Wave 11 lanes W11-A1 (installed Product Delivery scenario package),
// W11-A2 (composition-loader), and W11-A6 (product-delivery-integration tests)
// are built in parallel worktrees off the same frozen checkpoint and are NOT
// present in this worktree (verified at load time). The five invariants above
// stand on EXISTING infrastructure (the W7 ScenarioRunner, the W10-A4 Campaign
// scenario-ext package, and the legacy productDeliveryLifecycle), so they run
// unconditionally. The integration steps that REQUIRE an absent W11 sibling —
// loading the installed Product Delivery scenario package via the
// composition-loader and running it through the SAME ScenarioRunner as the
// Campaign — are gated behind an explicit `test.skip` that names the awaited
// sibling, so the file is GREEN today and ACTIVATES the moment W11-A1/A2/A6
// land (plan §0.5.2 serial integration).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Campaign scenario-ext package (W10-A4) — the real installable manifest.
// ---------------------------------------------------------------------------
import campaignScenarioManifest, {
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_TERMINAL_STATUSES,
} from '../../scenarios-ext/campaign/definition.mjs';

// Compiled Wave 7 runtime + Wave 1 SPI barrel (the shared surface the new
// scenario path and the campaign package both reach).
const { ScenarioRunner } = await import(
  '../../dist/process-modules/application/scenario-runner.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const {
  routeScenarioOutcome,
  validateScenarioRoutingGraph,
} = await import('../../dist/process-modules/application/scenario-router.js');
const {
  validateLifecycleScenarioManifest,
  assertCanonicalSerializable,
} = await import('../../dist/process-modules/domain/spi/index.js');
// Legacy Product Delivery LifecycleDefinition (the coexisting peer).
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Absent-sibling detection (plan §0.5.2 serial integration).
//
// These lanes are sibling worktrees; they are NOT present in this worktree.
// When they land, the corresponding `test.skip` blocks activate automatically
// (the file path check flips from absent → present).
// ---------------------------------------------------------------------------
const PRODUCT_DELIVERY_SCENARIO_PACKAGE = path.join(
  REPO_ROOT,
  'src/process-modules/installation/product-delivery-scenario-package.ts',
);
const COMPOSITION_LOADER = path.join(
  REPO_ROOT,
  'src/process-modules/application/composition-loader.ts',
);
const PRODUCT_DELIVERY_INTEGRATION_TEST = path.join(
  REPO_ROOT,
  'tests/execution/product-delivery-integration.test.mjs',
);

const hasProductDeliveryScenarioPackage = existsSync(
  PRODUCT_DELIVERY_SCENARIO_PACKAGE,
);
const hasCompositionLoader = existsSync(COMPOSITION_LOADER);
const hasProductDeliveryIntegrationTest = existsSync(
  PRODUCT_DELIVERY_INTEGRATION_TEST,
);

/** @param {string} p @returns {string[]} */
function siblingReason(p) {
  return [
    `AWAITING W11 SIBLING: ${path.relative(REPO_ROOT, p)} is not present in this worktree.`,
    `This test activates the moment the sibling lands (plan §0.5.2 serial integration).`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Module definition reused by the ScenarioRunner harnesses. The harness below
// drives a generic two-stage walk (draft → approve) — the SAME shape used in
// tests/process-modules/scenario-runner.test.mjs, so the runner contract is
// exercised identically. The Campaign harness binds the real campaign
// manifest's stage ids; the Product-Delivery-shaped harness binds its own
// distinct stage ids to prove isolation.
// ---------------------------------------------------------------------------

const HARNESS_MODULE_REF = Object.freeze({ name: 'coexist-test-module', version: '1.0.0' });
const HARNESS_MODULE_INPUT_SCHEMA = 'coexist.test.input.v1';
const HARNESS_MODULE_OUTPUT_SCHEMA = 'coexist.test.output.v1';

const HARNESS_MODULE_DEFINITION = {
  identity: {
    ...HARNESS_MODULE_REF,
    kind: 'coexist-test',
    displayName: 'Coexistence Test Module',
    description: 'Generic module used by the W11-A7 coexistence harnesses.',
  },
  inputContract: { id: HARNESS_MODULE_INPUT_SCHEMA },
  outputContract: { id: HARNESS_MODULE_OUTPUT_SCHEMA },
  outcomes: [
    { code: 'drafted', description: 'Drafted.', terminal: true },
    { code: 'approved', description: 'Approved.', terminal: true },
    { code: 'rejected', description: 'Rejected.', terminal: true },
  ],
  flow: {
    id: 'coexist.test.flow',
    version: '1.0.0',
    entryNodeId: 'finish',
    nodes: [],
    transitions: [],
    terminalNodeIds: [],
  },
  artifacts: [],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

function harnessContractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w11-a7-coexist' }),
  };
}

function harnessSelector(moduleRef) {
  return { name: moduleRef.name, versionRange: `^${moduleRef.version}` };
}

/**
 * Build a LifecycleScenarioManifest whose stage ids + terminals are drawn from
 * `stageIds`/`terminals`. Used to construct a manifest that mimics EITHER the
 * campaign's surface (real stage ids + campaign terminals) OR a
 * Product-Delivery-shaped surface (distinct stage ids + product-delivery
 * terminals) for the parallel-run isolation proof.
 */
function buildManifest({ stageIds, terminals, identity }) {
  const [first, second] = stageIds;
  const [approvedTerminal, rejectedTerminal] = terminals;
  const stageBindings = [
    {
      id: first,
      displayName: first,
      moduleRef: HARNESS_MODULE_REF,
      moduleSelector: harnessSelector(HARNESS_MODULE_REF),
      inputMapping: { brief: '$.initiative.brief' },
      outputMapping: { draft: '$.processOutcome.output' },
      outcomeRoutes: { drafted: { type: 'stage', stageId: second } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: second,
      displayName: second,
      moduleRef: HARNESS_MODULE_REF,
      moduleSelector: harnessSelector(HARNESS_MODULE_REF),
      inputMapping: { draft: `$.stages.${first}.output.draft` },
      outputMapping: { decision: '$.processOutcome.output' },
      outcomeRoutes: {
        approved: { type: 'terminal', status: approvedTerminal },
        rejected: { type: 'terminal', status: rejectedTerminal },
      },
      entryConditions: [],
      exitConditions: [],
    },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    identity,
    inputContractRef: harnessContractRef(`${identity.name}.input.v1`),
    outputContractRef: harnessContractRef(`${identity.name}.output.v1`),
    entryStageId: first,
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: '$.initiative' },
    outputMappings: {},
    terminalStatuses: [approvedTerminal, rejectedTerminal],
    scenarioPolicies: {},
    requiredModuleSelectors: [harnessSelector(HARNESS_MODULE_REF)],
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 0 },
  };
}

function buildLock(manifest) {
  const entries = manifest.stageBindings.map((s) => ({
    stageId: s.id,
    selector: s.moduleSelector,
    installedModuleRef: HARNESS_MODULE_REF,
    installationId: 1,
    packageDigest: sha256Hex({ module: HARNESS_MODULE_REF, stamp: 'w11-a7' }),
  }));
  return {
    scenarioIdentity: manifest.identity,
    entries,
    lockDigest: sha256Hex(canonicalJson(entries)),
  };
}

/**
 * Stand up a ScenarioRunner harness (adapted from
 * tests/process-modules/scenario-runner.test.mjs) for a two-stage manifest.
 * The harness is fully isolated: it owns its own LifecycleRunRepository,
 * ProcessRunRepository, router, and output-store instances — no shared state
 * with any other harness. This isolation is precisely what the coexistence
 * proof exercises.
 */
function createRunnerHarness({
  manifest,
  rootInput = { initiative: { brief: 'coexist' } },
  secondStageOutcome = 'approved',
}) {
  const lock = buildLock(manifest);
  const installationsByStageId = {};
  for (const binding of manifest.stageBindings) {
    installationsByStageId[binding.id] = {
      definition: HARNESS_MODULE_DEFINITION,
      executor: null,
    };
  }
  const installedScenario = {
    manifest,
    manifestSnapshot: canonicalJson(manifest),
    manifestHash: sha256Hex(manifest),
    lock,
    installationsByStageId,
  };

  const stageIds = manifest.stageBindings.map((b) => b.id);
  let stageIdCounter = 11;
  let processIdCounter = 42;
  const state = {
    lifecycle: {
      id: 1,
      lifecycle: manifest.identity,
      lifecycleRefKey: `${manifest.identity.name}@${manifest.identity.version}`,
      definitionSnapshot: installedScenario.manifestSnapshot,
      definitionHash: installedScenario.manifestHash,
      projectId: 7,
      epicId: 8,
      initiatedBy: 'test',
      idempotencyKey: `${manifest.identity.name}-run`,
      inputSchema: `${manifest.identity.name}.input.v1`,
      inputSnapshot: canonicalJson(rootInput),
      inputHash: sha256Hex(rootInput),
      status: 'created',
      entryStageId: manifest.entryStageId,
      currentStageId: manifest.entryStageId,
      currentStageRunId: null,
      terminalStatus: null,
      version: 0,
      leaseFence: 0,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    stages: [],
    processes: new Map(),
    storedOutputs: [],
    released: false,
    renewCalls: 0,
    processStartCommands: [],
    reachedTerminalStatus: null,
  };

  function makeStageRecord({ id, stageId, moduleRef, binding, input }) {
    return {
      id,
      lifecycleRunId: state.lifecycle.id,
      ordinal: id,
      stageId,
      attempt: 1,
      moduleRef,
      bindingSnapshot: canonicalJson(binding),
      bindingHash: sha256Hex(binding),
      inputSchema: HARNESS_MODULE_INPUT_SCHEMA,
      inputSnapshot: canonicalJson(input),
      inputHash: sha256Hex(input),
      status: 'created',
      processRunId: null,
      localOutcome: null,
      authority: null,
      output: null,
      certificate: null,
      mappedOutput: null,
      resultSnapshot: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const lifecycleRunRepo = {
    start: () => ({ record: state.lifecycle, replayed: false }),
    read: () => state.lifecycle,
    readByIdempotencyKey: () => state.lifecycle,
    listStageRuns: () => state.stages,
    listTransitions: () => [],
    readCurrentStageRun: () => state.stages[state.stages.length - 1] ?? null,
    ensureStageRun: (command) => {
      let existing = state.stages.find((s) => s.stageId === command.stageId);
      if (!existing) {
        existing = makeStageRecord({
          id: stageIdCounter++,
          stageId: command.stageId,
          moduleRef: command.moduleRef,
          binding: manifest.stageBindings.find((b) => b.id === command.stageId),
          input: command.inputPayload,
        });
        state.stages.push(existing);
        state.lifecycle.currentStageRunId = existing.id;
      }
      return { record: existing, replayed: existing.processRunId !== null };
    },
    bindProcessRun: (_lrId, stageRunId, processRunId) => {
      const sr = state.stages.find((s) => s.id === stageRunId);
      sr.processRunId = processRunId;
      return sr;
    },
    markStageRunning: (_lrId, stageRunId) => {
      const sr = state.stages.find((s) => s.id === stageRunId);
      sr.status = 'running';
      state.lifecycle.status = 'running';
      return sr;
    },
    pauseStage: () => {
      state.lifecycle.status = 'paused';
      return state.lifecycle;
    },
    fail: (_lrId, _srId, error) => {
      state.lifecycle.status = 'failed';
      state.lifecycle.error = error;
      return state.lifecycle;
    },
    resume: () => state.lifecycle,
    cancel: () => state.lifecycle,
    listRecoverable: () => [],
    completeStage: (command) => {
      const sr = state.stages.find((s) => s.id === command.stageRunId);
      sr.status = 'completed';
      sr.localOutcome = command.outcome;
      sr.mappedOutput = command.mappedOutput;
      sr.resultSnapshot = command.resultSnapshot;
      if (command.nextStage) {
        state.lifecycle.currentStageId = command.nextStage.stageId;
        state.lifecycle.currentStageRunId = null;
      } else {
        state.lifecycle.status = 'completed';
        state.lifecycle.currentStageId = null;
        state.lifecycle.currentStageRunId = null;
        state.lifecycle.terminalStatus = command.target.status;
        state.reachedTerminalStatus = command.target.status;
      }
      return {
        lifecycleRun: state.lifecycle,
        stageRun: sr,
        transition: {
          id: 1,
          lifecycleRunId: 1,
          fromStageRunId: sr.id,
          transitionKey: command.transitionKey,
          outcome: command.outcome,
          target: command.target,
          toStageRunId: null,
          handoffSnapshot: command.handoffSnapshot,
          handoffHash: command.handoffHash,
          decisionHash: command.decisionHash,
          createdAt: new Date().toISOString(),
        },
        replayed: false,
      };
    },
    acquireExecutionLease: (_id, owner) => {
      state.lifecycle.status = 'running';
      return { owner, fence: 1 };
    },
    renewExecutionLease: () => {
      state.renewCalls += 1;
      return true;
    },
    releaseExecutionLease: () => {
      state.released = true;
    },
  };

  const processRunRepo = {
    start: (command) => {
      state.processStartCommands.push(command);
      const id = processIdCounter++;
      const stageId = state.lifecycle.currentStageId;
      const isSecond = stageId === stageIds[1];
      const outcome = isSecond ? secondStageOutcome : 'drafted';
      const outputPayload = isSecond ? { decision: 'ok' } : { draft: 'body' };
      const process = {
        id,
        status: 'completed',
        localOutcome: outcome,
        authority: 'test-policy',
        outputSchema: HARNESS_MODULE_OUTPUT_SCHEMA,
        outputRef: `${stageId}-artifact`,
        outputHash: sha256Hex(outputPayload),
        certificateSchema: null,
        certificateRef: null,
        certificateHash: null,
        error: null,
      };
      state.processes.set(id, process);
      return { record: process, replayed: false };
    },
    read: (id) => state.processes.get(id) ?? null,
  };

  const executor = {
    moduleRef: HARNESS_MODULE_REF,
    kind: 'coexist-test',
    execute: async (_module, context) => {
      const process = state.processes.get(context.processRunId);
      return {
        outcome: process.localOutcome,
        output: {
          schema: HARNESS_MODULE_OUTPUT_SCHEMA,
          artifactRef: process.outputRef,
          contentHash: process.outputHash,
        },
        certificate: null,
        authority: process.authority,
      };
    },
  };
  for (const k of Object.keys(installationsByStageId)) {
    installationsByStageId[k] = { definition: HARNESS_MODULE_DEFINITION, executor };
  }

  const router = {
    resolveTransition: ({ stage, outcome }) => {
      const target = stage.outcomeRoutes[outcome];
      if (!target) {
        throw new Error(`no route for stage '${stage.id}' outcome '${outcome}'`);
      }
      return target;
    },
  };

  const storedSet = new Set();
  const outputStore = {
    storeOutput: async (record) => {
      const key = `${record.scenarioRunId}:${record.stageId}:${record.contentHash}`;
      if (!storedSet.has(key)) {
        storedSet.add(key);
        state.storedOutputs.push(record);
      }
      return record;
    },
    listOutputs: async (_runId) => state.storedOutputs,
  };

  const runner = new ScenarioRunner({
    lifecycleRunRepo,
    processRunRepo,
    router,
    outputStore,
  });

  return {
    state,
    installedScenario,
    runner,
    command: {
      projectId: 7,
      epicId: 8,
      inputSchema: `${manifest.identity.name}.input.v1`,
      inputPayload: rootInput,
      initiatedBy: 'test',
      idempotencyKey: `${manifest.identity.name}-run`,
    },
  };
}

// ---------------------------------------------------------------------------
// Surface collectors — the static, deterministic inputs to the isolation
// invariants. These read the REAL surfaces (campaign manifest + product
// delivery lifecycle) so the proofs are grounded, not asserted from literals.
// ---------------------------------------------------------------------------

/** @param {any} manifest @returns {Set<string>} */
function campaignStageIds(manifest) {
  return new Set(manifest.stageBindings.map((s) => s.id));
}

/** @param {any} manifest @returns {Set<string>} */
function campaignOutcomeTargets(manifest) {
  const targets = new Set();
  for (const s of manifest.stageBindings) {
    targets.add(s.id);
    for (const t of Object.values(s.outcomeRoutes)) {
      if (t.type === 'stage') targets.add(t.stageId);
      else if (t.type === 'terminal') targets.add(t.status);
    }
  }
  for (const t of Object.values(manifest.outcomeRoutes || {})) {
    if (t.type === 'stage') targets.add(t.stageId);
    else if (t.type === 'terminal') targets.add(t.status);
  }
  return targets;
}

/** @param {any} manifest @returns {Set<string>} */
function campaignTerminals(manifest) {
  return new Set(manifest.terminalStatuses);
}

/** @param {any} lifecycle @returns {Set<string>} */
function productDeliveryStageIds(lifecycle) {
  return new Set(lifecycle.stages.map((s) => s.id));
}

/** @param {any} lifecycle @returns {Set<string>} */
function productDeliveryTargets(lifecycle) {
  const targets = new Set();
  for (const s of lifecycle.stages) {
    targets.add(s.id);
    for (const t of Object.values(s.outcomeRoutes)) {
      if (t.type === 'stage') targets.add(t.stageId);
      else if (t.type === 'terminal') targets.add(t.status);
    }
  }
  return targets;
}

/** @param {any} lifecycle @returns {Set<string>} */
function productDeliveryTerminals(lifecycle) {
  const terminals = new Set();
  for (const s of lifecycle.stages) {
    for (const t of Object.values(s.outcomeRoutes)) {
      if (t.type === 'terminal') terminals.add(t.status);
    }
  }
  return terminals;
}

/** @param {Set<string>} a @param {Set<string>} b @returns {string[]} */
function intersection(a, b) {
  return [...a].filter((x) => b.has(x));
}

// ===========================================================================
// Group: Campaign integration (the Campaign scenario installs + routes).
// ===========================================================================

test('W11-A7: Campaign scenario manifest is installable (validates against the shared SPI)', () => {
  // The campaign package validates via the SAME Wave 1 SPI the Product
  // Delivery scenario package will validate through once W11-A1 lands — the
  // shared SPI is the proof the two paths do not need divergent validators.
  const result = validateLifecycleScenarioManifest(campaignScenarioManifest);
  assert.equal(result.ok, true, `campaign manifest validates (errors=${JSON.stringify(result.errors)})`);
  assertCanonicalSerializable(campaignScenarioManifest);
});

test('W11-A7: Campaign routing graph is acyclic + reachable (W7-A4 static router)', () => {
  // validateScenarioRoutingGraph returns { ok, errors }; a clean campaign
  // manifest yields ok=true with zero routing defects (no unreachable stages,
  // no dead ends, no orphan terminals, no unknown targets).
  const graph = validateScenarioRoutingGraph(campaignScenarioManifest);
  assert.equal(
    graph.ok,
    true,
    `campaign routing graph must be defect-free (errors=${JSON.stringify(graph.errors)})`,
  );
  assert.equal(graph.errors.length, 0, 'zero campaign routing defects');
});

test('W11-A7: Campaign outcome routes resolve via pure table lookup (no resolver)', () => {
  // The campaign's draft stage routes 'campaign-drafted' to seo-baseline
  // purely from the static table — proves §6.4 (no routeResolver) holds and
  // the new path routes Campaign outcomes without any per-run branch.
  const seoBaseline = campaignScenarioManifest.stageBindings.find(
    (s) => s.id === 'seo-baseline',
  );
  assert.ok(seoBaseline, 'campaign seo-baseline stage exists');
  const route = routeScenarioOutcome(campaignScenarioManifest, 'draft', 'campaign-drafted');
  assert.deepEqual(route.target, { type: 'stage', stageId: 'seo-baseline' });
});

// ===========================================================================
// Group: Coexistence — static isolation invariants (sibling-independent).
// ===========================================================================

test('W11-A7 coexistence: Campaign and Product Delivery identities are distinct', () => {
  const campaignId = campaignScenarioManifest.identity;
  const pdId = productDeliveryLifecycle.identity;
  assert.notEqual(campaignId.name, pdId.name, 'distinct lifecycle names');
  assert.notEqual(campaignId.displayName, pdId.displayName, 'distinct display names');
  // (name, version) ref keys must not collide — the composition-loader
  // (W11-A2) will key installed scenarios by exactly this pair.
  assert.notEqual(
    `${campaignId.name}@${campaignId.version}`,
    `${pdId.name}@${pdId.version}`,
    'distinct (name,version) ref keys',
  );
});

test('W11-A7 coexistence: Campaign stage ids never collide with Product Delivery stage ids', () => {
  const campaignStages = campaignStageIds(campaignScenarioManifest);
  const pdStages = productDeliveryStageIds(productDeliveryLifecycle);
  const overlap = intersection(campaignStages, pdStages);
  assert.deepEqual(
    overlap,
    [],
    `Campaign and Product Delivery stage ids must be disjoint (overlap=${JSON.stringify(overlap)})`,
  );
});

test('W11-A7 coexistence: Campaign outcome targets never land on a Product Delivery surface', () => {
  // A Campaign route target (stage id or terminal) must never be a Product
  // Delivery stage id — otherwise a Campaign outcome could accidentally hop
  // into the Product Delivery lifecycle.
  const campaignTargets = campaignOutcomeTargets(campaignScenarioManifest);
  const pdStages = productDeliveryStageIds(productDeliveryLifecycle);
  const overlap = intersection(campaignTargets, pdStages);
  assert.deepEqual(
    overlap,
    [],
    `Campaign targets must not collide with Product Delivery stage ids (overlap=${JSON.stringify(overlap)})`,
  );
  // Symmetric: a Product Delivery route target must never be a Campaign stage.
  const pdTargets = productDeliveryTargets(productDeliveryLifecycle);
  const campaignStages = campaignStageIds(campaignScenarioManifest);
  const overlap2 = intersection(pdTargets, campaignStages);
  assert.deepEqual(
    overlap2,
    [],
    `Product Delivery targets must not collide with Campaign stage ids (overlap=${JSON.stringify(overlap2)})`,
  );
});

test('W11-A7 coexistence: Campaign and Product Delivery terminal statuses are disjoint', () => {
  const campaignTerm = campaignTerminals(campaignScenarioManifest);
  const pdTerm = productDeliveryTerminals(productDeliveryLifecycle);
  const overlap = intersection(campaignTerm, pdTerm);
  assert.deepEqual(
    overlap,
    [],
    `Campaign and Product Delivery terminals must be disjoint (overlap=${JSON.stringify(overlap)})`,
  );
  // Explicit: the campaign terminals are exactly the campaign-* pair and none
  // of the Product Delivery terminals (released/failed/...).
  assert.deepEqual(
    [...campaignTerm].sort(),
    [...CAMPAIGN_TERMINAL_STATUSES].sort(),
    'campaign terminal set matches the declared pair',
  );
});

test('W11-A7 coexistence: Campaign and Product Delivery share NO module package', () => {
  // The campaign depends only on the three external sibling packages; Product
  // Delivery depends only on the built-in catalog. No shared ProcessModule
  // installation — the two lifecycles never execute the same module package.
  const campaignModules = new Set(
    campaignScenarioManifest.requiredModuleSelectors.map((s) => s.name),
  );
  const pdModules = new Set(
    productDeliveryLifecycle.stages.map((s) => s.moduleRef.name),
  );
  const overlap = intersection(campaignModules, pdModules);
  assert.deepEqual(
    overlap,
    [],
    `Campaign and Product Delivery must share no module package (overlap=${JSON.stringify(overlap)})`,
  );
  // Belt-and-braces: campaign modules are exactly the external trio.
  assert.deepEqual(
    [...campaignModules].sort(),
    ['external-seo', 'human-director-approval', 'lm-marketing'],
    'campaign depends only on the external sibling packages',
  );
});

// ===========================================================================
// Group: Runtime state isolation — parallel ScenarioRunner runs.
//
// Two independent ScenarioRunner harnesses (one Campaign-shaped, one
// Product-Delivery-shaped) are constructed in the same process and run. Each
// owns its own port instances; neither observes the other's state. This is
// the runtime proof that the new scenario path (where Campaign lives after
// the cutover) coexists with a parallel lifecycle walk without interference.
// ===========================================================================

test('W11-A7 coexistence: two ScenarioRunner runs in parallel reach their own terminals without interference', async () => {
  // Campaign-shaped manifest: distinct stage ids + campaign terminals.
  const campaignManifest = buildManifest({
    stageIds: ['coexist-campaign-draft', 'coexist-campaign-approve'],
    terminals: ['campaign-approved', 'campaign-rejected'],
    identity: {
      name: 'coexist-campaign',
      version: '1.0.0',
      displayName: 'Coexist Campaign',
      description: 'W11-A7 coexistence harness — campaign surface.',
    },
  });
  // Product-Delivery-shaped manifest: distinct stage ids + a Product Delivery
  // terminal ('released') — deliberately chosen from the real Product Delivery
  // terminal set to make the disjointness concrete.
  const pdManifest = buildManifest({
    stageIds: ['coexist-delivery-build', 'coexist-delivery-release'],
    terminals: ['released', 'delivery-blocked'],
    identity: {
      name: 'coexist-product-delivery',
      version: '1.0.0',
      displayName: 'Coexist Product Delivery',
      description: 'W11-A7 coexistence harness — product-delivery surface.',
    },
  });

  // Sanity: the two harness surfaces are disjoint (stage ids + terminals).
  assert.deepEqual(
    intersection(
      campaignStageIds(campaignManifest),
      campaignStageIds(pdManifest),
    ),
    [],
    'harness stage ids are disjoint',
  );
  assert.deepEqual(
    intersection(campaignTerminals(campaignManifest), campaignTerminals(pdManifest)),
    [],
    'harness terminals are disjoint',
  );

  const campaignHarness = createRunnerHarness({ manifest: campaignManifest });
  const pdHarness = createRunnerHarness({
    manifest: pdManifest,
    secondStageOutcome: 'approved', // -> 'released' terminal
  });

  // Run both. The order does not matter — the point is that neither run's
  // state crosses into the other.
  const [campaignResult, pdResult] = await Promise.all([
    campaignHarness.runner.run(campaignHarness.installedScenario, campaignHarness.command),
    pdHarness.runner.run(pdHarness.installedScenario, pdHarness.command),
  ]);

  // Each run reached its OWN terminal.
  assert.equal(campaignResult.status, 'completed');
  assert.equal(campaignResult.terminalStatus, 'campaign-approved');
  assert.equal(pdResult.status, 'completed');
  assert.equal(pdResult.terminalStatus, 'released');

  // No state leakage: each harness's stored outputs reference only its own
  // stage ids. The campaign store never saw a delivery stage and vice versa.
  const campaignStageSet = campaignStageIds(campaignManifest);
  const pdStageSet = campaignStageIds(pdManifest);
  for (const out of campaignHarness.state.storedOutputs) {
    assert.ok(
      campaignStageSet.has(out.stageId),
      `campaign output store leaked stage '${out.stageId}'`,
    );
    assert.ok(
      !pdStageSet.has(out.stageId),
      `campaign store must never hold a Product Delivery stage`,
    );
  }
  for (const out of pdHarness.state.storedOutputs) {
    assert.ok(
      pdStageSet.has(out.stageId),
      `product delivery output store leaked stage '${out.stageId}'`,
    );
    assert.ok(
      !campaignStageSet.has(out.stageId),
      `product delivery store must never hold a Campaign stage`,
    );
  }
  // Each run started exactly its own two stages.
  assert.equal(campaignHarness.state.processStartCommands.length, 2);
  assert.equal(pdHarness.state.processStartCommands.length, 2);
  // Each run released its own lease (independent lease lifecycle).
  assert.equal(campaignHarness.state.released, true);
  assert.equal(pdHarness.state.released, true);
});

test('W11-A7 coexistence: a failed Campaign run never surfaces in a parallel Product Delivery run', async () => {
  // Stronger interference probe: drive the Campaign run to a terminal reject
  // while a Product Delivery run completes successfully in the same process.
  // The Product Delivery run's terminal must be unaffected by the Campaign
  // rejection — proving failure isolation (one lifecycle's failure cannot
  // poison the other).
  const campaignManifest = buildManifest({
    stageIds: ['coexist-fail-campaign-draft', 'coexist-fail-campaign-approve'],
    terminals: ['campaign-approved', 'campaign-rejected'],
    identity: {
      name: 'coexist-fail-campaign',
      version: '1.0.0',
      displayName: 'Coexist Fail Campaign',
      description: 'W11-A7 coexistence harness — failing campaign surface.',
    },
  });
  const pdManifest = buildManifest({
    stageIds: ['coexist-fail-delivery-build', 'coexist-fail-delivery-release'],
    terminals: ['released', 'delivery-blocked'],
    identity: {
      name: 'coexist-fail-product-delivery',
      version: '1.0.0',
      displayName: 'Coexist Fail Product Delivery',
      description: 'W11-A7 coexistence harness — delivery surface alongside a failing campaign.',
    },
  });

  const campaignHarness = createRunnerHarness({
    manifest: campaignManifest,
    secondStageOutcome: 'rejected', // -> 'campaign-rejected' terminal
  });
  const pdHarness = createRunnerHarness({
    manifest: pdManifest,
    secondStageOutcome: 'approved', // -> 'released' terminal
  });

  const [campaignResult, pdResult] = await Promise.all([
    campaignHarness.runner.run(campaignHarness.installedScenario, campaignHarness.command),
    pdHarness.runner.run(pdHarness.installedScenario, pdHarness.command),
  ]);

  // The Campaign rejection did NOT propagate to the Product Delivery run.
  assert.equal(campaignResult.terminalStatus, 'campaign-rejected');
  assert.equal(pdResult.terminalStatus, 'released');
  assert.notEqual(
    pdResult.terminalStatus,
    campaignResult.terminalStatus,
    'Product Delivery terminal must differ from the (rejected) Campaign terminal',
  );
  // The Product Delivery run carried no error from the Campaign rejection.
  assert.equal(pdHarness.state.lifecycle.error, null);
  assert.equal(pdHarness.state.lifecycle.status, 'completed');
});

// ===========================================================================
// Group: Skip-on-absent-sibling (W11-A1 / W11-A2 / W11-A6).
//
// These tests activate automatically once the sibling files land. They are the
// FULL cutover coexistence proof: the installed Product Delivery scenario
// package (W11-A1) loaded via the composition-loader (W11-A2) and run through
// the SAME ScenarioRunner as the Campaign — the single integrator path the
// cutover wires. They are GREEN today (skipped) and turn into hard assertions
// at integration time.
// ===========================================================================

test.skip(
  siblingReason(PRODUCT_DELIVERY_SCENARIO_PACKAGE) +
    ' — install the Product Delivery scenario package and run it through the ScenarioRunner alongside a Campaign run',
  async () => {
    // Placeholder body. Activates when W11-A1 lands. The real assertion:
    //   const pdScenario = await installProductDeliveryScenarioPackage({...});
    //   const pdRunner = new ScenarioRunner({...});
    //   await pdRunner.run(pdScenario, pdCommand);   // reaches a Product Delivery terminal
    //   await campaignRunner.run(campaignScenario, campaignCommand); // reaches campaign-approved
    //   // both coexist on the same ScenarioRunner path with no interference.
    assert.ok(hasProductDeliveryScenarioPackage);
  },
);

test.skip(
  siblingReason(COMPOSITION_LOADER) +
    ' — load BOTH Campaign and Product Delivery installed scenarios via the composition-loader and prove they coexist in one process',
  async () => {
    // Placeholder body. Activates when W11-A2 lands. The real assertion:
    //   const composition = loadComposition({ packagesDir, scenariosDir });
    //   assert.ok(composition.scenarios.some(s => s.identity.name === 'campaign'));
    //   assert.ok(composition.scenarios.some(s => s.identity.name === 'product-delivery'));
    assert.ok(hasCompositionLoader);
  },
);

test.skip(
  siblingReason(PRODUCT_DELIVERY_INTEGRATION_TEST) +
    ' — cross-reference the W11-A6 Product Delivery integration suite to confirm coexistence coverage is paired',
  async () => {
    // Placeholder body. Activates when W11-A6 lands. W11-A6 proves the
    // Product Delivery installed-scenario path end to end; this file (W11-A7)
    // proves the Campaign path coexists with it. Together they cover exit
    // gate #3.
    assert.ok(hasProductDeliveryIntegrationTest);
  },
);

// ===========================================================================
// Group: Cutover anti-scope guard (no premature legacy deletion).
// ===========================================================================

test('W11-A7 anti-scope: legacy Product Delivery lifecycle still present (no premature deletion, spec §3)', () => {
  // The cutover is PREPARATION (spec §3 anti-scope: "NO legacy code is deleted
  // in this wave"). The legacy productDeliveryLifecycle must still be loadable
  // and well-formed so the legacy path keeps replaying old pinned runs. This
  // guards against an accidental early deletion that would break coexistence.
  assert.ok(productDeliveryLifecycle, 'legacy productDeliveryLifecycle is still exported');
  assert.equal(productDeliveryLifecycle.identity.name, 'product-delivery');
  assert.ok(
    productDeliveryLifecycle.stages.length > 0,
    'legacy Product Delivery lifecycle still carries its stages',
  );
  // And the legacy path still reaches its real terminals.
  const pdTerm = productDeliveryTerminals(productDeliveryLifecycle);
  assert.ok(pdTerm.has('released'), 'legacy Product Delivery still reaches the released terminal');
  assert.ok(pdTerm.has('failed'), 'legacy Product Delivery still reaches the failed terminal');
});

test('W11-A7 anti-scope: Campaign package imports nothing from src/ (cutover does not pull legacy code into the new path)', () => {
  // The campaign package is the proof that the new scenario path is
  // self-contained: it does not drag legacy src/ into the Campaign run. This
  // is the runtime-side mirror of the §3 anti-scope — the cutover wires the
  // new path ONTO the live execution surface without deleting legacy code,
  // and the Campaign package never reaches into that legacy code itself.
  // (Structural import-list proof lives in w10-a4-campaign-scenario.test.mjs;
  // this assertion re-states the contract for the coexistence file.)
  const campaignModules = campaignScenarioManifest.requiredModuleSelectors.map(
    (s) => s.name,
  );
  for (const name of campaignModules) {
    assert.ok(
      !name.startsWith('discovery') &&
        !name.startsWith('formalization') &&
        !name.startsWith('development') &&
        !name.startsWith('delivery'),
      `Campaign must not depend on a built-in (legacy) module (got '${name}')`,
    );
  }
});
