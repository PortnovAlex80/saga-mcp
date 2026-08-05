/**
 * TextSetManifest — the durable representation of a code change as a text
 * product on the universal desk (Conveyor v4 step 3.C.1).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-11-AC-05 ("TextSet
 * сохраняет paths, modes, rename/delete operations and canonical manifest
 * digest") + Conveyor Mental Model v4 §«The one-machine factory».
 *
 * # Why a TextSet
 *
 * Development's product is a CODE CHANGE. v4 says every product is text — but
 * a code change is NOT a concatenation of source files. It is a structured
 * set of path operations: create, modify, rename, delete. Each entry has a
 * path, a media type, a mode, and either a blob ref (for content) or a
 * delete/rename marker. The digest covers the CANONICAL MANIFEST, not the
 * concatenated source — so two semantically-identical changes with different
 * file ordering produce the same digest.
 *
 * This is the Development equivalent of the Formalization artifact-ref bridge
 * and the Discovery proposal-ref bridge: it lets Development place its
 * product on the universal desk as a content-addressed text artifact with a
 * declared schema.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';
import type { ProductRef } from '../../../process-modules/domain/spi/index.js';

/** The schema id for a TextSet product on the universal desk. */
export const TEXT_SET_SCHEMA = 'saga3.text-set.v1' as const;

/** The operation a TextSet entry performs. */
export type TextSetOperation = 'create' | 'modify' | 'rename' | 'delete';

/** One entry in a TextSet manifest. */
export interface TextSetEntry {
  /** Normalized forward-slash relative path (never absolute). */
  readonly path: string;
  readonly operation: TextSetOperation;
  /** Required for 'rename': the source path. */
  readonly fromPath?: string;
  /** Media type of the content (e.g. 'text/x-typescript'). */
  readonly mediaType?: string;
  /** File mode (e.g. '100644'). Optional. */
  readonly mode?: string;
  /** Immutable blob ref for the content. Required for create/modify. */
  readonly blobRef?: string;
  /** SHA-256 digest of the blob content. Required for create/modify. */
  readonly digest?: string;
}

/**
 * A TextSet manifest: the structured set of path operations that IS a code
 * change. The manifest digest is computed over the canonical form of the
 * entries array (sorted by path, stable field order).
 */
export interface TextSetManifest {
  /** Optional base tree ref (Git tree SHA the change applies to). */
  readonly baseTreeRef?: string;
  readonly entries: readonly TextSetEntry[];
}

/**
 * Compute the canonical digest of a TextSetManifest.
 *
 * Entries are sorted by path before hashing, so file ordering does not affect
 * the digest. The digest covers: baseTreeRef (if present), each entry's
 * path/operation/fromPath/mediaType/mode/blobRef/digest — in a fixed key order.
 *
 * REG-11-AC-05: "TextSet сохраняет paths, modes, rename/delete operations and
 * canonical manifest digest."
 */
export function computeTextSetDigest(manifest: TextSetManifest): string {
  const sorted = [...manifest.entries].sort((a, b) => a.path.localeCompare(b.path));
  return sha256Hex({
    baseTreeRef: manifest.baseTreeRef ?? null,
    entries: sorted.map(e => ({
      path: e.path,
      operation: e.operation,
      fromPath: e.fromPath ?? null,
      mediaType: e.mediaType ?? null,
      mode: e.mode ?? null,
      blobRef: e.blobRef ?? null,
      digest: e.digest ?? null,
    })),
  });
}

/**
 * Build a ProductRef for a TextSet product.
 */
export function buildTextSetProductRef(manifest: TextSetManifest): ProductRef {
  const digest = computeTextSetDigest(manifest);
  return {
    schemaId: TEXT_SET_SCHEMA,
    ref: `text-set:${digest}`,
    digest,
  };
}

/**
 * Validate a TextSetEntry's cross-field rules.
 *
 *   - path is non-empty, forward-slash relative, no `..` escape.
 *   - operation is one of the four closed values.
 *   - create/modify require blobRef + digest.
 *   - rename requires fromPath.
 *   - delete requires neither blobRef nor digest.
 */
export function assertValidTextSetEntry(entry: TextSetEntry): void {
  if (!entry.path || typeof entry.path !== 'string') {
    throw new Error('TextSetEntry.path must be a non-empty string');
  }
  if (entry.path.startsWith('/') || entry.path.includes('\\')) {
    throw new Error(`TextSetEntry.path must be relative forward-slash, got '${entry.path}'`);
  }
  if (entry.path.includes('..')) {
    throw new Error(`TextSetEntry.path must not contain '..' (path escape): '${entry.path}'`);
  }
  if (
    entry.operation !== 'create'
    && entry.operation !== 'modify'
    && entry.operation !== 'rename'
    && entry.operation !== 'delete'
  ) {
    throw new Error(`TextSetEntry.operation must be create|modify|rename|delete, got '${entry.operation}'`);
  }
  if ((entry.operation === 'create' || entry.operation === 'modify')) {
    if (!entry.blobRef) {
      throw new Error(`TextSetEntry '${entry.path}': ${entry.operation} requires blobRef`);
    }
    if (!entry.digest || !/^[a-f0-9]{64}$/i.test(entry.digest)) {
      throw new Error(`TextSetEntry '${entry.path}': ${entry.operation} requires a 64-char hex digest`);
    }
  }
  if (entry.operation === 'rename' && !entry.fromPath) {
    throw new Error(`TextSetEntry '${entry.path}': rename requires fromPath`);
  }
  if (entry.operation === 'delete' && (entry.blobRef || entry.digest)) {
    throw new Error(`TextSetEntry '${entry.path}': delete must not carry blobRef/digest`);
  }
}

/**
 * Validate a full TextSetManifest.
 */
export function assertValidTextSetManifest(manifest: TextSetManifest): void {
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error('TextSetManifest.entries must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    assertValidTextSetEntry(entry);
    if (seen.has(entry.path)) {
      throw new Error(`TextSetManifest duplicate path: '${entry.path}'`);
    }
    seen.add(entry.path);
  }
}
