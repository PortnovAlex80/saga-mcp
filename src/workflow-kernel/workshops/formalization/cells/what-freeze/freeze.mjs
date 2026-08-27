/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/freeze.mjs -
 * the WHAT-freeze desk driver (FRF-WP07): freeze the whole-WHAT baseline
 * from the exact accepted surfaces, deterministically.
 *
 * THE DESK STEP LADDER (deterministic; the CheckPlan mirrors it):
 *   1. refuse the folded legacy shape on sight (F-8 / D-10);
 *   2. ingest the exact accepted authority (fail-closed surface carry,
 *      build the sectioned baseline, one canonical trace digest, one
 *      canonical whole-WHAT digest, exact-authority assertion);
 *   3. validate via the FRF-WP03 typed validator against the universe
 *      derived from the SAME surfaces (the seam);
 *   4. route the outcome: `frozen` (sealed artifact + the domain.frozen
 *      transition), `drift-detected` (the freeze-drift human decision -
 *      a D12 typed wait; the domain.drift-detected edge fires only on the
 *      operator's confirm-inconsistent disposition), `indeterminate`
 *      (a D5 typed wait; nothing is frozen), `upstream-repair`, `repair`.
 *
 * The freezer performs NO authorship: the baseline product is BUILT from
 * accepted inputs (the installed driver's actorProductOf already returns
 * no authored what-baseline candidate; this cell makes the law explicit).
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import {
  artifactOf,
  isRefused,
  sha256OfCanonical,
  validateWhatBaseline,
} from './shared.mjs';
import { FREEZE_OUTCOME_OF_REASON, routeRefusal } from './protocol.mjs';
import { ingestAcceptedAuthority } from './ingestion.mjs';

/**
 * Freeze the whole-WHAT baseline over the exact accepted surfaces.
 * `options.pinnedCaseIdentity` is the external case-aggregate pin; when
 * supplied, a surface set carrying a different case identity is refused
 * DRIFT_DETECTED (substituted case material).
 * Returns, deterministically:
 *   { ok: true, outcome: 'frozen', artifact, baseline, universe, wait: null }
 *   { ok: true, outcome, wait, refusal }  - drift/indeterminate/repair routes
 *   { ... refused: true, ... }            - the desk itself was misused
 */
export function freezeWhatBaseline(surfaces, options = {}) {
  const ingested = ingestAcceptedAuthority(surfaces, { pinnedCaseIdentity: options.pinnedCaseIdentity });
  if (isRefused(ingested)) {
    return deskRefusal(ingested);
  }
  const { baseline, universe } = ingested;
  const validation = validateWhatBaseline(baseline, universe);
  if (validation.ok !== true) {
    return deskRefusal(validation);
  }
  // The WP03 validator sealed the payload; seal the kernel evidence
  // artifact over the SAME content (one identity, recomputed digest).
  const artifact = artifactOf(baseline);
  return {
    ok: true,
    outcome: 'frozen',
    artifact,
    baseline,
    universe,
    wait: null,
    refusal: null,
  };
}

/** Route one typed refusal through the freeze desk's declared table. */
function deskRefusal(refusal) {
  const routed = routeRefusal(FREEZE_OUTCOME_OF_REASON, refusal.reason);
  if (isRefused(routed)) return routed;
  return {
    ok: true,
    outcome: routed.outcome,
    artifact: null,
    baseline: null,
    universe: null,
    refusal,
    wait: waitOfOutcome(routed.outcome, refusal),
  };
}

/** The typed wait a non-frozen outcome opens (D5/D12 vocabulary only). */
function waitOfOutcome(outcome, refusal) {
  if (outcome === 'drift-detected') {
    // D12: the freeze-drift human decision wakes ONLY on the operator
    // disposition receipt; an automatic redrive is refused by the wait
    // resolver (persistence.mjs). The wait carries the exact drift
    // evidence digest so the disposition binds THIS drift, not a prose
    // opinion.
    return {
      kind: 'TypedWait:effect-uncertainty',
      disposition: 'operator-disposition-command-required',
      wakeCommands: ['workplace.resolveHumanResponse'],
      driftEvidenceDigest: sha256OfCanonical({ detail: refusal.detail, reason: refusal.reason }),
    };
  }
  if (outcome === 'indeterminate') {
    // D5: discharged by the frozen wake commands (the exact accepted
    // surface the transition failed to carry must arrive as evidence).
    return {
      kind: 'TypedWait:human-input',
      disposition: 'wake-source-completion',
      wakeCommands: ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision'],
      missingSurfaceDetail: refusal.detail,
    };
  }
  return null;
}

/** True when the freeze result is a lawful frozen baseline (test/desk oracle). */
export function isFrozen(result) {
  return result !== null && typeof result === 'object' && result.ok === true && result.outcome === 'frozen' && result.artifact !== null;
}
