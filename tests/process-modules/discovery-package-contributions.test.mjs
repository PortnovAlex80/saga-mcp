// tests/process-modules/discovery-package-contributions.test.mjs
//
// W9-A2 — Tests for the Discovery package-local contributions.
//
// Validates that the five contribution categories declared under
// `src/process-modules/modules/discovery/package/contributions/` plus the
// to the Wave 1 SPI shapes:
//   - tool contributions: every ModuleToolContribution validates.
//   - acceptance capabilities: capability requirements + guard bindings.
//   - output contracts: input/output contract refs + declared outcomes.
//   - reviewer skills: pinned skill resource index entries.
//
// These tests run against the compiled dist/ output (the contributions are
// pure data, so this is a structural + cross-reference conformance check).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISCOVERY_TOOL_CONTRIBUTIONS,
  DISCOVERY_TOOL_NAMESPACE,
  DISCOVERY_TOOL_RESOURCE_IDS,
  DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_GET_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION,
  DISCOVERY_READINESS_GET_CONTRIBUTION,
  DISCOVERY_READINESS_SUBMIT_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION,
  DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION,
  DISCOVERY_WORKER_DONE_CONTRIBUTION,
} from '../../dist/process-modules/modules/discovery/package/contributions/tool-contributions.js';

import {
  DISCOVERY_CAPABILITY_REQUIREMENTS,
  DISCOVERY_GUARD_BINDINGS,
  DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DISCOVERY_CAP_RUNTIME_PERSISTENCE,
} from '../../dist/process-modules/modules/discovery/package/contributions/acceptance-capabilities.js';

import {
  DISCOVERY_INPUT_CONTRACT,
  DISCOVERY_OUTPUT_CONTRACT,
  DISCOVERY_NODE_OUTPUT_CONTRACTS,
  DISCOVERY_DECLARED_OUTCOMES,
  DISCOVERY_OUTCOME_CODES,
} from '../../dist/process-modules/modules/discovery/package/contributions/output-contracts.js';

import {
  DISCOVERY_SKILL_RESOURCES,
  DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES,
  DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL,
  DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL,
} from '../../dist/process-modules/modules/discovery/package/contributions/reviewer-skills.js';

import {
  DISCOVERY_PACKAGE_HANDLER_IDS,
  portInjectedEnsureDiscoveryBrief,
  createDiscoveryPackageHandlerAdapter,
  createFakeDiscoveryBriefProvisioningPort,
} from '../../dist/process-modules/modules/discovery/package/contributions/handler-adapter.js';

// Barrel re-exports everything from one path — verify that too.
import * as barrel from '../../dist/process-modules/modules/discovery/package/contributions/index.js';

// ---------------------------------------------------------------------------
// Tool contributions.
// ---------------------------------------------------------------------------

test('W9-A2 tool contributions: declares exactly nine MCP tools', () => {
  assert.equal(DISCOVERY_TOOL_CONTRIBUTIONS.length, 9);
  const ids = DISCOVERY_TOOL_CONTRIBUTIONS.map((c) => c.logicalId).sort();
  assert.deepEqual(ids, [
    'discovery.artifact_create.brief',
    'discovery.diagnosis_get',
    'discovery.diagnosis_submit',
    'discovery.normalization_get',
    'discovery.normalization_submit',
    'discovery.proposal_submit',
    'discovery.readiness_get',
    'discovery.readiness_submit',
    'discovery.worker_done',
  ]);
});

test('W9-A2 tool contributions: every logical id is namespaced under discovery', () => {
  for (const c of DISCOVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(
      c.logicalId.startsWith(`${DISCOVERY_TOOL_NAMESPACE}.`),
      `${c.logicalId} is not namespaced under ${DISCOVERY_TOOL_NAMESPACE}`,
    );
  }
});

