import type {
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
} from '../../../process-modules/application/kernel-handler-registry.js';
import type { ProcessOutputPayloadResolver } from '../../../process-modules/application/lifecycle-orchestrator.js';
import type { ProcessModuleDefinition } from '../../../process-modules/domain/process-module.js';
import type {
  ModuleCompletion,
  ProcessModuleOutputEnvelope,
  ProductRef,
} from '../../../process-modules/domain/spi/index.js';
import type {
  ProcessModuleExecutionContext,
} from '../../../process-modules/application/process-module-executor.js';
import type { ProcessModuleOutput } from '../../../process-modules/persistence/process-run.js';
import type { ProcessOutcomeCertificateRepository } from '../../../process-modules/persistence/process-outcome-certificate-repository.js';
import type { IssueProcessOutcomeCertificateCommand } from '../../../process-modules/persistence/process-outcome-certificate.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  FORMALIZATION_PROCESS_MODULE_REF,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import type {
  FormalizationArtifactGraphPort,
  FormalizationCanonicalGraphPort,
  FormalizationSettlementPolicyPort,
} from '../domain/formalization-kernel-ports.js';
import {
  buildFormalizationCertificatePayload,
} from '../domain/formalization-kernel-ports.js';
import type {
  FormalizationBaselineRepository,
  FormalizationSolutionContractRepository,
} from '../domain/formalization-persistence-contracts.js';
import {
  ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
  FORMALIZATION_CASE_SCHEMA,
  FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
  FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
  FORMALIZATION_SRS_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
  type FormalizationCase,
  type FormalizationSolutionContractPayload,
  type FormalizationSettlementInput,
  type SolutionContractBundle,
} from '../domain/formalization-schemas.js';
import { acceptanceCriteriaForArtifact } from '../domain/acceptance-criterion-document.js';
import {
  extractD2Stanzas,
  parseD2CriticalityByAc,
} from './srs-d2-parser.js';
import { acContentRequiresImplementation } from './formalization-contract-analysis.js';

/**
 * Read covered_constraint_ids from AC artifact metadata (typed IDs only).
 * The metadata column arrives as a JSON string from SQLite — normalize once
 * here (same ingress rule as coveredConstraintIdsOfArtifacts).
 */
function coveredConstraintIdsFromMetadata(metadata: unknown): string[] {
  let record: Record<string, unknown> | null = null;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      record = null;
    }
  } else if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    record = metadata as Record<string, unknown>;
  }
  if (!record) return [];
  const ids = record['covered_constraint_ids'];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export const FORMALIZATION_KERNEL_HANDLER_IDS = {
  freezeBaseline: 'formalization-baseline-freezer',
  settle: 'formalization-settlement-policy',
} as const;

export interface FormalizationProductionCellInstallationDeps {
  readonly graph: FormalizationArtifactGraphPort & FormalizationCanonicalGraphPort;
  readonly baselineRepository: FormalizationBaselineRepository;
  readonly solutionContractRepository: FormalizationSolutionContractRepository;
  readonly settlementPolicy: FormalizationSettlementPolicyPort;
  readonly certificateRepository: ProcessOutcomeCertificateRepository;
  /** Exact accepted artifact bytes; settlement never derives HOW from AC tags. */
  readonly readArtifactContent: (artifactId: number) => string;
}

export function createFormalizationProductionCellKernelHandlers(
  deps: FormalizationProductionCellInstallationDeps,
): Record<string, KernelHandler> {
  return {
    [FORMALIZATION_KERNEL_HANDLER_IDS.freezeBaseline]: createBaselineFreezer(deps),
    [FORMALIZATION_KERNEL_HANDLER_IDS.settle]: createSettlementHandler(deps),
  };
}

