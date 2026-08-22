/**
 * CC-GAP-9 / ADR-089 — bounded deterministic in-check substrate retry, then
 * typed unknown (`warrant-blocked-environment`).
 *
 * Elite-6 defect (CC-00C F8/F10, I4): the readiness provider mapped every
 * `ReadinessExecutionError` — including the Docker-unavailable substrate
 * codes — to a `'failed'` check outcome, and `domain.failed` then routed
 * straight to `complete-failed` terminal: a machine fault was recorded as a
 * product verdict.
 *
 * This module is the PURE contract core of the fix (no DB, no process state):
 *
 *   1. A missing environment precondition (exactly the two frozen codes
 *      below) is retried deterministically INSIDE the check — a frozen
 *      attempt bound and a frozen schedule, no model, no WorkerExecution,
 *      no CandidateSet, no repair epoch, no worker repair budget.
 *   2. On exhaustion the check emits a typed `unknown` outcome carrying the
 *      `warrant-blocked-environment` diagnostic — never `passed`, never
 *      `failed` — with the full attempt evidence (per-attempt code, the
 *      frozen bound, the frozen schedule).
 *   3. The routing contract: the unknown receipt stops the line through the
 *      plan entry's `indeterminateDisposition: 'human-required'` →
 *      GateDecision `human_required` → the cell's `humanRequiredTransition`
 *      (`complete-blocked`), a truthful typed wait with a wake source —
 *      never a terminal product failure. A substrate condition alone can
 *      never produce `complete-failed`.
 *   4. Three classes stay mechanically distinct: product-failed (a check
 *      exercised the product and the product failed), oracle-insufficient
 *      (CC-GAP-7 vocabulary, unlanded) and substrate-unavailable. The
 *      rendering guard below makes every collapse of them — including the
 *      exact Elite-6 shape (`failed` + a substrate precondition code) —
 *      fail closed.
 *
 * Frozen-policy rule (ADR-089 pre-mortem #1/#4): the attempt bound and
 * schedule are CODE CONSTANTS. They are never read from the environment,
 * never from model output, never from repair budgets or CandidateSets, and
 * never silently tunable — changing them is a deliberate, reviewed code
 * change that bumps the provider digest. Only the sleep/clock functions are
 * injectable, and only as test seams (the schedule VALUES stay frozen).
 */

import type { CheckOutcome } from '../../process-modules/domain/workplace/gate.js';
import { ReadinessExecutionError } from './readiness-executor.js';

/**
 * The typed unknown diagnostic for an exhausted in-check substrate retry
 * (ADR-089 decision §3; network-3 vocabulary). Exact string stability is
 * frozen by the CC-GAP-9 blocking proofs.
 */
export const SUBSTRATE_PRECONDITION_DIAGNOSTIC = 'warrant-blocked-environment';

/**
 * The closed set of substrate-precondition codes that receive the bounded
 * in-check retry. Deliberately exactly two:
 *
 *   - `LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE` — the docker daemon is not
 *     reachable (daemon down, CLI absent);
 *   - `LOCAL_RUNNABILITY_DOCKER_NOT_LINUX` — the daemon is up but its
 *     runtime is not linux.
 *
 * Both mean "the declared environment precondition is missing", which is
 * exactly the ADR-089 missing-environment-precondition class. Every other
 * `ReadinessExecutionError` (pull failed, base resolution failed, …) keeps
 * the existing fail-closed `'failed'` semantics: those are configuration or
 * product-adjacent failures, not transient environment preconditions, and
 * widening the retry set would silently change product-failure semantics.
 */
export const SUBSTRATE_PRECONDITION_CODES = Object.freeze([
  'LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE',
  'LOCAL_RUNNABILITY_DOCKER_NOT_LINUX',
] as const);

export type SubstratePreconditionCode = (typeof SUBSTRATE_PRECONDITION_CODES)[number];

const SUBSTRATE_CODE_SET = new Set<string>(SUBSTRATE_PRECONDITION_CODES);

/**
 * The FROZEN in-check substrate retry policy (ADR-089 decision §2).
 * `maxAttempts` is the TOTAL probe count inside one check run (1 initial +
 * `maxAttempts - 1` retries); `retryDelayMs` is the fixed delay between
 * attempts. Deterministic: same schedule on every attempt, no backoff, no
 * jitter, no env override.
 */
export const SUBSTRATE_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  retryDelayMs: 1_000,
} as const);

/** One recorded substrate-precondition attempt (append-only attempt evidence). */
export interface SubstrateRetryAttempt {
  /** 1-based attempt ordinal inside the check. */
  readonly attempt: number;
  /** The typed precondition code the attempt observed. */
  readonly code: SubstratePreconditionCode;
  /** The executor's human-readable detail for the attempt. */
  readonly message: string;
}

