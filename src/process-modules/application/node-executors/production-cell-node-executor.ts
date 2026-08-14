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
  candidateSetDigestForRevision,
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
import type { SqliteCellFinalAcceptance } from '../../../infrastructure/workplace/sqlite-cell-final-acceptance.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
} from '../node-executor.js';
import { ProductionCellCoordinator } from '../production-cell-coordinator.js';
import { deriveWorkKey } from '../../domain/workplace/work-key-deriver.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type { AuthorCandidateCarryForwardPort } from '../../../infrastructure/workplace/sqlite-author-candidate-carry-forward.js';
import type { TransitionObligationIntegrator } from '../transition-obligation-integrator.js';
import { assembleRevision, type WorkplaceProductionRevision } from '../../domain/workplace/workplace-production-revision.js';
import { producedProductsToContribution } from '../production-source-adapters.js';
import type { SqliteWorkplaceProductionRevisionRepository } from '../../../infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import type { SqliteAcceptedAuthorityHeadRepository } from '../../../infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import { computeAcceptanceDigest } from '../post-acceptance-effects.js';
import type { SubmissionValidationReceiptProjection } from '../submission-validation-receipt-authority.js';

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
    productSource?: 'typed-submission' | 'managed-production';
  }): void;
  concludeExecutionIntent(executionRef: string): void;
  /**
   * Resolve worker-only execution coordinates when the CandidateSet producer
   * is a WorkerExecution. Kernel presenters (for example an authorized
   * carry-forward) are lawful ProducerRefs but deliberately have no worker
   * receipt, so they resolve to null.
   */
  readExecutionReceipt(executionRef: string): { intentId: number; taskId: number } | null;
  /** Successful validators durably committed by this exact worker_done. */
  readSubmissionValidationReceipts?(
    executionRef: string,
  ): readonly SubmissionValidationReceiptProjection[];
  projectWorkplace(workplaceRef: WorkplaceRef): void;
  /**
   * Seal the complete fan-out topology before any Workplace is admitted.
   * Implementations must compare exact graph equality on replay and project
   * task dependencies from this immutable source; partial/reduced replacement
   * is forbidden.
   */
  sealWorkplaceGraph?(input: {
    graphRef: string;
    graphDigest: string;
    processRunId: number;
    moduleRef: string;
    productionCellId: string;
    sealedAt: string;
    items: readonly {
      ordinal: number;
      itemId: string;
      workplaceRef: string;
      taskId: number;
      dependencyItemIds: readonly string[];
      dependencyWorkplaceRefs: readonly string[];
      dependencyTaskIds: readonly number[];
    }[];
  }): void;
  readProjectedRoleTask?(workplaceRef: WorkplaceRef, role: 'author' | 'reviewer'):
    { taskId: number } | null;
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
  /** Read pre-seal contributions presented by one fenced execution. */
  readContributionProducts(input: {
    processRunId: number;
    moduleRef: string;
    nodeId: string;
    contributorRef: string;
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
  readonly finalAcceptance: SqliteCellFinalAcceptance;
  readonly persistence: ProductionCellProjectionPersistence;
  readonly productReader: ProductionCellProductReader;
  readonly resolveInstallationDigest: (moduleName: string) => string;
  readonly resolveProductSemanticDigest?: (productRef: ProductRef) => string | null;
  readonly authorCandidateCarryForward?: AuthorCandidateCarryForwardPort;
  /** ADR-053 B-8 — MANDATORY. CandidateSet seals (and downstream transitions) append a durable obligation atomically with the source fact. */
  readonly obligationIntegrator: TransitionObligationIntegrator;
  /** ADR-053 B-1 — MANDATORY. CandidateSet seals append the revision and seal the set in one transaction; a set can never reference an absent revision. */
  readonly revisionRepo: SqliteWorkplaceProductionRevisionRepository;
  /** ADR-053 C1 — MANDATORY. The durable current accepted-author authority pointer; read by acceptedAuthorCandidate instead of hash-order selection. */
  readonly authorityHead: SqliteAcceptedAuthorityHeadRepository;
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
    const authorTaskIds = new Map<string, number>();
    const roleProjectedThisCycle = new Set<string>();
    for (const workplace of workplaces) {
      const state = this.requireState(workplace.ref);
      if (
        state.nextRole === 'author'
        && (state.loopState === 'idle' || state.loopState === 'queued')
      ) {
        authorTaskIds.set(workplace.itemId,
          this.ensureRoleProjection(ctx, node, cell, workplace, state));
        roleProjectedThisCycle.add(`${workplace.itemId}:author`);
        continue;
      }
      const projected = this.opts.persistence.readProjectedRoleTask?.(
        workplace.ref,
        'author',
      );
      if (!projected && cell.materialization.dependencySelector) {
        throw new NodeExecutionError(
          this.kind,
          node.id,
          `cell '${cell.id}' has no durable author task for item '${workplace.itemId}'`,
        );
      }
      if (projected) authorTaskIds.set(workplace.itemId, projected.taskId);
    }
    if (cell.materialization.dependencySelector) {
      if (!this.opts.persistence.sealWorkplaceGraph) {
        throw new NodeExecutionError(
          this.kind,
          node.id,
          `cell '${cell.id}' declares dependencies but no graph persistence capability is installed`,
        );
      }
      const graph = buildSealedGraph(node.id, cell, workplaces, authorTaskIds);
      this.opts.persistence.sealWorkplaceGraph({
        ...graph,
        processRunId: ctx.processRunId,
        moduleRef,
        productionCellId: cell.id,
        sealedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      });
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
        roleProjectedThisCycle.has(`${workplace.itemId}:${this.requireState(workplace.ref).nextRole}`),
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
    return { ref, workKey, itemId, item };
  }

  private async reconcile(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
    workplace: MaterializedWorkplace,
    workplacesByItemId: ReadonlyMap<string, MaterializedWorkplace>,
    currentRoleProjectedThisCycle: boolean,
  ): Promise<ReconcileOutcome> {
    let state = this.requireState(workplace.ref);
    if (state.loopState === 'terminal') {
      // ADR-053 C8 — crash recovery: if the workplace reached terminal(accepted)
      // but FinalAcceptance was never durably recorded (a crash in the window
      // between the gate-accept CAS transition and recordFinalAcceptanceAndCapture),
      // idempotently record FinalAcceptance + run replay-capture NOW, before
      // returning. Without this, a crash in that narrow window leaves the
      // acceptance non-durable and the replay capsule never captured.
      // recordFinalAcceptanceAndCapture is idempotent (replay-safe on the exact
      // acceptance identity), so re-running on the next reconcile is a no-op once
      // the row exists.
      if (state.terminalReason === 'accepted'
        && !this.opts.finalAcceptance.getAcceptedCandidateSetRef(
          serializeWorkplaceRef(workplace.ref),
        )) {
        const accepted = this.acceptedAuthorCandidate(workplace.ref);
        if (!accepted || !this.gateEffectHandoffReady(workplace.ref, accepted)) {
          return pendingOutcome();
        }
        const settlementReady = this.ensureFinalAcceptanceForTerminalAccepted(node, cell, workplace);
        if (!settlementReady) return pendingOutcome();
      }
      return this.terminalOutcome(workplace.ref, state);
    }
    if (state.loopState === 'paused') return pausedOutcome();
    if (state.loopState === 'effect_pending') {
      // ADR-053 Phase 7: read the accepted CandidateSet by EXACT ref from
      // CellFinalAcceptance, not by recency (latestCandidate). The final
      // acceptance table has UNIQUE workplace_ref — this is an exact match.
      const acceptedCsRef = this.opts.finalAcceptance.getAcceptedCandidateSetRef(
        serializeWorkplaceRef(workplace.ref),
      );
      let acceptedCandidate = acceptedCsRef
        ? this.opts.candidateSetRepo.read(acceptedCsRef)
        : null;
      // Crash recovery fallback: if FinalAcceptance was never recorded (factory
      // crashed between gate-accept and effect-settlement), resolve the accepted
      // author CandidateSet directly from the CandidateSet repository.
      if (!acceptedCandidate) {
        acceptedCandidate = this.acceptedAuthorCandidate(workplace.ref);
      }
      if (!acceptedCandidate || !cell.postAcceptanceEffect) {
        throw new NodeExecutionError(
          this.kind,
          node.id,
          `effect_pending Workplace lacks accepted candidate/effect declaration`,
        );
      }
      return this.settleAcceptanceEffect(node, cell, workplace, acceptedCandidate);
    }

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
      if (state.nextRole === 'author' && this.opts.authorCandidateCarryForward) {
        const semanticInputDigest = computeSemanticInputDigest(ctx, cell, workplace);
        const directive = this.opts.authorCandidateCarryForward.resolve({
          processRunId: ctx.processRunId,
          workplaceRef: workplace.ref,
          semanticInputDigest,
          itemSnapshotHash: sha256Hex(workplace.item),
          expectedProductSchemas: cell.productContracts.map(contract => contract.schemaRef),
        });
        if (directive) {
          this.opts.coordinator.presentCarriedForwardCandidate(
            workplace.ref,
            directive.presenterRef,
          );
          state = this.requireState(workplace.ref);
        }
      }
    }

    if (state.loopState === 'queued') {
      // A durable role task may already exist but still carry its prior active
      // projection (`in_progress` / `review_in_progress`) after a supervised
      // worker loss. If this exact role was not activated earlier in this
      // reconciliation cycle, re-activating its generation is idempotent and
      // makes queued Workplace authority claimable again. Author graph
      // projection is not proof that the current reviewer role is activated.
      if (!currentRoleProjectedThisCycle) {
        this.ensureRoleProjection(ctx, node, cell, workplace, state);
      }
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
    const carryDirective = role === 'author' && this.opts.authorCandidateCarryForward
      ? this.opts.authorCandidateCarryForward.resolve({
          processRunId: ctx.processRunId,
          workplaceRef: workplace.ref,
          semanticInputDigest: computeSemanticInputDigest(ctx, cell, workplace),
          itemSnapshotHash: sha256Hex(workplace.item),
          expectedProductSchemas: cell.productContracts.map(contract => contract.schemaRef),
        })
      : null;
    if (executionRef.startsWith('factory-carry-forward-presenter:') && !carryDirective) {
      throw new NodeExecutionError(this.kind, node.id, 'carried-forward presenter has no valid authorization');
    }
    const products = carryDirective
      ? carryDirective.products
      : this.opts.productReader.readContributionProducts({
          processRunId: ctx.processRunId,
          moduleRef,
          nodeId: node.id,
          contributorRef: executionRef,
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
      ? this.acceptedAuthorCandidate(workplace.ref)
      : null;
    const candidate = carryDirective
      ? this.sealCarriedForwardCandidateSet(workplace.ref, carryDirective)
      : this.sealCandidateSet(
          workplace.ref,
          executionRef,
          role,
          subjectAuthorSet?.candidateSetRef ?? null,
          products,
        );
    // ADR-053 B-8: sealing creates the durable RunGate obligation. A normal
    // lifecycle episode stops at that boundary. The fenced reconciler leases
    // the obligation and re-drives this idempotent node; only that leased
    // (`in_progress`) episode may enter GateRun.
    const runGateObligation = this.opts.obligationIntegrator.onCandidateSetSealed({
      candidateSetRef: candidate.candidateSetRef,
      candidateSetDigest: candidate.candidateSetDigest,
      workplaceRef: serializeWorkplaceRef(workplace.ref),
    });
    if (runGateObligation.state !== 'in_progress') {
      if (!carryDirective) this.opts.persistence.concludeExecutionIntent(executionRef);
      this.opts.persistence.projectWorkplace(workplace.ref);
      return pendingOutcome(candidate.candidateSetRef);
    }
    if (carryDirective) {
      this.opts.authorCandidateCarryForward!.consume({
        authorizationRef: carryDirective.authorizationRef,
        processRunId: ctx.processRunId,
        workplaceRef: workplace.ref,
        candidateSetRef: candidate.candidateSetRef,
        presenterRef: carryDirective.presenterRef,
      });
    }
    // Post-acceptance effects must run AFTER the durable transition. Running
    // them before applyGateDecision/applyReviewerVerdict is invalid: replay
    // capture's authority boundary is `terminal(accepted)`, which only exists
    // after the transition. Track the accepted candidate, apply the transition,
    // then fire effects only when the workplace is durably terminal(accepted).
    let postAcceptanceCandidate: CandidateSet | null = null;
    let nextHandoffReady = true;

    if (role === 'author') {
      const decision = this.runGate(
        ctx, workplace.ref, cell.authorGate, candidate.candidateSetRef, [],
        this.readGateUpstreamBinding(ctx, cell),
      );
      if (decision.verdict === 'accepted') {
        if (!cell.review) postAcceptanceCandidate = candidate;
        this.opts.coordinator.applyGateDecision(workplace.ref, {
          verdict: 'accepted', isFinal: !cell.review,
          effectRequired: !cell.review && Boolean(cell.postAcceptanceEffect),
          // ADR-053 C1 — record the accepted-author authority pointer atomically
          // with the CAS transition so acceptedAuthorCandidate reads the EXACT
          // accepted set, never sets[0] by hash order.
          acceptedCandidateSetRef: candidate.candidateSetRef,
          gateDecisionKey: decision.decisionKey,
          // ADR-053 C5-02 — bind the CURRENT workplace task at acceptance. The
          // authoritative source is the worker-execution→task binding
          // (readExecutionReceipt): the exact task the accepted execution was
          // launched for. This is carry-forward-safe — NOT submission.task_id
          // (the ORIGIN process's task, wrong after carry-forward) and NOT
          // ORDER BY t.id DESC (recency, wrong in repair cycles). A carry-forward
          // presenter has no worker receipt; it falls back to the durable
          // author-task projection for this workplace.
          acceptedAuthorTaskId: this.resolveAcceptedAuthorTaskId(executionRef, workplace.ref),
        });
        // ADR-053 B-8/C6 — gate accepted → effects must run (mandatory
        // obligation). The obligation carries the EXACT accepted GateDecision
        // identity (decisionKey + decisionDigest from runGate), not a fabricated
        // workplace-scoped string — so crash recovery redrives effects against
        // the precise accepted decision instead of guessing one by recency.
        nextHandoffReady = decision.transitionObligation?.state === 'in_progress';
      } else {
        this.opts.coordinator.applyGateDecision(workplace.ref, {
          verdict: decision.verdict,
          isFinal: !cell.review,
          repairTargetRole: decision.repairTargetRole ?? undefined,
          gateDecisionKey: decision.decisionKey,
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
        this.readGateUpstreamBinding(ctx, cell),
      );
      if (decision.verdict === 'accepted') {
        postAcceptanceCandidate = subjectAuthorSet;
        // ADR-053 B-8/C6 — reviewer gate accepted → effects must run (mandatory).
        // Obligation carries the EXACT reviewer GateDecision identity (not the
        // author subject's digest), so recovery redrives the right verdict.
        nextHandoffReady = decision.transitionObligation?.state === 'in_progress';
      }
      this.opts.coordinator.applyReviewerVerdict(workplace.ref, {
        verdict: decision.verdict,
        repairTargetRole: decision.repairTargetRole ?? undefined,
        effectRequired: decision.verdict === 'accepted' && Boolean(cell.postAcceptanceEffect),
        gateDecisionKey: decision.decisionKey,
      });
    }
    if (!carryDirective) this.opts.persistence.concludeExecutionIntent(executionRef);
    this.opts.persistence.projectWorkplace(workplace.ref);

    if (!nextHandoffReady) {
      return pendingOutcome(candidate.candidateSetRef);
    }

    state = this.requireState(workplace.ref);
    if (state.loopState === 'effect_pending') {
      if (!postAcceptanceCandidate) {
        throw new NodeExecutionError(this.kind, node.id, 'effect_pending has no accepted candidate');
      }
      return this.settleAcceptanceEffect(
        node,
        cell,
        workplace,
        postAcceptanceCandidate,
      );
    }
    if (state.loopState === 'terminal') {
      // Direct capture path: the transition is durable and the workplace is
      // terminal(accepted). Replay capture (and other post-acceptance effects)
      // run NOW — on the authoritative post-transition state. This is the
      // normal certification mechanism; the lazy claim-bound sweep remains as
      // a crash/reconciliation fallback only.
      if (postAcceptanceCandidate) {
        const settlementReady = this.recordFinalAcceptanceAndCapture(
          cell,
          workplace.ref,
          postAcceptanceCandidate,
          [],
        );
        if (!settlementReady) return pendingOutcome(candidate.candidateSetRef);
      }
      return this.terminalOutcome(workplace.ref, state);
    }
    if (state.loopState === 'paused') return pausedOutcome(candidate.candidateSetRef);
    if (state.loopState === 'queued') {
      this.ensureRoleProjection(ctx, node, cell, workplace, state);
    }
    return pendingOutcome(candidate.candidateSetRef);
  }

  private settleAcceptanceEffect(
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    workplace: MaterializedWorkplace,
    acceptedCandidate: CandidateSet,
  ): ReconcileOutcome {
    const effectId = cell.postAcceptanceEffect;
    if (!effectId) {
      throw new NodeExecutionError(this.kind, node.id, 'acceptance effect id is missing');
    }
    const existing = this.opts.finalAcceptance.readEffectReceipt(
      workplace.ref,
      effectId,
      acceptedCandidate.candidateSetRef,
    );
    let effectReceiptRef = existing?.effectReceiptRef ?? null;
    let finalAcceptanceObligation = null;
    if (!existing) {
      // Before an effect receipt exists, only the leased RunEffects obligation
      // may invoke the provider. After the receipt exists, authority has moved
      // to RecordFinalAcceptance and this prior handoff is expected to be
      // completed rather than in_progress.
      if (!this.gateEffectHandoffReady(workplace.ref, acceptedCandidate)) {
        return pendingOutcome(acceptedCandidate.candidateSetRef);
      }
      // ADR-053 Phase 6 — build AcceptedCandidateAuthority so effects consume
      // exact material coordinates (revision, productRefs, gateDecision)
      // instead of re-deriving from presenter provenance.
      const acceptedProductRefs = acceptedCandidate.members.map(m => m.productRef);
      const gateDecisionKey = this.opts.finalAcceptance.getAcceptedGateDecisionKey(
        serializeWorkplaceRef(workplace.ref), acceptedCandidate.candidateSetRef,
      );
      const productContract = cell.productContracts[0]?.payloadContract ?? null;
      const acceptanceDigest = computeAcceptanceDigest({
        candidateSetRef: acceptedCandidate.candidateSetRef,
        productionRevisionRef: acceptedCandidate.productionRevisionRef,
        acceptedProductRefs,
        gateDecisionKey,
      });
      const result = this.opts.postAcceptanceEffects.run(effectId, {
        authority: {
          workplaceRef: workplace.ref,
          candidateSetRef: acceptedCandidate.candidateSetRef,
          productionRevisionRef: acceptedCandidate.productionRevisionRef,
          acceptedProductRefs,
          productSchema: cell.productContracts[0]?.schemaRef ?? '',
          gateDecisionKey,
          productContractRef: productContract,
          acceptanceDigest,
        },
      });
      if (result.outcome === 'pending') return pendingOutcome(acceptedCandidate.candidateSetRef);
      if (result.outcome === 'repair_required') {
        this.opts.coordinator.requireAcceptanceEffectRepair(workplace.ref);
        this.opts.persistence.projectWorkplace(workplace.ref);
        return pendingOutcome(acceptedCandidate.candidateSetRef);
      }
      if (result.outcome === 'human_required') {
        this.opts.coordinator.applyGateDecision(workplace.ref, {
          verdict: 'human_required',
          isFinal: true,
        });
        this.opts.persistence.projectWorkplace(workplace.ref);
        return pausedOutcome(acceptedCandidate.candidateSetRef);
      }
      const committed = this.opts.finalAcceptance.transaction(() => {
        const receipt = this.opts.finalAcceptance.recordEffectReceipt({
          workplaceRef: workplace.ref,
          effectId,
          candidateSetRef: acceptedCandidate.candidateSetRef,
          result,
        });
        const obligation = this.opts.obligationIntegrator.onEffectsSettled({
          workplaceRef: serializeWorkplaceRef(workplace.ref),
          effectReceiptDigest: receipt.effectReceiptRef,
        });
        return { receipt, obligation };
      });
      effectReceiptRef = committed.receipt.effectReceiptRef;
      finalAcceptanceObligation = committed.obligation;
    }
    finalAcceptanceObligation ??= this.opts.obligationIntegrator.onEffectsSettled({
      workplaceRef: serializeWorkplaceRef(workplace.ref),
      effectReceiptDigest: effectReceiptRef!,
    });
    if (finalAcceptanceObligation.state !== 'in_progress') {
      return pendingOutcome(acceptedCandidate.candidateSetRef);
    }
    this.opts.coordinator.completeAcceptanceEffect(workplace.ref);
    this.opts.persistence.projectWorkplace(workplace.ref);
    const settlementReady = this.recordFinalAcceptanceAndCapture(
      cell,
      workplace.ref,
      acceptedCandidate,
      [effectReceiptRef!],
    );
    return settlementReady
      ? this.terminalOutcome(workplace.ref, this.requireState(workplace.ref))
      : pendingOutcome(acceptedCandidate.candidateSetRef);
  }

  private recordFinalAcceptanceAndCapture(
    cell: ProductionCellDefinition,
    workplaceRef: WorkplaceRef,
    acceptedCandidate: CandidateSet,
    effectReceiptRefs: readonly string[],
  ): boolean {
    // ADR-053 B-9/C6/C17 — resolve the EXACT accepted GateDecision key ONCE
    // (fail closed — no '' placeholder) and compute the real acceptance digest
    // once. The same (finalGateDecisionKey, acceptanceDigest) pair is shared by
    // the settle-process obligation, the replay-capture effect authority and the
    // receipt, so they provably consume the same exact acceptance rather than
    // re-deriving it from candidate-set digest or decided_at recency.
    const finalGateDecisionKey = this.opts.finalAcceptance.getAcceptedGateDecisionKey(
      serializeWorkplaceRef(workplaceRef), acceptedCandidate.candidateSetRef,
    );
    const acceptedProductRefs = acceptedCandidate.members.map(m => m.productRef);
    const acceptanceDigest = computeAcceptanceDigest({
      candidateSetRef: acceptedCandidate.candidateSetRef,
      productionRevisionRef: acceptedCandidate.productionRevisionRef,
      acceptedProductRefs,
      gateDecisionKey: finalGateDecisionKey,
    });
    // ADR-053 B-8 — final acceptance recorded → process must settle (mandatory).
    // The obligation digest is the REAL acceptance digest (not the candidate-set
    // digest), binding the handoff to the exact accepted material + decision.
    const settlementObligation = this.opts.finalAcceptance.transaction(() => {
      this.opts.finalAcceptance.recordFinalAcceptance({
        workplaceRef,
        candidateSetRef: acceptedCandidate.candidateSetRef,
        effectReceiptRefs,
        acceptedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      });
      return this.opts.obligationIntegrator.onFinalAcceptanceRecorded({
        finalAcceptanceRef: `final-acceptance:${serializeWorkplaceRef(workplaceRef)}:${acceptedCandidate.candidateSetRef}`,
        acceptanceDigest,
        workplaceRef: serializeWorkplaceRef(workplaceRef),
      });
    });
    if (settlementObligation.state !== 'in_progress') return false;
    const effectInput = {
      authority: {
        workplaceRef,
        candidateSetRef: acceptedCandidate.candidateSetRef,
        productionRevisionRef: acceptedCandidate.productionRevisionRef,
        acceptedProductRefs,
        productSchema: cell.productContracts[0]?.schemaRef ?? '',
        gateDecisionKey: finalGateDecisionKey,
        productContractRef: cell.productContracts[0]?.payloadContract ?? null,
        acceptanceDigest,
      },
    };
    // ADR-053 C8 — replay capture is a MANDATORY durable obligation, NOT
    // best-effort. It archives accepted production for future deterministic
    // replay, so a failure indicates a real defect (or a non-idempotent
    // capture) and MUST surface — silently swallowing it would leave the
    // workplace without a recoverable replay capsule and contradicts the
    // mandatory-obligation model. The effect itself is idempotent on the exact
    // acceptance identity, so a legitimate replay is safe to re-run.
    this.opts.postAcceptanceEffects.run('replay-capture', effectInput);
    return true;
  }

  /**
   * ADR-053 C8 — recover a terminal(accepted) Workplace whose FinalAcceptance
   * row is missing (crash between the gate-accept transition and
   * recordFinalAcceptanceAndCapture). Resolves the accepted author CandidateSet
   * and idempotently records FinalAcceptance + replay-capture. The accepted
   * candidate for a terminal(accepted) cell is the author set (for a no-review
   * cell it is the sealed author output; for a review cell it is the reviewer's
   * subject — both resolved as the workplace's accepted author candidate).
   */
  private ensureFinalAcceptanceForTerminalAccepted(
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    workplace: MaterializedWorkplace,
  ): boolean {
    const accepted = this.acceptedAuthorCandidate(workplace.ref);
    if (!accepted) {
      throw new NodeExecutionError(
        this.kind,
        node.id,
        `terminal(accepted) Workplace has no accepted author CandidateSet to finalize (C8 crash recovery)`,
      );
    }
    return this.recordFinalAcceptanceAndCapture(cell, workplace.ref, accepted, []);
  }

  /**
   * Recreate the exact GateAccepted obligation from the durable authority head
   * and admit the next handoff only while the reconciler owns its live lease.
   */
  private gateEffectHandoffReady(
    workplaceRef: WorkplaceRef,
    acceptedCandidate: CandidateSet,
  ): boolean {
    const decisionKey = this.opts.finalAcceptance.getAcceptedGateDecisionKey(
      serializeWorkplaceRef(workplaceRef),
      acceptedCandidate.candidateSetRef,
    );
    const decision = this.opts.gateRepo.readDecision(decisionKey);
    if (!decision || decision.verdict !== 'accepted') {
      throw new Error(`ACCEPTED_GATE_DECISION_NOT_FOUND: ${decisionKey}`);
    }
    return this.opts.obligationIntegrator.onGateAccepted({
      gateDecisionKey: decision.decisionKey,
      gateDecisionDigest: decision.decisionDigest,
      workplaceRef: serializeWorkplaceRef(workplaceRef),
    }).state === 'in_progress';
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
    const reviewerSubject = role === 'reviewer'
      ? this.acceptedAuthorCandidate(workplace.ref)
      : null;
    if (role === 'reviewer' && !reviewerSubject) {
      throw new NodeExecutionError(
        this.kind,
        node.id,
        `cell '${cell.id}' cannot project reviewer work without an author CandidateSet`,
      );
    }
    // A reviewer WorkIntent is authority over one exact immutable author set.
    // A repaired author set therefore receives a new intent/task generation;
    // the old reviewer authority is never silently retargeted.
    const generationKey = role === 'reviewer'
      ? `${serializeWorkplaceRef(workplace.ref)}:${role}:${sha256Hex(reviewerSubject!.candidateSetRef)}`
      : `${serializeWorkplaceRef(workplace.ref)}:${role}`;
    // FEEDBACK LOOP CLOSURE (continuation): a continuation run is created
    // BECAUSE the parent failed its acceptance gates. Its repair tasks must
    // carry the recorded causes (defectEvidence on the continuation recovery
    // snapshot) — otherwise every repair worker starts blind and guesses at
    // the defect (observed live: repair rounds fixed the wrong half).
    // Universal: reads the run input's continuationRecovery; no workshop or
    // cell names involved. Appended to the objective, which flows into the
    // task description and the worker's prompt.
    const defectEvidence = this.readContinuationDefectEvidence(ctx);
    const objective = defectEvidence
      ? `${cell.id}/${role}: ${node.description || node.label}\n\n`
        + `REPAIR CONTEXT (parent-run acceptance failures):\n`
        + defectEvidence
      : `${cell.id}/${role}: ${node.description || node.label}`;
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
    // One pre-projected task/intent can represent only a singleton cell. A
    // fan-out must derive one stable task+intent per Workplace; reusing the
    // same prepared card across items lets concurrent executions revoke each
    // other's fence and was observed as MANAGED_NODE_SUBMISSION_FENCE_LOST.
    const prepared = !cell.materialization.sourceBinding
      && Number.isInteger(preparedTaskId) && preparedTaskId > 0
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
          ...(role === 'author' && cell.productContracts[0]!.payloadContract
            ? { payload_contract: cell.productContracts[0]!.payloadContract }
            : role === 'reviewer' && cell.review?.payloadContract
              ? { payload_contract: cell.review.payloadContract }
              : {}),
          ...(role === 'reviewer'
            ? {
                payload_bindings: [{
                  field: 'subject_candidate_set_ref',
                  equals: reviewerSubject!.candidateSetRef,
                }],
              }
            : {}),
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
          ...(role === 'reviewer'
            ? { subject_candidate_set_ref: reviewerSubject!.candidateSetRef }
            : {}),
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
      productSource: cell.productContracts.find(c => c.schemaRef === node.outputSchema?.id)?.productSource,
    });
    return plan.taskId;
  }

  /**
   * ADR-053 C5-02 — resolve the CURRENT workplace task at author acceptance:
   * the task whose material is being accepted. This is the carry-forward-safe
   * task authority written to the accepted-authority head.
   *
   * Source (authoritative, in priority order):
   *   1. The worker-execution→task binding — `readExecutionReceipt(executionRef)`.
   *      This is the EXACT task the accepted execution was launched for, read by
   *      execution_id PK. It is neither `submission.task_id` (the ORIGIN
   *      process's task — wrong after carry-forward) nor `ORDER BY t.id DESC`
   *      (recency — wrong in repair cycles).
   *   2. The durable author-task projection — `readProjectedRoleTask(workplace,
   *      'author')`. Used when the producer is a kernel presenter (an authorized
   *      carry-forward) that deliberately has no worker receipt; the workplace's
   *      single stable author task (generationKey `${workplaceRef}:author`) is
   *      the current task whose material is being accepted.
   *
   * Returns the task id as a string (the head column is TEXT), or null when no
   * task can be resolved — the head still records the C1 pointer but leaves task
   * identity unbound, which downstream integration treats as "not yet bound".
   */
  private resolveAcceptedAuthorTaskId(executionRef: string, workplaceRef: WorkplaceRef): string | null {
    const receipt = this.opts.persistence.readExecutionReceipt(executionRef);
    if (receipt) return String(receipt.taskId);
    const projected = this.opts.persistence.readProjectedRoleTask?.(workplaceRef, 'author');
    return projected ? String(projected.taskId) : null;
  }

  /**
   * FEEDBACK LOOP CLOSURE — read the parent run's recorded acceptance
   * failures off the continuation recovery snapshot in the run input.
   * Returns null for ordinary (non-continuation) runs. The shape is the
   * externalBaselineSnapshot.defectEvidence array written by
   * prepareDevelopmentContinuation: {providerId, failedAt, message}.
   */
  private readContinuationDefectEvidence(ctx: NodeExecutionContext): string | null {
    const runInput = ctx.frame.runInput as {
      continuationRecovery?: {
        externalBaseline?: {
          defectEvidence?: unknown;
        };
      };
    } | undefined;
    const evidence = runInput?.continuationRecovery?.externalBaseline?.defectEvidence;
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    const lines: string[] = [];
    for (const entry of evidence) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { providerId?: unknown; failedAt?: unknown; message?: unknown };
      if (typeof record.message !== 'string' || record.message === '') continue;
      const provider = typeof record.providerId === 'string' ? record.providerId : 'unknown-check';
      const at = typeof record.failedAt === 'string' ? record.failedAt : '';
      lines.push(`- [${provider}${at ? ` @ ${at}` : ''}] ${record.message.slice(0, 900)}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
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
    // ADR-053 Phase 5 — assemble an immutable Workplace production revision
    // from the sealed products and carry its ref as the CandidateSet material
    // authority. Two executions producing the same products derive the same
    // revisionRef → same seal key → partition invariance (Run 011 fix).
    const revision = this.assembleRevisionFromProducts(
      workplaceRef, executionRef, products,
    );

    // ADR-053 B-1 — append the revision AND seal the CandidateSet in ONE
    // transaction: the set can never reference a revision that was not
    // persisted. revisionRepo is mandatory; if either write fails, neither
    // commits (all-or-nothing).
    const sealed = this.opts.revisionRepo.transaction(() => {
      // ADR-053 B-2 — partition convergence: if an equivalent revision (same
      // semanticDigest) already exists for this workplace, reuse its revisionRef
      // so the CandidateSet seal key (workplace + revisionRef + role) converges
      // across execution partitions (same material → one authority).
      const existing = this.opts.revisionRepo.getRevisionByMaterialDigest(
        revision.workplaceRef, revision.materialDigest,
      );
      const finalRevisionRef = existing?.revisionRef ?? revision.revisionRef;
      if (!existing) this.opts.revisionRepo.appendRevision(revision);
      const digest = candidateSetDigestForRevision({
        workplaceRef,
        productionRevisionRef: finalRevisionRef,
        role,
        subjectCandidateSetRef,
      });
      const set = this.opts.candidateSetRepo.seal({
        workplaceRef,
        productionRevisionRef: finalRevisionRef,
        role,
        subjectCandidateSetRef,
        members,
        sealReceiptRef: `seal:${executionRef}:${role}`,
        candidateSetDigest: digest,
        sealedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      }).set;
      // ADR-053 B-8/C7 — append the run-gate obligation INSIDE the same
      // transaction for EVERY sealed role (author AND reviewer): the obligation
      // is recorded iff the seal commits (atomic). A crash between seal and gate
      // leaves neither; a replay re-creates both. The reviewer obligation drives
      // the FINAL gate redrive; the author obligation drives the author gate.
      // obligationIntegrator is mandatory; append errors propagate and roll back
      // the seal.
      this.opts.obligationIntegrator.onCandidateSetSealed({
        candidateSetRef: set.candidateSetRef,
        candidateSetDigest: set.candidateSetDigest,
        workplaceRef: serializeWorkplaceRef(workplaceRef),
      });
      return set;
    });
    return sealed;
  }

  /**
   * ADR-053 B-1 — assemble a sealed Workplace production revision from a set of
   * ProductRefs. Each product becomes a revision member keyed by stable schema
   * + ordinal; execution-scoped ProductRef aliases remain provenance. The caller appends it
   * atomically with the CandidateSet seal (see sealCandidateSet).
   */
  private assembleRevisionFromProducts(
    workplaceRef: WorkplaceRef,
    executionRef: string,
    products: readonly ProductRef[],
  ): WorkplaceProductionRevision {
    if (products.length === 0) {
      throw new Error('CANNOT_SEAL_EMPTY_PRODUCT_SET: ADR-053 requires productionRevisionRef for every CandidateSet');
    }
    const workplaceSerialized = serializeWorkplaceRef(workplaceRef);
    // ADR-053 B-7 — route contribution building through the source adapter
    // boundary (producedProductsToContribution), not inline. The adapter
    // canonicalizes schema+content and excludes ProductRef row aliases from
    // material identity.
    const contribution = producedProductsToContribution({
      workplaceRef: workplaceSerialized,
      executionRef,
      products,
      validationReceipts: this.opts.persistence.readSubmissionValidationReceipts?.(executionRef) ?? [],
    });
    // ADR-053 C14 — the revision is CUMULATIVE: apply this execution's
    // contribution as a delta on top of the workplace's current accepted-author
    // revision (the durable authority head's revision), not parent:null. This
    // makes the revision a true cumulative desk state and proves the partition
    // property X+Y (one execution) ≡ X then Y (two executions): both arrive at
    // the same member set / semanticDigest. For a fresh first attempt (no head)
    // parent is null. `put` operations make a complete-set contribution
    // override the parent, so single-execution-complete seals are unaffected.
    const parent = this.currentAcceptedAuthorRevision(workplaceRef);
    return assembleRevision({
      workplaceRef: workplaceSerialized,
      parent,
      contributions: [contribution],
      presenterRef: executionRef,
    });
  }

  /**
   * ADR-053 C14 — the workplace's current accepted-author revision (the parent
   * for cumulative assembly), read from the durable authority head. Returns null
   * when no author acceptance has been recorded yet (fresh first attempt).
   */
  private currentAcceptedAuthorRevision(workplaceRef: WorkplaceRef): WorkplaceProductionRevision | null {
    const headCsRef = this.opts.authorityHead.readAuthorCandidateSetRef(
      serializeWorkplaceRef(workplaceRef),
    );
    if (!headCsRef) return null;
    const headCs = this.opts.candidateSetRepo.read(headCsRef);
    if (!headCs) return null;
    return this.opts.revisionRepo.getRevision(headCs.productionRevisionRef);
  }

  private sealCarriedForwardCandidateSet(
    workplaceRef: WorkplaceRef,
    directive: import('../../../infrastructure/workplace/sqlite-author-candidate-carry-forward.js').AuthorCandidateCarryForwardDirective,
  ): CandidateSet {
    const members: CandidateMember[] = directive.products.map(productRef => ({
      productRef,
      origin: 'carried-forward',
      sourceCandidateSetRef: directive.sourceCandidateSetRef,
    }));
    // ADR-053 B-1 — carry-forward seals append the revision and seal the set
    // atomically, same invariant as the produced-member path.
    const revision = this.assembleRevisionFromProducts(
      workplaceRef, directive.presenterRef, directive.products,
    );
    return this.opts.revisionRepo.transaction(() => {
      const existing = this.opts.revisionRepo.getRevisionByMaterialDigest(
        revision.workplaceRef, revision.materialDigest,
      );
      const finalRevisionRef = existing?.revisionRef ?? revision.revisionRef;
      if (!existing) this.opts.revisionRepo.appendRevision(revision);
      const digest = candidateSetDigestForRevision({
        workplaceRef,
        productionRevisionRef: finalRevisionRef,
        role: 'author',
        subjectCandidateSetRef: null,
      });
      const set = this.opts.candidateSetRepo.seal({
        workplaceRef,
        productionRevisionRef: finalRevisionRef,
        role: 'author',
        subjectCandidateSetRef: null,
        members,
        sealReceiptRef: `carry-forward-seal:${directive.authorizationRef}`,
        candidateSetDigest: digest,
        sealedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
      }).set;
      // ADR-053 C7 — a carried-forward author set feeds the current gate, so its
      // run-gate obligation is appended atomically with the seal (same invariant
      // as produced-member seals): a crash between carry-forward seal and gate
      // leaves neither; a replay re-creates both.
      this.opts.obligationIntegrator.onCandidateSetSealed({
        candidateSetRef: set.candidateSetRef,
        candidateSetDigest: set.candidateSetDigest,
        workplaceRef: serializeWorkplaceRef(workplaceRef),
      });
      return set;
    });
  }

  private runGate(
    ctx: NodeExecutionContext,
    workplaceRef: WorkplaceRef,
    gate: ProductionCellDefinition['authorGate'],
    subjectCandidateSetRef: string,
    assessmentCandidateSetRefs: readonly string[] = [],
    upstreamProductBinding: Readonly<Record<string, unknown>> = {},
  ) {
    return this.opts.gateRepo.transaction(() => {
      const decision = driveGateRun(this.opts.gateRepo, this.opts.checkProviders, {
        workplaceRef,
        subjectCandidateSetRef,
        assessmentCandidateSetRefs,
        checkPlan: gate.checkPlan,
        gatePhase: gate.gatePhase,
        expectedWorkplaceRevision: this.requireState(workplaceRef).revision,
        gateLeaseRef: `gate-lease:${sha256Hex({
          gatePhase: gate.gatePhase,
          subjectCandidateSetRef,
          assessmentCandidateSetRefs,
        })}`,
        installationDigest: this.opts.resolveInstallationDigest(ctx.module.identity.name),
        checkParameters: {
          processRunId: ctx.processRunId,
          moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
          ...upstreamProductBinding,
        },
        environmentRef: null,
      }).decision;
      const transitionObligation = decision.verdict === 'accepted'
        ? this.opts.obligationIntegrator.onGateAccepted({
            gateDecisionKey: decision.decisionKey,
            gateDecisionDigest: decision.decisionDigest,
            workplaceRef: serializeWorkplaceRef(workplaceRef),
          })
        : null;
      return { ...decision, transitionObligation };
    });
  }

  private readGateUpstreamBinding(
    ctx: NodeExecutionContext,
    cell: ProductionCellDefinition,
  ): Readonly<Record<string, unknown>> {
    const sourceBinding = cell.materialization.sourceBinding;
    if (!sourceBinding) return {};
    return readExactProductBinding(resolveSourceProduction(ctx, sourceBinding));
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
    // ADR-053 Phase 7: read the accepted CandidateSet by EXACT ref from
    // CellFinalAcceptance, not by recency (latestCandidate).
    const acceptedCsRef = this.opts.finalAcceptance.getAcceptedCandidateSetRef(
      serializeWorkplaceRef(ref),
    );
    const author = acceptedCsRef
      ? this.opts.candidateSetRepo.read(acceptedCsRef)
      : null;
    return {
      pending: false,
      paused: false,
      accepted: true,
      failed: false,
      products: author?.members.map(member => member.productRef) ?? [],
      candidateSetRef: author?.candidateSetRef ?? null,
      executionRef: author ? (this.opts.revisionRepo.getRevision(author.productionRevisionRef)?.presenterRef ?? null) : null,
    };
  }

  /**
   * ADR-053 clean-break: find the author CandidateSet for a workplace.
   * Uses deterministic candidate_set_ref ordering (NOT sealed_at recency).
   * The reviewer binds to this exact set as its subject.
   */
  private acceptedAuthorCandidate(ref: WorkplaceRef): CandidateSet | null {
    // ADR-053 C1 — read the EXACT accepted-author CandidateSet from the durable
    // authority pointer (written atomically with the author-gate-accept CAS
    // transition by the coordinator), NOT `sets[0]` by candidate_set_ref hash
    // order. In a repair cycle (multiple author attempts) the hash-order
    // selector could bind the reviewer subject / projection / crash recovery to
    // the WRONG attempt; the pointer is the single source of truth.
    const csRef = this.opts.authorityHead.readAuthorCandidateSetRef(
      serializeWorkplaceRef(ref),
    );
    return csRef ? this.opts.candidateSetRepo.read(csRef) : null;
  }

  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
    // Count sealed CandidateSets for this role as the primary attempt counter.
    // Each CandidateSet represents one completed gate-evaluated attempt.
    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role).length;
    // CGAD P18 / crash recovery: a crashed execution that never sealed a
    // CandidateSet still counts as an attempt. The Workplace's revision
    // reflects the number of transitions, which includes crash → repair_wait
    // cycles. This prevents infinite crash loops where the worker crashes
    // before sealing, attemptCount stays at the sealed count, and maxAttempts
    // is never reached.
    //
    // The crash-recovery fallback counts terminal (failed/lost) executions
    // for this workplace's task. It MUST apply even when sealedAttempts > 0,
    // because a crash can happen AFTER a sealed CandidateSet (e.g. during a
    // repair cycle: candidate₁ sealed → repair requested → repair-worker
    // crashes before candidate₂). In that case sealedAttempts=1 but the crash
    // must still expend retry budget.
    const state = this.opts.coordinator.readState(ref);
    if (state && state.loopState === 'repair_wait') {
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
    // (workplaceRef, candidateSetRef, presenter provenance, execution ids) is
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
 * Expose an exact content-addressed upstream product to installed check
 * providers. This is generic Gate request context, not a schema-specific
 * lookup: providers decide whether the triple is relevant. It replaces
 * process/kind/latest fallbacks and synthetic CandidateSets for kernel output.
 */
function readExactProductBinding(upstream: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(upstream)) return {};
  if (typeof upstream.schema !== 'string'
      || typeof upstream.artifactRef !== 'string'
      || typeof upstream.contentHash !== 'string') return {};
  return {
    upstreamProductSchema: upstream.schema,
    upstreamProductRef: upstream.artifactRef,
    upstreamProductDigest: upstream.contentHash,
  };
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
  // Entry cell: canonical business input. Strip run/operator provenance so the
  // cross-run semantic digest stays stable for the same product meaning.
  return sha256Hex(canonicalizeLifecycleInput(ctx.input));
}

/**
 * Canonicalize a lifecycle stage input for cross-run semantic identity.
 * Strips fields that carry run-specific provenance (certificate refs/hashes,
 * contract refs/hashes, operator initiation identity) while preserving all
 * business-semantic fields.
 */
function canonicalizeLifecycleInput(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(canonicalizeLifecycleInput);
  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      /certificate/i.test(key)
      || /contract/i.test(key)
      || /^initiated_?by$/i.test(key)
    ) continue;
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

function buildSealedGraph(
  nodeId: string,
  cell: ProductionCellDefinition,
  workplaces: readonly MaterializedWorkplace[],
  authorTaskIds: ReadonlyMap<string, number>,
): {
  graphRef: string;
  graphDigest: string;
  items: readonly {
    ordinal: number;
    itemId: string;
    workplaceRef: string;
    taskId: number;
    dependencyItemIds: readonly string[];
    dependencyWorkplaceRefs: readonly string[];
    dependencyTaskIds: readonly number[];
  }[];
} {
  const selector = cell.materialization.dependencySelector;
  if (!selector) {
    throw new NodeExecutionError('production-cell', nodeId,
      `cell '${cell.id}' has no dependency selector to seal`);
  }
  const byItemId = new Map<string, MaterializedWorkplace>();
  for (const workplace of workplaces) {
    if (byItemId.has(workplace.itemId)) {
      throw new NodeExecutionError('production-cell', nodeId,
        `cell '${cell.id}' has duplicate item id '${workplace.itemId}'`);
    }
    byItemId.set(workplace.itemId, workplace);
  }

  const dependencies = new Map<string, readonly string[]>();
  for (const workplace of workplaces) {
    const selected = rawStringArraySelector(workplace.item, selector, cell.id, workplace.itemId);
    if (new Set(selected).size !== selected.length) {
      throw new NodeExecutionError('production-cell', nodeId,
        `cell '${cell.id}' item '${workplace.itemId}' has duplicate dependencies`);
    }
    for (const dependencyId of selected) {
      if (dependencyId === workplace.itemId) {
        throw new NodeExecutionError('production-cell', nodeId,
          `cell '${cell.id}' item '${workplace.itemId}' depends on itself`);
      }
      if (!byItemId.has(dependencyId)) {
        throw new NodeExecutionError('production-cell', nodeId,
          `cell '${cell.id}' item '${workplace.itemId}' names unknown dependency '${dependencyId}'`);
      }
    }
    dependencies.set(workplace.itemId, selected);
  }
  assertAcyclicDependencies(nodeId, cell.id, dependencies);

  const items = workplaces.map((workplace, ordinal) => {
    const dependencyItemIds = dependencies.get(workplace.itemId) ?? [];
    const taskId = authorTaskIds.get(workplace.itemId);
    if (!taskId) {
      throw new NodeExecutionError('production-cell', nodeId,
        `cell '${cell.id}' item '${workplace.itemId}' has no author task projection`);
    }
    return {
      ordinal,
      itemId: workplace.itemId,
      workplaceRef: serializeWorkplaceRef(workplace.ref),
      taskId,
      dependencyItemIds,
      dependencyWorkplaceRefs: dependencyItemIds.map(id =>
        serializeWorkplaceRef(byItemId.get(id)!.ref)),
      dependencyTaskIds: dependencyItemIds.map(id => authorTaskIds.get(id)!),
    };
  });
  const graphDigest = sha256Hex({
    productionCellId: cell.id,
    items: items.map(item => ({
      ordinal: item.ordinal,
      itemId: item.itemId,
      workplaceRef: item.workplaceRef,
      taskId: item.taskId,
      dependencyItemIds: item.dependencyItemIds,
      dependencyWorkplaceRefs: item.dependencyWorkplaceRefs,
      dependencyTaskIds: item.dependencyTaskIds,
    })),
  });
  return {
    graphRef: `workplace-graph:${graphDigest}`,
    graphDigest,
    items,
  };
}

function rawStringArraySelector(
  value: unknown,
  selector: string,
  cellId: string,
  itemId: string,
): string[] {
  let selected = value;
  for (const segment of selector.split('.').filter(Boolean)) {
    if (!isRecord(selected)) {
      throw new Error(
        `PRODUCTION_CELL_DEPENDENCY_SELECTOR_INVALID: cell '${cellId}' item '${itemId}'`,
      );
    }
    selected = selected[segment];
  }
  if (!Array.isArray(selected) || !selected.every(item => typeof item === 'string')) {
    throw new Error(
      `PRODUCTION_CELL_DEPENDENCY_SELECTOR_INVALID: cell '${cellId}' item '${itemId}'`,
    );
  }
  return [...selected];
}

function assertAcyclicDependencies(
  nodeId: string,
  cellId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visited.has(itemId)) return;
    if (visiting.has(itemId)) {
      throw new NodeExecutionError('production-cell', nodeId,
        `cell '${cellId}' dependency graph contains a cycle at '${itemId}'`);
    }
    visiting.add(itemId);
    for (const dependencyId of dependencies.get(itemId) ?? []) visit(dependencyId);
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const itemId of dependencies.keys()) visit(itemId);
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
): {
  schema?: string;
  artifactRef?: string;
  contentHash: string;
  semanticDigest?: string;
  bindings: Record<string, unknown>;
} | null {
  const direct = ctx.frame.productions[sourceBinding];
  if (direct) {
    return {
      schema: direct.schema,
      artifactRef: direct.artifactRef,
      contentHash: direct.contentHash,
      semanticDigest: direct.semanticDigest,
      bindings: direct.bindings as Record<string, unknown>,
    };
  }
  const input = ctx.input as {
    schema?: unknown;
    artifactRef?: unknown;
    contentHash?: unknown;
    semanticDigest?: unknown;
    bindings?: unknown;
  } | null;
  if (input && typeof input.contentHash === 'string' && isRecord(input.bindings)) {
    return {
      schema: typeof input.schema === 'string' ? input.schema : undefined,
      artifactRef: typeof input.artifactRef === 'string' ? input.artifactRef : undefined,
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
