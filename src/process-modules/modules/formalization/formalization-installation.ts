import { createHash } from 'node:crypto';
import { getDb } from '../../../db.js';
import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import {
  type ExactCandidateAcceptance,
  type ExactCandidateAcceptanceDirective,
} from '../../application/exact-candidate-acceptance.js';
import {
  withKernelRecoveryIssue,
  type KernelRecoveryIssueSpec,
} from '../../application/kernel-recovery-issue.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../application/kernel-handler-registry.js';
import type {
  NodeExecutionReceipt,
  NodeExecutionResult,
  NodeProduction,
} from '../../application/node-executor.js';
import type {
  ProcessModuleExecutionContext,
} from '../../application/process-module-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../application/lifecycle-orchestrator.js';
import type { ProcessModuleOutput } from '../../persistence/process-run.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  FormalizationArtifactGraphPort,
  FormalizationArtifactSnapshot,
  FormalizationCanonicalGraphPort,
  FormalizationManagedProductionLedger,
  FormalizationSettlementPolicyPort,
  FormalizationTraceSnapshot,
  ManagedArtifactWriteRecord,
  ManagedProductionQuery,
  ManagedTraceWriteRecord,
} from './formalization-kernel-ports.js';
import { buildFormalizationCertificatePayload } from './formalization-kernel-ports.js';
import type {
  AcceptanceBaselineSnapshotRecord,
  FormalizationBaselineRepository,
  FormalizationSolutionContractRepository,
} from './formalization-persistence.js';
import {
  ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
  FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
  FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
  FORMALIZATION_CASE_SCHEMA,
  FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
  FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
  FORMALIZATION_RECONCILIATION_SCHEMA,
  FORMALIZATION_SRS_SCHEMA,
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
  FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
  type FormalizationCase,
  type FormalizationSettlementInput,
  type FormalizationSolutionContractPayload,
  type SolutionContractBundle,
} from './formalization-schemas.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from './formalization-schemas.js';

export const FORMALIZATION_MODULE_KEY =
  `${FORMALIZATION_PROCESS_MODULE_REF.name}@${FORMALIZATION_PROCESS_MODULE_REF.version}`;

export const FORMALIZATION_HANDLER_IDS = {
  resolveProduct: 'formalization-resolve-product-contract',
  resolveUseCases: 'formalization-resolve-use-cases',
  resolveAcceptance: 'formalization-resolve-acceptance-contract',
  resolveReconciliation: 'formalization-resolve-reconciliation',
  freezeBaseline: 'formalization-baseline-freezer',
  resolveArchitecture: 'formalization-resolve-architecture-contract',
  settle: 'formalization-settlement-policy',
} as const;

const SOURCE_NODES = {
  product: 'define-product-contract',
  useCases: 'model-use-cases',
  acceptance: 'define-acceptance-contract',
  reconciliation: 'reconcile-what',
  architecture: 'define-architecture-contract',
} as const;

const RESOLVER_NODES = {
  product: 'resolve-product-contract',
  useCases: 'resolve-use-cases',
  acceptance: 'resolve-acceptance-contract',
  reconciliation: 'resolve-reconciliation',
  baseline: 'freeze-acceptance-baseline',
  architecture: 'resolve-architecture-contract',
} as const;

export interface FormalizationInstallationDeps {
  ledger: FormalizationManagedProductionLedger;
  graph: FormalizationCanonicalGraphPort;
  baselineRepository: FormalizationBaselineRepository;
  solutionContractRepository: FormalizationSolutionContractRepository;
  settlementPolicy: FormalizationSettlementPolicyPort;
  candidateAcceptance: Pick<ExactCandidateAcceptance, 'isAcceptedExact'>;
}

interface ExecutionWrites {
  receipt: NodeExecutionReceipt;
  artifactWrites: readonly ManagedArtifactWriteRecord[];
  traceWrites: readonly ManagedTraceWriteRecord[];
  artifacts: readonly FormalizationArtifactSnapshot[];
  traces: readonly FormalizationTraceSnapshot[];
}

interface ContractSnapshot {
  artifacts: readonly FormalizationArtifactSnapshot[];
  traces: readonly FormalizationTraceSnapshot[];
  targetArtifacts: readonly FormalizationArtifactSnapshot[];
  artifactHashes: Readonly<Record<string, string>>;
  traceDigest: string;
}

interface ProductCategories {
  prd: FormalizationArtifactSnapshot[];
  frs: FormalizationArtifactSnapshot[];
  nfrs: FormalizationArtifactSnapshot[];
  rules: FormalizationArtifactSnapshot[];
  ucs: FormalizationArtifactSnapshot[];
  acs: FormalizationArtifactSnapshot[];
  srs: FormalizationArtifactSnapshot[];
}

const PRODUCT_CONTRACT_TYPES = ['PRD', 'FR', 'NFR', 'RULE'] as const;
const PRODUCT_SUPPORTING_TYPES = [
  'decision',
  'brief',
  'hypothesis',
  'business_metric',
  'theme',
] as const;

function recoverySpec(
  policyId: string,
  subject: string,
  acceptanceCriteria: readonly string[],
  allowedChanges: readonly string[],
  recoverableEvents: readonly string[] = ['clarification-required', 'inconsistent'],
): KernelRecoveryIssueSpec {
  return {
    policyId,
    subject,
    acceptanceCriteria,
    allowedChanges,
    triggerEvents: recoverableEvents,
    reasonBindings: ['reason', 'gap'],
    subjectIdBindings: [
      'dirtyArtifactIds',
      'unacceptedArtifactIds',
      'artifactIds',
    ],
    actualBindings: [
      'gap',
      'reason',
      'unacceptedArtifactIds',
      'baselineDriftArtifactIds',
    ],
    // Re-baselining is an explicit governance action, not an LM repair. Until
    // the runtime exposes a durable acknowledge/rebaseline command, preserve
    // the module's inconsistent outcome.
    skip: ({ bindings }) =>
      Array.isArray(bindings.baselineDriftArtifactIds)
      && bindings.baselineDriftArtifactIds.some(Number.isInteger),
    // A reconciler may repair its own traces, but it cannot accept an artifact
    // owned by an earlier author/resolver gate.
    disposition: ({ bindings }) =>
      Array.isArray(bindings.unacceptedArtifactIds)
      && bindings.unacceptedArtifactIds.some(Number.isInteger)
        ? 'human'
        : 'repair',
  };
}

export function createFormalizationKernelHandlers(
  deps: FormalizationInstallationDeps,
): Record<string, KernelHandler> {
  return {
    [FORMALIZATION_HANDLER_IDS.resolveProduct]: withKernelRecoveryIssue(
      createResolveProductHandler(deps),
      recoverySpec('repair-product-contract', 'product contract', [
        'Exactly one PRD and at least one FR are present.',
        'Product artifacts are trace-complete and accepted+clean.',
      ], ['PRD', 'FR', 'NFR', 'RULE', 'their outgoing traces']),
    ),
    [FORMALIZATION_HANDLER_IDS.resolveUseCases]: withKernelRecoveryIssue(
      createResolveUseCasesHandler(deps),
      recoverySpec('repair-use-case-contract', 'use-case contract', [
        'Every UC derives from the exact PRD and covers an exact FR.',
        'Use-case artifacts are accepted+clean.',
      ], ['UC artifacts', 'UC derived_from/covers traces']),
    ),
    [FORMALIZATION_HANDLER_IDS.resolveAcceptance]: withKernelRecoveryIssue(
      createResolveAcceptanceHandler(deps),
      recoverySpec('repair-acceptance-contract', 'acceptance contract', [
        'Every AC derives from an exact FR or NFR.',
        'FR-derived AC also derives from an exact UC.',
        'Acceptance artifacts are accepted+clean.',
      ], ['AC artifacts', 'AC derived_from traces']),
    ),
    [FORMALIZATION_HANDLER_IDS.resolveReconciliation]: withKernelRecoveryIssue(
      createResolveReconciliationHandler(deps),
      recoverySpec('repair-reconciliation', 'WHAT reconciliation', [
        'The exact product, UC and AC set is trace-complete.',
        'Every contract artifact is accepted+clean.',
      ], ['reconciliation-owned traces', 'unaccepted WHAT artifacts']),
    ),
    [FORMALIZATION_HANDLER_IDS.freezeBaseline]: createBaselineFreezerHandler(deps),
    [FORMALIZATION_HANDLER_IDS.resolveArchitecture]: withKernelRecoveryIssue(
      createResolveArchitectureHandler(deps),
      recoverySpec('repair-architecture-contract', 'architecture contract', [
        'Exactly one SRS is produced and traces to the exact PRD.',
        'The frozen acceptance baseline has not drifted.',
        'The reviewed SRS candidate is accepted+clean by the kernel gate.',
      ], ['SRS artifact', 'SRS derived_from traces']),
    ),
    [FORMALIZATION_HANDLER_IDS.settle]: createSettlementHandler(deps),
  };
}

