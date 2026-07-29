// tests/process-modules/gateway-guard.test.mjs
//
// W6-A3 — Generic server-side GatewayGuard pipeline tests.
//
// Task: `docs/refactor-management/05-subagent-tasks/W06-a3.md`.
// Spec:  `docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md`
//         §1 (W6-A3 lane), §2 exit-gate item 5 ("Gateway guard authoritative").
// Plan:  §11.7 + §14.8.3 in `docs/refactor-management/00-PLAN.md`.
//
// What this file proves:
//   1. AUTHORITATIVE (§11.7): a deny outcome is terminal and final — the
//      pipeline returns verdict='deny' and the gateway must not run the
//      handler.
//   2. The four stages run in fixed order, fail-closed: request → correlation
//      → fence → authority → validation. The first failing stage decides.
//   3. Authority intersection (§11.6): a tool not in the effective surface is
//      AUTHORITY_DENIED under enforcement=runtime.
//   4. Advisory authority softens but never replaces enforcement: an
//      out-of-surface tool under enforcement=advisory is ALLOWED with an
//      observation, and the audit trail records advisory=true.
//   5. Execution fence (§11.1, §0.7.11): a managed call with a missing or
//      mismatched execution id is FENCE_MISSING / FENCE_MISMATCH. A
//      non-managed call (fence=null) skips the fence stage.
//   6. Input validation runs LAST among the semantic stages — a validator is
//      never called for a call that failed authority or the fence. A thrown
//      validator is fail-closed (converted to VALIDATION_FAILED).
//   7. Audit trail (§11.1 audit, §11.9 correlation): every call — allow OR
//      deny — produces an immutable GuardAuditRecord with a stable content
//      hash; the hash is byte-stable across runs (determinism).
//   8. Call-instance correlation (§11.9): a managed call without a
//      callInstanceRef is CALL_INSTANCE_INVALID; the gateway needs it to
//      audit and to strip before handler input decoding.
//   9. Determinism + immutability: same inputs ⇒ same outcome + same audit
//      hash; the audit record and effective authority are frozen.
//
// Run: `node --test tests/process-modules/gateway-guard.test.mjs`
// (auto-discovered by tools/run-process-module-tests.mjs.)

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  runGatewayGuard,
  makeEffectiveCallAuthority,
} = await import('../../dist/process-modules/application/gateway-guard.js');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const RUN_ID = 'gw-run-001';
const EXEC_ID = 'exec-aaaa';
const CALL_REF = 'call-instance-0001';
const RECEIVED_AT = '2026-07-29T10:00:00.000Z';
const TOOL = 'mcp__saga__task_get';

function runtimeAuthority(tools) {
  return makeEffectiveCallAuthority(tools, 'runtime');
}

function advisoryAuthority(tools) {
  return makeEffectiveCallAuthority(tools, 'advisory');
}

function fence(callExecId = EXEC_ID, runtimeExecId = EXEC_ID) {
  return {
    callExecutionId: callExecId,
    runtimeExecutionId: runtimeExecId,
    runId: RUN_ID,
    workerId: 'worker-1',
  };
}

