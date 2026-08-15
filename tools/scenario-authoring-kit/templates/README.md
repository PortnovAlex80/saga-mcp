# Scenario Templates

Seed skeletons for a new Lifecycle Scenario (plan §6.x, §0.13.10). Copy these
into a new package directory (e.g. `scenarios-ext/<name>/`) and substitute the
`{{PLACEHOLDER}}` tokens. Both files describe the SAME scenario in two forms:

- `manifest.template.json` — the data-only rendering consumed by the validator
  and the scenario runtime. This is the installable artifact.
- `definition.template.mjs` — the documented `LifecycleDefinition`-SHAPED plain
  object. Mirrors the W0-A7 campaign fixture; kept in lock-step with the JSON by
  the kit's contract test.

## Placeholders

| Token | Meaning | Example |
|---|---|---|
| `{{SCENARIO_NAME}}` | scenario `identity.name` (kebab-case, unique) | `campaign` |
| `{{SCENARIO_DISPLAY_NAME}}` | human display name | `Campaign Lifecycle` |
| `{{SCENARIO_DESCRIPTION}}` | one-line purpose | `Composes marketing + seo + approval` |
| `{{ENTRY_STAGE_ID}}` | id of the first stage | `draft` |
| `{{ENTRY_STAGE_DISPLAY_NAME}}` | display name of the entry stage | `Draft Campaign` |
| `{{STAGE_2_ID}}` | id of the second stage | `approve` |
| `{{STAGE_2_DISPLAY_NAME}}` | display name of the second stage | `Approve` |
| `{{MODULE_NAME_1}}` | installed module package name for stage 1 | `lm-marketing` |
| `{{MODULE_VERSION_1}}` | installed module package version for stage 1 | `0.1.0` |
| `{{MODULE_NAME_2}}` | installed module package name for stage 2 | `human-director-approval` |
| `{{MODULE_VERSION_2}}` | installed module package version for stage 2 | `0.1.0` |
| `{{OUTCOME_1}}` | outcome emitted by stage 1's module | `campaign-drafted` |
| `{{OUTCOME_2_OK}}` | positive outcome of stage 2's module | `approved` |
| `{{OUTCOME_2_FAIL}}` | negative outcome of stage 2's module | `rejected` |
| `{{TERMINAL_STATUS_OK}}` | terminal status for the positive path | `campaign-approved` |
| `{{TERMINAL_STATUS_FAIL}}` | terminal status for the negative path | `campaign-rejected` |

The scaffold CLI (`scenario-scaffold.mjs`) substitutes these for you. To use the
templates by hand instead, copy both files and replace every `{{TOKEN}}`.

## Rules these templates encode

These are NOT optional conventions — they are the extensibility invariants
(verify with `scenario-validator.mjs`):

1. **§6.4 — No `routeResolver`.** Routes are declarative static `outcomeRoutes`
   only. There is no executable closure anywhere in the manifest.
2. **§6.8 — A module may be reused in multiple stages.** Same package, different
   stage, different mapping. The Runtime must not derive a stage from module
   kind or task-kind prefix.
3. **§6.3.5 / §6.9.3 — Complete route table.** Every declared module outcome has
   exactly one deterministic static route.
4. **§6.3.3 / §6.9.5 — Safe own-property mappings.** Values are a JSON-path
   string, `{ literal: <value> }`, or `{ runtime: 'initiatedBy' }` only. No
   expression language.
5. **§6.2.9 — Explicit terminal statuses.**
6. **§3.8 — Scenarios reference module contracts/identities only**, never module
   implementation classes.
