/**
 * p12-fan-out-topology - dependency topology FAN-OUT (a -> b, a -> c):
 * both successors become ready over the same predecessor acceptance and
 * may run under the declared cap in any order (canonicalized on compare).
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p12-fan-out-topology',
  projectKind: 'topology',
  description: 'Fan-out dependency topology (a -> {b, c}) fully settled; independent successors normalize under the WP-13A canonical ordering.',
  conveyorTopology: 'fan-out',
  product: { class: 'none', verification: 'none', fixture: null },
  expectations: { ...conveyorExpectations({ cells: ['a', 'b', 'c'] }) },
  expectationPolicies: {
    events: 'declared-subset', obligations: 'declared-subset', waits: 'declared-subset',
    'evidence.material': 'declared-subset', 'evidence.gate': 'declared-subset', 'evidence.effect': 'declared-subset',
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
