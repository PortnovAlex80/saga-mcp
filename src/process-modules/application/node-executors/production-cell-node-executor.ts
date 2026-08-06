/**
 * Workplace-native Production Cell reconciler.
 *
 * This executor deliberately does not assign, launch, poll, stop, or supervise
 * workers. It materializes deterministic Workplaces, projects the next desk,
 * reconciles completed executions into CandidateSets/GateDecisions, and pauses
 * the ProcessRun while the application-wide dispatcher staffs queued
 * Workplaces. ADR-030.
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
    projectRepositoryId?: number | null;
  }): void;
  readTaskProjectRepositoryId(taskId: number): number | null;
  /** Read the immutable hash of the factory order bound to this ProcessRun. */
  readProcessInputHash(processRunId: number): string;
  /** Make this the sole claimable task projection for the Workplace. */
  activateRoleTask(input: {
    taskId: number;
    intentId: number;
    workplaceRef: WorkplaceRef;
    role: 'author' | 'reviewer';
    executionProfileId: string;
  }): void;
  /** Conclude the physical attempt without deciding product acceptance. */
  concludeExecutionIntent(executionRef: string): void;
  /** Rebuild all task projections after a Workplace transition. */
  projectWorkplace(workplaceRef: WorkplaceRef): void;
}

export interface ProductionCellProductReader {
  readExecutionProducts(input: {
    processRunId: number;
    moduleRef: string;
    nodeId: string;
    executionRef: string;
  }): readonly ProductRef[];
}

export interface ProductionCellNodeExecutorOptions {
  readonly coordinator: ProductionCellCoordinator;
  readonly candidateSetRepo: SqliteCandidateSetRepository;
  readonly gateRepo: SqliteGateRepository;
  readonly checkProviders: CheckProviderRegistry;
  readonly persistence: ProductionCellProjectionPersistence;
  readonly productReader: ProductionCellProductReader;
  readonly resolveInstallationDigest: (moduleName: string) => string;
  readonly now?: () => Date;
}

interface MaterializedWorkplace {
  readonly ref: WorkplaceRef;
  readonly workKey: string;
  readonly item: unknown;
}

interface ReconcileOutcome {
  readonly pending: boolean;
  readonly accepted: boolean;
  readonly products: readonly ProductRef[];
  readonly candidateSetRef: string | null;
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
    const outcomes: ReconcileOutcome[] = [];
    for (const workplace of workplaces) {
      outcomes.push(await this.reconcile(ctx, node, cell, moduleRef, workplace));
    }

    if (outcomes.some(outcome => outcome.pending)) {
      return {
        runtimeEvent: 'paused',
        domainEvent: 'await-workplace',
        production: this.manifestProduction(cell, workplaces, outcomes, false),
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
      return [this.materializeOne(ctx, cell, moduleRef, 'singleton', ctx.input)];
    }
    const production = resolveSourceProduction(ctx, source);
    const items = extractItems(production?.bindings ?? {}, cell.materialization.workKeySelector);
    if (items.length === 0) {
      throw new NodeExecutionError(this.kind, node.id, `fan-out source '${source}' has no stable items`);
    }
    const sourceHash = production?.contentHash ?? source;
    return items.map(({ id, value }) =>
      this.materializeOne(ctx, cell, moduleRef, deriveWorkKey(sourceHash, id), value));
  }

  private materializeOne(
    ctx: NodeExecutionContext,
    cell: ProductionCellDefinition,
    moduleRef: string,
    workKey: string,
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
    return { ref, workKey, item };
  }

