// tests/factory-proof/k2-corpus-formalization.mjs
//
// K2-B — the STRICT multi-cell actor corpus: every cell from the first
// discovery spawn through the Formalization settle, played by the spawned
// child through the REAL saga MCP server. Cell dispatch is production-
// visible only: the task metadata (process_node_id) from the actor's own
// task_get, and the prompt (role marker for reviewer turns). Ids of prior
// material (PRD/FR/UC/...) come from artifact_list — exactly how a real
// model discovers them. No DB, no attempt counters, no scenario state.
//
// VARIANT (the actor's constitution, set by the drive — mirrors W1-1):
//   positive          — honest everywhere; the drive reaches 'formalized'.
//   fabricated-exact  — acceptance first attempt submits a fabricated digest;
//                       the typed ARTIFACT_CONTENT_HASH_UNVERIFIABLE tool
//                       error IS the exact feedback → repair with honest bytes.
//   fabricated-absent — same fault; the actor ignores tool errors → no repair
//                       (bounded stasis, never a terminal lifecycle death).
//   fabricated-stale  — same fault; the actor repairs only under a DIFFERENT
//                       (stale) reason code → no repair.
//   fabricated-corrupt— same fault; the actor demands a structured nonce
//                       (code+subject+evidence) the raw message cannot give →
//                       no repair.

const FRM_NODES = new Set([
  'define-product-contract', 'model-use-cases', 'define-acceptance-contract',
  'reconcile-what', 'define-architecture-contract',
]);

const FABRICATED = 'dcddb474aa26b7f8ff7a81f5324bbf4c1cb1f1e5b3b8f1f6d5f9d0c2b8a7e4f1';

const envelope = (prompt, key) => {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(prompt);
  return m ? m[1].trim() : null;
};

export async function run(a) {
  // task_get returns the task row: metadata is a JSON STRING.
  const rawMeta = a.firstTask?.metadata;
  const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : (rawMeta ?? {});
  // The prompt envelope header is the production-visible assignment: the
  // worker id, execution id, role and project id live THERE (the same lines
  // a real model reads); tasks.* carries no project_id and project_list is
  // outside the frozen tool whitelist.
  a.firstTask.project_id = Number(envelope(a.prompt, 'project_id') ?? 0) || a.firstTask.project_id;
  a.firstTask.assigned_to = a.firstTask.assigned_to
    ?? envelope(a.prompt, 'worker_id');
  a.firstTask.current_execution_id = a.firstTask.current_execution_id
    ?? envelope(a.prompt, 'execution_id');
  const node = meta.process_node_id ?? '';
  // The review turn keeps role=developer; the semantic skill carries the
  // reviewer persona (production-visible envelope line).
  const isReviewer = /reviewer/.test(envelope(a.prompt, 'semantic_skill') ?? '');

  if (isReviewer) return reviewer(a, meta);
  switch (node) {
    case 'produce-proposal': return proposal(a);
    case 'assess-readiness': return readiness(a, meta);
    case 'define-product-contract': return productContract(a);
    case 'model-use-cases': return useCases(a);
    case 'define-acceptance-contract': return acceptance(a);
    case 'reconcile-what': return reconcile(a);
    case 'define-architecture-contract': return architecture(a);
    default:
      throw new Error(`k2-corpus: no program for node '${node}'`);
  }
}

// --- shared helpers ---------------------------------------------------------

async function ids(a, type) {
  const epicId = a.firstTask.epic_id;
  const list = await a.call('artifact_list', { epic_id: epicId, type, status: 'accepted' });
  return (Array.isArray(list) ? list : list.artifacts ?? []).map(x => x.id);
}

async function finish(a, result) {
  await a.call('worker_done', {
    task_id: a.taskId,
    worker_id: a.firstTask.assigned_to,
    execution_id: a.firstTask.current_execution_id,
    result,
  });
  a.progress('worker-done');
}

async function createDoc(a, { type, code, title, rel }, digest = undefined) {
  const heading = type === 'AC' ? `## ${title}` : `# ${title}`;
  a.write(rel, `${heading}\n\nDeterministic ${type} artifact for ${code}.\n`);
  const epic = a.firstTask.epic_id;
  return a.call('artifact_create', {
    project_id: a.firstTask.project_id, epic_id: epic, type, code, title,
    path: rel, status: 'accepted', ...(digest ? { content_hash: digest } : {}),
  });
}

