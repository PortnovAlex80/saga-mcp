import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function parseClaudeArgv(argv) {
  const flagsWithValue = new Set([
    '--mcp-config', '--model', '--output-format', '--permission-mode',
    '--append-system-prompt', '--allowedTools', '--disallowedTools',
    '--max-turns', '--max-budget-usd', '--fallback-model',
    '--settings', '--effort',
  ]);
  let mcpConfigPath = null;
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (flagsWithValue.has(value)) {
      const next = argv[i + 1];
      if (value === '--mcp-config') mcpConfigPath = next ?? null;
      i += 1;
      continue;
    }
    if (value.startsWith('--') && value.includes('=')) {
      if (value.startsWith('--mcp-config=')) mcpConfigPath = value.slice('--mcp-config='.length);
      continue;
    }
    if (value.startsWith('-')) continue;
    positionals.push(value);
  }
  return { mcpConfigPath, prompt: positionals.at(-1) ?? '' };
}

export function parseSagaPrompt(prompt) {
  const values = {};
  for (const line of String(prompt).split('\n')) {
    if (line === 'Hard rules:') break;
    const match = /^([a-z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  for (const key of ['project_id', 'task_id']) {
    if (values[key] !== undefined) values[key] = Number(values[key]);
  }
  return values;
}

export function resolveDbPath(mcpConfigPath, env = process.env) {
  if (mcpConfigPath && existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      const configured = config?.mcpServers?.saga?.env?.DB_PATH;
      if (typeof configured === 'string' && configured.length > 0) return configured;
    } catch { /* inherited env remains the fallback */ }
  }
  return env.DB_PATH || null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveTemplatePath(path, vars) {
  const resolved = path.split('.').reduce((current, part) => current?.[part], vars);
  if (resolved === undefined || resolved === null) {
    throw new Error(`SIMULATOR_TEMPLATE_VALUE_MISSING: ${path}`);
  }
  return resolved;
}

export function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-zA-Z0-9_.-]+)\}\}$/.exec(value);
    if (exact) return resolveTemplatePath(exact[1], vars);
    return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, path) =>
      String(resolveTemplatePath(path, vars)));
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, renderTemplate(item, vars)]));
  }
  return value;
}

