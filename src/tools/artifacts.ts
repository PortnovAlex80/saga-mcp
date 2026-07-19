import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import { validateBrief } from '../validators/brief.js';
import { artifactDiskHash, refreshArtifactHash } from '../helpers/artifact-file.js';
import type { Artifact, ArtifactTrace, ToolHandler } from '../types.js';

// ============================================================================
// Requirements & design artifacts + traceability graph.
//
// Two tables:
//   artifacts       — PRD/SRS/UC/AC/FR/NFR/decision, with path to .md doc,
//                     status (draft/in_review/accepted/superseded), code (AC-1),
//                     parent_artifact_id (within-episode hierarchy).
//   artifact_traces — directed edges source→{artifact|task} with link_type
//                     (covers/implements/derived_from/...). The bridge between
//                     the requirements project and the builders' kanban: an AC
//                     artifact is 'implemented by' a dev task.
//
// Artifacts are scoped to a project (requirements project lives alongside
// builders' project in the same DB). Epic = one REQ-NNN episode.
// ============================================================================

// SRS-004 §2b.1 — 'brief' (discovery output) and 'theme' (top-level business
// board) extend the original 7 artifact types. 'RULE' (business rule / policy)
// and 'OQ' (open question / unresolved issue) widen the catalog further. 'SPEC'
// (technical specification / design contract referenced by FRs) widens it again
// so an FR can `implements_spec` a SPEC without leaking the design into the FR
// text (CGAD R14 / BABOK WHAT-vs-HOW separation). This array MUST stay in
// lock-step with the ArtifactType union (src/types.ts), ArtifactTypeSchema
// (src/schema.ts) and the artifacts.type SQL CHECK constraint — all four are
// the canonical list.
const ARTIFACT_TYPES = ['PRD', 'SRS', 'UC', 'AC', 'FR', 'NFR', 'decision', 'brief', 'theme', 'RULE', 'OQ', 'SPEC', 'hypothesis', 'business_metric', 'summary'] as const;
const ARTIFACT_STATUSES = ['draft', 'in_review', 'accepted', 'superseded'] as const;
const LINK_TYPES = ['covers', 'implements', 'implements_spec', 'derived_from', 'depends_on', 'verified_by', 'superseded_by'] as const;

// The business board project is identified by its exact name (SRS §2b.3). There
// is no project `kind` column, so the contract's `projectExists(id,'business')`
// is realized as a name match against the canonical 'business' project.
const BUSINESS_PROJECT_NAME = 'business';

// A brief that fails validation is persisted in `draft` (AC-1: "Отсутствие /
// невалидность decision → brief остаётся в статусе draft"). This constant names
// the metadata key under which the validated BriefPayload is stored.
const BRIEF_PAYLOAD_KEY = 'brief_payload';

// ============================================================================
// Handlers
// ============================================================================

