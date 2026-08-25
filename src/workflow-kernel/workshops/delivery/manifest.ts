/**
 * workflow-kernel/workshops/delivery/manifest.ts - the installed workshop
 * manifest DATA of the Delivery release workshop (WP-11L, plan phase EK-8).
 *
 * PLAN LAW (EK-8): "Keep module/package identity in installed manifests,
 * never in kernel conditionals." Everything workshop-semantic about the
 * release stage lives HERE as declaration data - the launch-kind bindings,
 * the installed skills, tools and hooks, the CheckPlan check set, the
 * declared deterministic providers and the product contracts. The kernel
 * (reducers, consumer, repositories) reads none of it to branch; the
 * structure test in this package scans for a workshop-identity conditional
 * and fails closed if one appears.
 *
 * The workshop identity itself is DERIVED from the frozen role-contract
 * manifest's launch-kind prefix (`<workshop>.<cell>.<role>`), never quoted
 * as a standalone literal in kernel scope - the complexity dimension
 * workshops.nameBranchLiterals (target 0, binding now) must stay green.
 *
 * LOCAL PACKAGING ONLY: the declared release policy asserts
 * externalDeployment === false and credentials === "none". Qualification of
 * this workshop NEVER depends on an external deployment system or any
 * credential - a policy declaring either is refused typed at preflight.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import { manifestBindingByLaunchKind } from '../../roles/compiler.js';
import type { ManifestBindingRow } from '../../roles/shapes.js';

/* ------------------------------------------------------------------ */
/* Launch-kind bindings (the frozen role-contract manifest rows)        */
/* ------------------------------------------------------------------ */

/** The author launch kind of this workshop's implementation cell. */
export const DELIVERY_AUTHOR_LAUNCH_KIND = 'delivery.implementation.author';
/** The reviewer launch kind of this workshop's implementation cell. */
export const DELIVERY_REVIEWER_LAUNCH_KIND = 'delivery.implementation.reviewer';

/** The workshop identity, derived from the launch-kind prefix (never a quoted literal). */
export function workshopOfLaunchKind(launchKind: string): string {
  return launchKind.split('.')[0] ?? '';
}

/** The exact manifest binding row of one launch kind (fail-closed: absent row = throw). */
export function deliveryBinding(launchKind: string): ManifestBindingRow {
  const binding = manifestBindingByLaunchKind(launchKind);
  if (binding === undefined) {
    throw new Error(`DELIVERY_MANIFEST: launch kind ${launchKind} is outside the installed role-contract manifest`);
  }
  return binding;
}

/**
 * The declared bindings of this workshop: exactly the author and reviewer
 * implementation-cell rows. EXACT ROLE-UNIVERSE EQUALITY: the derived
 * protocol-role set must equal the manifest's frozen role universe
 * {author, reviewer} - any drift is a typed refusal (never a silent
 * re-classification).
 */
export function deliveryBindings(): readonly ManifestBindingRow[] {
  return [deliveryBinding(DELIVERY_AUTHOR_LAUNCH_KIND), deliveryBinding(DELIVERY_REVIEWER_LAUNCH_KIND)];
}

/** The closed protocol-role universe this workshop admits (the frozen manifest's). */
export const DELIVERY_PROTOCOL_ROLES = ['author', 'reviewer'] as const;

/** Exact role-universe equality over the derived bindings (fail-closed). */
export function assertDeliveryRoleUniverse(bindings: readonly ManifestBindingRow[]): { readonly ok: true; readonly roles: readonly string[] } | { readonly refused: true; readonly reason: string; readonly detail: string } {
  const derived = [...new Set(bindings.map((binding) => binding.protocolRole))].sort();
  const expected = [...DELIVERY_PROTOCOL_ROLES].sort();
  if (derived.length !== expected.length || derived.some((role, index) => role !== expected[index])) {
    return {
      refused: true,
      reason: 'ROLE_UNIVERSE_MISMATCH',
      detail: `derived protocol roles [${derived.join(', ')}] != the frozen universe [${expected.join(', ')}]; the workshop never widens its role universe`,
    };
  }
  const semantic = [...new Set(bindings.map((binding) => binding.semanticProfile))].sort();
  const expectedSemantic = ['implementer', 'reviewer'];
  if (semantic.length !== expectedSemantic.length || semantic.some((profile, index) => profile !== expectedSemantic[index])) {
    return {
      refused: true,
      reason: 'ROLE_UNIVERSE_MISMATCH',
      detail: `derived semantic profiles [${semantic.join(', ')}] != the manifest's [${expectedSemantic.join(', ')}]`,
    };
  }
  return { ok: true, roles: derived };
}

/* ------------------------------------------------------------------ */
/* Installed skills / tools / hooks (declaration data only)             */
/* ------------------------------------------------------------------ */

/** One installed skill declaration (cognition content is authored content). */
export interface InstalledSkillDeclaration {
  readonly skillId: string;
  readonly layer: 'protocol' | 'semantic';
  readonly summary: string;
}

/** One installed tool declaration (the closed tool surface of the cell). */
export interface InstalledToolDeclaration {
  readonly toolId: string;
  readonly capability: string;
  readonly scope: 'material.read' | 'material.write' | 'cognition.provider-request';
}

/** One installed hook declaration (fires at a declared boundary; data only). */
export interface InstalledHookDeclaration {
  readonly hookId: string;
  readonly event: 'pre-package' | 'post-package' | 'pre-release-record' | 'post-release-record';
  readonly summary: string;
}

