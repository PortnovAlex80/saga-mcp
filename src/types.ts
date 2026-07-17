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
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  epic_id: number;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'review' | 'review_in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  // REQ-009 / CGAD §11 — RiskClass. declared_risk is proposed by the Builder;
  // derived_risk + policy_minimum are auto-derived from tags/task_kind (or set
  // explicitly); final_risk = max(declared, derived, policy_minimum) and is
  // always computed server-side. Any of these may be NULL in the DB row (e.g. a
  // plain task with no security/contract surface auto-derives derived_risk and
  // policy_minimum to null, and final_risk is then driven by declared_risk /
  // legacy priority). The runtime (src/tools/tasks.ts) may persist null when
  // auto-derivation yields no level — keep these nullable here to match the
  // schema, even though the user-facing input schemas use a non-null enum.
  declared_risk: 'low' | 'medium' | 'high' | 'critical' | null;
  derived_risk: 'low' | 'medium' | 'high' | 'critical' | null;
  policy_minimum: 'low' | 'medium' | 'high' | 'critical' | null;
  final_risk: 'low' | 'medium' | 'high' | 'critical' | null;
  sort_order: number;
  assigned_to: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  source_ref: string | null;
  task_kind: string | null;
  workflow_stage: string | null;
  execution_skill: string | null;
  review_skill: string | null;
  execution_mode: 'git_change' | 'tracker_only' | 'read_only_evidence' | 'interactive';
  project_repository_id: number | null;
  integration_state: 'not_required' | 'pending' | 'merged' | 'conflict';
  integrated_at: string | null;
  integrated_commit: string | null;
  generated_from_task_id: number | null;
  generation_key: string | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface Repository {
  id: number;
  name: string;
  remote_url: string | null;
  default_branch: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRepository {
  id: number;
  project_id: number;
  repository_id: number;
  role: string;
  local_path: string | null;
  integration_branch: string;
  docs_root: string | null;
  status: 'planned' | 'active' | 'on_hold' | 'archived';
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface RepositoryCheckout {
  id: number;
  project_repository_id: number;
  machine_id: string;
  local_path: string;
  status: 'active' | 'missing' | 'on_hold';
  metadata: string;
  last_seen_at: string;
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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;

// Requirements & design artifacts (PRD/SRS/UC/AC/FR/NFR/decision + theme/brief).
// One artifact = one .md doc + its status + optional parent (within-episode
// hierarchy) + code for querying (AC-1, FR-3).
//
// ArtifactType is the canonical union of artifact `type` literals. SRS-004 §2b.1.
// MUST stay in lock-step with `ArtifactTypeSchema` (src/schema.ts) and the SQL
// CHECK clause in SCHEMA_SQL. Additive only — never rename/remove existing
// literals (SRS §5 compatibility).
export type ArtifactType =
  | 'PRD' | 'SRS' | 'UC' | 'AC' | 'FR' | 'NFR' | 'decision'
  | 'theme'    // NEW — top-level business board
  | 'brief'    // NEW — discovery-phase output
  | 'RULE'     // NEW — business rule / policy artifact
  | 'OQ'       // NEW — open question / unresolved issue
  | 'SPEC'     // NEW — technical specification / design contract referenced by FRs
  | 'hypothesis'       // NEW — product discovery hypothesis
  | 'business_metric'; // NEW — metric definition referenced by hypothesis

export interface Artifact {
  id: number;
  project_id: number;
  epic_id: number;
  type: ArtifactType;
  code: string | null;
  title: string;
  path: string;
  status: 'draft' | 'in_review' | 'accepted' | 'superseded';
  parent_artifact_id: number | null;
  project_repository_id: number | null;
  content_hash: string | null;
  accepted_hash: string | null;
  drift_state: 'unknown' | 'clean' | 'drifted';
  evidence_status: 'confirmed' | 'proposed' | 'assumed' | 'open' | 'rejected' | 'superseded' | null;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

// Traceability edge. source = artifact; target = artifact OR task (polymorphic).
// link_type names the relation (covers/implements/derived_from/...).
export interface ArtifactTrace {
  id: number;
  source_id: number;
  target_type: 'artifact' | 'task';
  target_id: number;
  link_type: 'covers' | 'implements' | 'derived_from' | 'depends_on' | 'verified_by' | 'superseded_by' | 'implements_spec';
  created_at: string;
}

export interface TrustedProvider {
  id: number;
  project_id: number | null;
  category: 'deterministic_evidence' | 'authoritative_state' | 'authorized_decision';
  name: string;
  trust_basis: string;
  determinism: 'full' | 'partial' | 'none';
  scope: string;
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | null;
  version: string | null;
  config_path: string | null;
  status: 'active' | 'disabled' | 'deprecated';
  registered_at: string;
}
