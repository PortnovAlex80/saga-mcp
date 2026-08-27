/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/index.ts
 * - FRF-WP08: the public surface of the SRS scenario-realization cell.
 *
 * TEST-ONLY REACHABLE (the FRF cell landing rule): no production module
 * outside this cell directory imports it; the FRF-WP09+ work packages and
 * the coordinator wire the cell into the installed flow. Until then the
 * cell is exercised exclusively by its blocking-hosted suite
 * (tests/workflow-kernel/workshops/formalization/cells/srs-realization/**,
 * hosted by the acceptance matrix's workflow-kernel group glob).
 */

export * from './contract.js';
export * from './parser.js';
export * from './validator.js';
export * from './desk.js';
export * from './fixtures.js';
