/**
 * saga-mcp 3.0 — Autonomous Orchestration Engine (ADR-008, plan §1).
 *
 * The v2 model: a main-context agent (saga-orchestrator skill) drives the
 * flow by calling saga tools. It CAN bypass saga (AutoCad3D proved).
 *
 * The v3 model: a dumb pump loop. It cannot bypass saga. It only:
 *   1. Spawns workers for current claimable tasks (via ClaudeBoardRunner).
 *   2. When the queue is empty, asks workflow_generate_next to seed more.
 *   3. When no more tasks can be generated, attempts episode_transition.
 *   4. If a hard gate fails, flags needs-human and pauses until resumed.
 *
 * The engine runs as a background process (see orchestrate-cli.ts). It shares
 * the saga SQLite DB with tracker-view's HTTP server but does NOT depend on
 * it — both processes can run concurrently against the same DB file (SQLite
 * serialises writers via BEGIN IMMEDIATE, dispatcher.ts:37).
 *
 * This module is ADDITIVE (plan §Feature flag): under SAGA_ORCHESTRATION_MODE=v2
 * nothing here is imported or executed. v2 behaviour is unchanged.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeBoardRunner } from '../tracker-view/claude-runner.mjs';
import { getDb, closeDb } from './db.js';
import { generateNextForCompletedTask } from './tools/workflow.js';
import { handlers as lifecycleHandlers } from './tools/lifecycle.js';
import { handlers as dispatcherHandlers } from './tools/dispatcher.js';
import { reevaluateDownstream } from './tools/tasks.js';
import { handlers as projectHandlers } from './tools/projects.js';
import { logActivity } from './helpers/activity-logger.js';
import { reconcileWorkerExecutions } from './worker-executions.js';
import { releaseExecutionAtomically } from './lifecycle/atomic-release.js';

/**
 * Episode stage → next stage (mirror of lifecycle.ts NEXT, kept local to avoid
 * importing a non-exported const). If lifecycle.STAGES changes, update this.
 */
const NEXT_STAGE: Record<string, string | undefined> = {
  discovery: 'formalization',
  formalization: 'planning',
  planning: 'development',
  development: 'verification',
  verification: 'integration',
  integration: 'completed',
};

/** Pause cap: if the engine sits in needs-human for longer than this, exit. */
const MAX_PAUSE_MIN = 24 * 60; // 24h — engine exits, user can restart it.
/** Polling interval for needs-human resume signal. */
const RESUME_POLL_MS = 10_000;
/** Max consecutive empty pump cycles before the engine declares the run done. */
const MAX_EMPTY_CYCLES = 3;
/** Wait between pump cycles when workers are still active. */
const PUMP_TICK_MS = 5_000;

/** Reconcile durable worker executions every 6 cycles (30s). */
const ZOMBIE_CHECK_TICKS = 6;
let zombieCheckCounter = 0;

/**
 * Rate-limit aware concurrency. When API returns 429 (rate_limit), the engine
 * kills the affected worker, returns its task to the queue, and lowers the
 * effective concurrency by 1. This stops burning tokens on claude's own
 * exponential-backoff retries (4.7s → 8.5s → 17.5s per cycle) and lets the
 * remaining workers proceed without contention.
 *
 * Recovery: after RATE_LIMIT_COOLDOWN_SEC without any 429, effective
 * concurrency climbs back by 1 per cooldown window until it reaches the
 * target (opts.concurrency).
 *
 * The rate-limit scanner reads JSONL tails (same path as zombie detector)
 * and pattern-matches /api_retry.*429.*rate_limit/.
 */
const RATE_LIMIT_SCAN_TICKS = 2;         // every 10s
const RATE_LIMIT_COOLDOWN_SEC = 60;      // 60s without 429 → +1 concurrency
const RATE_LIMIT_LOG_TAIL_BYTES = 8192;  // scan last 8KB of JSONL for 429
const RATE_LIMIT_PATTERN = /api_retry[^\n]*"error_status":429[^\n]*"error":"rate_limit"/;
let rateLimitCheckCounter = 0;
let lastRateLimitAt = 0;                  // ms epoch of last 429 detection

/**
 * RECOVERY TREE — lookup table for self-healing on gate failures.
 *
 * When episode_transition fails (hard gate throws), the engine consults this
 * tree keyed by current stage. Each rule has:
 *   - match: RegExp tested against the gate error message
 *   - diagnosis: one-line root cause (for activity_log + UI)
 *   - action_prompt: full instructions for the recovery worker (inline prompt,
 *     no separate skill file — saga MCP tools are the surface)
 *   - max_retries: how many times engine may auto-heal this exact (stage, rule)
 *     before escalating to human. 0 = never auto-heal (semantic failures).
 *
 * The tree is the entire recovery logic. To add coverage for a new failure
 * mode → push a rule. No code restructuring needed.
 *
 * Worker spawned by attemptHeal() is a regular claude-runner worker with an
 * inline prompt (same MCP config, --disallowedTools worker_next). When done,
 * engine retries the gate; if it still fails, retry count increments; on
 * max_retries → escalate to human via needs-human.
 */
interface RecoveryRule {
  match: RegExp;
  diagnosis: string;
  action_prompt: string;
  max_retries: number;
}

