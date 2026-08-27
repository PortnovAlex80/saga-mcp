/**
 * FRF-WP06 define-acceptance-contract cell - THE CHECKPLAN.
 *
 * The declared deterministic check provider of the FRF acceptance cell
 * and its CheckPlan evidence fact (the exact input fact the kernel gate
 * guards consume - shape pinned to gates.ts checkPlanEvidenceFor).
 *
 * The cell provider id is the FRF cell-scoped successor of the
 * installed formalization.acceptance-structure.v1 row (manifest.ts):
 * at the FRF-WP11 cutover the desk descriptor re-pins to this
 * provider. Until then the cell is test-only reachable; the installed
 * provider keeps gating the installed desk.
 *
 * PURITY: pure data + the WP03 canonical digest rule. No I/O.
 */

import { sha256OfCanonical } from '../../contracts/validators/common.mjs';
import { ACCEPTANCE_CELL_NODE_ID, ACCEPTANCE_CELL_PRODUCT_KIND } from './protocol.mjs';

/** The cell's declared check provider. */
export const ACCEPTANCE_CHECK_PROVIDER = Object.freeze({
  providerId: 'frf.acceptance-closure.v1',
  version: '1.0.0',
  nodeId: ACCEPTANCE_CELL_NODE_ID,
  productKind: ACCEPTANCE_CELL_PRODUCT_KIND,
  validator: 'validateAcceptanceBundle',
  /** The installed provider row this cell succeeds at the WP11 cutover. */
  succeedsInstalledProvider: 'formalization.acceptance-structure.v1',
  repairTargetRole: 'author',
});

/** Recompute the provider declaration digest (never trust a stored one). */
export function acceptanceProviderDigest() {
  return sha256OfCanonical({
    providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
    version: ACCEPTANCE_CHECK_PROVIDER.version,
    nodeId: ACCEPTANCE_CHECK_PROVIDER.nodeId,
    productKind: ACCEPTANCE_CHECK_PROVIDER.productKind,
    validator: ACCEPTANCE_CHECK_PROVIDER.validator,
  });
}

/**
 * The CheckPlan evidence fact of this provider: { kind: 'CheckPlan',
 * ref, producer: 'external-input', payloadDigest } - the kernel
 * Input-authority evidence shape (gates.ts checkPlanEvidenceFor).
 */
export function acceptanceCheckPlanEvidence() {
  return Object.freeze({
    kind: 'CheckPlan',
    ref: `evidence:CheckPlan#${ACCEPTANCE_CHECK_PROVIDER.providerId}`,
    producer: 'external-input',
    payloadDigest: sha256OfCanonical({
      providerId: ACCEPTANCE_CHECK_PROVIDER.providerId,
      version: ACCEPTANCE_CHECK_PROVIDER.version,
      providerDigest: acceptanceProviderDigest(),
      nodeId: ACCEPTANCE_CHECK_PROVIDER.nodeId,
      productKind: ACCEPTANCE_CHECK_PROVIDER.productKind,
      validator: ACCEPTANCE_CHECK_PROVIDER.validator,
    }),
  });
}

/** The ordered checks the gate runs (one detector per named defect). */
export const ACCEPTANCE_CHECK_PLAN = Object.freeze([
  Object.freeze({
    checkId: 'acceptance.check.wp03-per-criterion',
    runs: 'the WP03 validateAcBinding seam, once per criterion, with the accepted id-set universe',
    kills: 'foreign AC refs; RULE bindings; one-sided scenario/branch citation; open evidence vocabulary; WHAT-side keys',
    authority: 'WP03 seam (wp03-seam.mjs)',
  }),
  Object.freeze({
    checkId: 'acceptance.check.duplicate-criterion-ids',
    runs: 'set-level duplicate scan over criterion ids',
    kills: 'duplicate criterion ids (double emission)',
    authority: 'closure.mjs checkAcToSourceClosure',
  }),
  Object.freeze({
    checkId: 'acceptance.check.ac-to-source-closure',
    runs: 'scenario-derived requirement bound => BOTH citation shapes, supported by the bound requirements derivation',
    kills: 'criterion binding scenario-derived FR without UC citation (FR without UC); semantically unrelated scenario substitution',
    authority: 'closure.mjs checkAcToSourceClosure',
  }),
  Object.freeze({
    checkId: 'acceptance.check.requirements-coverage-closure',
    runs: 'every FR/NFR covered by >=1 criterion or explicitly deferred (owner + reason)',
    kills: 'uncovered requirements without deferral; contradictory covered+deferred; RULE deferrals',
    authority: 'closure.mjs checkRequirementsCoverageClosure',
  }),
  Object.freeze({
    checkId: 'acceptance.check.terminal-result-coverage',
    runs: 'every required UC terminal branch covered by a criterion or a well-formed accepted evidence binding',
    kills: 'uncovered required terminal results (cr-05)',
    authority: 'closure.mjs checkTerminalResultCoverage (cr-05)',
  }),
]);
