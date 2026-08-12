import { createHash } from 'node:crypto';
// CONVEYOR Wave 7 — Isolate modules behind ports: the brief-provisioning
// substrate touch is delegated to an injected BriefProvisioningPort (wired by
// the composition root), so this module imports no getDb / db.ts.
import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
// Wave 4 (Uncle Bob): the formalization settlement kernel now issues its own
// ProcessOutcomeCertificate and emits an explicit ModuleCompletion whose
// outputEnvelope.certificateRef points at the issued row. This replaces the
// certificateRepo.issue (generic-flow-executor.ts:363-390). Type-only imports
// from the Wave 1 pure-SPI layer — application→domain is allowed; no runtime
// edge. The magic bindings are KEPT alongside (additive) until Wave 5 deletes
// that branch.
import type {
  ModuleCompletion,
} from '../../../process-modules/domain/spi/module-completion.js';
import type {
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/production-envelope.js';
import type {
  ProcessOutcomeCertificateRepository,
} from '../../../process-modules/persistence/process-outcome-certificate-repository.js';
import {
  type ExactCandidateAcceptance,
  type ExactCandidateAcceptanceDirective,
} from '../../../process-modules/application/exact-candidate-acceptance.js';
import {
  withKernelRecoveryIssue,
  type KernelRecoveryIssueSpec,
} from '../../../process-modules/application/kernel-recovery-issue.js';
import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../../process-modules/application/kernel-handler-registry.js';
import type {
  NodeExecutionReceipt,
  NodeExecutionResult,
  NodeProduction,
} from '../../../process-modules/application/node-executor.js';
import type {
  ProcessModuleExecutionContext,
} from '../../../process-modules/application/process-module-executor.js';
import type {
  ProcessOutputPayloadResolver,
} from '../../../process-modules/application/lifecycle-orchestrator.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';
import type {
  BriefProvisioningPort,
  FormalizationArtifactGraphPort,
  FormalizationArtifactSnapshot,
  FormalizationCanonicalGraphPort,
  FormalizationManagedProductionLedger,
  FormalizationSettlementPolicyPort,
  FormalizationTraceSnapshot,
  ManagedArtifactWriteRecord,
  ManagedProductionQuery,
  ManagedTraceWriteRecord,
} from '../domain/formalization-kernel-ports.js';
import { buildFormalizationCertificatePayload } from '../domain/formalization-kernel-ports.js';
import type { WorkplaceRef } from '../../../process-modules/domain/workplace/workplace-ref.js';
import type { CheckProvider, CheckReceipt, GateDecision } from '../../../process-modules/domain/workplace/gate.js';
import { driveGateRun } from '../../../process-modules/application/gate-run-driver.js';
import { buildArchitectureCheckPlan } from './architecture-check-plan.js';
import type {
  AcceptanceBaselineSnapshotRecord,
  FormalizationBaselineRepository,
  FormalizationSolutionContractRepository,
} from '../domain/formalization-persistence-contracts.js';
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
} from '../domain/formalization-schemas.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../domain/formalization-schemas.js';
import { assembleRevision, buildContribution } from '../../../process-modules/domain/workplace/workplace-production-revision.js';

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
  /**
   * Wave 7 — Isolate modules behind ports. Provisions the PRD root-ancestor
   * (brief) trace without the module touching `db.ts`. Required: the composition
   * root wires a concrete SQLite-backed adapter.
   */
  briefProvisioning: BriefProvisioningPort;
  /**
   * Wave 4 (Uncle Bob) — the settlement kernel now issues the
   * ProcessOutcomeCertificate ITSELF and emits an explicit ModuleCompletion
   * whose outputEnvelope.certificateRef points at the issued row. This replaces
   * certificateRepo.issue (generic-flow-executor.ts:377). The magic bindings
   * are KEPT alongside (additive) until Wave 5 deletes that branch.
   */
  certificateRepo: ProcessOutcomeCertificateRepository;
  /**
   * Production Cell: CandidateSet repository port. When non-null, the
   * architecture handler seals a CandidateSet from the worker's produced SRS
   * before driving a GateRun. When null (tests, unmigrated path), the handler
   * falls back to ExactCandidateAcceptance only.
   *
   * Defined as a structural port (not the concrete SqliteCandidateSetRepository
   * type) to keep the module driver-neutral — the composition root injects the
   * concrete SQLite adapter.
   */
  candidateSetRepo: CandidateSetSealPort | null;
  /**
   * Production Cell: Gate repository port. When non-null, the architecture
   * handler drives a GateRun (createGateRun → recordCheckReceipt →
   * recordDecision). When null, the handler falls back to
   * ExactCandidateAcceptance only.
   */
  gateRepo: GateRunPort | null;
  /**
   * Production Cell: CheckProvider registry. Resolves providerId → CheckProvider
   * instance. When non-null, the architecture handler uses the GateRun driver
   * to run structural checks. When null, falls back to ExactCandidateAcceptance.
   */
  checkProviderRegistry: CheckProviderResolverPort | null;
  /**
   * Production Cell: SRS content reader. Reads the SRS document content from
   * disk for the structural CheckProvider. Injected (driver-neutral) so the
   * module doesn't touch the filesystem directly.
   */
  srsContentReader: { readSrsContent(artifactRef: string): string | null } | null;
}