function handleArtifactCreate(args: Record<string, unknown>): Artifact {
  const db = getDb();
  const projectId = args.project_id as number;
  const epicId = args.epic_id as number;
  const type = args.type as typeof ARTIFACT_TYPES[number];
  const title = args.title as string;
  const projectRepositoryId = (args.project_repository_id as number | undefined) ?? null;
  // Workers sometimes write absolute paths (D:\Development\moscito\docs\...md)
  // despite the skill template saying 'docs/...'. On Windows this breaks
  // path.join(root, absPath) downstream (tracker-view resolver, artifactDiskHash).
  // Normalise: if path is absolute AND we know project_repository.local_path,
  // strip the local_path prefix to make it relative. Otherwise keep as-is but
  // tag metadata.path_warning so downstream knows.
  const rawPath = args.path as string;
  const code = (args.code as string | undefined) ?? null;
  const status = (args.status as typeof ARTIFACT_STATUSES[number] | undefined) ?? 'draft';
  const parentArtifactId = (args.parent_artifact_id as number | undefined) ?? null;
  const tags = (args.tags as string[] | undefined) ?? [];
  const metadata = (args.metadata as Record<string, unknown> | undefined) ?? {};

  if (!ARTIFACT_TYPES.includes(type)) {
    throw new Error(`type must be one of ${ARTIFACT_TYPES.join(', ')}, got '${type}'`);
  }
  if (!ARTIFACT_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${ARTIFACT_STATUSES.join(', ')}, got '${status}'`);
  }
  if (title === undefined || title === null || title === '') {
    throw new Error('title and path are required');
  }
  if (rawPath === undefined || rawPath === null || rawPath === '') {
    throw new Error('title and path are required');
  }
  if (projectRepositoryId != null) {
    const binding = db.prepare('SELECT project_id FROM project_repositories WHERE id=?').get(projectRepositoryId) as { project_id: number } | undefined;
    if (!binding) throw new Error(`Project repository ${projectRepositoryId} not found`);
    if (binding.project_id !== projectId) {
      throw new Error(`Project repository ${projectRepositoryId} does not belong to product project ${projectId}`);
    }
  }

  // Normalise absolute → relative path. Skill templates say 'docs/...' but
  // LLM workers sometimes prepend the workspace cwd (D:\Development\<repo>\docs\...).
  // We try to strip the known project_repository.local_path prefix; if that
  // fails, we keep the absolute path but tag it so tracker-view's defensive
  // resolver can still find the file.
  let path = rawPath;
  let metadataToPersist = metadata;
  const looksAbsolute = /^([A-Za-z]:[\\/]|[\\/]|\\\\[^?])/.test(rawPath.split('#')[0]);
  if (looksAbsolute && projectRepositoryId != null) {
    const repoRow = db.prepare(
      'SELECT local_path FROM project_repositories WHERE id=?',
    ).get(projectRepositoryId) as { local_path: string | null } | undefined;
    const localPath = repoRow?.local_path;
    if (localPath) {
      // Normalise both to forward slashes for prefix comparison.
      const normLocal = localPath.replace(/\\/g, '/').replace(/\/+$/, '');
      const normPath = rawPath.replace(/\\/g, '/');
      if (normPath.toLowerCase().startsWith(normLocal.toLowerCase() + '/')) {
        const stripped = normPath.slice(normLocal.length + 1);
        path = stripped;
      } else {
        // Absolute but not under this repo — keep as-is, tag for triage.
        metadataToPersist = { ...metadata, path_warning: 'absolute_path_not_under_repo_root' };
      }
    }
  } else if (looksAbsolute) {
    // No project_repository_id — cannot normalise. Tag for triage.
    metadataToPersist = { ...metadata, path_warning: 'absolute_path_no_repo_binding' };
  }

  const contentHash = artifactDiskHash(db, path, projectRepositoryId)
    ?? (args.content_hash as string | undefined) ?? null;

  // --- type-specific guards + payload prep (SRS §2b.3) ---
  //
  // `brief`: validate the BriefPayload BEFORE persisting. On failure we throw
  // (the index.ts marshalling layer turns any throw into an MCP isError
  // response), which keeps the error path uniform with every other tool. On
  // success the validated payload is persisted at metadata.brief_payload so
  // artifact_get(type:'brief') returns all 12 sections.
  // `theme`: a theme is the top-level business board and MUST live in the
  // 'business' project. Without a project `kind` column the contract's
  // `projectExists(id,'business')` is a name match.
  const acceptedHash = status === 'accepted' ? contentHash : null;
  const driftState = acceptedHash ? 'clean' : 'unknown';

  if (type === 'brief') {
    const briefPayload = (args.metadata as Record<string, unknown> | undefined)?.[BRIEF_PAYLOAD_KEY];
    const validation = validateBrief(briefPayload);
    if (!validation.ok) {
      // AC-1: a brief with a missing/invalid decision is not persisted as
      // accepted. We reject the whole payload (the index.ts marshalling turns
      // any throw into an MCP isError response) and surface the per-field errors
      // so the agent can correct and retry. Only a validated payload lands — at
      // the caller-supplied status, which is 'draft' until the gate passes.
      throw new Error(`brief validation failed:\n${validation.errors.join('\n')}`);
    }
    metadataToPersist = { ...metadataToPersist, [BRIEF_PAYLOAD_KEY]: briefPayload };
  }

  if (type === 'theme') {
    const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as { name: string } | undefined;
    if (!proj) {
      throw new Error(`theme requires project_id=${BUSINESS_PROJECT_NAME}: project ${projectId} not found`);
    }
    if (proj.name !== BUSINESS_PROJECT_NAME) {
      throw new Error(`theme requires project_id=${BUSINESS_PROJECT_NAME}, got project '${proj.name}' (id ${projectId})`);
    }
  }

  // --- upsert by (epic_id, code, type) (FR-1: idempotent re-create) ---
  //
  // A repeat artifact_create with the same code within an episode updates the
  // existing row instead of duplicating. code is nullable; when it is null we
  // always insert (there is nothing to match on). The match is scoped to the
  // epic + type so AC-1 in two different episodes never collide.
  let artifactId: number | undefined;
  let updatedExisting = false;

  if (code !== null) {
    const existing = db.prepare(
      'SELECT id FROM artifacts WHERE epic_id=? AND type=? AND code=?',
    ).get(epicId, type, code) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE artifacts SET project_id=?, title=?, path=?, status=?, parent_artifact_id=?,
                              project_repository_id=?, content_hash=?, accepted_hash=?,
                              drift_state=?, tags=?, metadata=?, updated_at=datetime('now')
         WHERE id=?`,
      ).run(
        projectId, title, path, status, parentArtifactId, projectRepositoryId,
        contentHash, acceptedHash, driftState,
        JSON.stringify(tags), JSON.stringify(metadataToPersist), existing.id,
      );
      artifactId = existing.id;
      updatedExisting = true;
    }
  }

  if (artifactId === undefined) {
    const info = db.prepare(
      `INSERT INTO artifacts (project_id, epic_id, type, code, title, path, status,
                              parent_artifact_id, project_repository_id,
                              content_hash, accepted_hash, drift_state, tags, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId, epicId, type, code, title, path, status, parentArtifactId, projectRepositoryId,
      contentHash, acceptedHash, driftState,
      JSON.stringify(tags), JSON.stringify(metadataToPersist),
    );
    artifactId = info.lastInsertRowid as number;
  }

  // After the row lands, treat the file on disk as the source of truth for
  // content_hash and drift_state. This does three things the inline pre-insert
  // computation cannot:
  //   1. Bug-2 fix: when the caller omitted content_hash, the SHA-256 of the
  //      file at `path` (resolved against project_repository_id) is computed
  //      and stamped. artifactDiskHash inside refreshArtifactHash already does
  //      exactly this read+hash+update.
  //   2. Bug-1 fix: when status==='accepted', the inline block above set
  //      accepted_hash = contentHash and drift_state='clean'. refreshArtifactHash
  //      re-reads the disk hash and confirms it matches accepted_hash, leaving
  //      drift_state='clean' (or flipping to 'drifted' if the file was mutated
  //      between the inline read and now — a defensive no-op in practice).
  //   3. Point-3: every artifact with a path that resolves to a real file gets
  //      its hash reconciled with the disk, regardless of caller-supplied
  //      content_hash. If there is no resolvable file, the function is a no-op
  //      and the inline values stand.
  if (path) {
    refreshArtifactHash(db, artifactId);
  }

  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId) as Artifact;
  logActivity(db, 'artifact', artifact.id, updatedExisting ? 'updated' : 'created', null, null, type,
    `Artifact ${artifact.type}${code ? ` ${code}` : ''} '${title}' ${updatedExisting ? 'updated (upsert)' : 'created'}`);
  return artifact;
}

function handleArtifactGet(args: Record<string, unknown>): {
  artifact: Artifact;
  parents: Artifact[];
  children: Artifact[];
  traces_out: Array<ArtifactTrace & { target_title: string | null }>;
  traces_in: Array<ArtifactTrace & { source: { id: number; type: string; code: string | null; title: string } }>;
} {
  const db = getDb();
  const id = args.id as number;
  refreshArtifactHash(db, id);
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Artifact | undefined;
  if (!artifact) throw new Error(`Artifact ${id} not found`);

  // parents up the hierarchy
  const parents: Artifact[] = [];
  let cur = artifact.parent_artifact_id;
  const seen = new Set<number>([id]);
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const p = db.prepare('SELECT * FROM artifacts WHERE id=?').get(cur) as Artifact | undefined;
    if (!p) break;
    parents.push(p);
    cur = p.parent_artifact_id;
  }

  // direct children
  const children = db.prepare('SELECT * FROM artifacts WHERE parent_artifact_id=? ORDER BY type, code').all(id) as Artifact[];

  // outgoing traces (this artifact → something)
  const tracesOut = db.prepare(
    `SELECT t.*, CASE WHEN t.target_type='artifact'
        THEN (SELECT title FROM artifacts WHERE id=t.target_id)
        ELSE (SELECT title FROM tasks WHERE id=t.target_id) END AS target_title
     FROM artifact_traces t WHERE t.source_id=? ORDER BY t.link_type, t.target_type`,
  ).all(id) as Array<ArtifactTrace & { target_title: string | null }>;

  // incoming traces (something → this artifact)
  const tracesIn = db.prepare(
    `SELECT t.*,
        (SELECT a.id FROM artifacts a WHERE a.id=t.source_id) AS _src_art,
        (SELECT a.type FROM artifacts a WHERE a.id=t.source_id) AS src_type,
        (SELECT a.code FROM artifacts a WHERE a.id=t.source_id) AS src_code,
        (SELECT a.title FROM artifacts a WHERE a.id=t.source_id) AS src_title
     FROM artifact_traces t
     WHERE t.target_type='artifact' AND t.target_id=?
     ORDER BY t.link_type`,
  ).all(id) as Array<ArtifactTrace & {
    src_type: string; src_code: string | null; src_title: string;
  }>;
  const traces_in = tracesIn.map((r) => ({
    id: r.id, source_id: r.source_id, target_type: r.target_type, target_id: r.target_id,
    link_type: r.link_type, created_at: r.created_at,
    source: { id: r.source_id, type: r.src_type, code: r.src_code, title: r.src_title },
  }));

  return { artifact, parents, children, traces_out: tracesOut, traces_in };
}

function handleArtifactList(args: Record<string, unknown>): {
  artifacts: Array<Artifact & { epic_name: string }>;
  count: number;
} {
  const db = getDb();
  const projectId = args.project_id as number | undefined;
  const epicId = args.epic_id as number | undefined;
  const type = args.type as string | undefined;
  const status = args.status as string | undefined;
  const parentArtifactId = args.parent_artifact_id as number | undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  if (projectId != null) { where.push('a.project_id=?'); params.push(projectId); }
  if (epicId != null) { where.push('a.epic_id=?'); params.push(epicId); }
  if (type) { where.push('a.type=?'); params.push(type); }
  if (status) { where.push('a.status=?'); params.push(status); }
  if (parentArtifactId != null) { where.push('a.parent_artifact_id=?'); params.push(parentArtifactId); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT a.*, e.name AS epic_name FROM artifacts a
     JOIN epics e ON e.id=a.epic_id
     ${whereClause}
     ORDER BY a.epic_id, a.type, a.code`,
  ).all(...params) as Array<Artifact & { epic_name: string }>;

  return { artifacts: rows, count: rows.length };
}

