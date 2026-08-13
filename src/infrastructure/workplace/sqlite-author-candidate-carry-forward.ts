import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';

import type { ProductRef } from '../../process-modules/domain/spi/index.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { DEVELOPMENT_REVIEW_VERDICT_SCHEMA } from '../../modules/development/domain/development-schemas.js';
import {
  deserializeWorkplaceRef,
  serializeWorkplaceRef,
} from '../../process-modules/domain/workplace/workplace-ref.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

export const REVIEW_SCHEMA_FAILURE_CODE = 'review-output-schema-mismatch' as const;
export const POST_ACCEPTANCE_MANIFEST_FAILURE_CODE =
  'post-acceptance-manifest-producer-not-worker' as const;
export const DEVELOPMENT_FREEZE_PROJECTION_FAILURE_CODE =
  'development-freeze-integration-projection-mismatch' as const;
export const CROSS_CELL_CARRY_SCOPE_FAILURE_CODE =
  'cross-cell-carry-forward-scope-mismatch' as const;

export interface AuthorCandidateCarryForwardDirective {
  readonly authorizationRef: string;
  readonly presenterRef: string;
  readonly sourceCandidateSetRef: string;
  readonly sourceCandidateSetDigest: string;
  readonly products: readonly ProductRef[];
}

export interface AuthorCandidateCarryForwardPort {
  resolve(input: {
    readonly processRunId: number;
    readonly workplaceRef: WorkplaceRef;
    readonly semanticInputDigest: string;
    readonly itemSnapshotHash: string;
    readonly expectedProductSchemas: readonly string[];
  }): AuthorCandidateCarryForwardDirective | null;
  consume(input: {
    readonly authorizationRef: string;
    readonly processRunId: number;
    readonly workplaceRef: WorkplaceRef;
    readonly candidateSetRef: string;
    readonly presenterRef: string;
  }): void;
}

/**
 * Authorize reuse of exact author material after a terminal failure which was
 * caused solely by a reviewer submitting the wrong declared schema.  This is
 * deliberately narrower than replay: the source set is evidence, while the
 * child must construct a new carried-forward CandidateSet and run current
 * gates/review/effects.
 */
