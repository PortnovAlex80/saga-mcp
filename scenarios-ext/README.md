# scenarios-ext/ — Third-party Lifecycle Scenario packages

Wave 10 extensibility surface (spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`).

This directory holds **installable third-party `LifecycleScenarioManifest` packages** — the proof that the architecture accepts ARBITRARY scenarios, not just the built-in product-delivery lifecycle. The `scenarios-ext/` prefix (not `scenarios/`) signals these are NOT built-in.

Each subdirectory is a self-contained scenario package:

```
scenarios-ext/<name>/
├── definition.mjs     <- LifecycleScenarioManifest builder (source of truth)
├── manifest.json      <- canonical rendering (read by the Wave 7 installer)
└── ...                <- resources (schemas, skills, templates)
```

## Packages

| Package | Lane | Composes |
|---|---|---|
| [`campaign/`](./campaign/) | W10-A4 | `lm-marketing` + `external-seo` (x3) + `human-director-approval` |

## Anti-scope (spec §3)

- NO package here is imported by `src/`, `modules/`, the catalog, or any composition root.
- NO edit to `src/` is required to install or validate any package here.
- The proof is that `npm run build` + `node --test` shows ZERO diffs in `src/` while these packages install and validate.

Sibling module packages live under `modules-ext/` (W10-A1/A2/A3).
