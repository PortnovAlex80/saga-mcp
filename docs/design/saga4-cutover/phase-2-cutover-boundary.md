# Phase 2 — Cutover Boundary: Lifecycle Orchestrator as the sole entrypoint

> **Status:** READ-ONLY edit specification. No source modified in this phase.
> Phase 2 defines the *exact* surgical edits that make the Lifecycle
> Orchestrator the SOLE start/resume entrypoint and make `saga3-lifecycle` the
> unconditional default — while preserving backward-compatibility for the test
> suite.
>
> Scope of this document: declare the boundary. A later phase executes the edits.

---

## 0. Current architecture (as found)

Three layers cooperate today, and a fourth (the worker/server) does **not**
read the mode at runtime. The mode is consumed only at composition time and at
tracker-view spawn time.

### 0.1 Mode union and helpers — `src/runtime/orchestration-mode.ts`

| Element | Line | Current value / behaviour |
|---|---|---|
| `OrchestrationMode` union | 50–57 | `'v2' \| 'v3' \| 'saga2' \| 'saga3-discovery' \| 'saga3-discovery-generic' \| 'saga3-formalization' \| 'saga3-lifecycle'` |
| `ORCHESTRATION_MODES` const | 59–62 | same 7 values as an array |
| `DEFAULT_ORCHESTRATION_MODE` | 65 | **`'v2'`** ← the value that must flip |
| `parseOrchestrationMode` | 74–83 | trims/normalises; throws on unknown |
| `requiresBackgroundEngine` | 94–96 | `mode !== 'v2'` |
| `isSaga3DiscoveryMode` | 107–109 | `=== 'saga3-discovery' \|\| === 'saga3-discovery-generic'` |
| `isSaga3DiscoveryGenericMode` | 116–118 | `=== 'saga3-discovery-generic'` |
| `isSaga3FormalizationMode` | 126–128 | `=== 'saga3-formalization'` |
| `isSaga3LifecycleMode` | 131–133 | `=== 'saga3-lifecycle'` |

**Functions that select `Saga2Engine` (transitively):** none of the predicates
do directly. The `Saga2Engine` selection is the **implicit fall-through** at the
end of `selectEngine` (`composition-root.ts:349–357`): every mode that is not
caught by an `isSaga3*` predicate lands there. Concretely `v2`, `v3`, and
`saga2` all reach `new Saga2Engine(...)`. `DEFAULT_ORCHESTRATION_MODE === 'v2'`
is what makes Saga 2 the default today.

### 0.2 Composition root — `src/app/composition-root.ts`

`selectEngine` (lines 201–358) is a four-branch cascade plus a Saga2 fall-through:

1. **L209** `if (isSaga3LifecycleMode(...))` → `createProductLifecycleRuntime(...)` (the target engine).
2. **L234** `if (isSaga3DiscoveryGenericMode(...))` → `buildDiscoveryGenericEngine(...)`.
3. **L250** `if (isSaga3DiscoveryMode(...))` → legacy `Saga3DiscoveryEngine` adapter.
4. **L320** `if (isSaga3FormalizationMode(...))` → `Saga3FormalizationEngine`.
5. **L349–357** fall-through → `new Saga2Engine(...)` for everything else (`v2`/`v3`/`saga2`).

`createSaga2Application` (L134–179) is the **only** public factory that calls
`selectEngine`. It is consumed by:
- `src/orchestrate-cli.ts:143` — the CLI host.
- `tools/discovery-run.mjs:318` — a dev/diagnostic harness (forces `saga3-discovery-generic`).
- `tests/architecture/saga2-boundaries.test.mjs:690` — the fall-through test.

`createSagaControlApplication` (L113–126) is tracker-view's control-plane
factory; it does **not** select an engine and is unaffected by the mode.

### 0.3 CLI host — `src/orchestrate-cli.ts`

