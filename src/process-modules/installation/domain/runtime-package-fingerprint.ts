// src/process-modules/installation/domain/runtime-package-fingerprint.ts
//
// ADR-077 — the canonical RuntimePackageFingerprint (Saga Core Renewal, K4).
//
// One named fingerprint of the EXACT executable contract a lifecycle runs
// under. The digest formula is FROZEN by ADR-077 (it equals
// computePackageDigest over the stamped manifest — the store formula, now
// contract, not implementation detail):
//
//   sha256Hex(canonicalJson({ manifest, resourceIndex, resourceDigests }))
//
// over the STAMPED manifest (real handler digests since K3, install-stamped
// resource digests). Observational data (timestamps, host paths, pids) is
// excluded by construction: none of it is an input.
//
// Extension rule (ADR-077): later releases ADD keyed components (check-plan
// digest in K6, toolchain digests in K19); they never remove or reorder
// existing ones.
//
// # Pure domain
// Only canonical-json + the package-store formula; no fs, no db.

import { computePackageDigest } from './package-store.js';
import type { ResourceBlob } from './package-store.js';
import type { ProcessModuleManifest } from '../../domain/spi/module-manifest.js';

/**
 * The named, canonical package identity (ADR-077).
 *
 * `digest` is THE fingerprint compared across install/verify/resume.
 * `components` are diagnostic projections of the same inputs (never a
 * substitute for the digest): the per-handler implementation digests and the
 * order-canonicalized resource digests, so an operator can see WHAT changed
//  when two fingerprints differ without re-deriving it by hand.
 */
export interface RuntimePackageFingerprint {
  readonly digest: string;
  readonly components: {
    readonly manifestFormatVersion: string;
    readonly moduleRef: string;
    readonly handlerDigests: readonly { readonly logicalId: string; readonly digest: string }[];
    readonly resourceDigests: readonly { readonly logicalId: string; readonly digest: string }[];
  };
}

/**
 * Compute the canonical fingerprint for one package.
 *
 * Preconditions: `manifest` is the STAMPED manifest (installer Step 3.5 ran;
 * handler digests are real per K3 — validation rejects placeholders), and
 * `resources` are the blobs the installer actually stored.
 */
export function computeRuntimePackageFingerprint(
  manifest: ProcessModuleManifest,
  resources: readonly ResourceBlob[],
): RuntimePackageFingerprint {
  const digest = computePackageDigest(manifest, resources);
  const handlerDigests = [...manifest.handlerRefs]
    .map(ref => ({ logicalId: ref.logicalId, digest: ref.digest }))
    .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0));
  const resourceDigests = [...manifest.resourceIndex]
    .map(entry => ({ logicalId: entry.logicalId, digest: entry.digest }))
    .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0));
  return {
    digest,
    components: {
      manifestFormatVersion: manifest.manifestFormatVersion,
      moduleRef: `${manifest.definition.identity.name}@${manifest.definition.identity.version}`,
      handlerDigests,
      resourceDigests,
    },
  };
}
