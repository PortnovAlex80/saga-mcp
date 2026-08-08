/**
 * Workplace-native Production Cell reconciler.
 *
 * This executor does not assign, launch, poll, stop, or supervise workers. It
 * materializes deterministic Workplaces, projects desks, seals CandidateSets,
 * drives GateRuns and applies durable GateDecisions. All workshop-specific
 * quality checks and post-acceptance effects are resolved from registries by
 * opaque ids declared in the installed cell definition.
 */

import { createHash } from 'node:crypto';

import type {
  ExecutionProfileDefinition,
  ProductionCellFlowNodeDefinition,
} from '../../domain/process-module.js';
import type { ProductRef } from '../../domain/spi/index.js';
import {
  assertValidProductionCellDefinition,
  asWorkplaceRef,
  serializeWorkplaceRef,
  type CandidateMember,
  type CandidateSet,
  type ProductionCellDefinition,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../domain/workplace/index.js';
import type { SqliteCandidateSetRepository } from '../../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type { SqliteGateRepository } from '../../../infrastructure/workplace/sqlite-gate-repository.js';
import {
  driveGateRun,
  type CheckProviderRegistry,
} from '../gate-run-driver.js';
import type { FactoryPostAcceptanceEffectRegistry } from '../post-acceptance-effects.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';
import { ProductionCellCoordinator } from '../production-cell-coordinator.js';
import { deriveWorkKey } from '../../domain/workplace/work-key-deriver.js';
import { sha256Hex } from '../../../shared/canonical-json.js';

export interface ProductionCellProjectionPersistence {
  ensureExecutionPlan(input: {
    intent: {
      epicId: number;
      kind: string;
      objective: string;
      authorityScope: {
        snapshot_ref: string;
        scope: string;
        allowed_tools: string[];
        enforcement: 'runtime';
      };
      outputSchema: string;
      tokenBudget: number;
      retryBudget: number;
    };
    task: {
      epicId: number;
      projectId: number;
      objective: string;
      taskKind: string;
      executionSkill: string;
      reviewSkill?: string | null;
      generationKey: string;
      workflowStage?: string;
      executionMode?: string;
      titlePrefix?: string;
      metadata?: Record<string, unknown>;
      sourceArtifactIds?: readonly number[];
      verificationTargetArtifactId?: number | null;
    };
  }): { intentId: number; taskId: number; replayed: boolean };
  bindProjectedTaskProcessContext?(input: {
    taskId: number;
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    processInputHash: string;
    nodeInput: unknown;
    nodeInputHash: string;
    /** Cross-run-stable semantic input digest (CONVEYOR v4.3 §8). */
    semanticInputDigest: string;
    projectRepositoryId?: number | null;
  }): void;
  readAuthorSemanticDigestForWorkplace?(serializedWorkplaceRef: string): string | null;
  readTaskProjectRepositoryId(taskId: number): number | null;
  readProcessInputHash(processRunId: number): string;
  readTrustedProviders?(projectId: number): readonly {
    providerId: number;
    name: string;
    version: string | null;
    category: string;
  }[];
  activateRoleTask(input: {
    taskId: number;
    intentId: number;
    workplaceRef: WorkplaceRef;
    role: 'author' | 'reviewer';
    executionProfileId: string;
  }): void;
  concludeExecutionIntent(executionRef: string): void;
  readExecutionReceipt(executionRef: string): { intentId: number; taskId: number };
  projectWorkplace(workplaceRef: WorkplaceRef): void;
  bindTaskDependencies?(taskId: number, dependencyTaskIds: readonly number[]): void;
  /**
   * Read the task associated with a workplace (for crash-recovery attempt
   * counting). Optional — when absent, attemptCount falls back to sealed
   * CandidateSet count only.
   */
  readTaskForWorkplace?(workplaceRef: WorkplaceRef): { taskId: number } | null;
  /**
   * Count terminal (lost/terminated/failed) worker executions for a task.
   * Used by crash recovery to prevent infinite crash loops when sealed
   * CandidateSets are absent. Optional — when absent, falls back to sealed
   * CandidateSet count.
   */
  countTerminalExecutionsForTask?(taskId: number): number;
}

export interface ProductionCellProductReader {
  readExecutionProducts(input: {
    processRunId: number;
    moduleRef: string;
    nodeId: string;
    executionRef: string;
    expectedSchemaRefs: readonly string[];
    requireTypedSubmission: boolean;
  }): readonly ProductRef[];
}

export interface ProductionCellNodeExecutorOptions {
  readonly coordinator: ProductionCellCoordinator;
  readonly candidateSetRepo: SqliteCandidateSetRepository;
  readonly gateRepo: SqliteGateRepository;
  readonly checkProviders: CheckProviderRegistry;
  readonly postAcceptanceEffects: FactoryPostAcceptanceEffectRegistry;
  readonly persistence: ProductionCellProjectionPersistence;
  readonly productReader: ProductionCellProductReader;
  readonly resolveInstallationDigest: (moduleName: string) => string;
  readonly resolveProductSemanticDigest?: (productRef: ProductRef) => string | null;
  readonly now?: () => Date;
}

interface MaterializedWorkplace {
  readonly ref: WorkplaceRef;
  readonly workKey: string;
  readonly itemId: string;
  readonly item: unknown;
}

interface ReconcileOutcome {
  readonly pending: boolean;
  readonly paused: boolean;
  readonly accepted: boolean;
  readonly failed: boolean;
  readonly products: readonly ProductRef[];
  readonly candidateSetRef: string | null;
  readonly executionRef: string | null;
}

export class ProductionCellNodeExecutor implements NodeExecutor {
  readonly kind = 'production-cell' as const;

  constructor(private readonly opts: ProductionCellNodeExecutorOptions) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = ctx.node as ProductionCellFlowNodeDefinition;
    const cell = resolveCellDefinition(node);
    assertValidProductionCellDefinition(cell);
    if (ctx.epicId === null) {
      throw new NodeExecutionError(this.kind, node.id, 'Production Cell requires epicId');
    }

    const moduleRef = `${ctx.module.identity.name}@${ctx.module.identity.version}`;
    const workplaces = this.materialize(ctx, node, cell, moduleRef);
    const initialTaskIds = new Map<string, number>();
    for (const workplace of workplaces) {
      const state = this.requireState(workplace.ref);
      if (state.loopState === 'queued' && state.nextRole === 'author') {
        initialTaskIds.set(
          workplace.itemId,
          this.ensureRoleProjection(ctx, node, cell, workplace, state),
        );
      }
    }
    if (cell.materialization.dependencySelector) {
      for (const workplace of workplaces) {
        const taskId = initialTaskIds.get(workplace.itemId);
        if (!taskId) continue;
        const dependencyTaskIds = stringSelector(
          workplace.item,
          cell.materialization.dependencySelector,
        ).map(itemId => initialTaskIds.get(itemId))
          .filter((id): id is number => id !== undefined);
        this.opts.persistence.bindTaskDependencies?.(taskId, dependencyTaskIds);
      }
    }

    const outcomes: ReconcileOutcome[] = [];
    const byItemId = new Map(workplaces.map(workplace => [workplace.itemId, workplace]));
    for (const workplace of workplaces) {
      outcomes.push(await this.reconcile(
        ctx,
        node,
        cell,
        moduleRef,
        workplace,
        byItemId,
        initialTaskIds.has(workplace.itemId),
      ));
    }

    if (outcomes.some(outcome => outcome.paused)) {
      return {
        runtimeEvent: 'paused',
        production: this.manifestProduction(cell, workplaces, outcomes, false),
      };
    }
    if (outcomes.some(outcome => outcome.pending)) {
      return {
        runtimeEvent: 'paused',
        production: this.manifestProduction(cell, workplaces, outcomes, false),
      };
    }
    if (outcomes.some(outcome => outcome.failed)) {
      return {
        runtimeEvent: 'completed',
        domainEvent: 'failed',
        production: this.manifestProduction(cell, workplaces, outcomes, true),
      };
    }

    const acceptedCount = outcomes.filter(outcome => outcome.accepted).length;
    const satisfied = completionSatisfied(cell, acceptedCount, outcomes.length);
    if (!satisfied) {
      throw new NodeExecutionError(
        this.kind,
        node.id,
        `completion policy '${cell.materialization.completionPolicy}' not satisfied: `
          + `${acceptedCount}/${outcomes.length} accepted`,
      );
    }

    return {
      runtimeEvent: 'completed',
      domainEvent: 'accepted',
      production: this.manifestProduction(cell, workplaces, outcomes, true),
    };
  }

  private materialize(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
  ): readonly MaterializedWorkplace[] {
    const source = cell.materialization.sourceBinding;
    if (!source) {
      return [this.materializeOne(ctx, cell, moduleRef, 'singleton', 'singleton', ctx.input)];
    }
    const production = resolveSourceProduction(ctx, source);
    const items = extractItems(production?.bindings ?? {}, cell.materialization.workKeySelector);
    if (items.length === 0) {
      throw new NodeExecutionError(this.kind, node.id, `fan-out source '${source}' has no stable items`);
    }
    // Fan-out WorkKey MUST derive from the cross-run-stable semantic source
    // identity, not the provenance-contaminated contentHash (CONVEYOR v4.3 §7).
    // Otherwise two equivalent Factory Runs produce different workKeys and
    // ReplayKey always misses downstream. Fall back to contentHash only when a
    // producer has not authored a semanticDigest (backward compat).
    const sourceHash = production?.semanticDigest ?? production?.contentHash ?? source;
    return items.map(({ id, value }) =>
      this.materializeOne(ctx, cell, moduleRef, deriveWorkKey(sourceHash, id), id, value));
  }

  private materializeOne(
    ctx: NodeExecutionContext,
    cell: ProductionCellDefinition,
    moduleRef: string,
    workKey: string,
    itemId: string,
    item: unknown,
  ): MaterializedWorkplace {
    const ref = asWorkplaceRef({
      processRunId: ctx.processRunId,
      moduleRef,
      productionCellId: cell.id,
      workKey,
    });
    this.opts.coordinator.materializeCell({
      processRunId: ctx.processRunId,
      moduleRef,
      productionCellId: cell.id,
      workKey,
    });
    const state = this.requireState(ref);
    if (state.loopState === 'idle') this.opts.coordinator.admitWork(ref);
    return { ref, workKey, itemId, item };
  }

  private async reconcile(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
    workplace: MaterializedWorkplace,
    workplacesByItemId: ReadonlyMap<string, MaterializedWorkplace>,
    initiallyProjected: boolean,
  ): Promise<ReconcileOutcome> {
    let state = this.requireState(workplace.ref);
    if (state.loopState === 'terminal') return this.terminalOutcome(workplace.ref, state);
    if (state.loopState === 'paused') return pausedOutcome();

    if (state.loopState === 'idle') {
      const dependencies = cell.materialization.dependencySelector
        ? stringSelector(workplace.item, cell.materialization.dependencySelector)
        : [];
      for (const dependencyId of dependencies) {
        const dependency = workplacesByItemId.get(dependencyId);
        if (!dependency) {
          throw new NodeExecutionError(
            this.kind,
            node.id,
            `cell '${cell.id}' item '${workplace.itemId}' names unknown dependency '${dependencyId}'`,
          );
        }
        const dependencyState = this.requireState(dependency.ref);
        if (dependencyState.loopState === 'paused') return pausedOutcome();
        if (dependencyState.loopState !== 'terminal') return pendingOutcome();
        if (dependencyState.terminalReason !== 'accepted') return failedOutcome();
      }
      this.opts.coordinator.admitWork(workplace.ref);
      state = this.requireState(workplace.ref);
    }

    if (state.loopState === 'repair_wait') {
      const attempts = this.attemptCount(workplace.ref, state.nextRole);
      if (attempts >= cell.recovery.maxAttempts) {
        if (cell.recovery.onExhausted === 'pause') {
          this.opts.coordinator.applyGateDecision(workplace.ref, {
            verdict: 'human_required', isFinal: true,
          });
        } else {
          this.opts.coordinator.applyGateDecision(workplace.ref, {
            verdict: 'failed', isFinal: true,
          });
        }
        this.opts.persistence.projectWorkplace(workplace.ref);
        state = this.requireState(workplace.ref);
        return state.loopState === 'paused'
          ? pausedOutcome()
          : this.terminalOutcome(workplace.ref, state);
      }
      this.opts.coordinator.requeue(workplace.ref, state.nextRole);
      this.opts.persistence.projectWorkplace(workplace.ref);
      state = this.requireState(workplace.ref);
    }

    if (state.loopState === 'queued') {
      if (!initiallyProjected) this.ensureRoleProjection(ctx, node, cell, workplace, state);
      return pendingOutcome();
    }
    if (state.loopState === 'leased' || state.loopState === 'running') {
      return pendingOutcome();
    }
    if (state.loopState === 'paused') return pausedOutcome();
    if (state.loopState !== 'verifying') {
      throw new NodeExecutionError(this.kind, node.id, `unsupported Workplace loop state '${state.loopState}'`);
    }

    const actors = this.opts.coordinator.readActiveActors(workplace.ref);
    const executionRef = actors?.activeReservationRef;
    if (!executionRef) {
      throw new NodeExecutionError(this.kind, node.id, 'verifying Workplace has no producer reservation');
    }
    const role = state.nextRole;
    const products = this.opts.productReader.readExecutionProducts({
      processRunId: ctx.processRunId,
      moduleRef,
      nodeId: node.id,
      executionRef,
      expectedSchemaRefs: role === 'reviewer'
        ? [cell.review?.verdictSchemaRef ?? '']
        : cell.productContracts.map(contract => contract.schemaRef),
      requireTypedSubmission: role === 'reviewer'
        || cell.productContracts.some(contract => contract.productSource === 'typed-submission'),
    });
    if (role === 'reviewer') {
      this.assertReviewerProductContract(cell, products, node.id);
    } else {
      this.assertProductContract(cell, products, node.id);
    }
    const subjectAuthorSet = role === 'reviewer'
      ? this.latestCandidate(workplace.ref, 'author')
      : null;
    const candidate = this.sealCandidateSet(
      workplace.ref,
      executionRef,
      role,
      subjectAuthorSet?.candidateSetRef ?? null,
      products,
    );
    // Post-acceptance effects must run AFTER the durable transition. Running
    // them before applyGateDecision/applyReviewerVerdict is invalid: replay
    // capture's authority boundary is `terminal(accepted)`, which only exists
    // after the transition. Track the accepted candidate, apply the transition,
    // then fire effects only when the workplace is durably terminal(accepted).
    let postAcceptanceCandidate: CandidateSet | null = null;

    if (role === 'author') {
      const decision = this.runGate(ctx, workplace.ref, cell.authorGate, candidate.candidateSetRef);
      if (decision.verdict === 'accepted') {
        if (!cell.review) postAcceptanceCandidate = candidate;
        this.opts.coordinator.applyGateDecision(workplace.ref, {
          verdict: 'accepted', isFinal: !cell.review,
        });
      } else {
        this.opts.coordinator.applyGateDecision(workplace.ref, {
          verdict: decision.verdict,
          isFinal: !cell.review,
          repairTargetRole: decision.repairTargetRole ?? undefined,
        });
      }
    } else {
      if (!cell.review || !subjectAuthorSet) {
        throw new NodeExecutionError(this.kind, node.id, 'reviewer run has no pinned author CandidateSet');
      }
      const decision = this.runGate(
        ctx,
        workplace.ref,
        cell.review.finalGate,
        subjectAuthorSet.candidateSetRef,
        [candidate.candidateSetRef],
      );
      if (decision.verdict === 'accepted') {
        postAcceptanceCandidate = subjectAuthorSet;
      }
      this.opts.coordinator.applyReviewerVerdict(workplace.ref, {
        verdict: decision.verdict,
        repairTargetRole: decision.repairTargetRole ?? undefined,
      });
    }
    this.opts.persistence.concludeExecutionIntent(executionRef);
    this.opts.persistence.projectWorkplace(workplace.ref);

    state = this.requireState(workplace.ref);
    if (state.loopState === 'terminal') {
      // Direct capture path: the transition is durable and the workplace is
      // terminal(accepted). Replay capture (and other post-acceptance effects)
      // run NOW — on the authoritative post-transition state. This is the
      // normal certification mechanism; the lazy claim-bound sweep remains as
      // a crash/reconciliation fallback only.
      if (postAcceptanceCandidate) {
        this.runPostAcceptanceEffect(ctx, cell, workplace.ref, postAcceptanceCandidate);
      }
      return this.terminalOutcome(workplace.ref, state);
    }
    if (state.loopState === 'paused') return pausedOutcome(candidate.candidateSetRef);
    if (state.loopState === 'queued') {
      this.ensureRoleProjection(ctx, node, cell, workplace, state);
    }
    return pendingOutcome(candidate.candidateSetRef);
  }

  private runPostAcceptanceEffect(
    ctx: NodeExecutionContext,
    cell: ProductionCellDefinition,
    workplaceRef: WorkplaceRef,
    acceptedCandidate: CandidateSet,
  ): void {
    const effectInput = {
      workplaceRef,
      processRunId: ctx.processRunId,
      candidateSetRef: acceptedCandidate.candidateSetRef,
      producerExecutionRef: acceptedCandidate.producerExecutionRef,
      expectedProductSchema: cell.productContracts[0]!.schemaRef,
    };
    // UNIVERSAL: replay capture runs for EVERY accepted candidate, regardless
    // of module. This is not a cell-specific effect — it is the factory-wide
    // mechanism that archives accepted production for future deterministic
    // replay. Best-effort: failure never revokes the GateDecision.
    try {
      this.opts.postAcceptanceEffects.run('replay-capture', effectInput);
    } catch {
      // Best-effort: replay capture failure is logged inside the effect.
    }
    // Cell-specific effect (git-integration, formalization-accept-products, ...).
    if (!cell.postAcceptanceEffect) return;
    this.opts.postAcceptanceEffects.run(cell.postAcceptanceEffect, effectInput);
  }

  private ensureRoleProjection(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    workplace: MaterializedWorkplace,
    state: WorkplaceState,
  ): number {
    const role = state.nextRole;
    const roleDeclaration = role === 'author' ? cell.author : cell.review?.reviewer;
    if (!roleDeclaration) {
      throw new NodeExecutionError(this.kind, node.id, `cell '${cell.id}' has no ${role} declaration`);
    }
    const profile = resolveExecutionProfile(ctx, roleDeclaration.skillRef);
    const generationKey = `${serializeWorkplaceRef(workplace.ref)}:${role}`;
    const objective = `${cell.id}/${role}: ${node.description || node.label}`;
    const preparationBindings = isRecord(ctx.input)
      && isRecord((ctx.input as Record<string, unknown>).bindings)
      ? (ctx.input as { bindings: Record<string, unknown> }).bindings
      : {};
    const preparedTaskId = Number(preparationBindings.preProjectedTaskId ?? 0);
    const preparedIntentId = Number(
      preparationBindings.preProjectedIntentId
        ?? preparationBindings.authorityIntentId
        ?? 0,
    );
    const prepared = Number.isInteger(preparedTaskId) && preparedTaskId > 0
      && Number.isInteger(preparedIntentId) && preparedIntentId > 0;
    const provenance = cell.materialization.taskProvenance;
    const sourceArtifactIds = provenance
      ? integerSelector(workplace.item, provenance.sourceArtifactIdsSelector)
      : [];
    const verificationTargets = provenance?.verificationTargetArtifactIdSelector
      ? integerSelector(workplace.item, provenance.verificationTargetArtifactIdSelector)
      : [];
    if (provenance?.verificationTargetArtifactIdSelector && verificationTargets.length !== 1) {
      throw new NodeExecutionError(this.kind, node.id,
        `cell '${cell.id}' requires exactly one verification target, got ${verificationTargets.length}`);
    }
    const plan = prepared
      ? { taskId: preparedTaskId, intentId: preparedIntentId, replayed: true }
      : this.opts.persistence.ensureExecutionPlan({
      intent: {
        epicId: ctx.epicId!,
        kind: profile.workIntentKind,
        objective,
        authorityScope: {
          snapshot_ref: serializeWorkplaceRef(workplace.ref),
          scope: profile.id,
          allowed_tools: [...profile.allowedTools],
          enforcement: 'runtime',
        },
        outputSchema: role === 'reviewer'
          ? cell.review!.verdictSchemaRef
          : cell.productContracts[0]!.schemaRef,
        tokenBudget: 0,
        retryBudget: cell.recovery.maxAttempts,
      },
      task: {
        epicId: ctx.epicId!,
        projectId: ctx.projectId,
        objective,
        taskKind: profile.taskKind,
        executionSkill: profile.executionSkill,
        reviewSkill: null,
        generationKey,
        workflowStage: ctx.module.identity.kind,
        executionMode: profile.executionMode,
        titlePrefix: `${cell.id}/${role}: `,
        metadata: {
          process_run_id: ctx.processRunId,
          process_node_id: node.id,
          process_module_ref: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
          process_execution_profile_id: profile.id,
          workplace_ref: serializeWorkplaceRef(workplace.ref),
          production_cell_id: cell.id,
          work_key: workplace.workKey,
          role,
          trusted_provider_bindings:
            this.opts.persistence.readTrustedProviders?.(ctx.projectId) ?? [],
          cell_input_item: workplace.item,
        },
        sourceArtifactIds,
        verificationTargetArtifactId: verificationTargets[0] ?? null,
      },
      });
    const projectRepositoryId = this.opts.persistence.readTaskProjectRepositoryId(plan.taskId);
    const nodeInput = cell.materialization.sourceBinding
      ? { upstream: ctx.input, item: workplace.item }
      : ctx.input;
    // Semantic input digest for cross-run replay identity (CONVEYOR v4.3 §8).
    // NOT the raw nodeInputHash (which includes run-specific provenance from
    // the upstream manifest). For an entry cell (no sourceBinding) ctx.input is
    // the canonical lifecycle business input — stable across runs — so its
    // canonical hash is the semantic identity. For a fan-out cell the semantic
    // identity is the upstream production's semanticDigest + the stable item
    // id + the item's semantic content. Fail closed if a fan-out upstream
    // lacks a semanticDigest (the WorkKey would also be unstable).
    // For the reviewer, reuse the author's semantic_input_digest from the same
    // Workplace so both roles share the same replay input identity.
    const semanticInputDigest = role === 'reviewer'
      ? (this.readAuthorSemanticDigest(workplace.ref) ?? computeSemanticInputDigest(ctx, cell, workplace))
      : computeSemanticInputDigest(ctx, cell, workplace);
    this.opts.persistence.bindProjectedTaskProcessContext?.({
      taskId: plan.taskId,
      processRunId: ctx.processRunId,
      nodeId: node.id,
      moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
      processInputHash: this.opts.persistence.readProcessInputHash(ctx.processRunId),
      nodeInput,
      nodeInputHash: sha256Hex(nodeInput),
      semanticInputDigest,
      projectRepositoryId,
    });
    this.opts.persistence.activateRoleTask({
      taskId: plan.taskId,
      intentId: plan.intentId,
      workplaceRef: workplace.ref,
      role,
      executionProfileId: profile.id,
    });
    return plan.taskId;
  }

  private sealCandidateSet(
    workplaceRef: WorkplaceRef,
    executionRef: string,
    role: 'author' | 'reviewer',
    subjectCandidateSetRef: string | null,
    products: readonly ProductRef[],
  ): CandidateSet {
    const members: CandidateMember[] = products.map(productRef => ({
      productRef,
      origin: 'produced',
      sourceCandidateSetRef: null,
    }));
    const digest = hash({ workplaceRef: serializeWorkplaceRef(workplaceRef), executionRef, role, products });
    return this.opts.candidateSetRepo.seal({
      workplaceRef,
      producerExecutionRef: executionRef,
      role,
      subjectCandidateSetRef,
      members,
      sealReceiptRef: `seal:${executionRef}:${role}`,
      candidateSetDigest: digest,
      sealedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
    }).set;
  }

  private runGate(
    ctx: NodeExecutionContext,
    workplaceRef: WorkplaceRef,
    gate: ProductionCellDefinition['authorGate'],
    subjectCandidateSetRef: string,
    assessmentCandidateSetRefs: readonly string[] = [],
  ) {
    return driveGateRun(this.opts.gateRepo, this.opts.checkProviders, {
      workplaceRef,
      subjectCandidateSetRef,
      assessmentCandidateSetRefs,
      checkPlan: gate.checkPlan,
      gatePhase: gate.gatePhase,
      expectedWorkplaceRevision: this.requireState(workplaceRef).revision,
      gateLeaseRef: `gate-lease:${subjectCandidateSetRef}:${gate.gatePhase}`,
      installationDigest: this.opts.resolveInstallationDigest(ctx.module.identity.name),
      checkParameters: {
        processRunId: ctx.processRunId,
        moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
      },
      environmentRef: null,
    }).decision;
  }

  private assertProductContract(
    cell: ProductionCellDefinition,
    products: readonly ProductRef[],
    nodeId: string,
  ): void {
    for (const contract of cell.productContracts) {
      const matching = products.filter(product => product.schemaId === contract.schemaRef);
      const minimum = contract.cardinality === '0..1' ? 0 : 1;
      const maximum = contract.cardinality === '1' || contract.cardinality === '0..1' ? 1 : Infinity;
      if (matching.length < minimum || matching.length > maximum) {
        throw new NodeExecutionError(
          this.kind,
          nodeId,
          `product contract '${contract.binding}' expected ${contract.cardinality} of `
            + `'${contract.schemaRef}', received ${matching.length}`,
        );
      }
    }
  }

  private assertReviewerProductContract(
    cell: ProductionCellDefinition,
    products: readonly ProductRef[],
    nodeId: string,
  ): void {
    const schemaRef = cell.review?.verdictSchemaRef;
    if (!schemaRef) {
      throw new NodeExecutionError(this.kind, nodeId, 'reviewer product has no declared verdict schema');
    }
    const matching = products.filter(product => product.schemaId === schemaRef);
    if (matching.length !== 1) {
      throw new NodeExecutionError(
        this.kind,
        nodeId,
        `review verdict contract expected exactly one '${schemaRef}', received ${matching.length}`,
      );
    }
  }

  private terminalOutcome(ref: WorkplaceRef, state: WorkplaceState): ReconcileOutcome {
    if (state.loopState !== 'terminal') {
      throw new Error(
        `WORKPLACE_NOT_TERMINAL: ${serializeWorkplaceRef(ref)} is ${state.loopState}`,
      );
    }
    if (state.terminalReason !== 'accepted') return failedOutcome();
    const author = this.latestCandidate(ref, 'author');
    return {
      pending: false,
      paused: false,
      accepted: true,
      failed: false,
      products: author?.members.map(member => member.productRef) ?? [],
      candidateSetRef: author?.candidateSetRef ?? null,
      executionRef: author?.producerExecutionRef ?? null,
    };
  }

  private latestCandidate(ref: WorkplaceRef, role: 'author' | 'reviewer'): CandidateSet | null {
    const sets = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role);
    return sets[0] ?? null;
  }

  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
    // Count sealed CandidateSets for this role as the primary attempt counter.
    // Each CandidateSet represents one completed gate-evaluated attempt.
    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role).length;
    // CGAD P18 / crash recovery: a crashed execution that never sealed a
    // CandidateSet still counts as an attempt. The Workplace's revision
    // reflects the number of transitions, which includes crash → repair_wait
    // cycles. When there are NO sealed CandidateSets but the workplace has
    // been through repair_wait, use the durable execution history to count
    // failed attempts. This prevents infinite crash loops where the worker
    // crashes before sealing, attemptCount stays 0, and maxAttempts is never
    // reached.
    // We use the higher of sealed attempts and the execution count from the
    // workplace's lifecycle events (stored in worker_executions).
    const state = this.opts.coordinator.readState(ref);
    if (state && sealedAttempts === 0 && state.loopState === 'repair_wait') {
      // Count terminal (failed/lost) executions for this workplace's task.
      // The task's workplace_ref identifies all executions that attempted work.
      const taskRow = this.opts.persistence.readTaskForWorkplace?.(ref);
      if (taskRow) {
        const failedExecs = this.opts.persistence.countTerminalExecutionsForTask?.(taskRow.taskId) ?? 0;
        return Math.max(sealedAttempts, failedExecs);
      }
    }
    return sealedAttempts;
  }

  private readAuthorSemanticDigest(workplaceRef: WorkplaceRef): string | null {
    const serialized = serializeWorkplaceRef(workplaceRef);
    return this.opts.persistence.readAuthorSemanticDigestForWorkplace?.(serialized) ?? null;
  }

  private requireState(ref: WorkplaceRef): WorkplaceState {
    const state = this.opts.coordinator.readState(ref);
    if (!state) throw new Error(`WORKPLACE_NOT_FOUND: ${serializeWorkplaceRef(ref)}`);
    return state;
  }

  private manifestProduction(
    cell: ProductionCellDefinition,
    workplaces: readonly MaterializedWorkplace[],
    outcomes: readonly ReconcileOutcome[],
    final: boolean,
  ): NodeExecutionResult['production'] {
    const items = workplaces.map((workplace, index) => {
      const outcome = outcomes[index] ?? pendingOutcome();
      const execution = outcome.executionRef
        ? this.opts.persistence.readExecutionReceipt(outcome.executionRef)
        : null;
      return {
        id: workplace.workKey,
        workKey: workplace.workKey,
        workplaceRef: serializeWorkplaceRef(workplace.ref),
        accepted: outcome.accepted,
        failed: outcome.failed,
        paused: outcome.paused,
        candidateSetRef: outcome.candidateSetRef,
        producerExecutionRef: outcome.executionRef,
        execution: execution && outcome.executionRef
          ? {
              intentId: execution.intentId,
              taskId: execution.taskId,
              executionRef: outcome.executionRef,
            }
          : null,
        products: outcome.products,
      };
    });
    const contentHash = hash({ cellId: cell.id, final, items });
    // Cross-run-stable semantic digest (CONVEYOR v4.3 §6). Authored here from
    // a STABLE projection: cell/contract identity + stable item identity +
    // canonical ProductRefs ({ schemaId, digest }). Run-specific provenance
    // (workplaceRef, candidateSetRef, producerExecutionRef, execution ids) is
    // excluded — those remain in `items`/`contentHash` for current-run audit.
    // Products are sorted per-item (multiset) and items sorted by id, so the
    // digest is order-independent and identical across two runs that produce
    // the same semantic output with different runtime identities.
    const semanticProjection = {
      cellId: cell.id,
      final,
      items: items
        .map(item => ({
          id: item.id,
          accepted: item.accepted,
          products: canonicalProductMultiset(item.products, this.opts.resolveProductSemanticDigest),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
    const semanticDigest = sha256Hex(semanticProjection);
    return {
      schema: 'factory.production-cell-output-manifest.v1',
      artifactRef: `production-cell-manifest:${cell.id}:${contentHash}`,
      contentHash,
      semanticDigest,
      bindings: { cellId: cell.id, final, items },
    };
  }
}

/**
 * Canonical multiset representation of a ProductRef list for cross-run semantic
 * identity: each product reduced to `{ schemaId, digest }` (the content atoms,
 * never the opaque `ref` which may carry run-specific ids), sorted so order is
 * irrelevant. Two runs producing the same products in different orders yield
 * the same multiset.
 */
function canonicalProductMultiset(
  products: readonly ProductRef[],
  semanticDigestResolver?: (productRef: ProductRef) => string | null,
): readonly { schemaId: string; digest: string }[] {
  return products
    .map(p => ({
      schemaId: p.schemaId,
      digest: semanticDigestResolver?.(p) ?? p.digest,
    }))
    .sort((a, b) =>
      a.schemaId < b.schemaId ? -1
      : a.schemaId > b.schemaId ? 1
      : a.digest < b.digest ? -1
      : a.digest > b.digest ? 1
      : 0,
    );
}

/**
 * Compute the cross-run-stable semantic input digest for a Production Cell
 * (CONVEYOR v4.3 §8).
 *
 * Three cases:
 *  1. Entry cell whose ctx.input is the canonical lifecycle/module business
 *     input (no upstream production envelope): hash ctx.input directly — it is
 *     pure business content with no runtime envelope, stable across runs.
 *  2. Singleton downstream cell (no sourceBinding, but ctx.input IS an upstream
 *     NodeProduction manifest): use the upstream's semanticDigest. Hashing the
 *     raw manifest would include provenance (workplaceRef, candidateSetRef,
 *     execution ids) and break cross-run stability.
 *  3. Fan-out cell: the semantic identity is the upstream production's
 *     semanticDigest + the stable item id + the item's semantic content.
 *
 * Cases 2 and 3 both detect "ctx.input is an upstream production" by checking
 * for the NodeProduction shape (contentHash + bindings). We fall back to
 * contentHash if the upstream producer did not author a semanticDigest; fail
 * closed only if neither is present.
 */
function computeSemanticInputDigest(
  ctx: NodeExecutionContext,
  cell: ProductionCellDefinition,
  workplace: MaterializedWorkplace,
): string {
  // Detect whether ctx.input is an upstream NodeProduction manifest (carries
  // contentHash + bindings) vs the raw lifecycle business input.
  const inputProduction = readInputAsProduction(ctx.input);
  if (cell.materialization.sourceBinding) {
    // Fan-out: resolve the source production explicitly (frame or ctx.input).
    const upstream = resolveSourceProduction(ctx, cell.materialization.sourceBinding);
    const upstreamSemanticDigest = upstream?.semanticDigest ?? upstream?.contentHash ?? null;
    if (!upstreamSemanticDigest) {
      throw new NodeExecutionError(
        'production-cell',
        cell.id,
        `REPLAY_SEMANTIC_IDENTITY_UNPROVEN: fan-out cell '${cell.id}' upstream has no semanticDigest; `
        + `cross-run replay identity cannot be derived. The upstream producer must author a semanticDigest.`,
      );
    }
    const inputRecord = isRecord(ctx.input) ? ctx.input : null;
    const immediateUpstream = inputRecord ? readInputAsProduction(inputRecord.upstream) : null;
    const immediateUpstreamSemanticDigest = immediateUpstream
      ? (immediateUpstream.semanticDigest ?? immediateUpstream.contentHash)
      : null;
    return sha256Hex({
      upstreamSemanticDigest,
      immediateUpstreamSemanticDigest:
        immediateUpstreamSemanticDigest === upstreamSemanticDigest ? null : immediateUpstreamSemanticDigest,
      itemId: workplace.itemId,
      itemDigest: sha256Hex(workplace.item),
    });
  }
  if (inputProduction) {
    // Singleton downstream cell: ctx.input is an upstream production manifest.
    // Use its semanticDigest (fallback contentHash) — NOT the raw manifest,
    // which carries run-specific provenance.
    return inputProduction.semanticDigest ?? inputProduction.contentHash;
  }
  // Entry cell: canonical business input. Strip certificate/contract refs
  // (run-specific DB ids) so the cross-run semantic digest is stable.
  return sha256Hex(canonicalizeLifecycleInput(ctx.input));
}

/**
 * Canonicalize a lifecycle stage input for cross-run semantic identity.
 * Strips fields that carry run-specific provenance (certificate refs/hashes,
 * contract refs/hashes) while preserving all business-semantic fields.
 */
function canonicalizeLifecycleInput(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(canonicalizeLifecycleInput);
  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (/certificate/i.test(key) || /contract/i.test(key)) continue;
    result[key] = canonicalizeLifecycleInput(value);
  }
  return result;
}

/**
 * Detect whether ctx.input is an upstream NodeProduction manifest (vs the raw
 * lifecycle business input). A NodeProduction carries contentHash + bindings;
 * the lifecycle business input does not.
 */
function readInputAsProduction(input: unknown): {
  contentHash: string;
  semanticDigest?: string;
} | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.contentHash !== 'string') return null;
  if (!obj.bindings || typeof obj.bindings !== 'object') return null;
  return {
    contentHash: obj.contentHash,
    semanticDigest: typeof obj.semanticDigest === 'string' ? obj.semanticDigest : undefined,
  };
}

