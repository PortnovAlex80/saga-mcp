/**
 * p05-scheduled-independent - the SCHEDULED product family: two independent
 * work items (no dependency edges, declared concurrency cap 2 - the only
 * place the corpus expresses parallelism, normalized away by the WP-13A
 * canonical ordering). The scheduled product is the deterministic batch
 * report; the run is replayable (determinism replay on a fresh database).
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p05-scheduled-independent',
  projectKind: 'scheduled',
  description: 'Scheduled product: two independent items under concurrency cap 2, fully settled; deterministic re-run and deterministic product build.',
  conveyorTopology: 'independent',
  product: { class: 'batch-report', verification: 'build-determinism-replay', fixture: 'batch-report' },
  expectations: { ...conveyorExpectations({ cells: ['a', 'b'] }) },
  expectationPolicies: {
    events: 'declared-subset',
    obligations: 'declared-subset',
    waits: 'declared-subset',
    'evidence.material': 'declared-subset',
    'evidence.gate': 'declared-subset',
    'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'independent items may interleave under the cap; the WP-13A canonical ordering normalizes scheduling artifacts, the declared multiset is the floor',
    obligations: 'the conveyor settles lanes internally; the closed set is proven by the WP-09 settlement tests',
    waits: 'independent items have no readiness waits; the declared empty set is exact',
    'evidence.material': 'per-cell material counts follow the conveyor desk structure',
    'evidence.gate': 'per-cell verdict kinds follow the conveyor desk structure',
    'evidence.effect': 'each cell settles exactly one success receipt',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'workplace:2', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'product-verification-green', 'product-determinism', 'determinism-replay'],
  ek11: { planId: 'P05', kind: 'todo-crud-web-app', fixture: 'qual:served-crud', profile: ["build","test","api-smoke","browser-smoke","package-receipt","persistence"] },
});
