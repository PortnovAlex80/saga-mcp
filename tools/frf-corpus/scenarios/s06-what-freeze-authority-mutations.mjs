/**
 * s06-what-freeze-authority-mutations - the WHAT-freeze authority
 * mutations over the exact accepted surfaces:
 *   - substituted member: one accepted UC member's identity replaced
 *     after acceptance (same case identity) -> the freeze desk detects
 *     the drift against the frozen trace/member-binding set and opens
 *     the D12 freeze-drift wait (DRIFT_DETECTED routes drift-detected);
 *   - folded section: the NFR members folded into the FR container (one
 *     section carrying two kinds of content; a member carried by two
 *     sections) -> the exact-authority ingestion refuses the folded
 *     shape as drift (the legacy folded product is not accepted
 *     authority).
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's06-what-freeze-authority-mutations',
  dimension: 'what-freeze-authority-mutation',
  mutations: [
    { kind: 'substituted-member', target: 'freeze-what-baseline:containers.uc.members' },
    { kind: 'folded-section', target: 'freeze-what-baseline:containers.fr+nfr' },
  ],
  expectedWorld: {
    sweep: [
      { target: 'freeze-what-baseline:containers.uc.members', reason: 'DRIFT_DETECTED', verdict: 'drift-detected' },
      { target: 'freeze-what-baseline:containers.fr+nfr', reason: 'DRIFT_DETECTED', verdict: 'drift-detected' },
    ],
  },
  notes: [
    'A drift-detected freeze opens the D12 TypedWait:effect-uncertainty - the operator disposition resume point (the persistence module refuses an automatic redrive).',
  ],
});
