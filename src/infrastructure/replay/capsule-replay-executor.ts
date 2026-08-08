/**
 * Generic in-process ReplayCapsule production adapter.
 *
 * Replay is an internal production source of the normal fenced WorkerExecution,
 * not another Factory/executor mode. It reconstructs worker products through
 * the same authorized product/artifact/trace boundary as inference; the current
 * CandidateSet, GateDecision and lifecycle always run afterwards.
 */
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ReplayCapsulePayload,
  ReplayArtifactSelector,
  ReplayArtifactProduct,
  ReplayInputBinding,
} from '../../replay/replay-capsule.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { deserializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export interface CapsuleReplayHandlers {
  product_submit: (input: { schema: string; content: unknown }) => unknown;
  artifact_create: (input: {
    type: string;
    code?: string;
    title: string;
    path: string;
    status: string;
    tags: readonly string[];
    metadata: Readonly<Record<string, unknown>>;
    parent_artifact_id?: number;
    project_repository_id?: number;
  }) => { artifact?: { id?: number } };
  trace_add: (input: {
    source_id: number;
    target_type: string;
    target_id?: number;
    link_type: string;
  }) => unknown;
  worker_done: (input: {
    task_id: number;
    worker_id: string;
    result: string;
    execution_id?: string;
  }) => unknown;
}

export interface CapsuleReplayContext {
  taskId: number;
  workerId: string;
  executionId: string;
  cwd: string;
}

export interface CapsuleReplayOutcome {
  readonly productsSubmitted: number;
  readonly artifactsRecreated: number;
  readonly tracesRecreated: number;
  readonly gitCommit?: string;
}

function selectorKey(selector: ReplayArtifactSelector): string {
  return `${selector.type}::${selector.code ?? ''}::${selector.title}::${selector.path}::${selector.contentHash ?? ''}`;
}

