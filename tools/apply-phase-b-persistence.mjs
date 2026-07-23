#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

function read(file) { return readFileSync(file, 'utf8'); }
function write(file, value) { writeFileSync(file, value, 'utf8'); }
function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}
function replaceExact(file, needle, replacement, expected = 1) {
  const source = read(file);
  const found = count(source, needle);
  if (found !== expected) {
    throw new Error(`${file}: expected ${expected} anchor(s), found ${found}: ${needle.slice(0, 140)}`);
  }
  write(file, source.split(needle).join(replacement));
}
function replaceBetween(file, start, end, replacement) {
  const source = read(file);
  const starts = count(source, start);
  if (starts !== 1) throw new Error(`${file}: start anchor count=${starts}: ${start.slice(0, 120)}`);
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`${file}: end anchor missing: ${end.slice(0, 120)}`);
  write(file, source.slice(0, from) + replacement + source.slice(to));
}
function assertIncludes(file, needles) {
  const source = read(file);
  for (const needle of needles) {
    if (!source.includes(needle)) throw new Error(`${file}: required guard missing: ${needle}`);
  }
}
function assertExcludes(file, needles) {
  const source = read(file);
  for (const needle of needles) {
    if (source.includes(needle)) throw new Error(`${file}: forbidden guard present: ${needle}`);
  }
}

const orchestrate = 'src/orchestrate.ts';

// Guard the user-supplied 92a2e9d model-routing fix before touching the pump.
assertIncludes('tracker-view/claude-runner.mjs', [
  "const effortArg = isLmstudio ? null : (am.effort || 'high');",
  "args.splice(modelIdx + 2, 0, '--effort', effortArg);",
]);
assertExcludes('tracker-view/claude-runner.mjs', [
  "'--effort', 'xhigh'",
]);
assertIncludes('tracker-view/tracker-view.mjs', [
  "'$.active_model_effort'",
  "effort: 'high'",
  'getActiveModel: epicId =>',
]);
assertIncludes('src/infrastructure/workers/legacy-claude-worker-executor-factory.ts', [
  'modelRouteReader',
  'active_model_effort',
  'getActiveModel: modelRouteReader',
]);
assertIncludes('src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts', [
  'readWorkerModelRoute',
  'active_model_effort',
]);

replaceExact(orchestrate,
  "import { getDb, closeDb } from './db.js';",
  "import { closeDb } from './db.js';");
replaceExact(orchestrate,
  "import { reevaluateDownstream } from './tools/tasks.js';\n",
  '');
replaceExact(orchestrate,
  "import { handlers as projectHandlers } from './tools/projects.js';\n",
  '');
replaceExact(orchestrate,
  "import { logActivity } from './helpers/activity-logger.js';\n",
  '');
replaceExact(orchestrate,
  "import { reconcileWorkerExecutions } from './worker-executions.js';\n",
  '');
replaceExact(orchestrate,
  "import type {\n  WorkerExecutorFactory,\n  WorkerRunSnapshot,\n} from './application/ports/worker-executor.js';",
  "import type { Saga2RuntimePersistence } from './application/ports/saga2-runtime-persistence.js';\nimport type {\n  WorkerExecutorFactory,\n  WorkerRunSnapshot,\n} from './application/ports/worker-executor.js';");
replaceExact(orchestrate,
  '  workerExecutorFactory: WorkerExecutorFactory;\n',
  '  workerExecutorFactory: WorkerExecutorFactory;\n  persistence: Saga2RuntimePersistence;\n');

replaceBetween(orchestrate,
  'function currentStage(epicId: number): string | null {',
  '/**\n * Count tasks in a stage by status.',
`function currentStage(epicId: number, opts: OrchestrateOptions): string | null {
  return opts.persistence.episodes.currentStage(epicId);
}

`);

replaceBetween(orchestrate,
  'function countActiveTasks(epicId: number): {',
  '/**\n * Find completed tasks in the epic',
`function countActiveTasks(epicId: number, opts: OrchestrateOptions) {
  const stage = currentStage(epicId, opts);
  if (!stage) return { claimable: 0, inFlight: 0, doneInCurrentStage: 0 };
  return opts.persistence.tasks.countStageTasks(epicId, stage);
}

`);