  private async reconcile(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
    workplace: MaterializedWorkplace,
  ): Promise<ReconcileOutcome> {
    let state = this.requireState(workplace.ref);
    if (state.loopState === 'terminal') return this.terminalOutcome(workplace.ref, state);

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
        return this.terminalOutcome(workplace.ref, this.requireState(workplace.ref));
      }
      this.opts.coordinator.requeue(workplace.ref, state.nextRole);
      this.opts.persistence.projectWorkplace(workplace.ref);
      state = this.requireState(workplace.ref);
    }

    if (state.loopState === 'queued') {
      this.ensureRoleProjection(ctx, node, cell, workplace, state);
      return pendingOutcome();
    }
    if (state.loopState === 'leased' || state.loopState === 'running' || state.loopState === 'paused') {
      return pendingOutcome();
    }
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
    this.opts.persistence.concludeExecutionIntent(executionRef);

    if (role === 'author') {
      const decision = this.runGate(ctx, workplace.ref, cell.authorGate, candidate.candidateSetRef);
      if (decision.verdict === 'accepted') {
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
      this.opts.coordinator.applyReviewerVerdict(workplace.ref, {
        verdict: decision.verdict,
        repairTargetRole: decision.repairTargetRole ?? undefined,
      });
    }
    this.opts.persistence.projectWorkplace(workplace.ref);

    state = this.requireState(workplace.ref);
    if (state.loopState === 'terminal') return this.terminalOutcome(workplace.ref, state);
    if (state.loopState === 'queued') {
      // Materialize the next desk before returning control to the global
      // dispatcher. Otherwise the just-concluded author projection could be
      // mistaken for a reviewer card during the hand-off window.
      this.ensureRoleProjection(ctx, node, cell, workplace, state);
    }
    return { ...pendingOutcome(), candidateSetRef: candidate.candidateSetRef };
  }

  private ensureRoleProjection(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    workplace: MaterializedWorkplace,
    state: WorkplaceState,
  ): void {
    const role = state.nextRole;
    const roleDeclaration = role === 'author' ? cell.author : cell.review?.reviewer;
    if (!roleDeclaration) {
      throw new NodeExecutionError(this.kind, node.id, `cell '${cell.id}' has no ${role} declaration`);
    }
    const profile = resolveExecutionProfile(ctx, roleDeclaration.skillRef);
    const generationKey = `${serializeWorkplaceRef(workplace.ref)}:${role}:revision:${state.revision}`;
    const objective = `${cell.id}/${role}: ${node.description || node.label}`;
    const plan = this.opts.persistence.ensureExecutionPlan({
      intent: {
        epicId: ctx.epicId!,
        kind: `production-cell.${role}`,
        objective,
        authorityScope: {
          snapshot_ref: serializeWorkplaceRef(workplace.ref),
          scope: profile.id,
          allowed_tools: [...profile.allowedTools],
          enforcement: 'runtime',
        },
        outputSchema: cell.productContracts[0]?.schemaRef ?? 'factory.product-envelope.v1',
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
        executionMode: profile.taskKind.includes('verification') ? 'tracker_only' : 'git_change',
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
          cell_input_item: workplace.item,
        },
      },
    });
    const projectRepositoryId = this.opts.persistence.readTaskProjectRepositoryId(plan.taskId);
    const nodeInput = { upstream: ctx.input, item: workplace.item };
    this.opts.persistence.bindProjectedTaskProcessContext?.({
      taskId: plan.taskId,
      processRunId: ctx.processRunId,
      nodeId: node.id,
      moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
      processInputHash: this.opts.persistence.readProcessInputHash(ctx.processRunId),
      nodeInput,
      nodeInputHash: sha256Hex(nodeInput),
      projectRepositoryId,
    });
    this.opts.persistence.activateRoleTask({
      taskId: plan.taskId,
      intentId: plan.intentId,
      workplaceRef: workplace.ref,
      role,
      executionProfileId: profile.id,
    });
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
    if (state.terminalReason !== 'accepted') {
      return { pending: false, accepted: false, products: [], candidateSetRef: null };
    }
    const author = this.latestCandidate(ref, 'author');
    return {
      pending: false,
      accepted: true,
      products: author?.members.map(member => member.productRef) ?? [],
      candidateSetRef: author?.candidateSetRef ?? null,
    };
  }

  private latestCandidate(ref: WorkplaceRef, role: 'author' | 'reviewer'): CandidateSet | null {
    const sets = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role);
    return sets[0] ?? null;
  }

  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
    return this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role).length;
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
    const items = workplaces.map((workplace, index) => ({
      id: workplace.workKey,
      workKey: workplace.workKey,
      workplaceRef: serializeWorkplaceRef(workplace.ref),
      accepted: outcomes[index]?.accepted ?? false,
      candidateSetRef: outcomes[index]?.candidateSetRef ?? null,
      products: outcomes[index]?.products ?? [],
    }));
    const contentHash = hash({ cellId: cell.id, final, items });
    return {
      schema: 'factory.production-cell-output-manifest.v1',
      artifactRef: `production-cell-manifest:${cell.id}:${contentHash}`,
      contentHash,
      bindings: { cellId: cell.id, final, items },
    };
  }
}

function resolveCellDefinition(node: ProductionCellFlowNodeDefinition): ProductionCellDefinition {
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
): { contentHash: string; bindings: Record<string, unknown> } | null {
  const direct = ctx.frame.productions[sourceBinding];
  if (direct) {
    return {
      contentHash: direct.contentHash,
      bindings: direct.bindings as Record<string, unknown>,
    };
  }
  const input = ctx.input as { contentHash?: unknown; bindings?: unknown } | null;
  if (input && typeof input.contentHash === 'string' && isRecord(input.bindings)) {
    return { contentHash: input.contentHash, bindings: input.bindings };
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

function pendingOutcome(): ReconcileOutcome {
  return { pending: true, accepted: false, products: [], candidateSetRef: null };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
