/**
 * p13-independent-topology - dependency topology INDEPENDENT (a, b; no
 * edges, declared concurrency cap 2): the only shape where two cells may
 * truly run in parallel; the whole-run replay must be identical.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p13-independent-topology',
  projectKind: 'topology',
  description: 'Independent dependency topology (a, b; cap 2) fully settled; the whole run replays identically on a fresh database.',
  conveyorTopology: 'independent',
  product: { class: 'none', verification: 'none', fixture: null },
  expectations: { ...conveyorExpectations({ cells: ['a', 'b'] }) },
  expectationPolicies: {
    events: 'declared-subset', obligations: 'declared-subset', waits: 'declared-subset',
    'evidence.material': 'declared-subset', 'evidence.gate': 'declared-subset', 'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'independent items may interleave under the cap; the declared multiset is the floor',
    obligations: 'the conveyor settles lanes internally',
    waits: 'independent items have no readiness waits',
    'evidence.material': 'per-cell material counts follow the conveyor desk structure',
    'evidence.gate': 'per-cell verdict kinds follow the conveyor desk structure',
    'evidence.effect': 'each cell settles exactly one success receipt',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'workplace:2', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'determinism-replay'],
  notes: [
    'RESIDUAL (observed honestly): after full settlement the obligation frontier still lists claimable lane rows (materializeWorkplace.production-cell, runGate.author/final, runEffects, advanceProcessFlow*) - the kernel exposes no drain-empty oracle, so no drain-closed invariant is declared for conveyor projects.',
  ],
});
