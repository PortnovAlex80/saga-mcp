#!/usr/bin/env node
/**
 * Canonical Factory Start/Resume operator entrypoint.
 *
 * This is the ONE public CLI for driving the Factory. Both `start` and `resume`
 * go through the same durable machine via `requestFactoryLaunch` — no manual
 * orchestration-table writes, no SQL hacks. The launch state machine owns:
 *
 *   requested → claimed → running → completed|failed
 *
 * Usage:
 *   node scripts/factory.mjs start  <db-path> <idea-text> [--model <name>] [--sandbox <dir>]
 *   node scripts/factory.mjs resume <db-path> [--requeue-paused|--recover-failed-gate]
 *
 * `start` provisions a sandbox (project + epic + repo + order), creates a
 * `mode:'new'` launch, and spawns orchestrate-cli.
 *
 * `resume` finds the single resumable lifecycle run for the DB, creates a
 * `mode:'resume'` launch bound to that run's idempotency key, and spawns
 * orchestrate-cli. The lifecycle runtime rehydrates input from the durable
 * LifecycleRun snapshot — no lifecycleInput is passed.
 *
 * Environment:
 *   DB_PATH              — path to the saga SQLite database (also arg 1)
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION — optional override; the canonical
 *                                      tracker composition is the default
 *   SAGA_CLAUDE_PATH     — Claude CLI binary path (optional, for workers)
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FACTORY_CONCURRENCY,
  DEFAULT_FACTORY_MODEL,
  effectiveFactoryConcurrency,
  factoryModelProfile,
} from '../dist/runtime/factory-model-profiles.js';

const args = process.argv.slice(2);
const command = args[0];

function die(msg) {
  process.stderr.write(`factory: ${msg}\n`);
  process.exit(2);
}

/**
 * Parse start arguments structurally. Control-plane option values must never
 * leak into the product idea: replay semantic identity is derived from business
 * input, not from model/sandbox/operator coordinates.
 */
function parseStartArguments(rawArgs) {
  const dbPath = rawArgs[1];
  const ideaParts = [];
  let modelName = DEFAULT_FACTORY_MODEL;
  let sandboxName = null;

  for (let i = 2; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--model' || arg === '--sandbox') {
      const value = rawArgs[i + 1];
      if (!value || value.startsWith('--')) {
        die(`start: ${arg} requires a value`);
      }
      if (arg === '--model') modelName = value;
      else sandboxName = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      die(`start: unsupported option '${arg}'`);
    }
    ideaParts.push(arg);
  }

  return {
    dbPath,
    idea: ideaParts.join(' ').trim(),
    modelName,
    sandboxName,
  };
}

if (command !== 'start' && command !== 'resume' && command !== 'continue') {
  die(`usage: node scripts/factory.mjs <start|resume|continue> <db-path> [options]\n`
    + `  start  <db-path> <idea-text> [--model <name>] [--sandbox <dir>]\n`
    + `  resume <db-path> [--requeue-paused|--recover-failed-gate]\n`
    + `  continue <db-path> --from-lifecycle <id> (--local-release | --verification-only | --adopt-task <id> --scope <path>...) [--check]`);
}

function resolveFactoryComposition() {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(join(here, '..', '..'));
  const configured = process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION;
  const compositionPath = resolve(
    configured && configured.trim() !== ''
      ? configured
      : join(repoRoot, 'tracker-view', 'product-delivery-composition.mjs'),
  );
  if (!existsSync(compositionPath)) {
    die(
      `production lifecycle composition not found at ${compositionPath}; `
      + 'set SAGA_PRODUCT_LIFECYCLE_COMPOSITION to an existing ESM composition module',
    );
  }
  return compositionPath;
}

// Preflight before any FactoryOrder/Launch/recovery mutation. The operator
// script owns a production-safe default and still permits an explicit override.
const factoryCompositionPath = resolveFactoryComposition();

