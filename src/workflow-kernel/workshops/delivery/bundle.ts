/**
 * workflow-kernel/workshops/delivery/bundle.ts - the verified Development
 * bundle: the Delivery input product and its PUBLIC typed ingress
 * (WP-11L, plan phase EK-8 workshop conversion).
 *
 * The INPUT product contract of this workshop is a content-addressed,
 * immutable bundle of the Development output: the VERIFIED development
 * certificate, the integrated candidate, the verified integration bundle,
 * the terminal lifecycle claims the certificate covers, and the exact
 * package bytes Development produced. Every sub-artifact digest is
 * recomputed over its canonical content at ingress (never trusted as
 * declared) - the same ingress law as the Discovery+Formalization capsule
 * (development/capsule.ts), applied to the Development -> Delivery handoff.
 *
 * The ONLY ingress is `ingressVerifiedBundle`: verify everything, then
 * import through the FactoryRun sole-writer repository commands
 * (factoryRun.bootstrap + factoryRun.importCapsule) into the fresh
 * database. No caller may invoke factoryRun.importCapsule directly for
 * bundle material.
 *
 * Typed fail-closed refusals, in the frozen check order:
 *   STALE_PROTOCOL         bundle protocol version is not the current one;
 *   BYTES_CORRUPT          any verified digest mismatch (bundle
 *                          self-address or any sub-artifact) or package
 *                          bytes that do not hash to the pinned digest;
 *   BYTES_MISSING          package bytes absent/empty;
 *   UNVERIFIED_CERTIFICATE the development certificate is not decision
 *                          "verified" - Delivery may never receive an
 *                          unverified Development output;
 *   FOREIGN_LINEAGE        bundle lineage does not match the operator's
 *                          expected lineage binding (a foreign workshop's
 *                          bundle never enters this database);
 *   ILLEGAL_PARENT_STATE   the producing parent lifecycle is not
 *                          development-terminal;
 *   ACTIVE_ATTEMPT         the target database already holds a live
 *                          (nonterminal) ActivityAttempt.
 *
 * PURITY of verification: node:crypto-free (the domain digest rule only).
 * The single mutation surface is the KernelPersistenceSession passed by
 * the focused tests; this module holds zero SQL.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { CommandOutcome } from '../../domain/types.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';

/** Exact protocol identity of the verified Development bundle. */
export const VERIFIED_BUNDLE_PROTOCOL_VERSION = 'ek.verified-development-bundle.ek8.v1';

