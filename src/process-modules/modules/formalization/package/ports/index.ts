/**
 * W8-A6 — Formalization package ports barrel.
 *
 * Single import surface for the formalization package's port-injected path.
 * Plan §5.4.8 (`modules/<module-name>/ports`). Re-exports the port interfaces
 * so a consumer imports substrate-free contracts from one place. The legacy
 * handler adapter was removed by the ADR-053 clean cutover: package code may
 * no longer construct the execution-scoped Formalization handler stack.
 *
 * Purity: this barrel re-exports only port TYPES. It does NOT re-export the
 * concrete SQLite-backed adapters (`SqliteFormalizationBrief
 * Provisioning` / `SqliteFormalizationManagedProduction` /
 * `buildSqliteFormalizationPackagePorts`): those live in
 * `src/modules/formalization/infrastructure/sqlite-formalization-package-adapters.ts`
 * and must be imported directly from there. A module-tree barrel re-exporting
 * them would form a Rule 2 module→infrastructure edge (dependency-direction
 * ratchet, `tests/architecture/dependency-direction.test.mjs`). Importers who
 * only need the TYPES (`import type { … }`) incur no runtime coupling to the
 * substrate, and the barrel itself now incurs none either.
 */

export type {
  FormalizationBriefProvisioningContext,
  FormalizationBriefProvisioningOutcome,
  FormalizationBriefProvisioningPort,
  FormalizationManagedArtifactWrite,
  FormalizationManagedProductionPort,
  FormalizationManagedProductionQuery,
  FormalizationManagedTraceWrite,
  FormalizationPackagePorts,
  FormalizationPrdRootRead,
} from './formalization-package-ports.js';
