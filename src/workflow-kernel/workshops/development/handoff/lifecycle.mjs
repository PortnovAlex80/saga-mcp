/**
 * workflow-kernel/workshops/development/handoff/lifecycle.mjs -
 * the FRF-WP09 lifecycle mapping: the settle-formalization ->
 * Development handoff edge (plan phase FRF-9 row "Update lifecycle
 * mapping with exact byte-for-byte handoff tests").
 *
 * LAWS (plan §"Target process graph"; reverse edge/0015
 * hands-off-byte-for-byte: "Formalization output maps byte-for-byte to
 * Development input for every authoritative field"):
 *
 *   - ONLY the `formalized` outcome of the settle-formalization desk
 *     hands off: `settle-formalization --domain.formalized-->
 *     complete-formalized` is the one edge whose target is the
 *     Development entry. The inconsistent/failed terminals carry NO
 *     Development material (a settlement that did not seal a contract
 *     is refused at the mapping, MISSING_LINEAGE).
 *   - THE BYTE-FOR-BYTE MAP: every authoritative field of the sealed
 *     solution contract equals its DevelopmentCase field exactly -
 *     whatBaselineRef === baselineRef, wholeWhatDigest ===
 *     baselineDigest, srsRef === srsRef, and each of the twelve
 *     contract handoff kinds' values resolve against the case's binding
 *     domain (DRIFT_DETECTED / FOREIGN_LINEAGE otherwise). The mapping
 *     never rewrites, re-derives or widens a field.
 *   - The mapping is DATA (one frozen edge + one pure function); the
 *     workshop identity rows are the installed manifest ids
 *     (workshop:solution-formalization / workshop:development), pinned
 *     by the blocking seam test.
 *
 * PURITY: pure data + pure functions. No I/O, no session, no clock.
 */

import { isRefused, refused, sortedUnique } from './shared.mjs';
import { DEVELOPMENT_CASE_ENTRY_ID } from './case.mjs';

/** The one formalization -> Development lifecycle handoff edge (data). */
export const FORMALIZATION_TO_DEVELOPMENT_EDGE = Object.freeze({
  carries: Object.freeze([
    'acceptance-bindings',
    'formalization-certificate',
    'integration-and-construction-obligations',
    'prd-intent-bindings',
    'repository-and-policy-bindings',
    'requirement-bindings',
    'scenario-bindings',
    'scenario-realization-bindings',
    'solution-contract',
    'srs-reference-and-hash',
    'terminal-claim-bindings',
    'what-baseline-reference-and-hash',
  ]),
  from: Object.freeze({
    nodeId: 'settle-formalization',
    on: 'domain.formalized',
    terminalNodeId: 'complete-formalized',
    workshopId: 'workshop:solution-formalization',
  }),
  kind: 'lifecycle-handoff',
  to: Object.freeze({
    developmentEntryId: DEVELOPMENT_CASE_ENTRY_ID,
    workshopId: 'workshop:development',
  }),
});

/** The domain field carried per handoff kind on this edge (byte-for-byte surface). */
export const CARRIED_FIELD_OF_KIND = Object.freeze({
  'acceptance-bindings': 'acceptanceBindings',
  'formalization-certificate': 'certificateRef',
  'integration-and-construction-obligations': 'integrationObligations',
  'prd-intent-bindings': 'prdIntentBindings',
  'repository-and-policy-bindings': 'repositoryPolicyBindings',
  'requirement-bindings': 'requirementBindings',
  'scenario-bindings': 'scenarioBindings',
  'scenario-realization-bindings': 'scenarioRealizationBindings',
  'solution-contract': 'solutionContractRef',
  'srs-reference-and-hash': 'srsRef',
  'terminal-claim-bindings': 'terminalClaimBindings',
  'what-baseline-reference-and-hash': 'baselineRef',
});

