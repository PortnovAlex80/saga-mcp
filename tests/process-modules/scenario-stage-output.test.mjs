// @ts-check
/**
 * W7-A5 — Scenario stage outputs: content-addressed public outputs, lifecycle
 * variables, exact mapped handoffs (no cumulative frame).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md (W7-A5).
 * Plan: §6.11 (store each public output once), §9.13 (LifecycleVariableStore),
 *       §13.21 (cumulative-frame smell replaced), §14.9.9 (content-addressed
 *       public stage outputs + exact mapped handoffs).
 *
 * Run: `npm run build && node --test tests/process-modules/scenario-stage-output.test.mjs`
 *
 * Proof targets baked in:
 *   1. Each public stage output is stored ONCE (idempotent re-record;
 *      divergent re-record rejected). §6.11 / §14.9.9.
 *   2. Content addressing: the same logical value carries the same digest
 *      regardless of producing stage; resolveByDigest works. §14.9.9.
 *   3. Exact handoffs: a downstream stage receives ONLY the fields its
 *      inputMapping declared — never a copy of the root input or sibling
 *      stage payloads. §6.11 / §13.21.
 *   4. The minimal handoff frame exposes only declared ports: a mapping that
 *      reaches for a legacy cumulative-frame field
 *      (`stages.<id>.processOutcome`) is REJECTED — that field is absent.
 *      §13.21.
 *   5. sourceVariableDigests proves a handoff was built only from declared
 *      public outputs. §14.9.9.
 *   6. Scaling: a long scenario does not duplicate the complete frame at every
 *      stage — the handoff payload size depends on the receiving mapping, not
 *      on the number of prior stages. Plan §15.16.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../../dist/shared/canonical-json.js';

import {
  InMemoryLifecycleVariableStore,
  LifecycleVariableAlreadyRecordedError,
  buildStageVariables,
  buildStageOutputEnvelope,
  buildHandoffFrame,
  buildScenarioHandoff,
  moduleOutputEnvelopeDigest,
  LIFECYCLE_VARIABLE_GENERIC_SCHEMA,
} from '../../dist/process-modules/application/scenario-stage-output.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function baselineRuntime(overrides = {}) {
  return {
    projectId: 1,
    epicId: 2,
    lifecycleRunId: 7,
    stageId: 'compute',
    initiatedBy: 'orchestrator',
    ...overrides,
  };
}

/** Record one stage's mapped output into the store and return its variables. */
function recordStage(store, params) {
  const { portSchemaIds, mappedOutput, stageId, stageRunId, processRunId } = params;
  const { variables, portDigests } = buildStageVariables({
    stageId,
    stageRunId,
    processRunId,
    portSchemaIds,
    mappedOutput,
  });
  for (const v of variables) store.record(v);
  return { variables, portDigests };
}

/**
 * Build + persist a full stage output envelope (variables + envelope) for a
 * stage. Returns the envelope.
 */
function persistStageOutput(store, params) {
  const {
    stageId,
    stageRunId,
    processRunId,
    outcome,
    portSchemaIds = {},
    mappedOutput,
    moduleEnvelope,
  } = params;
  const { portDigests } = recordStage(store, {
    stageId,
    stageRunId,
    processRunId,
    portSchemaIds,
    mappedOutput,
  });
  return buildStageOutputEnvelope({
    stageId,
    stageRunId,
    processRunId,
    outcome,
    portDigests,
    moduleOutput: {
      outcome,
      envelopeDigest: moduleOutputEnvelopeDigest(moduleEnvelope),
    },
  });
}

/** Minimal module output envelope shape (W1-A6 ProcessModuleOutputEnvelope). */
function moduleEnvelope(outcome, productions = []) {
  return {
    outcome,
    productions,
    completion: { outcome, outputEnvelope: null, terminal: true },
  };
}

// ---------------------------------------------------------------------------
// 1. Each public output stored ONCE.
// ---------------------------------------------------------------------------

