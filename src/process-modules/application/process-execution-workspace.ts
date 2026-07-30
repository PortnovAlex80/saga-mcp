/**
 * Machine-provisioned workspace for one Process Module LM execution.
 *
 * The Process Module descriptor owns the content (tracker/template/checklist
 * paths). This service owns the reusable execution physics: resolving those
 * assets safely, copying them into a project-scoped workspace, filling known
 * machine bindings and returning exact paths for the prompt and hook.
 *
 * W13-A2 legacy-removal note: the global-skill-root special-case paths that
 * previously lived here (resolving skills from a global skill root or built-in
 * catalog) are GONE. Pinned-installation skill/template resource resolution
 * now lives in `workspace-projection.ts` (W5-A1, via
 * `buildWorkspaceProjection`). This file keeps ONLY the legacy claude-worker
 * path that materializes tracker templates from `workspaceRoot` — the legacy
 * `legacy-claude-worker-executor-factory.ts` is still wired and active. When
 * that factory is retired, this file can be deleted entirely.
 *
 * No module-specific symbol or path is imported here.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';

export interface ProcessExecutionWorkspaceTask {
  id: number;
  epic_id?: number | null;
  metadata?: string | Record<string, unknown> | null;
}

export interface PrepareProcessExecutionWorkspaceRequest {
  workspaceRoot: string;
  module: ProcessModuleDefinition;
  profile: ExecutionProfileDefinition;
  projectId: number;
  epicId: number;
  task: ProcessExecutionWorkspaceTask;
  executionId: string | null;
  workerId: string;
}

export interface ProcessExecutionWorkspace {
  profileId: string;
  moduleRef: string;
  trackerPath: string;
  trackerAbsolutePath: string;
  agentAssistanceAbsolutePath?: string;
  executionDirectory: string;
  workspaceFiles: readonly string[];
  callFiles: readonly string[];
  checklists: readonly string[];
  /**
   * Optional test-only warm-start projection produced by an outer
   * infrastructure adapter. Process modules never read or create it.
   */
  testWarmStart?: {
    readonly fixtureId: string;
    readonly mode: 'verify-and-submit-existing-draft';
    readonly nodeId: string;
    readonly draftFiles: readonly string[];
    readonly coldStartFiles: readonly string[];
    readonly forceRewriteSlots: readonly string[];
    readonly instruction: string;
    readonly receiptPath: string;
    readonly cacheRoot: string;
    readonly cacheEntries: readonly {
      readonly slot: string;
      readonly policy: 'learn' | 'locked';
      readonly targetPath: string;
      readonly cachePath: string | null;
      readonly metadataPath: string | null;
      readonly packageDigest: string | null;
      readonly inputHash: string | null;
    }[];
  };
}

type MachineBindings = Record<string, unknown>;

export function normalizedKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function parseMetadata(value: ProcessExecutionWorkspaceTask['metadata']): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function collectScalarBindings(
  value: unknown,
  output: MachineBindings,
  prefix = '',
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key);
    const qualified = prefix ? `${prefix}_${normalized}` : normalized;
    if (
      child === null
      || typeof child === 'string'
      || typeof child === 'number'
      || typeof child === 'boolean'
    ) {
      if (!(normalized in output)) output[normalized] = child;
      output[qualified] = child;
      continue;
    }
    collectScalarBindings(child, output, qualified);
  }
}

