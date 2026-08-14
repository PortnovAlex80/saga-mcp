// tests/factory-e2e/w9-happy-handlers.mjs
//
// W9-02 per-module SCRIPTED HANDLERS for the clean scripted happy path. Every
// (module, cell, role) on the main spine — Discovery, Formalization,
// Development — is driven by a deterministic in-process handler that calls the
// SAME production MCP tool handlers (product_submit / artifact_create /
// trace_add / worker_done) the spawn-based golden-path scenarios call, then
// worker_done. The handlers are the AUTHORITY for product shapes; they produce
// CORRECT products, they do NOT bypass via authority hacks.
//
// These mirror tests/factory-contract/golden-path-scenarios.mjs but execute
// entirely in-process (no child MCP client) against the fresh harness.
//
// Key W9-02 wiring (the deferred LR gaps satisfied by the scripted handlers):
//   - developmentImplement commits a REAL minimal runnable artifact (the fresh
//     repo already carries package.json + test.js from provisionFreshRepo) and
//     declares an explicit STATIC readiness profile on the implementation
//     result. The freeze propagates it onto the frozen candidate (LR-04).
//   - The integrated candidate is sealed into an author candidate set by the
//     freeze (LR-01 exact-member resolution), so the local-runnability provider
//     can resolve it as its subject and produce a passed receipt (LR-07).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DISC = 'product-discovery@3.0.2';
const FRM = 'solution-formalization@1.0.0';
const DEV = 'solution-development@1.3.1';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
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

function artifactHash(type, code, title) {
  return sha256(`${type}:${code}:${title}`);
}

/**
 * Read accepted artifacts of a given type from the DB (in-process equivalent of
 * actions.findAcceptedArtifacts).
 */
function findAcceptedArtifacts(db, epicId, type) {
  return db.prepare(
    `SELECT id,project_id,epic_id,type,code,title,status,content_hash,accepted_hash
       FROM artifacts
      WHERE epic_id=? AND type=? AND status='accepted'
      ORDER BY id`,
  ).all(epicId, type);
}

/** Resolve { projectId, epicId } from the task row (tasks carry epic_id). */
function taskScope(db, taskId) {
  const row = db.prepare(
    'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
  ).get(Number(taskId));
  return { projectId: row?.project_id ?? 1, epicId: row?.epic_id ?? 1 };
}

/**
 * The EXPLICIT STATIC readiness profile the scripted implementation declares.
 * The fresh repo carries test.js (process.exit(0)) + package.json from
 * provisionFreshRepo; the integration merges the impl file on top, so the
 * integrated tree still has a passing test. Static = runnability proven by the
 * test command alone (no serve probe → deterministic, no cold-start timing).
 */
const RUNNABLE_STATIC_READINESS = Object.freeze({
  kind: 'static',
  commands: { installCommand: null, testCommand: 'node test.js' },
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discoveryProposal({ handlers, assignment }) {
  handlers.product_submit({
    schema: 'factory.discovery-proposal.v1',
    content: {
      problem_statement: 'The current pipeline lacks automated end-to-end validation.',
      observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
      stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
      assumptions: ['Factory physics is correct in isolation.', 'Deterministic workers can substitute LLM.'],
      unknowns: ['None blocking.'],
      risks: ['Fixture drift risk.'],
      candidate_scope: 'Run Product Delivery through the real Factory with deterministic physical workers.',
      evidence_refs: ['CONVEYOR-MENTAL-MODEL.md', 'factory-e2e harness'],
      recommended_outcome: 'go',
      rationale: 'Concrete gap, bounded scope and deterministic verification path.',
    },
  });
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result: 'produced discovery proposal with recommended_outcome=go',
  });
  return { kind: 'worker-done-accepted' };
}

