/**
 * s02-foreign-binding-mutations - the FOREIGN lineage sweep: one foreign
 * id (outside every accepted id set) substituted at each desk's binding
 * surface. Each desk's typed refusal surfaces the expected world -
 * FOREIGN_LINEAGE at the owning desk, routed upstream-repair by the cell
 * gates (the defect belongs to the upstream material), except the settle
 * desk where a foreign handoff binding routes the outcome inconsistent
 * and the Development case validator where a substituted-identity case is
 * refused before any planning (the consumer UC-FOREIGN kill).
 */
import { frfScenario } from './scaffold.mjs';

export default await frfScenario({
  scenarioId: 's02-foreign-binding-mutations',
  dimension: 'binding-mutation-sweep',
  mutations: [
    { kind: 'foreign-binding', target: 'define-product-intent:sourceClaimRefs' },
    { kind: 'foreign-binding', target: 'model-use-cases:prdIntentRefs' },
    { kind: 'foreign-binding', target: 'derive-system-requirements:prdIntentRefs' },
    { kind: 'foreign-binding', target: 'define-acceptance-contract:requirementRefs' },
    { kind: 'foreign-binding', target: 'settle-formalization:handoff.requirement-bindings' },
    { kind: 'foreign-binding', target: 'admit-development-case:scenario-bindings' },
  ],
  expectedWorld: {
    sweep: [
      { target: 'define-product-intent:sourceClaimRefs', reason: 'FOREIGN_LINEAGE', verdict: 'upstream-repair' },
      { target: 'model-use-cases:prdIntentRefs', reason: 'FOREIGN_LINEAGE', verdict: 'upstream-repair' },
      { target: 'derive-system-requirements:prdIntentRefs', reason: 'FOREIGN_LINEAGE', verdict: 'upstream-repair' },
      { target: 'define-acceptance-contract:requirementRefs', reason: 'FOREIGN_LINEAGE', verdict: 'upstream-repair' },
      { target: 'settle-formalization:handoff.requirement-bindings', reason: 'FOREIGN_LINEAGE', verdict: 'inconsistent' },
      { target: 'admit-development-case:scenario-bindings', reason: 'FOREIGN_LINEAGE', verdict: 'refused' },
    ],
  },
  notes: [
    'The consumer-side kill (admit-development-case) is validated through the public case validator over a green admitted case - a substituted-identity case never reaches planning.',
  ],
});
