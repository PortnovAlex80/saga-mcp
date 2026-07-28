// @ts-check
/**
 * W1-A8 — Round-trip conformance for every Wave 1 SPI manifest type.
 *
 * Spec ref: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §4
 * (round-trip contract), §1 (manifest types). Plan ref: §0.4.11 (serial gate),
 * §14.2.6 (Wave 1 exit gate).
 *
 * For EACH manifest type listed in spec §4 (ProcessModuleManifest,
 * LifecycleScenarioManifest, NodeProtocolDefinition, ModuleToolContribution,
 * AgentAssistanceDefinition, ModuleCompletion, ProcessModuleOutputEnvelope,
 * ExecutionContextEnvelope, DriverNeutralExecutionReceipt):
 *   1. Construct a valid minimal instance.
 *   2. Assert `JSON.parse(canonicalJson(instance))` deep-equals the instance.
 *   3. Assert `sha256Hex(instance)` is stable across two runs.
 *   4. Assert `assertCanonicalSerializable(instance)` does not throw.
 *
 * This is the serial-precondition proof (plan §0.4.11): the new SPI types
 * round-trip losslessly through canonical JSON, and the digest is stable, so
 * later waves can use canonicalJson as the wire + persistence format and
 * sha256Hex as the content-addressed identity.
 *
 * NOTE: This test imports from `dist/process-modules/domain/spi/index.js`,
 * which is the barrel produced by THIS lane. The barrel re-exports symbols
 * owned by sibling lanes A1..A7. If the sibling lanes have not yet been
 * cherry-picked into the integrator's tree, the import will fail with an
 * unresolved-import error — that is EXPECTED for A8 in isolation. The
 * integrator runs the full Wave 1 gate after cherry-picking all lanes in
 * order (plan §0.4.11, A8 task file §"Verify").
 *
 * Run: `node --test tests/spi/round-trip-conformance.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// The barrel — pulls every Wave 1 SPI symbol from sibling files (resolved
// at integration after A1..A7 are cherry-picked in order).
const {
  // W1-A1 canonical serialization
  assertCanonicalSerializable,
  // W1-A5 contract ref
  computeContractRefDigest,
  // W1-A2 module manifest
  validateProcessModuleManifest,
  // W1-A3 scenario manifest
  validateLifecycleScenarioManifest,
  // W1-A4 node protocol + execution envelope
  validateNodeProtocolDefinition,
  // W1-A6 production envelope + tool + assistance + receipt
  validateModuleToolContribution,
  validateAgentAssistanceDefinition,
  validateModuleCompletion,
  validateProcessModuleOutputEnvelope,
  validateExecutionContextEnvelope,
  validateDriverNeutralExecutionReceipt,
} = await import('../../dist/process-modules/domain/spi/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a pure ContractRef value (digest computed from a small schema doc).
 */
function makeContractRef(schemaId) {
  const doc = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} };
  return {
    schemaId,
    version: '0.1.0',
    digest: computeContractRefDigest(doc),
  };
}

/**
 * Round-trip + stability contract (spec §4).
 *
 * @param {string} label
 * @param {unknown} instance
 */
function assertRoundTrip(label, instance) {
  // 1. canonical serialization must not throw
  assertCanonicalSerializable(instance);

  // 2. JSON.parse(canonicalJson(instance)) deep-equals instance
  const json = canonicalJson(instance);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, instance, `${label}: round-trip via JSON.parse(canonicalJson(x))`);

  // 3. sha256Hex is stable across two runs (canonicalJson determinism)
  const h1 = sha256Hex(instance);
  const h2 = sha256Hex(instance);
  assert.equal(h1, h2, `${label}: sha256Hex stable across two runs`);
  assert.match(h1, /^[0-9a-f]{64}$/, `${label}: sha256Hex is 64-char lowercase hex`);
}

// ---------------------------------------------------------------------------
// Test data builders — one per manifest type
// ---------------------------------------------------------------------------

