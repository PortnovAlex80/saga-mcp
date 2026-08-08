/**
 * In-process ReplayCapsule executor (CONVEYOR v4.3 PART 2).
 *
 * This is the ONE normal WorkerExecution production source for replay. It is
 * NOT an executor mode and NOT a simulator. When `execution_context.replay
 * .capsule_ref` is non-null, the normal WorkerExecutor resolves the production
 * source internally and runs this adapter instead of invoking the selected
 * inference model.
 *
 * The adapter reconstructs accepted worker production from a frozen capsule
 * through the SAME normal MCP/tool handler boundary a real worker uses:
 *
 *   1. Reads the capsule payload from factory_replay_capsules.
 *   2. For artifacts: recreates artifact files + calls artifact_create.
 *   3. For traces: resolves source/target via semantic selectors, calls trace_add.
 *   4. For Git: applies the recorded patch to the RepositoryDesk worktree,
 *      recreates the commit with recorded metadata, verifies expected tree.
 *   5. For typed products: calls product_submit with the preserved payload.
 *
 * The normal Production Cell then seals the CandidateSet, the current GateRun
 * runs, and the current GateDecision decides acceptance — exactly as if a real
 * LLM had produced the work. The adapter operates under the exact frozen
 * WorkerExecution authority and cannot create CandidateSets, run Gates, change
 * Workplaces, advance lifecycle, or write acceptance state.
 *
 * Exactness rule: replay is all-or-nothing. Missing semantic references,
 * unsafe artifact paths, unresolved parents/trace targets, corrupt payloads or
 * Git mismatches fail the WorkerExecution. A certified capsule is never
 * "partially" replayed by silently dropping evidence.
 */
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ReplayCapsulePayload,
  ReplayArtifactSelector,
  ReplayArtifactProduct,
} from '../../replay/replay-capsule.js';
import { sha256Hex } from '../../shared/canonical-json.js';

/** Minimal handler-shape mirror of the normal MCP tool handler containers. */
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
}

export interface CapsuleReplayContext {
  taskId: number;
  workerId: string;
  executionId: string;
  /** The cwd the worker would have run in (RepositoryDesk/workspace root). */
  cwd: string;
}

export interface CapsuleReplayOutcome {
  readonly productsSubmitted: number;
  readonly artifactsRecreated: number;
  readonly tracesRecreated: number;
  readonly gitCommit?: string;
}

function selectorKey(selector: ReplayArtifactSelector): string {
  return `${selector.type}::${selector.code ?? ''}::${selector.title}::${selector.path}`;
}

