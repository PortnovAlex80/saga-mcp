// tests/process-modules/formalization-package-contributions.test.mjs
//
// W8-A7 — Tests for the Formalization package-local contributions.
//
// Validates that the five contribution categories declared under
// `src/process-modules/modules/formalization/package/contributions/` are
// well-formed, internally consistent, and conform to the Wave 1 SPI shapes:
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
  FORMALIZATION_TOOL_CONTRIBUTIONS,
  FORMALIZATION_TOOL_NAMESPACE,
  FORMALIZATION_TOOL_RESOURCE_IDS,
  FORMALIZATION_ARTIFACT_CREATE_CONTRIBUTION,
  FORMALIZATION_ARTIFACT_UPDATE_CONTRIBUTION,
  FORMALIZATION_TRACE_ADD_CONTRIBUTION,
  FORMALIZATION_WORKER_DONE_CONTRIBUTION,
} from '../../dist/process-modules/modules/formalization/package/contributions/tool-contributions.js';

import {
  FORMALIZATION_CAPABILITY_REQUIREMENTS,
  FORMALIZATION_GUARD_BINDINGS,
  FORMALIZATION_CAP_MANAGED_PRODUCTION_LEDGER,
} from '../../dist/process-modules/modules/formalization/package/contributions/acceptance-capabilities.js';

import {
  FORMALIZATION_INPUT_CONTRACT,
  FORMALIZATION_OUTPUT_CONTRACT,
  FORMALIZATION_NODE_OUTPUT_CONTRACTS,
  FORMALIZATION_DECLARED_OUTCOMES,
  FORMALIZATION_OUTCOME_CODES,
} from '../../dist/process-modules/modules/formalization/package/contributions/output-contracts.js';

import {
  FORMALIZATION_SKILL_RESOURCES,
  FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES,
  FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL,
  FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL,
} from '../../dist/process-modules/modules/formalization/package/contributions/reviewer-skills.js';

// Barrel re-exports everything from one path — verify that too.
import * as barrel from '../../dist/process-modules/modules/formalization/package/contributions/index.js';

// ---------------------------------------------------------------------------
// Tool contributions.
// ---------------------------------------------------------------------------

test('W8-A7 tool contributions: declares exactly four MCP tools', () => {
  assert.equal(FORMALIZATION_TOOL_CONTRIBUTIONS.length, 4);
  const ids = FORMALIZATION_TOOL_CONTRIBUTIONS.map((c) => c.logicalId).sort();
  assert.deepEqual(ids, [
    'formalization.artifact_create',
    'formalization.artifact_update',
    'formalization.trace_add',
    'formalization.worker_done',
  ]);
});

test('W8-A7 tool contributions: every logical id is namespaced under formalization', () => {
  for (const c of FORMALIZATION_TOOL_CONTRIBUTIONS) {
    assert.ok(
      c.logicalId.startsWith(`${FORMALIZATION_TOOL_NAMESPACE}.`),
      `${c.logicalId} is not namespaced under ${FORMALIZATION_TOOL_NAMESPACE}`,
    );
  }
});

