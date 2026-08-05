// tests/process-modules/delivery-package-contributions.test.mjs
//
// W9-A6 — Tests for the Delivery package-local contributions.
//
// Validates that the contribution categories declared under
// `src/process-modules/modules/delivery/package/contributions/` are
// well-formed, internally consistent, and conform to the Wave 1 SPI shapes:
//   - tool contributions: every ModuleToolContribution validates.
//   - acceptance capabilities: capability requirements + guard bindings.
//   - output contracts: input/output contract refs + declared outcomes.
//   - external-effects subtree: publish-deploy / observe-release adapters.
//   - human-approval subtree: approve-release adapter + statuses.
//   - idempotency subtree: cross-run action-key strategy.
//   - ports subtree: module-local port declarations.
//   - receipts subtree: durable action-receipt / action-observation.
//
// These tests run against the compiled dist/ output (the contributions are
// pure data, so this is a structural + cross-reference conformance check).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELIVERY_TOOL_CONTRIBUTIONS,
  DELIVERY_TOOL_NAMESPACE,
  DELIVERY_TOOL_RESOURCE_IDS,
  DELIVERY_PREFLIGHT_RELEASE_CONTRIBUTION,
  DELIVERY_APPROVE_RELEASE_CONTRIBUTION,
  DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION,
  DELIVERY_OBSERVE_RELEASE_CONTRIBUTION,
  DELIVERY_SETTLE_DELIVERY_CONTRIBUTION,
  DELIVERY_RECORD_RELEASE_CONTRIBUTION,
} from '../../dist/process-modules/modules/delivery/package/contributions/tool-contributions.js';

import {
  DELIVERY_CAPABILITY_REQUIREMENTS,
  DELIVERY_GUARD_BINDINGS,
  DELIVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DELIVERY_CAP_RUNTIME_PERSISTENCE,
  DELIVERY_CAP_OUTPUT_REPOSITORY,
  DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY,
  DELIVERY_GUARD_NO_DEFAULT_PROVIDER,
  DELIVERY_GUARD_PUSH_IS_NOT_RELEASE,
  DELIVERY_GUARD_CANDIDATE_IMMUTABLE,
} from '../../dist/process-modules/modules/delivery/package/contributions/acceptance-capabilities.js';

import {
  DELIVERY_INPUT_CONTRACT,
  DELIVERY_OUTPUT_CONTRACT,
  DELIVERY_RELEASE_RECORD_CONTRACT,
  DELIVERY_NODE_OUTPUT_CONTRACTS,
  DELIVERY_DECLARED_OUTCOMES,
  DELIVERY_OUTCOME_CODES,
} from '../../dist/process-modules/modules/delivery/package/contributions/output-contracts.js';

import {
  DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS,
  DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION,
  DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION,
  DELIVERY_EXTERNAL_RECEIPT_EVIDENCE,
  DELIVERY_RELEASE_ACTION_KINDS,
} from '../../dist/process-modules/modules/delivery/package/contributions/external-effects.js';

import {
  DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS,
  DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION,
  DELIVERY_HUMAN_RECEIPT_EVIDENCE,
  DELIVERY_APPROVAL_STATUSES,
} from '../../dist/process-modules/modules/delivery/package/contributions/human-approval.js';

import {
  DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS,
  DELIVERY_IDEMPOTENCY_STRATEGY,
  DELIVERY_IDEMPOTENT_TOOL_IDS,
  DELIVERY_ACTION_KEY_IDENTITY_FIELDS,
  DELIVERY_ACTION_KEY_PREFIX,
} from '../../dist/process-modules/modules/delivery/package/contributions/idempotency.js';

import {
  DELIVERY_PORT_CONTRIBUTIONS,
} from '../../dist/process-modules/modules/delivery/package/contributions/ports.js';

