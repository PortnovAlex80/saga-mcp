/**
 * Reducer contract + `decide` and `evolve` implementations.
 *
 * Source: blueprint §9 (docs/architecture/passive-worker-kernel-blueprint.md:421-453)
 *         and §11 transition table (line 506-528).
 *
 * Two functions:
 *   - `decide(state, envelope, facts) -> Decision | DomainRejection`
 *       Pure. Matches exactly one transition rule. Returns events+effects+result
 *       on acceptance, or a stable error code on rejection. `NO_TRANSITION`
 *       if zero rules match; throws `AMBIGUOUS_TRANSITION_TABLE` if >1 match
 *       (blueprint §9:451-453).
 *   - `evolve(state, event) -> ManagedTaskState`
 *       Pure. Folds one event into state. Must be the inverse-of-decide for
 *       post-state: `decision.events.reduce(evolve, state).kind === post-state`.
 *
 * Reducer rules (blueprint §9:442-449):
 *   - receive immutable state, command, and already-observed facts;
 *   - perform no I/O;
 *   - read no clock;
 *   - mutate no input;
 *   - return stable domain error codes;
 *   - match exactly one transition rule.
 *
 * Pure TS. No imports from SQLite, Node, tools, or tracker-view.
 */

import type {
  CommandEnvelope,
  LifecycleCommand,
} from './commands.js';
import type { DomainEvent } from './events.js';
import type { EffectIntent } from './effects.js';
import type { ManagedTaskState } from './state.js';
import { assertNever } from './state.js';

// ---------------------------------------------------------------------------
// Types (blueprint §9:424-440).
// ---------------------------------------------------------------------------

export interface Decision<R> {
  readonly ok: true;
  readonly events: readonly DomainEvent[];
  readonly effects: readonly EffectIntent[];
  readonly result: R;
}

/**
 * Stable rejection codes. These are the deterministic rejections the bus
 * persists as receipts too (blueprint §10:477-478). Frozen names.
 */
export type DomainRejectionCode =
  | 'NO_TRANSITION'          // no rule matched the (state, command) pair
  | 'PRECONDITION_FAILED'    // a rule matched but its facts/conditions failed
  | 'IDEMPOTENCY_KEY_REUSED' // commandId reused with different payload hash
  | 'NOT_AUTHORIZED'         // actor not permitted for this command
  | 'AMBIGUOUS_TRANSITION_TABLE'; // internal: >1 rule matched (bug)

export interface DomainRejection {
  readonly ok: false;
  readonly code: DomainRejectionCode;
  readonly message: string;
}

export type DecideResult<R> = Decision<R> | DomainRejection;

/**
 * LifecycleFacts — already-observed external truth the reducer needs but
 * cannot fetch itself (blueprint §9:444 — reducer "receive[s] immutable state,
 * command, and already-observed facts"). The shell fills these before calling
 * `decide`. For Slice 0 they are declarative placeholders; Slice 1+ populates
 * them from SQLite/Git/OS.
 */
export interface LifecycleFacts {
  /** True if the named dependency set is fully satisfied (DAG done+merged). */
  readonly dependenciesReady: boolean;
  /** True if no open human_requests block this task. */
  readonly noOpenHumanRequest: boolean;
  /** True if no other integration attempt holds the repository lock. */
  readonly repositoryFree: boolean;
  /** True if verification evidence for the task's AC has outcome='passed'. */
  readonly verificationPassed: boolean;
}

export const PERMISSIVE_FACTS: LifecycleFacts = {
  dependenciesReady: true,
  noOpenHumanRequest: true,
  repositoryFree: true,
  verificationPassed: true,
};

// ---------------------------------------------------------------------------
// evolve — event fold (blueprint §9:436-439).
// ---------------------------------------------------------------------------

/**
 * Fold one event into state. Inverse of decide for post-state.
 *
 * Returns the SAME state object reference if the event does not change it
 * (e.g. ExecutionExited after TaskReleased); the caller may rely on identity
 * for short-circuits.
 */
