/**
 * LegacyEngineExecutorAdapter — bridges an existing OrchestrationEngine (Saga2
 * stage pump, Saga3 discovery engine, future formalization pump) onto the
 * ProcessModuleExecutor SPI.
 *
 * This is the THIN SHIM the v2 plan calls for (correction #8): it does NOT add
 * a poll-loop of its own. The wrapped engine already has one. The adapter's
 * only job is:
 *   1. translate the generic ProcessModuleExecutionContext into the engine's
 *      native RunEpisodeCommand,
 *   2. call the engine's run() once (the engine pumps internally),
 *   3. project the engine's domain-specific result into the generic
 *      ProcessModuleRunResult via an outcome projector.
 *
 * The terminal condition is the wrapped engine's terminal condition — for
 * Discovery that's "settlement complete + certificate issued"; for
 * Formalization (P5) that's "SRS done + acceptance baseline frozen + no more
 * claimable formalization tasks". The adapter never invents its own
 * "no claimable tasks" terminal.
 */

import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../../application/ports/orchestration-engine.js';
import type {
  ProcessModuleDefinition,
  ProcessModuleReference,
} from '../domain/process-module.js';
import {
  type ProcessModuleExecutionContext,
  type ProcessModuleExecutor,
  type ProcessModuleRunResult,
} from './process-module-executor.js';
import type {
  ProcessModuleCertificateRef,
  ProcessModuleOutput,
} from '../persistence/process-run.js';

/**
 * Projects the wrapped engine's domain-specific result into a module-local
 * outcome. The projector reads stage-specific fields (settlement, baseline,
 * certificate id…) and returns the generic outcome code + output/certificate
 * refs. This is where any domain knowledge lives — nowhere else in the SPI.
 */
export type LegacyOutcomeProjector = (
  module: ProcessModuleDefinition,
  result: OrchestrationRunResult,
  context: ProcessModuleExecutionContext,
) => ProcessModuleRunResult;

/**
 * Translates the generic ProcessModuleExecutionContext into the engine's
 * native RunEpisodeCommand. For Discovery this is a near-identity mapping; for
 * Formalization (P5) the FormalizationCase payload is mapped onto the episode.
 */
export type LegacyCommandTranslator = (
  module: ProcessModuleDefinition,
  context: ProcessModuleExecutionContext,
) => RunEpisodeCommand;

export interface LegacyEngineExecutorAdapterOptions {
  readonly moduleRef: ProcessModuleReference;
  readonly engine: OrchestrationEngine;
  readonly translateCommand: LegacyCommandTranslator;
  readonly projectOutcome: LegacyOutcomeProjector;
}

export class LegacyEngineExecutorAdapter implements ProcessModuleExecutor {
  readonly moduleRef: ProcessModuleReference;
  readonly kind = 'legacy-adapter' as const;
  private readonly engine: OrchestrationEngine;
  private readonly translateCommand: LegacyCommandTranslator;
  private readonly projectOutcome: LegacyOutcomeProjector;

  constructor(opts: LegacyEngineExecutorAdapterOptions) {
    this.moduleRef = opts.moduleRef;
    this.engine = opts.engine;
    this.translateCommand = opts.translateCommand;
    this.projectOutcome = opts.projectOutcome;
  }

  async execute(
    module: ProcessModuleDefinition,
    context: ProcessModuleExecutionContext,
  ): Promise<ProcessModuleRunResult> {
    const command = this.translateCommand(module, context);
    const result: OrchestrationRunResult = await this.engine.run(command);
    return this.projectOutcome(module, result, context);
  }
}

/**
 * Helper to build a no-output result (module that only emits a certificate).
 */
export function certificateOnlyResult(
  outcome: string,
  certificate: ProcessModuleCertificateRef,
  authority: string | null,
  raw?: Record<string, unknown> | null,
): ProcessModuleRunResult {
  return { outcome, output: null, certificate, authority, raw: raw ?? null };
}

/**
 * Helper to build an output-only result (module that emits an artifact but no
 * authoritative certificate — e.g. an external gate).
 */
export function outputOnlyResult(
  outcome: string,
  output: ProcessModuleOutput,
  authority: string | null,
  raw?: Record<string, unknown> | null,
): ProcessModuleRunResult {
  return { outcome, output, certificate: null, authority, raw: raw ?? null };
}
