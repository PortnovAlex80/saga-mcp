/**
 * workflow-kernel/workshops/development/manifest.ts - the INSTALLED
 * WORKSHOP MANIFEST of the converted Development workshop (WP-11V, plan
 * EK-8): identity, input/output product schemas, installed skills, tools
 * and hooks - all manifest DATA.
 *
 * Module/package identity law: the workshop's identity (id, class, version,
 * process-module reference) lives HERE and in the installed manifests -
 * never in a kernel conditional. The class name of the lifecycle family is
 * READ FROM the frozen role-contract manifest at build time (single
 * source), never restated as a source literal (the EK-2 complexity
 * dimension workshops.nameBranchLiterals stays zero).
 *
 * PURITY: pure data builders. No I/O, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import { manifestBindingByLaunchKind } from '../../roles/compiler.js';
import { implementerLaunchKind } from '../../roles/fixtures/index.js';
import type {
  HookDeclaration,
  ProductSchemaDeclaration,
  SkillDeclaration,
  ToolDeclaration,
  WorkshopInstallation,
} from './installation.js';
import { developmentCheckPlanRows } from './checkplans.js';
import { developmentGateDeclarations } from './checkplans.js';
import { developmentEffectDeclaration } from './effects.js';
import { developmentWaitDeclarations } from './waits.js';

/** The lifecycle family class of this workshop, read from the frozen manifest row (never a source literal). */
export function developmentWorkshopClass(): string {
  const row = manifestBindingByLaunchKind(implementerLaunchKind);
  if (row === undefined) {
    throw new Error('WORKSHOP_MANIFEST_INCOMPLETE: the frozen installed manifest holds no row for the implementation author launch kind of this workshop');
  }
  return row.workshop;
}

/** The complete installed workshop (the EK-8 workshop semantic interface value). */
export function developmentWorkshopInstallation(): WorkshopInstallation {
  return {
    identity: {
      workshopId: 'workshop:development',
      workshopClass: developmentWorkshopClass(),
      version: 'ek.workshop-installation.ek8.v1',
      processModuleRef: 'content://process-modules/development-production-cell@ek8',
    },
    products: developmentProductSchemas(),
    installed: {
      skills: developmentInstalledSkills(),
      tools: developmentInstalledTools(),
      hooks: developmentInstalledHooks(),
    },
    checkPlans: developmentCheckPlanRows(),
    gates: developmentGateDeclarations(),
    effects: [developmentEffectDeclaration()],
    waits: developmentWaitDeclarations(),
  };
}

/* ------------------------------------------------------------------ */
/* Product schemas                                                     */
/* ------------------------------------------------------------------ */

/** The input/output product schemas of the workshop (the phase vocabulary is data). */
export function developmentProductSchemas(): readonly ProductSchemaDeclaration[] {
  return [
    {
      schemaId: 'workshop.development.integrated-candidate.v1',
      role: 'input',
      phase: 'review',
      fields: [
        { name: 'capsuleRef', kind: 'string', required: true },
        { name: 'productDigest', kind: 'digest', required: true },
        { name: 'scopeRefs', kind: 'ref-list', required: true },
        { name: 'toolCallDigest', kind: 'digest', required: true },
        { name: 'summary', kind: 'string', required: true },
      ],
    },
    {
      schemaId: 'workshop.development.review-verdict-payload.v1',
      role: 'input',
      phase: 'integration',
      fields: [
        { name: 'capsuleRef', kind: 'string', required: true },
        { name: 'reviewerProductDigest', kind: 'digest', required: false },
        { name: 'surfacedVerdict', kind: 'enum', values: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'], required: false },
        { name: 'toolCallDigest', kind: 'digest', required: true },
        { name: 'text', kind: 'ref-list', required: false },
      ],
    },
    {
      schemaId: 'workshop.development.readiness-manifest.v1',
      role: 'input',
      phase: 'certification',
      fields: [
        { name: 'capsuleRef', kind: 'string', required: true },
        { name: 'workplaceInstanceId', kind: 'string', required: true },
        { name: 'machineObservation', kind: 'enum', values: ['product-verified', 'product-verification-failed'], required: true },
        { name: 'verificationDigest', kind: 'digest', required: true },
        { name: 'settledEvidenceKinds', kind: 'ref-list', required: true },
        { name: 'unobservable', kind: 'enum', values: ['readiness-for-certification'], required: true },
        { name: 'requiredDisposition', kind: 'ref', required: true },
      ],
    },
    {
      schemaId: 'workshop.development.verified-bundle.v1',
      role: 'output',
      phase: 'verified',
      fields: [
        { name: 'capsuleRef', kind: 'string', required: true },
        { name: 'workplaceInstanceId', kind: 'string', required: true },
        { name: 'acceptanceDigest', kind: 'digest', required: true },
        { name: 'terminalProofs', kind: 'ref-list', required: true },
        { name: 'claimCoverageRefs', kind: 'ref-list', required: true },
        { name: 'runTerminalOutcome', kind: 'enum', values: ['success'], required: true },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Installed skills, tools and hooks                                   */
/* ------------------------------------------------------------------ */

function contentAddressedSkill(skillId: string, instructions: string): SkillDeclaration {
  return {
    skillId,
    instructionsRef: `sha256:${sha256OfCanonical({ skillId, instructions })}`,
    digest: sha256OfCanonical({ skillId, instructions }),
  };
}

function contentAddressedHook(event: string, additionalContext: unknown): HookDeclaration {
  return {
    event,
    additionalContextRef: `sha256:${sha256OfCanonical({ event, additionalContext })}`,
    digest: sha256OfCanonical({ event, additionalContext }),
  };
}

/** The installed skills of the workshop (cognition instructions, content-addressed). */
export function developmentInstalledSkills(): readonly SkillDeclaration[] {
  return [
    contentAddressedSkill(
      'workshop.development.skill.implementation-author',
      'Produce the cell material against the pinned product contracts; never widen scope; surface a human-wait request when readiness cannot be observed.',
    ),
    contentAddressedSkill(
      'workshop.development.skill.verification-reviewer',
      'Verify the candidate against the acceptance contract; return one of the frozen verdicts; prose-only verdicts are refused.',
    ),
    contentAddressedSkill(
      'workshop.development.skill.certifier-operator',
      'Operator-only readiness certification: dispose the readiness manifest after the machine evidence is complete; the machine never self-certifies readiness.',
    ),
  ];
}

/** The installed tools of the workshop (bounded schemas; the role contract pins the allowed set). */
export function developmentInstalledTools(): readonly ToolDeclaration[] {
  return [
    { toolRef: 'tool:read-file', schemaSummary: '(path) -> bytes' },
    { toolRef: 'tool:write-file', schemaSummary: '(path, bytes) -> receipt' },
    { toolRef: 'tool:run-command', schemaSummary: '(cmd) -> exit+stdout (bounded)' },
    { toolRef: 'tool:verify-product', schemaSummary: '() -> ProductVerificationEvidence|ProductVerificationFailure (external Input authority)' },
  ];
}

/** The installed hooks of the workshop (context injection points, content-addressed). */
export function developmentInstalledHooks(): readonly HookDeclaration[] {
  return [
    contentAddressedHook('SessionStart', { inject: 'workshop:development installed CheckPlan summary + capsule scope refs' }),
    contentAddressedHook('PostToolUse', { inject: 'bounded tool result (the cumulative accountant admits the exact next request)' }),
  ];
}
