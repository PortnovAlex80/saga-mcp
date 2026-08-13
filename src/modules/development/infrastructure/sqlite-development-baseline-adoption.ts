import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';
import { deserializeWorkplaceRef } from '../../../process-modules/domain/workplace/workplace-ref.js';

export interface AdoptDevelopmentBaselineCommand {
  readonly continuationRef: string;
  readonly sourceTaskId: number;
  readonly expectedIntegrationHead: string;
}

export interface DevelopmentBaselineAdoption {
  readonly adoptionRef: string;
  readonly sourceTaskId: number;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly integratedCommit: string;
  readonly integratedTree: string;
  readonly coveredAcceptanceCriteria: readonly number[];
  readonly evidenceDigest: string;
  readonly replayed: boolean;
}

/**
 * Creates new child-run authority for already integrated code. The old gate is
 * evidence only: the adoption additionally proves the live Git desired state.
 */
export function adoptIntegratedDevelopmentBaseline(
  db: Database.Database,
  command: AdoptDevelopmentBaselineCommand,
): DevelopmentBaselineAdoption {
  return db.transaction(() => {
    const continuation = db.prepare(
      `SELECT authorization_ref,prefix_hash,state
         FROM factory_continuation_authorizations WHERE authorization_ref=?`,
    ).get(command.continuationRef) as {
      authorization_ref: string;
      prefix_hash: string;
      state: string;
    } | undefined;
    if (!continuation) throw new Error('DEVELOPMENT_ADOPTION_CONTINUATION_MISSING');

    const task = db.prepare(
      `SELECT t.id,t.workplace_ref,t.integration_state,t.integrated_commit,t.metadata,
              w.process_run_id,w.kanban_phase,w.loop_state,w.terminal_reason
         FROM tasks t JOIN factory_workplaces w ON w.workplace_ref=t.workplace_ref
        WHERE t.id=?`,
    ).get(command.sourceTaskId) as Record<string, unknown> | undefined;
    if (
      !task
      || task.integration_state !== 'merged'
      || task.integrated_commit !== command.expectedIntegrationHead
      || task.kanban_phase !== 'done'
      || task.loop_state !== 'terminal'
      || task.terminal_reason !== 'accepted'
    ) {
      throw new Error('DEVELOPMENT_ADOPTION_SOURCE_NOT_FINAL');
    }
    const metadata = parseRecord(String(task.metadata), 'task metadata');
    const projectRepositoryId = requirePositiveInteger(
      metadata.project_repository_id,
      'project_repository_id',
    );
    const repository = db.prepare(
      `SELECT local_path,integration_branch FROM project_repositories
        WHERE id=? AND status='active'`,
    ).get(projectRepositoryId) as {
      local_path: string | null;
      integration_branch: string;
    } | undefined;
    if (!repository?.local_path) throw new Error('DEVELOPMENT_ADOPTION_REPOSITORY_MISSING');

    const author = requireSingleCandidate(db, String(task.workplace_ref), 'author');
    verifyCandidateSetDigest(db, author);
    const finalDecision = db.prepare(
      `SELECT * FROM factory_gate_decisions
        WHERE workplace_ref=? AND gate_phase='final' AND verdict='accepted'
        ORDER BY decided_at DESC LIMIT 1`,
    ).get(task.workplace_ref) as Record<string, unknown> | undefined;
    if (!finalDecision) throw new Error('DEVELOPMENT_ADOPTION_FINAL_GATE_MISSING');
    if (finalDecision.subject_candidate_set_ref !== author.candidate_set_ref) {
      throw new Error('DEVELOPMENT_ADOPTION_GATE_SUBJECT_MISMATCH');
    }
    verifyDecisionDigest(finalDecision);
    const assessmentRefs = parseStringArray(
      String(finalDecision.assessment_candidate_set_refs),
      'assessment candidate refs',
    );
    if (assessmentRefs.length !== 1) {
      throw new Error('DEVELOPMENT_ADOPTION_REVIEW_NOT_EXACT');
    }
    const reviewer = requireCandidateByRef(db, assessmentRefs[0]!);
    if (
      reviewer.role !== 'reviewer'
      || reviewer.subject_candidate_set_ref !== author.candidate_set_ref
    ) {
      throw new Error('DEVELOPMENT_ADOPTION_REVIEW_SUBJECT_MISMATCH');
    }
    verifyCandidateSetDigest(db, reviewer);

    const authorMembers = readCandidateMembers(db, author.candidate_set_ref);
    if (authorMembers.length !== 1) {
      throw new Error('DEVELOPMENT_ADOPTION_AUTHOR_PRODUCT_NOT_EXACT');
    }
    const product = authorMembers[0]!;
    const submissionId = parseManagedSubmissionRef(product.ref);
    const submission = db.prepare(
      `SELECT schema_version,payload_snapshot,content_hash,execution_id,task_id
         FROM factory_managed_node_submissions WHERE id=?`,
    ).get(submissionId) as {
      schema_version: string;
      payload_snapshot: string;
      content_hash: string;
      execution_id: string;
      task_id: number;
    } | undefined;
    if (
      !submission
      || submission.schema_version !== product.schemaId
      || submission.content_hash !== product.digest
    ) {
      throw new Error('DEVELOPMENT_ADOPTION_PRODUCT_DRIFT');
    }
    if (product.origin === 'produced') {
      if (
        product.sourceCandidateSetRef !== null
        || submission.task_id !== command.sourceTaskId
        || submission.execution_id !== author.producer_execution_ref
      ) throw new Error('DEVELOPMENT_ADOPTION_PRODUCT_OWNER_DRIFT');
    } else if (product.origin === 'carried-forward') {
      const lineage = db.prepare(
        `SELECT a.source_candidate_set_ref,a.source_product_schema,
                a.source_product_ref,a.source_product_digest,c.presenter_ref
           FROM factory_author_candidate_carry_forward_consumptions c
           JOIN factory_author_candidate_carry_forward_authorizations a
             ON a.authorization_ref=c.authorization_ref
          WHERE c.target_candidate_set_ref=?`,
      ).all(author.candidate_set_ref) as Array<{
        source_candidate_set_ref: string;
        source_product_schema: string;
        source_product_ref: string;
        source_product_digest: string;
        presenter_ref: string;
      }>;
      if (
        lineage.length !== 1
        || lineage[0]!.source_candidate_set_ref !== product.sourceCandidateSetRef
        || lineage[0]!.source_product_schema !== product.schemaId
        || lineage[0]!.source_product_ref !== product.ref
        || lineage[0]!.source_product_digest !== product.digest
        || lineage[0]!.presenter_ref !== author.producer_execution_ref
      ) throw new Error('DEVELOPMENT_ADOPTION_CARRY_LINEAGE_DRIFT');
    } else {
      throw new Error('DEVELOPMENT_ADOPTION_PRODUCT_ORIGIN_INVALID');
    }
    const payload = parseRecord(submission.payload_snapshot, 'implementation product');
    if (sha256Hex(payload) !== submission.content_hash) {
      throw new Error('DEVELOPMENT_ADOPTION_PRODUCT_HASH_MISMATCH');
    }
    const snapshot = requireRecord(payload.snapshot, 'implementation snapshot');
    const source = requireRecord(payload.source, 'implementation source');
    const repositoryPayload = requireRecord(payload.repository, 'implementation repository');
    const sourceCommit = requireHash(source.commitSha, 'source commit');
    const sourceTree = requireHash(snapshot.treeSha, 'source tree');
    const baseCommit = requireHash(repositoryPayload.baseCommit, 'base commit');
    const integratedCommit = requireHash(task.integrated_commit, 'integrated commit');

    const head = git(repository.local_path, 'rev-parse', `refs/heads/${repository.integration_branch}`);
    if (head !== command.expectedIntegrationHead || head !== integratedCommit) {
      throw new Error('DEVELOPMENT_ADOPTION_INTEGRATION_HEAD_DRIFT');
    }
    const observedSourceTree = git(repository.local_path, 'rev-parse', `${sourceCommit}^{tree}`);
    const integratedTree = git(repository.local_path, 'rev-parse', `${integratedCommit}^{tree}`);
    if (observedSourceTree !== sourceTree || integratedTree !== sourceTree) {
      throw new Error('DEVELOPMENT_ADOPTION_TREE_MISMATCH');
    }
    const parents = git(repository.local_path, 'show', '-s', '--format=%P', integratedCommit)
      .split(/\s+/u).filter(Boolean);
    if (
      parents.length !== 2
      || !parents.includes(baseCommit)
      || !parents.includes(sourceCommit)
    ) {
      throw new Error('DEVELOPMENT_ADOPTION_MERGE_PROOF_INVALID');
    }
    git(repository.local_path, 'merge-base', '--is-ancestor', sourceCommit, integratedCommit);

    const coveredAcceptanceCriteria = readCoveredAcceptanceCriteria(
      db,
      Number(task.process_run_id),
      metadata,
      payload,
      projectRepositoryId,
    );
    if (coveredAcceptanceCriteria.length === 0) {
      throw new Error('DEVELOPMENT_ADOPTION_COVERAGE_EMPTY');
    }

    const evidence = {
      schemaVersion: 'factory.development-baseline-adoption.v1',
      continuationRef: command.continuationRef,
      continuationPrefixHash: continuation.prefix_hash,
      sourceTaskId: command.sourceTaskId,
      sourceWorkplaceRef: task.workplace_ref,
      sourceProcessRunId: task.process_run_id,
      projectRepositoryId,
      integrationBranch: repository.integration_branch,
      baseCommit,
      sourceCommit,
      sourceTree,
      integratedCommit,
      integratedTree,
      authorCandidateSetRef: author.candidate_set_ref,
      authorCandidateSetDigest: author.candidate_set_digest,
      reviewerCandidateSetRef: reviewer.candidate_set_ref,
      reviewerCandidateSetDigest: reviewer.candidate_set_digest,
      finalGateRunRef: finalDecision.gate_run_ref,
      finalDecisionDigest: finalDecision.decision_digest,
      coveredAcceptanceCriteria,
    };
    const evidenceDigest = sha256Hex(evidence);
    const adoptionRef = `production-adoption:${evidenceDigest}`;
    const prior = db.prepare(
      `SELECT evidence_digest FROM factory_production_adoption_decisions
        WHERE continuation_ref=? AND source_task_id=?`,
    ).get(command.continuationRef, command.sourceTaskId) as {
      evidence_digest: string;
    } | undefined;
    if (prior) {
      if (prior.evidence_digest !== evidenceDigest) {
        throw new Error('DEVELOPMENT_ADOPTION_IDEMPOTENCY_MISMATCH');
      }
      return {
        adoptionRef,
        sourceTaskId: command.sourceTaskId,
        sourceCommit,
        sourceTree,
        integratedCommit,
        integratedTree,
        coveredAcceptanceCriteria,
        evidenceDigest,
        replayed: true,
      };
    }
    db.prepare(
      `INSERT INTO factory_production_adoption_decisions
        (adoption_ref,continuation_ref,source_task_id,source_workplace_ref,
         source_process_run_id,project_repository_id,integration_branch,
         source_commit,source_tree,integrated_commit,integrated_tree,
         author_candidate_set_ref,author_candidate_set_digest,
         reviewer_candidate_set_ref,reviewer_candidate_set_digest,
         final_gate_run_ref,final_decision_digest,covered_acceptance_criteria,
         evidence_snapshot,evidence_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      adoptionRef,
      command.continuationRef,
      command.sourceTaskId,
      task.workplace_ref,
      task.process_run_id,
      projectRepositoryId,
      repository.integration_branch,
      sourceCommit,
      sourceTree,
      integratedCommit,
      integratedTree,
      author.candidate_set_ref,
      author.candidate_set_digest,
      reviewer.candidate_set_ref,
      reviewer.candidate_set_digest,
      finalDecision.gate_run_ref,
      finalDecision.decision_digest,
      canonicalJson(coveredAcceptanceCriteria),
      canonicalJson(evidence),
      evidenceDigest,
    );
    return {
      adoptionRef,
      sourceTaskId: command.sourceTaskId,
      sourceCommit,
      sourceTree,
      integratedCommit,
      integratedTree,
      coveredAcceptanceCriteria,
      evidenceDigest,
      replayed: false,
    };
  })();
}

interface CandidateRow {
  candidate_set_ref: string;
  workplace_ref: string;
  producer_execution_ref: string;
  role: 'author' | 'reviewer';
  subject_candidate_set_ref: string | null;
  candidate_set_digest: string;
}

function requireSingleCandidate(
  db: Database.Database,
  workplaceRef: string,
  role: 'author' | 'reviewer',
): CandidateRow {
  const rows = db.prepare(
    `SELECT *, (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev WHERE rev.revision_ref=factory_candidate_sets.production_revision_ref) AS producer_execution_ref FROM factory_candidate_sets WHERE workplace_ref=? AND role=?
      ORDER BY created_at`,
  ).all(workplaceRef, role) as CandidateRow[];
  if (rows.length !== 1) {
    throw new Error(`DEVELOPMENT_ADOPTION_${role.toUpperCase()}_NOT_EXACT`);
  }
  return rows[0]!;
}

function requireCandidateByRef(db: Database.Database, ref: string): CandidateRow {
  const row = db.prepare(
    `SELECT *, (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev WHERE rev.revision_ref=factory_candidate_sets.production_revision_ref) AS producer_execution_ref FROM factory_candidate_sets WHERE candidate_set_ref=?`,
  ).get(ref) as CandidateRow | undefined;
  if (!row) throw new Error('DEVELOPMENT_ADOPTION_CANDIDATE_MISSING');
  return row;
}

function readCandidateMembers(db: Database.Database, ref: string) {
  return (db.prepare(
    `SELECT product_schema AS schemaId,product_ref AS ref,product_digest AS digest,
            origin,source_candidate_set_ref AS sourceCandidateSetRef
       FROM factory_candidate_set_members WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(ref) as Array<{
    schemaId: string;
    ref: string;
    digest: string;
    origin: string;
    sourceCandidateSetRef: string | null;
  }>);
}

function verifyCandidateSetDigest(db: Database.Database, candidate: CandidateRow): void {
  const products = readCandidateMembers(db, candidate.candidate_set_ref)
    .map(member => ({
      schemaId: member.schemaId,
      ref: member.ref,
      digest: member.digest,
    }));
  if (products.length === 0) throw new Error('DEVELOPMENT_ADOPTION_CANDIDATE_EMPTY');
  // ADR-053 B-3/C2 — recompute the digest with the SAME formula the seal used:
  // execution-free (including executionRef would mismatch every author set),
  // with the reviewer digest additionally binding its subject author set.
  const actual = candidate.role === 'reviewer'
    ? jsonHash({
      workplaceRef: candidate.workplace_ref,
      role: candidate.role,
      subjectCandidateSetRef: candidate.subject_candidate_set_ref,
      products,
    })
    : jsonHash({
      workplaceRef: candidate.workplace_ref,
      role: candidate.role,
      products,
    });
  if (actual !== candidate.candidate_set_digest) {
    throw new Error('DEVELOPMENT_ADOPTION_CANDIDATE_DIGEST_MISMATCH');
  }
}

function verifyDecisionDigest(decision: Record<string, unknown>): void {
  // ADR-053 C13 — the decision digest covers the FULL canonical decision
  // body (everything except decisionDigest itself). The previous partial
  // formula (key+verdict+repairTarget+receiptRefs) could not distinguish
  // decisions that differed in bound material or pinned package and mismatches
  // every decision sealed after the C13 cutover.
  const body = {
    gateRef: decision.gate_ref,
    gateRunRef: decision.gate_run_ref,
    gatePhase: decision.gate_phase,
    workplaceRef: deserializeWorkplaceRef(String(decision.workplace_ref)),
    transitionRef: decision.transition_ref,
    subjectCandidateSetRef: decision.subject_candidate_set_ref,
    assessmentCandidateSetRefs: parseStringArray(
      String(decision.assessment_candidate_set_refs),
      'assessment candidate refs',
    ),
    verdict: decision.verdict,
    repairTargetRole: decision.repair_target_role ?? null,
    checkPlanRef: decision.check_plan_ref,
    checkPlanDigest: decision.check_plan_digest,
    decisionPolicyRef: decision.decision_policy_ref,
    decisionPolicyDigest: decision.decision_policy_digest,
    checkReceiptRefs: parseStringArray(String(decision.check_receipt_refs), 'check receipts'),
    installationDigest: decision.installation_digest,
    decisionKey: decision.decision_key,
    acceptedOutputBindings: JSON.parse(String(decision.accepted_output_bindings ?? '[]')) as unknown,
    recoveryIssueRef: decision.recovery_issue_ref,
  };
  const actual = jsonHash(body);
  if (actual !== decision.decision_digest) {
    throw new Error('DEVELOPMENT_ADOPTION_DECISION_DIGEST_MISMATCH');
  }
}

function readCoveredAcceptanceCriteria(
  db: Database.Database,
  processRunId: number,
  taskMetadata: Record<string, unknown>,
  payload: Record<string, unknown>,
  projectRepositoryId: number,
): number[] {
  if (payload.acceptanceCriteriaCoverage !== undefined) {
    const coverage = requireRecord(
      payload.acceptanceCriteriaCoverage,
      'acceptance criteria coverage',
    );
    return [...new Set(
      Object.values(coverage).map(value =>
        requirePositiveInteger(requireRecord(value, 'coverage item').id, 'coverage id')),
    )].sort((a, b) => a - b);
  }

  // Managed TextSet candidates intentionally carry source bytes and exact Git
  // identity, while AC allocation remains in the accepted, content-addressed
  // Development task graph. Re-resolve that graph instead of trusting a task
  // card or inventing coverage in the candidate payload.
  const graphRow = db.prepare(
    `SELECT payload_snapshot,payload_hash,product_hash
       FROM factory_process_products
      WHERE process_run_id=? AND product_kind='development.task-graph'`,
  ).all(processRunId) as Array<{
    payload_snapshot: string;
    payload_hash: string;
    product_hash: string;
  }>;
  if (graphRow.length !== 1) throw new Error('DEVELOPMENT_ADOPTION_TASK_GRAPH_NOT_EXACT');
  const graph = parseRecord(graphRow[0]!.payload_snapshot, 'task graph');
  if (
    sha256Hex(graph) !== graphRow[0]!.payload_hash
    || graph.graphHash !== graphRow[0]!.product_hash
  ) throw new Error('DEVELOPMENT_ADOPTION_TASK_GRAPH_DRIFT');
  if (!Array.isArray(graph.implementationItems)) {
    throw new Error('DEVELOPMENT_ADOPTION_TASK_GRAPH_ITEMS_INVALID');
  }
  const workItemKey = payload.workItemKey;
  const items = graph.implementationItems.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return (item as Record<string, unknown>).key === workItemKey;
  }) as Array<Record<string, unknown>>;
  if (items.length !== 1 || items[0]!.projectRepositoryId !== projectRepositoryId) {
    throw new Error('DEVELOPMENT_ADOPTION_TASK_GRAPH_ITEM_NOT_EXACT');
  }
  const projectedItem = requireRecord(taskMetadata.cell_input_item, 'projected graph item');
  if (sha256Hex(projectedItem) !== sha256Hex(items[0]!)) {
    throw new Error('DEVELOPMENT_ADOPTION_PROJECTED_ITEM_DRIFT');
  }
  if (
    !Array.isArray(items[0]!.acceptanceCriterionIds)
    || items[0]!.acceptanceCriterionIds.length === 0
  ) throw new Error('DEVELOPMENT_ADOPTION_COVERAGE_EMPTY');
  return [...new Set(items[0]!.acceptanceCriterionIds.map(value =>
    requirePositiveInteger(value, 'coverage id')))].sort((a, b) => a - b);
}

function parseManagedSubmissionRef(ref: string): number {
  const match = /^managed-node-submission:(\d+)$/u.exec(ref);
  if (!match) throw new Error('DEVELOPMENT_ADOPTION_PRODUCT_REF_INVALID');
  return Number(match[1]);
}

function git(repositoryPath: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DEVELOPMENT_ADOPTION_GIT_PROOF_FAILED: ${message}`);
  }
}

function jsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  return requireRecord(JSON.parse(value) as unknown, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`DEVELOPMENT_ADOPTION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`DEVELOPMENT_ADOPTION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return parsed;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`DEVELOPMENT_ADOPTION_${label.toUpperCase()}_INVALID`);
  }
  return result;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new Error(`DEVELOPMENT_ADOPTION_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}
