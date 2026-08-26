/**
 * p01-served-happy - the interactive SERVED product happy path: a
 * Discovery+Formalization capsule imports through the WP-08 public ingress,
 * the material chain runs author -> reviewer -> final acceptance, and the
 * REAL product verifies hermetically (build + loopback over 127.0.0.1 +
 * browser smoke on a temp copy of the canonical simple-server fixture).
 */
import { developmentProject, developmentExpectations } from '../scaffold.mjs';

export default developmentProject({
  projectId: 'p01-served-happy',
  projectKind: 'interactive-served',
  description: 'Interactive served product (simple-server family): capsule ingress -> material chain -> CellFinalAcceptance -> run terminal proof, with real build+loopback+smoke product verification.',
  product: { class: 'served-html-app', verification: 'build-loopback-smoke', fixture: 'simple-server' },
  expectations: developmentExpectations(),
  expectationPolicies: {
    events: 'declared-subset',
    obligations: 'declared-subset',
    'evidence.material': 'declared-subset',
    'evidence.gate': 'declared-subset',
    'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'the material chain schedules its command order internally; the declared event kinds (with multiplicity floor) are asserted, the exact interleaving is WP-08 property',
    obligations: 'the chain settles lanes internally; the closed set is proven by the WP-08 obligation-consumer tests',
    'evidence.material': 'per-loop material counts follow the WP-08 chain implementation; the kinds are the closed material universe',
    'evidence.gate': 'gate verdict kinds follow the chain scripts; the verdict sequencing is asserted via proofs',
    'evidence.effect': 'the chain settles exactly one success receipt over the verified product',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'product-verification-green'],
  notes: ['The product check runs the fixture build/loopback/smoke scripts on a temp copy - hermetic (loopback on 127.0.0.1 ephemeral port).'],
  ek11: { planId: 'P01', kind: 'served-hello-frontend-api', fixture: 'repo:simple-server', profile: ["build","test","api-smoke","browser-smoke","package-receipt","determinism"] },
});
