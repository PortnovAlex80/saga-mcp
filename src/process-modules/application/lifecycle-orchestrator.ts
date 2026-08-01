import { randomUUID } from 'node:crypto';
import type {
  LifecycleDefinition,
  StageBinding,
  TransitionTarget,
} from '../domain/lifecycle.js';
import { DEFAULT_MAX_TRANSITIONS } from '../domain/lifecycle.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
  ProcessRunRecord,
} from '../persistence/process-run.js';
import type { ProcessRunRepository } from '../persistence/process-run-repository.js';
import type {
  LifecycleExecutionLease,
  LifecycleRunRecord,
  LifecycleStageRunRecord,
  StartLifecycleCommand,
} from '../persistence/lifecycle-run.js';
import type { LifecycleRunRepository } from '../persistence/lifecycle-run-repository.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';
import type { ProcessModuleInstallationRegistry } from './process-module-installation-registry.js';
import type { ProcessModuleRegistry } from './process-module-registry.js';
import type { ProcessModuleRunResult } from './process-module-executor.js';
import { routeProcessOutcome, validateLifecycleDefinition } from './lifecycle-router.js';
import {
  mapLifecycleValues,
  type LifecycleMappingRuntime,
} from './lifecycle-mapper.js';

const LIFECYCLE_LEASE_MS = 120_000;

/**
 * Resolves the complete immutable output payload for one stage's
 * {@link ProcessModuleOutput}, so the declarative output mappings may read its
 * body during the hand-off. The orchestrator never knows HOW a SolutionContract
 * or release bundle is stored; it asks this resolver for the exact ref and then
 * independently re-checks the canonical hash before any mapping may read it.
 *
 * Replaces the deleted `ProcessOutputPayloadRegistry` (plan §13.12): a single
 * injected callback per lifecycle runtime instead of a schema-keyed registry
 * object.
 */
export type ResolveStageOutputPayload = (params: {
  processRunId: number;
  moduleRef: ProcessModuleReference;
  projectId: number;
  epicId: number | null;
  output: ProcessModuleOutput;
}) => Promise<unknown> | unknown;

/**
 * Backward-compatible alias for {@link ResolveStageOutputPayload}. Module
 * installation files ship per-schema dereferencers typed against this name;
 * the deleted `ProcessOutputPayloadRegistry` was the original consumer. The
 * composition root now wires these dereferencers into a single
 * `ResolveStageOutputPayload` callback (W13-A3).
 */
export type ProcessOutputPayloadResolver = ResolveStageOutputPayload;

export interface RunLifecycleCommand {
  projectId: number;
  epicId: number | null;
  inputSchema: string;
  inputPayload: unknown;
  initiatedBy: string;
  idempotencyKey: string;
  /** Explicit controller authority to resume a durable semantic/human pause. */
  resumePaused?: boolean;
}

export interface LifecycleExecutionResult {
  lifecycleRun: LifecycleRunRecord;
  stageRuns: readonly LifecycleStageRunRecord[];
  status: LifecycleRunRecord['status'];
  terminalStatus: string | null;
  pausedAtStageId: string | null;
}

export interface LifecycleOrchestratorOptions {
  lifecycleRunRepo: LifecycleRunRepository;
  processRunRepo: ProcessRunRepository;
  moduleRegistry: ProcessModuleRegistry;
  installationRegistry: ProcessModuleInstallationRegistry;
  /**
   * Resolves the complete immutable output payload for one stage's output, so
   * the declarative output mappings may read its body during the hand-off.
   * Optional: a lifecycle whose mappings read only runtime fields / output
   * refs may omit it. Replaces the deleted `ProcessOutputPayloadRegistry`.
   */
  resolveOutputPayload?: ResolveStageOutputPayload;
  /**
   * Resolves the immutable module installation a ProcessRun should be pinned
   * to, by module reference. When provided, every started ProcessRun carries
   * the resolved installationId + packageDigest (W13-AUDIT §18.5). When
   * omitted (legacy / test paths), runs start unpinned (null/null) and the
   * legacy workspace-root resource lookup remains in effect. Mirrors the
   * scenario-runner's per-stage lockEntry resolution.
   */
  resolveModuleInstallation?: (moduleRef: ProcessModuleReference) => {
    installationId: number;
    packageDigest: string;
  } | null;
  /**
   * Converts portable lifecycle values into execution-local capabilities
   * immediately before a StageRun input is frozen. It is never reapplied to
   * an existing StageRun, preserving immutable replay.
   */
  resolveStageInput?: (params: {
    lifecycleRun: LifecycleRunRecord;
    stage: StageBinding;
    input: unknown;
  }) => Promise<unknown> | unknown;
  /**
   * Called exactly after the durable LifecycleRun row is created or replayed,
   * before any stage execution begins. Hosts use this to acknowledge startup
   * without mistaking a successful OS spawn for a durable Saga run.
   */
  onLifecycleStarted?: (run: LifecycleRunRecord) => Promise<void> | void;
  now?: () => Date;
  /** Primarily configurable for deterministic lease/watchdog tests. */
  leaseDurationMs?: number;
}

