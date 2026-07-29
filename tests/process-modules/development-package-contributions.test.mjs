// tests/process-modules/development-package-contributions.test.mjs
//
// W9-A4 — Tests for the Development package-local contributions.
//
// Validates that the five contribution categories declared under
// `src/process-modules/modules/development/package/contributions/` plus the
// legacy engine adapter are well-formed, internally consistent, and conform
// to the Wave 1 SPI shapes:
//   - tool contributions: every ModuleToolContribution validates.
//   - acceptance capabilities: capability requirements + guard bindings.
//   - output contracts: input/output contract refs + declared outcomes.
//   - reviewer skills: pinned skill resource index entries.
//   - recovery policies: per-node recovery action maps (valid actions only).
//   - legacy engine adapter: port-injected candidate-observation wrapper.
//
// These tests run against the compiled dist/ output (the contributions are
// pure data, so this is a structural + cross-reference conformance check).
//
// Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
// Task: docs/refactor-management/05-subagent-tasks/W09-a4.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateModuleToolContribution,
  validateCapabilityRequirement,
  validateGuardBinding,
} from '../../dist/process-modules/domain/spi/tool-contribution.js';
import {
  validateRecoveryPolicyBinding,
  RECOVERY_ACTIONS,
} from '../../dist/process-modules/domain/spi/recovery-definitions.js';
import { RESOURCE_KINDS } from '../../dist/process-modules/domain/spi/resource-index.js';

import {
  DEVELOPMENT_TOOL_CONTRIBUTIONS,
  DEVELOPMENT_TOOL_NAMESPACE,
  DEVELOPMENT_TOOL_RESOURCE_IDS,
  DEVELOPMENT_PROCESS_NODE_SUBMIT_CONTRIBUTION,
  DEVELOPMENT_VERIFICATION_RECORD_CONTRIBUTION,
  DEVELOPMENT_PLANNER_WORKER_DONE_CONTRIBUTION,
  DEVELOPMENT_VERIFIER_WORKER_DONE_CONTRIBUTION,
} from '../../dist/process-modules/modules/development/package/contributions/tool-contributions.js';

import {
  DEVELOPMENT_CAPABILITY_REQUIREMENTS,
  DEVELOPMENT_GUARD_BINDINGS,
  DEVELOPMENT_CAP_MANAGED_PRODUCTION_LEDGER,
  DEVELOPMENT_CAP_TASK_GRAPH_PERSISTENCE,
  DEVELOPMENT_GUARD_EVIDENCE_PINS_CANDIDATE,
  DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE,
} from '../../dist/process-modules/modules/development/package/contributions/acceptance-capabilities.js';

import {
  DEVELOPMENT_INPUT_CONTRACT,
  DEVELOPMENT_OUTPUT_CONTRACT,
  DEVELOPMENT_CERTIFICATE_CONTRACT,
  DEVELOPMENT_NODE_OUTPUT_CONTRACTS,
  DEVELOPMENT_DECLARED_OUTCOMES,
  DEVELOPMENT_OUTCOME_CODES,
} from '../../dist/process-modules/modules/development/package/contributions/output-contracts.js';

import {
  DEVELOPMENT_SKILL_RESOURCES,
  DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES,
  DEVELOPMENT_PLANNING_REVIEWER_SKILL,
  DEVELOPMENT_PLANNER_SKILL,
  DEVELOPMENT_VERIFIER_SKILL,
} from '../../dist/process-modules/modules/development/package/contributions/reviewer-skills.js';

import {
  DEVELOPMENT_RECOVERY_POLICY_BINDINGS,
  DEVELOPMENT_RECOVERY_TRIGGERS,
} from '../../dist/process-modules/modules/development/package/contributions/recovery-policies.js';

import {
  DEVELOPMENT_PACKAGE_HANDLER_IDS,
  portInjectedObserveDevelopmentCandidate,
  createDevelopmentPackageHandlerAdapter,
  createFakeDevelopmentCandidateObservationPort,
} from '../../dist/process-modules/modules/development/package/contributions/legacy-engine-adapter.js';