export function buildMachineBindings(
  request: PrepareProcessExecutionWorkspaceRequest,
): MachineBindings {
  const metadata = parseMetadata(request.task.metadata);
  const bindings: MachineBindings = {};
  collectScalarBindings(metadata, bindings);

  const processRunId = bindings.PROCESS_RUN_ID ?? null;
  const nodeId = bindings.PROCESS_NODE_ID ?? bindings.NODE_ID ?? null;
  const inputHash = bindings.PROCESS_NODE_INPUT_HASH
    ?? bindings.PROCESS_INPUT_HASH
    ?? bindings.INPUT_SNAPSHOT_HASH
    ?? null;
  const workIntentId = bindings.WORK_INTENT_ID
    ?? bindings.PRE_PROJECTED_INTENT_ID
    ?? bindings.AUTHORITY_INTENT_ID
    ?? null;

  Object.assign(bindings, {
    MODULE_NAME: request.module.identity.name,
    MODULE_VERSION: request.module.identity.version,
    MODULE_KIND: request.module.identity.kind,
    MODULE_REF: `${request.module.identity.name}@${request.module.identity.version}`,
    PROCESS_MODULE_REF: `${request.module.identity.name}@${request.module.identity.version}`,
    PROFILE_ID: request.profile.id,
    PROCESS_RUN_ID: processRunId,
    NODE_ID: nodeId,
    WORK_INTENT_ID: workIntentId,
    INTENT_ID: workIntentId,
    PROJECT_ID: request.projectId,
    EPIC_ID: request.epicId,
    TASK_ID: request.task.id,
    EXECUTION_ID: request.executionId,
    WORKER_ID: request.workerId,
    INPUT_HASH: inputHash,
    INPUT_SNAPSHOT_HASH: inputHash,
    OUTPUT_SCHEMA: request.profile.outputSchema.id,
    ALLOWED_TOOLS: JSON.stringify(request.profile.allowedTools),
    AUTHORITY_SCOPE: request.profile.semanticSkill,
    MAX_ATTEMPTS: request.profile.retryPolicy.maxAttempts,
  });

  return bindings;
}

function safeAssetPath(workspaceRoot: string, relativeAssetPath: string): string {
  if (path.isAbsolute(relativeAssetPath)) {
    throw new Error(`PROCESS_WORKSPACE_ASSET_INVALID: absolute path '${relativeAssetPath}'`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativeAssetPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`PROCESS_WORKSPACE_ASSET_INVALID: path escapes workspace '${relativeAssetPath}'`);
  }
  return resolved;
}

export function valueForFillToken(token: string, bindings: MachineBindings): unknown {
  const normalized = normalizedKey(token.replace(/^FILL_/, ''));
  const aliases: Array<[RegExp, string]> = [
    [/EXECUTION_ID/, 'EXECUTION_ID'],
    [/WORKER_ID/, 'WORKER_ID'],
    [/WORK_INTENT_ID/, 'WORK_INTENT_ID'],
    [/(^|_)TASK_ID($|_)/, 'TASK_ID'],
    [/(^|_)PROJECT_ID($|_)/, 'PROJECT_ID'],
    [/(^|_)EPIC_ID($|_)/, 'EPIC_ID'],
    [/PROCESS_RUN_ID/, 'PROCESS_RUN_ID'],
    [/(^|_)NODE_ID($|_)/, 'NODE_ID'],
    [/INPUT_(SNAPSHOT_)?HASH/, 'INPUT_SNAPSHOT_HASH'],
    [/CONTROL_INTENT_ID/, 'CONTROL_INTENT_ID'],
    [/SOURCE_(RAW_)?SUBMISSION_ID/, 'SOURCE_SUBMISSION_ID'],
  ];
  for (const [pattern, key] of aliases) {
    if (pattern.test(normalized) && bindings[key] !== undefined && bindings[key] !== null) {
      return bindings[key];
    }
  }

  const candidates = Object.keys(bindings)
    .filter(key => bindings[key] !== undefined && bindings[key] !== null)
    .sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    if (key.length >= 5 && normalized.includes(key)) return bindings[key];
  }
  return undefined;
}

export function fillKnownPlaceholders(content: string, bindings: MachineBindings): string {
  let result = content.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (full, rawKey: string) => {
    const value = bindings[normalizedKey(rawKey)];
    return value === undefined || value === null ? full : String(value);
  });

  result = result.replace(/"((?:FILL_)[A-Z0-9_]+)"/g, (full, token: string) => {
    const value = valueForFillToken(token, bindings);
    return value === undefined || value === null ? full : JSON.stringify(value);
  });
  return result;
}