export class LifecycleRunBusyError extends Error {
  constructor(readonly lifecycleRunId: number) {
    super(`LifecycleRun ${lifecycleRunId} is already owned by another executor`);
    this.name = 'LifecycleRunBusyError';
  }
}

export class LifecycleLeaseLostError extends Error {
  constructor(readonly lifecycleRunId: number) {
    super(`LifecycleRun ${lifecycleRunId} execution lease was lost`);
    this.name = 'LifecycleLeaseLostError';
  }
}

export class LifecycleOrchestrator {
  private readonly lifecycleRunRepo: LifecycleRunRepository;
  private readonly processRunRepo: ProcessRunRepository;
  private readonly moduleRegistry: ProcessModuleRegistry;
  private readonly installationRegistry: ProcessModuleInstallationRegistry;
  private readonly resolveOutputPayload: ResolveStageOutputPayload | null;
  private readonly resolveModuleInstallation:
    | NonNullable<LifecycleOrchestratorOptions['resolveModuleInstallation']>
    | null;
  private readonly resolveStageInput:
    | NonNullable<LifecycleOrchestratorOptions['resolveStageInput']>
    | null;
  private readonly onLifecycleStarted:
    | NonNullable<LifecycleOrchestratorOptions['onLifecycleStarted']>
    | null;
  private readonly now: () => Date;
  private readonly leaseDurationMs: number;

  constructor(options: LifecycleOrchestratorOptions) {
    this.lifecycleRunRepo = options.lifecycleRunRepo;
    this.processRunRepo = options.processRunRepo;
    this.moduleRegistry = options.moduleRegistry;
    this.installationRegistry = options.installationRegistry;
    this.resolveOutputPayload = options.resolveOutputPayload ?? null;
    this.resolveModuleInstallation = options.resolveModuleInstallation ?? null;
    this.resolveStageInput = options.resolveStageInput ?? null;
    this.onLifecycleStarted = options.onLifecycleStarted ?? null;
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? LIFECYCLE_LEASE_MS;
    if (!Number.isFinite(this.leaseDurationMs) || this.leaseDurationMs <= 0) {
      throw new Error('LifecycleOrchestrator leaseDurationMs must be positive');
    }
  }

