// tests/factory-temporal/scenarios/worker-boundary-crash-scenarios.mjs
//
// ADR-048 fault-injecting scenarios for the temporal worker-boundary test.
//
// Each scenario handler in this file targets ONE durable WorkerExecution
// boundary and forces a process exit at that exact point on the first
// attempt, then completes normally on subsequent attempts. The Factory's
// repair/recovery state machine must detect the missing receipt and
// requeue the Workplace so the lifecycle can converge.
//
// These scenarios are imported by tests/factory-temporal/worker-boundary.test.mjs
// and dispatched through the SAME production scenario-dispatcher used by the
// foundation and crash-recovery tests. The only production port replaced is the
// worker inference port (workerExecutorFactory) — exactly as in the golden path.
//
// # Boundaries exercised (ADR-048 canonical scenario family)
//
//   1. exit-before-product-submission        — exit(0) without product_submit
//                                               or worker_done. Clean crash.
//   2. exit-after-product-submission-before-  — submit a typed product, then
//      worker-done                              exit(0) without worker_done.
//                                               Orphaned desk production.
//   3. exit-after-worker-done                — call worker_done (durably
//                                               accepted), then exit(0). The
//                                               accepted receipt must be
//                                               authoritative.
//   4. terminal-execution-stale-host         — handled inside the test body by
//                                               directly mutating the host
//                                               snapshot; scenario only needs
//                                               a normal completion path.
//
// # Composition
//
// Each boundary scenario module exports its own `scenarios` map. The test
// imports the specific module it needs and points SAGA_SCENARIOS at it. The
// golden-path scenarios are spread in as the base so every NON-target cell
// still runs the golden path — only the targeted handler is overridden.

import { actions } from '../../factory-contract/scenario-engine.mjs';

const DISC = 'product-discovery@3.0.2';

// ---------------------------------------------------------------------------
// Shared discovery-proposal content (identical to crash-scenarios.mjs so the
// gate semantics are unchanged — only the crash point differs).
// ---------------------------------------------------------------------------

const proposalContent = {
  problem_statement: 'Temporal boundary fault-injection scenario.',
  observed_context: 'Worker crash at a durable boundary must be recovered.',
  stakeholders_or_actors: ['Platform team'],
  assumptions: ['Factory repair policy requeues crashed workplaces.'],
  unknowns: [],
  risks: [],
  candidate_scope: 'One workplace, one crash point, bounded recovery.',
  evidence_refs: ['ADR-048', 'CONVEYOR-MENTAL-MODEL.md'],
  recommended_outcome: 'go',
  rationale: 'Deterministic crash injection at a single boundary.',
};

// ===========================================================================
// Boundary 1 — exit(0) BEFORE product submission or worker_done.
//
// The worker starts, is marked running, then exits cleanly with no typed
// product and no worker_done receipt. This is the most basic orphan: nothing
// was produced, so recovery is purely a requeue. The Factory must advance the
// Workplace out of the crashed loop_state and reach a new attempt.
// ===========================================================================

const exitBeforeProductSubmission = async ({ client, prompt, attempt }) => {
  if (attempt === 1) {
    // CRASH: exit(0) immediately, before any product_submit or worker_done.
    // actions.exitWithoutDone() simply returns; the dispatcher exits(0) and
    // the production finalizer sees no accepted receipt → execution 'lost'.
    actions.exitWithoutDone();
    return;
  }
  // Attempt 2+: the Factory requeued the Workplace and a fresh execution is
  // now running. Complete the protocol normally — submit the typed proposal
  // and call worker_done. This proves the crashed loop_state advanced to a
  // new attempt rather than spinning.
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', proposalContent);
  await actions.done(
    client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal (recovered from pre-submission crash)',
  );
};

// ===========================================================================
// Boundary 2 — submit a typed product, THEN exit(0) before worker_done.
//
// This is the canonical "orphaned desk production" scenario: the worker
// durably submitted a typed product but never recorded a worker_done receipt.
// The Factory must detect the orphaned production, treat the execution as
// lost, and requeue the Workplace. On the retry, the typed product already
// exists (idempotent submission) so the second attempt catches the duplicate
// and completes normally.
// ===========================================================================

const exitAfterProductSubmissionBeforeDone = async ({ client, prompt, attempt }) => {
  // Always attempt submission. On attempt 1 this creates the typed product;
  // on attempt 2+ the duplicate is caught and we proceed.
  try {
    await actions.submitProduct(client, 'factory.discovery-proposal.v1', proposalContent);
  } catch (e) {
    if (!e.message.includes('already exists')) throw e;
    // Typed submission already exists from the crashed attempt — expected.
  }

  if (attempt === 1) {
    // CRASH: product was submitted but we exit without worker_done. The
    // production finalizer sees no accepted receipt → execution 'lost', and
    // the Factory must requeue. The orphaned product is NOT lost — it is
    // scoped to the process_run_id and the retry / gate will find it.
    actions.exitWithoutDone();
    return;
  }

  // Attempt 2+: complete the protocol.
  await actions.done(
    client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal (recovered from orphaned submission)',
  );
};

