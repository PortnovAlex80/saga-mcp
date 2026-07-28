# W0-A7 Synthetic Fixtures

Wave 0, Lane A7 — `refactor/w0-a7`. Plan ref: §0.3.8, §14.1.4, §15.11.

This directory ships **data-only** synthetic Process Module and Lifecycle
Scenario fixtures. They are the proof target for the entire refactor — Wave 1's
exit gate is "two unrelated synthetic packages validate using the same SPI"
(plan §0.4.11), and Wave 10's gate is "Marketing, SEO/Analytics, Director
Approval, and Campaign install and execute without any Runtime change"
(plan §0.13.10).

## What is here

```
tests/fixtures/
├── synthetic-modules/
│   ├── README.md                          <- this file
│   ├── index.test.mjs                     <- smoke test (passes today)
│   ├── lm-marketing/
│   │   ├── definition.mjs                 <- LM-node module (ProcessModuleDefinition-shaped)
│   │   ├── manifest.json                  <- data-only rendering (Wave 1 round-trip target)
│   │   ├── skills/synthetic-marketing-skill.md
│   │   └── templates/{campaign-draft-template,campaign-draft-tracker}.md
│   ├── kernel-analytics/
│   │   ├── definition.mjs                 <- Kernel-node module
│   │   ├── manifest.json
│   │   └── schemas/analytics-input.schema.json
│   ├── human-director-approval/
│   │   ├── definition.mjs                 <- Human-node module (2 outcomes)
│   │   ├── manifest.json
│   │   └── schemas/director-signoff.schema.json
│   └── external-seo/
│       ├── definition.mjs                 <- External-node module (REUSED in scenario)
│       ├── manifest.json
│       └── schemas/seo-input.schema.json
└── synthetic-scenarios/
    └── campaign/
        ├── definition.mjs                 <- LifecycleDefinition-shaped (5 stages)
        └── manifest.json                  <- data-only rendering
```

## Module fixtures — boundary per fixture

Every module fixture is a **`ProcessModuleDefinition`-shaped** plain object
(type imported via JSDoc from `src/process-modules/domain/process-module.ts`).
They share a uniform contract regardless of node kind — that uniformity is the
proof that the Runtime is module-kind-agnostic (plan §3.6, §7.2).

### `lm-marketing` — LM node

- **Exercises:** LM node kind (`kind: 'lm'` + `executionProfile` reference),
  one `ExecutionProfileDefinition` with relative `semanticSkill`,
  `trackerTemplate`, allowedTools, retry/recovery policy, one outcome
  (`campaign-drafted`), module-relative resource index.
- **Deliberately omits:** No real LM driver, no real prompt, no DB, no
  filesystem side effects. The skill/template/tracker files are placeholder
  content for resource-resolution proofs only.
- **Exit gate depending on it:** Wave 1 SPI (manifest validation, canonical
  JSON round-trip), Wave 2 installation (resource resolver, profile binding),
  Wave 5 workspace/tracker/skill projection, Wave 10 LM Marketing production
  package.

### `kernel-analytics` — Kernel node

- **Exercises:** Kernel node kind (`kind: 'kernel'` + `handler` reference),
  exact versioned handler ref `analytics-compute-handler@1.0.0`, one outcome
  (`metrics-computed`), `authority: 'kernel'` artifact, a `test`-enforced
  invariant.
- **Deliberately omits:** No real handler code, no DB, no in-process compute.
  The handler is a *reference string* only.
- **Exit gate depending on it:** Wave 1 SPI (Kernel node shape), Wave 2 kernel
  handler registry binding, Wave 10 SEO/Analytics production package.

### `human-director-approval` — Human node

- **Exercises:** Human node kind (`kind: 'human'` + `interactionContract`),
  exact versioned adapter ref `director-console-adapter@1.0.0`, **two** terminal
  outcomes (`approved`, `rejected`) — proves a complete route table for every
  declared module outcome (plan §6.3.5).
- **Deliberately omits:** No real human-interaction adapter, no console, no
  pause/resume wiring.
- **Exit gate depending on it:** Wave 1 SPI (Human node shape), Wave 4
  recovery conformance (human action as a recovery event), Wave 10 Human
  Director Approval production package.

### `external-seo` — External node

- **Exercises:** External node kind (`kind: 'external'` + `adapter` reference),
  exact versioned adapter ref `seo-api-adapter@1.0.0`, one outcome
  (`ranking-fetched`), `authority: 'external'` artifact.
- **Deliberately omits:** No real external HTTP client, no API key, no network.
- **Key property:** This module is **reused in two stages** of the campaign
  scenario (plan §6.8) — the single most important extensibility proof in the
  whole fixture set.
- **Exit gate depending on it:** Wave 1 SPI (External node shape), Wave 2
  external adapter registry, Wave 7 scenario runtime (same module, multiple
  stages), Wave 10 SEO/Analytics production package.

## Scenario fixture — `campaign`

- **Exercises:** A `LifecycleDefinition`-SHAPED plain object composing all 4
  module kinds across 5 stages:
  `draft (LM) -> seo-baseline (External) -> compute (Kernel) -> seo-followup (External) -> approve (Human)`.
- **Critical proof points baked in:**
  1. **§6.4 — No `routeResolver`.** Routes are declarative static
     `outcomeRoutes` only. There is no executable closure anywhere in the
     manifest. The Runtime must look up the target from the static table.
  2. **§6.8 — `synthetic-external-seo` reused in `seo-baseline` and
     `seo-followup`.** Same package, two stages, two different input/output
     mappings. Proves the Runtime must not derive a stage from module kind or
     task-kind prefix (plan §3.6, §6.8).
  3. **§6.3.5 / §6.9.3 — Complete deterministic route table.** The Human
     stage's two outcomes route to two different terminal statuses
     (`campaign-approved`, `campaign-rejected`).
  4. **§6.3.3 / §6.9.5 — Safe own-property mappings.** Each stage's
     `inputMapping` uses only root-input paths, prior-stage output paths,
     `{ literal: ... }`, or `{ runtime: 'initiatedBy' }`. No executable
     expression language.
- **Deliberately omits:** No `LifecycleScenarioManifest` TypeScript type yet
  (Wave 1's serial work, W1-A3). The fixture is a documented plain object
  mirroring `LifecycleDefinition` from the existing domain contract; Wave 1
  will codify the final type and Wave 7 will consume it through the new
  ScenarioRuntime (with an explicit legacy adapter per plan §3.13 if needed).
- **Exit gate depending on it:** Wave 7 Lifecycle Scenario Runtime (install +
  execute with NO Runtime changes), Wave 10 Campaign Lifecycle production
  scenario, Wave 12 fault-injection hardening.

## Anti-scope (what these fixtures are NOT)

- **No real handlers / adapters.** All handler/adapter references are strings.
- **No registry wiring.** Nothing here is imported by `modules/catalog.ts`,
  `composition/product-lifecycle-runtime.ts`, or any composition root.
- **No production source touched.** This entire subtree lives under
  `tests/fixtures/`.
- **No final `LifecycleScenarioManifest` type.** That is Wave 1's serial work.
- **No executable behavior.** Loading a fixture gives you a plain data object;
  it does not start a process, write a file, or call a handler.

## Smoke test

`node --test tests/fixtures/synthetic-modules/index.test.mjs`

Asserts that each fixture loads and has the required identity, flow, node, and
outcome fields. This is a *shape* test, not a behavior test — it must pass
today and continue to pass as later waves codify the typed SPI.