/** A happy-path managed request: in-scope tool, valid fence, valid ref. */
function managedRequest(overrides = {}) {
  return {
    toolName: TOOL,
    authority: runtimeAuthority([TOOL, 'mcp__saga__task_list']),
    fence: fence(),
    callInstanceRef: CALL_REF,
    rawInput: { task_id: 42 },
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

/** A non-managed (interactive / operator) request: fence=null. */
function interactiveRequest(overrides = {}) {
  return {
    toolName: TOOL,
    authority: runtimeAuthority([TOOL]),
    fence: null,
    callInstanceRef: null,
    rawInput: {},
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

// ===========================================================================
// makeEffectiveCallAuthority — canonicalisation + freeze.
// ===========================================================================

test('makeEffectiveCallAuthority normalizes the surface to unique-sorted form', () => {
  const a = makeEffectiveCallAuthority(['tool:c', 'tool:a', 'tool:a', 'tool:b', '']);
  assert.deepEqual([...a.allowedTools], ['tool:a', 'tool:b', 'tool:c']);
  assert.equal(a.enforcement, 'runtime'); // fail-closed default (§11.7)
});

test('makeEffectiveCallAuthority freezes the authority and the surface', () => {
  const a = makeEffectiveCallAuthority(['tool:a']);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.allowedTools), true);
});

test('makeEffectiveCallAuthority honors an explicit advisory enforcement', () => {
  const a = makeEffectiveCallAuthority(['tool:a'], 'advisory');
  assert.equal(a.enforcement, 'advisory');
});

// ===========================================================================
// Happy path: managed call, in-scope tool, valid fence, valid input.
// ===========================================================================

test('managed in-scope call is allowed and audited at stage=pipeline', () => {
  const r = runGatewayGuard(managedRequest());
  assert.equal(r.outcome.verdict, 'allow');
  assert.equal(r.outcome.toolName, TOOL);
  assert.equal(r.outcome.callInstanceRef, CALL_REF);
  assert.equal(r.outcome.advisory, false);
  assert.equal(r.audit.verdict, 'allow');
  assert.equal(r.audit.stage, 'pipeline');
  assert.equal(r.audit.advisory, false);
  assert.equal(r.audit.callInstanceRef, CALL_REF);
  assert.equal(r.audit.toolName, TOOL);
  assert.equal(typeof r.audit.contentHash, 'string');
  assert.equal(r.audit.contentHash.length, 64);
  assert.equal(Object.isFrozen(r.audit), true);
});

test('non-managed (interactive) call skips the fence and correlation stages', () => {
  const r = runGatewayGuard(interactiveRequest());
  assert.equal(r.outcome.verdict, 'allow');
  // No fence → no callInstanceRef required; outcome carries '' as the
  // null-equivalent so the discriminated union stays total.
  assert.equal(r.outcome.callInstanceRef, '');
  assert.equal(r.audit.callInstanceRef, null);
  assert.equal(r.audit.stage, 'pipeline');
});

// ===========================================================================
// Stage 0: request shape.
// ===========================================================================

test('MALFORMED_REQUEST: missing toolName', () => {
  const r = runGatewayGuard(managedRequest({ toolName: '   ' }));
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'MALFORMED_REQUEST');
  assert.equal(r.outcome.denial.stage, 'request');
  assert.equal(r.audit.verdict, 'deny');
  assert.equal(r.audit.code, 'MALFORMED_REQUEST');
});

test('MALFORMED_REQUEST: malformed authority (bad enforcement enum)', () => {
  const r = runGatewayGuard(
    managedRequest({ authority: { enforcement: 'lax', allowedTools: [TOOL] } }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'MALFORMED_REQUEST');
});

test('MALFORMED_REQUEST: missing receivedAt', () => {
  const r = runGatewayGuard(managedRequest({ receivedAt: '' }));
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'MALFORMED_REQUEST');
});

// ===========================================================================
// Stage 1: correlation (managed calls only).
// ===========================================================================

test('CALL_INSTANCE_INVALID: managed call missing callInstanceRef', () => {
  const r = runGatewayGuard(managedRequest({ callInstanceRef: null }));
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'CALL_INSTANCE_INVALID');
  assert.equal(r.outcome.denial.stage, 'correlation');
  // The denial carries null because there was no ref to thread.
  assert.equal(r.outcome.denial.callInstanceRef, null);
});

test('CALL_INSTANCE_INVALID: managed call with blank callInstanceRef', () => {
  const r = runGatewayGuard(managedRequest({ callInstanceRef: '   ' }));
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'CALL_INSTANCE_INVALID');
});

test('non-managed call does NOT require a callInstanceRef', () => {
  // fence=null → correlation stage skipped even though ref is null.
  const r = runGatewayGuard(interactiveRequest({ callInstanceRef: null }));
  assert.equal(r.outcome.verdict, 'allow');
});

// ===========================================================================
// Stage 2: execution fence (managed calls only).
// ===========================================================================