/**
 * Minimal `ProcessModuleManifest` (spec §1 row 4). Uses the smallest valid
 * ProcessModuleDefinition shape (the existing `ProcessModuleDefinition` from
 * `domain/process-module.ts`); W1-A2's validator re-checks that definition.
 */
function buildProcessModuleManifest() {
  const definition = {
    identity: {
      name: 'synthetic-roundtrip-module',
      version: '0.1.0',
      kind: 'roundtrip-kind',
      displayName: 'Round-trip Module',
      description: 'W1-A8 round-trip proof manifest.',
    },
    inputContract: { id: 'synthetic.roundtrip.input.v1' },
    outputContract: { id: 'synthetic.roundtrip.output.v1' },
    outcomes: [
      { code: 'done', description: 'ok', terminal: true },
    ],
    flow: {
      id: 'synthetic.roundtrip.flow',
      version: '0.1.0',
      entryNodeId: 'n1',
      nodes: [
        {
          id: 'n1',
          label: 'N1',
          kind: 'kernel',
          description: 'minimal',
          handler: 'noop-handler@1.0.0',
        },
      ],
      transitions: [],
      terminalNodeIds: ['n1'],
    },
    artifacts: [
      {
        type: 'synthetic.roundtrip.out',
        schema: { id: 'synthetic.roundtrip.output.v1' },
        authority: 'kernel',
        description: 'output envelope',
      },
    ],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
  return {
    manifestFormatVersion: '0.1.0',
    definition,
    resourceIndex: [
      {
        logicalId: 'input-schema',
        path: 'schemas/input.schema.json',
        kind: 'schema',
        digest: 'pending@wave-2',
      },
    ],
    handlerRefs: [
      { logicalId: 'noop-handler', version: '1.0.0', digest: 'pending@wave-2' },
    ],
    inputContractRef: makeContractRef('synthetic.roundtrip.input.v1'),
    outputContractRef: makeContractRef('synthetic.roundtrip.output.v1'),
    runtimeCompatibilityRange: '>=2.0.0 <3.0.0',
  };
}

/**
 * Minimal `LifecycleScenarioManifest` (spec §1 row 6). Mirrors the campaign
 * fixture shape: 2 stages, single outcome route per stage, no routeResolver.
 */
function buildLifecycleScenarioManifest() {
  const stage1 = {
    id: 'first',
    displayName: 'First',
    moduleRef: { name: 'synthetic-roundtrip-module', version: '0.1.0' },
    inputMapping: { root: 'initiative.brief' },
    outputMapping: { firstOut: 'output.firstOut' },
    outcomeRoutes: { done: { type: 'stage', stageId: 'second' } },
    entryConditions: ['root input'],
    exitConditions: ['done emitted'],
  };
  const stage2 = {
    id: 'second',
    displayName: 'Second',
    moduleRef: { name: 'synthetic-roundtrip-module', version: '0.1.0' },
    inputMapping: { in1: 'stages.first.output.firstOut' },
    outputMapping: { secondOut: 'output.secondOut' },
    outcomeRoutes: { done: { type: 'terminal', status: 'scenario-complete' } },
    entryConditions: ['first output'],
    exitConditions: ['done emitted'],
  };
  return {
    manifestFormatVersion: '0.1.0',
    identity: {
      name: 'synthetic-roundtrip-scenario',
      version: '0.1.0',
      displayName: 'Round-trip Scenario',
      description: 'W1-A8 round-trip proof scenario.',
    },
    inputContractRef: makeContractRef('synthetic.roundtrip.scenario.input.v1'),
    outputContractRef: makeContractRef('synthetic.roundtrip.scenario.output.v1'),
    entryStageId: 'first',
    stageBindings: [stage1, stage2],
    outcomeRoutes: {},
    inputMappings: {},
    outputMappings: {},
    terminalStatuses: ['scenario-complete'],
    scenarioRetryPolicy: { kind: 'none' },
    pausePolicy: { kind: 'none' },
    cancellationPolicy: { kind: 'none' },
    escalationPolicy: { kind: 'none' },
    requiredModuleSelectors: [
      { name: 'synthetic-roundtrip-module', versionRange: '0.1.0' },
    ],
    transitionBudgets: { maxTransitions: 16 },
    reentryBudgets: { maxReentries: 2 },
  };
}

/**
 * Minimal `NodeProtocolDefinition` (spec §1 row 7, plan §8.2). Single linear
 * step, runtime-implemented-linear retry.
 */
function buildNodeProtocolDefinition() {
  return {
    id: 'synthetic.roundtrip.protocol',
    version: '0.1.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'Do the work.',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
    transitions: [],
    nodeCompletionEvidence: [
      {
        category: 'artifact-reference',
        contractRef: makeContractRef('synthetic.roundtrip.protocol.evidence.v1'),
        required: true,
      },
    ],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
  };
}

/**
 * Minimal `ModuleToolContribution` (spec §1 row 12, plan §11.4).
 */
function buildModuleToolContribution() {
  return {
    logicalId: 'synthetic.roundtrip.tool',
    version: '0.1.0',
    inputContractRef: makeContractRef('synthetic.roundtrip.tool.input.v1'),
    outputContractRef: makeContractRef('synthetic.roundtrip.tool.output.v1'),
    handlerRef: 'noop-handler@1.0.0',
    guardBindings: [],
    idempotency: 'none',
    sideEffect: 'read',
  };
}

/**
 * Minimal `AgentAssistanceDefinition` (spec §1 row 13, plan §10.5).
 */
function buildAgentAssistanceDefinition() {
  return {
    nodeId: 'n1',
    mode: 'compact',
    events: [
      {
        event: 'step-enter',
        blocks: [
          { kind: 'goal', content: 'Produce a valid output envelope.' },
          { kind: 'next-action', content: 'Call the handler.' },
        ],
      },
    ],
    budgets: { maxSteps: 8, maxTokens: 4096 },
  };
}

/**
 * Minimal `ModuleCompletion` (spec §1 row 11, plan §7.5.6).
 *
 * NOTE: `outputEnvelope` references a `ProcessModuleOutputEnvelope` which
 * itself references this `ModuleCompletion` — a type-only cycle. For the
 * round-trip proof we build a self-consistent runtime value by constructing
 * the envelope first then patching the back-reference.
 */
function buildModuleCompletionAndEnvelope() {
  /** @type {any} */
  const completion = { outcome: 'done', outputEnvelope: null, terminal: true };
  /** @type {any} */
  const production = {
    schemaId: 'synthetic.roundtrip.production.v1',
    productRef: {
      schemaId: 'synthetic.roundtrip.production.v1',
      ref: 'production-1',
      digest: '0'.repeat(64),
    },
    lineage: [
      { kind: 'node-run', ref: 'node-run-1' },
    ],
    // NodeProduction base fields (from application/node-executor.ts)
    nodeRunId: 1,
    artifact: {
      type: 'synthetic.roundtrip.out',
      schema: { id: 'synthetic.roundtrip.output.v1' },
      authority: 'kernel',
      description: 'output envelope',
    },
    bytes: 'roundtrip-output-bytes',
    schema: { id: 'synthetic.roundtrip.output.v1' },
  };
  /** @type {any} */
  const envelope = {
    outcome: 'done',
    productions: [production],
    completion,
  };
  completion.outputEnvelope = envelope;
  return { completion, envelope };
}

/**
 * Minimal `ExecutionContextEnvelope` (spec §1 row 8, plan §7.7).
 */
function buildExecutionContextEnvelope() {
  return {
    processRunId: 42,
    nodeRunId: 7,
    attempt: 1,
    executionId: 'exec-roundtrip-1',
    packageRef: {
      name: 'synthetic-roundtrip-module',
      version: '0.1.0',
      digest: '0'.repeat(64),
    },
    nodeRef: { nodeId: 'n1', flowId: 'synthetic.roundtrip.flow', flowVersion: '0.1.0' },
    frozenAuthority: { role: 'worker', workIntent: 'roundtrip' },
    immutableRunInput: { brief: 'do the thing' },
    upstreamProducts: [
      {
        schemaId: 'synthetic.roundtrip.upstream.v1',
        ref: 'upstream-1',
        digest: 'f'.repeat(64),
      },
    ],
  };
}

/**
 * Minimal `DriverNeutralExecutionReceipt` (spec §1 row 9, plan §13.16).
 */
function buildDriverNeutralExecutionReceipt() {
  return {
    schemaVersion: 'saga3.driver-neutral-receipt.v1',
    nodeRunId: 7,
    attempt: 1,
    runtimeEvent: 'completed',
    driverKind: 'kernel',
    adapterData: { taskId: 99, boardId: 'board-1' },
  };
}

// ---------------------------------------------------------------------------
// Round-trip + validator tests
// ---------------------------------------------------------------------------

test('ProcessModuleManifest: round-trip + stable digest + serializable', () => {
  const manifest = buildProcessModuleManifest();
  assertRoundTrip('ProcessModuleManifest', manifest);
  const result = validateProcessModuleManifest(manifest);
  assert.equal(result.ok, true, `validateProcessModuleManifest ok: ${JSON.stringify(result.errors)}`);
});

test('LifecycleScenarioManifest: round-trip + stable digest + serializable', () => {
  const manifest = buildLifecycleScenarioManifest();
  assertRoundTrip('LifecycleScenarioManifest', manifest);
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, true, `validateLifecycleScenarioManifest ok: ${JSON.stringify(result.errors)}`);
});