/**
 * Minimal port for resolving a CheckProvider by providerId. Satisfied by a
 * simple Map-based registry wired at the composition root.
 */
export interface CheckProviderResolverPort {
  resolve(providerId: string): CheckProvider | null;
}

/**
 * Minimal port for sealing a CandidateSet. The concrete
 * SqliteCandidateSetRepository satisfies this; the module never imports the
 * concrete type.
 */
export interface CandidateSetSealPort {
  seal(input: {
    readonly workplaceRef: WorkplaceRef;
    readonly producerExecutionRef: string;
    readonly productionRevisionRef: string;
    readonly role: 'author' | 'reviewer';
    readonly subjectCandidateSetRef: string | null;
    readonly members: ReadonlyArray<{
      readonly productRef: { readonly schemaId: string; readonly ref: string; readonly digest: string };
      readonly origin: 'produced' | 'carried-forward';
      readonly sourceCandidateSetRef: string | null;
    }>;
    readonly candidateSetDigest: string;
    readonly sealReceiptRef: string;
    readonly sealedAt: string;
  }): { readonly set: { readonly candidateSetRef: string }; readonly replayed: boolean };
}

/**
 * Minimal port for driving a GateRun. The concrete SqliteGateRepository
 * satisfies this; the module never imports the concrete type. Uses the real
 * domain types (GateRun, CheckReceipt, GateDecision) from the workplace
 * domain to avoid structural drift.
 */
export interface GateRunPort {
  createGateRun(input: {
    readonly gateRunRef: string;
    readonly workplaceRef: WorkplaceRef;
    readonly gatePhase: 'author' | 'final';
    readonly subjectCandidateSetRef: string;
    readonly assessmentCandidateSetRefs: readonly string[];
    readonly checkPlanRef: string;
    readonly checkPlanDigest: string;
    readonly expectedWorkplaceRevision: number;
    readonly gateLeaseRef: string;
  }): unknown;
  setGateRunState(gateRunRef: string, state: 'claimed' | 'checking' | 'decided' | 'terminal'): void;
  recordCheckReceipt(input: Omit<CheckReceipt, 'checkReceiptRef'> & { readonly checkReceiptRef: string }): CheckReceipt;
  recordDecision(decision: GateDecision): { readonly decision: GateDecision; readonly replayed: boolean };
}

interface ExecutionWrites {
  receipt: NodeExecutionReceipt;
  artifactWrites: readonly ManagedArtifactWriteRecord[];
  traceWrites: readonly ManagedTraceWriteRecord[];
  artifacts: readonly FormalizationArtifactSnapshot[];
  traces: readonly FormalizationTraceSnapshot[];
}

export interface ContractSnapshot {
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
    requiredTools: ['trace_add', 'trace_delete', 'artifact_create', 'artifact_update'],
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
  // Dependency-clean pre-check via the graph port: if the PRD already has an
  // accepted brief ancestor, no provisioning is needed.
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
  // Wave 7 — Isolate modules behind ports. The substrate touch (find/create the
  // brief + attach the derived_from trace) is delegated to the injected
  // BriefProvisioningPort. The composition root wires a concrete SQLite adapter;
  // the module never touches db.ts.
  deps.briefProvisioning.ensureBriefRoot({
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    processRunId: ctx.processRunId,
    prdArtifactId,
  });
}

