/**
 * Saga 3 — Engine (composition root).
 *
 * The pump loop that drives EpisodeController.stepEpisode() until
 * terminal or quiescent. This is the ONLY entrypoint — no v2 fallback.
 *
 * Plan §3: "The Saga 3 entrypoint imports only Saga 3 modules."
 */

import type { Ports } from '../ports/ports.js';
import type { EpisodeContext } from './controller.js';
import { EpisodeController } from './controller.js';
import type { StepResult, TerminalOutcome } from '../domain/types.js';

export interface EngineOptions {
  readonly ports: Ports;
  readonly ctx: EpisodeContext;
  readonly maxSteps?: number;
  readonly tickMs?: number;
}

export interface EngineResult {
  readonly outcome: 'completed' | 'quiescent' | 'max_steps' | 'error';
  readonly terminalOutcome?: TerminalOutcome;
  readonly steps: number;
  readonly lastError?: string;
}

/**
 * Run the pump loop. Each iteration calls stepEpisode() once.
 * Stops when: terminal (absorbing), quiescent (3 consecutive), or maxSteps.
 *
 * In production this is called by the CLI/server. In tests by the simulator.
 */
export async function runEngine(opts: EngineOptions): Promise<EngineResult> {
  const { ports, ctx } = opts;
  const maxSteps = opts.maxSteps ?? 1000;
  const tickMs = opts.tickMs ?? 100;
  const controller = new EpisodeController(ports, ctx);

  let steps = 0;
  let quiescentCount = 0;
  const MAX_QUIESCENT = 3;

  while (steps < maxSteps) {
    steps++;

    let result: StepResult;
    try {
      result = controller.stepEpisode();
    } catch (e) {
      return {
        outcome: 'error',
        steps,
        lastError: e instanceof Error ? e.message : String(e),
      };
    }

    switch (result.kind) {
      case 'did_work':
        quiescentCount = 0;
        // In production: the pump would drive the worker through ports
        // (spawn claude, ingest output, attach evidence). For now, the
        // caller is responsible for executing the authorized work and
        // calling controller.ingestOutput before the next step.
        break;

      case 'waiting_until':
        quiescentCount = 0;
        // Sleep until the deadline (or tickMs, whichever is shorter).
        const waitMs = Math.min(result.at - ports.clock.now(), tickMs);
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, Math.min(waitMs, 100)));
        }
        break;

      case 'quiescent':
        quiescentCount++;
        if (quiescentCount >= MAX_QUIESCENT) {
          return { outcome: 'quiescent', steps };
        }
        await new Promise<void>((r) => setTimeout(r, tickMs));
        break;

      case 'terminal':
        return {
          outcome: 'completed',
          terminalOutcome: result.outcome,
          steps,
        };
    }
  }

  return { outcome: 'max_steps', steps };
}