test('FENCE_MISSING: managed call with empty callExecutionId', () => {
  const r = runGatewayGuard(
    managedRequest({ fence: fence('', EXEC_ID) }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'FENCE_MISSING');
  assert.equal(r.outcome.denial.stage, 'fence');
  assert.equal(r.outcome.denial.callInstanceRef, CALL_REF);
});

test('FENCE_MISMATCH: call execution id != runtime execution id (replay/stale)', () => {
  const r = runGatewayGuard(
    managedRequest({ fence: fence('exec-old', 'exec-new') }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'FENCE_MISMATCH');
  assert.equal(r.outcome.denial.stage, 'fence');
  assert.match(r.outcome.denial.reason, /exec-old/);
  assert.match(r.outcome.denial.reason, /exec-new/);
});

test('FENCE_MISMATCH: empty runtimeExecutionId is a mismatch', () => {
  const r = runGatewayGuard(
    managedRequest({ fence: fence(EXEC_ID, '') }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'FENCE_MISMATCH');
});

test('fence runs BEFORE authority: an out-of-scope replayed call is FENCE_MISMATCH, not AUTHORITY_DENIED', () => {
  // Order matters: a replayed call must not leak which tools the surface
  // grants. Replayed fence + out-of-scope tool → fence denial wins.
  const r = runGatewayGuard(
    managedRequest({
      fence: fence('exec-old', 'exec-new'),
      authority: runtimeAuthority(['some-other-tool']),
    }),
  );
  assert.equal(r.outcome.denial.code, 'FENCE_MISMATCH');
  assert.equal(r.outcome.denial.stage, 'fence');
});

// ===========================================================================
// Stage 3: authority intersection.
// ===========================================================================

test('AUTHORITY_DENIED: tool not in the effective surface (runtime enforcement)', () => {
  const r = runGatewayGuard(
    managedRequest({ authority: runtimeAuthority(['mcp__saga__task_list']) }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'AUTHORITY_DENIED');
  assert.equal(r.outcome.denial.stage, 'authority');
  assert.equal(r.outcome.denial.callInstanceRef, CALL_REF);
  assert.match(r.outcome.denial.recovery, /frozen execution_context is immutable/);
});

test('authority normalizes the surface (duplicates/whitespace tolerated)', () => {
  // A surface with dupes/blanks still classifies the tool correctly.
  const r = runGatewayGuard(
    managedRequest({
      authority: { enforcement: 'runtime', allowedTools: [TOOL, TOOL, '  '] },
    }),
  );
  assert.equal(r.outcome.verdict, 'allow');
});

test('advisory authority: out-of-scope tool is ALLOWED with observation + advisory=true', () => {
  const r = runGatewayGuard(
    managedRequest({
      authority: advisoryAuthority(['mcp__saga__task_list']),
    }),
  );
  assert.equal(r.outcome.verdict, 'allow');
  assert.equal(r.outcome.advisory, true);
  assert.match(r.outcome.observation, /NOT in the effective surface/);
  assert.match(r.outcome.observation, /enforcement=advisory/);
  // Audit trail records the soft-pass — never silent (§11.7).
  assert.equal(r.audit.verdict, 'allow');
  assert.equal(r.audit.advisory, true);
  assert.equal(r.audit.stage, 'authority');
});

test('advisory authority: in-scope tool is allowed with advisory=false', () => {
  const r = runGatewayGuard(
    managedRequest({ authority: advisoryAuthority([TOOL]) }),
  );
  assert.equal(r.outcome.verdict, 'allow');
  assert.equal(r.outcome.advisory, false);
  assert.equal(r.audit.stage, 'pipeline');
});

// ===========================================================================
// Stage 4: input validation.
// ===========================================================================

test('validation passes when the validator returns ok', () => {
  const r = runGatewayGuard(
    managedRequest({
      inputValidator: (raw) => (raw && typeof raw === 'object' ? { ok: true } : { ok: false, code: 'NOT_OBJECT', fieldPath: '$', message: 'must be object' }),
    }),
  );
  assert.equal(r.outcome.verdict, 'allow');
  assert.equal(r.audit.stage, 'pipeline');
});

test('VALIDATION_FAILED: validator returns ok=false', () => {
  const r = runGatewayGuard(
    managedRequest({
      inputValidator: () => ({
        ok: false,
        code: 'BAD_TASK_ID',
        fieldPath: 'task_id',
        message: 'task_id must be a positive integer',
        expected: 'integer>=1',
      }),
    }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'VALIDATION_FAILED');
  assert.equal(r.outcome.denial.stage, 'validation');
  assert.equal(r.outcome.denial.fieldPath, 'task_id');
  assert.equal(r.outcome.denial.expected, 'integer>=1');
  assert.equal(r.outcome.denial.callInstanceRef, CALL_REF);
});

test('validation runs LAST: a denied-authority call never invokes the validator', () => {
  let called = 0;
  const r = runGatewayGuard(
    managedRequest({
      authority: runtimeAuthority(['some-other-tool']),
      inputValidator: () => {
        called++;
        return { ok: true };
      },
    }),
  );
  assert.equal(r.outcome.denial.code, 'AUTHORITY_DENIED');
  assert.equal(called, 0, 'validator must not run for an authority-denied call');
});

test('validation runs LAST: a fence-mismatched call never invokes the validator', () => {
  let called = 0;
  const r = runGatewayGuard(
    managedRequest({
      fence: fence('exec-old', 'exec-new'),
      inputValidator: () => {
        called++;
        return { ok: true };
      },
    }),
  );
  assert.equal(r.outcome.denial.code, 'FENCE_MISMATCH');
  assert.equal(called, 0);
});

test('a thrown validator is fail-closed (converted to VALIDATION_FAILED, never allow)', () => {
  const r = runGatewayGuard(
    managedRequest({
      inputValidator: () => {
        throw new Error('zod exploded');
      },
    }),
  );
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'VALIDATION_FAILED');
  assert.equal(r.outcome.denial.fieldPath, '$');
  assert.match(r.outcome.denial.reason, /zod exploded/);
});

// ===========================================================================
// Audit trail + determinism (§11.1 audit, §11.9 correlation).
// ===========================================================================

test('every call produces an audit record (allow path)', () => {
  const r = runGatewayGuard(managedRequest());
  assert.ok(r.audit);
  assert.equal(r.audit.verdict, 'allow');
});

test('every call produces an audit record (deny path)', () => {
  const r = runGatewayGuard(
    managedRequest({ authority: runtimeAuthority(['other']) }),
  );
  assert.ok(r.audit);
  assert.equal(r.audit.verdict, 'deny');
  assert.equal(r.audit.code, 'AUTHORITY_DENIED');
});

test('audit contentHash is byte-stable across runs with identical inputs (determinism)', () => {
  const r1 = runGatewayGuard(managedRequest());
  const r2 = runGatewayGuard(managedRequest());
  assert.equal(r1.audit.contentHash, r2.audit.contentHash);
  assert.deepEqual(r1.outcome, r2.outcome);
});

test('audit contentHash changes when the decision changes', () => {
  const allow = runGatewayGuard(managedRequest());
  const deny = runGatewayGuard(
    managedRequest({ authority: runtimeAuthority(['other']) }),
  );
  assert.notEqual(allow.audit.contentHash, deny.audit.contentHash);
});

test('audit contentHash changes when the tool changes (same decision)', () => {
  const a = runGatewayGuard(managedRequest({ toolName: 'mcp__saga__task_get' }));
  const b = runGatewayGuard(managedRequest({ toolName: 'mcp__saga__task_list', authority: runtimeAuthority(['mcp__saga__task_list']) }));
  assert.notEqual(a.audit.contentHash, b.audit.contentHash);
});

test('denial carries the callInstanceRef so the audit + downstream error can correlate', () => {
  const r = runGatewayGuard(
    managedRequest({
      callInstanceRef: 'call-xyz',
      authority: runtimeAuthority(['other']),
    }),
  );
  assert.equal(r.outcome.denial.callInstanceRef, 'call-xyz');
  assert.equal(r.audit.callInstanceRef, 'call-xyz');
});

test('all six denial codes are reachable through the public surface', () => {
  const codes = new Set([
    // MALFORMED_REQUEST
    runGatewayGuard(managedRequest({ toolName: '' })).outcome.denial?.code,
    // CALL_INSTANCE_INVALID
    runGatewayGuard(managedRequest({ callInstanceRef: null })).outcome.denial?.code,
    // FENCE_MISSING
    runGatewayGuard(managedRequest({ fence: fence('', EXEC_ID) })).outcome.denial?.code,
    // FENCE_MISMATCH
    runGatewayGuard(managedRequest({ fence: fence('a', 'b') })).outcome.denial?.code,
    // AUTHORITY_DENIED
    runGatewayGuard(managedRequest({ authority: runtimeAuthority(['other']) })).outcome.denial?.code,
    // VALIDATION_FAILED
    runGatewayGuard(managedRequest({ inputValidator: () => ({ ok: false, code: 'X', fieldPath: '$', message: 'no' }) })).outcome.denial?.code,
  ]);
  assert.deepEqual(
    [...codes].sort(),
    [
      'AUTHORITY_DENIED',
      'CALL_INSTANCE_INVALID',
      'FENCE_MISMATCH',
      'FENCE_MISSING',
      'MALFORMED_REQUEST',
      'VALIDATION_FAILED',
    ],
  );
});

// ===========================================================================
// Purity / total: pipeline never throws on bad input.
// ===========================================================================

test('runGatewayGuard never throws on malformed input (stays total)', () => {
  assert.doesNotThrow(() => runGatewayGuard(null));
  assert.doesNotThrow(() => runGatewayGuard(undefined));
  assert.doesNotThrow(() => runGatewayGuard({}));
  assert.doesNotThrow(() => runGatewayGuard({ toolName: 'x' }));
  const r = runGatewayGuard(null);
  assert.equal(r.outcome.verdict, 'deny');
  assert.equal(r.outcome.denial.code, 'MALFORMED_REQUEST');
});
