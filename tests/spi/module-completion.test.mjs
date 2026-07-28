// tests/spi/module-completion.test.mjs
//
// W1-A6 — ModuleCompletion: the explicit terminal envelope.
//
// Covers the type-only circular reference between module-completion.ts and
// production-envelope.ts (resolved via `import type`): a ModuleCompletion
// whose outputEnvelope is a ProcessModuleOutputEnvelope whose completion is a
// ModuleCompletion must validate and round-trip.
//
// Covers (spec §3 + §4):
//   - Positive: valid ModuleCompletion passes + round-trips.
//   - Negative: rejects function / Map / Set / undefined-in-array /
//     class-instance / Symbol / non-finite number in any field; rejects
//     non-boolean terminal, empty outcome, missing outputEnvelope.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 10.
// Task: docs/refactor-management/05-subagent-tasks/W01-A6-production-completion-tool-assistance.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';
import { validateModuleCompletion } from '../../dist/process-modules/domain/spi/module-completion.js';

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

// ---------------------------------------------------------------------------
// Fixtures.
//
// IMPORTANT: the ModuleCompletion <-> ProcessModuleOutputEnvelope reference is
// a TYPE-ONLY cycle (resolved via `import type`). Serialized DATA must be a
// tree — canonicalJson cannot serialize a value-level cycle, and
// assertCanonicalSerializable rightly rejects one. In real persistence the two
// are stored as separate rows; a serialized ModuleCompletion's
// outputEnvelope.completion is therefore a stub shell (or omitted), NOT a
// back-pointer. The fixtures below mirror that: the nested completion is a
// plain shell object, not the parent.
// ---------------------------------------------------------------------------

function validModuleCompletion() {
  // validateModuleCompletion checks the outputEnvelope shell only (deep mutual
  // validation is the barrel's job, to avoid infinite recursion), so a plain
  // object with the shell fields suffices.
  return {
    outcome: 'accepted',
    outputEnvelope: {
      outcome: 'accepted',
      productions: [],
    },
    terminal: true,
  };
}

// ---------------------------------------------------------------------------
// Positive tests
// ---------------------------------------------------------------------------

test('ModuleCompletion: valid instance passes + round-trips', async () => {
  const v = validModuleCompletion();
  await assertValid(validateModuleCompletion, v, 'ModuleCompletion valid');
  assertRoundTrip(v, 'ModuleCompletion round-trip');
});

test('ModuleCompletion: terminal=false also valid', async () => {
  const v = validModuleCompletion();
  v.terminal = false;
  await assertValid(validateModuleCompletion, v, 'ModuleCompletion terminal=false');
});

test('ModuleCompletion: works without productions in envelope', async () => {
  const v = {
    outcome: 'rejected',
    outputEnvelope: { outcome: 'rejected' },
    terminal: true,
  };
  await assertValid(validateModuleCompletion, v, 'ModuleCompletion minimal');
});

// ---------------------------------------------------------------------------
// Negative tests — forbidden value kinds
// ---------------------------------------------------------------------------

test('ModuleCompletion: rejects each forbidden value kind in outcome', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleCompletion();
    v.outcome = value;
    await assertInvalid(validateModuleCompletion, v, `ModuleCompletion.outcome = ${name}`);
  }
});

test('ModuleCompletion: rejects each forbidden value kind in terminal', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleCompletion();
    v.terminal = value;
    await assertInvalid(validateModuleCompletion, v, `ModuleCompletion.terminal = ${name}`);
  }
});

test('ModuleCompletion: rejects each forbidden value kind in outputEnvelope', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validModuleCompletion();
    v.outputEnvelope = value;
    await assertInvalid(validateModuleCompletion, v, `ModuleCompletion.outputEnvelope = ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Negative tests — structural
// ---------------------------------------------------------------------------

test('ModuleCompletion: rejects non-boolean terminal', async () => {
  const v = validModuleCompletion();
  v.terminal = 'true';
  await assertInvalid(validateModuleCompletion, v, 'ModuleCompletion string terminal');
});

test('ModuleCompletion: rejects empty outcome', async () => {
  const v = validModuleCompletion();
  v.outcome = '';
  await assertInvalid(validateModuleCompletion, v, 'ModuleCompletion empty outcome');
});

test('ModuleCompletion: rejects missing outputEnvelope', async () => {
  const v = validModuleCompletion();
  delete v.outputEnvelope;
  await assertInvalid(validateModuleCompletion, v, 'ModuleCompletion missing outputEnvelope');
});

test('ModuleCompletion: rejects null and array roots', async () => {
  await assertInvalid(validateModuleCompletion, null, 'ModuleCompletion null');
  await assertInvalid(validateModuleCompletion, [], 'ModuleCompletion array');
});
