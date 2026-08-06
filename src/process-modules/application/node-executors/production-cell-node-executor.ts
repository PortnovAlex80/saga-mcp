/**
 * ProductionCellNodeExecutor — the universal NodeExecutor for
 * `production-cell` Flow nodes (ADR-029 Slice 1).
 *
 * This executor materializes a Workplace from the node's ProductionCellDefinition,
 * then drives the full bounded loop: admit → launch author → seal CandidateSet →
 * GateRun → apply GateDecision → (repair loop) → terminal.
 *
 * # Composition (not duplication)
 *
 * It does NOT re-implement worker launch. It composes three existing, proven
 * pieces:
 *   - {@link ProductionCellCoordinator} — Workplace state machine
 *     (materialize/admit/seal/applyGateDecision). Already tested (45 tests).
 *   - {@link LmNodeExecutor}'s launch pattern — project task +
 *     {@link WorkAssignmentPort.assignTask} + {@link WorkerExecutor.start} +
 *     poll-loop until worker_done. This is the production-proven launch path.
 *   - {@link driveGateRun} — the gate lifecycle driver built for the
 *     formalization architecture node.
 *
 * The launch path uses the SAME `WorkAssignmentPort` + `WorkerExecutorFactory`
 * the `LmNodeExecutor` and the dispatch-loop use — the canonical `WorkerLauncherPort`
 * remains wired-in-isolation for a future cutover (ADR-029 decision).
 *
 * # Blocking semantics
 *
 * `execute()` is async and BLOCKS (poll-loop) until the cell reaches a terminal
 * outcome. This mirrors `LmNodeExecutor` — the GenericFlowExecutor walks Flow
 * nodes sequentially, and a Production Cell is one node that internally runs a
 * whole author/review loop before the walk advances.
 *
 * # Slice 1 scope
 *
 * This first slice implements the SINGLETON path: one cell definition
 * materializes one Workplace (workKey=default). Fan-out (Slice 2) and the
 * reviewer phase (Slice 3) extend this same file.
 */

import os from 'node:os';
import { createHash } from 'node:crypto';

