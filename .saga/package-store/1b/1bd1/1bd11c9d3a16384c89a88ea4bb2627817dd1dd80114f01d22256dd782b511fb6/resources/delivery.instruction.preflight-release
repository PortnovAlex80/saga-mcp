# Preflight Release — deterministic release-guard evidence

> Pinned by `delivery.instruction.preflight-release`. Loaded by the
> `preflight-release` kernel node (W9-A5 Delivery package).

## Purpose

The preflight node assembles COMPLETE trusted release-guard evidence for the
EXACT certified candidate before any human approval or external effect may
begin. It is the only gate that may authorize progression to
`approve-release`.

## Non-negotiable rules

1. Re-read the exact `DeliveryReleaseCase` from the durable frame. Confirm:
   - `developmentCertificate.decision === 'verified'`.
   - `integratedCandidate.hash` is immutable for this run.
   - `policy` is a complete `DeliveryReleasePolicySnapshot`.
2. Build the preflight snapshot from the injected `DeliveryPreflightStatePort`
   — never from self-reported worker state.
3. Every required guard check (`policy.requiredPreflightCheckIds`) must be
   backed by a `deterministic_evidence` trusted provider. An untrusted or
   missing provider routes to `domain.blocked`, never to `domain.ready`.
4. Evaluate against the injected `DeliveryPreflightPolicyPort`:
   - all required checks `passed` → `domain.ready`.
   - any `failed` / `unknown` / `error` or missing provider → `domain.blocked`.
   - infrastructure error → `domain.failed`.

## Forbidden

- Inferring machine-filled hashes, schema versions, or provider bindings.
- Trusting a command response as release evidence (push-is-not-release).
- Skipping a required check because a provider is unavailable.
