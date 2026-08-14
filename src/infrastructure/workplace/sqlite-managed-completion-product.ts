import type Database from 'better-sqlite3';
import type { ProductRef } from '../../process-modules/domain/spi/index.js';
import { readFrozenProductionIngressIfBound } from '../../process-modules/application/production-ingress-contract.js';
import { deserializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { buildWorkplaceProductionSnapshot } from '../../process-modules/shared/workplace-production-snapshot.js';
import { sha256Hex } from '../../shared/canonical-json.js';
import { SqliteWorkplaceProductionResolver } from './sqlite-workplace-production-resolver.js';
import { SqliteWorkplaceProductAdapter } from '../../process-modules/persistence/sqlite-workplace-product-adapter.js';

interface CompletionContextRow {
  workplace_ref: string | null;
  output_schema: string;
  process_run_id: number;
  module_ref: string;
  node_id: string;
}

interface ExistingCompletionProductRow {
  work_intent_id: number;
  workplace_ref: string;
  schema_id: string;
  product_ref: string;
  product_digest: string;
  worker_done_command_id: string;
}

/** Freeze managed Workplace material inside the worker_done transaction. */
export function freezeManagedCompletionProduct(
  db: Database.Database,
  input: { executionId: string; workerDoneCommandId: string },
): ProductRef | null {
  const ingress = readFrozenProductionIngressIfBound(db, input.executionId);
  if (!ingress) return null;
  if (ingress.mode === 'typed-submission') return null;
  const row = db.prepare(
    `SELECT t.workplace_ref,wi.output_schema,
            CAST(json_extract(t.metadata,'$.process_run_id') AS INTEGER) AS process_run_id,
            json_extract(t.metadata,'$.process_module_ref') AS module_ref,
            json_extract(t.metadata,'$.process_node_id') AS node_id
       FROM worker_executions we
       JOIN tasks t ON t.id=we.task_id
       JOIN factory_work_intents wi ON wi.id=?
      WHERE we.execution_id=?`,
  ).get(ingress.workIntentId, input.executionId) as CompletionContextRow | undefined;
  if (!row?.workplace_ref || !Number.isSafeInteger(row.process_run_id)
    || typeof row.module_ref !== 'string' || row.module_ref === ''
    || typeof row.node_id !== 'string' || row.node_id === '') {
    throw new Error(`MANAGED_COMPLETION_CONTEXT_INVALID: ${input.executionId}`);
  }
  const existing = db.prepare(
    `SELECT work_intent_id,workplace_ref,schema_id,product_ref,product_digest,
            worker_done_command_id
       FROM factory_execution_completion_products
      WHERE execution_id=? AND schema_id=?`,
  ).get(input.executionId, row.output_schema) as ExistingCompletionProductRow | undefined;
  if (existing) {
    if (existing.work_intent_id !== ingress.workIntentId
      || existing.workplace_ref !== row.workplace_ref
      || existing.worker_done_command_id !== input.workerDoneCommandId) {
      throw new Error(`MANAGED_COMPLETION_PRODUCT_REPLAY_MISMATCH: ${input.executionId}`);
    }
    return {
      schemaId: existing.schema_id,
      ref: existing.product_ref,
      digest: existing.product_digest,
    };
  }

  const workplaceRef = deserializeWorkplaceRef(row.workplace_ref);
  const material = new SqliteWorkplaceProductionResolver(db).read(workplaceRef);
  if (material.artifacts.length === 0 && material.traces.length === 0) {
    throw new Error(`MANAGED_COMPLETION_PRODUCT_EMPTY: ${input.executionId}`);
  }
  const snapshot = buildWorkplaceProductionSnapshot({
    workplaceRef: row.workplace_ref,
    expectedSchemaRef: row.output_schema,
    artifacts: material.artifacts,
    traces: material.traces,
  });
  const digest = sha256Hex(snapshot);
  const productRef = new SqliteWorkplaceProductAdapter(db).submitProduct({
    processRunId: row.process_run_id,
    moduleRef: row.module_ref,
    nodeId: row.node_id,
    schema: row.output_schema,
    content: snapshot,
    contentHash: digest,
    executionRef: input.executionId,
  }).productRef;
  db.prepare(
    `INSERT INTO factory_execution_completion_products
       (execution_id,work_intent_id,workplace_ref,schema_id,product_ref,
        product_digest,worker_done_command_id)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    input.executionId,
    ingress.workIntentId,
    row.workplace_ref,
    productRef.schemaId,
    productRef.ref,
    productRef.digest,
    input.workerDoneCommandId,
  );
  return productRef;
}

export function readManagedCompletionProducts(
  db: Database.Database,
  executionId: string,
): ProductRef[] {
  return (db.prepare(
    `SELECT schema_id,product_ref,product_digest
       FROM factory_execution_completion_products
      WHERE execution_id=? ORDER BY schema_id`,
  ).all(executionId) as Array<{
    schema_id: string;
    product_ref: string;
    product_digest: string;
  }>).map(row => ({
    schemaId: row.schema_id,
    ref: row.product_ref,
    digest: row.product_digest,
  }));
}
