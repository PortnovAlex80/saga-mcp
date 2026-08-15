# Preflight Release — guard-set checklist

> Pinned by `delivery.checklist.preflight-release`. Loaded by the
> `preflight-release` kernel node before emitting a domain event.

Tick every item. An unticked item blocks `domain.ready`.

- [ ] The `DeliveryReleaseCase` was re-read from the durable frame (not
      reconstructed from live state).
- [ ] `developmentCertificate.decision === 'verified'`.
- [ ] `integratedCandidate.hash` matches the run input exactly.
- [ ] `policy.contentHash` matches the case policy exactly.
- [ ] Every id in `policy.requiredPreflightCheckIds` has a check in the
      preflight snapshot.
- [ ] Every check `subjectCandidateHash === integratedCandidate.hash`.
- [ ] Every check is backed by a trusted `deterministic_evidence` provider.
- [ ] Every check `outcome === 'passed'` (for `domain.ready`).
- [ ] `preflightHash` recomputes from the snapshot (`hashDeliveryPreflight`).
- [ ] No TODO / FILL / placeholder remains in the production bindings.

On any miss: route `domain.blocked` (guard/provider failure) or
`domain.failed` (infrastructure error), never `domain.ready`.
