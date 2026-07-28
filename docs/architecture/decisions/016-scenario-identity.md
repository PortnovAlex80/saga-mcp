# ADR-016: Lifecycle Scenario is a first-class versioned package

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.12, §6 (6.1–6.7), §14.1.2

## Context

Today the Product Delivery Lifecycle is **not a package**. It is a hard-coded
application service: `src/process-modules/lifecycles/product-delivery-lifecycle.ts`
(435 lines) directly imports concrete module schema/policy/ref symbols from all
four modules, attaches a non-serializable `routeResolver` to the lifecycle
definition via `Object.defineProperty({enumerable:false})` to dodge `canonicalJson`
(baseline §"Lifecycles — `lifecycles/`"), and bakes product-specific validation
into the lifecycle assembly.

Three observed consequences:

1. **Cross-module composition is not reusable.** A second lifecycle (e.g. a
   research-only scenario, or a delivery-without-discovery scenario) requires
   editing `product-delivery-lifecycle.ts` and the manual composition root
   `composition/product-lifecycle-runtime.ts` (baseline §"Composition —
   `composition/`"). The plan's primary objective — "compose them into arbitrary
   Lifecycle Scenario packages without changing Runtime source code" (plan
   preamble) — is unreachable in the current shape.

2. **Routing lives in a function closure.** `routeResolver` cannot be serialized,
   so it cannot be hashed, versioned, or pinned. `lifecycle-router.ts` asks
   `routeResolver` first, then falls back to a static table (baseline §"Application
   layer"). This violates plan §3.5 (no persisted function) and §6.4 (no scenario
   manifest may contain `routeResolver` or any executable closure).

3. **Resolution happens per stage, not at run start.** `lifecycle-orchestrator.ts`
   resolves the module installation at stage-execution time instead of pinning
   the complete module lock when the LifecycleRun starts (baseline §"Application
   layer"; plan §6.7). A newer module installed mid-run can change later stages.

Plan §6.1 declares the Lifecycle Scenario a first-class versioned package; §6.4
forbids executable closures in the manifest; §6.6 requires scenario installation
to resolve every module selector to an exact `InstalledProcessModule` and write
a scenario module lock; §6.7 requires the LifecycleRun to pin that exact
scenario installation plus the complete module lock at start.

## Decision

A **Lifecycle Scenario Package** is a versioned, serializable package identified
by `(scenario name, semantic version, content digest)`, on the same immutability
terms as a Process Module Package (ADR-015).

1. **`LifecycleScenarioManifest` is pure canonical data** (plan §6.2): identity
   and version; input and final output contracts; entry stage; stage bindings;
   deterministic outcome routes; typed input/output mappings; typed entry/exit/
   route guard references; terminal statuses; scenario-level retry/pause/cancel/
   escalation policy; required module selectors and capability requirements;
   explicit transition and reentry budgets. Every field must pass the same
   canonical-JSON rejection rules as a module manifest (plan §3.5, §14.2.3).

2. **No `routeResolver`, no executable closure.** `LifecycleScenarioManifest`
   MUST NOT contain `routeResolver` or any function (plan §6.4). Per-run routing
   choices use exactly one of two clean mechanisms (plan §6.5):

   - a small validated declarative predicate grammar over the immutable scenario
     frame (plan §6.5.1), or
   - an explicit decision Process Module stage for complex semantic routing
     (plan §6.5.2).

3. **Scenario installation resolves every module selector to an exact
   `InstalledProcessModule` and writes a scenario module lock** (plan §6.6). The
   lock is a frozen map `{ stage → module installation identity }` referencing
   pinned package bytes (ADR-015), not resolvable names.

4. **`LifecycleRun` pins the exact scenario installation and the complete module
   lock at start.** Installing a newer module while a scenario is running cannot
   alter later stages of that run (plan §6.7). The run records the scenario
   installation identity on the `LifecycleRun` row and on every `StageRun` (plan
   §9.4, §9.5).

5. **StageBinding is a standard serializable interface** (plan §6.3): stable
   stage id; exact or resolvable module requirement; input mapping from scenario
   root + prior stage outputs + immutable runtime fields; output mapping from the
   standard `ProcessModuleOutputEnvelope`; complete route table for every declared
   module outcome; optional declarative predicates with deterministic priority;
   optional typed scenario guard references.

## Consequences

**Positive:**

- A second Lifecycle Scenario becomes a new package, not an edit to Runtime or to
  `product-delivery-lifecycle.ts` — the plan's primary objective becomes
  reachable.
- `routeResolver` and the `Object.defineProperty({enumerable:false})` dodge are
  removed from the persisted contract; the lifecycle definition hash becomes
  trustworthy (plan §3.5).
- Pinning the module lock at run start makes mid-run module upgrades safe (plan
  §6.7; ADR-015).
- Scenario rollback selects a previous scenario installation; immutable bytes are
  never edited (plan §16.10; ADR-021).

**Negative:**

- Wave 7 must replace `product-delivery-lifecycle.ts` and the
   `routeResolver`+cumulative-frame machinery in `lifecycle-orchestrator.ts` with
   a serializable manifest + declarative route table (baseline §"Cross-cutting
   refactor seams"; plan §14.x). Until then the current hard-coded lifecycle is
   retained behind a compatibility seam (ADR-021).
- Wave 2 must add scenario installation storage and scenario module lock tables
   (plan §9.2; baseline §"Missing aggregates"). These do not exist today.
- Complex semantic routing that previously hid inside `routeResolver` must be
   promoted to an explicit decision module stage (plan §6.5.2) — a real design
   cost, not a mechanical move.

## Current state (frozen-commit `fd26fd1`)

- One hard-coded lifecycle: `product-delivery-lifecycle.ts`. No scenario
  installation table, no scenario module lock (baseline §"Missing aggregates").
- `routeResolver` lives in `domain/lifecycle.ts:69` and
  `lifecycles/product-delivery-lifecycle.ts:405–409` (the `defineProperty` dodge).
- Listed as a Wave 13 removal surface in `COMPATIBILITY-INVENTORY.md` ("routeResolver
  + cumulative-frame").

## References

- Plan §3.5, §3.12 (every run pins exact immutable bytes)
- Plan §6.1–6.7 (Scenario package, manifest, StageBinding, no closures, lock at start)
- Plan §9.2, §9.4 (scenario installation + LifecycleRun pinning)
- Plan §14.x (phased delivery; cutover gated by §16.8)
- Baseline §"Lifecycles — `lifecycles/`", §"Cross-cutting refactor seams"
- Related: ADR-015 (package identity), ADR-018 (execution envelopes), ADR-021 (compatibility)
