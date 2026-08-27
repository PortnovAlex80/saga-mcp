/**
 * s05-reconciliation-drift - the F-2 path: accepted material drifted
 * AFTER acceptance (an AC criterion whose requirement binding no longer
 * resolves). The report-only reconciler must COMPUTE the verdict from the
 * drift - never trust a declared one - and surface the named gap with
 * the typed vocabulary. The chain itself still completes through the
 * frozen authority (reconciliation is report-only), so the terminal is
 * reached with the gaps verdict on record.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's05-reconciliation-drift',
  dimension: 'reconciliation-drift',
  mutations: [
    { kind: 'drifted-snapshot', target: 'reconcile-what:snapshot' },
  ],
  expectedWorld: {
    closure: { verdict: 'gaps', gapReasons: ['FOREIGN_LINEAGE'] },
    terminal: { developmentCase: 'admitted', plan: 'planned' },
  },
  notes: [
    'The drifted criterion binds a foreign requirement id: the reverse direction names the criterion; the verdict is computed, never a parameter (the F-2 fix).',
  ],
});