test('NodeProtocolDefinition: round-trip + stable digest + serializable', () => {
  const def = buildNodeProtocolDefinition();
  assertRoundTrip('NodeProtocolDefinition', def);
  const result = validateNodeProtocolDefinition(def);
  assert.equal(result.ok, true, `validateNodeProtocolDefinition ok: ${JSON.stringify(result.errors)}`);
});

test('ModuleToolContribution: round-trip + stable digest + serializable', () => {
  const tc = buildModuleToolContribution();
  assertRoundTrip('ModuleToolContribution', tc);
  const result = validateModuleToolContribution(tc);
  assert.equal(result.ok, true, `validateModuleToolContribution ok: ${JSON.stringify(result.errors)}`);
});

test('AgentAssistanceDefinition: round-trip + stable digest + serializable', () => {
  const a = buildAgentAssistanceDefinition();
  assertRoundTrip('AgentAssistanceDefinition', a);
  const result = validateAgentAssistanceDefinition(a);
  assert.equal(result.ok, true, `validateAgentAssistanceDefinition ok: ${JSON.stringify(result.errors)}`);
});

test('ProcessModuleOutputEnvelope + ModuleCompletion: round-trip + stable digest + serializable', () => {
  const { envelope, completion } = buildModuleCompletionAndEnvelope();
  // The cycle is type-only at compile time; at runtime completion.outputEnvelope === envelope.
  // canonicalJson walks own-enumerable props and would recurse forever if we
  // left the back-pointer in place, so we round-trip each side with the
  // back-pointer temporarily severed and then reattach. This mirrors the
  // intended persistence shape: the envelope owns its completion; the
  // completion's `outputEnvelope` field is the containing envelope and is
  // therefore serialized as a reference, not a recursive expansion. Wave 1
  // declares the cycle; Wave 2 persistence resolves it. The round-trip proof
  // here is on the pure-data acyclic projections of each type.
  const savedBackPtr = completion.outputEnvelope;
  completion.outputEnvelope = null;
  try {
    assertRoundTrip('ModuleCompletion', completion);
    assertRoundTrip('ProcessModuleOutputEnvelope', envelope);
    // Validators (if exported): they check the canonical-serializable
    // acyclic projection. If the validator insists on the cycle, it would
    // fail canonical serialization — instead the validator only checks the
    // type's own fields. We invoke the optional validators; missing exports
    // are tolerated (older sibling revisions may not export them yet).
    if (typeof validateModuleCompletion === 'function') {
      const r1 = validateModuleCompletion(completion);
      assert.equal(r1.ok, true, `validateModuleCompletion ok: ${JSON.stringify(r1.errors)}`);
    }
    if (typeof validateProcessModuleOutputEnvelope === 'function') {
      const r2 = validateProcessModuleOutputEnvelope(envelope);
      assert.equal(r2.ok, true, `validateProcessModuleOutputEnvelope ok: ${JSON.stringify(r2.errors)}`);
    }
  } finally {
    completion.outputEnvelope = savedBackPtr;
  }
});

