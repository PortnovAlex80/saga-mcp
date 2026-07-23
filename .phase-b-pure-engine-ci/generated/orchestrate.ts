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
import { closeDb } from './db.js';
import type { Saga2RuntimePersistence } from './application/ports/saga2-runtime-persistence.js';
import type {
  WorkerExecutorFactory,
  WorkerRunSnapshot,
} from './application/ports/worker-executor.js';
import { generateNextForCompletedTask } from './tools/workflow.js';
import { handlers as lifecycleHandlers } from './tools/lifecycle.js';

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
    // NOTE (ADR-013 pipeline-reorder-srs-after-ac): workflow.ts now spawns
    // the formalization.ac task from uc_accepted (UC has no upstream sibling
    // to wait for anymore; SRS moved post-baseline). So AC generation is the
    // normal pipeline, not a recovery concern. The rule below is a SAFETY NET
    // for unusual cases: a saga-analyst worker crashed mid-AC, or someone
    // manually deleted accepted ACs. In the happy path this rule never fires
    // because the formalization.ac task succeeded and the baseline is already
    // accepted before episode_transition runs.
    {
      match: /no AC artifacts/i,
      diagnosis: 'Episode has no AC artifacts. Either formalization.ac task has not run, or saga-analyst did not register AC artifacts.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: episode is stuck in formalization because no AC (acceptance criteria) artifacts exist.',
        'epic_id=<EPIC_ID>',
        '',
        'You have full authority to fix this yourself. DO NOT call worker_ask_need unless Cynefin triage in the skill returns "genuine human-only" (rare for this scenario).',
        '',
        'DIAGNOSTIC QUERIES (Step 1 of the loop):',
        '- artifact_list({epic_id, type:"UC"}) and artifact_list({epic_id, type:"SRS"}) to see what exists.',
        '- artifact_list({epic_id, type:"FR"}) and type:"NFR" for the technical contract.',
        '',
        'FIX OPTIONS (Step 3 — generate 3 candidates, score, pick):',
        'A. If saga-analyst task exists but is in_review or in_progress: wait is not an option — move it forward via task_update or finish the work yourself by registering the ACs.',
        'B. Create the ACs yourself using saga-analyst semantics (Given/When/Then, properties block, derived_from → UC + FR). This is usually the right call — you have the UCs and FRs.',
        'C. task_create a new formalization.ac task to redrive the pipeline.',
        '',
        'Most likely answer: B. The agent has more context about the system than the human sponsor; asking the human to write ACs is an anti-pattern.',
      ].join('\n'),
      max_retries: 2,
    },
    {
      match: /AC baseline is not accepted and clean/i,
      diagnosis: 'ACs exist but not accepted, or drifted from disk.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: AC baseline gate failed — ACs are not all accepted+clean.',
        'epic_id=<EPIC_ID>',
        '',
        'You have full authority to fix this yourself. Common fixes (apply via MCDA in the skill):',
        '- artifact_save to refresh content_hash from the on-disk .md file, then artifact_update({status:"accepted"}).',
        '- If accepted_hash is missing (reconciler forgot to stamp it): artifact_save will set content_hash, then artifact_update({status:"accepted"}) will set accepted_hash = content_hash.',
        '- If the .md file is empty or missing: that is a real defect — consider moving the formalization.ac task back to todo via task_update({status:"todo"}) so saga-analyst rewrites it.',
        '',
        'DO NOT call worker_ask_need for stale hashes or missing accepted_hash — those are mechanical fixes the agent should do directly.',
      ].join('\n'),
      max_retries: 2,
    },
    {
      match: /Traceability gate failed:.*/i,
      diagnosis: 'A canonical lineage edge is missing in artifact_traces (PRD→brief, SRS→PRD, UC→PRD, AC→UC, etc.).',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: assertTraceability gate rejected the formalization→planning transition.',
        'epic_id=<EPIC_ID>',
        '',
        'The gate error names the exact missing edge (e.g. "AC AC-5 has no derived_from trace to any UC"). Diagnose via trace_list({source_id:<X>}), then add the edge via trace_add.',
        '',
        'COMMON CASES (decide via MCDA in the skill):',
        '- Missing edge with an obvious parent (PRD→brief, SRS→PRD, UC→PRD): just trace_add it. Clear case.',
        '- AC missing UC trace but has FR trace: usually means saga-analyst forgot the UC link. Read the AC body, find the matching UC, trace_add.',
        '- AC has only NFR trace (no UC, no FR): this is a cross-cutting AC (performance, code quality). The gate EXEMPTS these — if the AC has only NFR, the gate does not require UC. If the gate still complains, that is a gate bug — note it in the comment and proceed (move the AC to add a token UC trace as a workaround).',
        '- Wrong parent (e.g. AC traces to wrong UC): move the producer task back to todo via task_update({status:"todo"}) so saga-analyst re-runs.',
        '',
        'DO NOT call worker_ask_need for missing traces — the agent can read the artifacts and decide the correct edge.',
      ].join('\n'),
      max_retries: 3,
    },
    {
      match: /no PRD artifacts|no SRS artifacts|no UC artifacts/i,
      diagnosis: 'Upstream formalization artifact missing — earlier worker crashed or skipped.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: a formalization artifact (PRD/SRS/UC) is missing entirely.',
        'epic_id=<EPIC_ID>',
        '',
        'Decide via MCDA in the skill:',
        'A. Recreate the artifact yourself by reading the upstream and applying the corresponding producer skill (saga-product/architect/analyst).',
        'B. task_create a new formalization.<kind> task to redrive the pipeline, with a comment explaining what went wrong.',
        'C. If the upstream itself is missing (no brief → no PRD), recurse: diagnose the brief, etc.',
        '',
        'DO NOT call worker_ask_need — missing artifacts are an engineering defect the agent can repair.',
      ].join('\n'),
      max_retries: 2,
    },
  ],
  planning: [
    {
      match: /no planning tasks exist/i,
      diagnosis: 'saga-planner never ran or crashed.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: planning decomposition task is missing.',
        'epic_id=<EPIC_ID>',
        '',
        'Likely fix: task_create({epic_id, title:"Decompose accepted baseline", task_kind:"planning.decomposition", workflow_stage:"planning", execution_skill:"saga-planner", execution_mode:"tracker_only", priority:"high"}).',
        'Verify the AC baseline is accepted first; if not, you are in the wrong recovery branch — fix that first.',
      ].join('\n'),
      max_retries: 2,
    },
  ],
  development: [
    {
      match: /no development tasks exist/i,
      diagnosis: 'saga-planner did not decompose into dev tasks.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: saga-planner ran but produced no development tasks.',
        'epic_id=<EPIC_ID>',
        '',
        'Decide via MCDA in the skill:',
        'A. Re-run planning: move planning.decomposition task back to todo via task_update({status:"todo"}) so saga-planner re-executes.',
        'B. Inspect planning.decomposition output (comments + result) — the planner may have decided the baseline is not ready. Read its reasoning.',
        'C. Create development tasks yourself based on the ACs (each AC → at least one dev task with source_artifact_ids:[<AC id>]).',
        '',
        'DO NOT call worker_ask_need for planner output you can read and act on.',
      ].join('\n'),
      max_retries: 2,
    },
    {
      // Merge conflicts block the development→verification gate. The task is
      // done (worker finished, APPROVED) but its branch conflicted with dev.
      // Healer investigates: reads the task's worktree metadata, looks at the
      // conflicting files, either resolves the conflict (mechanical: both
      // sides add disjoint code) or reworks the offending task.
      match: /tasks not completed\/integrated:.*#(\d+(?:,\s*#\d+)*)/i,
      diagnosis: 'Some development tasks are done but their branches have merge conflicts or are still pending integration.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: development→verification gate failed — some done tasks have integration_state in (conflict, pending).',
        'epic_id=<EPIC_ID>',
        '',
        'For each blocked task, decide via MCDA in the skill:',
        'A. Mechanical conflict (different files, or disjoint regions of the same file): resolve by keeping both sides. git add, git commit, worker_merge_release({result:"merged"}).',
        'B. Semantic conflict (two tasks changed the same logic differently): pick the more correct version based on the ACs they implement. Move the loser back to todo via task_update({status:"todo"}). DO NOT silently pick — record which won and why in the comment.',
        'C. Pending integration (worker crashed before merge): re-attempt the merge via worker_merge_acquire + worker_merge_release.',
        '',
        'DO NOT call worker_ask_need for conflicts you can read and adjudicate.',
        'Your worker_id is in the task payload. The worktree path is in metadata.worktree.path.',
      ].join('\n'),
      max_retries: 3,
    },
  ],
  verification: [
    {
      match: /no passing.*evidence.*(?:AC-[A-Z]*-?\d+)/i,
      diagnosis: 'Verification gate failed — ACs missing passing or unknown evidence at baseline hash.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: verification gate failed — some ACs lack passing/unknown evidence.',
        'epic_id=<EPIC_ID>',
        '',
        'STEP 1: DIAGNOSE each blocked AC. Query:',
        '  SELECT a.code, v.outcome, substr(v.evidence,1,200) AS ev',
        '  FROM artifacts a LEFT JOIN verification_evidence v ON v.artifact_id=a.id',
        '  WHERE a.epic_id=<EPIC_ID> AND a.type=\'AC\' AND a.status=\'accepted\'',
        '  AND NOT EXISTS (SELECT 1 FROM verification_evidence v2 WHERE v2.artifact_id=a.id AND v2.outcome IN (\'passed\',\'unknown\') AND v2.content_hash=a.accepted_hash)',
        '',
        'STEP 2: For each blocked AC, classify:',
        '  - outcome=failed exists → REAL BUG. Find the dev task that implements this AC',
        '    (via trace_list({target_type:"task", target_id:<dev task>}) or task metadata.source_artifact_ids).',
        '    Move that dev task BACK to todo: task_update({_recovery_override:true, id:<dev_task_id>, status:"todo"}).',
        '    Add a comment explaining: "AC-<code> verification FAILED — rework needed: <reason from evidence>".',
        '    The dev worker will re-run and fix the bug. DO NOT re-spawn the verifier — it already did its job.',
        '  - NO evidence at all → verifier never ran. Spawn a new verification.ac task.',
        '  - outcome=unknown exists → should NOT be blocking (gate accepts unknown). If it still blocks,',
        '    the evidence content_hash may not match — record new unknown evidence with the correct hash.',
        '',
        'STEP 3: After moving dev tasks back, worker_done. The engine will:',
        '  - dispatch dev workers to rework the bugs',
        '  - after dev done, dispatch verifiers to re-verify',
        '  - the gate retries automatically',
        '',
        'CRITICAL: DO NOT call worker_ask_need. DO NOT re-spawn verifiers that already recorded failed.',
        'The fix path for failed ACs is: dev rework → dev done → verify again. Not: verify again → fail again → loop.',
      ].join('\n'),
      max_retries: 3,
    },
  ],
  integration: [
    {
      match: /no integration tasks exist/i,
      diagnosis: 'workflow did not generate integration task.',
      action_prompt: [
        'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
        '',
        'CONTEXT: integration task is missing.',
        'epic_id=<EPIC_ID>',
        '',
        'Likely fix: task_create({epic_id, title:"Integrate verified baseline", task_kind:"integration.merge", workflow_stage:"integration", execution_skill:"saga-worker", execution_mode:"git_change", priority:"high"}).',
      ].join('\n'),
      max_retries: 2,
    },
    // Merge conflicts at integration → run the autonomous-recovery loop.
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
  dbPath: string;
  lmStudioUrl: string;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
  sagaEntry?: string;
  sagaSkillRoot?: string;
  logRoot?: string;
  heartbeatLog?: string;
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
function currentStage(epicId: number, opts: OrchestrateOptions): string | null {
  return opts.persistence.episodes.currentStage(epicId);
}

/**
 * Count tasks in a stage by status. Used by the engine to decide whether to
 * pump workers, generate next, or attempt a transition.
 */
function countActiveTasks(epicId: number, opts: OrchestrateOptions) {
  const stage = currentStage(epicId, opts);
  if (!stage) return { claimable: 0, inFlight: 0, doneInCurrentStage: 0 };
  return opts.persistence.tasks.countStageTasks(epicId, stage);
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
function generateNextIfReady(
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
  opts.persistence.episodes.pause(epicId, reason);
  engineHeartbeat(opts, 'PAUSED', `reason="${reason.slice(0, 200)}"`);
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
    if (!opts.persistence.episodes.isNeedsHuman(epicId)) return true;
    await sleep(RESUME_POLL_MS);
  }
}

/**
 * Attempt to advance the episode by one stage. Returns true if the stage
 * changed, false if a hard gate blocked the transition (the caller then
 * pauses for human attention).
 */
function tryAdvanceStage(
  epicId: number,
  opts: OrchestrateOptions,
): { advanced: boolean; error: string | null } {
  const stage = currentStage(epicId, opts);
  if (!stage) return { advanced: false, error: `episode ${epicId} has no workflow row` };
  if (stage === 'completed' || stage === 'cancelled') return { advanced: false, error: null };
  if (opts.persistence.tasks.hasActiveRecovery(epicId)) return { advanced: false, error: null };

  const to = NEXT_STAGE[stage];
  if (!to) return { advanced: false, error: `no NEXT stage for '${stage}'` };
  try {
    const result = lifecycleHandlers.episode_transition({
      epic_id: epicId,
      to_stage: to as never,
    }) as { changed: boolean };

    if (result.changed) {
      const stranded = opts.persistence.tasks.listStrandedTasks(epicId, stage);
      if (stranded.length > 0) {
        const strandedList = stranded
          .map(task => `#${task.id} (${task.task_kind}, ${task.status})`)
          .join(', ');
        opts.persistence.tasks.recordPostTransitionSweep(
          epicId,
          strandedList,
          `Stage '${stage}' → '${to}': ${stranded.length} stranded task(s) detected — spawning recovery to resolve: ${strandedList}`,
        );
        spawnPostTransitionRecovery(epicId, stage, to, stranded, opts);
      }
    }
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
function attemptHeal(
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
    return { applied: false, escalate: true, reason: `no recovery rules for stage '${stage}'`, taskId: null };
  }
  const rule = rules.find(candidate => candidate.match.test(gateError));
  if (!rule) {
    return { applied: false, escalate: true, reason: `unmatched gate error for stage '${stage}': ${gateError.slice(0, 120)}`, taskId: null };
  }
  const healKey = `${epicId}:${stage}:${rule.diagnosis}`;
  const retries = healRetries.get(healKey) ?? 0;
  if (retries >= rule.max_retries) {
    return { applied: false, escalate: true, reason: `max_retries (${rule.max_retries}) reached for: ${rule.diagnosis}`, taskId: null };
  }
  healRetries.set(healKey, retries + 1);
  if (opts.persistence.episodes.projectIdForEpic(epicId) === null) {
    return { applied: false, escalate: true, reason: `epic ${epicId} has no project`, taskId: null };
  }

  const prompt = rule.action_prompt.replace(/<EPIC_ID>/g, String(epicId));
  const taskId = opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: `Recovery: ${rule.diagnosis.slice(0, 80)}`,
    description: `RECOVERY TASK (auto-spawned by engine).\n\nStage: ${stage}\nGate error: ${gateError}\nDiagnosis: ${rule.diagnosis}\n\n${prompt}`,
    workflowStage: stage,
    tags: [`stage:${stage}`, 'kind:recovery.heal', 'role:recovery'],
    activitySummary: `Engine auto-spawned recovery task #<TASK_ID> for stage='${stage}' (attempt ${retries + 1}/${rule.max_retries}): ${rule.diagnosis}`,
  });
  return { applied: true, escalate: false, reason: `spawned task #${taskId}`, taskId };
}

