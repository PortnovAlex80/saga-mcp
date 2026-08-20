# ADR-085: Co-locate workshops before opening package admission

- Status: Proposed; implementation blocked by the Saga Kernel Conformance Engine
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
factory-wide `workshop-capability-manifest.ts`, and the canonical runtime still
contains workshop-specific `register*` calls and schema resolver maps. The
existing `ProcessModulePlugin`, installation binding SPI and module authoring
kit prove useful pieces of the intended design, but do not yet make a package
the canonical composition authority.

This is not permission to open plugin admission. ADR-082 intentionally freezes
four manual admission surfaces until C12. A package-supplied composite manifest
or a generic catalog that silently admits new executable atoms would violate
that decision. Physical ownership and executable admission are distinct
problems and must be changed independently.

There is currently no deployed production environment, persistent production
database or non-terminal run population to preserve. Resource and
implementation digests may therefore be regenerated for the new layout. This
decision does not require data migration, a drain window, compatibility shims
or historical executable storage. Databases created by tests are disposable
test fixtures, not migration targets.

## Decision drivers

1. Preserve accepted-material and temporal semantics in code exactly.
2. Make a workshop understandable from one directory and one public entrypoint.
3. Give authors a mechanical creation and connection checklist.
4. Prevent orchestrator, worker MCP and scripted-worker capability drift.
5. Avoid a second executable path or a transitional compatibility architecture.
6. Respect ADR-082 rather than smuggling a C12 decision into a file move.
7. Reuse the existing manifest, installer, binding and conformance machinery.

## Options considered

### A. Atomic co-location and a closed built-in catalog

Move all four built-ins under `src/modules` in one direct cutover and make a
source-controlled, closed tuple the real canonical composition input. The
tuple cannot load external packages or package-supplied executable atoms. The
four ADR-082 admission surfaces remain explicit checked projections.

### B. New workspace packages and SPI v2

Create `workshops/<name>` workspace packages and a new `workshop-spi` package,
then switch all runtimes to generated package admission.

This has the cleanest theoretical package boundary, but creates a third
architecture during the refactor and unnecessarily broadens digest, build and
tooling changes.

### C. Per-workshop phased refactor with shadow composition

Move one workshop at a time behind a shadow descriptor and delete the old path
later. With no deployed state to migrate, this adds a transitional architecture
without buying safety and risks leaving two composition paths indefinitely.

## MCDA

Scores are 1 (poor) to 5 (strong). Weighted totals are out of 500.

| Criterion | Weight | A | B | C |
|---|---:|---:|---:|---:|
| Correctness and ADR alignment | 25 | 5 | 2 | 3 |
| No-regression evidence | 25 | 5 | 2 | 3 |
| Agent readability | 20 | 5 | 5 | 5 |
| Extensibility | 10 | 4 | 5 | 4 |
| Testability | 10 | 4 | 4 | 5 |
| Reversibility | 10 | 4 | 2 | 3 |
| **Weighted total** | **100** | **470** | **310** | **370** |

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

There is one executable cutover, not a shadow runtime path. All four trees,
composition consumers and legacy implementations change in one bounded merge.
Digests and generated fixtures are rebuilt from the new canonical layout.
Characterization and differential tests compare the base and candidate
revisions in isolated disposable environments; they are test oracles, not a
second live binder. No database migration or runtime compatibility layer is
created.

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
- Existing manifests, installation validation and conformance machinery remain
  the refactoring foundation.
- The repository has one composition authority after the cutover.
- Physical consolidation proceeds without opening package admission.

### Negative

- Before C12, adding a built-in workshop still edits four admission surfaces.
- Concrete host adapters remain outside the workshop directory by design.
- A semantic trace normalizer and isolated before/after harness must be built
  before the repository cutover.
- The cutover is broader than a per-workshop move and must land as one complete
  repository state.

## Pre-mortem

| Failure mode | Early signal | Required control |
|---|---|---|
| The atomic change becomes too large to review | Structural and behavioral edits are mixed | Use reviewable branch commits, but merge only the complete topology; require a machine diff report |
| Differential parity proves only structural equality | Equal manifests but different durable receipts/effects/routes | Compare the normalized durable authority graph on isolated snapshots |
| `WORKSHOP.md` becomes stale prose | Resource/capability inventory differs from code | Generate factual inventory blocks and verify anchors in CI |
| Co-location weakens ADR-082 | Installed packages begin supplying executable atoms | Catalog is a closed literal tuple; exact admission projections remain until a later ADR |
| Tests turn green by disappearing | Scenario or edge counts fall during a move | Non-vacuity floors and mutant tests are refactor gates |

## Red Team resolution

The adversarial review overturned the initial preference for option C. A
new-starts-only rollout would create two executable trees and repeat the
strangler-without-strangulation failure diagnosed by ADR-053. The absence of a
deployed environment and persistent run state removes the only reason to accept
that transitional complexity: all current digests and fixtures can be rebuilt
directly from the new layout.

The review also demonstrated that the two current trees already form one cyclic
component and the canonical runtime still uses the manual `register*` root.
Per-workshop shadow binding would prove a non-canonical theorem. The accepted correction is
an atomic all-built-in cutover, with the closed catalog consumed by the
canonical runtime in the same change and the legacy implementation removed at
the merge gate.

The second accepted objection is that putting concrete persistence beside a
workshop would improve browsing at the cost of reversing an established
dependency boundary. The target keeps host adapters in infrastructure and
makes them discoverable from the workshop inventory instead.

## Decision Journal

- **Observation:** the current layout is a partial consolidation, not two
  independent module systems.
- **Known constraint:** there is no deployed production state or persistent
  database to migrate; C12 timing remains unknown.
- **Rejected shortcuts:** opening generic package admission, adding database
  migrations, and maintaining a second binder for compatibility that is not
  needed.
- **Reversibility:** the repository change is reverted as a whole before any
  future persistent environment exists; no data rollback procedure is needed.
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
