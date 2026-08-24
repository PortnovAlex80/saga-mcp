// src/factory-e2e/fresh-harness.ts
//
// W9 finish-line HARNESS — a fresh, deterministic-friendly, scripted-inference
// driver for the production Factory runtime.
//
// What this module is:
//   A faithful IN-PROCESS re-host of the orchestrate-cli factory loop
//   (src/orchestrate-cli.ts) that substitutes ONLY worker inference via the
//   production `workerExecutorFactory` override seam. Everything else —
//   assignment (WorkAssignmentPort), desk provisioning, MCP authority, process
//   finalization, gates, CandidateSets, effects, lifecycle routing — stays on
//   the production implementations.
//
// Why in-process (not orchestrate-cli as a child):
//   The existing tests/factory-contract/golden-path.test.mjs drives
//   orchestrate-cli as a child process + replay capsules, which is FLAKY
//   (REPLAY_CAPSULE_CONTEXT_INVALID, child crash/recovery timing). This harness
//   removes that flakiness surface by driving the SAME production loop body
//   in-process with an in-process scripted executor. No orchestrate-cli child,
//   no scenario-dispatcher child, no replay-capsule base-commit matching.
//
// ADR-053 alignment — the harness CANNOT and DOES NOT:
//   - write to authority tables (factory_workplaces, factory_candidate_sets,
//     factory_gate_decisions, factory_accepted_authority_heads). bootstrapFresh
//     inserts ONLY configuration-surface rows (project/epic/repo/controls/
//     trusted_providers/factory_orders). Authority rows are created by the
//     production runtime during the drive.
//   - use recency/latest fallback or submission.task_id binding. Task identity
//     emerges from the accepted-authority head (readAuthorTaskId, ADR-053 C5).
//   - inject random faults. Crash points are named + deterministic (W9-03).
//
// If a caller would need any of the above to make a run converge, that is a
// BLOCKED exit (the harness must not paper over an authority defect).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createFactoryApplication,
  getLastFactoryEpisodeRuntimeRepository,
  getLastFactoryWorkAssignment,
  getLastFactoryWorkerExecutorFactory,
  type FactoryCompositionOverrides,
  type ProductLifecycleCompositionOverrides,
} from '../app/composition-root.js';
import { closeDb, getDb } from '../db.js';
import { distributeQueuedTasks } from '../app/dispatch-loop.js';
import { uuidIdGenerator } from '../infrastructure/conveyor/conveyor-adapters.js';
import {
  acquireFactoryLaunchController,
  assertFactoryControllerFence,
  finishFactoryLaunch,
  markFactoryLaunchRunning,
  renewFactoryControllerLease,
  requestFactoryLaunch,
} from '../infrastructure/factory/sqlite-factory-launch-repository.js';
import {
  installProductionModules,
  type ProductionInstallation,
} from '../process-modules/installation/production-install.js';
import { discoveryPackageManifest } from '../process-modules/modules/discovery/package/manifest.js';
import { formalizationPackageManifest } from '../process-modules/modules/formalization/package/manifest.js';
import { developmentPackageManifest } from '../process-modules/modules/development/package/manifest.js';
import { developmentContinuationPackageManifest } from '../process-modules/modules/development/package/continuation-manifest.js';
import { developmentVerificationContinuationPackageManifest } from '../process-modules/modules/development/package/verification-continuation-manifest.js';
import { deliveryPackageManifest } from '../process-modules/modules/delivery/package/manifest.js';
import { assembleProductLifecycleInput } from '../app/start-product-lifecycle-from-idea.js';
import { settleLaunchFromRunResult } from '../app/launch-terminal-settlement.js';
import type { OrchestrationRunResult } from '../application/ports/orchestration-engine.js';
import {
  assertProductDeliveryLifecycleInput,
} from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { lifecycleInputPolicyValidation } from '../infrastructure/process-modules/lifecycle-input-policy-validation.js';
import { ensureReplayCapsuleSchema } from '../infrastructure/replay/sqlite-replay-capsule-repository.js';
import { HARNESS_CONCURRENCY_CEILING } from './run-manifest.js';

