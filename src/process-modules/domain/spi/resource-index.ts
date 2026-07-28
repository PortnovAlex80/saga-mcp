/**
 * W1-A2 — Pure resource-index types for a Process Module manifest.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §1 row 4.
 *
 * A `ResourceIndexEntry` is a purely declarative pointer at a module-owned
 * resource (a skill file, an instruction doc, a template, a schema, ...). The
 * manifest carries the index; the Wave 2 content-addressed installer resolves
 * every entry under the package root and rejects absolute / traversal paths.
 *
 * This module is PURE DATA ONLY: no functions, no classes, no behavior. Every
 * type here is canonically serializable (plan §3.5) so a manifest carrying
 * these entries round-trips through canonical JSON with a stable digest.
 *
 * `digest` is `sha256Hex` of the resource's raw bytes. Wave 1 callers that do
 * not yet have real resource bytes (no content-addressed store exists until
 * Wave 2) may use the documented placeholder `'pending@wave-2'`; the Wave 2
 * installer replaces it with the real content hash at install time.
 */

/**
 * The set of resource kinds a module manifest may declare. Mirrors the kinds
 * the Wave 2 installer knows how to validate and the generic runtime knows how
 * to surface to an executing node.
 *
 * Adding a kind here is a contract change: the Wave 2 installer, the resource
 * resolver, and the manifest validator must all learn about it. Do not extend
 * ad-hoc.
 */
export type ResourceKind =
  | 'skill'
  | 'instruction'
  | 'reviewer-skill'
  | 'template'
  | 'mcp-call-template'
  | 'checklist'
  | 'schema'
  | 'error-hint'
  | 'description'
  | 'test';

/**
 * The frozen set of accepted `ResourceKind` values. Used by the manifest
 * validator to reject unknown kinds without itself switching on strings.
 */
export const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  'skill',
  'instruction',
  'reviewer-skill',
  'template',
  'mcp-call-template',
  'checklist',
  'schema',
  'error-hint',
  'description',
  'test',
]);

/**
 * A single module-relative resource declaration.
 *
 * @property logicalId  Stable, module-namespaced identifier for the resource
 *                      (e.g. `'semantic-skill'`, `'campaign-template'`). Unique
 *                      within a manifest's `resourceIndex`.
 * @property path       Module-relative POSIX path to the resource file. The
 *                      Wave 2 installer resolves this under the package root.
 * @property kind       One of {@link ResourceKind}. Drives installer validation.
 * @property digest     `sha256Hex` of the resource bytes, OR the documented
 *                      placeholder `'pending@wave-2'` when Wave 1 callers have
 *                      no real bytes yet. The installer replaces the placeholder
 *                      at install time.
 */
export interface ResourceIndexEntry {
  readonly logicalId: string;
  readonly path: string;
  readonly kind: ResourceKind;
  readonly digest: string;
}
