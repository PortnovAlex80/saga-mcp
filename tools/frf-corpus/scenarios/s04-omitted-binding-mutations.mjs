/**
 * s04-omitted-binding-mutations - the OMITTED binding sweep: required
 * bindings stripped from the authored material. A stripped AC terminal-
 * branch binding is refused MISSING_LINEAGE at the acceptance desk; an
 * omitted accepted surface opens the D5 indeterminate wait at the freeze
 * desk (the chain pauses at the typed wait); a stripped scenario binding
 * of the twelve-kind handoff is refused MISSING_LINEAGE at settlement
 * (ledger D-2/D-17: bindings are not optional metadata).
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's04-omitted-binding-mutations',
  dimension: 'binding-mutation-sweep',
  mutations: [
    { kind: 'omitted-binding', target: 'define-acceptance-contract:ucTerminalBranchRefs' },
    { kind: 'omitted-binding', target: 'freeze-what-baseline:surfaces.dispositions' },
    { kind: 'omitted-binding', target: 'settle-formalization:handoff.scenario-bindings' },
  ],
  expectedWorld: {
    sweep: [
      { target: 'define-acceptance-contract:ucTerminalBranchRefs', reason: 'MISSING_LINEAGE', verdict: 'repair' },
      { target: 'freeze-what-baseline:surfaces.dispositions', reason: 'MISSING_LINEAGE', verdict: 'indeterminate' },
      { target: 'settle-formalization:handoff.scenario-bindings', reason: 'MISSING_LINEAGE', verdict: 'failed' },
    ],
  },
});
