export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'on_hold' | 'completed' | 'archived';
  tags: string; // JSON array as text
  metadata: string; // JSON object as text
  created_at: string;
  updated_at: string;
}

export interface Epic {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'critical';
  sort_order: number;
  branch: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'review_in_progress'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: number;
  epic_id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  sort_order: number;
  assigned_to: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  source_ref: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Subtask {
  id: number;
  task_id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  note_type: 'general' | 'decision' | 'context' | 'meeting' | 'technical' | 'blocker' | 'progress' | 'release';
  related_entity_type: 'project' | 'epic' | 'task' | null;
  related_entity_id: number | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  summary: string | null;
  created_at: string;
}

// ─── Kernel ───

/** n8n-style execution statuses. `waiting` is a legitimate pause and is never
 *  treated as a crash; only `new | running` may be marked `crashed`. */
export type ExecutionStatus = 'new' | 'running' | 'waiting' | 'success' | 'error' | 'canceled' | 'crashed';

export interface WorkflowRow {
  id: string;
  name: string;
  version: number;
  graph_json: string;
  created_at: string;
}

export interface RunRow {
  id: string;
  workflow_id: string;
  root_run_id: string | null;
  status: ExecutionStatus;
  wait_till: string | null;
  next_seq: number;
  writer_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
}

export interface MaterialRow {
  digest: string;
  schema_ref: string;
  content: string;
  ts: string;
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;
