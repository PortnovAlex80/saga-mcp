import type Database from 'better-sqlite3';

import { readFrozenProductionIngress } from '../../process-modules/application/production-ingress-contract.js';
import { TransitionObligationIntegrator } from '../../process-modules/application/transition-obligation-integrator.js';
import { SqliteTransitionObligationLedger } from '../../process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { sha256Hex } from '../../shared/canonical-json.js';

export interface FinalPresentationCommitment {
  readonly commitmentRef: string;
  readonly workplaceRef: string;
  readonly workIntentId: number;
  readonly taskId: number;
  readonly executionId: string;
  readonly role: 'author' | 'reviewer';
  readonly productSchema: string;
  readonly productRef: string;
  readonly productDigest: string;
  readonly contractDigest: string;
}

interface CommitmentAuthorityRow {
  workplace_ref: string;
  loop_state: string;
  next_role: 'author' | 'reviewer';
  active_reservation_ref: string | null;
  authority_scope: string;
  output_schema: string;
}

/**
 * Atomically append the immutable typed-presentation source fact and its
 * close-presentation obligation. The caller must already be inside the same
 * transaction that inserted the managed submission and its projections.
 */
export function recordFinalPresentationCommitment(
  db: Database.Database,
  input: {
    readonly taskId: number;
    readonly executionId: string;
    readonly productSchema: string;
    readonly productRef: string;
    readonly productDigest: string;
  },
): FinalPresentationCommitment | null {
  if (!db.inTransaction) {
    throw new Error('FINAL_PRESENTATION_TRANSACTION_REQUIRED');
  }
  const ingress = readFrozenProductionIngress(db, input.executionId);
  if (ingress.mode !== 'typed-submission') return null;

  const authority = db.prepare(
    `SELECT t.workplace_ref,w.loop_state,w.next_role,w.active_reservation_ref,
            wi.authority_scope,wi.output_schema
       FROM tasks t
       JOIN factory_workplaces w ON w.workplace_ref=t.workplace_ref
       JOIN factory_work_intents wi ON wi.id=?
      WHERE t.id=? AND w.production_cell_id IS NOT NULL`,
  ).get(ingress.workIntentId, input.taskId) as CommitmentAuthorityRow | undefined;
  // product_submit is also used outside Production Cells. Those callers retain
  // the explicit worker_done protocol and do not create a Factory commitment.
  if (!authority) return null;
  if (authority.loop_state !== 'running'
    || authority.active_reservation_ref !== input.executionId) {
    throw new Error('FINAL_PRESENTATION_FENCE_MISMATCH');
  }
  if (authority.output_schema !== input.productSchema) {
    throw new Error('FINAL_PRESENTATION_SCHEMA_MISMATCH');
  }
  let scope: unknown;
  try { scope = JSON.parse(authority.authority_scope); } catch {
    throw new Error('FINAL_PRESENTATION_AUTHORITY_CORRUPT');
  }
  const pin = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? (scope as Record<string, unknown>).payload_contract
    : null;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
    // Legacy/unpinned typed cells are not silently reinterpreted. They keep
    // explicit worker_done as their only close signal.
    return null;
  }
  const contractDigest = (pin as Record<string, unknown>).contractDigest;
  if (typeof contractDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contractDigest)) {
    throw new Error('FINAL_PRESENTATION_CONTRACT_PIN_INVALID');
  }
  const commitmentRef = `final-presentation:${sha256Hex({
    workplaceRef: authority.workplace_ref,
    workIntentId: ingress.workIntentId,
    role: authority.next_role,
    executionId: input.executionId,
    productSchema: input.productSchema,
    productRef: input.productRef,
    productDigest: input.productDigest,
    contractDigest,
  })}`;
  db.prepare(
    `INSERT OR IGNORE INTO factory_final_presentation_commitments
       (commitment_ref,workplace_ref,work_intent_id,task_id,execution_id,role,
        product_schema,product_ref,product_digest,contract_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    commitmentRef,
    authority.workplace_ref,
    ingress.workIntentId,
    input.taskId,
    input.executionId,
    authority.next_role,
    input.productSchema,
    input.productRef,
    input.productDigest,
    contractDigest,
  );
  const commitment = readFinalPresentationCommitment(db, commitmentRef);
  if (!commitment) throw new Error('FINAL_PRESENTATION_COMMITMENT_VANISHED');
  assertCommitmentMatches(commitment, {
    commitmentRef,
    workplaceRef: authority.workplace_ref,
    workIntentId: ingress.workIntentId,
    taskId: input.taskId,
    executionId: input.executionId,
    role: authority.next_role,
    productSchema: input.productSchema,
    productRef: input.productRef,
    productDigest: input.productDigest,
    contractDigest,
  });
  new TransitionObligationIntegrator({
    ledger: new SqliteTransitionObligationLedger(db),
  }).onFinalPresentationCommitted({
    commitmentRef,
    commitmentDigest: sha256Hex({
      workplaceRef: commitment.workplaceRef,
      workIntentId: commitment.workIntentId,
      role: commitment.role,
      productSchema: commitment.productSchema,
      productRef: commitment.productRef,
      productDigest: commitment.productDigest,
      contractDigest: commitment.contractDigest,
    }),
    workplaceRef: commitment.workplaceRef,
  });
  return commitment;
}

export function readFinalPresentationCommitment(
  db: Database.Database,
  commitmentRef: string,
): FinalPresentationCommitment | null {
  const row = db.prepare(
    `SELECT commitment_ref,workplace_ref,work_intent_id,task_id,execution_id,
            role,product_schema,product_ref,product_digest,contract_digest
       FROM factory_final_presentation_commitments WHERE commitment_ref=?`,
  ).get(commitmentRef) as {
    commitment_ref: string;
    workplace_ref: string;
    work_intent_id: number;
    task_id: number;
    execution_id: string;
    role: 'author' | 'reviewer';
    product_schema: string;
    product_ref: string;
    product_digest: string;
    contract_digest: string;
  } | undefined;
  return row ? {
    commitmentRef: row.commitment_ref,
    workplaceRef: row.workplace_ref,
    workIntentId: row.work_intent_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    role: row.role,
    productSchema: row.product_schema,
    productRef: row.product_ref,
    productDigest: row.product_digest,
    contractDigest: row.contract_digest,
  } : null;
}

export function readFinalPresentationCommitmentForExecution(
  db: Database.Database,
  executionId: string,
): FinalPresentationCommitment | null {
  const row = db.prepare(
    `SELECT commitment_ref FROM factory_final_presentation_commitments
      WHERE execution_id=?`,
  ).get(executionId) as { commitment_ref: string } | undefined;
  return row ? readFinalPresentationCommitment(db, row.commitment_ref) : null;
}

function assertCommitmentMatches(
  actual: FinalPresentationCommitment,
  expected: FinalPresentationCommitment,
): void {
  for (const key of Object.keys(expected) as (keyof FinalPresentationCommitment)[]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`FINAL_PRESENTATION_REPLAY_MISMATCH:${String(key)}`);
    }
  }
}
