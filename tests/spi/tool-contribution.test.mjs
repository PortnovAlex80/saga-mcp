// tests/spi/tool-contribution.test.mjs
//
// W1-A6 — ModuleToolContribution, CapabilityRequirement, GuardBinding.
//
// Covers (spec §3 + §4):
//   - Positive: valid instances pass + round-trip through canonical JSON.
//   - Negative: each type rejects function / Map / Set / undefined-in-array /
//     class-instance / Symbol / non-finite number in any field.
//   - ModuleToolContribution: idempotency enum ('none'|'idempotent') and
//     sideEffect enum ('none'|'read'|'write'|'external') enforcement.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 12.
// Task: docs/refactor-management/05-subagent-tasks/W01-A6-production-completion-tool-assistance.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';
import {
  validateModuleToolContribution,
  validateCapabilityRequirement,
  validateGuardBinding,
  TOOL_IDEMPOTENCY_VALUES,
  TOOL_SIDE_EFFECT_VALUES,
} from '../../dist/process-modules/domain/spi/tool-contribution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertValid(validator, value, label) {
  const res = await validator(value);
  assert.ok(res.ok, `${label}: expected ok, got errors: ${JSON.stringify(res.errors)}`);
  assert.equal(res.errors.length, 0, `${label}: expected zero errors`);
}

async function assertInvalid(validator, value, label) {
  const res = await validator(value);
  assert.ok(!res.ok, `${label}: expected NOT ok, but validator passed`);
  assert.ok(res.errors.length > 0, `${label}: expected at least one error`);
}

function assertRoundTrip(value, label) {
  const json = canonicalJson(value);
  const reparsed = JSON.parse(json);
  assert.deepEqual(reparsed, value, `${label}: round-trip mismatch`);
  assert.equal(sha256Hex(value), sha256Hex(reparsed), `${label}: hash stability`);
}

class BogusInstance {
  constructor() {
    this.field = 'value';
  }
}

const FORBIDDEN_VALUES = [
  { name: 'function', value: () => 42 },
  { name: 'Map', value: new Map([['k', 1]]) },
  { name: 'Set', value: new Set([1, 2]) },
  { name: 'undefined-in-array', value: [undefined] },
  { name: 'class-instance', value: new BogusInstance() },
  { name: 'Symbol', value: Symbol('s') },
  { name: 'NaN', value: NaN },
  { name: 'Infinity', value: Infinity },
];

function contractRef() {
  return { schemaId: 'factory.tool.input.v1', version: '1.0.0', digest: 'abc' };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validGuardBinding() {
  return { ref: 'guard:submit-policy', scope: 'call' };
}

function validCapabilityRequirement() {
  return { ref: 'cap:mcp', version: '1.0.0' };
}

function validModuleToolContribution() {
  return {
    logicalId: 'discovery.proposal_submit',
    version: '1.0.0',
    inputContractRef: contractRef(),
    outputContractRef: contractRef(),
    handlerRef: 'handler:proposal-submit',
    callTemplateRef: 'tmpl:proposal-submit',
    checklistRef: 'checklist:proposal-submit',
    errorHintRef: 'hint:proposal-submit',
    guardBindings: [validGuardBinding()],
    idempotency: 'none',
    sideEffect: 'write',
  };
}

// ---------------------------------------------------------------------------
// GuardBinding
// ---------------------------------------------------------------------------

test('GuardBinding: valid instance passes + round-trips', async () => {
  const v = validGuardBinding();
  await assertValid(validateGuardBinding, v, 'GuardBinding valid');
  assertRoundTrip(v, 'GuardBinding round-trip');
});

test('GuardBinding: rejects each forbidden value kind in ref and scope', async () => {
  for (const field of ['ref', 'scope']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validGuardBinding();
      v[field] = value;
      await assertInvalid(validateGuardBinding, v, `GuardBinding.${field} = ${name}`);
    }
  }
});

test('GuardBinding: rejects missing/empty fields', async () => {
  await assertInvalid(validateGuardBinding, { scope: 's' }, 'GuardBinding missing ref');
  await assertInvalid(validateGuardBinding, { ref: '' }, 'GuardBinding empty ref');
});

// ---------------------------------------------------------------------------
// CapabilityRequirement
// ---------------------------------------------------------------------------

test('CapabilityRequirement: valid instance passes + round-trips', async () => {
  const v = validCapabilityRequirement();
  await assertValid(validateCapabilityRequirement, v, 'CapabilityRequirement valid');
  assertRoundTrip(v, 'CapabilityRequirement round-trip');
});

test('CapabilityRequirement: valid with optional=true', async () => {
  const v = { ...validCapabilityRequirement(), optional: true };
  await assertValid(validateCapabilityRequirement, v, 'CapabilityRequirement optional');
});

test('CapabilityRequirement: rejects each forbidden value kind in ref and version', async () => {
  for (const field of ['ref', 'version']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validCapabilityRequirement();
      v[field] = value;
      await assertInvalid(validateCapabilityRequirement, v, `CapabilityRequirement.${field} = ${name}`);
    }
  }
});