replaceBetween(orchestrate,
  'function generateNextIfReady(epicId: number): { created: number; error: string | null } {',
  '/**\n * Mark the episode as needs-human',
`function generateNextIfReady(
  epicId: number,
  opts: OrchestrateOptions,
): { created: number; error: string | null } {
  const candidates = opts.persistence.tasks.listGenerationCandidateIds(epicId);
  let totalCreated = 0;
  let lastError: string | null = null;
  for (const taskId of candidates) {
    try {
      const result = generateNextForCompletedTask(taskId);
      if (result && result.created.length > 0) totalCreated += result.created.length;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { created: totalCreated, error: lastError };
}

`);

replaceBetween(orchestrate,
  'async function pauseAndAlert(',
  '/** Wipe retry counters for one epic',
`async function pauseAndAlert(
  epicId: number,
  reason: string,
  opts: OrchestrateOptions,
): Promise<void> {
  opts.persistence.episodes.pause(epicId, reason);
  engineHeartbeat(opts, 'PAUSED', \`reason="\${reason.slice(0, 200)}"\`);
}

function clearNeedsHuman(epicId: number, opts: OrchestrateOptions): void {
  opts.persistence.episodes.clearNeedsHuman(epicId);
}

function readLatestBriefDecision(epicId: number, opts: OrchestrateOptions): string | null {
  return opts.persistence.episodes.readLatestBriefDecision(epicId);
}

function readEpisodeMeta(epicId: number, opts: OrchestrateOptions) {
  return opts.persistence.episodes.readHealMetadata(epicId);
}

function readTargetConcurrency(
  epicId: number,
  fallbackConcurrency: number,
  opts: OrchestrateOptions,
): number {
  return opts.persistence.episodes.readTargetConcurrency(epicId, fallbackConcurrency);
}

function writeEpisodeMeta(
  epicId: number,
  patch: Record<string, unknown>,
  opts: OrchestrateOptions,
): void {
  opts.persistence.episodes.patchMetadata(epicId, patch);
}

`);

replaceBetween(orchestrate,
  'async function waitForResume(',
  '/**\n * Attempt to advance the episode by one stage.',
`async function waitForResume(
  epicId: number,
  opts: OrchestrateOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  while (true) {
    if (now() - startedAt > MAX_PAUSE_MIN * 60_000) {
      engineHeartbeat(opts, 'PAUSE_TIMEOUT', \`\${MAX_PAUSE_MIN}min reached — engine exits\`);
      return false;
    }
    if (!opts.persistence.episodes.isNeedsHuman(epicId)) return true;
    await sleep(RESUME_POLL_MS);
  }
}

`);

replaceBetween(orchestrate,
  'function tryAdvanceStage(epicId: number): { advanced: boolean; error: string | null } {',
  '/**\n * Match the gate error against RECOVERY_TREE',
`function tryAdvanceStage(
  epicId: number,
  opts: OrchestrateOptions,
): { advanced: boolean; error: string | null } {
  const stage = currentStage(epicId, opts);
  if (!stage) return { advanced: false, error: \`episode \${epicId} has no workflow row\` };
  if (stage === 'completed' || stage === 'cancelled') return { advanced: false, error: null };
  if (opts.persistence.tasks.hasActiveRecovery(epicId)) return { advanced: false, error: null };

  const to = NEXT_STAGE[stage];
  if (!to) return { advanced: false, error: \`no NEXT stage for '\${stage}'\` };
  try {
    const result = lifecycleHandlers.episode_transition({
      epic_id: epicId,
      to_stage: to as never,
    }) as { changed: boolean };

    if (result.changed) {
      const stranded = opts.persistence.tasks.listStrandedTasks(epicId, stage);
      if (stranded.length > 0) {
        const strandedList = stranded
          .map(task => \`#\${task.id} (\${task.task_kind}, \${task.status})\`)
          .join(', ');
        opts.persistence.tasks.recordPostTransitionSweep(
          epicId,
          strandedList,
          \`Stage '\${stage}' → '\${to}': \${stranded.length} stranded task(s) detected — spawning recovery to resolve: \${strandedList}\`,
        );
        spawnPostTransitionRecovery(epicId, stage, to, stranded, opts);
      }
    }
    return { advanced: result.changed, error: null };
  } catch (err) {
    return { advanced: false, error: err instanceof Error ? err.message : String(err) };
  }
}

`);