/** Type guard: is this error a retryable substrate-precondition failure? */
export function isSubstratePreconditionError(
  error: unknown,
): error is ReadinessExecutionError & { code: SubstratePreconditionCode } {
  return error instanceof ReadinessExecutionError
    && SUBSTRATE_CODE_SET.has(error.code);
}

/**
 * Deterministic observation payload for the exhausted-unknown receipt: the
 * frozen bound, the frozen schedule, and every attempt. This rides the
 * receipt evidence so a human (or the CC-GAP-8 ledger reader) can see the
 * retry happened, how many times, under which frozen policy.
 */
export function substrateRetryObservation(
  attempts: readonly SubstrateRetryAttempt[],
): Record<string, unknown> {
  return {
    substrateRetry: {
      diagnostic: SUBSTRATE_PRECONDITION_DIAGNOSTIC,
      attemptBound: SUBSTRATE_RETRY_POLICY.maxAttempts,
      retryDelayMs: SUBSTRATE_RETRY_POLICY.retryDelayMs,
      exhausted: true,
      attempts: attempts.map(attempt => ({
        attempt: attempt.attempt,
        code: attempt.code,
      })),
    },
  };
}

/** Human-readable summary stamped into the warrant-blocked-environment diagnostic. */
export function substrateRetryMessage(
  attempts: readonly SubstrateRetryAttempt[],
): string {
  const last = attempts[attempts.length - 1];
  const codes = [...new Set(attempts.map(attempt => attempt.code))].join(', ');
  return 'the declared environment precondition is missing: '
    + `${codes} persisted for all ${SUBSTRATE_RETRY_POLICY.maxAttempts} in-check attempts `
    + `(frozen schedule: ${SUBSTRATE_RETRY_POLICY.retryDelayMs}ms between attempts). `
    + 'The product was never exercised — the outcome is unknown, not failed. '
    + `Last attempt detail: ${last ? last.message.slice(0, 600) : '(none)'}. `
    + 'Provision the environment (e.g. start the docker daemon / switch it to a '
    + 'linux runtime), then resume: the same criterion executes again under '
    + 'current authority and this unknown receipt never counts against it.';
}

/**
 * Block the current thread for `ms` without spinning (Atomics.wait), the
 * same bounded-sleep technique the docker executor uses. Default for the
 * retry loop so a forgotten injection can never turn the frozen schedule
 * into a spin; tests inject an instant fake to stay hermetic.
 */
function sleepSyncBounded(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin — SharedArrayBuffer unavailable */ }
  }
}

/**
 * The bounded deterministic in-check substrate retry loop (ADR-089 §2).
 *
 * Runs `attempt()` up to `SUBSTRATE_RETRY_POLICY.maxAttempts` times. A
 * retryable substrate-precondition error is recorded and retried after the
 * frozen delay; ANY other error propagates immediately (no retry for
 * non-precondition failures — pull failures, command failures and product
 * failures keep their existing semantics); a success returns immediately.
 *
 * `betweenAttempts` runs BEFORE each re-probe so the caller can invalidate
 * stale substrate observations (the docker availability cache) — each retry
 * must genuinely re-probe the precondition, never replay a cached miss.
 * `sleep` is injectable ONLY as a test seam; production uses the real
 * bounded sleep. The policy itself (bound + schedule) is not injectable.
 */
export function runBoundedSubstrateRetry<T>(input: {
  readonly attempt: () => T;
  readonly betweenAttempts?: () => void;
  readonly sleep?: (ms: number) => void;
}): { status: 'satisfied'; result: T } | { status: 'exhausted'; attempts: SubstrateRetryAttempt[] } {
  const sleep = input.sleep ?? sleepSyncBounded;
  const attempts: SubstrateRetryAttempt[] = [];
  for (let ordinal = 1; ordinal <= SUBSTRATE_RETRY_POLICY.maxAttempts; ordinal += 1) {
    try {
      const result = input.attempt();
      return { status: 'satisfied', result };
    } catch (error) {
      if (!isSubstratePreconditionError(error)) throw error;
      attempts.push({
        attempt: ordinal,
        code: error.code,
        message: error.message,
      });
      if (ordinal === SUBSTRATE_RETRY_POLICY.maxAttempts) break;
      if (input.betweenAttempts) input.betweenAttempts();
      sleep(SUBSTRATE_RETRY_POLICY.retryDelayMs);
    }
  }
  return { status: 'exhausted', attempts };
}