function handleArtifactUpdate(args: Record<string, unknown>): Artifact {
  const db = getDb();
  const id = args.id as number;
  const existing = db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Artifact | undefined;
  if (!existing) throw new Error(`Artifact ${id} not found`);

  const fields: string[] = [];
  const params: unknown[] = [];
  const trackedFields: Array<[string, string]> = [];

  const title = args.title as string | undefined;
  if (title !== undefined) { fields.push('title=?'); params.push(title); trackedFields.push(['title', 'title']); }

  const path = args.path as string | undefined;
  if (path !== undefined) { fields.push('path=?'); params.push(path); trackedFields.push(['path', 'path']); }

  const code = args.code as string | undefined;
  if (code !== undefined) { fields.push('code=?'); params.push(code); trackedFields.push(['code', 'code']); }

  const status = args.status as typeof ARTIFACT_STATUSES[number] | undefined;
  if (status !== undefined) {
    if (!ARTIFACT_STATUSES.includes(status)) {
      throw new Error(`status must be one of ${ARTIFACT_STATUSES.join(', ')}, got '${status}'`);
    }
    fields.push('status=?'); params.push(status); trackedFields.push(['status', 'status']);
  }

  const parentArtifactId = args.parent_artifact_id as number | null | undefined;
  if (parentArtifactId !== undefined) {
    fields.push('parent_artifact_id=?'); params.push(parentArtifactId); trackedFields.push(['parent_artifact_id', 'parent']);
  }

  const projectRepositoryId = args.project_repository_id as number | null | undefined;
  const effectivePath = path ?? existing.path;
  const effectiveRepositoryId = projectRepositoryId !== undefined
    ? projectRepositoryId : existing.project_repository_id;
  const diskHash = artifactDiskHash(db, effectivePath, effectiveRepositoryId);
  const contentHash = diskHash ?? (args.content_hash as string | null | undefined);
  if (contentHash !== undefined) {
    fields.push('content_hash=?'); params.push(contentHash);
    const acceptedHash = status === 'accepted'
      ? contentHash
      : existing.accepted_hash;
    const driftState = acceptedHash == null || contentHash == null
      ? 'unknown'
      : acceptedHash === contentHash ? 'clean' : 'drifted';
    if (status !== 'accepted') {
      fields.push('drift_state=?'); params.push(driftState);
    }
  }
  if (status === 'accepted') {
    const hashAtAcceptance = contentHash !== undefined ? contentHash : existing.content_hash;
    fields.push('accepted_hash=?'); params.push(hashAtAcceptance);
    fields.push('drift_state=?'); params.push(hashAtAcceptance ? 'clean' : 'unknown');
  }
  if (projectRepositoryId !== undefined) {
    if (projectRepositoryId != null) {
      const binding = db.prepare('SELECT project_id FROM project_repositories WHERE id=?').get(projectRepositoryId) as { project_id: number } | undefined;
      if (!binding || binding.project_id !== existing.project_id) {
        throw new Error(`Project repository ${projectRepositoryId} does not belong to artifact ${id}'s product`);
      }
    }
    fields.push('project_repository_id=?'); params.push(projectRepositoryId);
  }

  const tags = args.tags as string[] | undefined;
  if (tags !== undefined) { fields.push('tags=?'); params.push(JSON.stringify(tags)); }

  const metadata = args.metadata as Record<string, unknown> | undefined;
  if (metadata !== undefined) { fields.push('metadata=?'); params.push(JSON.stringify(metadata)); }

  if (fields.length === 0) {
    return existing; // nothing to update
  }
  fields.push("updated_at=datetime('now')");
  params.push(id);

  db.prepare(`UPDATE artifacts SET ${fields.join(', ')} WHERE id=?`).run(...params);
  const updated = db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Artifact;

  // logActivity: one summary line; status change is the most interesting
  const statusChanged = trackedFields.some(([f]) => f === 'status');
  logActivity(db, 'artifact', id, statusChanged ? 'status_changed' : 'updated',
    statusChanged ? 'status' : null,
    statusChanged ? existing.status : null,
    statusChanged ? (args.status as string) : null,
    `Artifact ${updated.type}${updated.code ? ` ${updated.code}` : ''} '${updated.title}' updated`);
  return updated;
}

