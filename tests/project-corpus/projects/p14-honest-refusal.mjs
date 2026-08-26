/**
 * p14-honest-refusal - the HONEST-FAILURE family, typed refusal terminal:
 * the author completion is issued with a stale expected revision and the
 * kernel answers STALE_EXPECTED_REVISION - the typed refusal IS the
 * project's honest terminal. The world up to the refusal is complete and
 * consistent (no invariant violations), and nothing after the refused
 * step committed.
 */
import { durableProject } from '../scaffold.mjs';
import { authoredEvents, staleRefusalProgram } from '../programs.mjs';

const program = staleRefusalProgram({ loopId: 'refuse' });
/* The events committed BEFORE the refused step (the refused step emits none). */
const refusalIndex = program.findIndex((step) => step.behavior === 'stale-hash');
const eventsBeforeRefusal = authoredEvents(program.slice(0, refusalIndex));
/* The evidence materialized before the refusal: the attempt completed
/* (ProviderRoutePin/ActivityAttempt:completed are non-class kinds); the
   material classes stay empty until the contribution/seal/present/gate. */
const evidenceBeforeRefusal = { material: [], gate: [], effect: [] };

export default durableProject({
  projectId: 'p14-honest-refusal',
  projectKind: 'honest-failure',
  description: 'Honest typed-refusal terminal: a stale expected revision is answered STALE_EXPECTED_REVISION; the refusal stops the run and commits nothing.',
  program,
  product: { class: 'none', verification: 'none', fixture: null },
  expectedInvariants: ['typed-refusal-family', 'no-invariant-violations'],
  expectedRefusal: { stepId: 'refuse-author-1-contribution', reason: 'STALE_EXPECTED_REVISION' },
  expectedEvents: eventsBeforeRefusal,
  expectedEvidence: evidenceBeforeRefusal,
  expectedWaits: [],
  expectedObligations: [
    { kind: 'obligation:launchAdmission', state: 'completed' },
    { kind: 'obligation:providerSend', state: 'completed' },
  ],
  expectationPolicies: {
    obligations: 'declared-subset',
    'evidence.material': 'declared-subset',
    'evidence.gate': 'declared-subset',
    'evidence.effect': 'declared-subset',
  },
  justifications: {
    obligations: 'the attempt lanes completed; the refused contribution leaves its lane open (declared floor)',
    'evidence.material': 'the loop materialized its contribution only after the refused step - nothing is declared beyond the floor',
    'evidence.gate': 'no gate ran before the refusal',
    'evidence.effect': 'no effect settled before the refusal',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'author-intent-admitted' },
  ],
  notes: ['Authored events cover only the steps before the refusal: the refused application emits no event.'],
  ek11: { planId: 'P14', kind: 'multi-module-event-processor', fixture: 'qual:event-processor', profile: ["build","test","cli-smoke","package-receipt","determinism"] },
});