`loadCompositionOverrides` (L191–257) reads `process.env.SAGA_ORCHESTRATION_MODE`
directly (L195) and branches:
- L197: `=== 'saga3-discovery-generic'` → install discovery packages.
- L206: `!== 'saga3-lifecycle'` → return `{}` (no lifecycle overrides needed).
- else (lifecycle): require `SAGA_PRODUCT_LIFECYCLE_COMPOSITION`, install production modules.

`main()` (L112–168) then calls `createSaga2Application(process.env, overrides)`
unconditionally at L143.

### 0.4 Runtime env-var reads of `SAGA_ORCHESTRATION_MODE`

| Site | File:line | Read via | Purpose |
|---|---|---|---|
| 1 | `src/runtime/saga-runtime-config.ts:49` | `parseOrchestrationMode(env.SAGA_ORCHESTRATION_MODE)` | the canonical config parse |
| 2 | `src/orchestrate-cli.ts:195` | `process.env.SAGA_ORCHESTRATION_MODE` (raw) | choosing composition overrides |
| 3 | `src/infrastructure/engine/legacy-engine-administration.ts:91` | `SAGA_ORCHESTRATION_MODE: this.config.orchestrationMode` | propagating config into the spawned CLI env |
| 4 | `tracker-view/tracker-view.mjs:4372` | `runtimeConfig.orchestrationMode` (via `loadSagaRuntimeConfig`) | the `requiresBackgroundEngine` spawn gate |
| 5 | `tracker-view/tracker-view.mjs:4336` | `runtimeConfig.orchestrationMode` via `isSaga3DiscoveryMode` | suppress legacy kickstart task in discovery mode |

**Worker/server code does NOT read the mode at runtime.** `Saga2Engine`,
`Saga3DiscoveryEngine`, and `Saga3FormalizationEngine` never inspect
`config.orchestrationMode` (verified: `Saga2Engine` reads only `claudePath`,
`dbPath`, `lmStudioUrl` from its config). The mode is purely a composition-time
+ spawn-time concern.

### 0.5 Tracker-view runtime use (the only other live consumer)

`tracker-view.mjs` imports `requiresBackgroundEngine` and
`isSaga3DiscoveryMode` from the compiled `orchestration-mode.js` (L32):
- L4336: if discovery mode, skip creating the legacy `discovery.kickstart` task.
- L4379: if `requiresBackgroundEngine(mode)`, spawn the background CLI.

Both become **trivially true** once the default is `saga3-lifecycle` (lifecycle
requires a background engine, and is not a discovery mode).

---

## 1. Goal of Phase 2

Make `createProductLifecycleRuntime` the **only** engine the composition root
ever returns, and make `saga3-lifecycle` the **unconditional default** — while:

- Keeping `createSaga2Application` compilable and callable (tests, `tools/discovery-run.mjs`).
- Keeping the legacy `Saga2Engine` / `Saga3DiscoveryEngine` / `Saga3FormalizationEngine` classes importable and directly constructible by tests (dozens of `tests/saga3/*.test.mjs` build them by hand).
- Keeping `parseOrchestrationMode` reject-on-unknown semantics (no silent engine switch).

This is a **selection** cutover, not a deletion of engine classes. The dead
branches are removed from the composition root; the engine implementations
themselves stay until a later cleanup phase.

---

## 2. Surgical edit specification

### 2.1 `src/runtime/orchestration-mode.ts`

**Intent:** collapse the union to lifecycle + its historical discovery/formalization
ancestors that are still constructible in tests; make lifecycle the default;
make the lifecycle predicate trivially-true; delete the Saga2-bearing modes
(`v2`/`v3`/`saga2`).

**BEFORE (current):**