test('W8-A7 tool contributions: every contribution has non-empty contract refs and handler ref', () => {
  for (const c of FORMALIZATION_TOOL_CONTRIBUTIONS) {
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

test('W8-A7 tool contributions: idempotency and side-effect enums are valid', () => {
  const validIdempotency = new Set(['none', 'idempotent']);
  const validSideEffect = new Set(['none', 'read', 'write', 'external']);
  for (const c of FORMALIZATION_TOOL_CONTRIBUTIONS) {
    assert.ok(validIdempotency.has(c.idempotency), `bad idempotency: ${c.idempotency}`);
    assert.ok(validSideEffect.has(c.sideEffect), `bad sideEffect: ${c.sideEffect}`);
  }
});

test('W8-A7 tool contributions: every contribution carries at least one guard binding', () => {
  for (const c of FORMALIZATION_TOOL_CONTRIBUTIONS) {
    assert.ok(Array.isArray(c.guardBindings), 'guardBindings must be an array');
    assert.ok(c.guardBindings.length > 0, 'guardBindings must be non-empty');
    for (const g of c.guardBindings) {
      assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
      assert.ok(g.scope.length > 0, 'guard scope must be non-empty');
    }
  }
});

test('W8-A7 tool contributions: trace_add is idempotent (INSERT OR IGNORE); others are not', () => {
  assert.equal(FORMALIZATION_TRACE_ADD_CONTRIBUTION.idempotency, 'idempotent');
  assert.equal(FORMALIZATION_ARTIFACT_CREATE_CONTRIBUTION.idempotency, 'none');
  assert.equal(FORMALIZATION_ARTIFACT_UPDATE_CONTRIBUTION.idempotency, 'none');
  assert.equal(FORMALIZATION_WORKER_DONE_CONTRIBUTION.idempotency, 'none');
});

test('W8-A7 tool contributions: all are write-side-effect (mutate durable state)', () => {
  for (const c of FORMALIZATION_TOOL_CONTRIBUTIONS) {
    assert.equal(c.sideEffect, 'write');
  }
});

test('W8-A7 tool contributions: resource ids reference package-local call templates + checklist', () => {
  assert.ok(FORMALIZATION_TOOL_RESOURCE_IDS.artifactCallTemplate.startsWith(FORMALIZATION_TOOL_NAMESPACE));
  assert.ok(FORMALIZATION_TOOL_RESOURCE_IDS.traceCallTemplate.startsWith(FORMALIZATION_TOOL_NAMESPACE));
  assert.ok(FORMALIZATION_TOOL_RESOURCE_IDS.workerDoneCallTemplate.startsWith(FORMALIZATION_TOOL_NAMESPACE));
  assert.ok(FORMALIZATION_TOOL_RESOURCE_IDS.nodeChecklist.startsWith(FORMALIZATION_TOOL_NAMESPACE));
});

// ---------------------------------------------------------------------------
// Acceptance capabilities.
// ---------------------------------------------------------------------------

test('W8-A7 acceptance capabilities: declares required platform capabilities', () => {
  assert.ok(FORMALIZATION_CAPABILITY_REQUIREMENTS.length >= 4);
  const refs = new Set(FORMALIZATION_CAPABILITY_REQUIREMENTS.map((c) => c.ref));
  assert.ok(refs.has(FORMALIZATION_CAP_MANAGED_PRODUCTION_LEDGER.ref));
});

test('W8-A7 acceptance capabilities: every requirement has non-empty ref + version', () => {
  for (const c of FORMALIZATION_CAPABILITY_REQUIREMENTS) {
    assert.ok(c.ref.length > 0, 'ref must be non-empty');
    assert.ok(c.version.length > 0, 'version must be non-empty');
    if (c.optional !== undefined) {
      assert.equal(typeof c.optional, 'boolean', 'optional must be boolean if present');
    }
  }
});

test('W8-A7 acceptance capabilities: at least one capability is optional (traceability policy fallback)', () => {
  const optional = FORMALIZATION_CAPABILITY_REQUIREMENTS.filter((c) => c.optional === true);
  assert.ok(optional.length >= 1, 'expected at least one optional capability');
});

test('W8-A7 acceptance capabilities: guard bindings cover call, submit, and node scopes', () => {
  const scopes = new Set(FORMALIZATION_GUARD_BINDINGS.map((g) => g.scope));
  assert.ok(scopes.has('call'), 'missing call-scope guard');
  assert.ok(scopes.has('submit'), 'missing submit-scope guard');
  assert.ok(scopes.has('node'), 'missing node-scope guard');
  for (const g of FORMALIZATION_GUARD_BINDINGS) {
    assert.ok(g.ref.length > 0, 'guard ref must be non-empty');
  }
});

// ---------------------------------------------------------------------------
// Output contracts.
// ---------------------------------------------------------------------------

test('W8-A7 output contracts: input + output contract refs are the saga3 formalization schemas', () => {
  assert.equal(FORMALIZATION_INPUT_CONTRACT.schemaId, 'factory.formalization-case.v1');
  assert.equal(FORMALIZATION_OUTPUT_CONTRACT.schemaId, 'factory.solution-contract-certificate.v1');
});

test('W8-A7 output contracts: every node output contract has a valid saga3 schema id', () => {
  for (const c of FORMALIZATION_NODE_OUTPUT_CONTRACTS) {
    assert.ok(c.schemaId.startsWith('factory.'), `${c.schemaId} is not a saga3 schema`);
    assert.ok(c.version.length > 0, 'version must be non-empty');
    assert.ok(c.digest.length > 0, 'digest must be non-empty');
  }
});

test('W8-A7 output contracts: declared outcomes are all terminal and match the formalization flow', () => {
  // 'clarification-required' and 'infeasible' deleted (no runtime producer).
  const expected = ['formalized', 'inconsistent', 'failed'];
  assert.deepEqual([...FORMALIZATION_OUTCOME_CODES].sort(), [...expected].sort());
  for (const o of FORMALIZATION_DECLARED_OUTCOMES) {
    assert.equal(o.terminal, true, `${o.outcome} must be terminal`);
    assert.ok(o.description.length > 0, `${o.outcome} needs a description`);
  }
});

// ---------------------------------------------------------------------------
// Reviewer skills.
// ---------------------------------------------------------------------------

test('W8-A7 reviewer skills: declares both reviewer skills (requirements + architecture)', () => {
  assert.equal(FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL.kind, 'reviewer-skill');
  assert.equal(FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL.kind, 'reviewer-skill');
  assert.ok(FORMALIZATION_REQUIREMENTS_REVIEWER_SKILL.path.endsWith('SKILL.md'));
  assert.ok(FORMALIZATION_ARCHITECTURE_REVIEWER_SKILL.path.endsWith('SKILL.md'));
});

test('W8-A7 reviewer skills: every skill resource has a unique logical id', () => {
  const ids = FORMALIZATION_SKILL_RESOURCES.map((s) => s.logicalId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate skill logical ids');
});

test('W8-A7 reviewer skills: resource index entries strip package-local metadata', () => {
  assert.equal(FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES.length, FORMALIZATION_SKILL_RESOURCES.length);
  for (const e of FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES) {
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
// Barrel.
// ---------------------------------------------------------------------------

test('W8-A7 barrel: re-exports all five contribution categories', () => {
  // Tool contributions.
  assert.ok(typeof barrel.FORMALIZATION_TOOL_CONTRIBUTIONS === 'object');
  // Acceptance capabilities.
  assert.ok(typeof barrel.FORMALIZATION_CAPABILITY_REQUIREMENTS === 'object');
  assert.ok(typeof barrel.FORMALIZATION_GUARD_BINDINGS === 'object');
  // Output contracts.
  assert.ok(typeof barrel.FORMALIZATION_INPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.FORMALIZATION_OUTPUT_CONTRACT === 'object');
  assert.ok(typeof barrel.FORMALIZATION_DECLARED_OUTCOMES === 'object');
  // Reviewer skills.
  assert.ok(typeof barrel.FORMALIZATION_SKILL_RESOURCE_INDEX_ENTRIES === 'object');
});

test('W8-A7 barrel: re-exported aggregates match the per-file aggregates', () => {
  assert.equal(barrel.FORMALIZATION_TOOL_CONTRIBUTIONS, FORMALIZATION_TOOL_CONTRIBUTIONS);
  assert.equal(barrel.FORMALIZATION_CAPABILITY_REQUIREMENTS, FORMALIZATION_CAPABILITY_REQUIREMENTS);
  assert.equal(barrel.FORMALIZATION_GUARD_BINDINGS, FORMALIZATION_GUARD_BINDINGS);
});
