// tests/application/pretooluse-projection.test.mjs
//
// W6-A4 — contract tests for the optional agent-side PreToolUse projection.
//
// Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md §1 (W6-A4).
// Plan: §0.9.6, §11.7, §14.8.4. Checklist: C038.
//
// This test imports ONLY from dist/ (compiled output), matching the repo
// convention for .mjs tests. Run `npm run build` before running this test.
//
// The core invariant under test (§11.7, C038): the projection is an
// OPTIMIZATION, never an AUTHORITY. So:
//   1. It can only DENY early (a useful hint) or PASS (defer to server).
//   2. There is NO `allow` outcome — a pass does not authorize anything.
//   3. EVERY result carries `authoritative: false`.
//   4. It is never STRICTER than the server guard: under advisory enforcement
//      the server only observes, so the projection must NOT deny either.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectPreToolUse,
} from '../../dist/application/pretooluse-projection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXEC_ID = 'exec-0001';

function runtimeAuthority(allowed, workIntentId = 7) {
  return {
    enforcement: 'runtime',
    allowed_saga_tools: allowed,
    work_intent_id: workIntentId,
  };
}

function advisoryAuthority(allowed, workIntentId = 7) {
  return {
    enforcement: 'advisory',
    allowed_saga_tools: allowed,
    work_intent_id: workIntentId,
  };
}

// ---------------------------------------------------------------------------
// §11.7 authority-model invariants — every result, every branch.
// ---------------------------------------------------------------------------

test('§11.7: every deny result carries authoritative=false', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a']),
    toolName: 'tool_b',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.authoritative, false);
});

test('§11.7: every pass result carries authoritative=false', () => {
  const cases = [
    // legacy snapshot
    { executionId: EXEC_ID, authority: null, toolName: 'anything' },
    // advisory, tool present
    { executionId: EXEC_ID, authority: advisoryAuthority(['tool_a']), toolName: 'tool_a' },
    // advisory, tool absent
    { executionId: EXEC_ID, authority: advisoryAuthority(['tool_a']), toolName: 'tool_b' },
    // runtime, tool present
    { executionId: EXEC_ID, authority: runtimeAuthority(['tool_a']), toolName: 'tool_a' },
    // empty tool name still produces a deny, covered separately
  ];
  for (const input of cases) {
    const res = projectPreToolUse(input);
    assert.equal(res.outcome, 'pass', `unexpected outcome for ${JSON.stringify(input)}`);
    assert.equal(res.authoritative, false, `pass must be non-authoritative for ${JSON.stringify(input)}`);
  }
});

test('§11.7: there is no allow outcome — only deny or pass', () => {
  const inputs = [
    { executionId: EXEC_ID, authority: null, toolName: 'x' },
    { executionId: EXEC_ID, authority: runtimeAuthority(['x']), toolName: 'x' },
    { executionId: EXEC_ID, authority: runtimeAuthority(['x']), toolName: 'y' },
    { executionId: EXEC_ID, authority: advisoryAuthority(['x']), toolName: 'x' },
    { executionId: EXEC_ID, authority: advisoryAuthority(['x']), toolName: 'y' },
    { executionId: EXEC_ID, authority: runtimeAuthority(['x']), toolName: '' },
  ];
  const outcomes = new Set(inputs.map((i) => projectPreToolUse(i).outcome));
  assert.ok(outcomes.has('deny'), 'expected at least one deny');
  assert.ok(outcomes.has('pass'), 'expected at least one pass');
  assert.ok(!outcomes.has('allow'), 'projection must NEVER emit an allow outcome');
});

// ---------------------------------------------------------------------------
// Runtime enforcement — the one case where an early denial is correct.
// ---------------------------------------------------------------------------

test('runtime enforcement: tool absent from allowed_saga_tools => deny with hint', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a', 'tool_c'], 42),
    toolName: 'tool_b',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.code, 'TOOL_NOT_IN_ALLOWED_TOOLS');
  assert.equal(res.requestedTool, 'tool_b');
  assert.deepEqual(res.allowedTools, ['tool_a', 'tool_c']);
  assert.equal(res.executionId, EXEC_ID);
  assert.equal(res.workIntentId, 42);
  // The reason must be honest that this is a hint, not authority.
  assert.match(res.reason, /runtime enforcement/i);
  assert.match(res.reason, /not authoritative|not authority/i);
});