  async run(
    definition: LifecycleDefinition,
    command: RunLifecycleCommand,
  ): Promise<LifecycleExecutionResult> {
    this.assertRunnableDefinition(definition);
    const definitionSnapshot = canonicalJson(definition);
    const started = this.lifecycleRunRepo.start({
      lifecycle: definition.identity,
      definitionSnapshot,
      definitionHash: sha256Hex(definition),
      entryStageId: definition.entryStageId,
      input: {
        schema: command.inputSchema,
        payload: command.inputPayload,
        contentHash: sha256Hex(command.inputPayload),
      },
      invocationContext: {
        projectId: command.projectId,
        epicId: command.epicId,
        initiatedBy: command.initiatedBy,
        idempotencyKey: command.idempotencyKey,
      },
    } satisfies StartLifecycleCommand);

    await this.onLifecycleStarted?.(started.record);

    if (isLifecycleTerminal(started.record.status)) {
      return this.result(started.record);
    }
    let runnable = started.record;
    if (runnable.status === 'paused') {
      if (!command.resumePaused) return this.result(runnable);
      runnable = this.lifecycleRunRepo.resume(runnable.id, runnable.version);
    }

    const owner = randomUUID();
    const lease = this.lifecycleRunRepo.acquireExecutionLease(
      runnable.id,
      owner,
      this.now().toISOString(),
      this.leaseExpiry(),
    );
    if (!lease) throw new LifecycleRunBusyError(runnable.id);

    try {
      // F3: a hard transition budget protects against an accidental cycle in
      // the declarative routing table (or a self-looping recovery policy)
      // spinning the conveyor forever. The default is generous; legitimate
      // lifecycles (the longest built-in DAG is 4 stages) never reach it. The
      // loop counter doubles as the budget: each iteration is one stage
      // transition attempt. We still keep the older stages*4+8 upper bound so
      // a misconfigured (tiny) maxTransitions cannot deadlock the run early.
      const transitionBudget = resolveMaxTransitions(definition.maxTransitions);
      const maxStages = Math.max(transitionBudget, definition.stages.length * 4 + 8);
      let transitions = 0;
      for (let step = 0; step < maxStages; step += 1) {
        // F3: count each stage execution attempt as one transition. Exceeding
        // the budget means the routing table has a cycle and the run would
        // spin forever; fail it with a distinct, attributable message.
        transitions += 1;
        if (transitions > transitionBudget) {
          const failed = this.lifecycleRunRepo.fail(
            started.record.id,
            this.lifecycleRunRepo.readCurrentStageRun(started.record.id)?.id ?? null,
            `Lifecycle exceeded its transition budget of ${transitionBudget}`,
            lease,
          );
          return this.result(failed);
        }
        // A successful completeStage atomically terminalizes the LifecycleRun.
        // Terminal rows intentionally reject lease renewal, so observe the
        // durable terminal state before heartbeating on the next loop turn.
        // For non-terminal work we still renew first, then re-read under the
        // live fence before making another decision.
        let lifecycleRun = this.requireLifecycleRun(started.record.id);
        if (isLifecycleTerminal(lifecycleRun.status)) return this.result(lifecycleRun);
        this.heartbeat(started.record.id, lease);
        lifecycleRun = this.requireLifecycleRun(started.record.id);
        if (isLifecycleTerminal(lifecycleRun.status)) return this.result(lifecycleRun);
        const stage = this.requireStage(definition, lifecycleRun.currentStageId);
        const rootInput = JSON.parse(lifecycleRun.inputSnapshot) as unknown;
        const durableFrame = this.buildFrame(rootInput, lifecycleRun.id);
        const runtime = this.mappingRuntime(lifecycleRun, stage.id);
        const frozenStageRun = this.lifecycleRunRepo.readCurrentStageRun(lifecycleRun.id);
        const mappedStageInput = frozenStageRun
          ? JSON.parse(frozenStageRun.inputSnapshot) as unknown
          : mapLifecycleValues(
              stage.inputMapping,
              durableFrame,
              runtime,
            );
        const stageInput = frozenStageRun || !this.resolveStageInput
          ? mappedStageInput
          : await this.resolveStageInput({
              lifecycleRun,
              stage,
              input: mappedStageInput,
            });
        const bindingSnapshot = canonicalJson(stage);
        const ensuredStage = this.lifecycleRunRepo.ensureStageRun({
          lifecycleRunId: lifecycleRun.id,
          stageId: stage.id,
          moduleRef: stage.moduleRef,
          bindingSnapshot,
          bindingHash: sha256Hex(stage),
          inputSchema: this.moduleRegistry.require(stage.moduleRef).inputContract.id,
          inputPayload: stageInput,
          inputHash: sha256Hex(stageInput),
        }, lease);
        let stageRun = ensuredStage.record;

        const installation = this.installationRegistry.require(stage.moduleRef);
        const processStart = this.processRunRepo.start({
          moduleRef: stage.moduleRef,
          input: {
            schema: stageRun.inputSchema,
            payload: stageInput,
            contentHash: stageRun.inputHash,
          },
          executorKind: installation.executor.kind,
          projectedStage: installation.definition.identity.kind,
          // W13-AUDIT §18.5: pin the ProcessRun to the immutable module
          // installation when a resolver is wired (production). Legacy / test
          // paths without a resolver start unpinned (null/null) and retain the
          // pre-Wave-2 behavior. Mirrors scenario-runner's lockEntry pinning.
          ...(this.resolveModuleInstallation
            ? (() => {
              const pin = this.resolveModuleInstallation!(stage.moduleRef);
              return {
                installationId: pin?.installationId ?? null,
                packageDigest: pin?.packageDigest ?? null,
              };
            })()
            : { installationId: null, packageDigest: null }),
          invocationContext: {
            projectId: lifecycleRun.projectId,
            epicId: lifecycleRun.epicId,
            initiatedBy: lifecycleRun.initiatedBy,
            idempotencyKey: `lifecycle:${lifecycleRun.id}:stage-run:${stageRun.id}`,
          },
        });
        stageRun = this.lifecycleRunRepo.bindProcessRun(
          lifecycleRun.id,
          stageRun.id,
          processStart.record.id,
          lease,
        );
        this.lifecycleRunRepo.markStageRunning(
          lifecycleRun.id,
          stageRun.id,
          lease,
        );

        const processResult = await this.executeOrReplayProcess(
          installation,
          lifecycleRun,
          stageRun,
          stageInput,
          lease,
        );
        if (processResult.kind === 'paused') {
          const paused = this.lifecycleRunRepo.pauseStage(
            lifecycleRun.id,
            stageRun.id,
            processResult.error,
            lease,
          );
          return this.result(paused);
        }
        if (processResult.kind === 'failed') {
          const failed = this.lifecycleRunRepo.fail(
            lifecycleRun.id,
            stageRun.id,
            processResult.error,
            lease,
          );
          return this.result(failed);
        }

        const persistedResult = processResult.result;
        const route = routeProcessOutcome(
          stage,
          persistedResult.outcome,
        );

        // outputMapping is a strict, typed hand-off contract. A terminal local
        // outcome does not have a downstream consumer, so it must not be made
        // to fail merely because the successful hand-off fields are absent.
        // The exact terminal result still remains durable on StageRun.
        const needsHandoff = route.target.type === 'stage';
        const outputPayload = needsHandoff
          && persistedResult.output
          && this.resolveOutputPayload
          ? await this.resolveStageOutputPayload(
              processStart.record.id,
              stage.moduleRef,
              lifecycleRun,
              persistedResult.output,
            )
          : undefined;
        const outcomeFrame = {
          ...durableFrame,
          processOutcome: {
            ...resultSnapshot(persistedResult),
            ...(outputPayload === undefined ? {} : { outputPayload }),
          },
        };
        const mappedOutput = needsHandoff && stage.outputMapping
          ? mapLifecycleValues(stage.outputMapping, outcomeFrame, runtime)
          : {};
        const handoffFrame = withStageOutput(
          durableFrame,
          stage.id,
          mappedOutput,
          persistedResult,
          stageRun.id,
          processStart.record.id,
        );
        const nextStageCommand = route.target.type === 'stage'
          ? this.buildNextStageCommand(
              definition,
              route.target,
              handoffFrame,
              lifecycleRun,
            )
          : null;
        const handoffHash = sha256Hex(handoffFrame);
        const decisionHash = sha256Hex({
          lifecycleRunId: lifecycleRun.id,
          stageRunId: stageRun.id,
          outcome: persistedResult.outcome,
          target: route.target,
          handoffHash,
        });
        this.lifecycleRunRepo.completeStage({
          lifecycleRunId: lifecycleRun.id,
          stageRunId: stageRun.id,
          expectedStageId: stage.id,
          transitionKey: `lifecycle:${lifecycleRun.id}:stage-run:${stageRun.id}:outcome`,
          outcome: persistedResult.outcome,
          authority: persistedResult.authority,
          output: persistedResult.output,
          certificate: persistedResult.certificate,
          resultSnapshot: resultSnapshot(persistedResult),
          mappedOutput,
          target: route.target,
          handoffSnapshot: handoffFrame,
          handoffHash,
          decisionHash,
          nextStage: nextStageCommand,
        }, lease);
      }
      const failed = this.lifecycleRunRepo.fail(
        started.record.id,
        this.lifecycleRunRepo.readCurrentStageRun(started.record.id)?.id ?? null,
        'Lifecycle flow exceeded its bounded stage count',
        lease,
      );
      return this.result(failed);
    } catch (error) {
      if (isLifecycleLeaseError(error)) {
        throw new LifecycleLeaseLostError(started.record.id);
      }
      if (isRecoverableExecutionContention(error)) throw error;
      const current = this.lifecycleRunRepo.read(started.record.id);
      if (current && !isLifecycleTerminal(current.status)) {
        try {
          const failed = this.lifecycleRunRepo.fail(
            current.id,
            current.currentStageRunId,
            (error as Error).message ?? String(error),
            lease,
          );
          return this.result(failed);
        } catch (failError) {
          if ((failError as Error).message === 'LIFECYCLE_LEASE_LOST') {
            throw new LifecycleLeaseLostError(started.record.id);
          }
        }
      }
      throw error;
    } finally {
      this.lifecycleRunRepo.releaseExecutionLease(started.record.id, lease);
    }
  }

