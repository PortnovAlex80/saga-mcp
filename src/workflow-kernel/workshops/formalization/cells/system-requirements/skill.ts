/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * skill.ts - the DESK SKILL DECLARATION and PRODUCT TEMPLATE of the
 * derive-system-requirements Production Cell (FRF-WP05).
 *
 * The desk skill id follows the installed manifest's convention
 * (`formalization-desk-${desk}`, manifest.ts install()): this cell serves
 * the installed desk `derive-system-requirements`, so its semantic skill
 * is `formalization-desk-derive-system-requirements`. The skill artifact
 * has the frozen WP-17 shape (ek.skill-artifact.ek1.v1: cognition
 * instructions only, never policy) so the cell's role contracts can pin
 * it (./roles.ts).
 *
 * The PRODUCT TEMPLATE is the authored skeleton the desk worker fills:
 * one row skeleton per requirement kind with the derivation reference
 * classes of the WP02 reverse graph (edges 0054-0062) and the three
 * derivation laws embedded as filling rules.
 *
 * PURITY: frozen data + content digests. No I/O, no session, no clock.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { SkillArtifact } from '../../../../roles/shapes.js';
import {
  DERIVATION_LAWS,
  REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  SYSTEM_REQUIREMENTS_DESK_ID,
} from './contract.js';

/** The desk skill id (the installed manifest's `formalization-desk-${desk}` row). */
export const SYSTEM_REQUIREMENTS_DESK_SKILL_ID = `formalization-desk-${SYSTEM_REQUIREMENTS_DESK_ID}` as const;

/** The semantic-skill instructions of the desk (cognition only, never policy). */
export const SYSTEM_REQUIREMENTS_SKILL_INSTRUCTIONS = [
  'You author the requirements bundle of the derive-system-requirements desk: FR, NFR and RULE members derived from the exact accepted PRD intent members and UC scenarios carried by the transition.',
  'Input surfaces: the accepted PRD revision (its intent-member id set) and the accepted UC revision (its scenario id set and each scenario terminal-branch id set); accepted source constraints and accepted verification surfaces for the cross-cutting and verification bindings.',
  'Law L1 (exact derivation lineage): every requirement binds exact PRD intent members. A scenario-derived FR also binds exact UC scenario identities AND exact terminal-branch identities of those scenarios; a scenario-local NFR or RULE may bind UC; a cross-cutting NFR or RULE may bind accepted source constraints directly and is never forced into a fictional user scenario.',
  'Law L2 (verification-surface coverage): every requirement names at least one accepted verification surface. A requirement you cannot verify through any accepted surface is a coverage gap - do not author it silently; surface the gap.',
  'Law L3 (revision-pin match): the bundle pins the exact accepted PRD and UC revision digests. Never copy a pin from a superseded or foreign revision.',
  'Every accepted UC scenario must produce at least one observable behavior obligation (an FR, a RULE or a scenario-local NFR). If a scenario yields none, the bundle is refused - author its obligation or route the gap upstream.',
  'Produce only the requirements bundle. Do not author scenarios, acceptance criteria, architecture or handoff material: those desks own them.',
  'When the WP03 validation check is indeterminate, the desk waits for the operator (a D5 typed wait). Never weaken or bypass the validator.',
  ...DERIVATION_LAWS.map((law) => `Declared law ${law.lawId} (${law.refusal}): ${law.statement}.`),
].join('\n');

/** The desk skill artifact (frozen WP-17 shape; pinned by ./roles.ts). */
export const SYSTEM_REQUIREMENTS_SKILL_ARTIFACT: SkillArtifact = {
  schemaVersion: 'ek.skill-artifact.ek1.v1',
  skillId: SYSTEM_REQUIREMENTS_DESK_SKILL_ID,
  instructions: SYSTEM_REQUIREMENTS_SKILL_INSTRUCTIONS,
};