test('runtime enforcement: tool present in allowed_saga_tools => pass (defer to server)', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a', 'tool_b']),
    toolName: 'tool_a',
  });
  assert.equal(res.outcome, 'pass');
  assert.equal(res.requestedTool, 'tool_a');
  // Even on pass under runtime, the server guard must still run.
  assert.match(res.reason, /server guard is authoritative/i);
});

test('runtime enforcement: case-sensitive tool match (no fuzzy/substring)', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['Tool_A']),
    toolName: 'tool_a',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.code, 'TOOL_NOT_IN_ALLOWED_TOOLS');
});

test('runtime enforcement: deny allowedTools is a faithful snapshot of the input list', () => {
  const allowed = ['x', 'y', 'z'];
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(allowed),
    toolName: 'w',
  });
  assert.equal(res.outcome, 'deny');
  assert.deepEqual([...res.allowedTools], allowed);
});

// ---------------------------------------------------------------------------
// Advisory enforcement — the projection must NOT be stricter than the server.
// ---------------------------------------------------------------------------

test('advisory enforcement: tool absent => PASS, not deny (server only observes)', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: advisoryAuthority(['tool_a']),
    toolName: 'tool_b',
  });
  // If the projection denied here, it would be STRICTER than the authoritative
  // server guard, violating §11.7 (cannot exceed server authority).
  assert.equal(res.outcome, 'pass');
  assert.match(res.reason, /advisory/i);
  assert.match(res.reason, /server guard is authoritative/i);
});

test('advisory enforcement: tool present => pass, with honest reason', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: advisoryAuthority(['tool_a']),
    toolName: 'tool_a',
  });
  assert.equal(res.outcome, 'pass');
  assert.match(res.reason, /advisory/);
});

// ---------------------------------------------------------------------------
// Legacy Saga 2 snapshot (authority === null).
// ---------------------------------------------------------------------------

test('legacy snapshot (authority=null) => pass (server compatibility-allows)', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: null,
    toolName: 'any_legacy_tool',
  });
  assert.equal(res.outcome, 'pass');
  assert.equal(res.requestedTool, 'any_legacy_tool');
  assert.match(res.reason, /legacy/i);
});

// ---------------------------------------------------------------------------
// Caller bug: empty tool name.
// ---------------------------------------------------------------------------

test('empty toolName => deny with EMPTY_TOOL_NAME (non-authoritative)', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a']),
    toolName: '',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.code, 'EMPTY_TOOL_NAME');
  assert.equal(res.requestedTool, '');
  assert.equal(res.authoritative, false);
  // allowedTools still returned so a recovery UI can show alternatives.
  assert.deepEqual(res.allowedTools, ['tool_a']);
});

test('empty toolName with legacy authority => still deny EMPTY_TOOL_NAME', () => {
  // Even a legacy snapshot cannot authorize "no tool". The server would reject.
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: null,
    toolName: '',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.code, 'EMPTY_TOOL_NAME');
});

// ---------------------------------------------------------------------------
// Determinism / purity.
// ---------------------------------------------------------------------------

test('projection is pure: identical inputs produce identical outputs', () => {
  const input = {
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a', 'tool_b'], 9),
    toolName: 'tool_b',
  };
  const a = projectPreToolUse(input);
  const b = projectPreToolUse(input);
  assert.deepEqual(a, b);
});

test('projection does not mutate the input authority or its allowed list', () => {
  const allowed = ['tool_a', 'tool_b'];
  const authority = runtimeAuthority(allowed, 3);
  const input = { executionId: EXEC_ID, authority, toolName: 'tool_a' };
  projectPreToolUse(input);
  // Array contents and length unchanged.
  assert.deepEqual([...authority.allowed_saga_tools], ['tool_a', 'tool_b']);
  assert.equal(authority.work_intent_id, 3);
  assert.equal(authority.enforcement, 'runtime');
  // Original caller array reference is untouched.
  assert.deepEqual(allowed, ['tool_a', 'tool_b']);
});

// ---------------------------------------------------------------------------
// workIntentId traceability on denial.
// ---------------------------------------------------------------------------

test('deny under runtime cites the work_intent_id from the snapshot', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a'], 123),
    toolName: 'tool_b',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.workIntentId, 123);
});

test('deny under runtime with null work_intent_id is still reported', () => {
  const res = projectPreToolUse({
    executionId: EXEC_ID,
    authority: runtimeAuthority(['tool_a'], null),
    toolName: 'tool_b',
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.workIntentId, null);
});
