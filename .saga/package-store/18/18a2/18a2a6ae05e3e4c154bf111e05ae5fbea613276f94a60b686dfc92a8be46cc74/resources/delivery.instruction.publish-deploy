# Publish and Deploy — desired-state action application

> Pinned by `delivery.instruction.publish-deploy`. Loaded by the
> `publish-deploy` external node (W9-A5 Delivery package).

## Purpose

The publication node applies every required release action through explicit
providers using deterministic cross-run action keys. It is the only node that
may produce externally-visible release state.

## Non-negotiable rules

1. Re-read the exact durable preflight + approval productions and assert the
   release is authorized (invariants `delivery.explicit-operator-authorization`
   + `delivery.no-default-provider`). No fallback provider may act.
2. Apply actions through the injected `DeliveryPublicationPort`. Every action
   uses its deterministic `actionKey` (`deliveryActionKey(case, action)`) so a
   retry is idempotent, not duplicative.
3. Adapters MUST NOT force push, bypass branch protection, bypass registry
   immutability, or bypass deployment policy
   (invariant `delivery.no-force-or-bypass`).
4. Collect a receipt per action. Persist uncertain results for the observation
   adapter instead of blind retry
   (invariant `delivery.observe-before-retry`).
5. Route:
   - every required action `succeeded` → `runtime.completed`.
   - any required action missing, or any receipt not `succeeded` →
     `runtime.failed` (the observation node still runs).

## Forbidden

- Treating a successful command response as release evidence
  (invariant `delivery.push-is-not-release` — only authoritative observation
  establishes release).
- Applying an action whose `actionKey`, `kind`, `target`, `payloadHash`, or
  `desiredStateHash` does not match the policy action plan.
