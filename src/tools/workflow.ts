import type Database from 'better-sqlite3';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { routeFastTrack } from '../planner/fast-track.js';
import type { BriefPayload } from '../validators/brief.js';
import type { Task, ToolHandler } from '../types.js';

type GeneratedResult = {
  transition: string;
  source_task_id: number;
  created: number[];
  reused: number[];
  tasks: Task[];
};

type TaskSpec = {
  key: string;
  title: string;
  kind: string;
  stage: string;
  executionSkill: string;
  reviewSkill: string;
  mode: Task['execution_mode'];
  repositoryId: number | null;
  sourceTaskId: number;
  dependencies: number[];
};

function insertGeneratedTask(db: Database.Database, epicId: number, spec: TaskSpec): { task: Task; created: boolean } {
  const existing = db.prepare(
    'SELECT * FROM tasks WHERE epic_id=? AND generation_key=?',
  ).get(epicId, spec.key) as Task | undefined;
  if (existing) return { task: existing, created: false };

  const unmet = spec.dependencies.some(id => {
    const dep = db.prepare('SELECT status FROM tasks WHERE id=? AND epic_id=?').get(id, epicId) as { status: string } | undefined;
    if (!dep) throw new Error(`Dependency task ${id} is missing from epic ${epicId}`);
    return dep.status !== 'done';
  });
  const status = unmet ? 'blocked' : 'todo';
  const task = db.prepare(`
    INSERT INTO tasks
      (epic_id,title,description,status,priority,task_kind,workflow_stage,
       execution_skill,review_skill,execution_mode,project_repository_id,
       generated_from_task_id,generation_key,tags,metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING *
  `).get(
    epicId,
    spec.title,
    `Generated from task #${spec.sourceTaskId}. generation_key=${spec.key}`,
    status,
    'high',
    spec.kind,
    spec.stage,
    spec.executionSkill,
    spec.reviewSkill,
    spec.mode,
    spec.repositoryId,
    spec.sourceTaskId,
    spec.key,
    JSON.stringify([`stage:${spec.stage}`, `kind:${spec.kind}`]),
    JSON.stringify({ generated: true, source_task_id: spec.sourceTaskId }),
  ) as Task;
  const depInsert = db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id,depends_on_task_id) VALUES (?,?)',
  );
  for (const dependency of spec.dependencies) depInsert.run(task.id, dependency);
  logActivity(db, 'task', task.id, 'created', 'generation_key', null, spec.key,
    `Workflow generated '${task.title}' from task ${spec.sourceTaskId}`);
  return { task, created: true };
}

function sibling(db: Database.Database, epicId: number, sourceParentId: number | null, kind: string): Task | undefined {
  if (sourceParentId == null) return undefined;
  return db.prepare(`
    SELECT * FROM tasks
     WHERE epic_id=? AND generated_from_task_id=? AND task_kind=?
     ORDER BY id LIMIT 1
  `).get(epicId, sourceParentId, kind) as Task | undefined;
}

