/**
 * workflow-kernel/workshops/discovery/installed-manifest.ts - the INSTALLED
 * workshop manifest of this package (WP-11D; the frozen universe's
 * authority:InstalledWorkshopManifest declaration surface, R15).
 *
 * LAW (plan EK-8): module/package identity lives ONLY in installed
 * manifests, never in kernel conditionals. Everything below is DATA:
 *   - the module/package identity this workshop runs as;
 *   - the launch kinds it binds (the frozen role-contract manifest rows);
 *   - the skill, tool and hook DECLARATIONS (cognition instructions and
 *     injected context travel by content address, never by branch);
 *   - the product-contract corpus (products.ts) and the declared check
 *     providers (checkplans.ts) the gates run;
 *   - the typed-wait vocabulary declaration (waits.ts, D5/D12).
 *
 * No kernel or driver code may branch on any identity in here; consumers
 * READ declarations (fail-closed when a declaration is absent).
 *
 * PURITY: imports only sibling pure modules + domain/digest.js. No I/O.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { EvidenceFact } from '../../domain/types.js';
import { DISCOVERY_PRODUCT_CONTRACTS, productContractRef, type ProductContract } from './products.js';
import { DECLARED_CHECK_PROVIDERS, type DeclaredCheckProvider } from './checkplans.js';
import { DECLARED_WAIT_KINDS, type DeclaredWaitKind } from './waits.js';

/** The installed-manifest document version (versioned data, not a branch). */
export const INSTALLED_WORKSHOP_MANIFEST_VERSION = 'ek.installed-workshop-manifest.ek8.v1' as const;

/** One skill declaration: cognition instructions pinned by content address. */
export interface SkillDeclaration {
  readonly skillId: string;
  readonly instructions: string;
}

/** One tool declaration: the schema string the cognition layer exposes. */
export interface ToolDeclaration {
  readonly toolId: string;
  readonly schema: string;
}

/** One hook declaration: the event point + the additional context it injects. */
export interface HookDeclaration {
  readonly hookId: string;
  readonly event: 'session-start' | 'pre-send' | 'post-product';
  readonly additionalContext: string;
}

/** The installed workshop manifest value (all identity is data). */
export interface InstalledWorkshopManifest {
  readonly schemaVersion: typeof INSTALLED_WORKSHOP_MANIFEST_VERSION;
  readonly workshopLaunchKinds: readonly string[];
  readonly module: {
    readonly moduleId: string;
    readonly packageName: string;
    readonly moduleVersion: string;
  };
  readonly skills: readonly SkillDeclaration[];
  readonly tools: readonly ToolDeclaration[];
  readonly hooks: readonly HookDeclaration[];
  readonly productContracts: readonly ProductContract[];
  readonly checkProviders: readonly DeclaredCheckProvider[];
  readonly waitKinds: readonly DeclaredWaitKind[];
}

/* ------------------------------------------------------------------ */
/* The installed manifest of this package                              */
/* ------------------------------------------------------------------ */

/** The launch kinds this workshop binds (frozen role-contract manifest rows). */
export const DISCOVERY_LAUNCH_KINDS = {
  author: 'discovery.implementation.author',
  reviewer: 'discovery.implementation.reviewer',
} as const;

export const INSTALLED_WORKSHOP_MANIFEST: InstalledWorkshopManifest = {
  schemaVersion: INSTALLED_WORKSHOP_MANIFEST_VERSION,
  workshopLaunchKinds: [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer],
  module: {
    moduleId: 'saga.workshop.idea-to-decision.ek8',
    packageName: 'process-module:discovery-idea-to-decision',
    moduleVersion: '1.0.0',
  },
  skills: [
    {
      skillId: 'discovery-protocol-execution',
      instructions: 'Cognition-only execution protocol: admit exactly one provider request per attempt, record the ordinary outcome, never fabricate factory facts.',
    },
    {
      skillId: 'discovery-semantic-author',
      instructions: 'Author the brief from the admitted idea: restate the problem, the outcome, carry every constraint, surface every open question. Unknowns never disappear.',
    },
    {
      skillId: 'discovery-semantic-reviewer',
      instructions: 'Review the sealed brief revision, decide go / no-go / needs-human, and record the intent product bound to the accepted brief address.',
    },
  ],
  tools: [
    { toolId: 'tool:read-idea', schema: 'tool:read-idea (ideaRef) -> idea value' },
    { toolId: 'tool:write-brief', schema: 'tool:write-brief (brief value) -> receipt' },
    { toolId: 'tool:record-decision', schema: 'tool:record-decision (intent value) -> receipt' },
  ],
  hooks: [
    { hookId: 'discovery.hook.session-start', event: 'session-start', additionalContext: 'installed workshop manifest: idea-to-decision conversion' },
    { hookId: 'discovery.hook.pre-send', event: 'pre-send', additionalContext: 'idea conservation (D10): open questions carry the idea unknowns' },
    { hookId: 'discovery.hook.post-product', event: 'post-product', additionalContext: 'product contracts bind the sealed production revision' },
  ],
  productContracts: DISCOVERY_PRODUCT_CONTRACTS,
  checkProviders: DECLARED_CHECK_PROVIDERS,
  waitKinds: DECLARED_WAIT_KINDS,
};

/**
 * The installed manifest accessor. The declarations (providers, wait kinds)
 * are read from their owning pure modules; the manifest is the single
 * installed identity surface where they are assembled.
 */
export function installedWorkshopManifest(): InstalledWorkshopManifest {
  return INSTALLED_WORKSHOP_MANIFEST;
}

/** The manifest digest (canonical, recomputed - never trusted as declared). */
export function installedManifestDigest(manifest: InstalledWorkshopManifest = installedWorkshopManifest()): string {
  return sha256OfCanonical(manifest);
}

/* ------------------------------------------------------------------ */
/* The CheckPlan external-input evidence (R15)                         */
/* ------------------------------------------------------------------ */

/**
 * The CheckPlan evidence fact of one gate plan. Gates refuse without a
 * CheckPlan in the guard context (workplace.runAuthorGate/runFinalGate);
 * this builder derives the fact from the INSTALLED manifest - the plan is
 * manifest data, the fact is the external Input-authority evidence, and
 * the payload digest pins the manifest the plan came from.
 */
export function checkPlanEvidence(
  manifest: InstalledWorkshopManifest,
  planId: string,
  payloadDigest?: string,
): EvidenceFact {
  return {
    kind: 'CheckPlan',
    ref: `evidence:CheckPlan#${planId}`,
    producer: 'external-input',
    payloadDigest: payloadDigest ?? installedManifestDigest(manifest),
  };
}

/** The content addresses of the manifest's product contracts (contract pins). */
export function productContractRefs(manifest: InstalledWorkshopManifest = installedWorkshopManifest()): readonly string[] {
  return manifest.productContracts.map((contract) => productContractRef(contract));
}
