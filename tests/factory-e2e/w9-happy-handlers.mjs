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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import {
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

const DISC = 'product-discovery@4.0.0';
const FRM = 'solution-formalization@1.0.0';
const DEV = 'solution-development@1.4.4';

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

/**
 * Read accepted artifacts of a given type from the DB (in-process equivalent of
 * actions.findAcceptedArtifacts).
 */
function findAcceptedArtifacts(db, epicId, type) {
  return db.prepare(
    `SELECT id,project_id,epic_id,type,code,title,status,path,content_hash,accepted_hash
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

function discoveryProposal({ handlers, assignment, meta }) {
  // Proposal content must derive from the ENTRY semantic input (the
  // initiative subject). Replay identity is content-addressed (ADR-079):
  // a restart with a DIFFERENT idea must yield a different proposal digest,
  // otherwise downstream cells legitimately replay the earlier run's
  // capsules (byte-identical material = correct reuse, not contamination).
  const subject = String(
    meta?.process_node_input?.subject
    ?? meta?.process_node_input?.objective
    ?? 'unspecified initiative',
  );
  handlers.product_submit({
    schema: 'factory.discovery-proposal.v1',
    content: {
      problem_statement: `[${subject}] The current pipeline lacks automated end-to-end validation.`,
      observed_context: 'Unit tests cover pure domain logic. No full factory test exists.',
      stakeholders_or_actors: ['Platform team', 'Module authors', 'CI reviewers'],
      assumptions: ['Factory physics is correct in isolation.', 'Deterministic workers can substitute LLM.'],
      unknowns: ['None blocking.'],
      risks: ['Fixture drift risk.'],
      candidate_scope: `[${subject}] Run Product Delivery through the real Factory with deterministic physical workers.`,
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

// ---------------------------------------------------------------------------
// ADR-090 (CC-IC-2) v2 register disposition helpers (same lawful shape the
// golden-path corpus uses): the deterministic author computes the SAME
// register the Discovery settlement froze (proposal drafts + unknowns + the
// DECLARED, digest-pinned lifecycle injection table — all public data the
// author can read from its own task input) and disposes EVERY entry in the
// strict v2 grammar, pinning the register digest the dispositions were
// authored against. Coverage ids flow from the brief's accepted entries.
// ---------------------------------------------------------------------------

function constraintRegisterOf(meta) {
  const formalizationCase = findObject(
    meta?.process_node_input ?? meta,
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

function constraintDispositionsOf(register) {
  if (!register) return null;
  const dispositions = {};
  for (const entry of register.constraints) {
    // The 2026-08-23 waiver-authority decision: v2 `waived` is TYPED
    // UNAVAILABLE (brief metadata is worker-authored — no operator
    // attribution a worker writes carries authority). The open question is
    // RESOLVED citing the authentic corpus evidence: the Discovery
    // readiness assessment's unknowns_manageability dimension (sufficient).
    // Resolution is a disposition state, NOT a coverage discharge.
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
 * The §D2/AC covered_constraint_ids relay read back from the ACCEPTED brief's
 * authored dispositions (the worker-visible disposition source — the same
 * read golden-path performs through artifact_list): EVERY non-waived id —
 * accepted AND resolved/deferred alike (on v2 resolved/deferred remain
 * obligations the AC/SRS work must cover; nothing subtracts on v2). Legacy
 * v1 reasoned waivers are the only lawful exclusion.
 *
 * Exported for the proof drives (W1-1): the ELITE-7 run-scoped register
 * repair made the acceptance coverage gate fire for EVERY formalization
 * node, so scripted corpora must close coverage exactly like the golden
 * path does.
 */
export function coveredConstraintIdsFromBriefDb(db, epicId) {
  const brief = db.prepare(
    `SELECT metadata FROM artifacts
      WHERE epic_id=? AND type='brief' AND status='accepted'
      ORDER BY id DESC LIMIT 1`,
  ).get(epicId);
  if (!brief?.metadata) return [];
  try {
    const parsed = JSON.parse(brief.metadata);
    const dispositions = parsed?.constraint_dispositions;
    if (!dispositions || typeof dispositions !== 'object') return [];
    return Object.entries(dispositions)
      .filter(([, value]) => value && value.disposition !== 'waived')
      .map(([id]) => id)
      .sort();
  } catch {
    return [];
  }
}

// ADR-079 replay identity is CONTENT-addressed: authored artifacts must
// derive from the upstream semantic material, or every restart's downstream
// cells legitimately replay the earlier run's capsules (byte-equal material
// is correct reuse, not contamination). The discovery proposal digest is the
// semantic marker: identical across replays of the same input, different for
// an incompatible input. It is threaded PRD -> UC -> AC -> SRS.
function proposalDigestFromMeta(meta) {
  const pni = meta?.process_node_input;
  // Stage-entry cells (e.g. formalization-product-contract) receive the
  // lifecycle-mapped BUSINESS input, which carries the proposal hash at the
  // top level; intra-stage downstream cells receive an upstream production
  // manifest, whose items carry typed ProductRefs.
  if (pni && typeof pni.discoveryProposalHash === 'string') return pni.discoveryProposalHash;
  const items = pni?.bindings?.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
      if (p) return p.digest;
    }
  }
  return 'no-proposal-digest';
}

function proposalMarkerFromFile(repoPath, filePath) {
  if (!filePath) return 'no-proposal-marker';
  try {
    const match = /\[proposal ([0-9a-f]{64}|no-proposal-[a-z-]+)\]/.exec(
      readFileSync(path.join(repoPath, filePath), 'utf8'),
    );
    return match?.[1] ?? 'no-proposal-marker';
  } catch {
    return 'no-proposal-marker';
  }
}

function formalizationProduct({ handlers, assignment, meta, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const proposalDigest = proposalDigestFromMeta(meta);
  const briefPayload = {
    classification: 'product', complexity: { tshirt: 'M', risk_triggers: [] },
    decision: 'go', reasoning: 'Feasible and bounded.',
    affected_projects: [projectId], topology_hint: 'sequence',
    scaffold_artifacts: [], shared_mutation_risk: false,
    completeness: 'high', degraded: false,
  };
  // ADR-090 (CC-IC-2): dispose every register entry in the strict v2 grammar
  // and pin the register digest the dispositions were authored against.
  const constraintDispositions = constraintDispositionsOf(constraintRegisterOf(meta));
  writeRepoFile(repoPath, 'docs/formalization/BRIEF-1.md', '# Product Brief\n');
  const brief = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'brief', code: 'BRIEF-1',
    title: 'Product Brief', path: 'docs/formalization/BRIEF-1.md',
    status: 'accepted',
    metadata: {
      brief_payload: briefPayload,
      ...(constraintDispositions ?? {}),
    },
  });
  const prd = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'PRD', code: 'PRD', title: 'Product Requirements',
    artifactPath: 'docs/formalization/PRD.md', repoPath,
    marker: proposalDigest,
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
  marker = null, metadata,
}) {
  if (repoPath && artifactPath) {
    // AC documents follow the conveyor heading grammar (acceptance-criterion-
    // document.ts): every /^AC-/ artifact code must resolve to exactly one
    // level-2/3 heading `## AC-x: <title>` — the acceptance-contract
    // validator v1.2.0 rejects bundles whose AC codes resolve to no heading.
    // Other artifact types keep the plain level-1 document heading.
    const heading = type === 'AC' ? `## ${title}` : `# ${title}`;
    const markerSuffix = marker ? ` [proposal ${marker}]` : '';
    writeRepoFile(repoPath, artifactPath, `${heading}\n\nDeterministic ${type} artifact for ${code}.${markerSuffix}\n`);
  }
  return handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type, code, title,
    path: artifactPath, status,
    ...(metadata ? { metadata } : {}),
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
  const marker = proposalMarkerFromFile(repoPath, prds[0].path);
  const uc = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'UC', code: 'UC-1', title: 'Use Case 1',
    artifactPath: 'docs/formalization/UC-1.md', repoPath, marker,
  });
  addTrace(handlers, uc.id, prds[0].id, 'derived_from');
  addTrace(handlers, uc.id, frs[0].id, 'covers');
  done(handlers, assignment, 'formalization use-cases: UC->PRD+FR');
  return { kind: 'worker-done-accepted' };
}

