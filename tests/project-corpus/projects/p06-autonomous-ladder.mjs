/**
 * p06-autonomous-ladder - the AUTONOMOUS product family: no human waits,
 * no uncertainty - a scripted author desk and reviewer desk settle the
 * whole ladder to the run terminal proof through public commands, with the
 * pure reference model (WP-13A) compared section-by-section against the
 * durable run.
 */
import { durableProject } from '../scaffold.mjs';
import { servedDeskProgram } from '../programs.mjs';

const program = servedDeskProgram({ loopId: 'desk' });

export default durableProject({
  projectId: 'p06-autonomous-ladder',
  projectKind: 'autonomous',
  description: 'Autonomous product: scripted author + reviewer desks, effect settled over the verified product, full ladder to TerminalProof:run.success; reference model compared section-wise.',
  program,
  product: { class: 'autonomous-decision', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'one-admitted-receipt-per-attempt', 'no-obligation-completed-twice', 'determinism-replay'],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'lifecycle-run:1', status: 'terminal', terminal: 'TerminalProof:lifecycle.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  notes: ['The seven-proof ladder (cell/workplace/node/process/stage/lifecycle/run) is authored from the universe proof tables.'],
});