test('store records each (stageId, portName) once and rejects divergent re-record', () => {
  const store = new InMemoryLifecycleVariableStore();
  const { variables } = buildStageVariables({
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    portSchemaIds: { campaignDraft: 'saga3.campaign-draft.v1' },
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
  });
  const [v] = variables;
  assert.equal(v.portName, 'campaignDraft');
  assert.equal(v.digest, sha256Hex({ title: 'Spring Sale' }));

  // First record: ok.
  store.record(v);
  // Idempotent re-record of identical digest: ok (no throw).
  store.record(v);
  assert.equal(store.resolve({ stageId: 'draft', portName: 'campaignDraft' }), v);

  // Divergent re-record (same key, different value): rejected. §6.11.
  const divergent = {
    ...v,
    digest: sha256Hex({ title: 'Autumn Sale' }),
    value: { title: 'Autumn Sale' },
  };
  assert.throws(
    () => store.record(divergent),
    (err) => err instanceof LifecycleVariableAlreadyRecordedError
      && err.stageId === 'draft'
      && err.portName === 'campaignDraft'
      && err.existingDigest === v.digest
      && err.attemptedDigest === divergent.digest,
  );
});

// ---------------------------------------------------------------------------
// 2. Content addressing — same value, same digest, regardless of stage.
// ---------------------------------------------------------------------------

test('content addressing: identical values share a digest across stages', () => {
  const store = new InMemoryLifecycleVariableStore();
  const sharedValue = { ranking: 42 };
  recordStage(store, {
    stageId: 'seo-baseline',
    stageRunId: 11,
    processRunId: 101,
    mappedOutput: { ranking: sharedValue },
  });
  recordStage(store, {
    stageId: 'seo-followup',
    stageRunId: 14,
    processRunId: 104,
    mappedOutput: { ranking: sharedValue },
  });

  const a = store.resolve({ stageId: 'seo-baseline', portName: 'ranking' });
  const b = store.resolve({ stageId: 'seo-followup', portName: 'ranking' });
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest, sha256Hex(sharedValue));

  // resolveByDigest returns the SAME object regardless of which stage produced it.
  const byDigest = store.resolveByDigest(a.digest);
  assert.ok(byDigest !== undefined);
  // Both resolve to one of the recorded variables sharing this digest.
  assert.ok([a.stageId, b.stageId].includes(byDigest.stageId));
});

// ---------------------------------------------------------------------------
// 3. Exact handoffs — downstream receives ONLY declared mapped fields.
// ---------------------------------------------------------------------------

test('handoff payload contains only the receiving stage inputMapping fields, not the whole frame', () => {
  const store = new InMemoryLifecycleVariableStore();

  // Stage 'draft' exports a port. It also (hypothetically) has a sibling
  // stage 'draft' that produced extra data — but only mappedOutput ports
  // enter the store, so non-mapped fields cannot leak.
  recordStage(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    portSchemaIds: { campaignDraft: 'saga3.campaign-draft.v1' },
    mappedOutput: {
      campaignDraft: { title: 'Spring Sale', budget: 5000 },
      // A second port on the same stage:
      meta: { author: 'marketing' },
    },
  });

  // The 'compute' stage declares an inputMapping that reads ONLY campaignDraft.
  const handoff = buildScenarioHandoff({
    targetStageId: 'compute',
    inputMapping: {
      draftTitle: '$.stages.draft.ports.campaignDraft.title',
      runId: { runtime: 'lifecycleRunId' },
    },
    rootInput: { initiative: 'q2-growth' },
    runtime: baselineRuntime({ stageId: 'compute' }),
    store,
    completedStageIds: ['draft'],
  });

  // Payload has EXACTLY the two mapped fields — no root spread, no sibling
  // 'meta' port, no full campaignDraft object.
  assert.deepEqual(Object.keys(handoff.payload).sort(), ['draftTitle', 'runId']);
  assert.equal(handoff.payload.draftTitle, 'Spring Sale');
  assert.equal(handoff.payload.runId, 7);

  // The handoff is content-addressed.
  assert.equal(handoff.handoffDigest, sha256Hex(handoff.payload));

  // sourceVariableDigests records exactly the one variable the mapping read.
  const draftVar = store.resolve({ stageId: 'draft', portName: 'campaignDraft' });
  assert.deepEqual(handoff.sourceVariableDigests, [draftVar.digest]);
});

