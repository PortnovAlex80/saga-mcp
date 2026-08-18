/**
 * Seed a durable WorkerExecution that satisfies the execution fence.
 *
 * §22: every managed tool validates execution authority fail-closed. Since the
 * fence landed, `worker_done` requires a CALLER-SUPPLIED execution_id (the
 * task's own fence is already cleared by the time an idempotent retry arrives),
 * and production ingress resolves that exact row and hash-verifies its frozen
 * execution context.
 *
 * Tests written before the fence called worker_done bare and now fail with
 * EXECUTION_FENCE_REQUIRED / PRODUCTION_INGRESS_EXECUTION_AUTHORITY_INVALID.
 * That is the runtime being correct, not a defect — those calls are no longer
 * legal. This helper gives such a test the smallest LAWFUL fence: an
 * explicitly UNBOUND execution (no WorkIntent, no authority), which
 * `readFrozenProductionIngressIfBound` accepts as a legacy tracker-only
 * execution while still proving the envelope is well-formed and hash-verified.
 *
 * Use it when the test's subject is the command/lifecycle layer. A test whose
 * subject is managed production must seed a real WorkIntent instead.
 */
import { executionContextHash } from '../../../dist/shared/authority/execution-context.js';

/**
 * Seed the running ProcessRun a claimable task must belong to.
 *
 * The claim predicate does not merely require `metadata.process_run_id` to be
 * present — it requires that ProcessRun to EXIST and be `running|paused`:
 *
 *   AND EXISTS (SELECT 1 FROM factory_process_runs pr
 *                WHERE pr.id=json_extract(t.metadata,'$.process_run_id')
 *                  AND pr.status IN ('running','paused'))
 *
 * That is correct and deliberately strict: a card whose process is finished or
 * never existed must not be handed to a worker. Fixtures that stamp a bare
 * `process_run_id` without the row therefore make every later claim return an
 * empty queue — which reads as "the task never became claimable again".
 */
export function seedRunningProcessRun(db, { id, projectId, epicId = null }) {
  db.prepare(
    `INSERT OR REPLACE INTO factory_process_runs
       (id,project_id,epic_id,module_name,module_version,module_ref_key,
        idempotency_key,executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'test-module','1.0.0','test-module@1.0.0',
             ?, 'generic-flow','test.input.v1','{}','hash-0','running')`,
  ).run(id, projectId, epicId, `idem-${id}`);
  return id;
}

export function seedUnboundExecution(db, {
  executionId,
  projectId,
  epicId,
  taskId,
  workerId,
  runId = 'test-run',
  machineId = 'test-machine',
  state = 'running',
  phase = 'executing',
}) {
  const executionContext = {
    policy_version: 'factory.execution.v2',
    work_intent_id: null,
    authority: null,
    model_route: { provider: 'test', model: 'test', effort: 'low' },
    executor_kind: 'claude-cli',
    captured_at: new Date().toISOString(),
  };
  // The hash covers exactly the fields the strict reader recomputes, in its
  // order: optional keys are included only when present on the raw context.
  const hash = executionContextHash({
    policy_version: executionContext.policy_version,
    work_intent_id: executionContext.work_intent_id,
    authority: executionContext.authority,
    model_route: executionContext.model_route,
    captured_at: executionContext.captured_at,
    executor_kind: executionContext.executor_kind,
  });
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
        state,phase,metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    executionId, runId, projectId, epicId, taskId, workerId, machineId,
    state, phase,
    JSON.stringify({ execution_context: executionContext, execution_context_hash: hash }),
  );
  return executionId;
}