/** Execute generic capsule replay through the normal production surface. */
export function executeCapsuleReplay(
  db: Database.Database,
  handlers: CapsuleReplayHandlers,
  context: CapsuleReplayContext,
): CapsuleReplayOutcome {
  const execRow = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(context.executionId) as { metadata: string } | undefined;
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
  const replayBinding = envelope?.execution_context?.replay;
  const capsuleRef = replayBinding?.capsule_ref;
  if (!capsuleRef) {
    throw new Error(
      'CAPSULE_REPLAY_NO_CAPSULE_REF: execution_context.replay.capsule_ref is null',
    );
  }

  const capsuleRow = db.prepare(
    'SELECT payload_snapshot,payload_hash FROM factory_replay_capsules WHERE capsule_ref=?',
  ).get(capsuleRef) as { payload_snapshot: string; payload_hash: string } | undefined;
  if (!capsuleRow) {
    throw new Error(`CAPSULE_REPLAY_CAPSULE_NOT_FOUND: ${capsuleRef}`);
  }

  const payload = JSON.parse(capsuleRow.payload_snapshot) as ReplayCapsulePayload;
  const computedHash = sha256Hex(payload);
  if (capsuleRow.payload_hash !== computedHash) {
    throw new Error(
      `CAPSULE_REPLAY_HASH_MISMATCH: capsule ${capsuleRef} payload hash mismatch — corruption detected`,
    );
  }
  if (
    replayBinding?.capsule_payload_hash
    && replayBinding.capsule_payload_hash !== capsuleRow.payload_hash
  ) {
    throw new Error(
      `CAPSULE_REPLAY_FROZEN_HASH_MISMATCH: execution froze ${replayBinding.capsule_payload_hash} `
      + `but capsule ${capsuleRef} now resolves to ${capsuleRow.payload_hash}`,
    );
  }

  const artifactIdBySelector = new Map<string, number>();

  // 1. Recreate artifacts. Ordering is part of the capsule recipe: a declared
  // parent must already have been materialized, otherwise the recipe is invalid.
  for (const artifact of payload.artifacts ?? []) {
    const key = selectorKey(artifact.selector);
    const parentArtifactId = artifact.parent
      ? artifactIdBySelector.get(selectorKey(artifact.parent))
      : undefined;
    if (artifact.parent && parentArtifactId === undefined) {
      throw new Error(
        `CAPSULE_REPLAY_PARENT_ARTIFACT_MISSING: ${key} references `
        + `${selectorKey(artifact.parent)} before it was materialized`,
      );
    }

    materializeArtifactFile(artifact, context.cwd);
    try {
      const result = handlers.artifact_create({
        type: artifact.selector.type,
        code: artifact.selector.code ?? undefined,
        title: artifact.selector.title,
        path: artifact.selector.path,
        status: artifact.status,
        tags: artifact.tags,
        metadata: artifact.metadata,
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
        `CAPSULE_REPLAY_ARTIFACT_FAILED: ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // 2. Recreate traces. A trace is accepted evidence; silently skipping a
  // missing source/target would create a different CandidateSet than certified.
  let tracesRecreated = 0;
  for (const trace of payload.traces ?? []) {
    const sourceKey = selectorKey(trace.source);
    const sourceId = artifactIdBySelector.get(sourceKey);
    if (!sourceId) {
      throw new Error(`CAPSULE_REPLAY_TRACE_SOURCE_MISSING: ${sourceKey}`);
    }

    let targetId: number | undefined;
    if (trace.targetType === 'artifact') {
      if (!trace.targetArtifact) {
        throw new Error('CAPSULE_REPLAY_TRACE_TARGET_MISSING: artifact trace has no target selector');
      }
      const targetKey = selectorKey(trace.targetArtifact);
      targetId = artifactIdBySelector.get(targetKey);
      if (!targetId) {
        throw new Error(`CAPSULE_REPLAY_TRACE_TARGET_MISSING: ${targetKey}`);
      }
    } else if (trace.targetType === 'task') {
      if (!trace.targetTaskGenerationKey) {
        throw new Error('CAPSULE_REPLAY_TRACE_TARGET_MISSING: task trace has no generation key');
      }
      const taskRow = db.prepare(
        `SELECT id FROM tasks
          WHERE generation_key=?
          ORDER BY id DESC LIMIT 1`,
      ).get(trace.targetTaskGenerationKey) as { id: number } | undefined;
      targetId = taskRow?.id;
      if (!targetId) {
        throw new Error(
          `CAPSULE_REPLAY_TRACE_TARGET_MISSING: task generation_key=${trace.targetTaskGenerationKey}`,
        );
      }
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
      throw new Error(
        `CAPSULE_REPLAY_TRACE_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // 3. Git recipe: apply patch to the RepositoryDesk worktree BEFORE products,
  // so worker completion sees the committed source.
  let gitCommit: string | undefined;
  if (payload.git) {
    gitCommit = applyGitRecipe(payload.git, context.cwd);
  }

  // 4. Submit typed products through the normal product_submit handler.
  let productsSubmitted = 0;
  for (const product of payload.typedProducts ?? []) {
    if (sha256Hex(product.content) !== product.contentHash) {
      throw new Error(
        `CAPSULE_REPLAY_PRODUCT_HASH_MISMATCH: schema=${product.schema}`,
      );
    }
    try {
      handlers.product_submit({ schema: product.schema, content: product.content });
      productsSubmitted += 1;
    } catch (error) {
      throw new Error(
        `CAPSULE_REPLAY_PRODUCT_FAILED schema=${product.schema}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

function materializeArtifactFile(
  artifact: ReplayArtifactProduct,
  cwd: string,
): void {
  if (!artifact.file) return;
  if (path.isAbsolute(artifact.selector.path)) {
    throw new Error(
      `CAPSULE_REPLAY_ARTIFACT_PATH_ABSOLUTE: '${artifact.selector.path}' must be workspace-relative`,
    );
  }

  const root = path.resolve(cwd);
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
      throw new Error(
        `CAPSULE_REPLAY_ARTIFACT_HASH_MISMATCH: ${selectorKey(artifact.selector)}`,
      );
    }
  }
  const dir = path.dirname(artifactPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
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
  const dirty = gitExec(worktreePath, ['status', '--porcelain']);
  if (dirty) {
    throw new Error('CAPSULE_REPLAY_GIT_WORKTREE_DIRTY: factory RepositoryDesk must be clean before replay');
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
      try { gitExec(worktreePath, ['reset', '--hard', recipe.baseCommit]); } catch { /* preserve original error */ }
      try { gitExec(worktreePath, ['clean', '-fd']); } catch { /* preserve original error */ }
    }
    if (error instanceof Error && error.message.startsWith('CAPSULE_REPLAY_')) throw error;
    throw new Error(
      `CAPSULE_REPLAY_GIT_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function gitExec(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

/** Resolve the replay capsule_ref frozen on a worker execution, if any. */
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
    const ref = envelope?.execution_context?.replay?.capsule_ref;
    return typeof ref === 'string' && ref ? ref : null;
  } catch {
    return null;
  }
}

/** Stable digest helper for tests/diagnostics. */
export function replayPayloadDigest(payload: unknown): string {
  return sha256Hex(payload);
}
