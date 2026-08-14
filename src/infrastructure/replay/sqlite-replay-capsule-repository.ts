import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../shared/canonical-json.js';
import type { Task } from '../../types.js';
import {
  REPLAY_CAPSULE_SCHEMA,
  computeReplayKey,
  type ReplayArtifactSelector,
  type ReplayCapsulePayload,
  type ReplayCapsuleRecord,
  type ReplayClaimSelection,
  type ReplayGitRecipe,
  type ReplayKeyMaterial,
} from '../../replay/replay-capsule.js';
// P6 consolidation: the strict key-material resolver and the stable-product
// digest helper are shared with the claim binder — one formula, one file.
import { resolveReplayKeyMaterial } from './replay-key-material.js';
import { isWorkplaceProductionSnapshot } from '../../process-modules/shared/workplace-production-snapshot.js';

interface ExecutionEnvelope {
  execution_context?: {
    replay?: {
      key?: unknown;
      key_material?: unknown;
      capsule_ref?: unknown;
    };
  };
}

export function ensureReplayCapsuleSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_replay_capsules (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      capsule_ref               TEXT NOT NULL UNIQUE,
      replay_key                TEXT NOT NULL,
      project_id                INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_execution_ref      TEXT NOT NULL,
      source_candidate_set_ref  TEXT NOT NULL,
      payload_hash              TEXT NOT NULL,
      payload_snapshot          TEXT NOT NULL,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(replay_key, payload_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_factory_replay_capsules_lookup
      ON factory_replay_capsules(project_id, replay_key, id DESC);
  `);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`REPLAY_CAPSULE_CONTEXT_INVALID: ${label} is required`);
  }
  return value;
}

function requireKeyMaterial(value: unknown): ReplayKeyMaterial {
  const row = asRecord(value);
  if (!row) throw new Error('REPLAY_CAPSULE_CONTEXT_INVALID: replay key material is missing');
  const role = row.role;
  if (role !== 'author' && role !== 'reviewer') {
    throw new Error('REPLAY_CAPSULE_CONTEXT_INVALID: replay role is invalid');
  }
  const projectId = Number(row.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('REPLAY_CAPSULE_CONTEXT_INVALID: projectId is invalid');
  }
  return {
    projectId,
    moduleRef: requireString(row.moduleRef, 'moduleRef'),
    nodeId: requireString(row.nodeId, 'nodeId'),
    productionCellId: requireString(row.productionCellId, 'productionCellId'),
    workKey: requireString(row.workKey, 'workKey'),
    role,
    packageDigest: requireString(row.packageDigest, 'packageDigest'),
    semanticInputDigest: requireString(row.semanticInputDigest, 'semanticInputDigest'),
    subjectProductionDigest: row.subjectProductionDigest === null
      ? null
      : requireString(row.subjectProductionDigest, 'subjectProductionDigest'),
  };
}

function collectIdentityBindings(
  value: unknown,
  pathPrefix = '$',
  out: Array<{ path: string; value: string | number | boolean | null }> = [],
): Array<{ path: string; value: string | number | boolean | null }> {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push({ path: pathPrefix, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIdentityBindings(item, `${pathPrefix}[${index}]`, out));
    return out;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) {
      collectIdentityBindings(item, `${pathPrefix}.${key}`, out);
    }
  }
  return out;
}

/**
 * Presentation aliases may differ across otherwise equivalent executions.
 * Captured products contain path markers for those aliases, so the capsule
 * only needs the allowed path, never the run-scoped value itself. Keeping the
 * raw value in payload identity would create two capsules for one replay key.
 */
export function canonicalReplayInputBindings(
  bindings: readonly { path: string; value: string | number | boolean | null }[],
): Array<{ path: string; value: string | number | boolean | null }> {
  return bindings.map(binding => ({
    path: binding.path,
    value: replayIdentityCandidate(binding.value) ? null : binding.value,
  }));
}

function replayIdentityCandidate(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{64}$/i.test(value)
    || value.startsWith('managed-node-submission:')
    || value.startsWith('candidate-set:')
    || value.startsWith('workplace/')
    || value.startsWith('product:')
    || value.length >= 32;
}

function templateAgainstInput(value: unknown, bindings: readonly { path: string; value: string | number | boolean | null }[]): unknown {
  const candidates = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!replayIdentityCandidate(binding.value)) continue;
    const key = `${typeof binding.value}:${String(binding.value)}`;
    const paths = candidates.get(key) ?? [];
    paths.push(binding.path);
    candidates.set(key, paths);
  }
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (!replayIdentityCandidate(item)) return item;
      const matches = candidates.get(`${typeof item}:${String(item)}`) ?? [];
      return matches.length === 1
        ? { $sagaReplayInput: matches[0] }
        : item;
    }
    if (Array.isArray(item)) return item.map(visit);
    const record = asRecord(item);
    if (!record) return item;
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

function artifactSelector(row: {
  type: string;
  code: string | null;
  title: string;
  path: string;
  content_hash: string | null;
}): ReplayArtifactSelector {
  return {
    type: row.type,
    code: row.code,
    title: row.title,
    path: row.path,
    contentHash: row.content_hash,
  };
}

function readArtifactBytes(
  db: Database.Database,
  artifact: { path: string; project_repository_id: number | null },
): { encoding: 'base64'; bytes: string } | null {
  const rawPath = artifact.path.split('#')[0]!;
  let resolved = rawPath;
  if (!path.isAbsolute(rawPath) && artifact.project_repository_id !== null) {
    const repository = db.prepare(
      `SELECT COALESCE(rc.local_path,pr.local_path) AS local_path
         FROM project_repositories pr
         LEFT JOIN repository_checkouts rc
           ON rc.project_repository_id=pr.id AND rc.status='active'
        WHERE pr.id=?`,
    ).get(artifact.project_repository_id) as { local_path: string | null } | undefined;
    if (repository?.local_path) resolved = path.resolve(repository.local_path, rawPath);
  }
  if (!existsSync(resolved)) return null;
  return { encoding: 'base64', bytes: readFileSync(resolved).toString('base64') };
}

function gitText(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trimEnd();
}

function captureGitRecipe(
  db: Database.Database,
  typedContents: readonly { schema: string; content: unknown }[],
): ReplayGitRecipe | null {
  const implementation = typedContents.find(item =>
    item.schema === 'factory.development-implementation-result.v1');
  const content = asRecord(implementation?.content);
  const source = asRecord(content?.source);
  const snapshot = asRecord(content?.snapshot);
  const repository = asRecord(content?.repository);
  if (!source || !snapshot || !repository) return null;
  const projectRepositoryId = Number(repository.projectRepositoryId);
  const baseCommit = typeof repository.baseCommit === 'string' ? repository.baseCommit : '';
  const sourceCommit = typeof source.commitSha === 'string' ? source.commitSha : '';
  const sourceTree = typeof snapshot.treeSha === 'string' ? snapshot.treeSha : '';
  const sourceBranch = typeof source.branch === 'string' ? source.branch : '';
  const integrationBranch = typeof repository.integrationBranch === 'string'
    ? repository.integrationBranch : '';
  if (!Number.isSafeInteger(projectRepositoryId) || !baseCommit || !sourceCommit || !sourceTree) return null;
  const repo = db.prepare(
    `SELECT COALESCE(rc.local_path,pr.local_path) AS local_path
       FROM project_repositories pr
       LEFT JOIN repository_checkouts rc
         ON rc.project_repository_id=pr.id AND rc.status='active'
      WHERE pr.id=?`,
  ).get(projectRepositoryId) as { local_path: string | null } | undefined;
  if (!repo?.local_path) return null;
  try {
    const patchBytes = execFileSync('git', [
      '-C', repo.local_path, 'diff', '--binary', `${baseCommit}..${sourceCommit}`,
    ]);
    const format = '%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';
    const parts = gitText(repo.local_path, ['show', '-s', `--format=${format}`, sourceCommit]).split('\u0000');
    if (parts.length < 7) return null;
    return {
      projectRepositoryId,
      integrationBranch,
      baseCommit,
      sourceCommit,
      sourceTree,
      sourceBranch,
      patchBase64: patchBytes.toString('base64'),
      commit: {
        authorName: parts[0]!, authorEmail: parts[1]!, authorDate: parts[2]!,
        committerName: parts[3]!, committerEmail: parts[4]!, committerDate: parts[5]!,
        message: parts.slice(6).join('\u0000'),
      },
    };
  } catch {
    return null;
  }
}

interface CandidateMemberRow {
  product_schema: string;
  product_ref: string;
  product_digest: string;
}

function readCandidateMembers(
  db: Database.Database,
  candidateSetRef: string,
): { workplaceRef: string; members: CandidateMemberRow[] } {
  const candidate = db.prepare(
    `SELECT workplace_ref FROM factory_candidate_sets WHERE candidate_set_ref=?`,
  ).get(candidateSetRef) as { workplace_ref: string } | undefined;
  if (!candidate) {
    throw new Error(`REPLAY_CAPTURE_CANDIDATE_NOT_FOUND: ${candidateSetRef}`);
  }
  const members = db.prepare(
    `SELECT product_schema,product_ref,product_digest
       FROM factory_candidate_set_members
      WHERE candidate_set_ref=? ORDER BY ordinal`,
  ).all(candidateSetRef) as CandidateMemberRow[];
  if (members.length === 0) {
    throw new Error(`REPLAY_CAPTURE_CANDIDATE_EMPTY: ${candidateSetRef}`);
  }
  return { workplaceRef: candidate.workplace_ref, members };
}

function readTypedCandidateProduct(
  db: Database.Database,
  member: CandidateMemberRow,
): { schema: string; content: unknown; contentHash: string } | null {
  if (!member.product_ref.startsWith('managed-node-submission:')) return null;
  const id = Number(member.product_ref.slice('managed-node-submission:'.length));
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`REPLAY_CAPTURE_PRODUCT_REF_INVALID: ${member.product_ref}`);
  }
  const row = db.prepare(
    `SELECT schema_version,payload_snapshot,content_hash
       FROM factory_managed_node_submissions WHERE id=?`,
  ).get(id) as {
    schema_version: string;
    payload_snapshot: string;
    content_hash: string;
  } | undefined;
  if (!row
      || row.schema_version !== member.product_schema
      || row.content_hash !== member.product_digest) {
    throw new Error(`REPLAY_CAPTURE_PRODUCT_NOT_FOUND: ${member.product_ref}`);
  }
  return {
    schema: row.schema_version,
    content: JSON.parse(row.payload_snapshot),
    contentHash: row.content_hash,
  };
}

function readPersistedCandidateProduct(
  db: Database.Database,
  member: CandidateMemberRow,
): unknown {
  const rows = db.prepare(
    `SELECT payload_snapshot,product_hash
       FROM factory_process_products
      WHERE schema_id=? AND artifact_ref=? AND product_hash=?`,
  ).all(member.product_schema, member.product_ref, member.product_digest) as Array<{
    payload_snapshot: string;
    product_hash: string;
  }>;
  if (rows.length !== 1) {
    throw new Error(`REPLAY_CAPTURE_PRODUCT_AUTHORITY_AMBIGUOUS: ${member.product_ref}`);
  }
  const row = rows[0]!;
  return JSON.parse(row.payload_snapshot) as unknown;
}

export class SqliteReplayCapsuleRepository {
  constructor(private readonly db: Database.Database) {
    ensureReplayCapsuleSchema(db);
  }

  /** Build the exact replay identity at claim time from server-authored bindings. */
  resolveClaim(task: Task, role: 'author' | 'reviewer'): ReplayClaimSelection {
    // P6 consolidation: the STRICT shared resolver (replay-key-material.ts).
    // The legacy fallback to run-scoped `process_node_input_hash` is removed —
    // a key built from run provenance can never match cross-run, so capsules
    // claimed under it were silently unreplayable; live conveyor tasks all
    // carry the frozen semantic digest.
    const keyMaterial = resolveReplayKeyMaterial(this.db, task, role);
    if (!keyMaterial) {
      const epicRow = this.db.prepare(
        'SELECT project_id FROM epics WHERE id=?',
      ).get(task.epic_id) as { project_id: number } | undefined;
      const fallbackProjectId = epicRow?.project_id ?? 0;
      const replayKey = sha256Hex({ projectId: fallbackProjectId, taskId: task.id, role, nonReplayable: true });
      return { replayKey, capsuleRef: null, capsulePayloadHash: null };
    }
    const replayKey = computeReplayKey(keyMaterial);
    const capsules = this.db.prepare(
      `SELECT capsule_ref,payload_hash
         FROM factory_replay_capsules
        WHERE project_id=? AND replay_key=?`,
    ).all(keyMaterial.projectId, replayKey) as Array<{
      capsule_ref: string;
      payload_hash: string;
    }>;
    if (capsules.length > 1) {
      throw new Error(`REPLAY_CAPSULE_AUTHORITY_AMBIGUOUS: ${replayKey}`);
    }
    const capsule = capsules[0];
    return {
      replayKey,
      capsuleRef: capsule?.capsule_ref ?? null,
      capsulePayloadHash: capsule?.payload_hash ?? null,
    };
  }

  read(capsuleRef: string): ReplayCapsuleRecord | null {
    const row = this.db.prepare(
      `SELECT capsule_ref,replay_key,project_id,source_execution_ref,
              source_candidate_set_ref,payload_hash,payload_snapshot,created_at
         FROM factory_replay_capsules WHERE capsule_ref=?`,
    ).get(capsuleRef) as {
      capsule_ref: string; replay_key: string; project_id: number;
      source_execution_ref: string; source_candidate_set_ref: string;
      payload_hash: string; payload_snapshot: string; created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      capsuleRef: row.capsule_ref,
      replayKey: row.replay_key,
      projectId: row.project_id,
      sourceExecutionRef: row.source_execution_ref,
      sourceCandidateSetRef: row.source_candidate_set_ref,
      payloadHash: row.payload_hash,
      payload: JSON.parse(row.payload_snapshot) as ReplayCapsulePayload,
      createdAt: row.created_at,
    };
  }

  /**
   * Capture the exact accepted CandidateSet material.
   *
   * sourceExecutionRef remains audit/key provenance (the execution that
   * presented the set), but product material is resolved exclusively from the
   * immutable CandidateSet ProductRefs. This is the P18 boundary: an accepted
   * replacement execution may have written nothing itself.
   */
  captureAcceptedExecution(input: {
    executionRef: string;
    candidateSetRef: string;
  }): ReplayCapsuleRecord {
    const execution = this.db.prepare(
      `SELECT we.metadata,we.task_id,t.metadata AS task_metadata
         FROM worker_executions we JOIN tasks t ON t.id=we.task_id
        WHERE we.execution_id=?`,
    ).get(input.executionRef) as { metadata: string; task_id: number; task_metadata: string } | undefined;
    if (!execution) throw new Error(`REPLAY_CAPTURE_EXECUTION_NOT_FOUND: ${input.executionRef}`);
    const envelope = JSON.parse(execution.metadata) as ExecutionEnvelope;
    const replay = envelope.execution_context?.replay;
    const keyMaterial = requireKeyMaterial(replay?.key_material);
    const replayKey = requireString(replay?.key, 'replay.key');
    if (replayKey !== computeReplayKey(keyMaterial)) {
      throw new Error('REPLAY_CAPTURE_KEY_MISMATCH: frozen key does not match key material');
    }
    const taskMetadata = parseJsonObject(execution.task_metadata);
    const inputValue = taskMetadata.process_node_input ?? taskMetadata.cell_input_item ?? {};
    const sourceInputBindings = collectIdentityBindings(inputValue);
    const inputBindings = canonicalReplayInputBindings(sourceInputBindings);

    const candidate = readCandidateMembers(this.db, input.candidateSetRef);
    const expectedWorkplace = typeof taskMetadata.workplace_ref === 'string'
      ? taskMetadata.workplace_ref : null;
    if (expectedWorkplace && candidate.workplaceRef !== expectedWorkplace) {
      throw new Error(
        `REPLAY_CAPTURE_CANDIDATE_WORKPLACE_MISMATCH: expected ${expectedWorkplace}, got ${candidate.workplaceRef}`,
      );
    }

    const typedProducts: Array<{ schema: string; content: unknown; contentHash: string }> = [];
    const artifactIds = new Set<number>();
    const traceIds = new Set<number>();

    for (const member of candidate.members) {
      const typed = readTypedCandidateProduct(this.db, member);
      if (typed) {
        typedProducts.push({
          schema: typed.schema,
          content: templateAgainstInput(typed.content, sourceInputBindings),
          contentHash: typed.contentHash,
        });
        continue;
      }

      const content = readPersistedCandidateProduct(this.db, member);
      if (!isWorkplaceProductionSnapshot(content)) {
        throw new Error(
          `REPLAY_CAPTURE_UNSUPPORTED_CANDIDATE_PRODUCT: ${member.product_ref}`,
        );
      }
      if (content.workplaceRef !== candidate.workplaceRef) {
        throw new Error(
          `REPLAY_CAPTURE_SNAPSHOT_WORKPLACE_MISMATCH: ${member.product_ref}`,
        );
      }
      for (const artifact of content.artifacts) artifactIds.add(artifact.artifactId);
      for (const trace of content.traces) traceIds.add(trace.traceId);
    }

    const artifactRows = [...artifactIds].map(id => this.db.prepare(
      `SELECT id,project_repository_id,type,title,path,code,status,parent_artifact_id,
              tags,metadata,content_hash
         FROM artifacts WHERE id=?`,
    ).get(id) as {
      id: number; project_repository_id: number | null; type: string; title: string;
      path: string; code: string | null; status: string; parent_artifact_id: number | null;
      tags: string; metadata: string; content_hash: string | null;
    } | undefined).filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (artifactRows.length !== artifactIds.size) {
      throw new Error(
        `REPLAY_CAPTURE_ARTIFACT_NOT_FOUND: expected ${artifactIds.size}, resolved ${artifactRows.length}`,
      );
    }
    const artifactById = new Map(artifactRows.map(row => [row.id, row]));
    const artifacts = artifactRows.map(row => {
      let parent: ReplayArtifactSelector | null = null;
      if (row.parent_artifact_id !== null) {
        const parentRow = artifactById.get(row.parent_artifact_id) ?? this.db.prepare(
          'SELECT type,code,title,path,content_hash FROM artifacts WHERE id=?',
        ).get(row.parent_artifact_id) as {
          type: string; code: string | null; title: string; path: string; content_hash: string | null;
        } | undefined;
        if (parentRow) parent = artifactSelector(parentRow);
      }
      return {
        selector: artifactSelector(row),
        projectRepositoryId: row.project_repository_id,
        status: 'draft' as const,
        tags: JSON.parse(row.tags || '[]') as string[],
        metadata: templateAgainstInput(
          parseJsonObject(row.metadata), sourceInputBindings,
        ) as Readonly<Record<string, unknown>>,
        parent,
        file: readArtifactBytes(this.db, row),
      };
    });

    const traceRows = [...traceIds].map(id => this.db.prepare(
      `SELECT id,source_id,target_type,target_id,link_type
         FROM artifact_traces WHERE id=?`,
    ).get(id) as {
      id: number; source_id: number; target_type: 'artifact' | 'task'; target_id: number; link_type: string;
    } | undefined).filter((row): row is NonNullable<typeof row> => row !== undefined);
    if (traceRows.length !== traceIds.size) {
      throw new Error(
        `REPLAY_CAPTURE_TRACE_NOT_FOUND: expected ${traceIds.size}, resolved ${traceRows.length}`,
      );
    }
    const selectorForArtifactId = (id: number): ReplayArtifactSelector | null => {
      const row = artifactById.get(id) ?? this.db.prepare(
        'SELECT type,code,title,path,content_hash FROM artifacts WHERE id=?',
      ).get(id) as {
        type: string; code: string | null; title: string; path: string; content_hash: string | null;
      } | undefined;
      return row ? artifactSelector(row) : null;
    };
    const traces = traceRows.flatMap(trace => {
      const source = selectorForArtifactId(trace.source_id);
      if (!source) return [];
      const targetArtifact = trace.target_type === 'artifact'
        ? selectorForArtifactId(trace.target_id) : null;
      const targetTask = trace.target_type === 'task'
        ? this.db.prepare('SELECT generation_key FROM tasks WHERE id=?').get(trace.target_id) as { generation_key: string | null } | undefined
        : undefined;
      return [{
        source,
        targetType: trace.target_type,
        targetArtifact,
        targetTaskGenerationKey: targetTask?.generation_key ?? null,
        linkType: trace.link_type,
      }];
    });

    const git = captureGitRecipe(this.db, typedProducts);
    const payload: ReplayCapsulePayload = {
      schemaVersion: REPLAY_CAPSULE_SCHEMA,
      key: keyMaterial,
      replayKey,
      inputBindings,
      typedProducts,
      artifacts,
      traces,
      git,
    };
    const payloadHash = sha256Hex(payload);
    const capsuleRef = `replay-capsule:${replayKey}:${payloadHash}`;
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_replay_capsules
         (capsule_ref,replay_key,project_id,source_execution_ref,
          source_candidate_set_ref,payload_hash,payload_snapshot)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      capsuleRef,
      replayKey,
      keyMaterial.projectId,
      input.executionRef,
      input.candidateSetRef,
      payloadHash,
      JSON.stringify(payload),
    );
    const record = this.read(capsuleRef);
    if (!record) throw new Error(`REPLAY_CAPSULE_PERSIST_FAILED: ${capsuleRef}`);
    return record;
  }
}
