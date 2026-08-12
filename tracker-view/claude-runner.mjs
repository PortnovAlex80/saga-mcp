import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createRepeatedToolLoopDetector } from './repeated-tool-loop.mjs';
import {
  markExecutionExited,
  markExecutionProgress,
  markExecutionRunning,
  markExecutionSpawnFailed,
  readProcessBirthToken,
} from '../dist/worker-executions.js';

// ESM .mjs files don't have `require` — use createRequire to load CJS
// modules (better-sqlite3 is CJS). Used for worker_pid persistence.
const require = createRequire(import.meta.url);

const TERMINAL_RUN_STATES = new Set(['completed', 'stopped', 'failed']);

// Claude Code's --allowedTools is an auto-allow list, not a capability
// boundary when permission checks are bypassed. Keep one explicit inventory so
// a pinned AgentLaunchSpec can deny every undeclared native tool as well as
// auto-allowing the declared subset.
const CLAUDE_BUILTIN_TOOLS = Object.freeze([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
]);

function nowIso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function roleFromTask(task, fallbackSkill) {
  let tags = [];
  try { tags = JSON.parse(task.tags || '[]'); } catch {}
  const roleTag = tags.find(tag => typeof tag === 'string' && tag.startsWith('role:'));
  if (roleTag) return roleTag.slice('role:'.length);
  return fallbackSkill === 'saga-reviewer' ? 'reviewer' : 'developer';
}

// --- W5-A6 AgentLaunchSpec integration (plan §10.12–10.16, §13.17–13.18) ------
//
// resolveLaunchSpec is an OPTIONAL callback injected by the worker-executor
// factory. When present it returns a ResolvedLaunchSpec — a feature-detected
// projection of the Wave 3 `AgentLaunchSpec` (src/process-modules/application/
// agent-launch-spec.ts) carrying the package-pinned resources + the
// author/reviewer/semantic/protocol skills resolved from the pinned module
// installation (NOT the global skill root). When the callback is absent OR
//
// The resolved descriptor exposes:
//   role           { executionSkill, reviewSkill, semanticSkill, protocolSkill }
//                  — the pinned skills from the installation's execution
//                    fallback).
//   resolveSkill   (skillName) => absolute path | null  — maps a skill name to
//                  its package-pinned SKILL.md path under the installation's
//                  content-addressed storeLocation. Built by the factory from
//                  installation.resourceIndex + installation.storeLocation.
//   allowedToolIds []                           — the profile's allowedTools
//                  (effective capability set). When non-empty, §13.17 grants
//                  only these builtins + the frozen saga MCP tools, instead of
//                  the hard-coded builtin set.
//
// §13.18 fix: for a review-status task, the reviewer skill
// (role.reviewSkill) is selected INSTEAD of the author semantic skill when the
// for review tasks (the bug §13.18 calls out).

/**
 * Pick the effective skill name for this assignment under a resolved launch
 * spec. For review tasks with a declared reviewSkill, that skill wins
 * (§13.18 fix). Otherwise the semantic skill (author role) is used.
 */
function pickLaunchSpecSkillName(launchSpec, isReview) {
  const role = launchSpec?.role;
  if (!role) return null;
  if (isReview && typeof role.reviewSkill === 'string' && role.reviewSkill.length > 0) {
    return role.reviewSkill;
  }
  if (typeof role.semanticSkill === 'string' && role.semanticSkill.length > 0) {
    return role.semanticSkill;
  }
  return null;
}

