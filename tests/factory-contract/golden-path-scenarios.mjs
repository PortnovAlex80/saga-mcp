// tests/factory-contract/golden-path-scenarios.mjs
//
// Scenario definitions for the deterministic golden path:
// Discovery → Formalization → Development → Delivery
//
// Each handler describes ONLY what the worker does through the real MCP boundary.
// The Factory owns all consequences (gate decisions, state transitions, etc.).

import { actions } from './scenario-engine.mjs';

const S = 'factory';
const FRM = 'solution-formalization@1.0.0';
const DISC = 'product-discovery@3.0.2';
const DEV = 'solution-development@1.0.0';

// --- Discovery scenarios ---

const discoveryProposal = async ({ client, task, prompt }) => {
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', {
    problem_statement: 'The current pipeline lacks automated end-to-end validation.',
    observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
    stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
    assumptions: ['Factory physics is correct in isolation.', 'Deterministic workers can substitute LLM.'],
    unknowns: ['MCP-config builder under saga4.'],
    risks: ['Fixture drift risk.'],
    candidate_scope: 'Build a mock-claude worker covering the Discovery module end-to-end.',
    evidence_refs: ['test:e2e-pipeline.test.mjs (missing)', 'CONVEYOR-MENTAL-MODEL.md §16'],
    recommended_outcome: 'go',
    rationale: 'Concrete gap, proven approach, bounded scope.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal with recommended_outcome=go');
};

const discoveryReadiness = async ({ client, task, prompt }) => {
  const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
  const pni = meta.process_node_input;
  // Extract proposal ProductRef from the production-cell-output-manifest
  let proposalSchema, proposalRef, proposalDigest;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(p => p.schemaId === 'factory.discovery-proposal.v1');
      if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
    }
  }
  if (!proposalSchema) throw new Error('No proposal product in manifest');
  const proposal = await client.callJson('product_read', {
    schema_id: proposalSchema, ref: proposalRef, digest: proposalDigest,
  });
  const proposalId = proposal.submission_id ?? 0;

  await actions.submitProduct(client, 'factory.discovery-readiness-assessment.v1', {
    proposal_id: proposalId,
    proposal_content_hash: proposalDigest,
    overall_readiness: 'ready',
    dimension_assessments: {
      problem_clarity: { status: 'sufficient', rationale: 'Clear.', source_refs: ['$.problem_statement'] },
      scope_boundedness: { status: 'sufficient', rationale: 'Bounded.', source_refs: ['$.candidate_scope'] },
      stakeholder_coverage: { status: 'sufficient', rationale: 'Three identified.', source_refs: ['$.stakeholders_or_actors'] },
      assumption_visibility: { status: 'sufficient', rationale: 'Two explicit.', source_refs: ['$.assumptions'] },
      unknowns_manageability: { status: 'partial', rationale: 'One unknown.', source_refs: ['$.unknowns'] },
      risk_visibility: { status: 'sufficient', rationale: 'One risk.', source_refs: ['$.risks'] },
      evidence_grounding: { status: 'sufficient', rationale: 'Grounded.', source_refs: ['$.evidence_refs'] },
    },
    blocking_gaps: [],
    non_blocking_gaps: [{ code: 'NG-001', description: 'Fixture drift risk noted.', source_refs: ['$.risks'] }],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.85,
    rationale: 'High confidence.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced readiness assessment: ready');
};

// --- Formalization scenarios ---

const formalizationProduct = async ({ client, task, prompt }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const briefPayload = {
    classification: 'product', complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go', reasoning: 'Feasible and bounded.',
    affected_projects: [projectId], topology_hint: 'sequence',
    scaffold_artifacts: [], shared_mutation_risk: false,
    completeness: 'high', degraded: false,
  };
  const briefHash = actions.contentHash('brief:BRIEF-1');
  const brief = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted', content_hash: briefHash,
    metadata: { brief_payload: briefPayload },
  });
  const prd = await actions.createArtifact(client, {
    projectId, epicId, type: 'PRD', code: 'PRD', title: 'Product Requirements',
    artifactPath: 'docs/formalization/PRD.md',
  });
  const fr = await actions.createArtifact(client, {
    projectId, epicId, type: 'FR', code: 'FR-1', title: 'Functional Requirement 1',
    artifactPath: 'docs/formalization/FR-1.md',
  });
  const nfr = await actions.createArtifact(client, {
    projectId, epicId, type: 'NFR', code: 'NFR-1', title: 'Non-Functional Requirement 1',
    artifactPath: 'docs/formalization/NFR-1.md',
  });
  const rule = await actions.createArtifact(client, {
    projectId, epicId, type: 'RULE', code: 'RULE-1', title: 'Business Rule 1',
    artifactPath: 'docs/formalization/RULE-1.md',
  });
  await actions.addTrace(client, prd.id, brief.id, 'derived_from');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization product-contract: brief→PRD→FR/NFR/RULE');
};

