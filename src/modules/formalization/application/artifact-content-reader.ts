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
import {
  resolveEffectiveRepositoryRoot,
  resolveRepositoryMaterialPath,
} from '../../../shared/effective-repository-path.js';

interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export function readExactArtifactContent(db: DbHandle, artifactId: number): string {
  const row = db.prepare(
    `SELECT a.path,a.content_hash,a.project_repository_id
       FROM artifacts a
      WHERE a.id=?`,
  ).get(artifactId) as {
    path: string;
    content_hash: string | null;
    project_repository_id: number | null;
  } | undefined;
  if (!row || !row.content_hash || row.project_repository_id == null) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE: ${artifactId}`);
  }
  const root = resolveEffectiveRepositoryRoot(db, row.project_repository_id);
  const filePath = root ? resolveRepositoryMaterialPath(root, row.path) : null;
  if (!filePath) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_UNAVAILABLE: ${artifactId}`);
  }
  const content = readFileSync(filePath, 'utf8');
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  if (actual !== row.content_hash) {
    throw new Error(`FORMALIZATION_ARTIFACT_CONTENT_DRIFT: ${artifactId}`);
  }
  return content;
}