function integerSelector(value: unknown, selector: string): number[] {
  let selected = value;
  for (const segment of selector.split('.').filter(Boolean)) {
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return [];
    selected = (selected as Record<string, unknown>)[segment];
  }
  const values = Array.isArray(selected) ? selected : [selected];
  return [...new Set(values.filter(
    (candidate): candidate is number => Number.isSafeInteger(candidate) && (candidate as number) > 0,
  ))];
}

function stringSelector(value: unknown, selector: string): string[] {
  let selected = value;
  for (const segment of selector.split('.').filter(Boolean)) {
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return [];
    selected = (selected as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(selected) || !selected.every(item => typeof item === 'string')) {
    return [];
  }
  return [...new Set(selected)];
}

function resolveCellDefinition(
  node: ProductionCellFlowNodeDefinition,
): ProductionCellDefinition {
  if (node.cellDefinition) return node.cellDefinition;
  throw new Error(
    `PRODUCTION_CELL_DEFINITION_REQUIRED: node '${node.id}' must carry an inline cellDefinition`,
  );
}

function resolveExecutionProfile(
  ctx: NodeExecutionContext,
  skillRef: string,
): ExecutionProfileDefinition {
  const matches = ctx.module.executionProfiles.filter(profile =>
    profile.executionSkill === skillRef || profile.id === skillRef);
  if (matches.length !== 1) {
    throw new Error(
      `PRODUCTION_CELL_PROFILE_INVALID: skill/profile '${skillRef}' resolved ${matches.length} profiles`,
    );
  }
  return matches[0]!;
}

function resolveSourceProduction(
  ctx: NodeExecutionContext,
  sourceBinding: string,
): { contentHash: string; semanticDigest?: string; bindings: Record<string, unknown> } | null {
  const direct = ctx.frame.productions[sourceBinding];
  if (direct) {
    return {
      contentHash: direct.contentHash,
      semanticDigest: direct.semanticDigest,
      bindings: direct.bindings as Record<string, unknown>,
    };
  }
  const input = ctx.input as {
    contentHash?: unknown;
    semanticDigest?: unknown;
    bindings?: unknown;
  } | null;
  if (input && typeof input.contentHash === 'string' && isRecord(input.bindings)) {
    return {
      contentHash: input.contentHash,
      semanticDigest: typeof input.semanticDigest === 'string' ? input.semanticDigest : undefined,
      bindings: input.bindings,
    };
  }
  return null;
}

function extractItems(
  bindings: Record<string, unknown>,
  selector?: string,
): readonly { id: string; value: unknown }[] {
  const selected = selector ? readPath(bindings, selector) : bindings.items;
  const arrays = Array.isArray(selected)
    ? [selected]
    : Object.values(bindings).filter(Array.isArray);
  for (const values of arrays) {
    const normalized = values.flatMap(value => {
      if (!isRecord(value)) return [];
      const id = value.id ?? value.key ?? value.workItemKey ?? value.criterionId;
      return typeof id === 'string' && id.length > 0 ? [{ id, value }] : [];
    });
    if (normalized.length > 0) return normalized;
  }
  return [];
}

function readPath(value: Record<string, unknown>, selector: string): unknown {
  return selector.split('.').reduce<unknown>((current, part) =>
    isRecord(current) ? current[part] : undefined, value);
}

function completionSatisfied(
  cell: ProductionCellDefinition,
  accepted: number,
  total: number,
): boolean {
  switch (cell.materialization.completionPolicy) {
    case 'all': return accepted === total;
    case 'any': return accepted >= 1;
    case 'quorum': return accepted >= (cell.materialization.quorum ?? 1);
  }
}

function pendingOutcome(candidateSetRef: string | null = null): ReconcileOutcome {
  return {
    pending: true,
    paused: false,
    accepted: false,
    failed: false,
    products: [],
    candidateSetRef,
    executionRef: null,
  };
}

function pausedOutcome(candidateSetRef: string | null = null): ReconcileOutcome {
  return {
    pending: false,
    paused: true,
    accepted: false,
    failed: false,
    products: [],
    candidateSetRef,
    executionRef: null,
  };
}

function failedOutcome(): ReconcileOutcome {
  return {
    pending: false,
    paused: false,
    accepted: false,
    failed: true,
    products: [],
    candidateSetRef: null,
    executionRef: null,
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
