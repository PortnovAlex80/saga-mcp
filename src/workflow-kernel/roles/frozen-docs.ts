/**
 * workflow-kernel/roles/frozen-docs.ts - runtime access to the FROZEN EK-1
 * admission documents (WP-17).
 *
 * The frozen schema and manifest are loaded from
 * docs/refactoring/event-kernel/specs/ - the single source of truth. They are
 * never copied into src/ (a second copy would be a mutable authority and
 * would reopen EK-1). Reads are memoized: one read per process per document.
 *
 * PURITY: node builtins only (fs/path/url); no persistence, UI, workshop or
 * transport module.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoleContractManifestDocument } from './shapes.js';

/**
 * Repository root, resolved from THIS compiled module
 * (dist/workflow-kernel/roles/frozen-docs.js -> three levels up).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SPECS_DIR = path.join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'specs');

const ROLE_CONTRACT_SCHEMA_PATH = path.join(SPECS_DIR, 'canonical-role-contract.schema.json');
const ROLE_CONTRACT_MANIFEST_PATH = path.join(SPECS_DIR, 'role-contract-manifest.json');

let cachedSchema: unknown;
let cachedManifest: unknown;

/**
 * The frozen CanonicalRoleContract schema document (draft 2020-12), parsed.
 * The root validates one CanonicalRoleContract; $defs freeze every
 * referenced-artifact shape and the manifest table.
 */
export function loadFrozenRoleContractSchema(): unknown {
  if (cachedSchema === undefined) {
    cachedSchema = JSON.parse(readFileSync(ROLE_CONTRACT_SCHEMA_PATH, 'utf8'));
  }
  return cachedSchema;
}

/**
 * The installed role-contract manifest (the complete launch-kind binding
 * table). Manifest admission itself is validated by the frozen admission
 * validator (npm run validate:ek-admission-specs); consumers here read the
 * rows and the compiler validates each row against $defs/ManifestBinding.
 */
export function loadRoleContractManifest(): RoleContractManifestDocument {
  if (cachedManifest === undefined) {
    cachedManifest = JSON.parse(readFileSync(ROLE_CONTRACT_MANIFEST_PATH, 'utf8'));
  }
  return cachedManifest as RoleContractManifestDocument;
}

/** Clears the memoized documents (test seam; production never needs it). */
export function resetFrozenDocumentCache(): void {
  cachedSchema = undefined;
  cachedManifest = undefined;
}