// ---------------------------------------------------------------------------
// 4. Minimal frame rejects legacy cumulative-frame field reads (§13.21).
// ---------------------------------------------------------------------------

test('legacy cumulative-frame field (stages.<id>.processOutcome) is absent and rejected', () => {
  const store = new InMemoryLifecycleVariableStore();
  recordStage(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
  });

  const frame = buildHandoffFrame({
    rootInput: { initiative: 'q2-growth' },
    runtime: baselineRuntime({ stageId: 'compute' }),
    store,
    completedStageIds: ['draft'],
  });

  // The legacy orchestrator exposed stages.<id>.processOutcome (a sibling's
  // result blob). The minimal frame exposes ONLY ports — processOutcome is
  // structurally absent, so a mapping that reaches for it fails cleanly.
  const draftEntry = frame.stages.draft;
  assert.deepEqual(Object.keys(draftEntry), ['ports']);
  assert.equal('processOutcome' in draftEntry, false);
  assert.equal('stageRunId' in draftEntry, false);
  assert.equal('processRunId' in draftEntry, false);

  // Root input is NOT spread into the top level (legacy did {...rootInput}).
  // It is referenced once under lifecycleInput.
  assert.equal('initiative' in frame, false);
  assert.deepEqual(frame.lifecycleInput, { initiative: 'q2-growth' });
});

// ---------------------------------------------------------------------------
// 5. buildStageOutputEnvelope: module output referenced by digest, not embedded.
// ---------------------------------------------------------------------------

test('stage output envelope references the module envelope by digest and is itself content-addressed', () => {
  const store = new InMemoryLifecycleVariableStore();
  const envelope = moduleEnvelope('campaign-drafted');
  const stageEnvelope = persistStageOutput(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    outcome: 'campaign-drafted',
    portSchemaIds: { campaignDraft: 'saga3.campaign-draft.v1' },
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
    moduleEnvelope: envelope,
  });

  // The module envelope is referenced by digest, NOT embedded.
  assert.equal(
    stageEnvelope.moduleOutput.envelopeDigest,
    moduleOutputEnvelopeDigest(envelope),
  );
  assert.equal(stageEnvelope.moduleOutput.outcome, 'campaign-drafted');

  // portDigests maps the exported port to its variable digest.
  const draftVar = store.resolve({ stageId: 'draft', portName: 'campaignDraft' });
  assert.equal(stageEnvelope.portDigests.campaignDraft, draftVar.digest);

  // The envelope itself is content-addressed (deterministic for same body).
  const rebuilt = buildStageOutputEnvelope({
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    outcome: 'campaign-drafted',
    portDigests: stageEnvelope.portDigests,
    moduleOutput: stageEnvelope.moduleOutput,
  });
  assert.equal(rebuilt.stageOutputDigest, stageEnvelope.stageOutputDigest);
  assert.equal(rebuilt.stageOutputDigest.length, 64);
});

// ---------------------------------------------------------------------------
// 6. Scaling — handoff size depends on the mapping, not on prior-stage count.
//    (Plan §15.16: a long scenario does not duplicate the complete frame.)
// ---------------------------------------------------------------------------

