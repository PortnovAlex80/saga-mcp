/**
 * s01-desk-chain-happy - THE HAPPY PATH: the WP03 frozen green fixtures
 * through ALL cells of the new semantic chain to the DevelopmentCase and
 * its plan:
 *   define-product-intent -> model-use-cases -> derive-system-requirements
 *   -> define-acceptance-contract -> reconcile-what (consistent)
 *   -> freeze-what-baseline -> define-architecture-contract
 *   -> settle-formalization -> admit-development-case -> plan-development.
 *
 * Expected world (authored from the WP03 vocabulary): every desk
 * accepted, the reconciliation verdict consistent, the twelve frozen
 * binding domains resolved to their exact frozen ids, the full capsule
 * sealed through public ingress.
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's01-desk-chain-happy',
  dimension: 'desk-chain-happy',
  expectedWorld: {
    verdicts: [
      { desk: 'define-product-intent', verdict: 'accepted' },
      { desk: 'model-use-cases', verdict: 'accepted' },
      { desk: 'derive-system-requirements', verdict: 'accepted' },
      { desk: 'define-acceptance-contract', verdict: 'accepted' },
      { desk: 'reconcile-what', verdict: 'consistent' },
      { desk: 'freeze-what-baseline', verdict: 'frozen' },
      { desk: 'define-architecture-contract', verdict: 'accepted' },
      { desk: 'settle-formalization', verdict: 'formalized' },
      { desk: 'admit-development-case', verdict: 'admitted' },
      { desk: 'plan-development', verdict: 'planned' },
    ],
    bindingDomains: [
      { kind: 'acceptance-bindings', ids: ['ac:checkout-end-1'] },
      { kind: 'formalization-certificate', ids: ['cert:disc-1', 'case:form-1'] },
      { kind: 'integration-and-construction-obligations', ids: ['svc:cart-api', 'module:audit-log'] },
      { kind: 'prd-intent-bindings', ids: ['prd:boundary-1'] },
      { kind: 'repository-and-policy-bindings', ids: ['repo:primary', 'policy:release-checklist'] },
      { kind: 'requirement-bindings', ids: ['fr:cart-1', 'nfr:retention-1'] },
      { kind: 'scenario-bindings', ids: ['uc:batch-1'] },
      { kind: 'scenario-realization-bindings', ids: ['realization:uc-checkout-1', 'realization:uc-batch-1'] },
      { kind: 'srs-reference-and-hash', ids: ['5f6b1c2a00000000000000000000000000000000000000000000000000000000'] },
      { kind: 'terminal-claim-bindings', ids: ['terminal:delivered-1'] },
    ],
    closure: { verdict: 'consistent', gapReasons: [] },
    waits: [],
    terminal: { developmentCase: 'admitted', plan: 'planned' },
    capsuleKinds: [
      'KernelEvidence:what-baseline',
      'formalization.acceptance-bindings.v1',
      'formalization.architecture-contract.v1',
      'formalization.what-reconciliation.v1',
      'frf-cell.product-intent.v1',
      'frf-cell.uc-scenarios.v1',
      'frf-contracts.requirements-bundle.v1',
      'frf-contracts.solution-contract.v1',
      'frf-development.case.v1',
      'frf-development.plan.v1',
    ],
  },
  notes: [
    'The binding domains are the settled solution contract twelve kinds minus the self-seal kind (solution-contract), whose value is the sealed digest of the contract itself.',
  ],
});