function discoveryReadiness({ handlers, assignment, db, meta }) {
  const { epicId } = taskScope(db, assignment.taskId);
  // Resolve the discovery proposal ProductRef from the task input (the same way
  // the golden-path readiness handler does), then read the submission id.
  const pni = meta.process_node_input;
  let proposalSchema, proposalRef, proposalDigest;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
      if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
    }
  }
  let proposalId = 0;
  if (proposalRef) {
    const read = handlers.product_read({
      schema_id: proposalSchema, ref: proposalRef, digest: proposalDigest,
    });
    proposalId = read.submission_id ?? 0;
  } else {
    // Fallback: find the proposal submission for this epic.
    const row = db.prepare(
      `SELECT id, content_hash FROM factory_managed_node_submissions
        WHERE schema_version='factory.discovery-proposal.v1' AND epic_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(epicId);
    if (!row) throw new Error('No discovery proposal for readiness assessment');
    proposalId = row.id;
    proposalDigest = row.content_hash;
  }

  handlers.product_submit({
    schema: 'factory.discovery-readiness-assessment.v1',
    content: {
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
    },
  });
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result: 'produced readiness assessment: ready',
  });
  return { kind: 'worker-done-accepted' };
}

// ---------------------------------------------------------------------------
// Formalization
// ---------------------------------------------------------------------------

function writeRepoFile(repoPath, filePath, content) {
  const fullPath = path.join(repoPath, filePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function formalizationProduct({ handlers, assignment, meta, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const briefPayload = {
    classification: 'product', complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go', reasoning: 'Feasible and bounded.',
    affected_projects: [projectId], topology_hint: 'sequence',
    scaffold_artifacts: [], shared_mutation_risk: false,
    completeness: 'high', degraded: false,
  };
  const briefHash = sha256('brief:BRIEF-1');
  writeRepoFile(repoPath, 'docs/formalization/BRIEF-1.md', '# Product Brief\n');
  const brief = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted', content_hash: briefHash,
    metadata: { brief_payload: briefPayload },
  });
  const prd = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'PRD', code: 'PRD', title: 'Product Requirements',
    artifactPath: 'docs/formalization/PRD.md', repoPath,
  });
  const fr = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'FR', code: 'FR-1', title: 'Functional Requirement 1',
    artifactPath: 'docs/formalization/FR-1.md', repoPath,
  });
  createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'NFR', code: 'NFR-1', title: 'Non-Functional Requirement 1',
    artifactPath: 'docs/formalization/NFR-1.md', repoPath,
  });
  createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'RULE', code: 'RULE-1', title: 'Business Rule 1',
    artifactPath: 'docs/formalization/RULE-1.md', repoPath,
  });
  addTrace(handlers, prd.id, brief.id, 'derived_from');
  addTrace(handlers, fr.id, prd.id, 'derived_from');
  done(handlers, assignment, 'formalization product-contract: brief->PRD->FR/NFR/RULE');
  return { kind: 'worker-done-accepted' };
}

function createFormalizationArtifact(handlers, {
  projectId, epicId, type, code, title, artifactPath, repoPath, status = 'accepted',
}) {
  const hash = artifactHash(type, code, title);
  if (repoPath && artifactPath) {
    writeRepoFile(repoPath, artifactPath, `# ${title}\n\nDeterministic ${type} artifact for ${code}.\n`);
  }
  return handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type, code, title,
    path: artifactPath, status, content_hash: hash,
  });
}

function addTrace(handlers, sourceId, targetId, linkType) {
  handlers.trace_add({
    source_id: sourceId, target_type: 'artifact', target_id: targetId, link_type: linkType,
  });
}

function formalizationUseCases({ handlers, assignment, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const prds = findAcceptedArtifacts(db, epicId, 'PRD');
  const frs = findAcceptedArtifacts(db, epicId, 'FR');
  if (!prds.length || !frs.length) throw new Error('No accepted PRD/FR for use-cases');
  const uc = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'UC', code: 'UC-1', title: 'Use Case 1',
    artifactPath: 'docs/formalization/UC-1.md', repoPath,
  });
  addTrace(handlers, uc.id, prds[0].id, 'derived_from');
  addTrace(handlers, uc.id, frs[0].id, 'covers');
  done(handlers, assignment, 'formalization use-cases: UC->PRD+FR');
  return { kind: 'worker-done-accepted' };
}

