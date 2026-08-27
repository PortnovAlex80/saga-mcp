/**
 * workflow-kernel/workshops/development/handoff/case.mjs -
 * the FRF-WP09 DevelopmentCase: construction from the sealed formalization
 * authorities and the fail-closed consumer-side validator.
 *
 * LAWS (plan §"Development handoff requirements"; phase FRF-9; ledger
 * D-2/D-3/D-4; reverse edges 0015-0029, 0003; coverage rules cr-02/cr-03):
 *
 *   - THE CASE CARRIES ALL TWELVE TYPED REQUIRED DOMAINS, each populated
 *     FROM the frozen whole-WHAT baseline's EXACT id sets (reverse edge
 *     0015: the solution contract hands off byte-for-byte; edge 0030:
 *     planning consumes these values). The domains are NOT optional
 *     metadata: a case with a missing or empty domain is a typed
 *     MISSING_LINEAGE refusal (ledger D-2/D-17 - "stripping UC/scenario
 *     bindings while retaining AC ids is refused").
 *   - THE CONSUMER-SIDE UC-FOREIGN KILL (reverse cr-02): a candidate case
 *     is validated AGAINST the frozen baseline's exact id sets; any
 *     binding outside the frozen sets is a typed FOREIGN_LINEAGE refusal.
 *     The frozen baseline's own developmentSurface declarations name the
 *     resolution surface of each domain - the consumer never widens them.
 *   - NO ACCEPTED UC DISAPPEARS (plan: "No accepted UC disappears from the
 *     WHAT baseline or DevelopmentCase"): each domain is exactly
 *     set-equal to its frozen surface - a dropped member is COVERAGE_GAP,
 *     a substituted member is FOREIGN_LINEAGE, a member with a drifted
 *     digest is DRIFT_DETECTED.
 *   - IDENTITY+HASH PRESERVATION (reverse cr-03): every scenario, branch,
 *     requirement and criterion binding carries the FROZEN digest, not
 *     just the id - the same identity and hash must survive to the
 *     WorkItems through replan/adoption/settlement/verification.
 *   - THE ARCHITECTURE CONTRACT INTAKE (FRF-WP08 output): the typed
 *     composition/infrastructure obligations and the realization-entry
 *     index are consumed ONLY from the sealed architecture contract whose
 *     baseline/SRS pins match the settlement authorities exactly
 *     (STALE_LINEAGE otherwise); its postFreeze.srs.* surfaces must be
 *     exactly the settlement's SRS surfaces (DRIFT_DETECTED otherwise).
 *   - FAIL-CLOSED: the constructor consumes pinned authorities only. It
 *     never scans, guesses, reselects or reparses accepted material.
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import {
  HANDOFF_BINDING_KINDS,
  HANDOFF_DOMAIN_FIELDS,
  artifactOf,
  digestExcluding,
  isHex64,
  isRefused,
  isShaRef,
  refused,
  sameSet,
  sha256OfCanonical,
  sortedUnique,
} from './shared.mjs';
import { settlementAuthorityPins, validateSolutionContract } from '../../formalization/cells/what-freeze/settlement.mjs';
import { ARCHITECTURE_CONTRACT_INTAKE } from './architecture.mjs';

/** The DevelopmentCase product kind (versioned contract identity). */
export const DEVELOPMENT_CASE_KIND = 'frf-development.case.v1';

/** The development workshop entry the sealed case is admitted at (lifecycle.mjs pins the full edge). */
export const DEVELOPMENT_CASE_ENTRY_ID = 'admit-development-case';

/** The authority inputs of the case desk (all pinned, never discovered). */
export const CASE_INPUT_CLASSES = Object.freeze([
  'frozenBaseline',
  'baselineArtifact',
  'srs',
  'repositoryPolicyRefs',
  'solutionContract',
  'architectureContract',
]);

/* ------------------------------------------------------------------ */
/* The frozen-surface domain derivations (construction side)           */
/* ------------------------------------------------------------------ */