// ─── Shared: spawn the runtime host with a launch capability ──────────────
function spawnOrchestrateCli(dbPath, launchRef, compositionPath = factoryCompositionPath) {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(join(here, '..', '..'));
  const cliPath = join(repoRoot, 'dist', 'orchestrate-cli.js');
  if (!existsSync(cliPath)) {
    die(`orchestrate-cli.js not found at ${cliPath} — run 'npm run build' first`);
  }
  const childEnv = {
    ...process.env,
    DB_PATH: dbPath,
    SAGA_PRODUCT_LIFECYCLE_COMPOSITION: compositionPath,
  };
  // Spawn detached so the factory outlives this script. stdio inherited so
  // the operator sees cycle/dispatch output in real time.
  const child = spawn('node', [cliPath, `--launch-ref=${launchRef}`], {
    stdio: 'inherit',
    env: childEnv,
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + 1 : 1));
  });
}

function parseConcurrency(value, fallback = DEFAULT_FACTORY_CONCURRENCY) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    die(`SAGA_FACTORY_CONCURRENCY must be an integer 1..10, got '${value}'`);
  }
  return parsed;
}

function resumeConcurrency(db, epicId) {
  const row = db.prepare(
    `SELECT concurrency, model_provider, model_name, model_concurrency_limit
       FROM lifecycle_execution_controls WHERE epic_id=?`,
  ).get(epicId);
  if (!row) {
    die(`resume: missing lifecycle_execution_controls for epic ${epicId}`);
  }
  const requested = parseConcurrency(
    process.env.SAGA_FACTORY_CONCURRENCY,
    row.concurrency,
  );
  const canonicalProfile = factoryModelProfile(row.model_name);
  const modelLimit = canonicalProfile?.limit ?? row.model_concurrency_limit;
  if (canonicalProfile) {
    db.prepare(
      `UPDATE lifecycle_execution_controls
          SET model_provider=?, model_concurrency_limit=?, updated_at=datetime('now')
        WHERE epic_id=?
          AND (model_provider<>? OR model_concurrency_limit<>?)`,
    ).run(
      canonicalProfile.provider,
      canonicalProfile.limit,
      epicId,
      canonicalProfile.provider,
      canonicalProfile.limit,
    );
  }
  return effectiveFactoryConcurrency(requested, modelLimit);
}

function parseContinueArguments(rawArgs) {
  const result = {
    dbPath: rawArgs[1],
    parentLifecycleRunId: null,
    adoptedTaskId: null,
    scopes: [],
    check: false,
    verificationOnly: false,
    observerConfirmed: false,
    localRelease: false,
  };
  for (let index = 2; index < rawArgs.length; index += 1) {
    const option = rawArgs[index];
    if (option === '--check') {
      result.check = true;
      continue;
    }
    if (option === '--verification-only') {
      result.verificationOnly = true;
      continue;
    }
    if (option === '--observer-confirmed') {
      result.observerConfirmed = true;
      continue;
    }
    if (option === '--local-release') {
      result.localRelease = true;
      continue;
    }
    if (['--from-lifecycle', '--adopt-task', '--scope'].includes(option)) {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith('--')) die(`continue: ${option} requires a value`);
      if (option === '--from-lifecycle') result.parentLifecycleRunId = Number(value);
      else if (option === '--adopt-task') result.adoptedTaskId = Number(value);
      else result.scopes.push(value);
      index += 1;
      continue;
    }
    die(`continue: unsupported option '${option}'`);
  }
  if (!result.dbPath) die('continue: db-path argument is required');
  if (!Number.isSafeInteger(result.parentLifecycleRunId) || result.parentLifecycleRunId < 1) {
    die('continue: --from-lifecycle must be a positive integer');
  }
  if (!result.verificationOnly && !result.localRelease && (!Number.isSafeInteger(result.adoptedTaskId) || result.adoptedTaskId < 1)) {
    die('continue: --adopt-task must be a positive integer');
  }
  if (!result.verificationOnly && !result.localRelease && result.scopes.length === 0) die('continue: at least one --scope is required');
  if (result.localRelease && (result.verificationOnly || result.adoptedTaskId || result.scopes.length > 0)) {
    die('continue: --local-release is mutually exclusive with Development continuation options');
  }
  if (result.observerConfirmed && !result.verificationOnly) {
    die('continue: --observer-confirmed requires --verification-only');
  }
  return result;
}

