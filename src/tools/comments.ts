import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';
import {
  materializeTaskRecoveryMemory,
  parseRecoveryComment,
} from '../lifecycle/task-recovery-memory.js';
import { journalEvent } from '../observability/run-journal.js';

export const definitions: Tool[] = [
  {
    name: 'comment_add',
    description:
      'Add a comment to a task. Comments create a chronological discussion thread — useful for leaving breadcrumbs across sessions. ' +
      'If the content starts with the exact prefix "RECOVERY:" (uppercase, at the very start), saga-core parses it as an episodic-memory note: the text after the prefix is stored into the task\'s metadata.attempt_history[].recovery_summary and metadata.previous_failures, and is delivered to the next worker that claims the task. ' +
      'Call shape: comment_add({ task_id: <integer>, content: "<string>", author: "<string (optional)>" }). The parameter is "task_id" (not "id"). Required: task_id, content.',
    annotations: { title: 'Add Comment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Task ID to comment on' },
        content: { type: 'string', description: 'Comment text' },
        author: { type: 'string', description: 'Author name (optional)' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'comment_list',
    description:
      'List all comments on a task in chronological order. ' +
      'Call shape: comment_list({ task_id: <integer> }). The parameter is "task_id" (not "id").',
    annotations: { title: 'List Comments', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
];

function handleCommentAdd(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;
  const content = args.content as string;
  const author = (args.author as string) ?? null;

  // Verify task exists
  const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(taskId) as { id: number; title: string } | undefined;
  if (!task) throw new Error(`Task ${taskId} not found`);

  // BLINDSIGHT X2 bridge: a RECOVERY:-prefixed comment is not just a
  // breadcrumb — it is the worker-side write of the episodic memory that the
  // saga-verifier contract promises. The insert and the materialization of
  // tasks.metadata.attempt_history / previous_failures commit atomically, so
  // a task_get right after the call already carries the reflection and the
  // next claim delivers it to the re-claiming worker.
  const recoveryNote = parseRecoveryComment(content);
  const { comment, epicId, attemptCount } = db.transaction(() => {
    const inserted = db
      .prepare('INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?) RETURNING *')
      .get(taskId, author, content) as Record<string, unknown>;
    logActivity(db, 'comment', inserted.id as number, 'created', null, null, null,
      `Comment added to task '${task.title}'${author ? ` by ${author}` : ''}`);
    if (!recoveryNote) {
      return { comment: inserted, epicId: undefined, attemptCount: 0 };
    }
    const outcome = materializeTaskRecoveryMemory(db, taskId);
    const epicRow = db.prepare('SELECT epic_id FROM tasks WHERE id=?').get(taskId) as
      | { epic_id: number }
      | undefined;
    return {
      comment: inserted,
      epicId: epicRow?.epic_id,
      attemptCount: outcome.snapshot.attempt_count,
    };
  })();

  // Observation is emitted AFTER the DB transaction commits; journalEvent is
  // append-only and never throws, so it can never break the write path.
  if (recoveryNote) {
    journalEvent('recovery.note_recorded', {
      epic_id: epicId,
    }, {
      task_id: taskId,
      comment_id: comment.id as number,
      attempt_count: attemptCount,
      recovery_summary: recoveryNote.summary,
    });
  }

  return comment;
}

function handleCommentList(args: Record<string, unknown>) {
  const db = getDb();
  const taskId = args.task_id as number;

  return db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId);
}

export const handlers: Record<string, ToolHandler> = {
  comment_add: handleCommentAdd,
  comment_list: handleCommentList,
};