export function executeCapsuleReplay(
  db: Database.Database,
  handlers: CapsuleReplayHandlers,
  context: CapsuleReplayContext,
): CapsuleReplayOutcome {
  const execRow = db.prepare(
    `SELECT we.metadata,t.metadata AS task_metadata,we.project_id
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
      WHERE we.execution_id=? AND we.task_id=?`,
  ).get(context.executionId, context.taskId) as {
    metadata: string;
    task_metadata: string;
    project_id: number;
  } | undefined;
  if (!execRow) {
    throw new Error(`CAPSULE_REPLAY_EXECUTION_NOT_FOUND: ${context.executionId}`);
  }

  const envelope = JSON.parse(execRow.metadata) as {
    execution_context?: {
      replay?: {
        capsule_ref?: string | null;
        capsule_payload_hash?: string | null;
      };
    };
  };
  const replayBinding = envelope.execution_context?.replay;
  const capsuleRef = replayBinding?.capsule_ref;
  if (!capsuleRef) throw new Error('CAPSULE_REPLAY_NO_CAPSULE_REF');

  const capsuleRow = db.prepare(
    `SELECT project_id,payload_snapshot,payload_hash
       FROM factory_replay_capsules WHERE capsule_ref=?`,
  ).get(capsuleRef) as {
    project_id: number;
    payload_snapshot: string;
    payload_hash: string;
  } | undefined;
  if (!capsuleRow) throw new Error(`CAPSULE_REPLAY_CAPSULE_NOT_FOUND: ${capsuleRef}`);
  if (capsuleRow.project_id !== execRow.project_id) {
    throw new Error('CAPSULE_REPLAY_PROJECT_SCOPE_MISMATCH');
  }

  const payload = JSON.parse(capsuleRow.payload_snapshot) as ReplayCapsulePayload;
  if (capsuleRow.payload_hash !== sha256Hex(payload)) {
    throw new Error(`CAPSULE_REPLAY_HASH_MISMATCH: ${capsuleRef}`);
  }
  if (
    replayBinding.capsule_payload_hash
    && replayBinding.capsule_payload_hash !== capsuleRow.payload_hash
  ) {
    throw new Error(`CAPSULE_REPLAY_FROZEN_HASH_MISMATCH: ${capsuleRef}`);
  }

  const taskMetadata = parseObject(execRow.task_metadata);
  const currentInput = taskMetadata.process_node_input
    ?? taskMetadata.cell_input_item
    ?? {};
  const allowedBindingPaths = new Set(
    (payload.inputBindings ?? []).map(binding => binding.path),
  );

  const artifactIdBySelector = new Map<string, number>();

  // Artifacts may contain run-local input identities in metadata even for old
  // capsules created before explicit metadata markers existed. Rebind only
  // values that correspond uniquely to the capsule's own exact inputBindings.
  for (const artifact of payload.artifacts ?? []) {
    const key = selectorKey(artifact.selector);
    const parentArtifactId = artifact.parent
      ? artifactIdBySelector.get(selectorKey(artifact.parent))
        ?? resolveExistingArtifactId(db, execRow.project_id, artifact.parent)
        ?? undefined
      : undefined;
    if (artifact.parent && parentArtifactId === undefined) {
      throw new Error(
        `CAPSULE_REPLAY_PARENT_ARTIFACT_MISSING: ${selectorKey(artifact.parent)}`,
      );
    }

    materializeArtifactFile(db, artifact, context.cwd);
    const reboundMetadata = rebindCapturedIdentityValues(
      artifact.metadata,
      payload.inputBindings ?? [],
      currentInput,
    );
    if (!reboundMetadata || typeof reboundMetadata !== 'object' || Array.isArray(reboundMetadata)) {
      throw new Error(`CAPSULE_REPLAY_ARTIFACT_METADATA_INVALID: ${key}`);
    }
    try {
      const result = handlers.artifact_create({
        type: artifact.selector.type,
        code: artifact.selector.code ?? undefined,
        title: artifact.selector.title,
        path: artifact.selector.path,
        status: artifact.status,
        tags: artifact.tags,
        metadata: reboundMetadata as Readonly<Record<string, unknown>>,
        parent_artifact_id: parentArtifactId,
        project_repository_id: artifact.projectRepositoryId ?? undefined,
      });
      const createdId = result?.artifact?.id;
      if (!Number.isSafeInteger(createdId) || Number(createdId) < 1) {
        throw new Error('artifact_create did not return a valid artifact id');
      }
      artifactIdBySelector.set(key, Number(createdId));
    } catch (error) {
      throw new Error(
        `CAPSULE_REPLAY_ARTIFACT_FAILED: ${key}: ${errorMessage(error)}`,
      );
    }
  }

  let tracesRecreated = 0;
  for (const trace of payload.traces ?? []) {
    const sourceKey = selectorKey(trace.source);
    const sourceId = artifactIdBySelector.get(sourceKey)
      ?? resolveExistingArtifactId(db, execRow.project_id, trace.source);
    if (!sourceId) throw new Error(`CAPSULE_REPLAY_TRACE_SOURCE_MISSING: ${sourceKey}`);

    let targetId: number;
    if (trace.targetType === 'artifact') {
      if (!trace.targetArtifact) {
        throw new Error('CAPSULE_REPLAY_TRACE_TARGET_MISSING: artifact selector absent');
      }
      const targetKey = selectorKey(trace.targetArtifact);
      const resolved = artifactIdBySelector.get(targetKey)
        ?? resolveExistingArtifactId(db, execRow.project_id, trace.targetArtifact);
      if (!resolved) throw new Error(`CAPSULE_REPLAY_TRACE_TARGET_MISSING: ${targetKey}`);
      targetId = resolved;
    } else if (trace.targetType === 'task') {
      if (!trace.targetTaskGenerationKey) {
        throw new Error('CAPSULE_REPLAY_TRACE_TARGET_MISSING: task identity absent');
      }
      const resolved = resolveCurrentTaskFromCapturedGenerationKey(
        db,
        execRow.project_id,
        trace.targetTaskGenerationKey,
      );
      if (!resolved) {
        throw new Error(
          `CAPSULE_REPLAY_TRACE_TARGET_MISSING: task=${trace.targetTaskGenerationKey}`,
        );
      }
      targetId = resolved;
    } else {
      throw new Error(`CAPSULE_REPLAY_TRACE_TARGET_TYPE_INVALID: ${String(trace.targetType)}`);
    }

    try {
      handlers.trace_add({
        source_id: sourceId,
        target_type: trace.targetType,
        target_id: targetId,
        link_type: trace.linkType,
      });
      tracesRecreated += 1;
    } catch (error) {
      throw new Error(`CAPSULE_REPLAY_TRACE_FAILED: ${errorMessage(error)}`);
    }
  }

  let gitCommit: string | undefined;
  if (payload.git) gitCommit = applyGitRecipe(payload.git, context.cwd);

  let productsSubmitted = 0;
  for (const product of payload.typedProducts ?? []) {
    const rebound = rehydrateReplayValue(
      product.content,
      currentInput,
      allowedBindingPaths,
    );
    try {
      handlers.product_submit({ schema: product.schema, content: rebound });
      productsSubmitted += 1;
    } catch (error) {
      throw new Error(
        `CAPSULE_REPLAY_PRODUCT_FAILED schema=${product.schema}: ${errorMessage(error)}`,
      );
    }
  }

  return {
    productsSubmitted,
    artifactsRecreated: artifactIdBySelector.size,
    tracesRecreated,
    gitCommit,
  };
}

