/**
 * W4-A4 — Universal recovery engine.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md
 *       (Wave 4 Lane A4). Plan §8.10 (RecoveryAction union).
 *
 * OWNERSHIP: this file is the single owner of the generic
 * RecoveryIssue → RecoveryAction → RecoveryFeedback mapping. It is
 * module-agnostic: it never switches on module names, reason-code vocabulary
 * or finding codes. The module's vocabulary enters only via the
 * `RecoveryPolicyBinding.actionMap` (Wave 1 SPI, opaque string keys →
 * `RecoveryAction` values).
 *
 * BUILDS ON the existing RecoveryCase system (Wave 3). It does NOT replace
 * `persistence/sqlite-recovery-case-repository.ts` or the
 * `reconcileRecoveryCheckpoint` loop in `generic-flow-executor.ts`. It exposes
 * a pure router (`routeRecoveryAction`) plus a thin application service
 * (`UniversalRecoveryEngine`) that records the issue through the existing
 * `RecoveryCaseRepository` port and returns a `RecoveryDecision` carrying the
 * chosen action together with the durable `RecoveryFeedback`.
 *
 * DEPENDENCY DIRECTION (ratchet): application/ → persistence/*-repository.ts
 * (port) allowed; application/ → domain/spi/* allowed; application/ →
 * domain/recovery.js allowed. No imports from sqlite adapters, infrastructure,
 * db.ts or module implementations.
 */

import {
  RECOVERY_FEEDBACK_SCHEMA,
  type RecoveryFeedback,
  type RecoveryIssue,
  type RecoverySourceProduction,
} from '../domain/recovery.js';
import type { ProcessModuleReference } from '../domain/process-module.js';
import {
  RECOVERY_ACTIONS,
  type RecoveryAction,
  type RecoveryPolicyBinding,
} from '../domain/spi/recovery-definitions.js';
import type { RecoveryCaseRepository } from '../persistence/recovery-case-repository.js';
import type {
  RecordRecoveryIssueInput,
  RecordRecoveryIssueResult,
} from '../persistence/recovery-case.js';

// ---------------------------------------------------------------------------
// Internal constants.
// ---------------------------------------------------------------------------

/**
 * Fallback mapping from the verifier's semantic `RecoveryDisposition` to a
 * runtime `RecoveryAction`, used when the module's `actionMap` does not name an
 * explicit action for the issue's `reasonCode`.
 *
 * The runtime owns HOW the issue is retried (plan §8.10). `disposition` is the
 * verifier's semantic recommendation; these defaults convert that
 * recommendation into a concrete runtime action without interpreting module
 * vocabulary.
 */
const DISPOSITION_FALLBACK: Readonly<Record<RecoveryIssue['disposition'], RecoveryAction>> = {
  repair: 'return-to-producer',
  retry: 'retry-current-node',
  human: 'request-human',
  fatal: 'terminate',
};

// ---------------------------------------------------------------------------
// Pure router.
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime action for one recovery issue.
 *
 * Resolution order (first wins):
 *   1. `policyBinding.actionMap[issue.reasonCode]` — the module's explicit,
 *      opaque-keyed binding. This is the primary path: the module decides the
 *      action for its own vocabulary.
 *   2. `policyBinding.actionMap['*']` — a module-authored wildcard binding.
 *   3. `DISPOSITION_FALLBACK[issue.disposition]` — the runtime default derived
 *      from the verifier's semantic recommendation.
 *   4. `'escalate'` — the conservative terminal fallback when nothing else
 *      matches and the disposition is unknown.
 *
 * The function is PURE: same `(issue, policyBinding)` → same action. It never
 * touches the repository, the clock, or any mutable state. The action chosen
 * here is advisorial with respect to the attempt budget: when the budget is
 * exhausted, callers should prefer `routeRecoveryActionOnExhaustion`.
 *
 * `policyBinding` may be `null`/`undefined` when a module has not declared a
 * per-node binding; the router then falls straight back to the disposition
 * default. This keeps the engine usable by modules that pre-date the Wave 1
 * SPI binding.
 */