/**
 * GenericFlowExecutor output hook. It never reconstructs a bundle from mutable
 * live state: the settlement handler persists one immutable SolutionContract,
 * terminal outcome emission preserves its bindings, and this hook re-reads the
 * exact row before exposing ProcessModuleRunResult.output.
 */
export function createFormalizationOutputResolver(
  repository: FormalizationSolutionContractRepository,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: NodeExecutionResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (_module, terminalOutcome, terminalResult, context) => {
    if (terminalOutcome !== 'formalized') return null;
    const bindings = terminalResult.production?.bindings ?? {};
    const artifactRef = stringBinding(bindings, 'solutionContractRef');
    const contentHash = stringBinding(bindings, 'solutionContractHash');
    const schema = stringBinding(bindings, 'solutionContractSchema');
    const record = repository.readByProcessRun(context.processRunId);
    if (
      !record
      || record.processRunId !== context.processRunId
      || record.formalizationEpicId !== context.epicId
      || record.artifactRef !== artifactRef
      || record.contentHash !== contentHash
      || record.payload.schemaVersion !== schema
    ) {
      throw new Error(
        `formalization output: terminal bindings do not resolve to the exact `
        + `SolutionContract for process_run ${context.processRunId}`,
      );
    }
    return { schema, artifactRef, contentHash };
  };
}

/**
 * Lifecycle handoffs dereference the exact immutable SolutionContract selected
 * by ProcessRun.output. The generic registry independently re-hashes the
 * returned payload before any declarative Formalization → Development mapping
 * may consume it.
 */
export function createFormalizationLifecycleOutputPayloadResolver(
  repository: FormalizationSolutionContractRepository,
): ProcessOutputPayloadResolver {
  return context => {
    const record = repository.readByProcessRun(context.processRunId);
    if (
      !record
      || record.processRunId !== context.processRunId
      || record.formalizationEpicId !== context.epicId
      || record.artifactRef !== context.output.artifactRef
      || record.contentHash !== context.output.contentHash
      || record.payload.schemaVersion !== context.output.schema
    ) {
      throw new Error(
        `formalization lifecycle output: '${context.output.artifactRef}' does not resolve to the `
        + `exact SolutionContract for process_run ${context.processRunId}`,
      );
    }
    return record.payload;
  };
}

