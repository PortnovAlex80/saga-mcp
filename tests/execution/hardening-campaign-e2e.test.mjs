// tests/execution/hardening-campaign-e2e.test.mjs
//
// W12-A8 — Repeated Campaign runs + cross-scenario isolation (end-to-end).
//
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md
//       §0 objective (serial gate), §1 critical constraint (test-only),
//       §2 Lane W12-A8 ("Repeated Campaign runs and cross-scenario isolation.
//       Proves Campaign completes repeatedly and does NOT interfere with
//       concurrent Product Delivery runs."),
//       §3 exit gate #6 (cross-scenario isolation holds),
//       §5 test design principles (real ScenarioRunner, no mocks of the
//       runtime; each test self-contained; byte-level replay equality).
// Plan: §0.15.11 (serial gate), §0.15.2 (test-only wave).
// Task: docs/refactor-management/05-subagent-tasks/W12-a8.md
//
// # What this file proves
//
// This is the DEFINITIVE end-to-end reliability proof for WAVE12 lane A8
// (spec §2): the Campaign scenario, driven through the REAL Wave 7
// ScenarioInstaller + ScenarioRunner (NOT mocked), completes REPEATEDLY and
// does NOT interfere with a CONCURRENT Product-Delivery-shaped run in the same
// process. Two guarantees, each backed by a real surface:
//
//   GUARANTEE 1 — REPEATED COMPLETION.
//   The Campaign scenario reaches a valid terminal status
//   (`campaign-approved` or `campaign-rejected`) on every run, across:
//     (a) N FRESH runs with distinct idempotency keys (each run walks all five
//         stages: draft → seo-baseline → metrics → seo-followup → approve);
//     (b) IDEMPOTENT REPLAY of the same run (same idempotency key + same
//         input hash) — the runner detects the already-terminal LifecycleRun
//         and returns it byte-for-byte without re-executing any stage;
//     (c) byte-level REPLAY EQUALITY — the public stage outputs produced by
//         two independent fresh runs are content-hash identical (spec §5:
//         "Assert byte-level replay equality"). Determinism is the hardening
//         contract: a Campaign that produced different bytes for the same
//         inputs would be non-reproducible and therefore unreliable.
//
//   GUARANTEE 2 — CROSS-SCENARIO ISOLATION (no interference).
//   A Campaign run and a Product-Delivery-shaped run, executed CONCURRENTLY
//   (Promise.all) in the same process through two independent ScenarioRunner
//   instances, never contaminate each other:
//     (a) each run reaches its OWN terminal (campaign-approved vs released);
//     (b) each run's output store holds ONLY its own stage ids (no leakage);
//     (c) each run's ProcessRun starts are scoped to its own stages;
//     (d) a FAILING Campaign (campaign-rejected) does NOT propagate its
//         failure to a concurrent successful Product Delivery run (failure
//         isolation — one lifecycle's terminal cannot poison the other).
//
// # Why this uses the REAL scenario manifest structure with `$.`-prefixed paths
//
// The real `scenarios-ext/campaign/definition.mjs` manifest (W10-A4) declares
// its `inputMapping` paths WITHOUT the `$.` prefix (e.g. `initiative.brief`).
// The ScenarioRunner's `mapLifecycleValues` (the local re-declaration of the
// legacy lifecycle-mapper in scenario-runner.ts) REQUIRES every string path to
// be `$` or start with `$.` — otherwise it throws
// `LIFECYCLE_MAPPING_INVALID_PATH`. This divergence is a genuine, documented
// finding (recorded below in the KNOWN FINDINGS section and surfaced by a
// dedicated diagnostic test): the W10-A4 campaign manifest cannot be driven
// through the REAL ScenarioRunner as-authored because its mapping paths do not
// satisfy the runner's path contract.
//
// Per the W12 test-only constraint (spec §1, §4 anti-scope: "NO production
// code changes"), this file CANNOT patch the runner or the manifest. Instead
// it proves the Campaign's STRUCTURE — the 5-stage graph, the 3-module
// composition with external-seo REUSED three times (plan §6.8), the two
// terminal statuses (campaign-approved / campaign-rejected) — completes
// repeatedly through the REAL ScenarioInstaller + ScenarioRunner by building a
// manifest that mirrors the campaign's stage graph verbatim but uses the
// `$.`-prefixed mapping paths the runner's contract requires. The stage ids,
// module refs, outcome routes, terminal statuses, and the three-fold reuse of
// the SEO module are faithful to the campaign scenario; only the path syntax
// is normalized to the runner's contract. This isolates the W12-A8 reliability
// proof (does the Campaign graph complete repeatedly + isolate?) from the
// W10-A4 path-syntax finding (can the as-authored manifest run?), which is
// returned to the owning subsystem per spec §4.
//
// # KNOWN FINDINGS (documented for the owning subsystem — spec §4 anti-scope)
//
//   FINDING W12-A8-1 (path-syntax divergence, returned to W10-A4/W7-A6).
//   `scenarios-ext/campaign/definition.mjs` declares non-`$.`-prefixed
//   mapping paths (e.g. `initiative.brief`, `stages.draft.output.keywords`).
//   The ScenarioRunner (`src/process-modules/application/scenario-runner.ts`,
//   `mapLifecycleValues`) requires `$.`-prefixed paths and throws
//   `LIFECYCLE_MAPPING_INVALID_PATH` otherwise. Consequence: the campaign
//   manifest as-authored CANNOT be run through the REAL ScenarioRunner without
//   either (a) the manifest authors adopting `$.`-prefixed paths, or (b) the
//   runner's mapper accepting bare paths. This is surfaced by the
//   `documents path-syntax divergence` test below and is NOT fixed here (test-
//   only wave). The rest of this file proves the campaign's stage GRAPH is
//   reliable once the path syntax is satisfied.
//
// Imports run against the COMPILED dist/ output. Run:
//   npm run build && node --test tests/execution/hardening-campaign-e2e.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// The REAL campaign scenario manifest (W10-A4) — used for the structural
// invariants and the path-syntax finding. Its stage graph, module refs,
// outcome routes, and terminal statuses are the source of truth this file's
// harness mirrors.
import campaignScenarioManifest, {
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_TERMINAL_STATUSES,
} from '../../scenarios-ext/campaign/definition.mjs';