// Barrel re-exports everything from one path — verify that too.
import * as barrel from '../../dist/process-modules/modules/development/package/contributions/index.js';

// ---------------------------------------------------------------------------
// Tool contributions.
// ---------------------------------------------------------------------------

test('W9-A4 tool contributions: declares exactly four MCP tools', () => {
  assert.equal(DEVELOPMENT_TOOL_CONTRIBUTIONS.length, 4);
  const ids = DEVELOPMENT_TOOL_CONTRIBUTIONS.map((c) => c.logicalId).sort();
  assert.deepEqual(ids, [
    'development.planner.worker_done',
    'development.process_node_submit',
    'development.verification_record',
    'development.verifier.worker_done',
  ]);
});

test('W9-A4 tool contributions: every logical id is namespaced under development', () => {
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
    assert.ok(
      c.logicalId.startsWith(`${DEVELOPMENT_TOOL_NAMESPACE}.`),
      `${c.logicalId} is not namespaced under ${DEVELOPMENT_TOOL_NAMESPACE}`,
    );
  }
});

test('W9-A4 tool contributions: every contribution validates against the Wave 1 SPI', async () => {
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
    const r = await validateModuleToolContribution(c);
    assert.ok(r.ok, `invalid contribution ${c.logicalId}: ${JSON.stringify(r.errors)}`);
  }
});

test('W9-A4 tool contributions: every contribution has non-empty contract refs and handler ref', () => {
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
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

test('W9-A4 tool contributions: idempotency and side-effect enums are valid', () => {
  const validIdempotency = new Set(['none', 'idempotent']);
  const validSideEffect = new Set(['none', 'read', 'write', 'external']);
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
    assert.ok(validIdempotency.has(c.idempotency), `bad idempotency: ${c.idempotency}`);
    assert.ok(validSideEffect.has(c.sideEffect), `bad sideEffect: ${c.sideEffect}`);
  }
});

test('W9-A4 tool contributions: every contribution carries at least one guard binding', async () => {
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
    assert.ok(Array.isArray(c.guardBindings), 'guardBindings must be an array');
    assert.ok(c.guardBindings.length > 0, 'guardBindings must be non-empty');
    for (const g of c.guardBindings) {
      const r = await validateGuardBinding(g);
      assert.ok(r.ok, `invalid guard on ${c.logicalId}: ${JSON.stringify(r.errors)}`);
    }
  }
});

test('W9-A4 tool contributions: submit/record/worker_done are single-shot writes (not idempotent)', () => {
  // All four development tools are single-shot by the dispatcher fence — not idempotent.
  for (const c of DEVELOPMENT_TOOL_CONTRIBUTIONS) {
    assert.equal(c.idempotency, 'none', `${c.logicalId} must be single-shot`);
    assert.equal(c.sideEffect, 'write', `${c.logicalId} must be a write`);
  }
});

test('W9-A4 tool contributions: verification_record carries the evidence-pins-candidate guard', () => {
  // Evidence must pin BOTH the AC hash AND the frozen candidate hash.
  const refs = DEVELOPMENT_VERIFICATION_RECORD_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(refs.includes('guard.saga.evidence-pins-candidate'));
});

test('W9-A4 tool contributions: process_node_submit targets the task-graph-proposal schema', () => {
  assert.equal(
    DEVELOPMENT_PROCESS_NODE_SUBMIT_CONTRIBUTION.inputContractRef.schemaId,
    'saga3.development-task-graph-proposal.v1',
  );
});

test('W9-A4 tool contributions: resource ids reference package-local call templates + checklists', () => {
  assert.ok(
    DEVELOPMENT_TOOL_RESOURCE_IDS.planningSubmissionCallTemplate.startsWith('planning-'),
  );
  assert.ok(
    DEVELOPMENT_TOOL_RESOURCE_IDS.verificationEvidenceRecordCallTemplate.startsWith('verification-'),
  );
  assert.ok(
    DEVELOPMENT_TOOL_RESOURCE_IDS.planningWorkerDoneCallTemplate.startsWith('planning-'),
  );
  assert.ok(
    DEVELOPMENT_TOOL_RESOURCE_IDS.verificationWorkerDoneCallTemplate.startsWith('verification-'),
  );
  // Package-wide checklist + error hints are namespaced under development.
  assert.ok(
    DEVELOPMENT_TOOL_RESOURCE_IDS.nodeChecklist.startsWith(DEVELOPMENT_TOOL_NAMESPACE),
  );
});

