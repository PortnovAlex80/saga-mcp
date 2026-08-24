// tests/factory-contract/golden-path-scenarios.mjs
//
// Deterministic physical-worker scripts for the FULL Product Delivery path.
// Scripts use only normal worker-facing MCP/Git boundaries. They never choose
// work, mutate Factory authority tables, decide Gates or route the lifecycle.

import { spawnSync } from 'node:child_process';
import { actions } from './scenario-engine.mjs';
import { buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import {
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

const FRM = 'solution-formalization@1.0.0';
const DISC = 'product-discovery@4.0.0';
const DEV = 'solution-development@1.4.4';

function metaOf(task) {
  return typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
}

/**
 * ADR-090 (CC-IC-2) corpus migration: the deterministic author computes the
 * SAME register the Discovery settlement froze (proposal drafts + unknowns +
 * the DECLARED, digest-pinned lifecycle injection table — all public data the
 * author can read) and disposes EVERY entry in the strict v2 grammar, pinning
 * the register digest the dispositions were authored against. The worker_done
 * disposition gate and the settlement freeze verify both.
 */
function constraintRegisterOf(task) {
  const formalizationCase = findObject(
    metaOf(task).process_node_input ?? metaOf(task),
    value => value.schemaVersion === 'factory.formalization-case.v1',
  );
  if (!formalizationCase) return null;
  const payload = formalizationCase.discoveryProposalPayload ?? {};
  return buildOrderConstraintRegisterV2({
    drafts: payload.order_constraints,
    unknowns: payload.unknowns,
    injections: [{
      table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
    }],
  });
}

/**
 * The honest per-kind disposition set of this corpus (the 2026-08-23
 * waiver-authority decision: v2 `waived` is TYPED UNAVAILABLE — brief
 * metadata is worker-authored, so no operator attribution a worker writes
 * can carry authority; workers may PROPOSE waivers in prose only):
 *  - open-question entries ('None blocking.'): `resolved` citing the
 *    AUTHENTIC resolution evidence of this corpus — the Discovery readiness
 *    assessment's unknowns_manageability dimension (sufficient), the product
 *    that adjudicated the unknown. Resolution is a disposition state, NOT a
 *    coverage discharge: the entry stays an obligation;
 *  - every other entry (injected synthesis/ordered-smoke, any draft):
 *    the brief/PRD/AC work carries it — accepted.
 */
function constraintDispositionsOf(register) {
  if (!register) return null;
  const dispositions = {};
  for (const entry of register.constraints) {
    dispositions[entry.id] = entry.kind === 'open-question'
      ? {
        disposition: 'resolved',
        evidenceRef: 'factory.discovery-readiness-assessment.v2:unknowns_manageability',
      }
      : { disposition: 'accepted' };
  }
  return {
    constraint_dispositions: dispositions,
    constraint_dispositions_register_digest: register.registerDigest,
  };
}

/**
 * The SRS §D2 covered_constraint_ids the e2e AC-1 stanza carries: EVERY
 * non-waived register id — accepted AND resolved/deferred alike. On v2,
 * resolved/deferred are disposition states, never coverage discharges, so
 * the open-question entries REMAIN obligations the AC/SRS work must cover
 * (the acceptance/SRS coverage gates diff the v2 register — which never
 * subtracts — against exactly this relay). Read from the accepted brief's
 * metadata: the worker-visible disposition source (the architecture task
 * input carries the frozen baseline, not the FormalizationCase). Legacy v1
 * reasoned waivers are the only lawful exclusion.
 */
async function coveredConstraintIdsFromBrief(client, epicId) {
  const briefs = await actions.findAcceptedArtifacts(client, epicId, 'brief');
  for (const brief of briefs) {
    let metadata = brief.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
    }
    const dispositions = metadata?.constraint_dispositions;
    if (!dispositions || typeof dispositions !== 'object') continue;
    return Object.entries(dispositions)
      .filter(([, value]) => value && value.disposition !== 'waived')
      .map(([id]) => id)
      .sort();
  }
  return [];
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

  await actions.submitProduct(client, 'factory.discovery-readiness-assessment.v2', {
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
  // ADR-090 (CC-IC-2): dispose every register entry in the strict v2 grammar
  // and pin the register digest the dispositions were authored against.
  const register = constraintRegisterOf(task);
  const constraintDispositions = constraintDispositionsOf(register);
  if (repoPath) actions.writeFile(repoPath, 'docs/formalization/BRIEF-1.md', '# Product Brief\n');
  const brief = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted',
    metadata: {
      brief_payload: briefPayload,
      ...(constraintDispositions ?? {}),
    },
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
  // ADR-090 (CC-IC-2): the e2e AC-1 artifact carries the covered_constraint_ids
  // relay for EVERY non-waived register entry (on v2: all of them —
  // resolved/deferred stay obligations) — the acceptance coverage gate diffs
  // the v2 register (which never subtracts) against exactly this metadata,
  // and the baseline freeze projects it into the Development handoff. Never
  // copied from task prose: read back from the accepted brief's dispositions.
  const coveredIds = await coveredConstraintIdsFromBrief(client, epicId);
  // Same file bytes + heading grammar as actions.createArtifact for an AC.
  if (repoPath) {
    actions.writeFile(repoPath, 'docs/formalization/AC-1.md',
      `## AC-1: Pipeline Completes\n\nDeterministic AC artifact for AC-1.\n`);
  }
  const ac1 = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'AC', code: 'AC-1',
    title: 'AC-1: Pipeline Completes', path: 'docs/formalization/AC-1.md',
    status: 'draft',
    metadata: coveredIds.length > 0 ? { covered_constraint_ids: coveredIds } : {},
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

  // ADR-090 (CC-IC-2): the e2e AC-1 stanza carries the covered_constraint_ids
  // relay for EVERY non-waived register entry — the injected
  // whole-product-synthesis + ordered-smoke obligations AND the resolved
  // open-question obligation (a resolution is a disposition state, never a
  // coverage discharge — the entry stays covered by the AC/SRS work).
  const coveredIds = await coveredConstraintIdsFromBrief(client, epicId);
  const coveredField = coveredIds.length > 0
    ? `\n  covered_constraint_ids: ${coveredIds.join(', ')}`
    : '';
  const ac1Stanza = `- ac: AC-1\n  title: Pipeline Completes\n  module: src/factory-contract\n  files: ['src/factory-contract/']\n  invariants: ['Factory reaches terminal']\n  test_layers: ['e2e']\n  pattern: A\n  depends_on: []\n  ac_kind: implementation\n  criticality: blocker${coveredField}`;
  // ADR-090 (CC-IC-2): the §2.2 Module Manifest — the required
  // synthesis-ownership evidence once the register is non-empty. The declared
  // module files must sit inside the plan's implementation change scopes
  // (the planner declares the module directory scope, so every declared
  // file is owned write authority for the chain).
  const srsContent = `# SRS\n\n## §D2 Acceptance Criteria Decomposition\n\n\`\`\`yaml\n${ac1Stanza}\n- ac: AC-2\n  title: NFR Compliance\n  module: src/factory-contract\n  files: ['src/factory-contract/']\n  invariants: ['Deterministic']\n  test_layers: ['contract']\n  pattern: B\n  depends_on: []\n  ac_kind: implementation\n  criticality: degradable\n\`\`\`\n\n### 2.2 Module Manifest\n\n| Module | Files |\n|---|---|\n| factory-contract | \`src/factory-contract/index.ts\` |\n\n## §12 Decision Log\n\n| # | Decision | Source/profile | Alternatives considered | Rationale | Date |\n|---|----------|---------------|------------------------|-----------|------|\n| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-08 |\n`;
  const srsPath = 'docs/formalization/SRS.md';
  actions.writeFile(repoPath, srsPath, srsContent);
  const srs = await client.callJson('artifact_create', {
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS',
    title: 'SRS', path: srsPath, status: 'draft',
    project_repository_id: 1,
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
  const criterionKeyOf = ac => `${ac.artifactId}:${ac.code ?? ''}`;
  const implementationItems = implementationCriteria.map((ac, index) => ({
      key: `impl-${criterionId(ac)}`,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: repo.projectRepositoryId,
      acceptanceCriterionKeys: [criterionKeyOf(ac)],
      // Exercise the real dependency/admission/base-propagation path. A
      // deterministic chain is deliberately used here: scripted production
      // must test the same non-empty DAG physics that real planners can emit,
      // rather than making dependency tests pass vacuously with [] everywhere.
      dependsOnKeys: index === 0
        ? []
        : [`impl-${criterionId(implementationCriteria[index - 1])}`],
      // ADR-090 (CC-IC-2): the SRS §2.2 Module Manifest declares the module
      // directory's files — the chain root owns the whole directory scope,
      // so every declared file is covered write authority; the dependency
      // chain supplies the required ordering for the overlap.
      changeScopes: ['src/factory-contract/'],
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
    acceptanceCriterionKeys: [criterionKeyOf(ac)],
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
  const acKey = String(item.acceptanceCriterionKeys?.[0] ?? '');
  const acId = Number(acKey.split(':')[0]) || task.verification_target_artifact_id || 0;
  if (!acId) throw new Error('verification acceptanceCriterionId missing');
  const acResp = await client.callJson('artifact_get', { id: acId });
  const ac = acResp.artifact || acResp;
  const acceptedCriterionHash = ac.accepted_hash || ac.content_hash;
  if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);
  const evidenceBody = {
    verificationItemKey: item.key,
    acceptanceCriterionKey: acKey,
    candidateHash: candidate.candidateHash,
    result: 'passed',
  };
  const evidenceHash = actions.contentHash(JSON.stringify(evidenceBody));
  await actions.submitProduct(client, 'factory.candidate-verification-evidence-product.v2', {
    schemaVersion: 'factory.candidate-verification-evidence-product.v2',
    verificationItemKey: item.key,
    acceptanceCriterionKey: acKey,
    acceptedCriterionHash,
    candidateHash: candidate.candidateHash,
    // ADR-090 (CC-IC-2): when the verification card pins coveredConstraintIds
    // (the AC-drift relay from the frozen criterion), the evidence must echo
    // the exact same set — lineage pins the constraint IDs to the criterion.
    ...(Array.isArray(item.coveredConstraintIds)
      ? { coveredConstraintIds: [...item.coveredConstraintIds] }
      : {}),
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

const developmentReadiness = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const sourceRef = findObject(
    meta.process_node_input ?? meta,
    value => value.schema === 'factory.integrated-source-candidate.v1'
      && typeof value.ref === 'string' && typeof value.hash === 'string',
  );
  if (!sourceRef) throw new Error('integrated source ProductRef not found');
  await actions.submitProduct(client, 'factory.development-readiness-manifest.v1', {
    schemaVersion: 'factory.development-readiness-manifest.v1',
    sourceCandidate: sourceRef,
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node -e "process.exit(0)"' },
      },
    }],
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'certified product readiness');
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
  [`${DEV}/certify-product-readiness/author/singleton`]: developmentReadiness,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
};
