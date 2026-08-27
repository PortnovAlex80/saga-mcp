/**
 * workflow-kernel/workshops/formalization/cells/use-cases/seam.ts -
 * THE WP03 CONTRACT SEAM of the model-use-cases Production Cell
 * (FRF-WP04; plan "Desk contracts/model-use-cases").
 *
 * Same honest seam contract as the product-intent cell (see
 * ../product-intent/seam.ts and README.md in this directory): the
 * semantic authority for a UC scenario member is the FRF-WP03 contract
 * frf-contracts.uc-scenario-member.v1 (schema + pure validator in the
 * docs tree). This cell NEVER re-implements it and NEVER imports the
 * docs tree; it validates every scenario through this port, installed
 * exactly once. Until installation the gate refuses fail-closed
 * (CONTRACT_SEAM_UNWIRED).
 *
 * PURITY: no I/O, no clock, no session. Single-slot registry with a
 * typed re-pin fence.
 */

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
  if (installedPort !== undefined && installedPort.validatorDigest !== port.validatorDigest) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_REPINNED',
      detail: `the UC scenario contract seam is pinned to validator ${installedPort.validatorDigest}; a swap to ${port.validatorDigest} is refused (install once; never silently exchanged)`,
    };
  }
  installedPort = port;
  return { installed: true, validatorDigest: port.validatorDigest };
}

/** Resolve the installed port (fail-closed when nothing is wired). */
export function resolveUcScenarioContract(): SeamResolution {
  if (installedPort === undefined) {
    return {
      refused: true,
      reason: 'CONTRACT_SEAM_UNWIRED',
      detail: 'no WP03 UC scenario contract validator is wired into the seam; the cell gate refuses fail-closed instead of guessing validity (see cells/use-cases/README.md)',
    };
  }
  return { resolved: true, port: installedPort };
}

/**
 * TEST-ONLY seam reset (named honestly). Production code never calls
 * this; the focused suite proves the UNWIRED and INDETERMINATE
 * behaviors before wiring the real WP03 validator. FRF-11 deletes it
 * together with the test-time injection.
 */
export function resetUcScenarioContractSeamForTests(): void {
  installedPort = undefined;
}