import type { ProductionCellFlowNodeDefinition } from '../../domain/process-module.js';
import type { ProductionCellDefinition } from '../../domain/workplace/production-cell-definition.js';
import {
  assertValidProductionCellDefinition,
} from '../../domain/workplace/production-cell-definition.js';
import type { WorkplaceRef } from '../../domain/workplace/workplace-ref.js';
import {
  DEFAULT_WORK_KEY,
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../domain/workplace/workplace-ref.js';
import { deriveWorkKey } from '../../domain/workplace/work-key-deriver.js';
import type { CandidateMember } from '../../domain/workplace/index.js';
import type { ProductRef } from '../../domain/spi/index.js';
import { ProductionCellCoordinator } from '../production-cell-coordinator.js';
import {
  driveGateRun,
  type CheckProviderRegistry,
  type GateRunDriverRepo,
} from '../gate-run-driver.js';
import type { SqliteCandidateSetRepository } from '../../../infrastructure/workplace/sqlite-candidate-set-repository.js';
import type {
  AssignedWork,
  WorkAssignmentPort,
  WorkerExecutor,
  WorkerExecutorFactory,
  WorkerExecutorFactoryContext,
} from '../../../application/ports/worker-executor.js';
import {
  NodeExecutionError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
  type NodeProduction,
} from '../node-executor.js';
import { asExecutionId } from '../../../lifecycle/domain/ids.js';

/**
 * Minimal persistence surface the executor needs to project a task for a cell
 * author/reviewer and read its terminal state. This mirrors the slice of
 * {@link LmNodeExecutionPersistence} the LM executor uses, kept narrow so a
 * concrete adapter (the same saga3 projection today) can satisfy it.
 */
export interface ProductionCellTaskPersistence {
  ensureExecutionPlan(input: {
    intent: {
      epicId: number;
      kind: string;
      objective: string;
      authorityScope: {
        snapshot_ref: string;
        scope: string;
        allowed_tools: string[];
        enforcement: 'advisory' | 'runtime';
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

  setIntentStatus(intentId: number, expected: string, next: string): boolean;
  prepareIntentForExecution(
    intentId: number,
    taskId: number,
  ): { status: 'ready' | 'active' | 'blocked' | 'done'; intentStatus: string };
  readTaskState(taskId: number): string | null;
  readCurrentExecutionId(taskId: number): string | null;
  readLatestExecutionId(taskId: number): string | null;
  readLatestManagedProductionExecutionId?(
    taskId: number,
    processRunId: number,
    nodeId: string,
  ): string | null;
  readTaskProjectRepositoryId(taskId: number): number | null;
  bindProjectedTaskProcessContext?(input: {
    taskId: number;
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    processInputHash: string;
    nodeInput: unknown;
    nodeInputHash: string;
    projectRepositoryId?: number | null;
    metadata?: Record<string, unknown>;
  }): void;
}

/**
 * Port the executor uses to read the products a worker submitted for a cell,
 * so it can seal them into a CandidateSet. In production this reads the
 * universal desk / managed-production ledger scoped by (processRunId, moduleRef,
 * nodeId, executionRef). Kept as a structural port so the executor is testable.
 */
export interface ProductionCellProductReader {
  /**
   * Return the exact ProductRefs the given execution produced on the given
   * cell's author (or reviewer) desk. Empty array is valid (the worker left no
   * typed product); the gate's fail-closed policy decides what that means.
   */
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
  readonly gateRepo: GateRunDriverRepo;
  readonly checkProviders: CheckProviderRegistry;
  readonly taskPersistence: ProductionCellTaskPersistence;
  readonly productReader: ProductionCellProductReader;
  readonly workerExecutorFactory: WorkerExecutorFactory;
  readonly resolveWorkerContext: (
    ctx: NodeExecutionContext,
    cell: ProductionCellDefinition,
    role: 'author' | 'reviewer',
    workKey: string,
  ) => WorkerExecutorFactoryContext;
  readonly workAssignment: WorkAssignmentPort;
  readonly installationDigest: string;
  readonly pollMs?: number;
  readonly maxRunMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export class ProductionCellNodeExecutor implements NodeExecutor {
  readonly kind = 'production-cell' as const;

  private readonly opts: ProductionCellNodeExecutorOptions;
  private executionSequence = 0;

  constructor(options: ProductionCellNodeExecutorOptions) {
    this.opts = options;
  }

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const node = ctx.node as ProductionCellFlowNodeDefinition;
    const cell = resolveCellDefinition(node);
    assertValidProductionCellDefinition(cell);

    if (ctx.epicId === null) {
      throw new NodeExecutionError(
        'production-cell',
        node.id,
        'Production Cell nodes require an epic scope (epicId is null)',
      );
    }

    const moduleRef = `${ctx.module.identity.name}@${ctx.module.identity.version}`;

    // Fan-out vs singleton: when the cell declares a materialization
    // sourceBinding, the runtime reads the accepted upstream binding and
    // materializes one Workplace per stable item id (REG-04-AC-03).
    if (cell.materialization.sourceBinding) {
      return this.driveFanOutCell(ctx, node, cell, moduleRef);
    }
    return this.driveSingletonCell(ctx, node, cell, moduleRef);
  }

  // -------------------------------------------------------------------------
  // Fan-out driver (Slice 2).
  // -------------------------------------------------------------------------

  private async driveFanOutCell(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
  ): Promise<NodeExecutionResult> {
    const sourceBinding = cell.materialization.sourceBinding!;
    const items = this.extractFanOutItems(ctx, node, sourceBinding);
    if (items.length === 0) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `fan-out cell '${cell.id}' found no items in source binding '${sourceBinding}'`,
      );
    }
    // Resolve the source content hash for workKey derivation scope. The source
    // production's contentHash pins the key space to one accepted version.
    const sourceProduction = this.resolveSourceProduction(ctx, sourceBinding);
    const sourceHash = sourceProduction?.contentHash ?? sourceBinding;

    // Phase 1: materialize all workplaces (idempotent), derive stable workKeys.
    const workplaces = items.map(item => {
      const workKey = deriveWorkKey(sourceHash, item.id);
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
      this.maybeAdmit(ref);
      return { item, workKey, ref };
    });

    // Phase 2: drive each non-terminal workplace through its author loop.
    // Sequential launch (one worker at a time) mirrors the LmNodeExecutor
    // pattern and keeps concurrency bounded; parallel launch is a future
    // optimization that must respect the global --concurrency=N budget.
    const outcomes: FanOutItemOutcome[] = [];
    for (const wp of workplaces) {
      const state = this.opts.coordinator.readState(wp.ref);
      if (state?.loopState === 'terminal') {
        // Already complete from a prior run (resume) — skip. We still record
        // the outcome so the completion join counts it.
        outcomes.push({
          item: wp.item,
          workKey: wp.workKey,
          ref: wp.ref,
          accepted: state.terminalReason === 'accepted',
          product: undefined,
          candidateSetRef: undefined,
        });
        continue;
      }
      const outcome = await this.driveFanOutItem(ctx, node, cell, wp);
      outcomes.push(outcome);
      // Continue to the next item even when this one failed: the completion
      // policy decides whether partial success is enough. Only 'all' demands
      // every item accepted, and we surface that at the join below. This lets
      // 'any'/'quorum' policies succeed with some failed items instead of
      // aborting the whole node on the first non-accepted verdict.
    }

    // Phase 3: completion join.
    const acceptedOutcomes = outcomes.filter(o => o.accepted);
    const acceptedCount = acceptedOutcomes.length;
    const policy = cell.materialization.completionPolicy;
    const satisfied =
      policy === 'all' ? acceptedCount === outcomes.length
      : policy === 'any' ? acceptedCount >= 1
      : policy === 'quorum' ? acceptedCount >= (cell.materialization.quorum ?? 1)
      : false;
    if (!satisfied) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `fan-out cell '${cell.id}' completion policy '${policy}' not satisfied: ` +
          `${acceptedCount}/${outcomes.length} accepted`,
      );
    }

    // Surface ALL accepted outputs as the node production. The primary
    // `production` carries the first accepted product (for Flow nodes that
    // read a single binding); the full manifest is exposed under
    // `production.bindings.items` so downstream settlement / readers can
    // reconstruct the complete set without re-querying the workplace records.
    // This corrects the earlier Slice 2 behaviour that only surfaced the first
    // product and forced downstream code to re-read state the executor already
    // held.
    return this.fanOutAcceptedResult(ctx, node, cell, acceptedOutcomes);
  }

  /**
   * Drive ONE fan-out item through its bounded author (+ optional reviewer)
   * loop. Mirrors the singleton driver's per-workplace logic but scoped to a
   * single workKey. Honours `cell.recovery.maxAttempts` for per-item repair.
   * On exhaustion the item is recorded as not-accepted (terminal failed); the
   * completion policy decides whether that fails the whole node.
   */
  private async driveFanOutItem(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    wp: { item: { readonly id: string }; workKey: string; ref: WorkplaceRef },
  ): Promise<FanOutItemOutcome> {
    const maxAttempts = cell.recovery.maxAttempts;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const authorExec = await this.launchAndWaitRole(
        ctx, node, cell, wp.ref, 'author', wp.workKey,
      );
      if (!authorExec.executionId) {
        throw new NodeExecutionError(
          'production-cell', node.id,
          `fan-out cell '${cell.id}' workKey '${wp.workKey}' author has no executionId`,
        );
      }
      const authorSetRef = this.sealCandidateSet(
        wp.ref, authorExec.executionId, 'author', null, authorExec.products,
      );
      this.opts.coordinator.sealCandidateSet(wp.ref);
      const decision = this.runGate(ctx, wp.ref, cell.authorGate, authorSetRef, 'author');
      if (decision.verdict === 'accepted') {
        if (cell.review) {
          const reviewResult = await this.driveReviewerPhase(
            ctx, node, cell, wp.ref, authorSetRef, authorExec,
          );
          if (reviewResult.runtimeEvent === 'completed') {
            // Final-accepted through review. Use the author product as the
            // item's accepted product (the reviewer verdict is evidence, not a
            // replacement — v4 §CandidateSet).
            return this.acceptedFanOutItem(wp, authorExec, authorSetRef);
          }
          // Reviewer-proven defect → repair author within the budget.
          if (attempts >= maxAttempts) {
            return this.exhaustedFanOutItem(ctx, node, cell, wp.ref, wp.item, wp.workKey);
          }
          continue;
        }
        this.opts.coordinator.applyGateDecision(wp.ref, {
          verdict: 'accepted', isFinal: true,
        });
        return this.acceptedFanOutItem(wp, authorExec, authorSetRef);
      }
      if (decision.verdict === 'repair_required') {
        this.opts.coordinator.applyGateDecision(wp.ref, {
          verdict: 'repair_required',
          isFinal: false,
          repairTargetRole: decision.repairTargetRole ?? 'author',
        });
        if (attempts >= maxAttempts) {
          return this.exhaustedFanOutItem(ctx, node, cell, wp.ref, wp.item, wp.workKey);
        }
        this.opts.coordinator.requeue(wp.ref, decision.repairTargetRole ?? 'author');
        continue;
      }
      if (decision.verdict === 'human_required') {
        this.opts.coordinator.applyGateDecision(wp.ref, {
          verdict: 'human_required', isFinal: true,
        });
        // human_required is terminal for this item (blocked). Not accepted.
        return {
          item: wp.item, workKey: wp.workKey, ref: wp.ref,
          accepted: false, product: undefined, candidateSetRef: undefined,
        };
      }
      // failed
      this.opts.coordinator.applyGateDecision(wp.ref, {
        verdict: 'failed', isFinal: true,
      });
      return {
        item: wp.item, workKey: wp.workKey, ref: wp.ref,
        accepted: false, product: undefined, candidateSetRef: undefined,
      };
    }
  }

  /**
   * Build an accepted outcome for one fan-out item from the author products.
   * Captures the full product (not just products[0]) so the manifest carries
   * every produced ProductRef.
   */
  private acceptedFanOutItem(
    wp: { item: { readonly id: string }; workKey: string; ref: WorkplaceRef },
    authorExec: RoleExecSummary,
    authorSetRef: string,
  ): FanOutItemOutcome {
    return {
      item: wp.item,
      workKey: wp.workKey,
      ref: wp.ref,
      accepted: true,
      product: authorExec.products[0] ?? null,
      products: authorExec.products,
      candidateSetRef: authorSetRef,
    };
  }

  private exhaustedFanOutItem(
    _ctx: NodeExecutionContext,
    _node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    ref: WorkplaceRef,
    item: { readonly id: string },
    workKey: string,
  ): FanOutItemOutcome {
    if (cell.recovery.onExhausted === 'fail') {
      this.opts.coordinator.applyGateDecision(ref, {
        verdict: 'failed', isFinal: true,
      });
    } else {
      this.opts.coordinator.applyGateDecision(ref, {
        verdict: 'human_required', isFinal: true,
      });
    }
    return {
      item, workKey, ref,
      accepted: false, product: undefined, candidateSetRef: undefined,
    };
  }

  /**
   * Assemble the node production for a completed fan-out cell. The primary
   * production is the first accepted product (single-binding downstream nodes);
   * the FULL manifest of accepted items is exposed under
   * `production.bindings.items` so settlement / cell-output readers can
   * reconstruct the complete set without re-querying workplace rows.
   */
  private fanOutAcceptedResult(
    ctx: NodeExecutionContext,
    _node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    acceptedOutcomes: readonly FanOutItemOutcome[],
  ): NodeExecutionResult {
    const primary = acceptedOutcomes[0]?.product;
    const moduleRef = `${ctx.module.identity.name}@${ctx.module.identity.version}`;
    const items = acceptedOutcomes.map(o => ({
      itemId: o.item.id,
      workKey: o.workKey,
      schema: o.product?.schemaId ?? null,
      artifactRef: o.product?.ref ?? null,
      contentHash: o.product?.digest ?? null,
      candidateSetRef: o.candidateSetRef ?? null,
      workplaceRef: serializeWorkplaceRef(o.ref),
    }));
    const production: NodeProduction | undefined = primary
      ? {
          schema: primary.schemaId,
          artifactRef: primary.ref,
          contentHash: primary.digest,
          bindings: {
            cellId: cell.id,
            moduleRef,
            items,
            acceptedCount: acceptedOutcomes.length,
          },
        }
      : {
          schema: cell.productContracts[0]?.schemaRef ?? 'factory.fanout-manifest.v1',
          artifactRef: `fanout-manifest:${ctx.processRunId}:${cell.id}`,
          contentHash: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
          bindings: { cellId: cell.id, moduleRef, items, acceptedCount: acceptedOutcomes.length },
        };
    return { runtimeEvent: 'completed', production };
  }

  /**
   * Extract the stable fan-out items from the accepted upstream binding.
   *
   * The source binding is a named entry in `ctx.frame.productions` (or the
   * node's chain input). Its `bindings` carry the accepted item list under a
   * well-known key. This reader is deliberately generic: it does not know
   * module vocabulary — it reads `items` (or falls back to scanning known
   * array-valued binding keys). A module that needs a custom selector can
   * declare it via `materialization.workKeySelector`.
   */
  private extractFanOutItems(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    sourceBinding: string,
  ): readonly { readonly id: string }[] {
    const production = this.resolveSourceProduction(ctx, sourceBinding);
    if (!production) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `fan-out source binding '${sourceBinding}' not found in frame`,
      );
    }
    const bindings = (production.bindings ?? {}) as Record<string, unknown>;
    // Prefer an explicit 'items' key; otherwise scan for the first array of
    // objects carrying a stable id field ('key' | 'id').
    const explicit = bindings.items;
    if (Array.isArray(explicit)) {
      return normalizeItems(explicit);
    }
    for (const value of Object.values(bindings)) {
      if (Array.isArray(value)) {
        const items = normalizeItems(value);
        if (items.length > 0) return items;
      }
    }
    return [];
  }

  private resolveSourceProduction(
    ctx: NodeExecutionContext,
    sourceBinding: string,
  ): { contentHash: string; bindings?: Record<string, unknown> } | null {
    const prod = ctx.frame.productions[sourceBinding];
    if (prod && typeof prod.contentHash === 'string') {
      return { contentHash: prod.contentHash, bindings: prod.bindings as Record<string, unknown> | undefined };
    }
    // Fall back to chain input when it is itself a production-shaped value.
    const input = ctx.input as { contentHash?: unknown; bindings?: unknown; schema?: unknown } | null;
    if (
      input
      && typeof input.contentHash === 'string'
      && typeof input.schema === 'string'
    ) {
      return {
        contentHash: input.contentHash,
        bindings: (input.bindings as Record<string, unknown> | undefined),
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Singleton driver.
  // -------------------------------------------------------------------------

  private async driveSingletonCell(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    moduleRef: string,
  ): Promise<NodeExecutionResult> {
    const ref = asWorkplaceRef({
      processRunId: ctx.processRunId,
      moduleRef,
      productionCellId: cell.id,
      workKey: DEFAULT_WORK_KEY,
    });

    // 1. Materialize (idempotent) + admit.
    this.opts.coordinator.materializeCell({
      processRunId: ctx.processRunId,
      moduleRef,
      productionCellId: cell.id,
      workKey: DEFAULT_WORK_KEY,
    });
    this.maybeAdmit(ref);

    // Resume fast-path: if a prior run already drove this workplace to a
    // terminal-accepted state, re-execute must NOT relaunch. Reconstruct the
    // accepted production from the persisted CandidateSet instead. This is
    // the crash-resume guarantee: accepted products are never regenerated.
    const existingState = this.opts.coordinator.readState(ref);
    if (existingState?.loopState === 'terminal'
      && existingState.terminalReason === 'accepted') {
      return this.resumeAcceptedSingleton(ctx, node, cell, ref);
    }

    // 2. Author loop with bounded repair.
    let attempts = 0;
    const maxAttempts = cell.recovery.maxAttempts;
    for (;;) {
      attempts += 1;
      // Author execution: project task, launch worker, wait for worker_done.
      const authorExec = await this.launchAndWaitRole(
        ctx, node, cell, ref, 'author', DEFAULT_WORK_KEY,
      );
      // 3. Seal the author CandidateSet from the worker's products.
      if (!authorExec.executionId) {
        throw new NodeExecutionError(
          'production-cell', node.id,
          `cell '${cell.id}' author execution has no executionId — cannot seal`,
        );
      }
      const authorSetRef = this.sealCandidateSet(ref, authorExec.executionId, 'author', null, authorExec.products);
      // 4. Author gate.
      this.opts.coordinator.sealCandidateSet(ref);
      const authorDecision = this.runGate(ctx, ref, cell.authorGate, authorSetRef, 'author');
      // 5. Apply decision.
      if (authorDecision.verdict === 'accepted') {
        if (cell.review) {
          // Slice 3: drive the reviewer phase. When it returns 'completed' the
          // cell is accepted; when it returns 'paused' (final gate requested
          // repair), fall through to the repair/requeue handling below to
          // re-enter the author loop within the recovery budget.
          const reviewResult = await this.driveReviewerPhase(
            ctx, node, cell, ref, authorSetRef, authorExec,
          );
          if (reviewResult.runtimeEvent === 'completed') {
            return reviewResult;
          }
          // Reviewer-proven defect (or final-gate repair). The coordinator's
          // reviewer-verdict(defect-proven) moved the workplace to
          // in_progress/repair_wait with nextRole=author. Requeue it back to
          // queued so the next author attempt can launch through
          // markWorkerLaunched (which requires loopState='queued').
          this.opts.coordinator.requeue(ref, 'author');
          if (attempts >= maxAttempts) {
            if (cell.recovery.onExhausted === 'fail') {
              this.opts.coordinator.applyGateDecision(ref, {
                verdict: 'failed', isFinal: true,
              });
              throw new NodeExecutionError(
                'production-cell', node.id,
                `cell '${cell.id}' exhausted recovery budget after review (${maxAttempts} attempts)`,
              );
            }
            this.opts.coordinator.applyGateDecision(ref, {
              verdict: 'human_required', isFinal: true,
            });
            return { runtimeEvent: 'paused', production: undefined };
          }
          continue;
        }
        this.opts.coordinator.applyGateDecision(ref, {
          verdict: 'accepted', isFinal: true,
        });
        return this.acceptedResult(ctx, node, cell, authorExec, authorSetRef);
      }
      if (authorDecision.verdict === 'repair_required') {
        this.opts.coordinator.applyGateDecision(ref, {
          verdict: 'repair_required',
          isFinal: false,
          repairTargetRole: authorDecision.repairTargetRole ?? 'author',
        });
        if (attempts >= maxAttempts) {
          if (cell.recovery.onExhausted === 'fail') {
            this.opts.coordinator.applyGateDecision(ref, {
              verdict: 'failed', isFinal: true,
            });
            throw new NodeExecutionError(
              'production-cell', node.id,
              `cell '${cell.id}' exhausted recovery budget (${maxAttempts} attempts)`,
            );
          }
          this.opts.coordinator.applyGateDecision(ref, {
            verdict: 'human_required', isFinal: true,
          });
          return { runtimeEvent: 'paused', production: undefined };
        }
        // Requeue the author role for another repair round.
        this.opts.coordinator.requeue(ref, authorDecision.repairTargetRole ?? 'author');
        continue;
      }
      if (authorDecision.verdict === 'human_required') {
        this.opts.coordinator.applyGateDecision(ref, {
          verdict: 'human_required', isFinal: true,
        });
        return { runtimeEvent: 'paused', production: undefined };
      }
      // failed
      this.opts.coordinator.applyGateDecision(ref, {
        verdict: 'failed', isFinal: true,
      });
      throw new NodeExecutionError(
        'production-cell', node.id,
        `cell '${cell.id}' author gate verdict 'failed'`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reviewer phase (Slice 3).
  // -------------------------------------------------------------------------

  private async driveReviewerPhase(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    ref: WorkplaceRef,
    authorSetRef: string,
    _authorExec: RoleExecSummary,
  ): Promise<NodeExecutionResult> {
    if (!cell.review) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `driveReviewerPhase called on cell '${cell.id}' with no review declared`,
      );
    }
    // Author gate accepted with review → route the same card to review.
    this.opts.coordinator.applyGateDecision(ref, {
      verdict: 'accepted', isFinal: false,
    });

    // Launch the reviewer execution on the same Workplace.
    const reviewerExec = await this.launchAndWaitRole(
      ctx, node, cell, ref, 'reviewer', ref.workKey,
    );
    if (!reviewerExec.executionId) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `cell '${cell.id}' reviewer execution has no executionId`,
      );
    }
    // Seal the reviewer CandidateSet. The subject is the author set: the
    // reviewer's verdict is evidence ABOUT the author product, never a
    // replacement for it (CONVEYOR-MENTAL-MODEL v4 §CandidateSet).
    const reviewerSetRef = this.sealCandidateSet(
      ref, reviewerExec.executionId, 'reviewer', authorSetRef, reviewerExec.products,
    );
    this.opts.coordinator.sealCandidateSet(ref);

    // Final gate: runs over the author set WITH the reviewer evidence. The
    // reviewer CandidateSet ref is passed as an assessment set so the gate's
    // check providers can read the reviewer verdict.
    const finalDecision = this.runGate(
      ctx, ref, cell.review.finalGate, authorSetRef, 'final', [reviewerSetRef],
    );

    if (finalDecision.verdict === 'accepted') {
      this.opts.coordinator.applyReviewerVerdict(ref, {
        verdict: 'accepted',
      });
      return this.acceptedResult(ctx, node, cell, reviewerExec, authorSetRef);
    }
    if (finalDecision.verdict === 'repair_required') {
      // Reviewer-proven author defect. The reducer moves review_in_progress →
      // in_progress/repair_wait (semantic backward transition, REG-28-AC-04).
      // The caller requeues within its recovery budget.
      this.opts.coordinator.applyReviewerVerdict(ref, {
        verdict: 'repair_required',
        repairTargetRole: finalDecision.repairTargetRole ?? 'author',
      });
      // The reducer already set nextRole=author via defect-proven, so requeue
      // is only needed if the kanban phase requires it. The caller's repair
      // loop re-enters the author loop on the next attempt.
      return { runtimeEvent: 'paused', production: undefined };
    }
    if (finalDecision.verdict === 'human_required') {
      this.opts.coordinator.applyReviewerVerdict(ref, {
        verdict: 'human_required',
      });
      return { runtimeEvent: 'paused', production: undefined };
    }
    // failed: reviewer produced invalid output. The reducer sets repair_wait
    // with nextRole=reviewer. Surface as a hard error to the caller — the
    // singleton driver's recovery budget applies.
    this.opts.coordinator.applyReviewerVerdict(ref, {
      verdict: 'failed',
    });
    throw new NodeExecutionError(
      'production-cell', node.id,
      `cell '${cell.id}' final gate verdict 'failed'`,
    );
  }

  // -------------------------------------------------------------------------
  // Worker launch + poll (mirrors LmNodeExecutor's proven pattern).
  // -------------------------------------------------------------------------

  /**
   * Project a task for the given role + workKey, atomically assign it, launch a
   * worker, poll until it reports worker_done (task→review/done), then return
   * the execution id + products the worker left on the desk.
   */
  private async launchAndWaitRole(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    ref: WorkplaceRef,
    role: 'author' | 'reviewer',
    workKey: string,
  ): Promise<RoleExecSummary> {
    const profile = role === 'author' ? cell.author : cell.review?.reviewer;
    if (!profile) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `cell '${cell.id}' has no ${role} profile`,
      );
    }
    const objective = this.buildObjective(ctx, node, cell, role);
    // The generationKey must be STABLE across a crash-resume of the SAME
    // attempt (so a concluded attempt is replayed, not re-launched) but
    // DISTINCT across repair rounds (so a fresh repair attempt gets a fresh
    // task/intent). The workplace revision is monotonic and increments on
    // every transition — including the requeue that starts a repair round —
    // so pinning it into the key gives exactly this behaviour. We read the
    // current revision BEFORE launching; the coordinator's markWorkerLaunched
    // will bump it further, but the pre-launch value is the stable identity
    // for this attempt.
    const preLaunchState = this.opts.coordinator.readState(ref);
    const attemptRevision = preLaunchState?.revision ?? 0;
    const generationKey = `process-run:${ctx.processRunId}:cell:${cell.id}:${workKey}:${role}:rev${attemptRevision}`;
    const snapshotRef = serializeWorkplaceRef(ref);

    const plan = this.opts.taskPersistence.ensureExecutionPlan({
      intent: {
        epicId: ctx.epicId!,
        kind: `production-cell.${role}`,
        objective,
        authorityScope: {
          snapshot_ref: snapshotRef,
          scope: profile.skillRef,
          allowed_tools: [],
          enforcement: 'runtime' as const,
        },
        outputSchema: cell.productContracts[0]?.schemaRef ?? 'factory.product-envelope.v1',
        tokenBudget: 0,
        retryBudget: cell.recovery.maxAttempts,
      },
      task: {
        epicId: ctx.epicId!,
        projectId: ctx.projectId,
        objective,
        taskKind: `${role}.cell`,
        executionSkill: profile.skillRef,
        reviewSkill: null,
        generationKey,
        workflowStage: ctx.module.identity.kind,
        executionMode: 'git_change',
        titlePrefix: `${cell.id}/${role}: `,
        metadata: {
          process_run_id: ctx.processRunId,
          process_node_id: node.id,
          process_module_ref: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
          workplace_ref: snapshotRef,
          production_cell_id: cell.id,
          work_key: workKey,
          role,
        },
      },
    });
    const taskId = plan.taskId;
    const intentId = plan.intentId;

    const repoId = this.opts.taskPersistence.readTaskProjectRepositoryId(taskId);
    this.opts.taskPersistence.bindProjectedTaskProcessContext?.({
      taskId,
      processRunId: ctx.processRunId,
      nodeId: node.id,
      moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
      processInputHash: '',
      nodeInput: ctx.input,
      nodeInputHash: '',
      projectRepositoryId: repoId,
      metadata: {
        workplace_ref: snapshotRef,
        production_cell_id: cell.id,
        work_key: workKey,
        role,
      },
    });

    const preparation = this.opts.taskPersistence.prepareIntentForExecution(intentId, taskId);
    if (preparation.status === 'done') {
      // Already concluded by a prior run (resume) — read the existing products.
      const executionId = this.opts.taskPersistence.readLatestManagedProductionExecutionId?.(
        taskId, ctx.processRunId, node.id,
      ) ?? this.opts.taskPersistence.readLatestExecutionId(taskId) ?? null;
      const products = executionId
        ? this.readProducts(ctx, node, executionId)
        : [];
      // The worker already finished in a prior run, but the Workplace state
      // machine may not have advanced through leased → running (e.g. the crash
      // happened after the worker reported done but before the seal). Drive
      // the loop transitions idempotently so the subsequent seal is valid:
      // markWorkerLaunched applies queued→leased→running, and is a no-op-safe
      // sequence (the reducer CAS-guards each step; if already running the
      // caller's sealCandidateSet proceeds). We use the existing executionId
      // as the fence token — it is the canonical identity of that attempt.
      if (executionId) {
        try {
          this.opts.coordinator.markWorkerLaunched(ref, executionId);
        } catch {
          // Already past 'queued' (e.g. a prior run advanced it) — safe to
          // ignore; the seal step below will assert the correct state.
        }
      }
      return { executionId, taskId, products, replayed: true };
    }
    if (preparation.status === 'active' || preparation.status === 'blocked') {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `projected task ${taskId} for cell '${cell.id}' ${role} is ${preparation.status}`,
      );
    }

    if (!this.opts.taskPersistence.setIntentStatus(intentId, preparation.intentStatus, 'executing')) {
      throw new NodeExecutionError(
        'production-cell', node.id,
        `lost CAS race preparing ${role} execution for cell '${cell.id}'`,
      );
    }

    // Generate fence token + assign + launch (the LmNodeExecutor pattern).
    const seq = ++this.executionSequence;
    const workerExecutionId =
      `exec-${ctx.projectId}-${process.pid}-${Date.now()}-${seq}`;
    const workerId = `cell-${ctx.processRunId}-${cell.id}-${workKey}-${role}-${seq}`;
    const runId = `process-run-${ctx.processRunId}`;
    const machineId = safeMachineId();

    const workerCtx = this.opts.resolveWorkerContext(ctx, cell, role, workKey);
    const workerExecutor = this.opts.workerExecutorFactory(workerCtx);
    ctx.heartbeat();

    let preassignedWork: AssignedWork | null;
    try {
      preassignedWork = this.opts.workAssignment.assignTask({
        projectId: ctx.projectId,
        epicId: ctx.epicId ?? undefined,
        workerId,
        workerExecutionId: asExecutionId(workerExecutionId),
        runId,
        machineId,
        taskIds: [taskId],
      });
      if (preassignedWork === null) {
        throw new NodeExecutionError(
          'production-cell', node.id,
          `assignTask returned no card for ${role} task ${taskId} of cell '${cell.id}'`,
        );
      }
      workerExecutor.start({
        projectId: ctx.projectId,
        epicId: ctx.epicId,
        concurrency: 1,
        assignment: preassignedWork,
      });
      // Drive the Workplace state-machine side of the launch: queued → leased
      // → running. The spawn path (WorkAssignmentPort + WorkerExecutorFactory)
      // performs claim/fence/spawn but does NOT touch Workplace state; without
      // these two transitions the subsequent `candidate-sealed` event would be
      // a NO_TRANSITION (reducer requires loopState='running'). Decouples
      // SPAWN (infrastructure) from WORKPLACE STATE (domain).
      this.opts.coordinator.markWorkerLaunched(ref, workerExecutionId);
    } catch (error) {
      this.opts.taskPersistence.setIntentStatus(intentId, 'executing', 'paused');
      try { workerExecutor.dispose(); } catch { /* best effort */ }
      throw error;
    }

    // Poll until worker_done (task → review OR done) or failure.
    const pollMs = this.opts.pollMs ?? 2000;
    const maxRunMs = this.opts.maxRunMs ?? 30 * 60 * 1000;
    const sleep = this.opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
    const startedAt = (this.opts.now ?? (() => new Date()))().getTime();
    let executionId = this.opts.taskPersistence.readCurrentExecutionId(taskId);
    let terminal: 'clean' | 'failed' | 'timeout' = 'timeout';
    try {
      for (;;) {
        ctx.heartbeat();
        executionId ??= this.opts.taskPersistence.readCurrentExecutionId(taskId);
        const taskStatus = this.opts.taskPersistence.readTaskState(taskId);
        const run = workerExecutor.status(ctx.projectId);
        const runStatus = run?.status ?? null;
        const taskStillActive = run?.active?.some(w => w.task_id === taskId) ?? false;
        const taskDoneOrReview = taskStatus === 'done' || taskStatus === 'review';
        if (run === null) { terminal = 'failed'; break; }
        if (runStatus === 'failed') { terminal = 'failed'; break; }
        if (runStatus === 'stopped') { terminal = 'failed'; break; }
        if (taskDoneOrReview && !taskStillActive) { terminal = 'clean'; break; }
        if ((this.opts.now ?? (() => new Date()))().getTime() - startedAt > maxRunMs) {
          terminal = 'timeout'; break;
        }
        await sleep(pollMs);
      }
    } catch (error) {
      this.opts.taskPersistence.setIntentStatus(intentId, 'executing', 'paused');
      try { workerExecutor.stop(ctx.projectId); } catch { /* best effort */ }
      try { workerExecutor.dispose(); } catch { /* best effort */ }
      throw error;
    } finally {
      if (terminal !== 'clean') {
        try { workerExecutor.stop(ctx.projectId); } catch { /* best effort */ }
      }
      try { workerExecutor.dispose(); } catch { /* best effort */ }
    }

    if (terminal !== 'clean') {
      this.opts.taskPersistence.setIntentStatus(intentId, 'executing', 'paused');
      throw new NodeExecutionError(
        'production-cell', node.id,
        `${role} worker for cell '${cell.id}' ended ${terminal}`,
      );
    }

    this.opts.taskPersistence.setIntentStatus(intentId, 'executing', 'concluded');
    const cleanExec =
      this.opts.taskPersistence.readLatestManagedProductionExecutionId?.(
        taskId, ctx.processRunId, node.id,
      ) ?? executionId ?? this.opts.taskPersistence.readLatestExecutionId(taskId);
    const products = cleanExec ? this.readProducts(ctx, node, cleanExec) : [];
    return { executionId: cleanExec, taskId, products, replayed: false };
  }

  // -------------------------------------------------------------------------
  // CandidateSet seal + gate.
  // -------------------------------------------------------------------------

  private sealCandidateSet(
    ref: WorkplaceRef,
    producerExecutionRef: string,
    role: 'author' | 'reviewer',
    subjectCandidateSetRef: string | null,
    products: readonly ProductRef[],
  ): string {
    const members: CandidateMember[] = products.map(p => ({
      productRef: p,
      origin: 'produced' as const,
      sourceCandidateSetRef: null,
    }));
    const digest = createHash('sha256')
      .update(JSON.stringify({ ref: serializeWorkplaceRef(ref), producerExecutionRef, role, products }))
      .digest('hex');
    const sealReceiptRef = `seal:${serializeWorkplaceRef(ref)}:${producerExecutionRef}:${role}`;
    const result = this.opts.candidateSetRepo.seal({
      workplaceRef: ref,
      producerExecutionRef,
      role,
      subjectCandidateSetRef,
      members,
      sealReceiptRef,
      candidateSetDigest: digest,
      sealedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
    });
    return result.set.candidateSetRef;
  }

  private runGate(
    ctx: NodeExecutionContext,
    ref: WorkplaceRef,
    gate: ProductionCellDefinition['authorGate'],
    subjectCandidateSetRef: string,
    gatePhase: 'author' | 'final',
    assessmentCandidateSetRefs: readonly string[] = [],
  ) {
    const state = this.opts.coordinator.readState(ref);
    const { decision } = driveGateRun(
      this.opts.gateRepo,
      this.opts.checkProviders,
      {
        workplaceRef: ref,
        subjectCandidateSetRef,
        checkPlan: gate.checkPlan,
        gatePhase,
        expectedWorkplaceRevision: state?.revision ?? 0,
        gateLeaseRef: `gate-lease:${serializeWorkplaceRef(ref)}:${gatePhase}`,
        installationDigest: this.opts.installationDigest,
        checkParameters: {
          processRunId: ctx.processRunId,
          moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
          assessmentCandidateSetRefs: assessmentCandidateSetRefs,
        },
        environmentRef: null,
      },
    );
    return decision;
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private readProducts(
    ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    executionRef: string,
  ): readonly ProductRef[] {
    return this.opts.productReader.readExecutionProducts({
      processRunId: ctx.processRunId,
      moduleRef: `${ctx.module.identity.name}@${ctx.module.identity.version}`,
      nodeId: node.id,
      executionRef,
    });
  }

  private buildObjective(
    _ctx: NodeExecutionContext,
    node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    role: 'author' | 'reviewer',
  ): string {
    return `${cell.id}/${role}: ${node.description || node.label}`;
  }

  private maybeAdmit(ref: WorkplaceRef): void {
    const state = this.opts.coordinator.readState(ref);
    if (state && state.kanbanPhase === 'todo' && state.loopState === 'idle') {
      this.opts.coordinator.admitWork(ref);
    }
  }

  /**
   * Reconstruct the accepted node production for a terminal-accepted singleton
   * workplace on crash-resume. Reads the durable sealed author CandidateSet
   * (and, for a reviewed cell, the reviewer set) and rebuilds the
   * {@link NodeExecutionResult} from it — WITHOUT relaunching a worker.
   *
   * This is the resume guarantee: accepted products are content-addressed and
   * immutable; a resumed run re-emits the same digest, never a regenerated one.
   */
  private resumeAcceptedSingleton(
    ctx: NodeExecutionContext,
    _node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    ref: WorkplaceRef,
  ): NodeExecutionResult {
    const sets = this.opts.candidateSetRepo.listForWorkplace(ref);
    // The author set is the one with role='author' and no subject (it is the
    // subject of the reviewer set, not itself an assessment).
    const authorSet = sets.find(s => s.role === 'author') ?? null;
    const products: ProductRef[] = authorSet
      ? authorSet.members.map(m => m.productRef)
      : [];
    const authorSetRef = authorSet?.candidateSetRef ?? '';
    const bindings: Record<string, unknown> = {};
    if (products.length > 0 && cell.productContracts.length > 0) {
      bindings[cell.productContracts[0]!.binding] = products;
    }
    const production = products[0]
      ? {
          schema: products[0].schemaId,
          artifactRef: products[0].ref,
          contentHash: products[0].digest,
          bindings: {
            ...bindings,
            candidateSetRef: authorSetRef,
            cellId: cell.id,
            resumed: true,
          },
        }
      : undefined;
    void ctx;
    return {
      runtimeEvent: 'completed',
      production,
    };
  }

  private acceptedResult(
    _ctx: NodeExecutionContext,
    _node: ProductionCellFlowNodeDefinition,
    cell: ProductionCellDefinition,
    authorExec: RoleExecSummary,
    authorSetRef: string,
  ): NodeExecutionResult {
    // The cell's accepted output bindings come from the product contracts.
    // For Slice 1 we surface the author's products as the node production so
    // the downstream settlement kernel / Flow handoff can read them.
    const bindings: Record<string, unknown> = {};
    if (authorExec.products.length > 0 && cell.productContracts.length > 0) {
      bindings[cell.productContracts[0]!.binding] = authorExec.products;
    }
    const production = authorExec.products[0]
      ? {
          schema: authorExec.products[0].schemaId,
          artifactRef: authorExec.products[0].ref,
          contentHash: authorExec.products[0].digest,
          bindings: { ...bindings, candidateSetRef: authorSetRef, cellId: cell.id },
        }
      : undefined;
    return {
      runtimeEvent: 'completed',
      production,
      receipt: authorExec.executionId
        ? {
            kind: 'task-execution' as const,
            executorKind: 'lm' as const,
            intentId: 0,
            taskId: authorExec.taskId,
            executionId: authorExec.executionId,
            runtimeStatus: 'completed' as const,
            replayed: authorExec.replayed,
          }
        : undefined,
    };
  }
}