function buildPrompt({
  assignment,
  project,
  workerId,
  workspaceRoot,
  sagaSkillRoot,
  resolvedProfile,
  processWorkspace,
  launchSpec,
}) {
  if (!launchSpec?.role || typeof launchSpec.resolveSkill !== 'function') {
    throw new Error('AGENT_LAUNCH_SPEC_REQUIRED: worker resources must come from the pinned installation');
  }
  const task = assignment.task;
  const role = roleFromTask(task, assignment.skill);
  const isReview = task.status === 'review' || task.status === 'review_in_progress';

  // --- Process Module execution profile resolution (P5b) -------------------
  // When the task's task_kind matches a Process Module execution profile, the
  // profile supplies TWO skills that the worker must combine:
  //   protocolSkill  — the reusable physical execution protocol (machine
  //                    binding, tracker hooks, materialized MCP calls,
  //                    authority enforcement, recovery). Same for every node
  //                    of every module — saga-process-module-worker-protocol.
  //   semanticSkill  — the domain role skill (saga-product, saga-analyst,
  //                    saga-discovery-worker, …). Defines WHAT the worker
  //                    produces; the protocol defines HOW it produces it
  //                    reliably.
  //
  // working unchanged while Process Module tasks get the composed prompt.
  let protocolSkillName = null;
  let semanticSkillName = null;
  let reviewerSkillName = null;
  const executionProfile = resolvedProfile?.profile ?? resolvedProfile;
  if (executionProfile) {
    protocolSkillName = executionProfile.protocolSkill ?? null;
    semanticSkillName = executionProfile.semanticSkill ?? null;
    reviewerSkillName = executionProfile.reviewSkill ?? null;
  }

  // W5-A6: when a launch spec resolved pinned package resources, override the
  // skill selection from the pinned installation's execution profile (plan
  // §10.13: the runner consumes AgentLaunchSpec and never re-resolves a profile
  // or skill from task kind). The launch spec's role block is the single source
  // of truth for the protocol + author semantic + reviewer skills.
  if (launchSpec?.role) {
    protocolSkillName = launchSpec.role.protocolSkill || protocolSkillName;
    semanticSkillName = launchSpec.role.semanticSkill || semanticSkillName;
    reviewerSkillName = launchSpec.role.reviewSkill ?? reviewerSkillName ?? null;
  }

  // §13.18 fix: for a review task with a declared reviewer skill, select the
  // REVIEWER skill instead of the author semantic skill. Without this the
  // profile.semanticSkill (author skill, e.g. saga-product) overwrites the
  // reviewer assignment for formalization/review tasks. pickLaunchSpecSkillName
  // preserved byte-for-byte (profile > assignment.skill > saga-<role>).
  const launchPickedSkill = pickLaunchSpecSkillName(launchSpec, isReview);
  const effectiveSemanticSkill = launchPickedSkill ?? semanticSkillName;
  if (!protocolSkillName || !effectiveSemanticSkill) {
    throw new Error('AGENT_LAUNCH_SKILLS_REQUIRED: protocol and semantic skills must be pinned');
  }
  const effectiveReviewerSkill = (isReview && reviewerSkillName)
    ? reviewerSkillName
    : null;

  // W5-A6: resolve the skill file path from the PINNED installation when the
  // launch spec supplies a resolveSkill resolver (plan §0.2.7 / §10.12:
  // resources come from the installation, NOT the global skill root). Fall back
  // pinned resolver returns no path (resource not declared in the index).
  const resolvePinnedSkillPath = (skillName) => {
    if (skillName) {
      const pinned = launchSpec.resolveSkill(skillName);
      if (typeof pinned === 'string' && pinned.length > 0) return pinned;
    }
    throw new Error(
      `PINNED_SKILL_NOT_RESOLVED: ${skillName} for installation ${launchSpec.installationId ?? 'unknown'}`,
    );
  };
  const semanticSkillPath = resolvePinnedSkillPath(effectiveSemanticSkill);
  if (!existsSync(semanticSkillPath)) {
    throw new Error(`PINNED_SKILL_FILE_MISSING: ${semanticSkillPath}`);
  }
  const skillPath = semanticSkillPath;

  // Inline the skill file(s) directly into the prompt. When a protocol skill
  // is resolved, BOTH are inlined as separate sections so the worker sees the
  // universal execution physics FIRST, then the domain workflow. Strong models
  // can still Read the files for the canonical version.
  let skillInline = '';
  if (protocolSkillName) {
    const protocolSkillPath = resolvePinnedSkillPath(protocolSkillName);
    let protocolInline = '';
    try {
      protocolInline = readFileSync(protocolSkillPath, 'utf8');
    } catch {
      protocolInline = `(Could not read protocol skill file at ${protocolSkillPath}.)`;
    }
    // For review tasks, inline the REVIEWER skill (not the author semantic) as
    // the second section when a reviewer skill resolved (§13.18 fix). The
    // reviewer skill is the authoritative "what to check" workflow; the author
    // semantic skill is what the author used to produce the artifact.
    const reviewerInlineSkillPath = effectiveReviewerSkill
      ? resolvePinnedSkillPath(effectiveReviewerSkill)
      : skillPath;
    let semanticInline = '';
    try {
      semanticInline = readFileSync(reviewerInlineSkillPath, 'utf8');
    } catch {
      semanticInline = `(Could not read semantic skill file at ${reviewerInlineSkillPath}. Follow the protocol above.)`;
    }
    const semanticSectionTitle = effectiveReviewerSkill
      ? '--- REVIEWER SKILL BEGIN (review role — what to verify) ---'
      : '--- SEMANTIC SKILL BEGIN (domain role — what to produce) ---';
    const semanticSectionEnd = effectiveReviewerSkill
      ? '--- REVIEWER SKILL END ---'
      : '--- SEMANTIC SKILL END ---';
    skillInline = [
      '--- PROTOCOL SKILL BEGIN (universal execution physics — apply to every action) ---',
      protocolInline,
      '--- PROTOCOL SKILL END ---',
      '',
      semanticSectionTitle,
      semanticInline,
      semanticSectionEnd,
    ].join('\n');
  }

  const profileAllowedTools = Array.isArray(launchSpec.allowedToolIds)
    ? new Set(launchSpec.allowedToolIds.filter(tool => typeof tool === 'string'))
    : null;
  const modelOwnsHeartbeat = profileAllowedTools === null || profileAllowedTools.has('Bash');
  const modelMayUpdateTracker = profileAllowedTools === null
    || profileAllowedTools.has('Write')
    || profileAllowedTools.has('Edit');

  return [
    'You are a single-use Saga CLI worker. Saga already atomically assigned exactly one task to this process.',
    '',
    `project_id=${project.id}`,
    `project_name=${project.name}`,
    `task_id=${task.id}`,
    `worker_id=${workerId}`,
    `execution_id=${assignment.execution_id}`,
    `role=${role}`,
    `dispatcher_skill=${assignment.skill}`,
    protocolSkillName ? `protocol_skill=${protocolSkillName}` : null,
    semanticSkillName ? `semantic_skill=${semanticSkillName}` : null,
    reviewerSkillName ? `reviewer_skill=${reviewerSkillName}` : null,
    `launch_spec_installation=${launchSpec.installationId}`,
    effectiveReviewerSkill ? `effective_skill=${effectiveReviewerSkill}` : null,
    processWorkspace ? `process_module_ref=${processWorkspace.moduleRef}` : null,
    processWorkspace ? `execution_profile=${processWorkspace.profileId}` : null,
    `task_kind=${task.task_kind}`,
    `workflow_stage=${task.workflow_stage}`,
    `execution_mode=${task.execution_mode || 'git_change'}`,
    `repository=${assignment.repository.name}`,
    `workspace_root=${workspaceRoot}`,
    '',
    'Hard rules:',
    modelOwnsHeartbeat
      ? '0. IMMEDIATELY on startup, before any other action, run this heartbeat command exactly once (it marks you as alive for the operator):'
      : '0. Runtime owns the operator heartbeat. Do not invoke Bash or another undeclared native tool for heartbeat.',
    modelOwnsHeartbeat
      ? `   bash -c 'echo "$(date -u +%FT%TZ) pid=$$ worker=${workerId} project=${project.id} task=${task.id} CLAIMED started" >> ~/.zcode/cli/worker-heartbeat.log'`
      : null,
    `1. Work only on task_id=${task.id}.`,
    '2. Never call worker_next; it is explicitly disabled for this process.',
    '3. Read the assigned task and its context through Saga MCP as needed.',
    `   To read your task: task_get({ id: ${task.id} }) — the parameter name is 'id' (NOT 'task_id' or 'taskId').`,
    protocolSkillName
      ? (effectiveReviewerSkill
        ? `4. Follow the PROTOCOL SKILL (execution physics) and the REVIEWER SKILL (what to verify) below. SKIP every instruction that claims or selects a task. The protocol is authoritative for HOW you work; the reviewer skill is authoritative for WHAT you check on this review task.`
        : `4. Follow the PROTOCOL SKILL (execution physics) and the SEMANTIC SKILL (domain role) below. SKIP every instruction that claims or selects a task. The protocol is authoritative for HOW you work; the semantic skill is authoritative for WHAT you produce.`)
      : `4. Follow the skill workflow below (also at ${skillPath}). SKIP every instruction that claims or selects a task.`,
    skillInline,
    processWorkspace
      ? [
          '',
          '--- MACHINE-PROVISIONED PROCESS WORKSPACE (mandatory, exact paths) ---',
          `tracker_path=${processWorkspace.trackerPath}`,
          `execution_workspace=${processWorkspace.executionDirectory}`,
          `workspace_files=${JSON.stringify(processWorkspace.workspaceFiles)}`,
          `materialized_call_files=${JSON.stringify(processWorkspace.callFiles)}`,
          `checklists=${JSON.stringify(processWorkspace.checklists)}`,
          '',
          'Weak-model execution order:',
          `a. Read ${processWorkspace.trackerPath} before any domain action.`,
          'b. Read the assigned task with task_get and verify its machine bindings.',
          'c. Use the listed materialized files; do not invent a call shape from memory.',
          'd. Before every consequential MCP write, read the listed checklist and the call file back.',
          modelMayUpdateTracker
            ? 'e. Update the exact tracker after every completed step and before worker_done.'
            : 'e. The tracker is runtime-owned for this read-only profile. Do not try to modify it; record findings in the typed product and worker_done receipt.',
          'Paths in this section are authoritative for this execution.',
          '--- END MACHINE-PROVISIONED PROCESS WORKSPACE ---',
          '',
        ].join('\n')
      : null,
    processWorkspace?.testWarmStart
      ? [
          '',
          '--- TEST WARM START (explicit fixture; normal gates still apply) ---',
          `fixture_id=${processWorkspace.testWarmStart.fixtureId}`,
          `fixture_receipt=${processWorkspace.testWarmStart.receiptPath}`,
          `epic_draft_cache=${processWorkspace.testWarmStart.cacheRoot}`,
          `reusable_draft_files=${JSON.stringify(processWorkspace.testWarmStart.draftFiles)}`,
          `cold_start_files=${JSON.stringify(processWorkspace.testWarmStart.coldStartFiles)}`,
          `force_rewrite_slots=${JSON.stringify(processWorkspace.testWarmStart.forceRewriteSlots)}`,
          processWorkspace.testWarmStart.instruction,
          'Do not recreate reusable drafts from scratch. Read and verify them first.',
          'A missing or empty cold-start file is not an error: create it normally; a later test run will reuse it.',
          'If a slot is listed in force_rewrite_slots, prior attempts repeated the same rejected content: rewrite that slot substantially instead of making another minimal edit.',
          'Do not claim that fixture preparation was model-generated work.',
          'No protocol step is pre-completed: use the normal MCP writes, traces, checklist, and worker_done.',
          '--- END TEST WARM START ---',
          '',
        ].join('\n')
      : null,
    task.execution_mode === 'git_change'
      ? (processWorkspace?.repositoryDesk
        ? [
            '5. Your repository workspace has been prepared by the factory. Work ONLY inside it.',
            '--- REPOSITORY DESK (machine-provisioned, do not change) ---',
            `repository_root=${processWorkspace.repositoryDesk.repositoryRoot}`,
            `execution_path=${processWorkspace.repositoryDesk.executionPath}`,
            processWorkspace.repositoryDesk.git.detached
              ? `head=detached at ${processWorkspace.repositoryDesk.git.headCommit ?? 'unknown'}`
              : `task_branch=${processWorkspace.repositoryDesk.git.branch}`,
            `base_commit=${processWorkspace.repositoryDesk.git.baseCommit}`,
            `integration_branch=${processWorkspace.repositoryDesk.git.integrationBranch}`,
            `role=${processWorkspace.repositoryDesk.role}`,
            '',
            'This worktree has already been prepared by the factory.',
            'Do NOT create or switch branches.',
            'Do NOT create another worktree.',
            `All repository changes MUST be made under: ${processWorkspace.repositoryDesk.executionPath}`,
            processWorkspace.repositoryDesk.git.detached
              ? 'This is a read-only review/verify desk. Do NOT commit or push.'
              : 'Commit your work on the task branch already checked out for you.',
            '--- END REPOSITORY DESK ---',
          ].join('\n')
        : '5. Use the existing task worktree/branch conventions from the skill.')
      : '5. This task is not a git-change task. Do not create a worktree or merge unless the assigned skill explicitly requires one.',
    isReview
      ? `6. Review the assigned implementation and call worker_done exactly once with verdict approved or changes_requested${assignment.execution_id ? ` and execution_id="${assignment.execution_id}"` : ''}.`
      : `6. Complete the assigned task according to its selected skill, verify its output, and call worker_done exactly once with a truthful result${assignment.execution_id ? ` and execution_id="${assignment.execution_id}"` : ''}.`,
    '6a. Completion requires invoking the actual mcp__saga__worker_done tool and receiving an accepted stop:true receipt. Writing, printing, or reading worker-done-call.json is NOT a tool call and MUST NOT be followed by process exit.',
    task.execution_mode === 'git_change' && isReview
      ? '7. If APPROVED reaches done, stop:true means do not claim another task: first acquire the repository merge lock, merge into the assigned integration branch, call worker_merge_release, then summarize and exit.'
      : '7. After worker_done returns stop:true, do not claim another task; finish any required terminal protocol, then return a concise summary and exit.',
    '8. Do not start, select, or accept another task. Do not spawn nested agents.',
    `8a. Include execution_id="${assignment.execution_id}" in worker_done, verification_record, worker_ask_need, worker_ask_done, worker_merge_acquire, and worker_merge_release.`,
    task.task_kind === 'verification.ac'
      ? `9. Before worker_done, call verification_record only for the task's canonical AC with recorded_by="${workerId}"${assignment.execution_id ? `, execution_id="${assignment.execution_id}"` : ''}, and truthful pass/fail evidence.`
      : '9. Preserve the task provenance and do not create unrelated downstream work.',
    '',
    'Assigned task payload:',
    JSON.stringify(task, null, 2),
  ].filter(line => line !== null).join('\n');
}