replaceBetween(orchestrate,
  'function attemptHeal(epicId: number, stage: string, gateError: string): {',
  '/**\n * Spawn a generic autonomous-recovery task',
`function attemptHeal(
  epicId: number,
  stage: string,
  gateError: string,
  opts: OrchestrateOptions,
): {
  applied: boolean;
  escalate: boolean;
  reason: string;
  taskId: number | null;
} {
  const rules = RECOVERY_TREE[stage];
  if (!rules || rules.length === 0) {
    return { applied: false, escalate: true, reason: \`no recovery rules for stage '\${stage}'\`, taskId: null };
  }
  const rule = rules.find(candidate => candidate.match.test(gateError));
  if (!rule) {
    return { applied: false, escalate: true, reason: \`unmatched gate error for stage '\${stage}': \${gateError.slice(0, 120)}\`, taskId: null };
  }
  const healKey = \`\${epicId}:\${stage}:\${rule.diagnosis}\`;
  const retries = healRetries.get(healKey) ?? 0;
  if (retries >= rule.max_retries) {
    return { applied: false, escalate: true, reason: \`max_retries (\${rule.max_retries}) reached for: \${rule.diagnosis}\`, taskId: null };
  }
  healRetries.set(healKey, retries + 1);
  if (opts.persistence.episodes.projectIdForEpic(epicId) === null) {
    return { applied: false, escalate: true, reason: \`epic \${epicId} has no project\`, taskId: null };
  }

  const prompt = rule.action_prompt.replace(/<EPIC_ID>/g, String(epicId));
  const taskId = opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: \`Recovery: \${rule.diagnosis.slice(0, 80)}\`,
    description: \`RECOVERY TASK (auto-spawned by engine).\\n\\nStage: \${stage}\\nGate error: \${gateError}\\nDiagnosis: \${rule.diagnosis}\\n\\n\${prompt}\`,
    workflowStage: stage,
    tags: [\`stage:\${stage}\`, 'kind:recovery.heal', 'role:recovery'],
    activitySummary: \`Engine auto-spawned recovery task #<TASK_ID> for stage='\${stage}' (attempt \${retries + 1}/\${rule.max_retries}): \${rule.diagnosis}\`,
  });
  return { applied: true, escalate: false, reason: \`spawned task #\${taskId}\`, taskId };
}

`);

replaceBetween(orchestrate,
  'function spawnGenericRecoveryTask(epicId: number, stage: string, gateError: string): number {',
  '/**\n * Spawn a recovery task to resolve STRANDED tasks',
`function spawnGenericRecoveryTask(
  epicId: number,
  stage: string,
  gateError: string,
  opts: OrchestrateOptions,
): number {
  if (opts.persistence.episodes.projectIdForEpic(epicId) === null) return -1;
  const prompt = [
    'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
    '',
    'CONTEXT: an episode gate failed with an error that does not match any',
    'specific recovery rule in RECOVERY_TREE. You are the catch-all.',
    '',
    \`epic_id=\${epicId}\`,
    \`stage=\${stage}\`,
    \`gate_error=\${gateError}\`,
    '',
    'YOUR AUTHORITY:',
    '- Diagnose the root cause via DB queries (artifact_list, task_list, trace_list, artifact_get).',
    '- Apply fixes: trace_add, artifact_update, artifact_save, task_create.',
    '- Move tasks backwards via task_update({_recovery_override: true, status: "todo"}) when a producer left bad output.',
    '- Spawn new tasks via task_create when an upstream producer crashed.',
    '',
    'DO NOT call worker_ask_need unless Cynefin triage in the skill returns "genuine human-only" (credentials, business intent, irreversible destructive action, external authority).',
    'Routine engineering failures (missing traces, stale hashes, draft artifacts, crashed workers) are YOUR job to fix.',
  ].join('\\n');
  return opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: \`Generic recovery: \${gateError.slice(0, 80)}\`,
    description: prompt,
    workflowStage: stage,
    tags: [\`stage:\${stage}\`, 'kind:recovery.heal', 'role:recovery', 'generic:true'],
    activitySummary: \`Engine auto-spawned GENERIC recovery task #<TASK_ID> for stage='\${stage}' (unmatched gate error): \${gateError.slice(0, 120)}\`,
  });
}

`);

