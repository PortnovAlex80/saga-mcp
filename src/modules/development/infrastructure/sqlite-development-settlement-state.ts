/**
 * Development persistence for the validated task graph and deterministic
 * settlement input. Settlement reconstructs its worksets exclusively from
 * accepted CandidateSets and exact typed submissions. Queue/card projections
 * are disposable and never have settlement authority.
 */

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  DevelopmentArtifactSnapshot,
  DevelopmentCanonicalGraphPort,
  DevelopmentSettlementStatePort,
  DevelopmentTaskGraphPort,
  DevelopmentTraceSnapshot,
  GitPort,
  MachinePort,
  ProcessProductRepositoryPort,
} from '../domain/development-kernel-ports.js';
import {
  acceptanceCriterionIdentity,
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  type AcceptanceVerificationWorkset,
  type CandidateVerificationEvidence,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentImplementationWorkset,
  type DevelopmentImplementationResultProduct,
  type DevelopmentSettlementInput,
  type DevelopmentTaskGraphSnapshot,
  type IntegratedReleaseCandidate,
  type DevelopmentVerificationEvidenceProduct,
  type VerificationProviderBinding,
} from '../domain/development-schemas.js';
import {
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
} from '../domain/development-settlement-policy.js';
import { SOURCE_CHANGE_CANDIDATE_SCHEMA } from '../../../infrastructure/source-change/managed-source-change-candidate.js';

const PROCESS_PRODUCT_KIND_TASK_GRAPH = 'development.task-graph';
const PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE = 'development.integrated-candidate';
const PROCESS_PRODUCT_KIND_ADOPTED_IMPLEMENTATION_WORKSET =
  'development.adopted-implementation-workset';

/**
 * SQLite-backed Development module store. Implements the declarative ports over
 * the shared tracker tables (tasks, task_dependencies, worker_executions,
 * integration_intents, verification_evidence, artifacts, artifact_traces) and
 * the module-owned projection tables installed by
 * {@link ensureDevelopmentStoreSchema}.
 *
 *   DevelopmentTaskGraphPort        — persist + project
 *   DevelopmentSettlementStatePort  — re-read + reconstruct settlement input
 *   DevelopmentCanonicalGraphPort   — re-read exact artifacts/traces by id
 */
