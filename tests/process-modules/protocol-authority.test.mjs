// W4-A6 — Protocol authority intersection + stale-state rejection tests.
//
// Task: `docs/refactor-management/05-subagent-tasks/W04-a6.md`.
// Spec: `docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md`
//        §1 (W4-A6 lane), §3 exit gate.
//
// Exercises the W4-A6 surface only:
//   - freezeExecutionAuthority: normalization, hashing, empty-grant rejection,
//     bad-input rejection.
//   - intersectAuthority: the pure frozen ∩ step intersection; monotonic
//     ceiling; dedup + sort; empty step set; no overlap; step widens past
//     the ceiling.
//   - authorizeStep: the stale-state rejection gate. Every rejection code is
//     covered (WRONG_RUN, RUN_NOT_LIVE, STALE_STEP, STALE_ATTEMPT,
//     EMPTY_GRANT), plus the happy allow path and determinism.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  freezeExecutionAuthority,
  intersectAuthority,
  authorizeStep,
} = await import('../../dist/process-modules/application/protocol-authority.js');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const RUN_ID = 'proto-run-001';

function freeze(tools, runId = RUN_ID) {
  return freezeExecutionAuthority({ runId, allowedTools: tools });
}

function pointer(stepId, attempt, runId = RUN_ID) {
  return { runId, stepId, attempt };
}

function attempt(stepId, attemptNum, tools, runId = RUN_ID) {
  return { runId, stepId, attempt: attemptNum, stepAllowedTools: tools };
}

// ===========================================================================
// freezeExecutionAuthority
// ===========================================================================

test('freezeExecutionAuthority: normalizes the grant to unique sorted form', () => {
  const f = freeze(['tool:c', 'tool:a', 'tool:b', 'tool:a', 'tool:b']);
  assert.deepEqual([...f.frozenAllowedTools], ['tool:a', 'tool:b', 'tool:c']);
  assert.equal(f.runId, RUN_ID);
  assert.match(f.contentHash, /^[0-9a-f]{64}$/);
});

test('freezeExecutionAuthority: rejects empty runId', () => {
  assert.throws(
    () => freezeExecutionAuthority({ runId: '', allowedTools: ['tool:a'] }),
    /runId must be a non-empty string/,
  );
});

test('freezeExecutionAuthority: rejects non-array allowedTools', () => {
  assert.throws(
    // intentionally wrong shape
    () => freezeExecutionAuthority({ runId: RUN_ID, allowedTools: 'tool:a' }),
    /allowedTools must be an array/,
  );
});

test('freezeExecutionAuthority: rejects an empty tool grant', () => {
  assert.throws(
    () => freeze([]),
    /cannot freeze an empty tool grant/,
  );
  // only-blank-strings also normalizes to empty
  assert.throws(
    () => freeze(['', '   ']),
    /cannot freeze an empty tool grant/,
  );
});

test('freezeExecutionAuthority: contentHash is stable for the same grant', () => {
  const a = freeze(['tool:a', 'tool:b']);
  const b = freeze(['tool:b', 'tool:a', 'tool:a']); // dup + reorder
  assert.equal(a.contentHash, b.contentHash);
});

test('freezeExecutionAuthority: contentHash differs across runs/grants', () => {
  const sameRun1 = freeze(['tool:a'], 'run-1');
  const sameRun2 = freeze(['tool:a'], 'run-2');
  const sameRun1DifferentGrant = freeze(['tool:b'], 'run-1');
  assert.notEqual(sameRun1.contentHash, sameRun2.contentHash);
  assert.notEqual(sameRun1.contentHash, sameRun1DifferentGrant.contentHash);
});

test('freezeExecutionAuthority: returns an immutable object', () => {
  const f = freeze(['tool:a']);
  assert.ok(Object.isFrozen(f));
});

// ===========================================================================
// intersectAuthority — the headline intersection
// ===========================================================================

test('intersectAuthority: returns the sorted unique intersection', () => {
  const f = freeze(['tool:a', 'tool:b', 'tool:c', 'tool:d']);
  const out = intersectAuthority(f, ['tool:b', 'tool:d', 'tool:z']);
  assert.deepEqual([...out], ['tool:b', 'tool:d']);
});

test('intersectAuthority: result is always a subset of the frozen ceiling (monotonic)', () => {
  const f = freeze(['tool:a', 'tool:b']);
  // step declares MORE tools than the grant ever allowed
  const out = intersectAuthority(f, ['tool:a', 'tool:b', 'tool:c', 'tool:d']);
  assert.deepEqual([...out], ['tool:a', 'tool:b']);
});

test('intersectAuthority: empty step set yields empty intersection', () => {
  const f = freeze(['tool:a']);
  assert.deepEqual([...intersectAuthority(f, [])], []);
});

test('intersectAuthority: no overlap yields empty intersection', () => {
  const f = freeze(['tool:a', 'tool:b']);
  assert.deepEqual([...intersectAuthority(f, ['tool:x', 'tool:y'])], []);
});

test('intersectAuthority: dedups and sorts step-side tools too', () => {
  const f = freeze(['tool:a', 'tool:b']);
  const out = intersectAuthority(f, ['tool:b', 'tool:a', 'tool:b', 'tool:a']);
  assert.deepEqual([...out], ['tool:a', 'tool:b']);
});

test('intersectAuthority: drops blank/non-string step entries', () => {
  const f = freeze(['tool:a', 'tool:b']);
  const out = intersectAuthority(f, ['tool:a', '', 'tool:b']);
  assert.deepEqual([...out], ['tool:a', 'tool:b']);
});

