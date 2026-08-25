/**
 * workflow-kernel/workshops/development/products.ts - the input/output
 * PRODUCT SCHEMAS of the converted workshop (WP-11V, plan EK-8): the
 * integrated candidate, the readiness manifest and the verified bundle.
 *
 * Phase mapping over the frozen kernel commands (no new kind anywhere):
 *   implementation  author contribution  -> IntegratedCandidate (input of review)
 *   review          reviewer loop        -> verdict payload (input of integration)
 *   integration     workplace.runFinalGate(accepted) -> AcceptedCandidateAuthority
 *   freeze          workplace.settleEffect -> ReadinessManifest (input of certification)
 *   readiness       TypedWait:human-input + operator disposition (Elite-2)
 *   certification   readiness cannot be observed by the machine -> D12-class
 *                   operator disposition through workplace.resolveHumanResponse
 *   verified        terminal proofs + lifecycleRun.verifyTerminalClaims ->
 *                   VerifiedBundle (the workshop output)
 *
 * PURITY: imports only the pure kernel digest rule. No I/O, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';

/* ------------------------------------------------------------------ */
/* Typed product refusals (workshop-level, closed set)                 */
/* ------------------------------------------------------------------ */

export type ProductRefusalCode =
  | 'PRODUCT_SCHEMA_MISMATCH'
  | 'PRODUCT_FIELD_MALFORMED'
  | 'PRODUCT_DIGEST_DRIFT';

export interface ProductRefusal {
  readonly refused: true;
  readonly code: ProductRefusalCode;
  readonly detail: string;
}

