/**
 * Saga 3 — CLI entrypoint.
 *
 * Takes a mandate text, builds the episode, runs the engine.
 *
 * Pump loop (saga3 MCP protocol):
 *   1. controller.stepEpisode() → did_work (authorized one condition deficit)
 *   2. buildWorkerPrompt(...) → system prompt for the claude worker
 *   3. buildMcpConfig(saga3ServerPath) → --mcp-config JSON (only saga3_* tools)
 *   4. Spawn claude with the prompt; stream-json is tee'd to a JSONL log under
 *      board-runs so tracker-view can tail the live worker.
 *   5. The worker does its work and writes results DIRECTLY to the DB through
 *      the saga3_* MCP tools (saga3_propose_artifact, saga3_propose_verification,
 *      saga3_complete). No JSON is parsed from claude's stdout.
 *   6. After claude exits: reload the addressed condition's status from
 *      saga3_condition_instances. If the worker flipped it to True, the
 *      controller advances on the next step.
 *
 * Usage:
 *   DB_PATH=~/.zcode/saga.db SAGA3_WORKSPACE=/path/to/repo \
 *     node dist/saga3/app/cli.js "Build a calculator app"
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { spawn } from 'node:child_process';
import { EpisodeController, loadConditionsFromDb, saveConditionToDb } from './controller.js';
import type { EpisodeContext } from './controller.js';
import { OracleRegistry } from '../evidence/attestation.js';
import { BudgetLedger } from '../budgets/budget-ledger.js';
import { allSkills } from '../executions/skill-registry.js';
import {
  PIPELINE_CONDITIONS,
  PIPELINE_ACTIONS,
  MANDATORY_CONDITIONS,
  resolveTaskForCondition,
} from '../domain/pipeline-contracts.js';
import { prodPorts } from '../adapters/prod-ports.js';
import { initSaga3Schema } from '../domain/schema.js';
import { buildWorkerPrompt, buildMcpConfig } from '../executions/prompt-builder.js';

const mandate = process.argv[2];
if (!mandate) {
  console.error('Usage: node dist/saga3/app/cli.js "your mandate text"');
  process.exit(1);
}

const workspace = process.env.SAGA3_WORKSPACE ?? process.cwd();
if (!existsSync(workspace)) {
  console.error(`Workspace not found: ${workspace}`);
  process.exit(1);
}

// Skills live OUTSIDE the product workspace (they are shared assets installed
// at the user level and shipped with saga-mcp source). The worker's cwd is the
// product workspace, which does NOT contain skills/, so a relative path fails
// with "File does not exist". Resolve an absolute skills root:
//   1. SAGA3_SKILLS_ROOT env override (highest priority)
//   2. <saga-mcp source>/skills  — three levels up from dist/saga3/app/
//   3. ~/.zcode/skills           — user-installed skills fallback
const candidateSkillsRoots = [
  process.env.SAGA3_SKILLS_ROOT,
  path.join(__dirname, '..', '..', '..', 'skills'),
  path.join(os.homedir(), '.zcode', 'skills'),
].filter((p): p is string => !!p && existsSync(p));
const skillsRoot = candidateSkillsRoots[0] ?? path.join(os.homedir(), '.zcode', 'skills');
if (!existsSync(skillsRoot)) {
  console.error(`Skills root not found. Tried: ${candidateSkillsRoots.join(', ')}`);
  process.exit(1);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const projectId = Number(process.env.SAGA3_PROJECT_ID ?? 0);
const epicId = Number(process.env.SAGA3_EPIC_ID ?? 0);
const configuredConcurrency = Number(process.env.SAGA3_MAX_CONCURRENCY ?? 1);


// --- Open the DB and apply the saga3 schema before anything reads from it ---

// We need a real DB for prodPorts, but for the walking skeleton we can use
// an in-memory approach. For now, create a minimal DB wrapper.
import Database from 'better-sqlite3';
const dbPath = process.env.DB_PATH;
let db: Database.Database;
if (dbPath && existsSync(dbPath)) {
  db = new Database(dbPath);
} else {
  // In-memory for testing
  db = new Database(':memory:');
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Ensure the saga3 tables exist so the worker (via the saga3 MCP server) can
// write its condition / artifact / evidence rows, and so we can reload the
// condition status after the worker exits.
initSaga3Schema(db);

// --- Build episode context ---

const constitutionHash = sha256(mandate);
// Stable identity of the frozen episode baseline. Runtime file observations
// belong in oracle evidence; using the live dirty-tree hash here made every
// engine restart detach from its own progress.
const sourceFingerprint = sha256(`${path.resolve(workspace)}\n${epicId}\n${constitutionHash}`);
const previousSpec = db.prepare(
  `SELECT id, generation, constitution_hash, platform_policy_hash,
          governance_hash, source_baseline, environment_baseline, sealed
     FROM saga3_episode_specs WHERE epic_id=?
     ORDER BY generation DESC LIMIT 1`,
).get(epicId) as any;
const generation = previousSpec && previousSpec.constitution_hash !== constitutionHash
  ? previousSpec.generation + 1
  : previousSpec?.generation ?? 1;
const spec = previousSpec && previousSpec.constitution_hash === constitutionHash ? {
  id: previousSpec.id,
  generation: previousSpec.generation,
  platformPolicyHash: previousSpec.platform_policy_hash,
  constitutionHash: previousSpec.constitution_hash,
  governanceHash: previousSpec.governance_hash,
  sourceBaseline: previousSpec.source_baseline,
  environmentBaseline: previousSpec.environment_baseline,
  sealed: previousSpec.sealed === 1,
} : {
  id: `spec-p${projectId}-e${epicId}-g${generation}-${constitutionHash.slice(0, 8)}`,
  generation,
  platformPolicyHash: sha256('platform-default'),
  constitutionHash,
  governanceHash: sha256('governance-default'),
  sourceBaseline: sourceFingerprint,
  environmentBaseline: process.platform,
  sealed: true,
};
db.prepare(
  `INSERT OR IGNORE INTO saga3_episode_specs
     (id, project_id, epic_id, mandate, controller_version, generation,
      platform_policy_hash, constitution_hash, governance_hash,
      source_baseline, environment_baseline, sealed)
   VALUES (?, ?, ?, ?, 'v3', ?, ?, ?, ?, ?, ?, ?)`,
).run(spec.id, projectId, epicId, mandate, spec.generation,
  spec.platformPolicyHash, spec.constitutionHash, spec.governanceHash,
  spec.sourceBaseline, spec.environmentBaseline, spec.sealed ? 1 : 0);

// Expose the frozen episode spec id to the environment so:
//   (a) buildMcpConfig() below can read it, and
//   (b) the spawned saga3 MCP server (a child node process) inherits it and
//       scopes every saga3_* tool call to this episode.
process.env.SAGA3_EPISODE_SPEC_ID = spec.id;

// Load (or seed) conditions from SQLite so a restart picks up where we left off.
const conditions = loadConditionsFromDb(db, spec.id);
// MandatePresent = True (mandate was received) — idempotent on every boot.
const mandateCond = conditions.get('MandatePresent') as { status: string; sourceFingerprint: string | null };
mandateCond.status = 'True';
mandateCond.sourceFingerprint = sourceFingerprint;
db.prepare(
  `INSERT OR IGNORE INTO saga3_evidence_records
     (id, episode_spec_id, condition_type, obligation_id, generation,
      source_fingerprint, environment_fingerprint, oracle_id, oracle_version,
      trust_class, verdict, raw_digest, observed_at, freshness_max_age_ms)
   VALUES (?, ?, 'MandatePresent', 'mandate', ?, ?, ?, 'mandate-check', '1',
           'deterministic', 'passed', ?, ?, ?)`,
).run(`ev-mandate-${spec.id}`, spec.id, spec.generation, sourceFingerprint,
  process.platform, sha256(mandate), Date.now(), Number.MAX_SAFE_INTEGER);
saveConditionToDb(db, mandateCond as any);

const oracleRegistry = new OracleRegistry();
for (const c of PIPELINE_CONDITIONS) {
  oracleRegistry.register({
    oracleId: c.oracleRequired,
    version: '1',
    trustClass: 'deterministic',
    scope: c.conditionType,
    proxyAllowed: false,
  });
}

const budget = new BudgetLedger(spec.id);
budget.allocate(10000);

// --- saga3 MCP wiring ---
// Absolute path to the compiled saga3 MCP server entry. Task 3 produces
// dist/saga3/app/mcp-server.js; cli.ts compiles next to it, so __dirname
// resolves correctly in the CJS output (dist/saga3/app/).
const saga3ServerPath = path.join(__dirname, 'mcp-server.js');

// One --mcp-config temp file per CLI process, mirroring claude-runner.mjs
// (line 122). Written once — the config does not change between steps — and
// cleaned up on exit.
const mcpConfigPath = path.join(os.tmpdir(), `saga3-claude-mcp-${process.pid}.json`);
writeFileSync(
  mcpConfigPath,
  JSON.stringify(buildMcpConfig(saga3ServerPath), null, 2),
  'utf8',
);

// board-runs log root — same location tracker-view reads for the v2 runner,
// so a saga3 episode shows up alongside v2 board runs in the live view.
const logRoot = path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
const claudePath = process.env.SAGA_CLAUDE_PATH ?? 'claude';

// --- Build ports ---

const ports = prodPorts(db, workspace);

// --- Build context ---

const ctx: EpisodeContext = {
  spec,
  conditionContracts: PIPELINE_CONDITIONS,
  actionContracts: PIPELINE_ACTIONS,
  conditions,
  skills: allSkills(),
  budget,
  oracleRegistry,
  currentSourceFingerprint: sourceFingerprint,
  currentEnvironmentFingerprint: process.platform,
  repositoryRoot: workspace,
  heldClaims: [],
  completedIntents: new Set(),
  dependencyEdges: [],
  certificate: null,
  db,
  leaseEpoch: 0,
  currentAssignment: null,
  currentIntent: null,
  maxConcurrency: Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency : 1,
};

// --- Custom pump: did_work → spawn worker (saga3 MCP) → reload DB ---

const controller = new EpisodeController(ports, ctx);

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function setEngineLifecycle(running: boolean, extra: Record<string, unknown> = {}): void {
  if (!epicId) return;
  try {
    const row = db.prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId) as { metadata: string } | undefined;
    if (!row) return;
    const metadata = JSON.parse(row.metadata || '{}');
    // A superseded process must not mark its replacement as stopped.
    if (!running && metadata.engine_pid && Number(metadata.engine_pid) !== process.pid) return;
    Object.assign(metadata, extra, {
      controller_version: 'v3',
      engine_running: running ? 1 : 0,
      engine_pid: running ? process.pid : null,
      engine_heartbeat_at: new Date().toISOString(),
    });
    db.prepare(`UPDATE episode_workflows SET metadata=?, updated_at=datetime('now') WHERE epic_id=?`)
      .run(JSON.stringify(metadata), epicId);
  } catch (e) {
    log(`(engine lifecycle write skipped: ${e instanceof Error ? e.message : 'error'})`);
  }
}

/**
 * Spawn the claude worker for one condition deficit.
 *
 * The worker communicates its result back exclusively through the saga3_*
 * MCP tools (which write to the DB). We do NOT parse its stdout for a result
 * payload — stdout is only tee'd to a JSONL log for tracker-view.
 *
 * Returns claude's exit code (0 = clean exit, which for a saga3 worker means
 * it called saga3_complete and stopped as instructed).
 */