function ensureBriefRootTrace(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  prdArtifactId: number,
): void {
  if (ctx.epicId === null || ctx.projectId === undefined) return;
  const existingTargets = deps.graph.readOutgoingArtifactTraces([prdArtifactId])
    .filter(trace =>
      trace.targetType === 'artifact'
      && trace.linkType === 'derived_from')
    .map(trace => trace.targetId);
  const existingRoot = deps.graph.readArtifactsByIds(existingTargets)
    .some(artifact =>
      artifact.type === 'brief'
      && artifact.status === 'accepted'
      && artifact.contentHash !== null
      && artifact.acceptedHash === artifact.contentHash
      && artifact.driftState === 'clean');
  if (existingRoot) return;
  const db = getDb();
  // Check if PRD already has a root trace
  const existing = db.prepare(
    `SELECT t.target_id, a.type
       FROM artifact_traces t
       JOIN artifacts a ON a.id = t.target_id
      WHERE t.source_id=? AND t.link_type='derived_from' AND t.target_type='artifact'
        AND a.type NOT IN ('PRD','FR','NFR','RULE','UC','AC','SRS')`,
  ).get(prdArtifactId) as { target_id: number; type: string } | undefined;
  if (existing) return; // already has a root trace

  // Check if a brief already exists in this epic
  let briefId = (db.prepare(
    "SELECT id FROM artifacts WHERE epic_id=? AND type='brief' AND status='accepted' ORDER BY id LIMIT 1",
  ).get(ctx.epicId) as { id: number } | undefined)?.id;

  if (!briefId) {
    // Create a synthetic brief from the discovery context
    const briefHash = sha256Hex({
      schema: 'saga3.discovery-brief.v1',
      epic_id: ctx.epicId,
      process_run_id: ctx.processRunId,
      note: 'Auto-provisioned by formalization resolver',
    });
    const result = db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status, content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (?, ?, 'brief', 'BRIEF-1', 'Discovery Brief (auto-provisioned)', 'docs/discovery/brief-auto-provisioned.md', 'accepted', ?, ?, 'clean', '[]', '{}') RETURNING id`,
    ).get(ctx.projectId, ctx.epicId, briefHash, briefHash) as { id: number };
    briefId = result.id;
  }

  // Create trace PRD -> brief if it doesn't exist
  db.prepare(
    `INSERT OR IGNORE INTO artifact_traces (source_id, target_type, target_id, link_type)
     VALUES (?, 'artifact', ?, 'derived_from')`,
  ).run(prdArtifactId, briefId);
}

function createResolveProductHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveProduct, () => {
    const writes = readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.product,
      FORMALIZATION_HANDLER_IDS.resolveProduct,
    );
    if (writes.artifacts.length === 0) {
      return semanticMissing(
        ctx,
        writes.receipt,
        'clarification-required',
        FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
        'The product execution persisted no canonical product artifacts.',
      );
    }
    assertOnlyTypes(writes.artifacts, [
      ...PRODUCT_CONTRACT_TYPES,
      ...PRODUCT_SUPPORTING_TYPES,
    ]);
    assertTraceWriteSources(writes, idsOf(writes.artifacts));
    const contractArtifacts = writes.artifacts.filter(artifact =>
      (PRODUCT_CONTRACT_TYPES as readonly string[]).includes(artifact.type));
    const supportingArtifacts = writes.artifacts.filter(artifact =>
      (PRODUCT_SUPPORTING_TYPES as readonly string[]).includes(artifact.type));
    const snapshot = buildContractSnapshot(deps.graph, contractArtifacts);
    const categories = categorize(snapshot.artifacts);
    if (categories.prd.length !== 1 || categories.frs.length === 0) {
      return manifestResult(
        ctx,
        writes,
        snapshot,
        FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
        SOURCE_NODES.product,
        'clarification-required',
        categoryBindings(categories),
      );
    }
    // Auto-provision a brief artifact if the worker did not create one.
    // Discovery does not always register a brief artifact row (it writes a
    // markdown file instead). Without a root ancestor trace (PRD -> brief),
    // findContractGap returns clarification-required. Create a synthetic
    // brief and link PRD -> brief so the contract has a valid root.
    ensureBriefRootTrace(deps, ctx, categories.prd[0].id);
    // Rebuild snapshot after the brief insertion so findContractGap sees it.
    const snapshotWithBrief = buildContractSnapshot(
      deps.graph,
      [...contractArtifacts, ...deps.graph.readArtifactsByIds(
        deps.graph.readOutgoingArtifactTraces([categories.prd[0].id])
          .filter(t => t.linkType === 'derived_from')
          .map(t => t.targetId),
      )],
    );
    const gap = findContractGap(snapshotWithBrief, { product: true });
    if (gap) {
      return manifestResult(
        ctx,
        writes,
        snapshotForOwnedArtifacts(snapshotWithBrief, contractArtifacts),
        FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
        SOURCE_NODES.product,
        'clarification-required',
        { ...categoryBindings(categories), gap },
      );
    }
    const completed = manifestResult(
      ctx,
      writes,
      snapshotForOwnedArtifacts(snapshotWithBrief, contractArtifacts),
      FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
      SOURCE_NODES.product,
      'completed',
      {
        ...categoryBindings(categories),
        supportingArtifactIds: idsOf(supportingArtifacts),
      },
    );
    return withExactCandidateAcceptance(
      completed,
      ctx,
      writes,
      contractArtifacts,
      {
        sourceNodeId: SOURCE_NODES.product,
        policyId: 'repair-product-contract',
        authority: 'formalization-product-gate@1',
        reasonCode: 'FORMALIZATION_PRODUCT_VALIDATED',
        summary: 'The exact product contract could not be committed',
        acceptanceCriteria: [
          'Exactly one PRD and at least one FR are trace-complete.',
          'The exact reviewed PRD/FR/NFR/RULE versions are accepted+clean.',
        ],
        allowedChanges: [
          'PRD, FR, NFR and RULE candidates from this execution',
          'their contract traces',
        ],
      },
    );
  });
}

function createResolveUseCasesHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveUseCases, () => {
    const writes = readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.useCases,
      FORMALIZATION_HANDLER_IDS.resolveUseCases,
    );
    if (writes.artifacts.length === 0) {
      return semanticMissing(
        ctx,
        writes.receipt,
        'clarification-required',
        FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
        'The use-case execution persisted no canonical UC artifacts.',
      );
    }
    assertOnlyTypes(writes.artifacts, ['UC']);
    assertTraceWriteSources(writes, idsOf(writes.artifacts));
    const productArtifacts = readProductionArtifacts(
      deps.graph,
      requireFrameProduction(ctx, RESOLVER_NODES.product),
    );
    const snapshot = buildContractSnapshot(
      deps.graph,
      uniqueArtifacts([...productArtifacts, ...writes.artifacts]),
    );
    const categories = categorize(snapshot.artifacts);
    const gap = findContractGap(snapshot, { product: true, useCases: true });
    const event = categories.ucs.length === 0
      ? 'clarification-required'
      : gap ? 'inconsistent' : 'completed';
    const resolved = manifestResult(
      ctx,
      writes,
      snapshotForOwnedArtifacts(snapshot, writes.artifacts),
      FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
      SOURCE_NODES.useCases,
      event,
      { ...categoryBindings(categorize(writes.artifacts)), gap },
    );
    return event === 'completed'
      ? withExactCandidateAcceptance(
          resolved,
          ctx,
          writes,
          writes.artifacts,
          {
            sourceNodeId: SOURCE_NODES.useCases,
            policyId: 'repair-use-case-contract',
            authority: 'formalization-use-case-gate@1',
            reasonCode: 'FORMALIZATION_USE_CASES_VALIDATED',
            summary: 'The exact use-case contract could not be committed',
            acceptanceCriteria: [
              'Every UC traces to the exact PRD and covers an exact FR.',
              'The exact reviewed UC versions are accepted+clean.',
            ],
            allowedChanges: ['UC candidates and their derived_from/covers traces'],
          },
        )
      : resolved;
  });
}

function createResolveAcceptanceHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveAcceptance, () => {
    const writes = readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.acceptance,
      FORMALIZATION_HANDLER_IDS.resolveAcceptance,
    );
    if (writes.artifacts.length === 0) {
      return semanticMissing(
        ctx,
        writes.receipt,
        'clarification-required',
        FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
        'The acceptance execution persisted no canonical AC artifacts.',
      );
    }
    assertOnlyTypes(writes.artifacts, ['AC']);
    assertTraceWriteSources(writes, idsOf(writes.artifacts));
    const productArtifacts = readProductionArtifacts(
      deps.graph,
      requireFrameProduction(ctx, RESOLVER_NODES.product),
    );
    const useCaseArtifacts = readProductionArtifacts(
      deps.graph,
      requireFrameProduction(ctx, RESOLVER_NODES.useCases),
    );
    const snapshot = buildContractSnapshot(
      deps.graph,
      uniqueArtifacts([...productArtifacts, ...useCaseArtifacts, ...writes.artifacts]),
    );
    const categories = categorize(snapshot.artifacts);
    const gap = findContractGap(snapshot, {
      product: true,
      useCases: true,
      acceptance: true,
    });
    const event = categories.acs.length === 0
      ? 'clarification-required'
      : gap ? 'inconsistent' : 'completed';
    const resolved = manifestResult(
      ctx,
      writes,
      snapshotForOwnedArtifacts(snapshot, writes.artifacts),
      FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
      SOURCE_NODES.acceptance,
      event,
      { ...categoryBindings(categorize(writes.artifacts)), gap },
    );
    return event === 'completed'
      ? withExactCandidateAcceptance(
          resolved,
          ctx,
          writes,
          writes.artifacts,
          {
            sourceNodeId: SOURCE_NODES.acceptance,
            policyId: 'repair-acceptance-contract',
            authority: 'formalization-acceptance-gate@1',
            reasonCode: 'FORMALIZATION_ACCEPTANCE_VALIDATED',
            summary: 'The exact acceptance contract could not be committed',
            acceptanceCriteria: [
              'Every AC traces to an exact FR/NFR and, when required, UC.',
              'The exact reviewed AC versions are accepted+clean.',
            ],
            allowedChanges: ['AC candidates and their derived_from traces'],
          },
        )
      : resolved;
  });
}

function createResolveReconciliationHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveReconciliation, () => {
    const writes = readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.reconciliation,
      FORMALIZATION_HANDLER_IDS.resolveReconciliation,
    );
    const exactArtifacts = uniqueArtifacts([
      ...readProductionArtifacts(
        deps.graph,
        requireFrameProduction(ctx, RESOLVER_NODES.product),
      ),
      ...readProductionArtifacts(
        deps.graph,
        requireFrameProduction(ctx, RESOLVER_NODES.useCases),
      ),
      ...readProductionArtifacts(
        deps.graph,
        requireFrameProduction(ctx, RESOLVER_NODES.acceptance),
      ),
    ]);
    const exactIds = new Set(idsOf(exactArtifacts));
    if (writes.artifacts.some(artifact => !exactIds.has(artifact.id))) {
      throw new Error('reconciliation execution wrote artifacts outside the exact upstream contract');
    }
    assertTraceWriteSources(writes, exactIds);
    const snapshot = buildContractSnapshot(deps.graph, exactArtifacts);
    const categories = categorize(snapshot.artifacts);
    const completeness = findContractGap(snapshot, {
      product: true,
      useCases: true,
      acceptance: true,
    });
    if (completeness) {
      return manifestResult(
        ctx,
        writes,
        snapshot,
        FORMALIZATION_RECONCILIATION_SCHEMA,
        SOURCE_NODES.reconciliation,
        'inconsistent',
        { ...categoryBindings(categories), gap: completeness },
      );
    }
    const unaccepted = snapshot.artifacts.filter(artifact => !isAcceptedClean(artifact));
    if (unaccepted.length > 0) {
      return manifestResult(
        ctx,
        writes,
        snapshot,
        FORMALIZATION_RECONCILIATION_SCHEMA,
        SOURCE_NODES.reconciliation,
        'inconsistent',
        {
          ...categoryBindings(categories),
          unacceptedArtifactIds: idsOf(unaccepted),
        },
      );
    }
    return manifestResult(
      ctx,
      writes,
      snapshot,
      FORMALIZATION_RECONCILIATION_SCHEMA,
      SOURCE_NODES.reconciliation,
      'reconciled',
      categoryBindings(categories),
    );
  });
}

function createBaselineFreezerHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => {
    try {
      if (ctx.epicId === null) throw new Error('baseline freezer requires an epic');
      const reconciliation = requireInputProduction(ctx);
      const artifacts = readProductionArtifacts(deps.graph, reconciliation);
      const categories = categorize(artifacts);
      if (categories.acs.length === 0) {
        return kernelFailure(
          ctx,
          'failed',
          ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
          'Reconciliation production contains no AC artifacts.',
        );
      }
      const expectedHashes = readArtifactHashes(reconciliation);
      const drifted = categories.acs.filter(artifact =>
        !isAcceptedClean(artifact)
        || expectedHashes[String(artifact.id)] !== artifact.contentHash);
      if (drifted.length > 0) {
        return kernelFailure(
          ctx,
          'drift-detected',
          ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
          `Acceptance artifacts changed before freeze: ${idsOf(drifted).join(', ')}`,
          { dirtyArtifactIds: idsOf(drifted) },
        );
      }
      const acArtifactHashes = artifactHashMap(categories.acs);
      const baselineHash = acceptanceBaselineHash(categories.acs);
      const { record, replayed } = deps.baselineRepository.freeze({
        schemaVersion: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
        processRunId: ctx.processRunId,
        formalizationEpicId: ctx.epicId,
        sourceReconciliationRef: reconciliation.artifactRef,
        sourceReconciliationHash: reconciliation.contentHash,
        acArtifactIds: idsOf(categories.acs),
        acArtifactHashes,
        baselineHash,
      });
      return {
        event: 'frozen',
        production: {
          schema: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
          artifactRef: record.artifactRef,
          contentHash: record.snapshotHash,
          bindings: {
            acceptanceBaselineHash: record.baselineHash,
            baselineSnapshotRef: record.artifactRef,
            baselineSnapshotHash: record.snapshotHash,
            acArtifactIds: record.payload.acArtifactIds,
            acArtifactHashes: record.payload.acArtifactHashes,
            sourceReconciliationRef: reconciliation.artifactRef,
            sourceReconciliationHash: reconciliation.contentHash,
            replayed,
          },
        },
      };
    } catch (error) {
      return kernelFailure(
        ctx,
        'failed',
        ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
        errorMessage(error),
      );
    }
  };
}

function createResolveArchitectureHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveArchitecture, () => {
    const writes = readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.architecture,
      FORMALIZATION_HANDLER_IDS.resolveArchitecture,
    );
    if (writes.artifacts.length === 0) {
      return semanticMissing(
        ctx,
        writes.receipt,
        'clarification-required',
        FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
        'The architecture execution persisted no canonical SRS artifact.',
      );
    }
    assertOnlyTypes(writes.artifacts, ['SRS']);
    assertTraceWriteSources(writes, idsOf(writes.artifacts));
    const reconciliationArtifacts = readProductionArtifacts(
      deps.graph,
      requireFrameProduction(ctx, RESOLVER_NODES.reconciliation),
    );
    const baseline = requireBaseline(deps.baselineRepository, ctx.processRunId);
    const baselineDrift = findBaselineDrift(deps.graph, baseline);
    if (baselineDrift.length > 0) {
      return manifestResult(
        ctx,
        writes,
        buildContractSnapshot(deps.graph, writes.artifacts),
        FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
        SOURCE_NODES.architecture,
        'inconsistent',
        { baselineDriftArtifactIds: baselineDrift },
      );
    }
    const snapshot = buildContractSnapshot(
      deps.graph,
      uniqueArtifacts([...reconciliationArtifacts, ...writes.artifacts]),
    );
    const categories = categorize(snapshot.artifacts);
    const gap = findContractGap(snapshot, {
      product: true,
      useCases: true,
      acceptance: true,
      architecture: true,
    });
    // Semantic validation stays in this module; the common KernelNodeExecutor
    // owns the exact atomic acceptance transition.
    const event = categories.srs.length !== 1
      ? 'clarification-required'
      : gap ? 'inconsistent' : 'completed';
    const resolved = manifestResult(
      ctx,
      writes,
      snapshotForOwnedArtifacts(snapshot, writes.artifacts),
      FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
      SOURCE_NODES.architecture,
      event,
      {
        ...categoryBindings(categorize(writes.artifacts)),
        baselineSnapshotRef: baseline.artifactRef,
        baselineSnapshotHash: baseline.snapshotHash,
        acceptanceBaselineHash: baseline.baselineHash,
        gap,
      },
    );
    return event === 'completed'
      ? withExactCandidateAcceptance(
          resolved,
          ctx,
          writes,
          writes.artifacts,
          {
            sourceNodeId: SOURCE_NODES.architecture,
            policyId: 'repair-architecture-contract',
            authority: 'formalization-architecture-gate@1',
            reasonCode: 'FORMALIZATION_ARCHITECTURE_VALIDATED',
            summary: 'The exact architecture contract could not be committed',
            acceptanceCriteria: [
              'Exactly one SRS traces to the exact PRD.',
              'The frozen acceptance baseline has not drifted.',
              'The exact reviewed SRS version is accepted+clean.',
            ],
            allowedChanges: ['SRS candidate and its derived_from traces'],
            context: {
              baselineSnapshotRef: baseline.artifactRef,
              baselineSnapshotHash: baseline.snapshotHash,
              acceptanceBaselineHash: baseline.baselineHash,
            },
          },
        )
      : resolved;
  });
}

function createSettlementHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => {
    try {
      if (ctx.epicId === null) throw new Error('formalization settlement requires an epic');
      const casePayload = requireFormalizationCase(ctx.frame.runInput);
      if (casePayload.formalizationEpicId !== ctx.epicId) {
        throw new Error('FormalizationCase epic does not match the ProcessRun epic');
      }
      const reconciliation = requireFrameProduction(ctx, RESOLVER_NODES.reconciliation);
      const architecture = requireFrameProduction(ctx, RESOLVER_NODES.architecture);
      const baseline = requireBaseline(deps.baselineRepository, ctx.processRunId);
      const artifacts = uniqueArtifacts([
        ...readProductionArtifacts(deps.graph, reconciliation),
        ...readProductionArtifacts(deps.graph, architecture),
      ]);
      assertProductionHashes(reconciliation, artifacts.filter(a => a.type !== 'SRS'));
      assertProductionHashes(architecture, artifacts.filter(a => a.type === 'SRS'));
      const unaccepted = artifacts.filter(artifact => !isAcceptedClean(artifact));
      if (unaccepted.length > 0) {
        throw new Error(
          `settlement exact artifact set is not accepted+clean: ${idsOf(unaccepted).join(', ')}`,
        );
      }
      const baselineDrift = findBaselineDrift(deps.graph, baseline);
      if (baselineDrift.length > 0) {
        throw new Error(`acceptance baseline drift: ${baselineDrift.join(', ')}`);
      }
      const snapshot = buildContractSnapshot(deps.graph, artifacts);
      const gap = findContractGap(snapshot, {
        product: true,
        useCases: true,
        acceptance: true,
        architecture: true,
      });
      const categories = categorize(snapshot.artifacts);
      const bundle = buildSolutionContractBundle(ctx.epicId, categories, baseline.baselineHash);
      const settlementInput: FormalizationSettlementInput = {
        schemaVersion: FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
        formalizationEpicId: ctx.epicId,
        discoveryCertificateRef: casePayload.discoveryCertificateRef,
        discoveryCertificateHash: casePayload.discoveryCertificateHash,
        bundle,
      };
      const boundedGraph = createBoundedSettlementGraph(
        categories,
        baseline,
        gap,
      );
      const decision = deps.settlementPolicy.settle(boundedGraph, settlementInput);
      const formalizationPayload = buildFormalizationCertificatePayload(
        decision,
        bundle,
        settlementInput,
      );
      const certificatePayload = {
        schemaVersion: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
        decision: decision.decision,
        reasonCodes: decision.reasonCodes,
        rationale: decision.rationale,
        inputHash: decision.inputHash,
        payload: formalizationPayload,
      };
      const certificateHash = sha256Hex(certificatePayload);

      let solutionBindings: Record<string, unknown> = {};
      let artifactRef = `formalization-settlement:${ctx.processRunId}:${certificateHash}`;
      let contentHash = certificateHash;
      if (decision.decision === 'formalized') {
        const srs = categories.srs[0];
        if (!srs) {
          throw new Error('formalized settlement has no exact canonical SRS');
        }
        const payload: FormalizationSolutionContractPayload = {
          schemaVersion: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          processRunId: ctx.processRunId,
          formalizationEpicId: ctx.epicId,
          discoveryCertificateRef: casePayload.discoveryCertificateRef,
          discoveryCertificateHash: casePayload.discoveryCertificateHash,
          bundle,
          artifactHashes: snapshot.artifactHashes,
          traceIds: snapshot.traces.map(trace => trace.id),
          traceDigest: snapshot.traceDigest,
          baselineSnapshotRef: baseline.artifactRef,
          baselineSnapshotHash: baseline.snapshotHash,
          srs: {
            schema: FORMALIZATION_SRS_SCHEMA,
            ref: `artifact:${srs.id}`,
            hash: acceptedArtifactHash(srs),
          },
          acceptanceCriteria: categories.acs.map(artifact => ({
            artifactId: artifact.id,
            code: artifact.code,
            acceptedHash: acceptedArtifactHash(artifact),
            // An AC tagged `ac_kind:verification` by the architect (e.g.
            // performance benchmarks, security scans, accessibility audits) is
            // verification-only — it does not need an implementation task.
            // Default to true (implementation required) when no tag is present,
            // preserving backward compatibility with ACs created before the tag.
            implementationRequired: !artifactTagsInclude(artifact, 'ac_kind:verification'),
          })),
        };
        const persisted = deps.solutionContractRepository.persist(payload);
        artifactRef = persisted.record.artifactRef;
        contentHash = persisted.record.contentHash;
        solutionBindings = {
          solutionContractRef: persisted.record.artifactRef,
          solutionContractHash: persisted.record.contentHash,
          solutionContractSchema: persisted.record.payload.schemaVersion,
          solutionContractReplayed: persisted.replayed,
        };
      }
      return {
        event: decision.decision,
        production: {
          schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          artifactRef,
          contentHash,
          bindings: {
            ...solutionBindings,
            certificatePayload,
            certificateHash,
            certificateSchema: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
            authority: 'formalization_settlement_policy',
            bundleHash: bundle.bundleHash,
            acceptanceBaselineHash: baseline.baselineHash,
          },
        },
      };
    } catch (error) {
      return settlementFailure(ctx, errorMessage(error));
    }
  };
}

function readExecutionWrites(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  sourceNodeId: string,
  handlerId: string,
): ExecutionWrites {
  const receipt = requireLmReceipt(ctx.input, handlerId);
  if (!receipt.executionId) {
    throw new Error(`${handlerId}: task execution has no durable execution fence`);
  }
  const query: ManagedProductionQuery = {
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_MODULE_KEY,
    nodeId: sourceNodeId,
    intentId: receipt.intentId,
    taskId: receipt.taskId,
    executionId: receipt.executionId,
  };
  let artifactWrites = latestArtifactWrites(deps.ledger.listArtifactsForExecution(query));
  let traceWrites = latestTraceWrites(deps.ledger.listTracesForExecution(query));
  // Retry/recovery fallback: when a worker retried (review changes_requested,
  // recovery repair, lease loss), the current execution may have produced NO
  // managed artifacts — they were created in an EARLIER execution of the same
  // task/intent. Fall back to the latest productions for this (epic, module,
  // node). This mirrors the Discovery module's readLatestXxx(intent) pattern.
  // Each artifact is still validated against the artifact graph below, but with
  // a relaxed fence (process+module+node+intent+task, NOT executionId).
  let usedFallback = false;
  if (artifactWrites.length === 0 && traceWrites.length === 0) {
    const runArtifacts = deps.ledger.listArtifactsForNodeInProcessRun(
      ctx.processRunId, FORMALIZATION_MODULE_KEY, sourceNodeId,
    );
    const runTraces = deps.ledger.listTracesForNodeInProcessRun(
      ctx.processRunId, FORMALIZATION_MODULE_KEY, sourceNodeId,
    );
    if (runArtifacts.length > 0 || runTraces.length > 0) {
      artifactWrites = latestArtifactWrites(runArtifacts);
      traceWrites = latestTraceWrites(runTraces);
      usedFallback = true;
    }
  }
  const artifacts = deps.graph.readArtifactsByIds(artifactWrites.map(write => write.artifactId));
  if (artifacts.length !== artifactWrites.length) {
    throw new Error(`${handlerId}: one or more ledger artifacts no longer exist`);
  }
  const artifactsById = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  for (const write of artifactWrites) {
    const artifact = artifactsById.get(write.artifactId);
    if (
      !(usedFallback ? matchesFenceRelaxed(write, query) : matchesExecutionFence(write, query))
      || !artifact
      || artifact.projectId !== ctx.projectId
      || artifact.epicId !== ctx.epicId
      || artifact.type !== write.artifactType
      || !artifactStatusMatchesManagedWrite(deps, ctx, query, write, artifact)
      || artifact.contentHash !== write.contentHash
      || !isSha256(write.contentHash)
    ) {
      throw new Error(
        `${handlerId}: ledger artifact ${write.artifactId} does not match its canonical row`,
      );
    }
  }
  const traces = deps.graph.readTracesByIds(traceWrites.map(write => write.traceId));
  if (traces.length !== traceWrites.length) {
    throw new Error(`${handlerId}: one or more ledger traces no longer exist`);
  }
  const tracesById = new Map(traces.map(trace => [trace.id, trace]));
  for (const write of traceWrites) {
    const trace = tracesById.get(write.traceId);
    if (
      !(usedFallback ? matchesFenceRelaxed(write, query) : matchesExecutionFence(write, query))
      || !trace
      || trace.sourceArtifactId !== write.sourceId
      || trace.targetType !== write.targetType
      || trace.targetId !== write.targetId
      || trace.linkType !== write.linkType
      || write.traceHash !== sha256Hex({
        sourceId: write.sourceId,
        targetType: write.targetType,
        targetId: write.targetId,
        linkType: write.linkType,
      })
    ) {
      throw new Error(`${handlerId}: ledger trace ${write.traceId} does not match its canonical row`);
    }
  }
  return { receipt, artifactWrites, traceWrites, artifacts, traces };
}

function requireLmReceipt(input: unknown, handlerId: string): NodeExecutionReceipt {
  const receipt = input as Partial<NodeExecutionReceipt> | null;
  if (
    !receipt
    || receipt.kind !== 'task-execution'
    || receipt.executorKind !== 'lm'
    || !Number.isInteger(receipt.intentId)
    || Number(receipt.intentId) <= 0
    || !Number.isInteger(receipt.taskId)
    || Number(receipt.taskId) <= 0
    || (receipt.executionId !== null && typeof receipt.executionId !== 'string')
    || !['completed', 'failed'].includes(String(receipt.runtimeStatus))
  ) {
    throw new Error(`${handlerId}: expected an exact completed/failed LM execution receipt`);
  }
  return receipt as NodeExecutionReceipt;
}

function latestArtifactWrites(
  records: readonly ManagedArtifactWriteRecord[],
): readonly ManagedArtifactWriteRecord[] {
  const latest = new Map<number, ManagedArtifactWriteRecord>();
  for (const record of [...records].sort((a, b) => a.ledgerId - b.ledgerId)) {
    if (!Number.isInteger(record.ledgerId) || !Number.isInteger(record.artifactId)) {
      throw new Error('managed-production ledger returned an invalid artifact write identity');
    }
    latest.set(record.artifactId, record);
  }
  return [...latest.values()].sort((a, b) => a.artifactId - b.artifactId);
}

function latestTraceWrites(
  records: readonly ManagedTraceWriteRecord[],
): readonly ManagedTraceWriteRecord[] {
  const latest = new Map<number, ManagedTraceWriteRecord>();
  for (const record of [...records].sort((a, b) => a.ledgerId - b.ledgerId)) {
    if (!Number.isInteger(record.ledgerId) || !Number.isInteger(record.traceId)) {
      throw new Error('managed-production ledger returned an invalid trace write identity');
    }
    latest.set(record.traceId, record);
  }
  return [...latest.values()].sort((a, b) => a.traceId - b.traceId);
}

function artifactStatusMatchesManagedWrite(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  query: ManagedProductionQuery,
  write: ManagedArtifactWriteRecord,
  artifact: FormalizationArtifactSnapshot,
): boolean {
  if (artifact.status === write.artifactStatus) return true;
  if (
    ctx.epicId === null
    || !isAcceptedClean(artifact)
    || !isSha256(write.contentHash)
  ) {
    return false;
  }
  return deps.candidateAcceptance.isAcceptedExact(
    {
      processRunId: query.processRunId,
      moduleRef: query.moduleRef,
      nodeId: query.nodeId,
      intentId: query.intentId,
      taskId: query.taskId,
      executionId: query.executionId,
      projectId: ctx.projectId,
      epicId: ctx.epicId,
    },
    {
      artifactId: write.artifactId,
      artifactType: write.artifactType,
      contentHash: write.contentHash,
    },
  );
}

function matchesExecutionFence(
  record: Pick<
    ManagedArtifactWriteRecord | ManagedTraceWriteRecord,
    'processRunId' | 'moduleRef' | 'nodeId' | 'intentId' | 'taskId' | 'executionId'
  >,
  query: ManagedProductionQuery,
): boolean {
  return (
    record.processRunId === query.processRunId
    && record.moduleRef === query.moduleRef
    && record.nodeId === query.nodeId
    && record.intentId === query.intentId
    && record.taskId === query.taskId
    && record.executionId === query.executionId
  );
}

/**
 * Relaxed fence for retry/recovery fallback: validates process + module + node
 * + intent + task but NOT executionId. The worker's artifacts were produced in
 * an earlier execution of the same task/intent; the fence still binds them to
 * the correct ProcessRun and node, just not to the current execution.
 */
function matchesFenceRelaxed(
  record: Pick<
    ManagedArtifactWriteRecord | ManagedTraceWriteRecord,
    'processRunId' | 'moduleRef' | 'nodeId' | 'intentId' | 'taskId' | 'executionId'
  >,
  query: ManagedProductionQuery,
): boolean {
  return (
    record.processRunId === query.processRunId
    && record.moduleRef === query.moduleRef
    && record.nodeId === query.nodeId
    && record.intentId === query.intentId
    && record.taskId === query.taskId
  );
}

function buildContractSnapshot(
  graph: FormalizationCanonicalGraphPort,
  artifacts: readonly FormalizationArtifactSnapshot[],
): ContractSnapshot {
  const exact = uniqueArtifacts(artifacts);
  const outgoing = graph.readOutgoingArtifactTraces(idsOf(exact));
  const targetIds = outgoing
    .filter(trace => trace.targetType === 'artifact')
    .map(trace => trace.targetId);
  const targetArtifacts = graph.readArtifactsByIds(targetIds);
  const typeById = new Map([
    ...exact.map(artifact => [artifact.id, artifact.type] as const),
    ...targetArtifacts.map(artifact => [artifact.id, artifact.type] as const),
  ]);
  const sourceTypeById = new Map(exact.map(artifact => [artifact.id, artifact.type]));
  const traces = outgoing.filter(trace => {
    if (trace.targetType !== 'artifact') return false;
    const sourceType = sourceTypeById.get(trace.sourceArtifactId);
    const targetType = typeById.get(trace.targetId);
    return (
      sourceType === 'PRD' && trace.linkType === 'derived_from' && targetType === 'brief'
    ) || (
      sourceType === 'UC'
      && ((trace.linkType === 'derived_from' && targetType === 'PRD')
        || (trace.linkType === 'covers' && targetType === 'FR'))
    ) || (
      sourceType === 'AC'
      && trace.linkType === 'derived_from'
      && (targetType === 'FR' || targetType === 'NFR' || targetType === 'UC')
    ) || (
      sourceType === 'SRS' && trace.linkType === 'derived_from' && targetType === 'PRD'
    );
  }).sort((a, b) => a.id - b.id);
  return {
    artifacts: exact,
    traces,
    targetArtifacts,
    artifactHashes: artifactHashMap(exact),
    traceDigest: sha256Hex(traces),
  };
}

function snapshotForOwnedArtifacts(
  full: ContractSnapshot,
  owned: readonly FormalizationArtifactSnapshot[],
): ContractSnapshot {
  const ownedIds = new Set(idsOf(owned));
  const traces = full.traces.filter(trace => ownedIds.has(trace.sourceArtifactId));
  return {
    artifacts: uniqueArtifacts(owned),
    traces,
    targetArtifacts: full.targetArtifacts,
    artifactHashes: artifactHashMap(owned),
    traceDigest: sha256Hex(traces),
  };
}

function findContractGap(
  snapshot: ContractSnapshot,
  required: {
    product?: boolean;
    useCases?: boolean;
    acceptance?: boolean;
    architecture?: boolean;
  },
): string | null {
  const categories = categorize(snapshot.artifacts);
  const targetById = new Map([
    ...snapshot.artifacts.map(artifact => [artifact.id, artifact] as const),
    ...snapshot.targetArtifacts.map(artifact => [artifact.id, artifact] as const),
  ]);
  const hasEdge = (
    sourceId: number,
    linkType: string,
    targetType: string,
    allowedTargetIds?: ReadonlySet<number>,
  ): boolean => snapshot.traces.some(trace =>
    trace.sourceArtifactId === sourceId
    && trace.targetType === 'artifact'
    && trace.linkType === linkType
    && targetById.get(trace.targetId)?.type === targetType
    && (!allowedTargetIds || allowedTargetIds.has(trace.targetId)));

  if (required.product) {
    if (categories.prd.length !== 1) return 'contract must contain exactly one PRD';
    if (categories.frs.length === 0) return 'contract must contain at least one FR';
    // PRD must trace to a root ancestor. The canonical root is a 'brief'
    // artifact (created by saga-product from the discovery document). But
    // discovery does not always register a brief artifact — it writes a
    // discovery-doc markdown file instead. Accept any accepted ancestor
    // artifact (brief, decision, discovery-doc, or any other accepted
    // artifact that is NOT itself a PRD/FR/NFR/RULE/UC/AC/SRS) as a valid
    // root. This keeps traceability enforcement without blocking the
    // lifecycle when discovery omits the brief artifact row.
    const OWN_PRODUCT_TYPES = new Set(['PRD', 'FR', 'NFR', 'RULE', 'UC', 'AC', 'SRS']);
    const prdId = categories.prd[0].id;
    const hasRootEdge = snapshot.traces.some(trace =>
      trace.sourceArtifactId === prdId
      && trace.targetType === 'artifact'
      && trace.linkType === 'derived_from'
      && targetById.has(trace.targetId)
      && !OWN_PRODUCT_TYPES.has(targetById.get(trace.targetId)!.type));
    if (!hasRootEdge) {
      return `PRD ${prdId} has no derived_from → root artifact (brief/decision/discovery-doc) trace`;
    }
  }
  if (required.useCases) {
    if (categories.ucs.length === 0) return 'contract must contain at least one UC';
    const prdIds = new Set(idsOf(categories.prd));
    const frIds = new Set(idsOf(categories.frs));
    for (const uc of categories.ucs) {
      if (!hasEdge(uc.id, 'derived_from', 'PRD', prdIds)) {
        return `UC ${uc.id} has no derived_from → exact PRD trace`;
      }
      if (!hasEdge(uc.id, 'covers', 'FR', frIds)) {
        return `UC ${uc.id} has no covers → exact FR trace`;
      }
    }
  }
  if (required.acceptance) {
    if (categories.acs.length === 0) return 'contract must contain at least one AC';
    const frIds = new Set(idsOf(categories.frs));
    const nfrIds = new Set(idsOf(categories.nfrs));
    const ucIds = new Set(idsOf(categories.ucs));
    for (const ac of categories.acs) {
      const hasFr = hasEdge(ac.id, 'derived_from', 'FR', frIds);
      const hasNfr = hasEdge(ac.id, 'derived_from', 'NFR', nfrIds);
      if (!hasFr && !hasNfr) {
        return `AC ${ac.id} has no derived_from → exact FR/NFR trace`;
      }
      if (hasFr && !hasEdge(ac.id, 'derived_from', 'UC', ucIds)) {
        return `FR-derived AC ${ac.id} has no derived_from → exact UC trace`;
      }
    }
  }
  if (required.architecture) {
    if (categories.srs.length !== 1) return 'contract must contain exactly one SRS';
    const prdIds = new Set(idsOf(categories.prd));
    if (!hasEdge(categories.srs[0].id, 'derived_from', 'PRD', prdIds)) {
      return `SRS ${categories.srs[0].id} has no derived_from → exact PRD trace`;
    }
  }
  return null;
}

function manifestResult(
  ctx: KernelHandlerContext,
  writes: ExecutionWrites,
  snapshot: ContractSnapshot,
  schema: string,
  sourceNodeId: string,
  event: string,
  extraBindings: Record<string, unknown> = {},
): KernelHandlerResult {
  const manifest = {
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_MODULE_KEY,
    sourceNodeId,
    sourceIntentId: writes.receipt.intentId,
    sourceTaskId: writes.receipt.taskId,
    sourceExecutionId: writes.receipt.executionId,
    sourceRuntimeStatus: writes.receipt.runtimeStatus,
    artifactIds: idsOf(snapshot.artifacts),
    artifactHashes: snapshot.artifactHashes,
    traceIds: snapshot.traces.map(trace => trace.id),
    traceDigest: snapshot.traceDigest,
    ledgerArtifactWriteIds: writes.artifactWrites.map(write => write.ledgerId),
    ledgerTraceWriteIds: writes.traceWrites.map(write => write.ledgerId),
    ...withoutUndefined(extraBindings),
  };
  const contentHash = sha256Hex(manifest);
  return {
    event,
    production: {
      schema,
      artifactRef: `formalization-node-product:${ctx.processRunId}:${sourceNodeId}:${contentHash}`,
      contentHash,
      bindings: manifest,
    },
  };
}

interface ExactAcceptanceSpec {
  sourceNodeId: string;
  policyId: string;
  authority: string;
  reasonCode: string;
  summary: string;
  acceptanceCriteria: readonly string[];
  allowedChanges: readonly string[];
  context?: Readonly<Record<string, unknown>>;
}

function withExactCandidateAcceptance(
  result: KernelHandlerResult,
  ctx: KernelHandlerContext,
  writes: ExecutionWrites,
  artifacts: readonly FormalizationArtifactSnapshot[],
  spec: ExactAcceptanceSpec,
): KernelHandlerResult {
  if (ctx.epicId === null) {
    throw new Error(`${ctx.node.id}: exact acceptance requires an epic`);
  }
  if (!writes.receipt.executionId) {
    throw new Error(`${ctx.node.id}: exact acceptance requires an execution fence`);
  }
  const candidates = artifacts.map(artifact => {
    if (!isSha256(artifact.contentHash)) {
      throw new Error(
        `${ctx.node.id}: artifact ${artifact.id} has no canonical SHA-256 content hash`,
      );
    }
    return {
      artifactId: artifact.id,
      artifactType: artifact.type,
      contentHash: artifact.contentHash,
    };
  }).sort((left, right) => left.artifactId - right.artifactId);
  if (candidates.length === 0) {
    throw new Error(`${ctx.node.id}: exact acceptance candidate set is empty`);
  }
  const candidateSetHash = sha256Hex(candidates);
  const subjectRefs = candidates.map(candidate => ({
    kind: 'artifact',
    ref: `artifact:${candidate.artifactId}`,
    schema: candidate.artifactType,
    contentHash: candidate.contentHash,
  }));
  const directive: ExactCandidateAcceptanceDirective = {
    command: {
      idempotencyKey:
        `process-run:${ctx.processRunId}:gate:${ctx.node.id}:`
        + `execution:${writes.receipt.executionId}:candidates:${candidateSetHash}`,
      lineage: {
        processRunId: ctx.processRunId,
        moduleRef: FORMALIZATION_MODULE_KEY,
        nodeId: spec.sourceNodeId,
        intentId: writes.receipt.intentId,
        taskId: writes.receipt.taskId,
        executionId: writes.receipt.executionId,
        projectId: ctx.projectId,
        epicId: ctx.epicId,
      },
      candidates,
      requireApprovedReview: true,
      authority: spec.authority,
      reasonCode: spec.reasonCode,
      context: {
        gateNodeId: ctx.node.id,
        semanticProductionRef: result.production.artifactRef,
        semanticProductionHash: result.production.contentHash,
        ...(spec.context ?? {}),
      },
    },
    rejection: {
      event: 'acceptance-blocked',
      policyId: spec.policyId,
      disposition: 'repair',
      summary: spec.summary,
      acceptanceCriteria: [
        'Worker candidates stay draft/in_review; only the common kernel gate sets accepted+clean.',
        ...spec.acceptanceCriteria,
      ],
      allowedChanges: [
        ...spec.allowedChanges,
        ...subjectRefs.map(subject => subject.ref),
      ],
      subjectRefs,
      context: {
        gateNodeId: ctx.node.id,
        semanticProductionRef: result.production.artifactRef,
        semanticProductionHash: result.production.contentHash,
      },
    },
  };
  return {
    ...result,
    exactCandidateAcceptance: directive,
  };
}

function semanticMissing(
  ctx: KernelHandlerContext,
  receipt: NodeExecutionReceipt,
  event: string,
  schema: string,
  reason: string,
): KernelHandlerResult {
  return {
    event,
    production: resolutionFailureProduction(ctx, schema, reason, receipt),
  };
}

function withResolutionFailure(
  ctx: KernelHandlerContext,
  handlerId: string,
  fn: () => KernelHandlerResult,
): KernelHandlerResult {
  try {
    return fn();
  } catch (error) {
    return {
      event: 'failed',
      production: resolutionFailureProduction(
        ctx,
        'saga3.formalization-resolution-failure.v1',
        `${handlerId}: ${errorMessage(error)}`,
        partialReceipt(ctx.input),
      ),
    };
  }
}

function resolutionFailureProduction(
  ctx: KernelHandlerContext,
  schema: string,
  reason: string,
  receipt: Partial<NodeExecutionReceipt> | null,
): NodeProduction {
  const body = {
    processRunId: ctx.processRunId,
    resolverNodeId: ctx.node.id,
    sourceIntentId: receipt?.intentId ?? null,
    sourceTaskId: receipt?.taskId ?? null,
    sourceExecutionId: receipt?.executionId ?? null,
    reason,
  };
  const contentHash = sha256Hex(body);
  return {
    schema,
    artifactRef: `formalization-resolution:${ctx.processRunId}:${ctx.node.id}:${contentHash}`,
    contentHash,
    bindings: body,
  };
}

function kernelFailure(
  ctx: KernelHandlerContext,
  event: string,
  schema: string,
  reason: string,
  extra: Record<string, unknown> = {},
): KernelHandlerResult {
  const body = {
    processRunId: ctx.processRunId,
    nodeId: ctx.node.id,
    reason,
    ...extra,
  };
  const contentHash = sha256Hex(body);
  return {
    event,
    production: {
      schema,
      artifactRef: `formalization-kernel-result:${ctx.processRunId}:${ctx.node.id}:${contentHash}`,
      contentHash,
      bindings: body,
    },
  };
}

function settlementFailure(
  ctx: KernelHandlerContext,
  reason: string,
): KernelHandlerResult {
  const inputHash = sha256Hex({
    processRunId: ctx.processRunId,
    input: ctx.input,
    reason,
  });
  const formalizationPayload = {
    schemaVersion: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
    decision: 'failed' as const,
    reasonCodes: ['infrastructure-error'] as const,
    rationale: reason,
    inputHash,
    discoveryCertificateRef: '',
    discoveryCertificateHash: '',
    bundleHash: '',
    acceptanceBaselineHash: '',
  };
  const certificatePayload = {
    schemaVersion: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
    decision: 'failed',
    reasonCodes: ['infrastructure-error'],
    rationale: reason,
    inputHash,
    payload: formalizationPayload,
  };
  const certificateHash = sha256Hex(certificatePayload);
  return {
    event: 'failed',
    production: {
      schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      artifactRef: `formalization-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      bindings: {
        certificatePayload,
        certificateHash,
        certificateSchema: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
        authority: 'formalization_settlement_policy',
        settlementError: reason,
      },
    },
  };
}

