// tests/spi/agent-assistance.test.mjs
//
// W1-A6 — AgentAssistanceDefinition, AssistanceEvent, AssistanceBlock,
// AssistanceBudgets.
//
// Covers (spec §3 + §4):
//   - Positive: valid instances pass + round-trip through canonical JSON.
//   - Negative: each type rejects function / Map / Set / undefined-in-array /
//     class-instance / Symbol / non-finite number in any field.
//   - AgentAssistanceDefinition: mode enum ('compact'|'guided'|'intensive') and
//     event enum ('step-enter'|'post-tool-success'|'post-tool-error'|
//     'before-submit'|'recovery-enter'|'resume') enforcement.
//   - AssistanceBlock: kind enum enforcement.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 13.
// Task: docs/refactor-management/05-subagent-tasks/W01-A6-production-completion-tool-assistance.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';
import {
  validateAgentAssistanceDefinition,
  validateAssistanceBlock,
  ASSISTANCE_MODES,
  ASSISTANCE_EVENT_NAMES,
  ASSISTANCE_BLOCK_KINDS,
} from '../../dist/process-modules/domain/spi/agent-assistance.js';

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
// Fixtures
// ---------------------------------------------------------------------------

function validBlock() {
  return { kind: 'goal', content: 'Submit a discovery proposal' };
}

function validEvent() {
  return {
    event: 'step-enter',
    blocks: [validBlock()],
  };
}

function validBudgets() {
  return { maxTokensPerBlock: 1024, maxBlocksPerEvent: 4, maxRetriesBeforeEscalate: 2 };
}

function validAssistanceDefinition() {
  return {
    nodeId: 'node-submit',
    mode: 'guided',
    events: [validEvent()],
    budgets: validBudgets(),
  };
}

// ---------------------------------------------------------------------------
// AssistanceBlock
// ---------------------------------------------------------------------------

test('AssistanceBlock: valid instance passes + round-trips', async () => {
  for (const kind of ASSISTANCE_BLOCK_KINDS) {
    const v = { kind, content: 'text' };
    await assertValid(validateAssistanceBlock, v, `AssistanceBlock kind=${kind}`);
    assertRoundTrip(v, `AssistanceBlock kind=${kind} round-trip`);
  }
});

test('AssistanceBlock: rejects each forbidden value kind in kind and content', async () => {
  for (const field of ['kind', 'content']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validBlock();
      v[field] = value;
      await assertInvalid(validateAssistanceBlock, v, `AssistanceBlock.${field} = ${name}`);
    }
  }
});

test('AssistanceBlock: rejects invalid kind enum', async () => {
  const v = validBlock();
  v.kind = 'not-a-real-block-kind';
  await assertInvalid(validateAssistanceBlock, v, 'AssistanceBlock invalid kind enum');
});

// ---------------------------------------------------------------------------
// AgentAssistanceDefinition — mode enum enforcement
// ---------------------------------------------------------------------------

test('AgentAssistanceDefinition: mode accepts all valid enum values', async () => {
  for (const mode of ASSISTANCE_MODES) {
    const v = validAssistanceDefinition();
    v.mode = mode;
    await assertValid(validateAgentAssistanceDefinition, v, `AssistanceDefinition mode=${mode}`);
  }
});

test('AgentAssistanceDefinition: mode rejects invalid enum value', async () => {
  const v = validAssistanceDefinition();
  v.mode = 'verbose';
  await assertInvalid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition invalid mode');
});

test('AgentAssistanceDefinition: mode rejects each forbidden value kind', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validAssistanceDefinition();
    v.mode = value;
    await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.mode = ${name}`);
  }
});

test('AgentAssistanceDefinition: mode rejects missing field', async () => {
  const v = validAssistanceDefinition();
  delete v.mode;
  await assertInvalid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition missing mode');
});

// ---------------------------------------------------------------------------
// AgentAssistanceDefinition — event enum enforcement
// ---------------------------------------------------------------------------

test('AgentAssistanceDefinition: event accepts all valid enum values', async () => {
  for (const eventName of ASSISTANCE_EVENT_NAMES) {
    const v = validAssistanceDefinition();
    v.events = [{ event: eventName, blocks: [] }];
    await assertValid(validateAgentAssistanceDefinition, v, `AssistanceDefinition event=${eventName}`);
  }
});

test('AgentAssistanceDefinition: event rejects invalid enum value', async () => {
  const v = validAssistanceDefinition();
  v.events = [{ event: 'on-init', blocks: [] }];
  await assertInvalid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition invalid event');
});

test('AgentAssistanceDefinition: event rejects each forbidden value kind', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validAssistanceDefinition();
    v.events = [{ event: value, blocks: [] }];
    await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.events[0].event = ${name}`);
  }
});

// ---------------------------------------------------------------------------
// AgentAssistanceDefinition — full positive + round-trip
// ---------------------------------------------------------------------------

test('AgentAssistanceDefinition: valid instance passes + round-trips', async () => {
  const v = validAssistanceDefinition();
  await assertValid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition valid');
  assertRoundTrip(v, 'AssistanceDefinition round-trip');
});

test('AgentAssistanceDefinition: valid with empty events and empty budgets', async () => {
  const v = { nodeId: 'n1', mode: 'compact', events: [], budgets: {} };
  await assertValid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition minimal');
});

// ---------------------------------------------------------------------------
// AgentAssistanceDefinition — negative: forbidden value kinds
// ---------------------------------------------------------------------------

test('AgentAssistanceDefinition: rejects each forbidden value kind in nodeId', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validAssistanceDefinition();
    v.nodeId = value;
    await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.nodeId = ${name}`);
  }
});

test('AgentAssistanceDefinition: rejects each forbidden value kind in budgets fields', async () => {
  for (const field of ['maxTokensPerBlock', 'maxBlocksPerEvent', 'maxRetriesBeforeEscalate']) {
    for (const { name, value } of FORBIDDEN_VALUES) {
      const v = validAssistanceDefinition();
      v.budgets = { ...validBudgets(), [field]: value };
      await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.budgets.${field} = ${name}`);
    }
  }
});

test('AgentAssistanceDefinition: rejects negative / non-integer budget', async () => {
  for (const bad of [-1, 1.5, '3', true]) {
    const v = validAssistanceDefinition();
    v.budgets = { maxTokensPerBlock: bad };
    await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.budgets bad ${JSON.stringify(bad)}`);
  }
});

test('AgentAssistanceDefinition: rejects non-array events', async () => {
  const v = validAssistanceDefinition();
  v.events = 'not-an-array';
  await assertInvalid(validateAgentAssistanceDefinition, v, 'AssistanceDefinition non-array events');
});

test('AgentAssistanceDefinition: rejects each forbidden value kind in event blocks', async () => {
  for (const { name, value } of FORBIDDEN_VALUES) {
    const v = validAssistanceDefinition();
    v.events = [{ event: 'step-enter', blocks: [value] }];
    await assertInvalid(validateAgentAssistanceDefinition, v, `AssistanceDefinition.blocks[0] = ${name}`);
  }
});

test('AgentAssistanceDefinition: rejects null and array roots', async () => {
  await assertInvalid(validateAgentAssistanceDefinition, null, 'AssistanceDefinition null');
  await assertInvalid(validateAgentAssistanceDefinition, [], 'AssistanceDefinition array');
});
