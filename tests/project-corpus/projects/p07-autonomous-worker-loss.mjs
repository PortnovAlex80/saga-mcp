/**
 * p07-autonomous-worker-loss - the AUTONOMOUS family under loss: the
 * worker never returns (timeout behavior); the attempt is CLASSIFIED
 * (worker-loss-classified + TypedWait:external-availability + retry
 * obligation - never a product failure), then the retry on the SAME
 * WorkIntent carries the cell to the full success ladder.
 */
import { durableProject } from '../scaffold.mjs';
import { workerLossProgram } from '../programs.mjs';

const program = workerLossProgram({ loopId: 'wl' });

export default durableProject({
  projectId: 'p07-autonomous-worker-loss',
  projectKind: 'autonomous',
  description: 'Worker loss classified, never product-failed: a timed-out attempt leaves a typed external-availability wait and an open retry obligation; the same-intent retry settles the ladder.',
  program,
  product: { class: 'autonomous-decision', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'worker-loss-classified-never-failed', 'workplace-terminal-success', 'one-admitted-receipt-per-attempt'],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
});
