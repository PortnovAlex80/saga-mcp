/**
 * Exact accepted artifact bytes for the formalization module.
 *
 * Reads the artifact's file through its repository checkout and verifies the
 * on-disk content still hashes to the registered content_hash — the same
 * contract the baseline freezer depends on ("exact accepted bytes"). Shared
 * by the production-cell kernel handlers and the acceptance-contract
 * submission validator so both read identical bytes (extracted from
 * index.ts; the validator cannot import the module index without a cycle).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export function readExactArtifactContent(db: DbHandle, artifactId: number): string {
  const row = db.prepare(
    `SELECT a.path,a.content_hash,r.local_path
       FROM artifacts a
       JOIN project_repositories r ON r.id=a.project_repository_id
      WHERE a.id=?`,
  ).get(artifactId) as {
    path: string;
    content_hash: string | null;
    local_path: string;
  } | undefined;
  if (!row || !row.content_hash || !row.local_path) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE: ${artifactId}`);
  }
  const filePath = join(row.local_path, row.path.split('#')[0]!);
  const content = readFileSync(filePath, 'utf8');
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  if (actual !== row.content_hash) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_DRIFT: ${artifactId}`);
  }
  return content;
}
