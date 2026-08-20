# ADR-085: Co-locate workshops before opening package admission

- Status: Proposed
- Date: 2026-08-21
- Owners: factory architecture
- Implementation plan: `docs/plans/WORKSHOP-MODULARIZATION-REFACTORING-PLAN.md`
- Supersedes: none
- Constrained by: ADR-053, ADR-082, ADR-083, ADR-084

## Context

A production workshop is currently split between two source trees:

- `src/process-modules/modules/<workshop>/` owns its declarative definition,
  package manifest, protocols and resources;
- `src/modules/<workshop>/` owns domain, application, infrastructure-facing
  code and the workshop-specific registration function.

The four built-in workshops therefore occupy 206 files across the two trees
(116 and 90 files respectively). Its universal application, domain and
installation layers alone occupy another 133 files. At least 32 files import
across the two workshop trees in
both directions. An agent cannot understand one workshop by opening one
directory, and adding one cannot be completed through one local contract.

Connection is split as well. Package manifests are installed through the
content-addressed package store, executable capabilities are collected in the
factory-wide `workshop-capability-manifest.ts`, and production runtime still
contains workshop-specific `register*` calls and schema resolver maps. The
existing `ProcessModulePlugin`, installation binding SPI and module authoring
kit prove useful pieces of the intended design, but do not yet make a package
the production composition authority.

This is not permission to open plugin admission. ADR-082 intentionally freezes
four manual admission surfaces until C12. A package-supplied composite manifest
or a generic catalog that silently admits new executable atoms would violate
that decision. Physical ownership and executable admission are distinct
problems and must be migrated independently.

Moving files also changes resource and implementation digests. A non-terminal
run pinned to the old package must never resume through ambient current code.
The migration therefore requires a compatibility census and an explicit drain
or historical executable strategy before any production cutover.

## Decision drivers

1. Preserve accepted-material, package-pin and temporal semantics exactly.
2. Make a workshop understandable from one directory and one public entrypoint.
3. Give authors a mechanical creation and connection checklist.
4. Prevent orchestrator, worker MCP and scripted-worker capability drift.
5. Avoid a second executable path and preserve resume of exact package pins.
6. Respect ADR-082 rather than smuggling a C12 decision into a file move.
7. Reuse the existing manifest, installer, binding and conformance machinery.

## Options considered

### A. Atomic co-location and a closed built-in catalog

Move all four built-ins under `src/modules` in one quiesced cutover and make a
source-controlled, closed tuple the real production composition input. The
tuple cannot load external packages or package-supplied executable atoms. The
four ADR-082 admission surfaces remain explicit checked projections.

### B. New workspace packages and SPI v2

Create `workshops/<name>` workspace packages and a new `workshop-spi` package,
then migrate all runtimes to generated package admission.

This has the cleanest theoretical package boundary, but creates a third
architecture during migration, broadens digest and build changes, and has the
weakest rollback story for pinned runs.

### C. Per-workshop migration with shadow composition

Move one workshop at a time behind a shadow descriptor, switch new starts, and
delete the old path after its pinned cohort drains. This appears reversible,
but the package store does not preserve old executable handler functions. It
would either strand resume or retain dual executable trees indefinitely.

## MCDA

Scores are 1 (poor) to 5 (strong). Weighted totals are out of 500.

| Criterion | Weight | A | B | C |
|---|---:|---:|---:|---:|
| Correctness and ADR alignment | 25 | 5 | 2 | 3 |
| No-regression evidence | 25 | 5 | 2 | 3 |
| Agent readability | 20 | 5 | 5 | 5 |
| Extensibility | 10 | 4 | 5 | 4 |
| Testability | 10 | 4 | 4 | 5 |
| Reversibility | 10 | 3 | 2 | 3 |
| **Weighted total** | **100** | **460** | **310** | **370** |

## Decision

Choose option A, narrowed to a closed-world built-in composition mechanism.

`src/modules/<workshop>/` becomes the canonical home of all workshop-owned
blueprint code, resources, contracts, ports and binding declarations.
`src/process-modules/{domain,application,installation,persistence}` remains the
universal kernel/SPI. Concrete SQLite and other factory-owned host adapters
remain under `src/infrastructure/process-modules/`, as required by the current
physical-placement boundary; the workshop owns the port, not the substrate.

Every workshop has:

- `WORKSHOP.md` as its agent entrypoint;
- `index.ts` as its only public TypeScript surface;
- a pure manifest/definition and package-relative resources;
- explicit runtime binding declarations with exact coverage and digests;
- module-owned conformance scenarios executed by the shared harness.

Before C12, the catalog is a literal, source-controlled tuple of the four
built-ins. It is not populated from installed package manifests, filesystem
discovery, configuration or external plugins. Adding a built-in still requires
the deliberate ADR-082 ceremony. The four frozen surfaces are retained as
explicit projections and exact parity ratchets. At C12, a separate ADR may
consider generic admission.