  private async executeOrReplayProcess(
    installation: ReturnType<ProcessModuleInstallationRegistry['require']>,
    lifecycleRun: LifecycleRunRecord,
    stageRun: LifecycleStageRunRecord,
    stageInput: unknown,
    lease: LifecycleExecutionLease,
  ): Promise<
    | { kind: 'completed'; result: ProcessModuleRunResult }
    | { kind: 'paused'; error: string }
    | { kind: 'failed'; error: string }
  > {
    if (stageRun.processRunId === null) {
      return { kind: 'failed', error: 'StageRun has no bound ProcessRun' };
    }
    let process = this.processRunRepo.read(stageRun.processRunId);
    if (!process) return { kind: 'failed', error: 'Bound ProcessRun is missing' };
    if (process.status === 'completed') {
      return { kind: 'completed', result: processRecordToResult(process) };
    }
    if (process.status === 'failed' || process.status === 'cancelled') {
      return {
        kind: 'failed',
        error: process.error ?? `ProcessRun ${process.id} is ${process.status}`,
      };
    }
    const processRunId = process.id;

    try {
      this.heartbeat(lifecycleRun.id, lease);
      await this.withLeaseWatchdog(
        lifecycleRun.id,
        lease,
        () => installation.executor.execute(installation.definition, {
          projectId: lifecycleRun.projectId,
          epicId: lifecycleRun.epicId,
          processRunId,
          inputPayload: stageInput,
          inputHash: stageRun.inputHash,
          initiatedBy: lifecycleRun.initiatedBy,
        }),
      );
      this.heartbeat(lifecycleRun.id, lease);
    } catch (error) {
      process = this.processRunRepo.read(processRunId);
      if (process?.status === 'paused') {
        return {
          kind: 'paused',
          error: process.error ?? (error as Error).message ?? 'ProcessRun paused',
        };
      }
      if (process?.status === 'failed' || process?.status === 'cancelled') {
        return {
          kind: 'failed',
          error: process.error ?? (error as Error).message ?? `ProcessRun ${process.status}`,
        };
      }
      throw error;
    }
    process = this.processRunRepo.read(processRunId);
    if (!process) return { kind: 'failed', error: 'ProcessRun disappeared after execution' };
    if (process.status === 'paused') {
      return { kind: 'paused', error: process.error ?? 'ProcessRun paused' };
    }
    if (process.status !== 'completed') {
      return {
        kind: 'failed',
        error: `Process executor returned while ProcessRun ${process.id} is '${process.status}'`,
      };
    }
    return { kind: 'completed', result: processRecordToResult(process) };
  }