// ============================================================================
// Traces
// ============================================================================

function handleTraceAdd(args: Record<string, unknown>): ArtifactTrace {
  const db = getDb();
  const sourceId = args.source_id as number;
  const targetType = args.target_type as 'artifact' | 'task';
  const targetId = args.target_id as number;
  const linkType = args.link_type as typeof LINK_TYPES[number];

  if (!['artifact', 'task'].includes(targetType)) {
    throw new Error(`target_type must be 'artifact' or 'task', got '${targetType}'`);
  }
  if (!LINK_TYPES.includes(linkType)) {
    throw new Error(`link_type must be one of ${LINK_TYPES.join(', ')}, got '${linkType}'`);
  }

  // source must exist
  const src = db.prepare('SELECT id,epic_id,type,status FROM artifacts WHERE id=?').get(sourceId) as
    | { id: number; epic_id: number; type: string; status: string }
    | undefined;
  if (!src) throw new Error(`source artifact ${sourceId} not found`);

  // target must exist
  if (targetType === 'artifact') {
    const t = db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(targetId);
    if (!t) throw new Error(`target artifact ${targetId} not found`);
  } else {
    const t = db.prepare(
      'SELECT id,epic_id,task_kind,verification_target_artifact_id FROM tasks WHERE id=?',
    ).get(targetId) as
      | {
          id: number;
          epic_id: number;
          task_kind: string | null;
          verification_target_artifact_id: number | null;
        }
      | undefined;
    if (!t) throw new Error(`target task ${targetId} not found`);
    if (t.task_kind === 'verification.ac' && (linkType === 'depends_on' || linkType === 'verified_by')) {
      if (src.type !== 'AC' || src.status !== 'accepted') {
        throw new Error(`${linkType} on verification.ac must originate from an accepted AC`);
      }
      if (src.epic_id !== t.epic_id) {
        throw new Error(`${linkType} on verification.ac must use an AC from the same episode`);
      }
      if (t.verification_target_artifact_id !== null && t.verification_target_artifact_id !== sourceId) {
        throw new Error(
          `Verification task ${targetId} targets AC ${t.verification_target_artifact_id}; ` +
          `cannot attach AC ${sourceId}`,
        );
      }
      if (linkType === 'verified_by' && t.verification_target_artifact_id === null) {
        throw new Error(
          `Verification task ${targetId} has no canonical AC; add its depends_on provenance first`,
        );
      }
      if (t.verification_target_artifact_id === null && linkType === 'depends_on') {
        db.prepare(
          `UPDATE tasks SET verification_target_artifact_id=?, updated_at=datetime('now')
           WHERE id=? AND verification_target_artifact_id IS NULL`,
        ).run(sourceId, targetId);
      }
    }
  }
  if (linkType === 'verified_by') {
    if (targetType !== 'task') {
      throw new Error('verified_by must target a verification task');
    }
    const evidence = db.prepare(
      `SELECT 1 FROM verification_evidence
       WHERE artifact_id=? AND task_id=? AND outcome='passed'`,
    ).get(sourceId, targetId);
    if (!evidence) {
      throw new Error('verified_by requires passing verification_evidence; use verification_record');
    }
  }

  const info = db.prepare(
    `INSERT OR IGNORE INTO artifact_traces (source_id, target_type, target_id, link_type) VALUES (?, ?, ?, ?)`,
  ).run(sourceId, targetType, targetId, linkType);

  const trace = db.prepare(
    'SELECT * FROM artifact_traces WHERE source_id=? AND target_type=? AND target_id=? AND link_type=?',
  ).get(sourceId, targetType, targetId, linkType) as ArtifactTrace;

  logActivity(db, 'artifact', sourceId, 'updated', 'trace', null, `${linkType}→${targetType}:${targetId}`,
    `Trace ${linkType} added: artifact ${sourceId} → ${targetType} ${targetId}${info.changes === 0 ? ' (already existed)' : ''}`);
  return trace;
}

