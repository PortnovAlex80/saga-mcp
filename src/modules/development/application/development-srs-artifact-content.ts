/**
 * Read the accepted SRS document content for a DevelopmentCase's lineage
 * `srs` reference (workshop fix: module-manifest coverage needs the SRS
 * body, not just its ContentAddressedReference).
 *
 * Access path follows the EXISTING precedent (formalization's
 * `readExactArtifactContent` / `srs-contract-validator`): resolve the case's
 * `artifact:<id>` ref through the artifacts + project_repositories tables,
 * read the file from the product repository checkout, and verify byte-level
 * integrity against `artifacts.content_hash`. No schema or case-field
 * changes; no recency lookups — the id comes from the frozen case lineage.
 *
 * Outcomes are explicit so the caller can stay fail-open for legacy cases
 * (artifact absent or unreadable → informational skip) while treating a
 * readable-but-drifted file as an integrity failure (fail closed): a drifted
 * manifest cannot be trusted for coverage decisions.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';
import type { ContentAddressedReference } from '../domain/development-schemas.js';

export type DevelopmentSrsContentResult =
  | { status: 'read'; content: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'drifted'; path: string; expectedHash: string };

export function readDevelopmentCaseSrsContent(
  db: SqlDatabasePort,
  srs: ContentAddressedReference,
): DevelopmentSrsContentResult {
  if (!srs.ref.startsWith('artifact:')) {
    return {
      status: 'unavailable',
      reason: `srs ref '${srs.ref}' is not an artifact reference (legacy lineage)`,
    };
  }
  const artifactId = Number(srs.ref.slice('artifact:'.length));
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
    return {
      status: 'unavailable',
      reason: `srs ref '${srs.ref}' does not carry a numeric artifact id`,
    };
  }
  let row: { path: string; content_hash: string | null; local_path: string } | undefined;
  try {
    row = db.prepare(
      `SELECT a.path,a.content_hash,r.local_path
         FROM artifacts a
         JOIN project_repositories r ON r.id=a.project_repository_id
        WHERE a.id=?`,
    ).get(artifactId) as typeof row;
  } catch {
    return {
      status: 'unavailable',
      reason: `the artifacts/project_repositories tables are not readable (artifact ${artifactId})`,
    };
  }
  if (!row || !row.content_hash || !row.local_path) {
    return {
      status: 'unavailable',
      reason: `SRS artifact ${artifactId} has no repository binding or content hash`,
    };
  }
  const filePath = join(row.local_path, row.path.split('#')[0]!);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {
      status: 'unavailable',
      reason: `SRS artifact file ${row.path} is not readable from the repository checkout`,
    };
  }
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  if (actual !== row.content_hash) {
    return { status: 'drifted', path: row.path, expectedHash: row.content_hash };
  }
  return { status: 'read', content };
}