replaceBetween(orchestrate,
  'function spawnPostTransitionRecovery(',
  '/**\n * Resolve the JSONL log path',
`function spawnPostTransitionRecovery(
  epicId: number,
  fromStage: string,
  toStage: string,
  stranded: Array<{ id: number; task_kind: string; status: string }>,
  opts: OrchestrateOptions,
): number {
  if (opts.persistence.episodes.projectIdForEpic(epicId) === null) return -1;
  const strandedList = stranded
    .map(task => \`  #\${task.id}: task_kind='\${task.task_kind}', status='\${task.status}'\`)
    .join('\\n');
  const prompt = [
    'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
    '',
    'CONTEXT: the episode just transitioned from one stage to the next,',
    'and some tasks from the PREVIOUS stage are still NOT done. They are',
    'now invisible to workers (the stage-filter blocks cross-stage claims).',
    'You must resolve each one.',
    '',
    \`epic_id=\${epicId}\`,
    \`transition: '\${fromStage}' → '\${toStage}'\`,
    '',
    'STRANDED TASKS:',
    strandedList,
    '',
    'YOUR JOB: For EACH stranded task, decide via MCDA in the skill:',
    '',
    '1. task_kind="summary.stage" or "recovery.heal" → these are BOOKKEEPING.',
    '   The stage is over. Close it with task_update({_recovery_override:true, id:N, status:"done"}).',
    '2. task_kind="verification.ac" in review → the gate already decided. Close it.',
    '3. task_kind="development.code" in review → the gate passed. Close it.',
    '4. Real incomplete work → close if captured downstream, otherwise move it to the new stage.',
    '',
    'DO NOT call worker_ask_need. Resolve by reading task comments and episode state.',
  ].join('\\n');
  return opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: \`Post-transition sweep: \${stranded.length} stranded task(s) from '\${fromStage}'\`,
    description: prompt,
    workflowStage: toStage,
    tags: [\`stage:\${toStage}\`, 'kind:recovery.heal', 'role:recovery', 'post_transition_sweep:true'],
    activitySummary: \`Post-transition sweep: spawned recovery task #<TASK_ID> to resolve \${stranded.length} stranded task(s) from stage='\${fromStage}' → '\${toStage}'\`,
  });
}

`);

replaceExact(orchestrate,
  '  const reconciled = reconcileWorkerExecutions(getDb(), projectId, epicId);',
  '  const reconciled = opts.persistence.executions.reconcile(projectId, epicId);');
replaceBetween(orchestrate,
  '  const tasks = getDb().prepare(\n    `SELECT id, assigned_to FROM tasks',
  '\n\n  let rateLimited = 0;',
  '  const tasks = opts.persistence.tasks.listRateLimitTasks(epicId);');

// Replace only orchestration call sites. Never replace repository method calls.
replaceExact(orchestrate,
  '    return readTargetConcurrency(epicId, concurrency);',
  '    return readTargetConcurrency(epicId, concurrency, opts);');
replaceExact(orchestrate,
  '      writeEpisodeMeta(epicId, { engine_rejected: true, engine_rejected_reason: `PID ${existingPid} already running` });',
  '      writeEpisodeMeta(epicId, { engine_rejected: true, engine_rejected_reason: `PID ${existingPid} already running` }, opts);');
replaceExact(orchestrate,
  '  const projects = projectHandlers.project_list({}) as unknown as Array<{ id: number }>;\n  const project = projects.find(p => p.id === projectId);\n  if (!project) {\n    throw new Error(`orchestrate: project ${projectId} not found`);\n  }\n  const workspaceRoot = resolveProjectWorkspaceForEngine(projectId);',
  '  const workspace = opts.persistence.workspaces.resolve(projectId);\n  if (!workspace.projectExists) {\n    throw new Error(`orchestrate: project ${projectId} not found`);\n  }\n  const workspaceRoot = workspace.workspaceRoot;');
replaceExact(orchestrate,
  "  getDb().prepare('INSERT OR IGNORE INTO episode_workflows (epic_id) VALUES (?)').run(epicId);",
  '  opts.persistence.episodes.ensureWorkflow(epicId);');
replaceExact(orchestrate,
  "  writeEpisodeMeta(epicId, {\n    engine_concurrency: concurrency,\n    engine_pid: process.pid,\n    engine_started_at: new Date().toISOString(),\n  });",
  "  writeEpisodeMeta(epicId, {\n    engine_concurrency: concurrency,\n    engine_pid: process.pid,\n    engine_started_at: new Date().toISOString(),\n  }, opts);");

replaceExact(orchestrate,
  'projectId, epicId, finalStage: currentStage(epicId) ?? \'unknown\'',
  'projectId, epicId, finalStage: currentStage(epicId, opts) ?? \'unknown\'',
  2);
replaceExact(orchestrate,
  '      const stage = currentStage(epicId);',
  '      const stage = currentStage(epicId, opts);');
replaceExact(orchestrate,
  '          engineHeartbeat(opts, \'STAGE_ADVANCED\', `${stage} → ${currentStage(epicId)}`);',
  '          engineHeartbeat(opts, \'STAGE_ADVANCED\', `${stage} → ${currentStage(epicId, opts)}`);');
