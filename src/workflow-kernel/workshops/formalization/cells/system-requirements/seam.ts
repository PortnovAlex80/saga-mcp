/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * seam.ts - THE DOCUMENTED WP03 VALIDATOR SEAM of the
 * derive-system-requirements Production Cell (FRF-WP05).
 *
 * SEAM RULE (see SEAM.md beside this file for the full contract):
 *   - The typed-refusal AUTHORITY of the cell's output bundle is the
 *     FRF-WP03 pure validator
 *     docs/refactoring/formalization-frf/contracts/validators/
 *     requirements-bundle.mjs (contract frf-contracts.requirements-
 *     bundle.v1). Production code NEVER imports the docs tree: docs are
 *     not a compiled dependency of src/, and a src->docs import would
 *     make the build depend on non-runtime material.
 *   - Instead, production code declares THIS typed seam: a bound
 *     validator function plus the contract identity it must carry. The
 *     composition root (or the test host) imports the docs-tree module
 *     and binds it through bindWp03RequirementsValidator, which verifies
 *     the module's identity fail-closed before the validator may run.
 *   - When the seam is NOT bound, the wp03-validation check is
 *     INDETERMINATE and the desk's gate yields human-wait (D5 typed wait
 *     TypedWait:human-input) - never a silent pass, never a fallback
 *     validator, never a weakened local reimplementation.
 *
 * PURITY: this module holds only the seam types, the fail-closed binder
 * and a fixed self-test probe. No I/O of its own (the dynamic import of
 * the docs module happens at the binding site, not here).
 */

import { REQUIREMENTS_BUNDLE_CONTRACT_KIND } from './contract.js';
import type { RequirementsBundle, RequirementsUniverse, Wp03Validation } from './contract.js';

/** The WP03 validator function as bound through the seam. */
export type Wp03RequirementsBundleValidator = (bundle: unknown, universe: unknown) => Wp03Validation;

/** The module shape the seam accepts (the docs-tree validator module). */
export interface Wp03ValidatorModule {
  readonly CONTRACT_KIND?: unknown;
  readonly validateRequirementsBundle?: unknown;
}

/** The bound seam: the verified validator + the contract identity. */
export interface BoundWp03Validator {
  readonly contractKind: typeof REQUIREMENTS_BUNDLE_CONTRACT_KIND;
  readonly validate: Wp03RequirementsBundleValidator;
}

/** Typed seam refusals (fail-closed; no fallback validator exists). */
export type SeamBinding =
  | { readonly bound: true; readonly seam: BoundWp03Validator }
  | {
      readonly bound: false;
      readonly reason: 'SEAM_MODULE_MALFORMED' | 'SEAM_CONTRACT_KIND_MISMATCH' | 'SEAM_VALIDATOR_MISSING' | 'SEAM_SELF_TEST_FAILED';
      readonly detail: string;
    };

/* ------------------------------------------------------------------ */
/* The fixed self-test probe                                           */
/* ------------------------------------------------------------------ */

const PROBE_PRD_DIGEST = 'a'.repeat(64);
const PROBE_UC_DIGEST = 'b'.repeat(64);

/**
 * A minimal well-formed probe bundle (deterministic, authored here). The
 * binder requires the bound validator to SEAL it - proving the bound
 * function really is the WP03 requirements-bundle validator, not an
 * imposter that always returns ok.
 */
const PROBE_UNIVERSE: RequirementsUniverse = {
  idSets: {
    prdMemberIds: ['probe:prd-member-1'],
    ucScenarioIds: ['probe:uc-scenario-1'],
    ucBranchIdsByScenario: { 'probe:uc-scenario-1': ['probe:uc-branch-1'] },
    sourceConstraintIds: [],
    verificationSurfaceIds: ['probe:verification-surface-1'],
  },
  revisionPins: { prd: PROBE_PRD_DIGEST, uc: PROBE_UC_DIGEST },
};

const PROBE_BUNDLE: RequirementsBundle = {
  schemaVersion: REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  prdRevisionRef: `sha256:${PROBE_PRD_DIGEST}`,
  ucRevisionRef: `sha256:${PROBE_UC_DIGEST}`,
  requirements: [
    {
      requirementId: 'probe:fr-1',
      requirementKind: 'FR',
      statement: 'Probe requirement: the system shall exhibit the probed observable behavior.',
      derivation: {
        prdIntentRefs: ['probe:prd-member-1'],
        ucScenarioRefs: ['probe:uc-scenario-1'],
        ucTerminalBranchRefs: ['probe:uc-branch-1'],
      },
      verificationSurfaceRefs: ['probe:verification-surface-1'],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* The fail-closed binder                                              */
/* ------------------------------------------------------------------ */

/**
 * Bind the docs-tree WP03 validator module to the cell's typed seam.
 * Fail-closed on every mismatch:
 *   - the module must be an object exporting validateRequirementsBundle
 *     as a function and CONTRACT_KIND equal to the frozen identity
 *     frf-contracts.requirements-bundle.v1;
 *   - the bound validator must SEAL the fixed probe bundle and REFUSE a
 *     null product typed MALFORMED_PRODUCT (the self-test).
 * A module failing any check is never bound; the caller's wp03-validation
 * check stays INDETERMINATE and the gate waits (D5).
 */
export function bindWp03RequirementsValidator(module: Wp03ValidatorModule): SeamBinding {
  if (module === null || typeof module !== 'object') {
    return { bound: false, reason: 'SEAM_MODULE_MALFORMED', detail: 'the WP03 validator seam was handed a non-object module' };
  }
  if (module.CONTRACT_KIND !== REQUIREMENTS_BUNDLE_CONTRACT_KIND) {
    return {
      bound: false,
      reason: 'SEAM_CONTRACT_KIND_MISMATCH',
      detail: `the module declares CONTRACT_KIND ${String(module.CONTRACT_KIND)}, the seam binds only ${REQUIREMENTS_BUNDLE_CONTRACT_KIND} (no substitute validator exists)`,
    };
  }
  if (typeof module.validateRequirementsBundle !== 'function') {
    return { bound: false, reason: 'SEAM_VALIDATOR_MISSING', detail: 'the module exports no validateRequirementsBundle function' };
  }
  const validate = module.validateRequirementsBundle as Wp03RequirementsBundleValidator;
  const sealed = validate(PROBE_BUNDLE, PROBE_UNIVERSE);
  if (!sealed || sealed.ok !== true || sealed.kind !== REQUIREMENTS_BUNDLE_CONTRACT_KIND) {
    return {
      bound: false,
      reason: 'SEAM_SELF_TEST_FAILED',
      detail: `the bound function did not seal the fixed probe bundle as ${REQUIREMENTS_BUNDLE_CONTRACT_KIND} (an imposter validator is never bound)`,
    };
  }
  const refusedNull = validate(null, PROBE_UNIVERSE);
  if (!refusedNull || refusedNull.ok !== false || refusedNull.reason !== 'MALFORMED_PRODUCT') {
    return {
      bound: false,
      reason: 'SEAM_SELF_TEST_FAILED',
      detail: 'the bound function did not refuse a null product typed MALFORMED_PRODUCT (fail-closed self-test)',
    };
  }
  return { bound: true, seam: { contractKind: REQUIREMENTS_BUNDLE_CONTRACT_KIND, validate } };
}
