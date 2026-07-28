# ADR-017: Dependency direction — modules depend only on ports; Runtime core has no module vocabulary

**Status:** Accepted
**Date:** 2026-07-28
**Plan ref:** §3.3, §3.7, §3.8, §3.14, §3.15, §3.16, §14.1.3

## Context

The codebase currently has **no repository-wide dependency enforcement**. The
only architecture test, `tests/architecture/saga2-boundaries.test.mjs`, scans a
handpicked list of 21 files that **predates** `src/process-modules/**`,
`src/saga3/**`, `src/lifecycle/**`, and `src/worker-executions.ts` (baseline
§"Architecture / boundary tests"). It cannot see the smells the refactor targets.

The smells, concentrated in four places (baseline §"Cross-cutting refactor
seams"):

1. **`modules/discovery/discovery-process-module.ts` reaches into `src/saga3/domain/`**
   — a module implementation depends on a legacy tree, so it is not
   self-contained (plan §3.16).
2. **`composition/product-lifecycle-runtime.ts` imports ~30 concrete symbols**
   — every module's process-module, schemas, ports, sqlite runtimes, all 10
   sqlite repositories. Any new module forces an edit here.
3. **`lifecycles/product-delivery-lifecycle.ts` imports concrete module
   schema/policy/ref symbols** from all four modules — a scenario depends on
   module *implementations*, not contracts (plan §3.8).
4. **`application/execution-profile-resolver.ts` imports the built-in catalog
   singleton and resolves by prefix/first-match** (`taskKind.split('.')[0]`,
   `executionProfiles[0]`) — Runtime switches on module name/kind (plan §3.6,
   §3.15).

These are the four highest-leverage targets. Plan §3.14 requires the
architecture to be enforced by dependency tests and package validators, not only
documentation. W0-A1 (parallel lane) is delivering exactly that test
(`tests/architecture/dependency-direction.test.mjs` +
`tools/dep-graph-scanner.mjs`) with a seeded `KNOWN_VIOLATIONS` allowlist that
ratchets down as later waves fix the imports.

## Decision

The intended dependency graph (the rules W0-A1's test enforces):

1. **A module never imports another module implementation, a Runtime adapter, a
   Runtime persistence implementation, or a Lifecycle Scenario implementation**
   (plan §3.7). A file under `src/process-modules/modules/<X>/` may not import
   from `src/process-modules/modules/<Y>/` (X≠Y), nor from any `sqlite-*.ts`
   adapter, `src/infrastructure/**`, `src/db.ts`, or `src/schema.ts`.

2. **A Lifecycle Scenario references module contracts and installed package
   identities only, never module implementation classes** (plan §3.8). A file
   under `src/process-modules/lifecycles/` may not import from
   `src/process-modules/modules/<X>/*`.

3. **Module domain and application code depend only on ports** (plan §3.16). A
   module package MAY ship infrastructure adapters that implement those ports,
   but its domain logic never calls global database, filesystem, runner, or MCP
   singletons. The `domain/` layer is pure: it may not import from
   `application/`, `persistence/`, `composition/`, `modules/`, or
   `src/infrastructure/`.

4. **Runtime core has no module vocabulary** (plan §3.3, §3.6, §3.15). Runtime
   never switches on module name, module kind, stage name, artifact type, reason
   code, or domain-specific field. WorkIntent, board task, epic, Claude Code,
   repository, and artifact-graph identities belong to adapters or optional
   capability contracts — NOT the base Process Module SPI. The current
   `execution-profile-resolver.ts` prefix/first-match heuristics and
   `generic-flow-executor.ts`'s magic terminal certificate bindings are
   module-kind switching and must be removed (W0-A1 rule 4; plan §7.5.6,
   §13.23).

5. **The architecture is enforced by tests, not docs** (plan §3.14). The
   W0-A1 test fails on any NEW forbidden edge not in `KNOWN_VIOLATIONS`, and
   fails if an allowlisted edge is removed without the underlying import also
   being fixed — i.e. allowlist shrinkage requires real repair.

## Consequences

**Positive:**

- A new module becomes "drop a package + register it", not "edit the composition
  root and the catalog" (plan §14.4.7 exit gate: installing a third synthetic
  module requires only package registration, not Runtime edits).
- Module domain stays portable and testable in isolation; persistence and
  runner coupling live in adapters behind ports.
- Scenario composition is contract-only, so a scenario can be assembled from
  modules whose source code is not present (only their installed bytes are) —
  ADR-015/016.

**Negative:**

- Four large allowlisted violations must be repaired across waves 3, 8, 9, 11:
   - `modules/discovery/` → `src/saga3/domain/` (Wave 9: discovery self-contained)
   - `composition/product-lifecycle-runtime.ts` (Wave 11 cutover)
   - `lifecycles/product-delivery-lifecycle.ts` (Wave 7: scenario package)
   - `execution-profile-resolver.ts` (Wave 3: injected `PackageRegistry`)
- The `node-executor.ts` SPI leaks board/task/WorkIntent vocabulary
   (`NodeProduction.bindings` keys `proposalId`/`workIntentId`,
   `NodeExecutionReceipt` `intentId`/`taskId`/`executionId`) — clean as a
   vertical slice (baseline §"Cross-cutting refactor seams" #3).

## Current state (frozen-commit `fd26fd1`)

- W0-A1 (parallel lane) is delivering `tests/architecture/dependency-direction.test.mjs`
  and `tools/dep-graph-scanner.mjs`. The test passes today with a seeded
  `KNOWN_VIOLATIONS` allowlist and ratchets thereafter. This ADR is the durable
  record of the rules that test enforces.
- The four big smells are listed in W0-A1's task file and in baseline
  §"Cross-cutting refactor seams".

## References

- Plan §3.3 (Runtime owns only generic execution physics), §3.6 (no module-kind switch)
- Plan §3.7 (modules depend only on ports; no cross-module/adapter imports)
- Plan §3.8 (scenarios reference contracts, not implementations)
- Plan §3.14 (enforced by tests), §3.15 (driver-neutral SPI), §3.16 (module domain purity)
- Plan §14.1.3 (Phase 0: repository-wide dependency tests before moving code)
- W0-A1 task file: `docs/refactor-management/05-subagent-tasks/W00-A1-dependency-direction.md`
- Baseline §"Architecture / boundary tests", §"Cross-cutting refactor seams"
- Related: ADR-015 (package identity), ADR-020 (tool ownership), ADR-021 (compatibility)