/**
 * Spawn a generic autonomous-recovery task for an unmatched gate error.
 *
 * This is the catch-all path when RECOVERY_TREE has no rule matching the
 * gate error. Instead of immediately pausing for a human, the engine gives
 * the autonomous-recovery skill a chance to diagnose and fix the problem
 * itself. The agent has access to all saga tools (task_update, trace_add,
 * artifact_update, artifact_save, task_create) and the full gate error text.
 *
 * The skill runs a 6-step decision loop (Cynefin triage + MCDA + apply + verify)
 * and only calls worker_ask_need if it classifies the situation as genuinely
 * human-only (irreversible, no domain knowledge, unsafe to guess).
 */
function spawnGenericRecoveryTask(
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
    `epic_id=${epicId}`,
    `stage=${stage}`,
    `gate_error=${gateError}`,
    '',
    'YOUR AUTHORITY:',
    '- Diagnose the root cause via DB queries (artifact_list, task_list, trace_list, artifact_get).',
    '- Apply fixes: trace_add, artifact_update, artifact_save, task_create.',
    '- Move tasks backwards via task_update({_recovery_override: true, status: "todo"}) when a producer left bad output.',
    '- Spawn new tasks via task_create when an upstream producer crashed.',
    '',
    'DO NOT call worker_ask_need unless Cynefin triage in the skill returns "genuine human-only" (credentials, business intent, irreversible destructive action, external authority).',
    'Routine engineering failures (missing traces, stale hashes, draft artifacts, crashed workers) are YOUR job to fix.',
  ].join('\n');
  return opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: `Generic recovery: ${gateError.slice(0, 80)}`,
    description: prompt,
    workflowStage: stage,
    tags: [`stage:${stage}`, 'kind:recovery.heal', 'role:recovery', 'generic:true'],
    activitySummary: `Engine auto-spawned GENERIC recovery task #<TASK_ID> for stage='${stage}' (unmatched gate error): ${gateError.slice(0, 120)}`,
  });
}

