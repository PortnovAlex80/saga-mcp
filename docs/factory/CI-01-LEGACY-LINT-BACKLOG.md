# CI-01 — Legacy lint debt backlog (deferred cleanup)

> Bounded cleanup note for the lint ratchet introduced by CI-01
> (`ci(factory): make lint a blocking acceptance gate`). This file is the
> record of debt **quarantined** by the eslint flat-config ratchet in
> `eslint.config.mjs`. It is NOT a COMPLETION-LEDGER task row and does not
> edit any ledger row.

## Context

CI-01 makes lint a **blocking** acceptance gate: `npx eslint src/` must exit 0
in CI, and the Factory-completion active paths must be lint-clean. The active
paths are fully error-enforced. The pre-existing legacy surfaces below carry
lint debt that predates the Factory completion plan and is intentionally NOT
blanket-fixed in CI-01:

- `eqeqeq` — the bulk. Several are intentional `== null` null/undefined guards;
  blanket `===` conversion is a correctness risk and "reformat the repository"
  is a non-goal.
- `prefer-const` — a handful of `let x; x = …` self-referential patterns.
- `@typescript-eslint/no-empty-object-type` — empty `interface Foo extends Bar {}`
  marker interfaces in legacy module roots.

These three rules are turned `off` for the legacy globs in `eslint.config.mjs`
so the gate is green, while every other recommended rule still applies.

## Quarantined files and counts (measured at CI-01 baseline, 4e5594b)

Total quarantined errors: **84** (of the original 88; the remaining 4 were in
Factory active paths and were fixed in the CI-01 commit).

By rule:

| Rule | Count |
|---|---|
| `eqeqeq` | 80 |
| `prefer-const` | 2 |
| `@typescript-eslint/no-empty-object-type` | 2 |

By file:

| File | Count | Rules |
|---|---|---|
| `src/tools/dispatcher.ts` | 13 | eqeqeq |
| `src/tools/tasks.ts` | 12 | eqeqeq (11), prefer-const (1) |
| `src/tools/artifacts.ts` | 12 | eqeqeq |
| `src/tools/observations.ts` | 11 | eqeqeq |
| `src/tools/export-import.ts` | 10 | eqeqeq |
| `src/tools/providers.ts` | 10 | eqeqeq |
| `src/tools/repositories.ts` | 5 | eqeqeq |
| `src/tools/conflicts.ts` | 4 | eqeqeq |
| `src/helpers/artifact-file.ts` | 2 | eqeqeq |
| `src/tools/lifecycle.ts` | 1 | prefer-const |
| `src/planner/topology.ts` | 1 | eqeqeq |
| `src/modules/discovery/index.ts` | 1 | no-empty-object-type |
| `src/modules/formalization/index.ts` | 1 | no-empty-object-type |
| `src/validators/brief.ts` | 1 | eqeqeq |

## Ratchet direction (only ever tighten)

To clean up, fix a file's debt and **remove its glob** from the legacy
`files:` block in `eslint.config.mjs` so the strict rules apply again. The
gate must stay green at every step, so each glob removal must follow a
verified clean-up of that file. When the `files:` list is empty, the ratchet
has fully closed and this backlog is done.

Suggested ordering (smallest/safest first): `src/validators/brief.ts`,
`src/planner/topology.ts`, `src/modules/discovery/index.ts`,
`src/modules/formalization/index.ts`, `src/helpers/artifact-file.ts`, then the
`src/tools/*` files (largest concentration of `== null` guards — review each
conversion for null-vs-undefined semantics).