There is one executable cutover, not a shadow production path. Before it, new
starts are paused and non-terminal package pins are drained, or a real
digest-scoped historical executable registry is implemented and proven. Then
all four trees, composition consumers and legacy implementations change in one
bounded merge. Characterization and differential tests run before the cutover
on isolated snapshots; they are test oracles, not a second live binder.

## Target ownership boundary

```text
src/modules/<workshop>/
  WORKSHOP.md
  index.ts
  manifest.ts
  definition.ts
  runtime-bindings.ts
  domain/
  application/
  ports/
  package/
    protocols/
    capabilities/
    resources/{skills,templates,checklists,schemas}/
  conformance/{fixtures.ts,scenarios.ts}

src/process-modules/
  domain/ application/ installation/ persistence/   # universal physics

src/infrastructure/process-modules/<workshop>/       # host-owned adapters
```

An adapter outside the workshop tree is discoverable through a generated
inventory section in `WORKSHOP.md`, but is not reclassified as workshop-owned
merely to achieve visual proximity.

## Consequences

### Positive

- An agent can map a workshop from one directory and one generated inventory.
- The module boundary becomes mechanically enforceable rather than customary.
- Existing package pins, manifests and installation machinery remain the
  migration foundation.
- The live system has one composition authority after the cutover.
- Physical consolidation proceeds without opening package admission.

### Negative

- Before C12, adding a built-in workshop still edits four admission surfaces.
- Concrete host adapters remain outside the workshop directory by design.
- Digest-sensitive moves require versioning, a pin census and possibly a drain
  window or historical executable registry.
- A semantic trace normalizer and isolated before/after harness must be built
  before the runtime cutover.
- The cutover is broader than a per-workshop move and needs a drain window.

## Pre-mortem

| Failure mode | Early signal | Required control |
|---|---|---|
| The atomic change becomes too large to review | Structural and behavioral edits are mixed | Prepare import-only commits without production switch; final cutover contains no business-rule changes and has a machine diff report |
| Differential parity proves only structural equality | Equal manifests but different durable receipts/effects/routes | Compare the normalized durable authority graph on isolated snapshots |
| File moves strand pinned runs | Non-terminal runs reference unavailable package/handler digests | Census pins; drain or preserve digest-scoped executable snapshots; fail closed |
| `WORKSHOP.md` becomes stale prose | Resource/capability inventory differs from code | Generate factual inventory blocks and verify anchors in CI |
| Co-location weakens ADR-082 | Installed packages begin supplying executable atoms | Catalog is a closed literal tuple; exact admission projections remain until a later ADR |
| Tests turn green by disappearing | Scenario or edge counts fall during a move | Non-vacuity floors and mutant tests are migration gates |

## Red Team resolution

The adversarial review overturned the initial preference for option C. Handler
digests depend on executable installation-module bytes, while the package store
snapshots manifests and resources rather than executable functions. A
new-starts-only migration would therefore strand old non-terminal pins or keep
two executable trees forever. That is the repository-scale form of the
strangler-without-strangulation failure diagnosed by ADR-053.

The review also demonstrated that the two current trees already form one cyclic
component and production still uses the manual `register*` root. Per-workshop
shadow binding would prove a non-production theorem. The accepted correction is
an atomic all-built-in cutover after drain, with the closed catalog consumed by
production in the same change and the legacy implementation removed at the
merge gate.

The second accepted objection is that putting concrete persistence beside a
workshop would improve browsing at the cost of reversing an established
dependency boundary. The target keeps host adapters in infrastructure and
makes them discoverable from the workshop inventory instead.

## Decision Journal

- **Observation:** the current layout is a partial consolidation, not two
  independent module systems.
- **Uncertainty:** C12 timing and the availability of old executable bytes are
  unknown; neither is guessed by this decision.
- **Rejected shortcuts:** opening generic package admission, and maintaining a
  second live binder while old cohorts drain.
- **Reversibility point:** all preparation before the quiesced cutover is
  test-only or structural and has no authoritative writes.
- **Irreversibility point:** once new starts use bumped package versions, rollback
  must restore the whole release and its executable set, never an ambient mix.
- **Expected evidence:** the implementation plan's phase gates and L0-L5/S
  test ladder.

## References

- `docs/architecture/decisions/053-workplace-production-revision-as-accepted-material-authority.md`
- `docs/architecture/decisions/082-kernel-admission-boundary.md`
- `docs/architecture/decisions/083-readiness-toolchain-package-identity-contract.md`
- `docs/architecture/decisions/084-causal-conformance-proof-kernel.md`
- `docs/plans/PROCESS-MODULE-PACKAGE-SPI.md`
- `docs/architecture/CONVEYOR-MENTAL-MODEL.md`
- `docs/architecture/CONVEYOR-TRANSITION-DIAGNOSTICS.md`
- `docs/architecture/CONVEYOR-TRANSITION-CHECKLIST.md`