/** The installed-style semantic skill declaration of the desk (content-addressed). */
export interface DeskSkillDeclaration {
  readonly skillId: typeof SYSTEM_REQUIREMENTS_DESK_SKILL_ID;
  readonly kind: 'semantic';
  readonly servesDesks: readonly (typeof SYSTEM_REQUIREMENTS_DESK_ID)[];
  readonly contractKind: typeof REQUIREMENTS_BUNDLE_CONTRACT_KIND;
  readonly digest: string;
}

export const SYSTEM_REQUIREMENTS_SKILL_DECLARATION: DeskSkillDeclaration = Object.freeze({
  skillId: SYSTEM_REQUIREMENTS_DESK_SKILL_ID,
  kind: 'semantic',
  servesDesks: [SYSTEM_REQUIREMENTS_DESK_ID],
  contractKind: REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  digest: sha256OfCanonical(SYSTEM_REQUIREMENTS_SKILL_ARTIFACT),
});

/* ------------------------------------------------------------------ */
/* The product template                                                */
/* ------------------------------------------------------------------ */

/** One row skeleton of the product template. */
export interface TemplateRow {
  readonly requirementKind: 'FR' | 'NFR' | 'RULE';
  readonly derivationGuide: string;
  readonly example: {
    readonly requirementId: string;
    readonly statement: string;
    readonly derivation: {
      readonly prdIntentRefs: readonly string[];
      readonly ucScenarioRefs?: readonly string[];
      readonly ucTerminalBranchRefs?: readonly string[];
      readonly sourceConstraintRefs?: readonly string[];
    };
    readonly verificationSurfaceRefs: readonly string[];
  };
}

/**
 * The product template: the authored skeleton of the bundle. Each row
 * carries its WP02 reverse-graph derivation guide and a worked example
 * (edges 0054-0056 for FR; 0057-0059 for NFR; 0060-0062 for RULE).
 */
export const SYSTEM_REQUIREMENTS_PRODUCT_TEMPLATE: readonly TemplateRow[] = Object.freeze([
  {
    requirementKind: 'FR',
    derivationGuide:
      'Scenario-derived functional requirement: exact PRD intent members + exact UC scenario identities + exact terminal-branch identities of the cited scenarios (reverse edges 0054, 0055, 0056). One FR (or RULE, or scenario-local NFR) must obligate every material UC system response.',
    example: {
      requirementId: 'fr:<subject>-1',
      statement: 'The system shall <observable behavior> for the <scenario> scenario.',
      derivation: {
        prdIntentRefs: ['prd:<intent-member-id>'],
        ucScenarioRefs: ['uc:<scenario-id>'],
        ucTerminalBranchRefs: ['branch:<terminal-branch-id>'],
      },
      verificationSurfaceRefs: ['surface:<verification-surface-id>'],
    },
  },
  {
    requirementKind: 'NFR',
    derivationGuide:
      'Quality requirement: exact PRD intent members always; UC scenario identities only when scenario-local (never forced into a fictional scenario); accepted source constraints directly when cross-cutting (reverse edges 0057, 0058, 0059).',
    example: {
      requirementId: 'nfr:<quality>-1',
      statement: 'The system shall <measurable quality property> within <bound>.',
      derivation: {
        prdIntentRefs: ['prd:<constraint-member-id>'],
        sourceConstraintRefs: ['constraint:<source-constraint-id>'],
      },
      verificationSurfaceRefs: ['surface:<verification-surface-id>'],
    },
  },
  {
    requirementKind: 'RULE',
    derivationGuide:
      'Operational/compliance rule: exact PRD intent members always; UC scenario identities only when scenario-local; accepted source constraints directly when cross-cutting (reverse edges 0060, 0061, 0062).',
    example: {
      requirementId: 'rule:<domain>-1',
      statement: 'Every <event> shall <mandatory operational consequence>.',
      derivation: {
        prdIntentRefs: ['prd:<boundary-member-id>'],
      },
      verificationSurfaceRefs: ['surface:<audit-or-monitoring-surface-id>'],
    },
  },
]);
