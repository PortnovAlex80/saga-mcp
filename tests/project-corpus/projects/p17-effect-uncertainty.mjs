/**
 * p17-effect-uncertainty - the EFFECT-UNCERTAINTY project (D12 arm B): the
 * node's provider outcome is UNKNOWN (the non-idempotent send happened,
 * its outcome is not). The kernel commits TypedWait:effect-uncertainty
 * whose ONLY wake is the operator disposition command; the workplace
 * settles its terminal over the verified effect, and the node STAYS in
 * provider-uncertainty-waited - the run ladder may not advance past an
 * outstanding operator disposition.
 */
import { durableProject } from '../scaffold.mjs';
import { effectUncertaintyProgram } from '../programs.mjs';

const program = effectUncertaintyProgram({ loopId: 'd12' });

export default durableProject({
  projectId: 'p17-effect-uncertainty',
  projectKind: 'effect-uncertainty',
  description: 'D12 effect-uncertainty: unknown provider outcome -> pending typed wait with the operator command as its ONLY wake; the workplace terminalizes, the node waits.',
  program,
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'd12-uncertainty-pending-operator-only', 'workplace-terminal-success'],
  expectedWaits: [
    { kind: 'TypedWait:human-input', state: 'discharged' },
    { kind: 'TypedWait:human-input', state: 'discharged' },
    { kind: 'TypedWait:effect-uncertainty', state: 'pending' },
  ],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'node-run:1', status: 'provider-uncertainty-waited' },
  ],
  notes: ['The honest terminal of this arm is the workplace proof with the node left waiting: delivery cannot pass an outstanding operator disposition.'],
});
