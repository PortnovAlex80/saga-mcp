# Wave 10 — Arbitrary Extensibility Proof & Authoring Kits Frozen Spec

> Frozen on `98c127f` (Wave 9 partial checkpoint). Plan §0.13 / Phase 12.

## 0. Objective (§0.13.10 serial gate)
Marketing, SEO/Analytics, Director Approval, and Campaign install and execute WITHOUT any Runtime, global runner, gateway, catalog, or existing-module source change. This is the DEFINITIVE proof that the architecture is truly extensible — not just claimed to be.

## 1. Lanes (8)

| Lane | Owns |
|---|---|
| **W10-A1** | LM Marketing package (`modules-ext/lm-marketing/`): manifest, NodeProtocols, resources, skills, templates. A self-contained LM module proving arbitrary LM extensibility. |
| **W10-A2** | External SEO/Analytics package (`modules-ext/external-seo/`): manifest, NodeProtocols, resources. Proving arbitrary External-node extensibility. |
| **W10-A3** | Human Director Approval package (`modules-ext/human-director-approval/`): manifest, NodeProtocols, resources. Proving arbitrary Human-node extensibility. |
| **W10-A4** | Campaign Lifecycle Scenario (`scenarios-ext/campaign/`): LifecycleScenarioManifest composing the 3 packages above. Proving arbitrary scenario extensibility. |
| **W10-A5** | Module Authoring Kit (`tools/module-authoring-kit/`): package templates, fixtures, module validator CLI, contract tests. |
| **W10-A6** | Scenario Authoring Kit (`tools/scenario-authoring-kit/`): scenario templates, scenario validator CLI. |
| **W10-A7** | Describe interfaces (`application/package-describe.ts`): read-only describe commands for agents/operators. Generated architecture views from manifests. |
| **W10-A8** | Tests: genericity, repeated-module, conditional-route, restart, recovery, no-Runtime-diff proof. The DEFINITIVE exit-gate proof. |

## 2. Exit gate (§0.13.10)
1. Marketing, SEO, Director Approval install + execute without Runtime/runner/gateway/catalog/existing-module change.
2. Campaign scenario composes them without Runtime change.
3. Module Authoring Kit produces a validatable package.
4. Scenario Authoring Kit produces a validatable scenario.
5. Describe interfaces expose package/scenario architecture from manifests.
6. Ratchet green. Wave 0-9 regression green.

## 3. Anti-scope
- NO edits to `src/` (all new packages live under `modules-ext/` and `scenarios-ext/` at repo root, outside the compiled tree).
- NO edits to existing modules (Discovery/Formalization/Development/Delivery).
- NO composition root changes (Wave 11).
- The proof is that `npm run build` + `node --test` shows ZERO diffs in `src/` while the new packages install and execute.

## 4. Key design
- W0-A7 synthetic fixtures (`tests/fixtures/synthetic-modules/`, `tests/fixtures/synthetic-scenarios/campaign/`) are the SEED for these packages — W10-A1/A2/A3/A4 upgrade them from fixtures to full installable packages with real NodeProtocols, resources, and manifests.
- The `modules-ext/` prefix (not `modules/`) signals these are NOT built-in — they prove the architecture accepts ARBITRARY packages, not just the 4 production ones.
- The proof test (W10-A8) asserts the import list: it imports ONLY from `installation/`, `domain/spi/`, `application/` services — NEVER from `src/index.ts`, `modules/catalog.ts`, `tracker-view/`, or any existing module. The import list IS the §0.13.10 proof.