replaceExact(orchestrate,
  '  const finalStage = currentStage(epicId) ?? \'unknown\';',
  '  const finalStage = currentStage(epicId, opts) ?? \'unknown\';');
replaceExact(orchestrate,
  '      const counts = countActiveTasks(epicId);',
  '      const counts = countActiveTasks(epicId, opts);');
replaceExact(orchestrate,
  '        const gen = generateNextIfReady(epicId);',
  '        const gen = generateNextIfReady(epicId, opts);');
replaceExact(orchestrate,
  '          const decision = readLatestBriefDecision(epicId);',
  '          const decision = readLatestBriefDecision(epicId, opts);');
replaceExact(orchestrate,
  '        const advance = tryAdvanceStage(epicId);',
  '        const advance = tryAdvanceStage(epicId, opts);');
replaceExact(orchestrate,
  '          const meta = readEpisodeMeta(epicId);',
  '          const meta = readEpisodeMeta(epicId, opts);');
replaceExact(orchestrate,
  '          const heal = attemptHeal(epicId, stage, advance.error);',
  '          const heal = attemptHeal(epicId, stage, advance.error, opts);');
replaceExact(orchestrate,
  '          writeEpisodeMeta(epicId, { lastHealError: advance.error, lastHealAttempt: new Date().toISOString() });',
  '          writeEpisodeMeta(epicId, { lastHealError: advance.error, lastHealAttempt: new Date().toISOString() }, opts);');
replaceExact(orchestrate,
  '            const genericTaskId = spawnGenericRecoveryTask(epicId, stage, advance.error);',
  '            const genericTaskId = spawnGenericRecoveryTask(epicId, stage, advance.error, opts);');
replaceExact(orchestrate,
  '\n            clearNeedsHuman(epicId);',
  '\n            clearNeedsHuman(epicId, opts);',
  2);
replaceExact(orchestrate,
  '\n          clearNeedsHuman(epicId);',
  '\n          clearNeedsHuman(epicId, opts);');
replaceExact(orchestrate,
  '        targetConcurrency = readTargetConcurrency(epicId, concurrency);',
  '        targetConcurrency = readTargetConcurrency(epicId, concurrency, opts);');

replaceBetween(orchestrate,
  '        const drainable = getDb().prepare(',
  '        const claimable = drainable?.claimable ?? 0;',
  '        const drainable = opts.persistence.tasks.terminalBookkeepingCounts(epicId, stage);\n');
replaceExact(orchestrate,
  '        const claimable = drainable?.claimable ?? 0;',
  '        const claimable = drainable.claimable;');
replaceExact(orchestrate,
  '        const inFlight = drainable?.in_flight ?? 0;',
  '        const inFlight = drainable.inFlight;');
replaceBetween(orchestrate,
  '      const doneTasks = getDb().prepare(',
  '\n\n      // Reconcile durable process state',
  '      opts.persistence.tasks.reevaluateDoneDependencies(epicId);');
replaceBetween(orchestrate,
  '/**\n * Resolve the workspace root for spawning workers.',
  '/** Re-export for tests. */',
  '');

// E2E uses the same concrete adapters and model-route boundary as production.
replaceExact(
  'tests/e2e-pipeline.test.mjs',
  "const { createLegacyClaudeWorkerExecutorFactory } = await import(\n  '../dist/infrastructure/workers/legacy-claude-worker-executor-factory.js'\n);",
  "const { createLegacyClaudeWorkerExecutorFactory } = await import(\n  '../dist/infrastructure/workers/legacy-claude-worker-executor-factory.js'\n);\nconst {\n  SqliteEpisodeRuntimeRepository,\n  SqliteExecutionRuntimeRepository,\n  SqliteTaskRuntimeRepository,\n} = await import('../dist/infrastructure/persistence/sqlite-saga2-runtime-repositories.js');\nconst { SqliteWorkspaceResolver } = await import(\n  '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'\n);");
replaceExact(
  'tests/e2e-pipeline.test.mjs',
  '  // The mock process is injected through the same WorkerExecutorFactory port',
  "  const persistence = {\n    episodes: new SqliteEpisodeRuntimeRepository(),\n    tasks: new SqliteTaskRuntimeRepository(),\n    executions: new SqliteExecutionRuntimeRepository(),\n    workspaces: new SqliteWorkspaceResolver(),\n  };\n\n  // The mock process is injected through the same WorkerExecutorFactory port");