export function evolve(state: ManagedTaskState, event: DomainEvent): ManagedTaskState {
  switch (event.kind) {
    case 'WorkItemCreated':
      // New work item — does not change current task state variant on its own.
      return state;

    case 'WorkAttemptReserved':
      if (state.kind === 'queued') {
        return {
          kind: 'active',
          phase: state.phase,
          workerId: '', // workerId is on the ExecutionReserved event; filled below
          executionId: event.executionId,
        };
      }
      return state;

    case 'ExecutionReserved':
      // Pairs with WorkAttemptReserved; sets the workerId on the active state.
      if (state.kind === 'active' && state.executionId === event.executionId) {
        return { ...state, workerId: event.workerId };
      }
      return state;

    case 'WorkAttemptStarted':
    case 'ExecutionStarted':
    case 'WorkAttemptSucceeded':
      return state;

    case 'ImplementationCompleted':
      // implementation attempt succeeded -> review queued
      if (state.kind === 'active' && state.phase === 'implementation') {
        return { kind: 'finishing', completedPhase: 'implementation', executionId: state.executionId };
      }
      return state;

    case 'ReviewItemCreated':
      if (state.kind === 'finishing' && state.completedPhase === 'implementation') {
        return { kind: 'queued', phase: 'review' };
      }
      return state;

    case 'ReviewApproved':
      if (state.kind === 'active' && state.phase === 'review') {
        return { kind: 'finishing', completedPhase: 'review', executionId: state.executionId };
      }
      return state;

    case 'IntegrationRequested':
      // Review approved for git_change task — integration item created.
      if (state.kind === 'finishing' && state.completedPhase === 'review') {
        return { kind: 'awaiting_integration', integrationId: event.integrationId };
      }
      return state;

    case 'IntegrationStarted':
      if (state.kind === 'awaiting_integration') {
        return {
          kind: 'integrating',
          integrationId: event.integrationId,
          executorExecutionId: event.executorExecutionId,
        };
      }
      return state;

    case 'IntegrationObservedMerged':
      if (state.kind === 'integrating' || state.kind === 'awaiting_integration') {
        return { kind: 'completed' };
      }
      return state;

    case 'IntegrationObservedConflict':
      if (
        state.kind === 'integrating' ||
        state.kind === 'awaiting_integration'
      ) {
        return { kind: 'integration_conflict', integrationId: event.integrationId };
      }
      return state;

    case 'ReviewChangesRequested':
      // Review terminal — fresh implementation cycle queued.
      if (state.kind === 'active' && state.phase === 'review') {
        return { kind: 'finishing', completedPhase: 'review', executionId: state.executionId };
      }
      return state;

    case 'ImplementationItemCreated':
      if (state.kind === 'finishing' && state.completedPhase === 'review') {
        return { kind: 'queued', phase: 'implementation' };
      }
      return state;

    case 'HumanInputRequested':
      if (state.kind === 'active') {
        return {
          kind: 'waiting_human',
          resumePhase: event.resumePhase,
          requestId: event.requestId,
        };
      }
      return state;

    case 'HumanInputProvided':
      if (state.kind === 'waiting_human') {
        // resumePhase was captured on ParkForHuman — use it here.
        const resumePhase = state.resumePhase;
        // The state union's `queued.phase` is implementation|review. Integration
        // resume returns to review (the closest queueable phase).
        const phase: 'implementation' | 'review' =
          resumePhase === 'implementation' ? 'implementation' : 'review';
        return { kind: 'queued', phase };
      }
      return state;

    case 'ExecutionStopRequested':
      return state;

    case 'ExecutionExited':
      // Process closed. Per blueprint §11:530-531, if a terminal report was
      // already accepted, this is bookkeeping and does not change semantic
      // state. If not, TaskReleased follows to return the task to its queue.
      return state;

    case 'ExecutionLost':
      // The attempt died. evolve alone does not downgrade the item — that is
      // TaskReleased's job, paired with ExecutionLost when no terminal report
      // was accepted.
      return state;

    case 'WorkAttemptLost':
      return state;

    case 'TaskReleased':
      // Return the task to its pre-attempt queue.
      if (state.kind === 'active' || state.kind === 'finishing') {
        // Determine phase: implementation attempts -> back to queued implementation;
        // review attempts -> back to queued review. If finishing after an
        // accepted terminal report, TaskReleased is NOT emitted (see decide).
        const phase: 'implementation' | 'review' =
          state.kind === 'finishing'
            ? state.completedPhase
            : state.phase;
        return { kind: 'queued', phase };
      }
      return state;

    case 'DependencyBlocked':
      if (state.kind === 'queued') return { kind: 'blocked_dependencies' };
      return state;

    case 'DependencyUnblocked':
      if (state.kind === 'blocked_dependencies') {
        return { kind: 'queued', phase: 'implementation' };
      }
      return state;

    case 'AdminOverrideApplied':
      if (event.target === 'completed') return { kind: 'completed' };
      if (event.target === 'blocked') return { kind: 'blocked_dependencies' };
      return { kind: 'queued', phase: 'implementation' };

    default:
      return assertNever(event);
  }
}

// ---------------------------------------------------------------------------
// decide — transition rules (blueprint §11, 19 rows).
// ---------------------------------------------------------------------------