export function refreshMarkdownMachineBindings(
  content: string,
  bindings: MachineBindings,
): string {
  let result = fillKnownPlaceholders(content, bindings);
  const lineBindings: Record<string, unknown> = {
    process_module_ref: bindings.PROCESS_MODULE_REF,
    process_run_id: bindings.PROCESS_RUN_ID,
    node_id: bindings.NODE_ID,
    work_intent_id: bindings.WORK_INTENT_ID,
    intent_id: bindings.WORK_INTENT_ID,
    project_id: bindings.PROJECT_ID,
    epic_id: bindings.EPIC_ID,
    task_id: bindings.TASK_ID,
    execution_id: bindings.EXECUTION_ID,
    worker_id: bindings.WORKER_ID,
    input_snapshot_hash: bindings.INPUT_SNAPSHOT_HASH,
    output_schema: bindings.OUTPUT_SCHEMA,
    allowed_tools: bindings.ALLOWED_TOOLS,
    authority_scope: bindings.AUTHORITY_SCOPE,
    max_attempts: bindings.MAX_ATTEMPTS,
  };
  for (const [key, value] of Object.entries(lineBindings)) {
    if (value === undefined || value === null) continue;
    const rendered = typeof value === 'string' && !value.startsWith('[')
      ? `\`${value}\``
      : String(value);
    result = result.replace(
      new RegExp(`^(\\s*-\\s+${key}:\\s*).*$`, 'gim'),
      (_full, prefix: string) => `${prefix}${rendered}`,
    );
  }
  return result;
}

export function refreshJsonMachineBindings(
  content: string,
  bindings: MachineBindings,
): string {
  const filled = fillKnownPlaceholders(content, bindings);
  try {
    const payload = JSON.parse(filled) as unknown;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const normalized = normalizedKey(key);
        const machineValue = bindings[normalized];
        if (machineValue !== undefined && machineValue !== null && [
          'PROCESS_RUN_ID',
          'NODE_ID',
          'WORK_INTENT_ID',
          'INTENT_ID',
          'PROJECT_ID',
          'EPIC_ID',
          'TASK_ID',
          'EXECUTION_ID',
          'WORKER_ID',
          'CONTROL_INTENT_ID',
          'SOURCE_SUBMISSION_ID',
          'INPUT_HASH',
          'INPUT_SNAPSHOT_HASH',
        ].includes(normalized)) {
          (value as Record<string, unknown>)[key] = machineValue;
        } else {
          visit(child);
        }
      }
    };
    visit(payload);
    return `${JSON.stringify(payload, null, 2)}\n`;
  } catch {
    return filled;
  }
}

export function materializedName(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return `${parsed.name.replace(/-template$/i, '')}${parsed.ext}`;
}

export function relativeWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), absolutePath).replace(/\\/g, '/');
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function recoveryFeedbackFromMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct = metadata.recovery_feedback;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const nodeInput = metadata.process_node_input;
  if (!nodeInput || typeof nodeInput !== 'object' || Array.isArray(nodeInput)) return null;
  const bindings = (nodeInput as Record<string, unknown>).bindings;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return null;
  const nested = (bindings as Record<string, unknown>).recoveryFeedback;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

// ---------------------------------------------------------------------------
// Machine-fill of the Development task-graph submit template.
//
// The planning LM historically failed to fill the placeholder template
// `task-graph-submit-call-template.json` correctly: it (a) skipped
// verification-only ACs because it could not distinguish "implementation
// required" from "always verify", and (b) picked the wrong
// `projectRepositoryId`. The fix is to read the authoritative state from the
// DB (accepted ACs + active repository bindings) and emit a COMPLETE proposal
// skeleton with correct integer ids, one implementation + one verification
// item per accepted AC (T-014 hard rule: every AC gets verification), and one
// integration target per bound repository. The LM only reviews/edits content.
//
// Constants mirror the planner skill (§2a ac_kind mapping + T-014 rule) so the
// machine skeleton matches what a correct manual planner would submit.
// ---------------------------------------------------------------------------

const DEVELOPMENT_PLANNING_MODULE_KIND = 'development';
const DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA =
  'saga3.development-task-graph-proposal.v1';
const DEVELOPMENT_TASK_GRAPH_TEMPLATE_BASENAME =
  'task-graph-submit-call-template.json';