  private buildNextStageCommand(
    definition: LifecycleDefinition,
    target: Extract<TransitionTarget, { type: 'stage' }>,
    handoffFrame: Record<string, unknown>,
    lifecycleRun: LifecycleRunRecord,
  ) {
    const next = this.requireStage(definition, target.stageId);
    const runtime = this.mappingRuntime(lifecycleRun, next.id);
    const inputPayload = mapLifecycleValues(next.inputMapping, handoffFrame, runtime);
    const bindingSnapshot = canonicalJson(next);
    return {
      stageId: next.id,
      moduleRef: next.moduleRef,
      bindingSnapshot,
      bindingHash: sha256Hex(next),
      inputSchema: this.moduleRegistry.require(next.moduleRef).inputContract.id,
      inputPayload,
      inputHash: sha256Hex(inputPayload),
    };
  }

  private buildFrame(
    rootInput: unknown,
    lifecycleRunId: number,
  ): Record<string, unknown> {
    const root = isRecord(rootInput)
      ? { ...rootInput }
      : { value: rootInput };
    const stages: Record<string, unknown> = {};
    for (const stage of this.lifecycleRunRepo.listStageRuns(lifecycleRunId)) {
      if (stage.status !== 'completed') continue;
      const result = stage.resultSnapshot ?? {};
      stages[stage.stageId] = {
        ...(stage.mappedOutput ?? {}),
        stageRunId: stage.id,
        processRunId: stage.processRunId,
        processOutcome: result,
      };
    }
    return {
      ...root,
      lifecycleInput: rootInput,
      stages,
    };
  }

