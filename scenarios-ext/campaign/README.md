# Campaign Lifecycle Scenario (W10-A4)

Wave 10, Lane A4 — `refactor/w10-a4`.
Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md` (Lane W10-A4, §2 exit gate #2, §4 key design). Plan ref: §0.13.4, §0.13.10 serial gate.

This is the **definitive proof of arbitrary scenario extensibility** (plan §0.13.10): a third-party [`LifecycleScenarioManifest`](../../src/process-modules/domain/spi/scenario-manifest.ts) that composes the three sibling-wave external module packages and installs + validates **without any Runtime, global runner, gateway, catalog, or existing-module source change** (spec §3 anti-scope).

It **upgrades** the W0-A7 synthetic fixture (`tests/fixtures/synthetic-scenarios/campaign/`) from a `LifecycleDefinition`-shaped plain object into a real, installable `LifecycleScenarioManifest` (the W1-A3 aggregate).

## Composition

The scenario composes exactly the three sibling-wave packages and reuses `external-seo` in **three** stages — the strongest possible proof of plan §6.8 (the same module package participates in multiple stages with different mappings; the Runtime must NOT derive a stage from module kind or task-kind prefix):

```
draft (LM marketing)         -> 'campaign-drafted'
   |
seo-baseline (External seo)  -> 'ranking-fetched'   [REUSE #1 of seo]
   |
metrics (External seo)       -> 'ranking-fetched'   [REUSE #2 of seo]
   |
seo-followup (External seo)  -> 'ranking-fetched'   [REUSE #3 of seo]
   |
approve (Human director)     -> 'approved' | 'rejected'
```

| Stage | Module selector | Outcome(s) | Routes to |
|---|---|---|---|
| `draft` | `lm-marketing@^1.0.0` | `campaign-drafted` | stage `seo-baseline` |
| `seo-baseline` | `external-seo@^1.0.0` | `ranking-fetched` | stage `metrics` |
| `metrics` | `external-seo@^1.0.0` | `ranking-fetched` | stage `seo-followup` |
| `seo-followup` | `external-seo@^1.0.0` | `ranking-fetched` | stage `approve` |
| `approve` | `human-director-approval@^1.0.0` | `approved` / `rejected` | terminal `campaign-approved` / `campaign-rejected` |

`requiredModuleSelectors` declares exactly three contracts — `lm-marketing`, `external-seo`, `human-director-approval`. The scenario depends on **no built-in module**.

## Proof points baked in

1. **§6.4 — No `routeResolver`.** Routes are declarative static `outcomeRoutes` only. There is no executable closure anywhere in the manifest.
2. **§6.8 — `external-seo` reused in 3 stages** with three different input/output mappings.
3. **§6.3.5 / §6.9.3 — Complete deterministic route table** for every declared module outcome. The Human stage's two outcomes route to two distinct terminal statuses.
4. **§6.3.3 / §6.9.5 — Safe own-property mappings** only (root input paths, prior-stage output paths, `{ literal }`, `{ runtime: 'initiatedBy' }`). No executable expression language.
5. **§6.2.9 — Explicit terminal statuses** (`campaign-approved`, `campaign-rejected`).

## Package contents

```
scenarios-ext/campaign/
├── definition.mjs                          <- LifecycleScenarioManifest builder (this package's source of truth)
├── manifest.json                           <- canonical rendering of the manifest (read by the Wave 7 installer)
├── README.md                               <- this file
└── schemas/
    ├── campaign-input.schema.json          <- scenario root input contract (campaign.input.v1)
    └── campaign-output.schema.json         <- scenario terminal output contract (campaign.output.v1)
```

## Anti-scope (spec §3)

- This package lives under `scenarios-ext/` at repo root, **outside** the compiled `src/` tree.
- It imports **nothing** from `src/`, `modules/`, the catalog, or the composition root — the import list IS the §0.13.10 proof.
- `npm run build` produces **zero** diffs in `src/` while this package installs and validates.

## Validation

The manifest passes `validateLifecycleScenarioManifest` and round-trips byte-identically through canonical JSON. See `tests/extensibility/w10-a4-campaign-scenario.test.mjs` for the proof test.