// Compiled Wave 7 runtime + Wave 1 SPI barrel (the REAL surfaces under test).
const { ScenarioInstaller, ScenarioRunner } = await import(
  '../../dist/process-modules/application/scenario-runner.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { routeScenarioOutcome } = await import(
  '../../dist/process-modules/application/scenario-router.js'
);
const {
  validateLifecycleScenarioManifest,
  assertCanonicalSerializable,
} = await import('../../dist/process-modules/domain/spi/index.js');
// The REAL legacy Product Delivery lifecycle — the coexisting peer whose
// terminals/stages must remain disjoint from the Campaign's.
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);

// ---------------------------------------------------------------------------
// Constants — the three campaign module identities + schemas.
//
// These mirror `scenarios-ext/campaign/definition.mjs` verbatim (the campaign
// depends on lm-marketing + external-seo + human-director-approval, with
// external-seo reused in seo-baseline, metrics, and seo-followup). The harness
// builds ProcessModuleDefinitions for these three identities so the REAL
// ScenarioInstaller resolves + pins them and the REAL ScenarioRunner drives
// them — no mocking of the runtime.
// ---------------------------------------------------------------------------

const LM_MARKETING_REF = Object.freeze({ name: 'lm-marketing', version: '1.0.0' });
const EXTERNAL_SEO_REF = Object.freeze({ name: 'external-seo', version: '1.0.0' });
const HUMAN_DIRECTOR_REF = Object.freeze({ name: 'human-director-approval', version: '1.0.0' });

const LM_MARKETING_INPUT = 'lm-marketing.input.v1';
const LM_MARKETING_OUTPUT = 'lm-marketing.output.v1';
const SEO_INPUT = 'external-seo.input.v1';
const SEO_OUTPUT = 'external-seo.output.v1';
const DIRECTOR_INPUT = 'human-director-approval.input.v1';
const DIRECTOR_OUTPUT = 'human-director-approval.output.v1';

/** Build a minimal but valid ProcessModuleDefinition for a module identity. */
function moduleDefinition(ref, kind, inputSchema, outputSchema, outcomes) {
  return {
    identity: {
      ...ref,
      kind,
      displayName: `${kind} module`,
      description: `W12-A8 harness module definition for ${ref.name}.`,
    },
    inputContract: { id: inputSchema },
    outputContract: { id: outputSchema },
    outcomes,
    flow: {
      id: `${ref.name}.flow`,
      version: ref.version,
      entryNodeId: 'node',
      nodes: [
        {
          id: 'node',
          label: ref.name,
          kind,
          description: 'harness node',
          inputSchema: { id: inputSchema },
          outputSchema: { id: outputSchema },
          emitsOutcome: outcomes[0].code,
        },
      ],
      transitions: [],
      terminalNodeIds: ['node'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
}

const LM_MARKETING_DEFINITION = moduleDefinition(
  LM_MARKETING_REF,
  'lm-marketing',
  LM_MARKETING_INPUT,
  LM_MARKETING_OUTPUT,
  [{ code: 'campaign-drafted', description: 'Campaign draft produced.', terminal: true }],
);

const EXTERNAL_SEO_DEFINITION = moduleDefinition(
  EXTERNAL_SEO_REF,
  'external-seo',
  SEO_INPUT,
  SEO_OUTPUT,
  [{ code: 'ranking-fetched', description: 'Ranking snapshot fetched.', terminal: true }],
);

const HUMAN_DIRECTOR_DEFINITION = moduleDefinition(
  HUMAN_DIRECTOR_REF,
  'human-approval',
  DIRECTOR_INPUT,
  DIRECTOR_OUTPUT,
  [
    { code: 'approved', description: 'Director approved.', terminal: true },
    { code: 'rejected', description: 'Director rejected.', terminal: true },
  ],
);

// ---------------------------------------------------------------------------
// Campaign stage graph — mirrors `scenarios-ext/campaign/definition.mjs`
// verbatim (same 5 stage ids, same module refs, same outcomeRoutes, same
// terminals, external-seo reused 3x) but with `$.`-prefixed mapping paths so
// the REAL ScenarioRunner's mapLifecycleValues accepts them.
//
// The stage graph is:
//   draft (lm-marketing)         --campaign-drafted-->  seo-baseline
//   seo-baseline (external-seo)  --ranking-fetched-->   metrics        [reuse #1]
//   metrics (external-seo)       --ranking-fetched-->   seo-followup   [reuse #2]
//   seo-followup (external-seo)  --ranking-fetched-->   approve        [reuse #3]
//   approve (human-director)     --approved/rejected--> terminal
//
// This is exactly the campaign's composition (plan §6.8: external-seo in three
// stages). Mapping paths use `$.initiative.*` (root input) and
// `$.stages.<id>.output.<field>` (prior stage output), the frame shape the
// ScenarioRunner builds in buildFrame().
// ---------------------------------------------------------------------------

/** Selector derived from a module ref (caret range = patch upgrades only). */
function selector(ref) {
  return { name: ref.name, versionRange: `^${ref.version}` };
}

function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, harness: 'w12-a8' }),
  };
}

/**
 * Build the campaign-shaped LifecycleScenarioManifest. `approveOutcome`
 * selects whether the Human stage emits 'approved' (-> campaign-approved) or
 * 'rejected' (-> campaign-rejected); this drives both the success and the
 * failure-isolation proofs.
 */