export type ProductValidation<T> = { readonly valid: true; readonly value: T } | ProductRefusal;

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const CONTENT_REF = /^(?:sha256:[0-9a-f]{64}|evidence:[^#]+#\d+|[a-z-]+:[^\s]+)$/;

function productRefused(code: ProductRefusalCode, detail: string): ProductRefusal {
  return { refused: true, code, detail };
}

/* ------------------------------------------------------------------ */
/* IntegratedCandidate (input of the review phase)                     */
/* ------------------------------------------------------------------ */

/** The author's integrated product candidate entering review. */
export interface IntegratedCandidate {
  readonly schemaId: 'workshop.development.integrated-candidate.v1';
  readonly capsuleRef: string;
  /** sha256 (hex) over the produced material bytes. */
  readonly productDigest: string;
  /** Content-addressed requirement refs the candidate covers. */
  readonly scopeRefs: readonly string[];
  /** sha256 (hex) over the canonical tool-call record. */
  readonly toolCallDigest: string;
  readonly summary: string;
}

export function isIntegratedCandidate(value: unknown): value is IntegratedCandidate {
  const candidate = value as Partial<IntegratedCandidate>;
  return candidate?.schemaId === 'workshop.development.integrated-candidate.v1'
    && typeof candidate.capsuleRef === 'string'
    && DIGEST_HEX.test(candidate.productDigest ?? '')
    && Array.isArray(candidate.scopeRefs)
    && candidate.scopeRefs.length > 0
    && DIGEST_HEX.test(candidate.toolCallDigest ?? '')
    && typeof candidate.summary === 'string';
}

export function validateIntegratedCandidate(value: unknown): ProductValidation<IntegratedCandidate> {
  if (!isIntegratedCandidate(value)) {
    return productRefused('PRODUCT_SCHEMA_MISMATCH', 'an integrated candidate requires capsuleRef, a sha256 productDigest, non-empty scopeRefs, a toolCallDigest and a summary');
  }
  for (const ref of value.scopeRefs) {
    if (typeof ref !== 'string' || !CONTENT_REF.test(ref)) {
      return productRefused('PRODUCT_FIELD_MALFORMED', `scope ref ${String(ref)} is not a content/evidence reference`);
    }
  }
  return { valid: true, value };
}

/** The canonical product digest (content address of the candidate). */
export function integratedCandidateDigest(candidate: IntegratedCandidate): string {
  return sha256OfCanonical(candidate);
}

/* ------------------------------------------------------------------ */
/* ReadinessManifest (input of the certification phase)                */
/* ------------------------------------------------------------------ */

/** What the machine observed about the frozen product before certification. */
export type MachineObservation =
  | 'product-verified'
  | 'product-verification-failed';

/**
 * The freeze-boundary readiness manifest. The MACHINE-OBSERVABLE facts are
 * carried as evidence; the readiness-for-certification disposition itself
 * is explicitly NOT machine-observable (the Elite-2 class) - the manifest
 * names the operator disposition it waits for.
 */
export interface ReadinessManifest {
  readonly schemaId: 'workshop.development.readiness-manifest.v1';
  readonly capsuleRef: string;
  readonly workplaceInstanceId: string;
  readonly machineObservation: MachineObservation;
  /** Digest of the machine verification evidence (ok or failure detail). */
  readonly verificationDigest: string;
  /** The kernel evidence kinds already committed for the frozen product. */
  readonly settledEvidenceKinds: readonly string[];
  /** The exact fact the machine cannot observe (certification waits on it). */
  readonly unobservable: 'readiness-for-certification';
  readonly requiredDisposition: {
    readonly kind: 'TypedWait:human-input';
    readonly wakeCommand: 'workplace.resolveHumanResponse';
    readonly operatorDispositionRequired: true;
  };
}

export function isReadinessManifest(value: unknown): value is ReadinessManifest {
  const manifest = value as Partial<ReadinessManifest>;
  return manifest?.schemaId === 'workshop.development.readiness-manifest.v1'
    && typeof manifest.capsuleRef === 'string'
    && typeof manifest.workplaceInstanceId === 'string'
    && (manifest.machineObservation === 'product-verified' || manifest.machineObservation === 'product-verification-failed')
    && DIGEST_HEX.test(manifest.verificationDigest ?? '')
    && Array.isArray(manifest.settledEvidenceKinds)
    && manifest.unobservable === 'readiness-for-certification'
    && manifest.requiredDisposition?.kind === 'TypedWait:human-input'
    && manifest.requiredDisposition?.wakeCommand === 'workplace.resolveHumanResponse'
    && manifest.requiredDisposition?.operatorDispositionRequired === true;
}

export function validateReadinessManifest(value: unknown): ProductValidation<ReadinessManifest> {
  if (!isReadinessManifest(value)) {
    return productRefused('PRODUCT_SCHEMA_MISMATCH', 'a readiness manifest requires the machine observation, the settled evidence kinds and the exact operator-disposition requirement');
  }
  return { valid: true, value };
}

export function readinessManifestDigest(manifest: ReadinessManifest): string {
  return sha256OfCanonical(manifest);
}

/* ------------------------------------------------------------------ */
/* VerifiedBundle (the workshop output)                                */
/* ------------------------------------------------------------------ */

/** The terminal-verified output bundle of the workshop run. */
export interface VerifiedBundle {
  readonly schemaId: 'workshop.development.verified-bundle.v1';
  readonly capsuleRef: string;
  readonly workplaceInstanceId: string;
  /** The CellFinalAcceptance digest (D11 - embedded in the acceptance fact). */
  readonly acceptanceDigest: string;
  /** Every terminal proof kind the verified bundle carries. */
  readonly terminalProofs: readonly string[];
  /** The certified terminal-claim coverage refs (capsule AC/TC digests). */
  readonly claimCoverageRefs: readonly string[];
  readonly runTerminalOutcome: 'success';
}

export function isVerifiedBundle(value: unknown): value is VerifiedBundle {
  const bundle = value as Partial<VerifiedBundle>;
  return bundle?.schemaId === 'workshop.development.verified-bundle.v1'
    && typeof bundle.capsuleRef === 'string'
    && typeof bundle.workplaceInstanceId === 'string'
    && DIGEST_HEX.test(bundle.acceptanceDigest ?? '')
    && Array.isArray(bundle.terminalProofs)
    && bundle.terminalProofs.length > 0
    && Array.isArray(bundle.claimCoverageRefs)
    && bundle.runTerminalOutcome === 'success';
}

export function validateVerifiedBundle(value: unknown): ProductValidation<VerifiedBundle> {
  if (!isVerifiedBundle(value)) {
    return productRefused('PRODUCT_SCHEMA_MISMATCH', 'a verified bundle requires the acceptance digest, non-empty terminal proofs and the certified claim coverage');
  }
  for (const proof of value.terminalProofs) {
    if (typeof proof !== 'string' || !proof.startsWith('TerminalProof:')) {
      return productRefused('PRODUCT_FIELD_MALFORMED', `terminal proof ${String(proof)} is not a TerminalProof kind`);
    }
  }
  return { valid: true, value };
}

export function verifiedBundleDigest(bundle: VerifiedBundle): string {
  return sha256OfCanonical(bundle);
}
