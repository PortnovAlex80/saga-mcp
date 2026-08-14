// tests/factory-contract/golden-path-scenarios.mjs
//
// Deterministic physical-worker scripts for the FULL Product Delivery path.
// Scripts use only normal worker-facing MCP/Git boundaries. They never choose
// work, mutate Factory authority tables, decide Gates or route the lifecycle.

import { spawnSync } from 'node:child_process';
import { actions } from './scenario-engine.mjs';

const FRM = 'solution-formalization@1.0.0';
const DISC = 'product-discovery@3.0.2';
const DEV = 'solution-development@1.3.1';

function metaOf(task) {
  return typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
}

function findObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findObject(child, predicate, seen);
    if (found) return found;
  }
  return null;
}

function git(repoPath, args) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const discoveryProposal = async ({ client, prompt }) => {
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', {
    problem_statement: 'The current pipeline lacks automated end-to-end validation.',
    observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
    stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
    assumptions: ['Factory physics is correct in isolation.', 'Deterministic workers can substitute LLM.'],
    unknowns: ['None blocking.'],
    risks: ['Fixture drift risk.'],
    candidate_scope: 'Run Product Delivery through the real Factory with deterministic physical workers.',
    evidence_refs: ['CONVEYOR-MENTAL-MODEL.md §16', 'factory-contract harness'],
    recommended_outcome: 'go',
    rationale: 'Concrete gap, bounded scope and deterministic verification path.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced discovery proposal with recommended_outcome=go');
};

const discoveryReadiness = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const pni = meta.process_node_input;
  let proposalSchema, proposalRef, proposalDigest;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
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
      stakeholder_coverage: { status: 'sufficient', rationale: 'Identified.', source_refs: ['$.stakeholders_or_actors'] },
      assumption_visibility: { status: 'sufficient', rationale: 'Explicit.', source_refs: ['$.assumptions'] },
      unknowns_manageability: { status: 'sufficient', rationale: 'No blocker.', source_refs: ['$.unknowns'] },
      risk_visibility: { status: 'sufficient', rationale: 'Visible.', source_refs: ['$.risks'] },
      evidence_grounding: { status: 'sufficient', rationale: 'Grounded.', source_refs: ['$.evidence_refs'] },
    },
    blocking_gaps: [],
    non_blocking_gaps: [],
    recommended_next_action: 'proceed_to_settlement',
    confidence: 0.95,
    rationale: 'Ready for deterministic formalization.',
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'produced readiness assessment: ready');
};

// ---------------------------------------------------------------------------
// Formalization
// ---------------------------------------------------------------------------

const formalizationProduct = async ({ client, task, prompt, repoPath }) => {
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
  if (repoPath) actions.writeFile(repoPath, 'docs/formalization/BRIEF-1.md', '# Product Brief\n');
  const brief = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted', content_hash: briefHash,
    metadata: { brief_payload: briefPayload },
  });
  const prd = await actions.createArtifact(client, {
    projectId, epicId, type: 'PRD', code: 'PRD', title: 'Product Requirements',
    artifactPath: 'docs/formalization/PRD.md', repoPath,
  });
  const fr = await actions.createArtifact(client, {
    projectId, epicId, type: 'FR', code: 'FR-1', title: 'Functional Requirement 1',
    artifactPath: 'docs/formalization/FR-1.md', repoPath,
  });
  await actions.createArtifact(client, {
    projectId, epicId, type: 'NFR', code: 'NFR-1', title: 'Non-Functional Requirement 1',
    artifactPath: 'docs/formalization/NFR-1.md', repoPath,
  });
  await actions.createArtifact(client, {
    projectId, epicId, type: 'RULE', code: 'RULE-1', title: 'Business Rule 1',
    artifactPath: 'docs/formalization/RULE-1.md', repoPath,
  });
  await actions.addTrace(client, prd.id, brief.id, 'derived_from');
  await actions.addTrace(client, fr.id, prd.id, 'derived_from');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization product-contract: brief→PRD→FR/NFR/RULE');
};

const formalizationUseCases = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const prds = await actions.findAcceptedArtifacts(client, epicId, 'PRD');
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  if (!prds.length || !frs.length) throw new Error('No accepted PRD/FR for use-cases');
  const uc = await actions.createArtifact(client, {
    projectId, epicId, type: 'UC', code: 'UC-1', title: 'Use Case 1',
    artifactPath: 'docs/formalization/UC-1.md', repoPath,
  });
  await actions.addTrace(client, uc.id, prds[0].id, 'derived_from');
  await actions.addTrace(client, uc.id, frs[0].id, 'covers');
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'formalization use-cases: UC→PRD+FR');
};

