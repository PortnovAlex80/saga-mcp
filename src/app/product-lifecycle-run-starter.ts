/**
 * Production LifecycleRunStarter adapters for startProductLifecycleFromIdea.
 *
 * The assembler (start-product-lifecycle-from-idea.ts) is decoupled from HOW
 * the durable LifecycleRun is started via the `LifecycleRunStarter` port. This
 * module supplies the production adapters and keeps them out of the assembler
 * so the assembler stays pure and unit-testable.
 *
 * Two adapters are provided:
 *
 *  - `createSpawnCliLifecycleRunStarter`: spawns `orchestrate-cli` as a detached
 *    background process, passing the validated input INLINE via the
 *    `SAGA_PRODUCT_LIFECYCLE_INPUT_JSON` env var. No JSON file is written to
 *    disk and no `--lifecycle-input` path is passed. This is the adapter the
 *    tracker-view "start from idea" route uses: it matches the existing
 *    detached-engine architecture while honouring the fail-closed constraints.
 *
 *  - `createInProcessLifecycleRunStarter`: runs the orchestrator in-process via
 *    an injected `application.runEpisode`. Used by tests / hosts that already
 *    hold a SagaApplication. Returns the durable lifecycleRunId from the run
 *    result.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestrationRunResult } from '../application/ports/orchestration-engine.js';
import type { SagaApplication } from '../application/saga-application.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  type ProductDeliveryLifecycleInput,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import type { LifecycleRunStarter } from './start-product-lifecycle-from-idea.js';

/**
 * Read the durable lifecycleRunId from an OrchestrationRunResult. The lifecycle
 * adapter always returns it on the `lifecycleRun` field; pre-lifecycle engines
 * do not, in which case this returns null (the caller decides how to surface
 * that — the run still happened, just not through the lifecycle runtime).
 */
export function lifecycleRunIdFromResult(
  result: OrchestrationRunResult,
): number | null {
  return result.lifecycleRun?.id ?? null;
}

export interface SpawnCliLifecycleRunStarterOptions {
  /**
   * Path to the orchestrate-cli.js entry. Defaults to dist/orchestrate-cli.js
   * relative to this module (the production layout).
   */
  orchestrateCliPath?: string;
  /** DB path passed to the child (DB_PATH env). */
  dbPath: string;
  /** Base env merged into the child env. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Injected spawn (tests). Defaults to node:child_process spawn. */
  spawnProcess?: typeof spawn;
}

/**
 * Spawns `orchestrate-cli` detached with the validated lifecycle input passed
 * INLINE via env (no JSON file, no --lifecycle-input path). Resolves once the
 * child is spawned (unref'd); the run continues in the background. The
 * lifecycleRunId is not known at spawn time (the child creates it), so this
 * adapter resolves `lifecycleRunId: 0` and the frontend discovers the run via
 * the lifecycle_run_list poll, exactly as it does for the existing engine
 * control flow.
 */
export function createSpawnCliLifecycleRunStarter(
  options: SpawnCliLifecycleRunStarterOptions,
): LifecycleRunStarter {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const orchestrateCliPath = options.orchestrateCliPath
    ?? path.join(here, '..', '..', 'orchestrate-cli.js');
  const spawnProcess = options.spawnProcess ?? spawn;
  return {
    async start(params) {
      const childEnv: NodeJS.ProcessEnv = {
        ...(options.baseEnv ?? {}),
        DB_PATH: options.dbPath,
        SAGA_PRODUCT_LIFECYCLE_INPUT_JSON: JSON.stringify(params.lifecycleInput),
        SAGA_INITIATED_BY: params.initiatedBy,
      };
      const cliArgs = [
        orchestrateCliPath,
        String(params.projectId),
        String(params.epicId),
        `--concurrency=${params.concurrency}`,
      ];
      if (params.idempotencyKey?.trim()) {
        cliArgs.push(`--idempotency-key=${params.idempotencyKey.trim()}`);
      }
      spawnProcess('node', cliArgs, {
        detached: true,
        stdio: 'ignore',
        env: childEnv,
      }).unref();
      return { lifecycleRunId: 0 };
    },
  };
}

/**
 * Runs the lifecycle in-process via an injected SagaApplication. Used by tests
 * and by hosts that already hold the execution-plane application. Returns the
 * real durable lifecycleRunId from the run result.
 */
export function createInProcessLifecycleRunStarter(
  application: SagaApplication,
): LifecycleRunStarter {
  return {
    async start(params) {
      const result = await application.runEpisode({
        projectId: params.projectId,
        epicId: params.epicId,
        concurrency: params.concurrency,
        lifecycleInput: params.lifecycleInput,
        lifecycleInputSchema: PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
        initiatedBy: params.initiatedBy,
        idempotencyKey: params.idempotencyKey,
      });
      const id = lifecycleRunIdFromResult(result);
      if (id === null) {
        throw new Error(
          'LIFECYCLE_RUN_ID_UNAVAILABLE: the engine did not project a '
          + 'lifecycleRun id (was a non-lifecycle engine selected?)',
        );
      }
      return { lifecycleRunId: id };
    },
  };
}

/**
 * Re-export the input type so adapter consumers do not need a second import
 * path. Intentionally typed-only.
 */
export type { ProductDeliveryLifecycleInput };