```ts
// 50–57
export type OrchestrationMode =
  | 'v2'
  | 'v3'
  | 'saga2'
  | 'saga3-discovery'
  | 'saga3-discovery-generic'
  | 'saga3-formalization'
  | 'saga3-lifecycle';

// 59–62
export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  'v2', 'v3', 'saga2', 'saga3-discovery', 'saga3-discovery-generic',
  'saga3-formalization', 'saga3-lifecycle',
];

// 64–65
/** The stable default. Never an experimental engine (see header). */
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'v2';

// 94–96
export function requiresBackgroundEngine(mode: OrchestrationMode): boolean {
  return mode !== 'v2';
}
```

**AFTER (target):**

```ts
export type OrchestrationMode =
  | 'saga3-discovery'
  | 'saga3-discovery-generic'
  | 'saga3-formalization'
  | 'saga3-lifecycle';

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  'saga3-discovery', 'saga3-discovery-generic',
  'saga3-formalization', 'saga3-lifecycle',
];

/**
 * The unconditional default. After the Phase 2 cutover every recognised mode
 * runs a background engine; saga3-lifecycle is the complete durable lifecycle.
 * Legacy 'v2'/'v3'/'saga2' were removed because they selected Saga2Engine,
 * which is no longer reachable from the composition root.
 */
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'saga3-lifecycle';

/**
 * Every retained mode spawns a background orchestrate-cli engine process.
 * The 'v2' exception is gone (v2 no longer exists). Kept as a function (not a
 * constant) so tracker-view's import surface and the spawn gate stay stable.
 */
export function requiresBackgroundEngine(_mode: OrchestrationMode): boolean {
  return true;
}
```

**Predicates to delete entirely (their sole caller, the composition-root branch, is removed in §2.2):**

- `isSaga3DiscoveryMode` (L107–109) — DELETE.
- `isSaga3DiscoveryGenericMode` (L116–118) — DELETE.
- `isSaga3FormalizationMode` (L126–128) — DELETE.

> ⚠ `tracker-view.mjs:4336` imports `isSaga3DiscoveryMode`. That import must be
> resolved in §2.4 (the legacy kickstart suppression either becomes unconditional
> skip, or the predicate is retained as a 1-line helper — see §2.4).

**Predicate to make trivially true:**

```ts
// 130–133
/** Does this mode select the complete durable Product Lifecycle? */
export function isSaga3LifecycleMode(mode: OrchestrationMode): boolean {
  return mode === 'saga3-lifecycle';
}
```

→ becomes:

```ts
/**
 * The composition root always builds the Product Lifecycle runtime now. Kept as
 * a named predicate so the composition-root call site stays self-documenting.
 */
export function isSaga3LifecycleMode(_mode: OrchestrationMode): boolean {
  return true;
}
```

**Header comment (L1–49):** rewrite the prose so it no longer claims "the
default remains the stable Saga 2 mode". Replace the `'v2'`/`'v3'`/`'saga2'`
doc bullets with a short cutover note. The `parseOrchestrationMode` function
(L74–83) needs **no body change** — it still throws on unknown values, which is
exactly the guard we want; only its error-message wording updates implicitly via
the shorter `ORCHESTRATION_MODES` list.

---

### 2.2 `src/app/composition-root.ts` — collapse `selectEngine`

**Intent:** `selectEngine` returns `createProductLifecycleRuntime(...)` and
nothing else. The discovery / discovery-generic / formalization / saga2 branches
are removed. The function shrinks to the lifecycle path plus its dependency
guard.

**BEFORE (current), `selectEngine` body L201–358:**

