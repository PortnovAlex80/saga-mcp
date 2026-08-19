/**
 * Product Delivery lifecycle composition root.
 *
 * Cross-module runtime mechanics are constructed once here. Each workshop
 * contributes its declaration, handlers, checks and effects through platform
 * extension points; the universal runtime never branches on workshop names.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/canonical-json.js';import type {
  WorkAssignmentPort,
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../application/ports/worker-executor.js';
import { getDb } from '../db.js';
import { engineLog } from '../runtime/engine-file-logger.js';
import type { FactoryDiscoveryRuntimePersistence } from '../modules/discovery/infrastructure/discovery-runtime-port.js';
import { SqliteFactoryDiscoveryRuntime } from '../modules/discovery/infrastructure/sqlite-discovery-runtime.js';
import {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} from '../process-modules/application/handlers/process-outcome-emitter.js';
import { HumanInteractionRegistry } from '../process-modules/application/human-interaction-registry.js';
import { KernelHandlerRegistry } from '../process-modules/application/kernel-handler-registry.js';
import { LifecycleOrchestrationEngineAdapter } from '../process-modules/application/lifecycle-orchestration-engine-adapter.js';
import { LifecycleOrchestrator } from '../process-modules/application/lifecycle-orchestrator.js';
import {
  assertWorkshopTransitionHandlerBinding,
  installWorkshopPayloadContracts,
  recordWorkshopBindingReceipt,
  registerWorkshopPostAcceptanceEffect,
} from '../process-modules/application/workshop-capability-manifest.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { TransitionObligationIntegrator } from '../process-modules/application/transition-obligation-integrator.js';
import {
  TransitionObligationReconciler,
  type TransitionObligationHandler,
} from '../process-modules/application/transition-obligation-reconciler.js';
import { closeCommittedTypedPresentation } from '../application/final-presentation-closure.js';
import {
  readExactCompletionReceipt,
  readTransitionHandoffPostcondition,
} from '../process-modules/application/transition-handoff-postconditions.js';
import { findStalledScopes } from '../application/progress/sqlite-progress-reader.js';
import type { ProgressExplanation } from '../application/progress/progress-classification.js';
import { SqliteTransitionObligationLedger } from '../process-modules/persistence/sqlite-transition-obligation-ledger.js';
import type { TransitionObligation } from '../process-modules/persistence/sqlite-transition-obligation-ledger.js';
import type {
  OrchestrationEngine,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type {
  NodeExecutor,
  NodeProducts,
} from '../process-modules/application/node-executor.js';
import { HumanNodeExecutor } from '../process-modules/application/node-executors/human-node-executor.js';
import { KernelNodeExecutor } from '../process-modules/application/node-executors/kernel-node-executor.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  assertProductDeliveryLifecycleInput,
  productDeliveryLifecycle,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { productBuildLifecycle } from '../process-modules/lifecycles/product-build-lifecycle.js';
import { lifecycleInputPolicyValidation } from '../infrastructure/process-modules/lifecycle-input-policy-validation.js';
import {
  canonicalizeProductDeliveryLifecycleInput,
  resolveProductDeliveryRepositories,
  resolveProductDeliveryStageInput,
} from './product-lifecycle-repository-bindings.js';
import { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import { ProcessModuleInstallationRegistry } from '../process-modules/application/process-module-installation-registry.js';
import type { ProductionInstallation } from '../process-modules/installation/production-install.js';
import type { ResolveStageOutputPayload } from '../process-modules/application/lifecycle-orchestrator.js';
import { SqliteLifecycleRunRepository } from '../process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { SqliteLifecycleContinuationRepository } from '../process-modules/persistence/sqlite-lifecycle-continuation-repository.js';
import { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { SqliteManagedProductionLedger } from '../process-modules/persistence/sqlite-managed-production-ledger.js';
import { SqliteProcessProductRepository } from '../process-modules/persistence/sqlite-process-product-repository.js';
import { SqliteProcessProductRepositoryV2 } from '../process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteWorkplaceProductAdapter } from '../process-modules/persistence/sqlite-workplace-product-adapter.js';
import { SqliteNodeRunRepository } from '../process-modules/persistence/sqlite-node-run-repository.js';
import { SqliteCandidateSetRepository } from '../infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteGateRepository } from '../infrastructure/workplace/sqlite-gate-repository.js';
import { SqliteProductionCellIntegration } from '../infrastructure/workplace/sqlite-production-cell-integration.js';
import { SqliteCellFinalAcceptance } from '../infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { SqliteReplanMandateLedger } from '../infrastructure/workplace/sqlite-replan-mandate-ledger.js';
import { SqliteSealedProductMaterialRepository } from '../infrastructure/workplace/sqlite-sealed-product-material-repository.js';
import { SqliteAuthorCandidateCarryForward } from '../infrastructure/workplace/sqlite-author-candidate-carry-forward.js';
import { SqliteExternalEffectLedger } from '../process-modules/persistence/sqlite-external-effect-ledger.js';
import {
  createGitIntegrationEffect,
} from '../infrastructure/workplace/git-integration-effect.js';
import { SqliteWorkplaceRepository } from '../infrastructure/workplace/sqlite-workplace-repository.js';
import { ProductionCellCoordinator } from '../process-modules/application/production-cell-coordinator.js';import { CommitAcceptedCandidate } from '../process-modules/application/commit-accepted-candidate.js';

import {
  ProductionCellNodeExecutor,
  type ProductionCellProductReader,
  type ProductionCellProjectionPersistence,
} from '../process-modules/application/node-executors/production-cell-node-executor.js';
import { readFrozenProductionIngress } from '../process-modules/application/production-ingress-contract.js';
import { readManagedCompletionProducts } from '../infrastructure/workplace/sqlite-managed-completion-product.js';
import {
  activateProductionCellRoleTask,
  completeProductionCellTaskProjections,
} from '../lifecycle/work-assignment-core.js';
import { createStandardCheckProviderRegistry } from '../process-modules/application/standard-check-providers.js';
import {
  createPostAcceptanceEffectRegistry,
} from '../process-modules/application/post-acceptance-effects.js';
import { createReplayCaptureEffect } from '../infrastructure/replay/replay-capture-effect.js';
import {
  deserializeWorkplaceRef,
  serializeWorkplaceRef,
} from '../process-modules/domain/workplace/workplace-ref.js';
import { recoveryEpochBackoffMs } from '../process-modules/domain/workplace/production-cell-definition.js';
import { isWorkplaceProductionSnapshot, workplaceProductionSemanticDigest } from '../process-modules/shared/workplace-production-snapshot.js';
import { SqliteProcessOutcomeCertificateRepository } from '../process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import { SqliteProcessRunRepository } from '../process-modules/persistence/sqlite-process-run-repository.js';
import { SqliteRecoveryCaseRepository } from '../process-modules/persistence/sqlite-recovery-case-repository.js';
import {
  countFailedAcceptanceEffectRepairs as countFailedAcceptanceEffectRepairsSql,
  countGateRejectedCandidateSets as countGateRejectedCandidateSetsSql,
  createSqliteProductionCellProjectionPersistence,
  readLastRepairRequiredDiagnosis as readLastRepairRequiredDiagnosisSql,
  readReviewerRoundHistory as readReviewerRoundHistorySql,
} from '../infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { createFormalizationLifecycleOutputPayloadResolver } from '../modules/formalization/application/formalization-production-cell-installation.js';
import { SOLUTION_CONTRACT_CERTIFICATE_SCHEMA } from '../modules/formalization/domain/formalization-schemas.js';
import { createDevelopmentOutputPayloadResolver } from '../modules/development/application/development-installation.js';
import { VERIFIED_INTEGRATION_BUNDLE_SCHEMA } from '../modules/development/domain/development-schemas.js';
import { DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-continuation-process-module.js';
import { DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-verification-continuation-process-module.js';
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../process-modules/modules/development/development-process-module.js';
import { createDeliveryOutputPayloadResolver } from '../modules/delivery/application/delivery-installation.js';
import { RELEASE_RECORD_SCHEMA } from '../modules/delivery/domain/delivery-schemas.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';
import { registerDiscovery } from '../modules/discovery/index.js';
import { createDiscoveryLifecycleOutputPayloadResolver } from '../modules/discovery/application/discovery-production-cell-installation.js';
import { DISCOVERY_PROPOSAL_SCHEMA } from '../modules/discovery/domain/discovery-proposal.js';
import { registerFormalization } from '../modules/formalization/index.js';
import { registerDevelopment } from '../modules/development/index.js';
import { promoteTaskToDone } from '../lifecycle/work-assignment-core.js';
import { registerDelivery } from '../modules/delivery/index.js';
import type {
  ModuleRegistries,
  ModuleSharedDeps,
} from '../modules/module-registration.js';
import type { DevelopmentCompositionDependencies } from '../modules/development/index.js';
import type {
  DeliveryCompositionDependencies,
  DeliveryProviderConfiguration,
} from '../modules/delivery/index.js';
import { SqliteResumeDirectiveRepository } from '../checkpoints/sqlite-resume-directive-repository.js';
import { reevaluateDownstream } from '../tools/tasks.js';
import { journalEvent } from '../observability/run-journal.js';

export type { DevelopmentCompositionDependencies };
export type {
  DeliveryCompositionDependencies,
  DeliveryProviderConfiguration,
};

export interface ProductLifecycleRuntimeOptions {
  workerExecutorFactory: WorkerExecutorFactory;
  resolveWorkerContext: (context: {
    projectId: number;
    epicId: number | null;
  }) => WorkerExecutorFactoryContext;
  concurrency?: number;
  workAssignment?: WorkAssignmentPort;
  development?: DevelopmentCompositionDependencies;
  delivery: DeliveryCompositionDependencies;
  db?: Database.Database;
  discoveryRuntimePersistence?: FactoryDiscoveryRuntimePersistence;
  packageInstallation?: ProductionInstallation;
  onLifecycleStarted?: (
    run: import('../process-modules/persistence/lifecycle-run.js').LifecycleRunRecord,
  ) => Promise<void> | void;
}

/**
 * Recovery-budget fairness (operator SOFT-STOP, schema v13): count the
 * terminal executions that spend recovery budget for a task. A VOIDED
 * execution (voided_at IS NOT NULL — an operator recall) is NOT a model
 * failure and must not burn recovery budget or epochs.
 */
