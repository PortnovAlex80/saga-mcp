# Scenario Authoring Kit

W10-A6 — `tools/scenario-authoring-kit/`. Plan §0.13.10, spec
`WAVE10-EXTENSIBILITY-SPEC.md`.

A developer can **scaffold** a new Lifecycle Scenario and **validate** it using
ONLY this kit — no Runtime, global runner, gateway, catalog, or existing-module
source involved. That is the Wave 10 extensibility proof (spec §0, §3, exit
gate #4): arbitrary scenarios are authorable and validatable without touching
the compiled tree.

## What is here

```
tools/scenario-authoring-kit/
├── README.md                                  <- this file
├── templates/
│   ├── README.md                              <- placeholder reference
│   ├── manifest.template.json                 <- data-only scenario skeleton ({{TOKEN}}s)
│   └── definition.template.mjs                <- documented LifecycleDefinition-shaped skeleton (same {{TOKEN}}s)
├── scenario-scaffold.mjs                      <- scaffold CLI: name + dir -> manifest.json + definition.mjs
├── scenario-validator.mjs                     <- validator CLI + importable validateScenarioManifest()
├── scenario-validator.test.mjs                <- validator unit tests (29 cases)
└── scenario-authoring-kit.contract.test.mjs   <- end-to-end contract / proof test (8 cases)
```

## Quick start

```bash
# 1. Scaffold a scenario (writes manifest.json + definition.mjs)
node tools/scenario-authoring-kit/scenario-scaffold.mjs my-flow scenarios-ext/my-flow

# 2. Validate it
node tools/scenario-authoring-kit/scenario-validator.mjs scenarios-ext/my-flow/manifest.json
```

The scaffolded manifest validates clean out of the box. Edit the real module
refs, stages, outcomes and re-validate.

### Override placeholders at scaffold time

```bash
node tools/scenario-authoring-kit/scenario-scaffold.mjs campaign scenarios-ext/campaign \
  --set MODULE_NAME_1=lm-marketing \
  --set MODULE_VERSION_1=1.0.0 \
  --set ENTRY_STAGE_ID=draft \
  --set OUTCOME_1=campaign-drafted
```

### Validate machine-readably

```bash
node tools/scenario-authoring-kit/scenario-validator.mjs --json path/to/manifest.json
```

The CLI exits `0` when the manifest satisfies all §6.x invariants, non-zero on
any error. Warnings (unreachable stages/statuses) are reported but do not fail
the run.

## The two CLIs

### `scenario-scaffold.mjs <name> <dir> [--force] [--set KEY=VALUE ...]`

Creates `<dir>/manifest.json` and `<dir>/definition.mjs` with every
`{{PLACEHOLDER}}` substituted. `<name>` must be kebab-case. Refuses a non-empty
target unless `--force`. See `templates/README.md` for the full token list.

### `scenario-validator.mjs <manifest.json> [--json]`

Validates a parsed scenario manifest against the §6.x extensibility invariants.
Read-only and side-effect-free. The validation core
(`validateScenarioManifest(manifest, options)`) is exported for in-process use —
that is how a scenario-runtime or install tool would call it programmatically,
and how the kit's tests call it.

## Rules enforced

| Rule | Plan ref | What it checks |
|---|---|---|
| V0 | §6.2 | Manifest is a JSON object. |
| V1 | §6.2 | Top-level required fields present and correctly typed. |
| V2 | §6.2 | `identity.name` kebab-case; `identity.version` semver-shaped. |
| V3 | §6.2 | `inputContract.id` / `outputContract.id` present. |
| V4 | §6.4 | **No `routeResolver`/`resolver` field; `routeResolverPresent` false/absent** (the core §6.4 proof — no executable closures). |
| V5 | §6.2 | `entryStageId` resolves to a declared stage. |
| V6 | §6.3.5/§6.4 | `outcomeRoutes` present per stage; every route is a static `stage`/`terminal` object; declared module outcomes are all routed (when `moduleOutcomes` supplied). |
| V7 | §6.3 | Each stage is an object with a unique string `id`. |
| V8 | §3.8 | Each `stage.moduleRef` is declared in `manifest.moduleRefs`. |
| V9 | §6.9.5 | Mapping values are path strings, `{ literal }`, or `{ runtime: <allowed> }` only. |
| V11 | §6.9.3 | Every non-entry stage is reachable (warning). |
| V12 | §6.2.9 | Every `terminalStatus` is reachable (warning). |

## Programmatic use

```js
import { validateScenarioManifest } from './tools/scenario-authoring-kit/scenario-validator.mjs';

const manifest = JSON.parse(manifestJsonText);
const { findings, summary } = validateScenarioManifest(manifest, {
  // Optional: map module name -> declared outcome codes, to verify the route
  // table is complete for every declared module outcome (§6.3.5).
  moduleOutcomes: { 'lm-marketing': ['campaign-drafted'] },
});
if (!summary.ok) {
  for (const f of findings) console.error(`${f.severity} ${f.rule}: ${f.message}`);
}
```

## Tests

```bash
# Validator unit tests (29 cases, one rule per case for unambiguous provenance)
node --test tools/scenario-authoring-kit/scenario-validator.test.mjs

# End-to-end contract test (8 cases): template parity, scaffold->validate loop,
# W0-A7 campaign fixture positive, no-production-import proof.
node --test tools/scenario-authoring-kit/scenario-authoring-kit.contract.test.mjs
```

## Anti-scope

This kit imports ONLY `node:` built-ins and intra-kit modules. It never imports
`src/`, `modules/catalog`, `tracker-view/`, or any composition/persistence/
application layer. That import list IS the spec §3 proof. The kit's own contract
test asserts it (`kit: validator module text imports no production source`).
