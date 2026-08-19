/**
 * Order Constraint Register (AC-drift remedy, network 0 — the single source
 * for all three obligation networks).
 *
 * The register is extracted at discovery time, while the order's constraints
 * are still visible, and is content-addressed by digest. It is the typed
 * inventory the A1 reaction network (brief dispositions), the A2 structure
 * network (AC/SRS coverage) and the A3 execution network (verification
 * warrant) all diff against.
 *
 * Pure unit tests: no SQLite, no engine, no LM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_CONSTRAINT_REGISTER_SCHEMA,
  ORDER_CONSTRAINT_CLASSES,
  buildOrderConstraintRegister,
  orderConstraintRegisterRef,
} from '../../dist/modules/discovery/domain/constraint-register.js';
import {
  validateDiscoveryProposal,
} from '../../dist/modules/discovery/domain/discovery-proposal.js';

function baseProposal(overrides = {}) {
  return {
    problem_statement: 'p',
    observed_context: 'o',
    stakeholders_or_actors: ['a'],
    assumptions: [],
    unknowns: [],
    risks: [],
    candidate_scope: 's',
    evidence_refs: ['e'],
    recommended_outcome: 'go',
    rationale: 'r',
    ...overrides,
  };
}

const DOCKER_DRAFT = {
  class: 'execution',
  text: 'one-command `docker compose up`',
  evidence_ref: 'order.source_body',
};
const TS_DRAFT = {
  class: 'material',
  text: 'TypeScript backend',
  evidence_ref: 'order.source_body',
};
const CHROME_DRAFT = {
  class: 'human',
  text: 'Chrome client feel',
  evidence_ref: 'order.source_body',
};

// ---- buildOrderConstraintRegister ------------------------------------------

test('register is null when no order_constraints are carried (retro-compat)', () => {
  assert.equal(buildOrderConstraintRegister(undefined), null);
  assert.equal(buildOrderConstraintRegister(null), null);
  assert.equal(buildOrderConstraintRegister([]), null);
});

test('register assigns stable positional IDs ord-c-001.. and carries the class', () => {
  const register = buildOrderConstraintRegister([
    { ...DOCKER_DRAFT },
    { ...TS_DRAFT },
    { ...CHROME_DRAFT },
  ]);
  assert.ok(register);
  assert.equal(register.schemaVersion, ORDER_CONSTRAINT_REGISTER_SCHEMA);
  assert.deepEqual(
    register.constraints.map(entry => entry.id),
    ['ord-c-001', 'ord-c-002', 'ord-c-003'],
  );
  assert.deepEqual(
    register.constraints.map(entry => entry.class),
    ['execution', 'material', 'human'],
  );
  assert.equal(register.constraints[0].text, DOCKER_DRAFT.text);
  assert.equal(register.constraints[0].evidenceRef, DOCKER_DRAFT.evidence_ref);
});

test('register digest is deterministic and independent of array identity', () => {
  const first = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  const second = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }, { ...TS_DRAFT }]);
  assert.ok(first && second);
  assert.equal(first.registerDigest, second.registerDigest);
  assert.match(first.registerDigest, /^[a-f0-9]{64}$/);
});

test('register digest changes when constraint content changes', () => {
  const first = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }]);
  const second = buildOrderConstraintRegister([{
    ...DOCKER_DRAFT,
    text: 'two-command startup',
  }]);
  assert.ok(first && second);
  assert.notEqual(first.registerDigest, second.registerDigest);
});

test('orderConstraintRegisterRef is content-addressed by the digest', () => {
  const register = buildOrderConstraintRegister([{ ...DOCKER_DRAFT }]);
  assert.ok(register);
  assert.equal(
    orderConstraintRegisterRef(register),
    `constraint-register:${register.registerDigest}`,
  );
});

test('duplicate constraint text is preserved as distinct entries (IDs are positional)', () => {
  const register = buildOrderConstraintRegister([
    { ...DOCKER_DRAFT },
    { ...DOCKER_DRAFT },
  ]);
  assert.ok(register);
  assert.equal(register.constraints.length, 2);
  assert.deepEqual(
    register.constraints.map(entry => entry.id),
    ['ord-c-001', 'ord-c-002'],
  );
});

test('invalid draft fails closed with a typed error', () => {
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'cosmic', text: 'x', evidence_ref: 'y' }]),
    /ORDER_CONSTRAINT_CLASS_INVALID/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'execution', text: '  ', evidence_ref: 'y' }]),
    /ORDER_CONSTRAINT_TEXT_REQUIRED/,
  );
  assert.throws(
    () => buildOrderConstraintRegister([{ class: 'execution', text: 'x' }]),
    /ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED/,
  );
});

test('non-array order_constraints fails closed', () => {
  assert.throws(
    () => buildOrderConstraintRegister('nope'),
    /ORDER_CONSTRAINT_DRAFTS_INVALID/,
  );
});

// ---- validateDiscoveryProposal integration ----------------------------------

test('proposal with valid order_constraints validates', () => {
  const result = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ ...DOCKER_DRAFT }, { ...TS_DRAFT }, { ...CHROME_DRAFT }],
  }));
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('proposal with invalid order_constraints is rejected with named field errors', () => {
  const result = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ class: 'runtime', text: 'x', evidence_ref: 'y' }],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('order_constraints[0].class')));

  const missingText = validateDiscoveryProposal(baseProposal({
    order_constraints: [{ class: 'material', text: '', evidence_ref: 'y' }],
  }));
  assert.equal(missingText.valid, false);
  assert.ok(missingText.errors.some(error => error.includes('order_constraints[0].text')));
});

test('proposal without order_constraints still validates (retro-compat monotonicity)', () => {
  const result = validateDiscoveryProposal(baseProposal());
  assert.equal(result.valid, true);
});

test('ORDER_CONSTRAINT_CLASSES is the closed class vocabulary', () => {
  assert.deepEqual([...ORDER_CONSTRAINT_CLASSES], ['execution', 'material', 'human']);
});