export function createStreamEmitter(output = process.stdout) {
  const sessionId = `sim-${process.pid}-${Date.now()}`;
  const emit = event => output.write(`${JSON.stringify(event)}\n`);
  return {
    sessionId,
    init(model = 'saga-deterministic-simulator') {
      emit({
        type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
        tools: ['mcp__saga__worker_done', 'mcp__saga__artifact_create',
          'mcp__saga__artifact_update', 'mcp__saga__trace_add',
          'mcp__saga__verification_record', 'mcp__saga__worker_merge_acquire',
          'mcp__saga__worker_merge_release'],
        mcp_servers: [{ name: 'saga', status: 'connected' }],
        model, permissionMode: 'bypassPermissions',
      });
    },
    text(text) {
      emit({
        type: 'assistant',
        message: {
          id: `msg_sim_${Date.now()}`, type: 'message', role: 'assistant',
          model: 'saga-deterministic-simulator',
          content: [{ type: 'text', text }], stop_reason: 'end_turn',
          stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null, session_id: sessionId,
        uuid: `uuid_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
      });
    },
    result({ durationMs, success, summary, error = null }) {
      emit({
        type: 'result', subtype: success ? 'success' : 'error', is_error: !success,
        api_error_status: null, duration_ms: durationMs, duration_api_ms: durationMs,
        ttft_ms: 1, num_turns: 1, result: summary,
        stop_reason: success ? 'end_turn' : 'error', session_id: sessionId,
        total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
        model: 'saga-deterministic-simulator', permission_denials: [],
        terminal_reason: success ? 'completed' : 'failed', error,
        uuid: `uuid_sim_result_${Date.now()}`,
      });
    },
  };
}

export function heartbeat(ctx, event, message = '') {
  const line = [new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    `pid=${process.pid}`, `worker=${ctx.worker_id ?? 'unknown'}`,
    `project=${ctx.project_id ?? 'unknown'}`, `task=${ctx.task_id ?? 'unknown'}`,
    event, message].join(' ').replace(/\s+/g, ' ').trim();
  try {
    const target = join(homedir(), '.zcode', 'cli', 'worker-heartbeat.log');
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}\n`);
  } catch { /* observability is non-authoritative */ }
}

export async function loadSagaRuntime(dbPath) {
  process.env.DB_PATH = dbPath;
  // The runner sets SAGA_MANAGED_EXECUTION=1 + SAGA_EXECUTION_ID in the MCP
  // server's env (mcpServers.saga.env). When the real Claude CLI spawns the
  // saga MCP server, those env vars are present. The simulator calls handlers
  // in-process (no MCP subprocess), so it must set them itself — otherwise
  // resolveManagedExecutionProvenance returns null and artifact_create
  // falls back to executionRef='system' → STALE_EXECUTION_CANNOT_SUBMIT.
  // enrichContext (called later) sets the per-task SAGA_EXECUTION_ID.
  process.env.SAGA_MANAGED_EXECUTION = '1';
  const dbModule = await import('../../dist/db.js');
  if (typeof dbModule.closeDb === 'function') {
    try { dbModule.closeDb(); } catch { /* no cached connection */ }
  }
  const [dispatcher, lifecycle, artifacts, products] = await Promise.all([
    import('../../dist/tools/dispatcher.js'),
    import('../../dist/tools/lifecycle.js'),
    import('../../dist/tools/artifacts.js'),
    import('../../dist/tools/products.js'),
  ]);
  // The factory runtime was refactored to a universal product desk:
  // module-specific submit tools (proposal_submit, readiness_submit,
  // process_node_submit, etc.) were replaced by the single `product_submit`
  // MCP tool. Discovery, Formalization and Development cells all publish
  // through it. The old module handler imports are intentionally removed.
  return { dbModule, dispatcher, lifecycle, artifacts, products };
}

export function enrichContext(runtime, promptContext) {
  const db = runtime.dbModule.getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(promptContext.task_id);
  if (!task) throw new Error(`SIMULATOR_TASK_NOT_FOUND: ${promptContext.task_id}`);
  let metadata = {};
  try { metadata = JSON.parse(task.metadata || '{}'); } catch { metadata = {}; }
  const attemptRow = promptContext.execution_id
    ? db.prepare(`SELECT COUNT(*) AS n FROM worker_executions
        WHERE task_id=? AND reserved_at <= (
          SELECT reserved_at FROM worker_executions WHERE execution_id=?)`)
      .get(task.id, promptContext.execution_id)
    : { n: 1 };
  return {
    ...promptContext, task, metadata, epic_id: task.epic_id,
    task_kind: task.task_kind || promptContext.task_kind || 'unbound',
    execution_mode: task.execution_mode || promptContext.execution_mode || 'tracker_only',
    process_run_id: metadata.process_run_id ?? null,
    process_module_ref: metadata.process_module_ref ?? promptContext.process_module_ref ?? null,
    process_node_id: metadata.process_node_id ?? null,
    attempt: Math.max(1, Number(attemptRow?.n ?? 1)),
    role: task.status === 'review' || task.status === 'review_in_progress'
      ? 'reviewer' : (promptContext.role || 'author'),
    isRetry: !!(metadata.recovery_feedback || metadata.process_node_input?.schema === 'factory.recovery-feedback.v1'),
  };
}

/**
 * Set the per-task execution env vars that handlers (artifact_create,
 * trace_add, worker_done, product_submit, etc.) read via
 * resolveManagedExecutionProvenance. The runner would set these in the
 * MCP server subprocess env; the simulator calls handlers in-process so
 * it must set them itself.
 */
export function setExecutionEnv(ctx) {
  process.env.SAGA_MANAGED_EXECUTION = '1';
  process.env.SAGA_EXECUTION_ID = ctx.execution_id || ctx.task?.current_execution_id || '';
  process.env.SAGA_TASK_ID = String(ctx.task_id ?? ctx.task?.id ?? '');
  process.env.SAGA_WORKER_ID = ctx.worker_id || '';
}

function findArtifact(db, epicId, type, code = null) {
  return code
    ? db.prepare(`SELECT * FROM artifacts WHERE epic_id=? AND type=? AND code=?
        ORDER BY id DESC LIMIT 1`).get(epicId, type, code)
    : db.prepare(`SELECT * FROM artifacts WHERE epic_id=? AND type=?
        ORDER BY id DESC LIMIT 1`).get(epicId, type);
}

function requireHandler(container, name) {
  const value = container?.handlers?.[name];
  if (typeof value !== 'function') throw new Error(`SIMULATOR_HANDLER_MISSING: ${name}`);
  return value;
}

function writeWorkspaceFile(ctx, relativePath, content) {
  const root = ctx.workspace_root && ctx.workspace_root !== 'undefined'
    ? ctx.workspace_root : process.cwd();
  const target = isAbsolute(relativePath) ? relativePath : resolve(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function integrateGitTask(runtime, ctx, stream) {
  const acquire = requireHandler(runtime.dispatcher, 'worker_merge_acquire');
  const release = requireHandler(runtime.dispatcher, 'worker_merge_release');
  const execution = ctx.execution_id ? { execution_id: ctx.execution_id } : {};
  acquire({ task_id: ctx.task_id, worker_id: ctx.worker_id, ...execution });

  const db = runtime.dbModule.getDb();
  const row = db.prepare(`SELECT t.metadata, pr.local_path, pr.integration_branch
      FROM tasks t LEFT JOIN project_repositories pr ON pr.id=t.project_repository_id
      WHERE t.id=?`).get(ctx.task_id);
  let metadata = {};
  try { metadata = JSON.parse(row?.metadata || '{}'); } catch { metadata = {}; }
  const repositoryPath = row?.local_path || ctx.workspace_root || process.cwd();
  const branch = metadata?.worktree?.branch || `task/${ctx.task_id}`;

  const commit = spawnSync('git', ['-C', repositoryPath, 'commit', '--allow-empty',
    '-m', `simulator: complete task #${ctx.task_id}`], { encoding: 'utf8' });
  if (commit.status !== 0) {
    stream.text(`simulator: empty commit skipped: ${(commit.stderr || '').slice(0, 160)}`);
  }
  const merge = spawnSync('git', ['-C', repositoryPath, 'merge', '--no-ff',
    '-m', `simulator: merge task #${ctx.task_id}`, branch], { encoding: 'utf8' });
  if (merge.status !== 0) {
    spawnSync('git', ['-C', repositoryPath, 'merge', '--abort'], { encoding: 'utf8' });
    release({ task_id: ctx.task_id, worker_id: ctx.worker_id, result: 'conflict', ...execution });
    throw new Error(`SIMULATOR_GIT_MERGE_CONFLICT: task ${ctx.task_id}`);
  }
  const revision = spawnSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' });
  const commitSha = revision.status === 0 ? revision.stdout.trim() : null;
  release({ task_id: ctx.task_id, worker_id: ctx.worker_id, result: 'merged',
    commit_sha: commitSha, ...execution });
  stream.text(`simulator: merged ${branch} into ${row?.integration_branch || 'integration branch'}`);
}

export async function executeSteps(runtime, ctx, scenario, stream) {
  const db = runtime.dbModule.getDb();
  const vars = { ctx, aliases: {}, env: process.env };
  for (const rawStep of scenario.steps) {
    const step = renderTemplate(rawStep, vars);
    switch (step.type) {
      case 'emit': stream.text(step.text); break;
      case 'sleep': await new Promise(done => setTimeout(done, step.ms)); break;
      case 'write_file': {
        const target = writeWorkspaceFile(ctx, step.path, step.content);
        vars.aliases[step.as || 'last_file'] = target;
        stream.text(`simulator: wrote ${target}`);
        break;
      }
      case 'artifact_create': {
        const args = { ...step.args };
        if (step.content !== undefined) {
          const target = writeWorkspaceFile(ctx, args.path, step.content);
          args.content_hash = sha256(step.content);
          vars.aliases[`${step.as || args.type}_path`] = target;
        }
        const result = requireHandler(runtime.artifacts, 'artifact_create')(args);
        const returnedId = result?.id ?? result?.artifact?.id ?? result?.artifact_id;
        const row = Number.isInteger(returnedId)
          ? { id: returnedId }
          : findArtifact(db, args.epic_id, args.type, args.code ?? null);
        if (!row) throw new Error(`SIMULATOR_ARTIFACT_CREATE_UNRESOLVED: ${args.type}`);
        vars.aliases[step.as] = row.id;
        stream.text(`simulator: created ${args.type} #${row.id}`);
        break;
      }
      case 'artifact_find': {
        const row = findArtifact(db, ctx.epic_id, step.artifactType, step.code ?? null);
        if (!row) throw new Error(`SIMULATOR_ARTIFACT_NOT_FOUND: ${step.artifactType}/${step.code ?? '*'}`);
        vars.aliases[step.as] = row.id;
        break;
      }
      case 'artifact_find_optional': {
        // Find artifact but don't throw if missing. Sets alias to the row id
        // or null. Used for idempotent retries: if the artifact already exists
        // (from a previous author run), skip re-creating it.
        const row = findArtifact(db, ctx.epic_id, step.artifactType, step.code ?? null);
        vars.aliases[step.as] = row?.id ?? null;
        if (row) stream.text(`simulator: found existing ${step.artifactType} #${row.id}`);
        break;
      }
      case 'skip_if': {
        // Conditional skip: if the alias referenced by 'check' is non-null
        // (artifact already exists), skip the next N steps.
        const value = vars.aliases[step.check];
        if (value !== null && value !== undefined) {
          // Skip the next step.skipCount steps by advancing the loop index.
          // We can't modify the for-of index directly, so use a sentinel.
          vars.aliases.__skip_count = step.skipCount || 1;
          stream.text(`simulator: skip ${step.skipCount || 1} step(s) — ${step.check} exists`);
        }
        break;
      }
      case 'trace_add':
        requireHandler(runtime.artifacts, 'trace_add')(step.args);
        stream.text(`simulator: trace ${step.args.source_id} -> ${step.args.target_id}`);
        break;
      case 'verification_record':
        requireHandler(runtime.lifecycle, 'verification_record')(step.args);
        stream.text('simulator: verification evidence recorded');
        break;
      case 'product_submit': {
        // Universal product desk. The handler derives ProcessRun / module /
        // node / intent / task / execution lineage from the live fence, so we
        // only pass { schema, content }. The same desk replaces the former
        // module-specific proposal_submit / readiness_submit / process_node_submit
        // tools (the old handlers were removed in the product-desk refactor).
        const submit = requireHandler(runtime.products, 'product_submit');
        const result = submit(step.args);
        stream.text(`simulator: product_submit schema=${step.args.schema} ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'process_node_submit': {
        // Legacy alias kept for scenario readability — route through the
        // universal product desk. { schema, payload } is mapped to
        // { schema, content }.
        const submit = requireHandler(runtime.products, 'product_submit');
        const result = submit({ schema: step.args.schema, content: step.args.payload });
        stream.text(`simulator: product_submit schema=${step.args.schema} ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'development_implementation_submit': {
        const item = ctx.metadata?.cell_input_item;
        if (!item?.key) throw new Error('SIMULATOR_DEVELOPMENT_ITEM_MISSING');
        const repository = db.prepare(
          `SELECT pr.id,pr.local_path,pr.integration_branch
             FROM tasks t JOIN project_repositories pr ON pr.id=t.project_repository_id
            WHERE t.id=?`,
        ).get(ctx.task_id);
        if (!repository?.local_path || !ctx.workspace_root) throw new Error('SIMULATOR_REPOSITORY_MISSING');
        const simulatorBranch = `sim/task/${ctx.task_id}`;
        const branchCreate = spawnSync('git', ['-C', ctx.workspace_root, 'checkout',
          '-b', simulatorBranch, repository.integration_branch], { encoding: 'utf8' });
        if (branchCreate.status !== 0) throw new Error(`SIMULATOR_TASK_BRANCH_FAILED: ${branchCreate.stderr}`);
        spawnSync('git', ['-C', ctx.workspace_root, 'add', '-A'], { encoding: 'utf8' });
        const committed = spawnSync('git', ['-C', ctx.workspace_root, 'commit',
          '-m', `simulator: implement task #${ctx.task_id}`], { encoding: 'utf8' });
        if (committed.status !== 0) throw new Error(`SIMULATOR_IMPLEMENTATION_COMMIT_FAILED: ${committed.stderr}`);
        const commit = spawnSync('git', ['-C', ctx.workspace_root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        const tree = spawnSync('git', ['-C', ctx.workspace_root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' });
        const branch = spawnSync('git', ['-C', ctx.workspace_root, 'branch', '--show-current'], { encoding: 'utf8' });
        if (commit.status !== 0 || tree.status !== 0) throw new Error('SIMULATOR_REPOSITORY_SNAPSHOT_FAILED');
        const htmlDigest = sha256(step.content);
        const payload = {
          schemaVersion: 'factory.development-implementation-result.v1',
          workItemKey: item.key,
          terminalStatus: 'complete',
          source: {
            branch: branch.stdout.trim(),
            commitSha: commit.stdout.trim(),
            workItemKey: item.key,
          },
          snapshot: {
            commitSha: commit.stdout.trim(),
            treeSha: tree.stdout.trim(),
            files: [{ path: 'index.html' }],
          },
          repository: {
            projectRepositoryId: repository.id,
            integrationBranch: repository.integration_branch,
            baseCommit: '',
            name: 'simulator-repository',
          },
          buildProducts: [{ kind: 'text-file', path: 'index.html', digest: htmlDigest }],
          reasonCodes: [],
        };
        const result = requireHandler(runtime.products, 'product_submit')({
          schema: 'factory.development-implementation-result.v1',
          content: payload,
        });
        stream.text(`simulator: implementation product ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'development_review_submit': {
        const task = db.prepare('SELECT workplace_ref FROM tasks WHERE id=?').get(ctx.task_id);
        const author = task?.workplace_ref ? db.prepare(
          `SELECT s.payload_snapshot
             FROM tasks t
             JOIN factory_managed_node_submissions s ON s.task_id=t.id
            WHERE t.workplace_ref=?
              AND s.schema_version='factory.development-implementation-result.v1'
            ORDER BY s.id DESC LIMIT 1`,
        ).get(task.workplace_ref) : null;
        if (!author?.payload_snapshot) throw new Error('SIMULATOR_REVIEW_AUTHOR_PRODUCT_MISSING');
        const product = JSON.parse(author.payload_snapshot);
        const payload = {
          verdict: step.verdict,
          workItemKey: product.workItemKey,
          reviewedCandidate: {
            sourceCommit: product.source.commitSha,
            sourceTree: product.snapshot.treeSha,
          },
          rationale: step.verdict === 'approved'
            ? 'Deterministic review accepted the pinned author product.'
            : 'Injected deterministic correction request.',
        };
        const result = requireHandler(runtime.products, 'product_submit')({
          schema: 'factory.development-review-verdict.v1', content: payload,
        });
        stream.text(`simulator: development review ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'formalization_review_submit': {
        // Formalization reviewer: submit factory.review-verdict.v1 through the
        // universal product desk. The subject is the author CandidateSet ref
        // carried in the task's cell_input_item (upstream bindings).
        const item = ctx.metadata?.cell_input_item;
        stream.text(`simulator: formalization_review cell_input_item keys=${JSON.stringify(Object.keys(item ?? {}))}`);
        // Try multiple shapes: bindings.items[].products[], bindings.candidateSetRef, direct
        let subjectCandidateSetRef = null;
        if (item) {
          if (typeof item.candidateSetRef === 'string') subjectCandidateSetRef = item.candidateSetRef;
          else if (typeof item.candidate_set_ref === 'string') subjectCandidateSetRef = item.candidate_set_ref;
          else if (Array.isArray(item.bindings?.items)) {
            const products = item.bindings.items.flatMap(it => it.products ?? []);
            subjectCandidateSetRef = products[0]?.candidateSetRef ?? products[0]?.candidate_set_ref ?? null;
          }
          if (!subjectCandidateSetRef && typeof item.bindings === 'object') {
            stream.text(`simulator: formalization_review bindings keys=${JSON.stringify(Object.keys(item.bindings))}`);
          }
        }
        if (!subjectCandidateSetRef) {
          // Last resort: query the latest sealed author CandidateSet for this workplace.
          const task = db.prepare('SELECT workplace_ref FROM tasks WHERE id=?').get(ctx.task_id);
          if (task?.workplace_ref) {
            const cs = db.prepare(
              `SELECT candidate_set_ref FROM factory_candidate_sets
                WHERE workplace_ref=? AND role='author'
                ORDER BY sealed_at DESC LIMIT 1`,
            ).get(task.workplace_ref);
            subjectCandidateSetRef = cs?.candidate_set_ref ?? null;
          }
        }
        stream.text(`simulator: formalization_review subject=${subjectCandidateSetRef ?? 'MISSING'}`);
        if (!subjectCandidateSetRef) throw new Error('SIMULATOR_FORMALIZATION_REVIEW_SUBJECT_MISSING');
        const verdict = step.verdict === 'changes_requested' ? 'changes_requested' : 'approved';
        const payload = {
          subject_candidate_set_ref: subjectCandidateSetRef,
          verdict,
          findings: verdict === 'approved'
            ? []
            : [{ artifact: 'pinned-author-product', defect: 'injected deterministic correction request' }],
        };
        const result = requireHandler(runtime.products, 'product_submit')({
          schema: 'factory.review-verdict.v1', content: payload,
        });
        stream.text(`simulator: formalization review verdict=${verdict} ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'development_verification_submit': {
        const item = ctx.metadata?.cell_input_item;
        const criterionId = item?.acceptanceCriterionIds?.[0];
        const criterion = Number.isInteger(criterionId)
          ? db.prepare('SELECT accepted_hash FROM artifacts WHERE id=?').get(criterionId)
          : null;
        const provider = db.prepare(
          `SELECT id,name,version FROM trusted_providers
            WHERE name='saga-deterministic-simulator'
              AND category='deterministic_evidence' AND status='active'
              AND (project_id=? OR project_id IS NULL)
            ORDER BY project_id IS NOT NULL DESC,id LIMIT 1`,
        ).get(ctx.project_id);
        if (!item?.key || !criterion?.accepted_hash || !provider) {
          throw new Error('SIMULATOR_VERIFICATION_LINEAGE_MISSING');
        }
        const candidateHash = findStringProperty(
          ctx.metadata?.process_node_input,
          'candidateHash',
        );
        if (!candidateHash) throw new Error('SIMULATOR_FROZEN_CANDIDATE_MISSING');
        const evidenceBody = {
          item: item.key,
          criterionId,
          acceptedHash: criterion.accepted_hash,
          result: 'passed',
        };
        const payload = {
          schemaVersion: 'factory.candidate-verification-evidence-product.v1',
          verificationItemKey: item.key,
          acceptanceCriterionId: criterionId,
          acceptedCriterionHash: criterion.accepted_hash,
          candidateHash,
          outcome: 'passed',
          evidence: {
            schema: 'factory.deterministic-verification-evidence.v1',
            ref: `simulator-verification:${ctx.execution_id}`,
            hash: sha256(JSON.stringify(evidenceBody)),
          },
          provider: {
            providerId: provider.id,
            name: provider.name,
            version: provider.version,
            category: 'deterministic_evidence',
            trusted: true,
          },
        };
        const result = requireHandler(runtime.products, 'product_submit')({
          schema: payload.schemaVersion,
          content: payload,
        });
        stream.text(`simulator: verification product ref=${result.product_ref?.ref ?? result.submission_id}`);
        break;
      }
      case 'proposal_submit': {
        // Universal product desk. The old discovery-proposal handler validated
        // against the legacy factory_work_intents binding and threw
        // `intent output_schema mismatch` on the new runtime. The product desk
        // derives lineage from the live managed-execution fence instead.
        // Scenario args carry schema_version + payload (legacy shape); map them
        // to the { schema, content } the desk expects.
        const schema = step.args.schema_version;
        const content = step.args.payload;
        const result = requireHandler(runtime.products, 'product_submit')({ schema, content });
        const digest = result?.product_ref?.digest ?? result?.content_hash;
        // Downstream readiness previously echoed proposal_id/proposal_hash from
        // the canonical factory_proposals row. Under the product desk the
        // immutable managed-node submission IS the proposal; the content digest
        // is its identity. Use the submission id as the proposal id surrogate so
        // the readiness payload's proposal_id / proposal_content_hash fields
        // stay stable and self-consistent.
        const proposalSurrogateId = result?.submission_id ?? null;
        if (typeof proposalSurrogateId === 'number') {
          vars.aliases[step.as || 'proposal'] = proposalSurrogateId;
          vars.aliases.proposal_content_hash = digest;
          vars.aliases.readiness_proposal_id = proposalSurrogateId;
          vars.aliases.readiness_proposal_hash = digest;
        }
        stream.text(`simulator: proposal product ref=${result?.product_ref?.ref ?? 'n/a'} replayed=${result?.replayed}`);
        break;
      }
      case 'readiness_get': {
        // The legacy readiness_get tool returned the immutable proposal plus
        // allowed source refs. Under the product desk the proposal content is
        // already known to the deterministic scenario, and source refs are
        // advisory only — the desk validates lineage, not citation. Seed the
        // aliases the subsequent readiness_submit renders against.
        const proposalId = vars.aliases.readiness_proposal_id;
        const proposalHash = vars.aliases.readiness_proposal_hash;
        if (typeof proposalId === 'number') vars.aliases.readiness_proposal_id = proposalId;
        if (typeof proposalHash === 'string') vars.aliases.readiness_proposal_hash = proposalHash;
        vars.aliases.allowed_source_refs = [];
        stream.text(`simulator: readiness_get proposal=${proposalId} hash=${proposalHash?.slice(0, 12) ?? 'n/a'}`);
        break;
      }
      case 'readiness_submit': {
        // Universal product desk. The readiness assessment is submitted as a
        // typed product; the desk validates schema + lineage. The readiness
        // CheckProvider re-validates the assessment against the EXACT accepted
        // proposal (integer submission id + content hash + allowed source refs),
        // so normalize those fields from the proposal ProductRef carried in the
        // readiness task's cell_input_item before submitting. The scenario
        // template renders the proposal ref/digest strings; here we coerce the
        // proposal_id to the integer the gate expects
        // (managed-node-submission:<id> -> <id>).
        const schema = step.args.schema_version;
        const content = { ...step.args.payload };
        const proposalProductRef = ctx.metadata?.cell_input_item?.bindings?.items?.[0]?.products?.[0];
        if (proposalProductRef && proposalProductRef.schemaId === 'factory.discovery-proposal.v1') {
          const refMatch = /^managed-node-submission:(\d+)$/.exec(proposalProductRef.ref);
          if (refMatch) content.proposal_id = Number(refMatch[1]);
          if (typeof proposalProductRef.digest === 'string') {
            content.proposal_content_hash = proposalProductRef.digest;
          }
        }
        const result = requireHandler(runtime.products, 'product_submit')({ schema, content });
        stream.text(`simulator: readiness product ref=${result?.product_ref?.ref ?? 'n/a'} replayed=${result?.replayed}`);
        break;
      }
      case 'worker_done':
        requireHandler(runtime.dispatcher, 'worker_done')(step.args);
        stream.text(`simulator: worker_done task #${step.args.task_id}`);
        break;
      case 'git_integrate':
        integrateGitTask(runtime, ctx, stream);
        break;
      case 'assert': {
        const row = db.prepare(step.sql).get(...(step.params || []));
        if (!row || (step.field && row[step.field] !== step.equals)) {
          throw new Error(`SIMULATOR_ASSERTION_FAILED: ${step.message || step.sql}`);
        }
        break;
      }
      case 'exit_error': throw new Error(step.message || 'SIMULATOR_INJECTED_FAILURE');
      default: throw new Error(`SIMULATOR_STEP_UNSUPPORTED: ${step.type}`);
    }
  }
  return vars;
}

function findStringProperty(value, key, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (typeof value[key] === 'string' && value[key]) return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findStringProperty(child, key, seen);
    if (found) return found;
  }
  return null;
}
