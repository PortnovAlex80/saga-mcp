/**
 * W0-A3 — Characterization: MCP catalog, authority, structured errors.
 *
 * Locks the CURRENT behavior of the MCP gateway so Wave 6 can replace it with
 * module-contributed tools + generic guards without silent regressions. This
 * file ASSERTS CURRENT BEHAVIOR — it is a safety net, not a spec of desired
 * behavior. When Wave 6 changes any of these surfaces, the corresponding
 * assertion must be updated as a visible, reviewed diff.
 *
 * Five characterized areas (W00-A3 task file):
 *   1. Tool catalog `ALL_TOOLS` — flat descriptor array, sorted name set
 *      (Wave 6 compatibility surface), no duplicate names.
 *   2. Authority `authorizeSagaToolCall` — managed deny-not-in-allow /
 *      allow-in-set, legacy non-managed allow, deny decision shapes.
 *   3. Identity guard `assertManagedExecutionIdentity` — marker/exec-id
 *      pairing rules and the AUTHORITY_CONTEXT_INVALID error code.
 *   4. Structured errors `actionableError` + `SAGA3_TOOL_CALL_SHAPES` +
 *      `enrichPayloadErrors` — error shape, parameterized workflow hint
 *      (W13-A5; was a hard-coded Discovery literal), recommended_outcome /
 *      recommended_next_action lists.
 *   5. Error normalization `friendlyError` — SQLite UNIQUE / NOT NULL / FK /
 *      no-such-table mappings.
 *
 * Plan ref: §0.3.4, §11 (MCP Tool Ownership), §13.13.
 *
 * NOTE on access: `ALL_TOOLS`, `friendlyError` are NOT exported from
 * `src/index.ts` (and importing that module runs the MCP server). `ALL_TOOLS`
 * is therefore re-assembled from the SAME 27 descriptor sources in the SAME
 * order as `src/index.ts:81` so the characterization is faithful to the real
 * gateway. `friendlyError` and `assertManagedExecutionIdentity` are pinned via
 * source-text anchors (the pattern used by `saga2-runtime-contracts.test.mjs`)
 * because they are local/unexported; the anchors lock the exact output strings
 * so any change is a visible diff.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

// The saga3 handler factories eagerly initialize SQLite schema against getDb()
// at construction time, so DB_PATH must point at a writable file before they
// are imported. Static ESM imports are hoisted, so we load the DB-bound modules
// dynamically AFTER seeding the env.
let dynamic;
async function loadModules() {
  if (dynamic) return dynamic;
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'saga-w0a3-'));
  process.env.DB_PATH = path.join(tmpDir, 'char.db');
  // Defer cleanup; node:test tears the process down at the end. The tmp dir is
  // under the OS temp root and will be reaped by the OS.
  dynamic = {
    // Catalog sources (same 27 as src/index.ts ALL_TOOLS assembly).
    catalogPromise: import('../../dist/tools/projects.js'),
  };
  // saga4 cutover: src/tools/workflow.ts (generateNextForCompletedTask +
  // workflow_generate_next MCP tool) and the episode_status/episode_transition
  // MCP tools were deleted (commit face6ad). src/index.ts no longer imports a
  // workflow module, so this re-assembly mirrors it by dropping that source.
  const [
    projects, epics, tasks, subtasks, notes, comments, templates, dashboard,
    search, activity, exportImport, dispatcher, artifacts, repositories,
    lifecycle, observations, conflicts, providers, processModules,
    processNodeSubmissions, deliveryApprovals, lifecycleRuns,
    saga3ProposalsMod, saga3NormalizationMod, saga3ReadinessMod,
  ] = await Promise.all([
    import('../../dist/tools/projects.js'),
    import('../../dist/tools/epics.js'),
    import('../../dist/tools/tasks.js'),
    import('../../dist/tools/subtasks.js'),
    import('../../dist/tools/notes.js'),
    import('../../dist/tools/comments.js'),
    import('../../dist/tools/templates.js'),
    import('../../dist/tools/dashboard.js'),
    import('../../dist/tools/search.js'),
    import('../../dist/tools/activity.js'),
    import('../../dist/tools/export-import.js'),
    import('../../dist/tools/dispatcher.js'),
    import('../../dist/tools/artifacts.js'),
    import('../../dist/tools/repositories.js'),
    import('../../dist/tools/lifecycle.js'),
    import('../../dist/tools/observations.js'),
    import('../../dist/tools/conflicts.js'),
    import('../../dist/tools/providers.js'),
    import('../../dist/tools/process-modules.js'),
    import('../../dist/tools/process-node-submissions.js'),
    import('../../dist/tools/delivery-approvals.js'),
    import('../../dist/tools/lifecycle-runs.js'),
    import('../../dist/tools/saga3-proposals.js'),
    import('../../dist/tools/saga3-normalization.js'),
    import('../../dist/tools/saga3-readiness.js'),
  ]);
  const saga3Proposals = saga3ProposalsMod.createSaga3ProposalHandlers();
  const saga3Normalization = saga3NormalizationMod.createSaga3NormalizationHandlers();
  const saga3Readiness = saga3ReadinessMod.createSaga3ReadinessHandlers();
  // EXACT mirror of src/index.ts:81 ALL_TOOLS assembly (same sources, same order).
  // saga4 cutover: the workflow source was removed (see note above); it is no
  // longer spread here.
  const ALL_TOOLS = [
    ...projects.definitions,
    ...epics.definitions,
    ...tasks.definitions,
    ...subtasks.definitions,
    ...notes.definitions,
    ...comments.definitions,
    ...templates.definitions,
    ...dashboard.definitions,
    ...search.definitions,
    ...activity.definitions,
    ...exportImport.definitions,
    ...dispatcher.definitions,
    ...artifacts.definitions,
    ...repositories.definitions,
    ...lifecycle.definitions,
    ...observations.definitions,
    ...conflicts.definitions,
    ...providers.definitions,
    ...processModules.definitions,
    ...processNodeSubmissions.definitions,
    ...deliveryApprovals.definitions,
    ...lifecycleRuns.definitions,
    ...saga3Proposals.definitions,
    ...saga3Normalization.definitions,
    ...saga3Readiness.definitions,
  ];
  const args = await import('../../dist/tools/saga3-args.js');
  const authority = await import('../../dist/shared/authority/authorize-tool-call.js');
  const ctxDomain = await import('../../dist/shared/authority/execution-context.js');
  const dbMod = await import('../../dist/db.js');
  dynamic = { ALL_TOOLS, args, authority, ctxDomain, dbMod };
  return dynamic;
}

// ===================================================================================
// Area 1 — Tool catalog `ALL_TOOLS`
// ===================================================================================

/**
 * The exact sorted set of MCP tool names exposed by the gateway today. This is
 * the COMPATIBILITY SURFACE Wave 6 must preserve or explicitly migrate. Any
 * addition or removal is a visible diff that the integrator records. Sorted so
 * the diff is stable regardless of assembly order.
 *
 * Sourced by re-assembling ALL_TOOLS identically to src/index.ts:81 (verified
 * at frozen commit fd26fd1). Count: 87 tools, 0 duplicates.
 *
 * saga4 cutover (commit face6ad): three legacy execution-surface tools were
 * DELETED and are intentionally absent from this set —
 *   episode_status, episode_transition (src/tools/lifecycle.ts stage-machine)
 *   workflow_generate_next  (src/tools/workflow.ts task-kind ladder)
 * The formalization→planning gate they implemented now lives in the
 * Formalization Process Module settlement policy
 * (sqlite-formalization-kernel.ts findFirstTraceabilityGap + areTasksReady).
 */