function rehydrateReplayValue(
  value: unknown,
  currentInput: unknown,
  allowedPaths: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => rehydrateReplayValue(item, currentInput, allowedPaths));
  }
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length === 1 && typeof row.$sagaReplayInput === 'string') {
    const bindingPath = row.$sagaReplayInput;
    if (!allowedPaths.has(bindingPath)) {
      throw new Error(`CAPSULE_REPLAY_INPUT_BINDING_UNDECLARED: ${bindingPath}`);
    }
    const resolved = readPath(currentInput, bindingPath);
    if (!resolved.found) {
      throw new Error(`CAPSULE_REPLAY_INPUT_BINDING_MISSING: ${bindingPath}`);
    }
    return resolved.value;
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, child]) => [
      key,
      rehydrateReplayValue(child, currentInput, allowedPaths),
    ]),
  );
}

function replayIdentityCandidate(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{64}$/i.test(value)
    || value.startsWith('managed-node-submission:')
    || value.startsWith('candidate-set:')
    || value.startsWith('workplace/')
    || value.startsWith('product:')
    || value.length >= 32;
}

/**
 * Compatibility rebind for metadata captured before marker templating was
 * extended beyond typed products. The mapping is exact and conservative: only
 * identity-like primitive values that occur at exactly one captured input path
 * are replaced with the value at that same path in the CURRENT input.
 */
function rebindCapturedIdentityValues(
  value: unknown,
  bindings: readonly ReplayInputBinding[],
  currentInput: unknown,
): unknown {
  const candidates = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!replayIdentityCandidate(binding.value)) continue;
    const key = `${typeof binding.value}:${String(binding.value)}`;
    const paths = candidates.get(key) ?? [];
    paths.push(binding.path);
    candidates.set(key, paths);
  }

  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (!replayIdentityCandidate(item)) return item;
      const paths = candidates.get(`${typeof item}:${String(item)}`) ?? [];
      if (paths.length !== 1) return item;
      const resolved = readPath(currentInput, paths[0]!);
      if (!resolved.found) {
        throw new Error(`CAPSULE_REPLAY_INPUT_BINDING_MISSING: ${paths[0]}`);
      }
      return resolved.value;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, visit(child)]),
    );
  };
  return visit(value);
}

