/**
 * s11-crash-restart-matrix - the crash schedule coverage: EVERY named
 * crash window of the formalization flow desks (before/after each desk,
 * the before/after evidence-commit seams of the freeze and settle desks,
 * and the before/after D5 wait-disposition seams - the WP07 persistence
 * module's resume points) is armed once, the driving process dies, a
 * restart re-derives the flow over the durable rows, and the settled
 * normalized world must be IDENTICAL to the clean run's world.
 *
 * The flow driven here is the FULL human-wait flow (the D5 wait opened
 * and discharged) so the wait-disposition windows are live, not dead
 * vocabulary.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's11-crash-restart-matrix',
  dimension: 'crash-restart-matrix',
  mutations: [
    { kind: 'omitted-binding', target: 'freeze-what-baseline:surfaces.dispositions' },
  ],
  expectedWorld: {
    crashLaw: 'identical-normalized-world',
  },
  notes: [
    'The matrix iterates the window list internally (frfCrashWindows): one crash per sub-run - one process dies once.',
    'Restarts restore the evidence ledger THROUGH its public submit() path (durable-row replay), never by writing authority storage directly.',
  ],
});
