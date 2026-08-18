/**
 * Typed storage policy for an artifact.
 *
 * The artifacts table column `storage_kind` declares where the artifact's
 * authority lives. Checkpoint capture, provisioning, and any integrity check
 * MUST read this through {@link readArtifactStorageKind} rather than parsing
 * the raw column / metadata ad-hoc — the type is the single source of truth
 * for "where do I find this artifact's bytes and how do I verify them".
 *
 *   file_backed  — a real file at `path` under the bound repository's
 *                  local_path. `content_hash` is SHA-256 of the file bytes.
 *                  Repo binding + file existence are mandatory for checkpoint.
 *
 *   db_native    — no physical file is authority. The canonical content lives
 *                  in `metadata.content`; `content_hash` is SHA-256 of
 *                  canonicalJson(metadata.content). A materialized projection
 *                  file MAY exist (e.g. for human review) but is not authority
 *                  and its bytes are never used to verify the artifact.
 *
 *   external_ref — content referenced by an external durable ref (reserved;
 *                  no current producer emits this kind).
 *
 * (the migration ladder that backfilled this column was removed with the
 * pre-production legacy purge; fresh DBs carry the column from CREATE TABLE).
 */
export type ArtifactStorageKind = 'file_backed' | 'db_native' | 'external_ref';

/**
 * Read the storage_kind from a raw row value.
 *
 * Accepts the column value directly (snake_case string from SQLite) or
 * `undefined`/`null` for rows that predate the column. Returns the typed
 * kind, or `null` when the value is absent/unknown — callers (checkpoint
 * capture) treat `null` as a hard fail (`CHECKPOINT_ARTIFACT_STORAGE_KIND_MISSING`)
 * rather than guessing, so a row with no declared storage policy can never
 * silently slip through as file_backed or db_native.
 */
export function readArtifactStorageKind(
  value: string | null | undefined,
): ArtifactStorageKind | null {
  if (value === 'file_backed' || value === 'db_native' || value === 'external_ref') {
    return value;
  }
  return null;
}
