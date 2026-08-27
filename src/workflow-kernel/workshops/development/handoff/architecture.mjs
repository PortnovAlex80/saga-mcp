/**
 * workflow-kernel/workshops/development/handoff/architecture.mjs -
 * the FRF-WP09 consumer-side intake of the sealed architecture contract
 * (the FRF-WP08 define-architecture-contract desk output).
 *
 * LAWS (plan §"Development handoff requirements"; reverse edges 0026/0028,
 * 0034/0038/0039; WP03 postFreeze.srs.* resolution surfaces):
 *
 *   - Development consumes the typed composition/infrastructure obligation
 *     surfaces ONLY from a sealed architecture contract whose baseline and
 *     SRS pins are the EXACT settlement authorities (STALE_LINEAGE
 *     otherwise - a contract sealed over another baseline/revision never
 *     enters the Development case).
 *   - The contract's declared postFreeze.srs.* surfaces must be exactly
 *     the settlement's SRS authority surfaces (realization entry ids,
 *     construction surfaces, revision digest) - DRIFT_DETECTED otherwise.
 *   - Every frozen UC scenario survives through the realization entries
 *     (COVERAGE_GAP otherwise; the WP08 coverage law re-checked on the
 *     consumer side - Development never trusts a stranger's coverage).
 *   - Every obligation surface/scenario/entry reference resolves against
 *     the exact accepted sets - FOREIGN_LINEAGE otherwise.
 *   - The canonical digest is recomputed, never trusted.
 *
 * The intake derives the REALIZATION INDEX the planning gates consume:
 * per realization entry - scenario identity, entrypoint surface, runtime
 * edges, composition owner, terminal result, evidence binding. This index
 * is the machine-checkable form of the plan's kill list ("a plan is
 * invalid if it covers every AC but omits a scenario entrypoint, runtime
 * edge, composition owner, terminal result, or verifier").
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import { digestExcluding, refused, sameSet, sortedUnique, subsetOf } from './shared.mjs';

/** The WP08 architecture contract product kind (the authoritative constant, mirrored for the seam). */
export const ARCHITECTURE_CONTRACT_KIND = 'formalization.architecture-contract.v1';

/** The desk that seals the architecture contract (the only lawful sealer). */
export const ARCHITECTURE_DESK_ID = 'define-architecture-contract';

/**
 * The consumer-side intake of the sealed architecture contract.
 * Returns { ok, realizationIndex, obligations } or a typed refusal.
 */
