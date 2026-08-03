/**
 * Formalization persistence port contracts — the driver-neutral repository
 * interfaces and record types the Formalization Process Module consumes.
 *
 * W7-THIRD-AUDIT (2026-08-02) — port-contract extraction (mirrors the
 * `discovery-domain-contracts.ts` convention). The concrete SQLite adapters
 * (`SqliteFormalizationBaselineRepository`,
 * `SqliteFormalizationSolutionContractRepository`,
 * `ensureFormalizationPersistenceSchema`) physically live in
 * `src/modules/formalization/infrastructure/formalization-persistence.ts`
 * after the Wave 7 hex extraction. The port interfaces and record types they
 * implement, however, are PURE contracts: they name only the schema payload
 * types (from the sibling `formalization-schemas.ts`) and primitive columns.
 * Co-locating these contracts with the concrete adapters forced every module
 * consumer (`formalization-installation.ts`) to import the infrastructure file,
 * forming a Rule 2 module→infrastructure edge
 * (`tests/architecture/dependency-direction.test.mjs`). The contracts now live
 * HERE, inside the module tree, and the infrastructure adapter depends INWARD
 * on them — the correct direction (infrastructure implements module-owned
 * ports). The definitions are byte-identical to the originals.
 *
 * INVARIANT: the field shapes MUST stay byte-identical — formalization
 * certificate/content hashes and replay idempotency depend on them.
 */

import type {
  AcceptanceBaselineSnapshotPayload,
  FormalizationSolutionContractPayload,
} from './formalization-schemas.js';

/** A frozen acceptance-baseline row (the durable AC baseline snapshot). */
export interface AcceptanceBaselineSnapshotRecord {
  id: number;
  processRunId: number;
  formalizationEpicId: number;
  payload: AcceptanceBaselineSnapshotPayload;
  baselineHash: string;
  snapshotHash: string;
  artifactRef: string;
  createdAt: string;
}

/** A persisted formalization solution-contract row. */
export interface FormalizationSolutionContractRecord {
  id: number;
  processRunId: number;
  formalizationEpicId: number;
  payload: FormalizationSolutionContractPayload;
  contentHash: string;
  artifactRef: string;
  createdAt: string;
}

/**
 * Port: freeze and read the acceptance baseline for one formalization run.
 * A driver-neutral contract; the concrete SQLite adapter lives in
 * infrastructure and is constructor-injected by the composition root.
 */
export interface FormalizationBaselineRepository {
  freeze(
    payload: AcceptanceBaselineSnapshotPayload,
  ): { record: AcceptanceBaselineSnapshotRecord; replayed: boolean };
  readByProcessRun(processRunId: number): AcceptanceBaselineSnapshotRecord | null;
}

/**
 * Port: persist and read the solution contract for one formalization run.
 * A driver-neutral contract; the concrete SQLite adapter lives in
 * infrastructure and is constructor-injected by the composition root.
 */
export interface FormalizationSolutionContractRepository {
  persist(
    payload: FormalizationSolutionContractPayload,
  ): { record: FormalizationSolutionContractRecord; replayed: boolean };
  readByProcessRun(processRunId: number): FormalizationSolutionContractRecord | null;
}
