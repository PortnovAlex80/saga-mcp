# 08 — Risk Register

Open risks surfaced during the refactor. Each has an owner and a mitigation.
Closed risks are moved to a "Closed" section at the bottom with the resolution.

Format:
```
## R-NN — <title>
- Surfaced: YYYY-MM-DD (wave/agent)
- Likelihood: low | medium | high
- Impact: low | medium | high
- Owner: <integrator | wave-lane>
- Description: ...
- Mitigation: ...
- Status: open | mitigated | closed
```

---

(seeded from plan §17 as standing risks; operational risks added as surfaced)

## R-01 — Over-generalizing the SPI
- Surfaced: 2026-07-28 (plan §17.1)
- Likelihood: medium · Impact: high
- Owner: integrator
- Description: Abstractions that serve only one module kind leak domain semantics into Runtime.
- Mitigation: Plan §17.1 — prove each abstraction with ≥2 unrelated module kinds; reject fields used by only one module from Runtime contracts. Enforced by Wave 10 (arbitrary extensibility proof) before any cutover.
- Status: open (standing)

## R-02 — Hash pinning without replayable bytes
- Surfaced: 2026-07-28 (plan §17.3, §13.15)
- Likelihood: high · Impact: high
- Owner: Wave 2 (W2-A1 store, W2-A3 installer)
- Description: Current prototype hashes mutable source files; same released name/version can carry different digests. Pinning a hash without immutable bytes gives false replay safety.
- Mitigation: Wave 2 mandates content-addressed immutable store + version-collision rejection + replay-after-source-mutation test (plan §0.5.12, C013/C014).
- Status: open (Wave 2 owns)

## R-03 — Decentralized SQL schema (~14 ensure…Schema writers)
- Surfaced: 2026-07-28 (baseline §"Persistence & migrations")
- Likelihood: high · Impact: medium
- Owner: per-wave SQL owner (C083)
- Description: `CREATE TABLE IF NOT EXISTS saga3_*` scattered across sqlite adapters + `src/schema.ts` + `src/db.ts` migration chain. New tables risk ordering bugs and merge conflicts when multiple waves add persistence.
- Mitigation: One SQL owner per wave reserves migration numbering; additive-only migrations until cutover (plan §16.1, §9.12). Track every new table in the wave file's "Schema changes" section.
- Status: open (standing)

## R-04 — Architecture test blind spot
- Surfaced: 2026-07-28 (baseline §"Architecture / boundary tests")
- Likelihood: high · Impact: high
- Owner: Wave 0 (W0-A1)
- Description: `tests/architecture/saga2-boundaries.test.mjs` scans 21 hard-coded files and predates `src/process-modules/**`, `src/saga3/**`, `src/lifecycle/**`. No repository-wide dependency enforcement exists.
- Mitigation: Wave 0 W0-A1 adds repository-wide dependency + forbidden-import tests before any code moves (plan §0.3.2, §14.1.3, C047).
- Status: open (Wave 0 owns)

## R-05 — Stale test-runner grouping
- Surfaced: 2026-07-28 (baseline §"Process-module tests")
- Likelihood: medium · Impact: low
- Owner: Wave 0 (W0-A8)
- Description: `tools/run-process-module-tests.mjs` groups a/b cover only 29 of 41 `tests/process-modules/` files; 12 files run only via default discovery.
- Mitigation: Wave 0 W0-A8 owns isolated test-runner configuration; regenerate groups from directory scan.
- Status: open (Wave 0 owns)

## R-07 — Wave 2 A8 conformance: cross-lane digest/SQL mismatches (RESOLVED)
- Surfaced: 2026-07-28 (Wave 2 integration) · Resolved: 2026-07-29
- Likelihood: was high · Impact: was medium
- Owner: integrator
- Description: W2-A8 conformance had 6/8 failing tests. Root cause (found after deep debug): **resource digest must use raw-bytes `crypto.createHash('sha256').update(bytes).digest('hex')`, NOT `sha256Hex(bytes)`** — because `sha256Hex` canonical-JSON-serializes a `Uint8Array` first (producing `{"0":x,"1":y,...}`), giving a completely different hash. Multiple test files (W2-A1 referencePackageDigest, W2-A3 fake-store verify + digestBytes, W2-A8 fixture loading) independently used `sha256Hex(bytes)` — the WRONG formula for raw bytes. Plus: better-sqlite3 `.get()` misused on UPDATE statements; A8 minimal table missing `updated_at` column; A5 registry `select()` vs A4 adapter `resolve()` API divergence; A8 fixture export name `complianceCheckResourceIndex` vs expected `resourceIndex`.
- Resolution: All fixed at Wave 2 integration. (1) `computePackageDigest` single-canonicalization per D-20260728-03; (2) all resource-digest computations use crypto raw-bytes sha256; (3) `.run()` for UPDATE; (4) `updated_at` added to minimal test table; (5) fallback registry wrapper; (6) fixture export name corrected. Wave 2 gate now 140/140 PASS including A8 conformance 8/8.
- Status: closed (resolved 2026-07-29)

## R-06 — Checked-in DB/log artifacts
- Surfaced: 2026-07-28 (baseline §"Hygiene flags")
- Likelihood: medium · Impact: low
- Owner: integrator (housekeeping)
- Description: `tests/planner-ac9/.tmp-ac9-pipeline.db*` (3 files) and numerous `epic3*-run.log` / `orchestrate-*.log` at repo root.
- Mitigation: Add to `.gitignore`; remove the checked-in tmp DB in a Wave 0 hygiene commit (do not touch unrelated user-owned bootstrap-*.mjs / lifecycle-input-*.json).
- Status: open (Wave 0 housekeeping)
