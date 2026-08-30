import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MaterialRow } from './types.js';

// Content-addressed material store (M0). Identity = digest of (schema_ref, content).
// Execution provenance never enters material identity — that is the ADR-053
// lesson baked in from the first commit.

export function materialDigest(schemaRef: string, content: string): string {
  return createHash('sha256')
    .update(schemaRef)
    .update('\0')
    .update(content, 'utf8')
    .digest('hex');
}

/** Stores material by digest. Re-submitting identical content is a no-op;
 *  a digest collision with different bytes fails closed. */
export function putMaterial(
  db: Database.Database,
  schemaRef: string,
  content: string
): { digest: string; created: boolean } {
  const digest = materialDigest(schemaRef, content);
  const existing = db
    .prepare('SELECT digest, schema_ref, content FROM materials WHERE digest = ?')
    .get(digest) as MaterialRow | undefined;
  if (existing) {
    if (existing.schema_ref !== schemaRef || existing.content !== content) {
      throw new Error(`MATERIAL_DIGEST_COLLISION: ${digest}`);
    }
    return { digest, created: false };
  }
  db.prepare('INSERT INTO materials (digest, schema_ref, content) VALUES (?, ?, ?)')
    .run(digest, schemaRef, content);
  return { digest, created: true };
}

export function getMaterial(db: Database.Database, digest: string): MaterialRow | undefined {
  return db
    .prepare('SELECT digest, schema_ref, content, ts FROM materials WHERE digest = ?')
    .get(digest) as MaterialRow | undefined;
}

export function requireMaterial(db: Database.Database, digest: string): MaterialRow {
  const row = getMaterial(db, digest);
  if (!row) {
    throw new Error(`MATERIAL_NOT_FOUND: ${digest}`);
  }
  return row;
}