  /**
   * Delegates to the injected {@link ResolveStageOutputPayload} callback and
   * independently re-checks the canonical hash before any declarative mapping
   * may read the payload — the boundary check the deleted registry performed.
   * The lifecycle core never trusts the resolver's bytes; it only trusts the
   * content-addressed ref it asked for.
   */
  private async resolveStageOutputPayload(
    processRunId: number,
    moduleRef: ProcessModuleReference,
    lifecycleRun: LifecycleRunRecord,
    output: ProcessModuleOutput,
  ): Promise<unknown> {
    if (!this.resolveOutputPayload) return undefined;
    const payload = await this.resolveOutputPayload({
      processRunId,
      moduleRef,
      projectId: lifecycleRun.projectId,
      epicId: lifecycleRun.epicId,
      output,
    });
    const actualHash = sha256Hex(payload);
    if (actualHash !== output.contentHash) {
      throw new Error(
        `PROCESS_OUTPUT_PAYLOAD_HASH_MISMATCH: '${output.artifactRef}' `
        + `resolved to '${actualHash}', expected '${output.contentHash}'`,
      );
    }
    return payload;
  }

  private mappingRuntime(
    lifecycleRun: LifecycleRunRecord,
    stageId: string,
  ): LifecycleMappingRuntime {
    return {
      projectId: lifecycleRun.projectId,
      epicId: lifecycleRun.epicId,
      lifecycleRunId: lifecycleRun.id,
      stageId,
      initiatedBy: lifecycleRun.initiatedBy,
    };
  }

  private heartbeat(lifecycleRunId: number, lease: LifecycleExecutionLease): void {
    if (!this.lifecycleRunRepo.renewExecutionLease(
      lifecycleRunId,
      lease,
      this.leaseExpiry(),
    )) {
      throw new LifecycleLeaseLostError(lifecycleRunId);
    }
  }

  private async withLeaseWatchdog<T>(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
    work: () => Promise<T>,
  ): Promise<T> {
    const heartbeatEveryMs = Math.max(1, Math.floor(this.leaseDurationMs / 3));
    let leaseError: unknown = null;
    let leaseWasLost = false;
    const watchdog = setInterval(() => {
      if (leaseWasLost) return;
      try {
        this.heartbeat(lifecycleRunId, lease);
      } catch (error) {
        leaseWasLost = true;
        leaseError = error;
      }
    }, heartbeatEveryMs);
    watchdog.unref();

    let result: T | undefined;
    let workError: unknown = null;
    let workFailed = false;
    try {
      result = await work();
    } catch (error) {
      workFailed = true;
      workError = error;
    } finally {
      clearInterval(watchdog);
    }

    // A stale executor must never commit merely because its module call happened
    // to finish after the durable lifecycle lease had already been lost.
    if (leaseWasLost) throw leaseError;
    if (workFailed) throw workError;
    return result as T;
  }

  private leaseExpiry(): string {
    return new Date(this.now().getTime() + this.leaseDurationMs).toISOString();
  }

  private assertRunnableDefinition(definition: LifecycleDefinition): void {
    const validation = validateLifecycleDefinition(definition, this.moduleRegistry);
    if (!validation.valid) {
      throw new Error(`Lifecycle definition is invalid: ${validation.errors.join('; ')}`);
    }
    // F3: validate the transition budget up front (before any lease is taken)
    // so a misconfigured lifecycle fails loudly at run start instead of being
    // swallowed by the run's catch-all fail handler.
    resolveMaxTransitions(definition.maxTransitions);
    for (const stage of definition.stages) {
      this.installationRegistry.require(stage.moduleRef);
    }
  }