function createResolveProductHandler(deps: FormalizationInstallationDeps): KernelHandler {
  return ctx => withResolutionFailure(ctx, FORMALIZATION_HANDLER_IDS.resolveProduct, () => {
    const writes = selectActiveExecutionWrites(readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.product,
      FORMALIZATION_HANDLER_IDS.resolveProduct,
    ));
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
    const writes = selectActiveExecutionWrites(readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.useCases,
      FORMALIZATION_HANDLER_IDS.resolveUseCases,
    ));
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
    const writes = selectActiveExecutionWrites(readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.acceptance,
      FORMALIZATION_HANDLER_IDS.resolveAcceptance,
    ));
    if (writes.artifacts.length === 0) {
      // CGAD P18: readExecutionWrites already queries the DURABLE node-scope
      // (all managed AC writes for this process+node, across every task). An
      // empty result therefore means no AC has ever been produced for this
      // node — not a recovery-task blinding. The feedback is honest: the model
      // must author the acceptance contract.
      return semanticMissing(
        ctx,
        writes.receipt,
        'clarification-required',
        FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
        'No acceptance-contract (AC) artifacts have been produced for this node across any task; author the AC contract.',
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
    const writes = selectActiveExecutionWrites(readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.reconciliation,
      FORMALIZATION_HANDLER_IDS.resolveReconciliation,
    ));
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
      // Cross-run semantic digest (CONVEYOR v4.3 §5-6). The downstream SRS cell
      // uses this (falling back to contentHash only if absent) to derive its
      // ReplayKey. contentHash/snapshotHash carries run-specific provenance
      // (processRunId, artifact IDs, reconciliation ref), so without an explicit
      // semanticDigest the SRS ReplayKey would change across runs even for
      // identical AC content — defeating replay. This digest is computed from
      // stable AC codes + accepted hashes only: no DB row IDs, no processRunId,
      // no refs, no timestamps.
      const semanticDigest = acceptanceBaselineSemanticDigest(categories.acs);
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
          semanticDigest,
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
    const writes = selectActiveExecutionWrites(readExecutionWrites(
      deps,
      ctx,
      SOURCE_NODES.architecture,
      FORMALIZATION_HANDLER_IDS.resolveArchitecture,
    ));
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
      ? (() => {
          // Production Cell: seal a CandidateSet from the worker's produced
          // SRS artifact, then drive a GateRun with the structural check
          // provider. When the gate infrastructure is wired (deps present),
          // the GateDecision is authoritative. When not wired (tests, early
          // boot), falls back to ExactCandidateAcceptance.
          // Production Cell bridge: seal + gate. Wrapped in try/catch — if the
          // bridge fails (e.g. workplace not materialized, FK constraint), the
          // bridge is skipped and ExactCandidateAcceptance runs alone. The
          // bridge is additive; it must NEVER break the existing acceptance path.
          let candidateSetRef: string | null = null;
          try {
            candidateSetRef = sealArchitectureCandidateSet(deps, ctx, writes);
          } catch {
            candidateSetRef = null;
          }
          const gateDecision = candidateSetRef
            ? runArchitectureGate(deps, ctx, writes, candidateSetRef)
            : null;
          if (gateDecision) {
            // GateDecision is authoritative. Map it to the handler result.
            if (gateDecision.verdict === 'accepted') {
              // Gate accepted — proceed with ExactCandidateAcceptance to
              // perform the artifact CAS (bridge: both run; Stage 5 will
              // remove ExactCandidateAcceptance and let the GateDecision
              // drive the artifact CAS directly).
              return withExactCandidateAcceptance(
                resolved, ctx, writes, writes.artifacts, {
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
                    gateDecisionKey: gateDecision.decisionKey,
                  },
                },
              );
            } else {
              // Gate rejected — return a repair event with the gate's
              // recovery issue.
              return manifestResult(
                ctx, writes,
                snapshotForOwnedArtifacts(snapshot, writes.artifacts),
                FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
                SOURCE_NODES.architecture,
                'inconsistent',
                {
                  ...categoryBindings(categorize(writes.artifacts)),
                  baselineSnapshotRef: baseline.artifactRef,
                  gateVerdict: gateDecision.verdict,
                  gateDecisionKey: gateDecision.decisionKey,
                  gateReceipts: gateDecision.checkReceiptRefs,
                  gap: `Gate verdict: ${gateDecision.verdict}`,
                },
              );
            }
          }
          // Gate infrastructure not wired — fallback to ExactCandidateAcceptance.
          return withExactCandidateAcceptance(
            resolved, ctx, writes, writes.artifacts, {
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
          );
        })()
      : resolved;
  });
}

/**
 * Production Cell bridge (Stage 1): seal a CandidateSet from the architecture
 * worker's produced SRS artifact.
 *
 * The CandidateSet captures the EXACT immutable product the worker produced
 * (the SRS artifact id + content hash). It is sealed via the CandidateSet
 * repository and persisted. In bridge mode, this does NOT replace
 * ExactCandidateAcceptance — both run in parallel. Stage 3 will switch the
 * acceptance decision from ExactCandidateAcceptance to the GateDecision that
 * the GateRun produces from this CandidateSet.
 *
 * Feature-detect: if candidateSetRepo is null (tests, unmigrated module),
 * this is a no-op — the handler falls back to ExactCandidateAcceptance only.
 */
function sealArchitectureCandidateSet(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  writes: ExecutionWrites,
): string | null {
  if (!deps.candidateSetRepo) return null;
  if (!writes.receipt.executionId) return null;
  // Build the CandidateSet members from the worker's produced SRS artifacts.
  // Each artifact is a 'produced' member (originated from this execution).
  const members = writes.artifacts
    .filter((artifact): artifact is typeof artifact & { contentHash: string } =>
      isSha256(artifact.contentHash))
    .map(artifact => ({
      productRef: {
        schemaId: artifact.type,
        ref: `artifact:${artifact.id}`,
        digest: artifact.contentHash,
      },
      origin: 'produced' as const,
      sourceCandidateSetRef: null,
    }));
  if (members.length === 0) return null;
  // Compute a deterministic digest over the member set.
  const candidateSetDigest = sha256Hex(members);
  // Build the WorkplaceRef. The architecture cell's workplace is identified
  // by (processRunId, moduleRef, productionCellId, workKey). The
  // productionCellId for the architecture node is its node id.
  const workplaceRef: WorkplaceRef = {
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_MODULE_KEY,
    productionCellId: SOURCE_NODES.architecture,
    workKey: 'default',
  };
  const sealReceiptRef = `execution-complete:${writes.receipt.executionId}`;
  // ADR-053: assemble a revision from the artifacts to carry productionRevisionRef.
  const workplaceSerialized = `${workplaceRef.processRunId}/${workplaceRef.moduleRef}/${workplaceRef.productionCellId}/${workplaceRef.workKey}`;
  const revisionContribution = buildContribution({
    workplaceRef: `workplace/${workplaceSerialized}`,
    contributorExecutionRef: writes.receipt.executionId,
    sourceAdapter: 'managed-artifact',
    operations: members.map(m => ({
      op: 'put' as const,
      memberKey: `product/${m.productRef.schemaId}/${m.productRef.ref}`,
      productRef: m.productRef.ref,
      contentDigest: m.productRef.digest,
      sourceAdapter: 'managed-artifact' as const,
    })),
    parentContributionRef: null,
  });
  const revision = assembleRevision({
    workplaceRef: `workplace/${workplaceSerialized}`,
    parent: null,
    contributions: [revisionContribution],
    presenterRef: writes.receipt.executionId,
  });
  const result = deps.candidateSetRepo.seal({
    workplaceRef,
    producerExecutionRef: writes.receipt.executionId,
    productionRevisionRef: revision.revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members,
    candidateSetDigest,
    sealReceiptRef,
    sealedAt: new Date().toISOString(),
  });
  return result.set.candidateSetRef;
}

