/**
 * cells/use-cases/seam.ts - THE WP03 CONTRACT SEAM of the
 * model-use-cases Production Cell (FRF-WP04; INSTALLED wiring since the
 * FRF-WP11 cutover; plan "Desk contracts/model-use-cases").
 *
 * Same honest seam contract as the product-intent cell (see
 * ../product-intent/seam.ts and README.md in this directory): the
 * semantic authority for a UC scenario member is the FRF-WP03 contract
 * frf-contracts.uc-scenario-member.v1 whose CANONICAL HOME is the
 * in-package contracts tree (src/workflow-kernel/workshops/
 * formalization/contracts/validators/uc-scenario-member.mjs; the
 * docs-tree copy is a frozen byte-equal snapshot, removal-guarded).
 * This cell NEVER re-implements the contract; it validates every
 * scenario through this port. Since FRF-WP11 the port SELF-INSTALLS on
 * first resolution from the in-package validator, pinned by the
 * package identity table (contracts/identity.ts) - a swap to a
 * different digest is refused (CONTRACT_SEAM_REPINNED).
 *
 * PURITY: no I/O, no clock, no session. Single-slot registry with a
 * typed re-pin fence.
 */

import { validateUcScenarioMember } from '../../contracts/validators/uc-scenario-member.mjs';
import { contractDigestOf } from '../../contracts/identity.js';

/** The WP03 contract identity this cell adopts (never re-declared as logic). */
export const UC_SCENARIO_CONTRACT_KIND = 'frf-contracts.uc-scenario-member.v1';

/**
 * The accepted-id-set universe the WP03 UC validator demands: the EXACT
 * accepted PRD intent-member ids - the upstream cell's accepted output
 * (cross-desk lineage). A prdIntentRefs binding that does not resolve
 * against this set is refused FOREIGN_LINEAGE (the UC-FOREIGN fix
 * target: never trust a binding without its accepted universe).
 */
export interface UcScenarioAcceptedIdSetUniverse {
  readonly idSets: {
    readonly prdMemberIds: readonly string[];
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

export type UcScenarioContractValidation = ContractSeal | ContractRefusalShape;

/**
 * The port the cell gate calls for EVERY scenario. `validateScenario`
 * must be the WP03 validateUcScenarioMember behavior: closed actor-kind
 * and evidence-kind vocabularies, exactly one main terminal branch,
 * material flows resolving to declared same-kind branches, fail-closed
 * prdIntentRefs resolution.
 */
export interface UcScenarioContractPort {
  readonly contractKind: typeof UC_SCENARIO_CONTRACT_KIND;
  /** sha256 over the validator implementation this port fronts (content-addressed seam). */
  readonly validatorDigest: string;
  validateScenario(scenario: unknown, universe: UcScenarioAcceptedIdSetUniverse): UcScenarioContractValidation;
}

/** Fail-closed seam resolution (an unwired seam never gates a product). */
export interface SeamRefusal {
  readonly refused: true;
  readonly reason: 'CONTRACT_SEAM_UNWIRED' | 'CONTRACT_SEAM_REPINNED';
  readonly detail: string;
}

export type SeamResolution =
  | { readonly resolved: true; readonly port: UcScenarioContractPort }
  | SeamRefusal;

let installedPort: UcScenarioContractPort | undefined;

/** Install the contract port ONCE (idempotent per digest; a swap is refused). */
export function installUcScenarioContract(port: UcScenarioContractPort): { readonly installed: true; readonly validatorDigest: string } | SeamRefusal {
  if (port === null || typeof port !== 'object' || port.contractKind !== UC_SCENARIO_CONTRACT_KIND || typeof port.validatorDigest !== 'string' || port.validatorDigest.length === 0 || typeof port.validateScenario !== 'function') {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_UNWIRED',
      detail: `the UC scenario contract port must carry contractKind ${UC_SCENARIO_CONTRACT_KIND}, a validatorDigest and a validateScenario function`,
    };
  }
  const pinned = contractDigestOf('uc-scenario-member');
  if (port.validatorDigest !== pinned) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_REPINNED',
      detail: `the UC scenario contract seam is pinned to the installed validator ${pinned} (contracts/identity.ts); a port carrying ${port.validatorDigest} is refused (the pin is the package identity table; never silently exchanged)`,
    };
  }
  installedPort = port;
  return { installed: true, validatorDigest: port.validatorDigest };
}

/**
 * The INSTALLED port (FRF-WP11): the in-package WP03 validator behind the
 * pinned digest from the package identity table. Self-installed on first
 * resolution - the seam is never unwired in the installed package.
 */
const INSTALLED_PORT: UcScenarioContractPort = {
  contractKind: UC_SCENARIO_CONTRACT_KIND,
  validatorDigest: contractDigestOf('uc-scenario-member'),
  validateScenario: (scenario, universe) => validateUcScenarioMember(scenario, universe) as UcScenarioContractValidation,
};

/**
 * Resolve the installed port. Since the FRF-WP11 cutover the resolution
 * SELF-INSTALLS the in-package validator port on first use (installed
 * wiring); an external install of the same pinned digest stays an
 * idempotent no-op.
 */
export function resolveUcScenarioContract(): SeamResolution {
  if (installedPort === undefined) {
    installedPort = INSTALLED_PORT;
  }
  return { resolved: true, port: installedPort };
}