export class SqliteDevelopmentModuleStore implements
  DevelopmentTaskGraphPort,
  DevelopmentSettlementStatePort,
  DevelopmentCanonicalGraphPort {
  private readonly db: Database.Database;
  private readonly products: ProcessProductRepositoryPort;
  private readonly git: GitPort;
  private readonly machine: MachinePort;

  constructor(
    db: Database.Database,
    products: ProcessProductRepositoryPort,
    git: GitPort,
    machine: MachinePort,
  ) {
    this.db = db;
    this.products = products;
    // Wave 7 hex extraction: git shell-outs and machine identity are injected
    // as ports — the module has no child_process / node:os imports.
    this.git = git;
    this.machine = machine;
    ensureDevelopmentStoreSchema(db);
  }

  // ----- DevelopmentTaskGraphPort --------------------------------------

  materializeValidatedTaskGraph(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    graph: DevelopmentTaskGraphSnapshot;
  }): {
    graph: DevelopmentTaskGraphSnapshot;
    reference: ContentAddressedReference;
  } {
    const existing = this.products.read<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_TASK_GRAPH,
    );
    if (existing) {
      assertStoredGraph(existing, input.graph);
      return { graph: existing.payload, reference: existing.reference };
    }

    const materialize = this.db.transaction(() => {
      this.assertDevelopmentScope(input.developmentCase);
      const stored = this.products.persist({
        processRunId: input.processRunId,
        productKind: PROCESS_PRODUCT_KIND_TASK_GRAPH,
        schema: DEVELOPMENT_TASK_GRAPH_SCHEMA,
        productHash: input.graph.graphHash,
        payload: input.graph,
        artifactRefPrefix: 'development-task-graph',
      });
      return stored.record;
    })();

    return {
      graph: materialize.payload,
      reference: materialize.reference,
    };
  }

  // ----- DevelopmentSettlementStatePort --------------------------------

  adoptVerificationBaseline(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
    taskGraph: DevelopmentTaskGraphSnapshot;
    implementationWorkset: DevelopmentImplementationWorkset;
    integratedCandidate: IntegratedReleaseCandidate;
  }): {
    taskGraph: ContentAddressedReference;
    implementationWorkset: ContentAddressedReference;
    integratedCandidate: ContentAddressedReference;
  } {
    this.assertDevelopmentScope(input.developmentCase);
    if (
      hashImplementationWorkset(input.implementationWorkset)
        !== input.implementationWorkset.worksetHash
      || hashIntegratedCandidate(input.integratedCandidate)
        !== input.integratedCandidate.candidateHash
      || input.implementationWorkset.taskGraphHash !== input.taskGraph.graphHash
      || input.integratedCandidate.taskGraphHash !== input.taskGraph.graphHash
      || input.integratedCandidate.implementationWorksetHash
        !== input.implementationWorkset.worksetHash
    ) {
      throw new Error('DEVELOPMENT_VERIFICATION_ADOPTION_LINEAGE_INVALID');
    }
    const graph = this.materializeValidatedTaskGraph({
      processRunId: input.processRunId,
      developmentCase: input.developmentCase,
      graph: input.taskGraph,
    });
    const workset = this.products.persist({
      processRunId: input.processRunId,
      productKind: PROCESS_PRODUCT_KIND_ADOPTED_IMPLEMENTATION_WORKSET,
      schema: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      productHash: input.implementationWorkset.worksetHash,
      payload: input.implementationWorkset,
      artifactRefPrefix: 'development-adopted-implementation-workset',
    }).record;
    const candidate = this.products.persist({
      processRunId: input.processRunId,
      productKind: PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE,
      schema: INTEGRATED_CANDIDATE_SCHEMA,
      productHash: input.integratedCandidate.candidateHash,
      payload: input.integratedCandidate,
      artifactRefPrefix: 'development-integrated-candidate',
    }).record;
    return {
      taskGraph: graph.reference,
      implementationWorkset: workset.reference,
      integratedCandidate: candidate.reference,
    };
  }

  freezeIntegratedCandidate(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }):
    | { status: 'frozen'; candidate: IntegratedReleaseCandidate; reference: ContentAddressedReference }
    | { status: 'waiting'; reasonCodes: readonly string[] }
    | { status: 'failed'; reasonCodes: readonly string[] } {
    const existing = this.products.read<IntegratedReleaseCandidate>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE,
    );
    if (existing) {
      if (hashIntegratedCandidate(existing.payload) !== existing.payload.candidateHash) {
        return { status: 'failed', reasonCodes: ['frozen-candidate-corrupt'] };
      }
      return {
        status: 'frozen',
        candidate: existing.payload,
        reference: existing.reference,
      };
    }
    const graphProduct = this.products.read<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_TASK_GRAPH,
    );
    if (!graphProduct) return { status: 'failed', reasonCodes: ['task-graph-missing'] };
    const workset = this.buildImplementationWorkset(input.processRunId, graphProduct.payload);
    if (!workset || !workset.complete) {
      return { status: 'failed', reasonCodes: ['implementation-products-incomplete'] };
    }
    const accepted = this.readAcceptedCellProducts<DevelopmentImplementationResultProduct>(
      input.processRunId,
      'development-implementation',
      [DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, SOURCE_CHANGE_CANDIDATE_SCHEMA],
    );
    const integrations = accepted.map(product => {
      const receipts = this.db.prepare(
        `SELECT effect_receipt_ref,evidence_snapshot
           FROM factory_cell_effect_receipts
          WHERE workplace_ref=? AND candidate_set_ref=?
            AND effect_id='git-integration'`,
      ).all(product.workplaceRef, product.candidateSetRef) as Array<{
        effect_receipt_ref: string;
        evidence_snapshot: string;
      }>;
      if (receipts.length !== 1) return null;
      const evidence = JSON.parse(receipts[0]!.evidence_snapshot) as unknown;
      if (!isRecord(evidence)) return null;
      const integratedCommit = stringValue(evidence.providerEffectId);
      if (!/^[a-f0-9]{40}$/u.test(integratedCommit)) return null;
      return {
        effectReceiptRef: receipts[0]!.effect_receipt_ref,
        integratedCommit,
      };
    });
    if (integrations.some(receipt => receipt === null)) {
      return { status: 'failed', reasonCodes: ['implementation-integration-not-merged'] };
    }
    try {
      this.assertDevelopmentScope(input.developmentCase);
      const repositories = graphProduct.payload.integrationTargets.map(target => {
        const binding = this.readRepositoryPath(target.projectRepositoryId);
        if (!binding || binding.projectId !== input.developmentCase.projectId) {
          throw new Error('repository checkout missing');
        }
        const commitSha = this.git.read(binding.localPath, [
          'rev-parse', `refs/heads/${target.targetBranch}`,
        ]);
        if (!commitSha || !this.git.ok(binding.localPath, [
          'merge-base', '--is-ancestor', target.expectedBaseCommit, commitSha,
        ])) throw new Error('integration branch lineage mismatch');
        const treeHash = this.git.read(binding.localPath, [
          'rev-parse', `${commitSha}^{tree}`,
        ]);
        if (!treeHash) throw new Error('integration tree missing');
        return {
          projectRepositoryId: target.projectRepositoryId,
          branch: target.targetBranch,
          commitSha,
          treeHash,
        };
      }).sort((left, right) => left.projectRepositoryId - right.projectRepositoryId);
      const buildProducts = repositories.map(repository => ({
        kind: 'source-tree',
        ref: `project-repository:${repository.projectRepositoryId}:${repository.commitSha}`,
        digest: repository.treeHash,
      }));
      const integrationIntentRefs = accepted.map((product, index) =>
        `${integrations[index]!.effectReceiptRef}:task:${product.taskId}:commit:${integrations[index]!.integratedCommit}`)
        .sort();
      const body: Omit<IntegratedReleaseCandidate, 'candidateHash'> = {
        schemaVersion: INTEGRATED_CANDIDATE_SCHEMA,
        taskGraphHash: graphProduct.payload.graphHash,
        implementationWorksetHash: workset.worksetHash,
        repositories,
        buildProducts,
        integrationIntentRefs,
        frozen: true,
      };
      const candidate = {
        ...body,
        candidateHash: hashIntegratedCandidate({ ...body, candidateHash: '' }),
      };
      const stored = this.products.persist({
        processRunId: input.processRunId,
        productKind: PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE,
        schema: INTEGRATED_CANDIDATE_SCHEMA,
        productHash: candidate.candidateHash,
        payload: candidate,
        artifactRefPrefix: 'development-integrated-candidate',
      }).record;
      return { status: 'frozen', candidate: stored.payload, reference: stored.reference };
    } catch {
      return { status: 'failed', reasonCodes: ['candidate-freeze-lineage-invalid'] };
    }
  }

  buildSettlementInput(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }): DevelopmentSettlementInput {
    const taskGraphProduct = this.products.read<DevelopmentTaskGraphSnapshot>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_TASK_GRAPH,
    );
    const taskGraph = taskGraphProduct?.payload ?? null;
    const taskGraphRef = taskGraphProduct?.reference ?? null;

    // Reconstruct module semantics exclusively from accepted, sealed cell
    // products. `tasks` is a disposable queue/card projection and is never a
    // settlement authority (ADR-030).
    const adoptedImplementation = this.products.read<DevelopmentImplementationWorkset>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_ADOPTED_IMPLEMENTATION_WORKSET,
    );
    const implementation = adoptedImplementation?.payload ?? (taskGraph
      ? this.buildImplementationWorkset(input.processRunId, taskGraph)
      : null);
    const candidateProduct = this.products.read<IntegratedReleaseCandidate>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE,
    );
    const candidate = candidateProduct?.payload ?? null;
    const verification = candidate && taskGraph
      ? this.buildAcceptanceVerification(
        input.processRunId,
        input.developmentCase,
        taskGraph,
        candidate,
      )
      : null;

    const observedCandidateHash = candidate
      ? this.observeCandidate(candidate)
      : null;
    const openHumanGateIds = this.readPausedWorkplaces(input.processRunId);

    return {
      schemaVersion: DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
      developmentCase: input.developmentCase,
      taskGraph,
      implementationWorkset: implementation,
      integratedCandidate: candidate,
      observedCandidateHash,
      acceptanceVerification: verification,
      productReferences: {
        taskGraph: taskGraphRef,
        implementationWorkset: adoptedImplementation?.reference
          ?? (implementation ? refOfWorkset(input.processRunId, implementation) : null),
        integratedCandidate: candidateProduct?.reference ?? null,
        acceptanceVerification: verification
          ? refOfVerification(input.processRunId, verification)
          : null,
      },
      openHumanGateIds,
    };
  }

  // ----- inner workset reconstruction ---------------------------------

  private buildImplementationWorkset(
    processRunId: number,
    taskGraph: DevelopmentTaskGraphSnapshot,
  ): DevelopmentImplementationWorkset | null {
    if (taskGraph.implementationItems.length === 0) return null;
    const products = this.readAcceptedCellProducts<DevelopmentImplementationResultProduct>(
      processRunId,
      'development-implementation',
      [DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA, SOURCE_CHANGE_CANDIDATE_SCHEMA],
    );
    const byKey = new Map(products.map(product => [product.payload.workItemKey, product]));
    const results = taskGraph.implementationItems.map(item => {
      const product = byKey.get(item.key);
      if (!product) {
        return {
          key: item.key,
          status: 'blocked' as const,
          taskId: 0,
          implementationExecutionId: null,
          reviewExecutionId: null,
          reviewedSourceCommit: null,
          result: null,
          reasonCodes: ['accepted-cell-product-missing'],
        };
      }
      return {
        key: item.key,
        status: product.payload.terminalStatus === 'complete'
          ? 'succeeded' as const
          : product.payload.terminalStatus,
        taskId: product.taskId,
        implementationExecutionId: product.executionId,
        reviewExecutionId: product.reviewExecutionId,
        reviewedSourceCommit: product.payload.source.commitSha,
        result: product.reference,
        reasonCodes: [...product.payload.reasonCodes],
      };
    });
    const requiredKeys = new Set(
      taskGraph.implementationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const blockingItemKeys = results
      .filter(result =>
        requiredKeys.has(result.key) && result.status !== 'succeeded')
      .map(result => result.key)
      .sort();
    const body = {
      schemaVersion: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
      taskGraphHash: taskGraph.graphHash,
      results,
      complete: blockingItemKeys.length === 0,
      blockingItemKeys,
    } as const;
    return {
      ...body,
      worksetHash: hashImplementationWorkset({ ...body, worksetHash: '' }),
    };
  }

  private buildAcceptanceVerification(
    processRunId: number,
    developmentCase: DevelopmentCase,
    taskGraph: DevelopmentTaskGraphSnapshot,
    candidate: IntegratedReleaseCandidate,
  ): AcceptanceVerificationWorkset | null {
    if (taskGraph.verificationItems.length === 0) return null;
    const products = this.readAcceptedCellProducts<DevelopmentVerificationEvidenceProduct>(
      processRunId,
      'development-verification',
      DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
    );
    const byKey = new Map(products.map(product => [product.payload.verificationItemKey, product]));
    const criterionById = new Map(
      developmentCase.acceptanceCriteria.map(criterion => [
        acceptanceCriterionIdentity(criterion),
        criterion,
      ]),
    );
    const evidence: CandidateVerificationEvidence[] = [];
    for (const item of taskGraph.verificationItems) {
      const product = byKey.get(item.key);
      if (!product) continue;
      const criterionId = item.acceptanceCriterionIds[0];
      if (criterionId === undefined) continue;
      const criterion = criterionById.get(criterionId);
      if (!criterion) continue;
      if (
        product.payload.acceptanceCriterionId !== criterionId
        || product.payload.acceptedCriterionHash !== criterion.acceptedHash
        || product.payload.candidateHash !== candidate.candidateHash
      ) continue;
      const authority = this.readTrustedVerificationReceipt(
        developmentCase.projectId,
        product.candidateSetRef,
      );
      if (!authority) continue;
      evidence.push({
        verificationItemKey: item.key,
        taskId: product.taskId,
        executionId: product.executionId,
        acceptanceCriterionId: criterionId,
        acceptedCriterionHash: product.payload.acceptedCriterionHash,
        candidateHash: product.payload.candidateHash,
        // Outcome and authority come from the immutable executable provider
        // receipt, never from the LM assessment payload or task metadata.
        outcome: authority.outcome,
        evidence: authority.evidence,
        provider: authority.provider,
      });
    }

    const requiredCount = taskGraph.verificationItems
      .filter(item => item.required).length;
    const complete = evidence.length === requiredCount;
    const body: Omit<AcceptanceVerificationWorkset, 'verificationHash'> = {
      schemaVersion: ACCEPTANCE_VERIFICATION_SCHEMA,
      acceptanceBaselineHash: developmentCase.acceptanceBaselineHash,
      candidateHash: candidate.candidateHash,
      evidence: evidence.sort((left, right) =>
        left.verificationItemKey.localeCompare(right.verificationItemKey)),
      complete,
    };
    return {
      ...body,
      verificationHash: hashAcceptanceVerification({
        ...body,
        verificationHash: '',
      }),
    };
  }

  private readTrustedVerificationReceipt(
    projectId: number,
    candidateSetRef: string,
  ): {
    outcome: 'passed';
    evidence: ContentAddressedReference;
    provider: VerificationProviderBinding;
  } | null {
    const rows = this.db.prepare(
      `SELECT cr.check_receipt_ref,cr.receipt_digest,cr.provider_id,
              cr.provider_version,cr.outcome,cr.evidence_refs,
              tp.id AS trusted_provider_id,tp.name,tp.version
         FROM factory_check_receipts cr
         JOIN factory_gate_decisions gd
           ON gd.gate_run_ref=cr.check_run_ref
          AND gd.subject_candidate_set_ref=cr.subject_candidate_set_ref
         JOIN trusted_providers tp
           ON tp.name=cr.provider_id
          AND (tp.project_id=? OR tp.project_id IS NULL)
          AND tp.category='deterministic_evidence'
          AND tp.determinism='full'
          AND tp.status='active'
        WHERE cr.subject_candidate_set_ref=?
          AND cr.outcome='passed'
          AND gd.gate_phase='final'
          AND gd.verdict='accepted'
        ORDER BY tp.project_id DESC,cr.check_receipt_ref`,
    ).all(projectId, candidateSetRef) as Array<{
      check_receipt_ref: string;
      receipt_digest: string;
      provider_id: string;
      provider_version: string;
      outcome: 'passed';
      evidence_refs: string;
      trusted_provider_id: number;
      name: string;
      version: string | null;
    }>;
    const admissible = rows.filter(row => {
      if (row.version !== null && row.version !== row.provider_version) return false;
      try {
        const refs = JSON.parse(row.evidence_refs) as unknown;
        return Array.isArray(refs)
          && refs.length > 0
          && refs.every(ref => typeof ref === 'string' && ref.length > 0);
      } catch {
        return false;
      }
    });
    // v2 workset has one provider binding per AC. Multiple executable
    // authorities need an explicit aggregation receipt rather than an
    // arbitrary winner.
    if (admissible.length !== 1) return null;
    const row = admissible[0]!;
    return {
      outcome: 'passed',
      evidence: {
        schema: 'factory.check-receipt.v1',
        ref: row.check_receipt_ref,
        hash: row.receipt_digest,
      },
      provider: {
        providerId: row.trusted_provider_id,
        name: row.name,
        version: row.version,
        category: 'deterministic_evidence',
        trusted: true,
      },
    };
  }

  private readAcceptedCellProducts<T>(
    processRunId: number,
    cellId: string,
    schemaId: string | readonly string[],
  ): Array<{
    workplaceRef: string;
    candidateSetRef: string;
    taskId: number;
    executionId: string;
    reviewExecutionId: string | null;
    reference: ContentAddressedReference;
    taskMetadata: unknown;
    payload: T;
  }> {
    const schemaIds = typeof schemaId === 'string' ? [schemaId] : [...schemaId];
    if (schemaIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT w.workplace_ref AS workplaceRef,
              cs.candidate_set_ref AS candidateSetRef,
              cs.producer_execution_ref AS executionId,
              submission.id AS submissionId,
              current_task.id AS taskId,
              current_task.metadata AS taskMetadata,
              submission.payload_snapshot AS payloadSnapshot,
              submission.content_hash AS contentHash,
              member.product_schema AS productSchema,
              (SELECT reviewer.producer_execution_ref
                 FROM factory_candidate_sets reviewer
                WHERE reviewer.workplace_ref=w.workplace_ref
                  AND reviewer.role='reviewer'
                ORDER BY reviewer.candidate_set_ref DESC
                LIMIT 1) AS reviewExecutionId
         FROM factory_workplaces w
         JOIN factory_cell_final_acceptances cfa
           ON cfa.workplace_ref=w.workplace_ref
         JOIN factory_candidate_sets cs
           ON cs.candidate_set_ref=cfa.candidate_set_ref AND cs.role='author'
         JOIN factory_candidate_set_members member
           ON member.candidate_set_ref=cs.candidate_set_ref
          AND member.product_schema IN (${schemaIds.map(() => '?').join(',')})
         JOIN factory_managed_node_submissions submission
           ON member.product_ref='managed-node-submission:' || submission.id
         JOIN tasks current_task
           ON current_task.workplace_ref=w.workplace_ref
          AND json_extract(current_task.metadata,'$.role')='author'
        WHERE w.process_run_id=?
          AND w.production_cell_id=?
          AND w.loop_state='terminal'
          AND w.terminal_reason='accepted'
        ORDER BY w.workplace_ref`,
    ).all(...schemaIds, processRunId, cellId) as Array<{
      workplaceRef: string;
      candidateSetRef: string;
      executionId: string;
      submissionId: number;
      taskId: number;
      taskMetadata: string;
      payloadSnapshot: string;
      contentHash: string;
      productSchema: string;
      reviewExecutionId: string | null;
    }>;
    const seen = new Set<string>();
    return rows.flatMap(row => {
      if (seen.has(row.workplaceRef)) return [];
      seen.add(row.workplaceRef);
      const payload = JSON.parse(row.payloadSnapshot) as T;
      if (sha256Hex(payload) !== row.contentHash) {
        throw new Error(`DEVELOPMENT_CELL_PRODUCT_CORRUPT: ${row.candidateSetRef}`);
      }
      return [{
        workplaceRef: row.workplaceRef,
        candidateSetRef: row.candidateSetRef,
        taskId: row.taskId,
        executionId: row.executionId,
        reviewExecutionId: row.reviewExecutionId,
        reference: {
          schema: row.productSchema,
          ref: `managed-node-submission:${row.submissionId}`,
          hash: row.contentHash,
        },
        taskMetadata: JSON.parse(row.taskMetadata) as unknown,
        payload,
      }];
    });
  }

  private readPausedWorkplaces(processRunId: number): string[] {
    return (this.db.prepare(
      `SELECT workplace_ref
         FROM factory_workplaces
        WHERE process_run_id=? AND loop_state='paused'
        ORDER BY workplace_ref`,
    ).all(processRunId) as Array<{ workplace_ref: string }>)
      .map(row => row.workplace_ref);
  }

  // ----- DevelopmentCanonicalGraphPort --------------------------------

  readArtifactsByIds(ids: readonly number[]): readonly DevelopmentArtifactSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, project_id, epic_id, type, code, status, content_hash,
              accepted_hash, drift_state, tags, metadata
         FROM artifacts
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      project_id: number;
      epic_id: number;
      type: string;
      code: string | null;
      status: string;
      content_hash: string | null;
      accepted_hash: string | null;
      drift_state: string;
      tags: string;
      metadata: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      type: row.type,
      code: row.code,
      status: row.status,
      contentHash: row.content_hash,
      acceptedHash: row.accepted_hash,
      driftState: row.drift_state,
      tags: parseTags(row.tags),
      metadata: parseMetadata(row.metadata),
    }));
  }

  readTracesByIds(ids: readonly number[]): readonly DevelopmentTraceSnapshot[] {
    const unique = [...new Set(ids.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      sourceArtifactId: row.source_id,
      targetType: row.target_type,
      targetId: row.target_id,
      linkType: row.link_type,
    }));
  }

  readOutgoingArtifactTraces(
    sourceArtifactIds: readonly number[],
  ): readonly DevelopmentTraceSnapshot[] {
    const unique = [...new Set(sourceArtifactIds.filter(Number.isInteger))].sort((a, b) => a - b);
    if (unique.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT id, source_id, target_type, target_id, link_type
         FROM artifact_traces
        WHERE source_id IN (${unique.map(() => '?').join(',')})
        ORDER BY id`,
    ).all(...unique) as Array<{
      id: number;
      source_id: number;
      target_type: 'artifact' | 'task';
      target_id: number;
      link_type: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      sourceArtifactId: row.source_id,
      targetType: row.target_type,
      targetId: row.target_id,
      linkType: row.link_type,
    }));
  }

  private readRepositoryPath(
    projectRepositoryId: number,
  ): {
    projectId: number;
    localPath: string;
  } | null {
    const row = this.db.prepare(
      `SELECT pr.project_id,
              COALESCE(rc.local_path,pr.local_path) AS local_path
         FROM project_repositories pr
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id
          AND rc.machine_id=?
          AND rc.status='active'
        WHERE pr.id=? AND pr.status='active'`,
    ).get(this.machine.hostname(), projectRepositoryId) as {
      project_id: number;
      local_path: string | null;
    } | undefined;
    return row?.local_path
      ? { projectId: row.project_id, localPath: row.local_path }
      : null;
  }

  private observeCandidate(
    candidate: IntegratedReleaseCandidate,
  ): string | null {
    try {
      const repositories = candidate.repositories.map(repository => {
        const binding = this.readRepositoryPath(repository.projectRepositoryId);
        if (!binding) throw new Error('checkout missing');
        const commitSha = this.git.read(binding.localPath, [
          'rev-parse',
          `refs/heads/${repository.branch}`,
        ]);
        if (!commitSha) throw new Error('branch missing');
        const treeHash = this.git.read(binding.localPath, [
          'rev-parse',
          `${commitSha}^{tree}`,
        ]);
        if (!treeHash) throw new Error('tree missing');
        return {
          projectRepositoryId: repository.projectRepositoryId,
          branch: repository.branch,
          commitSha,
          treeHash,
        };
      });
      const buildProducts = candidate.buildProducts.map(product => {
        if (product.kind !== 'source-tree') return product;
        const repository = repositories.find(item =>
          product.ref.includes(
            `project-repository:${item.projectRepositoryId}:`,
          ));
        return repository
          ? { ...product, digest: repository.treeHash }
          : product;
      });
      return hashIntegratedCandidate({
        ...candidate,
        repositories,
        buildProducts,
      });
    } catch {
      return null;
    }
  }

  private assertDevelopmentScope(developmentCase: DevelopmentCase): void {
    const epic = this.db.prepare(
      'SELECT project_id FROM epics WHERE id=?',
    ).get(developmentCase.epicId) as { project_id: number } | undefined;
    if (!epic || epic.project_id !== developmentCase.projectId) {
      throw new Error('DEVELOPMENT_EPIC_PROJECT_SCOPE_MISMATCH');
    }
    for (const repository of developmentCase.repositories) {
      const row = this.db.prepare(
        `SELECT project_id,integration_branch
           FROM project_repositories WHERE id=? AND status='active'`,
      ).get(repository.projectRepositoryId) as {
        project_id: number;
        integration_branch: string;
      } | undefined;
      if (
        !row
        || row.project_id !== developmentCase.projectId
        || row.integration_branch !== repository.integrationBranch
      ) {
        throw new Error(
          `DEVELOPMENT_REPOSITORY_SCOPE_MISMATCH: `
          + repository.projectRepositoryId,
        );
      }
    }
    for (const criterion of developmentCase.acceptanceCriteria) {
      const row = this.db.prepare(
        `SELECT epic_id,type,status,accepted_hash,content_hash,drift_state
           FROM artifacts WHERE id=?`,
      ).get(criterion.artifactId) as {
        epic_id: number;
        type: string;
        status: string;
        accepted_hash: string | null;
        content_hash: string | null;
        drift_state: string;
      } | undefined;
      if (
        !row
        || row.epic_id !== developmentCase.epicId
        || row.type !== 'AC'
        || row.status !== 'accepted'
        || row.accepted_hash !== criterion.acceptedHash
        || row.content_hash !== criterion.acceptedHash
        || row.drift_state !== 'clean'
      ) {
        throw new Error(
          `DEVELOPMENT_ACCEPTANCE_BASELINE_MISMATCH: `
          + criterion.artifactId,
        );
      }
    }
  }
}

