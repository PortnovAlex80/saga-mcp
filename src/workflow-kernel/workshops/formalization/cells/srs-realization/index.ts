/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/index.ts
 * - FRF-WP08: the public surface of the SRS scenario-realization cell.
 *
 * INSTALLED (since the FRF-WP11 cutover): the installed semantic
 * dispatch (cells/dispatch.mjs) routes the define-architecture-contract
 * desk through this cell (the manifest's formalization.srs-structure.v1
 * row that the desk declaration pins). The blocking-hosted suite stays
 * (tests/workflow-kernel/workshops/formalization/cells/srs-realization/**,
 * hosted by the acceptance matrix's workflow-kernel group glob).
 */

export * from './contract.js';
export * from './parser.js';
export * from './validator.js';
export * from './desk.js';
export * from './fixtures.js';