export class ClaudeBoardRunner {
  constructor(options) {
    this.claimTask = options.claimTask;
    this.getProject = options.getProject;
    this.getTaskState = options.getTaskState;
    this.getTask = options.getTask ?? null;
    this.recoverAssignment = options.recoverAssignment;
    this.resolveWorkspace = options.resolveWorkspace;
    this.spawn = options.spawn ?? nodeSpawn;
    this.executionStore = options.executionStore ?? {
      markExited: markExecutionExited,
      markProgress: markExecutionProgress,
      markRunning: markExecutionRunning,
      markSpawnFailed: markExecutionSpawnFailed,
      readBirthToken: readProcessBirthToken,
    };
    this.claudePath = options.claudePath ?? process.env.SAGA_CLAUDE_PATH ?? 'claude';
    // Routing cutover: the binary for each spawn is now selected from the
    // FROZEN execution_context.executor_kind. These two paths are the explicit
    // backend targets — `claudePath` remains as the legacy fallback. When unset,
    // resolveExecutorPath falls back to claudePath, preserving pre-cutover runs.
    this.realClaudePath = options.realClaudePath ?? process.env.SAGA_REAL_CLAUDE_PATH ?? null;
    this.dbPath = options.dbPath;
    this.sagaEntry = options.sagaEntry;
    this.sagaSkillRoot = options.sagaSkillRoot;
    // LM Studio provider: reads { model, provider, effort } from episode_workflows.metadata
    // (active_model / active_provider / active_model_effort). Returns
    // {provider:'zai', model:null, effort:null} when unset → spawn uses the
    // LM Studio routing lives primarily in ~/.claude/settings.json (patched by
    // POST /api/model/set). The spawn-env override below is a defensive belt-
    // and-suspenders for claude CLI versions where env DOES take priority over
    // settings.json (pre-v2 regression, anthropics/claude-code#8500). In v2.x
    // settings.json wins, so this env is effectively inert — but it stays so
    // the moment Anthropic restores env-priority, saga keeps working unchanged.
    // NOTE: the URL here keeps /v1 for direct /models probes; the settings.json
    // write strips it (claude v2 appends /v1 itself → /v1/v1/messages otherwise).
    this.getActiveModel = options.getActiveModel;
    // P5b: optional resolver that maps a task_kind to its Process Module
    // execution profile ({ protocolSkill, semanticSkill }). When present, the
    // prompt builder inlines BOTH skills (protocol = execution physics,
    // path is used. The resolver is injected by the worker-executor factory.
    this.resolveProfile = options.resolveProfile ?? null;
    // W5-A6 (plan §10.12–§10.16, §13.17–§13.18): optional resolver that turns
    // a claimed assignment into a package-pinned launch descriptor
    // (AgentLaunchSpec projection). When present and it returns a non-null
    // descriptor, the runner:
    //   - resolves skills from the PINNED installation's resourceIndex (via
    //     launchSpec.resolveSkill) instead of the global sagaSkillRoot (§0.2.7,
    //     §10.12 — resources come from the installation, NOT the skill root);
    //   - selects the REVIEWER skill for review-status tasks when the profile
    //     declares one (§13.18 fix — reviewer skill separate from author);
    //   - grants only the profile's allowedTools as Claude builtins, falling
    //     back to the hard-coded builtin set only when the launch spec carries
    //     no allowedToolIds (§13.17 fix — respect profile allowedTools).
    // hard-coded builtin set byte-for-byte. Injected by the worker-executor
    // factory; the .mjs runner never imports the TypeScript AgentLaunchSpec.
    this.resolveLaunchSpec = options.resolveLaunchSpec ?? null;
    // Runtime callback for exact task-scoped trackers/templates/checklists.
    this.prepareWorkspace = options.prepareWorkspace ?? null;
    // Optional test-only sidecar. Captures epic-scoped draft slots after the
    // worker exits; it never participates in task settlement or routing.
    this.captureWorkspace = options.captureWorkspace ?? null;
    this.lmstudioBaseUrl = options.lmstudioBaseUrl
      ?? process.env.SAGA_LMSTUDIO_URL
      ?? 'http://localhost:1234/v1';
    this.logRoot = options.logRoot ?? path.join(os.homedir(), '.zcode', 'cli', 'board-runs');
    // Единый heartbeat-лог всех воркеров (для наблюдения за запущенными агентами).
    // Plain text, по строке на событие. Смотреть через tail -f.
    this.heartbeatLog = options.heartbeatLog ?? path.join(os.homedir(), '.zcode', 'cli', 'worker-heartbeat.log');
    this.runs = new Map();
    this.sequence = 0;
    this.mcpConfigPath = path.join(os.tmpdir(), `saga-claude-mcp-${process.pid}.json`);
    this.writeMcpConfig();
  }

