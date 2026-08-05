/**
 * ProcessModuleExecutor — the SPI contract every Process Module executor
 * implements.
 *
 * This is the UNIVERSAL interface. Whether a module runs through a legacy
 * engine adapter (Discovery today), a generic LM/kernel flow executor (P6c),
 * an external system, or a human gate, the Runtime calls the same
 * `execute()` method. No `run_discovery` / `run_formalization` specializations
 * exist — the module identity is carried by `moduleRef`, the flow shape by
 * the ProcessModuleDefinition passed to execute().
 *
 * The executor OWNS:
 *   - driving the module's internal flow (LM nodes, kernel nodes, …)
 *   - producing the module's output artifact (if any)
 *   - requesting/accepting the outcome certificate (if any)
 *   - transitioning the ProcessRun through preparing → running → settling
 *
 * The executor does NOT own:
 *   - creating the ProcessRun row (the Runtime does that via process_run_start)
 *   - routing to the next module (Lifecycle Orchestrator, P12)
 *   - selecting which module to run (composition root / operator)
 */

import type { ExecutorKind } from '../persistence/process-run.js';
import type {
  ProcessModuleDefinition,
  ProcessModuleReference,
} from '../domain/process-module.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
} from '../persistence/process-run.js';

/**
 * What the Runtime passes to the executor when it drives one ProcessRun.
 * The ProcessRun row already exists (created by process_run_start); the
 * executor receives its id so it can update status/output/certificate via
 * the repository as it progresses.
 */
export interface ProcessModuleExecutionContext {
  projectId: number;
  epicId: number | null;
  processRunId: number;
  /** Decoded input payload (the executor decodes against the module's inputContract). */
  inputPayload: unknown;
  inputHash: string;
  /** Caller/initiator identity for audit. */
  initiatedBy: string;
}

/**
 * The mandatory result shape every executor returns. Defined here in P1 as a
 * minimal contract; P2 enforces it across all executors and ensures output
 * and certificate are properly separated (never merged into one blob).
 *
 *   outcome       — one of the module's declared outcome codes (validated
 *                   against the definition's outcomes[] by the Runtime).
 *   output        — the module's primary output artifact (null if the module
 *                   emits no separate output, only a certificate).
 *   certificate   — the authoritative outcome certificate (null if the module
 *                   has no certificate step, e.g. a pure external gate).
 *   authority     — who/what issued the outcome (policy handler id, human,
 *                   external system). Null if not applicable.
 *   raw           — executor-specific bag for the outcome projector. The
 *                   Runtime does not interpret this; the Installation's
 *                   projector (if any) does.
 */
export interface ProcessModuleRunResult {
  outcome: string;
  output: ProcessModuleOutput | null;
  certificate: ProcessModuleCertificateRef | null;
  authority: string | null;
  /** Executor-specific fields the outcome projector may consume. */
  raw?: Record<string, unknown> | null;
}

/**
 * The SPI. One implementation per executor kind. The Runtime never special-
 * cases on kind — it calls execute() and reads the RunResult.
 */
export interface ProcessModuleExecutor {
  /** Which module this executor binds to. Must match the Installation's definition. */
  readonly moduleRef: ProcessModuleReference;
  /** Executor kind — recorded on the ProcessRun for observability. */
  readonly kind: ExecutorKind;
  /**
   * Drive one ProcessRun to a terminal result. The executor MUST transition
   * the ProcessRun to a terminal status (completed/failed) via the repository
   * before or atomically with returning. A non-terminal return is a contract
   * violation.
   */
  execute(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
  ): Promise<ProcessModuleRunResult>;
}

/**
 * An Installation binds one ProcessModuleDefinition to one ProcessModuleExecutor.
 *
 * A Definition alone lives in the catalog (read-only: "this module exists and
 * is structurally valid"). An Installation is what makes it RUNNABLE: "this
 * module is wired to this executor and can be started." Without an Installation
 * the Runtime refuses process_run_start for that module.
 *
 * This separation lets a module be catalogued (inspected, validated, designed
 * against) before its executor exists — essential for the module-authoring kit
 * (P7-P9) where a designer skill produces a Definition that only later gets an
 * executor (generic-flow in P6c, or a legacy adapter).
 *
 * P-PM-1 adds an OPTIONAL `package` field. When present, the installation is
 * hash-pinned: every shipped resource (skill, template, checklist) and every
 * handler version is captured in `package.packageDigest`, and ProcessRuns
 * started against this installation pin that digest via the
 * `factory_process_module_installations` row. This closes the "skill edited,
 * version unchanged" replay attack. During migration, installations without a
 * package continue to work (legacy path); once a module is fully migrated
 * (P-PM-6+), `package` becomes required.
 */
export interface ProcessModuleInstallation {
  readonly definition: ProcessModuleDefinition;
  readonly executor: ProcessModuleExecutor;
  /**
   * Hash-pinned delivery unit. Optional during migration; the Runtime stores
   * it in `factory_process_module_installations` when present and pins
   * `packageDigest` to every ProcessRun started against this installation.
   */
  readonly package?: import('../domain/process-module.js').ProcessModulePackage;
}