function spawnWorker(
  conditionType: string,
  obligationId: string,
  skillId: string,
  role: string,
  executionId: string,
  workerId: string,
  onSpawn: (pid: number | null, logFile: string, taskId: number) => void,
): Promise<number> {
  const prompt = buildWorkerPrompt({
    conditionType,
    obligationId,
    skillId,
    workspaceRoot: workspace,
    skillsRoot,
    episodeSpecId: spec.id,
    generation: spec.generation,
    role,
    oracleId: PIPELINE_CONDITIONS.find((item) => item.conditionType === conditionType)?.oracleRequired,
  });

  const args = [
    '-p',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
  ];

  // Model routing: read active_model from episode_workflows metadata (same as old claude-runner).
  try {
    const ew = db.prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId) as { metadata: string } | undefined;
    if (ew?.metadata) {
      const meta = JSON.parse(ew.metadata);
      if (meta.active_model) {
        args.push('--model', meta.active_model);
      }
      // LM Studio env override (same as old claude-runner launch()).
      if (meta.active_provider === 'lmstudio') {
        log(`Using LM Studio provider: model=${meta.active_model}`);
      }
    }
  } catch { /* non-fatal — use default model */ }

  args.push(prompt);

  // Per-step JSONL log under board-runs — SAME convention as old claude-runner:
  // board-<projectId>-<pid>-<ts>/task-<taskId>-<workerId>.jsonl
  const runDir = path.join(logRoot, `board-${projectId}-${process.pid}-${Date.now()}`);
  try { mkdirSync(runDir, { recursive: true }); } catch { /* best effort */ }
  // Resolve a REAL tasks.id for this condition (v2 contract: one task per unit
  // of work, addressed by real task_id). This replaces the earlier synthetic
  // 9M id hack: synthetic ids were invisible to the board (no #N→title mapping)
  // and broke the operator's mental model. With a real task row, the board
  // renders "🤖 #103 Discovery: ..." exactly as in v2, and worker_executions'
  // UNIQUE(task_id) WHERE state active contract still holds.
  const taskId = resolveTaskForCondition(db, epicId, conditionType, mandate);
  const logFile = path.join(runDir, `task-${taskId}-${workerId}.jsonl`);

  return new Promise<number>((resolve) => {
    let logStream: ReturnType<typeof createWriteStream> | null = null;
    try { logStream = createWriteStream(logFile, { flags: 'a' }); } catch { /* best effort */ }

    const child = spawn(claudePath, args, {
      cwd: workspace,
      env: {
        ...process.env,
        // Inherited by the spawned saga3 MCP server (via --mcp-config) so it
        // opens the same DB and is scoped to this episode.
        SAGA3_EPISODE_SPEC_ID: spec.id,
        SAGA3_EXECUTION_ID: executionId,
        SAGA3_WORKER_ID: workerId,
        SAGA3_CONDITION: conditionType,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn(child.pid ?? null, logFile, taskId);

    // Tee stdout/stderr to the JSONL log only — we do NOT accumulate or parse
    // it. The saga3 protocol routes results through the DB, not stdout.
    if (logStream) {
      child.stdout?.pipe(logStream, { end: false });
      child.stderr?.pipe(logStream, { end: false });
    }

    child.once('error', (e) => {
      if (logStream) logStream.end();
      log(`WORKER SPAWN ERROR: ${e.message}`);
      resolve(1);
    });

    child.once('close', (code) => {
      if (logStream) logStream.end();
      resolve(code ?? 1);
    });
  });
}

/**
 * Reload one condition's status from saga3_condition_instances into the live
 * ctx.conditions map. The saga3 worker (via saga3_complete) writes the row; we
 * read it back so the controller's next step sees the new status.
 *
 * Returns the DB status ('True' | 'False' | 'Unknown') or null if no row.
 */
function reloadConditionFromDb(conditionType: string, obligationId: string): string | null {
  try {
    const row = db.prepare(
      `SELECT status FROM saga3_condition_instances
       WHERE episode_spec_id = ? AND condition_type = ? AND obligation_id = ?
         AND scope_type = 'episode' AND scope_id = ''
       LIMIT 1`,
    ).get(spec.id, conditionType, obligationId) as { status: string } | undefined;
    return row?.status ?? null;
  } catch {
    // Table missing or query error — treat as "no signal".
    return null;
  }
}

async function runEpisode(): Promise<void> {
  setEngineLifecycle(true, {
    episode_spec_id: spec.id,
    engine_started_at: new Date().toISOString(),
    engine_last_error: null,
    terminal_outcome: null,
  });
  log(`Saga 3 starting. Mandate: ${mandate.slice(0, 80)}...`);
  log(`Workspace: ${workspace}`);
  log(`Conditions: ${PIPELINE_CONDITIONS.length} (${MANDATORY_CONDITIONS.length} mandatory)`);
  log(`MCP server: ${saga3ServerPath}`);
  log(`MCP config: ${mcpConfigPath}`);
  log('');

  let step = 0;
  const maxSteps = 200;

  // Write a crash log file so we can debug when stdio is ignored.
  const crashLog = path.join(os.homedir(), '.zcode', 'cli', 'saga3-crash.log');
  function crashLogWrite(msg: string): void {
    try { writeFileSync(crashLog, `[${new Date().toISOString()}] ${msg}\n`, { flag: 'a' }); } catch { /* best effort */ }
  }
  crashLogWrite(`=== saga3 started, pid=${process.pid} ===`);

  while (step < maxSteps) {
    step++;

    // The frontend selector is the runtime source of truth. Re-read it before
    // every control decision so changing the limit does not require restart.
    try {
      const row = db.prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId) as { metadata: string } | undefined;
      const selected = Number(JSON.parse(row?.metadata || '{}').engine_concurrency);
      if (Number.isInteger(selected) && selected > 0) ctx.maxConcurrency = selected;
    } catch { /* retain the last valid user-selected value */ }

    let result;
    try {
      result = controller.stepEpisode();
      crashLogWrite(`step ${step}: kind=${result.kind}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : '';
      log(`ERROR step ${step}: ${msg}`);
      crashLogWrite(`ERROR step ${step}: ${msg}\n${stack}`);
      setEngineLifecycle(false, { engine_last_error: msg });
      break;
    }

    if (result.kind === 'terminal') {
      log(`TERMINAL: ${result.outcome} at step ${step}`);
      if (result.certificate) {
        log(`Certificate: satisfied=${result.certificate.satisfiedConditions.length}, unresolved=${result.certificate.unresolvedConditions.length}`);
        log(`Reason: ${result.certificate.causalReason}`);
      }
      break;
    }

    if (result.kind === 'quiescent') {
      setEngineLifecycle(false, { engine_last_error: 'Controller became quiescent without a terminal certificate' });
      log(`QUIESCENT at step ${step} — no deficits, but not terminal. Something is wrong.`);
      break;
    }

    if (result.kind === 'waiting_until') {
      // Brief wait then retry.
      await new Promise<void>((r) => setTimeout(r, 100));
      continue;
    }

    if (result.kind === 'did_work') {
      // The controller authorized work. Now we need to spawn a worker.
      const assignment = ctx.currentAssignment;
      if (!assignment) {
        log(`WARN: did_work but no assignment at step ${step}`);
        continue;
      }

      const intent = ctx.currentIntent;
      if (!intent) {
        log(`WARN: did_work but no authorized intent at step ${step}`);
        ctx.currentAssignment = null;
        continue;
      }
      const targetCondition = intent.targetCondition;

      // Find the action contract for this condition.
      const action = PIPELINE_ACTIONS.find((a) => a.targetCondition === targetCondition);
      const skillId = intent.skillId ?? action?.skillId ?? 'saga-worker';
      const obligationId = intent.targetObligation;
      const role = allSkills().find((s) => s.skillId === skillId)?.role ?? 'worker';

      const configuredMaxAttempts = Number(process.env.SAGA3_MAX_ATTEMPTS_PER_CONDITION ?? 3);
      const maxAttempts = Number.isInteger(configuredMaxAttempts) && configuredMaxAttempts > 0
        ? configuredMaxAttempts : 3;
      const attempts = db.prepare(
        `SELECT COUNT(*) AS count FROM worker_executions
          WHERE run_id=? AND json_extract(metadata,'$.condition_type')=?
            AND state IN ('exited','spawn_failed','lost','terminated')`,
      ).get(`saga3-run-${spec.id}`, targetCondition) as { count: number };
      if (attempts.count >= maxAttempts) {
        const satisfied = [...ctx.conditions.values()].filter((item) => item.status === 'True').map((item) => item.conditionType);
        const unresolved = [...ctx.conditions.values()].filter((item) => item.status !== 'True').map((item) => item.conditionType);
        const reason = `Recovery budget exhausted for ${targetCondition} after ${attempts.count} attempts`;
        db.prepare(
          `INSERT OR REPLACE INTO saga3_outcome_certificates
             (episode_spec_id, outcome, causal_reason, generation, source_fingerprint,
              satisfied_conditions, unresolved_conditions, certified_at)
           VALUES (?, 'RESOURCE_EXHAUSTED', ?, ?, ?, ?, ?, ?)`,
        ).run(spec.id, reason, spec.generation, sourceFingerprint,
          JSON.stringify(satisfied), JSON.stringify(unresolved), Date.now());
        setEngineLifecycle(false, { engine_last_error: reason, terminal_outcome: 'RESOURCE_EXHAUSTED' });
        log(`TERMINAL: RESOURCE_EXHAUSTED - ${reason}`);
        break;
      }

      log(`STEP ${step}: condition=${targetCondition} skill=${skillId} — spawning worker (saga3 MCP)...`);

      // Write worker_executions row so tracker-view shows the worker.
      const workerId = `saga3-${step}-${Date.now()}`;
      const executionId = `saga3-exec-${step}-${Date.now()}`;
      try {
        // The authoritative execution row is inserted by spawnWorker's
        // onSpawn callback, after the real worker PID is available.
      } catch (e) {
        // Old DB may not have the table — non-fatal.
        log(`(worker_executions write skipped: ${e instanceof Error ? e.message : 'error'})`);
      }

      // Spawn the claude worker. It writes its result to the DB through the
      // saga3_* MCP tools; we only collect the exit code here.
      const exitCode = await spawnWorker(
        targetCondition, obligationId, skillId, role, executionId, workerId,
        (pid, logFile, taskId) => {
          if (taskId <= 0) return;
          try {
            // Retire any prior active execution for this condition's synthetic
            // task_id before inserting the new one. The partial unique index
            // idx_worker_executions_one_active_task blocks a second running row
            // on the same task_id, so an orphaned row from a crashed prior
            // worker would otherwise make this INSERT fail. Marking it 'lost'
            // (not 'exited') signals the prior worker did not finish cleanly.
            db.prepare(
              `UPDATE worker_executions
                  SET state='lost', finished_at=datetime('now'),
                      last_error='superseded by new attempt'
                WHERE task_id=? AND state IN ('reserved','running','cancel_requested')`,
            ).run(taskId);
            db.prepare(
              `INSERT INTO worker_executions
                 (execution_id, run_id, project_id, epic_id, task_id, worker_id,
                  machine_id, launcher, state, phase, pid, log_path, reserved_at,
                  started_at, metadata)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),?)`,
            ).run(executionId, `saga3-run-${spec.id}`, projectId, epicId, taskId,
              workerId, os.hostname(), 'saga3-cli', 'running', 'executing', pid,
              logFile, JSON.stringify({ condition_type: targetCondition, obligation_id: obligationId }));
            db.prepare(
              `UPDATE saga3_worker_assignments
                  SET worker_id=?, execution_id=?, state='running', updated_at=datetime('now')
                WHERE id=?`,
            ).run(workerId, executionId, assignment.id);
            db.prepare(
              `UPDATE saga3_work_intents SET status='assigned', updated_at=datetime('now') WHERE id=?`,
            ).run(intent.id);
          } catch (e) {
            log(`(worker_executions write skipped: ${e instanceof Error ? e.message : 'error'})`);
          }
        },
      );

      // Update worker_executions: worker finished.
      try {
        db.prepare(
          `UPDATE worker_executions SET state='exited', phase='finishing',
           finished_at=datetime('now'), exit_code=?
           WHERE execution_id=?`,
        ).run(exitCode, executionId);
      } catch { /* non-fatal */ }

      // Reload the condition status the saga3 worker just wrote to the DB.
      // No JSON parsing from stdout — the DB is the single source of truth.
      const dbStatus = reloadConditionFromDb(targetCondition, obligationId);
      const cond = ctx.conditions.get(targetCondition);
      if (dbStatus && cond) {
        (cond as { status: string }).status = dbStatus;
        // Stamp a source fingerprint so evaluateCondition trusts a True.
        if (dbStatus === 'True') {
          (cond as { sourceFingerprint: string | null }).sourceFingerprint = ctx.currentSourceFingerprint;
        }
      }

      log(`CONDITION ${targetCondition}: ${cond?.status ?? 'missing'} (db=${dbStatus ?? 'n/a'}, exit=${exitCode})`);
      log('');

      const verified = exitCode === 0 && dbStatus === 'True';
      db.prepare(
        `UPDATE saga3_worker_assignments SET state=?, updated_at=datetime('now') WHERE id=?`,
      ).run(verified ? 'verified' : 'failed', assignment.id);
      db.prepare(
        `UPDATE saga3_work_intents SET status=?, updated_at=datetime('now') WHERE id=?`,
      ).run(verified ? 'completed' : 'failed', intent.id);

      if (exitCode !== 0) {
        log(`WARN: worker exited code=${exitCode} for ${targetCondition}`);
      }

      // Mark this work as completed and clear the assignment for the next step.
      ctx.completedIntents.add(assignment.id);
      ctx.currentAssignment = null;
      ctx.currentIntent = null;
    }
  }

  if (step >= maxSteps) {
    log(`MAX STEPS (${maxSteps}) reached without terminal.`);
    setEngineLifecycle(false, { engine_last_error: `Maximum controller steps reached (${maxSteps})` });
  }

  log(`Episode finished after ${step} steps.`);
}

// Clean up the temp MCP config on exit.
function cleanup(): void {
  setEngineLifecycle(false, { engine_stopped_at: new Date().toISOString() });
  try { rmSync(mcpConfigPath, { force: true }); } catch { /* best effort */ }
}
process.once('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });

runEpisode()
  .then(() => cleanup())
  .catch((e) => {
    console.error('FATAL:', e);
    setEngineLifecycle(false, { engine_last_error: e instanceof Error ? e.message : String(e) });
    cleanup();
    process.exit(1);
  });