const DEVELOPMENT_TASK_GRAPH_TEMPLATE_MATERIALIZED =
  'task-graph-submit-call.json';

const PLANNING_IMPLEMENTATION_TASK_KIND = 'development.code';
const PLANNING_IMPLEMENTATION_EXECUTION_SKILL = 'saga-worker';
const PLANNING_VERIFICATION_TASK_KIND = 'verification.ac';
const PLANNING_VERIFICATION_EXECUTION_SKILL = 'saga-verifier';

interface AcceptedAcRow {
  id: number;
  code: string | null;
}

interface ProjectRepositoryRow {
  id: number;
  integration_branch: string;
  local_path: string | null;
}

/**
 * Read the HEAD commit sha for the repo at `repoPath`. Returns an empty
 * string when git is unavailable or the path is not a checkout so the
 * template stays submittable (the planner LM can still read §D2 and patch
 * it). Never throws — the workspace materializer must stay robust.
 */
function resolveHeadCommit(repoPath: string): string {
  try {
    if (!repoPath || !existsSync(repoPath)) return '';
    const r = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0 || r.error) return '';
    return (r.stdout || '').trim();
  } catch {
    return '';
  }
}

function compareAcCode(a: AcceptedAcRow, b: AcceptedAcRow): number {
  // Natural sort so AC-2 sorts before AC-10/AC-15/AC-16. Falls back to id.
  const sa = (a.code ?? '').toLowerCase();
  const sb = (b.code ?? '').toLowerCase();
  if (sa && sb && sa !== sb) return sa.localeCompare(sb, undefined, { numeric: true });
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  return a.id - b.id;
}

/**
 * Build the filled Development task-graph submit call as a plain object, or
 * `null` when the DB state cannot support a complete skeleton (no accepted
 * ACs or no active repository bindings). Returning null leaves the LM to fill
 * the placeholder template by hand — the same behaviour as before this
 * machine-fill existed.
 *
 * `db` is accepted as a parameter so the function is testable without the
 * process-wide singleton; the public entry point resolves it via `getDb()`.
 */