export function countTerminalExecutionsForTask(
  db: Database.Database,
  taskId: number,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM worker_executions
      WHERE task_id=? AND state IN ('lost','terminated','spawn_failed')
        AND voided_at IS NULL`,
  ).get(taskId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createProductLifecycleRuntime(
  options: ProductLifecycleRuntimeOptions,
) {
  assertCompositionDependencies(options);
  const db = options.db ?? getDb();

  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const recoveryCaseRepo = new SqliteRecoveryCaseRepository(db);
  const lifecycleRunRepo = new SqliteLifecycleRunRepository(db);
  const lifecycleContinuationRepo = new SqliteLifecycleContinuationRepository(
    db,
    lifecycleRunRepo,
  );
  const processProductRepo = new SqliteProcessProductRepository(db);
  const processProductRepoV2 = new SqliteProcessProductRepositoryV2(db);
  const workplaceProductPort = new SqliteWorkplaceProductAdapter(
    db,
    processProductRepoV2,
  );
  const sealedProductMaterials = new SqliteSealedProductMaterialRepository(db);

  const lookupProduction = db.prepare(
    `SELECT output_schema AS schema, output_ref AS ref, output_hash AS hash,
            output_bindings AS bindingsText
       FROM factory_node_runs
      WHERE output_schema=? AND output_ref=? AND output_hash=?
        AND status='completed'
      LIMIT 1`,
  );
  const assemblerProductRepo = {
    getByProductRef: (ref: ProductRef) => {
      const product = workplaceProductPort.readProduct(ref);
      if (product !== null) {
        return {
          productRef: {
            schemaId: product.schema,
            ref: ref.ref,
            digest: product.contentHash,
          },
          payload: product.content,
        };
      }

      const nodeProduction = lookupProduction.get(
        ref.schemaId,
        ref.ref,
        ref.digest,
      ) as {
        schema: string | null;
        ref: string | null;
        hash: string | null;
        bindingsText: string | null;
      } | undefined;
      if (
        nodeProduction === undefined
        || nodeProduction.schema === null
        || nodeProduction.ref === null
        || nodeProduction.hash === null
      ) {
        if (ref.schemaId === 'factory.recovery-feedback.v1') {
          try {
            const recoveryRow = db.prepare(
              `SELECT feedback_snapshot, feedback_hash
                 FROM factory_recovery_attempts
                WHERE issue_ref=?
                ORDER BY attempt DESC
                LIMIT 1`,
            ).get(ref.ref) as {
              feedback_snapshot: string;
              feedback_hash: string;
            } | undefined;
            if (recoveryRow) {
              return {
                productRef: ref,
                payload: {
                  schema: ref.schemaId,
                  artifactRef: ref.ref,
                  contentHash: recoveryRow.feedback_hash,
                  bindings: JSON.parse(
                    recoveryRow.feedback_snapshot || '{}',
                  ),
                },
              };
            }
          } catch {
            // Legacy FlowRecovery compatibility is removed once no installed
            // module declares FlowDefinition.recovery.
          }
        }
        return null;
      }

      const bindings = nodeProduction.bindingsText
        ? JSON.parse(nodeProduction.bindingsText)
        : {};
      return {
        productRef: {
          schemaId: nodeProduction.schema,
          ref: nodeProduction.ref,
          digest: nodeProduction.hash,
        },
        payload: {
          schema: nodeProduction.schema,
          artifactRef: nodeProduction.ref,
          contentHash: nodeProduction.hash,
          bindings,
        },
      };
    },
  };

  const packageInstallation = options.packageInstallation;
  const resolvePackagePin = (moduleName: string): {
    packageIdentity: { name: string; version: string };
    installedDigest: string;
    flowIdentity: { flowId: string; flowVersion: string };
  } | null => {
    if (!packageInstallation) return null;
    const record = packageInstallation.records.get(moduleName);
    if (!record) return null;
    return {
      packageIdentity: { name: moduleName, version: record.version },
      installedDigest: record.packageDigest,
      flowIdentity: { flowId: moduleName, flowVersion: record.version },
    };
  };
  const executorV2Options = { productRepo: assemblerProductRepo, resolvePackagePin };

  const runtimePersistence = options.discoveryRuntimePersistence
    ?? new SqliteFactoryDiscoveryRuntime();
  const productionCellProjectionPersistence =
    createSqliteProductionCellProjectionPersistence(db);
  const managedNodeSubmissions =
    new SqliteManagedNodeSubmissionRepository(db);
  const centralLedger = new SqliteManagedProductionLedger(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const gateRepo = new SqliteGateRepository(db);
  const finalAcceptance = new SqliteCellFinalAcceptance(db);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const authorityHeadRepo = new SqliteAcceptedAuthorityHeadRepository(db);
  const productionCellCoordinator = new ProductionCellCoordinator({
    db,
    workplaceRepo,
    authorityHeadRepo,
    now: () => new Date(),
  });

  registerWorkshopPostAcceptanceEffect(
    createGitIntegrationEffect(
      new SqliteProductionCellIntegration(db, authorityHeadRepo),
      new SqliteExternalEffectLedger(db),
    ),
  );
  registerWorkshopPostAcceptanceEffect(createReplayCaptureEffect(db));

  const resolveNodeProducts = (
    processRunId: number,
    moduleRef: string,
    nodeId: string,
  ): NodeProducts | null => {
    const artifacts = centralLedger.listArtifactsForNodeInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
    );
    const traces = centralLedger.listTracesForNodeInProcessRun(
      processRunId,
      moduleRef,
      nodeId,
    );
    const submission = managedNodeSubmissions.readLatestForNode(
      processRunId,
      moduleRef,
      nodeId,
    );
    if (artifacts.length === 0 && traces.length === 0 && submission === null) {
      return null;
    }
    return {
      artifacts: artifacts
        .filter((artifact): artifact is typeof artifact & { contentHash: string } =>
          artifact.contentHash !== null)
        .map(artifact => ({
          ledgerId: artifact.ledgerId,
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          artifactStatus: artifact.artifactStatus,
          contentHash: artifact.contentHash,
          operation: artifact.operation,
        })),
      traces: traces.map(trace => ({
        ledgerId: trace.ledgerId,
        traceId: trace.traceId,
        sourceId: trace.sourceId,
        targetType: trace.targetType,
        targetId: trace.targetId,
        linkType: trace.linkType,
        traceHash: trace.traceHash,
      })),
      submission,
    };
  };

  const kernelHandlers = new KernelHandlerRegistry();
  kernelHandlers.register(
    PROCESS_OUTCOME_EMITTER_HANDLER_ID,
    processOutcomeEmitter,
  );
  const humanInteractions = new HumanInteractionRegistry();
  const moduleRegistry = new ProcessModuleRegistry();
  const installationRegistry = new ProcessModuleInstallationRegistry({
    kernelHandlerRegistry: kernelHandlers,
    humanInteractionRegistry: humanInteractions,
  });

  // ADR-053 Phase 8 — durable transition obligation substrate. Records
  // crash-recoverable handoffs (CandidateSetSealed→RunGate→RunEffects→
  // RecordFinalAcceptance→SettleProcess→RouteLifecycle) in the obligation
  // ledger so a fenced reconciler can redrive them after crash.
  const obligationLedger = new SqliteTransitionObligationLedger(db);
  const obligationIntegrator = new TransitionObligationIntegrator({ ledger: obligationLedger });

  // ADR-081 (K12) — the ONE proof-backed acceptance mutation service.
  const authorityCommit = new CommitAcceptedCandidate({
    gateRepo,
    coordinator: productionCellCoordinator,
  });

  const nodeExecutors = new Map<string, NodeExecutor>([
    ['kernel', new KernelNodeExecutor(kernelHandlers)],
    ['human', new HumanNodeExecutor(humanInteractions)],
    ['production-cell', new ProductionCellNodeExecutor({
      db,
      // RE-PLAN CYCLE (REPLAN-CYCLE-TZ §6) — cap (2 cycles per case lineage)
      // + monotonic ratchet, backed by the append-only mandate ledger.
      replanCyclePolicy: new SqliteReplanMandateLedger(db),
      coordinator: productionCellCoordinator,
      authorityCommit,
      candidateSetRepo,
      gateRepo,
      checkProviders: createStandardCheckProviderRegistry(),
      postAcceptanceEffects: createPostAcceptanceEffectRegistry(),
      finalAcceptance,
      authorityHead: authorityHeadRepo,
      authorCandidateCarryForward: new SqliteAuthorCandidateCarryForward(db),
      persistence: {
        ...productionCellProjectionPersistence,
        readAuthorSemanticDigestForWorkplace: (serializedWorkplaceRef: string): string | null => {
          const row = db.prepare(
            `SELECT t.metadata
               FROM factory_accepted_authority_head h
               JOIN tasks t
                 ON CAST(t.id AS TEXT)=h.accepted_author_task_id
                AND t.workplace_ref=h.workplace_ref
              WHERE h.workplace_ref=?`,
          ).get(serializedWorkplaceRef) as { metadata: string } | undefined;
          if (!row?.metadata) return null;
          try {
            const meta = JSON.parse(row.metadata);
            const sid = meta?.semantic_input_digest;
            return typeof sid === 'string' && sid ? sid : null;
          } catch {
            return null;
          }
        },
        activateRoleTask: ({
          taskId,
          intentId,
          workplaceRef,
          role,
          executionProfileId,
        }) => {
          const workplace = serializeWorkplaceRef(workplaceRef);
          activateProductionCellRoleTask(db, {
            taskId,
            intentId,
            workplaceRef: workplace,
            role,
            executionProfileId,
          });
        },
        concludeExecutionIntent: (executionRef) => {
          db.prepare(
            `UPDATE factory_work_intents
                SET status='concluded', updated_at=datetime('now')
              WHERE projected_task_id=(
                SELECT task_id FROM worker_executions WHERE execution_id=?
              ) AND status IN ('open','executing','paused')`,
          ).run(executionRef);
        },
        readExecutionReceipt: (executionRef) => {
          const row = db.prepare(
            `SELECT we.task_id AS taskId, wi.id AS intentId
               FROM worker_executions we
               JOIN factory_work_intents wi ON wi.projected_task_id=we.task_id
              WHERE we.execution_id=?`,
          ).get(executionRef) as { taskId: number; intentId: number } | undefined;
          return row ?? null;
        },
        readSubmissionValidationReceipts: (executionRef) => {
          const rows = db.prepare(
            `SELECT id AS receiptId,validator_id AS validatorId,
                    validator_version AS validatorVersion,
                    process_run_id AS processRunId,module_ref AS moduleRef,
                    node_id AS nodeId,input_snapshot_hash AS inputSnapshotHash,
                    artifact_ids AS artifactIds,trace_ids AS traceIds,
                    artifact_hashes AS artifactHashes,trace_digest AS traceDigest,
                    contract_ref AS contractRef,
                    validated_set_digest AS validatedSetDigest
               FROM factory_submission_validation_receipts
              WHERE execution_id=?
              ORDER BY id`,
          ).all(executionRef) as Array<Record<string, unknown>>;
          return rows.map(row => ({
            receiptId: Number(row.receiptId),
            validatorId: String(row.validatorId),
            validatorVersion: String(row.validatorVersion),
            processRunId: Number(row.processRunId),
            moduleRef: String(row.moduleRef),
            nodeId: String(row.nodeId),
            inputSnapshotHash: String(row.inputSnapshotHash),
            artifactIds: JSON.parse(String(row.artifactIds)) as number[],
            traceIds: JSON.parse(String(row.traceIds)) as number[],
            artifactHashes: JSON.parse(String(row.artifactHashes)) as Record<string, string>,
            traceDigest: String(row.traceDigest),
            contractRef: row.contractRef === null
              ? null
              : JSON.parse(String(row.contractRef)) as { version: string; digest: string },
            validatedSetDigest: String(row.validatedSetDigest),
          }));
        },
        readProcessInputHash: (processRunId) => {
          const row = db.prepare(
            'SELECT input_hash FROM factory_process_runs WHERE id=?',
          ).get(processRunId) as { input_hash: string } | undefined;
          if (!row) throw new Error(`PROCESS_RUN_NOT_FOUND: ${processRunId}`);
          return row.input_hash;
        },
        readTrustedProviders: (projectId) => db.prepare(
          `SELECT id AS providerId,name,version,category
             FROM trusted_providers
            WHERE status='active' AND (project_id=? OR project_id IS NULL)
            ORDER BY project_id IS NOT NULL DESC,id`,
        ).all(projectId) as Array<{
          providerId: number;
          name: string;
          version: string | null;
          category: string;
        }>,
        projectWorkplace: (workplaceRef) => {
          const workplace = serializeWorkplaceRef(workplaceRef);
          const state = db.prepare(
            `SELECT kanban_phase,loop_state,next_role
               FROM factory_workplaces WHERE workplace_ref=?`,
          ).get(workplace) as { kanban_phase: string; loop_state: string; next_role: string } | undefined;
          if (!state) throw new Error(`WORKPLACE_NOT_FOUND: ${workplace}`);
          if (state.loop_state === 'terminal') {
            const taskIds = (db.prepare(
              'SELECT id FROM tasks WHERE workplace_ref=?',
            ).all(workplace) as Array<{ id: number }>).map(row => row.id);
            completeProductionCellTaskProjections(db, workplace);
            for (const taskId of taskIds) reevaluateDownstream(db, taskId);
          }
        },
        // Keep the crash-attempt accounting added on saga4. A process that
        // dies before CandidateSet seal still consumes the cell recovery budget.
        readTaskForWorkplace: (workplaceRef) => {
          const serialized = serializeWorkplaceRef(workplaceRef);
          const row = db.prepare(
            'SELECT id AS taskId FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
          ).get(serialized) as { taskId: number } | undefined;
          return row ?? null;
        },
        // BLINDSIGHT C6 — durable reviewer round history for the reviewer
        // projection: the round number, prior verdicts and rejected author
        // candidates ride the reviewer objective into the worker prompt.
        readReviewerRoundHistory: (workplaceRef) =>
          readReviewerRoundHistorySql(db, serializeWorkplaceRef(workplaceRef)),
        countTerminalExecutionsForTask: (taskId) => countTerminalExecutionsForTask(db, taskId),
        // Fix-3 — an ACCEPTED CandidateSet must not consume recovery budget.
        countGateRejectedCandidateSets: (workplaceRef, role) =>
          countGateRejectedCandidateSetsSql(
            db, serializeWorkplaceRef(workplaceRef), role,
          ),
        // Fix-1 — decoded findings of the last repair_required decision, used
        // as the RECOVERY_BUDGET_EXHAUSTED park reason.
        readLastRepairRequiredDiagnosis: (workplaceRef, role) =>
          readLastRepairRequiredDiagnosisSql(
            db, serializeWorkplaceRef(workplaceRef), role,
          ),
        // Fix-3 companion (QA-E16) — failed effect actions bound the
        // accept → effect-fail → repair cycle now that accepted attempts
        // no longer consume budget.
        countFailedAcceptanceEffectRepairs: (workplaceRef) =>
          countFailedAcceptanceEffectRepairsSql(
            db, serializeWorkplaceRef(workplaceRef),
          ),
        // ADR-075 — latest recovery-epoch rollover for the (workplace, role):
        // counter baselines plus the inter-epoch backoff deadline derived from
        // the immutable row's created_at (SQLite datetime('now') is UTC) and
        // the epoch's exponential delay.
        readRecoveryEpochBaseline: (workplaceRef, role) => {
          const row = db.prepare(
            `SELECT epoch, baseline_rejected_sets, baseline_terminal_executions,
                    baseline_effect_repairs, created_at
               FROM factory_workplace_recovery_epochs
              WHERE workplace_ref=? AND role=?
              ORDER BY epoch DESC LIMIT 1`,
          ).get(serializeWorkplaceRef(workplaceRef), role) as {
            epoch: number;
            baseline_rejected_sets: number;
            baseline_terminal_executions: number;
            baseline_effect_repairs: number;
            created_at: string;
          } | undefined;
          if (!row) return null;
          return {
            epoch: row.epoch,
            baselineRejectedSets: row.baseline_rejected_sets,
            baselineTerminalExecutions: row.baseline_terminal_executions,
            baselineEffectRepairs: row.baseline_effect_repairs,
            rolledBackoffUntilMs:
              Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
              + recoveryEpochBackoffMs(row.epoch),
          };
        },
        // ADR-075 — append one immutable rollover row; idempotent by the
        // UNIQUE (workplace_ref, role, epoch) constraint.
        recordRecoveryEpoch: (input) => {
          db.prepare(
            `INSERT OR IGNORE INTO factory_workplace_recovery_epochs
               (workplace_ref, role, epoch,
                baseline_rejected_sets, baseline_terminal_executions,
                baseline_effect_repairs, exhausted_attempts,
                max_attempts, total_attempts_cap, last_diagnosis)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            serializeWorkplaceRef(input.workplaceRef),
            input.role,
            input.epoch,
            input.baselineRejectedSets,
            input.baselineTerminalExecutions,
            input.baselineEffectRepairs,
            input.exhaustedAttempts,
            input.maxAttempts,
            input.totalAttemptsCap,
            input.lastDiagnosis,
          );
        },
      } as ProductionCellProjectionPersistence,
      productReader: {
        readContributionProducts: ({ processRunId, moduleRef, nodeId, contributorRef, expectedSchemaRefs }) => {
          // Select exactly one physical ingress from the immutable WorkIntent.
          // Never probe typed rows and fall back to the managed desk: that would
          // let incidental storage chronology choose accepted material.
          const executionContext = db.prepare(
            `SELECT t.workplace_ref AS workplaceRef
               FROM worker_executions we
               JOIN tasks t ON t.id=we.task_id
              WHERE we.execution_id=?`,
          ).get(contributorRef) as {
            workplaceRef: string | null;
          } | undefined;
          if (!executionContext?.workplaceRef) {
            throw new Error(
              `WORKPLACE_PRODUCT_CONTEXT_MISSING: contributor ${contributorRef} has no workplace_ref`,
            );
          }
          const workplaceRef = deserializeWorkplaceRef(executionContext.workplaceRef);
          if (
            workplaceRef.processRunId !== processRunId
            || workplaceRef.moduleRef !== moduleRef
          ) {
            throw new Error(
              `WORKPLACE_PRODUCT_CONTEXT_MISMATCH: ${executionContext.workplaceRef}`,
            );
          }
          const ingressMode = readFrozenProductionIngress(db, contributorRef).mode;
          if (ingressMode === 'typed-submission') {
            const submission = db.prepare(
              `SELECT id,schema_version,content_hash
                 FROM factory_managed_node_submissions
                WHERE process_run_id=? AND module_ref=? AND node_id=? AND execution_id=?
                ORDER BY id DESC LIMIT 1`,
            ).get(processRunId, moduleRef, nodeId, contributorRef) as
              | { id: number; schema_version: string; content_hash: string }
              | undefined;
            return submission ? [{
              schemaId: submission.schema_version,
              ref: `managed-node-submission:${submission.id}`,
              digest: submission.content_hash,
            }] : [];
          }

          // Managed material is frozen atomically with accepted worker_done.
          // Never reread the mutable Workplace desk at CandidateSet seal time.
          const frozen = readManagedCompletionProducts(db, contributorRef);
          const expected = [...new Set(expectedSchemaRefs.filter(Boolean))].sort();
          const actual = frozen.map(product => product.schemaId).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
              `MANAGED_COMPLETION_PRODUCT_SET_MISMATCH: ${contributorRef}; `
              + `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
            );
          }
          return frozen;
        },
        readContributionProductPayload: (productRef) => {
          if (productRef.ref.startsWith('managed-node-submission:')) {
            const id = Number(productRef.ref.slice('managed-node-submission:'.length));
            if (!Number.isSafeInteger(id) || id < 1) {
              throw new Error(`PRODUCT_INGRESS_REF_INVALID: ${productRef.ref}`);
            }
            const row = db.prepare(
              `SELECT payload_snapshot FROM factory_managed_node_submissions
                WHERE id=? AND schema_version=? AND content_hash=?`,
            ).get(id, productRef.schemaId, productRef.digest) as {
              payload_snapshot: string;
            } | undefined;
            if (!row) throw new Error(`PRODUCT_INGRESS_NOT_FOUND: ${productRef.ref}`);
            const payload = JSON.parse(row.payload_snapshot) as unknown;
            if (sha256Hex(payload) !== productRef.digest) {
              throw new Error(`PRODUCT_INGRESS_DIGEST_MISMATCH: ${productRef.ref}`);
            }
            return payload;
          }
          const product = workplaceProductPort.readProduct(productRef);
          if (!product || product.contentHash !== productRef.digest) {
            throw new Error(`PRODUCT_INGRESS_NOT_FOUND: ${productRef.ref}`);
          }
          return product.content;
        },
      } as ProductionCellProductReader,
      resolveInstallationDigest: moduleName =>
        packageInstallation?.records.get(moduleName)?.packageDigest ?? 'factory-runtime',
      resolveProductSemanticDigest: (productRef) => {
        const content = processProductRepoV2.getByProductRef(productRef);
        if (!content) return null;
        if (!isWorkplaceProductionSnapshot(content.payload)) return null;
        return workplaceProductionSemanticDigest(content.payload);
      },
      // ADR-053 Phase 5 — revision repository so CandidateSet seals carry a
      // productionRevisionRef (the immutable material authority).
      revisionRepo: new SqliteWorkplaceProductionRevisionRepository(db),
      sealedProductMaterials,
      // ADR-053 Phase 8 — obligation integrator for durable transition handoffs.
      obligationIntegrator,
    })],
  ]);
  nodeExecutors.set('lm', nodeExecutors.get('production-cell')!);

  const sharedDeps: ModuleSharedDeps = {
    db,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    recoveryCaseRepo,
    managedNodeSubmissions,
    processProductRepo,
    nodeExecutors,
    resolveNodeProducts,
    executorV2Options,
    runtimePersistence,
    candidateSetRepo,
    gateRepo,
    workplaceProductPort,
    adoptedNodeResults: new SqliteResumeDirectiveRepository(db),
    transitionObligations: obligationIntegrator,

    onWorkplaceVerified: (processRunId, repairNodeId) => {
      const generationKey =
        `process-run:${processRunId}:node:${repairNodeId}`;
      const taskRow = db.prepare(
        `SELECT id
           FROM tasks
          WHERE generation_key=?
            AND current_execution_id IS NULL
            AND status IN (
              'todo','in_progress','review','review_in_progress','done'
            )
          ORDER BY id DESC
          LIMIT 1`,
      ).get(generationKey) as { id: number } | undefined;
      if (taskRow) promoteTaskToDone(db, taskRow.id);
    },
  };
  const registries: ModuleRegistries = {
    kernelHandlers,
    humanInteractions,
    moduleRegistry,
    installationRegistry,
  };

  // ADR-053 Phase 1: install payload contracts from the single workshop
  // capability manifest BEFORE module registration. Both the orchestrator and
  // the worker MCP derive payload contracts from the same
  // `WORKSHOP_PAYLOAD_CONTRACTS` source — there is no hand-list to drift.
  installWorkshopPayloadContracts();

  const discoveryExecutor = registerDiscovery(registries, sharedDeps);
  const formalization = registerFormalization(registries, sharedDeps);
  const development = registerDevelopment(
    registries,
    sharedDeps,
    options.development ?? {},
  );
  const delivery = registerDelivery(
    registries,
    sharedDeps,
    options.delivery,
  );

  const resolversBySchema = new Map<string, ResolveStageOutputPayload>([
    [
      DISCOVERY_PROPOSAL_SCHEMA,
      createDiscoveryLifecycleOutputPayloadResolver(db),
    ],
    [
      SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
      createFormalizationLifecycleOutputPayloadResolver(
        formalization.solutionContractRepository,
      ),
    ],
    [
      VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      createDevelopmentOutputPayloadResolver(development.outputRepository, [
        DEVELOPMENT_PROCESS_MODULE_REF,
        DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
        DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
      ]),
    ],
    [
      RELEASE_RECORD_SCHEMA,
      createDeliveryOutputPayloadResolver(delivery.outputRepository),
    ],
  ]);
  const resolveOutputPayload: ResolveStageOutputPayload = async params => {
    const resolver = resolversBySchema.get(params.output.schema);
    if (!resolver) {
      throw new Error(
        `no output payload resolver for schema ${params.output.schema}`,
      );
    }
    return resolver(params);
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    onLifecycleStarted: options.onLifecycleStarted,
    processRunRepo,
    moduleRegistry,
    installationRegistry,
    resolveOutputPayload,
    resolveStageInput: ({ lifecycleRun, stage, input }) =>
      resolveProductDeliveryStageInput(db, {
        projectId: lifecycleRun.projectId,
        stage,
        input,
      }),
    resolveInheritedStageFrame: lifecycleRun =>
      lifecycleContinuationRepo.readInheritedStageFrame(lifecycleRun.id),
    transitionObligations: obligationIntegrator,
    ...(packageInstallation
      ? {
        resolveModuleInstallation: (moduleRef: {
          name: string;
          version: string;
        }) => {
          const record = packageInstallation.records.get(moduleRef.name);
          if (!record) {
            engineLog(
              `[factory] resolveModuleInstallation: no record for '${moduleRef.name}'. `
              + `Available: ${[...packageInstallation.records.keys()].join(', ')}`,
            );
            return null;
          }
          return {
            installationId: record.id,
            packageDigest: record.packageDigest,
          };
        },
      }
      : {
        resolveModuleInstallation: () => {
          engineLog(
            '[factory] resolveModuleInstallation: packageInstallation is undefined/null',
          );
          return null;
        },
      }),
  });

  const baseEngine = new LifecycleOrchestrationEngineAdapter({
    definition: productBuildLifecycle,
    orchestrator,
    resolveDefinition(command, input) {
      const row = readPinnedLifecycleByInvocation(
        db,
        command.projectId,
        input.idempotencyKey,
      );
      if (!row) return productBuildLifecycle;
      return JSON.parse(row.definition_snapshot) as typeof productDeliveryLifecycle;
    },
    resolveInput(command) {
      let lifecycleInput = command.lifecycleInput;
      let pinnedReplay = false;
      if (lifecycleInput === undefined) {
        if (!command.resumePaused) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: pass RunEpisodeCommand.lifecycleInput',
          );
        }
        const idempotencyKey = command.idempotencyKey
          ?? `product-delivery:epic:${command.epicId}`;
        const existing = readPinnedLifecycleByInvocation(
          db,
          command.projectId,
          idempotencyKey,
        );
        if (!existing || existing.inputSnapshot === null) {
          throw new Error(
            'PRODUCT_LIFECYCLE_INPUT_REQUIRED: resume launch was requested but no durable '
            + `LifecycleRun input is persisted for idempotency key '${idempotencyKey}'`,
          );
        }
        lifecycleInput = JSON.parse(existing.inputSnapshot) as unknown;
        pinnedReplay = true;
      }

      const schema = command.lifecycleInputSchema
        ?? PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA;
      if (schema !== PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA) {
        throw new Error(
          `PRODUCT_LIFECYCLE_INPUT_SCHEMA_MISMATCH: expected `
          + `'${PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA}', got '${schema}'`,
        );
      }
      assertProductDeliveryLifecycleInput(
        lifecycleInput,
        lifecycleInputPolicyValidation,
      );
      const portableInput = pinnedReplay
        ? lifecycleInput as Parameters<typeof canonicalizeProductDeliveryLifecycleInput>[2]
        : canonicalizeProductDeliveryLifecycleInput(
            db,
            command.projectId,
            lifecycleInput,
          );
      resolveProductDeliveryRepositories(
        db,
        command.projectId,
        portableInput.development.repositories,
      );
      return {
        schema,
        payload: portableInput,
        initiatedBy:
          command.initiatedBy
          ?? (pinnedReplay
            ? readPinnedLifecycleByInvocation(
                db,
                command.projectId,
                command.idempotencyKey
                  ?? `product-delivery:epic:${command.epicId}`,
              )?.initiatedBy
            : undefined)
          ?? 'product-lifecycle-orchestrator',
        idempotencyKey:
          command.idempotencyKey
          ?? `product-delivery:project:${command.projectId}:start:${randomUUID()}`,
        resumePaused: command.resumePaused,
      };
    },
  });

  // ADR-053 B-8: the reconciler is part of the canonical production engine,
  // not a test-only/bootstrap utility. Each leased handoff re-drives the same
  // idempotent lifecycle episode for the exact ProcessRun that produced the
  // source fact. The node/lifecycle guards admit the transition only while the
  // obligation is `in_progress` under this reconciler lease.
  const obligationReconciler = new TransitionObligationReconciler(
    obligationLedger,
    (line: string) => engineLog(`[obligation-reconciler] ${line}`),
  );
  // K13 (card commit 3) — the completion receipt cites the EXACT durable row
  // identity where one exists. Today that is the FinalAcceptance row digest
  // (`cell-final-acceptance:<sha256>`) for the record-final-acceptance
  // handoff — the card's replacement of the fabricated alias. The remaining
  // kinds still carry the `transition-completion:<key>` alias; that residue
  // is the same defect class and is reported, not silently generalized
  // (stage-9 escalation rule).
  const exactCompletionReceipt = (obligation: TransitionObligation): string => {
    const exact = readExactCompletionReceipt(db, obligation);
    if (obligation.handoffKind === 'record-final-acceptance' && exact === null) {
      throw new Error(
        `FINAL_ACCEPTANCE_RECEIPT_UNRESOLVED: ${obligation.obligationKey} — the `
        + 'postcondition is satisfied yet no FinalAcceptance row matches the '
        + 'exact effect receipt',
      );
    }
    return exact ?? `transition-completion:${obligation.obligationKey}`;
  };
  for (const handoffKind of [
    'close-presentation',
    'run-gate',
    'run-effects',
    'record-final-acceptance',
    'route-lifecycle',
  ] as const) {
    const ownerCapability = handoffKind === 'close-presentation'
      ? 'presentation-closure'
      : handoffKind === 'run-gate'
      ? 'gate-run-driver'
      : handoffKind === 'route-lifecycle'
        ? 'lifecycle-orchestrator'
        : 'production-cell-node-executor';
    assertWorkshopTransitionHandlerBinding({ handoffKind, ownerCapability });
    const handler: TransitionObligationHandler = {
      handoffKind,
      async execute(obligation) {
        if (handoffKind === 'close-presentation') {
          const closed = closeCommittedTypedPresentation(db, obligation.sourceRef);
          return {
            completionReceipt: closed.receiptRef,
            resultDigest: sha256Hex({
              obligationKey: obligation.obligationKey,
              commitmentRef: closed.commitment.commitmentRef,
              productRef: closed.commitment.productRef,
              productDigest: closed.commitment.productDigest,
            }),
          };
        }
        // A crash may happen after the handler durably applied its transition
        // but before the obligation ledger recorded completion. Prove the
        // exact postcondition before invoking the handler again; external
        // post-acceptance effects must never be repeated merely to obtain an
        // obligation receipt.
        const existingPostcondition = readTransitionHandoffPostcondition(db, obligation);
        if (existingPostcondition.satisfied) {
          return {
            completionReceipt: exactCompletionReceipt(obligation),
            resultDigest: sha256Hex({
              obligationKey: obligation.obligationKey,
              recoveredFromDurablePostcondition: true,
            }),
          };
        }
        const command = transitionRedriveCommand(db, obligation.subjectRef, obligation.sourceRef);
        const result = await baseEngine.run(command);
        const postcondition = readTransitionHandoffPostcondition(db, obligation);
        if (!postcondition.satisfied) {
          return { outcome: 'deferred', reason: postcondition.reason };
        }
        return {
          completionReceipt: exactCompletionReceipt(obligation),
          resultDigest: sha256Hex({
            obligationKey: obligation.obligationKey,
            lifecycleRunId: result.lifecycleRun?.id ?? null,
            lifecycleStatus: result.lifecycleRun?.status ?? result.reason,
            terminalStatus: result.lifecycleRun?.terminalStatus ?? null,
          }),
        };
      },
    };
    obligationReconciler.registerHandler(handler);
  }
  recordWorkshopBindingReceipt({
    db,
    role: 'orchestrator',
    processIdentity: `orchestrator:${process.pid}`,
  });
  // Sweep observability: any sweep that completes or fails obligations is
  // logged in full; a defer-only sweep is logged once per DEFER_STREAK_PERIOD
  // sweeps so a livelocking obligation stays visible without flooding the
  // engine log once per second.
  let deferOnlySweeps = 0;
  // CONVEYOR §23 progress-obligation invariant. A defer-only streak proves an
  // obligation is waiting; it says NOTHING about a scope that has no obligation
  // at all. That is the dangerous case: the Workplace holds a nonterminal loop
  // state, nothing owns its next mutation, and the node simply re-enters
  // forever (observed: 9004 runtime.paused NodeRuns, zero pending obligations).
  // Every PROGRESS_SWEEP_PERIOD episodes we classify each nonterminal scope and
  // surface the ones that cannot prove they will still move. Reported once per
  // scope per classification change, so a persistent stall stays visible
  // without flooding the log.
  const PROGRESS_SWEEP_PERIOD = 30;
  let episodesSinceProgressSweep = 0;
  const reportedProgress = new Map<string, string>();
  const sweepProgressInvariant = (): void => {
    episodesSinceProgressSweep += 1;
    if (episodesSinceProgressSweep < PROGRESS_SWEEP_PERIOD) return;
    episodesSinceProgressSweep = 0;
    let unhealthy: readonly ProgressExplanation[];
    try {
      unhealthy = findStalledScopes(db);
    } catch (error) {
      // Diagnostics must never break the engine loop.
      engineLog(
        `[progress-invariant] classification failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const live = new Set<string>();
    for (const scope of unhealthy) {
      live.add(scope.scopeRef);
      const already = reportedProgress.get(scope.scopeRef) === scope.classification;
      journalEvent('invariant.classification', {
        workplace_ref: scope.scopeKind === 'workplace' ? scope.scopeRef : undefined,
      }, {
        scope_kind: scope.scopeKind,
        scope_ref: scope.scopeRef,
        classification: scope.classification,
        reason: scope.reason,
        evidence: scope.evidence,
        deduped: already,
      });
      if (already) continue;
      reportedProgress.set(scope.scopeRef, scope.classification);
      engineLog(
        `[progress-invariant] ${scope.classification.toUpperCase()} `
        + `${scope.scopeKind}=${scope.scopeRef} :: ${scope.reason}`
        + (scope.evidence.length ? ` [evidence: ${scope.evidence.join(', ')}]` : ''),
      );
    }
    for (const scopeRef of [...reportedProgress.keys()]) {
      if (live.has(scopeRef)) continue;
      reportedProgress.delete(scopeRef);
      journalEvent('invariant.recovered', {
        workplace_ref: scopeRef,
      });
      engineLog(`[progress-invariant] RECOVERED workplace=${scopeRef}`);
    }
  };
  const engine: OrchestrationEngine = {
    async run(command: RunEpisodeCommand) {
      sweepProgressInvariant();
      const sweep = await obligationReconciler.reconcile({
        leaseOwner: `product-lifecycle:${process.pid}:${randomUUID()}`,
        // One sweep must cover EVERY ready obligation: the engine loop gives
        // up after a bounded number of empty cycles, so an obligation left
        // outside the batch (starved by older deferring ones) parks the
        // lifecycle in TRANSITION_OBLIGATION_PENDING until a manual restart.
        batchSize: 256,
      });
      const DEFER_STREAK_PERIOD = 60;
      if (sweep.completed > 0 || sweep.failed > 0) {
        deferOnlySweeps = 0;
        engineLog(
          `[obligation-reconciler] sweep dispatched=${sweep.dispatched} `
          + `completed=${sweep.completed} failed=${sweep.failed} `
          + `deferred=${sweep.deferred} skipped=${sweep.skipped}`,
        );
      } else if (sweep.deferred > 0) {
        deferOnlySweeps += 1;
        if (deferOnlySweeps === 1 || deferOnlySweeps % DEFER_STREAK_PERIOD === 0) {
          engineLog(
            `[obligation-reconciler] defer-only streak=${deferOnlySweeps} `
            + `deferred=${sweep.deferred} — obligations are waiting on their `
            + `postconditions; see the DEFER lines above`,
          );
        }
      }
      return baseEngine.run(command);
    },
  };

  return {
    engine,
    orchestrator,
    moduleRegistry,
    installationRegistry,
    resolveOutputPayload,
    kernelHandlers,
    humanInteractions,
    executors: {
      discovery: discoveryExecutor,
      formalization: formalization.executor,
      development: development.executor,
      delivery: delivery.executor,
    },
    packageInstallation,
    runtimes: {
      development: development.graph,
      delivery: delivery.runtime,
    },
    interactions: {
      deliveryApprovalInbox: delivery.approvalInbox,
    },
    repositories: {
      processRunRepo,
      nodeRunRepo,
      certificateRepo,
      lifecycleRunRepo,
      lifecycleContinuationRepo,
      managedNodeSubmissions,
      formalizationBaselineRepository: formalization.baselineRepository,
      formalizationSolutionContractRepository:
        formalization.solutionContractRepository,
      developmentOutputRepository: development.outputRepository,
      deliveryOutputRepository: delivery.outputRepository,
    },
  };
}

