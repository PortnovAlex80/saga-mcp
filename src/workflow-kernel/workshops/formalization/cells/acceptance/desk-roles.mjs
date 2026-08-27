/**
 * FRF-WP06 define-acceptance-contract cell - THE DESK ROLE BINDING.
 *
 * NAMING LAW: this module is desk-roles.mjs, never role-binding.mjs - the
 * frozen complexity dimension roles.bindingAuthorities allows at most ONE
 * kernel file whose stem contains role-binding (the frozen role-contract
 * manifest is the ONE role-binding source; complexity-check.ts
 * kernelStemFiles scans all .ts/.mjs/.js under src/workflow-kernel).
 *
 * Binds the desk to the frozen role-contract manifest's two launch
 * kinds (roles.ts: formalization.implementation.author /
 * formalization.implementation.reviewer; the kernel protocol-role
 * universe is exactly author | reviewer - semantic profiles are never
 * kernel roles). Shape continuity: FORMALIZATION_ROLE_BINDINGS
 * (manifest.ts) rows { launchKind, protocolRole, semanticProfile }.
 *
 * PURITY: pure data + pure functions. No I/O.
 */

import { ACCEPTANCE_CELL_NODE_ID } from './protocol.mjs';

/** The kernel protocol-role universe (the closed set; mutation k fence). */
export const KERNEL_PROTOCOL_ROLE_UNIVERSE = Object.freeze(['author', 'reviewer']);

/** The cell's role bindings (manifest.ts row shape + the served desk). */
export const ACCEPTANCE_ROLE_BINDINGS = Object.freeze([
  Object.freeze({
    launchKind: 'formalization.implementation.author',
    protocolRole: 'author',
    semanticProfile: 'implementer',
    servesDesk: ACCEPTANCE_CELL_NODE_ID,
  }),
  Object.freeze({
    launchKind: 'formalization.implementation.reviewer',
    protocolRole: 'reviewer',
    semanticProfile: 'reviewer',
    servesDesk: ACCEPTANCE_CELL_NODE_ID,
  }),
]);

/**
 * Resolve the desk role of a launch kind (fail-closed: exactly one
 * binding per launch kind; no reclassification, no second resolution).
 */
export function roleBindingOf(launchKind) {
  const matches = ACCEPTANCE_ROLE_BINDINGS.filter((binding) => binding.launchKind === launchKind);
  if (matches.length === 1 && KERNEL_PROTOCOL_ROLE_UNIVERSE.includes(matches[0].protocolRole)) {
    return { ok: true, binding: matches[0] };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ROLE_NOT_BOUND', detail: `launch kind ${String(launchKind)} resolves ${matches.length} bindings of desk ${ACCEPTANCE_CELL_NODE_ID}; exactly one is lawful` };
  }
  return {
    ok: false,
    reason: 'ROLE_NOT_BOUND',
    detail: `launch kind ${String(launchKind)} is not bound to desk ${ACCEPTANCE_CELL_NODE_ID} (fail-closed)`,
  };
}
