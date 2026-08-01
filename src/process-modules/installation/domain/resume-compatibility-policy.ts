/**
 * CONVEYOR Wave 8 — ResumeCompatibilityPolicy.
 *
 * Spec: `docs/architecture/CONVEYOR-MENTAL-MODEL.md` Wave 8 (lines ~840-853) +
 *   CGAD P18 (resume is about the work on the card, not the toolset version).
 *
 * A ProcessRun pins an `installation_id` + `package_digest` so a run is
 * reproducible against the exact bytes it started with. But this pin is an
 * INTEGRITY BOUNDARY FOR TOOLSET VERSIONING, not a gate on whether the run's
 * work can be resumed. When the toolset changes (a skill updated, a tracker
 * rule tweaked), the naive path throws "already holds the active slot with a
 * different package_digest" — even though every artifact, trace, submission
 * and task on the workplace's card is unchanged and still valid.
 *
 * This policy replaces raw digest equality with an explicit compatibility
 * classification:
 *
 *   - `compatible` — the digest changed, but the module CONTRACT is unchanged
 *      (same identity name+version, same input/output schema ids, same handler
 *      refs). The runtime reinstalls the new toolset and resumes against the
 *      existing work. Audit records old→new installation identity.
 *   - `incompatible` — the contract itself changed (identity version bumped,
 *      input/output schema id changed, handler surface changed). The runtime
 *      PAUSES the run without mutating existing work and surfaces an explicit
 *      operator action. This is the "incompatible-upgrade pause" the doc
 *      requires.
 *
 * The policy is PURE: it reads only the old + new manifest/record data and
 * returns a verdict. It performs no I/O, no install, no DB write. The caller
 * (production-install / the runtime) acts on the verdict.
 */