function readPath(root: unknown, replayPath: string): { found: boolean; value: unknown } {
  if (replayPath === '$') return { found: true, value: root };
  if (!replayPath.startsWith('$')) return { found: false, value: undefined };
  const tokens: Array<string | number> = [];
  const suffix = replayPath.slice(1);
  const pattern = /\.([^.[\]]+)|\[(\d+)\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(suffix)) !== null) {
    if (match.index !== consumed) return { found: false, value: undefined };
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
    consumed = pattern.lastIndex;
  }
  if (consumed !== suffix.length) return { found: false, value: undefined };

  let current = root;
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Array.isArray(current) || token >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[token];
    } else {
      if (!current || typeof current !== 'object' || Array.isArray(current)
          || !Object.hasOwn(current as object, token)) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[token];
    }
  }
  return { found: true, value: current };
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolveCurrentTaskFromCapturedGenerationKey(
  db: Database.Database,
  projectId: number,
  capturedGenerationKey: string,
): number | null {
  // Same-run replay/debug may still resolve the exact key directly.
  const exact = db.prepare(
    `SELECT t.id
       FROM tasks t JOIN epics e ON e.id=t.epic_id
      WHERE e.project_id=? AND t.generation_key=?
      ORDER BY t.id DESC LIMIT 1`,
  ).get(projectId, capturedGenerationKey) as { id: number } | undefined;
  if (exact) return exact.id;

  const role = capturedGenerationKey.endsWith(':author')
    ? 'author'
    : capturedGenerationKey.endsWith(':reviewer') ? 'reviewer' : null;
  if (!role) return null;
  const workplaceString = capturedGenerationKey.slice(0, -(role.length + 1));
  let oldRef;
  try {
    oldRef = deserializeWorkplaceRef(workplaceString);
  } catch {
    return null;
  }

  // Cross-run semantic task identity excludes old processRunId but retains the
  // module/cell/workKey/role that define the same materialized work item.
  const current = db.prepare(
    `SELECT t.id
       FROM tasks t JOIN epics e ON e.id=t.epic_id
      WHERE e.project_id=?
        AND json_extract(t.metadata,'$.process_module_ref')=?
        AND json_extract(t.metadata,'$.production_cell_id')=?
        AND json_extract(t.metadata,'$.work_key')=?
        AND json_extract(t.metadata,'$.role')=?
      ORDER BY t.id DESC LIMIT 1`,
  ).get(
    projectId,
    oldRef.moduleRef,
    oldRef.productionCellId,
    oldRef.workKey,
    role,
  ) as { id: number } | undefined;
  return current?.id ?? null;
}

function resolveExistingArtifactId(
  db: Database.Database,
  projectId: number,
  selector: ReplayArtifactSelector,
): number | null {
  const row = db.prepare(
    `SELECT id
       FROM artifacts
      WHERE project_id=?
        AND type=?
        AND COALESCE(code,'')=COALESCE(?,'')
        AND title=?
        AND path=?
        AND (? IS NULL OR content_hash=?)
      ORDER BY id DESC LIMIT 1`,
  ).get(
    projectId,
    selector.type,
    selector.code,
    selector.title,
    selector.path,
    selector.contentHash,
    selector.contentHash,
  ) as { id: number } | undefined;
  return row?.id ?? null;
}

function materializeArtifactFile(
  db: Database.Database,
  artifact: ReplayArtifactProduct,
  fallbackRoot: string,
): void {
  if (!artifact.file) return;
  if (path.isAbsolute(artifact.selector.path)) {
    throw new Error(
      `CAPSULE_REPLAY_ARTIFACT_PATH_ABSOLUTE: '${artifact.selector.path}' must be workspace-relative`,
    );
  }

  let root = path.resolve(fallbackRoot);
  if (artifact.projectRepositoryId !== null) {
    const repository = db.prepare(
      `SELECT COALESCE(rc.local_path,pr.local_path) AS local_path
         FROM project_repositories pr
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE pr.id=?`,
    ).get(artifact.projectRepositoryId) as { local_path: string | null } | undefined;
    if (!repository?.local_path) {
      throw new Error(
        `CAPSULE_REPLAY_ARTIFACT_REPOSITORY_MISSING: ${artifact.projectRepositoryId}`,
      );
    }
    root = path.resolve(repository.local_path);
  }

  const artifactPath = path.resolve(root, artifact.selector.path);
  const relative = path.relative(root, artifactPath);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(
      `CAPSULE_REPLAY_ARTIFACT_PATH_ESCAPE: '${artifact.selector.path}' escapes '${root}'`,
    );
  }

  const bytes = Buffer.from(artifact.file.bytes, 'base64');
  if (artifact.selector.contentHash) {
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.selector.contentHash) {
      throw new Error(`CAPSULE_REPLAY_ARTIFACT_HASH_MISMATCH: ${selectorKey(artifact.selector)}`);
    }
  }
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, bytes);
}