```ts
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
  productLifecycle: ProductLifecycleCompositionOverrides | undefined,
  modulePackages: ProductionInstallation | undefined,
): OrchestrationEngine {
  if (isSaga3LifecycleMode(config.orchestrationMode)) {
    if (!productLifecycle) {
      throw new Error(
        'SAGA3_LIFECYCLE_DEPENDENCIES_REQUIRED: createSaga2Application '
        + 'must receive overrides.productLifecycle with explicit Delivery '
        + 'preflight/publication/observation providers',
      );
    }
    return createProductLifecycleRuntime({
      ...productLifecycle,
      workerExecutorFactory,
      resolveWorkerContext: context =>
        buildDiscoveryWorkerContext(config, persistence, host, context),
    }).engine;
  }

  if (isSaga3DiscoveryGenericMode(config.orchestrationMode)) { /* ... L234-248 ... */ }
  if (isSaga3DiscoveryMode(config.orchestrationMode)) { /* ... L250-312 ... */ }
  if (isSaga3FormalizationMode(config.orchestrationMode)) { /* ... L320-348 ... */ }
  return new Saga2Engine({ config, workerExecutorFactory, persistence, host });
}
```

**AFTER (target):**

```ts
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
  productLifecycle: ProductLifecycleCompositionOverrides | undefined,
  _modulePackages: ProductionInstallation | undefined,
): OrchestrationEngine {
  // Phase 2 cutover: the Product Lifecycle runtime is the sole engine. The
  // discovery / discovery-generic / formalization / saga2 branches were removed
  // — they are reachable only by direct engine construction in tests now.
  if (!productLifecycle) {
    throw new Error(
      'PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED: createSaga2Application '
      + 'must receive overrides.productLifecycle with explicit Delivery '
      + 'preflight/publication/observation providers. After the saga4 cutover '
      + 'the lifecycle runtime is the only engine; SAGA_PRODUCT_LIFECYCLE_COMPOSITION '
      + 'must be set (see orchestrate-cli.ts).',
    );
  }
  return createProductLifecycleRuntime({
    ...productLifecycle,
    workerExecutorFactory,
    resolveWorkerContext: context =>
      buildDiscoveryWorkerContext(config, persistence, host, context),
  }).engine;
}
```

**Supporting deletions in the same file:**

- **L234–248** (`isSaga3DiscoveryGenericMode` branch + `buildDiscoveryGenericEngine` call) — DELETE.
- **L250–312** (`isSaga3DiscoveryMode` branch constructing `Saga3DiscoveryEngine` + `ProcessModuleRuntimeEngine`) — DELETE.
- **L320–348** (`isSaga3FormalizationMode` branch constructing `Saga3FormalizationEngine`) — DELETE.
- **L349–357** (`return new Saga2Engine(...)`) — DELETE.
- **L370–486** `buildDiscoveryGenericEngine` helper — DELETE (no remaining caller).
- Imports that become unused: `Saga2Engine` (L18), `Saga3DiscoveryEngine` (L19), `SqliteSaga3DiscoveryRuntime` (L20, still used by `buildDiscoveryGenericEngine` only — verify), the discovery services (L21–24), `isSaga3DiscoveryMode`/`isSaga3DiscoveryGenericMode`/`isSaga3FormalizationMode` from the L40–45 import block, `Saga3FormalizationEngine` (L55), and the generic-flow helpers (L66–68, L410 etc.) — remove only those the compiler flags as unused after the branch deletions. **Keep** `createProductLifecycleRuntime`, `isSaga3LifecycleMode`, `buildDiscoveryWorkerContext`, `ProcessModuleRuntimeEngine`-independent helpers.
- The doc-comment block L181–200 ("Selects the concrete orchestration engine…") — rewrite to state the lifecycle runtime is unconditional.

> The `selectEngine` signature keeps `modulePackages` (now `_modulePackages`) so
> `createSaga2Application`'s call site (L161–168) is unchanged; only its body
> changes. This minimises diff surface.

**`createSaga2Application` (L134–179):** **no structural change.** It still
exists, still calls `selectEngine`. The factory name is retained as a
backward-compat name; tests and `tools/discovery-run.mjs` keep compiling.

---

### 2.3 `src/orchestrate-cli.ts` — lifecycle overrides become unconditional

**Intent:** the CLI is the lifecycle entrypoint. The raw `process.env` mode
comparisons collapse because the only valid mode is now lifecycle.

**BEFORE (current), `loadCompositionOverrides` L191–257:**