const RECOVERY_TREE: Record<string, RecoveryRule[]> = {
  formalization: [
    {
      match: /episode has no AC artifacts/i,
      diagnosis: 'saga-analyst never generated ACs after UC done. Workflow has no uc_accepted→ac generation transition; saga-analyst skill expects to write AC in a second task that never got created.',
      action_prompt: [
        'You are a saga recovery engineer. Episode is stuck in formalization because no AC (acceptance criteria) artifacts exist.',
        '',
        'ROOT CAUSE: saga-analyst wrote UCs but no ACs. The uc_accepted workflow transition does not generate a formalization.ac task.',
        '',
        'ACTIONS (use only mcp__saga__ tools; do NOT call worker_next):',
        '1. Read the episode: epic_id=<EPIC_ID>. Call artifact_list({epic_id, type:"UC"}) and artifact_list({epic_id, type:"SRS"}) and artifact_list({epic_id, type:"FR"}).',
        '2. Read each UC document at its path. Read the SRS for FR/NFR context.',
        '3. For EACH UC, derive ≥1 acceptance criterion. For each AC:',
        '   - artifact_create({project_id, epic_id, type:"AC", code:"AC-N", title:"<short>", path:"docs/.../03-acceptance-criteria.md#AC-N", status:"draft"})',
        '   - trace_add({source_id: <AC id>, target_type:"artifact", target_id: <UC id>, link_type:"derived_from"})',
        '   - trace_add({source_id: <AC id>, target_type:"artifact", target_id: <FR id it tests>, link_type:"depends_on"})',
        '4. After all ACs written, write the AC document to disk at the .md path you declared. Each AC MUST have: Given/When/Then + a measurable property block (per saga AC template).',
        '5. Accept upstream artifacts that are still in "draft" but have a real document on disk:',
        '   - artifact_list for PRD, SRS, UC. For each with status="draft": refresh hash via artifact_save with the current file content, then artifact_update to status="accepted".',
        '   - SKIP if the .md file does not exist or is empty — that is a real gap, escalate via worker_ask_need.',
        '6. Accept each AC: artifact_update to status:"accepted". AC MUST have content_hash matching accepted_hash (refreshArtifactHash via artifact_save if needed).',
        '7. Call worker_done({task_id, worker_id, result:"Recovery: created N AC artifacts, accepted PRD/SRS/UC/AC baseline"}).',
        '',
        'DO NOT touch PRD content. DO NOT change requirements — only formalize them as ACs.',
        'DO NOT call episode_transition — the engine will retry the gate after you finish.',
      ].join('\n'),
      max_retries: 2,
    },
    {
      match: /AC baseline is not accepted and clean/i,
      diagnosis: 'ACs exist but not accepted, or drifted from disk.',
      action_prompt: [
        'You are a saga recovery engineer. AC baseline is not accepted/clean.',
        '',
        'ACTIONS:',
        '1. artifact_list({epic_id:<EPIC_ID>, type:"AC"}) — list all ACs.',
        '2. For each AC with status != "accepted": verify the .md file at its path exists and is non-empty. If yes → artifact_save to refresh content_hash, then artifact_update to status:"accepted".',
        '3. For each AC with drift_state="drifted": artifact_save to rehash from disk. If hash now matches accepted_hash → drift clears. If not → escalate via worker_ask_need (someone is editing AC docs out-of-band).',
        '4. worker_done with summary.',
      ].join('\n'),
      max_retries: 1,
    },
    {
      match: /no PRD artifacts|no SRS artifacts|no UC artifacts/i,
      diagnosis: 'Upstream formalization artifact missing — earlier worker crashed or skipped.',
      action_prompt: [
        'You are a saga recovery engineer. A formalization artifact is missing.',
        '',
        'Diagnose by querying artifact_list for type PRD, SRS, UC. Whichever is missing, recreate:',
        '- Missing PRD: read brief, use saga-product procedure to write 00-PRD.md, register artifact with parent_artifact_id=<brief id>.',
        '- Missing SRS: read PRD, use saga-architect procedure to write SRS.md, register with parent_artifact_id=<PRD id>.',
        '- Missing UC: read PRD+SRS, use saga-analyst procedure to write UC.md, register with parent_artifact_id=<PRD id>.',
        '',
        'After creating missing artifact, also create any sibling artifacts the workflow would normally generate (e.g. creating UC also needs SRS to exist for reconciliation).',
        'Call worker_done with summary listing what was created.',
      ].join('\n'),
      max_retries: 1,
    },
  ],
  planning: [
    {
      match: /no planning tasks exist/i,
      diagnosis: 'saga-planner never ran or crashed.',
      action_prompt: [
        'You are a saga recovery engineer. Planning decomposition task is missing.',
        '',
        'ACTIONS:',
        '1. Verify AC baseline is accepted: artifact_list({epic_id:<EPIC_ID>, type:"AC"}). All must be status:"accepted" with content_hash.',
        '2. If baseline not accepted → do NOT proceed; escalate via worker_ask_need.',
        '3. If baseline OK → task_create({epic_id, title:"Decompose accepted baseline", task_kind:"planning.decomposition", workflow_stage:"planning", execution_skill:"saga-planner", execution_mode:"tracker_only", priority:"high"}).',
        '4. worker_done summary.',
      ].join('\n'),
      max_retries: 1,
    },
  ],
  development: [
    {
      match: /no development tasks exist/i,
      diagnosis: 'saga-planner did not decompose into dev tasks.',
      action_prompt: [
        'You are a saga recovery engineer. No development tasks exist after planning.',
        'This means saga-planner failed to decompose. Escalate: this requires re-running planning with possibly-fixifyable root cause.',
        'Call worker_ask_need({reason:"planner did not generate dev tasks — needs human to inspect planning.decomposition task output"}) ',
        'Then worker_done.',
      ].join('\n'),
      max_retries: 0, // planner failures usually semantic — do not auto-retry blindly
    },
    {
      // Merge conflicts block the development→verification gate. The task is
      // done (worker finished, APPROVED) but its branch conflicted with dev.
      // Healer investigates: reads the task's worktree metadata, looks at the
      // conflicting files, either resolves the conflict (mechanical: both
      // sides add disjoint code) or escalates (semantic: two tasks changed
      // the same logic differently).
      match: /tasks not completed\/integrated:.*#(\d+(?:,\s*#\d+)*)/i,
      diagnosis: 'Some development tasks are done but their branches have merge conflicts or are still pending integration.',
      action_prompt: [
        'You are a saga recovery engineer. The development→verification gate failed because some tasks are not fully integrated.',
        '',
        'ACTIONS (use mcp__saga__ tools; do NOT call worker_next):',
        '1. Read task_list for the epic. Identify tasks with status=\'done\' but integration_state IN (\'conflict\', \'pending\').',
        '2. For each such task:',
        '   a. Read its metadata.worktree (branch, path, merge_target, merge_conflict).',
        '   b. cd into the project repo. Check git status, git log --oneline -5, the task branch vs integration branch.',
        '   c. For integration_state=\'conflict\': examine the conflicting files (git diff --name-only --diff-filter=U).',
        '   d. If the conflict is mechanical (two tasks touched different parts of the same file, or different files with no logical overlap): resolve by keeping both sides. git add, git commit, then git merge.',
        '   e. If the conflict is semantic (two tasks changed the same function/logic differently): DO NOT guess. Call worker_ask_need with a description of the conflict.',
        '   f. After resolving: call worker_merge_release({task_id, worker_id, result:\'merged\', commit_sha}).',
        '3. For tasks still status=\'in_progress\' or \'review_in_progress\': they are genuinely still running — do NOT touch them. Skip.',
        '4. Call worker_done with a summary of what you resolved.',
        '',
        'Your worker_id is in the task payload. The worktree path is in metadata.worktree.path.',
      ].join('\n'),
      max_retries: 2,
    },
  ],
  verification: [
    {
      match: /no passing baseline evidence for ([AC-]+\d+(?:,\s*[AC-]+\d+)*)/i,
      diagnosis: 'verifier missed some ACs — they have no passing evidence at baseline hash.',
      action_prompt: [
        'You are a saga recovery engineer. Some accepted ACs have no passing verification evidence at their baseline hash.',
        '',
        'ACTIONS:',
        '1. Parse the error for the AC codes that lack evidence.',
        '2. For each: artifact_get to find its id and accepted_hash.',
        '3. task_create({epic_id, title:"Verify <AC code>", task_kind:"verification.ac", workflow_stage:"verification", execution_skill:"saga-verifier", execution_mode:"git_change", source_artifact_ids:[<AC id>], priority:"high"}) for each missing one.',
        '4. trace_add({source_id: <AC id>, target_type:"task", target_id:<verify task id>, link_type:"depends_on"}) so the verifier knows what to verify.',
        '5. worker_done summary.',
        '',
        'The engine will dispatch verifier workers; once they record passing evidence, the gate will pass on retry.',
      ].join('\n'),
      max_retries: 2,
    },
    // Verification gate also catches real test failures via outcome=failed, but those
    // surface as "no passing evidence" too. Healer cannot fix a real failure — but it
    // will try to re-spawn verifier once, and if it still fails, escalate.
  ],
  integration: [
    {
      match: /no integration tasks exist/i,
      diagnosis: 'workflow did not generate integration task.',
      action_prompt: [
        'You are a saga recovery engineer. No integration task exists.',
        'ACTIONS: task_create({epic_id, title:"Integrate verified baseline", task_kind:"integration.merge", workflow_stage:"integration", execution_skill:"saga-worker", execution_mode:"git_change", priority:"high"}). worker_done.',
      ].join('\n'),
      max_retries: 1,
    },
    // Merge conflicts at integration → always escalate (semantic).
  ],
};

/** Track heal attempts per (epic, stage, diagnosis) to enforce max_retries. */
const healRetries = new Map<string, number>();

