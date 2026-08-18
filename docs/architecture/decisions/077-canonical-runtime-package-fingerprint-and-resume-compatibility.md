# ADR-077: Canonical runtime package fingerprint and resume compatibility

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** the implicit notion that `packageDigest` bytes alone define package identity
- **Program:** Saga Core Renewal, release K4 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

Since K3 every runtime manifest pins real handler implementation digests, and
the installer stamps resource digests at install time. Two identity mechanisms
already exist:

1. `computePackageDigest(manifest, resources)` — a bytes-level canonical
   digest over the stamped manifest envelope and resource bytes.
2. `extractContractSurface(manifest)` / `classifyResumeCompatibility(...)` —
   a semantic surface (identity + input/output schemas + handler surface)
   with typed verdicts `unchanged | compatible | incompatible`.

Neither is a NAMED, canonical fingerprint of the full executable contract.
Resume paths still re-derive identity from whichever of the two happens to be
at hand, and nothing forbids a caller from constructing a private subset
(e.g. comparing `name@version` alone — the exact seam the 2026-08-16 audit
flagged as "resume compatibility uses handler logical IDs without
implementation digests").

## Decision

### 1. One named fingerprint: `RuntimePackageFingerprint`

The fingerprint is the canonical digest over the EXACT executable contract a
lifecycle runs under:

```
RuntimePackageFingerprint = sha256Hex(canonicalJson({
  manifestFormatVersion,
  definition,                 // nodes, outcomes, recovery policy, profiles
  handlerRefs,                // real implementation digests (K3, no placeholders)
  inputContractRef,
  outputContractRef,
  runtimeCompatibilityRange,
  assistance,
  resourceDigests,            // install-time stamped, order-canonicalized
}))
```

Explicitly EXCLUDED: observational data (timestamps, host paths, process
ids, invocation counts). The digest equals `computePackageDigest` over the
stamped manifest — the formula is frozen here; it is no longer an
implementation detail of the package store.

### 2. Canonical serialization rules

Key order, whitespace, and host filesystem paths must not affect the value:
inputs are canonicalized (`canonicalJson` — sorted keys, stable scalars) and
resource digests enter as an order-canonicalized list. A fingerprint computed
on host A re-computes identically on host B from the same package.

### 3. Persistence: pin the fingerprint at lifecycle start

Every lifecycle start persists the full fingerprint with its run pin — not
just `name@version` — and resume REHYDRATES the persisted fingerprint instead
of reconstructing one from the currently installed package. The currently
installed package is only ever a CANDIDATE compared against the persisted
pin by the explicit compatibility policy.

### 4. One compatibility surface

Every resume/adoption compatibility decision consumes the canonical
fingerprint components through `classifyResumeCompatibility`. No caller may
construct a private subset of package identity (logical IDs only, name@
version only, schema-only) for a compatibility decision.

## Consequences

- A rewritten handler with the same logical ID changes the fingerprint (K3
  digests are inputs) — silently resuming under rewritten code becomes
  structurally impossible.
- Check plans, configs, and toolchain digests join the fingerprint in later
  releases (K6 evidence freshness binds check plans; K19 binds toolchain) —
  the fingerprint structure is extendable by ADDING keyed components, never
  by removing or reordering existing ones.
- K5 owns the behavioral policy this fingerprint feeds: typed
  compatible / restart-required / forbidden outcomes with reasons.