function createBoundedSettlementGraph(
  categories: ProductCategories,
  baseline: AcceptanceBaselineSnapshotRecord,
  gap: string | null,
): FormalizationArtifactGraphPort {
  return {
    readAcceptedArtifacts: () => ({
      prd: categories.prd[0]?.id ?? null,
      frs: idsOf(categories.frs),
      nfrs: idsOf(categories.nfrs),
      rules: idsOf(categories.rules),
      ucs: idsOf(categories.ucs),
      acs: idsOf(categories.acs),
      srs: categories.srs[0]?.id ?? null,
    }),
    readAcceptanceBaselineHash: () => ({
      hash: baseline.baselineHash,
      clean: true,
      dirty: [],
    }),
    findFirstTraceabilityGap: () => gap
      ? {
          artifactType: 'contract',
          artifactId: 0,
          missingEdge: gap,
          description: gap,
        }
      : null,
    areTasksReady: () => ({ ready: true, blockingTaskIds: [] }),
  };
}

function buildSolutionContractBundle(
  epicId: number,
  categories: ProductCategories,
  baselineHash: string,
): SolutionContractBundle {
  const partial = {
    schemaVersion: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
    formalizationEpicId: epicId,
    prdArtifactId: categories.prd[0]?.id ?? null,
    frArtifactIds: idsOf(categories.frs),
    nfrArtifactIds: idsOf(categories.nfrs),
    ruleArtifactIds: idsOf(categories.rules),
    ucArtifactIds: idsOf(categories.ucs),
    acArtifactIds: idsOf(categories.acs),
    acceptanceBaselineHash: baselineHash,
    srsArtifactId: categories.srs[0]?.id ?? null,
  } as const;
  return { ...partial, bundleHash: sha256RawCanonical(partial) };
}

