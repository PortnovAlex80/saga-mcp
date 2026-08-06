import type Database from 'better-sqlite3';
import type {
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
} from '../node-executor.js';
import type { LmNodeExecutionPersistence } from './lm-node-executor.js';

export type AcceptedWorkerDoneStatus = 'review' | 'done' | 'todo' | 'blocked';

interface AcceptedWorkerDoneReceipt {
  readonly completedNewStatus: AcceptedWorkerDoneStatus;
}

/**
 * Corrects a lagging worker substrate verdict from durable command evidence.
 *
 * The wrapped LM executor still owns assignment, polling, timeout and receipt
 * construction. This decorator only resolves one split-brain condition: the
 * exact execution has an accepted worker_done receipt, but the runner/task
 * snapshots lagged and the LM executor returned failed or paused.
 */
export class ReceiptAwareLmNodeExecutor implements NodeExecutor {
  readonly kind = 'lm' as const;

  constructor(
    private readonly inner: NodeExecutor,
    private readonly persistence: LmNodeExecutionPersistence,
    private readonly db: Database.Database,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const result = await this.inner.execute(ctx);
    if (result.runtimeEvent === 'completed') return result;

    const executionId = result.receipt?.executionId ?? null;
    const completion = executionId
      ? this.readAcceptedWorkerDone(executionId)
      : null;
    if (!completion) return result;

    const runtimeEvent = completion.completedNewStatus === 'done'
      ? 'completed'
      : 'paused';

    if (runtimeEvent === 'completed' && result.receipt) {
      // The inner executor normally paused the intent on its false-negative
      // path. Reconcile the exact WorkIntent before returning completed; the
      // authority-binding invariant then settles Workplace + task atomically.
      for (const expected of ['executing', 'paused', 'open']) {
        this.persistence.setIntentStatus(
          result.receipt.intentId,
          expected,
          'concluded',
        );
      }
    }

    const corrected: NodeExecutionResult = {
      ...result,
      runtimeEvent,
    };
    if (result.receipt) {
      corrected.receipt = {
        ...result.receipt,
        runtimeStatus: runtimeEvent,
      };
    }
    if (result.driverReceipt) {
      corrected.driverReceipt = {
        ...result.driverReceipt,
        runtimeEvent,
      };
    }
    return corrected;
  }

  private readAcceptedWorkerDone(
    executionId: string,
  ): AcceptedWorkerDoneReceipt | null {
    let row: { reply_json: string } | undefined;
    try {
      row = this.db.prepare(
        `SELECT reply_json
           FROM command_receipts
          WHERE execution_id=?
            AND command_kind='worker_done'
            AND accepted=1
          ORDER BY accepted_at DESC, rowid DESC
          LIMIT 1`,
      ).get(executionId) as { reply_json: string } | undefined;
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) {
        return null;
      }
      throw error;
    }
    if (!row) return null;

    try {
      const reply = JSON.parse(row.reply_json) as {
        completed_new_status?: unknown;
      };
      const status = reply.completed_new_status;
      if (
        status !== 'review'
        && status !== 'done'
        && status !== 'todo'
        && status !== 'blocked'
      ) {
        return null;
      }
      return { completedNewStatus: status };
    } catch {
      return null;
    }
  }
}
