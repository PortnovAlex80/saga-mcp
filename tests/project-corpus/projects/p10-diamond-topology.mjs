/**
 * p10-diamond-topology - dependency topology DIAMOND (a -> b, a -> c,
 * b -> d, c -> d): fan-out after a, fan-in at d over BOTH predecessors.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

const headsWith = (terminals) => [
  ...terminals.map((terminal, index) => ({ instanceId: `workplace:${index + 1}`, status: 'terminal', terminal })),
  { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
];

export default conveyorProject({
  projectId: 'p10-diamond-topology',
  projectKind: 'topology',
  description: 'Diamond dependency topology (a -> {b, c} -> d) fully settled; d fans in over both predecessor acceptances.',
  conveyorTopology: 'diamond',
  product: { class: 'none', verification: 'none', fixture: null },
  expectations: { ...conveyorExpectations({ cells: ['a', 'b', 'c', 'd'] }) },
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
  expectedWorldHeads: headsWith([
    'TerminalProof:workplace.success', 'TerminalProof:workplace.success',
    'TerminalProof:workplace.success', 'TerminalProof:workplace.success',
  ]),
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success'],
  ek11: { planId: 'P10', kind: 'in-memory-job-queue-simulator', fixture: 'qual:job-queue-sim', profile: ["build","cli-smoke","package-receipt","determinism"] },
});
