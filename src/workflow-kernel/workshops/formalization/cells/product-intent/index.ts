/**
 * workflow-kernel/workshops/formalization/cells/product-intent/index.ts -
 * the FRF-WP04 define-product-intent Production Cell public surface.
 *
 * REACHABILITY LAW (plan FRF-WP04): this package is reachable ONLY from
 * focused tests (tests/workflow-kernel/workshops/formalization/cells/**)
 * until the coordinator wires it into the installed package manifest in
 * FRF-11. No production entrypoint imports it; the old formalization
 * flow stays authoritative until that cutover.
 *
 * THE SEAM: member semantics are adopted from the FRF-WP03 contract
 * frf-contracts.prd-intent-member.v1 through seam.ts (installed at test
 * time; see README.md in this directory).
 */

export * from './seam.js';
export * from './cell.js';
export * from './gate.js';
export * from './reviewer.js';
