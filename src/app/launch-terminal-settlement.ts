/**
 * CC-GAP-2 — launch/order/exit settlement as ONE pure, workshop-agnostic
 * projection with separated verdict channels.
 *
 * The defect this module closes: the engine CLI mapped `reason === 'completed'`
 * (the lifecycle MACHINE finishing a routed terminal) straight onto launch
 * `state='completed'`, order `state='completed'` and OS exit code 0 — with the
 * business verdict (lifecycle `terminal_status`, e.g. `development-blocked`,
 * `approval-required`, `formalization-inconsistent`) nowhere next to those
 * labels. A reader of exit 0 / "completed" could not avoid reading product
 * success into them (stage-19 post-mortem had to open the DB to prove the
 * label truthful).
 *
 * The lifecycle state machine deliberately separates:
 *
 *   status         = operational: did the machine reach a terminal state?
 *                    (`completed` = a routed business terminal, ANY verdict;
 *                     `failed` = runtime/infra failure; `cancelled`; `paused`)
 *   terminalStatus = the business verdict. The repository stamps it on every
 *                    terminal path (routed terminal → its declared status,
 *                    fail() → 'failed', cancel() → 'cancelled'); it is null
 *                    only while the run is non-terminal.
 *
 * Terminal statuses are declarative free-form strings per lifecycle scenario
 * package; the engine has NO workshop-agnostic success classification for them
 * (and must not invent one — `OutcomeDefinition` carries `terminal` only).
 * Therefore this settlement KEEPS the operational mapping byte-for-byte
 * (backward compatibility) and ADDS the verdict channels so every consumer can
 * — and must — read them separately:
 *
 *   exit 0 / launch 'completed' / order 'completed'
 *     = "the engine brought this run to a lifecycle terminal state"
 *     ≠ "the product succeeded".
 *
 * Which verdict the terminal carries is `lifecycleTerminalStatus`
 * (repository-stamped on every terminal path — the routed terminal's declared
 * status, 'failed', 'cancelled'), the last stage's local outcome is
 * `stageOutcome`, and the engine-projected final outcome is `productOutcome`
 * (terminalStatus ?? last stage localOutcome — the same projection rule as
 * `OrchestrationRunResult.outcome`).
 */

import type { OrchestrationRunResult } from '../application/ports/orchestration-engine.js';

export interface LaunchTerminalSettlement {
  /** Operational: the engine host reached a lifecycle terminal state (not paused mid-run). */
  readonly operationalTerminal: boolean;
  /** LaunchRequest settlement (operational; per CONVEYOR §23 the launch machine never claims lifecycle convergence). */
  readonly launchState: 'completed' | 'failed' | 'paused';
  /** FactoryOrder settlement. Enum-constrained (schema CHECK); 'completed' means the order's run reached ITS terminal state — NOT a product verdict. */
  readonly orderState: 'completed' | 'start_failed' | 'paused';
  /** OS exit contract: 0 = operational terminal (any business verdict), 1 = failed, 2 = paused. */
  readonly exitCode: number;
  /** Operational exit reason for journals ('completed'|'failed'|'stopped'|'paused'|...). */
  readonly exitReason: string;
  /** Launch error payload (only the runtime-failure branch carries one, as before). */
  readonly launchError: string | null;
  // --- separated verdict channels (CC-GAP-2; never implied by the fields above) ---
  /** Lifecycle machine status (`completed`/`failed`/`cancelled`/...), when a lifecycle adapter handled the run. */
  readonly lifecycleStatus: string | null;
  /** Lifecycle business verdict (`terminal_status`); repository-stamped on every terminal path (routed terminal status, 'failed', 'cancelled'), null only while non-terminal. */
  readonly lifecycleTerminalStatus: string | null;
  /** Final stage/process LOCAL outcome (module outcome code, e.g. 'verified'). */
  readonly stageOutcome: string | null;
  /** Engine-projected final outcome: terminalStatus ?? last stage localOutcome. NOT a success classification. */
  readonly productOutcome: string | null;
}

/**
 * Project one engine run result into the launch/order/exit settlement.
 *
 * Operational mapping is IDENTICAL to the pre-CC-GAP-2 inline CLI logic
 * (paused → paused/2, failed → failed+start_failed/1, any other terminal →
 * completed/0) so no consumer of launch state, order state or exit codes
 * changes behavior. The separation is additive: the verdict channels travel
 * WITH the settlement instead of being flattened into it.
 */
export function settleLaunchFromRunResult(
  result: OrchestrationRunResult,
): LaunchTerminalSettlement {
  const operationalTerminal = result.reason !== 'paused';
  const failed = result.reason === 'failed';
  return {
    operationalTerminal,
    launchState: !operationalTerminal ? 'paused' : failed ? 'failed' : 'completed',
    orderState: !operationalTerminal ? 'paused' : failed ? 'start_failed' : 'completed',
    exitCode: !operationalTerminal ? 2 : failed ? 1 : 0,
    exitReason: operationalTerminal ? result.reason : 'paused',
    launchError: failed ? JSON.stringify(result) : null,
    lifecycleStatus: result.lifecycleRun?.status ?? null,
    lifecycleTerminalStatus: result.lifecycleRun?.terminalStatus ?? null,
    stageOutcome: result.processOutcome?.code ?? null,
    productOutcome: result.outcome ?? null,
  };
}
