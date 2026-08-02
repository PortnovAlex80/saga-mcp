# ADR-022: Module-local ports over global conveyor catalog

**Status:** Accepted
**Date:** 2026-08-02
**Wave:** 1C (FU-E dead-port inventory)
**Supersedes (partially):** the global "14 outbound ports" surface named in
CONVEYOR-MENTAL-MODEL.md §"Required outbound ports" (the doc's mandatory +
additional port list, lines 592–639)

## Context

CONVEYOR-MENTAL-MODEL.md §"Required outbound ports" named a global port
catalog: 5 mandatory outbound ports (`WorkAssignmentPort`,
`WorkerLauncherPort`, `WorkerSupervisionPort`, `WorkspacePort`,
`ProductRepositoryPort`) plus 9 additional ports (`ProcessRunRepository`,
`NodeRunRepository`, `RecoveryCaseRepository`, `ModuleCatalogPort`,
`InstallationRepository`, `ExecutionJournalPort`, `ProcessLivenessPort`,
`ClockPort`, `IdGeneratorPort`). An earlier wave materialized the missing
declarations in `src/application/ports/conveyor-ports.ts` (8 interfaces + ~19
ubiquitous-language value objects) and wired thin adapters in
`src/infrastructure/conveyor/conveyor-adapters.ts`.

A Wave 1C (FU-E) dead-port inventory, run on 2026-08-02, grepped the import
graph of every declaration in that file against `src/` (excluding the file
itself and the architecture test). The result:

| Declaration | Production importers (from conveyor-ports.ts) | Verdict |
| --- | --- | --- |
| `IdGeneratorPort` | **6** — `app/dispatch-loop.ts`, `engines/saga3-discovery-engine.ts`, `saga3/application/{assign-one-card,discovery-diagnosis-service,discovery-normalization-service,discovery-readiness-service}.ts` | LIVE — keep |
| `ClockPort` | 0 (`systemClock`/`fixedClock` adapters: 0 importers) | DEAD — delete |
| `ProcessLivenessPort` | 0 (`systemProcessLiveness` adapter: 0 importers); `ProcessProbe` (`worker-executions.ts:30`) is the live contract | DEAD — delete |
| `WorkerLauncherPort` | 0 | superseded by `ClaudeBoardRunner` run-lifecycle surface |
| `WorkerSupervisionPort` | 0 | superseded by `startWorkerSupervision` + runtime repo + `reconcileWorkerExecutions` |
| `WorkspacePort` | 0 | superseded by `materializePinnedWorkspace` |
| `ProductRepositoryPort` | 0 | superseded by module-local `ProcessProductRepository(V2)` SPI |
| `ModuleCatalogPort` | 0 | superseded by module-local `PackageRegistry` SPI |
| `ExecutionJournalPort` | 0 | superseded by `command_receipts` via `lifecycle/idempotency.ts` |
| Value objects (`WorkplaceRef`, `CardRef`, `DeskRef`, `Product`, `Lease`, `FencedExecutionRef`, `FencedProgress`, `FencedCompletion`, `ReleaseResult`, `CompletionResult`, `ProcessExitObservation`, `ReconcileResult`, `WorkerLaunchContext`, `LaunchRef`, `JournalRecord`, `CatalogEntry`) | 0 importers from this file | DEAD — delete |
| `ProductRef`, `RecoveryIssue`, `ModuleSelector` | 0 importers from this file; **shadowed** by live declarations in `process-modules/domain/{spi/production-envelope,recovery,spi/scenario-manifest}.ts` that ARE imported | delete conveyor-ports copy; live module-local declarations stay |
| `WorkAssignmentPort` re-export | 0 importers of the re-export (canonical declaration in `worker-executor.ts` has 13 importers) | delete re-export; canonical stays |

7 of the 8 global ports and **all** the value objects had zero production
importers. The responsibilities they name are not gone — they are carried by
**module-local equivalents** (the Wave 7 process-module decomposition) whose
shapes are module-specific and cannot be expressed by a single global
interface without erasing that specificity.

