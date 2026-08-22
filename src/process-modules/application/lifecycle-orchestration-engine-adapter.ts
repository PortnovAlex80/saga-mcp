import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import type { LifecycleDefinition } from '../domain/lifecycle.js';
import { lifecycleRefKey } from '../persistence/lifecycle-run.js';
import type { RunTerminalEventClaim } from '../persistence/lifecycle-run-repository.js';
import { journalEvent } from '../../observability/run-journal.js';
import type { LifecycleOrchestrator } from './lifecycle-orchestrator.js';

export interface LifecycleEpisodeInput {
  schema: string;
  payload: unknown;
  initiatedBy: string;
  idempotencyKey: string;
  resumePaused?: boolean;
}

export interface LifecycleOrchestrationEngineAdapterOptions {
  definition: LifecycleDefinition;
  /** Resolve a run-pinned suffix definition for append-only continuations. */
  resolveDefinition?: (
    command: RunEpisodeCommand,
    input: LifecycleEpisodeInput,
  ) => Promise<LifecycleDefinition> | LifecycleDefinition;
  orchestrator: LifecycleOrchestrator;
  resolveInput: (
    command: RunEpisodeCommand,
  ) => Promise<LifecycleEpisodeInput> | LifecycleEpisodeInput;
  /**
   * CC-GAP-4 — the deterministic exactly-once gate for the `run.terminal`
   * journal boundary. REQUIRED: two competing paths re-enter this adapter
   * for the same terminalized scope — the dispatch loop and the
   * transition-obligation re-drive (`route-lifecycle` handler) — and both
   * replay the durable terminal record, so the adapter alone can never
   * tell a first terminalization from a replay of one. The claim is taken
   * against the durable authority (see
   * `LifecycleRunRepository.claimRunTerminalEvent`), which makes the
   * emission decision idempotent per terminalized scope across replays,
   * resumes, and concurrent engine processes. Fail-closed: `null` (no
   * durable terminal fact) never emits. Fail-silent (N1): the adapter
   * invokes this claim as OBSERVATION — a throw from it (a post-commit
   * storage error) costs that crossing's projection line only (the honest
   * 0..1 envelope per scope) and never propagates into engine behavior.
   */
  claimTerminalEvent: (lifecycleRunId: number) => RunTerminalEventClaim | null;
}

/**
 * Application-facing bridge for a complete Lifecycle. It projects the durable
 * lifecycle result without pretending that one stage's local outcome means
 * the whole product has shipped.
 */
export class LifecycleOrchestrationEngineAdapter implements OrchestrationEngine {
  constructor(
    private readonly options: LifecycleOrchestrationEngineAdapterOptions,
  ) {}

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const input = await this.options.resolveInput(command);
    const definition = this.options.resolveDefinition
      ? await this.options.resolveDefinition(command, input)
      : this.options.definition;
    const result = await this.options.orchestrator.run(
      definition,
      {
        projectId: command.projectId,
        epicId: command.epicId,
        inputSchema: input.schema,
        inputPayload: input.payload,
        initiatedBy: input.initiatedBy,
        idempotencyKey: input.idempotencyKey,
        resumePaused: input.resumePaused,
      },
    );
    const lastStage = result.stageRuns[result.stageRuns.length - 1] ?? null;
    const reason: OrchestrationRunResult['reason'] =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'paused'
          ? 'paused'
          : result.status === 'cancelled'
            ? 'stopped'
            : 'failed';
    // STAGE-11 TASK 5 — the terminal boundary: a reader must be able to tell
    // "the run ended" from "the journal stopped". Emitted only for terminal
    // results (paused resume cycles re-run this adapter). After the
    // orchestrator's commits — never inside a transaction a rollback could
    // falsify. Observation only.
    //
    // CC-GAP-4 — the status guard above is NOT an exactly-once gate: a
    // replayed terminal run returns the same terminal result, and the two
    // competing terminal paths (dispatch + obligation re-drive) both do
    // exactly that inside one engine.run() call. Uniqueness per
    // terminalized scope comes from the durable claim: claim FIRST against
    // the authority, append only when this caller is the single winner. A
    // crash between claim and append loses one projection line (never a
    // production fact, per run-journal.ts); emitting before claiming could
    // duplicate — so the order is load-bearing.
    //
    // CC-GAP-4 N1 (red-team follow-up) — the claim/journal pair is the
    // OBSERVATION plane, and the orchestrator's commits are already durable
    // when this block runs. A post-commit DB error thrown by the claim (or
    // anything else in this block) must therefore NEVER propagate into
    // engine behavior: this adapter is the return path of BOTH the dispatch
    // call and the obligation re-drive, so propagating would convert a lost
    // projection line into a broken engine result. Fail-silent: no observed
    // claim, no event. The journal envelope per terminalized scope stays
    // honestly 0..1 — at most one event (only an OBSERVED claim winner ever
    // appends), possibly zero when the observation plane fails: this
    // crossing stays silent, and if the claim row committed but the verdict
    // was lost, every later replay reads claimed:false and the scope ends
    // at zero. Never a duplicate in either direction.
    if (result.status !== 'paused' && result.status !== 'running') {
      try {
        const claim = this.options.claimTerminalEvent(result.lifecycleRun.id);
        if (claim !== null && claim.claimed) {
          journalEvent('run.terminal', {
            run_id: String(result.lifecycleRun.id),
            epic_id: command.epicId,
          }, {
            outcome: reason,
            status: result.status,
            final_stage: result.lifecycleRun.currentStageId
              ?? lastStage?.stageId
              ?? definition.entryStageId,
            error: result.lifecycleRun.error ?? null,
            cycles: result.stageRuns.length,
          });
        }
      } catch {
        // Intentionally swallowed — a lost observation, never a lost
        // production fact and never a broken run (see N1 above).
      }
    }
    return {
      projectId: command.projectId,
      epicId: command.epicId,
      finalStage:
        result.lifecycleRun.currentStageId
        ?? lastStage?.stageId
        ?? definition.entryStageId,
      endedAt:
        result.lifecycleRun.completedAt
        ?? result.lifecycleRun.updatedAt,
      reason,
      cycles: result.stageRuns.length,
      lastError: result.lifecycleRun.error,
      processOutcome: lastStage?.localOutcome
        ? {
            code: lastStage.localOutcome,
            authority: lastStage.authority,
            outputRef:
              lastStage.output?.artifactRef
              ?? lastStage.certificate?.certificateRef
              ?? null,
          }
        : undefined,
      pipelineScope: lifecycleRefKey(definition.identity),
      scopeCompleted: result.status === 'completed',
      outcome: result.terminalStatus ?? lastStage?.localOutcome ?? undefined,
      outcomeAuthority: lastStage?.authority ?? undefined,
      lifecycleRun: {
        id: result.lifecycleRun.id,
        ref: lifecycleRefKey(result.lifecycleRun.lifecycle),
        status: result.status,
        currentStageId: result.lifecycleRun.currentStageId,
        terminalStatus: result.terminalStatus,
      },
    };
  }
}