// ===========================================================================
// Boundary 3 — call worker_done (durably accepted), THEN exit.
//
// This boundary proves the durable receipt is authoritative: once worker_done
// is accepted, the execution is semantically complete regardless of what the
// OS process does afterwards. The next cycle must NOT redo the work — the
// accepted command_receipts row is the source of truth.
//
// Implementation: the scenario calls worker_done normally (so the receipt is
// accepted), then the process simply exits 0. The finalizer MUST classify this
// as semanticCompletion=true (see worker-process-termination.js:62-82). The
// test asserts that no retry attempt occurs for this cell.
// ===========================================================================

const exitAfterWorkerDoneNormal = async ({ client, prompt }) => {
  // Submit the product and complete normally — this establishes the
  // accepted receipt BEFORE the process exits.
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', proposalContent);
  await actions.done(
    client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal (receipt-authoritative exit)',
  );
  // The dispatcher will now exit(0). Because worker_done was accepted, the
  // production finalizer treats this as semantic completion — NOT a crash.
  // No explicit action needed; normal fall-through.
};

// ===========================================================================
// Shared assess-readiness handler (used by boundary 1 & 2 scenarios so the
// lifecycle can proceed past Discovery after the target cell recovers).
// Mirrors the crash-scenarios.mjs readiness handler.
// ===========================================================================

const discoveryReadiness = async ({ client, task, prompt }) => {
  const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
  const pni = meta.process_node_input;
  let proposalSchema, proposalRef, proposalDigest;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(p => p.schemaId === 'factory.discovery-proposal.v1');
      if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
    }
  }
  if (!proposalSchema) throw new Error('No proposal in manifest');
  const proposal = await client.callJson('product_read', {
    schema_id: proposalSchema, ref: proposalRef, digest: proposalDigest,
  });
  await actions.submitProduct(client, 'factory.discovery-readiness-assessment.v1', {
    proposal_id: proposal.submission_id ?? 0,
    proposal_content_hash: proposalDigest,
    overall_readiness: 'ready',
    dimension_assessments: {
      problem_clarity: { status: 'sufficient', rationale: 'Clear.', source_refs: ['$.problem_statement'] },
      scope_boundedness: { status: 'sufficient', rationale: 'Bounded.', source_refs: ['$.candidate_scope'] },
      stakeholder_coverage: { status: 'sufficient', rationale: 'Identified.', source_refs: ['$.stakeholders_or_actors'] },
      assumption_visibility: { status: 'sufficient', rationale: 'Explicit.', source_refs: ['$.assumptions'] },
      unknowns_manageability: { status: 'sufficient', rationale: 'None.', source_refs: ['$.unknowns'] },
      risk_visibility: { status: 'sufficient', rationale: 'None.', source_refs: ['$.risks'] },
      evidence_grounding: { status: 'sufficient', rationale: 'Grounded.', source_refs: ['$.evidence_refs'] },
    },
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.9,
    rationale: 'High confidence.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'readiness assessment ready');
};

// ===========================================================================
// Boundary-specific scenario maps. Each test imports the one it needs and
// points SAGA_SCENARIOS at it. Golden-path is spread as the base so every
// non-target cell runs normally.
//
// The dynamic import of golden-path is deferred to export-time so this module
// can be loaded eagerly by the scenario-dispatcher without cycle issues.
// ===========================================================================

const { goldenPathScenarios } = await import(
  '../../factory-contract/golden-path-scenarios.mjs'
);

// Boundary 1: exit before product submission.
// On attempt 1 the worker exits immediately. On attempt 2+ the handler
// submits the proposal and completes — proving the crashed loop_state
// advanced to a new attempt rather than spinning.
export const workerBoundary1Scenarios = {
  ...goldenPathScenarios,
  [`${DISC}/produce-proposal/author/singleton`]: exitBeforeProductSubmission,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};

// Boundary 2: exit after product submission, before worker_done.
export const workerBoundary2Scenarios = {
  ...goldenPathScenarios,
  [`${DISC}/produce-proposal/author/singleton`]: exitAfterProductSubmissionBeforeDone,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};

// Boundary 3: exit after worker_done (receipt-authoritative).
// The handler completes normally; the test asserts no retry occurs.
export const workerBoundary3Scenarios = {
  ...goldenPathScenarios,
  [`${DISC}/produce-proposal/author/singleton`]: exitAfterWorkerDoneNormal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};

// Boundary 4: terminal-execution-stale-host.
// Uses pure golden-path for the scenario (the host-snapshot staleness is
// injected by the test body, not the scenario). Exported for symmetry.
export const workerBoundary4Scenarios = {
  ...goldenPathScenarios,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};

// Default export: the union map (all four boundary handlers keyed by a
// scenario tag the test can select). Provided for completeness; tests
// typically import the specific boundary map.
export default workerBoundary1Scenarios;