  private requireStage(
    definition: LifecycleDefinition,
    stageId: string | null,
  ): StageBinding {
    if (!stageId) throw new Error('Lifecycle has no current stage');
    const stage = definition.stages.find(candidate => candidate.id === stageId);
    if (!stage) throw new Error(`Lifecycle stage '${stageId}' is missing`);
    return stage;
  }

  private requireLifecycleRun(id: number): LifecycleRunRecord {
    const run = this.lifecycleRunRepo.read(id);
    if (!run) throw new Error(`LifecycleRun ${id} is missing`);
    return run;
  }

  private result(run: LifecycleRunRecord): LifecycleExecutionResult {
    return {
      lifecycleRun: run,
      stageRuns: this.lifecycleRunRepo.listStageRuns(run.id),
      status: run.status,
      terminalStatus: run.terminalStatus,
      pausedAtStageId: run.status === 'paused' ? run.currentStageId : null,
    };
  }
}

function processRecordToResult(process: ProcessRunRecord): ProcessModuleRunResult {
  if (process.status !== 'completed' || !process.localOutcome) {
    throw new Error(`ProcessRun ${process.id} has no persisted completed outcome`);
  }
  const output: ProcessModuleOutput | null = process.outputRef === null
    ? null
    : {
        schema: process.outputSchema ?? '',
        artifactRef: process.outputRef,
        contentHash: process.outputHash ?? '',
      };
  const certificate: ProcessModuleCertificateRef | null = process.certificateRef === null
    ? null
    : {
        schema: process.certificateSchema ?? '',
        certificateRef: process.certificateRef,
        certificateHash: process.certificateHash ?? '',
      };
  return {
    outcome: process.localOutcome,
    output,
    certificate,
    authority: process.authority,
  };
}

function resultSnapshot(result: ProcessModuleRunResult): Record<string, unknown> {
  return {
    code: result.outcome,
    outcome: result.outcome,
    authority: result.authority,
    output: result.output,
    certificate: result.certificate,
    outputRef: result.output?.artifactRef ?? result.certificate?.certificateRef ?? null,
    outputHash: result.output?.contentHash ?? result.certificate?.certificateHash ?? null,
    outputSchema: result.output?.schema ?? result.certificate?.schema ?? null,
    certificateRef: result.certificate?.certificateRef ?? null,
    certificateHash: result.certificate?.certificateHash ?? null,
    certificateSchema: result.certificate?.schema ?? null,
  };
}

function withStageOutput(
  frame: Record<string, unknown>,
  stageId: string,
  mappedOutput: Record<string, unknown>,
  result: ProcessModuleRunResult,
  stageRunId: number,
  processRunId: number,
): Record<string, unknown> {
  const existingStages = isRecord(frame.stages) ? frame.stages : {};
  return {
    ...frame,
    processOutcome: resultSnapshot(result),
    stages: {
      ...existingStages,
      [stageId]: {
        ...mappedOutput,
        stageRunId,
        processRunId,
        processOutcome: resultSnapshot(result),
      },
    },
  };
}

function isLifecycleTerminal(status: LifecycleRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isLifecycleLeaseError(error: unknown): boolean {
  return error instanceof LifecycleLeaseLostError
    || errorMessage(error) === 'LIFECYCLE_LEASE_LOST';
}

function isRecoverableExecutionContention(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = errorMessage(error);
  return name === 'ProcessRunBusyError'
    || name === 'NodeExecutionLeaseLostError'
    || message.startsWith('PROCESS_RUN_CONCURRENT_TRANSITION:');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves a lifecycle's transition budget, defaulting to
 * {@link DEFAULT_MAX_TRANSITIONS} and rejecting a non-positive / non-integer
 * declaration up front so a misconfigured lifecycle fails loudly at run start
 * instead of deadlocking.
 */
function resolveMaxTransitions(declared: number | undefined): number {
  if (declared === undefined) return DEFAULT_MAX_TRANSITIONS;
  if (!Number.isInteger(declared) || declared <= 0) {
    throw new Error(
      `LifecycleDefinition.maxTransitions must be a positive integer, got ${declared}`,
    );
  }
  return declared;
}