function createBaselineFreezer(
  deps: FormalizationProductionCellInstallationDeps,
): KernelHandler {
  return ctx => {
    try {
      const epicId = requireEpicId(ctx);
      // ADR-078 (K6): the baseline freeze is scoped to the CURRENT lifecycle
      // run — the same TB-11 recovery the settlement gate uses. A dead run's
      // ACs must not freeze into this run's baseline.
      const lifecycleRunId = requireLifecycleRunId(deps.graph, ctx.processRunId);
      const accepted = deps.graph.readAcceptedArtifactsForLifecycle(epicId, lifecycleRunId);
      if (accepted.acs.length === 0) {
        return baselineFailure(ctx, 'acceptance baseline requires at least one accepted AC');
      }
      const baseline = deps.graph.readAcceptanceBaselineHashForLifecycle(epicId, lifecycleRunId);
      if (!baseline.clean) {
        return {
          event: 'drift-detected',
          production: baselineManifest(ctx, {
            status: 'drift-detected',
            dirtyArtifactIds: baseline.dirty,
          }),
        };
      }
      const acs = deps.graph.readArtifactsByIds(accepted.acs);
      const hashes = Object.fromEntries(acs.map(artifact => [
        String(artifact.id),
        acceptedHash(artifact),
      ]));
      const acceptanceCriteria = acs.flatMap(artifact => {
        const parsed = acceptanceCriteriaForArtifact(
          deps.readArtifactContent(artifact.id),
          artifact.code,
        );
        if (parsed.length > 0) {
          return parsed.map(criterion => ({ artifactId: artifact.id, ...criterion }));
        }
        if (!artifact.code) throw new Error(`accepted AC ${artifact.id} has no stable code`);
        return [{
          artifactId: artifact.id,
          code: artifact.code,
          title: artifact.code,
          contentHash: acceptedHash(artifact),
        }];
      });
      if (new Set(acceptanceCriteria.map(item => item.code)).size !== acceptanceCriteria.length) {
        throw new Error('atomic acceptance criterion codes must be unique across accepted artifacts');
      }
      // AC-drift structure network: freeze the per-AC constraint coverage
      // (covered_constraint_ids metadata) into the baseline payload. One
      // source, three projections — brief dispositions (network 1), this
      // frozen map (network 2), the downstream warrantRef (network 3).
      // Omitted entirely when no AC carries coverage — old runs freeze the
      // exact payload shape they always had.
      const coveredConstraints = Object.fromEntries(
        acs
          .map(artifact => [
            artifact.code ?? String(artifact.id),
            coveredConstraintIdsFromMetadata(artifact.metadata),
          ] as const,
        )
        .filter(([, ids]) => ids.length > 0),
      );
      // Cross-run semantic digest (CONVEYOR v4.3 §5-6): stable AC codes +
      // accepted hashes, no DB IDs/processRunId/refs. See the sibling
      // acceptanceBaselineSemanticDigest in formalization-installation.ts.
      const semanticDigest = acceptanceBaselineSemanticDigest(acs);
      const source = requireProduction(ctx.input, 'reconcile-what');
      const payload = {
        schemaVersion: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
        processRunId: ctx.processRunId,
        formalizationEpicId: epicId,
        sourceReconciliationRef: source.artifactRef,
        sourceReconciliationHash: source.contentHash,
        acArtifactIds: [...accepted.acs].sort((a, b) => a - b),
        acArtifactHashes: hashes,
        acceptanceCriteria,
        ...(Object.keys(coveredConstraints).length > 0 ? { coveredConstraints } : {}),
        baselineHash: baseline.hash,
      } as const;
      const frozen = deps.baselineRepository.freeze(payload);
      return {
        event: 'frozen',
        production: {
          schema: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
          artifactRef: frozen.record.artifactRef,
          contentHash: frozen.record.snapshotHash,
          semanticDigest,
          bindings: {
            baselineHash: frozen.record.baselineHash,
            snapshotHash: frozen.record.snapshotHash,
            acArtifactIds: frozen.record.payload.acArtifactIds,
            acceptanceCriterionCodes: frozen.record.payload.acceptanceCriteria?.map(item => item.code) ?? [],
            replayed: frozen.replayed,
          },
        },
      };
    } catch (error) {
      return baselineFailure(ctx, message(error));
    }
  };
}