/** The id-set view of one DevelopmentCase domain (for the subset check). */
function caseDomainIds(devCase, fieldName) {
  switch (fieldName) {
    case 'certificateRef':
      return [devCase.certificateRef.discoveryCertificateRef, devCase.certificateRef.formalizationCaseRef];
    case 'solutionContractRef':
      return [devCase.solutionContractRef];
    case 'srsRef':
      return [devCase.srsDigest];
    case 'baselineRef':
      return [devCase.baselineDigest];
    case 'prdIntentBindings':
      return devCase.prdIntentBindings.map((m) => m.memberId);
    case 'scenarioBindings':
      return devCase.scenarioBindings.map((m) => m.scenarioId);
    case 'requirementBindings':
      return [
        ...devCase.requirementBindings.fr.map((m) => m.memberId),
        ...devCase.requirementBindings.nfr.map((m) => m.memberId),
        ...devCase.requirementBindings.rule.map((m) => m.memberId),
      ];
    case 'acceptanceBindings':
      return devCase.acceptanceBindings.map((m) => m.criterionId);
    case 'scenarioRealizationBindings':
      return devCase.scenarioRealizationBindings.map((m) => m.realizationEntryId);
    case 'terminalClaimBindings':
      return devCase.terminalClaimBindings.map((m) => m.claimId);
    case 'integrationObligations':
      return [
        ...devCase.integrationObligations.integrationOrComposition.map((o) => o.surfaceRef),
        ...devCase.integrationObligations.infrastructure.map((o) => o.surfaceRef),
        ...devCase.scenarioRealizationBindings.map((m) => m.realizationEntryId),
      ];
    case 'repositoryPolicyBindings':
      return devCase.repositoryPolicyBindings.map((m) => m.ref);
    default:
      return [];
  }
}

/**
 * Map a settled formalization outcome to the Development stage entry.
 * Only `formalized` (domain.formalized -> complete-formalized) hands
 * off; every other settle outcome is refused typed at the mapping.
 */
export function mapSettlementToDevelopmentEntry(settled) {
  if (settled === null || typeof settled !== 'object') {
    return refused('MISSING_LINEAGE', 'the lifecycle mapping consumes a settled settle-formalization outcome (fail-closed)');
  }
  if (settled.ok !== true || settled.outcome !== 'formalized' || settled.contract === null || settled.contract === undefined) {
    return refused('MISSING_LINEAGE', `the settle-formalization outcome ${String(settled?.outcome)} carries no sealed solution contract; only domain.formalized (complete-formalized) hands off to Development`);
  }
  return { edge: FORMALIZATION_TO_DEVELOPMENT_EDGE, entry: FORMALIZATION_TO_DEVELOPMENT_EDGE.to.developmentEntryId, ok: true };
}

/**
 * The byte-for-byte handoff record: every authoritative field of the
 * sealed solution contract maps exactly onto the DevelopmentCase.
 * Returns the mapping evidence or a typed refusal (edge/0015).
 */
export function lifecycleHandoffRecord(settled, devCase) {
  const mapping = mapSettlementToDevelopmentEntry(settled);
  if (isRefused(mapping)) return mapping;
  const contract = settled.contract;
  if (contract.whatBaselineRef !== devCase.baselineRef) {
    return refused('DRIFT_DETECTED', `the contract pins WHAT baseline ${contract.whatBaselineRef}; the DevelopmentCase pins ${devCase.baselineRef} (byte-for-byte handoff, edge/0015)`);
  }
  if (contract.wholeWhatDigest !== devCase.baselineDigest) {
    return refused('DRIFT_DETECTED', `the contract pins whole-WHAT digest ${contract.wholeWhatDigest}; the DevelopmentCase pins ${devCase.baselineDigest} (byte-for-byte handoff)`);
  }
  if (contract.srsRef !== devCase.srsRef) {
    return refused('DRIFT_DETECTED', `the contract pins SRS ${contract.srsRef}; the DevelopmentCase pins ${devCase.srsRef} (byte-for-byte handoff)`);
  }
  if (devCase.solutionContractRef !== `sha256:${contract.canonicalDigest}`) {
    return refused('DRIFT_DETECTED', 'the DevelopmentCase does not reference the sealed solution contract by its canonical digest (byte-for-byte handoff)');
  }
  for (const [kind, carriedField] of Object.entries(CARRIED_FIELD_OF_KIND)) {
    const values = contract.developmentHandoff?.[kind]?.values;
    if (!Array.isArray(values) || values.length === 0) {
      return refused('MISSING_LINEAGE', `the sealed contract carries no values for handoff kind ${kind} (the twelve kinds are typed required values)`);
    }
    if (carriedField === 'solutionContractRef') continue; // the self-seal kind: checked above via canonicalDigest
    const domain = caseDomainIds(devCase, carriedField);
    const foreign = values.filter((value) => !domain.includes(value));
    if (foreign.length > 0) {
      return refused('FOREIGN_LINEAGE', `the contract's ${kind} values ${sortedUnique(foreign).join(', ')} do not resolve against the DevelopmentCase ${carriedField} domain [${sortedUnique(domain).join(', ')}] (byte-for-byte handoff: the case domains are exactly the frozen resolution surfaces)`);
    }
  }
  return {
    carried: [...FORMALIZATION_TO_DEVELOPMENT_EDGE.carries],
    edge: FORMALIZATION_TO_DEVELOPMENT_EDGE,
    handoffFingerprint: devCase.handoffFingerprint,
    ok: true,
    solutionContractRef: devCase.solutionContractRef,
  };
}