replaceExact(
  'tests/e2e-pipeline.test.mjs',
  "  const workerExecutorFactory = createLegacyClaudeWorkerExecutorFactory({\n    spawn:",
  "  const workerExecutorFactory = createLegacyClaudeWorkerExecutorFactory({\n    modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),\n    spawn:");
replaceExact(
  'tests/e2e-pipeline.test.mjs',
  '    workerExecutorFactory,\n    sleep:',
  '    workerExecutorFactory,\n    persistence,\n    sleep:');

// Characterization follows the moved persistence anchors and guards 92a2e9d.
replaceExact(
  'tests/characterization/saga2-runtime-contracts.test.mjs',
  "    'workerExecutorFactory',\n    'getDb',\n    'generateNextForCompletedTask',\n    'lifecycleHandlers',\n    'reconcileWorkerExecutions',",
  "    'workerExecutorFactory',\n    'persistence',\n    'generateNextForCompletedTask',\n    'lifecycleHandlers',");
replaceExact(
  'tests/characterization/saga2-runtime-contracts.test.mjs',
  "test('worker infrastructure keeps claim, recovery and concrete runner anchors', () => {",
`test('persistence adapters keep the moved SQLite and execution anchors', () => {
  const source = read('src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts');
  assertIncludesAll(source, [
    'episode_workflows',
    'worker_executions',
    'task_dependencies',
    'createRecoveryTask',
    'reconcileWorkerExecutions',
    'reevaluateDownstream',
    'active_model_effort',
    'readWorkerModelRoute',
  ], 'sqlite-saga2-runtime-repositories.ts');
});

test('model route remains model-config-driven across the worker boundary', () => {
  const runner = read('tracker-view/claude-runner.mjs');
  const factory = read('src/infrastructure/workers/legacy-claude-worker-executor-factory.ts');
  assertIncludesAll(runner, [
    "const effortArg = isLmstudio ? null : (am.effort || 'high');",
    "args.splice(modelIdx + 2, 0, '--effort', effortArg);",
  ], 'claude-runner.mjs');
  assert.ok(!runner.includes("'--effort', 'xhigh'"), 'xhigh must not be hardcoded');
  assertIncludesAll(factory, [
    'modelRouteReader',
    'getActiveModel: modelRouteReader',
  ], 'legacy-claude-worker-executor-factory.ts');
});

test('worker infrastructure keeps claim, recovery and concrete runner anchors', () => {`);

// Architecture gate: the pump has no persistence and model effort is ported.
const architecturePath = 'tests/architecture/saga2-boundaries.test.mjs';
let architecture = read(architecturePath);
architecture += `\n\ntest('orchestration pump has no direct persistence access after Phase B item 5', () => {\n  const source = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'orchestrate.ts'), 'utf8');\n  assert.doesNotMatch(source, /\\bgetDb\\b/);\n  assert.doesNotMatch(source, /\\.prepare\\s*\\(/);\n  assert.doesNotMatch(source, /reconcileWorkerExecutions/);\n  assert.match(source, /Saga2RuntimePersistence/);\n  assert.match(source, /persistence\\.episodes/);\n  assert.match(source, /persistence\\.tasks/);\n  assert.match(source, /persistence\\.executions/);\n  assert.match(source, /persistence\\.workspaces/);\n});\n\ntest('worker model route preserves provider and effort from episode persistence', () => {\n  const port = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'application', 'ports', 'worker-executor.ts'), 'utf8');\n  const composition = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'composition-root.ts'), 'utf8');\n  const runner = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tracker-view', 'claude-runner.mjs'), 'utf8');\n  assert.match(port, /WorkerModelRoute/);\n  assert.match(port, /effort: string \\| null/);\n  assert.match(composition, /readWorkerModelRoute/);\n  assert.match(runner, /isLmstudio \\? null : \\(am\\.effort \\|\\| 'high'\\)/);\n  assert.doesNotMatch(runner, /'--effort', 'xhigh'/);\n});\n`;
write(architecturePath, architecture);

const finalSource = read(orchestrate);
for (const forbidden of ['getDb', '.prepare(', 'reconcileWorkerExecutions', 'resolveProjectWorkspaceForEngine']) {
  if (finalSource.includes(forbidden)) throw new Error(`orchestrate.ts still contains persistence anchor: ${forbidden}`);
}
if (!finalSource.includes('persistence: Saga2RuntimePersistence')) {
  throw new Error('orchestrate.ts lost injected persistence contract');
}
console.log('Phase B persistence migration applied.');
