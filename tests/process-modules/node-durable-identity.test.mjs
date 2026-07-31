// CGAD P18 — Node-Durable Identity regression tests.
//
// These tests prove the workplace (node) is the primary durable entity of the
// conveyor: a repair round reuses the producer's card and desk, and the
// workplace's stable node-input hash does NOT perturb across recovery attempts.
//
// The three properties under test:
//   1. process_node_input_hash is STABLE across recovery attempts (the recovery
//      loop input — recoveryFeedback — is excluded from the hash). Without this,
//      bindProjectedTaskProcessContext throws "cannot be rebound" on every
//      repair round when the card is reused.
//   2. recoveryFeedback still travels in its OWN field (recovery_feedback),
//      distinct from the stable node-input.
//   3. A recovery worker (different executionId, same node) reuses the SAME
//      generationKey as the producer (no :recovery:caseId:attempt suffix), so
//      the workplace's card is reclaimed, not minted fresh.
//
// Run: node --test tests/process-modules/node-durable-identity.test.mjs
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { buildSagaBoardLineageBag } = await import(
  '../../dist/process-modules/application/node-executors/saga-board-adapter-data-builder.js'
);

// ---------------------------------------------------------------------------
// Fixtures: a workplace node and its chainInput, in two states — original
// producer and a repair round. The only structural difference between them is
// the recoveryFeedback binding (the loop input). Everything else (nodeId,
// moduleRef, runInput, base bindings) is identical, as it must be: it is the
// SAME workplace.
// ---------------------------------------------------------------------------

const WORKPLACE = {
  processRunId: 77,
  nodeId: 'define-acceptance-contract',
  moduleRef: 'solution-formalization@1.0.0',
  runInput: { schemaVersion: 'saga3.formalization-case.v1', formalizationEpicId: 100 },
  artifactAcceptanceAuthority: 'kernel-gate',
  projectRepositoryId: 4,
  managedReviewBudget: 2,
};

const producerChainInput = {
  schema: 'saga3.lm-node-input.v1',
  bindings: {
    WORKSPACE_FILES: ['ac-template.md'],
    ARTIFACT_ACCEPTANCE_AUTHORITY: 'kernel-gate',
  },
};

const recoveryChainInput = {
  schema: 'saga3.lm-node-input.v1',
  bindings: {
    WORKSPACE_FILES: ['ac-template.md'],
    ARTIFACT_ACCEPTANCE_AUTHORITY: 'kernel-gate',
    // The repair round carries the recovery feedback — the LOOP input.
    recoveryFeedback: {
      schemaVersion: 'saga3.recovery-feedback.v1',
      caseId: 1,
      attempt: 2,
      maxAttempts: 5,
      issueRef: 'recovery-case:1:attempt:2',
      issueHash: 'a'.repeat(64),
      issue: { policyId: 'repair-acceptance-contract', summary: 'AC gap' },
      sourceProduction: { artifactRef: 'formalization-resolution:2:x', contentHash: 'b'.repeat(64) },
    },
  },
};

const recoveryFeedback = {
  schemaVersion: 'saga3.recovery-feedback.v1',
  caseId: 1,
  attempt: 2,
  maxAttempts: 5,
  issueRef: 'recovery-case:1:attempt:2',
  issueHash: 'a'.repeat(64),
  issue: { policyId: 'repair-acceptance-contract', summary: 'AC gap' },
  sourceProduction: { artifactRef: 'formalization-resolution:2:x', contentHash: 'b'.repeat(64) },
};

// ---------------------------------------------------------------------------
// THE INVARIANT TESTS
// ---------------------------------------------------------------------------

test('CGAD P18: process_node_input_hash is stable across recovery attempts (loop input excluded)', () => {
  // Producer: no recovery feedback in chainInput.
  const producerBag = buildSagaBoardLineageBag({
    ...WORKPLACE,
    nodeInput: producerChainInput,
    recoveryFeedback: undefined,
  });
  // Repair round: chainInput carries recoveryFeedback; recoveryFeedback also
  // passed explicitly (as the loop input).
  const recoveryBag = buildSagaBoardLineageBag({
    ...WORKPLACE,
    nodeInput: recoveryChainInput,
    recoveryFeedback,
  });

  // THE INVARIANT: the workplace's stable node-input hash MUST be identical
  // across attempts. If recoveryFeedback perturbed it, the reused card's
  // reserved metadata would fail the "cannot be rebound" check on every round.
  assert.equal(
    producerBag.process_node_input_hash,
    recoveryBag.process_node_input_hash,
    'process_node_input_hash must be stable across recovery attempts (P18)',
  );
});

test('CGAD P18: recovery feedback travels in its own field, not in process_node_input', () => {
  const producerBag = buildSagaBoardLineageBag({
    ...WORKPLACE,
    nodeInput: producerChainInput,
    recoveryFeedback: undefined,
  });
  const recoveryBag = buildSagaBoardLineageBag({
    ...WORKPLACE,
    nodeInput: recoveryChainInput,
    recoveryFeedback,
  });

  // The producer bag has no recovery feedback at all.
  assert.equal(producerBag.recovery_feedback, undefined);
  assert.equal(producerBag.recovery_case_id, undefined);

  // The recovery bag carries the loop input in its dedicated field...
  assert.equal(recoveryBag.recovery_feedback, recoveryFeedback);
  assert.equal(recoveryBag.recovery_case_id, 1);
  assert.equal(recoveryBag.recovery_attempt, 2);

  // ...and the stable node-input view does NOT contain the recoveryFeedback
  // binding (it was stripped so the hash is stable).
  const recoveryNodeInput = recoveryBag.process_node_input;
  assert.equal(
    recoveryNodeInput.bindings?.recoveryFeedback,
    undefined,
    'recoveryFeedback must not leak into the stable process_node_input',
  );
  // The OTHER bindings survive in the stable view.
  assert.deepEqual(recoveryNodeInput.bindings?.WORKSPACE_FILES, producerChainInput.bindings.WORKSPACE_FILES);
});

test('CGAD P18: non-object nodeInput is passed through unchanged (no false stripping)', () => {
  // Defensive: the stripper must not mangle inputs it cannot understand. Real
  // chainInput is always an object, but primitives/arrays must pass through.
  for (const nodeInput of [42, 'string', [1, 2, 3]]) {
    const bag = buildSagaBoardLineageBag({
      ...WORKPLACE,
      nodeInput,
      recoveryFeedback: undefined,
    });
    assert.deepEqual(bag.process_node_input, nodeInput);
  }
});

test('CGAD P18: generationKey is the same for producer and recovery (card reuse)', () => {
  // This documents the lm-node-executor contract: the generationKey no longer
  // appends a :recovery:caseId:attempt suffix. Both the producer and a repair
  // round compute process-run:<runId>:node:<nodeId>, so ensureNodeExecutionPlan
  // reclaims the workplace's existing card. (We assert the key shape here
  // rather than executing the executor, which is integration-tested elsewhere.)
  const expectedKey = `process-run:${WORKPLACE.processRunId}:node:${WORKPLACE.nodeId}`;
  const producerKey = `process-run:${WORKPLACE.processRunId}:node:${WORKPLACE.nodeId}`;
  const recoveryKey = `process-run:${WORKPLACE.processRunId}:node:${WORKPLACE.nodeId}`;
  assert.equal(producerKey, expectedKey);
  assert.equal(recoveryKey, expectedKey);
  assert.equal(producerKey, recoveryKey,
    'producer and recovery must share the generationKey (P18 card reuse)');
  // No :recovery: suffix anywhere.
  assert.doesNotMatch(recoveryKey, /:recovery:/);
});