export function ARCHITECTURE_CONTRACT_INTAKE(contract, authorities) {
  const { baselineArtifact, frozenBaseline, srs } = authorities;
  if (contract === null || typeof contract !== 'object') {
    return refused('MISSING_LINEAGE', 'the Development case desk was given no sealed architecture contract (fail-closed)');
  }
  if (contract.schemaVersion !== ARCHITECTURE_CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `the architecture contract kind ${String(contract.schemaVersion)} is not the sealed ${ARCHITECTURE_CONTRACT_KIND}`);
  }
  if (contract.deskId !== ARCHITECTURE_DESK_ID) {
    return refused('SCOPE_VIOLATION', `the architecture contract is sealed by desk ${String(contract.deskId)}; only ${ARCHITECTURE_DESK_ID} seals it`);
  }
  // The pins: the exact settlement authorities (STALE_LINEAGE otherwise).
  if (contract.lineage?.baselineRef !== baselineArtifact.ref) {
    return refused('STALE_LINEAGE', `the architecture contract pins WHAT baseline ${String(contract.lineage?.baselineRef)}, the frozen authority is ${baselineArtifact.ref}`);
  }
  if (contract.lineage?.srsRevisionDigest !== srs.revisionDigest) {
    return refused('STALE_LINEAGE', `the architecture contract pins SRS revision ${String(contract.lineage?.srsRevisionDigest)}, the accepted revision is ${srs.revisionDigest}`);
  }
  // The seal: recomputed over the canonical content, never trusted.
  const recomputed = digestExcluding(contract, ['canonicalDigest']);
  if (recomputed !== contract.canonicalDigest) {
    return refused('DRIFT_DETECTED', `the canonical architecture-contract digest ${String(contract.canonicalDigest)} does not verify against the sealed content`);
  }
  // The postFreeze.srs.* surfaces: exactly the settlement SRS authority.
  const postFreeze = contract.postFreeze;
  if (!Array.isArray(postFreeze?.realizationEntryIds) || !Array.isArray(postFreeze?.surfaces)) {
    return refused('MALFORMED_PRODUCT', 'the architecture contract carries no postFreeze.srs.* resolution block');
  }
  if (!sameSet(postFreeze.realizationEntryIds, srs.realizationEntryIds)) {
    return refused('DRIFT_DETECTED', `the architecture contract's realization-entry surface [${sortedUnique(postFreeze.realizationEntryIds).join(', ')}] is not exactly the settlement SRS authority [${sortedUnique(srs.realizationEntryIds).join(', ')}]`);
  }
  if (!sameSet(postFreeze.surfaces, srs.surfaces)) {
    return refused('DRIFT_DETECTED', `the architecture contract's construction-surface set [${sortedUnique(postFreeze.surfaces).join(', ')}] is not exactly the settlement SRS authority [${sortedUnique(srs.surfaces).join(', ')}]`);
  }
  if (postFreeze.revisionDigest !== srs.revisionDigest) {
    return refused('STALE_LINEAGE', 'the architecture contract postFreeze revision digest is not the accepted SRS revision');
  }

  // The realization entries: exact set equality + scenario survival.
  const entries = contract.realization?.realizationEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return refused('MISSING_LINEAGE', 'the architecture contract declares no scenario-realization entries');
  }
  const frozenScenarioIds = frozenBaseline.containers.uc.members.map((m) => m.scenarioId);
  const entryIds = entries.map((entry) => entry.realizationEntryId);
  const foreignEntries = entryIds.filter((id) => !srs.realizationEntryIds.includes(id));
  if (foreignEntries.length > 0) {
    return refused('FOREIGN_LINEAGE', `the architecture contract carries realization entries ${sortedUnique(foreignEntries).join(', ')} outside the accepted SRS realization-entry set`);
  }
  const missingEntries = srs.realizationEntryIds.filter((id) => !entryIds.includes(id));
  if (missingEntries.length > 0) {
    return refused('COVERAGE_GAP', `the architecture contract drops realization entries ${sortedUnique(missingEntries).join(', ')} from the accepted SRS realization-entry set`);
  }
  const foreignScenarios = entries.map((e) => e.scenarioRef).filter((ref) => !frozenScenarioIds.includes(ref));
  if (foreignScenarios.length > 0) {
    return refused('FOREIGN_LINEAGE', `realization entries name UC scenarios ${sortedUnique(foreignScenarios).join(', ')} outside the frozen scenario id set`);
  }
  const realizedScenarioIds = entries.map((e) => e.scenarioRef);
  const unrealized = frozenScenarioIds.filter((id) => !realizedScenarioIds.includes(id));
  if (unrealized.length > 0) {
    return refused('COVERAGE_GAP', `frozen UC scenarios ${sortedUnique(unrealized).join(', ')} have no SRS scenario-realization entry (every frozen scenario survives through the SRS realized scenarios; cr-03 scenario survival)`);
  }

  // The typed Development obligations (composition + infrastructure).
  const obligations = contract.developmentObligations;
  if (obligations === null || typeof obligations !== 'object'
    || !Array.isArray(obligations.integrationOrComposition) || !Array.isArray(obligations.infrastructure)) {
    return refused('MALFORMED_PRODUCT', 'the architecture contract carries no typed developmentObligations block');
  }
  if (obligations.integrationOrComposition.length === 0) {
    return refused('COVERAGE_GAP', 'the architecture contract materializes no integration-or-composition obligation (every scenario realization carries composition surfaces)');
  }
  const declaredSurfaceIds = [...postFreeze.surfaces];
  for (const binding of [...obligations.integrationOrComposition, ...obligations.infrastructure]) {
    if (!declaredSurfaceIds.includes(binding.surfaceRef)) {
      return refused('FOREIGN_LINEAGE', `Development obligation cites surface ${String(binding.surfaceRef)} outside the accepted construction-surface set`);
    }
    if (!subsetOf(binding.realizedScenarioRefs ?? [], frozenScenarioIds)) {
      return refused('FOREIGN_LINEAGE', `Development obligation on surface ${String(binding.surfaceRef)} cites scenario(s) outside the frozen scenario id set`);
    }
    if (!subsetOf(binding.definedByRealizationEntryRefs ?? [], srs.realizationEntryIds)) {
      return refused('FOREIGN_LINEAGE', `Development obligation on surface ${String(binding.surfaceRef)} is defined by realization entries outside the accepted set`);
    }
    if ((binding.realizedScenarioRefs ?? []).length === 0) {
      return refused('FOREIGN_LINEAGE', `Development obligation on surface ${String(binding.surfaceRef)} realizes no scenario (every construction surface is cited with the scenarios it realizes)`);
    }
  }

  // The realization index (the planning-gate input surface).
  const realizationIndex = {
    entries: entries.map((entry) => ({
      realizationEntryId: entry.realizationEntryId,
      scenarioRef: entry.scenarioRef,
      entrypointSurfaceRef: entry.entrypointSurfaceRef,
      participatingSurfaceRefs: [...entry.participatingSurfaceRefs],
      runtimeEdges: entry.runtimeEdges.map((edge) => ({ fromSurfaceRef: edge.fromSurfaceRef, toSurfaceRef: edge.toSurfaceRef })),
      compositionOwnerSurfaceRef: entry.compositionOwnerSurfaceRef,
      terminalResult: entry.terminalResult,
      evidenceBinding: { evidenceKind: entry.evidenceBinding.evidenceKind, evidenceBindingRef: entry.evidenceBinding.evidenceBindingRef },
    })),
    postFreeze: {
      realizationEntryIds: sortedUnique(postFreeze.realizationEntryIds),
      revisionDigest: postFreeze.revisionDigest,
      surfaces: sortedUnique(postFreeze.surfaces),
    },
  };
  return { ok: true, obligations, realizationIndex };
}
