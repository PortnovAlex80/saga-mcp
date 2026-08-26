/**
 * p11-fan-in-topology - dependency topology FAN-IN (a, b -> c): c becomes
 * ready only over BOTH independent predecessors' acceptance evidence.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p11-fan-in-topology',
  projectKind: 'topology',
  description: 'Fan-in dependency topology ({a, b} -> c) fully settled; c carries both predecessors\' acceptance evidence.',
  conveyorTopology: 'fan-in',
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
  ek11: { planId: 'P11', kind: 'read-only-metrics-dashboard', fixture: 'qual:metrics-dashboard', profile: ["build","api-smoke","browser-smoke","package-receipt"] },
});