export function authorizeEligibleAuthorCandidateCarryForward(
  db: Database.Database,
  input: { readonly continuationRef: string; readonly parentLifecycleRunId: number },
): { authorizationRef: string; replayed: boolean } | null {
  return db.transaction(() => {
    const parent = db.prepare(
      `SELECT status,terminal_status,error FROM factory_lifecycle_runs WHERE id=?`,
    ).get(input.parentLifecycleRunId) as {
      status: string;
      terminal_status: string | null;
      error: string | null;
    } | undefined;
    if (!parent || !['failed', 'completed'].includes(parent.status)) {
      throw new Error('AUTHOR_CARRY_FORWARD_PARENT_NOT_TERMINAL_FAILED');
    }
    // NOTE: the includes() below matches the LITERAL historical error text
    // recorded on parent lifecycle runs before the constant existed — keep it
    // byte-stable or old failures stop being recognized as carry-forwardable.
    const eligibleFailureCode = parent.error?.includes(
      "review verdict contract expected exactly one 'factory.development-review-verdict.v1', received 0",
    )
      ? REVIEW_SCHEMA_FAILURE_CODE
      : parent.error?.startsWith(
        'EXECUTION_RECEIPT_NOT_FOUND: factory-carry-forward-presenter:',
      )
        ? POST_ACCEPTANCE_MANIFEST_FAILURE_CODE
        : parent.error === 'AUTHOR_CARRY_FORWARD_TARGET_CONTRACT_MISMATCH'
          ? CROSS_CELL_CARRY_SCOPE_FAILURE_CODE
        : parent.status === 'completed' && parent.terminal_status === 'development-blocked'
          ? DEVELOPMENT_FREEZE_PROJECTION_FAILURE_CODE
        : null;
    if (!eligibleFailureCode) return null;

    const continuation = db.prepare(
      `SELECT parent_lifecycle_run_id,state FROM factory_continuation_authorizations
        WHERE authorization_ref=?`,
    ).get(input.continuationRef) as {
      parent_lifecycle_run_id: number;
      state: string;
    } | undefined;
    if (!continuation || continuation.parent_lifecycle_run_id !== input.parentLifecycleRunId) {
      throw new Error('AUTHOR_CARRY_FORWARD_CONTINUATION_PARENT_MISMATCH');
    }

    const stage = db.prepare(
      `SELECT process_run_id,status,local_outcome,error FROM factory_stage_runs
        WHERE lifecycle_run_id=? AND stage_id='solution-development'
        ORDER BY attempt DESC,id DESC LIMIT 1`,
    ).get(input.parentLifecycleRunId) as {
      process_run_id: number | null;
      status: string;
      local_outcome: string | null;
      error: string | null;
    } | undefined;
    const failedBoundary = eligibleFailureCode !== DEVELOPMENT_FREEZE_PROJECTION_FAILURE_CODE;
    if (
      !stage?.process_run_id
      || (failedBoundary
        ? stage.status !== 'failed' || stage.error !== parent.error
        : stage.status !== 'completed' || stage.local_outcome !== 'blocked')
    ) {
      throw new Error('AUTHOR_CARRY_FORWARD_FAILED_STAGE_NOT_EXACT');
    }
    const process = db.prepare(
      `SELECT status,local_outcome,error FROM factory_process_runs WHERE id=?`,
    ).get(stage.process_run_id) as {
      status: string;
      local_outcome: string | null;
      error: string | null;
    } | undefined;
    if (
      !process
      || (failedBoundary
        ? process.status !== 'failed' || process.error !== parent.error
        : process.status !== 'completed' || process.local_outcome !== 'blocked')
    ) {
      throw new Error('AUTHOR_CARRY_FORWARD_FAILED_PROCESS_NOT_EXACT');
    }
    if (eligibleFailureCode === DEVELOPMENT_FREEZE_PROJECTION_FAILURE_CODE) {
      const freeze = db.prepare(
        `SELECT status,event,production_envelope
           FROM factory_node_runs
          WHERE process_run_id=? AND node_id='freeze-integrated-candidate'
          ORDER BY attempt DESC,id DESC LIMIT 1`,
      ).get(stage.process_run_id) as {
        status: string;
        event: string | null;
        production_envelope: string | null;
      } | undefined;
      const envelope = freeze?.production_envelope
        ? parseRecord(freeze.production_envelope, 'freeze production')
        : null;
      const bindings = envelope ? requireRecord(envelope.bindings, 'freeze bindings') : null;
      if (
        freeze?.status !== 'completed'
        || freeze.event !== 'domain.failed'
        || !bindings
        || !Array.isArray(bindings.reasonCodes)
        || bindings.reasonCodes.length !== 1
        || bindings.reasonCodes[0] !== 'implementation-integration-not-merged'
      ) {
        // `development-blocked` is a closed business outcome shared by
        // multiple later boundaries. A verification/settlement block is not
        // corruption of this narrowly-scoped author carry capability; it is
        // simply ineligible and must be handled by a different continuation
        // authority (for example exact candidate adoption).
        return null;
      }
    }
    if (eligibleFailureCode === CROSS_CELL_CARRY_SCOPE_FAILURE_CODE) {
      const failedNode = db.prepare(
        `SELECT status,error_message FROM factory_node_runs
          WHERE process_run_id=? AND node_id<>'implement-work-items'
          ORDER BY id DESC LIMIT 1`,
      ).get(stage.process_run_id) as {
        status: string;
        error_message: string | null;
      } | undefined;
      if (
        failedNode?.status !== 'failed'
        || failedNode.error_message !== parent.error
      ) throw new Error('AUTHOR_CARRY_FORWARD_CROSS_CELL_FAILURE_NOT_EXACT');
    }

    const candidates = db.prepare(
      `SELECT cs.candidate_set_ref,cs.candidate_set_digest,
              (SELECT rev.presenter_ref FROM factory_workplace_production_revisions rev
                WHERE rev.revision_ref = cs.production_revision_ref) AS producer_execution_ref,
              cs.workplace_ref,w.kanban_phase,w.loop_state,w.next_role,
              t.id AS task_id,t.metadata,t.project_repository_id,
              t.integration_state,t.integrated_commit,
              wi.output_schema
         FROM factory_candidate_sets cs
         JOIN factory_workplaces w ON w.workplace_ref=cs.workplace_ref
         JOIN tasks t ON t.workplace_ref=w.workplace_ref
          AND json_extract(t.metadata,'$.role')='author'
         JOIN factory_work_intents wi
           ON wi.id=json_extract(t.metadata,'$.work_intent_id')
        WHERE w.process_run_id=? AND cs.role='author'`,
    ).all(stage.process_run_id) as Array<{
      candidate_set_ref: string;
      candidate_set_digest: string;
      producer_execution_ref: string;
      workplace_ref: string;
      kanban_phase: string;
      loop_state: string;
      next_role: string;
      task_id: number;
      metadata: string;
      project_repository_id: number;
      integration_state: string;
      integrated_commit: string | null;
      output_schema: string;
    }>;
    if (candidates.length !== 1) {
      throw new Error(`AUTHOR_CARRY_FORWARD_SOURCE_SET_NOT_EXACT: ${candidates.length}`);
    }
    const source = candidates[0]!;
    const sourceBoundaryValid = eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE
      ? source.kanban_phase === 'review_in_progress'
        && source.loop_state === 'verifying'
        && source.next_role === 'reviewer'
      : source.kanban_phase === 'done'
        && source.loop_state === 'terminal'
        && source.integration_state === 'merged'
        && typeof source.integrated_commit === 'string';
    if (!sourceBoundaryValid) {
      throw new Error('AUTHOR_CARRY_FORWARD_FAILURE_BOUNDARY_INVALID');
    }
    const metadata = parseRecord(source.metadata, 'source task metadata');
    const semanticInputDigest = requireHash(metadata.semantic_input_digest, 'semantic input digest', 64);
    const item = requireRecord(metadata.cell_input_item, 'source item');
    const itemSnapshotHash = sha256Hex(item);

    const members = db.prepare(
      `SELECT product_schema,product_ref,product_digest,origin,source_candidate_set_ref
         FROM factory_candidate_set_members WHERE candidate_set_ref=? ORDER BY ordinal`,
    ).all(source.candidate_set_ref) as Array<{
      product_schema: string;
      product_ref: string;
      product_digest: string;
      origin: string;
      source_candidate_set_ref: string | null;
    }>;
    if (
      members.length !== 1
      || (eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE
        ? members[0]!.origin !== 'produced' || members[0]!.source_candidate_set_ref !== null
        : members[0]!.origin !== 'carried-forward' || !members[0]!.source_candidate_set_ref)
      || members[0]!.product_schema !== source.output_schema
    ) {
      throw new Error('AUTHOR_CARRY_FORWARD_SOURCE_PRODUCT_NOT_EXACT');
    }
    const member = members[0]!;
    verifyCandidateDigest(source, member);

    const authorDecisions = db.prepare(
      `SELECT decision_key,decision_digest,verdict FROM factory_gate_decisions
        WHERE workplace_ref=? AND gate_phase='author'
          AND subject_candidate_set_ref=?`,
    ).all(source.workplace_ref, source.candidate_set_ref) as Array<{
      decision_key: string;
      decision_digest: string;
      verdict: string;
    }>;
    if (authorDecisions.length !== 1 || authorDecisions[0]!.verdict !== 'accepted') {
      throw new Error('AUTHOR_CARRY_FORWARD_AUTHOR_GATE_NOT_ACCEPTED');
    }
    const finalDecision = db.prepare(
      `SELECT 1 FROM factory_gate_decisions
        WHERE workplace_ref=? AND gate_phase='final' LIMIT 1`,
    ).get(source.workplace_ref);
    const finalAcceptance = db.prepare(
      `SELECT 1 FROM factory_cell_final_acceptances WHERE workplace_ref=? LIMIT 1`,
    ).get(source.workplace_ref);
    const reviewerSets = db.prepare(
      `SELECT 1 FROM factory_candidate_sets
        WHERE workplace_ref=? AND role='reviewer' LIMIT 1`,
    ).get(source.workplace_ref);
    if (eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE) {
      if (finalDecision || finalAcceptance || reviewerSets) {
        throw new Error('AUTHOR_CARRY_FORWARD_SOURCE_ALREADY_HAS_LATER_AUTHORITY');
      }
    } else {
      const finalProof = db.prepare(
        `SELECT gd.decision_key,gd.decision_digest,cfa.final_acceptance_ref,
                cer.effect_receipt_ref,cer.provider_receipt_ref,cer.evidence_snapshot
           FROM factory_gate_decisions gd
           JOIN factory_cell_final_acceptances cfa
             ON cfa.workplace_ref=gd.workplace_ref
            AND cfa.candidate_set_ref=gd.subject_candidate_set_ref
            AND cfa.gate_decision_key=gd.decision_key
           JOIN factory_cell_effect_receipts cer
             ON cer.workplace_ref=cfa.workplace_ref
            AND cer.candidate_set_ref=cfa.candidate_set_ref
            AND cer.gate_decision_key=gd.decision_key
          WHERE gd.workplace_ref=? AND gd.gate_phase='final'
            AND gd.verdict='accepted' AND gd.subject_candidate_set_ref=?`,
      ).all(source.workplace_ref, source.candidate_set_ref) as Array<{
        decision_key: string;
        decision_digest: string;
        final_acceptance_ref: string;
        effect_receipt_ref: string;
        provider_receipt_ref: string;
        evidence_snapshot: string;
      }>;
      if (finalProof.length !== 1 || !finalDecision || !finalAcceptance || !reviewerSets) {
        throw new Error('AUTHOR_CARRY_FORWARD_FINAL_ACCEPTANCE_NOT_EXACT');
      }
      const providerEvidence = parseRecord(
        finalProof[0]!.evidence_snapshot,
        'final effect evidence',
      );
      if (
        finalProof[0]!.provider_receipt_ref === ''
        || providerEvidence.providerEffectId !== source.integrated_commit
      ) {
        throw new Error('AUTHOR_CARRY_FORWARD_FINAL_EFFECT_DRIFT');
      }
    }

    const reviewer = db.prepare(
      `SELECT t.id,wi.output_schema
         FROM tasks t JOIN factory_work_intents wi
           ON wi.id=json_extract(t.metadata,'$.work_intent_id')
        WHERE t.workplace_ref=? AND json_extract(t.metadata,'$.role')='reviewer'`,
    ).all(source.workplace_ref) as Array<{ id: number; output_schema: string }>;
    if (reviewer.length !== 1 || reviewer[0]!.output_schema !== DEVELOPMENT_REVIEW_VERDICT_SCHEMA) {
      throw new Error('AUTHOR_CARRY_FORWARD_REVIEW_INTENT_NOT_EXACT');
    }
    const wrongSubmissions = db.prepare(
      `SELECT schema_version FROM factory_managed_node_submissions WHERE task_id=?`,
    ).all(reviewer[0]!.id) as Array<{ schema_version: string }>;
    if (eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE && (
      wrongSubmissions.length === 0
      || wrongSubmissions.some(row => row.schema_version === reviewer[0]!.output_schema)
    )) {
      throw new Error('AUTHOR_CARRY_FORWARD_REVIEW_SCHEMA_FAILURE_NOT_PROVEN');
    }

    const submissionId = parseManagedSubmissionRef(member.product_ref);
    const submission = db.prepare(
      `SELECT task_id,execution_id,schema_version,payload_snapshot,content_hash
         FROM factory_managed_node_submissions WHERE id=?`,
    ).get(submissionId) as {
      task_id: number;
      execution_id: string;
      schema_version: string;
      payload_snapshot: string;
      content_hash: string;
    } | undefined;
    if (
      !submission
      || submission.schema_version !== member.product_schema
      || submission.content_hash !== member.product_digest
    ) throw new Error('AUTHOR_CARRY_FORWARD_SUBMISSION_DRIFT');
    if (eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE) {
      if (
        submission.task_id !== source.task_id
        || submission.execution_id !== source.producer_execution_ref
      ) throw new Error('AUTHOR_CARRY_FORWARD_SUBMISSION_OWNER_DRIFT');
    } else {
      const lineage = db.prepare(
        `SELECT a.source_candidate_set_ref,a.source_product_schema,
                a.source_product_ref,a.source_product_digest,
                c.presenter_ref
           FROM factory_author_candidate_carry_forward_consumptions c
           JOIN factory_author_candidate_carry_forward_authorizations a
             ON a.authorization_ref=c.authorization_ref
          WHERE c.target_candidate_set_ref=?`,
      ).all(source.candidate_set_ref) as Array<{
        source_candidate_set_ref: string;
        source_product_schema: string;
        source_product_ref: string;
        source_product_digest: string;
        presenter_ref: string;
      }>;
      if (
        lineage.length !== 1
        || lineage[0]!.source_candidate_set_ref !== member.source_candidate_set_ref
        || lineage[0]!.source_product_schema !== member.product_schema
        || lineage[0]!.source_product_ref !== member.product_ref
        || lineage[0]!.source_product_digest !== member.product_digest
        || lineage[0]!.presenter_ref !== source.producer_execution_ref
      ) throw new Error('AUTHOR_CARRY_FORWARD_LINEAGE_DRIFT');
    }
    const payload = parseRecord(submission.payload_snapshot, 'source product');
    if (sha256Hex(payload) !== submission.content_hash) {
      throw new Error('AUTHOR_CARRY_FORWARD_PRODUCT_HASH_MISMATCH');
    }
    const sourcePayload = requireRecord(payload.source, 'source identity');
    const snapshot = requireRecord(payload.snapshot, 'source snapshot');
    const repositoryPayload = requireRecord(payload.repository, 'source repository');
    const baseCommit = requireHash(repositoryPayload.baseCommit, 'base commit', 40);
    const sourceCommit = requireHash(sourcePayload.commitSha, 'source commit', 40);
    const sourceTree = requireHash(snapshot.treeSha, 'source tree', 40);

    const repository = db.prepare(
      `SELECT COALESCE(rc.local_path,pr.local_path) AS local_path,pr.integration_branch
         FROM project_repositories pr
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE pr.id=? AND pr.status='active'`,
    ).get(source.project_repository_id) as {
      local_path: string | null;
      integration_branch: string;
    } | undefined;
    if (!repository?.local_path || repository.integration_branch !== repositoryPayload.integrationBranch) {
      throw new Error('AUTHOR_CARRY_FORWARD_REPOSITORY_DRIFT');
    }
    const branch = String(sourcePayload.branch ?? '');
    const head = git(repository.local_path, 'rev-parse', `refs/heads/${repository.integration_branch}`);
    const observedSource = git(repository.local_path, 'rev-parse', `${sourceCommit}^{commit}`);
    const observedTree = git(repository.local_path, 'rev-parse', `${sourceCommit}^{tree}`);
    const observedBranch = git(repository.local_path, 'rev-parse', branch);
    if (
      observedSource !== sourceCommit
      || observedTree !== sourceTree || observedBranch !== sourceCommit
      || (eligibleFailureCode === REVIEW_SCHEMA_FAILURE_CODE
        ? head !== baseCommit
        : head !== source.integrated_commit
          || !isAncestor(repository.local_path, sourceCommit, head))
    ) throw new Error('AUTHOR_CARRY_FORWARD_GIT_IDENTITY_DRIFT');

    const evidence = {
      schemaVersion: 'factory.author-candidate-carry-forward-authorization.v1',
      continuationRef: input.continuationRef,
      sourceLifecycleRunId: input.parentLifecycleRunId,
      sourceProcessRunId: stage.process_run_id,
      sourceWorkplaceRef: source.workplace_ref,
      sourceCandidateSetRef: source.candidate_set_ref,
      sourceCandidateSetDigest: source.candidate_set_digest,
      sourceGateDecisionKey: authorDecisions[0]!.decision_key,
      sourceGateDecisionDigest: authorDecisions[0]!.decision_digest,
      sourceProduct: {
        schemaId: member.product_schema,
        ref: member.product_ref,
        digest: member.product_digest,
      },
      semanticInputDigest,
      itemSnapshotHash,
      projectRepositoryId: source.project_repository_id,
      integrationBranch: repository.integration_branch,
      baseCommit,
      sourceCommit,
      sourceTree,
      eligibleFailureCode,
      expectedIntegrationHead: head,
      parentError: parent.error,
    };
    const evidenceDigest = sha256Hex(evidence);
    const authorizationRef = `author-carry-forward:${evidenceDigest}`;
    const prior = db.prepare(
      `SELECT authorization_ref,evidence_digest
         FROM factory_author_candidate_carry_forward_authorizations
        WHERE continuation_ref=?`,
    ).get(input.continuationRef) as {
      authorization_ref: string;
      evidence_digest: string;
    } | undefined;
    if (prior) {
      if (prior.authorization_ref !== authorizationRef || prior.evidence_digest !== evidenceDigest) {
        throw new Error('AUTHOR_CARRY_FORWARD_IDEMPOTENCY_MISMATCH');
      }
      return { authorizationRef, replayed: true };
    }
    db.prepare(
      `INSERT INTO factory_author_candidate_carry_forward_authorizations
        (authorization_ref,continuation_ref,source_lifecycle_run_id,source_process_run_id,
         source_workplace_ref,source_candidate_set_ref,source_candidate_set_digest,
         source_gate_decision_key,source_gate_decision_digest,source_product_schema,
         source_product_ref,source_product_digest,semantic_input_digest,item_snapshot_hash,
         project_repository_id,integration_branch,base_commit,source_commit,source_tree,
         eligible_failure_code,evidence_snapshot,evidence_digest)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      authorizationRef, input.continuationRef, input.parentLifecycleRunId,
      stage.process_run_id, source.workplace_ref, source.candidate_set_ref,
      source.candidate_set_digest, authorDecisions[0]!.decision_key,
      authorDecisions[0]!.decision_digest, member.product_schema, member.product_ref,
      member.product_digest, semanticInputDigest, itemSnapshotHash,
      source.project_repository_id, repository.integration_branch, baseCommit,
      sourceCommit, sourceTree, eligibleFailureCode,
      canonicalJson(evidence), evidenceDigest,
    );
    return { authorizationRef, replayed: false };
  })();
}

export class SqliteAuthorCandidateCarryForward implements AuthorCandidateCarryForwardPort {
  constructor(private readonly db: Database.Database) {}

  resolve(input: {
    readonly processRunId: number;
    readonly workplaceRef: WorkplaceRef;
    readonly semanticInputDigest: string;
    readonly itemSnapshotHash: string;
    readonly expectedProductSchemas: readonly string[];
  }): AuthorCandidateCarryForwardDirective | null {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    const row = this.db.prepare(
      `SELECT a.*
         FROM factory_author_candidate_carry_forward_authorizations a
         JOIN factory_continuation_authorizations c
           ON c.authorization_ref=a.continuation_ref
         JOIN factory_stage_runs sr
           ON sr.lifecycle_run_id=c.child_lifecycle_run_id
          AND sr.process_run_id=?
        WHERE c.state='consumed'`,
    ).get(input.processRunId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sourceWorkplace = deserializeWorkplaceRef(String(row.source_workplace_ref));
    if (sourceWorkplace.productionCellId !== input.workplaceRef.productionCellId) {
      return null;
    }
    if (
      !/^[a-f0-9]{64}$/u.test(input.semanticInputDigest)
      || row.item_snapshot_hash !== input.itemSnapshotHash
      || input.expectedProductSchemas.length !== 1
      || row.source_product_schema !== input.expectedProductSchemas[0]
    ) throw new Error('AUTHOR_CARRY_FORWARD_TARGET_CONTRACT_MISMATCH');

    const target = this.db.prepare(
      `SELECT t.metadata,wi.output_schema
         FROM tasks t JOIN factory_work_intents wi
           ON wi.id=json_extract(t.metadata,'$.work_intent_id')
        WHERE t.workplace_ref=? AND json_extract(t.metadata,'$.role')='author'`,
    ).get(workplace) as { metadata: string; output_schema: string } | undefined;
    if (!target || target.output_schema !== row.source_product_schema) {
      throw new Error('AUTHOR_CARRY_FORWARD_TARGET_INTENT_MISMATCH');
    }
    const metadata = parseRecord(target.metadata, 'target metadata');
    // The child semantic_input_digest intentionally changes because its
    // continuation/adoption provenance is new authority.  Compatibility is
    // the exact stable item contract + output schema + unchanged Git base;
    // equating run-specific provenance would make lawful carry-forward
    // impossible and encourage relabelling the old run instead.
    if (
      typeof metadata.semantic_input_digest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(metadata.semantic_input_digest)
      || sha256Hex(requireRecord(metadata.cell_input_item, 'target item')) !== row.item_snapshot_hash
    ) throw new Error('AUTHOR_CARRY_FORWARD_TARGET_SEMANTICS_MISMATCH');

    this.reverifySource(row);
    const authorizationRef = String(row.authorization_ref);
    return {
      authorizationRef,
      presenterRef: `factory-carry-forward-presenter:${authorizationRef}`,
      sourceCandidateSetRef: String(row.source_candidate_set_ref),
      sourceCandidateSetDigest: String(row.source_candidate_set_digest),
      products: [{
        schemaId: String(row.source_product_schema),
        ref: String(row.source_product_ref),
        digest: String(row.source_product_digest),
      }],
    };
  }

  consume(input: {
    readonly authorizationRef: string;
    readonly processRunId: number;
    readonly workplaceRef: WorkplaceRef;
    readonly candidateSetRef: string;
    readonly presenterRef: string;
  }): void {
    const workplace = serializeWorkplaceRef(input.workplaceRef);
    const prior = this.db.prepare(
      `SELECT * FROM factory_author_candidate_carry_forward_consumptions
        WHERE authorization_ref=?`,
    ).get(input.authorizationRef) as Record<string, unknown> | undefined;
    if (prior) {
      if (
        prior.target_process_run_id !== input.processRunId
        || prior.target_workplace_ref !== workplace
        || prior.target_candidate_set_ref !== input.candidateSetRef
        || prior.presenter_ref !== input.presenterRef
      ) throw new Error('AUTHOR_CARRY_FORWARD_CONSUMPTION_MISMATCH');
      return;
    }
    this.db.prepare(
      `INSERT INTO factory_author_candidate_carry_forward_consumptions
        (authorization_ref,target_process_run_id,target_workplace_ref,
         target_candidate_set_ref,presenter_ref) VALUES (?,?,?,?,?)`,
    ).run(
      input.authorizationRef, input.processRunId, workplace,
      input.candidateSetRef, input.presenterRef,
    );
  }

  private reverifySource(row: Record<string, unknown>): void {
    const candidate = this.db.prepare(
      `SELECT candidate_set_digest FROM factory_candidate_sets WHERE candidate_set_ref=?`,
    ).get(row.source_candidate_set_ref) as { candidate_set_digest: string } | undefined;
    const product = this.db.prepare(
      `SELECT product_schema,product_ref,product_digest FROM factory_candidate_set_members
        WHERE candidate_set_ref=? AND ordinal=0`,
    ).get(row.source_candidate_set_ref) as {
      product_schema: string;
      product_ref: string;
      product_digest: string;
    } | undefined;
    if (
      candidate?.candidate_set_digest !== row.source_candidate_set_digest
      || product?.product_schema !== row.source_product_schema
      || product?.product_ref !== row.source_product_ref
      || product?.product_digest !== row.source_product_digest
    ) throw new Error('AUTHOR_CARRY_FORWARD_SOURCE_EVIDENCE_DRIFT');
    const repository = this.db.prepare(
      `SELECT COALESCE(rc.local_path,pr.local_path) AS local_path,pr.integration_branch
         FROM project_repositories pr LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE pr.id=? AND pr.status='active'`,
    ).get(row.project_repository_id) as { local_path: string | null; integration_branch: string } | undefined;
    if (!repository?.local_path || repository.integration_branch !== row.integration_branch) {
      throw new Error('AUTHOR_CARRY_FORWARD_TARGET_REPOSITORY_DRIFT');
    }
    const currentHead = git(
      repository.local_path,
      'rev-parse',
      `refs/heads/${repository.integration_branch}`,
    );
    const evidence = parseRecord(String(row.evidence_snapshot), 'authorization evidence');
    const postAcceptance = row.eligible_failure_code === POST_ACCEPTANCE_MANIFEST_FAILURE_CODE
      || row.eligible_failure_code === DEVELOPMENT_FREEZE_PROJECTION_FAILURE_CODE
      || row.eligible_failure_code === CROSS_CELL_CARRY_SCOPE_FAILURE_CODE;
    const expectedHead = postAcceptance
      ? evidence.expectedIntegrationHead
      : row.base_commit;
    if (
      currentHead !== expectedHead
      || git(repository.local_path, 'rev-parse', `${String(row.source_commit)}^{tree}`) !== row.source_tree
      || (postAcceptance
        && !isAncestor(repository.local_path, String(row.source_commit), currentHead))
    ) throw new Error('AUTHOR_CARRY_FORWARD_TARGET_BASE_DRIFT');
  }
}

function verifyCandidateDigest(
  candidate: { workplace_ref: string; producer_execution_ref: string; candidate_set_digest: string },
  member: { product_schema: string; product_ref: string; product_digest: string },
): void {
  const digest = createHash('sha256').update(JSON.stringify({
    workplaceRef: candidate.workplace_ref,
    role: 'author',
    products: [{ schemaId: member.product_schema, ref: member.product_ref, digest: member.product_digest }],
  })).digest('hex');
  if (digest !== candidate.candidate_set_digest) {
    throw new Error('AUTHOR_CARRY_FORWARD_CANDIDATE_DIGEST_MISMATCH');
  }
}

function parseManagedSubmissionRef(ref: string): number {
  const match = /^managed-node-submission:(\d+)$/u.exec(ref);
  if (!match) throw new Error('AUTHOR_CARRY_FORWARD_PRODUCT_REF_INVALID');
  return Number(match[1]);
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  return requireRecord(JSON.parse(raw) as unknown, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`AUTHOR_CARRY_FORWARD_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function requireHash(value: unknown, label: string, length: 40 | 64): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)) {
    throw new Error(`AUTHOR_CARRY_FORWARD_${label.toUpperCase().replaceAll(' ', '_')}_INVALID`);
  }
  return value;
}

function git(repositoryPath: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      `AUTHOR_CARRY_FORWARD_GIT_OBSERVATION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isAncestor(repositoryPath: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', [
      '-C', repositoryPath, 'merge-base', '--is-ancestor', ancestor, descendant,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}