```ts
async function loadCompositionOverrides(projectId, epicId): Promise<Saga2CompositionOverrides> {
  const orchestrationMode = process.env.SAGA_ORCHESTRATION_MODE;
  const repoRoot = path.resolve(process.env.SAGA_REPO_ROOT ?? process.cwd());
  if (orchestrationMode === 'saga3-discovery-generic') {
    const modulePackages = await installModulePackages(/* discovery only */);
    return { modulePackages };
  }
  if (orchestrationMode !== 'saga3-lifecycle') return {};
  // ... require SAGA_PRODUCT_LIFECYCLE_COMPOSITION, installProductionModules ...
  return { modulePackages: packageInstallation, productLifecycle: { ...productLifecycle, packageInstallation } };
}
```

**AFTER (target):**

```ts
async function loadCompositionOverrides(projectId, epicId): Promise<Saga2CompositionOverrides> {
  // Phase 2 cutover: the CLI always runs the Product Lifecycle runtime.
  // SAGA_PRODUCT_LIFECYCLE_COMPOSITION is mandatory.
  const repoRoot = path.resolve(process.env.SAGA_REPO_ROOT ?? process.cwd());

  const configuredPath = process.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION;
  if (!configuredPath) {
    throw new Error(
      'SAGA_PRODUCT_LIFECYCLE_COMPOSITION_REQUIRED: the lifecycle runtime is '
      + 'the only engine; an explicit ESM module supplying real Delivery '
      + 'preflight, publication and observation providers is mandatory',
    );
  }
  const absolutePath = path.resolve(configuredPath);
  const loaded = await import(pathToFileURL(absolutePath).href) as ProductLifecycleCompositionModule;
  const exported = loaded.createProductLifecycleComposition ?? loaded.default;
  if (!exported) {
    throw new Error(`PRODUCT_LIFECYCLE_COMPOSITION_EXPORT_MISSING: ${absolutePath}`);
  }
  const context = { env: process.env, cwd: process.cwd(), projectId, epicId };
  const productLifecycle = typeof exported === 'function' ? await exported(context) : exported;
  if (!productLifecycle?.delivery) {
    throw new Error(`PRODUCT_LIFECYCLE_DELIVERY_COMPOSITION_MISSING: ${absolutePath}`);
  }

  const packageInstallation = await installProductionModules(
    getDb(), repoRoot, process.env.SAGA_PACKAGE_STORE_DIR,
  );
  return {
    modulePackages: packageInstallation,
    productLifecycle: { ...productLifecycle, packageInstallation },
  };
}
```

**Collateral edits in this file:**
- L195 `const orchestrationMode = process.env.SAGA_ORCHESTRATION_MODE;` — DELETE (no longer read here).
- L197–205 (`saga3-discovery-generic` branch) — DELETE.
- L206 (`if (orchestrationMode !== 'saga3-lifecycle') return {};`) — DELETE.
- L78–80 help-text: replace the "For SAGA_ORCHESTRATION_MODE=saga3-lifecycle…" sentence with "SAGA_PRODUCT_LIFECYCLE_COMPOSITION is required (lifecycle is the only engine)."
- The `import { installModulePackages }` / `discoveryPackageManifest` imports (L29–32) become unused if `buildDiscoveryGenericEngine` is the only other consumer — but `installModulePackages` is still used by `tools/discovery-run.mjs` directly; in *this* file drop them only if the compiler reports them unused after the branch removal. (`installProductionModules` is retained.)

---

### 2.4 `tracker-view/tracker-view.mjs` — resolve the deleted predicates

**L32 import:** currently
```js
import { requiresBackgroundEngine, isSaga3DiscoveryMode } from '../dist/runtime/orchestration-mode.js';
```
After §2.1, `isSaga3DiscoveryMode` is deleted. Two options; **Option A is recommended** (smaller blast radius):

