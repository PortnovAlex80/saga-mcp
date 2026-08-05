#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolDir, '..');

function fail(message) {
  process.stderr.write(`[discovery-run] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const command = argv[2] ?? 'help';
  const options = {};
  for (const arg of argv.slice(3)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) fail(`unsupported argument '${arg}'`);
    options[match[1]] = match[2];
  }
  return { command, options };
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runGit(workspace, args) {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function ensureWorkspace(workspace, idea) {
  mkdirSync(workspace, { recursive: true });
  if (!existsSync(path.join(workspace, '.git'))) {
    runGit(workspace, ['init', '-b', 'main']);
    runGit(workspace, ['config', 'user.name', 'Saga Discovery']);
    runGit(workspace, ['config', 'user.email', 'saga-discovery@localhost']);
    writeFileSync(
      path.join(workspace, 'README.md'),
      `# Discovery sandbox\n\nInitial idea:\n\n${idea}\n`,
      'utf8',
    );
    runGit(workspace, ['add', 'README.md']);
    runGit(workspace, ['commit', '-m', 'chore: initialize discovery sandbox']);
  }
}

async function openDb(dbPath) {
  process.env.DB_PATH = dbPath;
  const { getDb, closeDb } = await import('../dist/db.js');
  return { db: getDb(), closeDb };
}

function tableExists(db, tableName) {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(tableName) !== undefined;
}

