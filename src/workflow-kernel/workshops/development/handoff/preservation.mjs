/**
 * workflow-kernel/workshops/development/handoff/preservation.mjs -
 * the FRF-WP09 identity preservation through the Development lifecycle:
 * replan, adoption, settlement, and verification.
 *
 * LAWS (plan §Objective; reverse coverage rule cr-03; reverse edge/0004
 * requires-identity-survival: "Same scenario identity and hash at every
 * hop; replan, adoption, settlement, and verification preserve them";
 * phase FRF-9 row "Update replan, adoption, settlement, verification,
 * capsule, and recovery paths to preserve exact identities and hashes"):
 *
 *   - THE PRESERVED IDENTITIES are exactly the DevelopmentCase's frozen
 *     scenario identities (id + digest + terminal-branch digests) and the
 *     handoff fingerprint over the twelve binding domains. Every
 *     lifecycle record carries them VERBATIM; a record whose identities
 *     differ from the case is DRIFT_DETECTED, never merged.
 *   - WORKITEM IDENTITY IMMUTABILITY: through replan cycles a SURVIVING
 *     WorkItem (same workItemId) keeps the exact same workItemDigest -
 *     obligation identities are immutable per WorkItem. Changing what a
 *     WorkItem binds requires a NEW WorkItem (removal + addition); the
 *     replan gate refuses a mutated survivor (DRIFT_DETECTED).
 *   - REPLAN NEVER DROPS COVERAGE: after a replan the full planning-gate
 *     ladder re-runs (an AC-complete-but-scenario-incomplete replan is
 *     refused exactly like a first plan).
 *   - ADOPTION / SETTLEMENT / VERIFICATION each re-validate the plan and
 *     re-emit the same identities with a stage digest chaining the
 *     previous stage (content-addressed; no clock, no counters).
 *   - VERIFICATION closes the loop: the verification evidence must cite
 *     EVERY scenario identity with its frozen digest (a scenario verified
 *     under a different hash is not the same scenario).
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import { digestExcluding, isRefused, refused, sha256OfCanonical } from './shared.mjs';
import { scenarioIdentitiesOf } from './case.mjs';
import { planDevelopment, validateDevelopmentPlan } from './plan.mjs';

/** The closed Development plan lifecycle stage vocabulary. */
export const PLAN_LIFECYCLE_STAGES = Object.freeze(['planned', 'adopted', 'settled', 'verified']);

/** The preserved identity view of a DevelopmentCase (cr-03's exact surface). */
export function preservedIdentitiesOf(devCase) {
  return {
    handoffFingerprint: devCase.handoffFingerprint,
    scenarioIdentities: scenarioIdentitiesOf(devCase),
  };
}

/** True when a record carries EXACTLY the case's preserved identities. */
export function identitiesPreserved(record, devCase) {
  const expected = preservedIdentitiesOf(devCase);
  return record.handoffFingerprint === expected.handoffFingerprint
    && sha256OfCanonical(record.scenarioIdentities) === sha256OfCanonical(expected.scenarioIdentities);
}