- **Option A (recommended): keep `isSaga3DiscoveryMode` as a retained 1-line helper in `orchestration-mode.ts`** (`return mode === 'saga3-discovery' || mode === 'saga3-discovery-generic';`). It has no composition-root caller but tracker-view and the boundary test still reference it. Document it as "legacy discovery-mode detection for the kickstart-task suppression; retained for the tracker-view spawn path". This avoids editing tracker-view at all.

- Option B: delete the predicate and edit `tracker-view.mjs:4336` to read the mode set inline. Larger diff, touches the frontend; not recommended for Phase 2.

**L4379 spawn gate:** `if (requiresBackgroundEngine(mode))` — now always true, but **leave the call as-is**. The function still exists (returns `true`), so tracker-view's logic is correct and its import is stable. No edit.

---

## 3. Test impact and minimal fixes

The affected tests are exclusively in
`tests/architecture/saga2-boundaries.test.mjs`. **All other test files
(`tests/saga3/*`, `tests/process-modules/*`, `tests/execution/*`,
`tests/characterization/*`) construct engines directly** (`new Saga3DiscoveryEngine(...)`,
`createProductLifecycleRuntime(...)`, `LifecycleOrchestrator`, etc.) and do not
route through the composition root or the mode parser, so they are unaffected.

### 3.1 Tests that assert the OLD default/mode behaviour

| Test | File:line | Current assertion | Minimal fix |
|---|---|---|---|
| `runtime config defaults orchestration mode to the stable v2 mode` | saga2-boundaries.test.mjs:447–456 | `config.orchestrationMode === 'v2'` | Flip the expectation to `'saga3-lifecycle'` and update the test name/comment to "defaults to the lifecycle engine". |
| `orchestration mode parser rejects unknown values instead of silent fallback` | saga2-boundaries.test.mjs:458–486 | parse table includes `[undefined,'v2']`, `['','v2']`, `['v2','v2']`, `['v3','v3']`, `['saga2','saga2']`; `requiresBackgroundEngine('v2')===false` | (a) Change `[undefined,'v2']`/`['','v2']`/`['v2','v2']` rows to expect `'saga3-lifecycle'`. (b) Delete the `['v3','v3']`, `['saga2','saga2']`, `['saga3-discovery',…]` rows OR keep the discovery/formalization rows that remain valid. (c) Delete the `requiresBackgroundEngine('v2')===false`, `('v3')`, `('saga2')`, `('saga3-discovery')`, `('saga3-lifecycle')` lines and replace with a single `assert.equal(requiresBackgroundEngine('saga3-lifecycle'), true)`. (d) Add `assert.throws(() => parseOrchestrationMode('v2'), /Unknown SAGA_ORCHESTRATION_MODE/)` to lock the cutover (v2 is now unknown). |
| `runtime config preserves Saga 2 defaults and environment precedence` | saga2-boundaries.test.mjs:46–76 | passes `SAGA_ORCHESTRATION_MODE:'v3'`, expects `orchestrationMode:'v3'` | Change env to `SAGA_ORCHESTRATION_MODE:'saga3-lifecycle'` and expected to `'saga3-lifecycle'` (or `saga3-discovery`), since `'v3'` is no longer a valid mode. |
| `engine spawn propagates config.orchestrationMode (no hardcoded mode)` | saga2-boundaries.test.mjs:406–445 | loops `for (const mode of ['v3','saga3-discovery'])` | Change the loop to `['saga3-discovery', 'saga3-lifecycle']` (both still-valid modes). The "no hardcoded v3" comment is still accurate in spirit. |
| `legacy engine administration preserves start/status/...` | saga2-boundaries.test.mjs:327–404 | `fullConfig({ orchestrationMode:'v3' })`, asserts `spawned[0].options.env.SAGA_ORCHESTRATION_MODE === 'v3'` | Change `'v3'` → `'saga3-discovery'` (or `'saga3-lifecycle'`) in both the config and the assertion. The spawn-propagation behaviour under test is unchanged. |