import {
  DELIVERY_RECEIPT_TYPES,
  DELIVERY_ACTION_RECEIPT_CONTRIBUTION,
  DELIVERY_ACTION_OBSERVATION_CONTRIBUTION,
  DELIVERY_RECEIPT_STATUS_VALUES,
  DELIVERY_OBSERVATION_OUTCOME_VALUES,
} from '../../dist/process-modules/modules/delivery/package/contributions/receipts.js';

// Barrel re-exports everything from one path — verify that too.
import * as barrel from '../../dist/process-modules/modules/delivery/package/contributions/index.js';

// ---------------------------------------------------------------------------
// Tool contributions.
// ---------------------------------------------------------------------------

test('W9-A6 tool contributions: declares exactly six MCP tools', () => {
  assert.equal(DELIVERY_TOOL_CONTRIBUTIONS.length, 6);
  const ids = DELIVERY_TOOL_CONTRIBUTIONS.map((c) => c.logicalId).sort();
  assert.deepEqual(ids, [
    'delivery.approve_release',
    'delivery.observe_release',
    'delivery.preflight_release',
    'delivery.publish_deploy',
    'delivery.record_release',
    'delivery.settle_delivery',
  ]);
});

test('W9-A6 tool contributions: every logical id is namespaced under delivery', () => {
  for (const c of DELIVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(
      c.logicalId.startsWith(`${DELIVERY_TOOL_NAMESPACE}.`),
      `${c.logicalId} is not namespaced under ${DELIVERY_TOOL_NAMESPACE}`,
    );
  }
});

