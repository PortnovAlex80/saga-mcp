/**
 * workflow-kernel/context-envelope/index.ts - the WP-18 public surface:
 * the cumulative context accountant, the CAS admission policy, the receipt
 * protocol and the cognition transport contract.
 *
 * Consumers: WP-08 (the cognition transport implements this contract at the
 * exact pre-send boundary) and the EK-12 qualification probes.
 */

export * from './receipt.js';
export * from './accountant.js';
export * from './admission.js';
export * from './transport.js';
