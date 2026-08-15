import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { recordManagedArtifactProduction } from '../process-modules/persistence/sqlite-managed-production-ledger.js';

export function artifactDiskHash(
  db: Database.Database,
  artifactPath: string,
  projectRepositoryId: number | null,
): string | null {
  if (projectRepositoryId == null) return null;
  const row = db.prepare(
    'SELECT local_path FROM project_repositories WHERE id=?',
  ).get(projectRepositoryId) as { local_path: string | null } | undefined;
  if (!row?.local_path) return null;
  const root = path.resolve(row.local_path);
  const relative = artifactPath.split('#')[0];
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    // Path escapes the repository root. This happens when a worker writes
    // an absolute path (D:\foreign\...) that the artifact_create handler
    // could not normalise. Rather than throw (which would block artifact
    // creation entirely), return null so the artifact is still persisted
    // (with content_hash=null). The path_warning metadata flag tells
    // downstream tooling why the hash is missing.
    return null;
  }
  if (!existsSync(absolute)) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

export function refreshArtifactHash(db: Database.Database, artifactId: number): void {
  const artifact = db.prepare(
    `SELECT id,path,status,project_repository_id,accepted_hash,
            content_hash AS currentHash
     FROM artifacts WHERE id=?`,
  ).get(artifactId) as {
    id: number; path: string; status: string;
    project_repository_id: number | null; accepted_hash: string | null;
    currentHash: string | null;
  } | undefined;
  if (!artifact) return;
  const hash = artifactDiskHash(db, artifact.path, artifact.project_repository_id);
  if (!hash) return;
  // TB-6: a hash refresh IS a mutation — record it in the managed production
  // ledger so the writer is attributable. Without this, refresh-on-read was a
  // silent mutator: two artifacts with no ledger row got the same hash
  // stamped purely by being read, and the drift investigation had no
  // provenance chain. Skip when the hash did not actually change (the common
  // no-drift re-read) to avoid ledger noise.
  const drift = artifact.accepted_hash == null
    ? 'unknown'
    : artifact.accepted_hash === hash ? 'clean' : 'drifted';
  db.prepare(
    `UPDATE artifacts SET content_hash=?, drift_state=?, updated_at=datetime('now') WHERE id=?`,
  ).run(hash, drift, artifactId);
  if (hash !== artifact.currentHash) {
    const fullArtifact = db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactId);
    if (fullArtifact) {
      // The CHECK constraint allows create/upsert/update — use 'update' for a
      // hash refresh (it IS a content mutation from the ledger's perspective).
      recordManagedArtifactProduction(db, fullArtifact as never, 'update');
    }
  }
}
