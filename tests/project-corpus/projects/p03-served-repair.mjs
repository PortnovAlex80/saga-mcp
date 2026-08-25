/**
 * p03-served-repair - the interactive SERVED product whose first author
 * submission is answered with a repair verdict: the D6 repair loop
 * (enterRepairWait -> rolloverRepairEpoch -> author re-admission) walks
 * through public commands and the repaired submission is accepted; the
 * product still verifies green at the end.
 */
import { durableProject } from '../scaffold.mjs';
import { servedDeskProgram } from '../programs.mjs';

const program = servedDeskProgram({ loopId: 'desk', repairRounds: 1 });

export default durableProject({
  projectId: 'p03-served-repair',
  projectKind: 'interactive-served',
  description: 'Served product with one D6 repair epoch: repair verdict -> repair wait -> epoch rollover -> author re-submission accepted -> full success ladder.',
  program,
  product: { class: 'served-html-app', verification: 'build-loopback-smoke', fixture: 'simple-server' },
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'one-admitted-receipt-per-attempt', 'product-verification-green'],
  expectationPolicies: {
    obligations: 'declared-subset',
  },
  justifications: {
    obligations: 'every attempt loop lane must be completed; the full open-row multiset includes mode-internal lane rows the universe tables alone do not determine',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
    { instanceId: 'lifecycle-run:1', status: 'terminal', terminal: 'TerminalProof:lifecycle.success' },
  ],
  notes: ['The repair loop exercises workplace.enterRepairWait + workplace.rolloverRepairEpoch (retry arm) before the accepted re-submission.'],
});