function handleTraceList(args: Record<string, unknown>): {
  traces: Array<ArtifactTrace & {
    source_type: string | null; source_code: string | null; source_title: string | null;
    target_title: string | null; target_status: string | null;
  }>;
  count: number;
} {
  const db = getDb();
  const sourceId = args.source_id as number | undefined;
  const targetType = args.target_type as string | undefined;
  const targetId = args.target_id as number | undefined;
  const linkType = args.link_type as string | undefined;

  const where: string[] = [];
  const params: unknown[] = [];
  if (sourceId != null) { where.push('t.source_id=?'); params.push(sourceId); }
  if (targetType) { where.push('t.target_type=?'); params.push(targetType); }
  if (targetId != null) { where.push('t.target_id=?'); params.push(targetId); }
  if (linkType) { where.push('t.link_type=?'); params.push(linkType); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT t.*,
        (SELECT a.type  FROM artifacts a WHERE a.id=t.source_id) AS source_type,
        (SELECT a.code  FROM artifacts a WHERE a.id=t.source_id) AS source_code,
        (SELECT a.title FROM artifacts a WHERE a.id=t.source_id) AS source_title,
        CASE WHEN t.target_type='artifact'
             THEN (SELECT a.title  FROM artifacts a WHERE a.id=t.target_id)
             ELSE (SELECT tk.title FROM tasks tk WHERE tk.id=t.target_id)
        END AS target_title,
        CASE WHEN t.target_type='artifact'
             THEN (SELECT a.status FROM artifacts a WHERE a.id=t.target_id)
             ELSE (SELECT tk.status FROM tasks tk WHERE tk.id=t.target_id)
        END AS target_status
     FROM artifact_traces t
     ${whereClause}
     ORDER BY t.source_id, t.link_type, t.target_type`,
  ).all(...params) as Array<ArtifactTrace & {
    source_type: string | null; source_code: string | null; source_title: string | null;
    target_title: string | null; target_status: string | null;
  }>;

  return { traces: rows, count: rows.length };
}

// Coverage matrix: for an epic (REQ-NNN episode), which artifacts of `type`
// (typically AC or FR) are covered by `link_type` (typically 'implements')
// pointing at tasks, and which are gaps.
function handleArtifactCoverage(args: Record<string, unknown>): {
  epic_id: number;
  type: string;
  link_type: string;
  total: number;
  covered: number;
  gaps: Array<{ artifact_id: number; code: string | null; title: string; path: string; status: string }>;
  covered_list: Array<{ artifact_id: number; code: string | null; title: string; task_ids: number[] }>;
} {
  const db = getDb();
  const epicId = args.epic_id as number;
  const type = (args.type as string | undefined) ?? 'AC';
  const linkType = (args.link_type as string | undefined) ?? 'implements';

  const artifacts = db.prepare(
    'SELECT * FROM artifacts WHERE epic_id=? AND type=? ORDER BY code',
  ).all(epicId, type) as Artifact[];

  const gaps: Array<{ artifact_id: number; code: string | null; title: string; path: string; status: string }> = [];
  const coveredList: Array<{ artifact_id: number; code: string | null; title: string; task_ids: number[] }> = [];

  for (const a of artifacts) {
    const links = db.prepare(
      `SELECT target_id FROM artifact_traces WHERE source_id=? AND target_type='task' AND link_type=?`,
    ).all(a.id, linkType) as Array<{ target_id: number }>;
    if (links.length === 0) {
      gaps.push({ artifact_id: a.id, code: a.code, title: a.title, path: a.path, status: a.status });
    } else {
      coveredList.push({ artifact_id: a.id, code: a.code, title: a.title, task_ids: links.map((l) => l.target_id) });
    }
  }

  return {
    epic_id: epicId,
    type,
    link_type: linkType,
    total: artifacts.length,
    covered: coveredList.length,
    gaps,
    covered_list: coveredList,
  };
}

// ============================================================================
// Definitions
// ============================================================================

export const definitions: Tool[] = [
  {
    name: 'artifact_create',
    description:
      "Create a requirements/design artifact (PRD, SRS, UC, AC, FR, NFR, or decision) tied to a .md doc on disk. Scoped to a project and an epic (the epic = one REQ-NNN episode). Carries a code for queryability (e.g. 'AC-1', 'FR-3'), a status (draft/in_review/accepted/superseded) mirroring the doc's Status header, and an optional parent_artifact_id to build the within-episode hierarchy (AC→UC, FR→PRD).",
    annotations: { title: 'Artifact: Create', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project ID (typically the requirements project).' },
        epic_id: { type: 'integer', description: 'Epic ID — one REQ-NNN episode.' },
        type: { type: 'string', enum: [...ARTIFACT_TYPES], description: "Artifact type: PRD, SRS, UC (use case), AC (acceptance criterion), FR (functional req), NFR (non-functional), decision." },
        title: { type: 'string', description: 'Human-readable title.' },
        path: { type: 'string', description: "Path to the .md doc (e.g. 'docs/requirements/REQ-001-auth/03-acceptance-criteria.md#AC-1')." },
        code: { type: 'string', description: "Optional code for querying: 'AC-1', 'FR-3', 'UC-2'. Unique within the epic is recommended." },
        status: { type: 'string', enum: [...ARTIFACT_STATUSES], default: 'draft' },
        parent_artifact_id: { type: 'integer', description: 'Optional parent artifact (builds hierarchy: AC→UC, FR→PRD).' },
        project_repository_id: { type: 'integer', description: 'Optional physical product repository containing the artifact document.' },
        content_hash: { type: 'string', description: 'SHA-256 (or equivalent stable digest) of the current document revision.' },
        tags: { type: 'array', items: { type: 'string' }, default: [] },
        metadata: { type: 'object', default: {} },
      },
      required: ['project_id', 'epic_id', 'type', 'title', 'path'],
    },
  },
  {
    name: 'artifact_get',
    description:
      'Get one artifact with its full context: parents up the hierarchy, direct children, outgoing traces (this artifact → others/tasks), and incoming traces (others → this artifact). Use this to understand an AC: which UC/FR it derives from, and which dev-tasks implement it.',
    annotations: { title: 'Artifact: Get', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Artifact ID.' } },
      required: ['id'],
    },
  },
  {
    name: 'artifact_list',
    description:
      'List artifacts with optional filters (project, epic, type, status, parent). Ordered by epic, type, code. Use type:"AC" + epic to get all acceptance criteria of a REQ episode.',
    annotations: { title: 'Artifact: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' },
        epic_id: { type: 'integer' },
        type: { type: 'string', enum: [...ARTIFACT_TYPES] },
        status: { type: 'string', enum: [...ARTIFACT_STATUSES] },
        parent_artifact_id: { type: 'integer', description: 'Filter to direct children of this artifact.' },
      },
    },
  },
  {
    name: 'artifact_update',
    description:
      "Update an artifact's mutable fields (title, path, code, status, parent_artifact_id, tags, metadata). Status transitions (draft→in_review→accepted→superseded) are logged. Use this when a doc's Status header changes.",
    annotations: { title: 'Artifact: Update', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        path: { type: 'string' },
        code: { type: 'string' },
        status: { type: 'string', enum: [...ARTIFACT_STATUSES] },
        parent_artifact_id: { type: 'integer', description: 'Pass null to detach from parent.' },
        project_repository_id: { type: ['integer', 'null'] },
        content_hash: { type: ['string', 'null'], description: 'Current document digest; changing it after acceptance marks drift.' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
      },
      required: ['id'],
    },
  },
  {
    name: 'trace_add',
    description:
      "Add a directed trace edge from an artifact (source) to another artifact or a task (target). link_type names the relation: 'covers' (FR covered by UC), 'implements' (AC implemented by a dev task — the bridge to the builders' kanban), 'implements_spec' (FR or RULE implemented by a SPEC design contract), 'derived_from' (AC derived from UC), 'depends_on', 'verified_by', 'superseded_by'. This is what builds the traceability graph.",
    annotations: { title: 'Trace: Add', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer', description: 'Source artifact ID.' },
        target_type: { type: 'string', enum: ['artifact', 'task'] },
        target_id: { type: 'integer', description: 'Target artifact or task ID.' },
        link_type: { type: 'string', enum: [...LINK_TYPES] },
      },
      required: ['source_id', 'target_type', 'target_id', 'link_type'],
    },
  },
  {
    name: 'trace_list',
    description:
      "List traces with optional filters (source, target_type, target_id, link_type). Returns source/target titles and the target's current status, so you can see e.g. which AC are implemented by done tasks vs in_progress tasks.",
    annotations: { title: 'Trace: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'integer' },
        target_type: { type: 'string', enum: ['artifact', 'task'] },
        target_id: { type: 'integer' },
        link_type: { type: 'string', enum: [...LINK_TYPES] },
      },
    },
  },
  {
    name: 'artifact_coverage',
    description:
      "Coverage matrix for an epic (REQ-NNN episode): of the artifacts of a given type (default AC), which are linked via a given link_type (default 'implements') to tasks, and which are gaps (not yet implemented). The core traceability query — use it to see 'AC-3 is not yet implemented by any dev task'.",
    annotations: { title: 'Artifact: Coverage', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'The REQ-NNN epic.' },
        type: { type: 'string', enum: [...ARTIFACT_TYPES], default: 'AC' },
        link_type: { type: 'string', enum: [...LINK_TYPES], default: 'implements' },
      },
      required: ['epic_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  artifact_create: handleArtifactCreate,
  artifact_get: handleArtifactGet,
  artifact_list: handleArtifactList,
  artifact_update: handleArtifactUpdate,
  trace_add: handleTraceAdd,
  trace_list: handleTraceList,
  artifact_coverage: handleArtifactCoverage,
};
