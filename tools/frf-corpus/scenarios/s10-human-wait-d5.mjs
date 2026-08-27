/**
 * s10-human-wait-d5 - the human-wait scenario: the freeze desk receives
 * accepted surfaces with the dispositions surface omitted -> the desk is
 * INDETERMINATE and opens the D5 TypedWait:human-input. A scripted actor
 * discharges the wait through the PUBLIC COMMAND PATH
 * (workplace.resolveHumanResponse carrying the accepted-surface evidence
 * ref), the desk re-runs on the completed surfaces, freezes, and the
 * flow completes to the DevelopmentCase and its plan.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's10-human-wait-d5',
  dimension: 'human-wait-disposition',
  mutations: [
    { kind: 'omitted-binding', target: 'freeze-what-baseline:surfaces.dispositions' },
  ],
  expectedWorld: {
    verdicts: [{ desk: 'freeze-what-baseline', verdict: 'frozen' }],
    waits: [{ kind: 'TypedWait:human-input', state: 'discharged' }],
    terminal: { developmentCase: 'admitted', plan: 'planned' },
  },
  notes: [
    'An automatic redrive without the wake receipt is refused by the wait resolver (the persistence module); only the public command path discharges.',
  ],
});