Keeping a global interface that nothing implements and nothing imports has two
costs: (1) it is a museum piece that misleads readers into thinking a boundary
exists where the code has already inverted it; (2) it invites a future change
to "wire it up" and re-centralize a responsibility the architecture has
deliberately pushed to the module edge. The "14 ports" count is not a
correctness property — a port counts when a real consumer depends on the
abstraction.

The human's decision rule (applied per port): for each port, one of (a) delete
as duplicate; (b) rename/use the existing live port; (c) wire if it is a
genuinely needed boundary; (d) change the architecture document via an ADR.
This ADR is the (d) step for the seven retired ports and their value objects:
the spec change that justifies the deletion, recorded **before** the code
change, not as retroactive justification.

## Decision

1. **Module-local port inversion is canonical.** Where a process module owns a
   responsibility, the module's local SPI/port interface is the canonical
   declaration. There is no requirement that such a responsibility also appear
   as a global interface in a shared `ports/` catalog. The global catalog is
   reserved for concerns that are genuinely cross-module.

2. **The seven global ports that the inventory proved dead are RETIRED as a
   responsibility-bearing surface.** Their declarations are removed from
   `conveyor-ports.ts`; their adapters are removed from
   `conveyor-adapters.ts`. The responsibilities live on at the module
   boundary:

   | Retired global port | Live module-local location |
   | --- | --- |
   | `WorkerLauncherPort` | `tracker-view/claude-runner.mjs` `ClaudeBoardRunner` (run-lifecycle surface) |
   | `WorkerSupervisionPort` | `infrastructure/work/worker-supervision-service.ts` (`startWorkerSupervision`) + runtime repo (`renewLeases`, `reconcile`) + `worker-executions.ts` (`reconcileWorkerExecutions`) |
   | `WorkspacePort` | `process-modules/application/pinned-workspace-materializer.ts` (`materializePinnedWorkspace`) |
   | `ProductRepositoryPort` | `process-modules/persistence/process-product-repository-v2.ts` (`ProcessProductRepository(V2)` SPI) |
   | `ModuleCatalogPort` | `process-modules/installation/domain/package-registry.ts` (`PackageRegistry` SPI) |
   | `ExecutionJournalPort` | `lifecycle/idempotency.ts` over the `command_receipts` table (`checkReceipt` / `storeReceipt`) |
   | `ProcessLivenessPort` | `worker-executions.ts:30` (`ProcessProbe` interface) + `REAL_PROCESS_PROBE` |

3. **`ClockPort` is retired and is NOT replaced globally.** A global clock
   abstraction had zero consumers and was the wrong granularity: temporal
   logic that needs determinism (FU-D supervision) is served by a NARROW LOCAL
   `SupervisionClock` constructed where it is used, not by a conveyor-wide
   port. Re-centralizing time would re-introduce exactly the coupling Wave 7
   removed.

4. **The value objects declared only in `conveyor-ports.ts` are deleted.**
   Those shadowed by independent live declarations
   (`ProductRef` → `process-modules/domain/spi/production-envelope.ts`;
   `RecoveryIssue` → `process-modules/domain/recovery.ts`;
   `ModuleSelector` → `process-modules/domain/spi/scenario-manifest.ts`) keep
   their live module-local declarations; only the unused conveyor-ports copies
   are removed.

5. **The `WorkAssignmentPort` re-export from `conveyor-ports.ts` is removed.**
   It had zero importers; the canonical declaration in
   `application/ports/worker-executor.ts` (13 importers) is unaffected.

6. **`IdGeneratorPort` STAYS GLOBAL and STAYS in `conveyor-ports.ts`.** Identity
   creation spans the entire conveyor — every module assigns ids (commands,
   receipts, executions, cards) — so it is a genuine cross-cutting concern
   rather than a module-local one. Its production adapter (`uuidIdGenerator`)
   and test adapter (`sequentialIdGenerator`) stay in `conveyor-adapters.ts`.
   The architecture test is strengthened from "interface exists" to
   "imported by ≥4 production files", so this declaration cannot silently go
   dead again.

