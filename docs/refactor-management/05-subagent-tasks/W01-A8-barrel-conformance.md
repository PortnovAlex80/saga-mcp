# W1-A8 — Barrel index + round-trip + synthetic-fixture conformance

**Wave:** 1 · **Lane:** A8 · **Spec:** §1 barrel, §4 · **Frozen input commit:** `b0746cd`
**Branch:** `refactor/w1-a8` · **Worktree:** `.worktrees/w1-a8`

## Read first
1. `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` (full).
2. All sibling lane return-reports in your worktree's `docs/refactor-management/06-PROGRESS-LOG.md` (to know the exported symbol names — BUT note: at the time you run, sibling lanes may not have committed yet; import from the spec'd paths regardless; integration resolves them).
3. `tests/fixtures/synthetic-modules/*` + `tests/fixtures/synthetic-scenarios/campaign/*` (W0-A7 — your conformance proof targets).

## Own (only you)
- `src/process-modules/domain/spi/index.ts` (barrel — re-exports everything)
- `tests/spi/round-trip-conformance.test.mjs`
- `tests/spi/synthetic-fixture-conformance.test.mjs`

## What to build
### `index.ts` (barrel)
Re-export from every sibling `domain/spi/*.ts` file: `canonical-serialization`, `contract-ref`, `contract-schema-registry`, `module-manifest`, `resource-index`, `scenario-manifest`, `node-protocol`, `execution-envelope`, `production-envelope`, `module-completion`, `recovery-definitions`, `tool-contribution`, `agent-assistance`, `execution-receipt`, `legacy-adapter`. This is the single import surface for the new SPI.

### `round-trip-conformance.test.mjs` (spec §4)
For EACH manifest type (`ProcessModuleManifest`, `LifecycleScenarioManifest`, `NodeProtocolDefinition`, `ModuleToolContribution`, `AgentAssistanceDefinition`, `ModuleCompletion`, `ProcessModuleOutputEnvelope`, `ExecutionContextEnvelope`, `DriverNeutralExecutionReceipt`):
- Construct a valid minimal instance.
- Assert `JSON.parse(canonicalJson(instance))` deep-equals the instance.
- Assert `sha256Hex(instance)` is stable across two runs.
- Assert `assertCanonicalSerializable(instance)` does not throw.

### `synthetic-fixture-conformance.test.mjs` (spec §4, plan §14.2.6)
- Import the 4 W0-A7 synthetic module definitions. Wrap each into a `ProcessModuleManifest` (via `adaptLegacyProcessModule` from W1-A7 OR by constructing directly with a resourceIndex — your choice, but document which). Validate each passes `validateProcessModuleManifest`. Round-trip each.
- Import the W0-A7 `campaign` scenario. Map it into a `LifecycleScenarioManifest`. Validate passes `validateLifecycleScenarioManifest`. Round-trip.
- Assert the campaign manifest has NO `routeResolver` (plan §6.4) and that `external-seo` appears in 2 stages (plan §6.8 — module reuse).
- This is the Wave 1 exit-gate proof: "two unrelated synthetic packages validate using the same SPI without Runtime changes" (plan §14.2.6) — lm-marketing (LM) + external-seo (External) are the two unrelated kinds.

## Cross-lane imports
- Everything from sibling `domain/spi/*.ts` via the barrel you create.
- W0-A7 fixtures from `tests/fixtures/...`.

## Anti-scope
- Do NOT modify sibling `domain/spi/*.ts` files (you only create `index.ts`). If a sibling file's export name differs from the spec, STOP and escalate — do not create a divergent alias.
- Do NOT modify existing production source.

## Verify
```
cd .worktrees/w1-a8 && npm run build && node --test tests/spi/round-trip-conformance.test.mjs tests/spi/synthetic-fixture-conformance.test.mjs && node --test tests/architecture/dependency-direction.test.mjs
```
NOTE: this lane's tests will FAIL in isolation if sibling lanes haven't landed in your worktree — that's expected. You develop against the spec'd paths; the integrator runs the full gate after cherry-picking all lanes in order. **In your return, clearly state whether your local run passed (siblings present) or failed-with-unresolved-imports (siblings not yet picked) — both are acceptable outcomes for A8; the integrator validates at integration.**

## Commit
`feat(spi): W1-A8 barrel index + round-trip + synthetic-fixture conformance (Wave 1 exit gate)`.

## Return
1. Branch + sha. 2. diff --stat. 3. test result (pass OR unresolved-import-fail — state which). 4. The full barrel export list (the integrator uses it to verify all sibling symbols landed). 5. Confirmation. Escalate any sibling-spec mismatch immediately.