/** Metamorphic packaging variant: ONE container AC artifact whose document
 * carries BOTH atomic criteria as level-2 headings — the lawful producer
 * shape that collapsed under the old artifactId identity (Elite-4). The
 * default W9 map keeps the N-documents shape; the contract-partition
 * scenario overrides with this handler. */
export function makeOneContainerAcceptanceHandler() {
  return function formalizationAcceptance({ handlers, assignment, context, db }) {
    const { projectId, epicId } = taskScope(db, assignment.taskId);
    const repoPath = context.workspaceRoot;
    const frs = findAcceptedArtifacts(db, epicId, 'FR');
    const nfrs = findAcceptedArtifacts(db, epicId, 'NFR');
    const ucs = findAcceptedArtifacts(db, epicId, 'UC');
    if (!frs.length) throw new Error('No accepted FR for acceptance');
    const marker = ucs.length
      ? proposalMarkerFromFile(repoPath, ucs[0].path)
      : proposalMarkerFromFile(repoPath, frs[0].path);
    const markerSuffix = marker ? ` [proposal ${marker}]` : '';
    const artifactPath = 'docs/formalization/AC.md';
    // Container document: two ATOMIC level-2 AC headings (the leaf grammar
    // of acceptance-criterion-document.ts). One provenance artifact, TWO
    // atomic criteria.
    writeRepoFile(repoPath, artifactPath,
      `## AC-1: Pipeline Completes\n\nDeterministic AC artifact for AC-1.${markerSuffix}\n\n`
      + `## AC-2: NFR Compliance\n\nDeterministic AC artifact for AC-2.${markerSuffix}\n`);
    // ADR-090 (CC-IC-2): the container AC carries the covered_constraint_ids
    // relay read back from the accepted brief — EVERY non-waived id (on v2:
    // all of them; metadata coverage is per-AC artifact regardless of the
    // container/atomic shape).
    const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);
    const container = handlers.artifact_create({
      project_id: projectId, epic_id: epicId, type: 'AC', code: 'AC',
      title: 'Acceptance Contract (container)', path: artifactPath,
      status: 'accepted',
      ...(coveredIds.length > 0 ? { metadata: { covered_constraint_ids: coveredIds } } : {}),
    });
    addTrace(handlers, container.id, frs[0].id, 'derived_from');
    if (ucs.length) addTrace(handlers, container.id, ucs[0].id, 'derived_from');
    if (nfrs.length) addTrace(handlers, container.id, nfrs[0].id, 'derived_from');
    done(handlers, assignment, 'formalization acceptance: one container AC document');
    return { kind: 'worker-done-accepted' };
  };
}

