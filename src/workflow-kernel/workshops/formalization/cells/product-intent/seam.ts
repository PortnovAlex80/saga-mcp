/**
 * workflow-kernel/workshops/formalization/cells/product-intent/seam.ts -
 * THE WP03 CONTRACT SEAM of the define-product-intent Production Cell
 * (FRF-WP04; plan docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md
 * "Work packages/FRF-WP04" + "Desk contracts/define-product-intent").
 *
 * WHAT THIS SEAM IS (documented honestly; see README.md in this directory):
 *
 *   The semantic authority for a PRD intent member is the FRF-WP03 contract
 *   frf-contracts.prd-intent-member.v1, whose schema and validator live in
 *   the docs tree (docs/refactoring/formalization-frf/contracts/) as pure
 *   .mjs modules. The TypeScript package under src/ CANNOT import them:
 *   tsc compiles src/** only, and the contracts are deliberately not
 *   compiled production modules yet (FRF-WP03: "Adds no artifact type or
 *   mutable storage owner"; the cells ADOPT the contracts, they do not
 *   fork them).
 *
 *   Therefore this cell NEVER re-implements the member contract and NEVER
 *   imports the docs tree. It validates every member through THIS SEAM:
 *   a typed port installed exactly once. Until a port is installed the
 *   gate refuses fail-closed (CONTRACT_SEAM_UNWIRED) - a bypassed
 *   validator can never become a silent pass.
 *
 *   TODAY the port is installed at TEST time by
 *   tests/workflow-kernel/workshops/formalization/cells/support.mjs,
 *   which imports the real WP03 validator
 *   (validators/prd-intent-member.mjs) and pins the port's
 *   validatorDigest to the sha256 of that exact file - the seam is
 *   content-addressed to the WP03 contract bytes. FRF-11 replaces the
 *   test-time injection with installed-package wiring (compiled contracts
 *   pinned by the package manifest); the port shape is already that
 *   wiring's shape, so no cell code changes.
 *
 * PURITY: no I/O, no clock, no session. A module-level single-slot
 * registry with a typed re-pin fence (install once; a second install
 * with a DIFFERENT digest is refused).
 */

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
  if (installedPort !== undefined && installedPort.validatorDigest !== port.validatorDigest) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_REPINNED',
      detail: `the product-intent contract seam is pinned to validator ${installedPort.validatorDigest}; a swap to ${port.validatorDigest} is refused (install once; never silently exchanged)`,
    };
  }
  installedPort = port;
  return { installed: true, validatorDigest: port.validatorDigest };
}

/** Resolve the installed port (fail-closed when nothing is wired). */
export function resolveProductIntentContract(): SeamResolution {
  if (installedPort === undefined) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_UNWIRED',
      detail: 'no WP03 product-intent contract validator is wired into the seam; the cell gate refuses fail-closed instead of guessing validity (see cells/product-intent/README.md)',
    };
  }
  return { resolved: true, port: installedPort };
}

/**
 * TEST-ONLY seam reset (named honestly). Production code never calls this;
 * it exists so the focused suite can prove the UNWIRED and INDETERMINATE
 * behaviors before wiring the real WP03 validator. FRF-11 deletes it
 * together with the test-time injection.
 */
export function resetProductIntentContractSeamForTests(): void {
  installedPort = undefined;
}