/**
 * Build a synthetic durable reference for the in-memory implementation
 * workset. The workset is not persisted to the process-product store; this
 * reference lets the settlement policy's referenceMatches check pass while
 * binding the exact workset hash into the verified bundle.
 */
function refOfWorkset(
  processRunId: number,
  workset: DevelopmentImplementationWorkset,
): ContentAddressedReference {
  return {
    schema: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
    ref: `development-implementation-workset:${processRunId}:${workset.worksetHash}`,
    hash: workset.worksetHash,
  };
}

function refOfVerification(
  processRunId: number,
  verification: AcceptanceVerificationWorkset,
): ContentAddressedReference {
  return {
    schema: ACCEPTANCE_VERIFICATION_SCHEMA,
    ref: `development-acceptance-verification:${processRunId}:${verification.verificationHash}`,
    hash: verification.verificationHash,
  };
}

function assertStoredGraph(
  existing: { payload: DevelopmentTaskGraphSnapshot; reference: ContentAddressedReference },
  expected: DevelopmentTaskGraphSnapshot,
): void {
  if (
    existing.payload.graphHash !== expected.graphHash
    || existing.reference.hash !== expected.graphHash
    || sha256Hex(existing.payload) !== sha256Hex(expected)
  ) {
    throw new Error(
      'DEVELOPMENT_TASK_GRAPH_REPLAY_MISMATCH: stored graph differs from authorized graph',
    );
  }
}

function parseTags(raw: string): readonly string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function ensureDevelopmentStoreSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_development_task_projections (
      process_run_id INTEGER NOT NULL
                       REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      graph_hash     TEXT NOT NULL,
      work_item_key  TEXT NOT NULL,
      item_kind      TEXT NOT NULL
                       CHECK (item_kind IN ('implementation','verification')),
      task_id        INTEGER NOT NULL
                       REFERENCES tasks(id) ON DELETE RESTRICT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(process_run_id,work_item_key),
      UNIQUE(process_run_id,task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_development_projection_task
      ON factory_development_task_projections(task_id);
  `);
}
