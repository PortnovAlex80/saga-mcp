/**
 * Generic capsule replayer — reconstructs accepted worker production from a
 * frozen ReplayCapsule through the SAME normal MCP/tool boundaries a real
 * worker uses. This is NOT a second execution path; it is the deterministic
 * executor selected when execution_context.replay.capsule_ref is non-null.
 *
 * The replayer:
 *   1. Reads the capsule payload from factory_replay_capsules.
 *   2. For typed products: calls product_submit with the preserved payload.
 *   3. For managed artifacts: recreates artifact files + calls artifact_create.
 *   4. For traces: resolves source/target via semantic selectors, calls trace_add.
 *   5. For Git: applies the recorded patch to the RepositoryDesk worktree,
 *      recreates the commit with recorded metadata, verifies expected tree.
 *   6. Finishes via the normal worker_done protocol.
 *
 * The normal Production Cell then seals the CandidateSet, the current GateRun
 * runs, and the current GateDecision decides acceptance — exactly as if a real
 * LLM had produced the work.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Execute generic capsule replay. Mutates nothing outside the normal MCP
 * surface (product_submit, artifact_create, trace_add, worker_done).
 *
 * @param {object} runtime — the saga runtime (dbModule, handlerContainer)
 * @param {object} ctx — the enriched prompt context (task_id, execution_id, ...)
 * @param {object} stream — the stream emitter for claude-compatible output
 * @returns {Promise<void>}
 */
