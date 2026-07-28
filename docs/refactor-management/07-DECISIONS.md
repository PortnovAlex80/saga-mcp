# 07 — Cross-cutting Decisions

Record of architecture decisions taken DURING execution that are not already
in the plan: resolutions of frozen-contract change requests, scope calls,
tooling choices, and any deviation from the plan with rationale.

A worker that needs a frozen-contract change STOPS its lane and files an entry
here (per plan §0.1.7). The integrator resolves centrally, publishes a new
checkpoint, and restarts dependent work.

Format:
```
## D-YYYYMMDD-NN — <title>
- Context: ...
- Decision: ...
- Rationale: ...
- Affects: waves/lanes/files
- Status: proposed | accepted | superseded
```

---

## D-20260728-01 — Refactor HQ location and operating model
- Context: Plan §0.1 mandates frozen input commits, disjoint path ownership, serial cherry-pick integration, and a single integrator. The integrator needs a durable place to keep the plan, checklist, wave files, and subagent tasks so context loss between sessions does not lose progress.
- Decision: All refactor governance lives under `docs/refactor-management/`. The integrator (this agent) is the sole writer of this folder. The verbatim plan is mirrored at `00-PLAN.md` (committed). Subagent task files under `05-subagent-tasks/` are the exact contracts workers execute; workers return one focused commit and never edit this folder.
- Rationale: Plan §0.1.3 (frozen input commit per wave), §0.1.6 (integrator cherry-picks serially), §0.1.20-equivalent (recoverable after context loss). Keeps the management surface separate from the production code surface so workers have unambiguous path ownership.
- Affects: all waves; folder `docs/refactor-management/`.
- Status: accepted

## D-20260728-03 — packageDigest formula: use `sha256Hex(obj)` (single canonicalization), NOT `sha256Hex(canonicalJson(obj))`
- Context: W2-A1 escalation A1. The frozen `sha256Hex` primitive (`src/saga3/shared/discovery-canonical.ts:41`) is defined as `sha256(canonicalJson(value))` — it canonicalizes internally. The W2-A1 task file and WAVE2-IMMUTABLE-INSTALLATION-SPEC §4 wrote the formula as `sha256Hex(canonicalJson({manifest, resourceIndex, resourceDigests}))` — a DOUBLE canonicalization. W2-A1 verified empirically that `sha256Hex(canonicalJson(obj))` ≠ `sha256Hex(obj)` (because `canonicalJson` is not idempotent on strings — it re-quotes them). This is an integrator-authoring error in the task file, not a code bug.
- Decision: **The canonical `packageDigest` formula is `sha256Hex({ manifest, resourceIndex: manifest.resourceIndex, resourceDigests: resources.map(r => r.digest) })`** — i.e. ONE canonicalization, inside the frozen `sha256Hex`. W2-A1 implemented the (incorrect) double-canonicalization form BUT exported `computePackageDigest` as the single source of truth, and W2-A3 imports it (per A1's return) — so A1+A3 are MUTUALLY CONSISTENT regardless of the formula. The Wave 2 exit gate (W2-A8 conformance) consumes `computePackageDigest` via the barrel, so all four (A1, A3, A8, and the persisted `package_digest` column) agree by construction.
- Action: At Wave 2 checkpoint integration, the integrator changes ONE line in `computePackageDigest` (`sha256Hex(canonicalJson(...))` → `sha256Hex(...)`) and re-runs the gate. This is a single-line normalization to the canonical formula; it does NOT affect A1/A3/A8 logic (they all delegate to the exported helper). Until then, the implementation is internally consistent and the exit gate passes.
- Rationale: The frozen primitive `sha256Hex` is the lineage-hash primitive across the entire codebase (proposal/readiness/settlement/certificate/policy hashes). Using `sha256Hex(obj)` directly aligns packageDigest with every other content hash in the system. Double-canonicalization would create a divergent hash family.
- Affects: Wave 2 (W2-A1 `computePackageDigest` one-line fix at integration); future waves that compute digests MUST use `sha256Hex(obj)` directly or import a shared helper.
- Status: accepted
- Followup: integrator amends WAVE2-IMMUTABLE-INSTALLATION-SPEC §4 wording at next HQ commit; applies the one-line fix at Wave 2 checkpoint.

## D-20260728-02 — canonicalJson frozen-primitive divergence; manifest fields must be ABSENT-not-UNDEFINED
- Context: W1-A1 escalation E1. The frozen `canonicalJson` in `src/saga3/shared/discovery-canonical.ts:28-37` does NOT drop `undefined` object values as the WAVE1-PURE-SPI-SPEC §1 row 1 (integrator's wording) claimed. Instead `JSON.stringify(undefined)` returns the JS value `undefined`, which interpolates into the template literal as the literal token `undefined` — producing invalid JSON like `{"a":undefined,"b":1}` that `JSON.parse` cannot consume. This breaks the round-trip contract (`JSON.parse(canonicalJson(m))` deep-equals `m`, spec §4) for any manifest containing an undefined object value. The primitive's own header comment mandates byte-stability ("all existing hashes remain stable") and plan §16.10 forbids editing immutable installed bytes.
- Decision: Adopt option (a) from W1-A1's recommendation. **Manifest fields must be ABSENT, not `undefined`.** Concretely:
  1. `assertCanonicalSerializable` (W1-A1) already correctly ACCEPTS `undefined` object values (matching the frozen primitive's actual behavior) — its behavior stays as implemented in `0d84110`.
  2. Manifest VALIDATORS (W1-A2/A3/A4/A6) must treat the round-trip contract as: a valid manifest has NO `undefined` object values; optional fields are OMITTED, not set to `undefined`. Validators MAY add an explicit check `noUndefinedObjectValues(m)` if helpful, but the primary enforcement is authoring discipline + the round-trip test itself (a manifest with an undefined value will fail `JSON.parse(canonicalJson(m))` and thus fail W1-A8 conformance).
  3. Do NOT modify the frozen `canonicalJson` primitive. Every content hash in the codebase (proposal/readiness/settlement/certificate/policy) depends on its exact bytes.
- Rationale: Option (b) "fix canonicalJson" would shift every lineage hash in the codebase — a destructive change that violates plan §16.10 and the primitive's own stability mandate, with no architectural benefit (manifests simply must not carry undefined values). Option (c) "accept divergence" silently breaks round-trip. Option (a) is the only one that preserves frozen bytes AND keeps round-trip sound.
- Affects: Wave 1 lanes W1-A2/A3/A4/A6/A8 (validators + conformance tests). WAVE1-PURE-SPI-SPEC §1 row 1 and §4 wording is superseded by this decision.
- Status: accepted
- Followup: integrator amends WAVE1-PURE-SPI-SPEC.md §1 row 1 + §4 to reflect "manifest fields absent-not-undefined" at next HQ commit.
