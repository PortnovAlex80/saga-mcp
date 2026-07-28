# Wave 2 — Immutable Installation & Registries

> Plan mapping: §0.5 (Phases 2, 3 excl. live LM driver). **Status:** 🟡 PARTIAL — 8/8 lanes integrated; build green; 132/132 lane tests pass; A8 conformance 6/8 fail (R-07 — `store.verify` replay mismatch under investigation).

## Dispatched lanes (tracking)

| Lane | Branch | Worktree | Status | Commit |
|---|---|---|---|---|
| W2-A1 | `refactor/w1-a1` | `.worktrees/w2-a1` | ✅ done (`589f5f3`) | 16/16 tests + W1 238/238 + W0 11/11 regression; exported `computePackageDigest` (W2-A3 imports); **ESCALATION A1**: packageDigest double-canonicalization formula ambiguity |
| W2-A2 (SQL OWNER) | `refactor/w2-a2` | `.worktrees/w2-a2` | ✅ done (`6e28522`) | 24/24 tests + 28 regression; single SQL owner; dual-placement of process_runs ALTERs (db.ts for upgrade + sqlite-process-run-repository.ts for fresh-DB — spec §3 assumption was wrong); ratchet green |
| W2-A3 | `refactor/w2-a3` | `.worktrees/w2-a3` | ✅ done (`c5274cb`) | 14/14 tests pass (with in-memory fakes matching ports); inline structural port types for isolation (integrator swaps to `import type` at cherry-pick); §0.5.12 replay test passes; ratchet green |
| W2-A4 | `refactor/w2-a4` | `.worktrees/w2-a4` | ✅ done (`049736c`) | 15/15 tests pass; self-contained (own ALTER ordering fix); raw SQL adapter (no SqliteProcessRunRepository import); structural-subset types for integration; ratchet green |
| W2-A5 | `refactor/w2-a5` | `.worktrees/w2-a5` | ✅ done (`661b8c7`) | 25/25 tests pass; inline semver matcher (`*`, exact, `^`, `~` — no prefix/hyphen/OR, plan §14.4.5); highest-version deterministic; W2-A2-owned types re-declared locally (fenced "W2-A2-OWNED" for cherry-pick); ratchet green |
| W2-A6 | `refactor/w2-a6` | `.worktrees/w2-a6` | ✅ done (`18415ed`) | 31/31 tests + W1 17/17 regression; 5 registry ports+adapters + ProcessModulePlugin + InstalledProcessModule binding (fail-fast, namespace collision rejected); local structural aliases for integration; ratchet green |
| W2-A7 | `refactor/w2-a7` | `.worktrees/w2-a7` | ✅ done (`a5dc12c`) | 7/7 tests pass + W0-A7 14/14 regression; 3rd synthetic `synthetic-compliance-check`@0.1.0 (Kernel, 2 resources) + security fixtures (path-traversal/hash-mismatch/version-collision); local structural alias for ModuleInstallationRecord; ratchet green |
| W2-A8 | `refactor/w2-a8` | `.worktrees/w2-a8` | ✅ done (`f7ab825`) | Expected unresolved-import in isolation; barrel uses explicit named re-exports (W1-A8 lesson); 8 exit-gate assertions ready; ratchet green |

## Objective (§0.5.12 serial gate)

Installed bytes replay after source mutation OR deletion; a released version cannot change digest; a pinned installation cannot be nullified; a 3rd module installs without a central catalog edit. Wave 2 ADDS an immutable package layer + generic registries alongside the legacy in-memory path — **no live execution-path cutover, no existing-run behavior change** (plan §16.9).

## Serial precondition (§0.5.2) — SATISFIED

Integrator published `09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`: new `installation/` subdir layout, ports vs adapters, additive schema (single SQL owner W2-A2), identity/digest rules, anti-scope, exit gate, integration order.

## Frozen input commit

