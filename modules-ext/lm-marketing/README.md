# `@saga-modules-ext/lm-marketing` — LM Marketing Process Module

**Wave 10, Lane A1** — `refactor/w10-a1`.
**Spec:** `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
**Task:** `docs/refactor-management/05-subagent-tasks/W10-a1.md`.

This is the **definitive proof that the saga runtime is arbitrarily extensible** for
LM (Language Model) nodes. It is a self-contained, installable Process Module
package that declares its own manifest, NodeProtocol, resources, skills,
templates, and schemas — and imports **only** the public process-module SPI
(`domain/spi/*`, `installation/*`, `application/*` services). It never imports
`src/index.ts`, `modules/catalog.ts`, `tracker-view/`, any runtime core, or any
existing built-in module (Discovery / Formalization / Development / Delivery).

## Why `modules-ext/` and not `modules/`

Per `WAVE10-EXTENSIBILITY-SPEC.md` §3 (anti-scope) and §4 (key design):

- All new packages live at repo root under `modules-ext/` and `scenarios-ext/`,
  **outside** the compiled `src/` tree. The proof is that `npm run build` +
  `node --test` shows **ZERO diffs in `src/`** while these packages install and
  execute.
- The `modules-ext/` prefix (not `modules/`) signals these are **NOT built-in** —
  they prove the architecture accepts ARBITRARY packages, not just the 4
  production ones.
- This package is the upgrade of the W0-A7 `tests/fixtures/synthetic-modules/
  lm-marketing/` data-only fixture into a full installable package with real
  NodeProtocols, resources, and a validated manifest envelope.

## What this package owns

```
modules-ext/lm-marketing/
├── package.json                 # installable package identity
├── README.md                    # this file
├── manifest.json                # canonical manifest envelope (validated at load)
├── definition.mjs               # ProcessModuleDefinition (pure data)
├── node-protocol.mjs            # NodeProtocolDefinition for the draft-campaign LM node
├── manifest.mjs                 # manifest envelope builder (validated at load)
├── contributions.mjs            # resource index, handler refs, contract refs
├── index.mjs                    # single import surface (barrel)
├── skills/
│   └── marketing-author-skill.md        # execution skill driving the LM node
├── templates/
│   ├── campaign-draft-template.md       # campaign draft workspace template
│   ├── campaign-draft-tracker.md        # per-stage tracker template
│   ├── campaign-draft-call-template.json # MCP call template for the draft tool
│   └── campaign-draft-checklist.md      # completeness checklist
├── schemas/
│   ├── marketing-input.schema.json      # MarketingBrief input contract
│   ├── marketing-output.schema.json     # CampaignDraft output contract
│   └── marketing-work-intent.schema.json # WorkIntent contract for the profile
└── lm-marketing.test.mjs        # package conformance test
```

## The §0.13.10 proof

`lm-marketing.test.mjs` asserts:

1. The manifest envelope passes `validateProcessModuleManifest` (structural +
   canonical-serializable).
2. The NodeProtocol passes `validateNodeProtocolDefinition`.
3. Every `resourceIndex` entry resolves to a real file under the package root
   and never escapes it.
4. The manifest is canonically serializable and round-trips through JSON.
5. The import list of every `.mjs` source file in this package imports ONLY from
   the public process-module SPI — never `src/index.ts`, `modules/catalog.ts`,
   `tracker-view/`, the composition root, or any existing built-in module.

Point (5) **is** the §0.13.10 import-list proof. Wave 10's exit gate
(`W10-A8`) re-asserts it at the integration level.

## Anti-scope

- NO edits to `src/` (all new content lives under `modules-ext/`).
- NO edits to existing modules (Discovery / Formalization / Development / Delivery).
- NO composition-root changes (Wave 11).
- NO runtime, runner, gateway, or catalog wiring. This package is pure data; it
  installs through the public SPI and executes through the runtime's existing
  LM-node executor without any module-name switching.

## Install + execute contract

A future installer (Wave 2 content-addressed package store, or Wave 11
composition cutover) consumes `manifest.mjs`'s exported `marketingPackageManifest`
and registers the package under its `name@version` identity
(`lm-marketing@1.0.0`). The runtime then drives the single `draft-campaign` LM
node through `marketingDraftCampaignNodeProtocol` using the pinned execution
profile `marketing-author`. No Runtime code change is required — the LM-node
executor is module-kind-agnostic (plan §3.6, §7.2).