## Consequences

**Positive:**

- The surviving global catalog (`IdGeneratorPort` only) reflects the true
  cross-module surface. A reader of `conveyor-ports.ts` sees the one port that
  actually spans modules, not a museum of dead interfaces.
- The dead-port test (`tests/architecture/conveyor-ports.test.mjs`) now PROVES
  usage via the import graph: `IdGeneratorPort` must be imported by ≥4
  production files or the build fails. The negative assertion forbids the
  retired ports from being re-centralized in the catalog file.
- No responsibility is lost. Every retired port has a named live location in
  the table above; the module-local SPIs carry module-specific shapes a global
  port could not express.
- Re-centralization is blocked at two layers: the ADR (this document) states
  the inversion is canonical, and the architecture test fails if a retired
  global declaration reappears in `conveyor-ports.ts`.

**Negative:**

- The "14 outbound ports" count in CONVEYOR-MENTAL-MODEL.md is no longer
  literally enforceable as "14 interfaces in one file". CONVEYOR-MENTAL-
  MODEL.md §"Required outbound ports" is updated to point here and to describe
  the responsibility→location mapping rather than a single-file count.
- A future contributor who wants a global `ClockPort` or `ProcessLivenessPort`
  must come back through this ADR (status: Accepted) and justify why a global
  boundary is needed when the module-local one was sufficient. That is the
  intended friction.
- `ClockPort`'s retirement means FU-D must introduce its narrow local
  `SupervisionClock` rather than reaching for a shared abstraction; this is a
  deferred task, not a regression in this wave.

**Neutral / non-goals:**

- This ADR does NOT prescribe the exact shape of each module-local SPI — those
  are owned by their modules and may continue to evolve. It only records that
  the global catalog is no longer the home for them.
- This ADR does NOT retire the already-formalized module-local repositories
  (`ProcessRunRepository`, `NodeRunRepository`, `RecoveryCaseRepository`,
  `ModuleInstallationRepository`); those were never in `conveyor-ports.ts` and
  remain verified in the architecture test.

## Current state (frozen-commit `7a1aa05`, branch `saga4`)

- `src/application/ports/conveyor-ports.ts` declares exactly one interface:
  `IdGeneratorPort`. The 7 retired ports and all value objects are removed.
- `src/infrastructure/conveyor/conveyor-adapters.ts` exports `uuidIdGenerator`
  and `sequentialIdGenerator` only. `systemClock`, `fixedClock`, and
  `systemProcessLiveness` are removed.
- `tests/architecture/conveyor-ports.test.mjs` proves `IdGeneratorPort` is
  imported by ≥4 production files (import-graph edge), and negatively asserts
  the retired ports do not reappear in the catalog file.
- The 6 production importers of `IdGeneratorPort`
  (`dispatch-loop.ts`, `saga3-discovery-engine.ts`, four `saga3/application/*`
  services) and the single importer of `uuidIdGenerator` (`orchestrate-cli.ts`)
  are unchanged.
- `npx tsc --noEmit` is clean (no production file imported any deleted type).
- `node --test tests/architecture/conveyor-ports.test.mjs` is green.

## References

- `docs/architecture/CONVEYOR-MENTAL-MODEL.md` §"Required outbound ports"
  (lines 592–639) — updated to reference this ADR.
- Wave 7 process-module decomposition (module-local SPIs over a shared
  application-layer catalog).
- FU-E dead-port inventory (2026-08-02): grep of `src/` for each declaration
  in `conveyor-ports.ts`, excluding the file itself and the architecture test.
- FU-D supervision clock: narrow local `SupervisionClock` is the planned
  replacement for the retired global `ClockPort`.
- Related: ADR-015 (package identity), ADR-017 (dependency direction),
  ADR-018 (execution envelopes), ADR-020 (tool ownership).