// ---------------------------------------------------------------------------
// Classification / rendering guard (CC-GAP-9 blocking mutations b + the
// tracker rendering assertion).
// ---------------------------------------------------------------------------

/**
 * The three distinct outcome classes (ADR-089 decision §1). They are never
 * collapsed on any surface or route: `product-failed` is a check verdict
 * about the product; `oracle-insufficient` (CC-GAP-7 vocabulary, unlanded)
 * is an outstanding obligation; `substrate-unavailable` is a missing
 * environment precondition — an `unknown` receipt, never a verdict.
 */
export type SubstrateOutcomeClass =
  | 'product-failed'
  | 'oracle-insufficient'
  | 'substrate-unavailable'
  | 'provider-error';

/** Classify a (receipt outcome, diagnostic code) pair. */
export function classifyCheckOutcome(input: {
  readonly outcome: CheckOutcome;
  readonly diagnosticCode?: string | null;
}): SubstrateOutcomeClass | 'passed' {
  if (isSubstrateDiagnosticCode(input.diagnosticCode)) {
    return 'substrate-unavailable';
  }
  switch (input.outcome) {
    case 'passed': return 'passed';
    case 'failed': return 'product-failed';
    // An `unknown` without the substrate diagnostic is the CC-GAP-7
    // oracle-insufficient shape (the declared oracle cannot prove the
    // claim). Distinct class by construction; never rendered failed.
    case 'unknown': return 'oracle-insufficient';
    case 'error': return 'provider-error';
  }
}

function isSubstrateDiagnosticCode(code: string | null | undefined): boolean {
  return code === SUBSTRATE_PRECONDITION_DIAGNOSTIC
    || (typeof code === 'string' && SUBSTRATE_CODE_SET.has(code));
}

/**
 * The tracker/status rendering assertion (CC-GAP-9 blocking mutation):
 * `unknown` is neither pass nor product-failed, and a substrate
 * precondition can never be rendered as a product verdict.
 *
 * Input is what a status surface intends to render for one check receipt:
 * the truthful receipt outcome plus the rendered verdict. The guard fails
 * closed on every collapse shape:
 *
 *   - an `unknown` receipt rendered as `pass`  — poison-green (mutation);
 *   - an `unknown` receipt rendered as `failed` — the Elite-6 flattening;
 *   - a `warrant-blocked-environment` / substrate-precondition diagnostic
 *     carried by a `failed` or `passed` receipt — the exact current-code
 *     defect shape (`evidence('failed', …, LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE)`);
 *   - a substrate class rendered as `pass` or `failed` at all.
 *
 * A substrate-unavailable render is lawful ONLY as `unknown`/blocked.
 */
export function assertRenderedCheckOutcomeTruthful(render: {
  readonly receiptOutcome: CheckOutcome;
  readonly diagnosticCode?: string | null;
  readonly renderedAs: 'pass' | 'failed' | 'unknown' | 'error';
}): void {
  const truthClass = classifyCheckOutcome({
    outcome: render.receiptOutcome,
    diagnosticCode: render.diagnosticCode,
  });
  if (isSubstrateDiagnosticCode(render.diagnosticCode)
      && render.receiptOutcome !== 'unknown') {
    throw new Error(
      'CHECK_OUTCOME_CLASS_COLLAPSE: a substrate precondition diagnostic ('
        + `${render.diagnosticCode}) cannot ride a '${render.receiptOutcome}' receipt — `
        + 'substrate-unavailable is the typed unknown '
        + `${SUBSTRATE_PRECONDITION_DIAGNOSTIC} class, never a product verdict`,
    );
  }
  if (render.receiptOutcome === 'unknown' && render.renderedAs !== 'unknown') {
    throw new Error(
      'CHECK_OUTCOME_RENDER_COLLAPSE: an unknown receipt ('
        + `${render.diagnosticCode ?? 'unattributed'}) rendered as '${render.renderedAs}' — `
        + 'unknown is neither pass nor product-failed; it is an outstanding '
        + 'obligation/blocked-environment render',
    );
  }
  if (truthClass === 'substrate-unavailable'
      && (render.renderedAs === 'pass' || render.renderedAs === 'failed')) {
    throw new Error(
      'CHECK_OUTCOME_RENDER_COLLAPSE: substrate-unavailable rendered as '
        + `'${render.renderedAs}' — only an unknown/blocked-environment render is lawful`,
    );
  }
  if (render.receiptOutcome === 'failed' && render.renderedAs === 'pass') {
    throw new Error(
      'CHECK_OUTCOME_RENDER_COLLAPSE: a product-failed receipt rendered as pass',
    );
  }
}