/** The one legal producing parent state (Development terminal). */
export const VERIFIED_BUNDLE_LEGAL_PARENT_STATES = ['development-terminal'] as const;
export type VerifiedBundleParentStatus = (typeof VERIFIED_BUNDLE_LEGAL_PARENT_STATES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* The bundle value                                                    */
/* ------------------------------------------------------------------ */

/** One content-addressed sub-artifact: content + its recomputed digest. */
export interface BundleArtifact {
  readonly ref: string;
  readonly digest: string;
  readonly content: unknown;
}

/** Lineage binding: which factory lineage produced this bundle. */
export interface BundleLineage {
  readonly lineageId: string;
  /** The producing (Development) lifecycle reference. */
  readonly parentLifecycleRef: string | null;
}

/** Parent state fact carried inside the bundle (verified, then trusted only after digest check). */
export interface BundleParentState {
  readonly status: VerifiedBundleParentStatus | string;
  readonly terminalProofRef: string;
}

/** The operator-side facts a verified Development bundle is built from. */
export interface VerifiedBundleFacts {
  /** The Development certificate; its decision must be exactly "verified". */
  readonly developmentCertificate: BundleArtifact;
  /** The accepted integrated candidate (the material authority handed off). */
  readonly integratedCandidate: BundleArtifact;
  /** The verified integration bundle evidence. */
  readonly verifiedIntegrationBundle: BundleArtifact;
  /** The terminal lifecycle claims the certificate covers. */
  readonly terminalClaims: readonly BundleArtifact[];
  /** Digest over the local packaging input Development assembled. */
  readonly packagingInput: BundleArtifact;
}

/** The sealed, self-addressed verified Development bundle. */
export interface VerifiedDevelopmentBundle {
  readonly schemaVersion: typeof VERIFIED_BUNDLE_PROTOCOL_VERSION;
  readonly bundleRef: string;
  readonly bundleDigest: string;
  readonly lineage: BundleLineage;
  readonly parentState: BundleParentState;
  readonly developmentCertificate: BundleArtifact;
  readonly integratedCandidate: BundleArtifact;
  readonly verifiedIntegrationBundle: BundleArtifact;
  readonly terminalClaims: readonly BundleArtifact[];
  readonly packagingInput: BundleArtifact;
  /** sha256 (hex) over the exact package bytes. */
  readonly packageBytesDigest: string;
}

/** Helper: seal one artifact (digest recomputed over canonical content). */
export function bundleArtifact(content: unknown): BundleArtifact {
  const digest = sha256OfCanonical(content);
  return { ref: `sha256:${digest}`, digest, content };
}

function stripContent(artifact: BundleArtifact): Omit<BundleArtifact, 'content'> {
  return { ref: artifact.ref, digest: artifact.digest };
}

/**
 * Build the sealed bundle. The bundle digest covers the canonical facts
 * (lineage, parent state, every sub-artifact digest and the package bytes
 * digest) minus the self-referencing keys; bundleRef is DERIVED.
 */
export function buildVerifiedDevelopmentBundle(
  facts: VerifiedBundleFacts,
  lineage: BundleLineage,
  parentState: BundleParentState,
  packageBytes: Uint8Array,
): VerifiedDevelopmentBundle {
  const packageBytesDigest = sha256OfCanonical([...packageBytes]);
  const body = {
    schemaVersion: VERIFIED_BUNDLE_PROTOCOL_VERSION,
    lineage,
    parentState,
    developmentCertificate: stripContent(facts.developmentCertificate),
    integratedCandidate: stripContent(facts.integratedCandidate),
    verifiedIntegrationBundle: stripContent(facts.verifiedIntegrationBundle),
    terminalClaims: facts.terminalClaims.map(stripContent),
    packagingInput: stripContent(facts.packagingInput),
    packageBytesDigest,
  } as const;
  const bundleDigest = sha256OfCanonical(body);
  return {
    ...body,
    schemaVersion: VERIFIED_BUNDLE_PROTOCOL_VERSION,
    developmentCertificate: facts.developmentCertificate,
    integratedCandidate: facts.integratedCandidate,
    verifiedIntegrationBundle: facts.verifiedIntegrationBundle,
    terminalClaims: [...facts.terminalClaims],
    packagingInput: facts.packagingInput,
    bundleRef: `sha256:${bundleDigest}`,
    bundleDigest,
  };
}

/* ------------------------------------------------------------------ */
/* Typed ingress refusals (closed set)                                 */
/* ------------------------------------------------------------------ */

export type BundleIngressRefusalReason =
  | 'STALE_PROTOCOL'
  | 'BYTES_CORRUPT'
  | 'BYTES_MISSING'
  | 'UNVERIFIED_CERTIFICATE'
  | 'FOREIGN_LINEAGE'
  | 'ILLEGAL_PARENT_STATE'
  | 'ACTIVE_ATTEMPT';

export interface BundleIngressRefusal {
  readonly refused: true;
  readonly reason: BundleIngressRefusalReason;
  readonly detail: string;
}

/** What ingress verified and what the kernel committed. */
export interface BundleIngressSuccess {
  readonly imported: true;
  readonly bundleRef: string;
  readonly verified: {
    readonly bundleDigest: string;
    readonly certificateDigest: string;
    readonly certificateDecision: string;
    readonly integratedCandidateDigest: string;
    readonly verifiedIntegrationBundleDigest: string;
    readonly terminalClaimDigests: readonly string[];
    readonly packagingInputDigest: string;
    readonly packageBytesDigest: string;
  };
  /** The CapsuleIngressReceipt evidence ref recorded by factoryRun.importCapsule. */
  readonly ingressReceiptRef: string;
  readonly outcome: Extract<CommandOutcome, { committed: true } | { replayed: true }>;
}

export type BundleIngressResult = BundleIngressSuccess | BundleIngressRefusal;

/** The lineage binding the operator expects this database to accept. */
export interface BundleLineageBinding {
  readonly expectedLineageId: string;
  readonly expectedParentLifecycleRef: string | null;
}

/* ------------------------------------------------------------------ */
/* The PUBLIC ingress                                                  */
/* ------------------------------------------------------------------ */

const FACTORY_INSTANCE = 'factory-run:1';

/**
 * The one public ingress: verify the bundle completely, then import it
 * through the FactoryRun sole-writer repository into the fresh database.
 * Check order is frozen (each class fails closed before the next).
 */
export function ingressVerifiedBundle(
  session: KernelPersistenceSession,
  bundle: VerifiedDevelopmentBundle,
  packageBytes: Uint8Array | undefined,
  binding: BundleLineageBinding,
): BundleIngressResult {
  // 1. Stale protocol.
  if (bundle.schemaVersion !== VERIFIED_BUNDLE_PROTOCOL_VERSION) {
    return refused('STALE_PROTOCOL', `bundle protocol ${bundle.schemaVersion} is not the current ${VERIFIED_BUNDLE_PROTOCOL_VERSION}; stale-protocol bundles are refused at ingress`);
  }

  // 2. Bundle self-address (corrupt bundle bytes).
  const artifacts: readonly [string, BundleArtifact][] = [
    ['developmentCertificate', bundle.developmentCertificate],
    ['integratedCandidate', bundle.integratedCandidate],
    ['verifiedIntegrationBundle', bundle.verifiedIntegrationBundle],
    ['packagingInput', bundle.packagingInput],
    ...bundle.terminalClaims.map((artifact, index): [string, BundleArtifact] => [`terminalClaims[${index}]`, artifact]),
  ];
  const factBody = {
    schemaVersion: bundle.schemaVersion,
    lineage: bundle.lineage,
    parentState: bundle.parentState,
    developmentCertificate: stripContent(bundle.developmentCertificate),
    integratedCandidate: stripContent(bundle.integratedCandidate),
    verifiedIntegrationBundle: stripContent(bundle.verifiedIntegrationBundle),
    terminalClaims: bundle.terminalClaims.map(stripContent),
    packagingInput: stripContent(bundle.packagingInput),
    packageBytesDigest: bundle.packageBytesDigest,
  };
  if (sha256OfCanonical(factBody) !== bundle.bundleDigest || bundle.bundleRef !== `sha256:${bundle.bundleDigest}`) {
    return refused('BYTES_CORRUPT', 'the bundle self-address does not verify against its canonical facts (corrupt bundle bytes)');
  }
  if (!SHA256_HEX.test(bundle.packageBytesDigest)) {
    return refused('BYTES_CORRUPT', `package bytes digest ${bundle.packageBytesDigest} is not a sha256 hex digest`);
  }

  // 3. Package bytes present.
  if (packageBytes === undefined || packageBytes.byteLength === 0) {
    return refused('BYTES_MISSING', 'the bundle package bytes are absent or empty; missing bytes are refused, never fabricated');
  }

  // 4. Every sub-artifact digest recomputed over its canonical content.
  for (const [label, artifact] of artifacts) {
    if (!SHA256_HEX.test(artifact.digest) || artifact.ref !== `sha256:${artifact.digest}`) {
      return refused('BYTES_CORRUPT', `bundle artifact ${label} ref ${artifact.ref} is not the content address of digest ${artifact.digest}`);
    }
    const recomputed = sha256OfCanonical(artifact.content);
    if (recomputed !== artifact.digest) {
      return refused('BYTES_CORRUPT', `bundle artifact ${label} digest ${artifact.digest} does not verify (recomputed ${recomputed})`);
    }
  }
  if (bundle.terminalClaims.length === 0) {
    return refused('BYTES_CORRUPT', 'a bundle without terminal claims is corrupt (the certificate covers nothing)');
  }
  const bytesDigest = sha256OfCanonical([...packageBytes]);
  if (bytesDigest !== bundle.packageBytesDigest) {
    return refused('BYTES_CORRUPT', `package bytes hash ${bytesDigest} != pinned packageBytesDigest ${bundle.packageBytesDigest} (corrupt package bytes)`);
  }

  // 5. Unverified certificate (Delivery never receives an unverified output).
  const decision = certificateDecisionOf(bundle.developmentCertificate);
  if (decision !== 'verified') {
    return refused('UNVERIFIED_CERTIFICATE', `development certificate decision is ${JSON.stringify(decision)}, not "verified"; an unverified Development output never enters the release stage`);
  }

  // 6. Foreign lineage.
  if (bundle.lineage.lineageId !== binding.expectedLineageId) {
    return refused('FOREIGN_LINEAGE', `bundle lineage ${bundle.lineage.lineageId} is not the bound lineage ${binding.expectedLineageId}; a foreign bundle never enters this database`);
  }
  if ((bundle.lineage.parentLifecycleRef ?? null) !== (binding.expectedParentLifecycleRef ?? null)) {
    return refused('FOREIGN_LINEAGE', `bundle parent lifecycle ${String(bundle.lineage.parentLifecycleRef)} is not the bound parent ${String(binding.expectedParentLifecycleRef)}`);
  }

  // 7. Illegal parent state.
  if (!(VERIFIED_BUNDLE_LEGAL_PARENT_STATES as readonly string[]).includes(bundle.parentState.status)) {
    return refused('ILLEGAL_PARENT_STATE', `producing parent state ${bundle.parentState.status} is not one of ${VERIFIED_BUNDLE_LEGAL_PARENT_STATES.join('|')}; a non-terminal Development parent cannot hand off a bundle`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(bundle.parentState.terminalProofRef)) {
    return refused('ILLEGAL_PARENT_STATE', `parent terminal proof ${bundle.parentState.terminalProofRef} is not a content address`);
  }

  // 8. Active attempt in the target world (fresh-run law).
  const world = session.hydrateWorld().world;
  for (const head of world.heads.values()) {
    if (head.aggregate === 'ActivityAttempt' && head.terminal === undefined) {
      return refused('ACTIVE_ATTEMPT', `ActivityAttempt ${head.instanceId} is still live in the target database; bundle ingress requires a fresh run world`);
    }
  }

  // 9. Import through the FactoryRun sole-writer repository (public commands).
  if (!world.heads.has(FACTORY_INSTANCE)) {
    const bootstrap = session.factoryRun.applyCommand({
      command: 'factoryRun.bootstrap',
      instanceId: FACTORY_INSTANCE,
      expectedRevision: 0,
      idempotencyKey: 'bundle-ingress:bootstrap',
      evidenceRefs: [bundle.bundleRef],
    });
    if ('refused' in bootstrap) {
      return refused('ILLEGAL_PARENT_STATE', `factoryRun.bootstrap refused: ${bootstrap.reason}: ${bootstrap.detail}`);
    }
  }
  const head = session.factoryRun.loadHead(FACTORY_INSTANCE);
  const outcome = session.factoryRun.applyCommand({
    command: 'factoryRun.importCapsule',
    instanceId: FACTORY_INSTANCE,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `bundle-ingress:${bundle.bundleRef}`,
    evidenceRefs: [
      bundle.bundleRef,
      bundle.developmentCertificate.ref,
      bundle.integratedCandidate.ref,
      bundle.verifiedIntegrationBundle.ref,
      bundle.packagingInput.ref,
    ],
  });
  if ('refused' in outcome) {
    return refused('ILLEGAL_PARENT_STATE', `factoryRun.importCapsule refused: ${outcome.reason}: ${outcome.detail}`);
  }
  const sequence = 'replayed' in outcome ? outcome.originalEventSequence : (outcome.event?.sequence ?? 0);
  return {
    imported: true,
    bundleRef: bundle.bundleRef,
    verified: {
      bundleDigest: bundle.bundleDigest,
      certificateDigest: bundle.developmentCertificate.digest,
      certificateDecision: decision ?? '',
      integratedCandidateDigest: bundle.integratedCandidate.digest,
      verifiedIntegrationBundleDigest: bundle.verifiedIntegrationBundle.digest,
      terminalClaimDigests: bundle.terminalClaims.map((artifact) => artifact.digest),
      packagingInputDigest: bundle.packagingInput.digest,
      packageBytesDigest: bundle.packageBytesDigest,
    },
    ingressReceiptRef: `evidence:CapsuleIngressReceipt#${sequence}`,
    outcome,
  };
}

/** The decision field of a certificate artifact content (typed, never guessed). */
function certificateDecisionOf(certificate: BundleArtifact): string | undefined {
  if (certificate.content !== null && typeof certificate.content === 'object' && 'decision' in certificate.content) {
    const decision = (certificate.content as { readonly decision?: unknown }).decision;
    return typeof decision === 'string' ? decision : undefined;
  }
  return undefined;
}

/** Typed refusal constructor (the closed ingress vocabulary). */
function refused(reason: BundleIngressRefusalReason, detail: string): BundleIngressRefusal {
  return { refused: true, reason, detail };
}
