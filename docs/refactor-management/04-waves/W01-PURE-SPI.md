# Wave 1 — Pure SPI Validation & Proof

> Plan mapping: §0.4 (Phase 1). **Status:** ✅ DONE — 8/8 lanes integrated, 238/238 SPI tests pass, 0 production lines changed.

## Dispatched lanes (tracking)

| Lane | Branch | Worktree | Status | Commit |
|---|---|---|---|---|
| W1-A1 | `refactor/w1-a1` | `.worktrees/w1-a1` | ✅ done (`0d84110`) | 19/19 tests pass; ratchet green. **ESCALATION E1**: `canonicalJson({a:undefined})` emits invalid JSON token `undefined` (not dropped as spec claimed) — round-trip will fail for manifests with undefined object values. Integrator resolving. |
| W1-A2 | `refactor/w1-a2` | `.worktrees/w1-a2` | ✅ done (`b655e2a`) | 28/28 tests pass (with local stubs, removed pre-commit); structural-only ProcessModuleDefinition check (Rule 5 forbids domain→application); ratchet green |
| W1-A3 | `refactor/w1-a3` | `.worktrees/w1-a3` | ✅ done (`002e1ee`) | 23/23 tests pass (with stubs, removed pre-commit); `ScenarioStageBinding extends StageBinding`; routeResolver key checked BEFORE canonical gate (§6.4 priority); ratchet green |
| W1-A4 | `refactor/w1-a4` | `.worktrees/w1-a4` | ✅ done (`838f541`) | 36/36 tests pass (with stubs, removed pre-commit); C061 driver-neutral guard `findForbiddenDriverNeutralKeys` + C065 retry/condition ratchets; ratchet green |
| W1-A5 | `refactor/w1-a5` | `.worktrees/w1-a5` | ✅ done (`9adc5c5`) | 17/17 tests pass; ratchet green (73 unchanged); ContractRef indexed by (schemaId,version), digest not lookup key |
| W1-A6 | `refactor/w1-a6` | `.worktrees/w1-a6` | ✅ done (`5f6fcfd`) | 75/75 tests pass; 6 source + 4 test files (2724 lines); inline-mirrored NodeProduction (Rule 5 compliance), dynamic-import resolver for A1/A5; ratchet green |
| W1-A7 | `refactor/w1-a7` | `.worktrees/w1-a7` | ✅ done (`fd0faa5`) | Expected isolated fail (W1-A2/A5 imports); pure `adaptLegacyProcessModule` + LEGACY constants + LegacyManifestAdapterError; ratchet green; validates at integration |
| W1-A8 | `refactor/w1-a8` | `.worktrees/w1-a8` | ✅ done (`da80a05`) | Expected unresolved-import-fail in isolation (siblings absent); barrel + 21 conformance tests ready; ratchet green; validates at integration |

## Objective (§0.4.11 serial gate)

All manifests round-trip through canonical JSON; functions, Maps, Sets, undefined-in-array values, non-enumerable behavior, ignored Flow conditions, and unsupported retry semantics **fail** canonical-serialization/manifest installation. Wave 1 adds ONLY new pure files under `src/process-modules/domain/spi/` and their tests. **No existing production source modified.**

## Serial precondition (§0.4.2) — SATISFIED