// ---------------------------------------------------------------------------
// Acceptance capabilities.
// ---------------------------------------------------------------------------

test('W9-A4 acceptance capabilities: declares required platform capabilities', () => {
  assert.ok(DEVELOPMENT_CAPABILITY_REQUIREMENTS.length >= 6);
  const refs = new Set(DEVELOPMENT_CAPABILITY_REQUIREMENTS.map((c) => c.ref));
  assert.ok(refs.has(DEVELOPMENT_CAP_MANAGED_PRODUCTION_LEDGER.ref));
  assert.ok(refs.has(DEVELOPMENT_CAP_TASK_GRAPH_PERSISTENCE.ref));
});

test('W9-A4 acceptance capabilities: every requirement validates against the Wave 1 SPI', async () => {
  for (const c of DEVELOPMENT_CAPABILITY_REQUIREMENTS) {
    const r = await validateCapabilityRequirement(c);
    assert.ok(r.ok, `invalid capability ${c.ref}: ${JSON.stringify(r.errors)}`);
  }
});

test('W9-A4 acceptance capabilities: at least one capability is optional (LM persistence fallback)', () => {
  const optional = DEVELOPMENT_CAPABILITY_REQUIREMENTS.filter((c) => c.optional === true);
  assert.ok(optional.length >= 1, 'expected at least one optional capability');
});

test('W9-A4 acceptance capabilities: guard bindings cover call, submit, node scopes', async () => {
  const scopes = new Set(DEVELOPMENT_GUARD_BINDINGS.map((g) => g.scope));
  assert.ok(scopes.has('call'), 'missing call-scope guard');
  assert.ok(scopes.has('submit'), 'missing submit-scope guard');
  assert.ok(scopes.has('node'), 'missing node-scope guard');
  for (const g of DEVELOPMENT_GUARD_BINDINGS) {
    const r = await validateGuardBinding(g);
    assert.ok(r.ok, `invalid guard ${g.ref}: ${JSON.stringify(r.errors)}`);
  }
});

test('W9-A4 acceptance capabilities: evidence-pins-candidate + candidate-immutable guards declared', () => {
  const refs = DEVELOPMENT_GUARD_BINDINGS.map((g) => g.ref);
  assert.ok(refs.includes(DEVELOPMENT_GUARD_EVIDENCE_PINS_CANDIDATE.ref));
  assert.ok(refs.includes(DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE.ref));
  // Candidate immutability spans the whole post-freeze node.
  assert.equal(DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE.scope, 'node');
});

// ---------------------------------------------------------------------------
// Output contracts.
// ---------------------------------------------------------------------------

test('W9-A4 output contracts: input + output contract refs are the saga3 development schemas', () => {
  assert.equal(DEVELOPMENT_INPUT_CONTRACT.schemaId, 'saga3.development-case.v1');
  assert.equal(DEVELOPMENT_OUTPUT_CONTRACT.schemaId, 'saga3.verified-integration-bundle.v1');
  assert.equal(DEVELOPMENT_CERTIFICATE_CONTRACT.schemaId, 'saga3.development-certificate.v1');
});

test('W9-A4 output contracts: every node output contract has a valid saga3 schema id', () => {
  for (const c of DEVELOPMENT_NODE_OUTPUT_CONTRACTS) {
    assert.ok(c.schemaId.startsWith('saga3.'), `${c.schemaId} is not a saga3 schema`);
    assert.ok(c.version.length > 0, 'version must be non-empty');
    assert.ok(c.digest.length > 0, 'digest must be non-empty');
  }
});

