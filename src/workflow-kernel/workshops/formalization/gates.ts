/**
 * workflow-kernel/workshops/formalization/gates.ts - the CheckPlans and
 * semantic gates of the Formalization workshop (WP-11F, plan phase EK-8
 * workshop conversion; R15: CheckPlan is installed-manifest input evidence).
 *
 * Laws implemented here:
 *   - Every gate runs over a DECLARED, deterministic provider from the
 *     installed manifest (checkProviderOfDesk). An undeclared provider is
 *     a typed fail-closed refusal - never a silent pass, never a fallback.
 *   - The semantic gate maps the pure product validators (products.ts) onto
 *     the kernel's frozen verdict vocabulary:
 *       MALFORMED_PRODUCT / MISSING_LINEAGE / STALE_LINEAGE / COVERAGE_GAP
 *         -> repair (the author desk is re-staffed; obligation:requeueRepair)
 *       FOREIGN_LINEAGE -> upstream-repair (the defect belongs to the owning
 *         upstream material; obligation:routeUpstreamRepair - never a
 *         silent scope widen)
 *       DRIFT_DETECTED -> human-wait (operator clarification; TypedWait
 *         via the D5/D12 vocabulary) or terminal-reject on repeated drift
 *   - The CheckPlan evidence fact this module emits is exactly what the
 *     kernel gate guards require (workplace.runAuthorGate / runFinalGate
 *     refuse without CheckPlan evidence in context).
 *
 * PURITY: pure functions only. No session, no SQL, no clock.
 */

import type { EvidenceFact } from '../../domain/types.js';
import type {
  AcceptanceContractProduct,
  AcceptedMaterial,
  BaselineFreezeInputs,
  PrdIntentProduct,
  ProductRefusalReason,
  SolutionContractProduct,
  SrsProduct,
  SystemRequirementsProduct,
  UseCaseScenariosProduct,
  WhatBaselineProduct,
  WhatReconciliationProduct,
} from './products.js';
import {
  validateAcceptanceContract,
  validatePrdIntent,
  validateSolutionContract,
  validateSrs,
  validateSystemRequirements,
  validateUseCaseScenarios,
  validateWhatBaseline,
  validateWhatReconciliation,
} from './products.js';
import type { CheckProviderDeclaration } from './manifest.js';
import { FORMALIZATION_CHECK_PROVIDERS } from './manifest.js';
import { sha256OfCanonical } from '../../domain/digest.js';

/** The gate verdict surface (the kernel's frozen five). */
export type SemanticGateVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

export interface SemanticGateOutcome {
  readonly verdict: SemanticGateVerdict;
  /** Exact typed issues (the RecoveryIssue feedback a repair requeue carries). */
  readonly issues: readonly { readonly source: ProductRefusalReason | 'check-plan'; readonly detail: string }[];
  readonly providerId: string;
  readonly productRef?: string;
}

/** Fail-closed gate refusal (an undeclared provider or unknown desk). */
export interface SemanticGateRefusal {
  readonly refused: true;
  readonly reason: 'PROVIDER_NOT_DECLARED' | 'DESK_NOT_DECLARED';
  readonly detail: string;
}

/** One authored candidate as presented to the gate. */
export type GateCandidate =
  | { readonly kind: 'formalization.prd-intent.v1'; readonly product: PrdIntentProduct }
  | { readonly kind: 'formalization.uc-scenarios.v1'; readonly product: UseCaseScenariosProduct }
  | { readonly kind: 'formalization.system-requirements.v1'; readonly product: SystemRequirementsProduct }
  | { readonly kind: 'formalization.acceptance-bindings.v1'; readonly product: AcceptanceContractProduct }
  | { readonly kind: 'formalization.what-reconciliation.v1'; readonly product: WhatReconciliationProduct }
  | { readonly kind: 'formalization.what-baseline.v1'; readonly product: WhatBaselineProduct; readonly expected: BaselineFreezeInputs }
  | { readonly kind: 'formalization.srs.v1'; readonly product: SrsProduct }
  | { readonly kind: 'formalization.solution-contract.v1'; readonly product: SolutionContractProduct };

/** Run one declared provider's pure validator (deterministic dispatch). */
function runValidator(provider: CheckProviderDeclaration, candidate: GateCandidate, accepted: AcceptedMaterial): ReturnType<typeof validatePrdIntent> {
  if (provider.productKind !== candidate.kind) {
    return {
      ok: false,
      refused: true as const,
      reason: 'MALFORMED_PRODUCT' as ProductRefusalReason,
      detail: `provider ${provider.providerId} gates product kind ${provider.productKind}; the desk presented ${candidate.kind}`,
    };
  }
  switch (candidate.kind) {
    case 'formalization.prd-intent.v1':
      return validatePrdIntent(candidate.product, accepted);
    case 'formalization.uc-scenarios.v1':
      return validateUseCaseScenarios(candidate.product, accepted);
    case 'formalization.system-requirements.v1':
      return validateSystemRequirements(candidate.product, accepted);
    case 'formalization.acceptance-bindings.v1':
      return validateAcceptanceContract(candidate.product, accepted);
    case 'formalization.what-reconciliation.v1':
      return validateWhatReconciliation(candidate.product, accepted);
    case 'formalization.what-baseline.v1':
      return validateWhatBaseline(candidate.product, candidate.expected);
    case 'formalization.srs.v1':
      return validateSrs(candidate.product, accepted);
    case 'formalization.solution-contract.v1':
      return validateSolutionContract(candidate.product, accepted);
  }
}

/** The refusal-reason -> verdict mapping (the frozen routing table). */
const VERDICT_OF_REASON: Readonly<Record<ProductRefusalReason, SemanticGateVerdict>> = {
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'human-wait',
  SCOPE_VIOLATION: 'terminal-reject',
};

/**
 * Evaluate one desk's semantic gate over its declared provider. The verdict
 * is a pure function of (provider declaration, candidate, accepted chain).
 * Fail-closed: the provider must be one of the INSTALLED declarations
 * (providerId + recomputed declaration digest); an impostor or uninstalled
 * provider never runs a validator.
 */
export function evaluateProductGate(
  provider: CheckProviderDeclaration,
  candidate: GateCandidate,
  accepted: AcceptedMaterial,
): SemanticGateOutcome | SemanticGateRefusal {
  const installed = FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.providerId === provider.providerId);
  if (
    installed === undefined ||
    installed.providerDigest !== provider.providerDigest ||
    installed.productKind !== provider.productKind ||
    installed.validator !== provider.validator ||
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
  const validation = runValidator(provider, candidate, accepted);
  if (!validation.ok) {
    return {
      verdict: VERDICT_OF_REASON[validation.reason],
      issues: [{ source: validation.reason, detail: validation.detail }],
      providerId: provider.providerId,
    };
  }
  return {
    verdict: 'accepted',
    issues: [],
    providerId: provider.providerId,
    productRef: validation.artifact.ref,
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
