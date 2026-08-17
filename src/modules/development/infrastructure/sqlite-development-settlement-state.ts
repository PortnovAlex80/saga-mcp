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
  INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
  DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
  type AcceptanceVerificationWorkset,
  type CandidateVerificationEvidence,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentImplementationWorkset,
  type DevelopmentImplementationResultProduct,
  type DevelopmentSettlementInput,
  type DevelopmentTaskGraphSnapshot,
  type IntegratedReleaseCandidate,
  type IntegratedSourceCandidate,
  type DevelopmentReadinessManifest,
  type DevelopmentVerificationEvidenceProduct,
  type LocalReadinessReceipt,
  type VerificationProviderBinding,
} from '../domain/development-schemas.js';
import {
  hashAcceptanceVerification,
  hashImplementationWorkset,
  hashIntegratedCandidate,
  hashIntegratedSourceCandidate,
} from '../domain/development-settlement-policy.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../application/candidate-check-contracts.js';
import { SOURCE_CHANGE_CANDIDATE_SCHEMA } from '../../../infrastructure/source-change/managed-source-change-candidate.js';
import {
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
} from '../application/development-check-providers.js';

const PROCESS_PRODUCT_KIND_TASK_GRAPH = 'development.task-graph';
const PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE = 'development.integrated-candidate';
const PROCESS_PRODUCT_KIND_INTEGRATED_SOURCE = 'development.integrated-source-candidate';
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
    | { status: 'frozen'; candidate: IntegratedSourceCandidate; reference: ContentAddressedReference }
    | { status: 'waiting'; reasonCodes: readonly string[] }
    | { status: 'failed'; reasonCodes: readonly string[] } {
    const existing = this.products.read<IntegratedSourceCandidate>(
      input.processRunId,
      PROCESS_PRODUCT_KIND_INTEGRATED_SOURCE,
    );
    if (existing) {
      if (hashIntegratedSourceCandidate(existing.payload) !== existing.payload.sourceHash) {
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
      const integrationIntentRefs = accepted.map((_product, index) =>
        `${integrations[index]!.effectReceiptRef}:commit:${integrations[index]!.integratedCommit}`)
        .sort();
      // ADR-070: freeze integrated material only. Scoped implementation
      // readiness remains evidence and cannot vote on candidate-wide commands.
      const body: Omit<IntegratedSourceCandidate, 'sourceHash'> = {
        schemaVersion: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
        taskGraphHash: graphProduct.payload.graphHash,
        implementationWorksetHash: workset.worksetHash,
        repositories,
        buildProducts,
        integrationIntentRefs,
        frozen: true,
      };
      const candidate = {
        ...body,
        sourceHash: hashIntegratedSourceCandidate({ ...body, sourceHash: '' }),
      };
      const stored = this.products.persist({
        processRunId: input.processRunId,
        productKind: PROCESS_PRODUCT_KIND_INTEGRATED_SOURCE,
        schema: INTEGRATED_SOURCE_CANDIDATE_SCHEMA,
        productHash: candidate.sourceHash,
        payload: candidate,
        artifactRefPrefix: 'development-integrated-source',
      }).record;
      // LR-01 / LR-07 — seal the integrated candidate into an author candidate
      // set so the local-runnability provider can resolve it as its subject
      // (exact-member resolution) and the settlement receipt binding can find
      // it. The freeze is a kernel node; this creates a minimal freeze-scoped
      // workplace + production revision + author CandidateSet whose single
      // member is the exact sealed integrated candidate ProductRef. If the seal
      // fails, the candidate IS persisted — log and still return 'frozen' so the
      // lifecycle advances to verification.
      return { status: 'frozen', candidate: stored.payload, reference: stored.reference };
    } catch {
      return { status: 'failed', reasonCodes: ['candidate-freeze-lineage-invalid'] };
    }
  }

  bindRunnableCandidate(input: {
    processRunId: number;
    developmentCase: DevelopmentCase;
  }):
    | { status: 'bound'; candidate: IntegratedReleaseCandidate; reference: ContentAddressedReference }
    | { status: 'waiting'; reasonCodes: readonly string[] }
    | { status: 'failed'; reasonCodes: readonly string[] } {
    const existing = this.products.read<IntegratedReleaseCandidate>(
      input.processRunId, PROCESS_PRODUCT_KIND_INTEGRATED_CANDIDATE,
    );
    if (existing) {
      return hashIntegratedCandidate(existing.payload) === existing.payload.candidateHash
        ? { status: 'bound', candidate: existing.payload, reference: existing.reference }
        : { status: 'failed', reasonCodes: ['frozen-candidate-corrupt'] };
    }
    const source = this.products.read<IntegratedSourceCandidate>(
      input.processRunId, PROCESS_PRODUCT_KIND_INTEGRATED_SOURCE,
    );
    if (!source || hashIntegratedSourceCandidate(source.payload) !== source.payload.sourceHash) {
      return { status: 'failed', reasonCodes: ['integrated-source-missing'] };
    }
    const manifests = this.readAcceptedCellProducts<DevelopmentReadinessManifest>(
      input.processRunId,
      'development-readiness-certification',
      DEVELOPMENT_READINESS_MANIFEST_SCHEMA,
    );
    if (manifests.length !== 1) {
      return { status: 'waiting', reasonCodes: ['readiness-manifest-missing'] };
    }
    const presentation = manifests[0]!;
    const manifest = presentation.payload;
    if (manifest.sourceCandidate.schema !== source.reference.schema
        || manifest.sourceCandidate.ref !== source.reference.ref
        || manifest.sourceCandidate.hash !== source.reference.hash
        || manifest.targets.length !== 1
        || manifest.targets[0]?.key !== 'primary') {
      return { status: 'failed', reasonCodes: ['readiness-manifest-source-mismatch'] };
    }
    const receipt = this.readExactReadinessReceipt(presentation.candidateSetRef);
    if (!receipt) return { status: 'waiting', reasonCodes: ['local-readiness-missing'] };
    const body: Omit<IntegratedReleaseCandidate, 'candidateHash'> = {
      schemaVersion: INTEGRATED_CANDIDATE_SCHEMA,
      taskGraphHash: source.payload.taskGraphHash,
      implementationWorksetHash: source.payload.implementationWorksetHash,
      repositories: source.payload.repositories,
      buildProducts: source.payload.buildProducts,
      integrationIntentRefs: source.payload.integrationIntentRefs,
      frozen: true,
      readiness: manifest.targets[0].readiness,
      sourceCandidate: source.reference,
      readinessCertification: {
        manifest: presentation.reference,
        candidateSetRef: presentation.candidateSetRef,
        checkReceipt: receipt,
      },
    };
    const candidate: IntegratedReleaseCandidate = {
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
    return { status: 'bound', candidate: stored.payload, reference: stored.reference };
  }

  private readExactReadinessReceipt(candidateSetRef: string): ContentAddressedReference | null {
    const rows = this.db.prepare(
      `SELECT cr.check_receipt_ref,cr.receipt_digest
         FROM factory_check_receipts cr
         JOIN factory_gate_decisions gd
           ON gd.gate_run_ref=cr.check_run_ref
          AND gd.subject_candidate_set_ref=cr.subject_candidate_set_ref
        WHERE cr.subject_candidate_set_ref=?
          AND cr.provider_id=? AND cr.provider_version=? AND cr.provider_digest=?
          AND cr.outcome='passed' AND gd.gate_phase='final' AND gd.verdict='accepted'
        ORDER BY cr.check_receipt_ref`,
    ).all(
      candidateSetRef,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    ) as Array<{ check_receipt_ref: string; receipt_digest: string }>;
    if (rows.length !== 1) return null;
    return {
      schema: 'factory.check-receipt.v1',
      ref: rows[0]!.check_receipt_ref,
      hash: rows[0]!.receipt_digest,
    };
  }

  /**
   * LR-01 / LR-07 — seal the frozen integrated candidate into an author
   * CandidateSet so the local-runnability provider (exact-member resolution)
   * and the settlement receipt binding can read it as their subject. The freeze
   * is a kernel node that produces a process product; without this seal the
   * candidate is a durable product but not a CandidateSet member, so no gate or
   * settlement could resolve it as the runnability subject. Idempotent: a
   * replay of the same freeze finds the existing seal and skips.
   */
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
    const localReadinessReceipt = candidate && candidateProduct
      ? this.readLocalReadinessReceipt(
        input.processRunId,
        candidate,
        candidateProduct.reference,
      )
      : null;

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
      localReadinessReceipt,
    };
  }

  /**
   * LR-07 / W5 — read the durable local-readiness receipt for the EXACT frozen
   * integrated candidate from the Gate-receipt substrate (factory_check_receipts,
   * the LR-06 durable store). The receipt is keyed by the verification author's
   * CandidateSet. Its immutable accepted-authority head and final acceptance
   * prove that the check belongs to an accepted verification Workplace; the
   * frozen WorkIntent input binds that Workplace to THIS candidate's exact ref
   * and digest. Returns null when no accepted receipt is bound to this candidate,
   * when receipts disagree, or when the Gate-receipt substrate is absent
   * (settlement then returns blocked / local-readiness-missing — the W5 gate).
   */
  private readLocalReadinessReceipt(
    _processRunId: number,
    candidate: IntegratedReleaseCandidate,
    _candidateRef: ContentAddressedReference,
  ): LocalReadinessReceipt | null {
    let rows: Array<{ outcome: string; evidence_refs: string }> = [];
    const certification = candidate.readinessCertification;
    if (!certification || !candidate.sourceCandidate) return null;
    try {
      rows = this.db.prepare(
        `SELECT cr.outcome, cr.evidence_refs
           FROM factory_check_receipts cr
           JOIN factory_gate_decisions gd
             ON gd.gate_run_ref=cr.check_run_ref
            AND gd.subject_candidate_set_ref=cr.subject_candidate_set_ref
          WHERE cr.check_receipt_ref=? AND cr.receipt_digest=?
            AND cr.subject_candidate_set_ref=?
            AND cr.provider_id=? AND cr.provider_digest=?
            AND cr.outcome IN ('passed','failed')
            AND gd.gate_phase='final' AND gd.verdict='accepted'`,
      ).all(
        certification.checkReceipt.ref,
        certification.checkReceipt.hash,
        certification.candidateSetRef,
        LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
        LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
      ) as Array<{ outcome: string; evidence_refs: string }>;
    } catch {
      return null;
    }
    if (rows.length === 0) return null;
    const outcomes = new Set(rows.map(row => row.outcome));
    if (outcomes.size !== 1) return null;
    const evidenceRefs = [...new Set(rows.flatMap(row => {
      try {
        const parsed = JSON.parse(row.evidence_refs) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === 'string')
          : [];
      } catch {
        return [];
      }
    }))];
    return {
      candidateHash: candidate.candidateHash,
      outcome: rows[0]!.outcome as 'passed' | 'failed',
      evidenceRefs,
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
    // Match by the kernel-authoritative item key, not the LM-authored payload
    // field (see implementationProductItemKey): a re-hired worker once stamped
    // the 24-hex workplace work_key into payload.workItemKey and this matcher
    // silently dropped the item (units epic-8 cert#37, tips epic-5 cert#40).
    const byKey = new Map(products.map(product => [
      implementationProductItemKey(product),
      product,
    ]));
    const results = taskGraph.implementationItems.map(item => {
      const product = byKey.get(item.key);
      if (!product) {
        return {
          key: item.key,
          status: 'blocked' as const,
          taskId: 0,
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
          AND (tp.project_id=? OR (
            tp.project_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM trusted_providers scoped
               WHERE scoped.project_id=? AND scoped.name=cr.provider_id
                 AND scoped.category='deterministic_evidence'
                 AND scoped.determinism='full' AND scoped.status='active'
            )
          ))
          AND tp.category='deterministic_evidence'
          AND tp.determinism='full'
          AND tp.status='active'
        WHERE cr.subject_candidate_set_ref=?
          AND cr.provider_id=?
          AND cr.provider_version=?
          AND cr.provider_digest=?
          AND cr.outcome='passed'
          AND gd.gate_phase='final'
          AND gd.verdict='accepted'
        ORDER BY cr.check_receipt_ref`,
    ).all(
      projectId,
      projectId,
      candidateSetRef,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
      DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
    ) as Array<{
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
          && refs.every(ref => typeof ref === 'string' && ref.length > 0);
      } catch {
        return false;
      }
    });
    // The LM-authored verification product is not authority for its own
    // outcome. The exact immutable CheckReceipt from the trusted executable
    // lineage provider is the evidence coordinate; evidenceRefs are optional
    // auxiliary diagnostics and therefore may lawfully be empty on success.
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
    reference: ContentAddressedReference;
    taskMetadata: unknown;
    payload: T;
  }> {
    const schemaIds = typeof schemaId === 'string' ? [schemaId] : [...schemaId];
    if (schemaIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT w.workplace_ref AS workplaceRef,
              cs.candidate_set_ref AS candidateSetRef,
              submission.id AS submissionId,
              current_task.id AS taskId,
              current_task.metadata AS taskMetadata,
              submission.payload_snapshot AS payloadSnapshot,
              submission.content_hash AS contentHash,
              member.product_schema AS productSchema
         FROM factory_workplaces w
         LEFT JOIN factory_cell_final_acceptances cfa
           ON cfa.workplace_ref=w.workplace_ref
         LEFT JOIN factory_accepted_authority_head h
           ON h.workplace_ref=w.workplace_ref
         JOIN factory_candidate_sets cs
           ON cs.candidate_set_ref=COALESCE(cfa.candidate_set_ref, h.accepted_author_candidate_set_ref)
          AND cs.role='author'
         JOIN factory_candidate_set_members member
           ON member.candidate_set_ref=cs.candidate_set_ref
          AND member.product_schema IN (${schemaIds.map(() => '?').join(',')})
         JOIN factory_managed_node_submissions submission
           ON member.product_ref='managed-node-submission:' || submission.id
         LEFT JOIN factory_gate_decisions final_decision
           ON final_decision.decision_key=cfa.gate_decision_key
          AND final_decision.subject_candidate_set_ref=cs.candidate_set_ref
          AND final_decision.gate_phase='final'
          AND final_decision.verdict='accepted'
         LEFT JOIN factory_candidate_sets reviewer
           ON reviewer.candidate_set_ref=json_extract(final_decision.assessment_candidate_set_refs,'$[0]')
          AND json_array_length(final_decision.assessment_candidate_set_refs)=1
          AND reviewer.workplace_ref=w.workplace_ref
          AND reviewer.role='reviewer'
          AND reviewer.subject_candidate_set_ref=cs.candidate_set_ref
         JOIN tasks current_task
           ON CAST(current_task.id AS TEXT)=h.accepted_author_task_id
          AND current_task.workplace_ref=w.workplace_ref
          AND json_extract(current_task.metadata,'$.role')='author'
        WHERE w.process_run_id=?
          AND w.production_cell_id=?
          AND w.loop_state='terminal'
          AND w.terminal_reason='accepted'
        ORDER BY w.workplace_ref`,
    ).all(...schemaIds, processRunId, cellId) as Array<{
      workplaceRef: string;
      candidateSetRef: string;
      submissionId: number;
      taskId: number;
      taskMetadata: string;
      payloadSnapshot: string;
      contentHash: string;
      productSchema: string;
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

/**
 * Kernel-authoritative key for one accepted implementation product.
 *
 * payload.workItemKey is LM-authored and NOT authority: a re-hired worker
 * stamped the 24-hex workplace work_key there, the strict byKey matcher then
 * dropped the item, and settlement died on the synthetic placeholder
 * (taskId:0) — units epic-8 cert#37, tips epic-5 cert#40. The authority is
 * the cell_input_item the Factory projected into the ACCEPTED author task's
 * metadata (the same current_task row the products SQL already joins via
 * h.accepted_author_task_id). Legacy products whose author task carries no
 * readable cell_input_item.key fall back to the payload key (old data only).
 */
function implementationProductItemKey(product: {
  taskMetadata: unknown;
  payload: { workItemKey: string };
}): string {
  const item = isRecord(product.taskMetadata)
    ? product.taskMetadata.cell_input_item
    : undefined;
  if (isRecord(item)) {
    const key = item.key;
    if (typeof key === 'string' && key.trim() !== '') return key;
  }
  return product.payload.workItemKey;
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
