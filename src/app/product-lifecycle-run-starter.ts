/**
 * Production LifecycleRunStarter adapters for startProductLifecycleFromIdea.
 *
 * The assembler (start-product-lifecycle-from-idea.ts) is decoupled from HOW
 * the durable LifecycleRun is started via the `LifecycleRunStarter` port. This
 * module supplies the production adapters and keeps them out of the assembler
 * so the assembler stays pure and unit-testable.
 *
 * Two internal adapters are provided:
 *
 *  - `createFactoryLaunchStarter`: persists a single-use launch capability and
 *    spawns the runtime host with only that opaque reference. Input and resume
 *    identity never cross the process boundary as caller-controlled flags.
 *
 *  - `createInProcessLifecycleRunStarter`: runs the orchestrator in-process via
 *    an injected `application.runEpisode`. Used by tests / hosts that already
 *    hold a SagaApplication. Returns the durable lifecycleRunId from the run
 *    result.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrchestrationRunResult } from '../application/ports/orchestration-engine.js';
import type { SagaApplication } from '../application/saga-application.js';
import {
  PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA,
  type ProductDeliveryLifecycleInput,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import type { LifecycleRunStarter } from './start-product-lifecycle-from-idea.js';
import Database from 'better-sqlite3';
import { requestFactoryLaunch } from '../infrastructure/factory/sqlite-factory-launch-repository.js';

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
  /**
   * Maximum time to wait for the child to acknowledge a durable LifecycleRun.
   * A successful OS spawn alone is not a successful Saga start.
   */
  startReceiptTimeoutMs?: number;
  /** Poll interval for the durable start receipt. */
  startReceiptPollMs?: number;
}

/**
 * Persists a launch ticket, then spawns the internal runtime host with only its
 * opaque single-use reference.
 *
 * The adapter does not report success merely because the OS accepted spawn().
 * The child writes an atomic one-shot receipt immediately after the durable
 * LifecycleRun is created/replayed and before the first stage executes. This
 * method resolves only after reading and validating that positive run id.
 */
export function createFactoryLaunchStarter(
  options: SpawnCliLifecycleRunStarterOptions,
): LifecycleRunStarter {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const orchestrateCliPath = options.orchestrateCliPath
    // `here` resolves to <repo>/dist/app (the compiled location of this file).
    // orchestrate-cli.js is a sibling at <repo>/dist/orchestrate-cli.js, so only
    // one '..' is needed. The previous '..','..' resolved to <repo>/root and
    // produced MODULE_NOT_FOUND when the engine child tried to require it.
    ?? path.join(here, '..', 'orchestrate-cli.js');
  const spawnProcess = options.spawnProcess ?? spawn;
  const startReceiptTimeoutMs = options.startReceiptTimeoutMs ?? 15_000;
  const startReceiptPollMs = options.startReceiptPollMs ?? 50;
  if (!Number.isFinite(startReceiptTimeoutMs) || startReceiptTimeoutMs <= 0) {
    throw new Error('startReceiptTimeoutMs must be positive');
  }
  if (!Number.isFinite(startReceiptPollMs) || startReceiptPollMs <= 0) {
    throw new Error('startReceiptPollMs must be positive');
  }
  return {
    async start(params) {
      const receiptPath = path.join(
        os.tmpdir(),
        `saga-lifecycle-start-${randomUUID()}.json`,
      );
      const childEnv: NodeJS.ProcessEnv = {
        ...(options.baseEnv ?? {}),
        DB_PATH: options.dbPath,
        SAGA_LIFECYCLE_START_RECEIPT: receiptPath,
      };
      const db = new Database(options.dbPath);
      let launchRef: string;
      try {
        launchRef = requestFactoryLaunch({
          orderRef: params.orderRef,
          mode: 'new',
          projectId: params.projectId,
          epicId: params.epicId,
          lifecycleInput: params.lifecycleInput,
          lifecycleInputSchema: params.lifecycleInputSchema,
          initiatedBy: params.initiatedBy,
          idempotencyKey: params.idempotencyKey
            // Per-start default (NOT per-epic): an intentional new Factory Start
            // for the same project/epic must get a fresh idempotency key so it
            // creates a new order/run (CONVEYOR v4.3 §7).
            ?? `product-delivery:project:${params.projectId}:start:${randomUUID()}`,
          concurrency: params.concurrency,
        }, db);
      } finally {
        db.close();
      }
      const cliArgs = [orchestrateCliPath, `--launch-ref=${launchRef}`];
      // Must be present before spawn; mutating childEnv afterwards does not
      // change the environment already copied into the child process.
      const engineLog = `${tmpdir()}/saga-engine-${Date.now()}.log`;
      childEnv.SAGA_ENGINE_LOG = engineLog;
      const child = spawnProcess('node', cliArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });
      // Pipe engine stdout/stderr to a persistent log file for debugging.
      const logStream = createWriteStream(engineLog, { flags: 'a' });
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);
      child.unref();
      try {
        return await waitForLifecycleStartReceipt({
          child,
          receiptPath,
          timeoutMs: startReceiptTimeoutMs,
          pollMs: startReceiptPollMs,
        });
      } finally {
        rmSync(receiptPath, { force: true });
      }
    },
  };
}


interface LifecycleStartReceipt {
  lifecycleRunId: number;
  status: string;
  createdAt: string;
  acknowledgedAt: string;
}

export async function waitForLifecycleStartReceipt(params: {
  child: ChildProcess;
  receiptPath: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<{ lifecycleRunId: number }> {
  const startedAt = Date.now();
  const state: {
    spawnError: Error | null;
    earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  } = {
    spawnError: null,
    earlyExit: null,
  };
  const onError = (error: Error) => {
    state.spawnError = error;
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    state.earlyExit = { code, signal };
  };
  params.child.once('error', onError);
  params.child.once('exit', onExit);
  try {
    while (Date.now() - startedAt < params.timeoutMs) {
      if (existsSync(params.receiptPath)) {
        const receipt = JSON.parse(
          readFileSync(params.receiptPath, 'utf8'),
        ) as Partial<LifecycleStartReceipt>;
        if (
          !Number.isSafeInteger(receipt.lifecycleRunId)
          || Number(receipt.lifecycleRunId) <= 0
        ) {
          throw new Error(
            'LIFECYCLE_START_RECEIPT_INVALID: lifecycleRunId must be positive',
          );
        }
        return { lifecycleRunId: Number(receipt.lifecycleRunId) };
      }
      if (state.spawnError) {
        throw new Error(
          `LIFECYCLE_START_SPAWN_FAILED: ${state.spawnError.message}`,
        );
      }
      if (state.earlyExit) {
        throw new Error(
          'LIFECYCLE_START_CHILD_EXITED_BEFORE_RECEIPT: '
          + `code=${state.earlyExit.code ?? 'null'} `
          + `signal=${state.earlyExit.signal ?? 'null'}`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, params.pollMs));
    }
    throw new Error(
      `LIFECYCLE_START_RECEIPT_TIMEOUT: no durable run acknowledgement after `
      + `${params.timeoutMs}ms`,
    );
  } finally {
    params.child.off('error', onError);
    params.child.off('exit', onExit);
  }
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
