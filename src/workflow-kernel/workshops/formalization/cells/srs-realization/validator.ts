/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/validator.ts
 * - FRF-WP08: the fail-closed, typed-refusal validators of the SRS
 * scenario-realization extension and of the architecture contract the
 * define-architecture-contract desk seals (plan phase FRF-8).
 *
 * THE WP03 VALIDATOR SEAM (the FRF-WP03 contract rule this cell adopts):
 *   every validator takes the ACCEPTED ID-SET UNIVERSE as input and is
 *   fail-closed. A reference class whose accepted set was not supplied is a
 *   typed MISSING_LINEAGE refusal ("will not guess the accepted universe");
 *   a binding that does not resolve against the exact supplied set is a
 *   typed FOREIGN_LINEAGE refusal (the UC-FOREIGN fix shape). The validator
 *   never scans by type/status/chronology and never reparses accepted
 *   material - the universe comes in pinned from the frozen baseline.
 *
 * Typed refusal taxonomy (the workshop's closed seven):
 *   MALFORMED_PRODUCT - wrong shape/version, open vocabulary, duplicated
 *                       scenario realization, composition owner of the
 *                       wrong surface kind.
 *   MISSING_LINEAGE   - unsupplied accepted sets / revision pins; a realized
 *                       scenario citing no surfaces at all.
 *   STALE_LINEAGE     - baselineRef / srsRevisionDigest pins that are not
 *                       the accepted revisions.
 *   FOREIGN_LINEAGE   - scenario/evidence refs outside the exact accepted
 *                       sets; a declared surface realizing NO scenario (the
 *                       missing-composition kill); surface claims naming
 *                       scenarios that were never realized.
 *   COVERAGE_GAP      - a frozen scenario with no realization entry; a
 *                       product surface required by a scenario's realization
 *                       ABSENT from the architecture contract (the
 *                       missing-entrypoint kill - typed, never silent);
 *                       disconnected runtime graphs.
 *   DRIFT_DETECTED   - duplicate realization entry ids, digest mismatches,
 *                       surface<->scenario bidirectional claim mismatch,
 *                       tampered postFreeze/obligation blocks.
 *   SCOPE_VIOLATION   - the architecture desk emitting WHAT-side material
 *                       (AC/FR content) inside the architecture contract.
 *
 * PURITY: pure functions only. No I/O, no clock, no session.
 */

import {
  ARCHITECTURE_CONTRACT_KIND,
  SRS_REALIZATION_SECTION_KIND,
  SRS_TRACE_RULE,
  architectureContractDigestOf,
  developmentObligationsOf,
  postFreezeBlockOf,
  realizationDigestOf,
  realizedScenarioIdsOf,
} from './contract.js';
import type {
  ArchitectureContractProduct,
  SrsRealizationSection,
  SrsRealizationUniverse,
} from './contract.js';
import type { ProductRefusal, ProductValidation } from '../../contracts/artifacts.js';

function refused(reason: ProductRefusal['reason'], detail: string): ProductRefusal {
  return { ok: false, refused: true, reason, detail };
}

/** Fail-closed universe resolution (the WP03 seam; MISSING_LINEAGE on any miss). */
function requireUniverse(universe: SrsRealizationUniverse | undefined): ProductRefusal | null {
  if (universe === undefined || universe === null) {
    return refused('MISSING_LINEAGE', 'no accepted id-set universe was supplied; the validator is fail-closed and will not guess the accepted universe');
  }
  const scenarioIds = universe.idSets?.ucScenarioIds;
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted ucScenarioIds set was supplied (the frozen scenario id set); the validator is fail-closed');
  }
  const evidenceBindingIds = universe.idSets?.evidenceBindingIds;
  if (!Array.isArray(evidenceBindingIds) || evidenceBindingIds.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted evidenceBindingIds set was supplied; the validator is fail-closed');
  }
  const whatBaselineDigest = universe.revisionPins?.whatBaselineDigest;
  if (typeof whatBaselineDigest !== 'string' || !/^[0-9a-f]{64}$/.test(whatBaselineDigest)) {
    return refused('MISSING_LINEAGE', 'no accepted whatBaselineDigest revision pin was supplied; the validator is fail-closed');
  }
  return null;
}