function transitionRedriveCommand(
  db: Database.Database,
  subjectRef: string,
  sourceRef: string,
): RunEpisodeCommand {
  const processRunId = subjectRef.startsWith('workplace/')
    ? deserializeWorkplaceRef(subjectRef).processRunId
    : Number((subjectRef.startsWith('process-run:') ? subjectRef : sourceRef).replace('process-run:', ''));
  if (!Number.isSafeInteger(processRunId) || processRunId <= 0) {
    throw new Error(`TRANSITION_OBLIGATION_PROCESS_REF_INVALID: ${subjectRef}`);
  }
  const row = db.prepare(
    `SELECT lr.project_id AS projectId,
            lr.epic_id AS epicId,
            lr.idempotency_key AS idempotencyKey,
            lr.initiated_by AS initiatedBy
       FROM factory_stage_runs sr
       JOIN factory_lifecycle_runs lr ON lr.id=sr.lifecycle_run_id
      WHERE sr.process_run_id=?`,
  ).get(processRunId) as {
    projectId: number;
    epicId: number | null;
    idempotencyKey: string;
    initiatedBy: string;
  } | undefined;
  if (!row || row.epicId === null) {
    throw new Error(`TRANSITION_OBLIGATION_LIFECYCLE_NOT_FOUND: process-run:${processRunId}`);
  }
  return {
    projectId: row.projectId,
    epicId: row.epicId,
    idempotencyKey: row.idempotencyKey,
    initiatedBy: row.initiatedBy,
    resumePaused: true,
  };
}

