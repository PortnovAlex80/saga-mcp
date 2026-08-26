/**
 * p09-chain-topology - dependency topology CHAIN (a -> b -> c): each
 * successor becomes ready exactly over its predecessor's acceptance
 * evidence; the aggregate settles after all three cells.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p09-chain-topology',
  projectKind: 'topology',
  description: 'Chain dependency topology (a -> b -> c) fully settled through the WP-09 conveyor.',
  conveyorTopology: 'chain',
  product: { class: 'none', verification: 'none', fixture: null },
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
    obligations: 'the conveyor settles lanes internally',
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
});