const EXPECTED_SORTED_TOOL_NAMES = [
  'activity_log',
  'artifact_coverage',
  'artifact_create',
  'artifact_get',
  'artifact_list',
  'artifact_update',
  'comment_add',
  'comment_list',
  'conflict_check',
  'conflict_keys_auto_derive',
  'conflict_keys_clear',
  'conflict_keys_list',
  'conflict_keys_set',
  'delivery_approval_decide',
  'delivery_approval_get',
  'delivery_approval_list',
  'epic_create',
  'epic_list',
  'epic_update',
  'lifecycle_run_get',
  'lifecycle_run_list',
  'normalization_get',
  'normalization_submit',
  'note_delete',
  'note_list',
  'note_save',
  'note_search',
  'observation_list',
  'observation_record',
  'process_lifecycle_get',
  'process_module_get',
  'process_module_list',
  'process_module_validate',
  'process_node_submit',
  'process_run_cancel',
  'process_run_get',
  'process_run_list',
  'process_run_set',
  'process_run_start',
  'project_create',
  'project_delete',
  'project_list',
  'project_resolve_by_name',
  'project_update',
  'proposal_submit',
  'provider_list',
  'provider_register',
  'readiness_get',
  'readiness_submit',
  'repository_checkout_bootstrap',
  'repository_checkout_list',
  'repository_checkout_register',
  'repository_get',
  'repository_list',
  'repository_register',
  'repository_update',
  'subtask_create',
  'subtask_delete',
  'subtask_update',
  'task_batch_update',
  'task_create',
  'task_get',
  'task_list',
  'task_update',
  'template_apply',
  'template_create',
  'template_delete',
  'template_list',
  'trace_add',
  'trace_delete',
  'trace_list',
  'tracker_dashboard',
  'tracker_export',
  'tracker_import',
  'tracker_init',
  'tracker_search',
  'tracker_session_diff',
  'verification_record',
  'worker_ask_done',
  'worker_ask_need',
  'worker_done',
  'worker_health',
  'worker_merge_acquire',
  'worker_merge_release',
  'worker_next',
];

