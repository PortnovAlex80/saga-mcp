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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
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
    } else if (path.extname(target).toLowerCase() === '.json') {
      // Preserve semantic work on retry, but refresh execution-fenced fields.
      const existing = readFileSync(target, 'utf8');
      writeFileSync(target, refreshJsonMachineBindings(existing, bindings));
    }
    materializedBySource.set(asset, relativeWorkspacePath(workspaceRoot, target));
  }

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
