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
  /**
   * K5 (Saga Core Renewal): sorted `logicalId:implementationDigest` pairs.
   * A changed implementation digest under the SAME logicalId is the exact
   * "rewritten handler" case the 2026-08-16 audit flagged — it must classify
   * as restart-required, never as a silently compatible toolset update.
   */
  readonly handlerDigests: readonly string[];
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
    handlerDigests: (manifest.handlerRefs ?? [])
      .map((h) => `${h.logicalId}:${h.digest ?? ''}`)
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
    handlerDigests: (snap.handlerRefs ?? [])
      .map((h) => `${h.logicalId}:${h.digest ?? ''}`)
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
      /**
       * K5 (Saga Core Renewal): handler IMPLEMENTATION digests changed under
       * stable logicalIds — the rewritten-handler case. Resume is NOT
       * automatic: the runtime must start an explicit new lifecycle or refuse.
       * Never silently compatible (audit 2026-08-16), never mutates existing
       * terminal/accepted work.
       */
      readonly outcome: 'restart-required';
      readonly reason: string;
      readonly oldInstallationId: number;
      readonly oldPackageDigest: string;
      readonly newPackageDigest: string;
      readonly changedHandlerImplementations: readonly string[];
    }
  | {
      readonly outcome: 'unchanged';
      readonly reason: string;
      readonly installationId: number;
      readonly packageDigest: string;
    };

/**
 * K5: list the per-handler implementation digest changes as
 * `logicalId: old → new` strings (diagnostic projection of the
 * handlerImplementationDigests surface diff).
 */
function diffHandlerImplementationDigests(
  oldDigests: readonly string[],
  newDigests: readonly string[],
): readonly string[] {
  const oldMap = new Map(oldDigests.map((pair) => [pair.slice(0, pair.indexOf(':')), pair.slice(pair.indexOf(':') + 1)]));
  const newMap = new Map(newDigests.map((pair) => [pair.slice(0, pair.indexOf(':')), pair.slice(pair.indexOf(':') + 1)]));
  const changes: string[] = [];
  for (const logicalId of new Map([...oldMap, ...newMap]).keys()) {
    const before = oldMap.get(logicalId) ?? '(absent)';
    const after = newMap.get(logicalId) ?? '(absent)';
    if (before !== after) {
      changes.push(`${logicalId}: ${before.slice(0, 12)}… → ${after.slice(0, 12)}…`);
    }
  }
  return changes.sort();
}

/**
 * Compare an existing active installation against a freshly-attempted install
 * and classify whether resume is compatible.
 *
 * Decision logic:
 *   1. If the digests are EQUAL → `unchanged` (no drift; resume trivially).
 *   2. If the digests differ BUT the contract surface is identical →
 *      `compatible` (toolset bytes changed; contract stable; resume safe).
 *   3. K5: if ONLY handler implementation digests changed (same logicalIds,
 *      same schemas, same identity) → `restart-required` — a resumed
 *      workplace would execute REWRITTEN code; resume needs an explicit new
 *      lifecycle or a refusal, never a silent toolset swap.
 *   4. Anything else changed → `incompatible` (the resumed workplace would
 *      see a different contract; pause for operator action).
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
        + '(identity + input/output schemas + handler implementation digests unchanged) — '
        + 'CGAD P18: resume continues against the existing work',
      oldInstallationId: existing.id,
      oldPackageDigest: oldDigest,
      newPackageDigest: newDigest,
    };
  }

  // K5: the ONLY drift is handler implementation digests under stable
  // logicalIds — the rewritten-handler case. Restart, never silent resume.
  const onlyHandlerImplementations = changedFields.every(
    (f) => f.startsWith('handlerImplementationDigests:'),
  );
  if (onlyHandlerImplementations) {
    const changedHandlerImplementations = diffHandlerImplementationDigests(
      oldSurface.handlerDigests,
      newSurface.handlerDigests,
    );
    return {
      outcome: 'restart-required',
      reason:
        `handler implementation(s) changed under stable logicalIds `
        + `(${changedHandlerImplementations.join('; ')}) — a resumed workplace `
        + 'would execute rewritten code; start an explicit new lifecycle or '
        + 'refuse (K5 / ADR-077); existing terminal and accepted work stays immutable',
      oldInstallationId: existing.id,
      oldPackageDigest: oldDigest,
      newPackageDigest: newDigest,
      changedHandlerImplementations,
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
  const oldDigests = oldSurface.handlerDigests.join(',');
  const newDigests = newSurface.handlerDigests.join(',');
  if (oldDigests !== newDigests) {
    changed.push(`handlerImplementationDigests: [${oldDigests}] → [${newDigests}]`);
  }
  return changed;
}