const formalizationUseCases = async ({ client, task, prompt }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const prds = await actions.findAcceptedArtifacts(client, epicId, 'PRD');
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  if (!prds.length || !frs.length) throw new Error('No accepted PRD/FR for use-cases');
  const uc = await actions.createArtifact(client, {
    projectId, epicId, type: 'UC', code: 'UC-1', title: 'Use Case 1',
    artifactPath: 'docs/formalization/UC-1.md',
  });
  await actions.addTrace(client, uc.id, prds[0].id, 'derived_from');
  await actions.addTrace(client, uc.id, frs[0].id, 'covers');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization use-cases: UC→PRD+FR');
};

const formalizationAcceptance = async ({ client, task, prompt }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  const nfrs = await actions.findAcceptedArtifacts(client, epicId, 'NFR');
  const ucs = await actions.findAcceptedArtifacts(client, epicId, 'UC');
  if (!frs.length) throw new Error('No accepted FR for acceptance');
  const ac1 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
    artifactPath: 'docs/formalization/AC-1.md',
  });
  await actions.addTrace(client, ac1.id, frs[0].id, 'derived_from');
  if (ucs.length) await actions.addTrace(client, ac1.id, ucs[0].id, 'derived_from');
  const ac2 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance',
    artifactPath: 'docs/formalization/AC-2.md',
  });
  if (nfrs.length) await actions.addTrace(client, ac2.id, nfrs[0].id, 'derived_from');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization acceptance: AC→FR/NFR+UC');
};

const formalizationReconcile = async ({ client, prompt }) => {
  await actions.submitProduct(client, 'factory.formalization-reconciliation-report.v1', {
    status: 'reconciled', rationale: 'All artifacts trace correctly.',
    remaining_gaps: [], repairs: [],
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization reconciliation: reconciled');
};

const formalizationArchitecture = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const prds = await actions.findAcceptedArtifacts(client, epicId, 'PRD');
  if (!prds.length) throw new Error('No accepted PRD for architecture');

  const srsContent = `# SRS

## §D2 Acceptance Criteria Decomposition

\`\`\`yaml
- ac: AC-1
  title: Pipeline Completes
  module: tests/factory-contract
  files: ['tests/factory-contract/']
  invariants: ['Factory reaches terminal']
  test_layers: ['e2e']
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
- ac: AC-2
  title: NFR Compliance
  module: tests/factory-contract
  files: ['tests/factory-contract/']
  invariants: ['Deterministic']
  test_layers: ['contract']
  pattern: B
  depends_on: []
  ac_kind: implementation
  criticality: degradable
\`\`\`

## §12 Decision Log

| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|---------------|------------------------|-----------|------|
| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-08 |
`;
  const srsPath = 'docs/formalization/SRS.md';
  actions.writeFile(repoPath, srsPath, srsContent);
  const fileHash = actions.contentHash(srsContent);

  const srs = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS',
    title: 'SRS', path: srsPath, status: 'draft',
    content_hash: fileHash, project_repository_id: 1,
  });
  await actions.addTrace(client, srs.id, prds[0].id, 'derived_from');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization architecture: SRS→PRD');
};

const formalizationReview = async ({ client, task, prompt }) => {
  const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
  const wpRef = meta.workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  await actions.submitProduct(client, 'factory.review-verdict.v1', {
    verdict: 'approved', findings: [],
    subject_candidate_set_ref: cand.candidate_set_ref,
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'review: approved');
};

// --- Scenario map ---

export const goldenPathScenarios = {
  // Discovery
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,
  // Formalization authors
  [`${FRM}/define-product-contract/author/singleton`]: formalizationProduct,
  [`${FRM}/model-use-cases/author/singleton`]: formalizationUseCases,
  [`${FRM}/define-acceptance-contract/author/singleton`]: formalizationAcceptance,
  [`${FRM}/reconcile-what/author/singleton`]: formalizationReconcile,
  [`${FRM}/define-architecture-contract/author/singleton`]: formalizationArchitecture,
  // Formalization reviewers (all use the same approved handler)
  [`${FRM}/define-product-contract/reviewer/singleton`]: formalizationReview,
  [`${FRM}/model-use-cases/reviewer/singleton`]: formalizationReview,
  [`${FRM}/define-acceptance-contract/reviewer/singleton`]: formalizationReview,
  [`${FRM}/reconcile-what/reviewer/singleton`]: formalizationReview,
  [`${FRM}/define-architecture-contract/reviewer/singleton`]: formalizationReview,
};
