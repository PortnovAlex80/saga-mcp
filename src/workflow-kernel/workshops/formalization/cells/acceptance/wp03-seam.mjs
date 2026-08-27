/**
 * FRF-WP06 define-acceptance-contract cell - THE WP03 VALIDATOR SEAM
 * (installed wiring since the FRF-WP11 cutover).
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
 *   canonical home   : src/workflow-kernel/workshops/formalization/contracts/
 *                      (FRF-WP11: the in-package tree IS the canonical home;
 *                      the docs-tree copy is a frozen byte-equal snapshot,
 *                      removal-guarded - the seam import resolves in-package)
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
 *   digest pin       : validatorSha256/commonSha256 pin the adopted
 *                      validator + helper file bytes; the focused test
 *                      re-hashes the canonical files and refuses on drift
 *                      (the frozen contract may only change through a new
 *                      WP03 version, never silently).
 *
 * PURITY: re-exports pure functions only. No I/O, no clock, no session.
 * Reachability: an INSTALLED package surface since the FRF-WP11 cutover
 * (the installed workshop routes the define-acceptance-contract desk
 * through this cell).
 */

import {
  CONTRACT_KIND as WP03_AC_BINDING_KIND,
  validateAcBinding,
} from '../../contracts/validators/ac-binding.mjs';

export {
  WP03_AC_BINDING_KIND,
  validateAcBinding,
};

/** The adopted validator module, for seam-identity assertions in tests. */
export const WP03_SEAM = Object.freeze({
  adoptedContract: 'frf-contracts.ac-binding.v1',
  adoptedValidator: 'validateAcBinding',
  // FRF-WP11 cutover: the canonical home is the in-package contracts tree;
  // the docs-tree copy is a frozen byte-equal snapshot (removal-guarded).
  adoptedFrom:
    'src/workflow-kernel/workshops/formalization/contracts/validators/ac-binding.mjs',
  adoptedSchema:
    'src/workflow-kernel/workshops/formalization/contracts/schemas/ac-binding.schema.json',
  /** sha256 over the adopted validator file bytes (drift tripwire). */
  validatorSha256:
    '74bbe6c257b878d6fd2f295925b62298c789327fb108f409d3851a3669f9a412',
  /** sha256 over the validator's shared helpers file bytes (drift tripwire). */
  commonSha256:
    '79ccf65795d4e83f3d3bb7cd5eba4fa5a43176d886d99a3fef03addb13acc236',
  callLaw:
    'the cell gate calls validateAcBinding once per criterion with the accepted id-set universe; per-criterion refusals propagate verbatim',
});
