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
import { EpisodeController, loadConditionsFromDb } from './controller.js';
import type { EpisodeContext } from './controller.js';
import { OracleRegistry } from '../evidence/attestation.js';
import { BudgetLedger } from '../budgets/budget-ledger.js';
import { allSkills } from '../executions/skill-registry.js';
import {
  PIPELINE_CONDITIONS,
  PIPELINE_ACTIONS,
  MANDATORY_CONDITIONS,
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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

const spec = {
  id: `spec-${Date.now()}`,
  generation: 1,
  platformPolicyHash: sha256('platform-default'),
  constitutionHash: sha256(mandate),
  governanceHash: sha256('governance-default'),
  sourceBaseline: sha256('init'),
  environmentBaseline: process.platform,
  sealed: true,
};

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
mandateCond.sourceFingerprint = sha256('init');

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
  currentSourceFingerprint: sha256('init'),
  currentEnvironmentFingerprint: process.platform,
  repositoryRoot: workspace,
  heldClaims: [],
  completedIntents: new Set(),
  dependencyEdges: [],
  certificate: null,
  db,
  leaseEpoch: 0,
  currentAssignment: null,
};

// --- Custom pump: did_work → spawn worker (saga3 MCP) → reload DB ---

const controller = new EpisodeController(ports, ctx);

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
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
): Promise<number> {
  const prompt = buildWorkerPrompt({
    conditionType,
    obligationId,
    skillId,
    workspaceRoot: workspace,
    episodeSpecId: spec.id,
    generation: spec.generation,
    role,
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
  const epicId = Number(process.env.SAGA3_EPIC_ID ?? 4);
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

  // Per-step JSONL log under board-runs (same convention as the v2 runner and
  // CliModelPort), so tracker-view can tail the live worker stream.
  const runDir = path.join(logRoot, `saga3-${spec.id}-${process.pid}`);
  try { mkdirSync(runDir, { recursive: true }); } catch { /* best effort */ }
  const logFile = path.join(runDir, `cond-${conditionType}-${workerId}.jsonl`);

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
  log(`Saga 3 starting. Mandate: ${mandate.slice(0, 80)}...`);
  log(`Workspace: ${workspace}`);
  log(`Conditions: ${PIPELINE_CONDITIONS.length} (${MANDATORY_CONDITIONS.length} mandatory)`);
  log(`MCP server: ${saga3ServerPath}`);
  log(`MCP config: ${mcpConfigPath}`);
  log('');

  let step = 0;
  const maxSteps = 200;

  while (step < maxSteps) {
    step++;

    let result;
    try {
      result = controller.stepEpisode();
    } catch (e) {
      log(`ERROR step ${step}: ${e instanceof Error ? e.message : String(e)}`);
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

      // Find the deficit condition that was addressed.
      const statuses: Record<string, string> = {};
      for (const [key, cond] of ctx.conditions) {
        statuses[key] = cond.status;
      }
      const deficits = Object.entries(statuses)
        .filter(([, s]) => s !== 'True')
        .map(([k]) => k);
      const targetCondition = deficits[0] ?? 'unknown';

      // Find the action contract for this condition.
      const action = PIPELINE_ACTIONS.find((a) => a.targetCondition === targetCondition);
      const skillId = action?.skillId ?? 'saga-worker';
      const obligationId = PIPELINE_CONDITIONS.find((c) => c.conditionType === targetCondition)?.obligationId ?? 'unknown';
      const role = allSkills().find((s) => s.skillId === skillId)?.role ?? 'worker';

      log(`STEP ${step}: condition=${targetCondition} skill=${skillId} — spawning worker (saga3 MCP)...`);

      // Write worker_executions row so tracker-view shows the worker.
      const workerId = `saga3-${step}-${Date.now()}`;
      const executionId = `saga3-exec-${step}-${Date.now()}`;
      const projectId = Number(process.env.SAGA3_PROJECT_ID ?? 3);
      const epicId = Number(process.env.SAGA3_EPIC_ID ?? 4);
      try {
        db.prepare(
          `INSERT INTO worker_executions
             (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
              launcher, state, phase, pid, reserved_at, started_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        ).run(executionId, `saga3-run-${spec.id}`, projectId, epicId, 0, workerId,
          os.hostname(), 'saga3-cli', 'running', 'executing', process.pid);
      } catch (e) {
        // Old DB may not have the table — non-fatal.
        log(`(worker_executions write skipped: ${e instanceof Error ? e.message : 'error'})`);
      }

      // Spawn the claude worker. It writes its result to the DB through the
      // saga3_* MCP tools; we only collect the exit code here.
      const exitCode = await spawnWorker(
        targetCondition, obligationId, skillId, role, executionId, workerId,
      );

      // Update worker_executions: worker finished.
      try {
        db.prepare(
          `UPDATE worker_executions SET state='exited', phase='finished',
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

      if (exitCode !== 0) {
        log(`WARN: worker exited code=${exitCode} for ${targetCondition}`);
      }

      // Mark this work as completed and clear the assignment for the next step.
      ctx.completedIntents.add(assignment.id);
      ctx.currentAssignment = null;
    }
  }

  if (step >= maxSteps) {
    log(`MAX STEPS (${maxSteps}) reached without terminal.`);
  }

  log(`Episode finished after ${step} steps.`);
}

// Clean up the temp MCP config on exit.
function cleanup(): void {
  try { rmSync(mcpConfigPath, { force: true }); } catch { /* best effort */ }
}
process.once('exit', cleanup);
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });

runEpisode().catch((e) => {
  console.error('FATAL:', e);
  cleanup();
  process.exit(1);
});
