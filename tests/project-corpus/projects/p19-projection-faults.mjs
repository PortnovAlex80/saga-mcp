/**
 * p19-projection-faults - the RESTART-HEAVY projection arm: projection-wipe
 * (every derived projection dropped; a brand-new session must rehydrate
 * the identical normalized world from ledger rows alone - the projection
 * is never authority) and projection-stale-write (a stale-revision write
 * attempt against the ledger is answered by the CAS fence and changes
 * nothing).
 */
import { durableProject } from '../scaffold.mjs';
import { servedDeskProgram, IDS } from '../programs.mjs';

const program = servedDeskProgram({ loopId: 'desk' });

export default durableProject({
  projectId: 'p19-projection-faults',
  projectKind: 'restart-heavy',
  description: 'Projection faults: wipe (rehydrate from the ledger alone) + stale write (CAS fence refuses, nothing changes).',
  program,
  faultSchedule: [
    { fault: 'projection-wipe', anchor: { command: 'workplace.recordContribution', instanceId: IDS.workplace } },
    { fault: 'projection-stale-write', anchor: { command: 'cognition.sendProviderRequest', instanceId: IDS.transport } },
  ],
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'projection-rehydrates-from-ledger', 'stale-write-refused-and-ineffective'],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
});
