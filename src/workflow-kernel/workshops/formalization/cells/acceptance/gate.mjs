/**
 * FRF-WP06 define-acceptance-contract cell - THE CELL GATE.
 *
 * Evaluates the desk's declared provider over an authored candidate
 * (shape pinned to gates.ts evaluateProductGate): fail-closed provider
 * verification (the declaration digest is recomputed, never trusted),
 * then the bundle validator (closure.mjs), then the frozen
 * refusal-reason -> verdict routing.
 *
 * VERDICT_OF_REASON is PINNED to gates.ts (the installed routing
 * table): MALFORMED_PRODUCT/MISSING_LINEAGE/STALE_LINEAGE/COVERAGE_GAP
 * -> repair; FOREIGN_LINEAGE -> upstream-repair; DRIFT_DETECTED ->
 * human-wait; SCOPE_VIOLATION -> terminal-reject. The focused test
 * reads the installed gates.ts source and refuses on drift.
 *
 * PURITY: pure functions. No I/O, no clock, no session.
 */

import { sha256OfCanonical } from '../../contracts/validators/common.mjs';
import { ACCEPTANCE_CHECK_PROVIDER, acceptanceProviderDigest } from './check-plan.mjs';
import { validateAcceptanceBundle } from './closure.mjs';

/** The gate verdict surface (the kernel's frozen five). */
export const GATE_VERDICTS = Object.freeze([
  'accepted',
  'repair',
  'upstream-repair',
  'human-wait',
  'terminal-reject',
]);

/** The refusal-reason -> verdict routing (pinned to gates.ts VERDICT_OF_REASON). */
export const VERDICT_OF_REASON = Object.freeze({
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'human-wait',
  SCOPE_VIOLATION: 'terminal-reject',
});

/** Fail-closed gate refusal (an undeclared/impostor provider). */
export function providerNotDeclared(provider, detail) {
  return { refused: true, reason: 'PROVIDER_NOT_DECLARED', providerId: provider?.providerId ?? '<none>', detail };
}

/**
 * Evaluate the acceptance cell's semantic gate.
 *
 * @param {object} providerDeclaration the presented provider declaration
 * @param {object} candidate { kind, product } - kind must equal the
 *   provider's productKind; product is the acceptance bundle
 * @param {object} universe the accepted id-set universe (acceptanceUniverseFrom)
 * @param {readonly object[]} requirements the accepted bundle members
 */
export function evaluateAcceptanceGate(providerDeclaration, candidate, universe, requirements) {
  const declaredDigest = acceptanceProviderDigest();
  const isInstalled =
    providerDeclaration !== null &&
    typeof providerDeclaration === 'object' &&
    providerDeclaration.providerId === ACCEPTANCE_CHECK_PROVIDER.providerId &&
    providerDeclaration.version === ACCEPTANCE_CHECK_PROVIDER.version &&
    providerDeclaration.nodeId === ACCEPTANCE_CHECK_PROVIDER.nodeId &&
    providerDeclaration.productKind === ACCEPTANCE_CHECK_PROVIDER.productKind &&
    providerDeclaration.validator === ACCEPTANCE_CHECK_PROVIDER.validator &&
    providerDeclaration.providerDigest === declaredDigest &&
    declaredDigest ===
      sha256OfCanonical({
        providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
        version: ACCEPTANCE_CHECK_PROVIDER.version,
        nodeId: ACCEPTANCE_CHECK_PROVIDER.nodeId,
        productKind: ACCEPTANCE_CHECK_PROVIDER.productKind,
        validator: ACCEPTANCE_CHECK_PROVIDER.validator,
      });
  if (!isInstalled) {
    return providerNotDeclared(
      providerDeclaration,
      `provider ${String(providerDeclaration?.providerId ?? '<none>')} is not the declared acceptance-cell provider (declared digest does not verify); an undeclared provider never gates a product`,
    );
  }
  if (candidate === null || typeof candidate !== 'object' || candidate.kind !== ACCEPTANCE_CHECK_PROVIDER.productKind) {
    return providerNotDeclared(
      providerDeclaration,
      `provider ${ACCEPTANCE_CHECK_PROVIDER.providerId} gates product kind ${ACCEPTANCE_CHECK_PROVIDER.productKind}; the presented kind ${String(candidate?.kind ?? '<none>')} has no declared provider for this desk`,
    );
  }
  const validation = validateAcceptanceBundle(candidate.product, universe, requirements);
  if (!validation.ok) {
    return {
      verdict: VERDICT_OF_REASON[validation.reason] ?? 'repair',
      issues: [{ source: validation.reason, detail: validation.detail }],
      providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
    };
  }
  return {
    verdict: 'accepted',
    issues: [],
    providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
    productRef: validation.artifact.ref,
  };
}
