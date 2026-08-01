/**
 * Machine-provisioned workspace helpers for Process Module LM executions.
 *
 * saga4 cutover (LEGO-CONTRACTS.md §"Слой 1: СТОЛ"): the legacy
 * `prepareProcessExecutionWorkspace` function and the loose
 * `ProcessExecutionWorkspace` interface have been REMOVED. After the saga4
 * cutover, `materializePinnedWorkspace` (in
 * `pinned-workspace-materializer.ts`) is the SOLE desk creator and returns the
 * strict {@link WorkplaceDesk} contract enforced by `assertDeskInvariants`.
 *
 * This file now keeps ONLY the reusable helpers the pinned materializer shares
 * with the broader runtime: metadata parsing, machine-binding construction,
 * placeholder refresh (markdown + JSON), materialized-name derivation, the
 * project-relative path helper, and the recovery/review feedback readers. The
 * pinned materializer imports these directly so the 15-key markdown allowlist
 * and 13-key JSON allowlist that define "what gets refreshed on retry" stay
 * single-source.
 *
 * No module-specific symbol or path is imported here.
 */

import path from 'node:path';
import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
} from '../domain/process-module.js';
import type {
  ProcessWorkspaceTemplatePreparer,
} from './process-workspace-preparation.js';

export interface ProcessExecutionWorkspaceTask {
  id: number;
  epic_id?: number | null;
  metadata?: string | Record<string, unknown> | null;
}

/**
 * Input shape for {@link buildMachineBindings}. Historically also used by the
 * deleted `prepareProcessExecutionWorkspace`; only the binding builder reads
 * it now (the pinned materializer builds its own request shape and forwards
 * into this helper).
 */
export interface PrepareProcessExecutionWorkspaceRequest {
  workspaceRoot: string;
  module: ProcessModuleDefinition;
  profile: ExecutionProfileDefinition;
  projectId: number;
  epicId: number;
  task: ProcessExecutionWorkspaceTask;
  executionId: string | null;
  workerId: string;
  /** Machine-owned projection values supplied by an outer adapter. */
  additionalBindings?: Readonly<Record<string, unknown>>;
  /** Optional module-owned semantic template preparation. */
  templatePreparer?: ProcessWorkspaceTemplatePreparer;
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
  Object.assign(bindings, request.additionalBindings ?? {});

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

export function valueForFillToken(token: string, bindings: MachineBindings): unknown {
  const normalized = normalizedKey(token.replace(/^FILL_/, ''));
  const aliases: Array<[RegExp, string]> = [
    [/EXECUTION_ID/, 'EXECUTION_ID'],
    [/WORKER_ID/, 'WORKER_ID'],
    [/WORK_INTENT_ID/, 'WORK_INTENT_ID'],
    [/(^|_)TASK_ID($|_)/, 'TASK_ID'],
    [/(^|_)PROJECT_ID($|_)/, 'PROJECT_ID'],
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
    submission_state: bindings.SUBMISSION_STATE,
    submission_ref: bindings.SUBMISSION_REF,
    submission_hash: bindings.SUBMISSION_HASH,
  };
  for (const [key, value] of Object.entries(lineBindings)) {
    if (value === undefined || value === null) continue;
    const rendered = typeof value === 'string' && !value.startsWith('[')
      ? `\`${value}\``
      : String(value);
    result = result.replace(
      // Horizontal whitespace only: `\s` also consumes the following newline
      // when an initially-empty tracker field is refreshed, which used to put
      // the machine value on a detached line that reviewers could not parse.
      new RegExp(`^([\\t ]*-[\\t ]+${key}:[\\t ]*).*$`, 'gim'),
      (_full, prefix: string) => `${prefix.trimEnd()} ${rendered}`,
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

/**
 * Read the most recent reviewer feedback (CGAD P18 — review-loop is a rework
 * cycle, same model as recovery: a worker comes to the workplace and must see
 * the feedback about what to fix). The dispatcher records the reviewer's
 * `result` text in `managed_review_last_feedback` when it returns
 * `changes_requested` (dispatcher.ts worker_done). This reader surfaces it as a
 * machine-owned feedback object so the materializer can write it to the desk,
 * mirroring recovery-feedback.json. Returns null when no prior review rejection
 * is recorded (first author pass, or an approved review).
 */
export function reviewFeedbackFromMetadata(
  metadata: Record<string, unknown>,
): { attempt: number; budget: number; rejections: number; feedback: string } | null {
  const feedback = metadata.managed_review_last_feedback;
  if (typeof feedback !== 'string' || feedback.trim().length === 0) return null;
  const rejections = typeof metadata.managed_review_rejections === 'number'
    ? metadata.managed_review_rejections
    : 0;
  if (rejections <= 0) return null;
  const budget = typeof metadata.managed_review_budget === 'number'
    ? metadata.managed_review_budget
    : 0;
  return {
    attempt: rejections,
    budget,
    rejections,
    feedback,
  };
}