/** The shared preservation fence: refuse a record whose identities drifted. */
function requirePreserved(record, devCase, stage) {
  if (!identitiesPreserved(record, devCase)) {
    return refused('DRIFT_DETECTED', `the ${stage} record does not preserve the exact DevelopmentCase identities (cr-03: same scenario identity and hash at every hop; replan, adoption, settlement, and verification preserve them - reverse edge/0004)`);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Replan                                                              */
/* ------------------------------------------------------------------ */

/**
 * Replan a Development plan: `nextWorkItems` replaces the current plan.
 *   - SURVIVORS (workItemIds present before and after) must be
 *     byte-identical (workItemDigest equality) - identities are immutable
 *     per WorkItem;
 *   - the full planning-gate ladder re-runs over the next set (a replan
 *     may never drop scenario identities or coverage).
 * Returns the new sealed plan plus the change record.
 */
export function replanDevelopmentPlan(devCase, currentPlan, nextWorkItems, options = {}) {
  if (currentPlan === null || typeof currentPlan !== 'object') {
    return refused('MISSING_LINEAGE', 'replan consumes the current sealed plan (fail-closed)');
  }
  const nextPlan = planDevelopment(devCase, nextWorkItems, options);
  if (isRefused(nextPlan)) return nextPlan;
  const currentById = new Map(currentPlan.workItems.map((workItem) => [workItem.workItemId, workItem]));
  const survivors = [];
  const mutatedSurvivors = [];
  for (const workItem of nextWorkItems) {
    const prior = currentById.get(workItem.workItemId);
    if (prior === undefined) continue;
    survivors.push(workItem.workItemId);
    if (prior.workItemDigest !== workItem.workItemDigest) {
      mutatedSurvivors.push(workItem.workItemId);
    }
  }
  if (mutatedSurvivors.length > 0) {
    return refused('DRIFT_DETECTED', `replan mutated the obligation identities of surviving WorkItem(s) ${mutatedSurvivors.sort().join(', ')} - a WorkItem's bindings are immutable; rebind through a NEW WorkItem (removal + addition), never a silent mutation`);
  }
  const nextIds = new Set(nextWorkItems.map((workItem) => workItem.workItemId));
  const change = {
    added: nextWorkItems.map((w) => w.workItemId).filter((id) => !currentById.has(id)).sort(),
    removed: [...currentById.keys()].filter((id) => !nextIds.has(id)).sort(),
    retained: survivors.sort(),
  };
  return { change, ok: true, plan: nextPlan.plan, coverage: nextPlan.coverage, replanDigest: digestExcluding({ change, planDigest: nextPlan.plan.planDigest }, []) };
}

/* ------------------------------------------------------------------ */
/* Adoption / settlement / verification                                */
/* ------------------------------------------------------------------ */

/** Stage record body (shared by all stages; stage digest chains the prior). */
function stageRecord(stage, devCase, plan, priorDigest, extra = {}) {
  const identities = preservedIdentitiesOf(devCase);
  const body = {
    caseDigest: devCase.caseDigest,
    planDigest: plan.planDigest,
    priorStageDigest: priorDigest,
    scenarioIdentities: identities.scenarioIdentities,
    handoffFingerprint: identities.handoffFingerprint,
    stage,
    ...extra,
  };
  return { ...body, stageDigest: digestExcluding(body, ['stageDigest']) };
}

/**
 * Adopt a plan: the gates re-run (validateDevelopmentPlan), the case
 * identities are carried verbatim, one content-addressed adoption record
 * is emitted.
 */
export function adoptDevelopmentPlan(devCase, plan) {
  const validation = validateDevelopmentPlan(plan, devCase);
  if (isRefused(validation)) return validation;
  const record = stageRecord('adopted', devCase, plan, plan.planDigest, { coverage: validation.coverage });
  const drift = requirePreserved(record, devCase, 'adoption');
  if (drift !== null) return drift;
  return { ok: true, record };
}

/** Settle an adopted plan: chains the adoption digest, same identities. */
export function settleDevelopmentPlan(devCase, plan, adoptionRecord) {
  const drift = requirePreserved(adoptionRecord, devCase, 'adoption');
  if (drift !== null) return drift;
  const validation = validateDevelopmentPlan(plan, devCase);
  if (isRefused(validation)) return validation;
  const record = stageRecord('settled', devCase, plan, adoptionRecord.stageDigest);
  const settledDrift = requirePreserved(record, devCase, 'settlement');
  if (settledDrift !== null) return settledDrift;
  return { ok: true, record };
}

/**
 * Verify a settled plan: the terminal stage. The verification evidence
 * must cite EVERY preserved scenario identity with its FROZEN digest and
 * every realization entry's terminal result (DRIFT_DETECTED otherwise -
 * a scenario verified under a different hash is not the same scenario).
 */
export function verifyDevelopmentPlan(devCase, plan, settlementRecord, verificationEvidence) {
  const drift = requirePreserved(settlementRecord, devCase, 'settlement');
  if (drift !== null) return drift;
  const validation = validateDevelopmentPlan(plan, devCase);
  if (isRefused(validation)) return validation;
  const expected = preservedIdentitiesOf(devCase);
  if (!Array.isArray(verificationEvidence) || verificationEvidence.length === 0) {
    return refused('MISSING_LINEAGE', 'verification carries no terminal evidence (every preserved scenario identity is verified with its frozen digest)');
  }
  const evidenceByScenario = new Map(verificationEvidence.map((evidence) => [evidence.scenarioId, evidence]));
  for (const identity of expected.scenarioIdentities) {
    const evidence = evidenceByScenario.get(identity.scenarioId);
    if (evidence === undefined) {
      return refused('COVERAGE_GAP', `verification omits the preserved scenario identity ${identity.scenarioId} (every scenario handed off through the DevelopmentCase is verified - cr-03)`);
    }
    if (evidence.digest !== identity.digest) {
      return refused('DRIFT_DETECTED', `verification of ${identity.scenarioId} cites digest ${String(evidence.digest)}; the frozen scenario digest is ${identity.digest} (same identity AND hash at every hop)`);
    }
    const evidenceBranches = (evidence.branches ?? []).map((b) => `${b.branchId}:${b.digest}`).sort();
    const frozenBranches = identity.branches.map((b) => `${b.branchId}:${b.digest}`).sort();
    if (evidenceBranches.join('\u0000') !== frozenBranches.join('\u0000')) {
      return refused('DRIFT_DETECTED', `verification of ${identity.scenarioId} cites a terminal-branch set that differs from the frozen branches (cr-03 branch-level identity AND hash preservation)`);
    }
  }
  const extraScenarios = [...evidenceByScenario.keys()].filter((scenarioId) => !expected.scenarioIdentities.some((i) => i.scenarioId === scenarioId));
  if (extraScenarios.length > 0) {
    return refused('FOREIGN_LINEAGE', `verification cites scenario(s) ${extraScenarios.sort().join(', ')} outside the DevelopmentCase scenario identities (verification covers exactly the handed-off scenarios)`);
  }
  const record = stageRecord('verified', devCase, plan, settlementRecord.stageDigest, { evidence: verificationEvidence });
  const verifiedDrift = requirePreserved(record, devCase, 'verification');
  if (verifiedDrift !== null) return verifiedDrift;
  return { ok: true, record };
}
