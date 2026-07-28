# Wave 0 — Baseline & Executable Architecture Rules

> Plan mapping: §0.3, §13, §15, §16. Phase 0 (§14.1).
> **Status:** 🟡 STAGING — frozen checkpoint being published.

## Objective (§0.3.10 serial gate)

Freeze terminology, dependency direction, the known-debt allowlist, current
failure fixtures, and synthetic fixture boundaries — **without production
behavior changes**. Wave 0 produces only tests, fixtures, ADRs, and the
repository-wide architecture enforcement that later waves depend on. No
production source files change semantics.

## Serial preconditions

- Integrator has read the full plan (C001 ✅).
- Baseline reconnaissance captured in `01-CODEBASE-BASELINE.md`.
- HEAD = `eb35510` (frozen input commit for this wave).

## Ownership lanes (8) — disjoint paths

| Lane | Owns (paths) | Plan ref |
|---|---|---|
| **W0-A1** | `tests/architecture/dependency-direction.test.mjs` (NEW, repo-wide), `tools/dep-graph-scanner.mjs` (NEW helper) | §0.3.2, §13.14, C047 |
| **W0-A2** | `tests/characterization/execution-profile-runner-workspace-hooks.test.mjs` (NEW) | §0.3.3 |
| **W0-A3** | `tests/characterization/mcp-catalog-authority-errors.test.mjs` (NEW) | §0.3.4 |
| **W0-A4** | `tests/characterization/lifecycle-routing-mapping-lock.test.mjs` (NEW) | §0.3.5 |
| **W0-A5** | `tests/characterization/package-identity-collision-replay.test.mjs` (NEW) | §0.3.6 |
| **W0-A6** | `tests/characterization/fixtures/2026-07-28-failures/` (NEW dir + fixtures) | §0.3.7 |
| **W0-A7** | `tests/fixtures/synthetic-modules/` (NEW dir: lm, kernel, human, external) + `tests/fixtures/synthetic-scenarios/` (NEW) | §0.3.8 |
| **W0-A8** | `tools/run-process-module-tests.mjs` (REGENERATE groups from dir scan), `docs/architecture/decisions/015-*.md`…`021-*.md` (NEW ADRs), `docs/architecture/COMPATIBILITY-INVENTORY.md` (NEW), `.gitignore` (append tmp db/log patterns) | §0.3.9, §14.1.2 |

**One writer per file.** No lane edits production source. No lane edits another
lane's file. Shared barrels (`package.json`, `tsconfig.json`) are touched only
by the integrator at checkpoint.

## Frozen input commit

- **HEAD:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd` (branch `agent/saga3-process-modules`)
- **Plan reference:** `docs/refactor-management/00-PLAN.md` (verbatim frozen copy)
- **Baseline:** `docs/refactor-management/01-CODEBASE-BASELINE.md`

## Test commands (the wave gate)

```bash
# Build first (all new tests import from dist/ or src/ via tsx-less node:test)
npm run build

# Wave 0 gate: architecture + new characterization + full default suite still green
npm run test:architecture
node --test tests/architecture/dependency-direction.test.mjs \
            tests/characterization/execution-profile-runner-workspace-hooks.test.mjs \
            tests/characterization/mcp-catalog-authority-errors.test.mjs \
            tests/characterization/lifecycle-routing-mapping-lock.test.mjs \
            tests/characterization/package-identity-collision-replay.test.mjs

# Regression: nothing Wave 0 touches should break the existing suite
npm test
```

## Exit gate (§0.3.10)

Wave 0 closes when ALL hold:
1. Repository-wide dependency-direction test exists and **passes**, with current
   violations listed as an explicit, documented allowlist (not silently
   ignored). [W0-A1]
2. Four characterization suites exist and **pass**, locking current behavior of:
   execution-profile/runner/workspace/hooks [W0-A2], MCP catalog/authority/
   structured errors [W0-A3], lifecycle routing/mapping/lock/cumulative-frame/
   restart/transaction [W0-A4], package identity/version collision/resource
   mutation/installation pin/replay [W0-A5].
3. 2026-07-28 failure fixtures captured (context/provenance/receipt/acceptance/
   recovery) as reproducible test inputs. [W0-A6]
4. Synthetic LM/Kernel/Human/External module fixtures + one synthetic scenario
   fixture exist with documented boundaries. [W0-A7]
5. ADRs written for: package identity, scenario identity, dependency direction,
   execution envelopes, protocol state, tool ownership, compatibility policy. [W0-A8]
6. Test runner config regenerated; compatibility inventory written; `.gitignore`
   covers tmp DB/log artifacts. [W0-A8]
7. **No production source file changed semantics** (commits are tests/fixtures/
   docs/tools only).

## Integration order (integrator, serial)

1. Cherry-pick W0-A1 (architecture enforcement is the foundation other lanes assert against).
2. Cherry-pick W0-A8 ADRs + inventory + .gitignore (documents the allowlist W0-A1 produced).
3. Cherry-pick W0-A7 synthetic fixtures (W0-A6 may reference them).
4. Cherry-pick W0-A6 failure fixtures.
5. Cherry-pick W0-A2, W0-A3, W0-A4, W0-A5 characterization suites (independent).
6. Run full gate after each pick.
7. Create checkpoint commit `refactor(wave-0): baseline + architecture rules checkpoint`.

## Schema changes

**None.** Wave 0 adds no persistence.

## Notes for workers

- Each worker creates a feature branch off `eb35510`: `refactor/w0-aN`.
- Each worker returns: branch name, changed-file list, test evidence (paste the passing summary), unresolved risks, confirmation it changed no frozen contract and no production semantics.
- Workers read `01-CODEBASE-BASELINE.md` for the precise inventory; they do not need to re-reconnoiter.
- Characterization tests ASSERT CURRENT BEHAVIOR (even if ugly). They are the safety net for later waves to change behavior deliberately. A characterization test that "improves" behavior is wrong.
- The dependency-direction test (W0-A1) MUST list current violations in an allowlist constant, not fail the build. Later waves move items off the allowlist; the test fails if a NEW violation appears or an allowlisted one is removed without being fixed.