/**
 * The lifecycle input schema the harness always uses (the production v2
 * product-delivery lifecycle input — same schema orchestrate-cli accepts).
 */
export const HARNESS_LIFECYCLE_INPUT_SCHEMA = 'factory.product-delivery-lifecycle-input.v2';

/**
 * Observer the test-side scripted executor exposes so the harness can report
 * the observed concurrency ceiling and scripted invocation count without the
 * harness depending on a specific executor implementation. Decoupled on
 * purpose: the harness knows the contract, not the double.
 */
export interface ScriptedInferenceObserver {
  /** High-water mark of concurrently-running scripted inferences. */
  readonly getMaxConcurrency: () => number;
  /** Total scripted inferences started so far. */
  readonly getInvocationCount: () => number;
}

/** Handle to a freshly-bootstrapped factory run (pre-drive). */
export interface FreshHarnessBootstrap {
  /** Absolute path to the clean per-run SQLite database. */
  readonly dbPath: string;
  /** Absolute path to the clean per-run git repository (real HEAD commit). */
  readonly repoPath: string;
  /**
   * Absolute path to the saga-mcp repository root (the harness host). Used to
   * resolve the MCP server entry (<sagaRepoRoot>/dist/index.js) for the worker
   * factory context and to install production module packages.
   */
  readonly sagaRepoRoot: string;
  readonly repoId: number;
  readonly projectRepositoryId: number;
  readonly projectId: number;
  readonly epicId: number;
  /** Real `git rev-parse HEAD` of the fresh repo's base commit. */
  readonly baseCommit: string;
  /** The validated production lifecycle input (from assembleProductLifecycleInput). */
  readonly lifecycleInput: unknown;
  readonly lifecycleInputSchema: string;
  /** Immutable installed workshop packages (single manifest digest). */
  readonly packageInstallation: ProductionInstallation;
  /** The factory launch ref, requested through the production launch API. */
  readonly launchRef: string;
  /**
   * Assert the harness made zero manual writes to authority tables between
   * bootstrap and the first drive cycle. The authority tables must be empty
   * at this point — every authority row is created by the production runtime.
   */
  readonly assertNoAuthorityWritesYet: () => void;
  /** Remove the per-run DB + repo. Safe to call once. */
  readonly cleanup: () => void;
}

/**
 * The authority tables the harness must NEVER write to directly. They are
 * created and mutated exclusively by the production runtime (workplace
 * coordinator, gate runner, acceptance coordinator, effects). This list is the
 * literal "no authority hacks" boundary from the W9 task card.
 */
export const AUTHORITY_TABLES = Object.freeze([
  'factory_workplaces',
  'factory_candidate_sets',
  'factory_gate_decisions',
  'factory_accepted_authority_heads',
]) as readonly string[];

function countRows(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return 0;
    throw error;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

/**
 * Provision a clean per-run git repository with one real initial commit.
 * The base commit is resolved via the REAL `git rev-parse HEAD` — never a zero
 * hash — exactly as the production assembler requires.
 */
function provisionFreshRepo(dir: string): { repoPath: string; baseCommit: string } {
  const repoPath = path.join(dir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), '# fresh-harness repo\n');
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name: 'fresh-harness-fixture',
    version: '1.0.0',
    scripts: { test: 'node test.js', start: 'node server.js' },
  }));
  writeFileSync(path.join(repoPath, 'test.js'), 'process.exit(0);\n');
  writeFileSync(path.join(repoPath, 'server.js'), [
    "const http=require('http');",
    "const port=Number(process.env.PORT);",
    "http.createServer((_q,r)=>r.end('ready')).listen(port,'127.0.0.1');",
  ].join('\n'));
  git(repoPath, 'init', '-q', '-b', 'dev');
  git(repoPath, 'config', 'user.email', 'harness@saga.local');
  git(repoPath, 'config', 'user.name', 'Fresh Harness');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'fresh-harness base');
  const baseCommit = git(repoPath, 'rev-parse', 'HEAD');
  return { repoPath, baseCommit };
}

