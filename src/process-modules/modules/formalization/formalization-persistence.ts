/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite adapters (`SqliteFormalizationBaselineRepository`,
 * `SqliteFormalizationSolutionContractRepository`,
 * `ensureFormalizationPersistenceSchema`) physically live in
 * `src/infrastructure/process-modules/formalization/formalization-persistence.ts`
 * after the Wave 7 hex extraction. The repository INTERFACES and RECORD types
 * are re-exported here too so existing importers (sibling modules, tests) keep
 * resolving — the interfaces themselves are pure contracts (no substrate), but
 * colocating their re-export with the concrete adapters preserves the single
 * import path. The implementation imports `better-sqlite3` and declares the
 * `Sqlite*` classes — neither belongs inside the module tree. A re-export is a
 * pure pass-through: no better-sqlite3 import, no Sqlite class declaration,
 * so it does not trip the physical-placement ratchet
 * (`tests/architecture/no-sqlite-in-modules.test.mjs`).
 *
 * New code MUST import directly from the infrastructure path.
 */
export {
  type AcceptanceBaselineSnapshotRecord,
  type FormalizationSolutionContractRecord,
  type FormalizationBaselineRepository,
  type FormalizationSolutionContractRepository,
  ensureFormalizationPersistenceSchema,
  SqliteFormalizationBaselineRepository,
  SqliteFormalizationSolutionContractRepository,
} from '../../../infrastructure/process-modules/formalization/formalization-persistence.js';
