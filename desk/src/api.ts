// The desk speaks to the bridge only through read models and the two operator
// writes. There is no client-side state machine: the board and the wiki are
// what the kernel says they are.

export type CardStatus = 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'failed';

export interface Card {
  id: string;
  run_id: string;
  workflow: string;
  run_status: string;
  node_id: string;
  node_type: string;
  parent?: string;
  title: string;
  status: CardStatus;
  verdict?: string;
  reasons: string[];
  attempts: number;
  repairs: number;
  effect_outcome?: string;
  gate?: string;
  materials: number;
  updated_at: string;
  seq: number;
  action?: 'operator_decision';
}

export interface BoardData {
  columns: Array<{ status: CardStatus; cards: Card[] }>;
  runs: Array<{ run_id: string; workflow: string; status: string; created_at: string; updated_at: string }>;
  totals: Record<string, number>;
}

export interface Artifact {
  id: string;
  run_id: string;
  workflow: string;
  node_id: string;
  node_type: string;
  path?: string;
  name: string;
  digest: string;
  index: number;
  field: string;
  kind: 'markdown' | 'json' | 'code' | 'text' | 'receipt';
  bytes: number;
  accepted: boolean;
  seq: number;
  preview: string;
  editable: boolean;
}

export interface ArtifactBody extends Artifact {
  body: string;
  items: Array<{ json: Record<string, unknown> }>;
}

export interface WorkshopInput {
  name: string;
  label: string;
  kind: 'text' | 'longtext';
  required?: boolean;
  placeholder?: string;
}

export interface GateCheckView {
  op: string;
  field?: string;
  value?: string;
  pattern?: string;
  min_count?: number;
}

export interface SkillView {
  title: string;
  role: string;
  instruction: string;
  output?: string;
  input_label?: string;
  checks: GateCheckView[];
}

export interface DeskView {
  id: string;
  title: string;
  skill?: string;
  input: { kind: string; desk?: string; path?: string; field?: string };
  fanout: boolean;
  tools: Array<{ kind: string; path: string; label?: string }>;
  hooks: { before?: Array<Record<string, unknown>>; after?: Array<Record<string, unknown>> };
  checks?: GateCheckView[];
  publish?: { path?: string; files_from?: string };
}

export interface WorkshopInfo {
  title: string;
  graph: unknown;
  inputs: WorkshopInput[];
  desks: DeskView[];
  shape: Array<{ node: string; type: string; next: string[] }>;
}

export interface Limits {
  max_workers: number;
  min_spawn_interval_ms: number;
}

export interface WorkerView {
  execution_id: string;
  run_id: string;
  workflow: string;
  node_id: string;
  attempt: number;
  status: string;
  worker_kind: string | null;
  model?: string;
  mode?: string;
  prompt_preview?: string;
  started_at: string | null;
  heartbeat_at: string | null;
  elapsed_s: number;
  heartbeat_age_s: number | null;
  heartbeat_s: number;
  start_to_close_s: number | null;
  schedule_to_start_s: number;
  stale: boolean;
  progress: string;
  progress_chars: number;
  usage?: { input?: number; output?: number; reasoning?: number; cost?: number };
}

export interface WorkersData {
  limits: Limits;
  hired: number;
  stats: { running: number; queued: number; stale: number; succeeded: number; failed: number };
  live: WorkerView[];
  recent: WorkerView[];
}

export interface RunEvent {
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? response.statusText);
  }
  return data as T;
}

export const api = {
  board: (params: { active_only?: boolean; run_id?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.active_only) query.set('active_only', '1');
    if (params.run_id) query.set('run_id', params.run_id);
    return json<BoardData>(`/api/board?${query}`);
  },
  workshops: () => json<Record<string, WorkshopInfo>>('/api/workshops'),
  skills: () => json<Record<string, SkillView>>('/api/skills'),
  startWorkshop: (name: string, input: Record<string, unknown>) =>
    json<{ runId: string; status: string }>(`/api/workshops/${name}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }),
  runEvents: (runId: string, limit = 200) =>
    json<{ run: { status: string }; events: RunEvent[] }>(`/api/runs/${runId}/events?limit=${limit}`),
  resolve: (runId: string, node: string, decision: 'approve' | 'reject', note?: string) =>
    json(`/api/runs/${runId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node, decision, note }),
    }),
  artifacts: (params: { run_id?: string; accepted_only?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (params.run_id) query.set('run_id', params.run_id);
    if (params.accepted_only) query.set('accepted_only', '1');
    return json<Artifact[]>(`/api/artifacts?${query}`);
  },
  artifact: (artifact: Pick<Artifact, 'run_id' | 'node_id' | 'digest' | 'index'>) => {
    const query = new URLSearchParams({
      run_id: artifact.run_id,
      node: artifact.node_id,
      digest: artifact.digest,
      index: String(artifact.index),
    });
    return json<ArtifactBody>(`/api/artifact?${query}`);
  },
  submit: (runId: string, node: string, payload: { text?: string; items?: unknown[]; note?: string }) =>
    json<{ digest: string; run: { status: string } }>(
      `/api/runs/${runId}/nodes/${encodeURIComponent(node)}/submit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    ),
  resume: (runId: string) => json(`/api/runs/${runId}/resume`, { method: 'POST' }),
  workers: () => json<WorkersData>('/api/workers'),
  setLimits: (limits: Partial<Limits>) =>
    json<{ limits: Limits; hired: number }>('/api/limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(limits),
    }),
};