test('W9-A2 tool contributions: every contribution has non-empty contract refs and handler ref', () => {
  for (const c of DISCOVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(c.version.length > 0, 'version must be non-empty');
    assert.ok(c.handlerRef.length > 0, 'handlerRef must be non-empty');
    assert.ok(c.inputContractRef.schemaId.length > 0, 'input schemaId must be non-empty');
    assert.ok(c.inputContractRef.version.length > 0, 'input version must be non-empty');
    assert.ok(c.inputContractRef.digest.length > 0, 'input digest must be non-empty');
    assert.ok(c.outputContractRef.schemaId.length > 0, 'output schemaId must be non-empty');
    assert.ok(c.outputContractRef.version.length > 0, 'output version must be non-empty');
    assert.ok(c.outputContractRef.digest.length > 0, 'output digest must be non-empty');
  }
});

test('W9-A2 tool contributions: idempotency and side-effect enums are valid', () => {
  const validIdempotency = new Set(['none', 'idempotent']);
  const validSideEffect = new Set(['none', 'read', 'write', 'external']);
  for (const c of DISCOVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(validIdempotency.has(c.idempotency), `bad idempotency: ${c.idempotency}`);
    assert.ok(validSideEffect.has(c.sideEffect), `bad sideEffect: ${c.sideEffect}`);
  }
});

test('W9-A2 tool contributions: every contribution carries at least one guard binding', () => {
  for (const c of DISCOVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(Array.isArray(c.guardBindings), 'guardBindings must be an array');
    assert.ok(c.guardBindings.length > 0, 'guardBindings must be non-empty');
    for (const g of c.guardBindings) {
      assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
      assert.ok(g.scope.length > 0, 'guard scope must be non-empty');
    }
  }
});

test('W9-A2 tool contributions: read tools are idempotent; submit/worker_done are not', () => {
  // *_get tools are pure reads — idempotent.
  assert.equal(DISCOVERY_NORMALIZATION_GET_CONTRIBUTION.idempotency, 'idempotent');
  assert.equal(DISCOVERY_READINESS_GET_CONTRIBUTION.idempotency, 'idempotent');
  assert.equal(DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION.idempotency, 'idempotent');
  // *_submit and worker_done are single-shot by the dispatcher fence — not idempotent.
  assert.equal(DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION.idempotency, 'none');
  assert.equal(DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION.idempotency, 'none');
  assert.equal(DISCOVERY_READINESS_SUBMIT_CONTRIBUTION.idempotency, 'none');
  assert.equal(DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION.idempotency, 'none');
  assert.equal(DISCOVERY_WORKER_DONE_CONTRIBUTION.idempotency, 'none');
  // Brief auto-provisioning is INSERT-guarded — idempotent.
  assert.equal(DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION.idempotency, 'idempotent');
});

test('W9-A2 tool contributions: get tools are read-side-effect; others are write', () => {
  assert.equal(DISCOVERY_NORMALIZATION_GET_CONTRIBUTION.sideEffect, 'read');
  assert.equal(DISCOVERY_READINESS_GET_CONTRIBUTION.sideEffect, 'read');
  assert.equal(DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION.sideEffect, 'read');
  assert.equal(DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DISCOVERY_READINESS_SUBMIT_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DISCOVERY_WORKER_DONE_CONTRIBUTION.sideEffect, 'write');
});

test('W9-A2 tool contributions: diagnosis_submit carries the diagnosis-advisory guard', () => {
  // The diagnosis must never alter the outcome — the advisory guard enforces this.
  const refs = DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(refs.includes('guard.saga.diagnosis-advisory'));
});

test('W9-A2 tool contributions: resource ids reference package-local call templates + checklists', () => {
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.proposalCallTemplate.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.normalizationGetCallTemplate.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.readinessGetCallTemplate.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.diagnosisGetCallTemplate.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.briefArtifactCallTemplate.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.proposalChecklist.startsWith(DISCOVERY_TOOL_NAMESPACE));
  assert.ok(DISCOVERY_TOOL_RESOURCE_IDS.nodeChecklist.startsWith(DISCOVERY_TOOL_NAMESPACE));
});

// ---------------------------------------------------------------------------
// Acceptance capabilities.
// ---------------------------------------------------------------------------