async function bootstrap(options) {
  const idea = options.idea?.trim();
  if (!idea) {
    fail('bootstrap requires --idea="your product idea"');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.resolve(
    options.root ?? path.join(os.tmpdir(), `saga-discovery-${stamp}`),
  );
  const workspace = path.join(runRoot, 'workspace');
  const dbPath = path.join(runRoot, 'saga.db');
  const packageStore = path.join(runRoot, 'package-store');
  const logRoot = path.join(runRoot, 'logs');
  const runFile = path.join(runRoot, 'run.json');

  if (existsSync(runFile)) {
    fail(`run already exists at ${runFile}; choose another --root`);
  }
  for (const directory of [runRoot, packageStore, logRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  ensureWorkspace(workspace, idea);

  if (!existsSync(path.join(repoRoot, 'dist', 'db.js'))) {
    fail(`compiled runtime is missing; run 'npm run build' in ${repoRoot}`);
  }

  const { db, closeDb } = await openDb(dbPath);
  let projectId;
  let repositoryId;
  let projectRepositoryId;
  let epicId;
  try {
    const seed = db.transaction(() => {
      const project = db.prepare(
        `INSERT INTO projects (name, description, status, metadata)
         VALUES (?, ?, 'active', ?)`,
      ).run(
        options.project ?? 'Discovery sandbox',
        'Isolated end-to-end Discovery validation project',
        JSON.stringify({ bootstrappedBy: 'tools/discovery-run.mjs' }),
      );
      projectId = Number(project.lastInsertRowid);

      const repository = db.prepare(
        `INSERT INTO repositories (name, default_branch, metadata)
         VALUES (?, 'main', ?)`,
      ).run(
        options.repository ?? 'discovery-sandbox',
        JSON.stringify({ purpose: 'discovery-e2e' }),
      );
      repositoryId = Number(repository.lastInsertRowid);

      const binding = db.prepare(
        `INSERT INTO project_repositories
           (project_id, repository_id, role, local_path, integration_branch, status)
         VALUES (?, ?, 'primary', ?, 'main', 'active')`,
      ).run(projectId, repositoryId, workspace);
      projectRepositoryId = Number(binding.lastInsertRowid);

      const epic = db.prepare(
        `INSERT INTO epics
           (project_id, name, description, status, priority, metadata)
         VALUES (?, ?, ?, 'planned', 'medium', ?)`,
      ).run(
        projectId,
        options.epic ?? 'Discover the initial product idea',
        idea,
        JSON.stringify({ inputKind: 'napkin-idea' }),
      );
      epicId = Number(epic.lastInsertRowid);

      db.prepare(
        `INSERT INTO episode_workflows (epic_id, stage, track, metadata)
         VALUES (?, 'discovery', 'formal', ?)`,
      ).run(epicId, JSON.stringify({
        active_provider: options.provider ?? 'zai',
        ...(options.model ? { active_model: options.model } : {}),
        ...(options.effort ? { active_model_effort: options.effort } : {}),
      }));
    });
    seed();
  } finally {
    closeDb();
  }

  const configuration = {
    schema: 'saga.discovery-run.v1',
    createdAt: new Date().toISOString(),
    repoRoot,
    runRoot,
    workspace,
    dbPath,
    packageStore,
    logRoot,
    projectId,
    repositoryId,
    projectRepositoryId,
    epicId,
    idea,
  };
  writeFileSync(runFile, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(configuration, null, 2)}\n\n`);
  printCommands(configuration);
}

function readRunFile(options) {
  const requested = options.run ?? options.root;
  if (!requested) fail('command requires --run=path/to/run.json-or-directory');
  const resolved = path.resolve(requested);
  const runFile = path.basename(resolved).toLowerCase() === 'run.json'
    ? resolved
    : path.join(resolved, 'run.json');
  if (!existsSync(runFile)) fail(`run file not found: ${runFile}`);
  return JSON.parse(readFileSync(runFile, 'utf8'));
}

function printCommands(configuration) {
  const cli = path.join(configuration.repoRoot, 'dist', 'orchestrate-cli.js');
  const tool = path.join(configuration.repoRoot, 'tools', 'discovery-run.mjs');
  const runFile = path.join(configuration.runRoot, 'run.json');
  process.stdout.write(
    'PowerShell launch command (this starts the real Claude workers):\n\n'
    + `$env:DB_PATH=${quotePowerShell(configuration.dbPath)}\n`
    + `$env:SAGA_REPO_ROOT=${quotePowerShell(configuration.repoRoot)}\n`
    + `$env:SAGA_PACKAGE_STORE_DIR=${quotePowerShell(configuration.packageStore)}\n`
    + `$env:SAGA_ORCHESTRATION_MODE='saga3-discovery-generic'\n`
    + `$env:SAGA_ORCHESTRATION_LOG=${quotePowerShell(configuration.logRoot)}\n`
    + `node ${quotePowerShell(cli)} ${configuration.projectId} ${configuration.epicId} --concurrency=1\n\n`
    + 'Status command (safe in another terminal):\n\n'
    + `node ${quotePowerShell(tool)} status --run=${quotePowerShell(runFile)}\n`,
  );
}

async function status(options) {
  const configuration = readRunFile(options);
  const { db, closeDb } = await openDb(configuration.dbPath);
  try {
    const result = {
      schema: 'saga.discovery-run-status.v1',
      run: configuration,
      processRuns: tableExists(db, 'saga3_process_runs')
        ? db.prepare(
          `SELECT id, module_name, module_version, status, local_outcome,
                  authority, output_ref, certificate_ref, error,
                  installation_id, package_digest, started_at, completed_at
             FROM saga3_process_runs
            WHERE project_id=? AND epic_id=?
            ORDER BY id`,
        ).all(configuration.projectId, configuration.epicId)
        : [],
      nodeRuns: tableExists(db, 'saga3_node_runs')
        ? db.prepare(
          `SELECT id, process_run_id, node_id, attempt, status, error_message,
                  started_at, completed_at
             FROM saga3_node_runs
            WHERE process_run_id IN (
              SELECT id FROM saga3_process_runs WHERE project_id=? AND epic_id=?
            )
            ORDER BY id`,
        ).all(configuration.projectId, configuration.epicId)
        : [],
      tasks: db.prepare(
        `SELECT id, title, task_kind, workflow_stage, status, assigned_to,
                current_execution_id, updated_at
           FROM tasks
          WHERE epic_id=?
          ORDER BY id`,
      ).all(configuration.epicId),
      workerExecutions: db.prepare(
        `SELECT execution_id, task_id, worker_id, state, phase, pid, last_error,
                started_at, finished_at
           FROM worker_executions
          WHERE epic_id=?
          ORDER BY started_at`,
      ).all(configuration.epicId),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeDb();
  }
}

function commands(options) {
  printCommands(readRunFile(options));
}

async function preflight(options) {
  const configuration = readRunFile(options);
  const checks = [
    ['runtime', path.join(configuration.repoRoot, 'dist', 'orchestrate-cli.js')],
    ['MCP server', path.join(configuration.repoRoot, 'dist', 'index.js')],
    ['database', configuration.dbPath],
    ['workspace', configuration.workspace],
    ['workspace git metadata', path.join(configuration.workspace, '.git')],
    ['Discovery manifest source', path.join(
      configuration.repoRoot,
      'src',
      'process-modules',
      'modules',
      'discovery',
      'package',
      'manifest.ts',
    )],
  ].map(([name, target]) => ({
    name,
    target,
    ok: existsSync(target),
  }));
  const claude = spawnSync(process.env.SAGA_CLAUDE_PATH ?? 'claude', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  checks.push({
    name: 'Claude CLI',
    target: process.env.SAGA_CLAUDE_PATH ?? 'claude',
    ok: claude.status === 0,
    detail: (claude.stdout || claude.stderr || '').trim(),
  });
  try {
    process.env.DB_PATH = configuration.dbPath;
    process.env.SAGA_REPO_ROOT = configuration.repoRoot;
    process.env.SAGA_PACKAGE_STORE_DIR = configuration.packageStore;
    // saga4 cutover: 'saga3-discovery-generic' is no longer a reachable mode
    // from createFactoryApplication — the composition root always returns the
    // Product Lifecycle runtime. This harness proved the generic-flow discovery
    // composition during P6c; that goal is complete. The check now verifies
    // that the discovery module package still installs cleanly (its manifest +
    // resources are intact) without asserting engine selection.
    const [
      { getDb },
      { installModulePackages },
      { discoveryPackageManifest },
    ] = await Promise.all([
      import('../dist/db.js'),
      import('../dist/process-modules/installation/production-install.js'),
      import('../dist/process-modules/modules/discovery/package/manifest.js'),
    ]);
    const modulePackages = await installModulePackages(
      getDb(),
      configuration.repoRoot,
      [discoveryPackageManifest],
      configuration.packageStore,
    );
    const installed = modulePackages.records.has(discoveryPackageManifest.name);
    checks.push({
      name: 'Discovery module package install',
      target: discoveryPackageManifest.name,
      ok: installed,
      detail: installed ? undefined : 'package not in installation records after install',
    });
  } catch (error) {
    checks.push({
      name: 'Discovery module package install',
      target: 'saga.product.discovery',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}

function help() {
  process.stdout.write(
    'Usage:\n'
    + '  node tools/discovery-run.mjs bootstrap --idea="product idea" [--root=path]\n'
    + '  node tools/discovery-run.mjs preflight --run=path/to/run.json\n'
    + '  node tools/discovery-run.mjs commands --run=path/to/run.json\n'
    + '  node tools/discovery-run.mjs status --run=path/to/run.json\n',
  );
}

const { command, options } = parseArgs(process.argv);
if (command === 'bootstrap') await bootstrap(options);
else if (command === 'preflight') await preflight(options);
else if (command === 'commands') commands(options);
else if (command === 'status') await status(options);
else if (command === 'help' || command === '--help' || command === '-h') help();
else fail(`unknown command '${command}'`);
