/**
 * s07-srs-elite-kills - the two SRS Elite composition kills over the
 * frozen WP08 elite fixture universe (four product profiles):
 *   - missing-entrypoint: the browser-bootstrap surface a scenario's
 *     entrypoint resolves through is absent from the contract -> a typed
 *     COVERAGE_GAP refusal at parse/validate/author level (never a
 *     silent pass), routed repair;
 *   - missing-composition: a declared composition surface realizing NO
 *     scenario -> FOREIGN_LINEAGE (the surface claims contract authority
 *     it does not have), routed upstream-repair.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's07-srs-elite-kills',
  dimension: 'srs-elite-kill',
  seedFixture: 'wp08-elite',
  mutations: [
    { kind: 'missing-entrypoint', target: 'define-architecture-contract:entrypoint' },
    { kind: 'missing-composition', target: 'define-architecture-contract:composition' },
  ],
  expectedWorld: {
    sweep: [
      { target: 'define-architecture-contract:entrypoint', reason: 'COVERAGE_GAP', verdict: 'repair' },
      { target: 'define-architecture-contract:composition', reason: 'FOREIGN_LINEAGE', verdict: 'upstream-repair' },
    ],
  },
});