const formalizationAcceptance = async ({ client, task, prompt, repoPath }) => {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const frs = await actions.findAcceptedArtifacts(client, epicId, 'FR');
  const nfrs = await actions.findAcceptedArtifacts(client, epicId, 'NFR');
  const ucs = await actions.findAcceptedArtifacts(client, epicId, 'UC');
  if (!frs.length) throw new Error('No accepted FR for acceptance');
  const ac1 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
    artifactPath: 'docs/formalization/AC-1.md', repoPath,
  });
  await actions.addTrace(client, ac1.id, frs[0].id, 'derived_from');
  if (ucs.length) await actions.addTrace(client, ac1.id, ucs[0].id, 'derived_from');
  const ac2 = await actions.createArtifact(client, {
    projectId, epicId, type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance',
    artifactPath: 'docs/formalization/AC-2.md', repoPath,
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

  const srsContent = `# SRS\n\n## §D2 Acceptance Criteria Decomposition\n\n\`\`\`yaml\n- ac: AC-1\n  title: Pipeline Completes\n  module: src/factory-contract\n  files: ['src/factory-contract/']\n  invariants: ['Factory reaches terminal']\n  test_layers: ['e2e']\n  pattern: A\n  depends_on: []\n  ac_kind: implementation\n  criticality: blocker\n- ac: AC-2\n  title: NFR Compliance\n  module: src/factory-contract\n  files: ['src/factory-contract/']\n  invariants: ['Deterministic']\n  test_layers: ['contract']\n  pattern: B\n  depends_on: []\n  ac_kind: implementation\n  criticality: degradable\n\`\`\`\n\n## §12 Decision Log\n\n| # | Decision | Source/profile | Alternatives considered | Rationale | Date |\n|---|----------|---------------|------------------------|-----------|------|\n| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-08 |\n`;
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

const approvedReview = async ({ client, task, prompt }) => {
  const wpRef = metaOf(task).workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  await actions.submitProduct(client, 'factory.review-verdict.v1', {
    verdict: 'approved', findings: [],
    subject_candidate_set_ref: cand.candidate_set_ref,
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'review: approved');
};

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

const developmentPlan = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const developmentCase = findObject(
    meta.process_node_input ?? meta.cell_input_item ?? meta,
    value => value.schemaVersion === 'factory.development-case.v1',
  );
  if (!developmentCase) throw new Error('DevelopmentCase not found in planner task input');
  const repos = developmentCase.repositories || [];
  const repo = repos[0];
  if (!repo) throw new Error('DevelopmentCase has no repository');
  const criteria = developmentCase.acceptanceCriteria || [];
  const implementationCriteria = criteria.filter(ac => ac.implementationRequired);
  const criterionId = ac => ac.artifactId;
  const implementationItems = implementationCriteria.map((ac, index) => ({
      key: `impl-${criterionId(ac)}`,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: repo.projectRepositoryId,
      acceptanceCriterionIds: [criterionId(ac)],
      // Exercise the real dependency/admission/base-propagation path. A
      // deterministic chain is deliberately used here: scripted production
      // must test the same non-empty DAG physics that real planners can emit,
      // rather than making dependency tests pass vacuously with [] everywhere.
      dependsOnKeys: index === 0
        ? []
        : [`impl-${criterionId(implementationCriteria[index - 1])}`],
      changeScopes: [`src/factory-contract/impl-${criterionId(ac)}.ts`],
      required: true,
      criticality: ac.criticality || 'blocker',
    }));
  const verificationItems = criteria.map(ac => ({
    key: `verify-${criterionId(ac)}`,
    kind: 'verification',
    taskKind: 'verification.ac',
    executionSkill: 'saga-worker',
    executionMode: 'read_only_evidence',
    projectRepositoryId: repo.projectRepositoryId,
    acceptanceCriterionIds: [criterionId(ac)],
    dependsOnKeys: [],
    changeScopes: [],
    required: true,
    criticality: ac.criticality || 'blocker',
  }));
  await actions.submitProduct(client, 'factory.development-task-graph-proposal.v1', {
    schemaVersion: 'factory.development-task-graph-proposal.v1',
    implementationItems,
    verificationItems,
    integrationTargets: [{
      projectRepositoryId: repo.projectRepositoryId,
      sourceWorkItemKeys: implementationItems.map(item => item.key),
      targetBranch: repo.integrationBranch,
      expectedBaseCommit: repo.expectedBaseCommit,
    }],
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `planned ${implementationItems.length} implementation + ${verificationItems.length} verification items`);
};

const developmentImplement = async ({ client, task, prompt, repoPath, desk }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'implementation');
  if (!item?.key) throw new Error('implementation work item not found');
  const workItemKey = String(item.key);
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  // Git Desk parity: commit inside the per-task worktree the factory
  // provisioned (same as a production worker). The worktree is already on
  // branch task/<id> at the frozen base commit — NO checkout -B, NO checkout
  // back. This eliminates the shared-checkout race that caused
  // PRODUCTION_CELL_REVIEWED_SOURCE_MISMATCH under concurrency ≥ 2.
  const filePath = `src/factory-contract/${safe}.ts`;
  const branch = desk?.branch || `factory-contract-${safe}-${String(prompt.task_id)}`;
  const integrationBranch = desk?.integrationBranch || 'dev';
  const baseCommit = desk?.baseCommit || git(repoPath, ['rev-parse', `refs/heads/${integrationBranch}`]);
  // When a desk is provisioned, the worktree is the repoPath. Without a desk
  // (legacy path), we must checkout -B our own branch in the shared root.
  if (!desk) {
    git(repoPath, ['checkout', '-B', branch, integrationBranch]);
  }
  actions.writeFile(repoPath, filePath,
    `// deterministic implementation for ${workItemKey}\nexport const ${safe.replace(/[^a-zA-Z0-9_]/g, '_')} = true;\n`);
  git(repoPath, ['add', filePath]);
  git(repoPath, ['commit', '-m', `factory-contract: implement ${workItemKey}`]);
  const commitSha = git(repoPath, ['rev-parse', 'HEAD']);
  const treeSha = git(repoPath, ['rev-parse', `${commitSha}^{tree}`]);

  await actions.submitProduct(client, 'factory.development-implementation-result.v1', {
    workItemKey,
    terminalStatus: 'complete',
    source: { branch, commitSha, workItemKey },
    snapshot: { commitSha, treeSha, files: [filePath], changedFiles: [filePath] },
    repository: {
      projectRepositoryId: Number(item.projectRepositoryId || task.project_repository_id || 1),
      integrationBranch,
      baseCommit,
      name: 'factory-contract-repo',
    },
    buildProducts: [],
    readiness: {
      kind: 'static',
      commands: {
        installCommand: null,
        testCommand: 'node -e "process.exit(0)"',
      },
    },
    reasonCodes: [],
  });
  // NO checkout back to integration branch when using a desk — the worktree is
  // disposable. Legacy path (no desk) restores the integration branch so the
  // next worker in the shared root starts clean.
  if (!desk) {
    git(repoPath, ['checkout', integrationBranch]);
  }
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `implemented ${workItemKey}`);
};

const developmentReview = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const wpRef = meta.workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  const implRef = (cand.product_refs || []).find(
    p => p.schemaId === 'factory.development-implementation-result.v1',
  );
  if (!implRef) throw new Error('implementation result missing from author CandidateSet');
  const read = await client.callJson('product_read', {
    schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
  });
  const impl = read.content || read;
  await actions.submitProduct(client, 'factory.development-review-verdict.v1', {
    subject_candidate_set_ref: cand.candidate_set_ref,
    verdict: 'approved',
    findings: [],
    workItemKey: impl.workItemKey,
    reviewedCandidate: {
      sourceCommit: impl.source?.commitSha,
      sourceTree: impl.snapshot?.treeSha,
    },
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `review approved ${impl.workItemKey}`);
};

const developmentVerify = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'verification');
  if (!item?.key) throw new Error('verification work item not found');
  const candidate = findObject(
    meta.process_node_input ?? meta,
    value => value.schemaVersion === 'factory.integrated-release-candidate.v1'
      && typeof value.candidateHash === 'string',
  );
  if (!candidate) throw new Error('frozen candidate not found in verification input');
  const acId = Number(item.acceptanceCriterionIds?.[0] || task.verification_target_artifact_id || 0);
  if (!acId) throw new Error('verification acceptanceCriterionId missing');
  const acResp = await client.callJson('artifact_get', { id: acId });
  const ac = acResp.artifact || acResp;
  const acceptedCriterionHash = ac.accepted_hash || ac.content_hash;
  if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);
  const evidenceBody = {
    verificationItemKey: item.key,
    acceptanceCriterionId: acId,
    candidateHash: candidate.candidateHash,
    result: 'passed',
  };
  const evidenceHash = actions.contentHash(JSON.stringify(evidenceBody));
  await actions.submitProduct(client, 'factory.candidate-verification-evidence-product.v2', {
    schemaVersion: 'factory.candidate-verification-evidence-product.v2',
    verificationItemKey: item.key,
    acceptanceCriterionId: acId,
    acceptedCriterionHash,
    candidateHash: candidate.candidateHash,
    outcome: 'passed',
    evidence: {
      summary: `Factory contract verification passed for ${item.key}`,
      observations: [`evidence digest ${evidenceHash}`],
      limitations: [],
    },
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `verified ${item.key}`);
};

export const goldenPathScenarios = {
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,

  [`${FRM}/define-product-contract/author/singleton`]: formalizationProduct,
  [`${FRM}/model-use-cases/author/singleton`]: formalizationUseCases,
  [`${FRM}/define-acceptance-contract/author/singleton`]: formalizationAcceptance,
  [`${FRM}/reconcile-what/author/singleton`]: formalizationReconcile,
  [`${FRM}/define-architecture-contract/author/singleton`]: formalizationArchitecture,
  [`${FRM}/define-product-contract/reviewer/singleton`]: approvedReview,
  [`${FRM}/model-use-cases/reviewer/singleton`]: approvedReview,
  [`${FRM}/define-acceptance-contract/reviewer/singleton`]: approvedReview,
  [`${FRM}/reconcile-what/reviewer/singleton`]: approvedReview,
  [`${FRM}/define-architecture-contract/reviewer/singleton`]: approvedReview,

  [`${DEV}/plan-task-graph/author/singleton`]: developmentPlan,
  [`${DEV}/implement-work-items/author/*`]: developmentImplement,
  [`${DEV}/implement-work-items/reviewer/*`]: developmentReview,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
};