test('W9-A2 acceptance capabilities: declares required platform capabilities', () => {
  assert.ok(DISCOVERY_CAPABILITY_REQUIREMENTS.length >= 4);
  const refs = new Set(DISCOVERY_CAPABILITY_REQUIREMENTS.map((c) => c.ref));
  assert.ok(refs.has(DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER.ref));
  assert.ok(refs.has(DISCOVERY_CAP_RUNTIME_PERSISTENCE.ref));
});

test('W9-A2 acceptance capabilities: every requirement has non-empty ref + version', () => {
  for (const c of DISCOVERY_CAPABILITY_REQUIREMENTS) {
    assert.ok(c.ref.length > 0, 'ref must be non-empty');
    assert.ok(c.version.length > 0, 'version must be non-empty');
    if (c.optional !== undefined) {
      assert.equal(typeof c.optional, 'boolean', 'optional must be boolean if present');
    }
  }
});

test('W9-A2 acceptance capabilities: at least one capability is optional (LM persistence fallback)', () => {
  const optional = DISCOVERY_CAPABILITY_REQUIREMENTS.filter((c) => c.optional === true);
  assert.ok(optional.length >= 1, 'expected at least one optional capability');
});

test('W9-A2 acceptance capabilities: guard bindings cover call, submit scopes', () => {
  const scopes = new Set(DISCOVERY_GUARD_BINDINGS.map((g) => g.scope));
  assert.ok(scopes.has('call'), 'missing call-scope guard');
  assert.ok(scopes.has('submit'), 'missing submit-scope guard');
  for (const g of DISCOVERY_GUARD_BINDINGS) {
    assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
  }
});

test('W9-A2 acceptance capabilities: diagnosis-advisory guard is declared package-wide', () => {
  const refs = DISCOVERY_GUARD_BINDINGS.map((g) => g.ref);
  assert.ok(refs.includes('guard.saga.diagnosis-advisory'));
});

// ---------------------------------------------------------------------------
// Output contracts.
// ---------------------------------------------------------------------------

test('W9-A2 output contracts: input + output contract refs are the saga3 discovery schemas', () => {
  assert.equal(DISCOVERY_INPUT_CONTRACT.schemaId, 'factory.discovery-case.v1');
  assert.equal(DISCOVERY_OUTPUT_CONTRACT.schemaId, 'factory.discovery-outcome-certificate.v1');
});

test('W9-A2 output contracts: every node output contract has a valid saga3 schema id', () => {
  for (const c of DISCOVERY_NODE_OUTPUT_CONTRACTS) {
    assert.ok(c.schemaId.startsWith('factory.'), `${c.schemaId} is not a saga3 schema`);
    assert.ok(c.version.length > 0, 'version must be non-empty');
    assert.ok(c.digest.length > 0, 'digest must be non-empty');
  }
});

test('W9-A2 output contracts: node output contracts cover proposal/normalization/readiness/diagnosis/brief', () => {
  const ids = DISCOVERY_NODE_OUTPUT_CONTRACTS.map((c) => c.schemaId);
  assert.ok(ids.includes('factory.discovery-proposal.v1'));
  assert.ok(ids.includes('factory.discovery-normalization-proposal.v1'));
  assert.ok(ids.includes('factory.discovery-readiness-assessment.v2'));
  assert.ok(ids.includes('factory.discovery-diagnosis.v1'));
  assert.ok(ids.includes('factory.discovery-brief.v1'));
});

test('W9-A2 output contracts: declared outcomes are all terminal and match the discovery flow', () => {
  // 'defer' and 'inconclusive' deleted (no runtime producer).
  const expected = ['go', 'clarify', 'reject', 'failed'];
  assert.deepEqual([...DISCOVERY_OUTCOME_CODES].sort(), [...expected].sort());
  for (const o of DISCOVERY_DECLARED_OUTCOMES) {
    assert.equal(o.terminal, true, `${o.outcome} must be terminal`);
    assert.ok(o.description.length > 0, `${o.outcome} needs a description`);
  }
});

