/**
 * workflow-kernel/workshops/formalization/cells/product-intent/cell.ts -
 * the define-product-intent Production Cell package declaration
 * (FRF-WP04): protocol (input brief/capsule intents -> output WP03 PRD
 * intent members), installed skill declarations, the author-facing
 * product template, the WP-17 role bindings, and the cross-desk
 * accepted-intent-set fold the model-use-cases Cell consumes.
 *
 * NEW PARALLEL CONSTRUCTION (plan FRF-WP04): this file edits no existing
 * formalization module and is wired into no manifest; it is reachable
 * only from focused tests until the coordinator integrates the package
 * in FRF-11. The old flow stays authoritative until then.
 *
 * PURITY: pure data + pure functions over the kernel digest rule.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { FormalizationRoleBinding, InstalledSkillDeclaration } from '../../manifest.js';
import { PRODUCT_INTENT_CONTRACT_KIND } from './seam.js';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const PRODUCT_INTENT_CELL_ID = 'define-product-intent';
/** The Cell's bundle product kind (a bundle of WP03 member payloads). */
export const PRODUCT_INTENT_CELL_PRODUCT_KIND = 'frf-cell.product-intent.v1';
/** The declared successor on domain.accepted (wired into the flow by FRF-11). */
export const PRODUCT_INTENT_CELL_SUCCESSOR = 'model-use-cases';

/** Bundle-level fence keys: the intent desk produces intent, never finals. */
export const PRODUCT_INTENT_FORBIDDEN_BUNDLE_KEYS = [
  'acceptance',
  'acceptanceCriteria',
  'fr',
  'nfr',
  'requirements',
  'rule',
  'scenarios',
  'srs',
  'useCases',
] as const;

/* ------------------------------------------------------------------ */
/* The desk protocol (input: brief + capsule intents; output: members)  */
/* ------------------------------------------------------------------ */

/** One Discovery capsule intent entering the desk (ingress-shaped input). */
export interface CapsuleIntentInput {
  readonly intentId: string;
  readonly statement: string;
  readonly sourceClaimRefs: readonly string[];
}

/** The protocol input envelope of the desk. */
export interface ProductIntentProtocolInput {
  readonly brief: string;
  readonly capsuleIntents: readonly CapsuleIntentInput[];
}

/** A member DRAFT: protocol-seeded, not yet authored (disposition TBD). */
export interface ProductIntentMemberDraft {
  readonly memberId: string;
  readonly memberKind: null;
  readonly statement: string;
  readonly sourceClaimRefs: readonly string[];
  readonly disposition: null;
}

/** The installed desk protocol (pure declaration data). */
export interface ProductIntentCellProtocol {
  readonly nodeId: typeof PRODUCT_INTENT_CELL_ID;
  readonly productKind: typeof PRODUCT_INTENT_CELL_PRODUCT_KIND;
  readonly adoptedContractKind: typeof PRODUCT_INTENT_CONTRACT_KIND;
  readonly input: {
    readonly kinds: readonly ['brief', 'discovery-capsule.intents'];
    readonly envelope: 'ProductIntentProtocolInput';
  };
  readonly output: {
    readonly container: 'brief+PRD';
    readonly memberField: 'members';
    readonly contractKind: typeof PRODUCT_INTENT_CONTRACT_KIND;
  };
  readonly fences: readonly string[];
  readonly declaredTransitions: readonly { readonly on: 'domain.accepted' | 'domain.failed'; readonly to: string }[];
}

export function productIntentProtocol(): ProductIntentCellProtocol {
  return {
    nodeId: PRODUCT_INTENT_CELL_ID,
    productKind: PRODUCT_INTENT_CELL_PRODUCT_KIND,
    adoptedContractKind: PRODUCT_INTENT_CONTRACT_KIND,
    input: { kinds: ['brief', 'discovery-capsule.intents'], envelope: 'ProductIntentProtocolInput' },
    output: { container: 'brief+PRD', memberField: 'members', contractKind: PRODUCT_INTENT_CONTRACT_KIND },
    fences: [...PRODUCT_INTENT_FORBIDDEN_BUNDLE_KEYS],
    declaredTransitions: [
      { on: 'domain.accepted', to: PRODUCT_INTENT_CELL_SUCCESSOR },
      { on: 'domain.failed', to: 'complete-failed' },
    ],
  };
}

/**
 * The deterministic protocol step: seed one member draft per capsule
 * intent. Drafts are NOT products - they carry no memberKind and no
 * disposition; the gate refuses them (WP03: COVERAGE_GAP / MALFORMED)
 * until the author disposes every member. Seeding is injective and
 * order-preserving; ids derive from the capsule intent ids.
 */
export function memberDraftsOfCapsuleIntents(input: ProductIntentProtocolInput): readonly ProductIntentMemberDraft[] {
  return input.capsuleIntents.map((intent) => ({
    memberId: `prd:${intent.intentId}`,
    memberKind: null,
    statement: intent.statement,
    sourceClaimRefs: [...intent.sourceClaimRefs],
    disposition: null,
  }));
}

/* ------------------------------------------------------------------ */
/* Installed skill declarations (manifest-data pattern)                */
/* ------------------------------------------------------------------ */

export const PRODUCT_INTENT_PROTOCOL_SKILL_ID = 'frf-cell-product-intent-protocol';
export const PRODUCT_INTENT_SEMANTIC_SKILL_ID = 'frf-cell-product-intent-semantic';

