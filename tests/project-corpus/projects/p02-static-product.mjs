/**
 * p02-static-product - the STATIC product family: a fully materialized
 * browser entry + asset + stylesheet with NO server. The honest static
 * analogue of the loopback is the structure hook (surfaces, references,
 * render target), and determinism is the second build producing the
 * byte-identical digest.
 */
import { developmentProject, developmentExpectations } from '../scaffold.mjs';

export default developmentProject({
  projectId: 'p02-static-product',
  projectKind: 'static',
  description: 'Static product (no runtime): capsule ingress -> material chain over the static-site product; verification = build + structure hook + deterministic re-build.',
  product: { class: 'static-site', verification: 'build-structure-determinism', fixture: 'static-site' },
  expectations: developmentExpectations(),
  expectationPolicies: {
    events: 'declared-subset',
    obligations: 'declared-subset',
    'evidence.material': 'declared-subset',
    'evidence.gate': 'declared-subset',
    'evidence.effect': 'declared-subset',
  },
  justifications: {
    events: 'the material chain schedules its command order internally; declared kinds with multiplicity floor are asserted',
    obligations: 'the chain settles lanes internally; the closed set is proven by the WP-08 obligation-consumer tests',
    'evidence.material': 'per-loop material counts follow the WP-08 chain implementation',
    'evidence.gate': 'gate verdict kinds follow the chain scripts',
    'evidence.effect': 'exactly one success receipt over the verified static product',
  },
  expectedWorldHeads: [
    { instanceId: 'workplace:1', status: 'terminal', terminal: 'TerminalProof:workplace.success' },
    { instanceId: 'factory-run:1', status: 'terminal', terminal: 'TerminalProof:run.success' },
  ],
  expectedInvariants: ['no-invariant-violations', 'workplace-terminal-success', 'product-verification-green', 'product-determinism'],
  notes: ['The static product gate = build + structure hook (no server to loopback); determinism = identical build digest on re-build.'],
});