function formalizationAcceptance({ handlers, assignment, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const frs = findAcceptedArtifacts(db, epicId, 'FR');
  const nfrs = findAcceptedArtifacts(db, epicId, 'NFR');
  const ucs = findAcceptedArtifacts(db, epicId, 'UC');
  if (!frs.length) throw new Error('No accepted FR for acceptance');
  const ac1 = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
    artifactPath: 'docs/formalization/AC-1.md', repoPath,
  });
  addTrace(handlers, ac1.id, frs[0].id, 'derived_from');
  if (ucs.length) addTrace(handlers, ac1.id, ucs[0].id, 'derived_from');
  const ac2 = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance',
    artifactPath: 'docs/formalization/AC-2.md', repoPath,
  });
  if (nfrs.length) addTrace(handlers, ac2.id, nfrs[0].id, 'derived_from');
  done(handlers, assignment, 'formalization acceptance: AC->FR/NFR+UC');
  return { kind: 'worker-done-accepted' };
}

function formalizationReconcile({ handlers, assignment }) {
  handlers.product_submit({
    schema: 'factory.formalization-reconciliation-report.v1',
    content: {
      status: 'reconciled', rationale: 'All artifacts trace correctly.',
      remaining_gaps: [], repairs: [],
    },
  });
  done(handlers, assignment, 'formalization reconciliation: reconciled');
  return { kind: 'worker-done-accepted' };
}

function formalizationArchitecture({ handlers, assignment, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const prds = findAcceptedArtifacts(db, epicId, 'PRD');
  if (!prds.length) throw new Error('No accepted PRD for architecture');

  const srsContent = [
    '# SRS',
    '',
    '## §D2 Acceptance Criteria Decomposition',
    '',
    '```yaml',
    '- ac: AC-1',
    '  title: Pipeline Completes',
    '  module: src/factory-e2e',
    '  files: ["src/factory-e2e/"]',
    "  invariants: ['Factory reaches terminal']",
    "  test_layers: ['e2e']",
    '  pattern: A',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: blocker',
    '- ac: AC-2',
    '  title: NFR Compliance',
    '  module: src/factory-e2e',
    '  files: ["src/factory-e2e/"]',
    "  invariants: ['Deterministic']",
    "  test_layers: ['contract']",
    '  pattern: B',
    '  depends_on: []',
    '  ac_kind: implementation',
    '  criticality: degradable',
    '```',
    '',
    '## §12 Decision Log',
    '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|---------------|------------------------|-----------|------|',
    '| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-12 |',
    '',
  ].join('\n');
  const srsPath = 'docs/formalization/SRS.md';
  writeRepoFile(repoPath, srsPath, srsContent);
  const fileHash = sha256(srsContent);
  const srs = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS',
    title: 'SRS', path: srsPath, status: 'draft',
    content_hash: fileHash, project_repository_id: 1,
  });
  addTrace(handlers, srs.id, prds[0].id, 'derived_from');
  done(handlers, assignment, 'formalization architecture: SRS->PRD');
  return { kind: 'worker-done-accepted' };
}

/**
 * Approved review verdict for any formalization reviewer cell. Reads the author
 * candidate to bind the verdict to the exact subject candidate set.
 */
function formalizationApprovedReview({ handlers, assignment, meta }) {
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (!workplaceRef) throw new Error('reviewer task has no workplace_ref');
  const cand = handlers.candidate_read({ workplace_ref: workplaceRef, role: 'author' });
  handlers.product_submit({
    schema: 'factory.review-verdict.v1',
    content: {
      verdict: 'approved', findings: [],
      subject_candidate_set_ref: cand.candidate_set_ref,
    },
  });
  done(handlers, assignment, 'review: approved');
  return { kind: 'worker-done-accepted' };
}

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

