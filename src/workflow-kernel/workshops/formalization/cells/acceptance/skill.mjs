/**
 * FRF-WP06 define-acceptance-contract cell - THE SEMANTIC SKILL.
 *
 * The desk's installed skill identity follows the manifest.ts pattern
 * (skillId `formalization-desk-${desk}`, kind 'semantic', servesDesks
 * [desk], digest = sha256OfCanonical({ skillId, kind, desk })). This
 * module declares the FRF cell's semantic skill with that SAME identity
 * (continuity: the digest equals the installed manifest's generated
 * row - tested) plus the desk checklist of laws the author must apply.
 *
 * PURITY: pure data + the WP03 canonical digest rule. No I/O.
 */

import { sha256OfCanonical } from '../../../../../../docs/refactoring/formalization-frf/contracts/validators/common.mjs';
import { ACCEPTANCE_CELL_NODE_ID } from './protocol.mjs';

/** The installed semantic-skill id pattern of this desk (manifest.ts). */
export const ACCEPTANCE_SKILL_ID = `formalization-desk-${ACCEPTANCE_CELL_NODE_ID}`;

/** The desk author checklist (the laws, in gate order). */
export const ACCEPTANCE_SKILL_CHECKLIST = Object.freeze([
  Object.freeze({
    lawId: 'ac-1',
    law: 'Every criterion binds exact FR or NFR material (edges 0049/0050). RULE is not AC-bindable - the grammar allows AC to derive from FR or NFR only.',
    authority: 'plan:#Desk contracts/define-acceptance-contract',
  }),
  Object.freeze({
    lawId: 'ac-2',
    law: 'A scenario-facing criterion retains BOTH citation shapes: its exact UC scenario binding (edge 0051) AND its terminal-branch binding (edge 0052). Stripping either is a killed mutation (MISSING_LINEAGE).',
    authority: 'plan:#Target semantic trace grammar; reverse a-5',
  }),
  Object.freeze({
    lawId: 'ac-3',
    law: 'A criterion binding scenario-derived FR/NFR material cites the UC scenario and branch that material derives from (never an unrelated well-formed scenario).',
    authority: 'reverse edge/0051+0052 constraints; cr-08',
  }),
  Object.freeze({
    lawId: 'ac-4',
    law: 'Evidence kind is one of test, monitoring, audit, independent-agent-review, and an observable terminal result is declared (cr-05).',
    authority: 'plan:#Desk contracts/define-acceptance-contract; cr-05',
  }),
  Object.freeze({
    lawId: 'ac-5',
    law: 'AC remains WHAT-side verification: no architecture, module allocation, or file decisions (SCOPE_VIOLATION).',
    authority: 'plan:#Desk contracts/define-acceptance-contract',
  }),
  Object.freeze({
    lawId: 'ac-6',
    law: 'Every FR/NFR is covered by >=1 criterion or explicitly deferred with owner and reason; every required UC terminal result has >=1 end-to-end criterion or an accepted evidence binding (cr-05).',
    authority: 'plan:#Phase FRF-6; cr-05',
  }),
  Object.freeze({
    lawId: 'ac-7',
    law: 'Criterion ids are stable and unique across the bundle (duplicate ids are double emission).',
    authority: 'plan:#Desk contracts/define-acceptance-contract (atomic AC identity)',
  }),
]);

/** The installed skill declaration of this desk (manifest.ts shape). */
export const ACCEPTANCE_SKILL = Object.freeze({
  skillId: ACCEPTANCE_SKILL_ID,
  kind: 'semantic',
  servesDesks: Object.freeze([ACCEPTANCE_CELL_NODE_ID]),
  checklist: ACCEPTANCE_SKILL_CHECKLIST,
  get digest() {
    return sha256OfCanonical({ skillId: ACCEPTANCE_SKILL_ID, kind: 'semantic', desk: ACCEPTANCE_CELL_NODE_ID });
  },
});

/** The declaration exactly as the installed manifest generates it. */
export function acceptanceSkillDeclaration() {
  return Object.freeze({
    skillId: ACCEPTANCE_SKILL_ID,
    kind: 'semantic',
    servesDesks: [ACCEPTANCE_CELL_NODE_ID],
    digest: sha256OfCanonical({ skillId: ACCEPTANCE_SKILL_ID, kind: 'semantic', desk: ACCEPTANCE_CELL_NODE_ID }),
  });
}