/**
 * Spawn a recovery task to resolve STRANDED tasks after a stage transition.
 *
 * When the episode advances from stage X to stage Y, any task with
 * workflow_stage=X that is NOT done becomes invisible to workers — the
 * stage-filter in claimTask blocks cross-stage claims. These tasks would
 * pollute the kanban forever.
 *
 * Instead of silently auto-closing them, the engine spawns a recovery task
 * that gets the full list of stranded tasks and uses the autonomous-recovery
 * skill to decide per-task:
 *   - summary.stage / bookkeeping → close it (task_update status='done')
 *   - real work left (in_progress, review) → rewind to todo for the NEW stage,
 *     or close if the work is already captured in artifacts
 *   - genuine blocker → record and close
 *
 * This is the "post-transition sweep": the engine doesn't guess — it delegates
 * to recovery, which has the tools and the decision loop.
 */
function spawnPostTransitionRecovery(
  epicId: number,
  fromStage: string,
  toStage: string,
  stranded: Array<{ id: number; task_kind: string; status: string }>,
  opts: OrchestrateOptions,
): number {
  if (opts.persistence.episodes.projectIdForEpic(epicId) === null) return -1;
  const strandedList = stranded
    .map(task => `  #${task.id}: task_kind='${task.task_kind}', status='${task.status}'`)
    .join('\n');
  const prompt = [
    'Load skill "autonomous-recovery" and run its 6-step recovery loop.',
    '',
    'CONTEXT: the episode just transitioned from one stage to the next,',
    'and some tasks from the PREVIOUS stage are still NOT done. They are',
    'now invisible to workers (the stage-filter blocks cross-stage claims).',
    'You must resolve each one.',
    '',
    `epic_id=${epicId}`,
    `transition: '${fromStage}' → '${toStage}'`,
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
  ].join('\n');
  return opts.persistence.tasks.createRecoveryTask({
    epicId,
    title: `Post-transition sweep: ${stranded.length} stranded task(s) from '${fromStage}'`,
    description: prompt,
    workflowStage: toStage,
    tags: [`stage:${toStage}`, 'kind:recovery.heal', 'role:recovery', 'post_transition_sweep:true'],
    activitySummary: `Post-transition sweep: spawned recovery task #<TASK_ID> to resolve ${stranded.length} stranded task(s) from stage='${fromStage}' → '${toStage}'`,
  });
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
  const reconciled = opts.persistence.executions.reconcile(projectId, epicId);
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
  const tasks = opts.persistence.tasks.listRateLimitTasks(epicId);

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
    // Re-read EVERY RATE_LIMIT_SCAN_TICKS cycle (see pump loop) so BOTH:
    //   - a model switch (/api/model/set → $.active_model_limit), AND
    //   - a concurrency switch (/api/engine/concurrency → $.engine_concurrency)
    // take effect WITHOUT an engine restart. Active workers finish; the
    // engine converges to the new target as the active count drops.
    return readTargetConcurrency(epicId, concurrency, opts);
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
          writeEpisodeMeta(epicId, { engine_rejected: true, engine_rejected_reason: `PID ${existingPid} already running` }, opts);
          return {
            projectId, epicId, finalStage: currentStage(epicId, opts) ?? 'unknown',
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
        projectId, epicId, finalStage: currentStage(epicId, opts) ?? 'unknown',
        endedAt: new Date(now()).toISOString(),
        reason: 'failed', cycles: 0,
        lastError: `duplicate engine — PID ${winnerPid || '?'} owns atomic lock`,
      };
    }
    engineHeartbeat(opts, 'LOCK_WARN', `PID-lock failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Resolve the project's workspace (where `claude -p` will run).
  const workspace = opts.persistence.workspaces.resolve(projectId);
  if (!workspace.projectExists) {
    throw new Error(`orchestrate: project ${projectId} not found`);
  }
  const workspaceRoot = workspace.workspaceRoot;
  if (!workspaceRoot) {
    throw new Error(
      `orchestrate: no workspace resolved for project ${projectId}. ` +
      `Register a repository via repository_register({local_path}) first.`,
    );
  }

  const runner = opts.workerExecutorFactory({
    projectId,
    epicId,
    workspaceRoot,
    dbPath: opts.dbPath,
    sagaEntry: opts.sagaEntry ?? path.join(__dirname, '..', 'dist', 'index.js'),
    sagaSkillRoot: opts.sagaSkillRoot ?? path.join(__dirname, '..', 'skills'),
    claudePath: opts.claudePath,
    logRoot: opts.logRoot,
    heartbeatLog: opts.heartbeatLog,
    lmStudioUrl: opts.lmStudioUrl,
  });

  engineHeartbeat(opts, 'ENGINE_START',
    `project=${projectId} epic=${epicId} concurrency=${concurrency} workspace=${workspaceRoot}`);

  // Ensure the episode has a workflow row (lifecycle.getOrCreate-style).
  opts.persistence.episodes.ensureWorkflow(epicId);

  // Persist engine state for UI consumption (concurrency selector reads this).
  // Updated on every engine start; cleared in engineHeartbeat on ENGINE_EXIT.
  writeEpisodeMeta(epicId, {
    engine_concurrency: concurrency,
    engine_pid: process.pid,
    engine_started_at: new Date().toISOString(),
  }, opts);

  let cycles = 0;
  let emptyCycles = 0;
  let lastError: string | null = null;

  try {
    while (true) {
      cycles += 1;
      const stage = currentStage(epicId, opts);
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
        const drainable = opts.persistence.tasks.terminalBookkeepingCounts(epicId, stage);
        const claimable = drainable.claimable;
        const inFlight = drainable.inFlight;
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
      let run: WorkerRunSnapshot | null;
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
      opts.persistence.tasks.reevaluateDoneDependencies(epicId);

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
        // Re-read BOTH concurrency and model-limit from metadata. Either can
        // change mid-run via the kanban UI; both take effect without an
        // engine restart.
        targetConcurrency = readTargetConcurrency(epicId, concurrency, opts);
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

      const counts = countActiveTasks(epicId, opts);
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
        const gen = generateNextIfReady(epicId, opts);
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
          const decision = readLatestBriefDecision(epicId, opts);
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
        const advance = tryAdvanceStage(epicId, opts);
        if (advance.advanced) {
          engineHeartbeat(opts, 'STAGE_ADVANCED', `${stage} → ${currentStage(epicId, opts)}`);
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
          const meta = readEpisodeMeta(epicId, opts);
          if (meta.lastHealError !== advance.error) {
            // New error → previous heal advanced the diagnosis. Reset counters
            // for the new error so the engine can heal again.
            resetHealRetriesForEpic(epicId);
          }
          const heal = attemptHeal(epicId, stage, advance.error, opts);
          writeEpisodeMeta(epicId, { lastHealError: advance.error, lastHealAttempt: new Date().toISOString() }, opts);
          if (heal.applied) {
            engineHeartbeat(opts, 'HEALING',
              `spawned task #${heal.taskId} — ${heal.reason.slice(0, 100)}`);
            lastError = null;
            emptyCycles = 0;
            // Clear needs-human so waitForResume isn't triggered; the pump
            // loop will pick up the healer task on next cycle and wait for
            // it like any other worker.
            clearNeedsHuman(epicId, opts);
            await sleep(PUMP_TICK_MS);
            continue;
          }

          // Healer couldn't help via a specific rule. Before bothering a human,
          // spawn a GENERIC autonomous-recovery task that gets the full gate
          // error and runs the 6-step decision loop from the skill. This is
          // the catch-all for failures the RECOVERY_TREE did not anticipate
          // (new gate checks, edge cases, etc.). The agent has the tools and
          // the context — let it try to fix the problem itself.
          const genericHealKey = `${epicId}:${stage}:generic`;
          const genericRetries = healRetries.get(genericHealKey) ?? 0;
          if (genericRetries < 2 && !heal.applied) {
            healRetries.set(genericHealKey, genericRetries + 1);
            const genericTaskId = spawnGenericRecoveryTask(epicId, stage, advance.error, opts);
            engineHeartbeat(opts, 'GENERIC_HEAL',
              `spawned autonomous-recovery task #${genericTaskId} for unmatched gate error`);
            lastError = null;
            emptyCycles = 0;
            clearNeedsHuman(epicId, opts);
            await sleep(PUMP_TICK_MS);
            continue;
          }

          // Generic healer exhausted too → escalate to human.
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
          clearNeedsHuman(epicId, opts);
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

  const finalStage = currentStage(epicId, opts) ?? 'unknown';
  return {
    projectId, epicId, finalStage, endedAt: new Date(now()).toISOString(),
    reason: finalStage === 'completed' ? 'completed' : 'failed',
    cycles, lastError,
  };
}

/** Re-export for tests. */
export { closeDb };