function specsForTransition(db: Database.Database, source: Task, transition: string): TaskSpec[] {
  const repo = source.project_repository_id;
  // brief_accepted — seeds formalization from Discovery (ADR-008).
  //
  // When the `discovery.kickstart` task completes, the v3 engine needs a
  // PRD task to appear so the formalization chain (prd_accepted → SRS+UC →
  // srs_accepted/uc_accepted → AC → ac_accepted → reconciliation →
  // baseline_accepted → planning) can proceed. This branch creates
  // EXACTLY ONE formalization.prd task — NOT PRD+SRS as the original 3.0
  // plan draft said. The "parallel SRS" wording was a simplification that
  // would break the sibling() lineage lookup in srs_accepted; see
  // docs/architecture/decisions/008-brief-accepted-prd-only.md.
  //
  // Decision guard: only seed PRD when brief decision === 'go'. Other
  // outcomes have their own paths (clarify/reject stop; fast-track goes
  // through routeFastTrack in src/planner/fast-track.ts).
  if (transition === 'brief_accepted') {
    if (source.task_kind !== 'discovery.kickstart') {
      throw new Error(`Transition brief_accepted requires task_kind=discovery.kickstart, got '${source.task_kind}'`);
    }
    // Read the brief artifact to check decision and inherit its repository binding.
    const brief = db.prepare(
      `SELECT id, project_repository_id, metadata FROM artifacts
       WHERE epic_id=? AND type='brief' ORDER BY id DESC LIMIT 1`,
    ).get(source.epic_id) as
      | { id: number; project_repository_id: number | null; metadata: string | null }
      | undefined;
    if (!brief) {
      throw new Error(
        `brief_accepted for task ${source.id}: no brief artifact in epic ${source.epic_id}. ` +
        `Kickstart must register a brief via artifact_create({type:'brief'}) before completing.`,
      );
    }
    let decision: string | undefined;
    let briefPayload: BriefPayload | undefined;
    try {
      const meta = JSON.parse(brief.metadata ?? '{}');
      briefPayload = meta?.brief_payload;
      decision = briefPayload?.decision;
    } catch { /* malformed metadata → decision stays undefined, falls to default */ }

    // ADR-012 — 4-way decision switch. Previously all non-'go' decisions
    // returned [] silently, leaving the engine to wander into formalization
    // with no tasks and hit a gate failure. Now each decision takes its
    // own path. 'clarify' and 'reject' still return [] because the engine
    // itself is responsible for the pause/cancel side-effects — a tool
    // handler must stay a pure DB op, not a control-flow side-effect.
    switch (decision) {
      case 'go': {
        const prdRepo = brief.project_repository_id ?? repo;
        return [{
          key: `brief:${source.id}:prd`,
          title: `PRD: ${source.title.replace(/^Discovery:\s*/i, '')}`,
          kind: 'formalization.prd',
          stage: 'formalization',
          executionSkill: 'saga-product',
          reviewSkill: 'saga-requirements-reviewer',
          // tracker_only: formalization artifacts are markdown docs registered
          // in the artifacts table; they do NOT go through git integration.
          // tracker_only avoids the integration_state='pending' trap that
          // previously left downstream tasks (SRS/UC) permanently blocked
          // because dependency-checker requires integration_state='merged'
          // for git_change tasks.
          mode: 'tracker_only',
          repositoryId: prdRepo,
          sourceTaskId: source.id,
          dependencies: [source.id],
        }];
      }
      case 'fast-track': {
        // routeFastTrack is the planner's fast-channel router (AC-6). It
        // creates the dev task directly, sets episode_workflows.stage=
        // 'development' via SQL (bypassing episode_transition, which would
        // reject the jump), and writes metadata.fast_track=1. We stamp
        // episode_workflows.track='fast-track' so downstream code knows
        // which pipeline this episode is on.
        if (!briefPayload) {
          throw new Error(
            `brief_accepted fast-track for task ${source.id}: brief metadata has no brief_payload`,
          );
        }
        const routing = routeFastTrack(brief.id, source.epic_id, briefPayload, db);
        db.prepare(
          `UPDATE episode_workflows SET track='fast-track' WHERE epic_id=? AND track='formal'`,
        ).run(source.epic_id);
        logActivity(db, 'task', source.id, 'created', 'fast_track_dev_task', null, String(routing.dev_task_id),
          `brief_accepted(fast-track) routed dev task #${routing.dev_task_id} directly into development (track='fast-track')`);
        // Return [] — routeFastTrack already created the dev task; the
        // engine will observe stage='development' on the next cycle and
        // proceed from there. No formalization tasks to insert here.
        return [];
      }
      case 'clarify':
      case 'reject':
        // Engine-side responsibility. Return [] and let the engine's
        // main loop inspect the brief decision when generateNextIfReady
        // produces no work (orchestrate.ts: ~line 1080, ADR-012 branch).
        return [];
      default:
        // Unknown/missing decision — behave like 'clarify' (halt). The
        // engine will surface the situation for human review rather than
        // silently wandering into formalization.
        return [];
    }
  }

  if (transition === 'prd_accepted') {
    if (source.task_kind !== 'formalization.prd') {
      throw new Error(`Transition prd_accepted requires task_kind=formalization.prd, got '${source.task_kind}'`);
    }
    return [
      {
        key: `prd:${source.id}:srs`, title: `SRS: ${source.title}`, kind: 'formalization.srs',
        stage: 'formalization', executionSkill: 'saga-architect', reviewSkill: 'saga-architecture-reviewer',
        mode: 'tracker_only', repositoryId: repo, sourceTaskId: source.id, dependencies: [source.id],
      },
      {
        key: `prd:${source.id}:uc`, title: `UC: ${source.title}`, kind: 'formalization.uc',
        stage: 'formalization', executionSkill: 'saga-analyst', reviewSkill: 'saga-requirements-reviewer',
        mode: 'tracker_only', repositoryId: repo, sourceTaskId: source.id, dependencies: [source.id],
      },
    ];
  }

  // srs_accepted / uc_accepted → formalization.ac
  //
  // Both SRS and UC must be done before AC can be written — AC derives
  // from UC (behavioural scenarios) and SRS (FR/NFR invariants). The
  // previous design spawned formalization.reconciliation here, which
  // silently ran saga-reconciler and *only then* declared the baseline
  // accepted — skipping AC creation entirely. saga-analyst then never
  // got invoked for AC, and the engine's recovery band-aid (orchestrate.ts
  // RECOVERY_TREE.formalization[0]) had to write the ACs as a workaround.
  //
  // New semantics: whichever of SRS/UC finishes SECOND is the trigger.
  // The first one returns [] (waiting); the second one returns the AC
  // task spec, with deps on BOTH siblings so AC unblocks only when both
  // are done. saga-analyst (Stage 4 — Formalization-AC per its SKILL)
  // is now the legitimate executor for AC artifacts.
  if (transition === 'srs_accepted' || transition === 'uc_accepted') {
    const expected = transition === 'srs_accepted' ? 'formalization.srs' : 'formalization.uc';
    const counterpartKind = transition === 'srs_accepted' ? 'formalization.uc' : 'formalization.srs';
    if (source.task_kind !== expected) {
      throw new Error(`Transition ${transition} requires task_kind=${expected}, got '${source.task_kind}'`);
    }
    const counterpart = sibling(db, source.epic_id, source.generated_from_task_id, counterpartKind);
    // Counterpart SRS/UC not done yet — wait. When counterpart completes,
    // ITS transition (uc_accepted or srs_accepted) will fire and produce
    // the AC task. Returning [] is the engine's signal to keep cycling.
    if (!counterpart || counterpart.status !== 'done') {
      return [];
    }
    const prdId = source.generated_from_task_id as number;
    return [{
      key: `prd:${prdId}:ac`,
      title: `AC: ${source.title.replace(/^(SRS|UC):\s*/i, '')}`,
      kind: 'formalization.ac',
      stage: 'formalization',
      executionSkill: 'saga-analyst',
      reviewSkill: 'saga-requirements-reviewer',
      mode: 'tracker_only',
      repositoryId: repo ?? counterpart.project_repository_id,
      sourceTaskId: source.id,
      dependencies: [source.id, counterpart.id],
    }];
  }

  // ac_accepted → formalization.reconciliation
  //
  // Once AC artifacts are written and accepted, the reconciliation task
  // re-checks consistency across PRD/SRS/UC/AC (FR↔AC traceability,
  // orphan ACs, missing properties) and stamps the baseline_hash.
  // Previously baseline_accepted was the transition that did this, fired
  // from a reconciliation task; now reconciliation is fired FROM the AC
  // task, and baseline_accepted (still fired from reconciliation) advances
  // the episode into planning.
  if (transition === 'ac_accepted') {
    if (source.task_kind !== 'formalization.ac') {
      throw new Error(`Transition ac_accepted requires task_kind=formalization.ac, got '${source.task_kind}'`);
    }
    const prdId = source.generated_from_task_id as number;
    // Look up both SRS and UC siblings to add as deps — reconciliation
    // is the place the planner checks PRD↔SRS↔UC↔AC traceability.
    const srs = sibling(db, source.epic_id, prdId, 'formalization.srs');
    const uc = sibling(db, source.epic_id, prdId, 'formalization.uc');
    const deps = [source.id];
    if (srs) deps.push(srs.id);
    if (uc) deps.push(uc.id);
    return [{
      key: `prd:${prdId}:reconciliation`,
      title: `Reconcile SRS + UC + AC for PRD task #${prdId}`,
      kind: 'formalization.reconciliation',
      stage: 'formalization',
      executionSkill: 'saga-reconciler',
      reviewSkill: 'saga-requirements-reviewer',
      mode: 'tracker_only',
      repositoryId: repo,
      sourceTaskId: source.id,
      dependencies: deps,
    }];
  }

  if (transition === 'baseline_accepted') {
    if (source.task_kind !== 'formalization.reconciliation') {
      throw new Error(`Transition baseline_accepted requires task_kind=formalization.reconciliation, got '${source.task_kind}'`);
    }
    return [{
      key: `reconciliation:${source.id}:planning`,
      title: `Decompose accepted baseline from task #${source.id}`,
      kind: 'planning.decomposition',
      stage: 'planning',
      executionSkill: 'saga-planner',
      reviewSkill: 'saga-planning-reviewer',
      mode: 'tracker_only',
      repositoryId: null,
      sourceTaskId: source.id,
      dependencies: [source.id],
    }];
  }

  throw new Error(`Unknown workflow transition '${transition}'`);
}

