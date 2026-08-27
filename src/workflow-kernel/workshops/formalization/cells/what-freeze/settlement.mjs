/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/settlement.mjs -
 * the settle-formalization desk (FRF-WP07): the settlement ladder and the
 * content-addressed Solution Contract.
 *
 * LAWS (plan §"Desk contracts"/settle-formalization; ledger D-1/D-12/A2;
 * reverse cr-02):
 *   - Settlement consumes the EXACT frozen whole-WHAT baseline and the
 *     exact accepted SRS revision. It must not rediscover accepted
 *     artifacts or reparse mutable source files (no scan path exists in
 *     this module; the authorities arrive pinned).
 *   - THE UC-FOREIGN KILL AT THE CONTRACT LEVEL (cr-02 / ledger D-1):
 *     every Development handoff binding resolves against the FROZEN
 *     baseline's exact id sets - the baseline's own
 *     `developmentSurface.handoffBindingKinds[kind].resolvesAgainst`
 *     declaration IS the accepted universe. A binding outside the named
 *     frozen surface is a typed FOREIGN_LINEAGE refusal. The WP03
 *     baseline validator's Development resolution surface is the accepted
 *     universe; settlement never widens it.
 *   - ALL TWELVE handoff kinds carry typed, required, NON-EMPTY values
 *     (ledger D-2/D-17: bindings are not optional metadata; stripping
 *     UC/scenario bindings while retaining AC ids is refused).
 *   - THE SETTLER FENCE (ledger D-12 note / A2): settlement must not
 *     EMIT a contract it could not validate - settleSolutionContract
 *     validates its own output through the same resolver before
 *     returning it.
 *   - THE SETTLEMENT LADDER (three deterministic rungs, each a
 *     content-addressed product; the first failing rung decides):
 *       R1 authority-pins     - both authorities pinned exactly;
 *       R2 binding-resolution - the twelve kinds resolved;
 *       R3 sealed-contract    - one canonical digest over the contract.
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import {
  artifactOf,
  HANDOFF_BINDING_KINDS,
  isRefused,
  refused,
  sha256OfCanonical,
} from './shared.mjs';
import { SETTLE_OUTCOME_OF_REASON, SOLUTION_CONTRACT_PRODUCT_KIND, routeRefusal } from './protocol.mjs';

/* ------------------------------------------------------------------ */
/* The settlement authorities (pinned, never discovered)                */
/* ------------------------------------------------------------------ */

/** The settle desk's authority input classes (fail-closed presence fence). */
export const SETTLEMENT_INPUT_CLASSES = Object.freeze([
  'frozenBaseline',
  'baselineArtifact',
  'srs',
  'repositoryPolicyRefs',
  'handoff',
]);

const SELF_SEAL_SURFACE = 'postFreeze.settlement.solutionContractDigest';