function developmentPlan({ handlers, assignment, meta }) {
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
    dependsOnKeys: index === 0
      ? []
      : [`impl-${criterionId(implementationCriteria[index - 1])}`],
    // Cover the requiredChangeScopes ('package.json', 'tests/') that
    // assembleProductLifecycleInput mandates for bootstrap material, plus the
    // item's own source file. The change scope MUST match the file path the
    // implement handler writes (src/w9/<workItemKey>.ts) so the implementation
    // scope check sees the changed path within the frozen authority. The
    // dependency chain makes the shared scope overlap safe.
    changeScopes: [`src/w9/impl-${criterionId(ac)}.ts`, 'package.json', 'tests/'],
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
  handlers.product_submit({
    schema: 'factory.development-task-graph-proposal.v1',
    content: {
      schemaVersion: 'factory.development-task-graph-proposal.v1',
      implementationItems,
      verificationItems,
      integrationTargets: [{
        projectRepositoryId: repo.projectRepositoryId,
        sourceWorkItemKeys: implementationItems.map(item => item.key),
        targetBranch: repo.integrationBranch,
        expectedBaseCommit: repo.expectedBaseCommit,
      }],
    },
  });
  done(handlers, assignment,
    `planned ${implementationItems.length} implementation + ${verificationItems.length} verification items`);
  return { kind: 'worker-done-accepted' };
}

function developmentImplement({ handlers, assignment, meta, context, db }) {
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'implementation');
  if (!item?.key) throw new Error('implementation work item not found');
  const workItemKey = String(item.key);
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  // Resolve the repo path + integration branch from the DB (the same source the
  // integration effect reads). Fall back to the workspace root.
  const binding = db
    ? db.prepare(
        `SELECT pr.local_path, pr.integration_branch
           FROM tasks t
           JOIN project_repositories pr ON pr.id = t.project_repository_id
          WHERE t.id = ?`,
      ).get(Number(assignment.taskId))
    : null;
  const repoPath = binding?.local_path ?? context.workspaceRoot;
  const integrationBranch = binding?.integration_branch || 'dev';

  const branch = `task/${safe}-${assignment.taskId}`;
  // Create the task branch from the integration branch, write the impl file,
  // and commit. The branch ref MUST point at the commit (the integration effect
  // reads refs/heads/<sourceBranch> to verify the source commit).
  git(repoPath, 'checkout', '-B', branch, integrationBranch);
  const filePath = `src/w9/${safe}.ts`;
  writeRepoFile(repoPath, filePath,
    `// deterministic implementation for ${workItemKey}\nexport const ${safe.replace(/[^a-zA-Z0-9_]/g, '_')} = true;\n`);
  git(repoPath, 'add', filePath);
  git(repoPath, 'commit', '-m', `w9: implement ${workItemKey}`);
  const commitSha = git(repoPath, 'rev-parse', 'HEAD');
  const treeSha = git(repoPath, 'rev-parse', `${commitSha}^{tree}`);
  const baseCommit = git(repoPath, 'merge-base', integrationBranch, branch) ||
    git(repoPath, 'rev-parse', integrationBranch);

  // Checkout back to the integration branch so the next worker starts clean.
  git(repoPath, 'checkout', integrationBranch);

  const projectRepositoryId = Number(item.projectRepositoryId || meta.project_repository_id || 1);
  handlers.product_submit({
    schema: 'factory.development-implementation-result.v1',
    content: {
      workItemKey,
      terminalStatus: 'complete',
      source: { branch, commitSha, workItemKey },
      snapshot: { commitSha, treeSha, files: [filePath], changedFiles: [filePath] },
      repository: {
        projectRepositoryId,
        integrationBranch,
        baseCommit,
        name: 'fresh-harness-repo',
      },
      buildProducts: [],
      reasonCodes: [],
      // LR-04 — the explicit STATIC readiness profile. The fresh repo already
      // has test.js (process.exit(0)) + package.json; the integrated tree still
      // has them after merging this impl file, so `node test.js` passes against
      // the exact sealed commit. The freeze propagates this onto the candidate.
      readiness: RUNNABLE_STATIC_READINESS,
    },
  });
  done(handlers, assignment, `implemented ${workItemKey}`);
  return { kind: 'worker-done-accepted' };
}

