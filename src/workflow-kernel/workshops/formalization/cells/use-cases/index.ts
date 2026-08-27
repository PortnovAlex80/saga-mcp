/**
 * workflow-kernel/workshops/formalization/cells/use-cases/index.ts -
 * the FRF-WP04 model-use-cases Production Cell public surface.
 *
 * REACHABILITY LAW (plan FRF-WP04): test-only reachable until the
 * coordinator wires the package in FRF-11; the old flow stays
 * authoritative until that cutover.
 *
 * THE SEAM: scenario semantics are adopted from the FRF-WP03 contract
 * frf-contracts.uc-scenario-member.v1 through seam.ts (installed at
 * test time; see README.md in this directory). The gate's accepted PRD
 * universe is the define-product-intent Cell's accepted output fold
 * (cross-desk lineage).
 */

export * from './seam.js';
export * from './cell.js';
export * from './gate.js';
export * from './reviewer.js';
