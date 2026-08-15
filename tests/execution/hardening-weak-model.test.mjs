// tests/execution/hardening-weak-model.test.mjs
//
// W12-A6 — Weak-model assistance-budget scenario (surviving subset).
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md lane A6.
// Task: docs/refactor-management/05-subagent-tasks/W12-a6.md.
// Plan: §0.15.11 exit gate item 5 ("Weak model receives bounded guidance").
//
// WHAT THIS PROVES (the lane invariants that do NOT depend on the renderer)
//   A weak model receives EXACT, BOUNDED guidance from PINNED resources whose
//   content address is stable, and whose effective tool ceiling is the
//   frozen-authority ∩ step-declared intersection (never wider than the freeze).
//
//   These two properties survive independently of the AgentAssistanceRenderer,
//   which was removed as dead code (saga4 cutover Block D.3 — 0 production
//   importers). The renderer-dependent guidance/boundedness/determinism
//   assertions were removed alongside it; the pinning + authority assertions
//   below are the renderer-independent remainder.
//
// ISOLATION NOTE: this is a TEST-ONLY lane (WAVE12-HARDENING-SPEC §1). It
// imports only generic Wave 1/4/5 surface that is already present. It does NOT
// patch any production file.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  freezeExecutionAuthority,
  intersectAuthority,
} from '../../dist/process-modules/application/protocol-authority.js';
import {
  canonicalJson,
  sha256Hex,
} from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// PINNED resources fixture.
//
// This is the AgentAssistanceDefinition a Process Module ships inside its
// manifest (W1-A2 module-manifest.ts: `assistance?: AgentAssistanceDefinition[]`).
// It is PURE CANONICAL DATA: no functions, no closures. Its content address is
// the pin the manifest installer freezes.
//
// The five required guidance pieces are each declared as a distinct block so
// the pinning proof below can name them individually, but no renderer is
// invoked — only the content-address stability of the pinned bytes is asserted.
// ---------------------------------------------------------------------------

const PINNED_DEFINITION = Object.freeze({
  nodeId: 'weak-model.discovery-propose',
  mode: 'intensive', // intensive = the most a weak model ever needs
  events: [
    {
      event: 'step-enter',
      blocks: [
        { kind: 'goal', content: 'Submit a discovery proposal that settles.' },
        { kind: 'resource-path', content: 'docs/skills/discovery-propose.md' },
        { kind: 'allowed-tools', content: 'proposal_submit,task_update' },
        { kind: 'completion-criteria', content: 'settlement outcome = go' },
      ],
    },
    {
      event: 'recovery-enter',
      blocks: [
        // The module-pinned repair action — what the weak model must DO.
        { kind: 'repair-fields', content: 'Fix evidence_refs, then retry proposal_submit.' },
      ],
    },
  ],
  budgets: { maxBlocksPerEvent: 9, maxTokensPerBlock: 256 },
});

// The pinned bytes: canonical JSON + content hash. This is what the manifest
// installer freezes and what a weak model consumes. Re-deriving the hash from
// the round-tripped bytes must be byte-identical (the pinning proof).
const PINNED_CANONICAL = canonicalJson(PINNED_DEFINITION);
const PINNED_HASH = sha256Hex(PINNED_DEFINITION);

// ===========================================================================
// GROUP 1 — Pinning: the definition is immutable, content-addressed data.
// ===========================================================================

test('W12-A6 pinning: the pinned definition is canonical-serializable round-trip stable', () => {
  // The pin survives a JSON.parse round-trip: identical canonical bytes.
  const roundTripped = canonicalJson(JSON.parse(PINNED_CANONICAL));
  assert.equal(roundTripped, PINNED_CANONICAL, 'canonical bytes are byte-identical after round-trip');
});

test('W12-A6 pinning: the pinned content hash is stable across re-derivation', () => {
  // sha256Hex canonicalizes its input, so re-hashing the parsed object must
  // match the original hash. This is the content-address the manifest carries.
  const reDerived = sha256Hex(JSON.parse(PINNED_CANONICAL));
  assert.equal(reDerived, PINNED_HASH, 'content hash stable across re-derivation');
  assert.equal(reDerived.length, 64, 'sha-256 hex digest');
});

test('W12-A6 pinning: the pinned definition carries no functions (no runner code embedded)', () => {
  // A weak model consumes pure data. Walk the structure and assert no value is
  // a function — the definition cannot smuggle module-specific behavior. (The
  // round-trip through JSON.parse already guarantees this for our fixture, but
  // the assertion documents the invariant the weak model depends on.)
  const stack = [JSON.parse(PINNED_CANONICAL)];
  while (stack.length > 0) {
    const v = stack.pop();
    assert.notEqual(typeof v, 'function',
      'pinned definition must not carry a function (no embedded runner code)');
    if (v !== null && typeof v === 'object') {
      for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push(child);
    }
  }
});

// ===========================================================================
// GROUP 2 — Allowed tools: the weak model's effective ceiling is the
// frozen-authority ∩ step-declared intersection (C-AUTH-1).
// ===========================================================================

test('W12-A6 allowed-tools: the effective ceiling is frozen-authority ∩ step-declared', () => {
  // The host grants a concrete tool set at run start (the frozen ceiling).
  const frozen = freezeExecutionAuthority({
    runId: 'run-1',
    allowedTools: ['proposal_submit', 'task_update', 'read_file', 'write_file'],
  });
  // The step declares a subset; one of its declarations is NOT granted.
  const stepDeclared = ['proposal_submit', 'task_update', 'tool_not_granted'];
  const effective = intersectAuthority(frozen, stepDeclared);
  // The weak model may call ONLY the intersection — never wider than the freeze.
  assert.deepEqual(effective, ['proposal_submit', 'task_update']);
  // C-AUTH-1 monotonic ceiling: effective ⊆ frozen for ANY step input.
  const aggressive = ['proposal_submit', 'admin_shell', 'drop_table'];
  assert.deepEqual(intersectAuthority(frozen, aggressive), ['proposal_submit']);
});