test('catalog: ALL_TOOLS is a flat array of descriptors with name/description/inputSchema', async () => {
  const { ALL_TOOLS } = await loadModules();
  assert.ok(Array.isArray(ALL_TOOLS), 'ALL_TOOLS must be an array');
  assert.ok(ALL_TOOLS.length > 0, 'ALL_TOOLS must be non-empty');
  for (const tool of ALL_TOOLS) {
    assert.ok(tool && typeof tool === 'object', 'each entry must be a descriptor object');
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `descriptor missing string name: ${JSON.stringify(tool)}`);
    assert.ok(typeof tool.description === 'string', `descriptor '${tool.name}' missing string description`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `descriptor '${tool.name}' missing object inputSchema`);
  }
});

test('catalog: no duplicate tool names', async () => {
  const { ALL_TOOLS } = await loadModules();
  const names = ALL_TOOLS.map((t) => t.name);
  const counts = {};
  for (const n of names) counts[n] = (counts[n] || 0) + 1;
  const dups = Object.entries(counts).filter(([, c]) => c > 1);
  assert.deepEqual(dups, [], `duplicate tool names in catalog: ${JSON.stringify(dups)}`);
});

test('catalog: pinned sorted tool-name set (Wave 6 compatibility surface)', async () => {
  const { ALL_TOOLS } = await loadModules();
  const sorted = ALL_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(
    sorted,
    EXPECTED_SORTED_TOOL_NAMES,
    'ALL_TOOLS name set changed — this is the Wave 6 compatibility surface; ' +
      'update this constant as a visible, reviewed diff if the change is intended.',
  );
});

test('catalog authority: managed Saga 3 sees only the frozen allowed Saga tools', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({
    allowedTools: ['task_get', 'worker_done', 'Read'],
  });
  const visible = authority.visibleSagaToolNames(db, {
    SAGA_MANAGED_EXECUTION: '1',
    SAGA_EXECUTION_ID: 'exec-1',
    SAGA_TASK_ID: '1',
    SAGA_WORKER_ID: 'worker-1',
  });
  assert.deepEqual([...visible].sort(), ['Read', 'task_get', 'worker_done']);
  const { ALL_TOOLS } = await loadModules();
  assert.deepEqual(
    ALL_TOOLS.filter(tool => visible.has(tool.name)).map(tool => tool.name).sort(),
    ['task_get', 'worker_done'],
    'Claude built-ins may be present in authority but never appear in Saga MCP tools/list',
  );
});

test('catalog authority: malformed or cross-worker managed identity exposes no Saga tools', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  const visible = authority.visibleSagaToolNames(db, {
    SAGA_MANAGED_EXECUTION: '1',
    SAGA_EXECUTION_ID: 'exec-1',
    SAGA_TASK_ID: '1',
    SAGA_WORKER_ID: 'another-worker',
  });
  assert.deepEqual([...visible], []);
});

test('catalog authority: interactive and explicit non-managed MCP retain the full catalog', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  assert.equal(authority.visibleSagaToolNames(db, {}), null);
  assert.equal(
    authority.visibleSagaToolNames(db, { SAGA_MANAGED_EXECUTION: '0' }),
    null,
  );
});