export function productIntentSkillDeclarations(): readonly InstalledSkillDeclaration[] {
  return [
    {
      skillId: PRODUCT_INTENT_PROTOCOL_SKILL_ID,
      kind: 'protocol',
      servesDesks: [PRODUCT_INTENT_CELL_ID],
      digest: sha256OfCanonical({ skillId: PRODUCT_INTENT_PROTOCOL_SKILL_ID, kind: 'protocol', desk: PRODUCT_INTENT_CELL_ID }),
    },
    {
      skillId: PRODUCT_INTENT_SEMANTIC_SKILL_ID,
      kind: 'semantic',
      servesDesks: [PRODUCT_INTENT_CELL_ID],
      digest: sha256OfCanonical({
        skillId: PRODUCT_INTENT_SEMANTIC_SKILL_ID,
        kind: 'semantic',
        desk: PRODUCT_INTENT_CELL_ID,
        contract: PRODUCT_INTENT_CONTRACT_KIND,
      }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The product template (author-facing, pure data)                     */
/* ------------------------------------------------------------------ */

/**
 * The fill-in template for one PRD intent member. The closed vocabularies
 * are duplicated here for AUTHORING ONLY (desk guidance); enforcement is
 * exclusively the WP03 validator's (never this template's copy).
 */
export interface ProductIntentMemberTemplate {
  readonly templateId: 'frf-cell.product-intent.member-template.v1';
  readonly contractKind: typeof PRODUCT_INTENT_CONTRACT_KIND;
  readonly idPattern: string;
  readonly requiredFields: readonly string[];
  readonly vocabularies: {
    readonly memberKinds: readonly string[];
    readonly dispositions: readonly string[];
  };
  readonly dispositionRequirements: readonly string[];
  readonly example: Record<string, unknown>;
}

export function productIntentMemberTemplate(): ProductIntentMemberTemplate {
  return {
    templateId: 'frf-cell.product-intent.member-template.v1',
    contractKind: PRODUCT_INTENT_CONTRACT_KIND,
    idPattern: '^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$',
    requiredFields: ['schemaVersion', 'memberId', 'memberKind', 'statement', 'sourceClaimRefs', 'disposition'],
    vocabularies: {
      memberKinds: ['actor-stakeholder', 'assumption-unknown', 'constraint', 'outcome', 'scope-exclusion', 'system-boundary', 'terminal-claim'],
      dispositions: ['scenario_required', 'direct_requirement', 'deferred', 'out_of_scope'],
    },
    dispositionRequirements: [
      'exactly one disposition per member (closed four-value vocabulary)',
      'deferred and out_of_scope require owner and reason',
      'direct_requirement requires a reason (why no meaningful interaction or operational scenario exists)',
    ],
    example: {
      schemaVersion: PRODUCT_INTENT_CONTRACT_KIND,
      memberId: 'prd:outcome-1',
      memberKind: 'outcome',
      statement: 'A shopper can complete an end-to-end checkout of a cart and receive a delivered order confirmation.',
      sourceClaimRefs: ['claim:outcome-1'],
      scopeClaimRefs: ['claim:scope-1'],
      terminalClaimRefs: ['terminal:delivered-1'],
      disposition: { disposition: 'scenario_required' },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Role bindings (the WP-17 pattern; identity lives in the manifest)    */
/* ------------------------------------------------------------------ */

/**
 * The launch kinds this desk is staffed through. Data only: resolution
 * goes through the ONE kernel WP-17 resolver (never a second path).
 */
export function productIntentRoleBindings(): readonly FormalizationRoleBinding[] {
  return [
    { launchKind: 'formalization.implementation.author', protocolRole: 'author', semanticProfile: 'implementer' },
    { launchKind: 'formalization.implementation.reviewer', protocolRole: 'reviewer', semanticProfile: 'reviewer' },
  ];
}

/* ------------------------------------------------------------------ */
/* The cross-desk accepted-intent-set fold                             */
/* ------------------------------------------------------------------ */

/**
 * The ACCEPTED output of the Cell as downstream lineage state: the exact
 * accepted member ids, the member digests the WP03 seals recomputed, the
 * members dispositioned scenario_required (the UC coverage fence input),
 * and one content-addressed revision digest. The model-use-cases Cell
 * validates its prdIntentRefs against THIS set (cross-desk lineage).
 */
export interface AcceptedIntentSet {
  readonly revisionDigest: string;
  readonly prdMemberIds: readonly string[];
  readonly scenarioRequiredMemberIds: readonly string[];
  readonly memberDigests: readonly string[];
}

/** Fold an ACCEPTED bundle into the downstream accepted-intent set (pure). */
export function acceptedIntentSetOf(bundle: { readonly members?: readonly unknown[] }, seals: readonly { readonly memberId: string; readonly digest: string }[]): { readonly ok: true; readonly set: AcceptedIntentSet } | { readonly ok: false; readonly detail: string } {
  const members = bundle.members ?? [];
  if (members.length === 0 || seals.length !== members.length) {
    return { ok: false, detail: 'the accepted-intent fold needs one WP03 seal per accepted member (never a partial fold)' };
  }
  const seen = new Set<string>();
  const prdMemberIds: string[] = [];
  const scenarioRequiredMemberIds: string[] = [];
  for (const member of members) {
    const record = member as { memberId?: unknown; disposition?: { disposition?: unknown } };
    if (typeof record.memberId !== 'string' || seen.has(record.memberId)) {
      return { ok: false, detail: 'the accepted-intent fold refuses duplicate or unidentified members' };
    }
    seen.add(record.memberId);
    prdMemberIds.push(record.memberId);
    if (record.disposition?.disposition === 'scenario_required') {
      scenarioRequiredMemberIds.push(record.memberId);
    }
  }
  const memberDigests = seals.map((seal) => seal.digest).sort();
  return {
    ok: true,
    set: {
      revisionDigest: sha256OfCanonical({ memberDigests }),
      prdMemberIds,
      scenarioRequiredMemberIds,
      memberDigests,
    },
  };
}
