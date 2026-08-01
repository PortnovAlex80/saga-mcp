# Approve Release — authorized-decision interaction

> Pinned by `delivery.instruction.approve-release`. Loaded by the
> `approve-release` human node (W9-A5 Delivery package).

## Purpose

The approval node materializes an authorized human decision bound to the
EXACT candidate, preflight result and release policy. Approval is the only
authority that may begin externally-visible release effects.

## Non-negotiable rules

1. Re-read the exact durable preflight production and assert it is still
   `domain.ready`. Approval binds `candidateHash + preflightHash +
   releasePolicyHash` and cannot float to a later revision
   (invariant `delivery.approval-binds-exact-input`).
2. Obtain the decision through the injected `DeliveryApprovalPort`. When
   `policy.humanApprovalRequired`, the decision MUST carry a trusted
   `authorized_decision` provider (`provider.trusted === true`,
   `provider.category === 'authorized_decision'`, `provider.providerId > 0`).
3. Route:
   - `approved` (with a complete trusted decision) → `domain.approved`.
   - `not-required` (policy does not require human approval) →
     `domain.not-required`.
   - `pending` → pause the run (`runtimeEvent: 'paused'`).
   - `expired` → `domain.approval-required`.
   - `denied` → `domain.denied`.

## Forbidden

- Beginning release effects without an admissible approval status
  (invariant `delivery.explicit-operator-authorization`).
- Accepting an `approved` status that lacks a trusted authorized-decision
  provider.
- Reusing an approval across a different candidate / preflight / policy hash.
