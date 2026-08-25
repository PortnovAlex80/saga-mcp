/**
 * p04-batch-pipeline - the BATCH product family: a chain topology (a -> b
 * -> c) of dependent work items, each produced and settled in order; the
 * batch product is a deterministic periodic report over a frozen input
 * window (build twice -> byte-identical digest).
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p04-batch-pipeline',
  projectKind: 'batch',
  description: 'Batch product pipeline: chain dependency topology (a -> b -> c) fully settled through the WP-09 conveyor; the batch report product is deterministic across builds.',
  conveyorTopology: 'chain',
  product: { class: 'batch-report', verification: 'build-determinism-replay', fixture: 'batch-report' },
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
    events: 'the conveyor schedules cell order internally; declared event kinds with multiplicity floor are asserted (the exact interleaving is WP-09 property)',
    obligations: 'the conveyor settles lanes internally; the closed set is proven by the WP-09 settlement tests',
    waits: 'chain successors discharge their readiness waits on predecessor acceptance; the declared set is the floor',
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
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'product-verification-green', 'product-determinism'],
});