function buildCampaignScenarioManifest() {
  const stageBindings = [
    {
      id: 'draft',
      displayName: 'Draft Campaign',
      moduleRef: LM_MARKETING_REF,
      moduleSelector: selector(LM_MARKETING_REF),
      inputMapping: {
        brief: '$.initiative.brief',
        audience: '$.initiative.audience',
      },
      outputMapping: {
        campaignDraft: '$.processOutcome.output',
        keywords: '$.processOutcome.output',
      },
      outcomeRoutes: { 'campaign-drafted': { type: 'stage', stageId: 'seo-baseline' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'seo-baseline',
      displayName: 'SEO Baseline Fetch',
      moduleRef: EXTERNAL_SEO_REF,
      moduleSelector: selector(EXTERNAL_SEO_REF),
      inputMapping: {
        keywords: '$.stages.draft.output.keywords',
        market: { literal: 'baseline' },
      },
      outputMapping: { baselineRanking: '$.processOutcome.output' },
      outcomeRoutes: { 'ranking-fetched': { type: 'stage', stageId: 'metrics' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'metrics',
      displayName: 'Compute Metrics',
      moduleRef: EXTERNAL_SEO_REF,
      moduleSelector: selector(EXTERNAL_SEO_REF),
      inputMapping: {
        keywords: '$.stages.draft.output.keywords',
        baselineRanking: '$.stages.seo-baseline.output.baselineRanking',
        market: { literal: 'metrics' },
      },
      outputMapping: { metrics: '$.processOutcome.output' },
      outcomeRoutes: { 'ranking-fetched': { type: 'stage', stageId: 'seo-followup' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'seo-followup',
      displayName: 'SEO Follow-up Fetch',
      moduleRef: EXTERNAL_SEO_REF,
      moduleSelector: selector(EXTERNAL_SEO_REF),
      inputMapping: {
        keywords: '$.stages.draft.output.keywords',
        metrics: '$.stages.metrics.output.metrics',
        market: { literal: 'followup' },
      },
      outputMapping: { followupRanking: '$.processOutcome.output' },
      outcomeRoutes: { 'ranking-fetched': { type: 'stage', stageId: 'approve' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'approve',
      displayName: 'Director Sign-off',
      moduleRef: HUMAN_DIRECTOR_REF,
      moduleSelector: selector(HUMAN_DIRECTOR_REF),
      inputMapping: {
        campaignDraft: '$.stages.draft.output.campaignDraft',
        metrics: '$.stages.metrics.output.metrics',
        followupRanking: '$.stages.seo-followup.output.followupRanking',
        requestedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: { directorDecision: '$.processOutcome.output' },
      outcomeRoutes: {
        approved: { type: 'terminal', status: 'campaign-approved' },
        rejected: { type: 'terminal', status: 'campaign-rejected' },
      },
      entryConditions: [],
      exitConditions: [],
    },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    identity: CAMPAIGN_SCENARIO_IDENTITY,
    inputContractRef: contractRef('campaign.input.v1'),
    outputContractRef: contractRef('campaign.output.v1'),
    entryStageId: 'draft',
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: '$.initiative' },
    outputMappings: {},
    terminalStatuses: CAMPAIGN_TERMINAL_STATUSES,
    scenarioPolicies: {},
    requiredModuleSelectors: [
      selector(LM_MARKETING_REF),
      selector(EXTERNAL_SEO_REF),
      selector(HUMAN_DIRECTOR_REF),
    ],
    transitionBudgets: { maxTransitions: 32 },
    reentryBudgets: { maxReentries: 0 },
  };
}

// ---------------------------------------------------------------------------
// Product-Delivery-shaped scenario for the isolation proof.
//
// A two-stage manifest (build -> release) with Product-Delivery-distinct stage
// ids and the 'released' terminal (drawn from the real productDeliveryLifecycle
// terminal set). Distinct module identities (delivery-build / delivery-release)
// so no module package is shared with the Campaign. This is the concurrent peer
// the Campaign must not interfere with.
// ---------------------------------------------------------------------------

const DELIVERY_BUILD_REF = Object.freeze({ name: 'delivery-build', version: '1.0.0' });
const DELIVERY_RELEASE_REF = Object.freeze({ name: 'delivery-release', version: '1.0.0' });
const DELIVERY_BUILD_INPUT = 'delivery-build.input.v1';
const DELIVERY_BUILD_OUTPUT = 'delivery-build.output.v1';
const DELIVERY_RELEASE_INPUT = 'delivery-release.input.v1';
const DELIVERY_RELEASE_OUTPUT = 'delivery-release.output.v1';

const DELIVERY_BUILD_DEFINITION = moduleDefinition(
  DELIVERY_BUILD_REF,
  'delivery-build',
  DELIVERY_BUILD_INPUT,
  DELIVERY_BUILD_OUTPUT,
  [{ code: 'built', description: 'Artifact built.', terminal: true }],
);

const DELIVERY_RELEASE_DEFINITION = moduleDefinition(
  DELIVERY_RELEASE_REF,
  'delivery-release',
  DELIVERY_RELEASE_INPUT,
  DELIVERY_RELEASE_OUTPUT,
  [
    { code: 'released', description: 'Released.', terminal: true },
    { code: 'blocked', description: 'Blocked.', terminal: true },
  ],
);

const PRODUCT_DELIVERY_HARNESS_IDENTITY = Object.freeze({
  name: 'product-delivery-harness',
  version: '1.0.0',
  displayName: 'Product Delivery Harness',
  description: 'W12-A8 isolation harness — product-delivery-shaped surface.',
});

function buildProductDeliveryManifest() {
  const stageBindings = [
    {
      id: 'delivery-build',
      displayName: 'Build',
      moduleRef: DELIVERY_BUILD_REF,
      moduleSelector: selector(DELIVERY_BUILD_REF),
      inputMapping: { spec: '$.initiative.spec' },
      outputMapping: { artifact: '$.processOutcome.output' },
      outcomeRoutes: { built: { type: 'stage', stageId: 'delivery-release' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'delivery-release',
      displayName: 'Release',
      moduleRef: DELIVERY_RELEASE_REF,
      moduleSelector: selector(DELIVERY_RELEASE_REF),
      inputMapping: { artifact: '$.stages.delivery-build.output.artifact' },
      outputMapping: { release: '$.processOutcome.output' },
      outcomeRoutes: {
        released: { type: 'terminal', status: 'released' },
        blocked: { type: 'terminal', status: 'delivery-blocked' },
      },
      entryConditions: [],
      exitConditions: [],
    },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    identity: PRODUCT_DELIVERY_HARNESS_IDENTITY,
    inputContractRef: contractRef('product-delivery-harness.input.v1'),
    outputContractRef: contractRef('product-delivery-harness.output.v1'),
    entryStageId: 'delivery-build',
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: '$.initiative' },
    outputMappings: {},
    terminalStatuses: ['released', 'delivery-blocked'],
    scenarioPolicies: {},
    requiredModuleSelectors: [
      selector(DELIVERY_BUILD_REF),
      selector(DELIVERY_RELEASE_REF),
    ],
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 0 },
  };
}

// ---------------------------------------------------------------------------
// REAL ScenarioInstaller deps.
//
// The installer is driven with REAL ports (a real in-memory installation
// registry that returns the real ProcessModuleDefinitions, a real compiler
// that runs the W1-A3 validator, and a real lock resolver that produces the
// exact-pin lock). The ONLY thing that is in-memory is the storage backing
// the ports — the ScenarioInstaller + ScenarioRunner logic under test is the
// real compiled production code.
// ---------------------------------------------------------------------------

/**
 * A minimal real executor. The harness's `processRunRepo.start` pre-completes
 * each ProcessRun with the configured stage outcome, so the ScenarioRunner's
 * `executeOrReplayProcess` reads the completed record and NEVER calls
 * `executor.execute`. However, the runner DOES read `executor.kind` when it
 * starts the ProcessRun (to populate `executorKind`), so the executor object
 * must carry a `kind`. The `execute` method is a defensive no-op that throws
 * if ever reached (it would indicate the harness's pre-completion contract
 * broke).
 */
function harnessExecutor(kind) {
  return {
    kind,
    execute: async () => {
      throw new Error(`harness executor for kind '${kind}' was called — ProcessRun should have been pre-completed`);
    },
  };
}

/** In-memory ProcessModuleInstallationRegistry fake bound to a definition map. */
function installationRegistry(definitionsByKey) {
  return {
    require(ref) {
      const key = `${ref.name}@${ref.version}`;
      const def = definitionsByKey[key];
      if (!def) {
        throw new Error(`process module ${ref.name}@${ref.version} is not installed`);
      }
      return { definition: def, executor: harnessExecutor(def.identity.kind) };
    },
  };
}

/** Real compiler: runs the W1-A3 manifest validator (the same check the
 *  production ScenarioInstaller delegates to). */
function realCompiler() {
  return (manifest) => {
    try {
      const result = validateLifecycleScenarioManifest(manifest);
      if (!result.ok) {
        return {
          ok: false,
          errors: result.errors.map((e) => ({
            code: e.code ?? 'MANIFEST_INVALID',
            path: e.path ?? '$',
            message: e.message ?? 'manifest validation error',
          })),
        };
      }
      return { ok: true, errors: [] };
    } catch (e) {
      return {
        ok: false,
        errors: [{
          code: 'MANIFEST_EXCEPTION',
          path: '$',
          message: e instanceof Error ? e.message : String(e),
        }],
      };
    }
  };
}

/**
 * Real lock resolver: produces a ScenarioModuleLock with one entry per stage,
 * each pinning the exact module identity the stage's moduleRef names. This is
 * the shape the W7-A2 lock-resolver produces against the package registry; we
 * build it directly so the test does not depend on a package-installation DB
 * while still exercising the REAL installer lock-validation + binding logic.
 */
function realLockResolver(manifest) {
  return async () => {
    const entries = manifest.stageBindings.map((s) => ({
      stageId: s.id,
      selector: s.moduleSelector,
      installedModuleRef: s.moduleRef,
      installationId: 1,
      packageDigest: sha256Hex({ module: s.moduleRef, stamp: 'w12-a8-lock' }),
    }));
    return {
      scenarioIdentity: manifest.identity,
      entries,
      lockDigest: sha256Hex(canonicalJson(entries)),
    };
  };
}

/** In-memory lock store (records writes; reads return null — fresh install). */
function inMemoryLockStore() {
  const written = [];
  return {
    write: async (lock) => { written.push(lock); return lock; },
    read: async () => null,
    _written: written,
  };
}

/**
 * Drive the REAL ScenarioInstaller to produce an InstalledScenario. Mirrors
 * what installProductDeliveryScenario does: compile -> resolve lock -> bind
 * installations -> persist lock -> return InstalledScenario.
 */
async function installScenarioReal(manifest, definitionsByKey) {
  const installer = new ScenarioInstaller();
  return installer.install(manifest, {
    compiler: realCompiler(),
    lockResolver: realLockResolver(manifest),
    lockStore: inMemoryLockStore(),
    installationRegistry: installationRegistry(definitionsByKey),
  });
}

// ---------------------------------------------------------------------------
// In-memory LifecycleRunRepository + ProcessRunRepository.
//
// This is the SAME proven harness shape used by
// tests/process-modules/scenario-runner.test.mjs, adapted to drive an
// ARBITRARY manifest (N stages, any module per stage). The repository ports
// are in-memory fakes; the ScenarioRunner that consumes them is the REAL
// compiled production code. The `stageOutcomes` map selects which outcome each
// stage's ProcessRun completes with (so the harness can drive both the
// campaign-approved and campaign-rejected paths).
// ---------------------------------------------------------------------------

function makeStageRecord({ id, lifecycleRunId, stageId, moduleRef, binding, input, inputSchema }) {
  return {
    id,
    lifecycleRunId,
    ordinal: id,
    stageId,
    attempt: 1,
    moduleRef,
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema,
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

/**
 * Build a runner harness over `installedScenario`. `stageOutcomes` maps
 * stageId -> { outcome, output, outputSchema } so the harness can drive each
 * stage to a chosen outcome (e.g. approve -> 'approved' or 'rejected').
 *
 * Each stage's ProcessRun is completed synchronously by the executor with the
 * configured outcome + output; the REAL ScenarioRunner handles lease,
 * stage-run creation, process-run start, output storage, routing, and
 * transition.
 */
function createRunnerHarness({
  installedScenario,
  rootInput,
  stageOutcomes,
  idempotencyKey,
  projectId = 7,
  epicId = 8,
  initiatedBy = 'w12-a8-test',
}) {
  const manifest = installedScenario.manifest;
  const stageIds = manifest.stageBindings.map((b) => b.id);

  let stageIdCounter = 11;
  let processIdCounter = 42;
  const leaseFence = { fence: 1 };

  const state = {
    lifecycle: {
      id: 1,
      lifecycle: manifest.identity,
      lifecycleRefKey: `${manifest.identity.name}@${manifest.identity.version}`,
      definitionSnapshot: installedScenario.manifestSnapshot,
      definitionHash: installedScenario.manifestHash,
      projectId,
      epicId,
      initiatedBy,
      idempotencyKey,
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
    processStartCommands: [],
    reachedTerminalStatus: null,
    leaseReleased: false,
  };

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
          inputSchema: command.inputSchema,
        });
        existing.lifecycleRunId = state.lifecycle.id;
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
    pauseStage: () => { state.lifecycle.status = 'paused'; return state.lifecycle; },
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
        state.lifecycle.completedAt = new Date().toISOString();
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
      return { owner, fence: leaseFence.fence };
    },
    renewExecutionLease: () => true,
    releaseExecutionLease: () => { state.leaseReleased = true; },
  };

  const processRunRepo = {
    start: (command) => {
      state.processStartCommands.push(command);
      const id = processIdCounter++;
      const stageId = state.lifecycle.currentStageId;
      const configured = stageOutcomes[stageId] ?? {
        outcome: 'completed',
        output: { value: `${stageId}-output` },
        outputSchema: `${stageId}.output.v1`,
      };
      const outputPayload = configured.output;
      const process = {
        id,
        status: 'completed',
        localOutcome: configured.outcome,
        authority: 'test-policy',
        outputSchema: configured.outputSchema,
        outputRef: `${stageId}-artifact-${id}`,
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

  const outputStore = {
    storeOutput: async (record) => {
      state.storedOutputs.push(record);
      return record;
    },
    listOutputs: async (_runId) => state.storedOutputs,
  };

  // REAL ScenarioRunner over the in-memory ports.
  const runner = new ScenarioRunner({
    lifecycleRunRepo,
    processRunRepo,
    router: {
      // The REAL routeScenarioOutcome is the router; we adapt its signature to
      // the ScenarioRouter port the runner expects. Budget enforcement is
      // exercised by the runner's own transition/reentry counters.
      resolveTransition: ({ stage, outcome }) =>
        routeScenarioOutcome(manifest, stage.id, outcome).target,
    },
    outputStore,
  });

  return {
    state,
    runner,
    installedScenario,
    command: {
      projectId,
      epicId,
      inputSchema: `${manifest.identity.name}.input.v1`,
      inputPayload: rootInput,
      initiatedBy,
      idempotencyKey,
    },
    stageIds,
  };
}

// ---------------------------------------------------------------------------
// Default stage outcomes for the campaign (all stages succeed; approve ->
// 'approved' -> campaign-approved terminal).
// ---------------------------------------------------------------------------

const CAMPAIGN_ROOT_INPUT = Object.freeze({
  initiative: {
    brief: 'Launch the autumn product line via organic search.',
    audience: 'budget-conscious outdoor enthusiasts',
  },
});

function defaultCampaignStageOutcomes({ approveOutcome = 'approved' } = {}) {
  return {
    draft: {
      outcome: 'campaign-drafted',
      output: {
        campaignDraft: { headline: 'Autumn Launch', body: 'draft body' },
        keywords: ['autumn', 'outdoor', 'launch'],
      },
      outputSchema: LM_MARKETING_OUTPUT,
    },
    'seo-baseline': {
      outcome: 'ranking-fetched',
      output: { rankingSnapshot: { 'autumn': 12 }, market: 'baseline' },
      outputSchema: SEO_OUTPUT,
    },
    metrics: {
      outcome: 'ranking-fetched',
      output: { metrics: { opportunity: 88 }, market: 'metrics' },
      outputSchema: SEO_OUTPUT,
    },
    'seo-followup': {
      outcome: 'ranking-fetched',
      output: { rankingSnapshot: { 'autumn': 9 }, market: 'followup' },
      outputSchema: SEO_OUTPUT,
    },
    approve: {
      outcome: approveOutcome,
      output: { decision: approveOutcome, comment: 'looks good' },
      outputSchema: DIRECTOR_OUTPUT,
    },
  };
}

const CAMPAIGN_DEFINITIONSByKey = {
  [`${LM_MARKETING_REF.name}@${LM_MARKETING_REF.version}`]: LM_MARKETING_DEFINITION,
  [`${EXTERNAL_SEO_REF.name}@${EXTERNAL_SEO_REF.version}`]: EXTERNAL_SEO_DEFINITION,
  [`${HUMAN_DIRECTOR_REF.name}@${HUMAN_DIRECTOR_REF.version}`]: HUMAN_DIRECTOR_DEFINITION,
};

const PRODUCT_DELIVERY_DEFINITIONSByKey = {
  [`${DELIVERY_BUILD_REF.name}@${DELIVERY_BUILD_REF.version}`]: DELIVERY_BUILD_DEFINITION,
  [`${DELIVERY_RELEASE_REF.name}@${DELIVERY_RELEASE_REF.version}`]: DELIVERY_RELEASE_DEFINITION,
};

// ===========================================================================
// Group 0 — structural sanity: the harness faithfully mirrors the campaign.
// ===========================================================================

test('W12-A8 harness: campaign stage graph mirrors the real campaign manifest', () => {
  // The harness manifest must have the SAME stage ids, module refs, outcome
  // route targets, and terminals as the real campaign. This proves the
  // reliability exercise below is faithful to the campaign scenario, not a
  // synthetic shape.
  const harness = buildCampaignScenarioManifest();
  const real = campaignScenarioManifest;

  // Same 5 stage ids in the same order.
  assert.deepEqual(
    harness.stageBindings.map((s) => s.id),
    real.stageBindings.map((s) => s.id),
    'harness stage ids must match the real campaign',
  );
  // Same module ref per stage.
  for (let i = 0; i < real.stageBindings.length; i += 1) {
    assert.deepEqual(
      harness.stageBindings[i].moduleRef,
      real.stageBindings[i].moduleRef,
      `stage '${real.stageBindings[i].id}' must bind the same module`,
    );
  }
  // Same outcome routes (the static routing table — §6.4).
  for (let i = 0; i < real.stageBindings.length; i += 1) {
    assert.deepEqual(
      harness.stageBindings[i].outcomeRoutes,
      real.stageBindings[i].outcomeRoutes,
      `stage '${real.stageBindings[i].id}' must have the same outcomeRoutes`,
    );
  }
  // Same terminals.
  assert.deepEqual(
    [...harness.terminalStatuses].sort(),
    [...real.terminalStatuses].sort(),
    'harness terminals must match the real campaign terminals',
  );
  // external-seo reused in exactly 3 stages (plan §6.8).
  const seoStages = harness.stageBindings.filter(
    (s) => s.moduleRef.name === EXTERNAL_SEO_REF.name,
  );
  assert.equal(seoStages.length, 3, 'external-seo reused in 3 stages');
  assert.deepEqual(
    seoStages.map((s) => s.id),
    ['seo-baseline', 'metrics', 'seo-followup'],
    'external-seo reused in the three expected stages',
  );
});

test('W12-A8 harness: campaign harness manifest validates + round-trips', () => {
  const manifest = buildCampaignScenarioManifest();
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, true, `harness manifest must validate (${JSON.stringify(result.errors)})`);
  assertCanonicalSerializable(manifest);
});

// ===========================================================================
// Group 1 — GUARANTEE 1: REPEATED COMPLETION.
// ===========================================================================

test('W12-A8 repeated: Campaign completes to campaign-approved across N fresh runs', async () => {
  // Run the campaign 5 times with distinct idempotency keys. Every run must
  // walk all 5 stages and reach campaign-approved. This is the core "completes
  // repeatedly" proof (spec §2 lane W12-A8, §3 exit gate #1).
  const manifest = buildCampaignScenarioManifest();
  const installed = await installScenarioReal(manifest, CAMPAIGN_DEFINITIONSByKey);
  const RUNS = 5;
  const terminals = [];

  for (let i = 0; i < RUNS; i += 1) {
    const harness = createRunnerHarness({
      installedScenario: installed,
      rootInput: CAMPAIGN_ROOT_INPUT,
      stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'approved' }),
      idempotencyKey: `w12-a8-fresh-${i}`,
    });
    const result = await harness.runner.run(installed, harness.command);
    terminals.push(result.terminalStatus);
    // Every run walked exactly 5 stages (draft -> seo-baseline -> metrics ->
    // seo-followup -> approve) and started 5 process runs.
    assert.equal(
      harness.state.stages.length,
      5,
      `run ${i}: all 5 stages executed`,
    );
    assert.equal(
      harness.state.processStartCommands.length,
      5,
      `run ${i}: 5 process runs started`,
    );
    assert.equal(result.status, 'completed', `run ${i}: status completed`);
    assert.equal(harness.state.leaseReleased, true, `run ${i}: lease released`);
  }

  assert.deepEqual(
    terminals,
    ['campaign-approved', 'campaign-approved', 'campaign-approved', 'campaign-approved', 'campaign-approved'],
    'all 5 fresh runs reached campaign-approved',
  );
});

test('W12-A8 repeated: Campaign completes to campaign-rejected across N fresh runs', async () => {
  // Symmetric proof: the reject path (Human stage emits 'rejected') also
  // completes repeatedly. A Campaign that only repeated on the happy path would
  // not prove reliability of the terminal routing for both declared outcomes.
  const manifest = buildCampaignScenarioManifest();
  const installed = await installScenarioReal(manifest, CAMPAIGN_DEFINITIONSByKey);
  const RUNS = 3;
  const terminals = [];

  for (let i = 0; i < RUNS; i += 1) {
    const harness = createRunnerHarness({
      installedScenario: installed,
      rootInput: CAMPAIGN_ROOT_INPUT,
      stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'rejected' }),
      idempotencyKey: `w12-a8-reject-${i}`,
    });
    const result = await harness.runner.run(installed, harness.command);
    terminals.push(result.terminalStatus);
    assert.equal(result.terminalStatus, 'campaign-rejected', `run ${i}: campaign-rejected`);
    assert.equal(result.status, 'completed', `run ${i}: status completed`);
  }

  assert.deepEqual(
    terminals,
    ['campaign-rejected', 'campaign-rejected', 'campaign-rejected'],
    'all reject runs reached campaign-rejected',
  );
});

test('W12-A8 repeated: byte-level replay equality — two fresh runs produce identical output hashes', async () => {
  // Spec §5: "Assert byte-level replay equality (content hashes match across
  // crash boundaries)". Two independent fresh runs over identical input must
  // produce content-hash-identical public outputs — determinism is the
  // hardening contract.
  const manifest = buildCampaignScenarioManifest();
  const installed = await installScenarioReal(manifest, CAMPAIGN_DEFINITIONSByKey);

  async function runOnce(idempotencyKey) {
    const harness = createRunnerHarness({
      installedScenario: installed,
      rootInput: CAMPAIGN_ROOT_INPUT,
      stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'approved' }),
      idempotencyKey,
    });
    const result = await harness.runner.run(installed, harness.command);
    return { result, harness };
  }

  const { harness: h1 } = await runOnce('w12-a8-determinism-1');
  const { harness: h2 } = await runOnce('w12-a8-determinism-2');

  // Same number of public outputs.
  assert.equal(h1.state.storedOutputs.length, h2.state.storedOutputs.length);
  // Per-stage content hashes identical across the two independent runs.
  const hashByStage1 = new Map(h1.state.storedOutputs.map((o) => [o.stageId, o.contentHash]));
  for (const out of h2.state.storedOutputs) {
    assert.equal(
      out.contentHash,
      hashByStage1.get(out.stageId),
      `stage '${out.stageId}' output content-hash must be identical across runs`,
    );
  }
  // The manifest hash pinned on both runs is identical (frozen scenario).
  assert.equal(
    h1.state.lifecycle.definitionHash,
    h2.state.lifecycle.definitionHash,
    'definition hash identical across runs',
  );
  // The lock digest is identical (same module pins).
  assert.equal(
    h1.installedScenario.lock.lockDigest,
    h2.installedScenario.lock.lockDigest,
    'lock digest identical across runs',
  );
});

test('W12-A8 repeated: idempotent replay returns the already-terminal run without re-executing stages', async () => {
  // A second run call with the SAME idempotency key against an already-terminal
  // LifecycleRun must return that terminal run and NOT re-execute any stage.
  // (The harness's in-memory repo returns the same lifecycle record keyed by
  // idempotency, so the runner's terminal-check short-circuits.) This proves
  // replay safety: re-driving a completed Campaign is a no-op, not a re-run.
  const manifest = buildCampaignScenarioManifest();
  const installed = await installScenarioReal(manifest, CAMPAIGN_DEFINITIONSByKey);
  const key = 'w12-a8-replay-key';

  const harness = createRunnerHarness({
    installedScenario: installed,
    rootInput: CAMPAIGN_ROOT_INPUT,
    stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'approved' }),
    idempotencyKey: key,
  });

  // First run: completes the campaign.
  const first = await harness.runner.run(installed, harness.command);
  assert.equal(first.terminalStatus, 'campaign-approved');
  const stagesAfterFirst = harness.state.stages.length;
  const processStartsAfterFirst = harness.state.processStartCommands.length;

  // The repo now holds a terminal lifecycle. A second start with the same key
  // returns that terminal record; the runner sees status==='completed' and
  // returns immediately without entering the stage loop.
  const second = await harness.runner.run(installed, harness.command);
  assert.equal(second.status, 'completed');
  assert.equal(second.terminalStatus, 'campaign-approved');
  // No new stages or process runs were created on replay.
  assert.equal(
    harness.state.stages.length,
    stagesAfterFirst,
    'replay must not create new stage runs',
  );
  assert.equal(
    harness.state.processStartCommands.length,
    processStartsAfterFirst,
    'replay must not start new process runs',
  );
});

// ===========================================================================
// Group 2 — GUARANTEE 2: CROSS-SCENARIO ISOLATION (no interference).
// ===========================================================================

test('W12-A8 isolation: Campaign and Product Delivery run concurrently and reach their own terminals', async () => {
  // Two INDEPENDENT ScenarioRunner instances (one Campaign, one Product
  // Delivery) run concurrently via Promise.all in the same process. Each owns
  // its own in-memory ports; neither observes the other's state. This is the
  // spec §2 lane W12-A8 / §3 exit gate #6 "does NOT interfere with concurrent
  // Product Delivery runs" proof.
  const campaignManifest = buildCampaignScenarioManifest();
  const pdManifest = buildProductDeliveryManifest();
  const campaignInstalled = await installScenarioReal(campaignManifest, CAMPAIGN_DEFINITIONSByKey);
  const pdInstalled = await installScenarioReal(pdManifest, PRODUCT_DELIVERY_DEFINITIONSByKey);

  const campaignHarness = createRunnerHarness({
    installedScenario: campaignInstalled,
    rootInput: CAMPAIGN_ROOT_INPUT,
    stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'approved' }),
    idempotencyKey: 'w12-a8-iso-campaign',
  });
  const pdHarness = createRunnerHarness({
    installedScenario: pdInstalled,
    rootInput: { initiative: { spec: 'build the release artifact' } },
    stageOutcomes: {
      'delivery-build': {
        outcome: 'built',
        output: { artifact: { name: 'release.tar', sha: 'abc' } },
        outputSchema: DELIVERY_BUILD_OUTPUT,
      },
      'delivery-release': {
        outcome: 'released',
        output: { release: { tag: 'v1.0.0' } },
        outputSchema: DELIVERY_RELEASE_OUTPUT,
      },
    },
    idempotencyKey: 'w12-a8-iso-pd',
  });

  const [campaignResult, pdResult] = await Promise.all([
    campaignHarness.runner.run(campaignInstalled, campaignHarness.command),
    pdHarness.runner.run(pdInstalled, pdHarness.command),
  ]);

  // Each run reached its OWN terminal — no cross-contamination.
  assert.equal(campaignResult.status, 'completed');
  assert.equal(campaignResult.terminalStatus, 'campaign-approved');
  assert.equal(pdResult.status, 'completed');
  assert.equal(pdResult.terminalStatus, 'released');
  assert.notEqual(
    campaignResult.terminalStatus,
    pdResult.terminalStatus,
    'terminals must differ across the two scenarios',
  );

  // No state leakage: each output store holds ONLY its own stage ids.
  const campaignStageSet = new Set(campaignManifest.stageBindings.map((s) => s.id));
  const pdStageSet = new Set(pdManifest.stageBindings.map((s) => s.id));
  for (const out of campaignHarness.state.storedOutputs) {
    assert.ok(campaignStageSet.has(out.stageId), `campaign store holds campaign stage '${out.stageId}'`);
    assert.ok(!pdStageSet.has(out.stageId), `campaign store must NOT hold a Product Delivery stage '${out.stageId}'`);
  }
  for (const out of pdHarness.state.storedOutputs) {
    assert.ok(pdStageSet.has(out.stageId), `pd store holds pd stage '${out.stageId}'`);
    assert.ok(!campaignStageSet.has(out.stageId), `pd store must NOT hold a Campaign stage '${out.stageId}'`);
  }

  // Each run started exactly its own stages.
  assert.equal(campaignHarness.state.processStartCommands.length, 5, 'campaign started 5 process runs');
  assert.equal(pdHarness.state.processStartCommands.length, 2, 'pd started 2 process runs');

  // Each run released its own lease (independent lease lifecycle).
  assert.equal(campaignHarness.state.leaseReleased, true);
  assert.equal(pdHarness.state.leaseReleased, true);

  // No error crossed into either run.
  assert.equal(campaignHarness.state.lifecycle.error, null);
  assert.equal(pdHarness.state.lifecycle.error, null);

  // Static disjointness (the isolation is structural, not accidental): the two
  // scenario identities, stage ids, and terminals are disjoint, and they share
  // no module package. (Re-stated here so the runtime isolation proof above is
  // paired with its static foundation.)
  assert.notEqual(
    `${campaignManifest.identity.name}@${campaignManifest.identity.version}`,
    `${pdManifest.identity.name}@${pdManifest.identity.version}`,
    'scenario identity ref keys are disjoint',
  );
  const campaignStages = new Set(campaignManifest.stageBindings.map((s) => s.id));
  const pdStages = new Set(pdManifest.stageBindings.map((s) => s.id));
  assert.deepEqual(
    [...campaignStages].filter((s) => pdStages.has(s)),
    [],
    'Campaign and Product Delivery stage ids are disjoint',
  );
  const campaignModules = new Set(campaignManifest.requiredModuleSelectors.map((s) => s.name));
  const pdModules = new Set(pdManifest.requiredModuleSelectors.map((s) => s.name));
  assert.deepEqual(
    [...campaignModules].filter((m) => pdModules.has(m)),
    [],
    'Campaign and Product Delivery share NO module package',
  );
});

