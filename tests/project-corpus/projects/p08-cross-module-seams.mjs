/**
 * p08-cross-module-seams - the CROSS-MODULE family: a chain topology whose
 * planning facts declare two integration seams (a->b, b->c) and per-item
 * module/test construction surfaces. The capsule import records
 * SeamOwnership + ConstructionSurface evidence, and after full settlement
 * the forward observed consumption graph must EXACTLY equal the declared
 * planning graph (WP-09): every seam edge was consumed as predecessor
 * acceptance evidence.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p08-cross-module-seams',
  projectKind: 'cross-module',
  description: 'Cross-module integration: two declared seams over a chain; seam ownership evidence at ingress and exact declared-vs-observed consumption graph at settlement.',
  conveyorTopology: 'chain',
  product: { class: 'cross-module-pair', verification: 'none', fixture: null },
  expectations: { ...conveyorExpectations({ cells: ['a', 'b', 'c'] }) },
  expectationPolicies: {
    events: 'declared-subset',
    obligations: 'declared-subset',
    waits: 'declared-subset',
    'evidence.material': 'declared-subset',
    'evidence.gate': 'declared-subset',
    'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'the conveyor schedules cell order internally; declared kinds with multiplicity floor are asserted',
    obligations: 'the conveyor settles lanes internally; the closed set is proven by the WP-09 settlement tests',
    waits: 'successor readiness waits discharge on predecessor acceptance',
    'evidence.material': 'per-cell material counts follow the conveyor desk structure',
    'evidence.gate': 'per-cell verdict kinds follow the conveyor desk structure',
    'evidence.effect': 'each cell settles exactly one success receipt',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'workplace:2', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'workplace:3', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success'],
  notes: ['The seam-consumption oracle: compareGraphs(forwardObservedGraph, declaredPlanningGraph) must be the typed exact equality (WP-09 observed-graphs).'],
});