### 3.2 Tests that assert composition-root SOURCE STRUCTURE (will break after §2.2)

| Test | File:line | Current assertion | Minimal fix |
|---|---|---|---|
| `composition root selects engine by orchestration mode without branching infrastructure` | saga2-boundaries.test.mjs:542–566 | `assert.match(compositionSrc, /isSaga3DiscoveryMode/)`, `/Saga3DiscoveryEngine/`, `/Saga2Engine/`; `new Saga3DiscoveryEngine` count === 1; no second board reader | This test encodes the OLD multi-branch structure. After §2.2 none of these strings exist in `composition-root.ts`. **Replace the whole test body** with a structural assertion of the new single-engine shape: `assert.match(compositionSrc, /createProductLifecycleRuntime/)`, `assert.doesNotMatch(compositionSrc, /new Saga2Engine/)`, `assert.doesNotMatch(compositionSrc, /Saga3DiscoveryEngine/)`, and keep the "no second board reader" negative assertion (still true). Rename the test to `composition root selects the lifecycle engine unconditionally`. |
| `composition root falls through to Saga 2 engine for non-saga3 modes` | saga2-boundaries.test.mjs:682–715 | calls `createSaga2Application({SAGA_ORCHESTRATION_MODE:'saga2'}, {config: fullConfig({orchestrationMode:'saga2'}), ...})` and asserts Saga2Engine duplicate-lock behaviour (`PID 999`) | This test verifies a code path that no longer exists (no Saga2Engine fall-through). **Delete the test.** Its intent ("selectEngine routes correctly") is now vacuous — there is only one engine. Alternatively, replace it with a test that `createSaga2Application` without `productLifecycle` throws `PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED`. |

### 3.3 Tests that are UNAFFECTED (verified, no edit needed)

