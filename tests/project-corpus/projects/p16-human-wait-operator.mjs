/**
 * p16-human-wait-operator - the HUMAN-WAIT project (D5/D12 arm A): the
 * author gate returns human-wait, the SCRIPTED OPERATOR disposes of the
 * wait through the public command (enterHumanWait ->
 * resolveHumanResponse), and the desk is re-driven to acceptance and the
 * full ladder. No live user ever pauses the run (the autonomy rule).
 */
import { durableProject } from '../scaffold.mjs';
import { humanWaitProgram } from '../programs.mjs';

const program = humanWaitProgram({ loopId: 'hw' });

export default durableProject({
  projectId: 'p16-human-wait-operator',
  projectKind: 'human-wait',
  description: 'Scripted operator disposition of a runtime human wait: gate human-wait -> enterHumanWait -> resolveHumanResponse (public command) -> accepted re-drive -> full ladder.',
  program,
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'operator-discharges-human-wait', 'workplace-terminal-success', 'determinism-replay'],
  expectedWaits: [
    { kind: 'TypedWait:human-input', state: 'discharged' },
    { kind: 'TypedWait:human-input', state: 'discharged' },
  ],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'node-run:1', status: 'human-decision-recorded' },
    { instanceId: 'factory-run:1', status: 'started' },
  ],
  notes: [
    'Both human-input waits (the gate verdict and enterHumanWait) are discharged exactly by the operator commands.',
    'KERNEL RESIDUAL (recorded honestly, not worked around): the node reducer has no cell-acceptance edge from the human-decision path, so the run ladder cannot close past a human-decision node; the honest terminal of the human-wait arm is the workplace terminal proof (the WP-13B reference terminal).',
  ],
});
