/**
 * workflow-kernel/workshops/formalization/gates.ts - the CheckPlans and
 * semantic gates of the Formalization workshop (WP-11F; R15: CheckPlan is
 * installed-manifest input evidence). FRF-WP11 CUTOVER: the gate surface
 * stays (declared providers, verdict routing, CheckPlan evidence); the
 * semantic AUTHORITY is the FRF cells package (WP04-09) through
 * ./cells/dispatch.mjs - the old products.ts desk validators (the folded
 * what-baseline shape, the hardcoded-consistent reconciliation, the
 * binding-blind settlement) are DELETED; there is no forwarding facade
 * and no dual path.
 *
 * Laws implemented here:
 *   - Every gate runs over a DECLARED, deterministic provider from the
 *     installed manifest (checkProviderOfDesk). An undeclared provider is
 *     a typed fail-closed refusal - never a silent pass, never a fallback.
 *   - The dispatch runs the OWNING cell's gate with the universe derived
 *     from the accepted chain (ADR-053: revision material decides); the
 *     cell's own provider fence (impostor digest, kind mismatch) fails
 *     closed before any validator runs.
 *   - The verdict vocabulary stays the kernel's frozen five; the cells'
 *     outcome routing (repair / upstream-repair / human-wait / terminal-
 *     reject) propagates verbatim - never widened here.
 *   - The CheckPlan evidence fact this module emits is exactly what the
 *     kernel gate guards require (workplace.runAuthorGate / runFinalGate
 *     refuse without CheckPlan evidence in context).
 *
 * PURITY: pure functions only. No session, no SQL, no clock.
 */

import type { EvidenceFact } from '../../domain/types.js';
import type { CheckProviderDeclaration } from './manifest.js';
import { FORMALIZATION_CHECK_PROVIDERS } from './manifest.js';
import { sha256OfCanonical } from '../../domain/digest.js';
import type { AcceptedChain, DeskCandidate, DeskDispatch } from './cells/dispatch.mjs';
import { evaluateDeskCandidate } from './cells/dispatch.mjs';

/** The gate verdict surface (the kernel's frozen five). */
export type SemanticGateVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/** One typed gate issue (the RecoveryIssue feedback a repair requeue carries). */
export interface SemanticGateIssue {
  readonly source: string;
  readonly detail: string;
}

export interface SemanticGateOutcome {
  readonly verdict: SemanticGateVerdict;
  readonly issues: readonly SemanticGateIssue[];
  readonly providerId: string;
  readonly productRef?: string;
  /** The chain-advancing fold (present only on an accepted desk). */
  readonly fold?: unknown;
  /** The typed wait a freeze-drift/indeterminate desk opened (D5/D12 vocabulary). */
  readonly wait?: unknown;
  /** The desk-level outcome of a non-accepting kernel desk (frozen/drift/indeterminate; inconsistent/failed). */
  readonly deskOutcome?: string;
}

/** Fail-closed gate refusal (an undeclared provider, an unknown desk, or a cell-side infrastructure miss). */
export type SemanticGateRefusalReason =
  | 'PROVIDER_NOT_DECLARED'
  | 'DESK_NOT_DECLARED'
  | 'PRODUCT_KIND_MISMATCH'
  | 'CONTRACT_SEAM_UNWIRED'
  | 'UPSTREAM_NOT_SUPPLIED';

export interface SemanticGateRefusal {
  readonly refused: true;
  readonly reason: SemanticGateRefusalReason;
  readonly detail: string;
}

/**
 * Evaluate one desk's semantic gate over its declared provider. The verdict
 * is a pure function of (provider declaration, candidate, accepted chain).
 * Fail-closed: the provider must be one of the INSTALLED declarations
 * (providerId + recomputed declaration digest); an impostor or uninstalled
 * provider never runs a validator.
 */