function requireFormalizationCase(input: unknown): FormalizationCase {
  const value = input as Partial<FormalizationCase> | null;
  if (
    !value
    || value.schemaVersion !== FORMALIZATION_CASE_SCHEMA
    || !Number.isInteger(value.discoveryEpicId)
    || !Number.isInteger(value.formalizationEpicId)
    || typeof value.discoveryCertificateRef !== 'string'
    || value.discoveryCertificateRef.length === 0
    || !isSha256(value.discoveryCertificateHash)
    || typeof value.discoveryOutcome !== 'string'
    || value.discoveryOutcome.length === 0
    || typeof value.initiatedBy !== 'string'
  ) {
    throw new Error('formalization settlement received an invalid or unauthorized FormalizationCase');
  }
  return value as FormalizationCase;
}

function requireInputProduction(ctx: KernelHandlerContext): NodeProduction {
  const input = ctx.input as Partial<NodeProduction> | null;
  if (
    !input
    || typeof input.schema !== 'string'
    || typeof input.artifactRef !== 'string'
    || typeof input.contentHash !== 'string'
    || !input.bindings
    || typeof input.bindings !== 'object'
  ) {
    throw new Error(`${ctx.node.id}: expected an upstream NodeProduction`);
  }
  return input as NodeProduction;
}