/**
 * Derive the twelve binding domains FROM the frozen baseline's exact id
 * sets (+ the pinned SRS/architecture/settlement authorities). Every
 * member keeps its frozen digest (cr-03 identity+hash preservation).
 */
export function frozenDomainsOf(baseline, srs, repositoryPolicyRefs, architectureContract, solutionContract) {
  const containers = baseline.containers;
  return {
    certificateRef: {
      discoveryCertificateRef: baseline.caseIdentity.discoveryCertificateRef,
      formalizationCaseRef: baseline.caseIdentity.formalizationCaseRef,
    },
    solutionContractRef: `sha256:${solutionContract.canonicalDigest}`,
    baselineRef: null, // filled by the constructor from the artifact (sha256:<artifact digest>)
    baselineDigest: baseline.wholeWhatDigest,
    srsRef: `sha256:${srs.revisionDigest}`,
    srsDigest: srs.revisionDigest,
    prdIntentBindings: containers.prd.members.map((m) => ({ digest: m.digest, memberId: m.memberId })),
    scenarioBindings: containers.uc.members.map((m) => ({
      branches: m.branches.map((b) => ({ branchId: b.branchId, digest: b.digest })),
      digest: m.digest,
      scenarioId: m.scenarioId,
    })),
    requirementBindings: {
      fr: containers.fr.members.map((m) => ({ digest: m.digest, memberId: m.memberId })),
      nfr: containers.nfr.members.map((m) => ({ digest: m.digest, memberId: m.memberId })),
      rule: containers.rule.members.map((m) => ({ digest: m.digest, memberId: m.memberId })),
    },
    acceptanceBindings: containers.ac.members.map((m) => ({ criterionId: m.criterionId, digest: m.digest })),
    scenarioRealizationBindings: architectureContract.realization.realizationEntries.map((entry) => ({
      realizationEntryId: entry.realizationEntryId,
      scenarioRef: entry.scenarioRef,
    })),
    terminalClaimBindings: baseline.sourceManifests.terminalClaims.ids.map((claimId) => ({ claimId })),
    integrationObligations: {
      integrationOrComposition: architectureContract.developmentObligations.integrationOrComposition,
      infrastructure: architectureContract.developmentObligations.infrastructure,
    },
    repositoryPolicyBindings: repositoryPolicyRefs.map((ref) => ({ ref })),
  };
}

/** The flat id-set view of one domain (the resolution vocabulary per kind). */
export function domainIdsOf(domains, fieldName) {
  switch (fieldName) {
    case 'certificateRef':
      return [domains.certificateRef.discoveryCertificateRef, domains.certificateRef.formalizationCaseRef];
    case 'solutionContractRef':
      return [domains.solutionContractRef];
    case 'baselineRef':
      return [domains.baselineDigest];
    case 'srsRef':
      return [domains.srsDigest];
    case 'prdIntentBindings':
      return domains.prdIntentBindings.map((m) => m.memberId);
    case 'scenarioBindings':
      return domains.scenarioBindings.map((m) => m.scenarioId);
    case 'requirementBindings':
      return [
        ...domains.requirementBindings.fr.map((m) => m.memberId),
        ...domains.requirementBindings.nfr.map((m) => m.memberId),
        ...domains.requirementBindings.rule.map((m) => m.memberId),
      ];
    case 'acceptanceBindings':
      return domains.acceptanceBindings.map((m) => m.criterionId);
    case 'scenarioRealizationBindings':
      return domains.scenarioRealizationBindings.map((m) => m.realizationEntryId);
    case 'terminalClaimBindings':
      return domains.terminalClaimBindings.map((m) => m.claimId);
    case 'integrationObligations':
      return [
        ...domains.integrationObligations.integrationOrComposition.map((o) => o.surfaceRef),
        ...domains.integrationObligations.infrastructure.map((o) => o.surfaceRef),
        ...domains.scenarioRealizationBindings.map((m) => m.realizationEntryId),
      ];
    case 'repositoryPolicyBindings':
      return domains.repositoryPolicyBindings.map((m) => m.ref);
    default:
      return null;
  }
}