function handleWorkflowGenerateNext(args: Record<string, unknown>): GeneratedResult {
  const db = getDb();
  const sourceId = args.source_task_id as number;
  const epicId = args.epic_id as number;
  const transition = String(args.transition ?? '');
  const source = db.prepare('SELECT * FROM tasks WHERE id=?').get(sourceId) as Task | undefined;
  if (!source) throw new Error(`Source task ${sourceId} not found`);
  if (source.epic_id !== epicId) throw new Error(`Source task ${sourceId} does not belong to epic ${epicId}`);
  if (source.status !== 'done') {
    throw new Error(`Source task ${sourceId} must be done before downstream generation (status=${source.status})`);
  }
  if (!source.task_kind) throw new Error(`Source task ${sourceId} is legacy/untyped and cannot auto-generate downstream work`);

  return db.transaction(() => {
    const specs = specsForTransition(db, source, transition);
    const result: GeneratedResult = {
      transition, source_task_id: sourceId, created: [], reused: [], tasks: [],
    };
    for (const spec of specs) {
      const inserted = insertGeneratedTask(db, epicId, spec);
      result.tasks.push(inserted.task);
      (inserted.created ? result.created : result.reused).push(inserted.task.id);
    }
    return result;
  })();
}

export function generateNextForCompletedTask(taskId: number): GeneratedResult | null {
  const db = getDb();
  const task = db.prepare('SELECT id,epic_id,task_kind,status FROM tasks WHERE id=?').get(taskId) as
    | { id: number; epic_id: number; task_kind: string | null; status: string }
    | undefined;
  if (!task || task.status !== 'done') return null;
  const transition = task.task_kind === 'discovery.kickstart' ? 'brief_accepted'
    : task.task_kind === 'formalization.prd' ? 'prd_accepted'
    : task.task_kind === 'formalization.srs' ? 'srs_accepted'
    : task.task_kind === 'formalization.uc' ? 'uc_accepted'
    : task.task_kind === 'formalization.ac' ? 'ac_accepted'
    : task.task_kind === 'formalization.reconciliation' ? 'baseline_accepted'
    : null;
  if (!transition) return null;
  return handleWorkflowGenerateNext({
    epic_id: task.epic_id,
    source_task_id: task.id,
    transition,
  });
}

export const definitions: Tool[] = [{
  name: 'workflow_generate_next',
  description: 'Idempotently generate the next typed workflow tasks from one completed upstream task. Supported transitions: brief_accepted (kickstart→PRD only, ADR-008), prd_accepted (→SRS+UC), srs_accepted/uc_accepted (→formalization.ac when both siblings done), ac_accepted (→reconciliation), baseline_accepted (→planning).',
  annotations: { title: 'Workflow: Generate Next', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      epic_id: { type: 'integer' },
      source_task_id: { type: 'integer' },
      transition: { type: 'string', enum: ['brief_accepted', 'prd_accepted', 'srs_accepted', 'uc_accepted', 'ac_accepted', 'baseline_accepted'] },
    },
    required: ['epic_id', 'source_task_id', 'transition'],
  },
}];

export const handlers: Record<string, ToolHandler> = {
  workflow_generate_next: handleWorkflowGenerateNext,
};
