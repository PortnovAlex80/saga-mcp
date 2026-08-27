/**
 * s03-stale-binding-mutations - the STALE lineage sweep: the requirements
 * bundle cites a stale PRD revision pin while the accepted universe
 * carries the true pin. The WP03 requirements validator refuses the
 * bundle typed STALE_LINEAGE and the desk routes it repair.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's03-stale-binding-mutations',
  dimension: 'binding-mutation-sweep',
  mutations: [
    { kind: 'stale-binding', target: 'derive-system-requirements:prdRevisionPin' },
  ],
  expectedWorld: {
    sweep: [
      { target: 'derive-system-requirements:prdRevisionPin', reason: 'STALE_LINEAGE', verdict: 'repair' },
    ],
  },
});