function createSettlementHandler(
  deps: FormalizationProductionCellInstallationDeps,
): KernelHandler {
  return ctx => {
    try {
      const epicId = requireEpicId(ctx);
      // TB-11: the settlement task-readiness gate is scoped to the CURRENT
      // lifecycle run. The executor context carries only processRunId, so the
      // owning lifecycle run is recovered through the graph port (see
      // readOwningLifecycleRunId for why this lookup lives there). A process
      // run without an owning lifecycle run is an infrastructure failure —
      // fail closed into the 'failed' settlement path below.
      const lifecycleRunId = requireLifecycleRunId(deps.graph, ctx.processRunId);
      const formalizationCase = requireFormalizationCase(ctx.frame.runInput);
      if (formalizationCase.formalizationEpicId !== epicId) {
        throw new Error('FormalizationCase epic does not match ProcessRun epic');
      }
      const baseline = deps.baselineRepository.readByProcessRun(ctx.processRunId);
      if (!baseline) throw new Error('formalization acceptance baseline is missing');
      // ADR-078 (K6): exact lifecycle-scoped accepted material.
      const accepted = deps.graph.readAcceptedArtifactsForLifecycle(epicId, lifecycleRunId);
      const bundle = buildBundle(epicId, accepted, baseline.baselineHash);
      const settlementInput: FormalizationSettlementInput = {
        schemaVersion: FORMALIZATION_SETTLEMENT_INPUT_SCHEMA,
        formalizationEpicId: epicId,
        discoveryCertificateRef: formalizationCase.discoveryCertificateRef,
        discoveryCertificateHash: formalizationCase.discoveryCertificateHash,
        bundle,
      };
      const decision = deps.settlementPolicy.settle(deps.graph, settlementInput, lifecycleRunId);
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

      let productionRef = `formalization-settlement:${ctx.processRunId}:${certificateHash}`;
      let productionHash = certificateHash;
      let outputBindings: Record<string, unknown> = {};
      if (decision.decision === 'formalized') {
        const payload = buildSolutionContractPayload(
          deps,
          ctx,
          formalizationCase,
          bundle,
          baseline.artifactRef,
          baseline.snapshotHash,
        );
        const persisted = deps.solutionContractRepository.persist(payload);
        productionRef = persisted.record.artifactRef;
        productionHash = persisted.record.contentHash;
        outputBindings = {
          solutionContractRef: persisted.record.artifactRef,
          solutionContractHash: persisted.record.contentHash,
          solutionContractSchema: persisted.record.payload.schemaVersion,
          solutionContractReplayed: persisted.replayed,
        };
      }

      const issued = deps.certificateRepository.issue({
        processRunId: ctx.processRunId,
        moduleRef: FORMALIZATION_PROCESS_MODULE_REF,
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        payload: certificatePayload,
        certificateHash,
        authority: 'formalization_settlement_policy',
      } satisfies IssueProcessOutcomeCertificateCommand);
      const certificateRef: ProductRef = {
        schemaId: FORMALIZATION_CERTIFICATE_SCHEMA_VERSION,
        ref: `certificate:${issued.record.id}`,
        digest: issued.record.certificateHash,
      };
      return {
        event: decision.decision,
        production: {
          schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          artifactRef: productionRef,
          contentHash: productionHash,
          bindings: {
            ...outputBindings,
            authority: 'formalization_settlement_policy',
            bundleHash: bundle.bundleHash,
            acceptanceBaselineHash: baseline.baselineHash,
          },
        },
        completion: moduleCompletion(decision.decision, certificateRef),
      };
    } catch (error) {
      return {
        event: 'failed',
        production: {
          schema: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
          artifactRef: `formalization-settlement-failed:${ctx.processRunId}:${sha256Hex(message(error))}`,
          contentHash: sha256Hex({ processRunId: ctx.processRunId, error: message(error) }),
          bindings: {
            authority: 'formalization_settlement_policy',
            settlementError: message(error),
          },
        },
      };
    }
  };
}

function buildBundle(
  epicId: number,
  accepted: ReturnType<FormalizationArtifactGraphPort['readAcceptedArtifactsForLifecycle']>,
  baselineHash: string,
): SolutionContractBundle {
  const body = {
    schemaVersion: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
    formalizationEpicId: epicId,
    prdArtifactId: accepted.prd,
    frArtifactIds: [...accepted.frs].sort((a, b) => a - b),
    nfrArtifactIds: [...accepted.nfrs].sort((a, b) => a - b),
    ruleArtifactIds: [...accepted.rules].sort((a, b) => a - b),
    ucArtifactIds: [...accepted.ucs].sort((a, b) => a - b),
    acArtifactIds: [...accepted.acs].sort((a, b) => a - b),
    acceptanceBaselineHash: baselineHash,
    srsArtifactId: accepted.srs,
  } as const;
  return { ...body, bundleHash: sha256Hex(body) };
}