test('W9-A4 output contracts: node output contracts cover proposal/graph/workset/candidate/verification', () => {
  const ids = DEVELOPMENT_NODE_OUTPUT_CONTRACTS.map((c) => c.schemaId);
  assert.ok(ids.includes('saga3.development-task-graph-proposal.v1'));
  assert.ok(ids.includes('saga3.development-task-graph.v1'));
  assert.ok(ids.includes('saga3.development-implementation-workset.v1'));
  assert.ok(ids.includes('saga3.integrated-release-candidate.v1'));
  assert.ok(ids.includes('saga3.acceptance-verification-workset.v1'));
});

test('W9-A4 output contracts: declared outcomes are all terminal and match the development flow', () => {
  const expected = ['verified', 'rework-required', 'clarification-required', 'blocked', 'failed'];
  assert.deepEqual([...DEVELOPMENT_OUTCOME_CODES].sort(), [...expected].sort());
  for (const o of DEVELOPMENT_DECLARED_OUTCOMES) {
    assert.equal(o.terminal, true, `${o.outcome} must be terminal`);
    assert.ok(o.description.length > 0, `${o.outcome} needs a description`);
  }
});

// ---------------------------------------------------------------------------
// Reviewer skills.
// ---------------------------------------------------------------------------

test('W9-A4 reviewer skills: declares the planning reviewer skill', () => {
  assert.equal(DEVELOPMENT_PLANNING_REVIEWER_SKILL.kind, 'reviewer-skill');
  assert.ok(DEVELOPMENT_PLANNING_REVIEWER_SKILL.path.endsWith('SKILL.md'));
});

test('W9-A4 reviewer skills: planner + verifier execution skills are pinned', () => {
  assert.equal(DEVELOPMENT_PLANNER_SKILL.kind, 'skill');
  assert.equal(DEVELOPMENT_VERIFIER_SKILL.kind, 'skill');
  assert.ok(DEVELOPMENT_PLANNER_SKILL.path.endsWith('SKILL.md'));
  assert.ok(DEVELOPMENT_VERIFIER_SKILL.path.endsWith('SKILL.md'));
});

