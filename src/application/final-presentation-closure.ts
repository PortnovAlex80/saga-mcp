import type Database from 'better-sqlite3';

import {
  readFinalPresentationCommitment,
  type FinalPresentationCommitment,
} from '../infrastructure/workplace/sqlite-final-presentation-commitment.js';
import { closeFinalPresentationFromKernel } from '../tools/dispatcher.js';

/**
 * Close one already committed typed presentation through the same task/fence/
 * Workplace transaction used by explicit worker_done. Safe to call from the
 * submit fast path, process termination, or the obligation reconciler.
 */
export function closeCommittedTypedPresentation(
  db: Database.Database,
  commitmentRef: string,
): { readonly receiptRef: string; readonly commitment: FinalPresentationCommitment } {
  const commitment = readFinalPresentationCommitment(db, commitmentRef);
  if (!commitment) {
    throw new Error(`FINAL_PRESENTATION_COMMITMENT_NOT_FOUND:${commitmentRef}`);
  }
  const source = db.prepare(
    `SELECT schema_version,content_hash,intent_id,task_id,execution_id
       FROM factory_managed_node_submissions
      WHERE id=CAST(substr(?, length('managed-node-submission:') + 1) AS INTEGER)`,
  ).get(commitment.productRef) as {
    schema_version: string;
    content_hash: string;
    intent_id: number;
    task_id: number;
    execution_id: string;
  } | undefined;
  if (!commitment.productRef.startsWith('managed-node-submission:')
    || !source
    || source.schema_version !== commitment.productSchema
    || source.content_hash !== commitment.productDigest
    || source.intent_id !== commitment.workIntentId
    || source.task_id !== commitment.taskId
    || source.execution_id !== commitment.executionId) {
    throw new Error('FINAL_PRESENTATION_PRODUCT_AUTHORITY_MISMATCH');
  }
  const execution = db.prepare(
    `SELECT worker_id,task_id FROM worker_executions WHERE execution_id=?`,
  ).get(commitment.executionId) as { worker_id: string; task_id: number } | undefined;
  if (!execution || execution.task_id !== commitment.taskId) {
    throw new Error('FINAL_PRESENTATION_EXECUTION_AUTHORITY_MISMATCH');
  }
  closeFinalPresentationFromKernel({
    taskId: commitment.taskId,
    executionId: commitment.executionId,
    workerId: execution.worker_id,
    commitmentRef: commitment.commitmentRef,
    productRef: commitment.productRef,
    productDigest: commitment.productDigest,
  });
  const receipt = db.prepare(
    `SELECT command_id FROM command_receipts
      WHERE execution_id=? AND command_kind='presentation_close'
        AND accepted=1 LIMIT 1`,
  ).get(commitment.executionId) as { command_id: string } | undefined;
  if (!receipt) throw new Error('FINAL_PRESENTATION_CLOSE_RECEIPT_MISSING');
  return { receiptRef: receipt.command_id, commitment };
}
