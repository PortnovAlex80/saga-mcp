/**
 * W7-RECHECK (2026-08-02) — Thin re-export shim.
 *
 * The concrete SQLite adapter (`SqliteFormalizationArtifactGraph`) and the
 * pure reference policy (`ReferenceFormalizationSettlementPolicy`) physically
 * live in `src/infrastructure/process-modules/formalization/sqlite-formalization-kernel.ts`
 * after the Wave 7 hex extraction. This file remains ONLY as a re-export so
 * existing importers (sibling modules, the saga3-formalization-engine,
 * tests) keep resolving. The adapter implementation imports `better-sqlite3`
 * and declares the `Sqlite*` class — neither belongs inside the module tree.
 * A re-export is a pure pass-through: no better-sqlite3 import, no Sqlite
 * class declaration, so it does not trip the physical-placement ratchet
 * (`tests/architecture/no-sqlite-in-modules.test.mjs`). The reference policy
 * is pure (no substrate) but is re-exported alongside the adapter to preserve
 * the historical import surface.
 *
 * New code MUST import directly from the infrastructure path.
 */
export {
  SqliteFormalizationArtifactGraph,
  ReferenceFormalizationSettlementPolicy,
} from '../../../infrastructure/process-modules/formalization/sqlite-formalization-kernel.js';
