/**
 * p20-idempotent-replay - the IDEMPOTENCY project: after the full clean
 * settlement, the whole input list is RE-DRIVEN statelessly (every step
 * must skip/replay; the normalized world must not change) and a verbatim
 * completion re-issue under a fresh key is refused by the CAS fence - a
 * duplicate completion can never double-commit.
 */
import { durableProject } from '../scaffold.mjs';
import { servedDeskProgram } from '../programs.mjs';

const program = servedDeskProgram({ loopId: 'desk' });

export default durableProject({
  projectId: 'p20-idempotent-replay',
  projectKind: 'idempotency',
  description: 'Idempotent replay: a full stateless re-drive changes nothing; a verbatim completion re-issue is refused by the CAS fence.',
  program,
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'idempotent-replay-no-double-commit', 'one-admitted-receipt-per-attempt', 'determinism-replay'],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
});
