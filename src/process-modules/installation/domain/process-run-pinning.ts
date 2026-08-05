/**
 * ProcessRun installation pinning — pure value layer (W2-A4, plan §14.3.7,
 * WAVE2-IMMUTABLE-INSTALLATION-SPEC.md §1 rows 7,8, §4).
 *
 * Every new ProcessRun (Wave 2 onward) MUST pin the immutable
 * `installation_id` + `package_digest` of the module installation it executes
 * against. Legacy runs (pre-Wave-2) carry NULL on both columns and route
 * through the legacy nullable adapter (see ProcessRunInstallationAdapter)
 * which resolves the installation by `module_name`+`module_version` via an
 * injected fallback. Wave 13 removes the legacy path.
 *
 * This file is PURE: it defines value types and a value builder only. The
 * persistence touch (reading/writing the two columns on `factory_process_runs`)
 * lives in `installation/persistence/process-run-installation-adapter.ts`.
 *
 * Plan ref: §1 row 7 (PinnedInstallation + pinInstallationOnProcessRun),
 *          §1 row 8 (ProcessRunInstallationAdapter), §4 (identity rules),
 *          §14.3.7 (legacy nullable adapter).
 *
 * INTEGRATION NOTE (integrator, Wave 2 cherry-pick): `ModuleInstallationId`
 * and `ModuleInstallationRecord` are defined here ONLY because W2-A4 runs in
 * isolation and W2-A2 (the canonical owner of installation/domain/installation.ts)
 * has not landed in this worktree. This mirrors the Wave 1 precedent (each lane
 * defined its own copy in isolation; the integrator reconciled at cherry-pick).
 * When W2-A2 lands, the integrator should EITHER re-export W2-A2's canonical
 * types from here OR rewrite these imports to point at installation.ts and
 * delete the local definitions. The local shapes are intentionally structural
 * subsets so the swap is mechanical.
 */

// ---------------------------------------------------------------------------
// ModuleInstallationId (local isolation copy — canonical owner is W2-A2).
// ---------------------------------------------------------------------------

/**
 * Branding marker for the nominal `ModuleInstallationId` type. Branded so that
 * a bare `number` cannot be passed where an installation id is required; the
 * adapter is the only place that mints these from DB rows.
 */
declare const __moduleInstallationIdBrand: unique symbol;

/**
 * Nominal id of a row in `factory_module_installations` (W2-A2). Branded
 * `number`. The canonical definition lives in W2-A2's
 * `installation/domain/installation.ts`; this is the isolation-safe local copy.
 */
export type ModuleInstallationId = number & {
  readonly [__moduleInstallationIdBrand]: true;
};

/**
 * Cast a raw DB integer into the nominal `ModuleInstallationId`. Centralized so
 * the brand is applied at exactly one boundary (the persistence adapter). Pure.
 */
export function asModuleInstallationId(raw: number): ModuleInstallationId {
  return raw as ModuleInstallationId;
}

// ---------------------------------------------------------------------------
// PinnedInstallation (pure value).
// ---------------------------------------------------------------------------

/**
 * The immutable pin binding one ProcessRun to one module installation.
 *
 * `installationId` references `factory_module_installations.id` (W2-A2).
 * `packageDigest` is the denormalized `sha256Hex` of the canonical
 * `{ manifest, resourceIndex, resourceDigests }` (W2-A3) — denormalized onto
 * the run row so replay verification can re-hash stored bytes without a join.
 * `pinnedAt` is the ISO timestamp at which the pin was written (set by the
 * adapter when it persists; the pure builder seeds it from `nowIso`).
 *
 * This is a value object: two `PinnedInstallation` values with equal fields
 * are equivalent. It carries NO behavior and NO side effects.
 */
export interface PinnedInstallation {
  /** The ProcessRun row id (`factory_process_runs.id`). */
  readonly processRunId: number;
  /** The pinned module installation id (NOT NULL on new Wave-2+ runs). */
  readonly installationId: ModuleInstallationId;
  /** Denormalized package digest for replay verification (W2-A3/Wave 3). */
  readonly packageDigest: string;
  /** ISO timestamp the pin was written. */
  readonly pinnedAt: string;
}

/**
 * Build a `PinnedInstallation` value. Pure — no side effects, no persistence.
 * The caller (the adapter) is responsible for persisting the returned value via
 * `ProcessRunInstallationAdapter.setPinnedInstallation`.
 *
 * `nowIso` defaults to `new Date().toISOString()` so callers in tests can inject
 * a deterministic clock.
 */
export function pinInstallationOnProcessRun(
  processRunId: number,
  installationId: ModuleInstallationId,
  packageDigest: string,
  nowIso: string = new Date().toISOString(),
): PinnedInstallation {
  if (!Number.isInteger(processRunId) || processRunId <= 0) {
    throw new Error(
      `PINNED_INSTALLATION_INVALID_RUN_ID: processRunId must be a positive integer, got ${processRunId}`,
    );
  }
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(
      `PINNED_INSTALLATION_INVALID_INSTALLATION_ID: installationId must be a positive integer, got ${installationId}`,
    );
  }
  if (typeof packageDigest !== 'string' || packageDigest.length === 0) {
    throw new Error(
      'PINNED_INSTALLATION_INVALID_DIGEST: packageDigest must be a non-empty string',
    );
  }
  if (typeof nowIso !== 'string' || nowIso.length === 0) {
    throw new Error(
      'PINNED_INSTALLATION_INVALID_TIMESTAMP: nowIso must be a non-empty ISO string',
    );
  }
  return {
    processRunId,
    installationId,
    packageDigest,
    pinnedAt: nowIso,
  };
}