export function buildDevelopmentTaskGraphSubmitCall(
  db: Database.Database,
  projectId: number,
  epicId: number,
): {
  tool: 'process_node_submit';
  arguments: {
    schema: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
    payload: {
      schemaVersion: typeof DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA;
      implementationItems: unknown[];
      verificationItems: unknown[];
      integrationTargets: unknown[];
    };
  };
} | null {
  const acs = (db.prepare(
    `SELECT id, code FROM artifacts
       WHERE project_id=? AND epic_id=? AND type='AC' AND status='accepted'`,
  ).all(projectId, epicId) as AcceptedAcRow[]).sort(compareAcCode);

  const repositories = db.prepare(
    `SELECT id, integration_branch, local_path
       FROM project_repositories
      WHERE project_id=? AND status='active'
      ORDER BY id`,
  ).all(projectId) as ProjectRepositoryRow[];

  if (acs.length === 0 || repositories.length === 0) return null;

  // Single bound repository is the overwhelmingly common case (one epic → one
  // physical repo). When the development-case input binds more than one repo,
  // the planner LM owns the per-AC repo assignment; here we attribute every AC
  // to the primary (lowest-id active) repository so the skeleton is internally
  // consistent and submittable, and the LM re-routes items as needed.
  const primaryRepository = repositories[0]!;
  const primaryRepositoryId = primaryRepository.id;

  const implementationItems: unknown[] = [];
  const verificationItems: unknown[] = [];
  const implementationKeys: string[] = [];

  for (const ac of acs) {
    const suffix = (ac.code ?? `id${ac.id}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const implKey = suffix ? `impl-ac-${suffix}` : `impl-ac-${ac.id}`;
    const verifyKey = suffix ? `verify-ac-${suffix}` : `verify-ac-${ac.id}`;

    implementationItems.push({
      key: implKey,
      kind: 'implementation',
      taskKind: PLANNING_IMPLEMENTATION_TASK_KIND,
      executionSkill: PLANNING_IMPLEMENTATION_EXECUTION_SKILL,
      executionMode: 'git_change',
      projectRepositoryId: primaryRepositoryId,
      acceptanceCriterionIds: [ac.id],
      dependsOnKeys: [],
      required: true,
    });
    implementationKeys.push(implKey);

    // T-014: every accepted AC gets exactly one required verification item,
    // regardless of its ac_kind (implementation ACs are NOT exempt).
    verificationItems.push({
      key: verifyKey,
      kind: 'verification',
      taskKind: PLANNING_VERIFICATION_TASK_KIND,
      executionSkill: PLANNING_VERIFICATION_EXECUTION_SKILL,
      executionMode: 'read_only_evidence',
      projectRepositoryId: primaryRepositoryId,
      acceptanceCriterionIds: [ac.id],
      dependsOnKeys: [implKey],
      required: true,
    });
  }

  const integrationTargets = repositories.map(repo => ({
    projectRepositoryId: repo.id,
    sourceWorkItemKeys: repo.id === primaryRepositoryId
      ? implementationKeys
      : [],
    targetBranch: repo.integration_branch,
    expectedBaseCommit: resolveHeadCommit(repo.local_path ?? ''),
  }));

  return {
    tool: 'process_node_submit',
    arguments: {
      schema: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
      payload: {
        schemaVersion: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
        implementationItems,
        verificationItems,
        integrationTargets,
      },
    },
  };
}

/**
 * Materialize a DB-backed, COMPLETE task-graph submit call for the Development
 * planning LM, REPLACING the placeholder template the LM would otherwise have
 * to fill by hand. Idempotent and carry-over aware:
 *
 *  - Only fires when `module.identity.kind === 'development'` AND the profile's
 *    callTemplates reference the Development task-graph template.
 *  - `overwriteFreshPlaceholder` must be `true` to write. The caller sets it
 *    only when the materialized target did NOT exist before this invocation
 *    (i.e. the materializer loop just emitted the placeholder template). When
 *    it is `false` the target is either a recovery carry-over (the LM-edited
 *    draft from the previous attempt, copied in earlier in this function) or a
 *    replay within the same attempt — the LM owns the working copy and the
 *    machine never clobbers semantic work.
 *  - Skipped silently when DB state cannot produce a complete skeleton (no
 *    accepted ACs or no active repository bindings); the LM then fills the
 *    placeholder template manually — identical to pre-machine-fill behaviour.
 *
 * Returns the basename of the materialized file when it (re)wrote it, or
 * `null` when it did not.
 */
export function machineFillPlanningTemplate(
  request: PrepareProcessExecutionWorkspaceRequest,
  executionDirectory: string,
  overwriteFreshPlaceholder: boolean,
): string | null {
  if (request.module.identity.kind !== DEVELOPMENT_PLANNING_MODULE_KIND) {
    return null;
  }
  if (!overwriteFreshPlaceholder) return null;
  const hasTaskGraphTemplate = request.profile.callTemplates.some(asset =>
    path.basename(asset) === DEVELOPMENT_TASK_GRAPH_TEMPLATE_BASENAME);
  if (!hasTaskGraphTemplate) return null;

  const filled = buildDevelopmentTaskGraphSubmitCall(
    getDb(),
    request.projectId,
    request.epicId,
  );
  if (!filled) return null;

  const target = path.join(executionDirectory, DEVELOPMENT_TASK_GRAPH_TEMPLATE_MATERIALIZED);
  writeFileSync(target, `${JSON.stringify(filled, null, 2)}\n`);
  return DEVELOPMENT_TASK_GRAPH_TEMPLATE_MATERIALIZED;
}

export function prepareProcessExecutionWorkspace(
  request: PrepareProcessExecutionWorkspaceRequest,
): ProcessExecutionWorkspace {
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const stage = request.module.identity.kind;
  const stageRoot = path.join(workspaceRoot, 'docs', stage);
  const toolsDirectory = path.join(stageRoot, 'tools');
  const projectDirectory = path.join(stageRoot, 'projects', String(request.epicId));
  const executionDirectory = path.join(
    projectDirectory,
    'executions',
    `task-${request.task.id}`,
  );
  mkdirSync(toolsDirectory, { recursive: true });
  mkdirSync(executionDirectory, { recursive: true });

  const bindings = buildMachineBindings(request);
  const metadata = parseMetadata(request.task.metadata);
  const recoveryFeedback = recoveryFeedbackFromMetadata(metadata);
  const recoveryFeedbackPath = recoveryFeedback
    ? path.join(executionDirectory, 'recovery-feedback.json')
    : null;
  if (recoveryFeedbackPath) {
    // Machine-owned on every semantic attempt: never retain stale findings
    // from a prior task/work-intent round.
    writeFileSync(
      recoveryFeedbackPath,
      `${JSON.stringify(recoveryFeedback, null, 2)}\n`,
    );
  }
  if (recoveryFeedback) {
    // Carry over previous attempt's materialized files so the worker fixes
    // existing work instead of starting from a blank template. A recovery
    // attempt gets a NEW task id -> NEW execution directory, so without this
    // carry-over the "preserve semantic work on retry" branch below would
    // never fire (the target file does not exist in the new directory) and
    // the worker would loop on the same mistakes.
    const currentTaskDir = `task-${request.task.id}`;
    const expectedFiles = unique([
      ...request.profile.workspaceTemplates,
      ...request.profile.callTemplates,
    ]).map(asset => materializedName(asset));

    let prevDirs: string[] = [];
    try {
      prevDirs = readdirSync(path.join(projectDirectory, 'executions'))
        .filter(d => d.startsWith('task-') && d !== currentTaskDir)
        .map(d => path.join(projectDirectory, 'executions', d))
        .filter(d => existsSync(d))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // newest first
    } catch {
      /* no previous dirs */
    }

    for (const prevDir of prevDirs) {
      for (const expectedFile of expectedFiles) {
        const target = path.join(executionDirectory, expectedFile);
        if (existsSync(target)) continue; // already have it
        const source = path.join(prevDir, expectedFile);
        if (existsSync(source)) {
          writeFileSync(target, readFileSync(source, 'utf8'));
        }
      }
    }
  }
  const allAssets = unique([
    ...(request.profile.trackerTemplate ? [request.profile.trackerTemplate] : []),
    ...request.profile.workspaceTemplates,
    ...request.profile.callTemplates,
    ...request.profile.checklists,
  ]);

  for (const asset of allAssets) {
    const source = safeAssetPath(workspaceRoot, asset);
    if (!existsSync(source)) {
      throw new Error(
        `PROCESS_WORKSPACE_ASSET_MISSING: profile '${request.profile.id}' references '${asset}'`,
      );
    }
    const sharedTarget = path.join(toolsDirectory, path.basename(asset));
    if (!existsSync(sharedTarget)) {
      writeFileSync(sharedTarget, readFileSync(source, 'utf8'));
    }
  }

  const materializedBySource = new Map<string, string>();
  const freshPlaceholderTargets = new Set<string>();
  for (const asset of unique([
    ...request.profile.workspaceTemplates,
    ...request.profile.callTemplates,
  ])) {
    const source = safeAssetPath(workspaceRoot, asset);
    const target = path.join(executionDirectory, materializedName(asset));
    const sourceContent = readFileSync(source, 'utf8');
    if (!existsSync(target)) {
      const prepared = path.extname(target).toLowerCase() === '.json'
        ? refreshJsonMachineBindings(sourceContent, bindings)
        : fillKnownPlaceholders(sourceContent, bindings);
      writeFileSync(target, prepared);
      freshPlaceholderTargets.add(target);
    } else if (path.extname(target).toLowerCase() === '.json') {
      // Preserve semantic work on retry, but refresh execution-fenced fields.
      const existing = readFileSync(target, 'utf8');
      writeFileSync(target, refreshJsonMachineBindings(existing, bindings));
    }
    materializedBySource.set(asset, relativeWorkspacePath(workspaceRoot, target));
  }

  // Machine-fill the Development planning submit template: emit a COMPLETE,
  // DB-backed task-graph proposal skeleton instead of the placeholder template
  // the LM would otherwise fill by hand. Only overwrites the FRESH placeholder
  // the loop just emitted (carry-over / replay drafts are preserved).
  machineFillPlanningTemplate(
    request,
    executionDirectory,
    freshPlaceholderTargets.has(
      path.join(executionDirectory, DEVELOPMENT_TASK_GRAPH_TEMPLATE_MATERIALIZED),
    ),
  );

  if (!request.profile.trackerTemplate) {
    throw new Error(
      `PROCESS_WORKSPACE_TRACKER_MISSING: profile '${request.profile.id}' has no tracker template`,
    );
  }
  const trackerSource = safeAssetPath(workspaceRoot, request.profile.trackerTemplate);
  if (!existsSync(trackerSource)) {
    throw new Error(
      `PROCESS_WORKSPACE_ASSET_MISSING: tracker '${request.profile.trackerTemplate}'`,
    );
  }
  const trackerAbsolutePath = path.join(
    projectDirectory,
    `project-${request.epicId}-${stage}-stage-${request.task.id}.md`,
  );
  if (!existsSync(trackerAbsolutePath)) {
    const tracker = refreshMarkdownMachineBindings(
      readFileSync(trackerSource, 'utf8'),
      bindings,
    );
    writeFileSync(trackerAbsolutePath, tracker);
  } else {
    // Retry/restart: retain checkpoints and only refresh machine-owned fields.
    const tracker = refreshMarkdownMachineBindings(
      readFileSync(trackerAbsolutePath, 'utf8'),
      bindings,
    );
    writeFileSync(trackerAbsolutePath, tracker);
  }

  // Machine-fill submission state from DB: if a proposal was submitted in a
  // previous execution of this node, update the tracker so the reviewer (who
  // reads the tracker markdown, not the DB) sees submission_state: submitted.
  // Without this, every review-loop execution regenerates tracker with
  // not-submitted, causing the reviewer to reject with "No proposal found".
  if (request.module.identity.kind === 'development') {
    try {
      const db = getDb();
      const nodeId = parseMetadata(request.task.metadata).process_node_id;
      if (nodeId) {
        const submission = db.prepare(
          `SELECT id, content_hash FROM saga3_managed_node_submissions
            WHERE process_run_id=? AND node_id=?
            ORDER BY id DESC LIMIT 1`,
        ).get(
          parseMetadata(request.task.metadata).process_run_id,
          nodeId,
        ) as { id: number; content_hash: string } | undefined;
        if (submission) {
          const trackerContent = readFileSync(trackerAbsolutePath, 'utf8');
          const updated = trackerContent
            .replace(
              /submission_state:\s*`not-submitted`/g,
              `submission_state: \`submitted\``,
            )
            .replace(
              /submission_ref:\s*$/m,
              `submission_ref: managed-node-submission:${submission.id}`,
            )
            .replace(
              /submission_hash:\s*$/m,
              `submission_hash: ${submission.content_hash}`,
            );
          if (updated !== trackerContent) {
            writeFileSync(trackerAbsolutePath, updated);
          }
        }
      }
    } catch {
      // Non-fatal: if DB read fails, tracker stays as-is (not-submitted).
    }
  }

  return {
    profileId: request.profile.id,
    moduleRef: `${request.module.identity.name}@${request.module.identity.version}`,
    trackerPath: relativeWorkspacePath(workspaceRoot, trackerAbsolutePath),
    trackerAbsolutePath,
    executionDirectory: relativeWorkspacePath(workspaceRoot, executionDirectory),
    workspaceFiles: [
      ...request.profile.workspaceTemplates
        .map(asset => materializedBySource.get(asset))
        .filter((value): value is string => Boolean(value)),
      ...(recoveryFeedbackPath
        ? [relativeWorkspacePath(workspaceRoot, recoveryFeedbackPath)]
        : []),
    ],
    callFiles: request.profile.callTemplates
      .map(asset => materializedBySource.get(asset))
      .filter((value): value is string => Boolean(value)),
    checklists: request.profile.checklists.map(asset =>
      relativeWorkspacePath(
        workspaceRoot,
        path.join(toolsDirectory, path.basename(asset)),
      )),
  };
}