// ===================================================================================
// Area 2 — Authority `authorizeSagaToolCall`
// ===================================================================================

/**
 * Build a worker_executions row carrying a valid frozen execution_context
 * snapshot (runtime enforcement, an explicit allowed_saga_tools set), plus the
 * minimal project/epic/task rows the strict reader joins on. Mirrors what the
 * dispatcher writes at claim time (D1.1). Returns a fresh in-memory DB so each
 * authority test is isolated.
 */
async function buildManagedAuthorityDb({ allowedTools, workIntentId = 7 }) {
  const { ctxDomain, dbMod } = await loadModules();
  // getDb() caches a singleton on first call, so each authority test gets an
  // isolated DB by closing any cached handle, pointing DB_PATH at a fresh temp
  // file, and re-initializing.
  dbMod.closeDb();
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'saga-w0a3-auth-'));
  process.env.DB_PATH = path.join(tmpDir, 'auth.db');
  const db = dbMod.getDb();
  const ins = (sql, params) => db.prepare(sql).run(...params);
  ins('INSERT INTO projects (id, name) VALUES (?, ?)', [1, 'p']);
  ins('INSERT INTO epics (id, project_id, name) VALUES (?, ?, ?)', [1, 1, 'e']);
  ins('INSERT INTO tasks (id, epic_id, title, task_kind, metadata) VALUES (?, ?, ?, ?, ?)', [
    1, 1, 't', 'development.code', JSON.stringify({ work_intent_id: workIntentId }),
  ]);
  const authority = {
    enforcement: 'runtime',
    allowed_saga_tools: allowedTools,
    scope: 'task:1',
    snapshot_ref: 'snap-1',
    work_intent_id: workIntentId,
    authority_hash: ctxDomain.authorityHash({
      enforcement: 'runtime',
      allowed_saga_tools: allowedTools,
      scope: 'task:1',
      snapshot_ref: 'snap-1',
      work_intent_id: workIntentId,
    }),
  };
  const snapshot = {
    policy_version: ctxDomain.EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id: workIntentId,
    authority,
    model_route: { provider: 'anthropic', model: 'claude', effort: 'high' },
    captured_at: '2026-07-28T00:00:00Z',
  };
  const metadata = {
    execution_context: snapshot,
    execution_context_hash: ctxDomain.executionContextHash(snapshot),
  };
  ins(
    'INSERT INTO worker_executions (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['exec-1', 'run-1', 1, 1, 1, 'worker-1', 'm1', 'reserved', 'executing', JSON.stringify(metadata)],
  );
  return db;
}

test('authority: managed execution allows a tool in the frozen allowed_saga_tools set', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get', 'task_update'] });
  const decision = authority.authorizeSagaToolCall({
    toolName: 'task_get', db, executionId: 'exec-1', managedExecution: '1',
  });
  assert.deepEqual(decision, { allow: true, executionId: 'exec-1' });
});

test('authority: managed execution denies a tool NOT in the frozen allowed_saga_tools set (AUTHORITY_DENIED)', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get', 'task_update'] });
  const decision = authority.authorizeSagaToolCall({
    toolName: 'project_delete', db, executionId: 'exec-1', managedExecution: '1',
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, 'AUTHORITY_DENIED');
  // Pin the deny details shape — these fields are the repair contract the
  // worker/controller reads to issue a new WorkIntent.
  assert.deepEqual(Object.keys(decision.details).sort(), [
    'allowed_tools', 'execution_id', 'policy_version', 'recovery',
    'requested_tool', 'work_intent_id',
  ]);
  assert.equal(decision.details.execution_id, 'exec-1');
  assert.equal(decision.details.work_intent_id, 7);
  assert.equal(decision.details.requested_tool, 'project_delete');
  assert.deepEqual(decision.details.allowed_tools, ['task_get', 'task_update']);
  assert.equal(decision.details.policy_version, 'saga3.execution.v1');
  assert.ok(typeof decision.details.recovery === 'string' && decision.details.recovery.length > 0);
});

test('authority: non-managed execution (no marker, no execution id) is compatibility-allowed', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  // No managedExecution / executionId passed → legacy interactive call.
  const decision = authority.authorizeSagaToolCall({ toolName: 'project_delete', db });
  assert.deepEqual(decision, { allow: true });
});