function applyGitRecipe(
  recipe: NonNullable<ReplayCapsulePayload['git']>,
  cwd: string,
): string {
  const worktreePath = path.resolve(cwd);
  const currentHead = gitExec(worktreePath, ['rev-parse', 'HEAD']);
  if (currentHead !== recipe.baseCommit) {
    throw new Error(
      `CAPSULE_REPLAY_GIT_BASE_MISMATCH: worktree HEAD ${currentHead.slice(0, 12)} `
      + `!= expected base ${recipe.baseCommit.slice(0, 12)}`,
    );
  }
  if (gitExec(worktreePath, ['status', '--porcelain'])) {
    throw new Error('CAPSULE_REPLAY_GIT_WORKTREE_DIRTY');
  }

  const patchBytes = Buffer.from(recipe.patchBase64, 'base64');
  let mutated = false;
  try {
    execFileSync('git', ['-C', worktreePath, 'apply', '--whitespace=nowarn'], {
      input: patchBytes,
      encoding: 'utf8',
      timeout: 30_000,
    });
    mutated = true;
    gitExec(worktreePath, ['add', '-A']);
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: recipe.commit.authorName,
      GIT_AUTHOR_EMAIL: recipe.commit.authorEmail,
      GIT_AUTHOR_DATE: recipe.commit.authorDate,
      GIT_COMMITTER_NAME: recipe.commit.committerName,
      GIT_COMMITTER_EMAIL: recipe.commit.committerEmail,
      GIT_COMMITTER_DATE: recipe.commit.committerDate,
    };
    execFileSync(
      'git',
      ['-C', worktreePath, 'commit', '--allow-empty', '-m', recipe.commit.message],
      { encoding: 'utf8', timeout: 30_000, env: commitEnv },
    );
    const actualTree = gitExec(worktreePath, ['rev-parse', 'HEAD^{tree}']);
    if (actualTree !== recipe.sourceTree) {
      throw new Error(
        `CAPSULE_REPLAY_GIT_TREE_MISMATCH: produced tree ${actualTree.slice(0, 12)} `
        + `!= expected ${recipe.sourceTree.slice(0, 12)}`,
      );
    }
    return gitExec(worktreePath, ['rev-parse', 'HEAD']);
  } catch (error) {
    if (mutated) {
      try { gitExec(worktreePath, ['reset', '--hard', recipe.baseCommit]); } catch { /* preserve original */ }
      try { gitExec(worktreePath, ['clean', '-fd']); } catch { /* preserve original */ }
    }
    if (error instanceof Error && error.message.startsWith('CAPSULE_REPLAY_')) throw error;
    throw new Error(`CAPSULE_REPLAY_GIT_FAILED: ${errorMessage(error)}`);
  }
}

function gitExec(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readFrozenCapsuleRef(
  db: Database.Database,
  executionId: string,
): string | null {
  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(executionId) as { metadata: string } | undefined;
  if (!row) return null;
  try {
    const envelope = JSON.parse(row.metadata) as {
      execution_context?: { replay?: { capsule_ref?: string | null } };
    };
    const ref = envelope.execution_context?.replay?.capsule_ref;
    return typeof ref === 'string' && ref ? ref : null;
  } catch {
    return null;
  }
}

export function replayPayloadDigest(payload: unknown): string {
  return sha256Hex(payload);
}
