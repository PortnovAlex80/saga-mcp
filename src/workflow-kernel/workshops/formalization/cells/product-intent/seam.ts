/**
 * cells/product-intent/seam.ts - THE WP03 CONTRACT SEAM of the
 * define-product-intent Production Cell (FRF-WP04; INSTALLED wiring since
 * the FRF-WP11 cutover; plan docs/plans/
 * FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md "Work packages/
 * FRF-WP04" + "Desk contracts/define-product-intent").
 *
 * WHAT THIS SEAM IS (documented honestly; see README.md in this directory):
 *
 *   The semantic authority for a PRD intent member is the FRF-WP03 contract
 *   frf-contracts.prd-intent-member.v1. Since the FRF-WP11 cutover the
 *   contract's CANONICAL HOME is the in-package contracts tree
 *   (src/workflow-kernel/workshops/formalization/contracts/validators/
 *   prd-intent-member.mjs, imported directly below through its .d.mts
 *   declaration; the docs-tree copy is a frozen byte-equal snapshot,
 *   removal-guarded). This cell NEVER re-implements the member contract:
 *   it validates every member through THIS SEAM - a typed port installed
 *   exactly once, content-addressed to the pinned validator bytes.
 *
 *   INSTALLED WIRING (the FRF-WP11 flip): the port self-installs on first
 *   resolution from the in-package validator, pinned by the package's
 *   identity table (contracts/identity.ts; the blocking guard re-hashes
 *   both the canonical file and the docs snapshot against the pin - a
 *   drifted or swapped validator is a red build). The install() function
 *   stays the documented seam surface: a test-side install of the SAME
 *   digest is an idempotent no-op; a swap to a DIFFERENT digest is
 *   refused (CONTRACT_SEAM_REPINNED) - a bypassed or silently-exchanged
 *   validator can never become a silent pass.
 *
 * PURITY: no I/O, no clock, no session. A module-level single-slot
 * registry with a typed re-pin fence (install once; a second install
 * with a DIFFERENT digest is refused).
 */

import { validatePrdIntentMember } from '../../contracts/validators/prd-intent-member.mjs';
import { contractDigestOf } from '../../contracts/identity.js';

/** The WP03 contract identity this cell adopts (never re-declared as logic). */
export const PRODUCT_INTENT_CONTRACT_KIND = 'frf-contracts.prd-intent-member.v1';

/**
 * The accepted-id-set universe the WP03 validator demands (fail-closed
 * lineage resolution). The Cell supplies the EXACT accepted sets carried
 * by the Discovery handoff; the validator refuses any binding that does
 * not resolve against them (the UC-FOREIGN fix target pattern).
 */
export interface ProductIntentAcceptedIdSetUniverse {
  readonly idSets: {
    readonly sourceClaimIds: readonly string[];
    readonly terminalClaimIds?: readonly string[];
  };
}

/** The sealed (accepted) result shape the WP03 validators return. */
export interface ContractSeal {
  readonly ok: true;
  readonly digest: string;
  readonly ref: string;
  readonly kind: string;
}

/** The typed-refusal shape the WP03 validators return (closed vocabulary). */
export interface ContractRefusalShape {
  readonly ok: false;
  readonly refused: true;
  readonly reason: string;
  readonly detail: string;
}

export type ProductIntentContractValidation = ContractSeal | ContractRefusalShape;

/**
 * The port the cell gate calls for EVERY member. `validateMember` must be
 * the WP03 validatePrdIntentMember behavior: deterministic, closed-
 * vocabulary, fail-closed with typed refusal codes.
 */
export interface ProductIntentContractPort {
  readonly contractKind: typeof PRODUCT_INTENT_CONTRACT_KIND;
  /** sha256 over the validator implementation this port fronts (content-addressed seam). */
  readonly validatorDigest: string;
  validateMember(member: unknown, universe: ProductIntentAcceptedIdSetUniverse): ProductIntentContractValidation;
}

/** Fail-closed seam resolution (an unwired seam never gates a product). */
export interface SeamRefusal {
  readonly refused: true;
  readonly reason: 'CONTRACT_SEAM_UNWIRED' | 'CONTRACT_SEAM_REPINNED';
  readonly detail: string;
}

export type SeamResolution =
  | { readonly resolved: true; readonly port: ProductIntentContractPort }
  | SeamRefusal;

let installedPort: ProductIntentContractPort | undefined;

/**
 * The INSTALLED port (FRF-WP11): the in-package WP03 validator behind the
 * pinned digest from the package identity table. Self-installed on first
 * resolution - the seam is never unwired in the installed package.
 */
const INSTALLED_PORT: ProductIntentContractPort = {
  contractKind: PRODUCT_INTENT_CONTRACT_KIND,
  validatorDigest: contractDigestOf('prd-intent-member'),
  validateMember: (member, universe) => validatePrdIntentMember(member, universe) as ProductIntentContractValidation,
};

/**
 * Install the contract port ONCE. A re-install with the same digest is an
 * idempotent no-op; a re-install with a different digest is refused (the
 * seam is pinned, never silently swapped - mutation: validator swap).
 */
export function installProductIntentContract(port: ProductIntentContractPort): { readonly installed: true; readonly validatorDigest: string } | SeamRefusal {
  if (port === null || typeof port !== 'object' || port.contractKind !== PRODUCT_INTENT_CONTRACT_KIND || typeof port.validatorDigest !== 'string' || port.validatorDigest.length === 0 || typeof port.validateMember !== 'function') {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_UNWIRED',
      detail: `the product-intent contract port must carry contractKind ${PRODUCT_INTENT_CONTRACT_KIND}, a validatorDigest and a validateMember function`,
    };
  }
  const pinned = contractDigestOf('prd-intent-member');
  if (port.validatorDigest !== pinned) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_REPINNED',
      detail: `the product-intent contract seam is pinned to the installed validator ${pinned} (contracts/identity.ts); a port carrying ${port.validatorDigest} is refused (the pin is the package identity table; never silently exchanged)`,
    };
  }
  installedPort = port;
  return { installed: true, validatorDigest: port.validatorDigest };
}

/**
 * Resolve the installed port. Since the FRF-WP11 cutover the resolution
 * SELF-INSTALLS the in-package validator port on first use (installed
 * wiring); an external install of the same pinned digest stays an
 * idempotent no-op.
 */
export function resolveProductIntentContract(): SeamResolution {
  if (installedPort === undefined) {
    installedPort = INSTALLED_PORT;
  }
  return { resolved: true, port: installedPort };
}
