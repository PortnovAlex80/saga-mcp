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

## R-07 — Wave 2 A8 conformance: 3 failing cross-lane tests (PARTIAL INTEGRATION)
- Surfaced: 2026-07-28 (Wave 2 integration)
- Likelihood: high · Impact: medium
- Owner: integrator (Wave 2 follow-up before Wave 3)
- Description: Wave 2 cherry-picked all 8 lanes (build green, 132/132 lane tests pass). The W2-A8 conformance suite has 3 failing tests due to cross-lane assumption mismatches that surfaced only at integration:
  1. **Version-collision detection point**: W2-A3 installer detects collision at `activate` (step 8), surfacing `MODULE_INSTALLATION_ACTIVATE_FAILED` with a collision message — but W2-A8 expects the error CODE `MODULE_INSTALLATION_VERSION_COLLISION`. Fix: the installer's `wrapPortError` must recognize collision messages and translate to the canonical code. OR detect at `insert` by pre-checking `repo.getActiveByNameVersion`.
  2. **SQLITE_ERROR in pinning test** (W2-A8 line 414): the pinning test path doesn't ensure `saga3_process_runs` table + the new ALTER columns exist in its DB context. W2-A4's own test handled this via `ensureInstallationColumns()`; W2-A8 doesn't replicate that setup.
  3. **"fixture has at least one stored resource"** (W2-A8 line 522): the corruption test expects stored resource files on disk after install, but the install path may not have written resources (manifest from `adaptLegacyProcessModule` has empty resourceIndex, so no resources to store).
- Mitigation: These are integration-reconciliation fixes (like the W1 cross-lane fixes), not architectural gaps. The Wave 2 SPI + store + repo + installer + registries + pinning + describe are all proven by the 132 passing lane tests. The A8 conformance is the END-TO-END proof that needs the 3 fixes. Integrator addresses in a follow-up commit before Wave 3 (Wave 3 depends on a working installation layer).
- Status: open (Wave 2 follow-up)

## R-06 — Checked-in DB/log artifacts
- Surfaced: 2026-07-28 (baseline §"Hygiene flags")
- Likelihood: medium · Impact: low
- Owner: integrator (housekeeping)
- Description: `tests/planner-ac9/.tmp-ac9-pipeline.db*` (3 files) and numerous `epic3*-run.log` / `orchestrate-*.log` at repo root.
- Mitigation: Add to `.gitignore`; remove the checked-in tmp DB in a Wave 0 hygiene commit (do not touch unrelated user-owned bootstrap-*.mjs / lifecycle-input-*.json).
- Status: open (Wave 0 housekeeping)