function reject(code: DomainRejectionCode, message: string): DomainRejection {
  return { ok: false, code, message };
}

/**
 * Apply the transition table. Returns a Decision (events+effects+result) on
 * acceptance, or a stable DomainRejection. See blueprint §11 for the table.
 *
 * NOTE on Slice 0 scope: `decide` here implements the *pure* transition logic.
 * It does NOT perform the command-bus receipt/outbox work (that is Slice 1).
 * The result type is a minimal ack per command; Slice 1+ will widen it.
 */
export function decide<C extends LifecycleCommand>(
  state: ManagedTaskState,
  envelope: CommandEnvelope<C>,
  facts: LifecycleFacts = PERMISSIVE_FACTS,
): DecideResult<{ readonly acknowledged: true }> {
  const cmd = envelope.command;

  switch (cmd.kind) {
    // -----------------------------------------------------------------------
    // ReserveWorkItem(implementation|review) — §11:510-511
    // -----------------------------------------------------------------------
    case 'ReserveWorkItem': {
      if (state.kind !== 'queued' || state.phase !== cmd.phase) {
        return reject('NO_TRANSITION', `state ${state.kind}:${('phase' in state ? state.phase : '-')}`);
      }
      if (!facts.dependenciesReady) {
        return reject('PRECONDITION_FAILED', 'dependencies not ready');
      }
      if (!facts.noOpenHumanRequest) {
        return reject('PRECONDITION_FAILED', 'open human request blocks claim');
      }
      return {
        ok: true,
        events: [
          {
            kind: 'WorkAttemptReserved',
            taskId: cmd.taskId,
            workItemId: cmd.workItemId,
            attemptId: cmd.attemptId,
            executionId: cmd.executionId,
          },
          {
            kind: 'ExecutionReserved',
            taskId: cmd.taskId,
            executionId: cmd.executionId,
            workerId: cmd.workerId,
          },
        ],
        effects: [{ kind: 'worker.spawn', executionId: cmd.executionId }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // RegisterWorkerProcess — §11:512
    // -----------------------------------------------------------------------
    case 'RegisterWorkerProcess': {
      if (state.kind !== 'active') {
        return reject('NO_TRANSITION', `RegisterWorkerProcess requires active state, got ${state.kind}`);
      }
      if (state.executionId !== cmd.executionId) {
        return reject('PRECONDITION_FAILED', 'execution id mismatch');
      }
      return {
        ok: true,
        events: [
          {
            kind: 'ExecutionStarted',
            taskId: cmd.taskId,
            executionId: cmd.executionId,
            pid: cmd.pid,
          },
        ],
        effects: [],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ReportImplementationCompleted — §11:513
    // -----------------------------------------------------------------------
    case 'ReportImplementationCompleted': {
      if (state.kind !== 'active' || state.phase !== 'implementation') {
        return reject('NO_TRANSITION', `requires active:implementation, got ${state.kind}`);
      }
      return {
        ok: true,
        events: [
          {
            kind: 'ImplementationCompleted',
            taskId: cmd.taskId,
            workItemId: cmd.workItemId,
            attemptId: cmd.attemptId,
            sourceSha: cmd.sourceSha,
          },
          {
            kind: 'ReviewItemCreated',
            taskId: cmd.taskId,
            workItemId: `review-for-${cmd.workItemId}`,
          },
        ],
        effects: [],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // SubmitReviewVerdict — §11:514-516 (three sub-rows)
    // -----------------------------------------------------------------------
    case 'SubmitReviewVerdict': {
      if (state.kind !== 'active' || state.phase !== 'review') {
        return reject('NO_TRANSITION', `requires active:review, got ${state.kind}`);
      }
      if (cmd.verdict === 'approved') {
        if (!facts.verificationPassed) {
          return reject('PRECONDITION_FAILED', 'verification gate not passed');
        }
        // Git vs non-git distinction is decided by the shell (whether
        // reviewedSourceSha is present). For Slice 0 the oracle emits the
        // non-git variant when reviewedSourceSha is absent.
        if (cmd.reviewedSourceSha) {
          const integrationId = `integration-for-${cmd.workItemId}` as const;
          return {
            ok: true,
            events: [
              {
                kind: 'ReviewApproved',
                taskId: cmd.taskId,
                workItemId: cmd.workItemId,
                attemptId: cmd.attemptId,
                reviewedSourceSha: cmd.reviewedSourceSha,
              },
              {
                kind: 'IntegrationRequested',
                taskId: cmd.taskId,
                integrationId: integrationId as never,
              },
            ],
            effects: [{ kind: 'integration.execute', integrationId: integrationId as never }],
            result: { acknowledged: true },
          };
        }
        return {
          ok: true,
          events: [
            {
              kind: 'ReviewApproved',
              taskId: cmd.taskId,
              workItemId: cmd.workItemId,
              attemptId: cmd.attemptId,
            },
          ],
          effects: [{ kind: 'workflow.generate', sourceTaskId: cmd.taskId }],
          result: { acknowledged: true },
        };
      }
      // changes_requested
      return {
        ok: true,
        events: [
          {
            kind: 'ReviewChangesRequested',
            taskId: cmd.taskId,
            workItemId: cmd.workItemId,
            attemptId: cmd.attemptId,
          },
          {
            kind: 'ImplementationItemCreated',
            taskId: cmd.taskId,
            workItemId: `impl-cycle-after-${cmd.workItemId}`,
          },
        ],
        effects: [],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ParkForHuman — §11:517 (terminal, blueprint §12.3)
    // -----------------------------------------------------------------------
    case 'ParkForHuman': {
      if (state.kind !== 'active') {
        return reject('NO_TRANSITION', `requires active, got ${state.kind}`);
      }
      const requestId = `human-${cmd.taskId}-${cmd.attemptId}` as never;
      return {
        ok: true,
        events: [
          {
            kind: 'HumanInputRequested',
            taskId: cmd.taskId,
            requestId,
            resumePhase: cmd.resumePhase,
            question: cmd.question,
          },
        ],
        effects: [{ kind: 'human.notify', requestId }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // RecordHumanAnswer — §11:518
    // -----------------------------------------------------------------------
    case 'RecordHumanAnswer': {
      if (state.kind !== 'waiting_human' || state.requestId !== cmd.requestId) {
        return reject('NO_TRANSITION', `requires waiting_human:${cmd.requestId}, got ${state.kind}`);
      }
      return {
        ok: true,
        events: [
          {
            kind: 'HumanInputProvided',
            taskId: cmd.taskId,
            requestId: cmd.requestId,
          },
        ],
        effects: [],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // RequestExecutionStop — §11 (implied, paired with ExecutionStopRequested)
    // -----------------------------------------------------------------------
    case 'RequestExecutionStop': {
      if (state.kind !== 'active' && state.kind !== 'finishing') {
        return reject('NO_TRANSITION', `requires active|finishing, got ${state.kind}`);
      }
      if (state.executionId !== cmd.executionId) {
        return reject('PRECONDITION_FAILED', 'execution id mismatch');
      }
      return {
        ok: true,
        events: [
          {
            kind: 'ExecutionStopRequested',
            taskId: cmd.taskId,
            executionId: cmd.executionId,
          },
        ],
        effects: [{ kind: 'worker.terminate', executionId: cmd.executionId }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ObserveProcessExited — §11:519-520 (two rows)
    // -----------------------------------------------------------------------
    case 'ObserveProcessExited': {
      // Row 1 (§11:519): after accepted terminal report. State is finishing or
      // already post-terminal. ExecutionExited is bookkeeping.
      // Row 2 (§11:520): no terminal report. ExecutionExited + TaskReleased,
      // task returns to its original phase queue.
      if (state.kind === 'finishing') {
        return {
          ok: true,
          events: [
            {
              kind: 'ExecutionExited',
              taskId: cmd.taskId,
              executionId: cmd.executionId,
              exitCode: cmd.exitCode,
            },
          ],
          effects: [],
          result: { acknowledged: true },
        };
      }
      if (state.kind === 'active') {
        const phase = state.phase;
        return {
          ok: true,
          events: [
            {
              kind: 'ExecutionExited',
              taskId: cmd.taskId,
              executionId: cmd.executionId,
              exitCode: cmd.exitCode,
            },
            {
              kind: 'TaskReleased',
              taskId: cmd.taskId,
              resumePhase: phase,
            },
          ],
          effects: [],
          result: { acknowledged: true },
        };
      }
      return reject('NO_TRANSITION', `state ${state.kind} has no execution to exit`);
    }

    // -----------------------------------------------------------------------
    // ObserveProcessLost — §11:521-522 (two rows)
    // -----------------------------------------------------------------------
    case 'ObserveProcessLost': {
      // Row 1 (§11:522): reviewer died AFTER approval. Review item already
      // terminal; integration remains ready. ExecutionLost only.
      if (state.kind === 'awaiting_integration' || state.kind === 'integrating' || state.kind === 'integration_conflict') {
        return {
          ok: true,
          events: [
            { kind: 'ExecutionLost', taskId: cmd.taskId, executionId: cmd.executionId },
          ],
          effects: [],
          result: { acknowledged: true },
        };
      }
      // Row 2 (§11:521): verified-dead active execution. WorkAttemptLost +
      // ExecutionLost + TaskReleased, item returns to its queue.
      if (state.kind === 'active' || state.kind === 'finishing') {
        const phase = state.kind === 'finishing' ? state.completedPhase : state.phase;
        return {
          ok: true,
          events: [
            { kind: 'ExecutionLost', taskId: cmd.taskId, executionId: cmd.executionId },
            { kind: 'WorkAttemptLost', taskId: cmd.taskId, attemptId: '(inferred from execution)' },
            { kind: 'TaskReleased', taskId: cmd.taskId, resumePhase: phase },
          ],
          effects: [],
          result: { acknowledged: true },
        };
      }
      return reject('NO_TRANSITION', `state ${state.kind} has no execution to lose`);
    }

    // -----------------------------------------------------------------------
    // ReserveIntegrationAttempt — §11:523
    // -----------------------------------------------------------------------
    case 'ReserveIntegrationAttempt': {
      if (state.kind !== 'awaiting_integration') {
        return reject('NO_TRANSITION', `requires awaiting_integration, got ${state.kind}`);
      }
      if (!facts.repositoryFree) {
        return reject('PRECONDITION_FAILED', 'repository not free');
      }
      return {
        ok: true,
        events: [
          {
            kind: 'IntegrationStarted',
            taskId: cmd.taskId,
            integrationId: cmd.integrationId,
            executorExecutionId: cmd.executorExecutionId,
          },
        ],
        effects: [{ kind: 'integration.execute', integrationId: cmd.integrationId }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ObserveIntegrationMerged — §11:524
    // -----------------------------------------------------------------------
    case 'ObserveIntegrationMerged': {
      if (
        state.kind !== 'integrating' &&
        state.kind !== 'awaiting_integration'
      ) {
        return reject('NO_TRANSITION', `requires integrating|awaiting_integration, got ${state.kind}`);
      }
      return {
        ok: true,
        events: [
          {
            kind: 'IntegrationObservedMerged',
            taskId: cmd.taskId,
            integrationId: cmd.integrationId,
            mergeCommitSha: cmd.mergeCommitSha,
          },
        ],
        effects: [{ kind: 'workflow.generate', sourceTaskId: cmd.taskId }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ObserveIntegrationConflict — §11:525
    // -----------------------------------------------------------------------
    case 'ObserveIntegrationConflict': {
      if (
        state.kind !== 'integrating' &&
        state.kind !== 'awaiting_integration'
      ) {
        return reject('NO_TRANSITION', `requires integrating|awaiting_integration, got ${state.kind}`);
      }
      return {
        ok: true,
        events: [
          {
            kind: 'IntegrationObservedConflict',
            taskId: cmd.taskId,
            integrationId: cmd.integrationId,
            conflictManifest: cmd.conflictManifest,
          },
        ],
        effects: [{ kind: 'human.notify', requestId: `(integration-conflict-${cmd.taskId})` as never }],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // ReconcileDependencies — §11:526-527
    // -----------------------------------------------------------------------
    case 'ReconcileDependencies': {
      if (cmd.blocked) {
        // Row §11:526: queued tasks only.
        if (state.kind !== 'queued') {
          return reject('NO_TRANSITION', `block requires queued, got ${state.kind}`);
        }
        return {
          ok: true,
          events: [{ kind: 'DependencyBlocked', taskId: cmd.taskId }],
          effects: [],
          result: { acknowledged: true },
        };
      }
      // Unblock.
      if (state.kind !== 'blocked_dependencies') {
        return reject('NO_TRANSITION', `unblock requires blocked_dependencies, got ${state.kind}`);
      }
      return {
        ok: true,
        events: [{ kind: 'DependencyUnblocked', taskId: cmd.taskId }],
        effects: [],
        result: { acknowledged: true },
      };
    }

    // -----------------------------------------------------------------------
    // AdminOverrideLifecycle — §11:528
    // -----------------------------------------------------------------------
    case 'AdminOverrideLifecycle': {
      if (envelope.actor.kind !== 'admin') {
        return reject('NOT_AUTHORIZED', 'admin override requires admin actor');
      }
      return {
        ok: true,
        events: [
          {
            kind: 'AdminOverrideApplied',
            taskId: cmd.taskId,
            target: cmd.target,
            reason: envelope.actor.reason,
          },
        ],
        effects: [],
        result: { acknowledged: true },
      };
    }

    default:
      return assertNever(cmd);
  }
}
