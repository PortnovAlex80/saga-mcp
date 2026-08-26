/**
 * p18-restart-matrix - the RESTART-HEAVY project: a fault schedule whose
 * crash entries cover ALL 16 WP-07 registry points. A schedule arming more
 * than one crash is a MATRIX (one process dies once per execution): the
 * driver arms each entry in its own fresh database, crashes exactly at the
 * mapped registry point, restarts statelessly, and every settled world
 * must equal the clean golden world (scenario-level exactly-once).
 */
import { durableProject } from '../scaffold.mjs';
import { servedDeskProgram, IDS } from '../programs.mjs';

const program = servedDeskProgram({ loopId: 'desk' });

/* One crash entry per registry point (the boundary is named where the
   scenario vocabulary has one; the anchor command selects the window for
   the admission/send/worker-return points). */
const matrix = [
  { fault: 'crash-before-commit', boundary: 'before-event', anchor: { command: 'workplace.recordContribution', instanceId: IDS.workplace } },
  { fault: 'crash-after-event', boundary: 'after-event', anchor: { command: 'workplace.recordContribution', instanceId: IDS.workplace } },
  { fault: 'crash-before-commit', anchor: { command: 'factoryRun.start', instanceId: IDS.factory } },
  { fault: 'crash-after-event', anchor: { command: 'factoryRun.start', instanceId: IDS.factory } },
  { fault: 'crash-before-commit', anchor: { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' } },
  { fault: 'crash-after-event', anchor: { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' } },
  { fault: 'crash-before-commit', anchor: { command: 'cognition.sendProviderRequest', instanceId: IDS.transport } },
  { fault: 'crash-after-event', anchor: { command: 'cognition.sendProviderRequest', instanceId: IDS.transport } },
  { fault: 'crash-before-commit', boundary: 'before-worker', anchor: { command: 'cognition.sendProviderRequest', instanceId: IDS.transport } },
  { fault: 'crash-after-event', boundary: 'after-worker', anchor: { command: 'cognition.sendProviderRequest', instanceId: IDS.transport } },
  { fault: 'crash-before-commit', anchor: { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1' } },
  { fault: 'crash-after-event', anchor: { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1' } },
  { fault: 'crash-before-commit', boundary: 'before-gate', anchor: { command: 'workplace.runAuthorGate', instanceId: IDS.workplace } },
  { fault: 'crash-after-event', boundary: 'after-gate', anchor: { command: 'workplace.runAuthorGate', instanceId: IDS.workplace } },
  { fault: 'crash-before-commit', boundary: 'before-effect', anchor: { command: 'workplace.settleEffect', instanceId: IDS.workplace } },
  { fault: 'crash-after-event', boundary: 'after-effect', anchor: { command: 'workplace.settleEffect', instanceId: IDS.workplace } },
];

export default durableProject({
  projectId: 'p18-restart-matrix',
  projectKind: 'restart-heavy',
  description: 'Crash matrix over all 16 registry points: crash -> stateless restart -> settle; every settled world equals the clean golden world (exactly-once).',
  program,
  faultSchedule: matrix,
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'crash-matrix-covers-registry', 'exactly-once-under-schedule'],
  expectationPolicies: { obligations: 'declared-subset' },
  justifications: { obligations: 'every attempt loop lane must be completed; the open-row multiset includes mode-internal lane rows the universe tables alone do not determine' },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  notes: [
    'The 16 entries map one-to-one onto the WP-07 registry points (boundary map for the commit/worker/gate/effect seams, anchor-command windows for admission/send/worker-return).',
    'One process dies once: each matrix entry executes in its own fresh database.',
  ],
  ek11: { planId: 'P18', kind: 'import-export-with-recovery', fixture: 'qual:import-export', profile: ["build","api-smoke","package-receipt","persistence","recovery"] },
});
