/**
 * workflow-kernel/workshops/delivery/packaging.ts - the local packaging
 * effect and the release record (WP-11L, plan phase EK-8).
 *
 * IDEMPOTENT EFFECTS (assignment point 5): packaging runs EXACTLY ONCE per
 * accepted candidate. The effect is keyed by the integrated-candidate
 * digest into a content-addressed release store (a directory the operator
 * provisions); a re-package of the same candidate observes the existing
 * artifact and returns already-applied with the SAME package digest -
 * never a second artifact, never an invented success. The kernel side of
 * the same law is workplace.settleEffect: the first run settles
 * EffectReceipt:success, a duplicate settles EffectReceipt:already-applied
 * (both success-shaped receipts; D2).
 *
 * LOCAL PACKAGING ONLY: the effect reads the declared product-tree entries
 * and assembles the release package in the store. There is no network, no
 * registry, no deployment system and no credential anywhere in this module
 * - qualification of the release stage NEVER depends on them.
 *
 * THE RELEASE RECORD is the immutable output product: one write-once
 * record per candidate digest binding the certificate, the bundle, the
 * candidate, the preflight, the approval decision, the publication and the
 * destinations. A SECOND record for the same candidate is refused typed
 * (DUPLICATE_RELEASE - the duplicate-release mutation); a replay of the
 * identical record replays (replayed: true).
 *
 * This module is the effect boundary: it writes ONLY the release store
 * directory, never a factory table. Receipts enter the kernel through the
 * conveyor's public command path.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256OfCanonical } from '../../domain/digest.js';
import type { VerifiedDevelopmentBundle } from './bundle.js';
import { DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT } from './manifest.js';

/* ------------------------------------------------------------------ */
/* The packaging input declaration                                     */
/* ------------------------------------------------------------------ */

/** The declared product-tree entries the local package assembles. */
export interface PackagingInputDeclaration {
  readonly productRoot: string;
  readonly entries: readonly string[];
}

/** The default declared entries of the canonical simple product tree. */
export const DEFAULT_PACKAGING_ENTRIES: readonly string[] = [
  'src/server.js',
  'public/index.html',
  'public/app.js',
  'package.json',
  'acceptance-contract.json',
];

/* ------------------------------------------------------------------ */
/* The local packaging effect (exactly-once per candidate)             */
/* ------------------------------------------------------------------ */

export const RELEASE_PACKAGE_SCHEMA = 'delivery.local-release-package.v1';

/** The assembled local release package (the output product). */
export interface ReleasePackage {
  readonly schemaVersion: typeof RELEASE_PACKAGE_SCHEMA;
  readonly candidateDigest: string;
  readonly entries: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly packageDigest: string;
  readonly externalDeployment: false;
}

/** One packaging run outcome (the D2 effect shapes this workshop may settle). */
export type PackagingOutcome =
  | { readonly status: 'success'; readonly packaged: ReleasePackage }
  | { readonly status: 'already-applied'; readonly packaged: ReleasePackage }
  | { readonly refused: true; readonly reason: 'PACKAGING_INPUT_MISSING' | 'PACKAGING_ENTRY_MISMATCH'; readonly detail: string; readonly paths?: readonly string[] };

function manifestPath(storeRoot: string, candidateDigest: string): string {
  return join(storeRoot, 'releases', candidateDigest, 'package-manifest.json');
}