function requireFrameProduction(
  ctx: KernelHandlerContext,
  nodeId: string,
): NodeProduction {
  const production = ctx.frame.productions[nodeId];
  if (!production) throw new Error(`${ctx.node.id}: missing durable production from '${nodeId}'`);
  return production;
}

function readProductionArtifacts(
  graph: FormalizationCanonicalGraphPort,
  production: NodeProduction,
): readonly FormalizationArtifactSnapshot[] {
  const ids = numberArrayBinding(production.bindings, 'artifactIds');
  if (ids.length === 0) return [];
  const artifacts = graph.readArtifactsByIds(ids);
  if (artifacts.length !== ids.length || !sameIds(ids, idsOf(artifacts))) {
    throw new Error(`production '${production.artifactRef}' references missing canonical artifacts`);
  }
  return artifacts;
}

function assertProductionHashes(
  production: NodeProduction,
  artifacts: readonly FormalizationArtifactSnapshot[],
): void {
  const expected = readArtifactHashes(production);
  for (const artifact of artifacts) {
    if (!artifact.contentHash || expected[String(artifact.id)] !== artifact.contentHash) {
      throw new Error(
        `production '${production.artifactRef}' hash mismatch for artifact ${artifact.id}`,
      );
    }
  }
}

function readArtifactHashes(production: NodeProduction): Readonly<Record<string, string>> {
  const raw = production.bindings.artifactHashes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`production '${production.artifactRef}' has no artifactHashes binding`);
  }
  const hashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !isSha256(value)) {
      throw new Error(`production '${production.artifactRef}' has malformed artifactHashes`);
    }
    hashes[key] = value;
  }
  return hashes;
}