/** Fail-closed SRS revision pin resolution. */
function requireSrsRevisionPin(universe: SrsRealizationUniverse): ProductRefusal | null {
  const srsRevisionDigest = universe.revisionPins?.srsRevisionDigest;
  if (typeof srsRevisionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(srsRevisionDigest)) {
    return refused('MISSING_LINEAGE', 'no accepted srsRevisionDigest pin was supplied; the validator is fail-closed');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Validator 1: the SRS scenario-realization section                    */
/* ------------------------------------------------------------------ */

/**
 * Validate the mandatory scenario-realization section against the frozen
 * universe. Every frozen UC scenario must be realized (>= 1 realized
 * scenario; duplicates are refused), every realized scenario must resolve
 * against the frozen scenario id set, every realized scenario must cite its
 * realizing architecture surfaces, and the runtime graph must be connected
 * from the entrypoint (a flat list of files is not proof of runtime
 * connectivity).
 */
export function validateSrsRealization(
  section: SrsRealizationSection,
  universe: SrsRealizationUniverse,
): ProductValidation {
  if (section === null || typeof section !== 'object' || section.schemaVersion !== SRS_REALIZATION_SECTION_KIND) {
    return refused('MALFORMED_PRODUCT', `the realization section is not a ${SRS_REALIZATION_SECTION_KIND}`);
  }
  const universeRefusal = requireUniverse(universe);
  if (universeRefusal !== null) return universeRefusal;

  // Lineage pins: the section derives from the frozen WHAT baseline only.
  if (section.lineage?.traceRule !== SRS_TRACE_RULE) {
    return refused('MALFORMED_PRODUCT', `the realization section carries trace rule ${String(section.lineage?.traceRule)}, the closed rule is ${SRS_TRACE_RULE}`);
  }
  if (section.lineage.baselineRef !== `sha256:${universe.revisionPins.whatBaselineDigest}`) {
    return refused('STALE_LINEAGE', `the pinned WHAT baseline ${String(section.lineage?.baselineRef)} is not the frozen baseline sha256:${universe.revisionPins.whatBaselineDigest} (the SRS derives from the frozen whole-WHAT baseline only)`);
  }

  // Canonical digest: recomputed, never trusted (digestExcluding drops the
  // self-referencing digest field under the kernel's frozen rule).
  if (realizationDigestOf(section) !== section.realizationDigest) {
    return refused('DRIFT_DETECTED', `the realization digest ${String(section.realizationDigest)} does not verify against the canonical section content`);
  }

  const frozenScenarioIds = universe.idSets.ucScenarioIds;
  const frozenEvidenceIds = universe.idSets.evidenceBindingIds;
  const declaredSurfaces = new Map(section.surfaces.map((surface) => [surface.surfaceId, surface]));
  const declaredSurfaceIds = [...declaredSurfaces.keys()];

  // Every realized scenario resolves against the frozen scenario id set and
  // is realized exactly once (plan FRF-8: every frozen required UC exactly
  // once; extra, duplicate, stale, foreign scenarios are rejected).
  const realizedByScenario = new Map<string, number>();
  const seenEntryIds = new Map<string, number>();
  for (const [index, entry] of section.realizationEntries.entries()) {
    const priorEntry = seenEntryIds.get(entry.realizationEntryId);
    if (priorEntry !== undefined) {
      return refused('DRIFT_DETECTED', `realization entry ${entry.realizationEntryId} appears more than once (entries ${priorEntry} and ${index}; an artifact was emitted twice)`);
    }
    seenEntryIds.set(entry.realizationEntryId, index);
    if (!frozenScenarioIds.includes(entry.scenarioRef)) {
      return refused('FOREIGN_LINEAGE', `realization entry ${entry.realizationEntryId} names UC scenario ${entry.scenarioRef} outside the frozen scenario id set (realizedScenarioIds resolve against the frozen scenario id set only)`);
    }
    const priorRealization = realizedByScenario.get(entry.scenarioRef);
    if (priorRealization !== undefined) {
      return refused('MALFORMED_PRODUCT', `scenario ${entry.scenarioRef} is realized more than once (entries ${priorRealization} and ${index}; every frozen required UC is realized exactly once)`);
    }
    realizedByScenario.set(entry.scenarioRef, index);
    if (!frozenEvidenceIds.includes(entry.evidenceBinding.evidenceBindingRef)) {
      return refused('FOREIGN_LINEAGE', `realization of ${entry.scenarioRef} cites evidence binding ${entry.evidenceBinding.evidenceBindingRef} outside the frozen evidence-binding id set`);
    }

    // Every realized scenario cites its realizing architecture surfaces:
    // entrypoint, participants, runtime-edge ends, composition owner - all
    // must be declared in the architecture contract. A required surface
    // absent from the contract is the missing-entrypoint kill: a typed
    // refusal, never a silent gap. (The terminal observable result is a
    // plain graph node like in the sibling SRS contract - it is not itself
    // a declared surface.)
    const citedSurfaces = [
      entry.entrypointSurfaceRef,
      entry.compositionOwnerSurfaceRef,
      ...entry.participatingSurfaceRefs,
      ...entry.implementationSurfaceRefs,
      ...entry.runtimeEdges.flatMap((edge) => [edge.fromSurfaceRef, edge.toSurfaceRef])
        .filter((ref) => ref !== entry.terminalResult),
    ];
    if (citedSurfaces.length === 0) {
      return refused('MISSING_LINEAGE', `realization of ${entry.scenarioRef} cites no architecture surface`);
    }
    for (const surfaceRef of [...new Set(citedSurfaces)].sort()) {
      if (!declaredSurfaceIds.includes(surfaceRef)) {
        return refused('COVERAGE_GAP', `realization of ${entry.scenarioRef} requires architecture surface ${surfaceRef} which the contract does not declare (missing entrypoint/composition surface; a typed refusal, never silent)`);
      }
    }
    const owner = declaredSurfaces.get(entry.compositionOwnerSurfaceRef);
    if (owner !== undefined && owner.surfaceKind !== 'composition') {
      return refused('MALFORMED_PRODUCT', `the composition owner of ${entry.scenarioRef} is surface ${entry.compositionOwnerSurfaceRef} of kind ${owner.surfaceKind}; a composition owner is a composition surface`);
    }
    if (!entry.participatingSurfaceRefs.includes(entry.entrypointSurfaceRef)) {
      return refused('COVERAGE_GAP', `realization of ${entry.scenarioRef}: the entrypoint surface ${entry.entrypointSurfaceRef} is not a participating surface (disconnected runtime graph)`);
    }

    // Runtime connectivity: every participating surface and the terminal
    // observable result are reachable from the entrypoint over the declared
    // producer-consumer edges (reverse edge/0043/0044 constraint).
    const nodes = new Set<string>([...entry.participatingSurfaceRefs, entry.terminalResult]);
    const edges = entry.runtimeEdges.filter((edge) => nodes.has(edge.fromSurfaceRef) && nodes.has(edge.toSurfaceRef));
    const reachable = new Set<string>([entry.entrypointSurfaceRef]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of edges) {
        if (reachable.has(edge.fromSurfaceRef) && !reachable.has(edge.toSurfaceRef)) {
          reachable.add(edge.toSurfaceRef);
          grew = true;
        }
      }
    }
    for (const node of [...nodes].sort()) {
      if (!reachable.has(node)) {
        return refused('COVERAGE_GAP', `realization of ${entry.scenarioRef}: node ${node} is unreachable from the entrypoint (disconnected runtime graph; a flat list of files is not proof of runtime connectivity)`);
      }
    }
  }

  // Coverage: every frozen UC scenario survives through the SRS realized
  // scenarios (>= 1 realization entry each).
  for (const scenarioId of [...frozenScenarioIds].sort()) {
    if (!realizedByScenario.has(scenarioId)) {
      return refused('COVERAGE_GAP', `frozen UC scenario ${scenarioId} has no SRS scenario-realization entry (every frozen scenario survives through the SRS realized scenarios)`);
    }
  }

  // Declared surfaces resolve into the realized-scenario universe: a
  // declared surface realizing NO scenario is the missing-composition kill.
  const realizedScenarioIds = realizedScenarioIdsOf(section);
  for (const surface of section.surfaces) {
    if (surface.realizedScenarioRefs.length === 0) {
      return refused('FOREIGN_LINEAGE', `declared ${surface.surfaceKind} surface ${surface.surfaceId} realizes no scenario (every architecture surface is cited with the scenarios it realizes)`);
    }
    const foreign = surface.realizedScenarioRefs.filter((ref) => !realizedScenarioIds.includes(ref));
    if (foreign.length > 0) {
      return refused('FOREIGN_LINEAGE', `surface ${surface.surfaceId} claims to realize scenario(s) ${foreign.sort().join(', ')} outside the realized scenario set`);
    }
  }
  return { ok: true, artifact: { ref: `sha256:${section.realizationDigest}`, digest: section.realizationDigest, content: section } };
}

/* ------------------------------------------------------------------ */
/* Validator 2: the sealed architecture contract                        */
/* ------------------------------------------------------------------ */

/** The desk-scope fence: WHAT-side material never enters the architecture contract. */
const FORBIDDEN_CONTRACT_FIELDS = ['acceptanceCriteria', 'criteria', 'frMembers', 'requirements', 'useCases'] as const;

/**
 * Validate the architecture contract the define-architecture-contract desk
 * seals: the embedded realization section must pass validator 1, and the
 * surface<->scenario binding must be the closed bidirectional composition
 * (each surface cited with the scenarios it realizes; each claim verified
 * against the realizing entries). The Development obligation block and the
 * postFreeze.srs.* resolution surfaces must equal their derived values.
 */
export function validateArchitectureContract(
  contract: ArchitectureContractProduct,
  universe: SrsRealizationUniverse,
): ProductValidation {
  if (contract === null || typeof contract !== 'object' || contract.schemaVersion !== ARCHITECTURE_CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `the product is not a ${ARCHITECTURE_CONTRACT_KIND}`);
  }
  const raw = contract as unknown as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_CONTRACT_FIELDS) {
    if (raw[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `the architecture contract must not carry WHAT-side material (${forbidden}); AC decomposition may remain in the SRS but can never substitute for scenario realization`);
    }
  }
  const universeRefusal = requireUniverse(universe);
  if (universeRefusal !== null) return universeRefusal;
  const pinRefusal = requireSrsRevisionPin(universe);
  if (pinRefusal !== null) return pinRefusal;

  if (contract.deskId !== 'define-architecture-contract') {
    return refused('SCOPE_VIOLATION', `the architecture contract is sealed by desk ${String(contract.deskId)}; only define-architecture-contract seals it`);
  }
  if (contract.lineage?.traceRule !== SRS_TRACE_RULE || contract.realization?.lineage?.traceRule !== SRS_TRACE_RULE) {
    return refused('MALFORMED_PRODUCT', `the contract lineage must carry the trace rule ${SRS_TRACE_RULE} at both levels`);
  }
  if (contract.lineage.baselineRef !== `sha256:${universe.revisionPins.whatBaselineDigest}`) {
    return refused('STALE_LINEAGE', `the contract pins WHAT baseline ${String(contract.lineage?.baselineRef)}, the frozen baseline is sha256:${universe.revisionPins.whatBaselineDigest}`);
  }
  if (contract.lineage.srsRevisionDigest !== universe.revisionPins.srsRevisionDigest) {
    return refused('STALE_LINEAGE', `the contract pins SRS revision ${String(contract.lineage?.srsRevisionDigest)}, the accepted revision is ${universe.revisionPins.srsRevisionDigest}`);
  }

  // The embedded realization section must itself be valid (validator 1 runs
  // with the same universe: its kills stay live at the contract level too).
  const sectionRefusal = validateSrsRealization(contract.realization, universe);
  if (!sectionRefusal.ok) return sectionRefusal;

  // Bidirectional surface<->scenario closure: every realized scenario cites
  // its realizing surfaces (validator 1), and every surface claim is cited
  // back by the realizing entry (a false claim is drift, not coverage).
  for (const surface of contract.realization.surfaces) {
    for (const claimedScenario of surface.realizedScenarioRefs) {
      const entry = contract.realization.realizationEntries.find((candidate) => candidate.scenarioRef === claimedScenario);
      if (entry === undefined) continue; // validator 1 already refused foreign claims
      const cited = entry.entrypointSurfaceRef === surface.surfaceId ||
        entry.compositionOwnerSurfaceRef === surface.surfaceId ||
        entry.participatingSurfaceRefs.includes(surface.surfaceId) ||
        entry.implementationSurfaceRefs.includes(surface.surfaceId) ||
        entry.runtimeEdges.some((edge) => edge.fromSurfaceRef === surface.surfaceId || edge.toSurfaceRef === surface.surfaceId);
      if (!cited) {
        return refused('DRIFT_DETECTED', `surface ${surface.surfaceId} claims to realize ${claimedScenario}, but that scenario's realization entry ${entry.realizationEntryId} does not cite it (the surface<->scenario binding is the accepted bidirectional closure)`);
      }
    }
  }

  // The Development obligation block must equal its derivation over the
  // section (composition -> integration-or-composition; infrastructure ->
  // infrastructure; each cited with the scenarios it realizes).
  const derivedObligations = developmentObligationsOf(contract.realization);
  if (JSON.stringify(derivedObligations) !== JSON.stringify(contract.developmentObligations)) {
    return refused('DRIFT_DETECTED', 'the developmentObligations block does not equal its derivation over the realization section (composition surfaces -> integration-or-composition obligations; infrastructure surfaces -> infrastructure obligations)');
  }
  if (derivedObligations.integrationOrComposition.length === 0) {
    return refused('COVERAGE_GAP', 'the architecture contract materializes no integration-or-composition obligation (every scenario realization carries composition surfaces)');
  }

  // The postFreeze.srs.* resolution surfaces must equal the section content
  // (the WP03-declared downstream seam: realizationEntryIds, surfaces,
  // revisionDigest).
  const derivedPostFreeze = postFreezeBlockOf(contract.realization, universe.revisionPins.srsRevisionDigest);
  if (JSON.stringify(derivedPostFreeze) !== JSON.stringify(contract.postFreeze)) {
    return refused('DRIFT_DETECTED', 'the postFreeze block does not equal the exact postFreeze.srs.* resolution surfaces derived from the accepted section (realizationEntryIds / surfaces / revisionDigest)');
  }

  // Canonical digest: recomputed over the sealed content, never trusted.
  if (architectureContractDigestOf(contract) !== contract.canonicalDigest) {
    return refused('DRIFT_DETECTED', `the canonical architecture-contract digest ${String(contract.canonicalDigest)} does not verify against the sealed content`);
  }
  return { ok: true, artifact: { ref: `sha256:${contract.canonicalDigest}`, digest: contract.canonicalDigest, content: contract } };
}