  /**
   * Spawn the claude executable (or a simulator). Supports compound paths
   * like "node tools/claude-cli-simulator.mjs" by splitting on spaces and
   * using the first token as the command, the rest as extra args.
   */
  spawnClaude(claudePath, args, options) {
    const parts = claudePath.trim().split(/\s+/);
    if (parts.length > 1) {
      const [cmd, ...prefixArgs] = parts;
      return this.spawn(cmd, [...prefixArgs, ...args], options);
    }
    return this.spawn(claudePath, args, options);
  }

  /**
   * Resolve the executor binary for one assignment from the FROZEN route in
   * execution_context.executor_kind (routing cutover, v2).
   *
   * CONVEYOR v4.3 PART 1,3,12: there is exactly ONE Factory execution path.
   * The `claude-cli-simulator` executor kind is no longer supported — replay
   * is an internal production source resolved from
   * execution_context.replay.capsule_ref inside the normal WorkerExecutor, so
   * spawn is never reached for a capsule-bound execution. This resolver only
   * ever returns the real Claude CLI binary.
   *
   * Fallback chain (preserves pre-cutover behavior when no frozen executor_kind):
   *   1. frozen execution_context.executor_kind='claude-cli'  (v2 — authoritative)
   *   2. this.claudePath / SAGA_CLAUDE_PATH / 'claude'         (legacy default)
   *
   * Returns { claudePath, isSimulator }.
   */
  resolveExecutorPath(assignment) {
    const ctx = assignment?.execution_context;
    const frozenKind = ctx && typeof ctx === 'object'
      ? ctx.executor_kind
      : undefined;
    if (frozenKind === 'claude-cli' || frozenKind === undefined) {
      // The real Claude CLI. Provider/model/effort come from model_route.
      return { claudePath: this.realClaudePath ?? this.claudePath, isSimulator: false };
    }
    // Any other frozen kind is rejected upstream by the authority layer. We
    // never select a simulator here.
    return { claudePath: this.realClaudePath ?? this.claudePath, isSimulator: false };
  }

  // Записать строку в heartbeat-лог. Формат:
  //   <iso> pid=<pid> worker=<id> project=<id> [<name>] task=<id> <EVENT> <message>
  // Используется runner'ом при старте (STARTED) и завершении (CLOSED/FAILED).
  // Воркер пишет CLAIMED/STEP отдельно из скилла (см. saga-worker/SKILL.md).
  heartbeat(run, execution, event, message) {
    const line = [
      nowIso(),
      `pid=${execution?.child?.pid ?? '?'}`,
      `worker=${execution?.workerId ?? '?'}`,
      `project=${run.projectId} [${run.projectName}]`,
      `task=${execution?.taskId ?? '?'}`,
      event,
      message || '',
    ].join(' ').replace(/\s+/g, ' ').trim() + '\n';
    try {
      writeFileSync(this.heartbeatLog, line, { flag: 'a' });
    } catch {
      // лог не критичен — падать не должны
    }
  }