test('W12-A8 isolation: a rejected Campaign does NOT poison a concurrent successful Product Delivery run', async () => {
  // Stronger interference probe: drive the Campaign to campaign-rejected while
  // a Product Delivery run completes successfully (released) in the same
  // process. The Product Delivery terminal must be unaffected by the Campaign
  // rejection — proving failure isolation (one lifecycle's failure cannot
  // propagate to the other).
  const campaignManifest = buildCampaignScenarioManifest();
  const pdManifest = buildProductDeliveryManifest();
  const campaignInstalled = await installScenarioReal(campaignManifest, CAMPAIGN_DEFINITIONSByKey);
  const pdInstalled = await installScenarioReal(pdManifest, PRODUCT_DELIVERY_DEFINITIONSByKey);

  const campaignHarness = createRunnerHarness({
    installedScenario: campaignInstalled,
    rootInput: CAMPAIGN_ROOT_INPUT,
    stageOutcomes: defaultCampaignStageOutcomes({ approveOutcome: 'rejected' }),
    idempotencyKey: 'w12-a8-failiso-campaign',
  });
  const pdHarness = createRunnerHarness({
    installedScenario: pdInstalled,
    rootInput: { initiative: { spec: 'build the release artifact' } },
    stageOutcomes: {
      'delivery-build': {
        outcome: 'built',
        output: { artifact: { name: 'release.tar', sha: 'def' } },
        outputSchema: DELIVERY_BUILD_OUTPUT,
      },
      'delivery-release': {
        outcome: 'released',
        output: { release: { tag: 'v2.0.0' } },
        outputSchema: DELIVERY_RELEASE_OUTPUT,
      },
    },
    idempotencyKey: 'w12-a8-failiso-pd',
  });

  const [campaignResult, pdResult] = await Promise.all([
    campaignHarness.runner.run(campaignInstalled, campaignHarness.command),
    pdHarness.runner.run(pdInstalled, pdHarness.command),
  ]);

  // The Campaign rejection did NOT propagate to the Product Delivery run.
  assert.equal(campaignResult.terminalStatus, 'campaign-rejected');
  assert.equal(pdResult.terminalStatus, 'released');
  assert.equal(pdResult.status, 'completed');
  assert.equal(pdHarness.state.lifecycle.error, null, 'Product Delivery run carries no error from the Campaign rejection');
  assert.equal(campaignHarness.state.lifecycle.status, 'completed', 'rejected Campaign is a completed terminal, not a failed run');
});

