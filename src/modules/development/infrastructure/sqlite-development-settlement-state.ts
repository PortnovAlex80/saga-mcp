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
} from '../domain/development-schemas.js';
import {
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
} from '../domain/development-settlement-policy.js';

const PROCESS_PRODUCT_KIND_TASK_GRAPH = 'development.task-graph';


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
    const implementation = taskGraph
      ? this.buildImplementationWorkset(
        input.processRunId,
        taskGraph,
      )
      : null;
    const candidate = implementation && taskGraph
      ? this.buildIntegratedCandidate(
        input.processRunId,
        input.developmentCase,
        taskGraph,
        implementation,
      )
      : null;
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
        implementationWorkset: implementation
          ? refOfWorkset(input.processRunId, implementation)
          : null,
        integratedCandidate: candidate
          ? refOfCandidate(input.processRunId, candidate)
          : null,
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
      DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
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
        status: product.payload.status,
        taskId: product.taskId,
        implementationExecutionId: product.executionId,
        reviewExecutionId: product.reviewExecutionId,
        reviewedSourceCommit: product.payload.reviewedSourceCommit,
        result: product.payload.result ?? product.reference,
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

  private buildIntegratedCandidate(
    processRunId: number,
    developmentCase: DevelopmentCase,
    taskGraph: DevelopmentTaskGraphSnapshot,
    workset: DevelopmentImplementationWorkset,
  ): IntegratedReleaseCandidate | null {
    // Only freeze a candidate once required implementation is complete; a
    // partial workset means integration has not happened yet.
    const requiredKeys = new Set(
      taskGraph.implementationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const requiredSucceeded = workset.results.every(result =>
      !requiredKeys.has(result.key) || result.status === 'succeeded');
    if (!workset.complete || !requiredSucceeded) return null;

    try {
      const accepted = this.readAcceptedCellProducts<DevelopmentImplementationResultProduct>(
        processRunId,
        'development-implementation',
        DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
      );
      const repositoryById = new Map<number, NonNullable<DevelopmentImplementationResultProduct['repository']>>();
      for (const product of accepted) {
        const repository = product.payload.repository;
        if (!repository) continue;
        const prior = repositoryById.get(repository.projectRepositoryId);
        if (prior && (
          prior.branch !== repository.branch
          || prior.commitSha !== repository.commitSha
          || prior.treeHash !== repository.treeHash
        )) {
          // Multiple desks may contribute to one integration target, but they
          // must agree on the exact frozen repository snapshot.
          return null;
        }
        repositoryById.set(repository.projectRepositoryId, repository);
      }
      const repositories = [...repositoryById.values()]
        .sort((left, right) => left.projectRepositoryId - right.projectRepositoryId);
      const expectedRepositoryIds = new Set(
        developmentCase.repositories.map(repository => repository.projectRepositoryId),
      );
      if (repositories.length !== expectedRepositoryIds.size
        || repositories.some(repository => !expectedRepositoryIds.has(repository.projectRepositoryId))) {
        return null;
      }
      const integrationIntentRefs = accepted.map(product => product.candidateSetRef).sort();
      const buildProductByIdentity = new Map<string, (typeof accepted)[number]['payload']['buildProducts'][number]>();
      for (const product of accepted.flatMap(item => item.payload.buildProducts)) {
        const key = `${product.kind}\u0000${product.ref}`;
        const prior = buildProductByIdentity.get(key);
        if (prior && prior.digest !== product.digest) return null;
        buildProductByIdentity.set(key, product);
      }
      const buildProducts = [...buildProductByIdentity.values()]
        .sort((left, right) => left.ref.localeCompare(right.ref));
      const body: Omit<IntegratedReleaseCandidate, 'candidateHash'> = {
        schemaVersion: INTEGRATED_CANDIDATE_SCHEMA,
        taskGraphHash: taskGraph.graphHash,
        implementationWorksetHash: workset.worksetHash,
        repositories,
        buildProducts,
        integrationIntentRefs,
        frozen: true as const,
      };
      return {
        ...body,
        candidateHash: hashIntegratedCandidate({
          ...body,
          candidateHash: '',
        }),
      };
    } catch {
      return null;
    }
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
        criterion.artifactId,
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
      evidence.push({
        verificationItemKey: item.key,
        taskId: product.taskId,
        executionId: product.executionId,
        acceptanceCriterionId: criterionId,
        acceptedCriterionHash: criterion.acceptedHash,
        candidateHash: candidate.candidateHash,
        outcome: product.payload.outcome,
        evidence: product.payload.evidence,
        provider: product.payload.provider,
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

  private readAcceptedCellProducts<T extends { schemaVersion: string }>(
    processRunId: number,
    cellId: string,
    schemaId: string,
  ): Array<{
    workplaceRef: string;
    candidateSetRef: string;
    taskId: number;
    executionId: string;
    reviewExecutionId: string | null;
    reference: ContentAddressedReference;
    payload: T;
  }> {
    const rows = this.db.prepare(
      `SELECT w.workplace_ref AS workplaceRef,
              cs.candidate_set_ref AS candidateSetRef,
              cs.producer_execution_ref AS executionId,
              submission.id AS submissionId,
              submission.task_id AS taskId,
              submission.payload_snapshot AS payloadSnapshot,
              submission.content_hash AS contentHash,
              (SELECT reviewer.producer_execution_ref
                 FROM factory_candidate_sets reviewer
                WHERE reviewer.workplace_ref=w.workplace_ref
                  AND reviewer.role='reviewer'
                ORDER BY reviewer.sealed_at DESC,reviewer.candidate_set_ref DESC
                LIMIT 1) AS reviewExecutionId
         FROM factory_workplaces w
         JOIN factory_candidate_sets cs
           ON cs.workplace_ref=w.workplace_ref AND cs.role='author'
         JOIN factory_candidate_set_members member
           ON member.candidate_set_ref=cs.candidate_set_ref
          AND member.product_schema=?
         JOIN factory_managed_node_submissions submission
           ON member.product_ref='managed-node-submission:' || submission.id
        WHERE w.process_run_id=?
          AND w.production_cell_id=?
          AND w.loop_state='terminal'
          AND w.terminal_reason='accepted'
        ORDER BY w.workplace_ref,cs.sealed_at DESC,cs.candidate_set_ref DESC`,
    ).all(schemaId, processRunId, cellId) as Array<{
      workplaceRef: string;
      candidateSetRef: string;
      executionId: string;
      submissionId: number;
      taskId: number;
      payloadSnapshot: string;
      contentHash: string;
      reviewExecutionId: string | null;
    }>;
    const seen = new Set<string>();
    return rows.flatMap(row => {
      if (seen.has(row.workplaceRef)) return [];
      seen.add(row.workplaceRef);
      const payload = JSON.parse(row.payloadSnapshot) as T;
      if (payload.schemaVersion !== schemaId || sha256Hex(payload) !== row.contentHash) {
        throw new Error(`DEVELOPMENT_CELL_PRODUCT_CORRUPT: ${row.candidateSetRef}`);
      }
      return [{
        workplaceRef: row.workplaceRef,
        candidateSetRef: row.candidateSetRef,
        taskId: row.taskId,
        executionId: row.executionId,
        reviewExecutionId: row.reviewExecutionId,
        reference: {
          schema: schemaId,
          ref: `managed-node-submission:${row.submissionId}`,
          hash: row.contentHash,
        },
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

function refOfCandidate(
  processRunId: number,
  candidate: IntegratedReleaseCandidate,
): ContentAddressedReference {
  return {
    schema: INTEGRATED_CANDIDATE_SCHEMA,
    ref: `development-integrated-candidate:${processRunId}:${candidate.candidateHash}`,
    hash: candidate.candidateHash,
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