function assemblePackagingInput(declaration: PackagingInputDeclaration): { readonly entries: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[] } | { readonly missing: readonly string[] } {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  const missing: string[] = [];
  for (const rel of declaration.entries) {
    const path = join(declaration.productRoot, rel);
    if (!existsSync(path)) {
      missing.push(rel);
      continue;
    }
    const bytes = readFileSync(path);
    entries.push({ path: rel, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return missing.length > 0 ? { missing } : { entries };
}

/**
 * Run the local packaging effect for one accepted candidate. Exactly-once:
 * an existing manifest for the candidate digest is read back and returned
 * as already-applied (byte-identical digest); otherwise the package is
 * assembled deterministically and written once.
 */
export function runLocalPackaging(
  storeRoot: string,
  bundle: VerifiedDevelopmentBundle,
  declaration: PackagingInputDeclaration,
): PackagingOutcome {
  const candidateDigest = bundle.integratedCandidate.digest;
  const manifest = manifestPath(storeRoot, candidateDigest);

  // Idempotent re-drive: the artifact already exists for THIS candidate.
  if (existsSync(manifest)) {
    const existing = JSON.parse(readFileSync(manifest, 'utf8')) as ReleasePackage;
    if (existing.schemaVersion !== RELEASE_PACKAGE_SCHEMA || existing.candidateDigest !== candidateDigest) {
      return {
        refused: true,
        reason: 'PACKAGING_ENTRY_MISMATCH',
        detail: `release store manifest for ${candidateDigest} does not verify (schema ${existing.schemaVersion}, candidate ${existing.candidateDigest})`,
      };
    }
    return { status: 'already-applied', packaged: existing };
  }

  const assembled = assemblePackagingInput(declaration);
  if ('missing' in assembled) {
    return {
      refused: true,
      reason: 'PACKAGING_INPUT_MISSING',
      detail: `product-tree entries absent for the local package: ${assembled.missing.join(', ')}`,
      paths: assembled.missing,
    };
  }
  const packageBody = {
    schemaVersion: RELEASE_PACKAGE_SCHEMA,
    candidateDigest,
    entries: [...assembled.entries].sort((a, b) => (a.path < b.path ? -1 : 1)),
    externalDeployment: false as const,
  } as const;
  const packaged: ReleasePackage = { ...packageBody, packageDigest: sha256OfCanonical(packageBody) };
  mkdirSync(join(storeRoot, 'releases', candidateDigest), { recursive: true });
  writeFileSync(manifest, JSON.stringify(packaged, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { status: 'success', packaged };
}

/** Verify a packaged artifact against the bundle candidate (the resume fence). */
export function verifyPackagedRelease(storeRoot: string, candidateDigest: string): { readonly ok: true; readonly packageDigest: string } | { readonly ok: false; readonly detail: string } {
  const manifest = manifestPath(storeRoot, candidateDigest);
  if (!existsSync(manifest)) {
    return { ok: false, detail: `no release package for candidate ${candidateDigest} in the store` };
  }
  const packaged = JSON.parse(readFileSync(manifest, 'utf8')) as ReleasePackage;
  if (packaged.candidateDigest !== candidateDigest || packaged.externalDeployment !== false) {
    return { ok: false, detail: `release package for ${candidateDigest} does not verify (candidate ${packaged.candidateDigest}, externalDeployment ${String(packaged.externalDeployment)})` };
  }
  return { ok: true, packageDigest: packaged.packageDigest };
}

/* ------------------------------------------------------------------ */
/* Pure contribution mappings (through the kernel material chain)       */
/* ------------------------------------------------------------------ */

/**
 * The pure contribution mapping of the release cell: the actor's ordinary
 * packaging output maps onto kernel material-chain inputs (the candidate
 * digest the contribution carries and the revision payload digest). Pure:
 * no I/O, deterministic digests.
 */
export interface ContributionMapping {
  readonly candidateDigest: string;
  readonly contributionDigest: string;
  readonly revisionPayloadDigest: string;
  readonly productContract: string;
}

export function packagingContributionOf(bundle: VerifiedDevelopmentBundle, packaged: ReleasePackage): ContributionMapping {
  return {
    candidateDigest: bundle.integratedCandidate.digest,
    contributionDigest: sha256OfCanonical({ candidate: bundle.integratedCandidate.digest, package: packaged.packageDigest, contract: DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT }),
    revisionPayloadDigest: packaged.packageDigest,
    productContract: DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT,
  };
}

/* ------------------------------------------------------------------ */
/* The release record (write-once per candidate)                       */
/* ------------------------------------------------------------------ */

export const RELEASE_RECORD_SCHEMA_VERSION = 'delivery.release-record.v1';

/** The immutable release record: the second output product. */
export interface ReleaseRecord {
  readonly schemaVersion: typeof RELEASE_RECORD_SCHEMA_VERSION;
  readonly developmentCertificateRef: string;
  readonly verifiedBundleRef: string;
  readonly integratedCandidateRef: string;
  readonly policyDigest: string;
  readonly preflightDigest: string;
  readonly approvalRef: string;
  readonly packageDigest: string;
  readonly recordDigest: string;
}

export type ReleaseRecordOutcome =
  | { readonly recorded: true; readonly record: ReleaseRecord }
  | { readonly replayed: true; readonly record: ReleaseRecord }
  | { readonly refused: true; readonly reason: 'DUPLICATE_RELEASE'; readonly detail: string; readonly recordDigest: string };

/**
 * Assemble and seal the release record into the store. Write-once per
 * candidate: an existing record for the candidate replays only when
 * byte-identical (same recordDigest); any different second record is the
 * typed DUPLICATE_RELEASE refusal.
 */
export function assembleReleaseRecord(
  storeRoot: string,
  input: {
    readonly bundle: VerifiedDevelopmentBundle;
    readonly policyDigest: string;
    readonly preflightDigest: string;
    readonly approvalRef: string;
    readonly packageDigest: string;
  },
): ReleaseRecordOutcome {
  const candidateDigest = input.bundle.integratedCandidate.digest;
  const body = {
    schemaVersion: RELEASE_RECORD_SCHEMA_VERSION,
    developmentCertificateRef: input.bundle.developmentCertificate.ref,
    verifiedBundleRef: input.bundle.bundleRef,
    integratedCandidateRef: input.bundle.integratedCandidate.ref,
    policyDigest: input.policyDigest,
    preflightDigest: input.preflightDigest,
    approvalRef: input.approvalRef,
    packageDigest: input.packageDigest,
  } as const;
  const recordDigest = sha256OfCanonical(body);
  const path = join(storeRoot, 'records', `${candidateDigest}.json`);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as ReleaseRecord;
    if (existing.recordDigest === recordDigest) {
      return { replayed: true, record: existing };
    }
    return {
      refused: true,
      reason: 'DUPLICATE_RELEASE',
      detail: `a release record for candidate ${candidateDigest} already exists (record ${existing.recordDigest}); a second, different record for one candidate is the duplicate-release refusal`,
      recordDigest,
    };
  }
  const record: ReleaseRecord = { ...body, recordDigest };
  mkdirSync(join(storeRoot, 'records'), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { recorded: true, record };
}