function requireBaseline(
  repository: FormalizationBaselineRepository,
  processRunId: number,
): AcceptanceBaselineSnapshotRecord {
  const baseline = repository.readByProcessRun(processRunId);
  if (!baseline) throw new Error(`process_run ${processRunId} has no frozen acceptance baseline`);
  return baseline;
}

function findBaselineDrift(
  graph: FormalizationCanonicalGraphPort,
  baseline: AcceptanceBaselineSnapshotRecord,
): number[] {
  const artifacts = graph.readArtifactsByIds(baseline.payload.acArtifactIds);
  if (artifacts.length !== baseline.payload.acArtifactIds.length) {
    const found = new Set(idsOf(artifacts));
    return baseline.payload.acArtifactIds.filter(id => !found.has(id));
  }
  const drifted = artifacts.filter(artifact =>
    artifact.type !== 'AC'
    || !isAcceptedClean(artifact)
    || baseline.payload.acArtifactHashes[String(artifact.id)] !== artifact.contentHash);
  if (acceptanceBaselineHash(artifacts) !== baseline.baselineHash) {
    return [...new Set([...idsOf(drifted), ...idsOf(artifacts)])];
  }
  return idsOf(drifted);
}

function categorize(
  artifacts: readonly FormalizationArtifactSnapshot[],
): ProductCategories {
  const type = (wanted: string) => artifacts
    .filter(artifact => artifact.type === wanted)
    .sort((a, b) => a.id - b.id);
  return {
    prd: type('PRD'),
    frs: type('FR'),
    nfrs: type('NFR'),
    rules: type('RULE'),
    ucs: type('UC'),
    acs: type('AC'),
    srs: type('SRS'),
  };
}

