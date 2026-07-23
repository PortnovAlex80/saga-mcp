#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { LIVE_STAGE_SEQUENCE, previousStage, stageByCondition } from './stages.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const defaultMandate = [
  'Build a small local calculator web application.',
  'It must support addition, subtraction, multiplication, and division, show validation errors,',
  'be usable without a network connection, and include automated tests and concise documentation.',
  'Saga must preserve traceability from this mandate through requirements, architecture, plan, code, verification, and release evidence.',
].join(' ');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (['--stage', '--run-dir', '--mandate', '--model', '--lmstudio-url', '--timeout-ms', '--project-name'].includes(token)) {
      args[token.slice(2)] = argv[++index];
    } else if (token === '--skip-build') {
      args.skipBuild = true;
    } else if (token === '--allow-unreviewed') {
      args.allowUnreviewed = true;
    } else if (token === '--list-stages') {
      args.listStages = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function git(command, cwd) {
  return execFileSync('git', command, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function queryOne(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function queryAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail: String(detail ?? '') };
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
}

async function probeLmStudio(baseUrl, model) {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`LM Studio models endpoint returned ${response.status}`);
    const payload = await response.json();
    const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter(Boolean) : [];
    if (!ids.includes(model)) {
      throw new Error(`Model '${model}' is not loaded. LM Studio reports: ${ids.join(', ') || '(none)'}`);
    }
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

async function importDist(relativePath) {
  const absolute = path.join(repoRoot, 'dist', relativePath);
  return import(pathToFileURL(absolute).href);
}

function initializeWorkspace(workspace) {
  mkdirSync(workspace, { recursive: true });
  if (!existsSync(path.join(workspace, '.git'))) {
    git(['init', '-b', 'main'], workspace);
    git(['config', 'user.email', 'saga3-live@test.local'], workspace);
    git(['config', 'user.name', 'Saga 3 Live Test'], workspace);
    writeFileSync(path.join(workspace, 'README.md'), '# Saga 3 live acceptance workspace\n', 'utf8');
    writeFileSync(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'saga3-live-calculator',
        private: true,
        type: 'module',
        scripts: {
          build: 'node -e "console.log(\\"build baseline ok\\")"',
          test: 'node --test',
        },
      }, null, 2) + '\n',
      'utf8',
    );
    git(['add', '.'], workspace);
    git(['commit', '-m', 'test: seed live acceptance workspace'], workspace);
  }
}

