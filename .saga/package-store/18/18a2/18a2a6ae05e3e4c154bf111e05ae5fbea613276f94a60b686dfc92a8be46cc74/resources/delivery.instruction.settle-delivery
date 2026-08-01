# Settle Delivery — exact-product + immutability settlement

> Pinned by `delivery.instruction.settle-delivery`. Loaded by the
> `settle-delivery` kernel node (W9-A5 Delivery package).

## Purpose

The settlement node validates exact durable products and candidate
immutability, then issues a canonical `ReleaseRecord` (on `released`) and a
`DeliveryCertificate`. It routes to the matching terminal outcome emitter.

## Non-negotiable rules

1. Re-read the exact settlement input from the injected
   `DeliverySettlementStatePort`: durable preflight, approval, publication and
   observation productions plus `currentCandidateHash`. Even a preflight
   failure reaches settlement (the worker may have committed durable writes
   before dying).
2. Validate every content-addressed reference matches its durable production.
3. Assert `currentCandidateHash === integratedCandidate.hash`
   (invariant `delivery.candidate-is-immutable`). Any drift blocks release and
   requires fresh Development verification.
4. Settle through the injected `DeliverySettlementPolicyPort`:
   - authorized + every destination authoritatively observed at desired state →
     `released`.
   - missing/inconclusive authorization or observation →
     `approval-required` / `blocked`.
   - integrity, lineage, or external-state failure → `failed`.
5. On `released` ONLY, persist the canonical `ReleaseRecord` through the
   `DeliveryOutputRepository` and emit the certificate with the record hashes.
   Any other decision MUST NOT expose a `ReleaseRecord`.
6. Emit the domain event (`released` / `approval-required` / `blocked` /
   `failed`) the Flow terminal transitions on. The module emits a LOCAL
   outcome and does not decide lifecycle routing
   (invariant `delivery.module-does-not-route`).

## Forbidden

- Emitting a `ReleaseRecord` for any decision other than `released`.
- Settling `released` without a `matched` authoritative observation for every
  required destination.
- Trusting publication receipts in lieu of observation
  (`delivery.push-is-not-release`).