test('ExecutionContextEnvelope: round-trip + stable digest + serializable', () => {
  const env = buildExecutionContextEnvelope();
  assertRoundTrip('ExecutionContextEnvelope', env);
  if (typeof validateExecutionContextEnvelope === 'function') {
    const r = validateExecutionContextEnvelope(env);
    assert.equal(r.ok, true, `validateExecutionContextEnvelope ok: ${JSON.stringify(r.errors)}`);
  }
});

test('DriverNeutralExecutionReceipt: round-trip + stable digest + serializable', () => {
  const r = buildDriverNeutralExecutionReceipt();
  assertRoundTrip('DriverNeutralExecutionReceipt', r);
  if (typeof validateDriverNeutralExecutionReceipt === 'function') {
    const v = validateDriverNeutralExecutionReceipt(r);
    assert.equal(v.ok, true, `validateDriverNeutralExecutionReceipt ok: ${JSON.stringify(v.errors)}`);
  }
});

// ---------------------------------------------------------------------------
// Cross-instance digest stability (deterministic canonical JSON)
// ---------------------------------------------------------------------------

test('canonical JSON determinism: two equal instances produce identical sha256Hex', () => {
  const a = buildProcessModuleManifest();
  const b = buildProcessModuleManifest();
  const ha = sha256Hex(a);
  const hb = sha256Hex(b);
  assert.equal(ha, hb, 'two structurally-equal manifests produce the same digest');
});