export interface BootstrapFreshHarnessOptions {
  /**
   * Absolute path to the saga-mcp repository root (used by installProductionModules
   * to resolve packaged module resources against the immutable package store).
   */
  readonly repoRoot: string;
  /** The product idea; assembled into the lifecycle input via the production assembler. */
  readonly idea?: string;
  readonly projectId?: number;
  readonly epicId?: number;
  /** Per-run concurrency cap. Must be ≤ HARNESS_CONCURRENCY_CEILING (2). */
  readonly concurrencyCap?: number;
  /** Explicit temp dir; defaults to a fresh mkdtemp under os.tmpdir(). */
  readonly tempDir?: string;
  /** Override the production-assembled lifecycle input (W9-02 may use authorized delivery). */
  readonly lifecycleInput?: unknown;
  readonly lifecycleInputSchema?: string;
  /** Package store dir override ( forwarded to installProductionModules). */
  readonly packageStoreDir?: string;
}

/**
 * Bootstrap a FRESH factory run: clean per-run DB + clean per-run git repo,
 * configuration-surface rows only, validated production lifecycle input, and
 * the immutable installed workshop manifest. Emits NO authority rows.
 *
 * Production APIs used here:
 *   - assembleProductLifecycleInput (the tracker "start from idea" assembler)
 *   - assertProductDeliveryLifecycleInput (production validation)
 *   - installProductionModules (single installed workshop manifest + digest)
 *   - requestFactoryLaunch (durable launch request)
 */