function developmentReview({ handlers, assignment, meta }) {
  const workplaceRef = meta.workplace_ref ?? meta.workplaceRef;
  if (!workplaceRef) throw new Error('reviewer task has no workplace_ref');
  const cand = handlers.candidate_read({ workplace_ref: workplaceRef, role: 'author' });
  const implRef = (cand.product_refs || []).find(
    p => p.schemaId === 'factory.development-implementation-result.v1',
  );
  if (!implRef) throw new Error('implementation result missing from author CandidateSet');
  const read = handlers.product_read({
    schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
  });
  const impl = read.content || read;
  handlers.product_submit({
    schema: 'factory.development-review-verdict.v1',
    content: {
      subject_candidate_set_ref: cand.candidate_set_ref,
      verdict: 'approved',
      findings: [],
      workItemKey: impl.workItemKey,
      reviewedCandidate: {
        sourceCommit: impl.source?.commitSha,
        sourceTree: impl.snapshot?.treeSha,
      },
    },
  });
  done(handlers, assignment, `review approved ${impl.workItemKey}`);
  return { kind: 'worker-done-accepted' };
}

function developmentVerify({ handlers, assignment, meta, db }) {
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'verification');
  if (!item?.key) throw new Error('verification work item not found');
  const candidate = findObject(
    meta.process_node_input ?? meta,
    value => value.schemaVersion === 'factory.integrated-release-candidate.v1'
      && typeof value.candidateHash === 'string',
  );
  if (!candidate) throw new Error('frozen candidate not found in verification input');
  const acId = Number(item.acceptanceCriterionIds?.[0] || meta.verification_target_artifact_id || 0);
  if (!acId) throw new Error('verification acceptanceCriterionId missing');
  // Read the AC's accepted_hash directly from the DB.
  const acRow = db.prepare(
    'SELECT accepted_hash, content_hash FROM artifacts WHERE id=?',
  ).get(acId);
  const acceptedCriterionHash = acRow?.accepted_hash || acRow?.content_hash;
  if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);

  handlers.product_submit({
    schema: 'factory.candidate-verification-evidence-product.v2',
    content: {
      schemaVersion: 'factory.candidate-verification-evidence-product.v2',
      verificationItemKey: item.key,
      acceptanceCriterionId: acId,
      acceptedCriterionHash,
      candidateHash: candidate.candidateHash,
      outcome: 'passed',
      evidence: {
        summary: `W9 scripted verification passed for ${item.key}`,
        observations: [`candidate ${candidate.candidateHash.slice(0, 12)}`],
        limitations: [],
      },
    },
  });
  done(handlers, assignment, `verified ${item.key}`);
  return { kind: 'worker-done-accepted' };
}

function done(handlers, assignment, result) {
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result,
  });
}

/**
 * The W9-02 happy-path scripted handler map, keyed by scriptedScenarioKey().
 * Wildcards follow the same precedence as scripted-inference.mjs:
 *   exact → `${module}/${node}/${role}/*` → `*`.
 */
export const W9_HAPPY_HANDLERS = Object.freeze({
  // Discovery
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,

  // Formalization authors
  [`${FRM}/define-product-contract/author/singleton`]: formalizationProduct,
  [`${FRM}/model-use-cases/author/singleton`]: formalizationUseCases,
  [`${FRM}/define-acceptance-contract/author/singleton`]: formalizationAcceptance,
  [`${FRM}/reconcile-what/author/singleton`]: formalizationReconcile,
  [`${FRM}/define-architecture-contract/author/singleton`]: formalizationArchitecture,

  // Formalization reviewers (all use the same approved verdict)
  [`${FRM}/define-product-contract/reviewer/singleton`]: formalizationApprovedReview,
  [`${FRM}/model-use-cases/reviewer/singleton`]: formalizationApprovedReview,
  [`${FRM}/define-acceptance-contract/reviewer/singleton`]: formalizationApprovedReview,
  [`${FRM}/reconcile-what/reviewer/singleton`]: formalizationApprovedReview,
  [`${FRM}/define-architecture-contract/reviewer/singleton`]: formalizationApprovedReview,

  // Development
  [`${DEV}/plan-task-graph/author/singleton`]: developmentPlan,
  [`${DEV}/implement-work-items/author/*`]: developmentImplement,
  [`${DEV}/implement-work-items/reviewer/*`]: developmentReview,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
});