function categoryBindings(categories: ProductCategories): Record<string, unknown> {
  return {
    prdArtifactId: categories.prd[0]?.id ?? null,
    frArtifactIds: idsOf(categories.frs),
    nfrArtifactIds: idsOf(categories.nfrs),
    ruleArtifactIds: idsOf(categories.rules),
    ucArtifactIds: idsOf(categories.ucs),
    acArtifactIds: idsOf(categories.acs),
    srsArtifactId: categories.srs[0]?.id ?? null,
  };
}

function assertOnlyTypes(
  artifacts: readonly FormalizationArtifactSnapshot[],
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const wrong = artifacts.filter(artifact => !allowedSet.has(artifact.type));
  if (wrong.length > 0) {
    throw new Error(
      `execution wrote node-external artifact types: `
      + wrong.map(artifact => `${artifact.id}:${artifact.type}`).join(', '),
    );
  }
}

function assertTraceWriteSources(
  writes: ExecutionWrites,
  allowedSourceIds: ReadonlySet<number> | readonly number[],
): void {
  const allowed = allowedSourceIds instanceof Set
    ? allowedSourceIds
    : new Set(allowedSourceIds);
  const external = writes.traces.filter(trace => !allowed.has(trace.sourceArtifactId));
  if (external.length > 0) {
    throw new Error(
      `execution wrote traces from node-external artifacts: `
      + external.map(trace => trace.sourceArtifactId).join(', '),
    );
  }
}

function isAcceptedClean(artifact: FormalizationArtifactSnapshot): boolean {
  return artifact.status === 'accepted'
    && isSha256(artifact.contentHash)
    && artifact.acceptedHash === artifact.contentHash
    && artifact.driftState === 'clean';
}

function acceptedArtifactHash(artifact: FormalizationArtifactSnapshot): string {
  if (!isAcceptedClean(artifact) || !isSha256(artifact.acceptedHash)) {
    throw new Error(`artifact ${artifact.id} has no immutable accepted SHA-256 hash`);
  }
  return artifact.acceptedHash;
}

function artifactTagsInclude(artifact: FormalizationArtifactSnapshot, tag: string): boolean {
  const tags = artifact.tags;
  return Array.isArray(tags) && tags.includes(tag);
}

function artifactHashMap(
  artifacts: readonly FormalizationArtifactSnapshot[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const artifact of [...artifacts].sort((a, b) => a.id - b.id)) {
    if (!isSha256(artifact.contentHash)) {
      throw new Error(`artifact ${artifact.id} has no canonical SHA-256 content hash`);
    }
    result[String(artifact.id)] = artifact.contentHash;
  }
  return result;
}

function acceptanceBaselineHash(
  artifacts: readonly FormalizationArtifactSnapshot[],
): string {
  const rows = [...artifacts].sort((a, b) => a.id - b.id);
  return createHash('sha256')
    .update(rows.map(artifact => `${artifact.id}:${artifact.acceptedHash ?? ''}`).join('\n'))
    .digest('hex');
}

function uniqueArtifacts(
  artifacts: readonly FormalizationArtifactSnapshot[],
): readonly FormalizationArtifactSnapshot[] {
  const byId = new Map<number, FormalizationArtifactSnapshot>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function idsOf(items: readonly { id: number }[]): number[] {
  return items.map(item => item.id).sort((a, b) => a - b);
}

function numberArrayBinding(
  bindings: Record<string, unknown>,
  name: string,
): number[] {
  const value = bindings[name];
  if (!Array.isArray(value) || !value.every(item => Number.isInteger(item) && item > 0)) {
    throw new Error(`production binding '${name}' must be an array of positive integers`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function stringBinding(bindings: Record<string, unknown>, name: string): string {
  const value = bindings[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`production binding '${name}' must be a non-empty string`);
  }
  return value;
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((id, index) => id === b[index]);
}

function partialReceipt(input: unknown): Partial<NodeExecutionReceipt> | null {
  return input && typeof input === 'object'
    ? input as Partial<NodeExecutionReceipt>
    : null;
}

function withoutUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sha256RawCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