test('W9-A4 reviewer skills: every skill resource has a unique logical id', () => {
  const ids = DEVELOPMENT_SKILL_RESOURCES.map((s) => s.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate skill logical ids');
});

test('W9-A4 reviewer skills: every resource kind is in the frozen RESOURCE_KINDS set', () => {
  const validKinds = new Set(RESOURCE_KINDS);
  for (const s of DEVELOPMENT_SKILL_RESOURCES) {
    assert.ok(validKinds.has(s.kind), `unknown skill kind: ${s.kind}`);
  }
});

test('W9-A4 reviewer skills: resource index entries strip package-local metadata', () => {
  assert.equal(DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES.length, DEVELOPMENT_SKILL_RESOURCES.length);
  for (const e of DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES) {
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
// Recovery policies.
// ---------------------------------------------------------------------------

test('W9-A4 recovery policies: every binding validates against the Wave 1 SPI', async () => {
  for (const b of DEVELOPMENT_RECOVERY_POLICY_BINDINGS) {
    const r = await validateRecoveryPolicyBinding(b);
    assert.ok(r.ok, `invalid binding ${b.nodeId}: ${JSON.stringify(r.errors)}`);
  }
});

test('W9-A4 recovery policies: declares one binding per verifier node', () => {
  const nodeIds = DEVELOPMENT_RECOVERY_POLICY_BINDINGS.map((b) => b.nodeId).sort();
  assert.deepEqual(nodeIds, [
    'execute-implementation-workset',
    'integrate-release-candidate',
    'resolve-task-graph',
    'settle-development',
    'verify-acceptance-workset',
  ]);
});

test('W9-A4 recovery policies: every action is a valid RecoveryAction', () => {
  for (const b of DEVELOPMENT_RECOVERY_POLICY_BINDINGS) {
    assert.ok(b.nodeId.length > 0, 'nodeId must be non-empty');
    for (const [key, action] of Object.entries(b.actionMap)) {
      assert.ok(
        RECOVERY_ACTIONS.has(action),
        `${b.nodeId}.${key} has invalid action: ${action}`,
      );
    }
  }
});

test('W9-A4 recovery policies: repair-required routes the resolver back to the planner', () => {
  const resolver = DEVELOPMENT_RECOVERY_POLICY_BINDINGS.find(
    (b) => b.nodeId === 'resolve-task-graph',
  );
  assert.ok(resolver);
  assert.equal(
    resolver.actionMap[DEVELOPMENT_RECOVERY_TRIGGERS.repairRequired],
    'return-to-producer',
  );
});

test('W9-A4 recovery policies: candidate-drifted terminates (post-freeze mutation is unrecoverable)', () => {
  const integrate = DEVELOPMENT_RECOVERY_POLICY_BINDINGS.find(
    (b) => b.nodeId === 'integrate-release-candidate',
  );
  assert.ok(integrate);
  assert.equal(
    integrate.actionMap[DEVELOPMENT_RECOVERY_TRIGGERS.candidateDrifted],
    'terminate',
  );
  const verify = DEVELOPMENT_RECOVERY_POLICY_BINDINGS.find(
    (b) => b.nodeId === 'verify-acceptance-workset',
  );
  assert.ok(verify);
  assert.equal(
    verify.actionMap[DEVELOPMENT_RECOVERY_TRIGGERS.candidateDrifted],
    'terminate',
  );
});

test('W9-A4 recovery policies: settlement decision outcomes are terminal', () => {
  const settle = DEVELOPMENT_RECOVERY_POLICY_BINDINGS.find((b) => b.nodeId === 'settle-development');
  assert.ok(settle);
  assert.equal(settle.actionMap[DEVELOPMENT_RECOVERY_TRIGGERS.reworkRequired], 'terminate');
  assert.equal(settle.actionMap[DEVELOPMENT_RECOVERY_TRIGGERS.blocked], 'terminate');
});

// ---------------------------------------------------------------------------
// Legacy engine adapter.
// ---------------------------------------------------------------------------

test('W9-A4 legacy adapter: exposes the development handler + node ids', () => {
  // Kernel handler ids (address handlers in the handler map).
  assert.equal(DEVELOPMENT_PACKAGE_HANDLER_IDS.resolveTaskGraph, 'development-resolve-task-graph');
  assert.equal(DEVELOPMENT_PACKAGE_HANDLER_IDS.settle, 'development-settlement-policy');
  // Flow node ids live under `nodes` (disjoint from the handler-id keys).
  assert.equal(DEVELOPMENT_PACKAGE_HANDLER_IDS.nodes.settlement, 'settle-development');
  assert.equal(DEVELOPMENT_PACKAGE_HANDLER_IDS.nodes.verification, 'verify-acceptance-workset');
  assert.equal(DEVELOPMENT_PACKAGE_HANDLER_IDS.nodes.resolveTaskGraph, 'resolve-task-graph');
});

test('W9-A4 legacy adapter: fake candidate-observation port records calls', () => {
  const fake = createFakeDevelopmentCandidateObservationPort([
    { status: 'unchanged', observedCandidateHash: 'candidate-abc' },
  ]);
  const outcome = fake.observeDevelopmentCandidate({
    projectId: 1,
    epicId: 2,
    processRunId: 3,
    expectedCandidateHash: 'candidate-abc',
  });
  assert.equal(outcome.status, 'unchanged');
  assert.equal(outcome.observedCandidateHash, 'candidate-abc');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].ctx.epicId, 2);
});

test('W9-A4 legacy adapter: portInjectedObserveDevelopmentCandidate fails without an epic', () => {
  const fake = createFakeDevelopmentCandidateObservationPort();
  const outcome = portInjectedObserveDevelopmentCandidate(
    fake,
    { projectId: 1, epicId: null, processRunId: 3 },
    'candidate-abc',
  );
  assert.equal(outcome.status, 'observation-failed');
  assert.ok(outcome.reason.length > 0);
  // The port must NOT have been called when there is no epic.
  assert.equal(fake.calls.length, 0);
});

test('W9-A4 legacy adapter: portInjectedObserveDevelopmentCandidate delegates to the port with an epic', () => {
  const fake = createFakeDevelopmentCandidateObservationPort([
    { status: 'drifted', expectedCandidateHash: 'a', observedCandidateHash: 'b' },
  ]);
  const outcome = portInjectedObserveDevelopmentCandidate(
    fake,
    { projectId: 1, epicId: 5, processRunId: 9 },
    'a',
  );
  assert.equal(outcome.status, 'drifted');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].ctx.epicId, 5);
  assert.equal(fake.calls[0].ctx.processRunId, 9);
  assert.equal(fake.calls[0].ctx.expectedCandidateHash, 'a');
});

