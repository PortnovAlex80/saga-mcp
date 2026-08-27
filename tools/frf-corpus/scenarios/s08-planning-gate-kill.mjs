/**
 * s08-planning-gate-kill - the audit's named planning gate: a WorkItem
 * set that covers every acceptance criterion (AC-complete) while the
 * batch scenario-realization obligation is stripped (scenario-incomplete)
 * is REFUSED by the planning gate - typed COVERAGE_GAP naming the
 * scenario-incomplete family (cr-01). An AC-complete but
 * scenario-incomplete plan is invalid before Development execution.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's08-planning-gate-kill',
  dimension: 'planning-gate-kill',
  mutations: [
    { kind: 'scenario-incomplete', target: 'plan-development:scenario-realization' },
  ],
  expectedWorld: {
    refusals: [{ target: 'plan-development', reason: 'COVERAGE_GAP' }],
    terminal: { developmentCase: 'admitted', plan: 'refused' },
  },
});