// --- cells ------------------------------------------------------------------

async function proposal(a) {
  await a.call('product_submit', {
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
  await finish(a, 'produced discovery proposal with recommended_outcome=go');
}

async function readiness(a, meta) {
  const pni = meta.process_node_input;
  let proposalSchema; let proposalRef; let proposalDigest;
  for (const item of pni?.bindings?.items ?? []) {
    const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
    if (p) { proposalSchema = p.schemaId; proposalRef = p.ref; proposalDigest = p.digest; break; }
  }
  let proposalId = 0;
  if (proposalRef) {
    const read = await a.call('product_read', {
      schema_id: proposalSchema, ref: proposalRef, digest: proposalDigest,
    });
    proposalId = read.submission_id ?? 0;
  }
  await a.call('product_submit', {
    schema: 'factory.discovery-readiness-assessment.v2',
    content: {
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
  await finish(a, 'produced readiness assessment: ready');
}

async function productContract(a) {
  const briefPayload = {
    classification: 'product', complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go', reasoning: 'Feasible and bounded.',
    affected_projects: [a.firstTask.project_id], topology_hint: 'sequence',
    scaffold_artifacts: [], shared_mutation_risk: false,
    completeness: 'high', degraded: false,
  };
  a.write('docs/formalization/BRIEF-1.md', '# Product Brief\n');
  const epic = a.firstTask.epic_id;
  const brief = await a.call('artifact_create', {
    project_id: a.firstTask.project_id, epic_id: epic, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md', status: 'accepted',
    metadata: { brief_payload: briefPayload },
  });
  const prd = await createDoc(a, { type: 'PRD', code: 'PRD', title: 'Product Requirements', rel: 'docs/formalization/PRD.md' });
  const fr = await createDoc(a, { type: 'FR', code: 'FR-1', title: 'Functional Requirement 1', rel: 'docs/formalization/FR-1.md' });
  await createDoc(a, { type: 'NFR', code: 'NFR-1', title: 'Non-Functional Requirement 1', rel: 'docs/formalization/NFR-1.md' });
  await createDoc(a, { type: 'RULE', code: 'RULE-1', title: 'Business Rule 1', rel: 'docs/formalization/RULE-1.md' });
  await a.call('trace_add', { source_id: prd.id, target_type: 'artifact', target_id: brief.id, link_type: 'derived_from' });
  await a.call('trace_add', { source_id: fr.id, target_type: 'artifact', target_id: prd.id, link_type: 'derived_from' });
  await finish(a, 'formalization product-contract: brief->PRD->FR/NFR/RULE');
}

async function useCases(a) {
  const prds = await ids(a, 'PRD');
  const frs = await ids(a, 'FR');
  const uc = await createDoc(a, { type: 'UC', code: 'UC-1', title: 'Use Case 1', rel: 'docs/formalization/UC-1.md' });
  await a.call('trace_add', { source_id: uc.id, target_type: 'artifact', target_id: prds[0], link_type: 'derived_from' });
  await a.call('trace_add', { source_id: uc.id, target_type: 'artifact', target_id: frs[0], link_type: 'covers' });
  await finish(a, 'formalization use-cases: UC->PRD+FR');
}

async function acceptance(a) {
  const variant = process.env.K2_ACTOR_VARIANT ?? 'positive';
  const frs = await ids(a, 'FR');
  const ucs = await ids(a, 'UC');
  const nfrs = await ids(a, 'NFR');

  if (variant !== 'positive') {
    // Fabricated first attempt: the file must NOT resolve, so the digest is
    // UNVERIFIABLE — the typed rejection is the exact feedback.
    let feedback = null;
    try {
      await a.call('artifact_create', {
        project_id: a.firstTask.project_id, epic_id: a.firstTask.epic_id,
        type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
        path: 'docs/formalization/AC-1.md', status: 'accepted', content_hash: FABRICATED,
      });
      feedback = { unexpected: 'accepted' };
    } catch (error) {
      feedback = { message: error instanceof Error ? error.message : String(error) };
      // Evidence rail: what the actor SAW at the tool boundary (the fault
      // witness for every variant — intake rejections leave no DB row).
      a.witness(`FABRICATED_REJECTED variant=${variant} message=${feedback.message.slice(0, 200)}`);
    }
    const repairs =
      (variant === 'fabricated-exact'
        && /ARTIFACT_CONTENT_HASH_UNVERIFIABLE/.test(feedback.message ?? ''))
      || (variant === 'fabricated-stale'
        && /SOME_OTHER_STALE_CODE/.test(feedback.message ?? ''))
      || (variant === 'fabricated-corrupt'
        && /^code=[^|]+\|subject=[^|]+\|evidence=[^|]+$/.test(feedback.message ?? ''));
    if (!repairs) {
      // absent (no feedback), stale (wrong code), corrupt (no structured
      // nonce): the actor cannot lawfully repair → completes unresolved.
      const why = String(feedback?.message ?? 'no feedback').slice(0, 120);
      await finish(a, `k2 ${variant}: no lawful repair (${why})`);
      return;
    }
  }

  const ac1 = await createDoc(a, { type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes', rel: 'docs/formalization/AC-1.md' });
  await a.call('trace_add', { source_id: ac1.id, target_type: 'artifact', target_id: frs[0], link_type: 'derived_from' });
  if (ucs.length) await a.call('trace_add', { source_id: ac1.id, target_type: 'artifact', target_id: ucs[0], link_type: 'derived_from' });
  const ac2 = await createDoc(a, { type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance', rel: 'docs/formalization/AC-2.md' });
  if (nfrs.length) await a.call('trace_add', { source_id: ac2.id, target_type: 'artifact', target_id: nfrs[0], link_type: 'derived_from' });
  await finish(a, `formalization acceptance: AC-1/AC-2 (variant ${process.env.K2_ACTOR_VARIANT ?? 'positive'})`);
}

async function reconcile(a) {
  await a.call('product_submit', {
    schema: 'factory.formalization-reconciliation-report.v1',
    content: { status: 'reconciled', rationale: 'All artifacts trace correctly.', remaining_gaps: [], repairs: [] },
  });
  await finish(a, 'formalization reconciliation: reconciled');
}

async function architecture(a) {
  const prds = await ids(a, 'PRD');
  const stanza = (ac, title, layer) => [
    `- ac: ${ac}`, `  title: ${title}`, '  module: src/factory-e2e',
    '  files: ["src/factory-e2e/"]', `  invariants: ['${layer}']`, `  test_layers: ['${layer}']`,
    '  pattern: A', '  depends_on: []', '  ac_kind: implementation', '  criticality: blocker',
  ].join('\n');
  a.write('docs/formalization/SRS.md', [
    '# SRS', '', '## §D2 Acceptance Criteria Decomposition', '', '```yaml',
    stanza('AC-1', 'Pipeline Completes', 'e2e'),
    stanza('AC-2', 'NFR Compliance', 'contract'),
    '```', '', '## §12 Decision Log', '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|----------------|--------------------------|-----------|------|',
    '| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-12 |', '',
  ].join('\n'));
  const srs = await a.call('artifact_create', {
    project_id: a.firstTask.project_id, epic_id: a.firstTask.epic_id,
    type: 'SRS', code: 'SRS', title: 'SRS', path: 'docs/formalization/SRS.md',
    status: 'draft', project_repository_id: 1,
  });
  await a.call('trace_add', { source_id: srs.id, target_type: 'artifact', target_id: prds[0], link_type: 'derived_from' });
  await finish(a, 'formalization architecture: SRS->PRD');
}

async function reviewer(a, meta) {
  const workplaceRef = meta.workplace_ref;
  const cand = await a.call('candidate_read', { workplace_ref: workplaceRef, role: 'author' });
  await a.call('product_submit', {
    schema: 'factory.review-verdict.v1',
    content: { verdict: 'approved', findings: [], subject_candidate_set_ref: cand.candidate_set_ref },
  });
  await finish(a, 'review: approved');
}
