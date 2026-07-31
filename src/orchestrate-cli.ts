#!/usr/bin/env node
/**
 * Saga orchestration CLI host.
 *
 * Usage:
 *   node dist/orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]
 *
 * The CLI now depends on the engine-neutral SagaApplication boundary. After the
 * saga4 cutover the composition root always returns the Product Lifecycle
 * runtime; the legacy Saga2Engine is no longer reachable from here.
 *
 * Env:
 *   DB_PATH             — saga SQLite database (required; same as saga server)
 *   SAGA_CLAUDE_PATH    — path to the claude CLI binary (default: 'claude')
 *   SAGA_ORCHESTRATION_LOG — existing runtime log setting
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION — ESM module supplying Delivery providers
 *                         (required; the lifecycle runtime is the only engine)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createSaga2Application,
  type ProductLifecycleCompositionOverrides,
  type Saga2CompositionOverrides,
} from './app/composition-root.js';
import type { SagaApplication } from './application/saga-application.js';
import { getDb } from './db.js';
import {
  installProductionModules,
} from './process-modules/installation/production-install.js';

function parseArgs(argv: string[]): {
  projectId: number;
  epicId: number;
  concurrency: number;
  lifecycleInputPath: string | null;
  idempotencyKey: string | null;
  resumePaused: boolean;
} {
  const positional: string[] = [];
  let concurrency = 4;
  let lifecycleInputPath: string | null = null;
  let idempotencyKey: string | null = null;
  let resumePaused = false;
  for (const arg of argv.slice(2)) {
    const m = /^--concurrency=(\d+)$/.exec(arg);
    if (m) {
      concurrency = Number(m[1]);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
        throw new Error(`--concurrency must be an integer 1..10, got '${m[1]}'`);
      }
      continue;
    }
    const lifecycleInput = /^--lifecycle-input=(.+)$/.exec(arg);
    if (lifecycleInput) {
      lifecycleInputPath = lifecycleInput[1];
      continue;
    }
    const idempotency = /^--idempotency-key=(.+)$/.exec(arg);
    if (idempotency) {
      idempotencyKey = idempotency[1];
      continue;
    }
    if (arg === '--resume') {
      resumePaused = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: orchestrate-cli.js <project_id> <epic_id> [options]\n'
        + '  --concurrency=4\n'
        + '  --lifecycle-input=path/to/input.json\n'
        + '  --idempotency-key=stable-key\n'
        + '  --resume\n'
        + '\n'
        + 'SAGA_PRODUCT_LIFECYCLE_COMPOSITION is required (lifecycle is the only '
        + 'engine). Pass --lifecycle-input, set SAGA_PRODUCT_LIFECYCLE_INPUT '
        + '(path), or set SAGA_PRODUCT_LIFECYCLE_INPUT_JSON (inline JSON).\n',
      );
      process.exit(0);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    process.stderr.write(
      'Usage: orchestrate-cli.js <project_id> <epic_id> [--concurrency=4]\n',
    );
    process.exit(2);
  }
  const projectId = Number(positional[0]);
  const epicId = Number(positional[1]);
  if (!Number.isInteger(projectId) || projectId < 1) {
    process.stderr.write(`project_id must be a positive integer, got '${positional[0]}'\n`);
    process.exit(2);
  }
  if (!Number.isInteger(epicId) || epicId < 1) {
    process.stderr.write(`epic_id must be a positive integer, got '${positional[1]}'\n`);
    process.exit(2);
  }
  return {
    projectId,
    epicId,
    concurrency,
    lifecycleInputPath,
    idempotencyKey,
    resumePaused,
  };
}


function writeLifecycleStartReceipt(run: {
  id: number;
  status: string;
  createdAt: string;
}): void {
  const configured = process.env.SAGA_LIFECYCLE_START_RECEIPT?.trim();
  if (!configured) return;
  const receiptPath = path.resolve(configured);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      lifecycleRunId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      acknowledgedAt: new Date().toISOString(),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
  renameSync(temporaryPath, receiptPath);
}

async function main() {
  const {
    projectId,
    epicId,
    concurrency,
    lifecycleInputPath,
    idempotencyKey,
    resumePaused,
  } = parseArgs(process.argv);
  if (!process.env.DB_PATH) {
    process.stderr.write(
      'DB_PATH env var is required (path to the saga SQLite database).\n',
    );
    process.exit(2);
  }

  process.stdout.write(
    `[orchestrate-cli] starting project=${projectId} epic=${epicId} concurrency=${concurrency}\n`,
  );

  let application: SagaApplication | null = null;
  try {
    const overrides = await loadCompositionOverrides(projectId, epicId);
    // The lifecycle input may be supplied three ways. The preferred in-process
    // path is SAGA_PRODUCT_LIFECYCLE_INPUT_JSON: the parent (e.g. the tracker-
    // view "start from idea" route) assembles and validates the
    // ProductDeliveryLifecycleInput in its own memory and hands the JSON inline
    // to this child via env — no JSON file is written to disk and no
    // --lifecycle-input path is passed. The runtime's resolveInput re-validates
    // it (assertProductDeliveryLifecycleInput) before Discovery runs.
    const inlineLifecycleInputJson =
      process.env.SAGA_PRODUCT_LIFECYCLE_INPUT_JSON?.trim()
        ? process.env.SAGA_PRODUCT_LIFECYCLE_INPUT_JSON
        : null;
    const resolvedLifecycleInputPath = lifecycleInputPath
      ?? process.env.SAGA_PRODUCT_LIFECYCLE_INPUT
      ?? null;
    const lifecycleInput = inlineLifecycleInputJson !== null
      ? JSON.parse(inlineLifecycleInputJson) as unknown
      : resolvedLifecycleInputPath
        ? JSON.parse(
          readFileSync(path.resolve(resolvedLifecycleInputPath), 'utf8'),
        ) as unknown
        : undefined;
    application = createSaga2Application(process.env, overrides);
    const result = await application.runEpisode({
      projectId,
      epicId,
      concurrency,
      lifecycleInput,
      lifecycleInputSchema: lifecycleInput === undefined
        ? undefined
        : 'saga3.product-delivery-lifecycle-input.v2',
      idempotencyKey: idempotencyKey ?? undefined,
      resumePaused,
      initiatedBy: process.env.SAGA_INITIATED_BY ?? 'orchestrate-cli',
    });
    process.stdout.write(`[orchestrate-cli] done: ${JSON.stringify(result)}\n`);
    process.exit(result.reason === 'failed' ? 1 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[orchestrate-cli] fatal: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  } finally {
    try { application?.close(); } catch { /* best effort */ }
  }
}