const isShaRef = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** The SRS post-freeze authority surface (realization entries + construction surfaces). */
export function srsAuthorityOf(srs) {
  if (srs === null || typeof srs !== 'object' || !isHex64(srs.revisionDigest)
    || !Array.isArray(srs.realizationEntryIds) || !Array.isArray(srs.surfaces)) {
    return refused('MISSING_LINEAGE', 'settlement consumes the exact accepted SRS revision (revision digest + realization entry ids + construction surfaces); fail-closed');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The frozen-surface resolver (THE UC-FOREIGN kill)                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve one named resolution surface of the frozen baseline to its
 * exact accepted id set / pinned scalar. The surface vocabulary is the
 * closed WP03 list; an unknown surface name is refused (fail-closed).
 */
function frozenSurfaceValues(surfaceName, authorities) {
  const { baseline, srs, repositoryPolicyRefs } = authorities;
  switch (surfaceName) {
    case 'caseIdentity.discoveryCertificateRef':
      return { scalar: baseline.caseIdentity.discoveryCertificateRef };
    case 'caseIdentity.formalizationCaseRef':
      return { scalar: baseline.caseIdentity.formalizationCaseRef };
    case 'containers.ac.criterionIds':
      return { set: baseline.containers.ac.members.map((m) => m.criterionId) };
    case 'containers.fr.memberIds':
      return { set: baseline.containers.fr.members.map((m) => m.memberId) };
    case 'containers.nfr.memberIds':
      return { set: baseline.containers.nfr.members.map((m) => m.memberId) };
    case 'containers.prd.memberIds':
      return { set: baseline.containers.prd.members.map((m) => m.memberId) };
    case 'containers.rule.memberIds':
      return { set: baseline.containers.rule.members.map((m) => m.memberId) };
    case 'containers.uc.scenarioIds':
      return { set: baseline.containers.uc.members.map((m) => m.scenarioId) };
    case 'sourceManifests.claimIds':
      return { set: baseline.sourceManifests.claims.ids };
    case 'sourceManifests.constraintIds':
      return { set: baseline.sourceManifests.constraints.ids };
    case 'sourceManifests.terminalClaimIds':
      return { set: baseline.sourceManifests.terminalClaims.ids };
    case 'postFreeze.srs.realizationEntryIds':
      return { set: srs.realizationEntryIds };
    case 'postFreeze.srs.revisionDigest':
      return { scalar: srs.revisionDigest };
    case 'postFreeze.srs.surfaces':
      return { set: srs.surfaces };
    case 'postFreeze.development.repositoryPolicyRefs':
      return { set: repositoryPolicyRefs };
    case SELF_SEAL_SURFACE:
      // Resolved by the sealed-contract rung (the contract's own seal).
      return { selfSeal: true };
    case 'wholeWhatDigest':
      return { scalar: baseline.wholeWhatDigest };
    default:
      return refused('MALFORMED_PRODUCT', `the frozen baseline names resolution surface ${String(surfaceName)} outside the closed WP03 vocabulary`);
  }
}

/** Resolve one handoff kind's values against its declared frozen surfaces. */
function resolveHandoffKind(kind, values, authorities) {
  const declaredSurfaces = authorities.baseline.developmentSurface?.handoffBindingKinds?.[kind]?.resolvesAgainst;
  if (!Array.isArray(declaredSurfaces) || declaredSurfaces.length === 0) {
    return refused('MALFORMED_PRODUCT', `the frozen baseline declares no resolution surface for handoff kind ${kind} (the baseline's Development surface is the accepted universe)`);
  }
  const union = new Set();
  let selfSeal = false;
  for (const surfaceName of declaredSurfaces) {
    const resolved = frozenSurfaceValues(surfaceName, authorities);
    if (isRefused(resolved)) return resolved;
    if (resolved.selfSeal === true) selfSeal = true;
    else if (resolved.set !== undefined) for (const id of resolved.set) union.add(id);
    else if (resolved.scalar !== undefined) union.add(resolved.scalar);
  }
  const foreign = values.filter((value) => !union.has(value));
  if (foreign.length > 0 && union.size > 0) {
    return refused('FOREIGN_LINEAGE', `handoff kind ${kind} cites ${foreign.sort().join(', ')} outside the exact frozen surface(s) [${declaredSurfaces.join(', ')}] (cr-02: every handoff binding resolves against the accepted id sets; the UC-FOREIGN reproduction is killed here)`);
  }
  if (foreign.length > 0 && union.size === 0 && !selfSeal) {
    return refused('FOREIGN_LINEAGE', `handoff kind ${kind} cites ${foreign.sort().join(', ')} outside its declared frozen surfaces`);
  }
  // A pure self-seal surface (postFreeze.settlement.solutionContractDigest)
  // cannot resolve at binding time by construction: the sealed-contract
  // rung asserts the self-seal digest instead (sealSolutionContract).
  return { ok: true, selfSeal: selfSeal && union.size === 0 };
}

/* ------------------------------------------------------------------ */
/* The settlement ladder                                               */
/* ------------------------------------------------------------------ */

/** R1 - the authority pins: both authorities sealed and exact. */
export function settlementAuthorityPins(inputs) {
  for (const inputClass of SETTLEMENT_INPUT_CLASSES) {
    if (inputs[inputClass] === undefined || inputs[inputClass] === null) {
      return refused('MISSING_LINEAGE', `settlement was given no ${inputClass} input (fail-closed; settlement never discovers authorities)`);
    }
  }
  const srsRefusal = srsAuthorityOf(inputs.srs);
  if (srsRefusal !== null) return srsRefusal;
  if (!Array.isArray(inputs.repositoryPolicyRefs) || inputs.repositoryPolicyRefs.length === 0) {
    return refused('MISSING_LINEAGE', 'no post-freeze repository/policy authority refs were supplied');
  }
  const artifact = inputs.baselineArtifact;
  if (!isShaRef(artifact?.ref) || !isHex64(artifact?.digest) || artifact.ref !== `sha256:${artifact.digest}`) {
    return refused('MALFORMED_PRODUCT', 'the baseline kernel-evidence artifact is not a content-addressed ref (sha256:<64 hex> with matching digest)');
  }
  const recomputed = sha256OfCanonical(inputs.frozenBaseline);
  if (recomputed !== artifact.digest) {
    return refused('DRIFT_DETECTED', `the supplied frozen baseline does not verify against its pinned artifact digest (pinned ${artifact.digest}, recomputed ${recomputed}); settlement refuses a forged or partially-substituted authority`);
  }
  const pins = {
    productKind: SOLUTION_CONTRACT_PRODUCT_KIND,
    baselineRef: artifact.ref,
    baselineWholeWhatDigest: inputs.frozenBaseline.wholeWhatDigest,
    srsRevisionDigest: inputs.srs.revisionDigest,
  };
  return { ok: true, rung: 'authority-pins', artifact: artifactOf(pins), pins };
}

/** R2 - the binding resolution record: the twelve kinds, non-empty, resolved. */
export function settlementBindingResolution(inputs, pins) {
  const authorities = { baseline: inputs.frozenBaseline, srs: inputs.srs, repositoryPolicyRefs: inputs.repositoryPolicyRefs };
  const handoff = inputs.handoff;
  if (handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) {
    return refused('MISSING_LINEAGE', 'settlement was given no typed Development handoff values');
  }
  const present = Object.keys(handoff).sort();
  const expected = [...HANDOFF_BINDING_KINDS].sort();
  if (present.join('\u0000') !== expected.join('\u0000')) {
    const missing = expected.filter((kind) => !present.includes(kind));
    const extra = present.filter((kind) => !expected.includes(kind));
    if (missing.length > 0) {
      return refused('MISSING_LINEAGE', `the Development handoff is missing typed required value(s): ${missing.join(', ')} (ledger D-2/D-17: the twelve kinds are not optional metadata; stripping UC/scenario bindings is refused)`);
    }
    return refused('MALFORMED_PRODUCT', `the handoff declares unknown binding kind(s): ${extra.join(', ')}`);
  }
  const resolution = {};
  const selfSealKinds = [];
  for (const kind of HANDOFF_BINDING_KINDS) {
    // The input form is the raw values array; a re-validation of a sealed
    // contract passes the resolution-record form ({values, resolvedAgainst}).
    const entry = handoff[kind];
    const values = Array.isArray(entry) ? entry : Array.isArray(entry?.values) ? entry.values : null;
    if (values === null || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length === 0)) {
      return refused('MISSING_LINEAGE', `handoff kind ${kind} carries no typed non-empty binding values`);
    }
    const resolved = resolveHandoffKind(kind, values, authorities);
    if (isRefused(resolved)) return resolved;
    if (resolved.selfSeal) selfSealKinds.push(kind);
    resolution[kind] = { values: [...values], resolvedAgainst: [...authorities.baseline.developmentSurface.handoffBindingKinds[kind].resolvesAgainst] };
  }
  if (selfSealKinds.length > 1) {
    return refused('MALFORMED_PRODUCT', `at most one handoff kind may resolve against the settlement self-seal surface (got: ${selfSealKinds.join(', ')})`);
  }
  const record = { productKind: SOLUTION_CONTRACT_PRODUCT_KIND, pins, handoff: resolution };
  return { ok: true, rung: 'binding-resolution', artifact: artifactOf(record), record, selfSealKind: selfSealKinds[0] ?? null };
}

/* ------------------------------------------------------------------ */
/* R3 - the sealed solution contract                                   */
/* ------------------------------------------------------------------ */

/**
 * The canonical contract body (the digest basis, shared by the seal and
 * the validator so the two can never drift apart):
 *   sealBase       = sha256(canonical body with the self-seal value zeroed)
 *   self-seal ref  = `sha256:<sealBase>`
 *   canonicalDigest= sha256(canonical body with the self-seal value filled)
 */
function contractBodyOf(pins, handoff, selfSealKind, selfValue) {
  const developmentHandoff = Object.fromEntries(Object.entries(handoff).map(([kind, entry]) => [
    kind,
    { values: kind === selfSealKind ? [selfValue] : [...entry.values], resolvedAgainst: [...entry.resolvedAgainst] },
  ]));
  return {
    schemaVersion: SOLUTION_CONTRACT_PRODUCT_KIND,
    whatBaselineRef: pins.baselineRef,
    wholeWhatDigest: pins.baselineWholeWhatDigest,
    srsRef: `sha256:${pins.srsRevisionDigest}`,
    developmentHandoff,
  };
}

/** Seal the contract (deterministic; never circular). */
export function sealSolutionContract(pins, resolution, selfSealKind) {
  const sealBase = sha256OfCanonical(contractBodyOf(pins, resolution, selfSealKind, ''));
  const body = contractBodyOf(pins, resolution, selfSealKind, `sha256:${sealBase}`);
  const canonicalDigest = sha256OfCanonical(body);
  return { ok: true, contract: { ...body, canonicalDigest }, sealBase };
}

/** R3 (full desk): pins -> resolution -> seal -> self-validation (the A2 fence). */
export function settleSolutionContract(inputs) {
  const pinsRung = settlementAuthorityPins(inputs);
  if (isRefused(pinsRung)) return ladderRefusal(pinsRung);
  const bindingRung = settlementBindingResolution(inputs, pinsRung.pins);
  if (isRefused(bindingRung)) return ladderRefusal(bindingRung);
  const seal = sealSolutionContract(pinsRung.pins, bindingRung.record.handoff, bindingRung.selfSealKind);
  const contract = seal.contract;
  // The settler fence (A2): validate the sealed contract through the SAME
  // resolver before emitting it - settlement never emits what it could
  // not validate.
  const validation = validateSolutionContract(contract, inputs.frozenBaseline, inputs.baselineArtifact, inputs.srs, inputs.repositoryPolicyRefs);
  if (isRefused(validation)) return ladderRefusal(validation);
  return {
    ok: true,
    outcome: 'formalized',
    rung: 'sealed-contract',
    contract,
    artifact: artifactOf(contract),
    ladder: [pinsRung.artifact, bindingRung.artifact, artifactOf(contract)],
  };
}

/**
 * Validate a settled solution contract against BOTH exact authorities and
 * the frozen resolution surface (the D-1 fix: the validator is
 * binding-aware; foreign handoff bindings are FOREIGN_LINEAGE refusals).
 */
export function validateSolutionContract(contract, frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs) {
  if (contract === null || typeof contract !== 'object' || contract.schemaVersion !== SOLUTION_CONTRACT_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${SOLUTION_CONTRACT_PRODUCT_KIND}`);
  }
  const recomputed = sha256OfCanonical({
    schemaVersion: contract.schemaVersion,
    whatBaselineRef: contract.whatBaselineRef,
    wholeWhatDigest: contract.wholeWhatDigest,
    srsRef: contract.srsRef,
    developmentHandoff: contract.developmentHandoff,
  });
  if (recomputed !== contract.canonicalDigest) {
    return refused('DRIFT_DETECTED', 'the canonical solution-contract digest does not verify');
  }
  const pinsRung = settlementAuthorityPins({ frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs, handoff: contract.developmentHandoff ?? {} });
  if (isRefused(pinsRung)) return pinsRung;
  if (contract.whatBaselineRef !== pinsRung.pins.baselineRef || contract.wholeWhatDigest !== pinsRung.pins.baselineWholeWhatDigest) {
    return refused('STALE_LINEAGE', 'the contract does not pin the exact frozen whole-WHAT baseline (artifact ref + whole-WHAT digest)');
  }
  if (contract.srsRef !== `sha256:${pinsRung.pins.srsRevisionDigest}`) {
    return refused('STALE_LINEAGE', 'the contract does not pin the exact accepted SRS revision');
  }
  const bindingRung = settlementBindingResolution(
    { frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs, handoff: contract.developmentHandoff },
    pinsRung.pins,
  );
  if (isRefused(bindingRung)) return bindingRung;
  // The self-seal assertion: the self-seal kind's value must be
  // `sha256:<sealBase>` over the same body with the value zeroed.
  if (bindingRung.selfSealKind !== null) {
    const kind = bindingRung.selfSealKind;
    const value = contract.developmentHandoff[kind].values[0];
    const sealBase = sha256OfCanonical(contractBodyOf(pinsRung.pins, bindingRung.record.handoff, kind, ''));
    if (value !== `sha256:${sealBase}`) {
      return refused('DRIFT_DETECTED', `the self-seal value of handoff kind ${kind} is not sha256 of the contract's sealed base (settlement self-references exactly; a copied foreign digest is refused)`);
    }
  }
  return { ok: true, artifact: artifactOf(contract) };
}

/** Route a ladder refusal to the settle desk's terminal outcome (frozen table). */
export function ladderRefusal(refusal) {
  const routed = routeRefusal(SETTLE_OUTCOME_OF_REASON, refusal.reason);
  if (isRefused(routed)) return routed;
  return { ok: true, outcome: routed.outcome, rung: null, contract: null, ladder: [], refusal };
}