function readPinnedLifecycleByInvocation(
  db: Database.Database,
  projectId: number,
  idempotencyKey: string,
): {
  inputSnapshot: string;
  definition_snapshot: string;
  initiatedBy: string;
} | null {
  const rows = db.prepare(
    `SELECT input_snapshot AS inputSnapshot,definition_snapshot,
            initiated_by AS initiatedBy
       FROM factory_lifecycle_runs
      WHERE project_id=? AND idempotency_key=?`,
  ).all(projectId, idempotencyKey) as Array<{
    inputSnapshot: string;
    definition_snapshot: string;
    initiatedBy: string;
  }>;
  if (rows.length > 1) {
    throw new Error(
      `LIFECYCLE_INVOCATION_AMBIGUOUS: project ${projectId} idempotency '${idempotencyKey}'`,
    );
  }
  return rows[0] ?? null;
}

function assertCompositionDependencies(
  options: ProductLifecycleRuntimeOptions,
): void {
  const missing: string[] = [];
  if (!options.delivery) missing.push('delivery');
  if (!options.workerExecutorFactory) missing.push('workerExecutorFactory');
  if (!options.resolveWorkerContext) missing.push('resolveWorkerContext');
  if (missing.length > 0) {
    throw new Error(
      `PRODUCT_LIFECYCLE_COMPOSITION_INCOMPLETE: ${missing.join(', ')}`,
    );
  }
}