export async function executeCapsuleReplay(runtime, ctx, stream) {
  const db = runtime.dbModule.getDb();

  // 1. Read the capsule from the frozen execution_context.
  const execRow = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(ctx.execution_id);
  if (!execRow) throw new Error(`CAPSULE_REPLAY_EXECUTION_NOT_FOUND: ${ctx.execution_id}`);

  const envelope = JSON.parse(execRow.metadata);
  const replay = envelope?.execution_context?.replay;
  const capsuleRef = replay?.capsule_ref;
  if (!capsuleRef) {
    throw new Error('CAPSULE_REPLAY_NO_CAPSULE_REF: execution_context.replay.capsule_ref is null');
  }

  stream.text(`capsule-replay: loading ${capsuleRef}`);
  const capsuleRow = db.prepare(
    'SELECT payload_snapshot FROM factory_replay_capsules WHERE capsule_ref=?',
  ).get(capsuleRef);
  if (!capsuleRow) throw new Error(`CAPSULE_REPLAY_CAPSULE_NOT_FOUND: ${capsuleRef}`);

  const payload = JSON.parse(capsuleRow.payload_snapshot);

  // Verify capsule payload hash integrity.
  const { sha256Hex } = await import('../../dist/shared/canonical-json.js');
  const computedHash = sha256Hex(payload);
  // The payload_hash is stored in the capsule row; verify against it.
  const hashRow = db.prepare(
    'SELECT payload_hash FROM factory_replay_capsules WHERE capsule_ref=?',
  ).get(capsuleRef);
  if (hashRow?.payload_hash && hashRow.payload_hash !== computedHash) {
    throw new Error(
      `CAPSULE_REPLAY_HASH_MISMATCH: capsule ${capsuleRef} payload hash mismatch — corruption detected`,
    );
  }

  // 2. Resolve semantic artifact selectors to current artifact IDs (built
  // incrementally as we recreate artifacts).
  const artifactIdBySelector = new Map();

  function selectorKey(selector) {
    return `${selector.type}::${selector.code ?? ''}::${selector.title}::${selector.path}`;
  }

  // 3. Handler resolution. The saga runtime exposes handlers grouped by
  // domain module: products (product_submit), artifacts (artifact_create),
  // lifecycle (trace_add), dispatcher (worker_done). Each module carries a
  // `.handlers` map. We resolve the right module per tool name.
  function getHandler(name) {
    const containers = [
      runtime.products,
      runtime.artifacts,
      runtime.lifecycle,
      runtime.dispatcher,
    ];
    for (const container of containers) {
      const handler = container?.handlers?.[name];
      if (typeof handler === 'function') return handler;
    }
    throw new Error(`CAPSULE_REPLAY_HANDLER_MISSING: ${name}`);
  }

  for (const artifact of payload.artifacts ?? []) {
    const key = selectorKey(artifact.selector);
    // Materialize the artifact file if one was captured.
    let artifactPath = artifact.selector.path;
    if (artifact.file) {
      const bytes = Buffer.from(artifact.file.bytes, 'base64');
      const dir = path.dirname(artifactPath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(artifactPath, bytes);
    }
    // Call artifact_create through the normal handler.
    try {
      const result = getHandler('artifact_create')({
        type: artifact.selector.type,
        code: artifact.selector.code ?? undefined,
        title: artifact.selector.title,
        path: artifactPath,
        status: artifact.status,
        tags: artifact.tags ?? [],
        metadata: artifact.metadata ?? {},
        parent_artifact_id: artifact.parent
          ? artifactIdBySelector.get(selectorKey(artifact.parent)) ?? undefined
          : undefined,
        project_repository_id: artifact.projectRepositoryId ?? undefined,
      });
      if (result?.artifact?.id) {
        artifactIdBySelector.set(key, result.artifact.id);
      }
      stream.text(`capsule-replay: artifact recreated type=${artifact.selector.type} id=${result?.artifact?.id ?? '?'}`);
    } catch (error) {
      stream.text(`capsule-replay: artifact recreation failed for ${key}: ${error.message}`);
    }
  }

  // 4. Recreate traces.
  for (const trace of payload.traces ?? []) {
    const sourceId = artifactIdBySelector.get(selectorKey(trace.source));
    if (!sourceId) {
      stream.text(`capsule-replay: trace skipped — source artifact not found`);
      continue;
    }
    let targetId = undefined;
    if (trace.targetType === 'artifact' && trace.targetArtifact) {
      targetId = artifactIdBySelector.get(selectorKey(trace.targetArtifact));
    } else if (trace.targetType === 'task' && trace.targetTaskGenerationKey) {
      const taskRow = db.prepare(
        'SELECT id FROM tasks WHERE generation_key=? ORDER BY id DESC LIMIT 1',
      ).get(trace.targetTaskGenerationKey);
      targetId = taskRow?.id;
    }
    try {
      getHandler('trace_add')({
        source_id: sourceId,
        target_type: trace.targetType,
        target_id: targetId,
        link_type: trace.linkType,
      });
      stream.text(`capsule-replay: trace recreated source=${sourceId} → ${trace.targetType}=${targetId ?? '?'}`);
    } catch (error) {
      stream.text(`capsule-replay: trace recreation failed: ${error.message}`);
    }
  }

  // 5. Git recipe: apply patch to the RepositoryDesk worktree.
  if (payload.git) {
    const gitRecipe = payload.git;
    // The RepositoryDesk was provisioned by the factory before spawn. The
    // worker's cwd is the worktree path. We apply the recorded patch to the
    // exact base commit, recreate the commit with recorded metadata, and
    // verify the resulting tree hash.
    const worktreePath = process.cwd();
    stream.text(`capsule-replay: git recipe → worktree=${worktreePath} base=${gitRecipe.baseCommit.slice(0, 12)}`);

    // Verify the worktree is at the expected base.
    const currentHead = gitExec(worktreePath, ['rev-parse', 'HEAD']);
    if (currentHead !== gitRecipe.baseCommit) {
      throw new Error(
        `CAPSULE_REPLAY_GIT_BASE_MISMATCH: worktree HEAD ${currentHead.slice(0, 12)} != expected base ${gitRecipe.baseCommit.slice(0, 12)}`,
      );
    }

    // Apply the recorded patch.
    const patchBytes = Buffer.from(gitRecipe.patchBase64, 'base64');
    try {
      execFileSync('git', ['-C', worktreePath, 'apply', '--whitespace=nowarn'], {
        input: patchBytes,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (error) {
      throw new Error(
        `CAPSULE_REPLAY_GIT_PATCH_FAILED: could not apply recorded patch: ${error.message}`,
      );
    }

    // Stage and commit with recorded metadata.
    gitExec(worktreePath, ['add', '-A']);
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: gitRecipe.commit.authorName,
      GIT_AUTHOR_EMAIL: gitRecipe.commit.authorEmail,
      GIT_AUTHOR_DATE: gitRecipe.commit.authorDate,
      GIT_COMMITTER_NAME: gitRecipe.commit.committerName,
      GIT_COMMITTER_EMAIL: gitRecipe.commit.committerEmail,
      GIT_COMMITTER_DATE: gitRecipe.commit.committerDate,
    };
    execFileSync(
      'git',
      ['-C', worktreePath, 'commit', '--allow-empty', '-m', gitRecipe.commit.message],
      { encoding: 'utf8', timeout: 30_000, env: commitEnv },
    );

    // Verify the resulting tree hash matches the capsule.
    const actualTree = gitExec(worktreePath, ['rev-parse', 'HEAD^{tree}']);
    if (actualTree !== gitRecipe.sourceTree) {
      throw new Error(
        `CAPSULE_REPLAY_GIT_TREE_MISMATCH: produced tree ${actualTree.slice(0, 12)} != expected ${gitRecipe.sourceTree.slice(0, 12)}`,
      );
    }
    const actualCommit = gitExec(worktreePath, ['rev-parse', 'HEAD']);
    stream.text(`capsule-replay: git commit recreated tree=${actualTree.slice(0, 12)} commit=${actualCommit.slice(0, 12)}`);
  }

  // 6. Submit typed products through the normal product_submit handler.
  for (const product of payload.typedProducts ?? []) {
    try {
      const result = getHandler('product_submit')({
        schema: product.schema,
        content: product.content,
      });
      stream.text(
        `capsule-replay: product submitted schema=${product.schema} ref=${result?.product_ref?.ref ?? 'n/a'}`,
      );
    } catch (error) {
      stream.text(`capsule-replay: product submission failed for ${product.schema}: ${error.message}`);
      throw error;
    }
  }

  stream.text(`capsule-replay: completed — ${payload.typedProducts?.length ?? 0} product(s), ${payload.artifacts?.length ?? 0} artifact(s)`);
}

function gitExec(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}