export async function bootstrapFreshHarness(opts: BootstrapFreshHarnessOptions): Promise<FreshHarnessBootstrap> {
  const concurrencyCap = opts.concurrencyCap ?? HARNESS_CONCURRENCY_CEILING;
  if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1 || concurrencyCap > HARNESS_CONCURRENCY_CEILING) {
    throw new Error(
      `FRESH_HARNESS_CONCURRENCY_INVALID: concurrencyCap must be 1..${HARNESS_CONCURRENCY_CEILING}, got ${concurrencyCap}`,
    );
  }
  const dir = opts.tempDir ?? mkdtempSync(path.join(os.tmpdir(), 'saga-fresh-harness-'));
  const dbPath = path.join(dir, 'fresh-harness.db');
  const { repoPath, baseCommit } = provisionFreshRepo(dir);

  // The DB is a singleton keyed on process.env.DB_PATH. The harness owns the
  // process; set the path before any getDb() call.
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;

  const projectId = opts.projectId ?? 1;
  const epicId = opts.epicId ?? 1;
  let db: Database.Database;
  try {
    db = getDb();
    // ---- Configuration surface ONLY. No authority rows. ----
    db.prepare(
      `INSERT INTO projects (id,name,description,status,tags,metadata)
       VALUES (?, 'Fresh Harness Product','W9 fresh scripted E2E harness','active','[]','{}')`,
    ).run(projectId);
    db.prepare(
      `INSERT INTO epics (id,project_id,name,status,priority)
       VALUES (?, ?, 'Fresh Harness Pipeline','planned','high')`,
    ).run(epicId, projectId);
    // Operator cap and exact scripted-provider quota are independent inputs.
    db.prepare(
      `INSERT INTO lifecycle_execution_controls
         (epic_id,concurrency,model_provider,model_name,model_concurrency_limit)
       VALUES (?, ?,'test','scripted-fresh-harness',?)`,
    ).run(epicId, concurrencyCap, concurrencyCap);
    const repoInfo = db.prepare(
      `INSERT INTO repositories (name,default_branch,metadata)
       VALUES ('fresh-harness-repo','dev','{}')`,
    ).run();
    const repoId = Number(repoInfo.lastInsertRowid);
    const prInfo = db.prepare(
      `INSERT INTO project_repositories
         (project_id,repository_id,role,local_path,integration_branch,status)
       VALUES (?, ?, 'component', ?, 'dev', 'active')`,
    ).run(projectId, repoId, repoPath);
    const projectRepositoryId = Number(prInfo.lastInsertRowid);
    // Trusted deterministic-evidence + authoritative-state providers used by
    // settlement/release. These are provider REGISTRATIONS (configuration), not
    // authority rows; production settlement reads them at runtime.
    // The delivery rows carry EXPLICIT ids (9001/9002) pinned by the canonical
    // proof provider doubles (canonical-proof-composition.mjs) — same
    // convention as the temporal fixtures (fresh-db.mjs seeds 9101/9102).
    // resolveTrustedProvider matches id+name+category+version, so an unpinned
    // row resolves untrusted and production fails the release closed.
    db.prepare(
      `INSERT INTO trusted_providers
         (id,project_id,category,name,trust_basis,determinism,scope,layer,version,status)
       VALUES
         (9001, ?, 'deterministic_evidence','fresh-harness-preflight',
            'fresh harness deterministic fixture','full','fresh-harness','L0','1.0.0','active'),
         (9002, ?, 'authoritative_state','fresh-harness-deployment-state',
            'fresh harness authoritative fixture','partial','fresh-harness','L4','1.0.0','active'),
         (NULL, ?, 'deterministic_evidence','development.verification-product-contract.v2',
            'fresh harness verification provider','full','fresh-harness','L0','2.0.0','active')`,
    ).run(projectId, projectId, projectId);
    ensureReplayCapsuleSchema(db);

    // The authority tables must be EMPTY after bootstrap — the harness wrote
    // zero authority rows. (Asserted again via the returned handle.)
    for (const table of AUTHORITY_TABLES) {
      const n = countRows(db, table);
      if (n !== 0) {
        throw new Error(
          `FRESH_HARNESS_AUTHORITY_LEAK: bootstrap wrote ${n} row(s) to authority table '${table}' — the harness may not seed authority`,
        );
      }
    }

    // Build the lifecycle input via the PRODUCTION assembler (start-from-idea).
    // Produces a deferred-delivery input by default (no operator authorization
    // hack); W9-02 may override with an authorized input.
    const lifecycleInput = opts.lifecycleInput ?? assembleProductLifecycleInput({
      projectId,
      epicId,
      idea: opts.idea ?? 'Fresh scripted E2E harness: prove the production runtime with scripted inference only.',
      db,
    });
    assertProductDeliveryLifecycleInput(
      lifecycleInput,
      lifecycleInputPolicyValidation,
    );

    // Install the immutable workshop manifest (single digest for every process).
    const packageInstallation = await installProductionModules(
      db,
      opts.repoRoot,
      [
        discoveryPackageManifest,
        formalizationPackageManifest,
        developmentPackageManifest,
        developmentContinuationPackageManifest,
        developmentVerificationContinuationPackageManifest,
        deliveryPackageManifest,
      ],
      opts.packageStoreDir,
    );

    // Request the factory launch through the production launch API.
    const orderRef = `order-fresh-${randomUUID()}`;
    db.prepare(
      `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
       VALUES (?, ?, ?, 'idea_url','starting')`,
    ).run(orderRef, projectId, epicId);
    const launchRef = requestFactoryLaunch({
      orderRef,
      mode: 'new',
      projectId,
      epicId,
      initiatedBy: 'fresh-harness',
      idempotencyKey: `fresh-harness-${randomUUID()}`,
      concurrency: concurrencyCap,
      lifecycleInput,
      lifecycleInputSchema: opts.lifecycleInputSchema ?? HARNESS_LIFECYCLE_INPUT_SCHEMA,
    }, db);

    const handle: FreshHarnessBootstrap = {
      dbPath,
      repoPath,
      sagaRepoRoot: opts.repoRoot,
      repoId,
      projectRepositoryId,
      projectId,
      epicId,
      baseCommit,
      lifecycleInput,
      lifecycleInputSchema: opts.lifecycleInputSchema ?? HARNESS_LIFECYCLE_INPUT_SCHEMA,
      packageInstallation,
      launchRef,
      assertNoAuthorityWritesYet: () => {
        const live = getDb();
        for (const table of AUTHORITY_TABLES) {
          const n = countRows(live, table);
          if (n !== 0) {
            throw new Error(
              `FRESH_HARNESS_AUTHORITY_LEAK: authority table '${table}' has ${n} row(s) before the drive — bootstrap must not seed authority`,
            );
          }
        }
      },
      cleanup: () => {
        try { closeDb(); } catch { /* best effort */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        if (previousDbPath === undefined) {
          delete process.env.DB_PATH;
        } else {
          process.env.DB_PATH = previousDbPath;
        }
      },
    };
    return handle;
  } catch (error) {
    // Never leak a half-bootstrapped DB/process env.
    try { closeDb(); } catch { /* best effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (previousDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = previousDbPath;
    }
    throw error;
  }
}

/**
 * Request an ADDITIONAL factory launch on an already-bootstrapped harness DB
 * (W1-4: a NEW lifecycle on the SAME project/epic — the ADR-078 isolation
 * subject). Pure production API: requestFactoryLaunch on a fresh order row;
 * no authority writes. The caller drives the new launch via driveFreshHarness
 * with { launchRef }.
 */
export function requestFreshHarnessLaunch(
  bootstrap: FreshHarnessBootstrap,
  opts: { idea: string; lifecycleInputSchema?: string },
): string {
  const db = getDb();
  const lifecycleInput = assembleProductLifecycleInput({
    projectId: bootstrap.projectId,
    epicId: bootstrap.epicId,
    idea: opts.idea,
    db,
  });
  assertProductDeliveryLifecycleInput(lifecycleInput, lifecycleInputPolicyValidation);
  const orderRef = `order-fresh-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES (?, ?, ?, 'idea_url','starting')`,
  ).run(orderRef, bootstrap.projectId, bootstrap.epicId);
  return requestFactoryLaunch({
    orderRef,
    mode: 'new',
    projectId: bootstrap.projectId,
    epicId: bootstrap.epicId,
    initiatedBy: 'fresh-harness',
    idempotencyKey: `fresh-harness-${randomUUID()}`,
    concurrency: 2,
    lifecycleInput,
    lifecycleInputSchema: opts.lifecycleInputSchema ?? HARNESS_LIFECYCLE_INPUT_SCHEMA,
  }, db);
}

// ---------------------------------------------------------------------------
// Drive loop — in-process, bounded, production-faithful.
// ---------------------------------------------------------------------------

export interface DriveFreshHarnessOptions {
  readonly bootstrap: FreshHarnessBootstrap;
  /**
   * Drive THIS launch instead of the bootstrap's own (W1-4: an additional
   * launch requested via requestFreshHarnessLaunch on the same DB/epic).
   */
  readonly launchRef?: string;
  /**
   * Product lifecycle composition carrying the SCRIPTED workerExecutorFactory
   * (inference substitution) + explicit Delivery providers. Factory authority,
   * gates, CandidateSets, effects and lifecycle routing stay production.
   */
  readonly composition: ProductLifecycleCompositionOverrides;
  /** Per-scenario concurrency cap (≤ HARNESS_CONCURRENCY_CEILING). */
  readonly scenarioConcurrencyCap: number;
  /** Hard ceiling on runEpisode/dispatch cycles. Default 6. */
  readonly maxCycles?: number;
  /** Per-worker poll interval in the dispatch loop. Default 10ms (fast + deterministic). */
  readonly pollMs?: number;
  /** Empty-dispatch streak before stopping. Default 2. */
  readonly maxEmptyDispatchStreak?: number;
  /**
   * Stop driving as soon as the launch's lifecycle has ANY stage run with
   * this local_outcome (e.g. 'formalized' for W1-4, where the proof scope is
   * the Formalization stage and the lifecycle would otherwise continue into
   * Development). The stop is reported via stoppedByStageOutcome.
   */
  readonly stopOnStageOutcome?: string;
  /** Optional scripted-executor observer for reporting max concurrency + invocations. */
  readonly scriptedObserver?: ScriptedInferenceObserver;
}

export interface HarnessDriveResult {
  readonly cycles: number;
  readonly terminalReason: string;
  readonly finalStage: string | null;
  readonly lifecycleRunId: number | null;
  readonly effectiveConcurrency: number;
  /** High-water concurrent scripted inferences observed (via observer). */
  readonly maxObservedConcurrency: number;
  readonly scriptedInvocationCount: number;
  /** Worker executions still active at exit (must be 0 for a clean run). */
  readonly strandedActiveExecutions: number;
  /** True if the lifecycle reached a terminal state (completed/failed/stopped). */
  readonly reachedTerminal: boolean;
  /** Whether the drive stopped because maxCycles was hit (not a regression). */
  readonly stoppedByCycleBound: boolean;
  /** Whether the drive stopped because stopOnStageOutcome was observed. */
  readonly stoppedByStageOutcome: boolean;
}

/**
 * Drive the factory run IN-PROCESS: createFactoryApplication → controller
 * lease → runEpisode/distribute loop, bounded by maxCycles. This is the same
 * loop body as orchestrate-cli, minus the child-process boundary and the
 * replay-capsule machinery. Substitutes ONLY the worker inference via the
 * composition's workerExecutorFactory seam.
 */
export async function driveFreshHarness(opts: DriveFreshHarnessOptions): Promise<HarnessDriveResult> {
  const { bootstrap, composition } = opts;
  const maxCycles = opts.maxCycles ?? 6;
  const pollMs = opts.pollMs ?? 10;
  const maxEmptyDispatchStreak = opts.maxEmptyDispatchStreak ?? 2;

  // The production composition root. modulePackages + productLifecycle carry
  // the pinned workshop manifest + the scripted workerExecutorFactory.
  // Mirrors orchestrate-cli's loadCompositionOverrides: the scripted
  // workerExecutorFactory is LIFTED from productLifecycle to the top-level
  // override so createFactoryApplication uses it instead of constructing the
  // real Claude worker factory. Without this lift the real factory wins and the
  // harness would spawn Claude — the opposite of scripted inference.
  const overrides: FactoryCompositionOverrides = {
    modulePackages: bootstrap.packageInstallation,
    productLifecycle: {
      ...composition,
      packageInstallation: bootstrap.packageInstallation,
    },
    executionRouteResolverOptions: {},
    // The harness — NOT the application — owns the per-run DB lifecycle.
    // application.close() defaults to closeDb (the global singleton), which
    // would close the DB mid-test when multiple drives share a process. The
    // bootstrap.cleanup() handle is the sole closer; a no-op here prevents the
    // application from closing the global DB out from under a subsequent drive.
    close: () => { /* DB lifecycle owned by bootstrap.cleanup() */ },
    ...(composition.workerExecutorFactory
      ? { workerExecutorFactory: composition.workerExecutorFactory }
      : {}),
    // K2 strict seam: when the composition carries workerSpawn (and NO
    // in-process workerExecutorFactory), lift it too so createFactoryApplication
    // builds the production pinned worker factory with the spawned-child
    // substitution at the physical-executable seam only.
    ...(composition.workerSpawn && !composition.workerExecutorFactory
      ? { workerSpawn: composition.workerSpawn }
      : {}),
  };
  // The scripted executor replaces inference; the production Claude path is
  // never constructed (overrides.workerExecutorFactory / composition.workerExec
  // is the canonical substitution seam — Factory Contract Harness §8.9).
  const application = createFactoryApplication(process.env, overrides);
  const episodeRuntime = getLastFactoryEpisodeRuntimeRepository();
  if (!episodeRuntime) {
    throw new Error('FRESH_HARNESS_EPISODE_RUNTIME_MISSING: composition-root did not publish the episode runtime');
  }

  const claimToken = randomUUID();
  const driveLaunchRef = opts.launchRef ?? bootstrap.launchRef;
  const ticket = acquireFactoryLaunchController(driveLaunchRef, claimToken);
  const controllerEpoch = ticket.controllerEpoch!;
  let controllerFenceLost: Error | null = null;
  const heartbeat = setInterval(() => {
    try {
      renewFactoryControllerLease(driveLaunchRef, claimToken, controllerEpoch);
    } catch (error) {
      controllerFenceLost = error instanceof Error ? error : new Error(String(error));
    }
  }, 5_000);
  heartbeat.unref();

  const idempotencyKey = ticket.idempotencyKey;
  // A resume launch carries its own idempotency key, but the pinned
  // LifecycleRun input is durable under the ORIGINAL run's key — the engine
  // pattern (engine-administration): resolve the resumable run and pass ITS
  // key so resolveInput finds the persisted input snapshot.
  const runIdempotencyKey = ticket.mode === 'resume' && ticket.lifecycleRunId !== null
    ? (getDb().prepare(
        'SELECT idempotency_key AS key FROM factory_lifecycle_runs WHERE id=?',
      ).get(ticket.lifecycleRunId) as { key: string } | undefined)?.key ?? idempotencyKey
    : idempotencyKey;
  const initiatedBy = ticket.initiatedBy;
  // A RESUME launch (mode='resume', no lifecycle_input on the request) continues
  // the existing paused lifecycle run: the engine pattern from
  // engine-administration — resumePaused from the FIRST cycle and no
  // lifecycleInput (passing the original input would collide with the active
  // scope guard, LIFECYCLE_SCOPE_ALREADY_ACTIVE).
  const isResumeDrive = ticket.mode === 'resume';
  const lifecycleInput = isResumeDrive ? undefined
    : ticket.lifecycleInput ?? bootstrap.lifecycleInput;
  const lifecycleInputSchema = isResumeDrive ? undefined
    : ticket.lifecycleInputSchema ?? bootstrap.lifecycleInputSchema;

  let cycles = 0;
  let lastReason = 'unknown';
  let lastStage = '';
  let lastResult: OrchestrationRunResult | null = null;
  let lifecycleRunId: number | null = null;
  let stoppedByCycleBound = false;
  let stoppedByStageOutcome = false;
  let emptyDispatchStreak = 0;

  try {
    let isFirstCycle = true;
    while (cycles < maxCycles) {
      if (controllerFenceLost) throw controllerFenceLost;
      assertFactoryControllerFence(driveLaunchRef, claimToken, controllerEpoch);
      const admission = episodeRuntime.readConcurrencyAdmission(bootstrap.epicId);
      const result = await application.runEpisode({
        projectId: bootstrap.projectId,
        epicId: bootstrap.epicId,
        concurrency: admission.effectiveConcurrency,
        lifecycleInput: isFirstCycle && !isResumeDrive ? lifecycleInput : undefined,
        lifecycleInputSchema: isFirstCycle && !isResumeDrive && lifecycleInput !== undefined
          ? lifecycleInputSchema ?? undefined
          : undefined,
        idempotencyKey: runIdempotencyKey,
        resumePaused: !isFirstCycle || isResumeDrive,
        initiatedBy,
      });
      cycles += 1;
      isFirstCycle = false;
      lastResult = result;
      lastReason = result.reason;
      lastStage = result.finalStage;
      if (result.lifecycleRun?.id) {
        lifecycleRunId = result.lifecycleRun.id;
        markFactoryLaunchRunning(driveLaunchRef, claimToken, result.lifecycleRun.id);
      }
      if (opts.stopOnStageOutcome && result.lifecycleRun?.id && getDb().prepare(
        `SELECT 1 FROM factory_stage_runs WHERE lifecycle_run_id=? AND local_outcome=? LIMIT 1`,
      ).get(result.lifecycleRun.id, opts.stopOnStageOutcome)) {
        stoppedByStageOutcome = true;
        break;
      }
      if (result.reason !== 'paused') break;

      // Paused — drain queued kanban tasks through the SAME production
      // WorkAssignmentPort + WorkerExecutorFactory the composition root built.
      const workAssignment = getLastFactoryWorkAssignment();
      const workerExecutorFactory = getLastFactoryWorkerExecutorFactory();
      if (!workAssignment || !workerExecutorFactory) {
        throw new Error(
          'FRESH_HARNESS_ASSIGNMENT_UNAVAILABLE: composition-root did not publish the shared WorkAssignmentPort/WorkerExecutorFactory',
        );
      }
      const workspaceRoot = bootstrap.repoPath;
      const dispatched = await distributeQueuedTasks({
        projectId: bootstrap.projectId,
        epicId: bootstrap.epicId,
        readConcurrencyAdmission: () => episodeRuntime.readConcurrencyAdmission(bootstrap.epicId),
        // Mirrors orchestrate-cli: when the kernel owns rightward Kanban work
        // (repair_wait / verifying / effect_pending), dispatch MUST yield — the
        // ProductionCellNodeExecutor drives those transitions on the next
        // runEpisode, not via a re-dispatch. Without this, a crashed worker
        // whose card returns to 'todo' would be re-dispatched in a tight loop.
        shouldYieldToKernel: () => Boolean(getDb().prepare(
          `SELECT 1
             FROM factory_workplaces w
             JOIN factory_process_runs pr ON pr.id=w.process_run_id
            WHERE pr.epic_id=?
              AND pr.status IN ('running','paused')
              AND w.loop_state IN ('repair_wait','verifying','effect_pending')
            LIMIT 1`,
        ).get(bootstrap.epicId)),
        workAssignment,
        workerExecutorFactory,
        idGenerator: uuidIdGenerator,
        machineId: os.hostname(),
        pollMs,
        factoryContext: {
          projectId: bootstrap.projectId,
          epicId: bootstrap.epicId,
          workspaceRoot,
          dbPath: bootstrap.dbPath,
          sagaEntry: path.resolve(bootstrap.sagaRepoRoot, 'dist/index.js'),
          sagaSkillRoot: bootstrap.repoPath,
          lmStudioUrl: process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1',
        },
      });
      if (dispatched === 0) {
        emptyDispatchStreak += 1;
        if (emptyDispatchStreak >= maxEmptyDispatchStreak) break;
      } else {
        emptyDispatchStreak = 0;
      }
    }
    if (cycles >= maxCycles && lastReason === 'paused') {
      stoppedByCycleBound = true;
    }
  } finally {
    clearInterval(heartbeat);
    try { application.close(); } catch { /* best effort */ }
  }

  const finalAdmission = episodeRuntime.readConcurrencyAdmission(bootstrap.epicId);
  const stranded = (
    getDb().prepare(
      `SELECT COUNT(*) AS n FROM worker_executions
        WHERE project_id=? AND epic_id=?
          AND state IN ('reserved','running','cancel_requested')`,
    ).get(bootstrap.projectId, bootstrap.epicId) as { n: number }
  ).n;

  // CC-GAP-2: the drive settles its launch through the SAME pure settlement
  // projection as orchestrate-cli (settleLaunchFromRunResult) — one mapping,
  // not two divergent copies. Operational mapping is unchanged; the verdict
  // channels ride along on the returned settlement for callers that project
  // them (reachedTerminal stays the operational fact it always was).
  const isTerminal = lastReason !== 'paused';
  try {
    const settlement = lastResult !== null
      ? settleLaunchFromRunResult(lastResult)
      : null;
    finishFactoryLaunch(
      driveLaunchRef,
      claimToken,
      settlement ? settlement.launchState : 'paused',
      settlement ? settlement.launchError : null,
      settlement ? settlement.orderState : 'paused',
    );
  } catch {
    /* finishing the launch is best-effort at drive end */
  }

  return {
    cycles,
    terminalReason: lastReason,
    finalStage: lastStage,
    lifecycleRunId,
    effectiveConcurrency: finalAdmission.effectiveConcurrency,
    maxObservedConcurrency: opts.scriptedObserver?.getMaxConcurrency() ?? 0,
    scriptedInvocationCount: opts.scriptedObserver?.getInvocationCount() ?? 0,
    strandedActiveExecutions: stranded,
    reachedTerminal: isTerminal,
    stoppedByCycleBound,
    stoppedByStageOutcome,
  };
}