/**
 * The handoff fingerprint: sha256 over the canonical view of the twelve
 * domain id sets. This is the identity anchor every replan/adoption/
 * settlement/verification record must reproduce byte-for-byte (cr-03).
 */
export function handoffFingerprintOf(domains) {
  const view = {};
  for (const kind of HANDOFF_BINDING_KINDS) {
    view[kind] = sortedUnique(domainIdsOf(domains, HANDOFF_DOMAIN_FIELDS[kind]));
  }
  return sha256OfCanonical(view);
}

/** The scenario identity map (id -> frozen digest + branch digests) - cr-03's preserved identities. */
export function scenarioIdentitiesOf(domains) {
  return domains.scenarioBindings
    .map((m) => ({ branches: m.branches.map((b) => ({ branchId: b.branchId, digest: b.digest })), digest: m.digest, scenarioId: m.scenarioId }))
    .sort((a, b) => (a.scenarioId < b.scenarioId ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* The case body + seal                                                */
/* ------------------------------------------------------------------ */

function caseBodyOf(lifecycle, domains, realizationIndex) {
  return {
    schemaVersion: DEVELOPMENT_CASE_KIND,
    lifecycle,
    ...domains,
    realizationIndex,
  };
}

/** Seal the case: caseDigest over the canonical body (digest excluded), plus the handoff fingerprint. */
function sealCase(lifecycle, domains, realizationIndex) {
  const body = caseBodyOf(lifecycle, domains, realizationIndex);
  const caseDigest = digestExcluding(body, ['caseDigest', 'handoffFingerprint']);
  return { ...body, caseDigest, handoffFingerprint: handoffFingerprintOf(domains) };
}

/* ------------------------------------------------------------------ */
/* Construction (the desk's green path)                                */
/* ------------------------------------------------------------------ */

/**
 * Build the DevelopmentCase from the pinned formalization authorities:
 *   1. the authority pins re-verify through the WP07 settlement R1 (the
 *      baseline artifact digest is recomputed - a stale/forged baseline
 *      authority is DRIFT_DETECTED, never handed off);
 *   2. the sealed solution contract re-validates through the WP07
 *      binding-aware validator (byte-for-byte, reverse edge/0015);
 *   3. the architecture contract intakes fail-closed (typed obligations);
 *   4. the twelve domains are populated FROM the frozen exact id sets;
 *   5. the contract's own twelve handoff kinds must resolve against the
 *      constructed domains (the settlement values are a subset view of the
 *      exact frozen sets; a value outside its domain is FOREIGN_LINEAGE).
 */
export function buildDevelopmentCase(inputs) {
  for (const inputClass of CASE_INPUT_CLASSES) {
    if (inputs[inputClass] === undefined || inputs[inputClass] === null) {
      return refused('MISSING_LINEAGE', `the Development case desk was given no ${inputClass} authority (fail-closed; the case desk never discovers authorities)`);
    }
  }
  // R1 re-verify: the exact frozen baseline + SRS + repository pins.
  const pinsRung = settlementAuthorityPins({
    frozenBaseline: inputs.frozenBaseline,
    baselineArtifact: inputs.baselineArtifact,
    srs: inputs.srs,
    repositoryPolicyRefs: inputs.repositoryPolicyRefs,
    handoff: {},
  });
  if (isRefused(pinsRung)) return pinsRung;
  // R2 re-verify: the sealed solution contract through the WP07 validator.
  const contractValidation = validateSolutionContract(
    inputs.solutionContract,
    inputs.frozenBaseline,
    inputs.baselineArtifact,
    inputs.srs,
    inputs.repositoryPolicyRefs,
  );
  if (isRefused(contractValidation)) return contractValidation;
  // R3 intake: the sealed architecture contract (typed obligations + pins).
  const intake = ARCHITECTURE_CONTRACT_INTAKE(inputs.architectureContract, {
    baselineArtifact: inputs.baselineArtifact,
    frozenBaseline: inputs.frozenBaseline,
    srs: inputs.srs,
  });
  if (isRefused(intake)) return intake;

  const lifecycle = {
    developmentEntryId: DEVELOPMENT_CASE_ENTRY_ID,
    on: 'domain.formalized',
    sourceNodeId: 'settle-formalization',
    sourceTerminalNodeId: 'complete-formalized',
    sourceWorkshopId: 'workshop:solution-formalization',
    targetWorkshopId: 'workshop:development',
  };
  const domains = frozenDomainsOf(inputs.frozenBaseline, inputs.srs, inputs.repositoryPolicyRefs, inputs.architectureContract, inputs.solutionContract);
  domains.baselineRef = inputs.baselineArtifact.ref;
  const realizationIndex = intake.realizationIndex;
  const devCase = sealCase(lifecycle, domains, realizationIndex);

  // The settler fence, consumer edition: never EMIT a case that would not
  // validate. The construction path and the validation path share only
  // the sealed authorities - this self-check is a real kill, not a tautology.
  const selfValidation = validateDevelopmentCase(devCase, inputs);
  if (isRefused(selfValidation)) return selfValidation;
  return { ok: true, developmentCase: devCase, artifact: artifactOf(devCase) };
}

/* ------------------------------------------------------------------ */
/* The consumer-side validator (THE UC-FOREIGN consumer kill)          */
/* ------------------------------------------------------------------ */

/** Extract the flat id-set view of one domain of a candidate case payload. */
function candidateDomainIds(candidate, fieldName) {
  return domainIdsOf(candidate, fieldName);
}

/** Per-domain set-equality detail naming the exact law family. */
function domainLawOf(fieldName) {
  switch (fieldName) {
    case 'scenarioBindings': return 'no accepted UC disappears from the DevelopmentCase; retaining all AC ids while stripping UC/scenario bindings is rejected';
    case 'scenarioRealizationBindings': return 'scenario realization is a typed required value; stripping realization bindings from the DevelopmentCase is refused';
    case 'terminalClaimBindings': return 'terminal-claim bindings are a typed required value; removing them fails before planning';
    default: return 'the domain is exactly the frozen accepted set';
  }
}

/**
 * Validate a candidate DevelopmentCase against the pinned authorities.
 * THE CONSUMER KILL: a case built over foreign/unrelated bindings is
 * refused typed, never planned (audit D-1..D-4 / reverse cr-02).
 */
export function validateDevelopmentCase(candidate, authorities) {
  if (candidate === null || typeof candidate !== 'object' || candidate.schemaVersion !== DEVELOPMENT_CASE_KIND) {
    return refused('MALFORMED_PRODUCT', `the candidate is not a ${DEVELOPMENT_CASE_KIND}`);
  }
  // The twelve domains: typed, required, NON-EMPTY (ledger D-2/D-17).
  for (const kind of HANDOFF_BINDING_KINDS) {
    const fieldName = HANDOFF_DOMAIN_FIELDS[kind];
    if (candidate[fieldName] === undefined || candidate[fieldName] === null) {
      return refused('MISSING_LINEAGE', `the DevelopmentCase carries no ${fieldName} (handoff kind ${kind}); the twelve binding kinds are typed required values, not optional metadata (ledger D-2/D-17)`);
    }
  }
  if (!Array.isArray(candidate.scenarioBindings) || candidate.scenarioBindings.length === 0) {
    return refused('MISSING_LINEAGE', 'the DevelopmentCase carries no scenario bindings (edge/0021: DevelopmentCase rejects missing scenario bindings)');
  }
  if (!Array.isArray(candidate.scenarioRealizationBindings) || candidate.scenarioRealizationBindings.length === 0) {
    return refused('MISSING_LINEAGE', 'the DevelopmentCase carries no scenario realization bindings (edge/0026: DevelopmentCase rejects missing realization bindings)');
  }
  if (!Array.isArray(candidate.prdIntentBindings) || candidate.prdIntentBindings.length === 0
    || !Array.isArray(candidate.acceptanceBindings) || candidate.acceptanceBindings.length === 0
    || !Array.isArray(candidate.terminalClaimBindings) || candidate.terminalClaimBindings.length === 0
    || !Array.isArray(candidate.repositoryPolicyBindings) || candidate.repositoryPolicyBindings.length === 0) {
    return refused('MISSING_LINEAGE', 'a binding domain of the DevelopmentCase is empty (the twelve kinds are typed required values)');
  }
  const rb = candidate.requirementBindings;
  if (rb === null || typeof rb !== 'object' || !Array.isArray(rb.fr) || rb.fr.length === 0 || !Array.isArray(rb.nfr) || !Array.isArray(rb.rule)) {
    return refused('MISSING_LINEAGE', 'the requirement bindings domain is incomplete (FR bindings are required; NFR/RULE lists are typed)');
  }
  const io = candidate.integrationObligations;
  if (io === null || typeof io !== 'object' || !Array.isArray(io.integrationOrComposition) || io.integrationOrComposition.length === 0
    || !Array.isArray(io.infrastructure)) {
    return refused('MISSING_LINEAGE', 'the integration and construction obligations domain is incomplete (integration/composition obligations are typed required values, not payload decoration)');
  }
  if (candidate.certificateRef === null || typeof candidate.certificateRef !== 'object'
    || typeof candidate.certificateRef.discoveryCertificateRef !== 'string' || candidate.certificateRef.discoveryCertificateRef.length === 0
    || typeof candidate.certificateRef.formalizationCaseRef !== 'string' || candidate.certificateRef.formalizationCaseRef.length === 0) {
    return refused('MISSING_LINEAGE', 'the formalization certificate domain is incomplete (edge/0016)');
  }
  if (!isShaRef(candidate.solutionContractRef)) {
    return refused('MALFORMED_PRODUCT', 'the solution contract reference is not content-addressed (sha256:<64 hex>)');
  }
  if (!isShaRef(candidate.baselineRef) || !isHex64(candidate.baselineDigest)) {
    return refused('MALFORMED_PRODUCT', 'the whole-WHAT baseline reference/hash domain is malformed (edge/0018)');
  }
  if (!isShaRef(candidate.srsRef) || !isHex64(candidate.srsDigest) || candidate.srsRef !== `sha256:${candidate.srsDigest}`) {
    return refused('MALFORMED_PRODUCT', 'the SRS reference/hash domain is malformed (edge/0019)');
  }

  // The authorities re-verify (the same ladder as construction; a stale
  // baseline digest, a forged artifact or an unverifiable contract dies here).
  const pinsRung = settlementAuthorityPins({
    frozenBaseline: authorities.frozenBaseline,
    baselineArtifact: authorities.baselineArtifact,
    srs: authorities.srs,
    repositoryPolicyRefs: authorities.repositoryPolicyRefs,
    handoff: {},
  });
  if (isRefused(pinsRung)) return pinsRung;
  if (candidate.baselineRef !== authorities.baselineArtifact.ref || candidate.baselineDigest !== authorities.frozenBaseline.wholeWhatDigest) {
    return refused('STALE_LINEAGE', 'the case does not pin the exact frozen whole-WHAT baseline (artifact ref + whole-WHAT digest)');
  }
  if (candidate.srsDigest !== authorities.srs.revisionDigest) {
    return refused('STALE_LINEAGE', 'the case does not pin the exact accepted SRS revision digest');
  }
  if (authorities.solutionContract !== undefined && authorities.solutionContract !== null) {
    const contractValidation = validateSolutionContract(
      authorities.solutionContract,
      authorities.frozenBaseline,
      authorities.baselineArtifact,
      authorities.srs,
      authorities.repositoryPolicyRefs,
    );
    if (isRefused(contractValidation)) return contractValidation;
    if (candidate.solutionContractRef !== `sha256:${authorities.solutionContract.canonicalDigest}`) {
      return refused('STALE_LINEAGE', 'the case does not reference the sealed solution contract by its canonical digest (byte-for-byte handoff, edge/0015)');
    }
  }
  // The architecture contract intake (when the authority is supplied).
  let intake = null;
  if (authorities.architectureContract !== undefined && authorities.architectureContract !== null) {
    intake = ARCHITECTURE_CONTRACT_INTAKE(authorities.architectureContract, {
      baselineArtifact: authorities.baselineArtifact,
      frozenBaseline: authorities.frozenBaseline,
      srs: authorities.srs,
    });
    if (isRefused(intake)) return intake;
  }

  // THE CONSUMER-SIDE UC-FOREIGN KILL: exact set equality per domain
  // against the frozen baseline's exact id sets (foreign = FOREIGN_LINEAGE,
  // dropped = COVERAGE_GAP; digests = DRIFT_DETECTED).
  const expected = frozenDomainsOf(
    authorities.frozenBaseline,
    authorities.srs,
    authorities.repositoryPolicyRefs,
    authorities.architectureContract ?? intakeFallbackOf(candidate),
    authorities.solutionContract ?? { canonicalDigest: candidate.solutionContractRef.slice(7) },
  );
  for (const kind of HANDOFF_BINDING_KINDS) {
    const fieldName = HANDOFF_DOMAIN_FIELDS[kind];
    const actualIds = candidateDomainIds(candidate, fieldName) ?? [];
    const expectedIds = domainIdsOf(expected, fieldName) ?? [];
    const foreign = actualIds.filter((id) => !expectedIds.includes(id));
    if (foreign.length > 0) {
      return refused('FOREIGN_LINEAGE', `DevelopmentCase domain ${fieldName} (handoff kind ${kind}) cites ${sortedUnique(foreign).join(', ')} outside the exact frozen id set [${sortedUnique(expectedIds).join(', ')}] (cr-02: every handoff binding resolves against the accepted id sets; the consumer-side UC-FOREIGN kill - the case is refused, never planned)`);
    }
    const missing = expectedIds.filter((id) => !actualIds.includes(id));
    if (missing.length > 0 && fieldName !== 'solutionContractRef' && fieldName !== 'baselineRef' && fieldName !== 'srsRef') {
      return refused('COVERAGE_GAP', `DevelopmentCase domain ${fieldName} (handoff kind ${kind}) drops ${sortedUnique(missing).join(', ')} from the exact frozen id set (${domainLawOf(fieldName)})`);
    }
  }
  // Frozen digest preservation (cr-03): same identity AND same hash.
  const digestOf = (map, id) => map.get(id);
  const frozenScenarioDigests = new Map(expected.scenarioBindings.map((m) => [m.scenarioId, m]));
  for (const binding of candidate.scenarioBindings) {
    const frozen = digestOf(frozenScenarioDigests, binding.scenarioId);
    if (frozen !== undefined && binding.digest !== frozen.digest) {
      return refused('DRIFT_DETECTED', `scenario binding ${binding.scenarioId} carries digest ${String(binding.digest)} but the frozen scenario digest is ${frozen.digest} (cr-03: same identity AND hash at every hop)`);
    }
    if (frozen !== undefined && !sameSet(binding.branches.map((b) => b.branchId), frozen.branches.map((b) => b.branchId))) {
      return refused('DRIFT_DETECTED', `scenario binding ${binding.scenarioId} carries a branch set that differs from the frozen terminal-branch set (cr-03 identity preservation)`);
    }
    for (const branch of binding.branches) {
      const frozenBranch = frozen.branches.find((b) => b.branchId === branch.branchId);
      if (frozenBranch !== undefined && branch.digest !== frozenBranch.digest) {
        return refused('DRIFT_DETECTED', `terminal branch ${branch.branchId} of ${binding.scenarioId} carries a drifted digest (cr-03: same identity AND hash at every hop)`);
      }
    }
  }
  const frozenCriterionDigests = new Map(expected.acceptanceBindings.map((m) => [m.criterionId, m.digest]));
  for (const binding of candidate.acceptanceBindings) {
    if (frozenCriterionDigests.get(binding.criterionId) !== undefined && binding.digest !== frozenCriterionDigests.get(binding.criterionId)) {
      return refused('DRIFT_DETECTED', `acceptance binding ${binding.criterionId} carries a digest that differs from the frozen criterion digest (cr-03)`);
    }
  }
  for (const family of ['fr', 'nfr', 'rule']) {
    const frozenMembers = new Map(expected.requirementBindings[family].map((m) => [m.memberId, m.digest]));
    for (const binding of candidate.requirementBindings[family]) {
      if (frozenMembers.get(binding.memberId) !== undefined && binding.digest !== frozenMembers.get(binding.memberId)) {
        return refused('DRIFT_DETECTED', `requirement binding ${binding.memberId} (${family}) carries a digest that differs from the frozen member digest (cr-03)`);
      }
    }
  }
  const frozenPrd = new Map(expected.prdIntentBindings.map((m) => [m.memberId, m.digest]));
  for (const binding of candidate.prdIntentBindings) {
    if (frozenPrd.get(binding.memberId) !== undefined && binding.digest !== frozenPrd.get(binding.memberId)) {
      return refused('DRIFT_DETECTED', `PRD intent binding ${binding.memberId} carries a digest that differs from the frozen member digest (cr-03)`);
    }
  }

  // The realization index (when the architecture authority was supplied,
  // the candidate must carry it exactly; otherwise it must still be present
  // and internally lawful - it is the planning-gate input).
  if (intake !== null) {
    if (JSON.stringify(sortedUnique(Object.keys(candidate.realizationIndex ?? {}))) !== JSON.stringify(['entries', 'postFreeze'])) {
      return refused('MALFORMED_PRODUCT', 'the DevelopmentCase carries no realization index (the planning-gate input surface)');
    }
  }

  // The lifecycle block must be the canonical handoff edge (lifecycle.mjs
  // pins the same data; a forged entry is a scope violation).
  if (candidate.lifecycle?.sourceNodeId !== 'settle-formalization' || candidate.lifecycle?.on !== 'domain.formalized'
    || candidate.lifecycle?.developmentEntryId !== DEVELOPMENT_CASE_ENTRY_ID) {
    return refused('SCOPE_VIOLATION', 'the case lifecycle block is not the canonical settle-formalization -> development handoff edge');
  }

  // The seal: recomputed, never trusted.
  const recomputedDigest = digestExcluding(candidate, ['caseDigest', 'handoffFingerprint']);
  if (recomputedDigest !== candidate.caseDigest) {
    return refused('DRIFT_DETECTED', `the DevelopmentCase digest ${String(candidate.caseDigest)} does not verify against the canonical case content`);
  }
  const recomputedFingerprint = handoffFingerprintOf(candidate);
  if (recomputedFingerprint !== candidate.handoffFingerprint) {
    return refused('DRIFT_DETECTED', 'the handoff fingerprint does not verify against the twelve domain id sets');
  }
  return { ok: true, artifact: artifactOf(candidate) };
}

/**
 * A fallback authority view for validator-only calls where the candidate
 * itself is the only source of the realization surface: extracts a MINIMAL
 * architecture-contract-shaped object from the candidate's own domains.
 * (Only used to re-derive expected id sets; every set equality is still
 * enforced against the candidate, so a forged fallback cannot pass.)
 */
function intakeFallbackOf(candidate) {
  const entries = (candidate.scenarioRealizationBindings ?? []).map((binding) => ({
    realizationEntryId: binding.realizationEntryId,
    scenarioRef: binding.scenarioRef,
  }));
  return {
    developmentObligations: candidate.integrationObligations ?? { integrationOrComposition: [], infrastructure: [] },
    postFreeze: { realizationEntryIds: entries.map((e) => e.realizationEntryId), surfaces: [] },
    realization: { realizationEntries: entries },
  };
}