test('CapabilityRequirement: rejects each forbidden value kind in optional', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = { ...validCapabilityRequirement(), optional: value };
    await assertInvalid(validateCapabilityRequirement, v, `CapabilityRequirement.optional = ${name}`);
  }
});

test('CapabilityRequirement: rejects non-boolean optional', async () => {
  const v = { ...validCapabilityRequirement(), optional: 'yes' };
  await assertInvalid(validateCapabilityRequirement, v, 'CapabilityRequirement string optional');
});

// ---------------------------------------------------------------------------
// ModuleToolContribution
// ---------------------------------------------------------------------------

test('ModuleToolContribution: valid instance passes + round-trips', async () => {
  const v = validModuleToolContribution();
  await assertValid(validateModuleToolContribution, v, 'ModuleToolContribution valid');
  assertRoundTrip(v, 'ModuleToolContribution round-trip');
});

test('ModuleToolContribution: valid without optional refs', async () => {
  const v = validModuleToolContribution();
  delete v.callTemplateRef;
  delete v.checklistRef;
  delete v.errorHintRef;
  await assertValid(validateModuleToolContribution, v, 'ModuleToolContribution no optional refs');
});

test('ModuleToolContribution: rejects each forbidden value kind in scalar fields', async () => {
  for (const field of ['logicalId', 'version', 'handlerRef']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validModuleToolContribution();
      v[field] = value;
      await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.${field} = ${name}`);
    }
  }
});

test('ModuleToolContribution: rejects each forbidden value kind in optional refs', async () => {
  for (const field of ['callTemplateRef', 'checklistRef', 'errorHintRef']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validModuleToolContribution();
      v[field] = value;
      await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.${field} = ${name}`);
    }
  }
});

test('ModuleToolContribution: rejects each forbidden value kind in contract refs', async () => {
  for (const field of ['inputContractRef', 'outputContractRef']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validModuleToolContribution();
      v[field] = value;
      await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.${field} = ${name}`);
    }
  }
});

test('ModuleToolContribution: rejects each forbidden value kind in guardBindings elements', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleToolContribution();
    v.guardBindings = [value];
    await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.guardBindings[0] = ${name}`);
  }
});

test('ModuleToolContribution: rejects non-array guardBindings', async () => {
  const v = validModuleToolContribution();
  v.guardBindings = 'not-an-array';
  await assertInvalid(validateModuleToolContribution, v, 'ModuleToolContribution non-array guardBindings');
});

// ---------------------------------------------------------------------------
// idempotency enum enforcement
// ---------------------------------------------------------------------------

test('ModuleToolContribution: idempotency accepts all valid enum values', async () => {
  for (const idem of TOOL_IDEMPOTENCY_VALUES) {
    const v = validModuleToolContribution();
    v.idempotency = idem;
    await assertValid(validateModuleToolContribution, v, `ModuleToolContribution idempotency=${idem}`);
  }
});

test('ModuleToolContribution: idempotency rejects invalid enum value', async () => {
  const v = validModuleToolContribution();
  v.idempotency = 'idempotency-not-a-real-value';
  await assertInvalid(validateModuleToolContribution, v, 'ModuleToolContribution invalid idempotency');
});

test('ModuleToolContribution: idempotency rejects each forbidden value kind', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleToolContribution();
    v.idempotency = value;
    await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.idempotency = ${name}`);
  }
});

test('ModuleToolContribution: idempotency rejects missing field', async () => {
  const v = validModuleToolContribution();
  delete v.idempotency;
  await assertInvalid(validateModuleToolContribution, v, 'ModuleToolContribution missing idempotency');
});

// ---------------------------------------------------------------------------
// sideEffect enum enforcement
// ---------------------------------------------------------------------------

test('ModuleToolContribution: sideEffect accepts all valid enum values', async () => {
  for (const se of TOOL_SIDE_EFFECT_VALUES) {
    const v = validModuleToolContribution();
    v.sideEffect = se;
    await assertValid(validateModuleToolContribution, v, `ModuleToolContribution sideEffect=${se}`);
  }
});

test('ModuleToolContribution: sideEffect rejects invalid enum value', async () => {
  const v = validModuleToolContribution();
  v.sideEffect = 'side-effect-not-a-real-value';
  await assertInvalid(validateModuleToolContribution, v, 'ModuleToolContribution invalid sideEffect');
});

test('ModuleToolContribution: sideEffect rejects each forbidden value kind', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleToolContribution();
    v.sideEffect = value;
    await assertInvalid(validateModuleToolContribution, v, `ModuleToolContribution.sideEffect = ${name}`);
  }
});

test('ModuleToolContribution: sideEffect rejects missing field', async () => {
  const v = validModuleToolContribution();
  delete v.sideEffect;
  await assertInvalid(validateModuleToolContribution, v, 'ModuleToolContribution missing sideEffect');
});

test('ModuleToolContribution: rejects null and array roots', async () => {
  await assertInvalid(validateModuleToolContribution, null, 'ModuleToolContribution null');
  await assertInvalid(validateModuleToolContribution, [], 'ModuleToolContribution array');
});