export function evaluateProductGate(
  provider: CheckProviderDeclaration,
  candidate: DeskCandidate,
  accepted: AcceptedChain,
): SemanticGateOutcome | SemanticGateRefusal {
  const installed = FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.providerId === provider.providerId);
  if (
    installed === undefined ||
    installed.providerDigest !== provider.providerDigest ||
    installed.productKind !== provider.productKind ||
    installed.validator !== provider.validator ||
    installed.nodeId !== provider.nodeId ||
    provider.providerDigest !== sha256OfCanonical({ providerId: provider.providerId, version: provider.version, nodeId: provider.nodeId, productKind: provider.productKind, validator: provider.validator })
  ) {
    return {
      refused: true,
      reason: 'PROVIDER_NOT_DECLARED',
      detail: `provider ${provider.providerId} is not one of the installed declarations (declared digest ${provider.providerDigest} does not verify); an undeclared provider never gates a product`,
    };
  }
  if (provider.productKind !== candidate.kind) {
    return {
      refused: true,
      reason: 'PROVIDER_NOT_DECLARED',
      detail: `provider ${provider.providerId} declares product kind ${provider.productKind}; the presented kind ${candidate.kind} has no declared provider for this desk`,
    };
  }
  const dispatch: DeskDispatch = evaluateDeskCandidate(provider.nodeId, candidate, accepted);
  if (!('verdict' in dispatch)) {
    const reason: SemanticGateRefusalReason =
      dispatch.reason === 'DESK_NOT_INSTALLED' ? 'DESK_NOT_DECLARED'
        : dispatch.reason === 'PRODUCT_KIND_MISMATCH' || dispatch.reason === 'CONTRACT_SEAM_UNWIRED' || dispatch.reason === 'UPSTREAM_NOT_SUPPLIED' ? dispatch.reason
          : 'PROVIDER_NOT_DECLARED';
    return {
      refused: true,
      reason,
      detail: dispatch.detail,
    };
  }
  return {
    verdict: dispatch.verdict,
    issues: [...dispatch.issues],
    providerId: dispatch.providerId,
    ...(dispatch.productRef !== undefined && dispatch.productRef !== null ? { productRef: dispatch.productRef } : {}),
    ...(dispatch.fold !== undefined ? { fold: dispatch.fold } : {}),
    ...(dispatch.wait !== undefined && dispatch.wait !== null ? { wait: dispatch.wait } : {}),
    ...(dispatch.outcome !== undefined ? { deskOutcome: dispatch.outcome } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* CheckPlan evidence (R15: installed-manifest input)                  */
/* ------------------------------------------------------------------ */

/**
 * The CheckPlan evidence fact of one desk's declared provider: the exact
 * input fact the kernel gate guards consume (payloadDigest over the
 * provider declaration, recomputed here - never a declared digest). The
 * fact references the installed manifest's declaration; its producer is
 * the kernel's closed Input-authority producer string.
 */
export function checkPlanEvidenceFor(provider: CheckProviderDeclaration): EvidenceFact {
  return {
    kind: 'CheckPlan',
    ref: `evidence:CheckPlan#${provider.providerId}`,
    producer: 'external-input',
    payloadDigest: sha256OfCanonical({
      providerId: provider.providerId,
      version: provider.version,
      providerDigest: provider.providerDigest,
      nodeId: provider.nodeId,
      productKind: provider.productKind,
      validator: provider.validator,
    }),
  };
}

/** The external Input-authority evidence set of a full formalization run. */
export function formalizationExternalEvidence(
  providers: readonly CheckProviderDeclaration[],
  productVerification: { readonly ok: boolean; readonly digest: string },
): readonly EvidenceFact[] {
  const facts: EvidenceFact[] = providers.map(checkPlanEvidenceFor);
  facts.push(
    productVerification.ok
      ? { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input', payloadDigest: productVerification.digest }
      : { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input', payloadDigest: productVerification.digest },
  );
  return facts;
}