// ESM does not define __dirname; derive it once from import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface OrchestrateOptions {
  projectId: number;
  epicId: number;
  concurrency?: number;
  claudePath?: string;
  sagaEntry?: string;
  sagaSkillRoot?: string;
  logRoot?: string;
  heartbeatLog?: string;
  /** Injectable for tests; defaults to node child_process.spawn. */
  spawn?: typeof nodeSpawn;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OrchestrateResult {
  projectId: number;
  epicId: number;
  finalStage: string;
  endedAt: string;
  reason: 'completed' | 'failed' | 'paused_timeout' | 'stopped';
  cycles: number;
  lastError: string | null;
}

/**
 * Heartbeat line written to the engine log on every cycle boundary. Format
 * matches claude-runner.mjs heartbeat (line ~100): one line per event, plain
 * text, parseable by `tail -f`.
 */
function engineHeartbeat(opts: OrchestrateOptions, event: string, message: string, now = Date.now): void {
  const line = [
    new Date(now()).toISOString(),
    `engine project=${opts.projectId} epic=${opts.epicId}`,
    event,
    message,
  ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
  const logPath = opts.heartbeatLog
    ?? path.join(os.homedir(), '.zcode', 'cli', 'engine-heartbeat.log');
  try { appendFileSync(logPath, line); } catch { /* log not critical */ }
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Returns the current episode stage, or null if the episode has no workflow row.
 * Mirrors lifecycle.ts:getOrCreate without the INSERT side effect.
 */
function currentStage(epicId: number): string | null {
  const row = getDb().prepare('SELECT stage FROM episode_workflows WHERE epic_id=?').get(epicId) as
    | { stage: string }
    | undefined;
  return row?.stage ?? null;
}

/**
 * Count tasks in a stage by status. Used by the engine to decide whether to
 * pump workers, generate next, or attempt a transition.
 */
function countActiveTasks(epicId: number): {
  claimable: number;
  inFlight: number;
  doneInCurrentStage: number;
} {
  const db = getDb();
  const stage = currentStage(epicId);
  if (!stage) return { claimable: 0, inFlight: 0, doneInCurrentStage: 0 };
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN t.status IN ('todo','review')
                     AND (t.assigned_to IS NULL OR t.assigned_to='')
                     AND t.current_execution_id IS NULL
                     AND t.priority IN ('critical','high','medium')
                     AND NOT EXISTS (
                       SELECT 1 FROM worker_executions we
                       WHERE we.task_id=t.id AND we.state IN ('reserved','running','cancel_requested')
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM task_dependencies d
                       JOIN tasks dep ON dep.id=d.depends_on_task_id
                       WHERE d.task_id=t.id AND (
                         dep.status!='done' OR (
                           dep.task_kind IS NOT NULL AND dep.execution_mode='git_change'
                           AND dep.integration_state!='merged'
                         )
                       )
                     )
                THEN 1 ELSE 0 END) AS claimable,
       SUM(CASE WHEN t.status IN ('in_progress','review_in_progress')
                      OR (t.status='review' AND t.assigned_to IS NOT NULL AND t.assigned_to!='')
                      OR EXISTS (
                        SELECT 1 FROM worker_executions live
                         WHERE live.task_id=t.id
                           AND live.state IN ('reserved','running','cancel_requested')
                      )
                THEN 1 ELSE 0 END) AS in_flight,
       SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) AS done_count
     FROM tasks t WHERE t.epic_id=? AND t.workflow_stage=?`,
  ).get(epicId, stage) as {
    claimable: number | null; in_flight: number | null; done_count: number | null;
  };
  return {
    claimable: row.claimable ?? 0,
    inFlight: row.in_flight ?? 0,
    doneInCurrentStage: row.done_count ?? 0,
  };
}

/**
 * Find completed tasks in the epic whose task_kind is on the
 * generateNextForCompletedTask ladder, and invoke the generator. Returns the
 * number of NEW tasks created (0 if nothing to do).
 *
 * generateNextForCompletedTask already keys on task_kind and is idempotent
 * (insertGeneratedTask dedupes by generation_key), so calling it on every
 * done task is safe — it no-ops on tasks whose downstream already exists.
 */
function generateNextIfReady(epicId: number): { created: number; error: string | null } {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT id FROM tasks
     WHERE epic_id=? AND status='done' AND task_kind IS NOT NULL
     ORDER BY id`,
  ).all(epicId) as Array<{ id: number }>;
  let totalCreated = 0;
  let lastError: string | null = null;
  for (const c of candidates) {
    try {
      const result = generateNextForCompletedTask(c.id);
      if (result && result.created.length > 0) {
        totalCreated += result.created.length;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { created: totalCreated, error: lastError };
}

/**
 * Mark the episode as needs-human (pause). The engine then polls until the
 * flag is cleared (by POST /api/episode/resume in tracker-view) or until
 * MAX_PAUSE_MIN elapses.
 */
async function pauseAndAlert(
  epicId: number,
  reason: string,
  opts: OrchestrateOptions,
): Promise<void> {
  const db = getDb();
  db.prepare(
    `UPDATE episode_workflows
     SET metadata=json_set(COALESCE(metadata,'{}'),
       '$.needs-human', true,
       '$.pause_reason', ?,
       '$.paused_at', datetime('now')),
       updated_at=datetime('now')
     WHERE epic_id=?`,
  ).run(reason, epicId);
  logActivity(db, 'epic', epicId, 'updated', 'needs-human', null, 'true',
    `Engine paused: ${reason}`);
  engineHeartbeat(opts, 'PAUSED', `reason="${reason.slice(0, 200)}"`);
}

function clearNeedsHuman(epicId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE episode_workflows
     SET metadata=json_remove(metadata, '$.needs-human', '$.pause_reason', '$.paused_at'),
       updated_at=datetime('now')
     WHERE epic_id=?`,
  ).run(epicId);
}

/**
 * ADR-012 — Read the decision from the most recent brief artifact in the
 * epic. Used by the engine's main loop to route discovery-stage episodes
 * after their kickstart worker completes. Returns one of 'go', 'fast-track',
 * 'clarify', 'reject' — or null if no brief exists / metadata is malformed
 * / decision is absent. The caller treats null as 'go' (formal pipeline).
 */
function readLatestBriefDecision(epicId: number): string | null {
  const row = getDb().prepare(
    `SELECT metadata FROM artifacts
     WHERE epic_id=? AND type='brief' ORDER BY id DESC LIMIT 1`,
  ).get(epicId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return null;
  try {
    const decision = JSON.parse(row.metadata)?.brief_payload?.decision;
    if (typeof decision === 'string' && ['go', 'fast-track', 'clarify', 'reject'].includes(decision)) {
      return decision;
    }
  } catch { /* malformed metadata */ }
  return null;
}

/** Read select metadata fields for the recovery loop's bookkeeping. */
function readEpisodeMeta(epicId: number): { lastHealError: string | null; lastHealAttempt: string | null } {
  const row = getDb().prepare(
    `SELECT json_extract(metadata, '$.lastHealError') AS e,
            json_extract(metadata, '$.lastHealAttempt') AS a
     FROM episode_workflows WHERE epic_id=?`,
  ).get(epicId) as { e: string | null; a: string | null } | undefined;
  return { lastHealError: row?.e ?? null, lastHealAttempt: row?.a ?? null };
}

/**
 * Read the active model's concurrency limit (ceiling) from episode metadata.
 * Written by /api/model/set when the user switches models mid-run. The pump
 * loop uses min(opts.concurrency, active_model_limit) as its target so that:
 *   - Active workers (already on the OLD model) finish their cycle untouched.
 *   - The engine stops spawning NEW workers until the active count drops below
 *     the new limit, then spawns fresh workers that read the patched
 *     ~/.claude/settings.json and run on the new model.
 * Returns null when no model limit has been recorded — caller falls back to
 * opts.concurrency unchanged.
 */
function readActiveModelLimit(epicId: number): number | null {
  const row = getDb().prepare(
    `SELECT json_extract(metadata, '$.active_model_limit') AS lim
     FROM episode_workflows WHERE epic_id=?`,
  ).get(epicId) as { lim: number | null } | undefined;
  const lim = row?.lim;
  return typeof lim === 'number' && lim >= 1 ? lim : null;
}

/** Persist recovery bookkeeping fields into episode metadata (merge). */
function writeEpisodeMeta(epicId: number, patch: Record<string, unknown>): void {
  const db = getDb();
  let sql = 'UPDATE episode_workflows SET metadata=json_set(COALESCE(metadata,\'{}\')';
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sql += `,'$.${k}',?`;
    params.push(v);
  }
  sql += '), updated_at=datetime(\'now\') WHERE epic_id=?';
  params.push(epicId);
  db.prepare(sql).run(...params);
}

/** Wipe retry counters for one epic (used on human-resume or on new diagnosis). */
function resetHealRetriesForEpic(epicId: number): void {
  for (const key of [...healRetries.keys()]) {
    if (key.startsWith(`${epicId}:`)) healRetries.delete(key);
  }
}

async function waitForResume(
  epicId: number,
  opts: OrchestrateOptions,
): Promise<boolean> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  while (true) {
    if (now() - startedAt > MAX_PAUSE_MIN * 60_000) {
      engineHeartbeat(opts, 'PAUSE_TIMEOUT', `${MAX_PAUSE_MIN}min reached — engine exits`);
      return false;
    }
    const row = getDb().prepare(
      `SELECT json_extract(metadata,'$.needs-human') AS nh FROM episode_workflows WHERE epic_id=?`,
    ).get(epicId) as { nh: number | null } | undefined;
    if (!row || row.nh !== 1) {
      // Either the flag was cleared, or the row was deleted. Treat as resumed.
      return true;
    }
    await sleep(RESUME_POLL_MS);
  }
}

/**
 * Attempt to advance the episode by one stage. Returns true if the stage
 * changed, false if a hard gate blocked the transition (the caller then
 * pauses for human attention).
 */
function tryAdvanceStage(epicId: number): { advanced: boolean; error: string | null } {
  const stage = currentStage(epicId);
  if (!stage) return { advanced: false, error: `episode ${epicId} has no workflow row` };
  if (stage === 'completed' || stage === 'cancelled') {
    return { advanced: false, error: null };
  }

  // RECOVERY HOLD: if any recovery.heal task is still active (not done), the
  // episode MUST NOT advance. Recovery is a monopoly mode — pump loop keeps
  // spawning workers (including the recovery task's reviewer), but episode
  // transition is blocked until every recovery task in the epic reaches done.
  // Without this, episode can race ahead (e.g. formalization→planning) while
  // a healer's review is still in flight, leaving the review task stranded
  // with a stale workflow_stage that no worker can claim.
  const activeRecovery = getDb().prepare(
    `SELECT id FROM tasks
     WHERE epic_id=? AND task_kind='recovery.heal'
       AND status IN ('todo','in_progress','review','review_in_progress')`,
  ).get(epicId) as { id: number } | undefined;
  if (activeRecovery) {
    return { advanced: false, error: null };
  }

  const to = NEXT_STAGE[stage];
  if (!to) return { advanced: false, error: `no NEXT stage for '${stage}'` };
  try {
    const result = lifecycleHandlers.episode_transition({
      epic_id: epicId,
      to_stage: to as never,
    }) as { changed: boolean };
    return { advanced: result.changed, error: null };
  } catch (err) {
    return { advanced: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Match the gate error against RECOVERY_TREE and spawn a recovery worker if
 * a rule matches and retry budget allows. Returns applied:true if a healer
 * task was created — the engine pump loop will pick it up via worker_next,
 * the healer runs, calls worker_done, and on the next cycle the engine
 * retries the gate (which now may pass).
 *
 * Returns escalate:true when:
 *   - no rule matches the error (unknown failure mode), OR
 *   - retry budget for this (stage, rule) is exhausted, OR
 *   - RECOVERY_TREE has no entry for this stage.
 *
 * In those cases the caller pauses for human attention.
 *
 * The healer task is a regular task with task_kind:"recovery.heal" so the
 * kanban / activity log can distinguish it from regular work. Its
 * execution_skill is null — the prompt is fully inline (rendered from the
 * RECOVERY_TREE rule). claude-runner's buildPrompt falls back to saga-worker
 * skill when execution_skill is unset, which is fine: the inline prompt
 * overrides the skill body in practice (worker reads task description).
 *
 * NOTE: buildPrompt expects a prompt POSITIONAL ARG, not from task.description.
 * The runner builds the prompt from task payload. To pass our inline recovery
 * prompt, we put it in task.description — and also extend buildPrompt via the
 * runner? Simpler: write the prompt into task.metadata.recovery_prompt and
 * extend the runner's prompt builder to prefer it. To avoid touching the
 * runner, we instead create the task with execution_skill:"saga-worker" and
 * put the full recovery prompt in task.description — saga-worker reads task
 * description as part of its standard context. The prompt is loud enough to
 * override the skill body.
 */
function attemptHeal(epicId: number, stage: string, gateError: string): {
  applied: boolean;
  escalate: boolean;
  reason: string;
  taskId: number | null;
} {
  const rules = RECOVERY_TREE[stage];
  if (!rules || rules.length === 0) {
    return { applied: false, escalate: true, reason: `no recovery rules for stage '${stage}'`, taskId: null };
  }
  const rule = rules.find(r => r.match.test(gateError));
  if (!rule) {
    return { applied: false, escalate: true, reason: `unmatched gate error for stage '${stage}': ${gateError.slice(0, 120)}`, taskId: null };
  }
  const healKey = `${epicId}:${stage}:${rule.diagnosis}`;
  const retries = healRetries.get(healKey) ?? 0;
  if (retries >= rule.max_retries) {
    return { applied: false, escalate: true, reason: `max_retries (${rule.max_retries}) reached for: ${rule.diagnosis}`, taskId: null };
  }
  healRetries.set(healKey, retries + 1);

  // Render prompt with epic_id substituted (other placeholders deliberately
  // absent — the healer discovers project_id, artifact ids via saga MCP).
  const prompt = rule.action_prompt.replace(/<EPIC_ID>/g, String(epicId));
  const db = getDb();
  const projectIdRow = db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId) as { project_id: number } | undefined;
  if (!projectIdRow) {
    return { applied: false, escalate: true, reason: `epic ${epicId} has no project`, taskId: null };
  }
  // Insert the recovery task. We put the full prompt in description because
  // claude-runner's buildPrompt includes the task payload (description among
  // it) in the worker prompt — the worker reads it and acts.
  const info = db.prepare(
    `INSERT INTO tasks
       (epic_id, title, description, status, priority, task_kind, workflow_stage,
        execution_skill, review_skill, execution_mode, tags, metadata)
     VALUES (?, ?, ?, 'todo', 'critical', 'recovery.heal', ?,
             'saga-worker', 'saga-reviewer', 'tracker_only', ?, '{}')`,
  ).run(
    epicId,
    `Recovery: ${rule.diagnosis.slice(0, 80)}`,
    `RECOVERY TASK (auto-spawned by engine).\n\nStage: ${stage}\nGate error: ${gateError}\nDiagnosis: ${rule.diagnosis}\n\n${prompt}`,
    stage,
    JSON.stringify([`stage:${stage}`, 'kind:recovery.heal', 'role:recovery']),
  );
  const taskId = Number(info.lastInsertRowid);
  logActivity(db, 'epic', epicId, 'created', 'recovery_task', null, String(taskId),
    `Engine auto-spawned recovery task #${taskId} for stage='${stage}' (attempt ${retries + 1}/${rule.max_retries}): ${rule.diagnosis}`);
  return { applied: true, escalate: false, reason: `spawned task #${taskId}`, taskId };
}

/**
 * Resolve the JSONL log path for an active worker task. claude-runner writes
 * to <logRoot>/board-<projectId>-<ts>/task-<taskId>-<workerId>.jsonl. We find
 * it by scanning the newest matching file (worker IDs are unique per spawn).
 */
function resolveWorkerLogPath(taskId: number, workerId: string, projectId: number): string | null {
  const logRoot = path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
  const safeWorker = workerId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const fileName = `task-${taskId}-${safeWorker}.jsonl`;
  try {
    const dir = readdirSync(logRoot)
      .filter((d: string) => d.startsWith(`board-${projectId}-`))
      .map((d: string) => ({ d, full: path.join(logRoot, d), mtime: statSync(path.join(logRoot, d)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    for (const r of dir) {
      const candidate = path.join(r.full, fileName);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* logRoot missing */ }
  return null;
}

/**
 * Reconcile process truth independently from task status. Log output is not a
 * liveness signal; only dead local PIDs or invalid fenced phases are revoked.
 */
function detectAndKillZombies(epicId: number, projectId: number, opts: OrchestrateOptions): number {
  // Log silence is progress telemetry, not liveness. Verification workers may
  // legitimately spend several minutes in cargo/vitest or contract reading.
  // The durable execution reconciler revokes only a dead host-local PID or a
  // fenced execution that no longer owns an allowed lifecycle phase.
  const reconciled = reconcileWorkerExecutions(getDb(), projectId, epicId);
  const recovered = reconciled.filter(result =>
    result.action === 'lost' || result.action === 'terminated',
  );
  for (const result of recovered) {
    engineHeartbeat(
      opts,
      result.action === 'lost' ? 'WORKER_LOST' : 'WORKER_TERMINATED',
      `task #${result.taskId} execution=${result.executionId} released=${result.released} ${result.reason}`,
    );
  }
  return recovered.length;
}

/**
 * Rate-limit detector. Scans active workers' JSONL tails for 429 rate_limit
 * events from the API. When found, kills the affected worker (it's stuck in
 * claude's exponential backoff, burning time without producing useful work),
 * returns its task to the queue, and signals the pump loop to lower effective
 * concurrency by 1. The task will be re-claimed later when the API recovers.
 *
 * Only rolls back tasks where the 429 happened early in the worker's session
 * (within the last RATE_LIMIT_LOG_TAIL_BYTES of the log). A worker that did
 * substantial work before hitting 429 is left alone — claude's own retry
 * will likely succeed, and killing it would waste the context it built.
 *
 * Returns the count of rate-limited workers killed this scan.
 */
/**
 * Rate-limit detector — NATURAL ROTATION. Scans active workers' JSONL tails
 * for 429 rate_limit events. When detected, does NOT kill the worker —
 * claude's own exponential backoff will eventually succeed (or the task
 * finishes naturally). Instead, signals the pump loop to lower the
 * effective concurrency ceiling by 1, so the NEXT worker death does NOT
 * trigger a replacement spawn. Convergence is gradual:
 *
 *   5 workers, limit 2 → 3 hit 429 → effectiveConcurrency drops to 4, 3, 2
 *   → workers die naturally → no replacements spawned → stabilizes at 2
 *
 * Recovery: 60s without 429 → effectiveConcurrency climbs by 1 per scan.
 */
function detectRateLimits(epicId: number, projectId: number, opts: OrchestrateOptions): number {
  const tasks = getDb().prepare(
    `SELECT id, assigned_to FROM tasks
     WHERE epic_id=? AND status='in_progress' AND assigned_to IS NOT NULL`,
  ).all(epicId) as Array<{ id: number; assigned_to: string }>;

  let rateLimited = 0;
  for (const t of tasks) {
    const logPath = resolveWorkerLogPath(t.id, t.assigned_to, projectId);
    if (!logPath || !existsSync(logPath)) continue;
    try {
      const st = statSync(logPath);
      const tailBytes = Math.min(st.size, RATE_LIMIT_LOG_TAIL_BYTES);
      const fd = openSync(logPath, 'r');
      const buf = Buffer.alloc(tailBytes);
      readSync(fd, buf, 0, tailBytes, Math.max(0, st.size - tailBytes));
      closeSync(fd);
      const tail = buf.toString('utf8');
      if (RATE_LIMIT_PATTERN.test(tail)) {
        rateLimited += 1;
        lastRateLimitAt = Date.now();
      }
    } catch { /* stat/read failed */ }
  }
  if (rateLimited > 0) {
    engineHeartbeat(opts, 'RATE_LIMIT',
      `${rateLimited} worker(s) hit 429 — lowering concurrency ceiling`);
  }
  return rateLimited;
}

/**
 * Compute the effective concurrency for this pump cycle. If we've seen 429s
 * recently, throttle down. If the cooldown window passed without new 429s,
 * recover toward the target.
 */
function computeEffectiveConcurrency(target: number, current: number): number {
  if (lastRateLimitAt === 0) return target;
  const sinceLimit = (Date.now() - lastRateLimitAt) / 1000;
  if (sinceLimit < RATE_LIMIT_COOLDOWN_SEC) {
    // Still in cooldown — hold current (don't increase).
    return Math.min(current, target);
  }
  // Cooldown elapsed — recover by 1 per call (caller runs this every RATE_LIMIT_SCAN_TICKS).
  return Math.min(current + 1, target);
}

/**
 * Run the orchestration loop. Resolves when:
 *  - episode reaches 'completed' (success), OR
 *  - needs-human pause exceeds MAX_PAUSE_MIN (timeout exit), OR
 *  - MAX_EMPTY_CYCLES consecutive cycles produce no work and no transition.
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const projectId = opts.projectId;
  const epicId = opts.epicId;
  const concurrency = opts.concurrency ?? 4;
  // Model-limit ceiling: if /api/model/set wrote $.active_model_limit into
  // episode_workflows.metadata (because the user switched models mid-run), the
  // effective target is min(concurrency, limit). Active workers stay on the
  // old model; this ceiling only prevents spawning NEW workers above the new
  // model's API limit. As old workers finish, fresh spawns read the patched
  // ~/.claude/settings.json and run on the new model.
  // Re-read every RATE_LIMIT_SCAN_TICKS cycle (see pump loop) so a model switch
  // takes effect WITHOUT an engine restart.
  let targetConcurrency = (() => {
    const lim = readActiveModelLimit(epicId);
    return lim !== null ? Math.min(concurrency, lim) : concurrency;
  })();
  // Effective concurrency may be lower than the target when the API is
  // rate-limiting (429). Starts at target, drops by 1 per rate-limit hit,
  // recovers by 1 per RATE_LIMIT_COOLDOWN_SEC of clean running.
  let effectiveConcurrency = targetConcurrency;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  // === SINGLETON GUARD (PID-lock) ===
  // Only ONE engine per epic. Without this, every /api/engine/restart and
  // /api/model/set spawned a fresh engine without killing the old one —
  // producing 6+ engines, 10+ claude workers, rate-limit storms.
  // The lock is a file: ~/.zcode/cli/engine-<projectId>-<epicId>.pid
  // containing the engine's PID. On start: check if existing engine is alive.
  // If yes → exit immediately (duplicate engine). If no → claim the lock.
  const lockFile = path.join(os.homedir(), '.zcode', 'cli', `engine-${projectId}-${epicId}.pid`);
  try {
    if (existsSync(lockFile)) {
      const existingPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
      if (existingPid && !Number.isNaN(existingPid)) {
        // Check if process is alive: process.kill(pid, 0) throws if dead.
        try {
          process.kill(existingPid, 0);
          // Process is alive — this is a DUPLICATE engine. Exit.
          engineHeartbeat(opts, 'DUPLICATE_EXIT',
            `engine PID ${existingPid} already running for project=${projectId} epic=${epicId} — exiting`);
          writeEpisodeMeta(epicId, { engine_rejected: true, engine_rejected_reason: `PID ${existingPid} already running` });
          return {
            projectId, epicId, finalStage: currentStage(epicId) ?? 'unknown',
            endedAt: new Date(now()).toISOString(),
            reason: 'failed', cycles: 0,
            lastError: `duplicate engine — PID ${existingPid} already running`,
          };
        } catch {
          // Process is dead — stale lock. Remove and claim.
          try { unlinkSync(lockFile); } catch { /* ignore */ }
        }
      }
    }
    // Claim the lock with our PID.
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, String(process.pid), { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const winnerPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
      engineHeartbeat(opts, 'DUPLICATE_EXIT',
        `engine PID ${winnerPid || '?'} won atomic lock for project=${projectId} epic=${epicId}`);
      return {
        projectId, epicId, finalStage: currentStage(epicId) ?? 'unknown',
        endedAt: new Date(now()).toISOString(),
        reason: 'failed', cycles: 0,
        lastError: `duplicate engine — PID ${winnerPid || '?'} owns atomic lock`,
      };
    }
    engineHeartbeat(opts, 'LOCK_WARN', `PID-lock failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Resolve the project's workspace (where `claude -p` will run).
  const projects = projectHandlers.project_list({}) as unknown as Array<{ id: number }>;
  const project = projects.find(p => p.id === projectId);
  if (!project) {
    throw new Error(`orchestrate: project ${projectId} not found`);
  }
  const workspaceRoot = resolveProjectWorkspaceForEngine(projectId);
  if (!workspaceRoot) {
    throw new Error(
      `orchestrate: no workspace resolved for project ${projectId}. ` +
      `Register a repository via repository_register({local_path}) first.`,
    );
  }

  const runner = createClaudeBoardRunner({
    // dispatcherHandlers.worker_next returns `unknown` (ToolHandler signature);
    // claude-runner.mjs consumes assignment.task / assignment.skill but does
    // not type-check them at runtime. Cast through unknown to satisfy tsc.
    claimTask: (args: {
      worker_id: string; project_id: number; machine_id?: string; epic_id?: number;
      execution_id?: string; run_id?: string;
    }) =>
      dispatcherHandlers.worker_next(args) as ReturnType<typeof dispatcherHandlers.worker_next> as never,
    getProject: (id: number) => getDb().prepare('SELECT * FROM projects WHERE id=?').get(id),
    getTaskState: (taskId: number) => {
      const row = getDb().prepare(
        'SELECT id, status, assigned_to, tags, integration_state FROM tasks WHERE id=?',
      ).get(taskId);
      return row as { id: number; status: string; assigned_to: string | null; tags: string; integration_state: string | null } | undefined;
    },
    recoverAssignment: ({ taskId, workerId, originalStatus, executionId, reason }: {
      taskId: number; workerId: string; originalStatus: string; reason: string;
      executionId?: string | null;
    }) => {
      // Slice 1 (ADR-010/011, blueprint §16:829-845): fenced-task recovery
      // delegates to the single atomic terminalization+release function in
      // src/lifecycle/atomic-release.ts. This removes the duplicate recovery
      // SQL between orchestrate.ts and tracker-view (blueprint §22:1199) and
      // collapses the close/reconciler race: the function's fence CAS means
      // only one of the two callers wins; the other no-ops.
      //
      // Legacy (pre-ADR-009, unfenced) assignments still need the old code path.
      const db = getDb();
      const task = db.prepare(
        `SELECT id, title, status, assigned_to, tags, current_execution_id
         FROM tasks WHERE id=?`,
      ).get(taskId) as {
        id: number; title: string; status: string; assigned_to: string;
        tags: string; current_execution_id: string | null;
      } | undefined;
      if (!task || task.assigned_to !== workerId) return false;
      let tags: string[] = [];
      try { tags = JSON.parse(task.tags || '[]'); } catch { tags = []; }
      if (tags.includes('needs-human')) return false;

      // Fenced task: delegate to atomic-release.
      if (executionId && task.current_execution_id === executionId) {
        const outcome = releaseExecutionAtomically(db, {
          executionId,
          terminalState: 'lost',
          reason: `engine recovery: ${reason ?? 'process exited before terminal worker_done'}`,
        });
        if (outcome.taskReleased) {
          logActivity(db, 'task', taskId, 'status_changed', 'status',
            task.status, outcome.restoredStatus,
            `Engine recovered task '${task.title}' (atomic): ${reason ?? ''}`);
        }
        return outcome.taskReleased;
      }

      // Legacy path: pre-ADR-009 unfenced assignment.
      const restoredStatus =
        originalStatus === 'review' && task.status !== 'in_progress' ? 'review' : 'todo';
      const info = db.prepare(
        `UPDATE tasks
         SET status=?, assigned_to=NULL, current_execution_id=NULL, updated_at=datetime('now')
         WHERE id=? AND assigned_to=?
           AND (current_execution_id IS NULL OR current_execution_id=?)`,
      ).run(restoredStatus, taskId, workerId, executionId ?? null);
      return info.changes === 1;
    },
    resolveWorkspace: () => workspaceRoot,
    dbPath: process.env.DB_PATH!,
    sagaEntry: opts.sagaEntry ?? path.join(__dirname, '..', 'dist', 'index.js'),
    sagaSkillRoot: opts.sagaSkillRoot ?? path.join(__dirname, '..', 'skills'),
    claudePath: opts.claudePath,
    spawn: opts.spawn ?? nodeSpawn,
    logRoot: opts.logRoot,
    heartbeatLog: opts.heartbeatLog,
  });

  engineHeartbeat(opts, 'ENGINE_START',
    `project=${projectId} epic=${epicId} concurrency=${concurrency} workspace=${workspaceRoot}`);

  // Ensure the episode has a workflow row (lifecycle.getOrCreate-style).
  getDb().prepare('INSERT OR IGNORE INTO episode_workflows (epic_id) VALUES (?)').run(epicId);

  // Persist engine state for UI consumption (concurrency selector reads this).
  // Updated on every engine start; cleared in engineHeartbeat on ENGINE_EXIT.
  writeEpisodeMeta(epicId, {
    engine_concurrency: concurrency,
    engine_pid: process.pid,
    engine_started_at: new Date().toISOString(),
  });

  let cycles = 0;
  let emptyCycles = 0;
  let lastError: string | null = null;

  try {
    while (true) {
      cycles += 1;
      const stage = currentStage(epicId);
      if (!stage) {
        lastError = `episode ${epicId} workflow row vanished mid-run`;
        engineHeartbeat(opts, 'ABORT', lastError);
        break;
      }
      if (stage === 'completed' || stage === 'cancelled') {
        // Before exiting, check whether any bookkeeping tasks (summary.stage,
        // recovery.heal) in this terminal stage are still claimable or
        // in-flight. These tasks are spawned by the engine itself (e.g. the
        // auto-spawn summary at stage transition) and must complete before
        // the engine exits — otherwise they stay stranded in todo with no
        // pump to claim them. assertTasksReady excludes them from the
        // transition gate (lifecycle.ts), which is correct for advancing the
        // episode, but the engine must still drain them. Gate-level tasks
        // (development.code, verification.ac, etc.) cannot exist here: the
        // episode would not have transitioned to 'completed' otherwise.
        const drainable = getDb().prepare(
          `SELECT
             SUM(CASE WHEN status IN ('todo','review')
                       AND (assigned_to IS NULL OR assigned_to='')
                       AND current_execution_id IS NULL THEN 1 ELSE 0 END) AS claimable,
             SUM(CASE WHEN status IN ('in_progress','review_in_progress')
                       OR (status='review' AND assigned_to IS NOT NULL AND assigned_to!='')
                       THEN 1 ELSE 0 END) AS in_flight
           FROM tasks
           WHERE epic_id=? AND workflow_stage=?
             AND task_kind IN ('summary.stage','recovery.heal')`,
        ).get(epicId, stage) as { claimable: number | null; in_flight: number | null };
        const claimable = drainable?.claimable ?? 0;
        const inFlight = drainable?.in_flight ?? 0;
        if (claimable === 0 && inFlight === 0) {
          engineHeartbeat(opts, 'DONE', `stage=${stage} cycles=${cycles}`);
          return {
            projectId, epicId, finalStage: stage, endedAt: new Date(now()).toISOString(),
            reason: 'completed', cycles, lastError: null,
          };
        }
        // Else: fall through to the normal pump path. The engine will keep
        // cycling until every summary/recovery task in this terminal stage
        // is done, then exit on the next cycle.
        engineHeartbeat(opts, 'DRAINING',
          `stage=${stage} claimable=${claimable} in_flight=${inFlight} (summary/recovery bookkeeping)`);
      }

      // Step 1: pump workers for any claimable tasks in the current stage.
      let run: ReturnType<typeof runner.status>;
      try {
        // Idempotent start: if a run is already active for this project,
        // start() throws — we treat that as "workers are already pumping".
        try {
          runner.start({ projectId, epicId, concurrency: effectiveConcurrency });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already has an active board run/.test(msg)) throw err;
        }
        run = runner.status(projectId);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        engineHeartbeat(opts, 'PUMP_FAILED', lastError);
        // Don't abort the whole engine on a pump failure — sleep and retry.
        await sleep(PUMP_TICK_MS);
        continue;
      }

      // Re-evaluate downstream deps for every done task in the epic. saga's
      // worker_done / worker_merge_release handlers call reevaluateDownstream
      // themselves, but if anything modified task state outside that path
      // (recovery healer, manual DB fix, engine restart mid-cycle), blocked
      // tasks may remain blocked even though their deps are now done+merged.
      // Calling it here is idempotent and cheap (one UPDATE per ready task).
      const doneTasks = getDb().prepare(
        `SELECT id FROM tasks WHERE epic_id=? AND status='done'`,
      ).all(epicId) as Array<{ id: number }>;
      for (const d of doneTasks) reevaluateDownstream(getDb(), d.id);

      // Reconcile durable process state every ~30s. Quiet logs are ignored.
      zombieCheckCounter += 1;
      if (zombieCheckCounter >= ZOMBIE_CHECK_TICKS) {
        zombieCheckCounter = 0;
        const killed = detectAndKillZombies(epicId, projectId, opts);
        if (killed > 0) emptyCycles = 0;
      }

      // Rate-limit scanner: every RATE_LIMIT_SCAN_TICKS cycles, check active
      // workers' JSONL tails for 429 rate_limit events. When detected, kill
      // NATURAL ROTATION: rate-limit scan + model-limit ceiling.
      //
      // Every RATE_LIMIT_SCAN_TICKS cycles (~10s):
      // 1. Re-read active_model_limit from metadata (mid-run model switch)
      // 2. Scan workers for 429 → lower effectiveConcurrency (ceiling)
      // 3. If 60s without 429 → recover toward target
      // 4. Apply via runner.setConcurrency — no kill, no spawn, just ceiling
      //    Workers that hit 429 keep running (claude backoff); when they die
      //    naturally, pump() won't spawn a replacement if below ceiling.
      rateLimitCheckCounter += 1;
      if (rateLimitCheckCounter >= RATE_LIMIT_SCAN_TICKS) {
        rateLimitCheckCounter = 0;
        const lim = readActiveModelLimit(epicId);
        targetConcurrency = lim !== null ? Math.min(concurrency, lim) : concurrency;
        const rlDetected = detectRateLimits(epicId, projectId, opts);
        if (rlDetected > 0) {
          // Drop ceiling by 1 per rate-limited worker (min 1). Old workers
          // keep running and eventually die; no replacements spawn until
          // active count drops below the new ceiling.
          effectiveConcurrency = Math.max(1, effectiveConcurrency - rlDetected);
          emptyCycles = 0;
        }
        // Recovery: if no 429 for cooldown window, climb back toward target.
        effectiveConcurrency = computeEffectiveConcurrency(targetConcurrency, effectiveConcurrency);
        // Apply ceiling to runner — live, no restart needed.
        runner.setConcurrency(projectId, effectiveConcurrency);
      }

      const counts = countActiveTasks(epicId);
      const workersBusy = (run?.active?.length ?? 0) > 0;

      engineHeartbeat(opts, 'CYCLE',
        `stage=${stage} claimable=${counts.claimable} in_flight=${counts.inFlight}` +
        ` workers=${run?.active?.length ?? 0}`);

      // Step 2: if there's nothing to claim AND no workers running, try to
      // generate the next wave of tasks.
      //
      // CRITICAL (discovered during 4D_Las_viewer first run): the gate must
      // also block when counts.inFlight > 0, not just when workersBusy is true.
      // workersBusy reflects only THIS runner's child processes; but a worker
      // spawned by a PREVIOUS engine process (or by tracker-view's board-run)
      // is still in_flight at the DB level (task.status='in_progress'). Without
      // this check, the engine races ahead: kicks off episode_transition while
      // kickstart worker is mid-flight writing its brief — episode jumps to
      // 'formalization' with no artifacts, then crashes the planning gate.
      if (counts.claimable === 0 && !workersBusy && counts.inFlight === 0) {
        const gen = generateNextIfReady(epicId);
        if (gen.error) {
          engineHeartbeat(opts, 'GEN_ERROR', gen.error.slice(0, 200));
          lastError = gen.error;
        }
        if (gen.created > 0) {
          engineHeartbeat(opts, 'GENERATED', `tasks=${gen.created}`);
          emptyCycles = 0;
          continue; // new tasks appeared — pump them next cycle
        }

        // ADR-012 — Multi-track pipeline. When generateNextIfReady returns
        // created:0 from a discovery.kickstart brief_accepted transition,
        // consult the brief's decision. workflow.ts has already done the
        // side-effects it can (routeFastTrack for fast-track); the engine
        // handles the remaining control flow:
        //   - 'go' → fall through to tryAdvanceStage (formal pipeline).
        //   - 'fast-track' → routeFastTrack already wrote stage='development'
        //     directly; just continue and the next cycle will see the new stage.
        //   - 'clarify' → pause with needs-human; await resume or timeout.
        //   - 'reject' → episode_transition(cancelled).
        // Only consult the brief when we're still in discovery — once we've
        // advanced, the decision has been honoured and re-reading it would
        // re-enter the branch every cycle.
        if (stage === 'discovery') {
          const decision = readLatestBriefDecision(epicId);
          if (decision === 'fast-track') {
            engineHeartbeat(opts, 'FAST_TRACK',
              `brief decision='fast-track' → routeFastTrack jumped stage; continuing`);
            emptyCycles = 0;
            continue;
          }
          if (decision === 'clarify') {
            engineHeartbeat(opts, 'CLARIFY',
              `brief decision='clarify' → pausing for human input`);
            await pauseAndAlert(epicId,
              `Brief decision='clarify': discovery could not reach a verdict. ` +
              `Read the latest brief artifact and answer the open question via ` +
              `POST /api/episode/resume after updating the brief.`,
              opts);
            const resumed = await waitForResume(epicId, opts);
            if (!resumed) {
              return {
                projectId, epicId, finalStage: stage, endedAt: new Date(now()).toISOString(),
                reason: 'paused_timeout', cycles, lastError: 'clarify pause timed out',
              };
            }
            emptyCycles = 0;
            continue;
          }
          if (decision === 'reject') {
            try {
              lifecycleHandlers.episode_transition({ epic_id: epicId, to_stage: 'cancelled' });
              engineHeartbeat(opts, 'REJECT',
                `brief decision='reject' → episode cancelled`);
            } catch (e) {
              engineHeartbeat(opts, 'REJECT_FAILED',
                `reject transition failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            emptyCycles = 0;
            continue;
          }
          // decision === 'go' OR undefined/unknown — fall through to
          // tryAdvanceStage below.
        }

        // Step 3: nothing left to generate. Try to advance the stage.
        const advance = tryAdvanceStage(epicId);
        if (advance.advanced) {
          engineHeartbeat(opts, 'STAGE_ADVANCED', `${stage} → ${currentStage(epicId)}`);
          emptyCycles = 0;
          continue;
        }
        if (advance.error) {
          // Hard gate failed. If it's a recoverable "tasks not ready" we just
          // wait; if it's a substantive gate failure, try self-heal first.
          const isTasksReady = /gate failed: tasks not completed/i.test(advance.error)
            || /gate failed: no .* tasks exist/i.test(advance.error);
          if (isTasksReady && (counts.inFlight > 0 || counts.claimable > 0)) {
            // Workers still finishing OR tasks still waiting to be claimed —
            // this is NOT a gate failure, it's normal "work in progress".
            // Wait silently. Do NOT escalate to healer or human.
            await sleep(PUMP_TICK_MS);
            continue;
          }

          // Recovery: consult RECOVERY_TREE before bothering a human.
          // attemptHeal either spawns a healer task (applied:true) or
          // returns escalate:true when budget exhausted / unknown failure.
          // Only check for a NEW gate error — if it changed since last heal
          // attempt, the previous heal made progress (different failure now),
          // so we reset the retry counter for the new diagnosis.
          const meta = readEpisodeMeta(epicId);
          if (meta.lastHealError !== advance.error) {
            // New error → previous heal advanced the diagnosis. Reset counters
            // for the new error so the engine can heal again.
            resetHealRetriesForEpic(epicId);
          }
          const heal = attemptHeal(epicId, stage, advance.error);
          writeEpisodeMeta(epicId, { lastHealError: advance.error, lastHealAttempt: new Date().toISOString() });
          if (heal.applied) {
            engineHeartbeat(opts, 'HEALING',
              `spawned task #${heal.taskId} — ${heal.reason.slice(0, 100)}`);
            lastError = null;
            emptyCycles = 0;
            // Clear needs-human so waitForResume isn't triggered; the pump
            // loop will pick up the healer task on next cycle and wait for
            // it like any other worker.
            clearNeedsHuman(epicId);
            await sleep(PUMP_TICK_MS);
            continue;
          }

          // Healer couldn't help → escalate to human.
          engineHeartbeat(opts, 'ESCALATE', `recovery gave up: ${heal.reason}`);
          lastError = `${advance.error} [healer: ${heal.reason}]`;
          await pauseAndAlert(epicId, lastError, opts);
          const resumed = await waitForResume(epicId, opts);
          if (!resumed) {
            return {
              projectId, epicId, finalStage: stage, endedAt: new Date(now()).toISOString(),
              reason: 'paused_timeout', cycles, lastError,
            };
          }
          // Resumed — clear flag and continue (the human may have advanced
          // the stage manually; currentStage() will reflect it next loop).
          clearNeedsHuman(epicId);
          // Human override → reset retry budget, give the engine a fresh start.
          resetHealRetriesForEpic(epicId);
          emptyCycles = 0;
          continue;
        }

        // No tasks, no generation, no transition, no error → empty cycle.
        emptyCycles += 1;
        engineHeartbeat(opts, 'EMPTY', `empty=${emptyCycles}/${MAX_EMPTY_CYCLES}`);
        if (emptyCycles >= MAX_EMPTY_CYCLES) {
          engineHeartbeat(opts, 'STOP', `${MAX_EMPTY_CYCLES} empty cycles — engine done`);
          break;
        }
        await sleep(PUMP_TICK_MS);
        continue;
      }

      // There are claimable tasks or workers in flight — wait for progress.
      emptyCycles = 0;
      await sleep(PUMP_TICK_MS);
    }
  } finally {
    try { runner.dispose(); } catch { /* best effort */ }
    // Release PID-lock so the next engine can start.
    try {
      if (typeof lockFile !== 'undefined' && existsSync(lockFile)) {
        const ownerPid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
        if (ownerPid === process.pid) unlinkSync(lockFile);
      }
    } catch { /* stale lock, ignore */ }
    engineHeartbeat(opts, 'ENGINE_EXIT', `cycles=${cycles} lastError=${lastError ?? 'null'}`);
  }

  const finalStage = currentStage(epicId) ?? 'unknown';
  return {
    projectId, epicId, finalStage, endedAt: new Date(now()).toISOString(),
    reason: finalStage === 'completed' ? 'completed' : 'failed',
    cycles, lastError,
  };
}

/**
 * Resolve the workspace root for spawning workers. Preference order:
 *  1. The first registered repository with a local_path that exists on disk.
 *  2. Null if no usable workspace is found.
 *
 * Mirrors tracker-view.mjs resolveProjectWorkspace but kept self-contained
 * so the engine does not depend on the HTTP server.
 */
function resolveProjectWorkspaceForEngine(projectId: number): string | null {
  const db = getDb();
  const rows = db.prepare(
    `SELECT pr.id, r.name, COALESCE(rc.local_path, pr.local_path) AS local_path
     FROM project_repositories pr
     JOIN repositories r ON r.id=pr.repository_id
     LEFT JOIN repository_checkouts rc
       ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
     WHERE pr.project_id=? AND pr.status='active'
     ORDER BY pr.id`,
  ).all(os.hostname(), projectId) as Array<{ id: number; name: string; local_path: string | null }>;
  for (const r of rows) {
    if (r.local_path && existsSync(r.local_path)) return r.local_path;
  }
  return null;
}

/** Re-export for tests. */
export { closeDb };
