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
 *   node scripts/factory.mjs resume <db-path>
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

function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

if (command !== 'start' && command !== 'resume') {
  die(`usage: node scripts/factory.mjs <start|resume> <db-path> [options]\n`
    + `  start  <db-path> <idea-text> [--model <name>] [--sandbox <dir>]\n`
    + `  resume <db-path>`);
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

// ─── resume: continue an existing durable lifecycle run ───────────────────
if (command === 'resume') {
  const dbPath = args[1];
  if (!dbPath) die('resume: db-path argument is required');

  const { resolveFactoryResumeTarget } = await import('../dist/app/factory-start.js');
  const { requestFactoryLaunch } = await import('../dist/infrastructure/factory/sqlite-factory-launch-repository.js');

  const db = new Database(dbPath);
  let launchRef;
  try {
    const target = resolveFactoryResumeTarget(db, 1); // sandbox projects use id=1
    launchRef = requestFactoryLaunch({
      orderRef: target.orderRef ?? `order-resume-${crypto.randomUUID()}`,
      mode: 'resume',
      projectId: target.projectId,
      epicId: target.epicId,
      lifecycleRunId: target.lifecycleRunId,
      initiatedBy: 'factory-resume',
      idempotencyKey: target.idempotencyKey,
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
  const dbPath = args[1];
  const idea = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
  if (!dbPath) die('start: db-path argument is required');
  if (!idea) die('start: idea-text argument is required');

  const modelName = flag('model', 'glm-4.7');
  const sandboxName = flag('sandbox', null);

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
    const baseCommit = git(['rev-parse', 'HEAD']);

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
      `SELECT pr.local_path, r.name AS repo_name
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
        repositories: [{ repositoryRef: { repositoryName: repoRow.repo_name, role: 'component' }, integrationBranch: 'dev', expectedBaseCommit: baseCommit.stdout.trim() }],
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
      initiatedBy: sandboxName ?? 'factory-start',
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