export function routeRecoveryAction(
  issue: RecoveryIssue,
  policyBinding: RecoveryPolicyBinding | null | undefined,
): RecoveryAction {
  if (policyBinding) {
    const explicit = policyBinding.actionMap[issue.reasonCode];
    if (typeof explicit === 'string' && RECOVERY_ACTIONS.has(explicit)) {
      return explicit;
    }
    const wildcard = policyBinding.actionMap['*'];
    if (typeof wildcard === 'string' && RECOVERY_ACTIONS.has(wildcard)) {
      return wildcard;
    }
  }
  return DISPOSITION_FALLBACK[issue.disposition] ?? 'escalate';
}

/**
 * Resolve the runtime action once the configured repair budget is exhausted.
 *
 * The chosen in-budget action (e.g. `return-to-producer`) is no longer useful
 * once every repair round has failed. This router promotes the action along
 * the exhaustion ladder:
 *
 *   - `escalate` / `terminate` / `request-human` are already terminal or
 *     human-class — preserved as-is.
 *   - `pause-external` is preserved (an external pause is itself a terminal
 *     hand-off for the external side).
 *   - any in-budget repair/retry action (`retry-current-node`,
 *     `return-to-producer`, `enter-recovery-node`) becomes `escalate`, matching
 *     `FlowRecoveryDefinition.onExhausted='escalate'` semantics.
 *
 * Pure. Used by the engine after `recordIssue` reports `exhausted: true`.
 */
export function routeRecoveryActionOnExhaustion(
  action: RecoveryAction,
): RecoveryAction {
  switch (action) {
    case 'escalate':
    case 'terminate':
    case 'request-human':
    case 'pause-external':
      return action;
    case 'retry-current-node':
    case 'return-to-producer':
    case 'enter-recovery-node':
      return 'escalate';
    default:
      // Defensive: an unknown action should not silently become repairable.
      return 'escalate';
  }
}

// ---------------------------------------------------------------------------
// Pure feedback builder.
// ---------------------------------------------------------------------------

/**
 * Inputs needed to assemble a `RecoveryFeedback` envelope for the repair
 * worker. Mirrors the durable identity the SQLite repository stamps, so the
 * engine can hand the same envelope to a ProtocolRun-driven repair path
 * without re-reading the database.
 */
export interface BuildRecoveryFeedbackInput {
  readonly caseId: number;
  readonly processRunId: number;
  readonly moduleRef: ProcessModuleReference;
  readonly sourceNodeRunId: number;
  readonly verifyNodeId: string;
  readonly repairNodeId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly issueRef: string;
  readonly issueHash: string;
  readonly issue: RecoveryIssue;
  readonly sourceProduction: RecoverySourceProduction;
}

/**
 * Build the runtime-owned `RecoveryFeedback` envelope delivered to the repair
 * worker. Pure: it only assembles the envelope from the supplied durable
 * identity and the immutable issue. It does not persist anything.
 *
 * The resulting shape is byte-compatible with the feedback the SQLite
 * repository writes (see `SqliteRecoveryCaseRepository.recordIssue`), so a
 * caller may use either source interchangeably when reconstructing a repair
 * task after a crash.
 */
export function buildRecoveryFeedback(
  input: BuildRecoveryFeedbackInput,
): RecoveryFeedback {
  return {
    schemaVersion: RECOVERY_FEEDBACK_SCHEMA,
    caseId: input.caseId,
    processRunId: input.processRunId,
    moduleRef: input.moduleRef,
    sourceNodeRunId: input.sourceNodeRunId,
    verifyNodeId: input.verifyNodeId,
    repairNodeId: input.repairNodeId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    issueRef: input.issueRef,
    issueHash: input.issueHash,
    issue: input.issue,
    sourceProduction: input.sourceProduction,
  };
}

