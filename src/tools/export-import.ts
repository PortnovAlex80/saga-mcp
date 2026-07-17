import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'tracker_export',
    description:
      'Export a full project as nested JSON. Includes all epics, tasks, subtasks, comments, dependencies, and related notes. Useful for backup, migration, or sharing.',
    annotations: { title: 'Export Project', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'integer',
          description: 'Project ID to export (omit if only one project exists)',
        },
      },
    },
  },
  {
    name: 'tracker_import',
    description:
      'Import a project from JSON (matching tracker_export format). Creates all entities with new IDs and remaps references. Uses a transaction for atomicity.',
    annotations: { title: 'Import Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          description: 'Full export JSON object from tracker_export',
        },
      },
      required: ['data'],
    },
  },
];

function handleExport(args: Record<string, unknown>) {
  const db = getDb();

  let projectId = args.project_id as number | undefined;
  if (!projectId) {
    const first = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number } | undefined;
    if (!first) throw new Error('No projects found. Create a project first.');
    projectId = first.id;
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
  if (!project) throw new Error(`Project ${projectId} not found`);

  const epics = db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY sort_order, created_at')
    .all(projectId) as Array<Record<string, unknown>>;

  const epicData = epics.map((epic) => {
    const tasks = db.prepare('SELECT * FROM tasks WHERE epic_id = ? ORDER BY sort_order, created_at')
      .all(epic.id as number) as Array<Record<string, unknown>>;

    const taskData = tasks.map((task) => {
      const taskId = task.id as number;

      const subtasks = db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
        .all(taskId) as Array<Record<string, unknown>>;

      const comments = db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC')
        .all(taskId) as Array<Record<string, unknown>>;

      const deps = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?')
        .all(taskId) as Array<{ depends_on_task_id: number }>;

      return {
        _original_id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        sort_order: task.sort_order,
        assigned_to: task.assigned_to,
        estimated_hours: task.estimated_hours,
        actual_hours: task.actual_hours,
        due_date: task.due_date,
        source_ref: task.source_ref,
        task_kind: task.task_kind,
        workflow_stage: task.workflow_stage,
        execution_skill: task.execution_skill,
        review_skill: task.review_skill,
        execution_mode: task.execution_mode,
        _original_project_repository_id: task.project_repository_id,
        integration_state: task.integration_state,
        integrated_at: task.integrated_at,
        integrated_commit: task.integrated_commit,
        _original_generated_from_task_id: task.generated_from_task_id,
        generation_key: task.generation_key,
        tags: task.tags,
        metadata: task.metadata,
        depends_on: deps.map((d) => d.depends_on_task_id),
        subtasks: subtasks.map((s) => ({
          title: s.title,
          status: s.status,
          sort_order: s.sort_order,
        })),
        comments: comments.map((c) => ({
          author: c.author,
          content: c.content,
          created_at: c.created_at,
        })),
      };
    });

    return {
      _original_id: epic.id,
      name: epic.name,
      description: epic.description,
      status: epic.status,
      priority: epic.priority,
      sort_order: epic.sort_order,
      branch: epic.branch,
      tags: epic.tags,
      metadata: epic.metadata,
      workflow: db.prepare('SELECT * FROM episode_workflows WHERE epic_id=?').get(epic.id),
      tasks: taskData,
    };
  });

  // Collect notes linked to this project, its epics, or its tasks
  const notes: Array<Record<string, unknown>> = [];

  notes.push(...db.prepare(
    `SELECT * FROM notes WHERE related_entity_type = 'project' AND related_entity_id = ?`
  ).all(projectId) as Array<Record<string, unknown>>);

  const epicIds = epics.map((e) => e.id as number);
  if (epicIds.length > 0) {
    const placeholders = epicIds.map(() => '?').join(',');
    notes.push(...db.prepare(
      `SELECT * FROM notes WHERE related_entity_type = 'epic' AND related_entity_id IN (${placeholders})`
    ).all(...epicIds) as Array<Record<string, unknown>>);
  }

  const allTaskIds: number[] = [];
  for (const epic of epics) {
    const tasks = db.prepare('SELECT id FROM tasks WHERE epic_id = ?')
      .all(epic.id as number) as Array<{ id: number }>;
    allTaskIds.push(...tasks.map((t) => t.id));
  }
  if (allTaskIds.length > 0) {
    const placeholders = allTaskIds.map(() => '?').join(',');
    notes.push(...db.prepare(
      `SELECT * FROM notes WHERE related_entity_type = 'task' AND related_entity_id IN (${placeholders})`
    ).all(...allTaskIds) as Array<Record<string, unknown>>);
  }

  // Include unlinked notes
  notes.push(...db.prepare(
    'SELECT * FROM notes WHERE related_entity_type IS NULL'
  ).all() as Array<Record<string, unknown>>);

  const noteData = notes.map((n) => ({
    title: n.title,
    content: n.content,
    note_type: n.note_type,
    related_entity_type: n.related_entity_type,
    _original_related_entity_id: n.related_entity_id,
    tags: n.tags,
    metadata: n.metadata,
  }));
  const repositoryRows = db.prepare(`
    SELECT pr.id AS _original_id, pr.role, pr.local_path, pr.integration_branch,
           pr.docs_root, pr.status, pr.metadata,
           r.name, r.remote_url, r.default_branch
      FROM project_repositories pr JOIN repositories r ON r.id=pr.repository_id
     WHERE pr.project_id=? ORDER BY pr.id
  `).all(projectId) as Array<Record<string, unknown>>;
  const repositoryData = repositoryRows.map(repo => ({
    ...repo,
    checkouts: db.prepare(
      `SELECT machine_id,local_path,status,metadata,last_seen_at
       FROM repository_checkouts WHERE project_repository_id=? ORDER BY machine_id`,
    ).all(repo._original_id),
  }));
  const artifactData = db.prepare(
    `SELECT * FROM artifacts WHERE project_id=? ORDER BY epic_id,id`,
  ).all(projectId) as Array<Record<string, unknown>>;
  const artifactIds = artifactData.map(a => a.id as number);
  const traceData = artifactIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM artifact_traces WHERE source_id IN (${artifactIds.map(() => '?').join(',')})`,
  ).all(...artifactIds);
  const evidenceData = artifactIds.length === 0 ? [] : db.prepare(
    `SELECT * FROM verification_evidence WHERE artifact_id IN (${artifactIds.map(() => '?').join(',')})`,
  ).all(...artifactIds);

  return {
    format_version: '1.4',
    exported_at: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description,
      status: project.status,
      tags: project.tags,
      metadata: project.metadata,
      repositories: repositoryData,
      epics: epicData,
      artifacts: artifactData,
      artifact_traces: traceData,
      verification_evidence: evidenceData,
    },
    notes: noteData,
  };
}

function handleImport(args: Record<string, unknown>) {
  const db = getDb();
  const data = args.data as Record<string, unknown>;

  const version = data.format_version as string;
  if (!['1.0', '1.1', '1.2', '1.3', '1.4'].includes(version)) {
    throw new Error(`Unsupported format version: ${version}. Expected 1.0 through 1.4.`);
  }

  const projectData = data.project as Record<string, unknown>;
  if (!projectData || !projectData.name) {
    throw new Error('Invalid import data: missing project or project.name');
  }

  const result = db.transaction(() => {
    const epicIdMap = new Map<number, number>();
    const taskIdMap = new Map<number, number>();
    const repositoryBindingIdMap = new Map<number, number>();
    const artifactIdMap = new Map<number, number>();

    // 1. Create project
    const project = db.prepare(
      'INSERT INTO projects (name, description, status, tags, metadata) VALUES (?, ?, ?, ?, ?) RETURNING *'
    ).get(
      projectData.name,
      projectData.description ?? null,
      projectData.status ?? 'active',
      projectData.tags ?? '[]',
      projectData.metadata ?? '{}'
    ) as Record<string, unknown>;

    const newProjectId = project.id as number;
    logActivity(db, 'project', newProjectId, 'created', null, null, null, `Project '${projectData.name}' imported`);

    const repositoryData = (projectData.repositories as Array<Record<string, unknown>>) ?? [];
    for (const repoData of repositoryData) {
      const repo = db.prepare(`
        INSERT INTO repositories (name,remote_url,default_branch)
        VALUES (?,?,?) RETURNING id
      `).get(repoData.name, repoData.remote_url ?? null, repoData.default_branch ?? 'main') as { id: number };
      const binding = db.prepare(`
        INSERT INTO project_repositories
          (project_id,repository_id,role,local_path,integration_branch,docs_root,status,metadata)
        VALUES (?,?,?,?,?,?,?,?) RETURNING id
      `).get(
        newProjectId, repo.id, repoData.role ?? 'component', repoData.local_path ?? null,
        repoData.integration_branch ?? 'dev', repoData.docs_root ?? null,
        repoData.status ?? 'active', repoData.metadata ?? '{}',
      ) as { id: number };
      if (repoData._original_id != null) {
        repositoryBindingIdMap.set(repoData._original_id as number, binding.id);
      }
      for (const checkout of (repoData.checkouts as Array<Record<string, unknown>>) ?? []) {
        db.prepare(
          `INSERT INTO repository_checkouts
           (project_repository_id,machine_id,local_path,status,metadata,last_seen_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(binding.id, checkout.machine_id, checkout.local_path, checkout.status ?? 'active',
          checkout.metadata ?? '{}', checkout.last_seen_at ?? new Date().toISOString());
      }
    }

    // 2. Create epics and their children
    const epics = (projectData.epics as Array<Record<string, unknown>>) ?? [];
    let epicCount = 0;
    let taskCount = 0;
    let subtaskCount = 0;
    let commentCount = 0;
    let depCount = 0;

    // Collect deferred dependencies (need all tasks created first)
    const deferredDeps: Array<{ newTaskId: number; originalDeps: number[] }> = [];
    const deferredGeneratedFrom: Array<{ newTaskId: number; originalTaskId: number }> = [];

    for (const epicData of epics) {
      const epic = db.prepare(
        `INSERT INTO epics (project_id, name, description, status, priority, sort_order, branch, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).get(
        newProjectId,
        epicData.name,
        epicData.description ?? null,
        epicData.status ?? 'planned',
        epicData.priority ?? 'medium',
        epicData.sort_order ?? 0,
        epicData.branch ?? null,
        epicData.tags ?? '[]',
        epicData.metadata ?? '{}'
      ) as Record<string, unknown>;

      const newEpicId = epic.id as number;
      if (epicData._original_id != null) {
        epicIdMap.set(epicData._original_id as number, newEpicId);
      }
      epicCount++;
      logActivity(db, 'epic', newEpicId, 'created', null, null, null, `Epic '${epicData.name}' imported`);

      // 3. Create tasks
      const tasks = (epicData.tasks as Array<Record<string, unknown>>) ?? [];
      for (const taskData of tasks) {
        const task = db.prepare(
          `INSERT INTO tasks (epic_id, title, description, status, priority, sort_order,
           assigned_to, estimated_hours, actual_hours, due_date, source_ref,
           task_kind,workflow_stage,execution_skill,review_skill,execution_mode,
           project_repository_id,integration_state,integrated_at,integrated_commit,
           generation_key,tags,metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        ).get(
          newEpicId,
          taskData.title,
          taskData.description ?? null,
          taskData.status ?? 'todo',
          taskData.priority ?? 'medium',
          taskData.sort_order ?? 0,
          taskData.assigned_to ?? null,
          taskData.estimated_hours ?? null,
          taskData.actual_hours ?? null,
          taskData.due_date ?? null,
          taskData.source_ref ?? null,
          taskData.task_kind ?? null,
          taskData.workflow_stage ?? null,
          taskData.execution_skill ?? null,
          taskData.review_skill ?? null,
          taskData.execution_mode ?? 'git_change',
          taskData._original_project_repository_id == null
            ? null
            : repositoryBindingIdMap.get(taskData._original_project_repository_id as number) ?? null,
          taskData.integration_state ?? 'not_required',
          taskData.integrated_at ?? null,
          taskData.integrated_commit ?? null,
          taskData.generation_key ?? null,
          taskData.tags ?? '[]',
          taskData.metadata ?? '{}'
        ) as Record<string, unknown>;

        const newTaskId = task.id as number;
        if (taskData._original_id != null) {
          taskIdMap.set(taskData._original_id as number, newTaskId);
        }
        taskCount++;
        logActivity(db, 'task', newTaskId, 'created', null, null, null, `Task '${taskData.title}' imported`);

        // Defer dependency creation
        const originalDeps = (taskData.depends_on as number[]) ?? [];
        if (originalDeps.length > 0) {
          deferredDeps.push({ newTaskId, originalDeps });
        }
        if (taskData._original_generated_from_task_id != null) {
          deferredGeneratedFrom.push({
            newTaskId,
            originalTaskId: taskData._original_generated_from_task_id as number,
          });
        }

        // 4. Create subtasks
        const subtasks = (taskData.subtasks as Array<Record<string, unknown>>) ?? [];
        for (const subtaskData of subtasks) {
          const subtask = db.prepare(
            'INSERT INTO subtasks (task_id, title, status, sort_order) VALUES (?, ?, ?, ?) RETURNING *'
          ).get(
            newTaskId,
            subtaskData.title,
            subtaskData.status ?? 'todo',
            subtaskData.sort_order ?? 0
          ) as Record<string, unknown>;

          subtaskCount++;
          logActivity(db, 'subtask', subtask.id as number, 'created', null, null, null, `Subtask '${subtaskData.title}' imported`);
        }

        // 5. Create comments
        const comments = (taskData.comments as Array<Record<string, unknown>>) ?? [];
        for (const commentData of comments) {
          db.prepare(
            'INSERT INTO comments (task_id, author, content) VALUES (?, ?, ?)'
          ).run(newTaskId, commentData.author ?? null, commentData.content);
          commentCount++;
        }
      }
      const workflow = epicData.workflow as Record<string, unknown> | undefined;
      if (workflow) {
        db.prepare(
          `INSERT INTO episode_workflows (epic_id,stage,baseline_hash,metadata)
           VALUES (?,?,?,?)`,
        ).run(newEpicId, workflow.stage ?? 'discovery', workflow.baseline_hash ?? null, workflow.metadata ?? '{}');
      }
    }

    // 6. Create dependencies with ID remapping
    const depInsert = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
    for (const { newTaskId, originalDeps } of deferredDeps) {
      for (const origDepId of originalDeps) {
        const newDepId = taskIdMap.get(origDepId);
        if (newDepId != null) {
          depInsert.run(newTaskId, newDepId);
          depCount++;
        }
      }

    }
    for (const { newTaskId, originalTaskId } of deferredGeneratedFrom) {
      const mapped = taskIdMap.get(originalTaskId);
      if (mapped != null) {
        db.prepare('UPDATE tasks SET generated_from_task_id=? WHERE id=?').run(mapped, newTaskId);
      }
    }

    // 7. Requirements artifacts, traces and immutable verification evidence.
    const artifacts = (projectData.artifacts as Array<Record<string, unknown>>) ?? [];
    const deferredParents: Array<{ id: number; parent: number }> = [];
    for (const artifact of artifacts) {
      const mappedEpic = epicIdMap.get(artifact.epic_id as number);
      if (!mappedEpic) continue;
      const inserted = db.prepare(
        `INSERT INTO artifacts
         (project_id,epic_id,type,code,title,path,status,project_repository_id,
          content_hash,accepted_hash,drift_state,tags,metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      ).get(
        newProjectId, mappedEpic, artifact.type, artifact.code ?? null, artifact.title,
        artifact.path, artifact.status ?? 'draft',
        artifact.project_repository_id == null ? null
          : repositoryBindingIdMap.get(artifact.project_repository_id as number) ?? null,
        artifact.content_hash ?? null, artifact.accepted_hash ?? null,
        artifact.drift_state ?? 'unknown', artifact.tags ?? '[]', artifact.metadata ?? '{}',
      ) as { id: number };
      artifactIdMap.set(artifact.id as number, inserted.id);
      if (artifact.parent_artifact_id != null) {
        deferredParents.push({ id: inserted.id, parent: artifact.parent_artifact_id as number });
      }
    }
    for (const parent of deferredParents) {
      const mapped = artifactIdMap.get(parent.parent);
      if (mapped) db.prepare('UPDATE artifacts SET parent_artifact_id=? WHERE id=?').run(mapped, parent.id);
    }
    for (const trace of (projectData.artifact_traces as Array<Record<string, unknown>>) ?? []) {
      const source = artifactIdMap.get(trace.source_id as number);
      const target = trace.target_type === 'artifact'
        ? artifactIdMap.get(trace.target_id as number)
        : taskIdMap.get(trace.target_id as number);
      if (source && target) {
        db.prepare(
          `INSERT OR IGNORE INTO artifact_traces (source_id,target_type,target_id,link_type)
           VALUES (?,?,?,?)`,
        ).run(source, trace.target_type, target, trace.link_type);
      }
    }
    for (const evidence of (projectData.verification_evidence as Array<Record<string, unknown>>) ?? []) {
      const task = taskIdMap.get(evidence.task_id as number);
      const artifact = artifactIdMap.get(evidence.artifact_id as number);
      if (task && artifact) {
        db.prepare(
          `INSERT INTO verification_evidence
           (task_id,artifact_id,outcome,evidence,content_hash,recorded_by,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(task, artifact, evidence.outcome, evidence.evidence, evidence.content_hash ?? null,
          evidence.recorded_by ?? null, evidence.created_at ?? new Date().toISOString());
      }
    }
    for (const epicData of epics) {
      const workflow = epicData.workflow as Record<string, unknown> | undefined;
      if (!workflow?.baseline_artifact_id) continue;
      const epic = epicIdMap.get(epicData._original_id as number);
      const baseline = artifactIdMap.get(workflow.baseline_artifact_id as number);
      if (epic && baseline) {
        db.prepare('UPDATE episode_workflows SET baseline_artifact_id=? WHERE epic_id=?').run(baseline, epic);
      }
    }

    // 8. Create notes with ID remapping
    const importNotes = (data.notes as Array<Record<string, unknown>>) ?? [];
    let noteCount = 0;

    for (const noteData of importNotes) {
      let relatedEntityType = noteData.related_entity_type as string | null;
      let relatedEntityId: number | null = null;
      const originalId = noteData._original_related_entity_id as number | null;

      if (relatedEntityType && originalId != null) {
        if (relatedEntityType === 'project') {
          relatedEntityId = newProjectId;
        } else if (relatedEntityType === 'epic') {
          relatedEntityId = epicIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        } else if (relatedEntityType === 'task') {
          relatedEntityId = taskIdMap.get(originalId) ?? null;
          if (relatedEntityId === null) relatedEntityType = null;
        }
      }

      const note = db.prepare(
        `INSERT INTO notes (title, content, note_type, related_entity_type, related_entity_id, tags, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).get(
        noteData.title,
        noteData.content,
        noteData.note_type ?? 'general',
        relatedEntityType,
        relatedEntityId,
        noteData.tags ?? '[]',
        noteData.metadata ?? '{}'
      ) as Record<string, unknown>;

      noteCount++;
      logActivity(db, 'note', note.id as number, 'created', null, null, null, `Note '${noteData.title}' imported`);
    }

    return {
      message: 'Import complete.',
      project_id: newProjectId,
      project_name: projectData.name,
      counts: { epics: epicCount, tasks: taskCount, subtasks: subtaskCount, comments: commentCount, dependencies: depCount, notes: noteCount },
    };
  })();

  return result;
}

export const handlers: Record<string, ToolHandler> = {
  tracker_export: handleExport,
  tracker_import: handleImport,
};