- `Saga2Engine owns the pump and consumes only injected runtime ports` (L78–120) — constructs `new Saga2Engine(...)` directly; the class is retained.
- `composition root selects the engine through the real wiring, not a source regex (saga3-discovery)` (L627–680) — constructs `new Saga3DiscoveryEngine(...)` directly and injects it via the low-level `createSagaApplication` factory (not `createSaga2Application`). The class is retained; the test bypasses `selectEngine`. **Unaffected.**
- All `tests/saga3/*.test.mjs` — direct engine construction.
- All `tests/process-modules/*.test.mjs` (incl. `lifecycle-orchestrator`, `product-lifecycle-composition`) — direct `createProductLifecycleRuntime` / `LifecycleOrchestrator` construction.
- `tests/architecture/dependency-direction.test.mjs` — its Rule-6 `compositionCutover` allowlist (L87, L240–251) is already empty after W13-A6; removing `selectEngine` branches does not add or remove import edges (the lifecycle runtime's imports were already sourced from `src/app/`). **Unaffected**, but re-run to confirm R6 stays at 0.
- `tests/characterization/saga2-runtime-contracts.test.mjs:95` — scans `src/engines/saga2-engine.ts` source, which is retained.

### 3.4 Non-test caller that needs a one-line fix

`tools/discovery-run.mjs:300` sets `process.env.SAGA_ORCHESTRATION_MODE = 'saga3-discovery-generic'` and L318 calls `createSaga2Application(process.env, { modulePackages })`. After §2.2, `createSaga2Application` will throw `PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED` because no `productLifecycle` override is supplied. **Fix:** either (a) retire the `discovery-run.mjs` harness (its purpose — proving the generic discovery composition — is complete), or (b) update it to construct the discovery engine directly via `buildDiscoveryGenericEngine`'s equivalent (the helper is deleted, so this means inlining the generic-flow build, which defeats the harness). **Recommended: retire `tools/discovery-run.mjs`** or mark it `skip`-on-cutover. This is a dev tool, not a shipped surface.

---

## 4. Risk register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | `tools/discovery-run.mjs` calls `createSaga2Application` without `productLifecycle` → runtime throw. | **Certain** after §2.2. | §3.4: retire or skip the harness. |
| R2 | A test or operator sets `SAGA_ORCHESTRATION_MODE=v2`/`v3`/`saga2` expecting Saga2Engine. | Medium — `parseOrchestrationMode` will now **throw** (`Unknown SAGA_ORCHESTRATION_MODE`), which is the desired fail-loud behaviour, but it is a breaking change for any `.env`/CI that hardcodes `v2`. | Grep ops configs; the fail-loud throw is the correct signal. Document in the cutover changelog that `v2`/`v3`/`saga2` are removed. |
| R3 | Tracker-view `isSaga3DiscoveryMode` import breaks if the predicate is deleted. | **Certain** if Option B (§2.4) is chosen. | §2.4 Option A: retain the predicate. |
| R4 | `createSaga2Application` no longer returns Saga2Engine, surprising any non-test caller. | Low — the only callers are orchestrate-cli.ts (now lifecycle), tools/discovery-run.mjs (R1), and one test (§3.2). | The factory name is retained for compile compat; its semantics change is the entire point of Phase 2. |
| R5 | `Saga2Engine` / `Saga3DiscoveryEngine` / `Saga3FormalizationEngine` classes become unreferenced by src (only tests import them). | Expected — these are the "dead branches". | Do NOT delete the classes in Phase 2. Leave for a later cleanup phase so the dozens of direct-construction tests keep passing. |
| R6 | `requiresBackgroundEngine` always-true may let tracker-view spawn a CLI for a hypothetical future non-background mode. | None in Phase 2 — only lifecycle remains. | The function stays as a stable seam; revisit if a no-background mode is reintroduced. |
| R7 | `selectEngine`'s `modulePackages` param becomes `_modulePackages` (unused). | Cosmetic. | Prefix with `_` to satisfy linters; keep the param so the call site is unchanged. |

---

## 5. Execution checklist (for the phase that applies these edits)

1. Edit `src/runtime/orchestration-mode.ts` (§2.1): flip default, shrink union, trivialise `isSaga3LifecycleMode`, retain `isSaga3DiscoveryMode` (Option A), delete the other two discovery/formalization predicates *only if* their composition-root branches are also deleted in the same change.
2. Edit `src/app/composition-root.ts` (§2.2): collapse `selectEngine`, delete the four dead branches and `buildDiscoveryGenericEngine`, prune unused imports via compiler errors.
3. Edit `src/orchestrate-cli.ts` (§2.3): make lifecycle overrides unconditional.
4. Leave `tracker-view/tracker-view.mjs` untouched (Option A keeps its imports valid).
5. Update `tests/architecture/saga2-boundaries.test.mjs` per §3.1 and §3.2.
6. Retire/skip `tools/discovery-run.mjs` (§3.4).
7. `tsc --noEmit` + run the full `node --test` suite; confirm `dependency-direction` R6 stays 0.

---

## 6. Files touched (summary)

**Source (edited):**
- `src/runtime/orchestration-mode.ts`
- `src/app/composition-root.ts`
- `src/orchestrate-cli.ts`

**Source (untouched, Option A):**
- `tracker-view/tracker-view.mjs`
- `src/infrastructure/engine/legacy-engine-administration.ts` (still propagates `config.orchestrationMode` into the spawn env — correct, unchanged)
- `src/runtime/saga-runtime-config.ts` (no body change; the config field type narrows via the union)

**Tests (edited):**
- `tests/architecture/saga2-boundaries.test.mjs` (§3.1, §3.2)

**Tools (retired/skipped):**
- `tools/discovery-run.mjs`

**Engine classes retained (deleted only in a later phase):**
- `src/engines/saga2-engine.ts`
- `src/engines/saga3-discovery-engine.ts`
- `src/engines/saga3-formalization-engine.ts`
