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
 *   node scripts/factory.mjs resume <db-path> [--requeue-paused]
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
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION — composition root (set by caller)
 *   SAGA_CLAUDE_PATH     — Claude CLI binary path (optional, for workers)
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  let modelName = 'glm-4.7';
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

if (command !== 'start' && command !== 'resume') {
  die(`usage: node scripts/factory.mjs <start|resume> <db-path> [options]\n`
    + `  start  <db-path> <idea-text> [--model <name>] [--sandbox <dir>]\n`
    + `  resume <db-path> [--requeue-paused]`);
}

// ─── Shared: spawn the runtime host with a launch capability ──────────────
function spawnOrchestrateCli(dbPath, launchRef) {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(join(here, '..', '..'));
  const cliPath = join(repoRoot, 'dist', 'orchestrate-cli.js');
  if (!existsSync(cliPath)) {
    die(`orchestrate-cli.js not found at ${cliPath} — run 'npm run build' first`);
  }
  const childEnv = {
    ...process.env,
    DB_PATH: dbPath,
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
    if (option !== '--requeue-paused') die(`resume: unsupported option '${option}'`);
  }

  const {
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
    const target = resolveFactoryResumeTarget(db, 1); // sandbox projects use id=1
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
      concurrency: Number(process.env.SAGA_FACTORY_CONCURRENCY ?? 5),
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
    db.prepare(`INSERT INTO lifecycle_execution_controls (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit) VALUES (1,5,'zai',?, 'medium',5)`).run(modelName);
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
        constraints: { staticFilesOnly: true, noDependencies: true },
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
      concurrency: Number(process.env.SAGA_FACTORY_CONCURRENCY ?? 5),
    }, db);
  } finally {
    db.close();
  }

  process.stdout.write(`[factory] start launch=${launchRef} db=${dbPath} model=${modelName}\n`);
  spawnOrchestrateCli(dbPath, launchRef);
  // spawnOrchestrateCli wires exit — we don't reach here.
}
