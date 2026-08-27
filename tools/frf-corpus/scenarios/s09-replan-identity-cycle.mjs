/**
 * s09-replan-identity-cycle - the replan identity-preservation cycle:
 * a lawful replan (wi:verify replaced by wi:verify-2 with identical
 * obligations) re-seals a new plan whose survivors are byte-identical and
 * whose case identities (handoff fingerprint + scenario identities) are
 * carried verbatim; a replan that MUTATES a surviving WorkItem's
 * obligation identities is refused DRIFT_DETECTED (rebind through a NEW
 * WorkItem, never a silent mutation).
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's09-replan-identity-cycle',
  dimension: 'replan-identity-cycle',
  mutations: [
    { kind: 'mutated-survivor', target: 'replan-development:mutated-survivor' },
  ],
  expectedWorld: {
    verdicts: [{ desk: 'plan-development', verdict: 'planned' }],
    terminal: { developmentCase: 'admitted', plan: 'planned', replan: 'identity-preserved' },
  },
});