/**
 * Production Cell Stage 3: drive a GateRun for the architecture CandidateSet.
 *
 * After sealing the CandidateSet, this function drives the full gate lifecycle:
 * createGateRun → run SRS structural check → recordCheckReceipt →
 * recordDecision. The GateDecision is returned to the handler, which uses it
 * as the authoritative acceptance verdict.
 *
 * Feature-detect: if gateRepo or checkProviderRegistry is null, returns null
 * (handler falls back to ExactCandidateAcceptance).
 */
function runArchitectureGate(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  writes: ExecutionWrites,
  candidateSetRef: string,
): { verdict: string; decisionKey: string; checkReceiptRefs: readonly string[] } | null {
  if (!deps.gateRepo || !deps.checkProviderRegistry || !deps.srsContentReader) {
    return null;
  }
  // Build the CheckPlan (immutable, content-addressed).
  const checkPlan = buildArchitectureCheckPlan();
  // The SRS artifact ref is passed as a check parameter.
  const srsArtifact = writes.artifacts.find(a => a.type === 'SRS');
  if (!srsArtifact) return null;
  const srsArtifactRef = `artifact:${srsArtifact.id}`;
  // Build the WorkplaceRef for the gate.
  const workplaceRef: WorkplaceRef = {
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_MODULE_KEY,
    productionCellId: SOURCE_NODES.architecture,
    workKey: 'default',
  };
  // Read the current workplace revision for the expected revision check.
  // The workplace should be in 'verifying' state at this point.
  // For the bridge, we use revision 1 (the materialized initial revision);
  // a future ConveyorRuntime.applyGateDecision will CAS on the actual revision.
  const expectedWorkplaceRevision = 1;
  const gateLeaseRef = `gate-lease:${writes.receipt.executionId}`;
  const installationDigest = sha256Hex(FORMALIZATION_MODULE_KEY);
  const result = driveGateRun(
    deps.gateRepo,
    deps.checkProviderRegistry,
    {
      workplaceRef,
      subjectCandidateSetRef: candidateSetRef,
      checkPlan,
      gatePhase: 'author',
      expectedWorkplaceRevision,
      gateLeaseRef,
      installationDigest,
      checkParameters: { srsArtifactRef },
      environmentRef: null,
    },
  );
  return {
    verdict: result.decision.verdict,
    decisionKey: result.decision.decisionKey,
    checkReceiptRefs: result.decision.checkReceiptRefs,
  };
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
            criterionId: Number.parseInt(acceptedArtifactHash(artifact).slice(0, 12), 16),
            artifactId: artifact.id,
            code: artifact.code,
            acceptedHash: acceptedArtifactHash(artifact),
            // An AC tagged `ac_kind:verification` by the architect (e.g.
            // performance benchmarks, security scans, accessibility audits) is
            // verification-only — it does not need an implementation task.
            // Default to true (implementation required) when no tag is present,
            // preserving backward compatibility with ACs created before the tag.
            implementationRequired: !artifactTagsInclude(artifact, 'ac_kind:verification'),
            // Criticality: read from AC tags (criticality:blocker |
            // criticality:degradable | criticality:nice_to_have). The architect
            // tags ACs from SRS §D2. Default 'blocker' (conservative) when no
            // tag is present — treat as mandatory until Integration Readiness
            // policy explicitly allows degradation.
            criticality: readCriticalityFromTags(artifact),
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
      // Wave 4 (Uncle Bob): issue the ProcessOutcomeCertificate IN THE KERNEL
      // so the explicit ModuleCompletion can carry a content-addressed
      // certificateRef. The SolutionContract-bearing production above is
      // unchanged and stays the module `output` (resolved via resolveOutput /
      // the lifecycle output payload resolver); the certificate completion is
      // (certificatePayload / certificateHash / certificateSchema) are removed
      // from `production.bindings` — the completion envelope is the sole
      // certificate channel. `solutionBindings` (solutionContractRef etc.),
      // `authority`, `bundleHash` and `acceptanceBaselineHash` are non-
      // certificate bindings and are retained.
      const issuedCertificate = issueFormalizationCertificate(
        deps,
        ctx,
        certificatePayload,
        certificateHash,
      );
      return {
        event: decision.decision,
        production: {
          schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          artifactRef,
          contentHash,
          bindings: {
            ...solutionBindings,
            authority: 'formalization_settlement_policy',
            bundleHash: bundle.bundleHash,
            acceptanceBaselineHash: baseline.baselineHash,
          },
        },
        completion: buildFormalizationModuleCompletion(
          decision.decision,
          certificatePayload,
          certificateHash,
          issuedCertificate,
        ),
      };
    } catch (error) {
      return settlementFailure(deps, ctx, errorMessage(error));
    }
  };
}

