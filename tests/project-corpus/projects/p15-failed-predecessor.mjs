/**
 * p15-failed-predecessor - the HONEST-FAILURE family, failure ladder: cell
 * a fails TRUTHFULLY (repair verdict -> D6 repair-wait terminality), the
 * dependant b settles UNREACHABLE (D7 - never a silent block), and the
 * truthful-failure ladder runs to TerminalProof:run.truthful-failure. The
 * readiness boundary is probed while a is unaccepted: b must not be ready
 * and its gaps must be typed.
 */
import { conveyorProject, conveyorExpectations } from '../scaffold.mjs';

export default conveyorProject({
  projectId: 'p15-failed-predecessor',
  projectKind: 'honest-failure',
  description: 'Truthful failure ladder: a fails honestly, b settles unreachable (D7), the run terminalizes truthful-failure; the readiness boundary holds while a is unaccepted.',
  conveyorTopology: 'failed-predecessor',
  product: { class: 'none', verification: 'none', fixture: null },
  expectations: {
    ...conveyorExpectations({ cells: ['a', 'b'], failure: true }),
  },
  expectationPolicies: {
    events: 'declared-subset', obligations: 'declared-subset', waits: 'declared-subset',
    'evidence.material': 'declared-subset', 'evidence.gate': 'declared-subset', 'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'the conveyor schedules cell order internally; declared kinds with multiplicity floor are asserted',
    obligations: 'the failure ladder settles lanes internally',
    waits: 'the dependant readiness wait converts to unreachable settlement (D7)',
    'evidence.material': 'only the failing cell ran a desk; the dependant produced no material',
    'evidence.gate': 'the failing cell ends on a repair verdict',
    'evidence.effect': 'no effect settles over a failed cell',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.truthful-failure' },
    { instanceId: 'workplace:2', status: 'terminal', terminal: 'TerminalProof:workplace.unreachable' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.truthful-failure' },
  ],
  expectedInvariants: ['no-invariant-violations', 'truthful-failure-ladder', 'readiness-boundary-intact'],
});