/** The installed skills of the release cell. */
export const DELIVERY_INSTALLED_SKILLS: readonly InstalledSkillDeclaration[] = [
  { skillId: 'delivery-protocol-release', layer: 'protocol', summary: 'Cognition-only execution-protocol instructions for the release cell.' },
  { skillId: 'delivery-semantic-packaging', layer: 'semantic', summary: 'Cognition-only packaging semantics: local assembly, digests, release record.' },
];

/** The installed tools of the release cell (local packaging only). */
export const DELIVERY_INSTALLED_TOOLS: readonly InstalledToolDeclaration[] = [
  { toolId: 'fs:read', capability: 'read product tree entries', scope: 'material.read' },
  { toolId: 'fs:write', capability: 'write release-store entries', scope: 'material.write' },
  { toolId: 'saga-board', capability: 'board projection reads', scope: 'cognition.provider-request' },
];

/** The installed hooks of the release cell (fired by the driver as data). */
export const DELIVERY_INSTALLED_HOOKS: readonly InstalledHookDeclaration[] = [
  { hookId: 'delivery-pre-package', event: 'pre-package', summary: 'Observes the exact candidate digest before packaging starts.' },
  { hookId: 'delivery-post-package', event: 'post-package', summary: 'Observes the package digest after packaging commits.' },
  { hookId: 'delivery-pre-release-record', event: 'pre-release-record', summary: 'Observes the assembled release-record inputs.' },
  { hookId: 'delivery-post-release-record', event: 'post-release-record', summary: 'Observes the sealed release record hash.' },
];

/* ------------------------------------------------------------------ */
/* The CheckPlan (declared checks + deterministic declared providers)   */
/* ------------------------------------------------------------------ */

/** The closed check-id universe of this workshop's CheckPlan. */
export const DELIVERY_CHECK_IDS = [
  'bundle-digest-verify',
  'certificate-verified',
  'policy-bound-candidate',
  'packaging-input-assemblable',
  'local-only-policy',
] as const;
export type DeliveryCheckId = (typeof DELIVERY_CHECK_IDS)[number];

/**
 * The declared deterministic providers of the check set. Every provider is
 * a pure deterministic function (no network, no clock, no credential); an
 * undeclared check id in a release policy is refused fail-closed at
 * preflight (never silently skipped, never guessed).
 */
export const DECLARED_CHECK_PROVIDERS: Readonly<Record<string, (input: { readonly ok: boolean; readonly detail: string }) => { readonly ok: boolean; readonly detail: string }>> = {
  'bundle-digest-verify': (reported) => reported,
  'certificate-verified': (reported) => reported,
  'policy-bound-candidate': (reported) => reported,
  'packaging-input-assemblable': (reported) => reported,
  'local-only-policy': (reported) => reported,
};

/** True iff the check id is declared in this workshop's CheckPlan. */
export function isDeclaredCheck(checkId: string): boolean {
  return (DELIVERY_CHECK_IDS as readonly string[]).includes(checkId);
}

/* ------------------------------------------------------------------ */
/* Declared authorized-decision providers (the operator identity set)   */
/* ------------------------------------------------------------------ */

/**
 * The declared authorized-decision providers who may record a release
 * approval decision (the operator identity set; deterministic declaration,
 * no database, no credential).
 */
export interface DeclaredDecisionProvider {
  readonly providerId: string;
  readonly name: string;
  readonly category: 'authorized_decision';
}

export const DECLARED_DECISION_PROVIDERS: readonly DeclaredDecisionProvider[] = [
  { providerId: 'operator-release-1', name: 'Release Operator One', category: 'authorized_decision' },
  { providerId: 'operator-release-2', name: 'Release Operator Two', category: 'authorized_decision' },
];

/** True iff the provider id is a declared authorized-decision provider. */
export function isDeclaredDecisionProvider(providerId: string): boolean {
  return DECLARED_DECISION_PROVIDERS.some((provider) => provider.providerId === providerId);
}

/* ------------------------------------------------------------------ */
/* The declared release policy + the product contracts                 */
/* ------------------------------------------------------------------ */

/** The local-only release policy declaration (manifest data). */
export interface DeclaredReleasePolicy {
  readonly policyId: string;
  readonly version: string;
  readonly channel: string;
  readonly humanApprovalRequired: true;
  readonly requiredCheckIds: readonly string[];
  /** LOCAL PACKAGING ONLY: no external deployment, ever. */
  readonly externalDeployment: false;
  /** No credential participates in qualification, ever. */
  readonly credentials: 'none';
}

/** The workshop's one declared release policy. */
export const DELIVERY_RELEASE_POLICY: DeclaredReleasePolicy = {
  policyId: 'delivery-local-release-policy',
  version: '1',
  channel: 'local',
  humanApprovalRequired: true,
  requiredCheckIds: [...DELIVERY_CHECK_IDS],
  externalDeployment: false,
  credentials: 'none',
};

/** The content address of the declared policy (candidate/policy binding input). */
export function deliveryPolicyDigestOf(policy: DeclaredReleasePolicy): string {
  return sha256OfCanonical({ ...policy });
}

/* ------------------------------------------------------------------ */
/* Input/output product contracts (declaration data)                    */
/* ------------------------------------------------------------------ */

/** The input product contract: the verified Development bundle in. */
export const DELIVERY_INPUT_PRODUCT_CONTRACT = 'delivery.verified-development-bundle-input.v1';
/** The output product contract: the local release/packaging product out. */
export const DELIVERY_OUTPUT_PACKAGING_PRODUCT_CONTRACT = 'delivery.local-release-package.v1';
/** The output product contract: the immutable release record out. */
export const DELIVERY_OUTPUT_RELEASE_RECORD_CONTRACT = 'delivery.release-record.v1';
