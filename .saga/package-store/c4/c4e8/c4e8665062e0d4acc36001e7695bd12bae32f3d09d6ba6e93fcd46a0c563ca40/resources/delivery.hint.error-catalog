# Delivery error-hint catalog

> Pinned by `delivery.hint.error-catalog`. Surfaced by the non-terminal
> delivery nodes when a guard, provider, or lineage check fails
> (W9-A5 Delivery package).

Each hint maps a `DeliveryReasonCode` (see `delivery-schemas.ts`) to the
deterministic recovery route. The module NEVER auto-recovers a release; it
routes to `blocked` / `failed` and lets the operator decide.

## Input / lineage integrity

- `invalid-input-contract` — the `DeliveryReleaseCase` failed schema or
  project/epic binding. Re-issue the case from the verified Development
  certificate; do not patch hashes.
- `development-certificate-invalid` — upstream Development decision is not
  `verified`. Re-run Development verification.
- `candidate-drifted` — `currentCandidateHash` differs from the certified
  candidate. Candidate is immutable after Development certification; re-verify.
- `operator-authorization-missing` — no explicit operator grant bound to this
  policy + candidate. Obtain authorization; never default.

## Preflight guards

- `preflight-missing` / `preflight-hash-invalid` / `preflight-lineage-mismatch`
  — the durable preflight production is absent or tampered. Re-run preflight.
- `preflight-check-missing` / `preflight-check-failed` /
  `preflight-check-inconclusive` — a required guard did not pass. Resolve the
  underlying evidence; do not bypass the guard.
- `preflight-provider-untrusted` — a guard provider is not
  `deterministic_evidence` + trusted. Inject a trusted provider.

## Approval

- `approval-missing` / `approval-hash-invalid` / `approval-lineage-mismatch`
  — the durable approval production is absent or tampered. Re-obtain approval.
- `approval-provider-untrusted` — the decision lacks a trusted
  `authorized_decision` provider.
- `approval-denied` / `approval-expired` — the human decision is not
  admissible. Re-request or escalate; never override.

## Publication / observation

- `publication-missing` / `publication-hash-invalid` /
  `publication-lineage-mismatch` — durable publication is absent or tampered.
- `action-plan-mismatch` / `action-receipt-missing` / `action-key-invalid` /
  `action-failed` / `action-uncertain` — the executed actions diverge from the
  policy plan. Observe before retry; never force-push or bypass protection
  (`delivery.no-force-or-bypass`).
- `observation-missing` / `observation-hash-invalid` /
  `observation-lineage-mismatch` / `observation-mismatched` /
  `observation-inconclusive` / `observation-provider-untrusted` —
  authoritative target state did not match the desired state. Re-observe; a
  push response alone never establishes release (`delivery.push-is-not-release`).

## Infrastructure

- `infrastructure-error` — an injected port threw. The run reached a terminal
  `failed` decision with a certificate; inspect the settlement rationale.