test('W9-A4 legacy adapter: createDevelopmentPackageHandlerAdapter wraps the settlement handler', () => {
  // The adapter is constructed from a minimal legacy-deps stub. The legacy
  // factory does not invoke the handlers at construction time, only the adapter
  // wraps them. We confirm the adapter produces a handler map keyed by the
  // development handler ids and that the target handler is wrapped (a function).
  const fakeLegacyDeps = {};
  const fakePort = createFakeDevelopmentCandidateObservationPort();
  const handlers = createDevelopmentPackageHandlerAdapter({
    legacyDeps: fakeLegacyDeps,
    ports: { candidateObservation: fakePort },
  });
  // Every development kernel handler id is present.
  assert.ok(
    typeof handlers[DEVELOPMENT_PACKAGE_HANDLER_IDS.resolveTaskGraph] === 'function',
    'resolveTaskGraph handler must be a function',
  );
  assert.ok(
    typeof handlers[DEVELOPMENT_PACKAGE_HANDLER_IDS.settle] === 'function',
    'settle handler must be a function',
  );
});

test('W9-A4 legacy adapter: throws on unknown handler id', () => {
  const fakeLegacyDeps = {};
  const fakePort = createFakeDevelopmentCandidateObservationPort();
  assert.throws(
    () =>
      createDevelopmentPackageHandlerAdapter({
        legacyDeps: fakeLegacyDeps,
        ports: { candidateObservation: fakePort },
        candidateObservationHandlerId: 'development-nonexistent',
      }),
    /unknown handler id/,
  );
});

// ---------------------------------------------------------------------------
// Barrel.
// ---------------------------------------------------------------------------

test('W9-A4 barrel: re-exports all five contribution categories + the adapter', () => {
  // Tool contributions.
  assert.ok(typeof barrel.DEVELOPMENT_TOOL_CONTRIBUTIONS === 'object');
  // Acceptance capabilities.
  assert.ok(typeof barrel.DEVELOPMENT_CAPABILITY_REQUIREMENTS === 'object');
  assert.ok(typeof barrel.DEVELOPMENT_GUARD_BINDINGS === 'object');
  // Output contracts.
  assert.ok(typeof barrel.DEVELOPMENT_INPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DEVELOPMENT_OUTPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DEVELOPMENT_DECLARED_OUTCOMES === 'object');
  // Reviewer skills.
  assert.ok(typeof barrel.DEVELOPMENT_SKILL_RESOURCE_INDEX_ENTRIES === 'object');
  // Recovery policies.
  assert.ok(typeof barrel.DEVELOPMENT_RECOVERY_POLICY_BINDINGS === 'object');
  // Legacy engine adapter.
  assert.equal(typeof barrel.createDevelopmentPackageHandlerAdapter, 'function');
  assert.equal(typeof barrel.createFakeDevelopmentCandidateObservationPort, 'function');
  assert.equal(typeof barrel.portInjectedObserveDevelopmentCandidate, 'function');
});

test('W9-A4 barrel: re-exported aggregates match the per-file aggregates', () => {
  assert.equal(barrel.DEVELOPMENT_TOOL_CONTRIBUTIONS, DEVELOPMENT_TOOL_CONTRIBUTIONS);
  assert.equal(barrel.DEVELOPMENT_CAPABILITY_REQUIREMENTS, DEVELOPMENT_CAPABILITY_REQUIREMENTS);
  assert.equal(barrel.DEVELOPMENT_GUARD_BINDINGS, DEVELOPMENT_GUARD_BINDINGS);
  assert.equal(barrel.DEVELOPMENT_RECOVERY_POLICY_BINDINGS, DEVELOPMENT_RECOVERY_POLICY_BINDINGS);
});