- **HEAD:** `15d931a` (Wave 1 checkpoint `6a349a2` + progress-log commit). Wave 2 branches off this.
- **Spec:** `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
- **Wave 1 SPI barrel:** `src/process-modules/domain/spi/index.ts` (ProcessModuleManifest, ResourceIndexEntry, HandlerRef, ContractRef, etc.)

## Ownership lanes (8) — disjoint new files under `installation/` + `tests/installation/`

| Lane | Owns (new files) | Spec section |
|---|---|---|
| **W2-A1** | `installation/domain/package-store.ts` + `installation/adapters/filesystem-package-store.ts` + `tests/installation/filesystem-package-store.test.mjs` | §1 rows 1,2 |
| **W2-A2** (SQL OWNER) | `installation/domain/installation.ts` + `installation/persistence/installation-repository.ts` + `tests/installation/installation-repository.test.mjs` + edits to `src/db.ts` (the ONLY `db.ts` editor this wave) | §1 rows 3,4 + §3 |
| **W2-A3** | `installation/domain/installer.ts` + `installation/domain/dependency-lock.ts` + `tests/installation/installer.test.mjs` | §1 rows 5,6 |
| **W2-A4** | `installation/domain/process-run-pinning.ts` + `installation/persistence/process-run-installation-adapter.ts` + `tests/installation/process-run-pinning.test.mjs` | §1 rows 7,8 |
| **W2-A5** | `installation/domain/package-registry.ts` + `tests/installation/package-registry.test.mjs` | §1 row 9 |
| **W2-A6** | `installation/domain/registries.ts` + `installation/domain/plugin.ts` + `installation/domain/installation-binding.ts` + `tests/installation/registries.test.mjs` | §1 rows 10,11,12 |
| **W2-A7** | `tests/installation/fixtures/3rd-synthetic-module/` (NEW fixture proving no-catalog-edit install) + `installation/domain/describe.ts` + `tests/installation/describe.test.mjs` + resource-traversal/hash-mismatch/version-collision fixtures | §1 row 13,14 |
| **W2-A8** | `installation/index.ts` (barrel) + `tests/installation/round-trip-replay-conformance.test.mjs` (Wave 2 exit-gate proof: install → mutate source → replay → identical) | §1 barrel + §6 |

**One writer per file.** All new files live under `installation/` (new subdir) and `tests/installation/` (new subdir). The dep-graph ratchet MUST stay green: `installation/domain/*` imports ONLY from `installation/domain/*`, `domain/spi/*`, `domain/*.ts`, `shared/canonical-json.ts`. SQLite/filesystem touches are in `installation/persistence/` + `installation/adapters/` ONLY.

## Single SQL owner (C083)

**W2-A2 is the ONLY lane that edits `src/db.ts` this wave.** W2-A2 adds `ensureSaga3ModuleInstallationSchema(db)` + the two ALTERs on `saga3_process_runs` (additive, nullable). Any other lane needing a schema change STOPs and escalates (§0.1.7). Plan §0.5.2.

## Composition root (HOT FILE, C084)

`composition/product-lifecycle-runtime.ts` is touched ONLY by the integrator at checkpoint — lanes expose services via the barrel; the integrator wires a parallel installation path. Lanes do NOT edit the composition root.

## Exit gate (§0.5.12 / spec §6)

1. `npm run build` green.
2. Install → mutate source → replay identical (§14.3.8).
3. Version-collision rejected.
4. Pinned installation not nullifiable (legacy adapter resolves NULL).
5. 3rd module installs without catalog/Runtime/module edit (§14.4.7).
6. Dependency lock resolves every ref to digest.
7. Ratchet green (73 unchanged or fewer).
8. Wave 0 + Wave 1 regression green.

## Test command (the wave gate)

```bash
npm run build
node --test tests/installation/**/*.test.mjs
node --test tests/spi/**/*.test.mjs
node --test tests/architecture/dependency-direction.test.mjs
node --test tests/characterization/saga2-runtime-contracts.test.mjs
```

## Integration order (integrator, serial)

A2 → A1 → A3 → A5 → A6 → A4 → A7 → A8. Gate after each pick. Checkpoint `refactor(wave-2): immutable installation checkpoint`.

## Schema changes

ADDITIVE only (§3): new `saga3_module_installations` table + 2 nullable ALTERs on `saga3_process_runs`. Single SQL owner W2-A2.
