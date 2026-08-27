/**
 * FRF-WP06 define-acceptance-contract cell - THE WP03 VALIDATOR SEAM.
 *
 * This module is the ONE place the acceptance cell touches the FRF-WP03
 * semantic contracts. WP03 declared its five payload contracts "payload
 * contract only ... the FRF-04..09 cells will adopt the schemas/validators
 * as their product payload contracts and call the validators with the
 * exact accepted id sets carried by transitions" (contracts/validators/
 * common.mjs header). This seam IS that adoption for the ac-binding
 * contract: the cell gate calls the WP03 validator DIRECTLY - the actual
 * module is imported, never copied, so no drift between the frozen
 * contract and the cell's enforcement is possible.
 *
 * SEAM CONTRACT (documented for the FRF-WP06 gate "WP03 validator seam
 * documented"):
 *   adopted contract : frf-contracts.ac-binding.v1 (schemas/ac-binding.schema.json)
 *   adopted validator: validateAcBinding (validators/ac-binding.mjs)
 *   call law         : the cell gate runs validateAcBinding once per
 *                      criterion with the accepted id-set universe built
 *                      by protocol.mjs/acceptanceUniverseFrom(); every
 *                      per-criterion typed refusal (MALFORMED_PRODUCT,
 *                      MISSING_LINEAGE, FOREIGN_LINEAGE, SCOPE_VIOLATION)
 *                      propagates verbatim - the cell NEVER re-implements
 *                      or weakens a WP03 law.
 *   BOTH-shapes law  : the WP03 validator enforces the BOTH-citation-shapes
 *                      law (reverse edges 0051+0052): a scenario-facing AC
 *                      must retain its UC scenario binding AND its
 *                      terminal-branch binding together; stripping either
 *                      is MISSING_LINEAGE (the plan's killed mutation
 *                      "keep AC coverage but remove its terminal scenario
 *                      binding").
 *   digest pin       : WP03_AC_BINDING_VALIDATOR_SHA256 pins the adopted
 *                      validator file bytes; the focused test re-hashes
 *                      the docs file and refuses on drift (the frozen
 *                      contract may only change through a new WP03
 *                      version, never silently).
 *
 * PURITY: re-exports pure functions only. No I/O, no clock, no session.
 * Reachability: focused tests only until the FRF-WP11 cutover installs
 * the cells package (the installed workshop keeps its own validators;
 * nothing under src (no .ts module) imports this file - law tested in
 * tests/.../cells/acceptance/structure.test.mjs).
 */

import {
  CONTRACT_KIND as WP03_AC_BINDING_KIND,
  validateAcBinding,
} from '../../../../../../docs/refactoring/formalization-frf/contracts/validators/ac-binding.mjs';

export {
  WP03_AC_BINDING_KIND,
  validateAcBinding,
};

/** The adopted validator module, for seam-identity assertions in tests. */
export const WP03_SEAM = Object.freeze({
  adoptedContract: 'frf-contracts.ac-binding.v1',
  adoptedValidator: 'validateAcBinding',
  adoptedFrom:
    'docs/refactoring/formalization-frf/contracts/validators/ac-binding.mjs',
  adoptedSchema:
    'docs/refactoring/formalization-frf/contracts/schemas/ac-binding.schema.json',
  /** sha256 over the adopted validator file bytes (drift tripwire). */
  validatorSha256:
    '74bbe6c257b878d6fd2f295925b62298c789327fb108f409d3851a3669f9a412',
  /** sha256 over the validator's shared helpers file bytes (drift tripwire). */
  commonSha256:
    '79ccf65795d4e83f3d3bb7cd5eba4fa5a43176d886d99a3fef03addb13acc236',
  callLaw:
    'the cell gate calls validateAcBinding once per criterion with the accepted id-set universe; per-criterion refusals propagate verbatim',
});