// ─── continue: append-only suffix after a terminal downstream failure ─────
if (command === 'continue') {
  const input = parseContinueArguments(args);
  const absoluteDbPath = resolve(input.dbPath);
  if (!existsSync(absoluteDbPath)) die(`continue: DB not found: ${absoluteDbPath}`);
  let workingDbPath = absoluteDbPath;
  let temporaryRoot = null;
  if (input.check) {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'saga-continuation-check-'));
    workingDbPath = join(temporaryRoot, 'factory.sqlite');
    const source = new Database(absoluteDbPath, { readonly: true });
    await source.backup(workingDbPath);
    source.close();
  } else {
    const backupRoot = join(resolve(absoluteDbPath, '..'), '.factory-backups');
    mkdirSync(backupRoot, { recursive: true });
    const backupPath = join(
      backupRoot,
      `pre-continuation-${new Date().toISOString().replaceAll(':', '-')}.sqlite`,
    );
    const source = new Database(absoluteDbPath, { readonly: true });
    await source.backup(backupPath);
    source.close();
    process.stdout.write(`[factory] continuation backup=${backupPath}\n`);
  }
  let continuationDb = null;
  try {
    const db = new Database(workingDbPath);
    continuationDb = db;
    db.pragma('foreign_keys=ON');
    const { SCHEMA_SQL, migrateFactorySchemaV3ToV4 } = await import('../dist/schema.js');
    db.exec(SCHEMA_SQL);
    migrateFactorySchemaV3ToV4(db);
    const parent = db.prepare(
      `SELECT fo.order_ref
         FROM factory_orders fo
         JOIN factory_order_runs chain ON chain.order_ref=fo.order_ref
        WHERE chain.lifecycle_run_id=?`,
    ).get(input.parentLifecycleRunId);
    if (!parent?.order_ref) {
      db.close();
      die(`continue: lifecycle ${input.parentLifecycleRunId} has no root FactoryOrder`);
    }
    const prepared = input.localRelease
      ? (await import('../dist/app/factory-release-continuation.js'))
        .prepareLocalReleaseContinuation(db, {
          orderRef: parent.order_ref,
          parentLifecycleRunId: input.parentLifecycleRunId,
          actorId: 'product-owner:user',
          reason: 'operator approved exact local source-tag release',
        })
      : (await import('../dist/app/factory-continuation.js'))
        .prepareDevelopmentContinuation(db, {
          orderRef: parent.order_ref,
          parentLifecycleRunId: input.parentLifecycleRunId,
          adoptedTaskId: input.adoptedTaskId,
          remainingChangeScopes: input.scopes,
          verificationOnly: input.verificationOnly,
          observerConfirmation: input.observerConfirmed ? {
            observerId: 'product-owner:user',
            statement: 'Product owner explicitly confirmed all described manual, visual, keyboard and screen-reader checks as verified in the operator conversation.',
          } : undefined,
          actorId: 'factory-continuation-operator',
          reason: 'append-only authority-complete Development incident recovery',
        });
    if (input.check) {
      process.stdout.write(`[factory] continuation check: ${JSON.stringify(prepared)}\n`);
      db.close();
      continuationDb = null;
      process.exitCode = 0;
    } else {
      const { requestFactoryLaunch } = await import(
        '../dist/infrastructure/factory/sqlite-factory-launch-repository.js'
      );
      const concurrency = resumeConcurrency(db, prepared.epicId);
      const launchRef = requestFactoryLaunch({
        orderRef: prepared.orderRef,
        mode: 'resume',
        projectId: prepared.projectId,
        epicId: prepared.epicId,
        lifecycleRunId: prepared.childLifecycleRunId,
        initiatedBy: 'factory-continuation-operator',
        idempotencyKey: `${prepared.childIdempotencyKey}:launch`,
        concurrency,
      }, db);
      db.close();
      continuationDb = null;
      process.stdout.write(
        `[factory] continuation launch=${launchRef} child=${prepared.childLifecycleRunId} db=${absoluteDbPath}\n`,
      );
      const localComposition = resolve(join(
        fileURLToPath(import.meta.url), '..', '..',
        'tracker-view', 'product-delivery-local-release-composition.mjs',
      ));
      spawnOrchestrateCli(
        absoluteDbPath,
        launchRef,
        input.localRelease ? localComposition : factoryCompositionPath,
      );
    }
  } finally {
    if (continuationDb) {
      try { continuationDb.close(); } catch { /* preserve the primary failure */ }
    }
    if (temporaryRoot) {
      try {
        rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        process.stderr.write(
          `[factory] continuation check cleanup deferred for ${temporaryRoot}: `
          + `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      }
    }
  }
}

/**
 * Runs the declared node validator once for an old paused incident that
 * predates durable rejection receipts. The resulting admin observation uses
 * the same append-only ledger/feedback path as managed worker rejections.
 */
async function ensurePausedRecoveryFeedback(db, lifecycleRunId) {
  const task = db.prepare(
    `SELECT t.*, e.project_id
       FROM factory_lifecycle_runs lr
       JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
       JOIN factory_workplaces w ON w.process_run_id=sr.process_run_id
       JOIN tasks t ON t.workplace_ref=w.workplace_ref
       JOIN epics e ON e.id=t.epic_id
      WHERE lr.id=? AND lr.status='paused' AND sr.status='paused'
        AND w.kanban_phase='blocked' AND w.loop_state='paused'`,
  ).get(lifecycleRunId);
  if (!task) die(`resume: no unique blocked/paused task for lifecycle ${lifecycleRunId}`);
  const metadata = JSON.parse(task.metadata || '{}');
  if (metadata.recovery_feedback?.schemaVersion === 'factory.submission-validation-recovery-feedback.v1') {
    return;
  }
  const execution = db.prepare(
    `SELECT execution_id FROM worker_executions
      WHERE task_id=? AND state NOT IN ('reserved','running','cancel_requested')
      ORDER BY reserved_at DESC LIMIT 1`,
  ).get(task.id);
  if (!execution?.execution_id) {
    die(`resume: task ${task.id} has no terminal execution to bind operator preflight`);
  }
  const {
    initSubmissionRegistries,
    getSubmissionPolicyRegistry,
    getSubmissionValidatorRegistry,
  } = await import('../dist/process-modules/application/submission-registries.js');
  const { persistSubmissionValidationRejection } = await import(
    '../dist/lifecycle/submission-validation-rejections.js'
  );
  initSubmissionRegistries(db);
  const policy = getSubmissionPolicyRegistry()?.resolve(
    metadata.process_module_ref,
    metadata.process_node_id,
  );
  if (!policy || policy.mode !== 'required') {
    die(`resume: paused node ${metadata.process_node_id} has no required submission validator`);
  }
  const validator = getSubmissionValidatorRegistry()?.resolve(policy.validatorId);
  if (!validator) die(`resume: validator ${policy.validatorId} is unavailable`);
  const validation = validator.validate({
    processRunId: metadata.process_run_id,
    moduleRef: metadata.process_module_ref,
    nodeId: metadata.process_node_id,
    executionId: execution.execution_id,
    taskId: task.id,
    epicId: task.epic_id,
    projectId: task.project_id,
    contractRef: policy.contractRef,
  });
  if (validation.accepted) {
    die(`resume: current output for task ${task.id} now validates; refusing to manufacture repair feedback`);
  }
  db.transaction(() => persistSubmissionValidationRejection(db, {
    validatorId: validator.validatorId,
    validatorVersion: validator.validatorVersion,
    processRunId: metadata.process_run_id,
    moduleRef: metadata.process_module_ref,
    nodeId: metadata.process_node_id,
    executionId: execution.execution_id,
    taskId: task.id,
    actorKind: 'admin',
    rejectionCode: validation.code,
    gaps: validation.gaps,
    details: validation.details,
    contractRef: policy.contractRef,
    inputSnapshotHash: metadata.process_node_input_hash ?? metadata.process_input_hash ?? '',
  }))();
}

// ─── resume: continue an existing durable lifecycle run ───────────────────
if (command === 'resume') {
  const dbPath = args[1];
  if (!dbPath) die('resume: db-path argument is required');
  const resumeOptions = new Set(args.slice(2));
  for (const option of resumeOptions) {
    if (
      option !== '--requeue-paused'
      && option !== '--recover-failed-gate'
      && option !== '--recover-missing-product'
      && option !== '--recover-orphaned-launch'
    ) {
      die(`resume: unsupported option '${option}'`);
    }
  }
  if ([
    '--requeue-paused',
    '--recover-failed-gate',
    '--recover-missing-product',
    '--recover-orphaned-launch',
  ].filter(option => resumeOptions.has(option)).length > 1) {
    die('resume: recovery options are mutually exclusive');
  }

  const {
    recoverFailedGateRun,
    recoverMissingProductionCellProduct,
    recoverOrphanedFactoryLaunch,
    resolveFactoryResumeTarget,
    resumePausedSubmissionWorkplace,
  } = await import('../dist/app/factory-start.js');
  const { SCHEMA_SQL } = await import('../dist/schema.js');
  const { requestFactoryLaunch } = await import('../dist/infrastructure/factory/sqlite-factory-launch-repository.js');

  const db = new Database(dbPath);
  let launchRef;
  try {
    // Apply additive runtime tables before any recovery/launch operation.
    db.exec(SCHEMA_SQL);
    if (resumeOptions.has('--recover-failed-gate')) {
      const { formalizationProcessModule } = await import(
        '../dist/process-modules/modules/formalization/formalization-process-module.js'
      );
      const architectureNode = formalizationProcessModule.flow.nodes.find(
        node => node.id === 'define-architecture-contract',
      );
      const replacementCheckPlan = architectureNode?.cellDefinition?.authorGate?.checkPlan;
      if (!replacementCheckPlan) {
        die('resume: canonical architecture author CheckPlan is unavailable');
      }
      const recovery = recoverFailedGateRun(db, {
        projectId: 1,
        replacementCheckPlan,
        actorId: 'factory-resume-operator',
        reason: 'replace legacy provider plan and replay sealed CandidateSet gate',
      });
      process.stdout.write(
        `[factory] failed-gate recovery=${recovery.authorizationRef} `
        + `candidate=${recovery.candidateSetRef} `
        + `abandoned-gate=${recovery.abandonedGateRunRef} `
        + `replacement-plan=${recovery.replacementCheckPlanDigest} `
        + `replayed=${recovery.replayed}\n`,
      );
    }
    const target = resolveFactoryResumeTarget(db, 1); // sandbox projects use id=1
    const concurrency = resumeConcurrency(db, target.epicId);
    if (resumeOptions.has('--recover-missing-product')) {
      const recovery = recoverMissingProductionCellProduct(db, {
        lifecycleRunId: target.lifecycleRunId,
        expectedSchema: 'factory.source-change-candidate.v1',
        actorId: 'factory-resume-operator',
        reason: 'recover false worker_done without a typed Production Cell product',
      });
      process.stdout.write(
        `[factory] missing-product recovery=${recovery.authorizationRef} `
        + `rejection=${recovery.rejectionRef} task=${recovery.taskId} `
        + `abandoned-launch=${recovery.abandonedLaunchRef ?? 'none'} `
        + `revision=${recovery.resultingRevision} replayed=${recovery.replayed}\n`,
      );
    }
    if (resumeOptions.has('--recover-orphaned-launch')) {
      const recovery = recoverOrphanedFactoryLaunch(db, {
        lifecycleRunId: target.lifecycleRunId,
        actorId: 'factory-resume-operator',
        reason: 'close controller launch after supervised worker loss',
      });
      process.stdout.write(
        `[factory] orphaned-launch recovery=${recovery.recoveryRef} `
        + `launch=${recovery.launchRef} execution=${recovery.executionId} `
        + `replayed=${recovery.replayed}\n`,
      );
    }
    if (resumeOptions.has('--requeue-paused')) {
      await ensurePausedRecoveryFeedback(db, target.lifecycleRunId);
      const recovery = resumePausedSubmissionWorkplace(db, {
        lifecycleRunId: target.lifecycleRunId,
        actorId: 'factory-resume-operator',
        reason: 'resume paused submission-preflight incident',
      });
      process.stdout.write(
        `[factory] workplace recovery=${recovery.authorizationRef} `
        + `rejection=${recovery.rejectionRef} revision=${recovery.resultingRevision} `
        + `replayed=${recovery.replayed}\n`,
      );
    }
    launchRef = requestFactoryLaunch({
      orderRef: target.orderRef ?? `order-resume-${crypto.randomUUID()}`,
      mode: 'resume',
      projectId: target.projectId,
      epicId: target.epicId,
      lifecycleRunId: target.lifecycleRunId,
      initiatedBy: 'factory-resume',
      // Resume is a DISTINCT launch command on the same durable lifecycle.
      // The lifecycle run keeps its own idempotency key (target.idempotencyKey);
      // the LAUNCH needs its own key so it doesn't collide with the original
      // 'new' launch's idempotency binding. Each resume invocation is a fresh
      // operator action — use a unique key so repeated resume attempts each
      // get their own launch row (the previous launch may be in 'claimed'/
      // 'running' state from a crashed or failed attempt).
      idempotencyKey: `${target.idempotencyKey}:resume:${crypto.randomUUID()}`,
      concurrency,
    }, db);
  } finally {
    db.close();
  }

  process.stdout.write(`[factory] resume launch=${launchRef} db=${dbPath}\n`);
  spawnOrchestrateCli(dbPath, launchRef);
  // spawnOrchestrateCli wires exit — we don't reach here.
}

// ─── start: provision a new sandbox + create a new factory run ────────────
if (command === 'start') {
  const {
    dbPath,
    idea,
    modelName,
    sandboxName,
  } = parseStartArguments(args);
  if (!dbPath) die('start: db-path argument is required');
  if (!idea) die('start: idea-text argument is required');
  const modelProfile = factoryModelProfile(modelName);
  if (!modelProfile) die(`start: unknown Factory model '${modelName}'`);
  const requestedConcurrency = parseConcurrency(process.env.SAGA_FACTORY_CONCURRENCY);
  const launchConcurrency = effectiveFactoryConcurrency(
    requestedConcurrency,
    modelProfile.limit,
  );

  // If a sandbox dir is specified, provision the full project structure.
  // Otherwise, assume the DB already has project/epic/repo rows and only
  // the factory order + launch need to be created (the DB-path-only mode
  // for existing sandboxes that need a fresh start).
  const { SCHEMA_SQL, rebuildFactoryOrdersWithoutColumnUniques, rebuildLaunchIdempotencyIndex } = await import('../dist/schema.js');
  const { sha256Hex } = await import('../dist/shared/canonical-json.js');
  const { requestFactoryLaunch } = await import('../dist/infrastructure/factory/sqlite-factory-launch-repository.js');

  if (sandboxName) {
    const root = resolve(sandboxName);
    const repositoryPath = join(root, 'product');
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(repositoryPath, { recursive: true });

    function git(gitArgs) {
      const result = spawnSync('git', gitArgs, { cwd: repositoryPath, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    }
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Saga Factory']);
    git(['config', 'user.email', 'saga-factory@example.test']);
    writeFileSync(join(repositoryPath, 'README.md'), `# ${sandboxName}\n`);
    git(['add', '-A']);
    git(['commit', '-m', 'chore: initialize product']);
    git(['checkout', '-b', 'dev']);
    git(['rev-parse', 'HEAD']);

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    rebuildFactoryOrdersWithoutColumnUniques(db);
    rebuildLaunchIdempotencyIndex(db);

    const repoName = `${sandboxName}-repo`;
    db.prepare("INSERT INTO projects (id,name,description,status) VALUES (1,?,'idea run','active')").run(sandboxName);
    db.prepare("INSERT INTO epics (id,project_id,name,description,status,priority) VALUES (1,1,?,?, 'planned','high')").run('REQ-001', idea);
    db.prepare("INSERT INTO repositories (id,name) VALUES (1,?)").run(repoName);
    db.prepare(`INSERT INTO project_repositories (id,project_id,repository_id,role,local_path,integration_branch,status) VALUES (1,1,1,'component',?,'dev','active')`).run(repositoryPath);
    db.prepare(`INSERT INTO trusted_providers (id,project_id,name,version,category,trust_basis,determinism,scope,status) VALUES (1,1,'saga-real-model-worker','1.0.0','deterministic_evidence','real factory execution','partial','factory-smoke','active')`).run();
    db.prepare(
      `INSERT INTO lifecycle_execution_controls
         (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
       VALUES (1,?,?,?,?,?)`,
    ).run(
      launchConcurrency,
      modelProfile.provider,
      modelProfile.id,
      modelProfile.effort,
      modelProfile.limit,
    );
    db.close();

    process.stdout.write(`[factory] provisioned sandbox=${sandboxName} repo=${repositoryPath}\n`);
  }

  // Create the factory order + launch through the canonical API.
  const db = new Database(dbPath);
  let launchRef;
  try {
    const repoRow = db.prepare(
      `SELECT pr.local_path, pr.role AS repo_role, pr.integration_branch, r.name AS repo_name
         FROM project_repositories pr JOIN repositories r ON r.id=pr.repository_id
        WHERE pr.project_id=1 AND pr.status='active' ORDER BY pr.id LIMIT 1`,
    ).get();
    if (!repoRow) die('no active project_repository for project 1 — provision the sandbox first');
    const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRow.local_path, encoding: 'utf8',
    });
    if (baseCommit.status !== 0) die(`git rev-parse failed in ${repoRow.local_path}`);

    const policyBase = { id: 'reference-development-policy', version: '1.0.0' };
    const deferredBase = { schemaVersion: 'factory.delivery-deferred-profile.v1', reason: 'authorization-required', source: 'start-from-idea' };
    const lifecycleInput = {
      schemaVersion: 'factory.product-delivery-lifecycle-input.v2',
      initiative: {
        subject: idea,
        context: { type: 'web-app', complexity: 'XS' },
        evidence: {},
        // The public Factory gateway must not silently narrow arbitrary product
        // intent to a static/no-dependency toy. Product architecture is
        // discovered and formalized from the request. These are lifecycle
        // boundaries only: produce a locally runnable revision, do not deploy,
        // and involve the human after startup for acceptance feedback.
        constraints: {
          localRunRequired: true,
          deploymentExcluded: true,
          humanAcceptanceAfterLocalStart: true,
        },
      },
      development: {
        repositories: [{
          repositoryRef: { repositoryName: repoRow.repo_name, role: repoRow.repo_role },
          integrationBranch: repoRow.integration_branch ?? 'dev',
          expectedBaseCommit: baseCommit.stdout.trim(),
        }],
        policy: { ...policyBase, contentHash: sha256Hex(policyBase) },
      },
      delivery: {
        mode: 'deferred', policy: null, operatorAuthorization: null,
        deferredProfile: { ...deferredBase, profileHash: sha256Hex(deferredBase) },
      },
    };

    const orderRef = `order-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
       VALUES (?,1,1,NULL,'existing_project','starting')`,
    ).run(orderRef);

    launchRef = requestFactoryLaunch({
      orderRef,
      mode: 'new',
      projectId: 1,
      epicId: 1,
      lifecycleInput,
      lifecycleInputSchema: lifecycleInput.schemaVersion,
      // initiatedBy is audit provenance, not product semantics. Keep the
      // canonical operator identity stable across sandbox provisioning and
      // later new-start invocations so it cannot manufacture replay misses.
      initiatedBy: 'factory-start',
      idempotencyKey: `${sandboxName ?? 'factory'}-${crypto.randomUUID()}`,
      concurrency: launchConcurrency,
    }, db);
  } finally {
    db.close();
  }

  process.stdout.write(`[factory] start launch=${launchRef} db=${dbPath} model=${modelName}\n`);
  spawnOrchestrateCli(dbPath, launchRef);
  // spawnOrchestrateCli wires exit — we don't reach here.
}
