import type Database from 'better-sqlite3';
import type { NodeExecutionResult } from '../process-modules/application/node-executor.js';
import { canonicalJson, digestJson } from './canonical-json.js';

export interface AdoptedNodeResult {
  readonly directiveRef: string;
  readonly adoptionRef: string;
  readonly result: NodeExecutionResult;
}

export interface AdoptedNodeResultPort {
  peek(params: {
    processRunId: number;
    nodeId: string;
    processInputHash: string;
    packageDigest: string | null;
  }): AdoptedNodeResult | null;
  markConsumed(directiveRef: string, nodeRunId: number): void;
  /**
   * Atomically complete the adopted NodeRun AND consume the resume directive
   * in a single database transaction.
   *
   * `completeFn` is invoked inside the transaction (it performs the
   * completeV2 UPDATE on factory_node_runs). If it throws, the directive is
   * NOT consumed and the whole transaction rolls back. If `completeFn`
   * succeeds, markConsumed runs in the same transaction — a crash between
   * the two writes is structurally impossible.
   *
   * This closes the window the previous two-statement path
   * (completeV2(); markConsumed()) left open: a crash between them left the
   * NodeRun committed but the directive still `ready`, which could let a
   * later re-entry into the same node re-adopt the stale directive.
   */
  completeAdoptedNodeRun(input: {
    directiveRef: string;
    nodeRunId: number;
    completeFn: () => void;
  }): void;
}

interface DirectiveRow {
  directive_ref: string;
  adoption_ref: string;
  process_input_hash: string;
  package_digest: string | null;
  result_json: string;
  result_digest: string;
}

export class SqliteResumeDirectiveRepository implements AdoptedNodeResultPort {
  constructor(private readonly db: Database.Database) {}

  peek(params: {
    processRunId: number;
    nodeId: string;
    processInputHash: string;
    packageDigest: string | null;
  }): AdoptedNodeResult | null {
    const row = this.db.prepare(
      `SELECT directive_ref, adoption_ref, process_input_hash, package_digest,
              result_json, result_digest
         FROM factory_resume_directives
        WHERE process_run_id=? AND node_id=? AND state='ready'`,
    ).get(params.processRunId, params.nodeId) as DirectiveRow | undefined;
    if (!row) return null;
    if (row.process_input_hash !== params.processInputHash) {
      throw new Error('CHECKPOINT_DIRECTIVE_INPUT_MISMATCH');
    }
    if (row.package_digest !== null && row.package_digest !== params.packageDigest) {
      throw new Error('CHECKPOINT_DIRECTIVE_PACKAGE_MISMATCH');
    }
    const parsed = JSON.parse(row.result_json) as NodeExecutionResult;
    if (digestJson(parsed) !== row.result_digest) {
      throw new Error('CHECKPOINT_DIRECTIVE_DIGEST_MISMATCH');
    }
    if (parsed.runtimeEvent !== 'completed') {
      throw new Error('CHECKPOINT_DIRECTIVE_RESULT_NOT_COMPLETED');
    }
    return {
      directiveRef: row.directive_ref,
      adoptionRef: row.adoption_ref,
      result: {
        ...parsed,
        ...(parsed.receipt
          ? {
              receipt: {
                ...parsed.receipt,
                executionId: `checkpoint-import:${row.adoption_ref}`,
                replayed: true,
              },
            }
          : {}),
      },
    };
  }

  markConsumed(directiveRef: string, nodeRunId: number): void {
    const result = this.db.prepare(
      `UPDATE factory_resume_directives
          SET state='consumed', consumed_node_run_id=?, consumed_at=datetime('now')
        WHERE directive_ref=? AND state='ready'`,
    ).run(nodeRunId, directiveRef);
    if (result.changes !== 1) {
      throw new Error(`CHECKPOINT_DIRECTIVE_ALREADY_CONSUMED: ${directiveRef}`);
    }
  }

  completeAdoptedNodeRun(input: {
    directiveRef: string;
    nodeRunId: number;
    completeFn: () => void;
  }): void {
    // Single transaction: completeFn (completeV2 UPDATE) + markConsumed.
    // better-sqlite3 transaction() uses SAVEPOINTs that nest correctly even
    // when completeFn opens its own nested statements. A throw from either
    // side rolls back both.
    const txn = this.db.transaction(() => {
      input.completeFn();
      const result = this.db.prepare(
        `UPDATE factory_resume_directives
            SET state='consumed', consumed_node_run_id=?, consumed_at=datetime('now')
          WHERE directive_ref=? AND state='ready'`,
      ).run(input.nodeRunId, input.directiveRef);
      if (result.changes !== 1) {
        throw new Error(`CHECKPOINT_DIRECTIVE_ALREADY_CONSUMED: ${input.directiveRef}`);
      }
    });
    txn();
  }

  static serializeResult(result: NodeExecutionResult): {
    json: string;
    digest: string;
  } {
    return { json: canonicalJson(result), digest: digestJson(result) };
  }
}