function formalizationAcceptance({ handlers, assignment, context, db }) {
  const { projectId, epicId } = taskScope(db, assignment.taskId);
  const repoPath = context.workspaceRoot;
  const frs = findAcceptedArtifacts(db, epicId, 'FR');
  const nfrs = findAcceptedArtifacts(db, epicId, 'NFR');
  const ucs = findAcceptedArtifacts(db, epicId, 'UC');
  if (!frs.length) throw new Error('No accepted FR for acceptance');
  const marker = ucs.length
    ? proposalMarkerFromFile(repoPath, ucs[0].path)
    : proposalMarkerFromFile(repoPath, frs[0].path);
  // ADR-090 (CC-IC-2): the e2e AC-1 artifact carries the covered_constraint_ids
  // relay read back from the accepted brief — EVERY non-waived id. The
  // acceptance coverage gate diffs the v2 register (which never subtracts —
  // resolved/deferred stay obligations) against exactly this metadata, and
  // the baseline freeze projects it downstream.
  const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);
  const ac1 = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
    artifactPath: 'docs/formalization/AC-1.md', repoPath, marker,
    ...(coveredIds.length > 0 ? { metadata: { covered_constraint_ids: coveredIds } } : {}),
  });
  addTrace(handlers, ac1.id, frs[0].id, 'derived_from');
  if (ucs.length) addTrace(handlers, ac1.id, ucs[0].id, 'derived_from');
  const ac2 = createFormalizationArtifact(handlers, {
    projectId, epicId, type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance',
    artifactPath: 'docs/formalization/AC-2.md', repoPath, marker,
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

  // ADR-090 (CC-IC-2): the e2e AC-1 stanza carries the covered_constraint_ids
  // relay (read back from the accepted brief — never authored from prose):
  // EVERY non-waived id — the resolved open-question obligation included.
  // The §2.2 Module Manifest declares the module files the plan's
  // implementation scopes own (package.json is a mandated scope of every
  // implementation item, so the declared file is covered write authority).
  const coveredIds = coveredConstraintIdsFromBriefDb(db, epicId);
  const coveredField = coveredIds.length > 0
    ? `\n  covered_constraint_ids: ${coveredIds.join(', ')}`
    : '';
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
    `  criticality: blocker${coveredField}`,
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
    '### 2.2 Module Manifest',
    '',
    '| Module | Files |',
    '|---|---|',
    '| w9-harness | `package.json` |',
    '',
    '## §12 Decision Log',
    '',
    '| # | Decision | Source/profile | Alternatives considered | Rationale | Date |',
    '|---|----------|---------------|------------------------|-----------|------|',
    '| 1 | Scripted workers | CONVEYOR §16 | Real LLM | Deterministic | 2026-08-12 |',
    '',
    `[proposal ${proposalMarkerFromFile(repoPath, prds[0].path)}]`,
    '',
  ].join('\n');
  const srsPath = 'docs/formalization/SRS.md';
  writeRepoFile(repoPath, srsPath, srsContent);
  const srs = handlers.artifact_create({
    project_id: projectId, epic_id: epicId, type: 'SRS', code: 'SRS',
    title: 'SRS', path: srsPath, status: 'draft',
    project_repository_id: 1,
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

/** Parameterized development planner. Default: the W9 dependency chain
 * (impl-N depends on impl-N-1) with shared mandated scopes made safe by the
 * chain. parallelBurst: N extra siblings after the FIRST implementation
 * item, each with a DISJOINT single-file scope (no overlap → no forced
 * dependency) and all depending on the first item only — so B/C/D are
 * simultaneously runnable and the factory concurrency cap is the ONLY thing
 * that can limit their peak parallelism (the D2 cap proof). */
export function makeDevelopmentPlanHandler({ parallelBurst = 0 } = {}) {
  return function developmentPlan({ handlers, assignment, meta }) {
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
  // Item keys are per-ATOMIC-criterion: several criteria may share one
  // provenance artifact, and keys derived from artifactId would collide.
  const itemCode = ac => (ac.code ?? String(ac.artifactId)).replace(/[^A-Za-z0-9._-]/g, '-');
  let implementationItems;
  if (parallelBurst > 0 && implementationCriteria.length >= 1) {
    // Cap-proof topology: item A carries the mandated shared scopes; every
    // later sibling (real criteria + burst extras) owns ONE disjoint file and
    // depends on A only — so B/C/D are simultaneously runnable and the
    // factory concurrency cap is the ONLY limiter of their peak.
    const [first] = implementationCriteria;
    const own = key => [`src/w9/${key}.ts`];
    const item = (key, acKeys, scopes, dependsOn) => ({
      key,
      kind: 'implementation',
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      executionMode: 'git_change',
      projectRepositoryId: repo.projectRepositoryId,
      acceptanceCriterionKeys: acKeys,
      dependsOnKeys: dependsOn,
      changeScopes: scopes,
      required: true,
      criticality: 'blocker',
    });
    const firstKey = `impl-${itemCode(first)}`;
    implementationItems = [
      item(firstKey, [criterionKeyOf(first)],
        [`src/w9/${firstKey}.ts`, 'package.json', 'tests/'], []),
      ...implementationCriteria.slice(1).map(ac => item(
        `impl-${itemCode(ac)}`, [criterionKeyOf(ac)],
        own(`impl-${itemCode(ac)}`), [firstKey],
      )),
      ...Array.from({ length: parallelBurst }, (_, i) => item(
        `impl-burst-${i + 1}`, [], own(`impl-burst-${i + 1}`), [firstKey],
      )),
    ];
  } else {
  implementationItems = implementationCriteria.map((ac, index) => ({
    key: `impl-${itemCode(ac)}`,
    kind: 'implementation',
    taskKind: 'development.code',
    executionSkill: 'saga-worker',
    executionMode: 'git_change',
    projectRepositoryId: repo.projectRepositoryId,
    acceptanceCriterionKeys: [criterionKeyOf(ac)],
    dependsOnKeys: index === 0
      ? []
      : [`impl-${itemCode(implementationCriteria[index - 1])}`],
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
  }
  const verificationItems = criteria.map(ac => ({
    key: `verify-${itemCode(ac)}`,
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
  };
}

/** Parameterizable implementation author: filePathFor(safe, workItemKey)
 * decides the written path (and declared changedFiles follow it); dropFor
 * optionally supplies the LAWFUL repair disposition — snapshot.droppedFiles
 * entries with non-empty reasons (claim-monotonicity's documented exit).
 * The default is the in-scope src/w9 path; fault scenarios override it on
 * chosen invocations to drive the production implementation-scope fence. */
export function makeDevelopmentImplementHandler(filePathFor, dropFor) {
  return function developmentImplement({ handlers, assignment, meta, context, db }) {
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
  const filePath = filePathFor(safe, workItemKey);
  writeRepoFile(repoPath, filePath,
    `// deterministic implementation for ${workItemKey}\nexport const ${safe.replace(/[^a-zA-Z0-9_]/g, '_')} = true;\n`);
  git(repoPath, 'add', filePath);
  // Replay idempotency (§16): on a restart the SAME material is already
  // committed on this branch — `git commit` then exits non-zero ("nothing
  // to commit") and the replayed execution dies. Observe-before-commit: a
  // failed commit with a CLEAN tree means the commit already happened and
  // the branch ref already points at it — skip, like the production
  // external-effect short-circuit. A dirty tree is a real failure.
  try {
    git(repoPath, 'commit', '-m', `w9: implement ${workItemKey}`);
  } catch (error) {
    // -uno: untracked files (e.g. other cells' docs/ artifacts in the shared
    // repo) are not this commit's concern; only TRACKED/staged state decides.
    if (git(repoPath, 'status', '--porcelain', '-uno').trim() !== '') throw error;
  }
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
      snapshot: {
        commitSha, treeSha, files: [filePath], changedFiles: [filePath],
        ...(dropFor ? { droppedFiles: dropFor() } : {}),
      },
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
};
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
  const acKey = String(item.acceptanceCriterionKeys?.[0] ?? '');
  const acId = Number(acKey.split(':')[0]) || meta.verification_target_artifact_id || 0;
  if (!acKey || !acId) throw new Error('verification acceptanceCriterionKey missing');
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
      acceptanceCriterionKey: acKey,
      acceptedCriterionHash,
      candidateHash: candidate.candidateHash,
      // ADR-090 (CC-IC-2): when the verification card pins coveredConstraintIds
      // (the AC-drift relay from the frozen criterion), the evidence echoes the
      // exact same set — lineage pins the constraint IDs to the criterion.
      ...(Array.isArray(item.coveredConstraintIds)
        ? { coveredConstraintIds: [...item.coveredConstraintIds] }
        : {}),
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

function developmentReadinessCertification({ handlers, assignment, meta }) {
  const sourceCandidate = findObject(
    meta.process_node_input,
    value => value.schema === 'factory.integrated-source-candidate.v1'
      && typeof value.ref === 'string'
      && typeof value.hash === 'string',
  );
  if (!sourceCandidate) {
    throw new Error('Exact integrated-source ProductRef is missing from readiness input');
  }
  handlers.product_submit({
    schema: 'factory.development-readiness-manifest.v1',
    content: {
      schemaVersion: 'factory.development-readiness-manifest.v1',
      sourceCandidate: {
        schema: sourceCandidate.schema,
        ref: sourceCandidate.ref,
        hash: sourceCandidate.hash,
      },
      targets: [{ key: 'primary', readiness: RUNNABLE_STATIC_READINESS }],
    },
  });
  done(handlers, assignment, 'certified exact integrated source readiness');
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
  [`${DEV}/plan-task-graph/author/singleton`]: makeDevelopmentPlanHandler(),
  [`${DEV}/implement-work-items/author/*`]: makeDevelopmentImplementHandler(
    safe => `src/w9/${safe}.ts`,
  ),
  [`${DEV}/implement-work-items/reviewer/*`]: developmentReview,
  [`${DEV}/certify-product-readiness/author/singleton`]: developmentReadinessCertification,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
});
