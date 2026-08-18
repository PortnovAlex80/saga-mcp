// tests/factory-contract/crash-scenarios.mjs
//
// Scenario definitions for crash-recovery testing.
// The discovery proposal worker crashes on attempt 1 (submits product but
// exits without worker_done), then succeeds on attempt 2.
// This exercises the Factory's repair/recovery state machine.

import { actions } from './scenario-engine.mjs';

const DISC = 'product-discovery@3.0.2';
const FRM = 'solution-formalization@1.0.0';

const proposalContent = {
  problem_statement: 'Test problem for crash recovery.',
  observed_context: 'Unit tests cover domain logic.',
  stakeholders_or_actors: ['Team'],
  assumptions: ['Factory physics is correct.'],
  unknowns: [],
  risks: [],
  candidate_scope: 'Bounded scope.',
  evidence_refs: ['e2e-test', 'CONVEYOR-MENTAL-MODEL.md'],
  recommended_outcome: 'go',
  rationale: 'Bounded and proven.',
};

const discoveryProposalCrash = async ({ client, task, prompt, attempt }) => {
  // Always try to submit the product. On attempt 1, we crash after.
  // On attempt 2+, the typed submission may already exist (from attempt 1),
  // so we catch the duplicate error and still complete.
  try {
    await actions.submitProduct(client, 'factory.discovery-proposal.v1', proposalContent);
  } catch (e) {
    // Typed submission already exists from a prior attempt — that's OK.
    // The gate will find it via the process_run_id scope.
    if (!e.message.includes('already exists')) throw e;
  }

  if (attempt === 1) {
    // CRASH: exit without worker_done. The Factory will detect the missing
    // receipt, advance the Workplace to repair_wait, and requeue.
    return; // no worker_done — crash simulation
  }

  // Attempt 2+: complete normally
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal (after crash recovery)');
};

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
  await actions.submitProduct(client, 'factory.discovery-readiness-assessment.v2', {
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

// Import formalization scenarios from golden-path
const { goldenPathScenarios } = await import('./golden-path-scenarios.mjs');

// Persistent-crash variant for ADR-075 epoch coverage: EVERY attempt
// submits the typed product and exits without worker_done. The cell's
// recovery budget must exhaust and roll over into immutable recovery
// epochs — never a human park. (The one-shot `discoveryProposalCrash`
// above cannot produce epochs anymore: a healthy retry path converges
// without ever exhausting the budget.)
const discoveryProposalPersistentCrash = async ({ client }) => {
  try {
    await actions.submitProduct(client, 'factory.discovery-proposal.v1', proposalContent);
  } catch (e) {
    if (!e.message.includes('already exists')) throw e;
  }
  // No worker_done on ANY attempt — persistent crash simulation.
};

export const scenarios = {
  // Spread golden-path first, then override with crash-specific handlers.
  // This ensures the crash handler for produce-proposal takes precedence.
  ...goldenPathScenarios,
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposalCrash,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};

export const persistentCrashScenarios = {
  ...goldenPathScenarios,
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposalPersistentCrash,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
};