test('canonical JSON determinism: key order is normalized (digest insensitive to insertion order)', () => {
  // Build the same logical object with different key insertion order.
  const ordered = {
    manifestFormatVersion: '0.1.0',
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: makeContractRef('s'),
    outputContractRef: makeContractRef('s'),
    runtimeCompatibilityRange: '>=2.0.0 <3.0.0',
    definition: {
      identity: { name: 'k', version: '0.1.0', kind: 'k', displayName: 'k', description: 'k' },
      inputContract: { id: 's' },
      outputContract: { id: 's' },
      outcomes: [],
      flow: { id: 'f', version: '0.1.0', entryNodeId: 'n', nodes: [], transitions: [], terminalNodeIds: [] },
      artifacts: [],
      policies: [],
      invariants: [],
      executionProfiles: [],
    },
  };
  // Same fields, reverse insertion order at top level.
  const reversed = {
    definition: ordered.definition,
    runtimeCompatibilityRange: ordered.runtimeCompatibilityRange,
    outputContractRef: ordered.outputContractRef,
    inputContractRef: ordered.inputContractRef,
    handlerRefs: ordered.handlerRefs,
    resourceIndex: ordered.resourceIndex,
    manifestFormatVersion: ordered.manifestFormatVersion,
  };
  assert.equal(sha256Hex(ordered), sha256Hex(reversed), 'digest is key-order-independent');
});