  writeMcpConfig() {
    const config = {
      mcpServers: {
        saga: {
          type: 'stdio',
          command: 'node',
          args: [this.sagaEntry],
          env: {
            DB_PATH: path.resolve(this.dbPath),
            TRACKER_AUTOSTART: '0',
            SAGA_MANAGED_EXECUTION: '0',
          },
        },
      },
    };
    writeFileSync(this.mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  // D1.1: write a per-execution MCP config that carries SAGA_EXECUTION_ID +
  // SAGA_TASK_ID + SAGA_WORKER_ID into the spawned saga MCP child's env. Under
  // --strict-mcp-config the MCP child receives ONLY the keys in this env block,
  // so execution identity must be plumbed HERE, not via the worker claude's
  // process env (which does not reach the stdio-spawned MCP child). The gateway
  // in src/index.ts reads process.env.SAGA_EXECUTION_ID to authorize each Saga
  // tool call against the frozen execution_context snapshot.
  writeExecutionMcpConfig(executionId, taskId, workerId) {
    const safeId = (executionId || 'noexec').replace(/[^A-Za-z0-9_.-]/g, '_');
    const configPath = path.join(os.tmpdir(), `saga-claude-mcp-exec-${safeId}.json`);
    const config = {
      mcpServers: {
        saga: {
          type: 'stdio',
          command: 'node',
          args: [this.sagaEntry],
          env: {
            DB_PATH: path.resolve(this.dbPath),
            TRACKER_AUTOSTART: '0',
            SAGA_MANAGED_EXECUTION: '1',
            SAGA_EXECUTION_ID: executionId || '',
            SAGA_TASK_ID: String(taskId ?? ''),
            SAGA_WORKER_ID: workerId || '',
          },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return configPath;
  }

  dispose() {
    for (const run of this.runs.values()) this.stop(run.projectId);
    try { rmSync(this.mcpConfigPath, { force: true }); } catch {}
  }

  /**
   * Synchronous sleep (blocks the event loop). Used in the pump() retry
   * back-off to avoid 100 Hz spawn loops that can trigger API rate limits.
   * Atomics.wait is the only built-in synchronous sleep in Node.js.
   */
  syncSleep(ms) {
    if (ms <= 0) return;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      // SharedArrayBuffer may be unavailable in some environments. Fall back
      // to a busy-wait (less precise, but still prevents tight loops).
      const end = Date.now() + ms;
      while (Date.now() < end) { /* spin */ }
    }
  }

  start({ projectId, epicId, concurrency, assignment }) {
    const existing = this.runs.get(projectId);
    if (existing && !TERMINAL_RUN_STATES.has(existing.status)) {
      throw new Error(`Project ${projectId} already has an active board run`);
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw new Error('concurrency must be an integer from 1 to 10');
    }
    if (!assignment) {
      throw new Error('PREASSIGNED_WORK_REQUIRED: the dispatcher must fence one card before worker launch');
    }

    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const workspaceRoot = this.resolveWorkspace(project);

    const runId = `board-${projectId}-${process.pid}-${Date.now()}`;
    const run = {
      id: runId,
      projectId,
      epicId: epicId ?? null,
      // Conveyor model (Slice 1 Zones 1-4 refactor — node-breaker): the
      // dispatcher ALWAYS pre-assigns a card (assignTask already flipped status
      // + set the fence) before start(). The runner stores it here and pump()
      // launches the worker directly WITHOUT calling claimTask — the assignment
      // in-process worker_next self-claim path is removed.
      preassignedWork: assignment,
      projectName: project.name,
      workspaceRoot,
      concurrency,
      status: 'running',
      startedAt: nowIso(),
      finishedAt: null,
      active: new Map(),
      completed: 0,
      failed: 0,
      claimed: 0,
      lastError: null,
      emptyChecks: 0,
      stopRequested: false,
    };
    this.runs.set(projectId, run);
    mkdirSync(path.join(this.logRoot, safeName(runId)), { recursive: true });
    queueMicrotask(() => this.pump(run));
    return this.snapshot(run);
  }

  stop(projectId) {
    const run = this.runs.get(projectId);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return run ? this.snapshot(run) : null;
    run.stopRequested = true;
    run.status = 'stopping';
    for (const execution of run.active.values()) {
      try { execution.child.kill(); } catch {}
    }
    if (run.active.size === 0) this.finish(run, 'stopped');
    return this.snapshot(run);
  }

  status(projectId) {
    const run = this.runs.get(projectId);
    return run ? this.snapshot(run) : null;
  }

  // Live concurrency adjustment — the "natural rotation" mechanism. Calling
  // this does NOT kill or spawn anything. It only changes the ceiling that
  // pump() checks on every close event: `run.active.size < run.concurrency`.
  // When an active worker finishes naturally → pump decides whether to spawn
  // a replacement based on the new ceiling.
  //
  // Used by: model change (lower ceiling when switching to a smaller model),
  // rate-limit recovery (drop ceiling on 429, climb back after cooldown),
  // concurrency selector (operational policy change for the next factory resume).
  setConcurrency(projectId, concurrency) {
    const run = this.runs.get(projectId);
    if (!run) return;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) return;
    run.concurrency = concurrency;
  }

  snapshot(run) {
    return {
      id: run.id,
      project_id: run.projectId,
      project_name: run.projectName,
      concurrency: run.concurrency,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      active: [...run.active.values()].map(execution => ({
        task_id: execution.taskId,
        title: execution.title,
        worker_id: execution.workerId,
        pid: execution.child.pid ?? null,
        started_at: execution.startedAt,
        // Exposed so the live-workers panel can fetch /api/worker/tail
        // and show the worker's real-time stream-json events.
        log_path: execution.logPath,
      })),
      completed: run.completed,
      failed: run.failed,
      claimed: run.claimed,
      last_error: run.lastError,
    };
  }

  finish(run, status) {
    if (TERMINAL_RUN_STATES.has(run.status)) return;
    run.status = status;
    run.finishedAt = nowIso();
  }

  pump(run) {
    if (run.stopRequested || run.status !== 'running') {
      if (run.active.size === 0) this.finish(run, 'stopped');
      return;
    }

    // Slice 1 Zones 1-4 (conveyor refactor — node-breaker): the runner is now
    // strictly one-card. The dispatcher ALWAYS pre-assigns the card (claim +
    // fence happened atomically BEFORE start() was called). pump() converts
    // the AssignedWork into the launch()-shaped assignment and launches the
    // worker directly — NO claimTask call, NO worker_next. One pre-assigned
    // card = one worker; after launching, the run waits for that worker to
    // finish (the close handler re-pumps, sees preassignedWork consumed, and
    // removed.
    //
    // Defensive null-guard: assignment is now mandatory on start(), so
    // preassignedWork is never null at pump time — but keep the guard so a
    // future caller cannot crash silently if the contract is loosened.
    if (run.preassignedWork) {
      const work = run.preassignedWork;
      // Consume it so a re-pump (after the worker closes) does not relaunch.
      run.preassignedWork = null;
      const workerId = work.workerId;
      const assignment = this.assignmentFromAssignedWork(work);
      run.claimed += 1;
      try {
        this.launch(run, assignment, workerId);
        run.consecutiveSpawnFailures = 0;
      } catch (error) {
        run.failed += 1;
        run.lastError = error instanceof Error ? error.message : String(error);
        // The dispatcher's assignTask created the fence; a spawn failure must
        // release it so the card returns to the queue. recoverAssignment +
        this.recoverAssignment({
          taskId: work.taskId,
          workerId,
          originalStatus: work.status === 'review_in_progress' ? 'review' : 'todo',
          executionId: work.workerExecutionId,
          reason: `Claude spawn failed (pre-assigned): ${run.lastError}`,
          spawnFailure: true,
        });
        this.finish(run, 'failed');
      }
      return;
    }

    // No pre-assigned card and nothing active: the one-card run is done. This
    // branch is reached after the single worker closes and re-pumps (its
    // preassignedWork was consumed on the first pump). It also covers the
    // defensive case where start() was called without an assignment (should
    // be impossible under the mandatory contract).
    if (run.active.size === 0) {
      run.emptyChecks += 1;
      this.finish(run, run.failed > 0 && run.completed === 0 ? 'failed' : 'completed');
    }
  }

  /**
   * Convert a pre-assigned AssignedWork (built by WorkAssignmentPort.assignTask
   * before spawn) into the launch()-shaped assignment object. launch() expects
   * { task, repository, execution_context, execution_id } — the same shape the
   * worker_next claim path produces. We rebuild it from the typed AssignedWork
   * claim runs.
   *
   * `task` is fetched fresh from the DB so launch() sees the post-claim status
   * (in_progress / review_in_progress) and the full task row (task_kind,
   * execution_skill, …) that resolveProfile / resolveLaunchSpec need.
   */
  assignmentFromAssignedWork(work) {
    if (!this.getTask) {
      throw new Error('PREASSIGNED_WORK_REQUIRES_GET_TASK: the runner was constructed without a getTask callback, which is required to launch a pre-assigned card.');
    }
    const task = this.getTask(work.taskId);
    if (!task) {
      throw new Error(`Pre-assigned task ${work.taskId} not found (was it deleted between assignTask and launch?)`);
    }
    return {
      task,
      repository: work.repository,
      execution_context: work.executionContext,
      execution_id: work.workerExecutionId,
    };
  }

  launch(run, assignment, workerId) {
    const task = assignment.task;
    const workspaceRoot = assignment.repository?.local_path || run.workspaceRoot;
    if (!assignment.repository) {
      throw new Error('PINNED_REPOSITORY_REQUIRED: assignment has no repository binding');
    }
    if (!assignment.execution_id || !assignment.execution_context) {
      throw new Error('FENCED_EXECUTION_CONTEXT_REQUIRED: assignment is not frozen');
    }
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      throw new Error(`Local checkout for repository '${assignment.repository.name}' was not found`);
    }
    // Provider routing: read the active model/provider for this episode from
    // saga.db metadata (written by POST /api/model/set). provider==='lmstudio'
    // → point THIS worker's claude at the local LM Studio endpoint via env
    // (env overrides ~/.claude/settings.json, so the global z.ai config is
    // whatever ~/.claude/settings.json says.
    // `am.effort` carries the model-config reasoning effort (e.g. 'high' for
    // z.ai cloud). LM Studio models omit it → we pass NO --effort so the local
    // chat template picks its own default (LM Studio rejects effort='xhigh'/
    // 'high' for qwen, mapping them inefficiently to reasoning='on').
    //
    // D1.1: prefer the FROZEN model route from the execution_context snapshot
    // captured at claim (single source of truth — same value the gateway and
    // proposal provenance will see). Fall back to getActiveModel only when no
    // pre-D1.1 path byte-for-byte for those cases.
    const snapshotRoute = assignment.execution_context?.model_route;
    if (!snapshotRoute) throw new Error('FROZEN_MODEL_ROUTE_REQUIRED');
    const am = snapshotRoute;
    // Routing cutover: select the spawn binary from the FROZEN executor_kind.
    // The simulator is not a model, so --model is omitted when isSimulator.
    const executorSelection = this.resolveExecutorPath(assignment);
    const isSimulator = executorSelection.isSimulator;
    const isLmstudio = !isSimulator && am.provider === 'lmstudio' && am.model;
    // For the simulator there is no model id. For LM Studio we pass the concrete
    // model id (--model <lmstudio-id>); for z.ai we keep the 'opus' alias
    // (resolved via ANTHROPIC_DEFAULT_OPUS_MODEL). When the frozen route carries
    // an explicit model id for a z.ai provider, honor it.
    const modelArg = isSimulator
      ? null
      : isLmstudio
        ? am.model
        : (am.model || 'opus');
    // --effort is model-config-driven, not a global constant. The simulator
    // gets no --effort (it is not a model). LM Studio: omit entirely (its chat
    // template owns the reasoning default). z.ai: use the per-model effort from
    // the catalog, falling back to 'high' (the previous 'xhigh' was excessive
    // even for cloud and burned tokens at x3 peak rate).
    const effortArg = isSimulator
      ? null
      : isLmstudio ? null : (am.effort || 'high');

    // D1.1: per-execution MCP config carrying SAGA_EXECUTION_ID/TASK_ID/WORKER_ID
    // into the spawned saga MCP child. Falls back to the shared PID config when
    // no execution identity is present (defensive — every claim today supplies one).
    const executionMcpConfigPath = this.writeExecutionMcpConfig(assignment.execution_id, task.id, workerId);

    if (typeof this.resolveProfile !== 'function') throw new Error('EXECUTION_PROFILE_RESOLVER_REQUIRED');
    const resolvedProfile = this.resolveProfile(task.task_kind);
    if (!resolvedProfile) throw new Error(`EXECUTION_PROFILE_NOT_FOUND: ${task.task_kind}`);
    // W5-A6: resolve the package-pinned AgentLaunchSpec projection for this
    // assignment (plan §10.12–§10.16). Feature-detected: when no resolver is
    // (global skill root, hard-coded builtins, author semantic skill for
    // reviews) is preserved byte-for-byte.
    if (typeof this.resolveLaunchSpec !== 'function') throw new Error('AGENT_LAUNCH_SPEC_RESOLVER_REQUIRED');
    const launchSpec = this.resolveLaunchSpec({ assignment, resolvedProfile });
    if (!launchSpec) throw new Error('AGENT_LAUNCH_SPEC_REQUIRED');
    const processWorkspace = typeof this.prepareWorkspace === 'function'
      ? this.prepareWorkspace({
          assignment,
          project: { id: run.projectId, name: run.projectName },
          workerId,
          workspaceRoot,
          resolvedProfile,
        })
      : null;

    // Repository Desk: when the factory provisioned a git worktree, the worker
    // process MUST start in the worktree — not the shared checkout. This is the
    // physical workspace boundary: the LM operates only within executionPath.
    // Legacy fallback (no desk) keeps cwd = repository local_path.
    const executionCwd = processWorkspace?.repositoryDesk?.executionPath
      ?? workspaceRoot;
    if (processWorkspace?.repositoryDesk && !existsSync(executionCwd)) {
      throw new Error(
        `REPOSITORY_DESK_PATH_MISSING: provisioned worktree '${executionCwd}' does not exist`,
      );
    }

    const prompt = buildPrompt({
      assignment,
      project: { id: run.projectId, name: run.projectName },
      workerId,
      executionId: assignment.execution_id || null,
      workspaceRoot,
      sagaSkillRoot: this.sagaSkillRoot,
      resolvedProfile,
      processWorkspace,
      launchSpec,
    });
    const args = [
      '-p',
      // Factory workers execute only the frozen Workplace contract. User and
      // project hooks, plugins, skills, memory and CLAUDE.md files are ambient
      // authority and can both pollute the prompt and make completion depend on
      // a developer's machine. Explicit --settings and --mcp-config below stay
      // available in bare mode, so the core-owned structured hook and exact
      // Saga tool surface are preserved.
      '--bare',
      '--disable-slash-commands',
      // --model is omitted for the simulator (it is not a model-backed
      // executor). The simulator parses its own argv and ignores --model.
      ...(modelArg !== null ? ['--model', modelArg] : []),
      // --effort is injected conditionally below (LM Studio → omitted).
      '--mcp-config', executionMcpConfigPath,
      '--strict-mcp-config',
    ];
    // Structured tool-result hooks: W13-A2 replaced tracker-reminder.mjs (which
    // parsed Markdown checkboxes via regex — C027 violation) with the W5-A5
    // structured-context-hook.mjs. The new hook reads a STRUCTURED
    // agent-assistance.json projection (C031) — never scans docs/ and never
    // resolves paths by convention (§13.5). The pinned projection path is
    // passed through SAGA_AGENT_ASSISTANCE_PATH in the child env below.
    // tasks without a projection fail closed to '{}'.
    const hookPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
      'structured-context-hook.mjs',
    );
    if (processWorkspace && existsSync(hookPath)) {
      const commandHook = {
        // Use the documented explicit wildcard for every tool. This avoids
        // relying on the version-dependent interpretation of an empty matcher.
        matcher: '*',
        hooks: [{
          type: 'command',
          // Keep both argv and path-bearing data ASCII-only. Claude Code
          // 2.1.219 corrupts non-ASCII Windows paths in hook commands AND in
          // the hook subprocess environment (D:\Разработка becomes
          // D:\??????????). The runner therefore transports the trusted
          // core-owned hook bytes as base64 and imports that data module.
          command: 'node',
          args: [
            '--input-type=module',
            '--eval',
            "await import('data:text/javascript;base64,' + process.env.SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64)",
          ],
        }],
      };
      const settings = {
        hooks: {
          PostToolUse: [commandHook],
          PostToolUseFailure: [commandHook],
        },
      };
      args.push('--settings', JSON.stringify(settings));
    }
    // D-whitelist: if the frozen execution_context carries allowed_saga_tools,
    // pass them as --allowedTools so claude NEVER sees the other 90+ saga tools
    // it has no authority to call. This eliminates wasted tokens reasoning
    // about tools like tracker_dashboard/epic_create/note_search that will only
    // produce AUTHORITY_DENIED. Non-saga tools (Bash, Read, Write, Glob, Grep,
    // etc.) are always allowed — the saga authority covers only mcp__saga__*.
    const frozenAuthority = assignment.execution_context?.authority;
    const frozenTools = frozenAuthority?.allowed_saga_tools;
    if (frozenAuthority && Array.isArray(frozenTools)) {
      // Non-saga built-in Claude tools that workers legitimately need (heartbeat,
      // file reads for skill/worktree conventions). These are NOT authority-gated.
      // The set MUST stay in sync with the builtin names that Process Module
      // profiles put inside authority_scope.allowed_tools "for documentation and
      // skill sync, not for gateway enforcement" (the retired
      // factory-discovery-engine DISCOVERY_ALLOWED_TOOLS was the historical source
      // of this list; the engine is gone but the canonical surface lives on in
      // capability-enforcement.ts).
      const DEFAULT_BUILTIN = CLAUDE_BUILTIN_TOOLS;
      // §13.17 fix (W5-A6): when a launch spec resolved an effective capability
      // set with allowedToolIds, the PROFILE owns the Claude builtin surface.
      // We grant only the builtins the profile declares (intersected with the
      // frozen builtin names) instead of the hard-coded DEFAULT_BUILTIN set.
      // This lets a narrow profile (e.g. only Read+Edit) actually restrict the
      // agent's builtin tools. When the launch spec carries no allowedToolIds
      // DEFAULT_BUILTIN set is granted — the pre-W5-A6 behavior, byte-for-byte.
      let builtin;
      const profileAllowed = Array.isArray(launchSpec?.allowedToolIds)
        ? launchSpec.allowedToolIds
        : null;
      if (profileAllowed) {
        const profileSet = new Set(profileAllowed.filter(t => typeof t === 'string'));
        builtin = DEFAULT_BUILTIN.filter(b => profileSet.has(b));
      } else {
        builtin = [...DEFAULT_BUILTIN];
      }
      const knownBuiltinSet = new Set(DEFAULT_BUILTIN);
      // Only the actual saga MCP tools get the mcp__saga__ prefix. Mapping the
      // builtin entries too produced names like `mcp__saga__Write` /
      // `mcp__saga__Read` that the saga MCP server never exposes — claude then
      // treats them as missing and the whole saga whitelist silently fails to
      // load, leaving the worker without task_get / proposal_submit / worker_done.
      const sagaAllowed = frozenTools
        .filter(t => typeof t === 'string' && t.trim() !== '' && !knownBuiltinSet.has(t))
        .map(t => `mcp__saga__${t}`);
      args.push('--allowedTools', [...sagaAllowed, ...builtin].join(','));
      if (profileAllowed) {
        const deniedBuiltin = DEFAULT_BUILTIN.filter(tool => !profileAllowed.includes(tool));
        args.push(
          '--disallowedTools',
          ['mcp__saga__worker_next', ...deniedBuiltin].join(','),
        );
      } else {
        args.push('--disallowedTools', 'mcp__saga__worker_next');
      }
    } else {
      args.push('--disallowedTools', 'mcp__saga__worker_next');
    }
    // CRITICAL: On Windows, CreateProcess has a 32767-character command line
    // limit. Large skills (saga-architect is 38KB + SRS template 16KB) make
    // the inline prompt exceed this limit, causing spawn to fail silently
    // (ENOENT or E2BIG) and triggering a 100Hz retry loop that can get the
    // account banned. Fix: pipe the prompt through stdin instead of passing
    // it as a command-line argument. Claude CLI `-p` reads stdin when no
    // positional prompt is given. This removes the prompt from the argument
    // vector entirely, staying well within the OS limit regardless of prompt
    // size.
    args.push(
      // Unattended but fail-closed: declared tools are auto-allowed and every
      // other request is denied instead of prompting or bypassing policy.
      '--permission-mode', 'dontAsk',
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--no-session-persistence',
    );
    // Inject --effort right after --model so the flag order stays grouped.
    // Spliced here (not inline above) so the LM Studio "omit entirely" rule is
    // a single readable branch rather than a ternary inside the array literal.
    if (effortArg) {
      const modelIdx = args.indexOf('--model');
      args.splice(modelIdx + 2, 0, '--effort', effortArg);
    }
    // LM Studio worker env: redirect THIS worker's claude to the local
    // Anthropic-compatible endpoint. Tokens are placeholders — LM Studio does
    // not validate them; they exist only so claude CLI doesn't refuse to start
    // (it requires some non-empty auth value). CLAUDE_CODE_ATTRIBUTION_HEADER=0
    // is required by the LM Studio Claude Code integration docs (the default
    // attribution header trips up the local server).
    const lmstudioEnv = isLmstudio ? {
      ANTHROPIC_BASE_URL: this.lmstudioBaseUrl,
      ANTHROPIC_AUTH_TOKEN: 'lm-studio',
      ANTHROPIC_API_KEY: 'lm-studio',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      // Явный context window для non-Claude модели (LM Studio qwen3.6 загружена
      // с loaded_context_length=262144). Без этой переменной Claude Code использует
      // hardcoded fallback (~200k) — см. https://code.claude.com/docs/en/env-vars
      // и anthropics/claude-code#46416.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
    } : {};
    const child = this.spawnClaude(executorSelection.claudePath, args, {
      cwd: executionCwd,
      env: {
        ...process.env,
        ...lmstudioEnv,
        SAGA_RUN_ID: run.id,
        SAGA_WORKER_ID: workerId,
        SAGA_EXECUTION_ID: assignment.execution_id || '',
        SAGA_TASK_ID: String(task.id),
        SAGA_STRUCTURED_CONTEXT_HOOK_SOURCE_B64:
          processWorkspace && existsSync(hookPath)
            ? readFileSync(hookPath).toString('base64')
            : '',
        SAGA_AGENT_ASSISTANCE_PATH: processWorkspace?.agentAssistanceAbsolutePath || '',
        SAGA_PROJECT_ID: String(run.projectId),
        SAGA_PROJECT_NAME: run.projectName,
        SAGA_TASK_TITLE: task.title,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Diagnostic: log the resolved spawn command + PID + cwd to the JSONL log.
    // This makes spawn failures immediately diagnosable (path issues, compound
    // claudePath splitting, missing modules, etc.) without guessing.
    const _diagLogPath = path.join(this.logRoot, safeName(run.id), `task-${task.id}-${safeName(workerId)}.jsonl`);
    try {
      const _diag = createWriteStream(_diagLogPath, { flags: 'a' });
      _diag.write(`[runner] spawn: claudePath=${JSON.stringify(executorSelection.claudePath)} pid=${child.pid} cwd=${JSON.stringify(executionCwd)} task=${task.id} exec=${assignment.execution_id || 'none'}\n`);
      _diag.write(`[runner] spawnClaude split: cmd=${JSON.stringify(executorSelection.claudePath.trim().split(/\s+/)[0])} prefixArgs=${JSON.stringify(executorSelection.claudePath.trim().split(/\s+/).slice(1))}\n`);
      _diag.end();
    } catch { /* diagnostic is best-effort */ }
    // Pipe the prompt through stdin instead of passing it as a command-line
    // argument. This avoids the Windows CreateProcess 32767-char limit that
    // silently kills spawns for large skills (saga-architect: 38KB skill +
    // 16KB SRS template). Claude CLI -p reads stdin when no positional prompt
    // arg is present.
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      // If stdin write fails, the child still starts — it will just have an
      // empty prompt and exit quickly. The pump retry-limit will catch it.
    }
    const logPath = path.join(this.logRoot, safeName(run.id), `task-${task.id}-${safeName(workerId)}.jsonl`);
    const log = createWriteStream(logPath, { flags: 'a' });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    // CONVEYOR Wave 5 — progress signal (§363-370). Observable worker activity
    // (stdout) updates progress_at so the stuck-policy distinguishes a
    // long-running-but-healthy worker from a dead one. Throttled to ≤1 update /
    // 30s: stdout can be high-frequency, but progress_at only needs coarse
    // freshness for stuck detection (STUCK_SILENCE_MS = 10min).
    if (assignment.execution_id) {
      let lastProgressAt = 0;
      const PROGRESS_THROTTLE_MS = 30_000;
      const progressDbPath = this.dbPath;
      const progressExecId = assignment.execution_id;
      const onProgressData = () => {
        const now = Date.now();
        if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        try { this.executionStore.markProgress(progressDbPath, progressExecId); } catch { /* best-effort */ }
      };
      child.stdout?.on('data', onProgressData);
      child.stderr?.on('data', onProgressData);
    }

    // Tool traffic alone is not semantic progress. Terminate an exact repeated
    // action loop and let the normal fenced recovery path replace the worker.
    const repeatedToolLoop = createRepeatedToolLoopDetector({ limit: 12 });
    child.stdout?.on('data', chunk => {
      const violation = repeatedToolLoop.push(chunk);
      if (!violation) return;
      run.lastError = `REPEATED_TOOL_LOOP: ${violation.tool} repeated ${violation.repetitions} times with identical input`;
      try { child.kill(); } catch { /* close/reaper remains authoritative */ }
    });

    const execution = {
      taskId: task.id,
      title: task.title,
      workerId,
      executionId: assignment.execution_id || null,
      originalStatus: task.status,
      child,
      log,
      logPath,
      startedAt: nowIso(),
      workspaceRoot,
      repository: assignment.repository?.name || null,
      // D1.1: per-execution MCP config path — cleaned up on close so /tmp does
      // not accumulate one file per worker launch.
      executionMcpConfigPath: executionMcpConfigPath !== this.mcpConfigPath
        ? executionMcpConfigPath
        : null,
    };
    run.active.set(workerId, execution);

    // Heartbeat: воркер стартовал (spawn завершён, процесс жив).
    this.heartbeat(run, execution, 'STARTED',
      `claude -p task_id=${task.id} role=${roleFromTask(task, assignment.skill)} pid=${child.pid}`);

    child.once('error', error => {
      run.lastError = error instanceof Error ? error.message : String(error);
      this.heartbeat(run, execution, 'ERROR', `spawn error: ${run.lastError}`);
    });
    // Windows pipe-inheritance fix: 'close' fires only after ALL stdio streams
    // are torn down. On Windows, if a grandchild process inherits the piped
    // stdio descriptors, 'close' NEVER fires even after the child exits.
    // This causes waitForAssignedWorker to poll executor.status() forever.
    //
    // Fix: extract finalize into a shared closure with an idempotency guard.
    // Listen for 'exit' separately. After a 5s grace period, if 'close' hasn't
    // fired, call finalize DIRECTLY (not via destroy→close chain which is
    // unreliable on Windows when file descriptors are inherited).
    let workerFinalized = false;
    const workerFinalize = (code) => {
      if (workerFinalized) return;
      workerFinalized = true;
      child.stdout?.unpipe(log);
      child.stderr?.unpipe(log);
      if (execution.executionMcpConfigPath) {
        try { rmSync(execution.executionMcpConfigPath, { force: true }); } catch {}
      }
      run.active.delete(workerId);
      const taskState = this.getTaskState(task.id, execution.executionId);
      const semanticCompletionAccepted = taskState?.worker_done_accepted === true;
      const integrationComplete = !(
        task.status === 'review'
        && task.task_kind
        && task.execution_mode === 'git_change'
      ) || taskState?.integration_state === 'merged';
      const completed = semanticCompletionAccepted || (taskState &&
        (taskState.status === 'review' || taskState.status === 'done') &&
        !taskState.assigned_to &&
        integrationComplete);
      const changesRequested = task.status === 'review' &&
        taskState?.status === 'todo' &&
        !taskState.assigned_to;
      const reviewExhausted = task.status === 'review' &&
        taskState?.status === 'blocked' &&
        !taskState.assigned_to;
      const captureOutcome = completed
        ? 'completed'
        : changesRequested || reviewExhausted
          ? 'changes_requested'
          : 'failed';

      if (typeof this.captureWorkspace === 'function') {
        try {
          this.captureWorkspace({
            workspaceRoot,
            processWorkspace,
            outcome: captureOutcome,
          });
        } catch (error) {
          this.heartbeat(
            run,
            execution,
            'ERROR',
            `test draft cache capture failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (completed) {
        run.completed += 1;
        this.heartbeat(run, execution, 'CLOSED',
          `exit=${code ?? '?'} completed from durable worker_done status=${taskState?.status || '?'}`);
      } else if (changesRequested) {
        run.completed += 1;
        this.heartbeat(run, execution, 'CLOSED',
          `exit=0 changes_requested → returned to dev queue`);
      } else if (reviewExhausted) {
        run.completed += 1;
        this.heartbeat(run, execution, 'CLOSED',
          'exit=0 changes_requested → review budget exhausted; task blocked');
      } else {
        run.failed += 1;
        run.lastError = `Task ${task.id} Claude process exited with code ${code} before terminal worker_done`;
        this.heartbeat(run, execution, 'FAILED',
          `exit=${code} before worker_done → task recovered`);
        this.recoverAssignment({
          taskId: task.id,
          workerId,
          originalStatus: task.status,
          executionId: execution.executionId,
          reason: run.lastError,
          spawnFailure: false,
        });
      }
      if (execution.executionId) {
        try {
          this.executionStore.markExited(
            this.dbPath,
            execution.executionId,
            code ?? null,
            execution.terminationRequested ? 'terminated' : 'exited',
          );
        } catch (error) {
          run.lastError = `execution close persistence failed: ${error.message}`;
        }
      }

      if (run.stopRequested) {
        if (run.active.size === 0) this.finish(run, 'stopped');
      } else {
        queueMicrotask(() => this.pump(run));
      }
    };
    child.once('exit', (code) => {
      setTimeout(() => {
        if (!workerFinalized) {
          process.stdout.write(`[runner] exit fired but close did not within 5s — force-finalizing task=${task.id}\n`);
          try { log.end(() => workerFinalize(code)); } catch { workerFinalize(code); }
        }
      }, 5000);
    });
    child.once('close', code => {
      try { log.end(() => workerFinalize(code)); } catch { workerFinalize(code); }
    });

    // Listener registration MUST precede synchronous DB/OS inspection: a very
    // short-lived child can otherwise close while its PID birth token is read.
    try {
      const pid = child.pid;
      if (execution.executionId) {
        this.executionStore.markRunning(
          this.dbPath,
          execution.executionId,
          pid ?? null,
          this.executionStore.readBirthToken(pid ?? null),
          logPath,
          execution.startedAt,
        );
      }
    } catch (e) {
      run.lastError = `worker execution registration failed: ${e.message}`;
      try { execution.log.write(`[runner] ${run.lastError}\n`); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

export function createClaudeBoardRunner(options) {
  return new ClaudeBoardRunner(options);
}
