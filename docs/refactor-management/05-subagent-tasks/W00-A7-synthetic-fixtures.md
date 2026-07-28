# W0-A7 — Synthetic LM/Kernel/Human/External module + scenario fixtures

**Wave:** 0 · **Lane:** A7 · **Plan ref:** §0.3.8, §14.1.4, §15.11
**Frozen input commit:** `eb35510935f2317bc1bc7eb8e0b35f943bb0fadd`
**Branch to create:** `refactor/w0-a7`

## Context

- Plan §14.1.4: "Add minimal synthetic modules for LM, Kernel, Human, and External node contract tests."
- Plan §15.11: "Add exact launch tests with two modules and two versions sharing one task kind; the pinned installation must always select the correct profile, author/reviewer skill, protocol, and resources."
- Baseline: NO synthetic module/scenario fixture directory exists today (tests construct in-memory registries per-test). These fixtures are the proof target for the whole refactor — Wave 1's exit gate is "two unrelated synthetic packages validate using the same SPI."

## Architecture rule served

Plan §3.1–3.2: a Process Module Package owns one bounded capability; a
Lifecycle Scenario Package owns cross-module composition. Synthetic fixtures
let us prove the SPI is module-kind-agnostic and that the Runtime does not
switch on domain vocabulary.

## What you OWN

- `tests/fixtures/synthetic-modules/` — NEW directory with 4 minimal synthetic modules.
- `tests/fixtures/synthetic-scenarios/` — NEW directory with 1 minimal synthetic scenario.
- `tests/fixtures/synthetic-modules/README.md` — documents the boundary of each fixture (what it proves, what it deliberately omits).

## Synthetic modules to create (MINIMAL — not production-shaped)

Each module is a **data-only fixture** describing a `ProcessModuleDefinition`-
shaped object (import the type from `src/process-modules/domain/process-module.ts`).
They do NOT ship real handlers — they declare handler *references* (strings) and
are used to validate manifests, identity, digest, and installation binding in
later waves. The point is contract shape, not executable behavior.

1. **`lm-marketing/`** — an LM-node module:
   - identity: `name: 'synthetic-lm-marketing'`, `version: '0.1.0'`, `kind: 'lm-marketing'`.
   - one FlowDefinition with one LM node (`nodeId: 'draft-campaign'`) referencing an execution profile (`profileId: 'marketing-author'`, `semanticSkill: 'synthetic-marketing-skill'`).
   - one input schema ref, one output schema ref (use opaque ids like `'synthetic.marketing.input.v1'`).
   - one outcome `'campaign-drafted'`.
   - resource index: one skill file path, one template path (relative within the fixture dir).

2. **`kernel-analytics/`** — a Kernel-node module:
   - identity: `name: 'synthetic-kernel-analytics'`, `version: '0.1.0'`, `kind: 'kernel-analytics'`.
   - one FlowDefinition with one Kernel node (`nodeId: 'compute-metrics'`) referencing a kernel handler (`handlerRef: 'analytics-compute-handler@1.0.0'`).
   - one outcome `'metrics-computed'`.

3. **`human-director-approval/`** — a Human-node module:
   - identity: `name: 'synthetic-human-director-approval'`, `version: '0.1.0'`, `kind: 'human-approval'`.
   - one FlowDefinition with one Human node (`nodeId: 'director-signoff'`) referencing a human-interaction adapter (`adapterRef: 'director-console-adapter@1.0.0'`).
   - outcomes: `'approved'`, `'rejected'`.

4. **`external-seo/`** — an External-node module:
   - identity: `name: 'synthetic-external-seo'`, `version: '0.1.0'`, `kind: 'external-seo'`.
   - one FlowDefinition with one External node (`nodeId: 'fetch-ranking'`) referencing an external adapter (`adapterRef: 'seo-api-adapter@1.0.0'`).
   - one outcome `'ranking-fetched'`.

Each module fixture is a `.ts` (or `.mjs`) file exporting the definition object,
plus a `manifest.json` data-only rendering of the same (for serialization tests
in Wave 1).

## Synthetic scenario

- `tests/fixtures/synthetic-scenarios/campaign/` — a `LifecycleScenarioManifest`-shaped object (use a plain-data shape mirroring plan §6.2; if the type does not yet exist in code, define the fixture as a documented plain object and Wave 1 will codify the type).
   - Stages: `draft` (uses `synthetic-lm-marketing`) → `compute` (uses `synthetic-kernel-analytics`) → `approve` (uses `synthetic-human-director-approval`), with `external-seo` used in a parallel branch or a second stage to prove reuse (plan §6.8: "the same module may appear in multiple stages").
   - Each stage has input/output mapping (safe own-property paths), outcome routes (deterministic), terminal statuses.
   - **No `routeResolver` function** — use declarative static routes only (proves the §6.4 rule).
   - Document: this is the Wave 7/10 proof target — "install and execute without Runtime changes."

## Boundary documentation (README.md)

For each fixture, state:
- What contract shape it exercises (manifest fields, node kind, outcome routes).
- What it deliberately OMITS (no real handler code, no DB, no filesystem side effects).
- Which wave's exit gate depends on it (Wave 1 SPI, Wave 7 scenario, Wave 10 arbitrary-extensibility).

## Anti-scope

- Do NOT create real handler implementations.
- Do NOT wire these into any registry or composition root.
- Do NOT edit production source or `modules/catalog.ts`.
- Do NOT touch other lanes' files.
- Do NOT define the final `LifecycleScenarioManifest` TypeScript type — that is Wave 1's serial work. Use a plain documented object shape for now.

## Exit criteria

- [ ] 4 synthetic module fixtures exist, each with `.ts`/`.mjs` definition export + `manifest.json`.
- [ ] 1 synthetic scenario fixture exists with the documented shape.
- [ ] README documents boundaries.
- [ ] A `tests/fixtures/synthetic-modules/index.test.mjs` smoke test loads each fixture and asserts it has the required identity/flow/outcome fields (passes today).
- [ ] No production source modified.

## Return to integrator

1. Branch name. 2. `git diff --stat`. 3. Passing smoke test summary. 4. The list of fixtures and which waves will consume them. 5. Confirmation.