interface ProductLifecycleCompositionModule {
  createProductLifecycleComposition?: (context: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    projectId: number;
    epicId: number;
  }) =>
    | ProductLifecycleCompositionOverrides
    | Promise<ProductLifecycleCompositionOverrides>;
  default?:
    | ProductLifecycleCompositionOverrides
    | ((context: {
      env: NodeJS.ProcessEnv;
      cwd: string;
      projectId: number;
      epicId: number;
    }) =>
      | ProductLifecycleCompositionOverrides
      | Promise<ProductLifecycleCompositionOverrides>);
}

async function loadCompositionOverrides(
  projectId: number,
  epicId: number,
): Promise<Saga2CompositionOverrides> {
  // saga4 cutover: the CLI always runs the Product Lifecycle runtime.
  // SAGA_PRODUCT_LIFECYCLE_COMPOSITION is mandatory.
  const repoRoot = path.resolve(process.env.SAGA_REPO_ROOT ?? process.cwd());
  const configuredPath = process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION;
  if (!configuredPath) {
    throw new Error(
      'SAGA_PRODUCT_LIFECYCLE_COMPOSITION_REQUIRED: the lifecycle runtime is '
      + 'the only engine; an explicit ESM module supplying real Delivery '
      + 'preflight, publication and observation providers is mandatory',
    );
  }
  const absolutePath = path.resolve(configuredPath);
  const loaded = await import(pathToFileURL(absolutePath).href) as
    ProductLifecycleCompositionModule;
  const exported =
    loaded.createProductLifecycleComposition ?? loaded.default;
  if (!exported) {
    throw new Error(
      `PRODUCT_LIFECYCLE_COMPOSITION_EXPORT_MISSING: ${absolutePath}`,
    );
  }
  const context = {
    env: process.env,
    cwd: process.cwd(),
    projectId,
    epicId,
  };
  const productLifecycle = typeof exported === 'function'
    ? await exported(context)
    : exported;
  if (!productLifecycle?.delivery) {
    throw new Error(
      `PRODUCT_LIFECYCLE_DELIVERY_COMPOSITION_MISSING: ${absolutePath}`,
    );
  }

  // W13-AUDIT §18.5/§18.9: install the 4 production modules into the durable
  // content-addressed package store ONCE before the runtime is constructed
  // (install is async I/O; createProductLifecycleRuntime stays synchronous).
  // The resulting ProductionInstallation is threaded through overrides so every
  // ProcessRun is pinned to an immutable packageDigest and the workspace
  // materializer resolves resources from pinned bytes. Idempotent across CLI
  // restarts (same DB + unchanged bytes → reuse active records).
  const packageInstallation = await installProductionModules(
    getDb(),
    repoRoot,
    process.env.SAGA_PACKAGE_STORE_DIR,
  );

  return {
    modulePackages: packageInstallation,
    productLifecycle: {
      ...productLifecycle,
      packageInstallation,
      onLifecycleStarted: writeLifecycleStartReceipt,
    },
  };
}

main().catch(err => {
  process.stderr.write(`[orchestrate-cli] unhandled: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