test('authority: managed=1 without SAGA_EXECUTION_ID is AUTHORITY_CONTEXT_INVALID', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  const decision = authority.authorizeSagaToolCall({
    toolName: 'task_get', db, managedExecution: '1',
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
  assert.equal(decision.details.execution_id, null);
  assert.equal(decision.details.requested_tool, 'task_get');
  assert.ok(decision.details.reason.includes('SAGA_EXECUTION_ID'), JSON.stringify(decision.details));
});

test('authority: invalid SAGA_MANAGED_EXECUTION marker value is AUTHORITY_CONTEXT_INVALID', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  const decision = authority.authorizeSagaToolCall({
    toolName: 'task_get', db, managedExecution: 'yes',
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
  assert.ok(decision.details.reason.includes("invalid SAGA_MANAGED_EXECUTION='yes'"), JSON.stringify(decision.details));
});

test('authority: marker=0 with an execution id is AUTHORITY_CONTEXT_INVALID (non-managed must not carry exec id)', async () => {
  const { authority } = await loadModules();
  const db = await buildManagedAuthorityDb({ allowedTools: ['task_get'] });
  const decision = authority.authorizeSagaToolCall({
    toolName: 'task_get', db, managedExecution: '0', executionId: 'exec-1',
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.code, 'AUTHORITY_CONTEXT_INVALID');
  assert.ok(decision.details.reason.includes('non-managed process must not carry SAGA_EXECUTION_ID'), JSON.stringify(decision.details));
});

// ===================================================================================
// Area 3 — Identity guard `assertManagedExecutionIdentity`
// ===================================================================================

/**
 * assertManagedExecutionIdentity is exported from src/index.ts but importing
 * that module runs the MCP server (main()), so the guard is characterized via
 * source-text anchors — the same pattern saga2-runtime-contracts.test.mjs uses.
 * The anchors pin the exact error code and messages so any drift is a visible
 * diff.
 */
test('identity guard: AUTHORITY_CONTEXT_INVALID code + pairing rules are pinned in source', () => {
  const src = read('src/index.ts');
  assert.ok(src.includes('export function assertManagedExecutionIdentity'), 'guard must remain exported from src/index.ts');
  // Pin the error CODE.
  assert.ok(src.includes("throw new Error(`AUTHORITY_CONTEXT_INVALID:"), 'guard must throw AUTHORITY_CONTEXT_INVALID');
  // Pin the three pairing rules (exact message substrings).
  const expectedMessages = [
    "AUTHORITY_CONTEXT_INVALID: invalid SAGA_MANAGED_EXECUTION='",
    'AUTHORITY_CONTEXT_INVALID: managed MCP child is missing SAGA_EXECUTION_ID',
    'AUTHORITY_CONTEXT_INVALID: SAGA_EXECUTION_ID requires SAGA_MANAGED_EXECUTION=1',
  ];
  for (const m of expectedMessages) {
    assert.ok(src.includes(m), `identity guard lost message anchor: ${m}`);
  }
  // Pin the branch conditions.
  assert.ok(src.includes("marker !== undefined && marker !== '0' && marker !== '1'"), 'invalid-marker branch condition changed');
  assert.ok(src.includes("marker === '1' && !executionId"), 'managed-without-exec-id branch condition changed');
  assert.ok(src.includes("marker !== '1' && executionId"), 'exec-id-without-managed branch condition changed');
});

// ===================================================================================
// Area 4 — Structured errors (actionableError + shapes + enrichPayloadErrors)
// ===================================================================================

test('structured errors: actionableError produces the documented field shape', async () => {
  const { args } = await loadModules();
  const err = args.actionableError(
    'proposal_submit',
    "'intent_id' must be an integer, got null",
    { field: 'intent_id', source: 'task_get metadata', expected: 'shape X', got: null },
  );
  assert.ok(err instanceof Error, 'actionableError must return an Error');
  // Message keeps the short diagnostic phrase as a substring (legacy compat).
  assert.ok(err.message.includes("'intent_id' must be an integer"), err.message);
  // And appends expected shape / source / got value.
  assert.ok(err.message.includes('Expected shape: shape X'), err.message);
  assert.ok(err.message.includes('Source: task_get metadata'), err.message);
  assert.ok(err.message.includes('Got: null'), err.message);
  // Tool prefix.
  assert.ok(err.message.startsWith('proposal_submit: '), err.message);
});

test('structured errors: actionableError omits absent detail sections', async () => {
  const { args } = await loadModules();
  const err = args.actionableError('readiness_get', 'bare message');
  assert.equal(err.message, 'readiness_get: bare message');
});

test('structured errors: SAGA3_TOOL_CALL_SHAPES covers all 7 saga3 tools', async () => {
  const { args } = await loadModules();
  assert.deepEqual(
    Object.keys(args.SAGA3_TOOL_CALL_SHAPES).sort(),
    [
      'normalization_get', 'normalization_submit',
      'proposal_submit', 'readiness_get', 'readiness_submit',
    ],
  );
  for (const [tool, shape] of Object.entries(args.SAGA3_TOOL_CALL_SHAPES)) {
    assert.ok(typeof shape === 'string' && shape.startsWith(`${tool}(`), `shape for ${tool} must start with the tool name`);
  }
});

test('structured errors: parameterized Discovery workflow hint is appended by enrichPayloadErrors (W13-A5)', async () => {
  const { args } = await loadModules();
  // The hint must route the worker back to the exact paths already returned
  // by task_get. It must never guess a legacy project path.
  const WORKFLOW_HINT =
    '[Workflow: Read your stage tracker the exact tracker_path returned by task_get._workflow_hint, verify checklist the exact checklist path returned by task_get._workflow_hint, resume at the rejected operation after repairing and re-reading the materialized call file, retry.]';
  const enriched = args.enrichPayloadErrors('proposal_submit', ["field 'rationale' must be a non-empty string"]);
  assert.ok(enriched.includes(WORKFLOW_HINT), `parameterized Discovery workflow hint lost:\n${WORKFLOW_HINT}`);
  // The hint is always the second-to-last element (shape is last when present).
  assert.equal(enriched[enriched.length - 2], WORKFLOW_HINT);
  assert.equal(WORKFLOW_HINT.includes('docs/discovery'), false);
});

test('structured errors: enrichPayloadErrors workflow hint is parameterized — caller refs override Discovery defaults (W13-A5)', async () => {
  const { args } = await loadModules();
  // A non-Discovery caller passes its own refs; the hint must NOT mention the
  // discovery path. This is the §13.13 anti-regression: no module name is
  // baked into the platform helper.
  const enriched = args.enrichPayloadErrors('proposal_submit', ['something wrong'], {
    trackerRef: 'docs/formalization/project-9-formalization-stage.md',
    resumeStep: '2b',
  });
  const hint = enriched[enriched.length - 2];
  assert.match(hint, /docs\/formalization\/project-9-formalization-stage\.md/);
  assert.equal(hint.includes('discovery'), false, 'parameterized hint must not bake discovery');
});

test('structured errors: enrichPayloadErrors omits the workflow sentence when caller supplies no refs (W13-A5)', async () => {
  const { args } = await loadModules();
  // renderWorkflowHint({}) returns '' → no workflow element is appended; only
  // the Expected shape (when present) follows the raw errors.
  const enriched = args.enrichPayloadErrors('proposal_submit', ['something wrong'], {});
  const last = enriched[enriched.length - 1];
  assert.match(last, /^\[Expected proposal_submit shape:/);
  assert.ok(!enriched.some((e) => e.startsWith('[Workflow:')),
    `unexpected workflow sentence when no refs supplied: ${JSON.stringify(enriched)}`);
});

test('structured errors: enrichPayloadErrors appends the Expected <tool> shape last', async () => {
  const { args } = await loadModules();
  const enriched = args.enrichPayloadErrors('readiness_submit', ['something wrong']);
  const last = enriched[enriched.length - 1];
  assert.ok(last.startsWith('[Expected readiness_submit shape: readiness_submit('), last);
});

test('structured errors: enrichPayloadErrors is a no-op for an unknown tool (no shape, no hint)', async () => {
  const { args } = await loadModules();
  const out = args.enrichPayloadErrors('not_a_saga3_tool', ['some error']);
  // Unknown tools must NOT get the generic workflow sentence — that would
  // change error semantics and hide the missing registry (see source comment).
  assert.deepEqual(out, ['some error']);
});

test('structured errors: enrichPayloadErrors([]) returns []', async () => {
  const { args } = await loadModules();
  assert.deepEqual(args.enrichPayloadErrors('proposal_submit', []), []);
});

test('structured errors: proposal_submit recommended_outcome Discovery vocabulary is pinned', async () => {
  const { args } = await loadModules();
  // Pin the enumerated allowed list surfaced in the Source hint for the
  // recommended_outcome field (Discovery decision vocabulary baked into the
  // gateway). Any change is a visible diff.
  const enriched = args.enrichPayloadErrors('proposal_submit', ["field 'recommended_outcome' value not allowed"]);
  const hint = enriched.find((e) => e.includes('recommended_outcome'));
  assert.ok(hint, 'no hint emitted for recommended_outcome');
  assert.ok(
    hint.includes('one of: go, clarify, reject, defer, inconclusive, failed'),
    `recommended_outcome vocabulary changed: ${hint}`,
  );
});

test('structured errors: readiness_submit recommended_next_action Discovery vocabulary is pinned', async () => {
  const { args } = await loadModules();
  const enriched = args.enrichPayloadErrors('readiness_submit', ["field 'recommended_next_action' value not allowed"]);
  const hint = enriched.find((e) => e.includes('recommended_next_action'));
  assert.ok(hint, 'no hint emitted for recommended_next_action');
  assert.ok(
    hint.includes('one of: proceed_to_settlement, request_clarification, repeat_discovery, defer, reject, manual_review'),
    `recommended_next_action vocabulary changed: ${hint}`,
  );
});

// ===================================================================================
// Area 5 — Error normalization `friendlyError`
// ===================================================================================

/**
 * friendlyError is a local function in src/index.ts (not exported). It is
 * characterized via source-text anchors pinning the four SQLite normalization
 * branches and their exact output strings. The anchors lock the mapping so any
 * change to the normalization is a visible, reviewed diff.
 */
test('error normalization: friendlyError SQLite mappings pinned in source', () => {
  const src = read('src/index.ts');
  // The function definition must remain.
  assert.ok(src.includes('function friendlyError(msg: string): string'), 'friendlyError definition moved or renamed');
  // UNIQUE — extracts the column name; falls back to a generic phrase.
  assert.ok(src.includes("'UNIQUE constraint failed'"), 'UNIQUE branch lost');
  assert.ok(src.includes('/UNIQUE constraint failed: \\w+\\.(\\w+)/'), 'UNIQUE regex changed');
  assert.ok(src.includes('A record with that'), 'UNIQUE output string changed');
  assert.ok(src.includes("'A record with that value already exists.'"), 'UNIQUE fallback string changed');
  // NOT NULL. Output is a template literal `Missing required field: ${match[1]}.`
  // (no leading quote in source); pin both the template-literal body and the
  // fallback string literal.
  assert.ok(src.includes("'NOT NULL constraint failed'"), 'NOT NULL branch lost');
  assert.ok(src.includes('/NOT NULL constraint failed: \\w+\\.(\\w+)/'), 'NOT NULL regex changed');
  assert.ok(src.includes('Missing required field: ${match[1]}.'), 'NOT NULL output template changed');
  assert.ok(src.includes("'A required field is missing.'"), 'NOT NULL fallback string changed');
  // FOREIGN KEY.
  assert.ok(src.includes("'FOREIGN KEY constraint failed'"), 'FK branch lost');
  assert.ok(src.includes("'Referenced record not found. Check that the parent item exists.'"), 'FK output string changed');
  // no such table.
  assert.ok(src.includes("'no such table'"), 'no-such-table branch lost');
  assert.ok(src.includes("'Database not initialized. Run tracker_init first.'"), 'no-such-table output string changed');
  // Default pass-through.
  assert.ok(/return msg;/.test(src), 'default pass-through return lost');
});

test('error normalization: handler wires friendlyError into the CallTool error envelope', () => {
  const src = read('src/index.ts');
  // Pin that the dispatch catch-all normalizes via friendlyError and wraps as
  // an MCP isError text envelope. Wave 6 must preserve structured-error
  // preservation (plan §11.10) — this anchor makes a regression visible.
  assert.ok(src.includes('const friendly = friendlyError(msg)'), 'dispatch no longer normalizes errors via friendlyError');
  assert.ok(src.includes('text: `Error: ${friendly}`'), 'error envelope text format changed');
  assert.ok(/isError: true/.test(src), 'error envelope no longer flagged isError');
});
