/**
 * Conveyor outbound ports — the SURVIVING global port surface.
 *
 * History: a previous version of this file declared 8 outbound ports + ~19
 * ubiquitous-language value objects to satisfy the "14 ports" count named in
 * CONVEYOR-MENTAL-MODEL.md §"Required outbound ports". A Wave 1C (FU-E)
 * dead-port inventory found that 7 of those 8 ports and all of the value
 * objects had ZERO production importers: the responsibilities they named are
 * carried by MODULE-LOCAL equivalents (Wave 7 decomposition) that express
 * module-specific shapes a global port cannot. Keeping dead global ports
 * would re-centralize an interface that the architecture has already
 * inverted — so they were retired by ADR-022, not left as a museum.
 *
 * What SURVIVES here, and why:
 *
 * - `IdGeneratorPort` — the ONE genuinely cross-module global concern. It is
 *   imported by 5 production files (dispatch-loop and four saga3 application
 *   services) because identity creation spans the whole conveyor (every module
 *   assigns ids). It is not a module-local responsibility, so it stays global.
 *   The test below proves the import graph so this declaration cannot silently
 *   go dead again.
 *
 * Everything else named in the old doc (`WorkerLauncherPort`,
 * `WorkerSupervisionPort`, `WorkspacePort`, `ProductRepositoryPort`,
 * `ModuleCatalogPort`, `ExecutionJournalPort`, `ProcessLivenessPort`,
 * `ClockPort`) is RETIRED as a global declaration. Its responsibility lives
 * on at the module boundary:
 *
 *   WorkerLauncher   -> tracker-view ClaudeBoardRunner (run-lifecycle surface)
 *   WorkerSupervision-> startWorkerSupervision + runtime repo + reconcile
 *                       (worker-supervision-service.ts)
 *   Workspace        -> materializePinnedWorkspace
 *                       (process-modules/.../pinned-workspace-materializer.ts)
 *   ProductRepository-> ProcessProductRepository(V2) — module-local SPI
 *   ModuleCatalog    -> PackageRegistry — module-local SPI
 *   ExecutionJournal -> command_receipts via lifecycle/idempotency.ts
 *   ProcessLiveness  -> ProcessProbe (worker-executions.ts:34) — live contract
 *   Clock            -> narrow local SupervisionClock where needed (FU-D),
 *                       NOT a global abstraction
 *
 * See docs/architecture/decisions/022-module-local-ports-over-global-catalog.md
 * for the decision, the evidence, and the consequences.
 */

/**
 * ID generation abstraction. Replaces inline `randomUUID()` /
 * `${prefix}:${Date.now()}` / DB autoincrement so identity creation is
 * injectable and deterministic under test.
 *
 * This is the only port that remains GLOBAL: every conveyor module creates
 * ids (commands, receipts, executions, cards), so identity creation is a
 * genuine cross-cutting concern rather than a module-local one. Production
 * adapter: `uuidIdGenerator`; test adapter: `sequentialIdGenerator`
 * (infrastructure/conveyor/conveyor-adapters.ts).
 */
export interface IdGeneratorPort {
  /** Generate a fresh opaque unique id (UUID-shaped). */
  newId(): string;
  /** Generate a branded/prefixed id for a known kind. */
  newTypedId(prefix: string): string;
}