test('scaling: handoff payload size is independent of the number of prior stages', () => {
  const store = new InMemoryLifecycleVariableStore();

  // Seed N prior stages, each exporting a port. Only the LAST one is read by
  // the target mapping; the others are present in the store but must NOT
  // inflate the handoff payload (the §13.21 cumulative-frame smell).
  const N = 25;
  for (let i = 0; i < N; i++) {
    recordStage(store, {
      stageId: `stage-${i}`,
      stageRunId: 100 + i,
      processRunId: 1000 + i,
      mappedOutput: { payload: { index: i, blob: 'x'.repeat(1000) } },
    });
  }

  const handoff = buildScenarioHandoff({
    targetStageId: 'target',
    inputMapping: {
      lastPayload: '$.stages.stage-24.ports.payload.index',
    },
    rootInput: { initiative: 'q2-growth' },
    runtime: baselineRuntime({ stageId: 'target' }),
    store,
    completedStageIds: Array.from({ length: N }, (_, i) => `stage-${i}`),
  });

  // Payload has EXACTLY one field — the single mapped value. The other 24
  // stages' data is NOT copied in (which is exactly what the cumulative frame
  // did and what §13.21 / §15.16 forbid).
  assert.deepEqual(Object.keys(handoff.payload), ['lastPayload']);
  assert.equal(handoff.payload.lastPayload, 24);

  // sourceVariableDigests records exactly the one variable read, not all 25.
  assert.equal(handoff.sourceVariableDigests.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Literal + runtime mapping expressions contribute no source digest but
//    still appear in the payload.
// ---------------------------------------------------------------------------

test('literal and runtime mapping expressions resolve without a source variable digest', () => {
  const store = new InMemoryLifecycleVariableStore();
  recordStage(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
  });

  const handoff = buildScenarioHandoff({
    targetStageId: 'compute',
    inputMapping: {
      title: '$.stages.draft.ports.campaignDraft.title',
      constant: { literal: { region: 'EU' } },
      project: { runtime: 'projectId' },
    },
    rootInput: { initiative: 'q2-growth' },
    runtime: baselineRuntime({ stageId: 'compute', projectId: 42 }),
    store,
    completedStageIds: ['draft'],
  });

  assert.deepEqual(handoff.payload.constant, { region: 'EU' });
  assert.equal(handoff.payload.project, 42);
  assert.equal(handoff.payload.title, 'Spring Sale');

  // Only the path expression sourced a declared variable.
  const draftVar = store.resolve({ stageId: 'draft', portName: 'campaignDraft' });
  assert.deepEqual(handoff.sourceVariableDigests, [draftVar.digest]);
});

// ---------------------------------------------------------------------------
// 8. buildStageVariables uses the generic schema placeholder for ports
//    without a declared schema (legacy compatibility).
// ---------------------------------------------------------------------------

test('ports without a declared schema fall back to the generic lifecycle-variable schema', () => {
  const { variables } = buildStageVariables({
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    // No portSchemaIds provided.
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
  });
  assert.equal(variables[0].schemaId, LIFECYCLE_VARIABLE_GENERIC_SCHEMA);
});

// ---------------------------------------------------------------------------
// 9. A mapping that reads the root input lands on lifecycleInput (no source
//    variable digest — root input is not a stage output).
// ---------------------------------------------------------------------------

test('root-input reads resolve from lifecycleInput and contribute no source variable digest', () => {
  const store = new InMemoryLifecycleVariableStore();
  recordStage(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    mappedOutput: { campaignDraft: { title: 'Spring Sale' } },
  });

  const handoff = buildScenarioHandoff({
    targetStageId: 'compute',
    inputMapping: {
      initiative: '$.lifecycleInput.initiative',
    },
    rootInput: { initiative: 'q2-growth' },
    runtime: baselineRuntime({ stageId: 'compute' }),
    store,
    completedStageIds: ['draft'],
  });

  assert.equal(handoff.payload.initiative, 'q2-growth');
  // Root-input read contributes no declared-variable digest.
  assert.deepEqual(handoff.sourceVariableDigests, []);
});

// ---------------------------------------------------------------------------
// 10. listForStage returns ports in stable port-name order (deterministic).
// ---------------------------------------------------------------------------

test('listForStage returns ports in stable port-name order', () => {
  const store = new InMemoryLifecycleVariableStore();
  recordStage(store, {
    stageId: 'draft',
    stageRunId: 10,
    processRunId: 100,
    // Insertion order is non-alphabetical:
    mappedOutput: { zeta: 1, alpha: 2, mid: 3 },
  });
  const ports = store.listForStage('draft').map((v) => v.portName);
  assert.deepEqual(ports, ['alpha', 'mid', 'zeta']);
});