async function initializeRun({ runDir, mandate, model, baseUrl, projectName }) {
  mkdirSync(runDir, { recursive: true });
  const workspace = path.join(runDir, 'workspace');
  const dbPath = path.join(runDir, 'saga3-live.db');
  initializeWorkspace(workspace);

  process.env.DB_PATH = dbPath;
  const projects = await importDist('tools/projects.js');
  const epics = await importDist('tools/epics.js');
  const repositories = await importDist('tools/repositories.js');
  const dbModule = await importDist('db.js');

  const project = projects.handlers.project_create({
    name: projectName,
    description: mandate,
    tags: ['saga3-live', 'lmstudio'],
  });
  const repository = repositories.handlers.repository_register({
    project_id: project.id,
    name: 'live-workspace',
    local_path: workspace,
    default_branch: 'main',
    integration_branch: 'main',
    role: 'primary',
  });
  repositories.handlers.repository_checkout_register({
    project_repository_id: repository.id,
    machine_id: os.hostname(),
    local_path: workspace,
  });
  const epic = epics.handlers.epic_create({
    project_id: project.id,
    name: 'Saga 3 live pipeline acceptance',
    description: mandate,
    status: 'in_progress',
    priority: 'high',
    branch: 'main',
  });

  const metadata = {
    active_provider: 'lmstudio',
    active_model: model,
    engine_concurrency: 1,
    live_acceptance: true,
  };
  const db = dbModule.getDb();
  db.prepare(
    `INSERT INTO episode_workflows (epic_id, stage, metadata)
     VALUES (?, 'discovery', ?)`
  ).run(epic.id, JSON.stringify(metadata));
  dbModule.closeDb();

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    runDir,
    dbPath,
    workspace,
    projectId: project.id,
    epicId: epic.id,
    projectRepositoryId: repository.id,
    projectName,
    mandate,
    model,
    lmstudioUrl: baseUrl,
    checkpoints: [],
  };
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function loadManifest(runDir) {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function saveManifest(manifest) {
  writeFileSync(path.join(manifest.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function requirePriorReview(manifest, stage, allowUnreviewed) {
  const previous = previousStage(stage.condition);
  if (!previous) return;
  const checkpoint = manifest.checkpoints.find((item) => item.stage === previous.condition);
  if (!checkpoint?.mechanicalPass) {
    throw new Error(`Previous checkpoint ${previous.condition} has not passed mechanical checks.`);
  }
  const reviewPath = path.join(checkpoint.bundleDir, 'semantic-review.json');
  if (!existsSync(reviewPath)) {
    if (allowUnreviewed) return;
    throw new Error(`Previous checkpoint requires semantic review: ${reviewPath}`);
  }
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (review.verdict !== 'pass' && !allowUnreviewed) {
    throw new Error(`Previous semantic review verdict is '${review.verdict}', not pass.`);
  }
}

function updateEpisodeModel(db, manifest, model) {
  const row = queryOne(db, 'SELECT metadata FROM episode_workflows WHERE epic_id=?', manifest.epicId);
  if (!row) throw new Error(`episode_workflows row not found for epic ${manifest.epicId}`);
  const metadata = JSON.parse(row.metadata || '{}');
  Object.assign(metadata, {
    active_provider: 'lmstudio',
    active_model: model,
    engine_concurrency: 1,
    live_acceptance: true,
  });
  db.prepare("UPDATE episode_workflows SET metadata=?, updated_at=datetime('now') WHERE epic_id=?")
    .run(JSON.stringify(metadata), manifest.epicId);
}

function parseWorkerLog(logPath) {
  if (!logPath || !existsSync(logPath)) return { exists: false, jsonEvents: 0, resultEvents: 0, errorEvents: 0 };
  const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  let jsonEvents = 0;
  let resultEvents = 0;
  let errorEvents = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      jsonEvents++;
      if (event.type === 'result') {
        resultEvents++;
        if (event.is_error === true || event.subtype === 'error') errorEvents++;
      }
    } catch {
      // MCP stderr and diagnostics may share the log; only JSON events are counted.
    }
  }
  return { exists: true, jsonEvents, resultEvents, errorEvents };
}

function collectStageState(db, manifest, stage, engineLogPath) {
  const spec = queryOne(
    db,
    `SELECT * FROM saga3_episode_specs WHERE epic_id=? ORDER BY generation DESC LIMIT 1`,
    manifest.epicId,
  );
  const condition = spec ? queryOne(
    db,
    `SELECT * FROM saga3_condition_instances
      WHERE episode_spec_id=? AND condition_type=? ORDER BY projection_version DESC LIMIT 1`,
    spec.id,
    stage.condition,
  ) : null;
  const task = queryOne(
    db,
    `SELECT * FROM tasks WHERE epic_id=? AND task_kind=? ORDER BY id DESC LIMIT 1`,
    manifest.epicId,
    stage.taskKind,
  );
  const execution = task ? queryOne(
    db,
    `SELECT * FROM worker_executions WHERE task_id=? ORDER BY started_at DESC, reserved_at DESC LIMIT 1`,
    task.id,
  ) : null;
  const intent = spec ? queryOne(
    db,
    `SELECT * FROM saga3_work_intents
      WHERE episode_spec_id=? AND target_condition=? ORDER BY created_at DESC LIMIT 1`,
    spec.id,
    stage.condition,
  ) : null;
  const assignment = intent ? queryOne(
    db,
    `SELECT * FROM saga3_worker_assignments WHERE work_intent_id=? ORDER BY created_at DESC LIMIT 1`,
    intent.id,
  ) : null;
  const evidence = spec ? queryOne(
    db,
    `SELECT * FROM saga3_evidence_records
      WHERE episode_spec_id=? AND condition_type=? ORDER BY observed_at DESC LIMIT 1`,
    spec.id,
    stage.condition,
  ) : null;
  const artifactRows = spec ? queryAll(
    db,
    `SELECT * FROM saga3_artifacts WHERE episode_spec_id=? ORDER BY created_at ASC`,
    spec.id,
  ) : [];

  const artifacts = artifactRows.map((row) => {
    const absolutePath = path.resolve(manifest.workspace, String(row.path).split('#')[0]);
    const fileExists = existsSync(absolutePath);
    const content = fileExists ? readFileSync(absolutePath) : Buffer.alloc(0);
    return {
      id: row.id,
      kind: row.kind,
      path: absolutePath,
      relativePath: row.path,
      digest: row.digest,
      fileExists,
      actualDigest: fileExists ? sha256(content) : null,
      size: fileExists ? statSync(absolutePath).size : 0,
      contentPreview: fileExists ? content.toString('utf8').slice(0, 4000) : '',
    };
  });

  const workerLogPath = execution?.log_path ? path.resolve(execution.log_path) : null;
  const workerLog = parseWorkerLog(workerLogPath);
  const engineLog = existsSync(engineLogPath) ? readFileSync(engineLogPath, 'utf8') : '';
  return {
    project: queryOne(db, 'SELECT * FROM projects WHERE id=?', manifest.projectId),
    epic: queryOne(db, 'SELECT * FROM epics WHERE id=?', manifest.epicId),
    spec,
    condition,
    task,
    execution,
    intent,
    assignment,
    evidence,
    artifacts,
    workerLogPath,
    workerLog,
    engineLog,
  };
}

function buildMechanicalChecks(state, manifest, stage) {
  const expectedArtifacts = stage.artifactKinds.length === 0
    ? []
    : state.artifacts.filter((artifact) => stage.artifactKinds.includes(artifact.kind));
  return [
    check('project exists on board', state.project?.id === manifest.projectId, `project=${state.project?.id ?? 'missing'}`),
    check('project description preserves mandate', state.project?.description === manifest.mandate, 'projects.description must equal the supplied mandate'),
    check('epic exists on board', state.epic?.id === manifest.epicId, `epic=${state.epic?.id ?? 'missing'}`),
    check('episode spec is sealed', state.spec?.sealed === 1, `sealed=${state.spec?.sealed ?? 'missing'}`),
    check('condition became True', state.condition?.status === 'True', `status=${state.condition?.status ?? 'missing'}`),
    check('task projection has expected type', state.task?.task_kind === stage.taskKind, `task_kind=${state.task?.task_kind ?? 'missing'}`),
    check('task projection has expected workflow stage', state.task?.workflow_stage === stage.workflowStage, `workflow_stage=${state.task?.workflow_stage ?? 'missing'}`),
    check('task projection has expected skill', state.task?.execution_skill === stage.skillId, `execution_skill=${state.task?.execution_skill ?? 'missing'}`),
    check('board task is done after worker completion', state.task?.status === 'done', `status=${state.task?.status ?? 'missing'}`),
    check('worker execution exited cleanly', state.execution?.state === 'exited' && state.execution?.exit_code === 0,
      `state=${state.execution?.state ?? 'missing'} exit=${state.execution?.exit_code ?? 'missing'}`),
    check('WorkIntent is completed', state.intent?.status === 'completed', `status=${state.intent?.status ?? 'missing'}`),
    check('WorkerAssignment is verified', state.assignment?.state === 'verified', `state=${state.assignment?.state ?? 'missing'}`),
    check('evidence uses expected oracle', state.evidence?.oracle_id === stage.oracleId, `oracle=${state.evidence?.oracle_id ?? 'missing'}`),
    check('evidence passed', state.evidence?.verdict === 'passed', `verdict=${state.evidence?.verdict ?? 'missing'}`),
    check('evidence has controller provenance', Boolean(state.evidence?.source_fingerprint && state.evidence?.environment_fingerprint),
      `source=${state.evidence?.source_fingerprint ? 'set' : 'missing'} environment=${state.evidence?.environment_fingerprint ? 'set' : 'missing'}`),
    check('expected artifact kind exists', stage.artifactKinds.length === 0 || expectedArtifacts.length > 0,
      `expected one of [${stage.artifactKinds.join(', ')}], got [${state.artifacts.map((artifact) => artifact.kind).join(', ')}]`),
    check('artifact files exist and match manifest digests', state.artifacts.every((artifact) => artifact.fileExists && artifact.digest === artifact.actualDigest),
      `${state.artifacts.filter((artifact) => !artifact.fileExists || artifact.digest !== artifact.actualDigest).length} invalid artifact file(s)`),
    check('engine log records target condition', state.engineLog.includes(`condition=${stage.condition}`), `engine log must contain condition=${stage.condition}`),
    check('engine log confirms LM Studio routing', state.engineLog.includes('Using LM Studio provider'), 'LM Studio routing marker missing'),
    check('engine log has no fatal/spawn error', !/FATAL:|WORKER SPAWN ERROR|TERMINAL: RESOURCE_EXHAUSTED/i.test(state.engineLog), 'fatal, spawn, or exhaustion marker found'),
    check('worker JSONL log exists', state.workerLog.exists, state.workerLogPath ?? 'missing'),
    check('worker JSONL has a result event', state.workerLog.resultEvents > 0 && state.workerLog.errorEvents === 0,
      `json=${state.workerLog.jsonEvents} result=${state.workerLog.resultEvents} errors=${state.workerLog.errorEvents}`),
  ];
}

function writeReviewBundle({ bundleDir, state, manifest, stage, checks, engineLogPath }) {
  mkdirSync(bundleDir, { recursive: true });
  const mechanicalPass = checks.every((item) => item.pass);
  const report = {
    generatedAt: new Date().toISOString(),
    stage,
    mechanicalPass,
    checks,
    state: {
      projectId: manifest.projectId,
      epicId: manifest.epicId,
      episodeSpecId: state.spec?.id ?? null,
      taskId: state.task?.id ?? null,
      executionId: state.execution?.execution_id ?? null,
      workIntentId: state.intent?.id ?? null,
      assignmentId: state.assignment?.id ?? null,
      evidenceId: state.evidence?.id ?? null,
    },
  };
  writeFileSync(path.join(bundleDir, 'mechanical-report.json'), JSON.stringify(report, null, 2), 'utf8');

  const snapshotDir = path.join(bundleDir, 'artifact-snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  const reviewArtifacts = state.artifacts.map((artifact, index) => {
    const snapshotPath = path.join(snapshotDir, `${String(index + 1).padStart(2, '0')}-${safeName(artifact.kind)}-${safeName(path.basename(artifact.path))}`);
    if (artifact.fileExists) copyFileSync(artifact.path, snapshotPath);
    return { ...artifact, snapshotPath };
  });

  const request = {
    generatedAt: new Date().toISOString(),
    mandate: manifest.mandate,
    project: { id: manifest.projectId, name: manifest.projectName },
    stage,
    mechanicalPass,
    mechanicalReport: path.join(bundleDir, 'mechanical-report.json'),
    artifacts: reviewArtifacts,
    logs: [engineLogPath, state.workerLogPath].filter(Boolean),
    agentInstructions: [
      'Read every artifact snapshot and both logs in full; previews are navigation aids only.',
      'Compare content with the mandate, upstream artifacts, and the stage semanticChecks.',
      'Look for generic prose, invented facts, missing decisions, contradictions, false claims of verification, hidden retries, and work outside the assigned scope.',
      'Do not mark pass merely because mechanical checks passed.',
      'Write a review JSON matching the documented schema and validate it with test:saga3:live:review.',
    ],
  };
  writeFileSync(path.join(bundleDir, 'semantic-review-request.json'), JSON.stringify(request, null, 2), 'utf8');

  const template = {
    stage: stage.condition,
    verdict: 'pass',
    summary: 'Replace with a grounded semantic assessment of the produced work.',
    confidence: 0.8,
    inspectedArtifacts: reviewArtifacts.map((artifact) => ({ path: artifact.path, assessment: '', findings: [] })),
    inspectedLogs: request.logs.map((logPath) => ({ path: logPath, assessment: '' })),
    requirementsCoverage: stage.semanticChecks.map((requirement) => ({ requirement, status: 'covered', evidence: '' })),
    defects: [],
  };
  writeFileSync(path.join(bundleDir, 'semantic-review.template.json'), JSON.stringify(template, null, 2), 'utf8');
  writeFileSync(
    path.join(bundleDir, 'AGENT_REVIEW.md'),
    `# Agent semantic review — ${stage.condition}\n\n` +
      `Mechanical status: **${mechanicalPass ? 'PASS' : 'FAIL'}**\n\n` +
      `1. Read \`semantic-review-request.json\`.\n` +
      `2. Read every file under \`artifact-snapshots/\` and the original artifact paths.\n` +
      `3. Inspect the engine and worker logs listed in the request.\n` +
      `4. Fill a copy of \`semantic-review.template.json\`.\n` +
      `5. Validate it:\n\n` +
      `   npm run test:saga3:live:review -- --bundle "${bundleDir}" --review "<review.json>"\n\n` +
      `The next stage is blocked until the canonical \`semantic-review.json\` exists with verdict \`pass\`.\n`,
    'utf8',
  );
  return { mechanicalPass, report, request };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.listStages) {
    for (const stage of LIVE_STAGE_SEQUENCE) console.log(`${stage.condition}\t${stage.taskKind}\t${stage.skillId}\t${stage.oracleId}`);
    return;
  }
  if (process.env.SAGA3_LIVE_LMSTUDIO !== '1') {
    throw new Error('Live test is opt-in. Set SAGA3_LIVE_LMSTUDIO=1.');
  }

  const stage = stageByCondition(args.stage ?? process.env.SAGA3_LIVE_STAGE ?? 'ConstitutionReady');
  if (!stage) throw new Error(`Unknown stage. Use --list-stages.`);
  const model = args.model ?? process.env.SAGA3_LIVE_MODEL;
  if (!model) throw new Error('Set SAGA3_LIVE_MODEL or pass --model with the exact LM Studio model id.');
  const baseUrl = args['lmstudio-url'] ?? process.env.SAGA_LMSTUDIO_URL ?? 'http://localhost:1234/v1';
  const timeoutMs = Number(args['timeout-ms'] ?? process.env.SAGA3_LIVE_TIMEOUT_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new Error('timeout must be at least 10000 ms');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(args['run-dir'] ?? process.env.SAGA3_LIVE_RUN_DIR ?? path.join(repoRoot, '.saga3-live', timestamp));
  const mandate = args.mandate ?? process.env.SAGA3_LIVE_MANDATE ?? defaultMandate;
  const projectName = args['project-name'] ?? process.env.SAGA3_LIVE_PROJECT_NAME ?? 'Saga 3 LM Studio live acceptance';

  console.log(`LIVE_STAGE=${stage.condition}`);
  console.log(`LIVE_RUN_DIR=${runDir}`);
  console.log(`LMSTUDIO_URL=${baseUrl}`);
  console.log(`LMSTUDIO_MODEL=${model}`);

  await probeLmStudio(baseUrl, model);
  if (!args.skipBuild && process.env.SAGA3_LIVE_SKIP_BUILD !== '1') {
    console.log('Building Saga before live execution...');
    execFileSync(npmCommand(), ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!existsSync(path.join(repoRoot, 'dist', 'saga3', 'app', 'cli.js'))) {
    throw new Error('dist/saga3/app/cli.js is missing; run npm run build.');
  }

  let manifest = loadManifest(runDir);
  if (!manifest) {
    manifest = await initializeRun({ runDir, mandate, model, baseUrl, projectName });
  } else {
    if (manifest.mandate !== mandate) throw new Error('Mandate differs from the existing live run manifest.');
    manifest.model = model;
    manifest.lmstudioUrl = baseUrl;
  }
  requirePriorReview(manifest, stage, args.allowUnreviewed);

  const db = new Database(manifest.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const priorCondition = queryOne(
    db,
    `SELECT status FROM saga3_condition_instances ci
      JOIN saga3_episode_specs es ON es.id=ci.episode_spec_id
      WHERE es.epic_id=? AND ci.condition_type=? ORDER BY es.generation DESC LIMIT 1`,
    manifest.epicId,
    stage.prerequisite,
  );
  if (stage.condition !== 'ConstitutionReady' && priorCondition?.status !== 'True') {
    throw new Error(`Prerequisite ${stage.prerequisite} is not True.`);
  }
  const already = queryOne(
    db,
    `SELECT ci.status FROM saga3_condition_instances ci
      JOIN saga3_episode_specs es ON es.id=ci.episode_spec_id
      WHERE es.epic_id=? AND ci.condition_type=? ORDER BY es.generation DESC LIMIT 1`,
    manifest.epicId,
    stage.condition,
  );
  if (already?.status === 'True') throw new Error(`${stage.condition} is already True in this run.`);
  updateEpisodeModel(db, manifest, model);

  const checkpointIndex = LIVE_STAGE_SEQUENCE.findIndex((item) => item.condition === stage.condition) + 1;
  const bundleDir = path.join(runDir, 'checkpoints', `${String(checkpointIndex).padStart(2, '0')}-${stage.condition}`);
  mkdirSync(bundleDir, { recursive: true });
  const engineLogPath = path.join(bundleDir, 'engine.log');
  writeFileSync(engineLogPath, '', 'utf8');

  const claudePath = process.env.SAGA_CLAUDE_PATH ?? 'claude';
  const skillsRoot = process.env.SAGA3_SKILLS_ROOT ?? path.join(repoRoot, 'skills');
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'dist', 'saga3', 'app', 'cli.js'), manifest.mandate],
    {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DB_PATH: manifest.dbPath,
        SAGA3_WORKSPACE: manifest.workspace,
        SAGA3_SKILLS_ROOT: skillsRoot,
        SAGA3_PROJECT_ID: String(manifest.projectId),
        SAGA3_EPIC_ID: String(manifest.epicId),
        SAGA3_MAX_CONCURRENCY: '1',
        SAGA3_MAX_ATTEMPTS_PER_CONDITION: '1',
        SAGA_CLAUDE_PATH: claudePath,
        SAGA_LMSTUDIO_URL: baseUrl,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? 'lm-studio',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'lm-studio',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '262144',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  );

  const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      process.stdout.write(chunk);
      appendFileSync(engineLogPath, chunk);
    });
  }

  const startedAt = Date.now();
  let targetReached = false;
  let engineExited = false;
  child.once('close', () => { engineExited = true; });
  while (Date.now() - startedAt < timeoutMs) {
    const row = queryOne(
      db,
      `SELECT ci.status FROM saga3_condition_instances ci
        JOIN saga3_episode_specs es ON es.id=ci.episode_spec_id
        WHERE es.epic_id=? AND ci.condition_type=? ORDER BY es.generation DESC LIMIT 1`,
      manifest.epicId,
      stage.condition,
    );
    if (row?.status === 'True') {
      targetReached = true;
      console.log(`LIVE_CHECKPOINT_REACHED condition=${stage.condition}`);
      break;
    }
    if (engineExited) break;
    await sleep(200);
  }

  if (targetReached) {
    // After the condition is True, the claude worker process is still alive:
    // it has called saga3_complete via MCP, but claude -p still has to emit
    // its final assistant text and the closing `result` stream-json event.
    // Killing the tree here (the old behaviour) truncated the JSONL log before
    // the result event, failing the "worker JSONL has a result event" check.
    //
    // Give claude a grace window to finish its turn naturally. We wait for
    // EITHER the engine child to exit on its own (preferred — means the
    // worker returned cleanly), OR the JSONL log to contain a `result` event,
    // OR a hard cap (30s) — whichever comes first.
    const graceUntil = Date.now() + 30000;
    while (Date.now() < graceUntil && !engineExited) {
      const task = queryOne(db, 'SELECT id FROM tasks WHERE epic_id=? AND task_kind=? ORDER BY id DESC LIMIT 1', manifest.epicId, stage.taskKind);
      const execution = task ? queryOne(db, 'SELECT state, log_path FROM worker_executions WHERE task_id=? ORDER BY started_at DESC LIMIT 1', task.id) : null;
      if (execution?.log_path && existsSync(execution.log_path)) {
        try {
          const tail = readFileSync(execution.log_path, 'utf8').slice(-8192);
          if (/\{"type":"result"/.test(tail)) break;
        } catch { /* log may be mid-write */ }
      }
      await sleep(200);
    }
  }
  if (!engineExited) terminateProcessTree(child);
  const exitState = await Promise.race([exit, sleep(7000).then(() => ({ code: null, signal: 'timeout-after-terminate' }))]);

  const state = collectStageState(db, manifest, stage, engineLogPath);
  const checks = buildMechanicalChecks(state, manifest, stage);
  checks.push(check('target checkpoint was observed before timeout', targetReached,
    `engine exit code=${exitState.code ?? 'null'} signal=${exitState.signal ?? 'none'}`));
  const bundle = writeReviewBundle({ bundleDir, state, manifest, stage, checks, engineLogPath });

  manifest.checkpoints = manifest.checkpoints.filter((item) => item.stage !== stage.condition);
  manifest.checkpoints.push({
    stage: stage.condition,
    bundleDir,
    mechanicalPass: bundle.mechanicalPass,
    completedAt: new Date().toISOString(),
  });
  saveManifest(manifest);
  db.close();

  console.log(`MECHANICAL_RESULT=${bundle.mechanicalPass ? 'PASS' : 'FAIL'}`);
  console.log(`MECHANICAL_REPORT=${path.join(bundleDir, 'mechanical-report.json')}`);
  console.log(`SEMANTIC_REVIEW_REQUEST=${path.join(bundleDir, 'semantic-review-request.json')}`);
  console.log(`AGENT_REVIEW_GUIDE=${path.join(bundleDir, 'AGENT_REVIEW.md')}`);
  console.log('SEMANTIC_REVIEW_REQUIRED=1');
  if (!bundle.mechanicalPass) process.exit(1);
}

main().catch((error) => {
  console.error(`LIVE_TEST_FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
