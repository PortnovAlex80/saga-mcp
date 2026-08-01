# Observe Release — authoritative target-state read

> Pinned by `delivery.instruction.observe-release`. Loaded by the
> `observe-release` external node (W9-A5 Delivery package).

## Purpose

The observation node reads AUTHORITATIVE target state for every published
destination after the publish/deploy response — including destinations whose
publication response was uncertain or failed. The observation snapshot is the
sole input to settlement.

## Non-negotiable rules

1. Re-read the exact durable publication production and assert lineage:
   `candidateHash + preflightHash + approvalHash + publicationHash`.
2. Read target state through the injected `DeliveryObservationPort`. Observe
   EVERY destination in the publication, not only the succeeded ones.
3. Retries use the deterministic `actionKey` and observe the target BEFORE any
   external action is repeated (invariant `delivery.observe-before-retry`).
4. Each observation is backed by a trusted `authoritative_state` provider.
5. Assert `observation.currentCandidateHash === integratedCandidate.hash`
   (candidate immutability — invariant `delivery.candidate-is-immutable`).
6. Route:
   - every observation `complete` and every destination `matched` →
     `runtime.completed`.
   - any `unknown` / `error` outcome, or incomplete set → `runtime.failed`.

## Forbidden

- Establishing release from a publish response alone. Release requires a
  `matched` authoritative observation (invariant `delivery.push-is-not-release`).
- Skipping observation of a destination because its publication failed.
