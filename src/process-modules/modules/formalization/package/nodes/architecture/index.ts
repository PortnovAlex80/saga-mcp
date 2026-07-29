/**
 * W8-A5 — Barrel index for the Formalization architecture + recovery node
 * protocols and package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 *       lane W8-A5.
 * Plan: §0.11.6.
 *
 * Single import surface for the architecture lane. W8-A1 (package manifest)
 * and W8-A8 (tests) import from here. Other lanes MUST NOT import across lane
 * subtrees (plan §0.11.10); they submit manifest entries to W8-A1 instead.
 *
 * Exports:
 *   - `ARCHITECTURE_NODE_PROTOCOL`            — LM `define-architecture-contract`.
 *   - `ARCHITECTURE_RESOLVER_NODE_PROTOCOL`   — kernel `resolve-architecture-contract`.
 *   - `ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL` — kernel `freeze-acceptance-baseline`.
 *   - `ARCHITECTURE_RECOVERY_NODE_PROTOCOL`   — synthetic recovery node.
 *   - `ARCHITECTURE_RESOURCE_ENTRIES`         — package-local resources (→ W8-A1 manifest).
 *   - `ARCHITECTURE_CONTRACT_REFS`            — pinned ContractRef values.
 *   - `ARCHITECTURE_RECOVERY_*` constants     — recovery policy + acceptance criteria.
 *   - `validateArchitectureLaneProtocols()`   — structural self-check (delegates to
 *     `validateNodeProtocolDefinition` from the Wave 1 SPI).
 */

export {
  ARCHITECTURE_NODE_PROTOCOL,
  ARCHITECTURE_RESOURCE_IDS,
  ARCHITECTURE_WORK_INTENT_SCHEMA_ID,
} from './srs-node-protocol.js';

export {
  ARCHITECTURE_RESOLVER_NODE_PROTOCOL,
  ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL,
} from './architecture-resolver-node-protocol.js';

export {
  ARCHITECTURE_RECOVERY_NODE_PROTOCOL,
  ARCHITECTURE_RECOVERY_BINDING_ID,
  ARCHITECTURE_RECOVERY_POLICY,
  ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA,
  ARCHITECTURE_RECOVERY_ALLOWED_CHANGES,
  ARCHITECTURE_RECOVERY_TRIGGER_EVENTS,
  ARCHITECTURE_RECOVERY_RESOLVED_EVENTS,
} from './architecture-recovery-node-protocol.js';

export {
  ARCHITECTURE_RESOURCE_ENTRIES,
  ARCHITECTURE_CONTRACT_REFS,
} from './architecture-resources.js';

import { validateNodeProtocolDefinition } from '../../../../../domain/spi/node-protocol.js';
import type { ValidationError, ValidationResult } from '../../../../../domain/spi/node-protocol.js';
import { ARCHITECTURE_NODE_PROTOCOL } from './srs-node-protocol.js';
import {
  ARCHITECTURE_RESOLVER_NODE_PROTOCOL,
  ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL,
} from './architecture-resolver-node-protocol.js';
import { ARCHITECTURE_RECOVERY_NODE_PROTOCOL } from './architecture-recovery-node-protocol.js';

/**
 * The complete set of architecture-lane NodeProtocolDefinitions. W8-A1 merges
 * these into the manifest's handler/protocol surface; W8-A8 asserts over this
 * set.
 */
export const ARCHITECTURE_LANE_NODE_PROTOCOLS = Object.freeze([
  ARCHITECTURE_NODE_PROTOCOL,
  ARCHITECTURE_RESOLVER_NODE_PROTOCOL,
  ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL,
  ARCHITECTURE_RECOVERY_NODE_PROTOCOL,
]);

/**
 * Structural self-check for every architecture-lane protocol.
 *
 * Delegates to the Wave 1 SPI `validateNodeProtocolDefinition` (canonical
 * serializability + retry-semantics + entry/transition/recovery-step
 * invariants). Returns the FIRST failure (protocols are independently valid;
 * one bad entry is enough to reject the lane). W8-A8 tests call this; W8-A1
 * may call it at manifest-merge time.
 */
export function validateArchitectureLaneProtocols(): ValidationResult {
  for (const proto of ARCHITECTURE_LANE_NODE_PROTOCOLS) {
    const result = validateNodeProtocolDefinition(proto);
    if (!result.ok) {
      return {
        ok: false,
        errors: result.errors.map((e: ValidationError) => ({
          code: e.code,
          path: `${proto.id}.${e.path}`,
          message: e.message,
        })),
      };
    }
  }
  return { ok: true, errors: [] };
}