test('W9-A6 tool contributions: every contribution has non-empty contract refs and handler ref', () => {
  for (const c of DELIVERY_TOOL_CONTRIBUTIONS) {
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

test('W9-A6 tool contributions: idempotency and side-effect enums are valid', () => {
  const validIdempotency = new Set(['none', 'idempotent']);
  const validSideEffect = new Set(['none', 'read', 'write', 'external']);
  for (const c of DELIVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(validIdempotency.has(c.idempotency), `bad idempotency: ${c.idempotency}`);
    assert.ok(validSideEffect.has(c.sideEffect), `bad sideEffect: ${c.sideEffect}`);
  }
});

test('W9-A6 tool contributions: every contribution carries at least one guard binding', () => {
  for (const c of DELIVERY_TOOL_CONTRIBUTIONS) {
    assert.ok(Array.isArray(c.guardBindings), 'guardBindings must be an array');
    assert.ok(c.guardBindings.length > 0, 'guardBindings must be non-empty');
    for (const g of c.guardBindings) {
      assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
      assert.ok(g.scope.length > 0, 'guard scope must be non-empty');
    }
  }
});

test('W9-A6 tool contributions: publish_deploy is external + idempotent; observe_release is read + idempotent', () => {
  // The deterministic cross-run action key makes a replayed action a no-op.
  assert.equal(DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION.sideEffect, 'external');
  assert.equal(DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION.idempotency, 'idempotent');
  // Observation is a pure authoritative read.
  assert.equal(DELIVERY_OBSERVE_RELEASE_CONTRIBUTION.sideEffect, 'read');
  assert.equal(DELIVERY_OBSERVE_RELEASE_CONTRIBUTION.idempotency, 'idempotent');
  // The output repository reuses the first run's record for the same candidate + policy.
  assert.equal(DELIVERY_RECORD_RELEASE_CONTRIBUTION.sideEffect, 'write');
  assert.equal(DELIVERY_RECORD_RELEASE_CONTRIBUTION.idempotency, 'idempotent');
  // Preflight/approve/settle are gated by the run fence — single-shot.
  assert.equal(DELIVERY_PREFLIGHT_RELEASE_CONTRIBUTION.idempotency, 'none');
  assert.equal(DELIVERY_APPROVE_RELEASE_CONTRIBUTION.idempotency, 'none');
  assert.equal(DELIVERY_SETTLE_DELIVERY_CONTRIBUTION.idempotency, 'none');
});

test('W9-A6 tool contributions: publish_deploy carries no-force-or-bypass + explicit-operator-authorization guards', () => {
  const refs = DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(refs.includes('guard.saga.no-force-or-bypass'));
  assert.ok(refs.includes('guard.saga.explicit-operator-authorization'));
  assert.ok(refs.includes('guard.saga.no-default-provider'));
});

test('W9-A6 tool contributions: approve_release binds exact input', () => {
  const refs = DELIVERY_APPROVE_RELEASE_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(refs.includes('guard.saga.approval-binds-exact-input'));
  assert.ok(refs.includes('guard.saga.explicit-operator-authorization'));
});

test('W9-A6 tool contributions: settle_delivery + record_release enforce push-is-not-release', () => {
  const settleRefs = DELIVERY_SETTLE_DELIVERY_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(settleRefs.includes('guard.saga.push-is-not-release'));
  assert.ok(settleRefs.includes('guard.saga.candidate-immutable'));
  const recordRefs = DELIVERY_RECORD_RELEASE_CONTRIBUTION.guardBindings.map((g) => g.ref);
  assert.ok(recordRefs.includes('guard.saga.push-is-not-release'));
});

test('W9-A6 tool contributions: resource ids reference package-local instructions + checklists', () => {
  for (const id of Object.values(DELIVERY_TOOL_RESOURCE_IDS)) {
    assert.ok(
      id.startsWith(DELIVERY_TOOL_NAMESPACE),
      `${id} is not namespaced under ${DELIVERY_TOOL_NAMESPACE}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Acceptance capabilities.
// ---------------------------------------------------------------------------

test('W9-A6 acceptance capabilities: declares required platform capabilities', () => {
  assert.ok(DELIVERY_CAPABILITY_REQUIREMENTS.length >= 6);
  const refs = new Set(DELIVERY_CAPABILITY_REQUIREMENTS.map((c) => c.ref));
  assert.ok(refs.has(DELIVERY_CAP_MANAGED_PRODUCTION_LEDGER.ref));
  assert.ok(refs.has(DELIVERY_CAP_RUNTIME_PERSISTENCE.ref));
  assert.ok(refs.has(DELIVERY_CAP_OUTPUT_REPOSITORY.ref));
  assert.ok(refs.has(DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY.ref));
});

test('W9-A6 acceptance capabilities: every requirement has non-empty ref + version', () => {
  for (const c of DELIVERY_CAPABILITY_REQUIREMENTS) {
    assert.ok(c.ref.length > 0, 'ref must be non-empty');
    assert.ok(c.version.length > 0, 'version must be non-empty');
    if (c.optional !== undefined) {
      assert.equal(typeof c.optional, 'boolean', 'optional must be boolean if present');
    }
  }
});

test('W9-A6 acceptance capabilities: trusted-provider-registry is required (no default provider)', () => {
  const registry = DELIVERY_CAPABILITY_REQUIREMENTS.find(
    (c) => c.ref === DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY.ref,
  );
  assert.ok(registry);
  assert.notEqual(registry.optional, true, 'trusted-provider-registry must be required');
});

test('W9-A6 acceptance capabilities: at least one capability is optional (approval-inbox fallback)', () => {
  const optional = DELIVERY_CAPABILITY_REQUIREMENTS.filter((c) => c.optional === true);
  assert.ok(optional.length >= 1, 'expected at least one optional capability');
});

test('W9-A6 acceptance capabilities: guard bindings cover call, submit, node scopes', () => {
  const scopes = new Set(DELIVERY_GUARD_BINDINGS.map((g) => g.scope));
  assert.ok(scopes.has('call'), 'missing call-scope guard');
  assert.ok(scopes.has('submit'), 'missing submit-scope guard');
  assert.ok(scopes.has('node'), 'missing node-scope guard');
  for (const g of DELIVERY_GUARD_BINDINGS) {
    assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
  }
});

test('W9-A6 acceptance capabilities: no-default-provider + push-is-not-release + candidate-immutable guards declared', () => {
  const refs = DELIVERY_GUARD_BINDINGS.map((g) => g.ref);
  assert.ok(refs.includes(DELIVERY_GUARD_NO_DEFAULT_PROVIDER.ref));
  assert.ok(refs.includes(DELIVERY_GUARD_PUSH_IS_NOT_RELEASE.ref));
  assert.ok(refs.includes(DELIVERY_GUARD_CANDIDATE_IMMUTABLE.ref));
});

// ---------------------------------------------------------------------------
// Output contracts.
// ---------------------------------------------------------------------------

test('W9-A6 output contracts: input + output contract refs are the saga3 delivery schemas', () => {
  assert.equal(DELIVERY_INPUT_CONTRACT.schemaId, 'factory.delivery-release-case.v2');
  assert.equal(DELIVERY_OUTPUT_CONTRACT.schemaId, 'factory.delivery-certificate.v2');
  assert.equal(DELIVERY_RELEASE_RECORD_CONTRACT.schemaId, 'factory.release-record.v1');
});

test('W9-A6 output contracts: every node output contract has a valid saga3 schema id', () => {
  for (const c of DELIVERY_NODE_OUTPUT_CONTRACTS) {
    assert.ok(c.schemaId.startsWith('factory.'), `${c.schemaId} is not a saga3 schema`);
    assert.ok(c.version.length > 0, 'version must be non-empty');
    assert.ok(c.digest.length > 0, 'digest must be non-empty');
  }
});

test('W9-A6 output contracts: node output contracts cover the five flow-node products', () => {
  const ids = DELIVERY_NODE_OUTPUT_CONTRACTS.map((c) => c.schemaId);
  assert.ok(ids.includes('factory.delivery-preflight.v1'));
  assert.ok(ids.includes('factory.delivery-approval-decision.v1'));
  assert.ok(ids.includes('factory.delivery-publication.v1'));
  assert.ok(ids.includes('factory.delivery-observation.v1'));
  assert.ok(ids.includes('factory.delivery-settlement-input.v1'));
  assert.ok(ids.includes('factory.release-record.v1'));
});

test('W9-A6 output contracts: declared outcomes are all terminal and match the delivery flow', () => {
  const expected = ['released', 'approval-required', 'blocked', 'failed'];
  assert.deepEqual([...DELIVERY_OUTCOME_CODES].sort(), [...expected].sort());
  for (const o of DELIVERY_DECLARED_OUTCOMES) {
    assert.equal(o.terminal, true, `${o.outcome} must be terminal`);
    assert.ok(o.description.length > 0, `${o.outcome} needs a description`);
  }
});

// ---------------------------------------------------------------------------
// External-effects subtree.
// ---------------------------------------------------------------------------

test('W9-A6 external-effects: declares exactly two external adapters', () => {
  assert.equal(DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS.length, 2);
  const ids = DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS.map((a) => a.adapterId).sort();
  assert.deepEqual(ids, ['delivery-observe-release', 'delivery-publish-deploy']);
});

test('W9-A6 external-effects: publish-deploy covers all four action kinds + external side effect', () => {
  assert.equal(DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION.sideEffect, 'external');
  assert.deepEqual(
    [...DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION.actionKinds].sort(),
    [...DELIVERY_RELEASE_ACTION_KINDS].sort(),
  );
});

test('W9-A6 external-effects: observe-release is a read with no action kinds', () => {
  assert.equal(DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION.sideEffect, 'read');
  assert.equal(DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION.actionKinds.length, 0);
});

test('W9-A6 external-effects: every adapter carries no-default-provider + no-force-or-bypass lineage', () => {
  for (const a of DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS) {
    assert.ok(a.invariantRefs.includes('delivery.no-default-provider'));
    assert.ok(a.invariantRefs.includes('delivery.observe-before-retry'));
    assert.ok(a.invariantRefs.includes('delivery.push-is-not-release'));
  }
  // publish-deploy additionally carries no-force-or-bypass.
  assert.ok(
    DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION.invariantRefs.includes('delivery.no-force-or-bypass'),
  );
});

test('W9-A6 external-effects: external-receipt evidence is required + canonically named', () => {
  assert.equal(DELIVERY_EXTERNAL_RECEIPT_EVIDENCE.category, 'external-receipt');
  assert.equal(DELIVERY_EXTERNAL_RECEIPT_EVIDENCE.required, true);
  assert.equal(DELIVERY_EXTERNAL_RECEIPT_EVIDENCE.contractRef.schemaId, 'factory.evidence.external-receipt.v1');
});

test('W9-A6 external-effects: release action kinds are the closed four-kind set', () => {
  assert.deepEqual(
    [...DELIVERY_RELEASE_ACTION_KINDS].sort(),
    ['deployment', 'package-publish', 'source-release', 'source-tag'],
  );
});

// ---------------------------------------------------------------------------
// Human-approval subtree.
// ---------------------------------------------------------------------------

test('W9-A6 human-approval: declares exactly one human adapter', () => {
  assert.equal(DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS.length, 1);
  assert.equal(
    DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION.adapterId,
    'delivery-release-approval',
  );
  assert.equal(DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION.owningFlowNodeId, 'approve-release');
});

test('W9-A6 human-approval: pending is the non-terminal status (never auto-converted to approved)', () => {
  assert.equal(DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION.nonTerminalStatus, 'pending');
});

test('W9-A6 human-approval: approval statuses include pending + approved + denied + expired + not-required', () => {
  assert.deepEqual(
    [...DELIVERY_APPROVAL_STATUSES].sort(),
    ['approved', 'denied', 'expired', 'not-required', 'pending'],
  );
});

test('W9-A6 human-approval: human-receipt evidence is required + canonically named', () => {
  assert.equal(DELIVERY_HUMAN_RECEIPT_EVIDENCE.category, 'human-receipt');
  assert.equal(DELIVERY_HUMAN_RECEIPT_EVIDENCE.required, true);
  assert.equal(DELIVERY_HUMAN_RECEIPT_EVIDENCE.contractRef.schemaId, 'factory.evidence.human-receipt.v1');
});

test('W9-A6 human-approval: adapter carries explicit-operator-authorization + approval-binds-exact-input', () => {
  const refs = DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION.invariantRefs;
  assert.ok(refs.includes('delivery.explicit-operator-authorization'));
  assert.ok(refs.includes('delivery.approval-binds-exact-input'));
});

// ---------------------------------------------------------------------------
// Idempotency subtree.
// ---------------------------------------------------------------------------

test('W9-A6 idempotency: declares exactly one cross-run action-key strategy', () => {
  assert.equal(DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS.length, 1);
  assert.equal(DELIVERY_IDEMPOTENCY_STRATEGY.name, 'delivery-cross-run-action-key');
  assert.equal(DELIVERY_IDEMPOTENCY_STRATEGY.retryContract, 'observe-before-retry');
});

test('W9-A6 idempotency: action key deliberately excludes processRunId', () => {
  assert.ok(DELIVERY_IDEMPOTENCY_STRATEGY.excludedFields.includes('processRunId'));
  // Identity fields must NOT include processRunId.
  assert.ok(!DELIVERY_IDEMPOTENCY_STRATEGY.identityFields.includes('processRunId'));
});

test('W9-A6 idempotency: identity fields mirror deliveryActionKey (candidate + policy + action identity)', () => {
  const expected = [
    'developmentCertificateHash',
    'candidateHash',
    'releasePolicyHash',
    'actionId',
    'kind',
    'target',
    'desiredStateHash',
    'payloadHash',
  ];
  assert.deepEqual(
    [...DELIVERY_ACTION_KEY_IDENTITY_FIELDS].sort(),
    [...expected].sort(),
  );
  assert.equal(DELIVERY_ACTION_KEY_PREFIX, 'delivery:');
});

test('W9-A6 idempotency: idempotent tool ids match the idempotent tools in tool-contributions', () => {
  const idempotentFromTools = DELIVERY_TOOL_CONTRIBUTIONS.filter(
    (c) => c.idempotency === 'idempotent',
  ).map((c) => c.logicalId).sort();
  assert.deepEqual(
    [...DELIVERY_IDEMPOTENT_TOOL_IDS].sort(),
    idempotentFromTools,
  );
});

test('W9-A6 idempotency: strategy carries observe-before-retry + push-is-not-release invariants', () => {
  const refs = DELIVERY_IDEMPOTENCY_STRATEGY.invariantRefs;
  assert.ok(refs.includes('delivery.observe-before-retry'));
  assert.ok(refs.includes('delivery.push-is-not-release'));
});

// ---------------------------------------------------------------------------
// Ports subtree.
// ---------------------------------------------------------------------------

test('W9-A6 ports: declares one contribution per injected port', () => {
  // Eight ports: preflight-state, approval, publication, observation,
  // settlement-state, output-repository, preflight-policy, settlement-policy.
  assert.equal(DELIVERY_PORT_CONTRIBUTIONS.length, 8);
  const ids = DELIVERY_PORT_CONTRIBUTIONS.map((p) => p.portId).sort();
  assert.deepEqual(ids, [
    'delivery.approval',
    'delivery.observation',
    'delivery.output-repository',
    'delivery.preflight-policy',
    'delivery.preflight-state',
    'delivery.publication',
    'delivery.settlement-policy',
    'delivery.settlement-state',
  ]);
});

test('W9-A6 ports: every port is required (no default provider)', () => {
  for (const p of DELIVERY_PORT_CONTRIBUTIONS) {
    assert.equal(p.required, true, `${p.portId} must be required (no default provider)`);
    assert.ok(p.capabilityRef.length > 0, `${p.portId} needs a capabilityRef`);
    assert.ok(p.version.length > 0, `${p.portId} needs a version`);
    assert.ok(p.invariantRefs.includes('delivery.no-default-provider') || p.invariantRefs.includes('delivery.push-is-not-release'),
      `${p.portId} must enforce no-default-provider or push-is-not-release`);
  }
});

test('W9-A6 ports: every port is bound to a flow node or the cross-node output repository', () => {
  const flowNodeIds = DELIVERY_PORT_CONTRIBUTIONS
    .map((p) => p.owningFlowNodeId)
    .filter((id) => id !== null);
  const expected = [
    'preflight-release',
    'approve-release',
    'publish-deploy',
    'observe-release',
    'settle-delivery',
  ];
  for (const id of expected) {
    assert.ok(flowNodeIds.includes(id), `missing port for flow node ${id}`);
  }
  // The output repository is cross-node (null owningFlowNodeId).
  const outputRepo = DELIVERY_PORT_CONTRIBUTIONS.find((p) => p.portId === 'delivery.output-repository');
  assert.ok(outputRepo);
  assert.equal(outputRepo.owningFlowNodeId, null);
});

// ---------------------------------------------------------------------------
// Receipts subtree.
// ---------------------------------------------------------------------------

test('W9-A6 receipts: declares exactly two receipt types (action receipt + observation)', () => {
  assert.equal(DELIVERY_RECEIPT_TYPES.length, 2);
  const ids = DELIVERY_RECEIPT_TYPES.map((r) => r.receiptTypeId).sort();
  assert.deepEqual(ids, ['delivery.action-observation', 'delivery.action-receipt']);
});

test('W9-A6 receipts: action receipt fields mirror DeliveryActionReceipt', () => {
  const expected = [
    'actionKey', 'actionId', 'kind', 'target', 'payloadHash',
    'desiredStateHash', 'status', 'externalRef', 'resultHash', 'provider', 'replayed',
  ];
  assert.deepEqual(
    [...DELIVERY_ACTION_RECEIPT_CONTRIBUTION.fields].sort(),
    [...expected].sort(),
  );
  assert.equal(DELIVERY_ACTION_RECEIPT_CONTRIBUTION.evidenceCategory, 'external-receipt');
});

test('W9-A6 receipts: observation fields mirror DeliveryActionObservation', () => {
  const expected = [
    'actionKey', 'target', 'desiredStateHash', 'observedStateHash',
    'outcome', 'observation', 'provider',
  ];
  assert.deepEqual(
    [...DELIVERY_ACTION_OBSERVATION_CONTRIBUTION.fields].sort(),
    [...expected].sort(),
  );
  assert.equal(DELIVERY_ACTION_OBSERVATION_CONTRIBUTION.evidenceCategory, 'external-receipt');
});

test('W9-A6 receipts: status + outcome vocabularies include the uncertain case (no blind retry)', () => {
  assert.ok(DELIVERY_RECEIPT_STATUS_VALUES.includes('uncertain'));
  assert.deepEqual(
    [...DELIVERY_RECEIPT_STATUS_VALUES].sort(),
    ['blocked', 'failed', 'succeeded', 'uncertain'],
  );
  assert.deepEqual(
    [...DELIVERY_OBSERVATION_OUTCOME_VALUES].sort(),
    ['error', 'matched', 'mismatched', 'unknown'],
  );
});

test('W9-A6 receipts: every receipt type carries push-is-not-release + observe-before-retry', () => {
  for (const r of DELIVERY_RECEIPT_TYPES) {
    assert.ok(r.invariantRefs.includes('delivery.push-is-not-release'));
    assert.ok(r.invariantRefs.includes('delivery.observe-before-retry'));
  }
});

// ---------------------------------------------------------------------------
// Barrel.
// ---------------------------------------------------------------------------

test('W9-A6 barrel: re-exports all contribution categories', () => {
  // Tool contributions.
  assert.ok(typeof barrel.DELIVERY_TOOL_CONTRIBUTIONS === 'object');
  // Acceptance capabilities.
  assert.ok(typeof barrel.DELIVERY_CAPABILITY_REQUIREMENTS === 'object');
  assert.ok(typeof barrel.DELIVERY_GUARD_BINDINGS === 'object');
  // Output contracts.
  assert.ok(typeof barrel.DELIVERY_INPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DELIVERY_OUTPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.DELIVERY_DECLARED_OUTCOMES === 'object');
  // External-effects.
  assert.ok(typeof barrel.DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS === 'object');
  // Human-approval.
  assert.ok(typeof barrel.DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS === 'object');
  // Idempotency.
  assert.ok(typeof barrel.DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS === 'object');
  // Ports.
  assert.ok(typeof barrel.DELIVERY_PORT_CONTRIBUTIONS === 'object');
  // Receipts.
  assert.ok(typeof barrel.DELIVERY_RECEIPT_TYPES === 'object');
});

test('W9-A6 barrel: re-exported aggregates match the per-file aggregates', () => {
  assert.equal(barrel.DELIVERY_TOOL_CONTRIBUTIONS, DELIVERY_TOOL_CONTRIBUTIONS);
  assert.equal(barrel.DELIVERY_CAPABILITY_REQUIREMENTS, DELIVERY_CAPABILITY_REQUIREMENTS);
  assert.equal(barrel.DELIVERY_GUARD_BINDINGS, DELIVERY_GUARD_BINDINGS);
  assert.equal(barrel.DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS, DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS);
  assert.equal(barrel.DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS, DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS);
  assert.equal(barrel.DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS, DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS);
  assert.equal(barrel.DELIVERY_PORT_CONTRIBUTIONS, DELIVERY_PORT_CONTRIBUTIONS);
  assert.equal(barrel.DELIVERY_RECEIPT_TYPES, DELIVERY_RECEIPT_TYPES);
});