export function buildSolutionContractPayload(
  deps: FormalizationProductionCellInstallationDeps,
  ctx: KernelHandlerContext,
  formalizationCase: FormalizationCase,
  bundle: SolutionContractBundle,
  baselineSnapshotRef: string,
  baselineSnapshotHash: string,
): FormalizationSolutionContractPayload {
  const ids = [
    ...(bundle.prdArtifactId ? [bundle.prdArtifactId] : []),
    ...bundle.frArtifactIds,
    ...bundle.nfrArtifactIds,
    ...bundle.ruleArtifactIds,
    ...bundle.ucArtifactIds,
    ...bundle.acArtifactIds,
    ...(bundle.srsArtifactId ? [bundle.srsArtifactId] : []),
  ];
  const artifacts = deps.graph.readArtifactsByIds(ids);
  if (artifacts.length !== new Set(ids).size) {
    throw new Error('solution contract artifact set is incomplete');
  }
  const artifactHashes = Object.fromEntries(
    artifacts.map(artifact => [String(artifact.id), acceptedHash(artifact)]),
  );
  const traces = deps.graph.readOutgoingArtifactTraces(ids)
    .filter(trace => trace.targetType === 'artifact' && ids.includes(trace.targetId))
    .sort((a, b) => a.id - b.id);
  const srs = artifacts.find(artifact => artifact.id === bundle.srsArtifactId);
  if (!srs) throw new Error('formalized contract has no accepted SRS');

  const srsContent = deps.readArtifactContent(srs.id);
  const d2ByCode = new Map(
    extractD2Stanzas(srsContent).map(stanza => [stanza.ac, stanza]),
  );
  const criticalityByCode = parseD2CriticalityByAc(srsContent);
  const frozen = deps.baselineRepository.readByProcessRun(ctx.processRunId);
  if (!frozen) throw new Error('formalized contract has no frozen acceptance baseline');
  const criteria = frozen.payload.acceptanceCriteria ?? artifacts
    .filter(artifact => bundle.acArtifactIds.includes(artifact.id))
    .sort((a, b) => a.id - b.id)
    .map(artifact => ({
      artifactId: artifact.id,
      code: artifact.code ?? '',
      title: artifact.code ?? '',
      contentHash: acceptedHash(artifact),
    }));

  return {
    schemaVersion: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
    processRunId: ctx.processRunId,
    formalizationEpicId: requireEpicId(ctx),
    discoveryCertificateRef: formalizationCase.discoveryCertificateRef,
    discoveryCertificateHash: formalizationCase.discoveryCertificateHash,
    bundle,
    artifactHashes,
    traceIds: traces.map(trace => trace.id),
    traceDigest: sha256Hex(traces),
    baselineSnapshotRef,
    baselineSnapshotHash,
    srs: {
      schema: FORMALIZATION_SRS_SCHEMA,
      ref: `artifact:${srs.id}`,
      hash: acceptedHash(srs),
    },
    acceptanceCriteria: criteria.map(artifact => {
      if (!artifact.code) {
        throw new Error(`accepted AC member ${artifact.artifactId} has no stable code`);
      }
      const stanza = d2ByCode.get(artifact.code);
      if (!stanza) {
        throw new Error(
          `SRS §D2 does not decompose accepted ${artifact.code}; downstream binding denied`,
        );
      }
      const acKind = stanza.fields.get('ac_kind');
      if (acKind !== 'implementation' && acKind !== 'verification') {
        throw new Error(`SRS §D2 ${artifact.code} has invalid ac_kind '${acKind ?? ''}'`);
      }
      return {
        criterionId: artifact.artifactId,
        artifactId: artifact.artifactId,
        code: artifact.code,
        acceptedHash: artifactHashes[String(artifact.artifactId)]!,
        criterionHash: artifact.contentHash,
        // Guard: an AC whose content signals implementation work (tests/build/
        // wrapper/gradle/runtime) is implementation-required even if the SRS §D2
        // classified it verification-only. Keeps both producers consistent.
        implementationRequired: acKind === 'implementation'
          || acContentRequiresImplementation(artifact),
        criticality: criticalityByCode.get(artifact.code) ?? 'blocker',
      };
    }),
  };
}

export function createFormalizationOutputResolver(
  repository: FormalizationSolutionContractRepository,
): (
  module: ProcessModuleDefinition,
  terminalOutcome: string,
  terminalResult: unknown,
  context: ProcessModuleExecutionContext,
) => ProcessModuleOutput | null {
  return (_module, terminalOutcome, _terminalResult, context) => {
    if (terminalOutcome !== 'formalized') return null;
    const record = repository.readByProcessRun(context.processRunId);
    if (!record) throw new Error('formalized run has no durable SolutionContract');
    return {
      schema: record.payload.schemaVersion,
      artifactRef: record.artifactRef,
      contentHash: record.contentHash,
    };
  };
}

