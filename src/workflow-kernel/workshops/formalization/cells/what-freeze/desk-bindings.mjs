/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/desk-bindings.mjs -
 * the ROLE BINDINGS of the WHAT-freeze kernel desks (FRF-WP07; ADR-053 /
 * FWD:F007: identity lives in the frozen role-contract manifest, never in
 * kernel conditionals).
 *
 * (Named desk-bindings, not role-binding: the EK-2 complexity dimension
 * roles.bindingAuthorities binds at <=1 kernel role-binding stem file;
 * this module is a workshop cell's declaration, not a second
 * role-binding authority.)
 *
 * The two kernel desks bind EXACTLY the two launch kinds the frozen
 * workshop manifest admits, with their operator-staffed flag as manifest
 * data (the kernel sees only author/reviewer). The freezer performs no
 * authorship: the `author` slot is bound for the desk's provisioning
 * surface only (the deterministic builder is the product source); the
 * `reviewer` slot binds the review verdict; the D12 drift disposition is
 * the OPERATOR's, never an actor's.
 *
 * The blocking cell-contracts test cross-checks these declarations
 * against the INSTALLED manifest (dist) - the launch kinds, the node
 * ids, the check provider ids and the effect ids must all resolve there,
 * so the WP11 integration flips data, not identities.
 *
 * PURITY: pure data. No I/O.
 */

import { FREEZE_EFFECT_ID, FREEZE_NODE_ID, SETTLE_EFFECT_ID, SETTLE_NODE_ID } from './protocol.mjs';

/** The frozen launch kinds (the installed manifest's role bindings). */
export const FORMALIZATION_LAUNCH_KINDS = Object.freeze({
  author: 'formalization.implementation.author',
  reviewer: 'formalization.implementation.reviewer',
});

/** The kernel protocol-role universe (closed; mutation-k fence). */
export const PROTOCOL_ROLE_UNIVERSE = Object.freeze(['author', 'reviewer']);

/** The WHAT-freeze cell's desk role bindings. */
export function whatFreezeDeskRoleBindings() {
  return [
    {
      nodeId: FREEZE_NODE_ID,
      nodeKind: 'kernel',
      launchKind: FORMALIZATION_LAUNCH_KINDS.reviewer,
      protocolRole: 'reviewer',
      semanticProfile: 'reviewer',
      operatorStaffed: true,
      checkProviderId: 'formalization.baseline-freeze.v1',
      effectId: FREEZE_EFFECT_ID,
      productSource: 'deterministic-builder (no authoring actor: the baseline is built from the exact accepted surfaces)',
    },
    {
      nodeId: SETTLE_NODE_ID,
      nodeKind: 'kernel',
      launchKind: FORMALIZATION_LAUNCH_KINDS.reviewer,
      protocolRole: 'reviewer',
      semanticProfile: 'reviewer',
      operatorStaffed: true,
      checkProviderId: 'formalization.settlement-structure.v1',
      effectId: SETTLE_EFFECT_ID,
      productSource: 'deterministic-settler (no authoring actor: the contract is sealed from the two exact authorities)',
    },
  ];
}

/** Fail-closed: the binding of one desk node (an unbound node is refused). */
export function roleBindingOfNode(nodeId) {
  const binding = whatFreezeDeskRoleBindings().find((entry) => entry.nodeId === nodeId);
  return binding === undefined
    ? { detail: `node ${String(nodeId)} has no role binding in the WHAT-freeze cell`, ok: false, reason: 'SCOPE_VIOLATION', refused: true }
    : { ok: true, binding };
}