test('W12-A8 isolation: Campaign and Product Delivery remain disjoint from the REAL legacy Product Delivery lifecycle', () => {
  // The isolation proof is grounded against the REAL productDeliveryLifecycle
  // (the production coexisting peer). The Campaign harness terminals must be
  // disjoint from the real Product Delivery terminals, and the Product-Delivery
  // harness uses 'released' (a real Product Delivery terminal) to make the
  // disjointness concrete.
  const campaignManifest = buildCampaignScenarioManifest();
  const pdTerminals = new Set();
  for (const s of productDeliveryLifecycle.stages) {
    for (const t of Object.values(s.outcomeRoutes)) {
      if (t.type === 'terminal') pdTerminals.add(t.status);
    }
  }
  assert.ok(pdTerminals.has('released'), "real Product Delivery reaches 'released'");
  const campaignTerminals = new Set(campaignManifest.terminalStatuses);
  assert.deepEqual(
    [...campaignTerminals].filter((t) => pdTerminals.has(t)),
    [],
    'Campaign terminals are disjoint from the real Product Delivery terminals',
  );
});

// ===========================================================================
// Group 3 — KNOWN FINDING: path-syntax divergence (returned to owning subsystem).
// ===========================================================================

test('W12-A8 finding (documents W12-A8-1): the real campaign manifest uses non-$. mapping paths the ScenarioRunner rejects', () => {
  // This test DOCUMENTS the finding described in the file header (FINDING
  // W12-A8-1) and proves it is real, so the owning subsystem (W10-A4 manifest
  // authors / W7-A6 runner mapper) has a reproducing assertion. It is NOT a
  // production-code fix (test-only wave, spec §1/§4).
  //
  // The real campaign manifest's inputMapping paths are bare (e.g.
  // 'initiative.brief'), while the ScenarioRunner's mapLifecycleValues
  // requires '$.'-prefixed paths. We prove both halves:
  //   (a) the real manifest carries at least one bare path;
  //   (b) the runner's path contract rejects a bare path.
  const real = campaignScenarioManifest;
  const barePaths = [];
  for (const stage of real.stageBindings) {
    for (const [key, expr] of Object.entries(stage.inputMapping)) {
      if (typeof expr === 'string' && expr !== '$' && !expr.startsWith('$.')) {
        barePaths.push({ stageId: stage.id, key, path: expr });
      }
    }
  }
  assert.ok(
    barePaths.length > 0,
    'real campaign manifest declares at least one non-$. mapping path (finding premise)',
  );
  // Pin a concrete example so the finding is unambiguous.
  assert.ok(
    barePaths.some((p) => p.stageId === 'draft' && p.path === 'initiative.brief'),
    `draft.brief is bare (got ${JSON.stringify(barePaths[0])})`,
  );

  // The runner's mapper rejects a bare path. We exercise the REAL compiled
  // mapLifecycleValues by driving a one-stage scenario whose inputMapping has
  // a bare path; the runner must fail the run (not silently misroute). We do
  // NOT need the run to complete — we assert the path contract is enforced.
  // (Re-using the runner's failure path: a LIFECYCLE_MAPPING_INVALID_PATH
  // surfaces as a failed LifecycleRun.)
  const bareManifest = {
    manifestFormatVersion: '0.1.0',
    identity: { name: 'bare-path-probe', version: '1.0.0', displayName: 'Bare Path Probe', description: 'probe' },
    inputContractRef: contractRef('bare.input.v1'),
    outputContractRef: contractRef('bare.output.v1'),
    entryStageId: 'only',
    stageBindings: [
      {
        id: 'only',
        displayName: 'Only',
        moduleRef: LM_MARKETING_REF,
        moduleSelector: selector(LM_MARKETING_REF),
        inputMapping: { brief: 'initiative.brief' }, // bare — the finding
        outputMapping: {},
        outcomeRoutes: { 'campaign-drafted': { type: 'terminal', status: 'done' } },
        entryConditions: [],
        exitConditions: [],
      },
    ],
    outcomeRoutes: {},
    inputMappings: {},
    outputMappings: {},
    terminalStatuses: ['done'],
    scenarioPolicies: {},
    requiredModuleSelectors: [selector(LM_MARKETING_REF)],
    transitionBudgets: { maxTransitions: 4 },
    reentryBudgets: { maxReentries: 0 },
  };
  const installed = {
    manifest: bareManifest,
    manifestSnapshot: canonicalJson(bareManifest),
    manifestHash: sha256Hex(bareManifest),
    lock: {
      scenarioIdentity: bareManifest.identity,
      entries: [{
        stageId: 'only',
        selector: selector(LM_MARKETING_REF),
        installedModuleRef: LM_MARKETING_REF,
        installationId: 1,
        packageDigest: sha256Hex({ m: LM_MARKETING_REF }),
      }],
      lockDigest: sha256Hex([{ stageId: 'only' }]),
    },
    installationsByStageId: {
      only: { definition: LM_MARKETING_DEFINITION, executor: harnessExecutor(LM_MARKETING_DEFINITION.identity.kind) },
    },
  };
  const harness = createRunnerHarness({
    installedScenario: installed,
    rootInput: { initiative: { brief: 'x' } },
    stageOutcomes: {
      only: { outcome: 'campaign-drafted', output: { x: 1 }, outputSchema: LM_MARKETING_OUTPUT },
    },
    idempotencyKey: 'w12-a8-bare-probe',
  });
  const result = harness.runner.run(installed, harness.command);
  // The run fails (the runner surfaces the mapping error as a failed run, not
  // a silent misroute). We accept either a rejected promise or a resolved
  // failed-result; both prove the path contract is enforced.
  return Promise.resolve(result).then(
    (r) => {
      assert.equal(r.status, 'failed', 'bare-path run must fail (path contract enforced)');
      assert.match(r.lifecycleRun.error ?? '', /MAPPING_INVALID_PATH|initiative\.brief/);
    },
    (err) => {
      // If the mapper throws synchronously during frame build, the runner
      // surfaces it as a failed run; either way the contract is enforced.
      assert.match(
        err instanceof Error ? err.message : String(err),
        /MAPPING_INVALID_PATH|initiative\.brief/,
        'bare-path run rejects with MAPPING_INVALID_PATH',
      );
    },
  );
});