// ---------------------------------------------------------------------------
// Engine — wires the pure router to the existing RecoveryCaseRepository.
// ---------------------------------------------------------------------------

/**
 * Inputs the engine needs from the runtime to record one recovery issue and
 * decide the action. It is the union of what the repository needs to persist
 * (`RecordRecoveryIssueInput`) and what the router needs to choose the action
 * (`RecoveryPolicyBinding`).
 */
export interface RecoveryEngineInput extends RecordRecoveryIssueInput {
  /**
   * Per-node binding of module reason codes to runtime actions. Optional: when
   * omitted, the router falls back to the issue's `disposition`.
   */
  readonly policyBinding?: RecoveryPolicyBinding | null;
}

/**
 * The engine's decision: the chosen action plus the durable feedback the
 * repair worker needs, and the repository result for callers that want the
 * full case/attempt records.
 */
export interface RecoveryDecision {
  /** The action the runtime should take for this issue. */
  readonly action: RecoveryAction;
  /** Durable feedback envelope for the repair worker. */
  readonly feedback: RecoveryFeedback;
  /**
   * `true` when the configured repair budget is consumed. Callers MUST treat
   * the case as terminal-for-repair and honour the exhaustion-routed action.
   */
  readonly exhausted: boolean;
  /** `true` when this exact issue was already recorded (idempotent replay). */
  readonly replayed: boolean;
  /** Raw repository result (case + attempt records). */
  readonly recorded: RecordRecoveryIssueResult;
}

/**
 * Universal, module-agnostic recovery engine.
 *
 * Wraps the pure `routeRecoveryAction` router and the existing
 * `RecoveryCaseRepository` port. One engine instance repairs any module: the
 * module's vocabulary enters only through `RecoveryPolicyBinding.actionMap`,
 * and durability is delegated to the injected repository (the Wave 3 SQLite
 * adapter by default, but any port implementation works).
 *
 * The engine is stateless beyond the repository handle: it holds no per-run
 * memory, so it is safe to reuse across process runs and recovery policies.
 */
export class UniversalRecoveryEngine {
  constructor(private readonly recoveryCaseRepo: RecoveryCaseRepository) {}

  /**
   * Record one verifier failure and decide the runtime action.
   *
   * Steps:
   *   1. Delegate persistence to `recoveryCaseRepo.recordIssue`. This is
   *      idempotent on the source NodeRun + immutable issue, and tracks the
   *      attempt budget atomically (Wave 3 contract).
   *   2. Route the in-budget action via `routeRecoveryAction`.
   *   3. When the repository reports `exhausted`, promote the action via
   *      `routeRecoveryActionOnExhaustion`.
   *   4. Return the `RecoveryDecision` (action + feedback + recorded result).
   *
   * The returned `feedback` is the authoritative envelope for the repair
   * worker; it is byte-compatible with the repository's persisted snapshot.
   */
  recordAndRoute(input: RecoveryEngineInput): RecoveryDecision {
    const recorded = this.recoveryCaseRepo.recordIssue(input);
    const inBudget = routeRecoveryAction(input.issue, input.policyBinding ?? null);
    const action = recorded.exhausted
      ? routeRecoveryActionOnExhaustion(inBudget)
      : inBudget;
    return {
      action,
      feedback: recorded.feedback,
      exhausted: recorded.exhausted,
      replayed: recorded.replayed,
      recorded,
    };
  }

  /**
   * Resolve the active recovery case for a policy after its verifier succeeds.
   * Thin pass-through to the repository so callers dependent on the engine do
   * not also need to hold the repository handle.
   */
  resolveActive(
    processRunId: number,
    policyId: string,
    resolvedByNodeRunId: number,
  ): number | null {
    const record = this.recoveryCaseRepo.resolveActive(
      processRunId,
      policyId,
      resolvedByNodeRunId,
    );
    return record?.id ?? null;
  }
}