The integrator alone published the pure SPI checkpoint: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md`. It names every new file, its owner lane, its fields, its validator, and its negative-test contract. Workers validate against it; they do not change it.

## Frozen input commit

- **HEAD:** `b0746cd` (Wave 0 checkpoint) — Wave 1 branches off this.
- **Spec:** `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md`
- **Synthetic fixtures:** `tests/fixtures/synthetic-modules/*`, `tests/fixtures/synthetic-scenarios/campaign/*` (from W0-A7).

## Ownership lanes (8) — disjoint new files under `domain/spi/`

| Lane | Owns (new files) | Spec section |
|---|---|---|
| **W1-A1** | `domain/spi/canonical-serialization.ts` + `tests/spi/canonical-serialization.test.mjs` | §1 row 1, §3 |
| **W1-A2** | `domain/spi/module-manifest.ts` + `resource-index.ts` + `tests/spi/module-manifest.test.mjs` | §1 rows 4,5 |
| **W1-A3** | `domain/spi/scenario-manifest.ts` + `tests/spi/scenario-manifest.test.mjs` | §1 row 6 |
| **W1-A4** | `domain/spi/node-protocol.ts` + `execution-envelope.ts` + `tests/spi/node-protocol.test.mjs` + `tests/spi/execution-envelope.test.mjs` | §1 rows 7,8 |
| **W1-A5** | `domain/spi/contract-ref.ts` + `contract-schema-registry.ts` + `tests/spi/contract-schema-registry.test.mjs` | §1 rows 2,3 |
| **W1-A6** | `domain/spi/production-envelope.ts` + `module-completion.ts` + `recovery-definitions.ts` + `tool-contribution.ts` + `agent-assistance.ts` + `execution-receipt.ts` + `tests/spi/{production-envelope,module-completion,tool-contribution,agent-assistance}.test.mjs` | §1 rows 9,10,11,12,13,14 |
| **W1-A7** | `domain/spi/legacy-adapter.ts` + `tests/spi/legacy-adapter.test.mjs` | §1 row 15 |
| **W1-A8** | `domain/spi/index.ts` (barrel) + `tests/spi/round-trip-conformance.test.mjs` + `tests/spi/synthetic-fixture-conformance.test.mjs` | §1 barrel, §4 |

**One writer per file.** All new files live under `domain/spi/` (a new subdir) and `tests/spi/` (a new subdir) — zero overlap with existing production source. The dependency-direction ratchet (W0-A1) MUST stay green: new files import only from `domain/`, `shared/canonical-json.ts`, and other `domain/spi/` files.

## Inter-lane type dependencies (important)

The spec defines a clean import DAG. To avoid cherry-pick conflicts, lanes must import sibling `domain/spi/` types via the **logical path** (e.g. `../contract-ref.js`) but NOT create a barrel until W1-A8. Concretely:
- `module-manifest.ts` (A2) imports `ContractRef` from A5's `contract-ref.ts`, `ResourceIndexEntry` from A2's own `resource-index.ts`, and types from A6 (`ModuleToolContribution`, `AgentAssistanceDefinition`, `GuardBinding`, `CapabilityRequirement`).
- `scenario-manifest.ts` (A3) imports `ContractRef` (A5), reuses `LifecycleIdentity`/`StageBinding`/`LifecycleMappingExpression`/`TransitionTarget` from existing `domain/lifecycle.ts`.
- `production-envelope.ts` / `module-completion.ts` (A6) import `ContractRef` (A5).
- `legacy-adapter.ts` (A7) imports `ProcessModuleManifest` (A2) + existing `ProcessModuleDefinition`.

Because the imports cross lane boundaries by **type only** (no runtime coupling), and each file has exactly one writer, cherry-pick integration will be clean. The barrel `index.ts` (A8) is created LAST and imports from all lanes — that's why A8 runs after the others in integration order.

## Test commands (the wave gate)

```bash
npm run build
node --test tests/spi/**/*.test.mjs
node --test tests/architecture/dependency-direction.test.mjs   # ratchet green
```

## Exit gate (§0.4.11 / spec §6)

1. `npm run build` green.
2. `assertCanonicalSerializable` rejects every forbidden value kind (A1 negative tests).
3. Every manifest validator rejects its negative cases (A2/A3/A4/A6 negative tests).
4. `ProcessModuleManifest` + `LifecycleScenarioManifest` round-trip via canonical JSON (A8).
5. W0-A7 synthetic fixtures wrap into new manifest types and round-trip (A8).
6. **No existing production source file modified.**
7. Two unrelated synthetic packages validate via same SPI (lm-marketing + external-seo).

## Integration order (integrator, serial)

1. Cherry-pick W1-A1 (canonical-serialization is the foundation every validator calls).
2. Cherry-pick W1-A5 (ContractRef + registry — A2/A3/A6 depend on ContractRef).
3. Cherry-pick W1-A6 (production/completion/recovery/tool/assistance types — A2 manifest references them).
4. Cherry-pick W1-A2 (module manifest + resource index).
5. Cherry-pick W1-A4 (node protocol + execution envelope).
6. Cherry-pick W1-A3 (scenario manifest).
7. Cherry-pick W1-A7 (legacy adapter — depends on A2 manifest).
8. Cherry-pick W1-A8 (barrel + conformance tests — depends on all).
9. Run gate after each pick. Create checkpoint commit `refactor(wave-1): pure SPI checkpoint`.

## Schema changes

**None.** Wave 1 adds no persistence.

## Notes for workers

- Read `09-contracts/WAVE1-PURE-SPI-SPEC.md` IN FULL before writing code. It is your contract.
- Every validator MUST call `assertCanonicalSerializable` (from W1-A1) on its input. If A1 hasn't landed in your worktree, write your validator to import it from the spec'd path — it will resolve at integration time.
- Reuse existing types from `domain/process-module.ts`, `domain/lifecycle.ts`, `domain/recovery.ts` via import. Do NOT redefine them.
- Do NOT modify any existing production file. New files only.
- If a spec field is ambiguous, STOP and report it as a risk — do not guess and create a divergent type (§0.1.7).