export function createFormalizationLifecycleOutputPayloadResolver(
  repository: FormalizationSolutionContractRepository,
): ProcessOutputPayloadResolver {
  return context => {
    if (
      context.moduleRef.name !== FORMALIZATION_PROCESS_MODULE_REF.name
      || context.moduleRef.version !== FORMALIZATION_PROCESS_MODULE_REF.version
    ) {
      throw new Error('formalization output payload: module reference mismatch');
    }
    const record = repository.readByProcessRun(context.processRunId);
    if (!record) throw new Error('formalization output payload missing');
    if (
      record.artifactRef !== context.output.artifactRef
      || record.contentHash !== context.output.contentHash
      || record.payload.schemaVersion !== context.output.schema
      || sha256Hex(record.payload) !== record.contentHash
    ) {
      throw new Error('formalization output payload: exact output mismatch');
    }
    return record.payload;
  };
}

function baselineManifest(
  ctx: KernelHandlerContext,
  bindings: Record<string, unknown>,
) {
  const contentHash = sha256Hex(bindings);
  return {
    schema: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
    artifactRef: `formalization-baseline-status:${ctx.processRunId}:${contentHash}`,
    contentHash,
    bindings,
  };
}

function baselineFailure(
  ctx: KernelHandlerContext,
  reason: string,
): KernelHandlerResult {
  return {
    event: 'failed',
    production: baselineManifest(ctx, { status: 'failed', error: reason }),
  };
}

function requireProduction(value: unknown, label: string): {
  artifactRef: string;
  contentHash: string;
} {
  if (!isRecord(value)) throw new Error(`${label}: production is required`);
  const artifactRef = value.artifactRef;
  const contentHash = value.contentHash;
  if (typeof artifactRef !== 'string' || typeof contentHash !== 'string') {
    throw new Error(`${label}: exact production ref/hash required`);
  }
  return { artifactRef, contentHash };
}

function requireFormalizationCase(value: unknown): FormalizationCase {
  if (!isRecord(value) || value.schemaVersion !== FORMALIZATION_CASE_SCHEMA) {
    throw new Error('invalid FormalizationCase');
  }
  return value as unknown as FormalizationCase;
}

function requireEpicId(ctx: KernelHandlerContext): number {
  if (!Number.isSafeInteger(ctx.epicId) || (ctx.epicId ?? 0) < 1) {
    throw new Error('formalization requires epicId');
  }
  return ctx.epicId as number;
}

/**
 * TB-11: resolve the lifecycle run owning this process run and fail closed
 * when there is none — settlement MUST be scoped to a concrete lifecycle run
 * so that workplaces of DEAD runs cannot poison the task-readiness gate.
 */
function requireLifecycleRunId(
  graph: FormalizationProductionCellInstallationDeps['graph'],
  processRunId: number,
): number {
  const lifecycleRunId = graph.readOwningLifecycleRunId(processRunId);
  if (!Number.isSafeInteger(lifecycleRunId) || (lifecycleRunId ?? 0) < 1) {
    throw new Error(
      `formalization settlement requires an owning lifecycle run for process run ${processRunId}`,
    );
  }
  return lifecycleRunId as number;
}

function acceptedHash(artifact: {
  id: number;
  status: string;
  contentHash: string | null;
  acceptedHash: string | null;
  driftState: string;
}): string {
  if (
    artifact.status !== 'accepted'
    || !artifact.contentHash
    || artifact.acceptedHash !== artifact.contentHash
    || artifact.driftState !== 'clean'
  ) {
    throw new Error(`artifact ${artifact.id} is not accepted+clean`);
  }
  return artifact.acceptedHash;
}

/**
 * Cross-run-stable semantic digest of the acceptance baseline (CONVEYOR v4.3
 * §5-6). Computed from stable AC codes + accepted hashes only — no DB row IDs,
 * no processRunId, no refs, no timestamps. See the sibling function in
 * formalization-installation.ts for the full rationale.
 */
function acceptanceBaselineSemanticDigest(
  artifacts: ReadonlyArray<{
    code: string | null;
    type: string;
    acceptedHash: string | null;
    contentHash: string | null;
    status: string;
    driftState: string;
    id: number;
  }>,
): string {
  const rows = [...artifacts]
    .map((artifact, index) => ({
      key: artifact.code ?? `${artifact.type}:${index}`,
      hash: acceptedHash(artifact),
    }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return sha256Hex(rows.map(row => `${row.key}:${row.hash}`).join('\n'));
}

function moduleCompletion(outcome: string, certificateRef: ProductRef): ModuleCompletion {
  const outputEnvelope: ProcessModuleOutputEnvelope = {
    outcome,
    productions: [],
    certificateRef,
  };
  return { outcome, outputEnvelope, terminal: true };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