test('intersectAuthority: is pure — same inputs always same output', () => {
  const f = freeze(['tool:a', 'tool:b', 'tool:c']);
  const a = intersectAuthority(f, ['tool:b', 'tool:c']);
  const b = intersectAuthority(f, ['tool:c', 'tool:b']);
  assert.deepEqual([...a], [...b]);
});

// ===========================================================================
// authorizeStep — stale-state rejection gate
// ===========================================================================

test('authorizeStep: happy path allows with the intersection as effective tools', () => {
  const f = freeze(['tool:read', 'tool:write', 'tool:seal']);
  const rp = pointer('step-1', 1);
  const sa = attempt('step-1', 1, ['tool:write', 'tool:read', 'tool:nuke']);
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'allow');
  assert.deepEqual([...d.effectiveAllowedTools], ['tool:read', 'tool:write']);
  assert.equal(d.code, undefined);
});

test('authorizeStep: allow holds for a tool-free step (empty intersection is not a rejection)', () => {
  const f = freeze(['tool:read']);
  const rp = pointer('step-ev', 3);
  const sa = attempt('step-ev', 3, []); // evidence-only step
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'allow');
  assert.deepEqual([...d.effectiveAllowedTools], []);
});

test('authorizeStep: wrong runId on attempt => AUTHORITY_WRONG_RUN', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-1', 1, RUN_ID);
  const sa = attempt('step-1', 1, ['tool:a'], 'other-run');
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_WRONG_RUN');
  assert.deepEqual([...d.effectiveAllowedTools], []);
});

test('authorizeStep: wrong runId on pointer => AUTHORITY_WRONG_RUN', () => {
  const f = freeze(['tool:a'], RUN_ID);
  const rp = pointer('step-1', 1, 'pointer-run');
  const sa = attempt('step-1', 1, ['tool:a'], RUN_ID);
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_WRONG_RUN');
});

test('authorizeStep: runtime has no live step (empty stepId) => AUTHORITY_RUN_NOT_LIVE', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('', 1); // not started / between steps
  const sa = attempt('step-1', 1, ['tool:a']);
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_RUN_NOT_LIVE');
});

test('authorizeStep: runtime has no live step (non-positive attempt) => AUTHORITY_RUN_NOT_LIVE', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-1', 0);
  const sa = attempt('step-1', 1, ['tool:a']);
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_RUN_NOT_LIVE');
});

test('authorizeStep: step attempt targets a different step => AUTHORITY_STALE_STEP', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-2', 1); // runtime advanced to step-2
  const sa = attempt('step-1', 1, ['tool:a']); // worker still on step-1
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_STALE_STEP');
});

test('authorizeStep: step matches but attempt is the previous attempt => AUTHORITY_STALE_ATTEMPT', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-1', 2); // runtime retried to attempt 2
  const sa = attempt('step-1', 1, ['tool:a']); // worker holds attempt-1 frame
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_STALE_ATTEMPT');
});

test('authorizeStep: non-integer attempt on the step request => AUTHORITY_STALE_ATTEMPT', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-1', 1);
  const sa = attempt('step-1', 1.5, ['tool:a']);
  const d = authorizeStep(f, rp, sa);
  assert.equal(d.decision, 'reject');
  assert.equal(d.code, 'AUTHORITY_STALE_ATTEMPT');
});

// ---------------------------------------------------------------------------
// Stale-state is REJECTED, never silently re-authorized — the core safety
// property. After a reject, re-presenting the SAME stale frame must reject
// again (no idempotent "settle" into an allow).
// ---------------------------------------------------------------------------

test('authorizeStep: a rejected stale frame rejects again on re-present (no silent settle)', () => {
  const f = freeze(['tool:a']);
  const rp = pointer('step-1', 2);
  const sa = attempt('step-1', 1, ['tool:a']);
  const d1 = authorizeStep(f, rp, sa);
  const d2 = authorizeStep(f, rp, sa);
  assert.equal(d1.decision, 'reject');
  assert.equal(d2.decision, 'reject');
  assert.equal(d1.code, d2.code);
  assert.equal(d1.code, 'AUTHORITY_STALE_ATTEMPT');
});

test('authorizeStep: the SAME (frozen, pointer, attempt) triple is deterministic', () => {
  const f = freeze(['tool:a', 'tool:b']);
  const rp = pointer('step-1', 1);
  const sa = attempt('step-1', 1, ['tool:a', 'tool:b']);
  const d1 = authorizeStep(f, rp, sa);
  const d2 = authorizeStep(f, rp, sa);
  assert.deepEqual(d1, d2);
});

test('authorizeStep: a retry that catches up to the runtime pointer re-authorizes', () => {
  // Simulates crash-resume: worker was stale at attempt 1, runtime is at
  // attempt 1; after the runtime advances to attempt 2 a fresh worker
  // presents the correct attempt-2 frame and is allowed.
  const f = freeze(['tool:a', 'tool:b']);
  const rp = pointer('step-1', 2);
  const stale = authorizeStep(f, rp, attempt('step-1', 1, ['tool:a']));
  assert.equal(stale.decision, 'reject');
  const fresh = authorizeStep(f, rp, attempt('step-1', 2, ['tool:a', 'tool:b']));
  assert.equal(fresh.decision, 'allow');
  assert.deepEqual([...fresh.effectiveAllowedTools], ['tool:a', 'tool:b']);
});