function readExecutionWrites(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  sourceNodeId: string,
  handlerId: string,
): ExecutionWrites {
  // On recovery resume, ctx.input may be a feedbackProduction (recovery
  // feedback) instead of an LM execution receipt. The durable receipt is
  // available in ctx.frame.productions (the LM node's production restored
  // from node_run output_bindings). Try ctx.input first (normal path), then
  // fall back to the frame production for the source node.
  let receipt = tryLmReceipt(ctx.input, handlerId);
  if (!receipt) {
    // On recovery resume, ctx.input may be feedbackProduction. The durable
    // LM receipt is in ctx.frame.receipts (restored from node_run
    // execution_receipt by restoreNodeResult → frame.receipts[nodeId]).
    receipt = tryLmReceipt(ctx.frame.receipts?.[sourceNodeId], handlerId)
      ?? tryLmReceipt(ctx.frame.productions?.[sourceNodeId], handlerId)
      ?? null;
  }
  if (!receipt) {
    throw new Error(`${handlerId}: expected an exact completed/failed LM execution receipt (checked ctx.input and frame.productions.${sourceNodeId})`);
  }
  if (!receipt.executionId) {
    throw new Error(`${handlerId}: task execution has no durable execution fence`);
  }
  // CGAD P18 — Node-Durable Identity. The workplace (node) is the primary
  // durable entity; the card (task) belongs to the workplace and a repair round
  // task). The gate reads managed productions by DURABLE node-scope
  // (processRunId + moduleRef + nodeId), which is robust whether or not a future
  // change reintroduces per-attempt tasks — it can never be blinded to the
  // workplace's prior work. The receipt's task/intent/execution are kept in
  // `query` only as durability fences (proof the worker executed) and for CAS
  // lineage — never as SQL filters.
  const query: ManagedProductionQuery = {
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_MODULE_KEY,
    nodeId: sourceNodeId,
    intentId: receipt.intentId,
    taskId: receipt.taskId,
    executionId: receipt.executionId,
  };
  const processRunArtifactWrites = deps.ledger.listArtifactsForNodeInProcessRun(
    ctx.processRunId, FORMALIZATION_MODULE_KEY, sourceNodeId,
  );
  const processRunTraceWrites = deps.ledger.listTracesForNodeInProcessRun(
    ctx.processRunId, FORMALIZATION_MODULE_KEY, sourceNodeId,
  );
  // Recovery fallback: if this process-run has NO ledger entries for this node
  // (repair worker reused accepted artifacts from a prior run), borrow canonical
  // writes from the epic-wide node scope. The borrowed writes carry a different
  // processRunId, so matchesNodeFence (which checks processRunId) is skipped for
  // them — the artifacts themselves are epic-scoped, immutable, and hash-verified.
  const borrowedFromEpic = processRunArtifactWrites.length === 0;
  const artifactWrites = latestArtifactWrites(
    borrowedFromEpic
      ? deps.ledger.listArtifactsForNodeInEpic(
          ctx.projectId, ctx.epicId!, FORMALIZATION_MODULE_KEY, sourceNodeId,
        )
      : processRunArtifactWrites,
  );
  const traceWrites = latestTraceWrites(
    processRunTraceWrites.length === 0
      ? deps.ledger.listTracesForNodeInEpic(
          ctx.projectId, ctx.epicId!, FORMALIZATION_MODULE_KEY, sourceNodeId,
        )
      : processRunTraceWrites,
  );
  const artifacts = deps.graph.readArtifactsByIds(artifactWrites.map(write => write.artifactId));
  // When borrowing from epic-scope (recovery fallback), some ledger writes may
  // SQL operations before the immutability contract was enforced). Filter
  // those dangling writes instead of crashing — the surviving canonical
  // artifacts are sufficient for the gate to verify. For the normal path
  // (current process-run), keep the strict check: a missing artifact IS a
  // real error.
  if (!borrowedFromEpic && artifacts.length !== artifactWrites.length) {
    throw new Error(`${handlerId}: one or more ledger artifacts no longer exist`);
  }
  const artifactsById = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  // Filter artifactWrites to only those whose artifact still exists.
  // (No-op for the normal path where the strict check above already passed.)
  const validArtifactWrites = artifactWrites.filter(write => artifactsById.has(write.artifactId));
  for (const write of validArtifactWrites) {
    const artifact = artifactsById.get(write.artifactId);
      if (
        (!borrowedFromEpic && !matchesNodeFence(write, query))
        || !artifact
        || artifact.projectId !== ctx.projectId
        || artifact.epicId !== ctx.epicId
        || artifact.type !== write.artifactType
        || (!borrowedFromEpic && !artifactStatusMatchesManagedWrite(deps, ctx, query, write, artifact))
        || artifact.contentHash !== write.contentHash
        || !isSha256(write.contentHash)
      ) {
      throw new Error(
        `${handlerId}: ledger artifact ${write.artifactId} does not match its canonical row`,
      );
    }
  }
  const traces = deps.graph.readTracesByIds(traceWrites.map(write => write.traceId));
  // The ledger is an append-only provenance journal, while a worker may
  // explicitly delete a defective trace before creating its corrected
  // replacement in the same fenced execution. Missing historical trace rows
  // therefore cannot be treated as products. Keep only canonical rows; if a
  // required trace for the active artifact is missing, the semantic graph gate
  // below will fail closed on the actual current graph.
  const tracesById = new Map(traces.map(trace => [trace.id, trace]));
  const validTraceWrites = traceWrites.filter(write => tracesById.has(write.traceId));
  for (const write of validTraceWrites) {
    const trace = tracesById.get(write.traceId);
    if (
      (!borrowedFromEpic && !matchesNodeFence(write, query))
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
  // P18 fix: the receipt.executionId may point to a REVIEWER or FAILED repair
  // execution (the latest NodeRun for this node), not the PRODUCER (the author
  // who created artifacts and moved the task to 'review'). The exact-acceptance
  // gate requires the producer's executionId to find the 'review' receipt.
  // Resolve the producer from the managed_artifact_productions ledger — it
  // records the exact execution that produced artifacts for this node-scope.
  const ledgerProducerExec = deps.ledger.readLatestManagedProductionExecutionIdForNode?.(
    ctx.processRunId,
    FORMALIZATION_MODULE_KEY,
    sourceNodeId,
  );
  const finalReceipt = (ledgerProducerExec && ledgerProducerExec !== receipt.executionId)
    ? { ...receipt, executionId: ledgerProducerExec }
    : receipt;
  return {
    receipt: finalReceipt,
    artifactWrites: validArtifactWrites,
    traceWrites: validTraceWrites,
    artifacts,
    traces,
  };
}

/**
 * Try to read an LM execution receipt from the given input. Returns null if
 * the input is not a valid LM receipt (instead of throwing). Used by
 * readExecutionWrites to try multiple sources (ctx.input, frame.productions)
 * before giving up. On recovery resume, ctx.input may be a feedbackProduction
 * instead of a receipt; the durable receipt is then in frame.productions.
 */
function tryLmReceipt(input: unknown, _handlerId: string): NodeExecutionReceipt | null {
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
    return null;
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

/**
 * A workplace ledger retains every authored revision for provenance, including
 * rows later marked `superseded`.  The node product, candidate set and semantic
 * gate must represent the active revision set only; otherwise a worker that
 * repairs a draft in-place appears to have authored several simultaneous
 * contracts and exact acceptance tries to recommit obsolete rows.
 */
function selectActiveExecutionWrites(writes: ExecutionWrites): ExecutionWrites {
  const nonSuperseded = writes.artifacts.filter(artifact => artifact.status !== 'superseded');
  const writeByArtifactId = new Map(
    writes.artifactWrites.map(write => [write.artifactId, write]),
  );
  const latestSingular = new Map<string, number>();
  for (const artifact of nonSuperseded) {
    if (artifact.type !== 'PRD' && artifact.type !== 'SRS') continue;
    const currentId = latestSingular.get(artifact.type);
    const currentWrite = currentId === undefined ? undefined : writeByArtifactId.get(currentId);
    const candidateWrite = writeByArtifactId.get(artifact.id);
    if (currentId === undefined
      || (candidateWrite?.ledgerId ?? artifact.id) > (currentWrite?.ledgerId ?? currentId)) {
      latestSingular.set(artifact.type, artifact.id);
    }
  }
  const artifacts = nonSuperseded.filter(artifact =>
    (artifact.type !== 'PRD' && artifact.type !== 'SRS')
    || latestSingular.get(artifact.type) === artifact.id);
  const artifactIds = new Set(artifacts.map(artifact => artifact.id));
  const traces = writes.traces.filter(trace => artifactIds.has(trace.sourceArtifactId));
  const traceIds = new Set(traces.map(trace => trace.id));
  return {
    ...writes,
    artifacts,
    artifactWrites: writes.artifactWrites.filter(write => artifactIds.has(write.artifactId)),
    traces,
    traceWrites: writes.traceWrites.filter(write => traceIds.has(write.traceId)),
  };
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

/**
 * CGAD P18 — the fence matches the DURABLE node-scope boundary of the read
 * (processRunId + moduleRef + nodeId). Task identity is deliberately excluded:
 * recovery mints a new task per attempt, so a task-equality fence would blind
 * the gate to durable artifacts produced in an earlier task of the same node.
 * The earlier "Never relax this fence to node scope" comment was the
 * self-defence of the regression that reopened BUGS #1/#2; it contradicted the
 * team's own fix and is removed.
 */
function matchesNodeFence(
  record: Pick<
    ManagedArtifactWriteRecord | ManagedTraceWriteRecord,
    'processRunId' | 'moduleRef' | 'nodeId'
  >,
  query: ManagedProductionQuery,
): boolean {
  return (
    record.processRunId === query.processRunId
    && record.moduleRef === query.moduleRef
    && record.nodeId === query.nodeId
  );
}

export function buildContractSnapshot(
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

/**
 * AUTHORITATIVE for the per-node exact-set traceability gate. Each formalization
 * resolver node (product / useCases / acceptance / architecture / reconciliation)
 * calls this to validate the traceability edges of the EXACT artifact set that
 * node owns, BEFORE the settlement certificate gate runs.
 *
 * DUPLICATE NOTICE — there is a second, deliberately different traceability
 * check: `findFirstTraceabilityGap` in
 * src/modules/formalization/infrastructure/sqlite-formalization-kernel.ts
 * (the epic-wide settlement-certificate gate, AUTHORITATIVE for RULE-012).
 *
 * These two are NOT duplicates and were intentionally NOT consolidated, because
 * they answer different questions on different data sources:
 *
 *   dimension           | findFirstTraceabilityGap (SQL)    | findContractGap (this)
 *   --------------------+-----------------------------------+----------------------------------
 *   AUTHORITATIVE FOR   | settlement certificate (RULE-012) | per-node exact-set gate
 *   data source         | LIVE artifact_traces (whole epic) | ContractSnapshot (exact owned set)
 *   scope of edges      | epic-wide (any same-type target)  | exact-set (target must be in snapshot)
 *   PRD root edge       | literal type='brief'              | any non-product ancestor type
 *                       |                                   |   (brief/decision/discovery-doc/...)
 *   SRS/UC/AC/FR edges  | SAME five canonical edges         | SAME five canonical edges
 *   return shape        | first gap as structured object    | ALL gaps joined as one string
 *                       | {artifactType,artifactId,         |   plus cardinality failures
 *                       |  missingEdge, description} | null |   ('exactly one PRD', '>=1 FR', ...)
 *
 * The PRD-root-edge difference is load-bearing: discovery does not always
 * register a `brief` artifact row, so the per-node gate accepts any accepted
 * non-product ancestor while the settlement gate requires the literal brief
 * edge (the brief-provisioning adapter creates it before settlement runs).
 *
 * When the canonical RULES edge set changes, BOTH this function AND
 * findFirstTraceabilityGap must be updated together. Do not collapse them into
 * one shared helper: the SQL path must stay short-circuit-first-gap against the
 * live DB (its port contract is stubbed across 4 test files), and this path
 * must stay aggregated-string over the exact snapshot (its callers bind the
 * aggregated `gap` string into manifest results).
 */
export function findContractGap(
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
  const gaps: string[] = [];
  if (required.useCases) {
    if (categories.ucs.length === 0) return 'contract must contain at least one UC';
    const prdIds = new Set(idsOf(categories.prd));
    const frIds = new Set(idsOf(categories.frs));
    for (const uc of categories.ucs) {
      if (!hasEdge(uc.id, 'derived_from', 'PRD', prdIds)) {
        gaps.push(`UC ${uc.id} has no derived_from → exact PRD trace`);
      }
      if (!hasEdge(uc.id, 'covers', 'FR', frIds)) {
        gaps.push(`UC ${uc.id} has no covers → exact FR trace`);
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
        gaps.push(`AC ${ac.id} has no derived_from → exact FR/NFR trace`);
      }
      if (hasFr && !hasEdge(ac.id, 'derived_from', 'UC', ucIds)) {
        gaps.push(`FR-derived AC ${ac.id} has no derived_from → exact UC trace`);
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
  return gaps.length > 0 ? gaps.join('; ') : null;
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
  // Cross-run-stable semantic digest (CONVEYOR v4.3 §6). Excludes run-specific
  // provenance (processRunId, intentId, taskId, executionId, artifactIds,
  // traceIds, ledgerIds). Uses stable artifact content hashes + trace digest.
  const semanticProjection = {
    moduleRef: FORMALIZATION_MODULE_KEY,
    sourceNodeId,
    event,
    artifactHashes: Object.values(snapshot.artifactHashes).sort(),
    traceDigest: snapshot.traceDigest,
  };
  const semanticDigest = sha256Hex(semanticProjection);
  return {
    event,
    production: {
      schema,
      artifactRef: `formalization-node-product:${ctx.processRunId}:${sourceNodeId}:${contentHash}`,
      contentHash,
      semanticDigest,
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
      requireApprovedReview: false,
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
        'factory.formalization-resolution-failure.v1',
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
  deps: FormalizationInstallationDeps,
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
  // WAVE 8 HIGH 3 — issue the failure certificate IN THE KERNEL. The failure
  // outcome is terminal and historically was certified via the executor's
  // magic-bindings path. Wave 4 made the kernel the issuer; Wave 5 deleted the
  // magic-bindings fallback; Wave 8 makes terminal completion MANDATORY. There
  // is NO recovery path: if `certificateRepo.issue` throws, the settlement MUST
  // FAIL LOUDLY — a swallowed error would silently produce a null certificate,
  // which is data loss (a real problem: DB issue, schema mismatch, etc.). The
  // previous try/catch swallow was deleted; the failure surfaces as a thrown
  // error and the ProcessRun flips to 'failed'.
  const issuedCertificate = issueFormalizationCertificate(
    deps,
    ctx,
    certificatePayload,
    certificateHash,
  );
  return {
    event: 'failed',
    production: {
      schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      artifactRef: `formalization-settlement:${ctx.processRunId}:${certificateHash}`,
      contentHash: certificateHash,
      // WAVE 5 CUTOVER — certificate envelope removed from bindings (see the
      // success path above). `authority` + `settlementError` are non-certificate
      // bindings and are retained.
      bindings: {
        authority: 'formalization_settlement_policy',
        settlementError: reason,
      },
    },
    completion: buildFormalizationModuleCompletion(
      'failed',
      certificatePayload,
      certificateHash,
      issuedCertificate,
    ),
  };
}

/**
 * Wave 4 (Uncle Bob) — issue the Formalization ProcessOutcomeCertificate IN
 * THE KERNEL. This mirrors what the generic-flow-executor's magic-bindings
 * path does (generic-flow-executor.ts:363-390): the kernel becomes the
 * certificate issuer so the explicit ModuleCompletion can carry a content-
 * addressed certificateRef that points at the issued row. Idempotent on
 * certificateHash (the repository returns the existing row on replay).
 *
 * Returns the issued certificate's durable id + hash, which the caller wraps
 * into a ProductRef for the completion envelope.
 */
function issueFormalizationCertificate(
  deps: FormalizationInstallationDeps,
  ctx: KernelHandlerContext,
  certificatePayload: {
    schemaVersion: string;
    decision: string;
    reasonCodes: readonly string[];
    rationale: string;
    inputHash: string;
    payload: unknown;
  },
  certificateHash: string,
): { id: number; certificateHash: string } {
  const result = deps.certificateRepo.issue({
    processRunId: ctx.processRunId,
    moduleRef: FORMALIZATION_PROCESS_MODULE_REF,
    projectId: ctx.projectId,
    epicId: ctx.epicId,
    payload: certificatePayload,
    certificateHash,
    authority: 'formalization_settlement_policy',
  });
  return {
    id: result.record.id,
    certificateHash: result.record.certificateHash,
  };
}

/**
 * Wave 4 (Uncle Bob) — build the explicit ModuleCompletion envelope that
 * outputEnvelope.certificateRef is the content-addressed pointer settlement
 * reads to bypass the magic-bindings fallback entirely (Wave 5 deletes that
 * branch). `terminal` mirrors the formalization outcome definitions: every
 * settlement decision (formalized / clarification-required / inconsistent /
 * failed) is terminal.
 *
 * The `productions` array is left empty here because the completion envelope's
 * contract only requires the certificateRef for settlement; the durable
 * NodeProduction (the SolutionContract-bearing production) is already persisted
 * by the executor on the NodeRun row and surfaced via `output` through the
 * resolveOutput hook. This matches the shape proven by
 * tests/process-modules/module-completion-persistence.test.mjs
 * (sampleModuleCompletion: productions: []).
 *
 * Wave 8 BLOCKER 2: the envelope is a LEAF. The previous implementation built
 * a REAL runtime cycle (`envelope.completion = completion`) to satisfy the
 * now-removed `ProcessModuleOutputEnvelope.completion` field. That cycle made
 * `JSON.stringify(completion)` throw "Converting circular structure to JSON"
 * in the durable persist path. With the field gone, the model is a tree:
 * ModuleCompletion.outputEnvelope → envelope (one-directional).
 */
function buildFormalizationModuleCompletion(
  outcome: string,
  _certificatePayload: unknown,
  certificateHash: string,
  issuedCertificate: { id: number; certificateHash: string },
): ModuleCompletion {
  const certificateRef: ProductRef = {
    schemaId: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
    ref: `certificate:${issuedCertificate.id}`,
    digest: issuedCertificate.certificateHash,
  };
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  const completion: ModuleCompletion = {
    outcome,
    outputEnvelope,
    terminal: true,
  };
  void certificateHash;
  return completion;
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
    || typeof value.discoveryProposalRef !== 'string'
    || value.discoveryProposalRef.length === 0
    || !isSha256(value.discoveryProposalHash)
    || !value.discoveryProposalPayload
    || typeof value.discoveryProposalPayload !== 'object'
    || sha256Hex(value.discoveryProposalPayload) !== value.discoveryProposalHash
    || typeof value.initiativeSubject !== 'string'
    || value.initiativeSubject.trim().length === 0
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
    .filter(artifact => artifact.type === wanted && artifact.status !== 'superseded')
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

/**
 * Read criticality classification from AC artifact tags.
 * The architect tags each AC from SRS §D2: `criticality:blocker`,
 * `criticality:degradable`, `criticality:nice_to_have`.
 * Default: 'blocker' (conservative — treat as mandatory).
 */
function readCriticalityFromTags(artifact: FormalizationArtifactSnapshot): 'blocker' | 'degradable' | 'nice_to_have' {
  const tags = artifact.tags;
  if (!Array.isArray(tags)) return 'blocker';
  for (const tag of tags) {
    if (tag === 'criticality:blocker') return 'blocker';
    if (tag === 'criticality:degradable') return 'degradable';
    if (tag === 'criticality:nice_to_have') return 'nice_to_have';
  }
  return 'blocker';
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

/**
 * Cross-run-stable semantic digest of the acceptance baseline (CONVEYOR v4.3
 * §5-6). Unlike {@link acceptanceBaselineHash}, this excludes all run-specific
 * provenance: no DB row IDs, no processRunId, no artifact refs. It is computed
 * from stable AC codes (falling back to type+index when code is absent) paired
 * with accepted content hashes — the semantic identity of the baseline that
 * downstream cells (SRS) use for cross-run ReplayKey derivation.
 *
 * Two runs with the same AC content (same codes, same accepted hashes) produce
 * the same digest even though they have different DB artifact IDs, different
 * processRunIds, and different reconciliation refs.
 */
function acceptanceBaselineSemanticDigest(
  artifacts: readonly FormalizationArtifactSnapshot[],
): string {
  const rows = [...artifacts]
    .map((artifact, index) => ({
      // Stable identity: prefer the artifact code (e.g. "AC-1"), which is
      // human-assigned and stable across runs. If code is absent (edge case),
      // fall back to type + ordinal index — still independent of DB row ID.
      key: artifact.code ?? `${artifact.type}:${index}`,
      hash: artifact.acceptedHash ?? '',
    }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return createHash('sha256')
    .update(rows.map(row => `${row.key}:${row.hash}`).join('\n'))
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