// ---------------------------------------------------------------------------
// Reviewer skills.
// ---------------------------------------------------------------------------

test('W9-A2 reviewer skills: declares both advisory reviewer skills (readiness + diagnosis)', () => {
  assert.equal(DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL.kind, 'reviewer-skill');
  assert.equal(DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL.kind, 'reviewer-skill');
  assert.ok(DISCOVERY_READINESS_ADVISOR_REVIEWER_SKILL.path.endsWith('SKILL.md'));
  assert.ok(DISCOVERY_DIAGNOSIS_ADVISOR_REVIEWER_SKILL.path.endsWith('SKILL.md'));
});

test('W9-A2 reviewer skills: every skill resource has a unique logical id', () => {
  const ids = DISCOVERY_SKILL_RESOURCES.map((s) => s.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate skill logical ids');
});

test('W9-A2 reviewer skills: resource index entries strip package-local metadata', () => {
  assert.equal(DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES.length, DISCOVERY_SKILL_RESOURCES.length);
  for (const e of DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES) {
    assert.ok(e.logicalId.length > 0);
    assert.ok(e.path.length > 0);
    assert.ok(typeof e.kind === 'string');
    assert.ok(e.digest.length > 0);
    // The stripped entry must NOT carry the package-local extension fields.
    assert.equal('pinnedByProfile' in e, false, 'pinnedByProfile must be stripped');
    assert.equal('slot' in e, false, 'slot must be stripped');
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test('W9-A2 unsupported adapter: exposes the discovery handler ids', () => {
  assert.equal(DISCOVERY_PACKAGE_HANDLER_IDS.resolveProposalSubmission, 'discovery-resolve-proposal-submission');
  assert.equal(DISCOVERY_PACKAGE_HANDLER_IDS.settle, 'discovery-settlement-policy');
});

test('W9-A2 unsupported adapter: fake brief-provisioning port records calls', () => {
  const fake = createFakeDiscoveryBriefProvisioningPort([
    { status: 'brief-created', briefArtifactId: 42 },
  ]);
  const outcome = fake.provisionDiscoveryBrief({
    projectId: 1,
    epicId: 2,
    processRunId: 3,
    proposalPayload: null,
  });
  assert.equal(outcome.status, 'brief-created');
  assert.equal(outcome.briefArtifactId, 42);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].ctx.epicId, 2);
});

test('W9-A2 unsupported adapter: portInjectedEnsureDiscoveryBrief fails without an epic', () => {
  const fake = createFakeDiscoveryBriefProvisioningPort();
  const outcome = portInjectedEnsureDiscoveryBrief(fake, {
    projectId: 1,
    epicId: null,
    processRunId: 3,
  }, null);
  assert.equal(outcome.status, 'provisioning-failed');
  assert.ok(outcome.reason.length > 0);
  // The port must NOT have been called when there is no epic.
  assert.equal(fake.calls.length, 0);
});

test('W9-A2 unsupported adapter: portInjectedEnsureDiscoveryBrief delegates to the port with an epic', () => {
  const fake = createFakeDiscoveryBriefProvisioningPort([
    { status: 'already-provisioned', briefArtifactId: 7 },
  ]);
  const outcome = portInjectedEnsureDiscoveryBrief(fake, {
    projectId: 1,
    epicId: 5,
    processRunId: 9,
  }, null);
  assert.equal(outcome.status, 'already-provisioned');
  assert.equal(outcome.briefArtifactId, 7);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].ctx.epicId, 5);
  assert.equal(fake.calls[0].ctx.processRunId, 9);
});