import type { ProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import type { ModuleInstallationRecord } from './installation.js';

/**
 * The contract surface compared for compatibility. These are the fields that,
 * if changed, mean a resumed workplace would see a DIFFERENT contract — not
 * merely a different toolset. Resource-byte changes (skill wording, template
 * tweaks) do NOT appear here: they change the digest but not the contract.
 */
export interface ModuleContractSurface {
  readonly moduleName: string;
  readonly moduleVersion: string;
  readonly inputContractSchemaId: string;
  readonly outputContractSchemaId: string;
  readonly handlerLogicalIds: readonly string[];
}

/**
 * Extract the contract surface from a manifest. Only the identity-stable
 * fields are compared; resource bytes and digests are deliberately excluded.
 */
export function extractContractSurface(
  manifest: ProcessModuleManifest,
): ModuleContractSurface {
  return {
    moduleName: manifest.definition.identity.name,
    moduleVersion: manifest.definition.identity.version,
    inputContractSchemaId: manifest.inputContractRef.schemaId,
    outputContractSchemaId: manifest.outputContractRef.schemaId,
    handlerLogicalIds: (manifest.handlerRefs ?? [])
      .map((h) => h.logicalId)
      .sort(),
  };
}

/**
 * Extract the contract surface from a persisted installation record. Mirrors
 * {@link extractContractSurface} so old (persisted) and new (fresh manifest)
 * surfaces are comparable.
 */
export function extractContractSurfaceFromRecord(
  record: ModuleInstallationRecord,
): ModuleContractSurface {
  const snap = record.manifestSnapshot;
  return {
    moduleName: record.name,
    moduleVersion: record.version,
    inputContractSchemaId: snap.inputContractRef.schemaId,
    outputContractSchemaId: snap.outputContractRef.schemaId,
    handlerLogicalIds: (snap.handlerRefs ?? [])
      .map((h) => h.logicalId)
      .sort(),
  };
}

/**
 * Verdict returned by {@link classifyResumeCompatibility}.
 */
export type ResumeCompatibilityVerdict =
  | {
      readonly outcome: 'compatible';
      readonly reason: string;
      readonly oldInstallationId: number;
      readonly oldPackageDigest: string;
      readonly newPackageDigest: string;
    }
  | {
      readonly outcome: 'incompatible';
      readonly reason: string;
      readonly oldInstallationId: number;
      readonly oldPackageDigest: string;
      readonly newPackageDigest: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly outcome: 'unchanged';
      readonly reason: string;
      readonly installationId: number;
      readonly packageDigest: string;
    };

/**
 * Compare an existing active installation against a freshly-attempted install
 * and classify whether resume is compatible.
 *
 * Decision logic:
 *   1. If the digests are EQUAL → `unchanged` (no drift; resume trivially).
 *   2. If the digests differ BUT the contract surface is identical →
 *      `compatible` (toolset bytes changed; contract stable; resume safe).
 *   3. If the digests differ AND the contract surface changed →
 *      `incompatible` (the resumed workplace would see a different contract;
 *      pause for operator action).
 *
 * This is the explicit policy the doc requires in place of raw digest
 * equality. A `compatible` verdict lets the runtime retire the old slot and
 * reinstall; an `incompatible` verdict must NOT mutate existing work.
 */
export function classifyResumeCompatibility(
  existing: ModuleInstallationRecord,
  attemptedPackageDigest: string,
  attemptedManifest: ProcessModuleManifest,
): ResumeCompatibilityVerdict {
  const oldDigest = existing.packageDigest;
  const newDigest = attemptedPackageDigest;

  if (oldDigest === newDigest) {
    return {
      outcome: 'unchanged',
      reason: 'package digest unchanged — same toolset, resume trivially',
      installationId: existing.id,
      packageDigest: oldDigest,
    };
  }

  const oldSurface = extractContractSurfaceFromRecord(existing);
  const newSurface = extractContractSurface(attemptedManifest);
  const changedFields = diffContractSurface(oldSurface, newSurface);

  if (changedFields.length === 0) {
    return {
      outcome: 'compatible',
      reason:
        'package bytes changed but module contract is stable '
        + '(identity + input/output schemas + handler surface unchanged) — '
        + 'CGAD P18: resume continues against the existing work',
      oldInstallationId: existing.id,
      oldPackageDigest: oldDigest,
      newPackageDigest: newDigest,
    };
  }

  return {
    outcome: 'incompatible',
    reason:
      `module contract changed (${changedFields.join(', ')}) — a resumed `
      + 'workplace would see a different contract; pause without mutating '
      + 'existing work (CONVEYOR Wave 8 incompatible-upgrade pause)',
    oldInstallationId: existing.id,
    oldPackageDigest: oldDigest,
    newPackageDigest: newDigest,
    changedFields,
  };
}

/**
 * Compute the list of contract-surface fields that differ between old and new.
 * Returns an empty array when the surfaces are contractually identical (the
 * `compatible` case). Pure structural comparison.
 */
export function diffContractSurface(
  oldSurface: ModuleContractSurface,
  newSurface: ModuleContractSurface,
): readonly string[] {
  const changed: string[] = [];
  if (oldSurface.moduleName !== newSurface.moduleName) {
    changed.push(`moduleName: '${oldSurface.moduleName}' → '${newSurface.moduleName}'`);
  }
  if (oldSurface.moduleVersion !== newSurface.moduleVersion) {
    changed.push(`moduleVersion: '${oldSurface.moduleVersion}' → '${newSurface.moduleVersion}'`);
  }
  if (oldSurface.inputContractSchemaId !== newSurface.inputContractSchemaId) {
    changed.push(`inputContractSchemaId: '${oldSurface.inputContractSchemaId}' → '${newSurface.inputContractSchemaId}'`);
  }
  if (oldSurface.outputContractSchemaId !== newSurface.outputContractSchemaId) {
    changed.push(`outputContractSchemaId: '${oldSurface.outputContractSchemaId}' → '${newSurface.outputContractSchemaId}'`);
  }
  const oldHandlers = oldSurface.handlerLogicalIds.join(',');
  const newHandlers = newSurface.handlerLogicalIds.join(',');
  if (oldHandlers !== newHandlers) {
    changed.push(`handlerLogicalIds: [${oldHandlers}] → [${newHandlers}]`);
  }
  return changed;
}