// -------------------------------------------------------------------------
// Internal helpers + types.
// -------------------------------------------------------------------------

interface RoleExecSummary {
  executionId: string | null;
  taskId: number;
  products: readonly ProductRef[];
  replayed: boolean;
}

/**
 * Outcome of driving one fan-out item through its author (+ optional reviewer)
 * loop. `accepted` records whether the item reached terminal-accepted; when it
 * did, `product` / `products` / `candidateSetRef` capture the accepted output
 * so the completion join can assemble the full manifest.
 */
interface FanOutItemOutcome {
  item: { readonly id: string };
  workKey: string;
  ref: WorkplaceRef;
  accepted: boolean;
  product: ProductRef | null | undefined;
  products?: readonly ProductRef[];
  candidateSetRef: string | undefined;
}

function resolveCellDefinition(
  node: ProductionCellFlowNodeDefinition,
): ProductionCellDefinition {
  if (node.cellDefinition) return node.cellDefinition;
  if (node.cellDefinitionRef) {
    throw new Error(
      `PRODUCTION_CELL_REGISTRY_UNRESOLVED: node '${node.id}' uses ` +
        `cellDefinitionRef='${node.cellDefinitionRef}' but the inline form is ` +
        `required for Slice 1 (registry resolution is a later slice)`,
    );
  }
  throw new Error(
    `PRODUCTION_CELL_DEFINITION_MISSING: node '${node.id}' has neither ` +
      `cellDefinition nor cellDefinitionRef`,
  );
}

function safeMachineId(): string {
  try {
    const name = os.hostname();
    return name && name.length > 0 ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Normalize a raw array (from a binding) into stable-id items. Accepts objects
 * with `key` or `id` string fields; other elements are skipped. Returns the
 * deduplicated-by-id list. Pure.
 */
function normalizeItems(values: readonly unknown[]): readonly { readonly id: string }[] {
  const seen = new Set<string>();
  const items: { id: string }[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as { key?: unknown; id?: unknown };
    const rawId = record.key ?? record.id;
    if (typeof rawId !== 'string' || rawId.trim().length === 0) continue;
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    items.push({ id: rawId });
  }
  return items;
}