test('W9-A2 unsupported adapter: createDiscoveryPackageHandlerAdapter wraps the proposal resolver', () => {
  // The adapter is constructed from a runtime-persistence fake. We only need
  // to confirm the adapter produces a handler map keyed by the discovery
  // handler ids and that the target handler is wrapped (a function).
  const fakeRuntime = {
    // construction time, only the adapter wraps them. We need the methods the
    // factory closes over to exist as no-ops so the map builds.
    readRawSubmissionForExecution: () => null,
    readLatestRawSubmission: () => null,
    readProposalForExecution: () => null,
    readLatestProposal: () => null,
    readProposalForSettlement: () => null,
    ensureNormalizationControl: () => ({}),
    readRawSubmission: () => null,
    readNormalizationProposalForExecution: () => null,
    readLatestNormalizationProposal: () => null,
    ensureReadinessControl: () => ({}),
    readReadinessAssessmentForExecution: () => null,
    readLatestReadinessAssessment: () => null,
    readReadinessAssessment: () => null,
    readOutcomeCertificate: () => null,
    setControlIntentStatus: () => {},
    setReadinessControlStatus: () => {},
    setIntentStatus: () => {},
  };
  const fakePort = createFakeDiscoveryBriefProvisioningPort();
  const handlers = createDiscoveryPackageHandlerAdapter({
    // Wave 8 MEDIUM 7: settlementService is now a required injected port.
    // This test only checks handler-map construction (no settlement is
    // invoked), so a stub settle() suffices.
    kernelDeps: { runtimePersistence: fakeRuntime, settlementService: { settle: async () => { throw new Error('not used'); } } },
    ports: { briefProvisioning: fakePort },
  });
  // Every discovery handler id is present.
  for (const id of Object.values(DISCOVERY_PACKAGE_HANDLER_IDS)) {
    assert.ok(typeof handlers[id] === 'function', `handler ${id} must be a function`);
  }
  // The proposal-submission resolver is the wrapped target.
  assert.ok(typeof handlers[DISCOVERY_PACKAGE_HANDLER_IDS.resolveProposalSubmission] === 'function');
});

test('W9-A2 unsupported adapter: throws on unknown handler id', () => {
  const fakeRuntime = {};
  const fakePort = createFakeDiscoveryBriefProvisioningPort();
  assert.throws(
    () =>
      createDiscoveryPackageHandlerAdapter({
        kernelDeps: { runtimePersistence: fakeRuntime, settlementService: { settle: async () => { throw new Error('not used'); } } },
        ports: { briefProvisioning: fakePort },
        briefProvisioningHandlerId: 'discovery-nonexistent',
      }),
    /unknown handler id/,
  );
});

// ---------------------------------------------------------------------------
// Barrel.
// ---------------------------------------------------------------------------

test('W9-A2 barrel: re-exports all five contribution categories + the adapter', () => {
  // Tool contributions.
  assert.ok(typeof barrel.DISCOVERY_TOOL_CONTRIBUTIONS === 'object');
  // Acceptance capabilities.
  assert.ok(typeof barrel.DISCOVERY_CAPABILITY_REQUIREMENTS === 'object');
  assert.ok(typeof barrel.DISCOVERY_GUARD_BINDINGS === 'object');
  // Output contracts.
  assert.ok(typeof barrel.DISCOVERY_INPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DISCOVERY_OUTPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DISCOVERY_DECLARED_OUTCOMES === 'object');
  // Reviewer skills.
  assert.ok(typeof barrel.DISCOVERY_SKILL_RESOURCE_INDEX_ENTRIES === 'object');
  assert.equal(typeof barrel.createDiscoveryPackageHandlerAdapter, 'function');
  assert.equal(typeof barrel.createFakeDiscoveryBriefProvisioningPort, 'function');
  assert.equal(typeof barrel.portInjectedEnsureDiscoveryBrief, 'function');
});

test('W9-A2 barrel: re-exported aggregates match the per-file aggregates', () => {
  assert.equal(barrel.DISCOVERY_TOOL_CONTRIBUTIONS, DISCOVERY_TOOL_CONTRIBUTIONS);
  assert.equal(barrel.DISCOVERY_CAPABILITY_REQUIREMENTS, DISCOVERY_CAPABILITY_REQUIREMENTS);
  assert.equal(barrel.DISCOVERY_GUARD_BINDINGS, DISCOVERY_GUARD_BINDINGS);
});
