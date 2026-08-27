/**
 * workflow-kernel/workshops/formalization/cells/use-cases/cell.ts -
 * the model-use-cases Production Cell package declaration (FRF-WP04):
 * protocol (input brief/capsule intents + the upstream accepted intent
 * set -> output WP03 UC scenario members), installed skill
 * declarations, the author-facing product template, the WP-17 role
 * bindings, and the cross-desk accepted-scenario-set fold the
 * derive-system-requirements Cell (FRF-WP05) consumes.
 *
 * NEW PARALLEL CONSTRUCTION: edits no existing formalization module,
 * wired into no manifest, test-only reachable until FRF-11.
 *
 * PURITY: pure data + pure functions over the kernel digest rule.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { FormalizationRoleBinding, InstalledSkillDeclaration } from '../../manifest.js';
import type { AcceptedIntentSet } from '../product-intent/cell.js';
import { UC_SCENARIO_CONTRACT_KIND } from './seam.js';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export const UC_CELL_ID = 'model-use-cases';
/** The Cell's bundle product kind (a bundle of WP03 member payloads). */
export const UC_CELL_PRODUCT_KIND = 'frf-cell.uc-scenarios.v1';
/** The declared successor on domain.accepted (wired into the flow by FRF-11). */
export const UC_CELL_SUCCESSOR = 'derive-system-requirements';

/** Bundle-level fence keys: the UC desk never requires or produces finals. */
export const UC_FORBIDDEN_BUNDLE_KEYS = [
  'acceptance',
  'acceptanceCriteria',
  'frRefs',
  'nfrRefs',
  'requirementRefs',
  'requirements',
  'ruleRefs',
] as const;

/* ------------------------------------------------------------------ */
/* The desk protocol (input: intents + accepted PRD; output: scenarios) */
/* ------------------------------------------------------------------ */

/** A scenario DRAFT seeded per scenario_required intent member. */
export interface UcScenarioDraft {
  readonly scenarioId: string;
  readonly seededFromPrdMemberId: string;
  readonly actorKind: null;
  readonly actorIdentity: null;
  readonly goal: null;
  readonly trigger: null;
  readonly preconditions: readonly string[];
  readonly operationalSteps: readonly string[];
  readonly postcondition: null;
  readonly prdIntentRefs: readonly string[];
  readonly terminalBranches: readonly [];
  readonly evidenceKindRefs: readonly [];
}

/** The installed desk protocol (pure declaration data). */
export interface UcCellProtocol {
  readonly nodeId: typeof UC_CELL_ID;
  readonly productKind: typeof UC_CELL_PRODUCT_KIND;
  readonly adoptedContractKind: typeof UC_SCENARIO_CONTRACT_KIND;
  readonly input: {
    readonly kinds: readonly ['brief', 'discovery-capsule.intents', 'upstream.accepted-intent-set'];
    readonly upstreamContract: 'AcceptedIntentSet (define-product-intent cell output fold)';
  };
  readonly output: {
    readonly container: 'UC';
    readonly memberField: 'scenarios';
    readonly contractKind: typeof UC_SCENARIO_CONTRACT_KIND;
  };
  readonly fences: readonly string[];
  readonly declaredTransitions: readonly { readonly on: 'domain.accepted' | 'domain.failed'; readonly to: string }[];
}

export function ucCellProtocol(): UcCellProtocol {
  return {
    nodeId: UC_CELL_ID,
    productKind: UC_CELL_PRODUCT_KIND,
    adoptedContractKind: UC_SCENARIO_CONTRACT_KIND,
    input: { kinds: ['brief', 'discovery-capsule.intents', 'upstream.accepted-intent-set'], upstreamContract: 'AcceptedIntentSet (define-product-intent cell output fold)' },
    output: { container: 'UC', memberField: 'scenarios', contractKind: UC_SCENARIO_CONTRACT_KIND },
    fences: [...UC_FORBIDDEN_BUNDLE_KEYS],
    declaredTransitions: [
      { on: 'domain.accepted', to: UC_CELL_SUCCESSOR },
      { on: 'domain.failed', to: 'complete-failed' },
    ],
  };
}

/**
 * The deterministic protocol step: seed one scenario DRAFT per
 * scenario_required intent member of the upstream accepted set (the UC
 * coverage fence made visible to the author before any validation).
 * Drafts are NOT products - the gate refuses them until the author
 * completes the actor, flows, branches and evidence kinds.
 */
export function scenarioDraftsOfAcceptedIntents(accepted: AcceptedIntentSet): readonly UcScenarioDraft[] {
  return accepted.scenarioRequiredMemberIds.map((memberId) => ({
    scenarioId: `uc:${memberId.split(':').slice(1).join(':') || memberId}`,
    seededFromPrdMemberId: memberId,
    actorKind: null,
    actorIdentity: null,
    goal: null,
    trigger: null,
    preconditions: [],
    operationalSteps: [],
    postcondition: null,
    prdIntentRefs: [memberId],
    terminalBranches: [],
    evidenceKindRefs: [],
  }));
}

/* ------------------------------------------------------------------ */
/* Installed skill declarations (manifest-data pattern)                */
/* ------------------------------------------------------------------ */

export const UC_PROTOCOL_SKILL_ID = 'frf-cell-use-cases-protocol';
export const UC_SEMANTIC_SKILL_ID = 'frf-cell-use-cases-semantic';

export function ucSkillDeclarations(): readonly InstalledSkillDeclaration[] {
  return [
    {
      skillId: UC_PROTOCOL_SKILL_ID,
      kind: 'protocol',
      servesDesks: [UC_CELL_ID],
      digest: sha256OfCanonical({ skillId: UC_PROTOCOL_SKILL_ID, kind: 'protocol', desk: UC_CELL_ID }),
    },
    {
      skillId: UC_SEMANTIC_SKILL_ID,
      kind: 'semantic',
      servesDesks: [UC_CELL_ID],
      digest: sha256OfCanonical({
        skillId: UC_SEMANTIC_SKILL_ID,
        kind: 'semantic',
        desk: UC_CELL_ID,
        contract: UC_SCENARIO_CONTRACT_KIND,
      }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The product template (author-facing, pure data)                     */
/* ------------------------------------------------------------------ */

/**
 * The fill-in template for one UC scenario member. Closed vocabularies
 * are duplicated for AUTHORING ONLY; enforcement is exclusively the
 * WP03 validator's.
 */
export interface UcScenarioMemberTemplate {
  readonly templateId: 'frf-cell.uc-scenarios.member-template.v1';
  readonly contractKind: typeof UC_SCENARIO_CONTRACT_KIND;
  readonly idPattern: string;
  readonly requiredFields: readonly string[];
  readonly vocabularies: {
    readonly actorKinds: readonly string[];
    readonly branchKinds: readonly string[];
    readonly evidenceKinds: readonly string[];
  };
  readonly scenarioLaws: readonly string[];
  readonly example: Record<string, unknown>;
}

export function ucScenarioMemberTemplate(): UcScenarioMemberTemplate {
  return {
    templateId: 'frf-cell.uc-scenarios.member-template.v1',
    contractKind: UC_SCENARIO_CONTRACT_KIND,
    idPattern: '^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$',
    requiredFields: [
      'schemaVersion', 'scenarioId', 'actorKind', 'actorIdentity', 'goal', 'trigger',
      'preconditions', 'operationalSteps', 'alternateFlows', 'errorFlows',
      'terminalBranches', 'postcondition', 'prdIntentRefs', 'evidenceKindRefs',
    ],
    vocabularies: {
      actorKinds: ['human', 'operator', 'external_system', 'scheduler_or_clock', 'sensor_or_environment'],
      branchKinds: ['main', 'alternate', 'error'],
      evidenceKinds: ['test', 'monitoring', 'audit', 'independent-agent-review'],
    },
    scenarioLaws: [
      'a UC may be human-neutral but never actorless (actor kind + actor identity required)',
      'exactly one main terminal branch per scenario; material flows resolve to declared branches of their own kind (branch identities are their own level)',
      'prdIntentRefs cite exact accepted PRD intent members (cross-desk lineage, fail-closed)',
      'the desk must not require a pre-existing FR and must not create FR/NFR/RULE or AC artifacts',
    ],
    example: {
      schemaVersion: UC_SCENARIO_CONTRACT_KIND,
      scenarioId: 'uc:checkout-1',
      actorKind: 'human',
      actorIdentity: 'shopper with a browser session',
      goal: 'Receive a delivered order confirmation for the cart',
      trigger: 'The shopper selects checkout',
      preconditions: ['The cart holds at least one item'],
      operationalSteps: [
        'The shopper opens the cart',
        'The shopper confirms the order',
        'The system computes the total and takes payment',
        'The system emits an order confirmation',
      ],
      alternateFlows: [
        { branchId: 'branch:checkout-alt', steps: ['The shopper edits the shipping address', 'The system revalidates the cart total', 'The order is delivered to the edited address'] },
      ],
      errorFlows: [],
      terminalBranches: [
        { branchId: 'branch:checkout-main', branchKind: 'main', terminalResult: 'Order delivered and confirmed' },
        { branchId: 'branch:checkout-alt', branchKind: 'alternate', terminalResult: 'Order delivered to the edited address' },
      ],
      postcondition: 'The order is delivered and observable in the shopper\'s order history',
      prdIntentRefs: ['prd:outcome-1'],
      evidenceKindRefs: ['test'],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Role bindings (the WP-17 pattern; identity lives in the manifest)    */
/* ------------------------------------------------------------------ */

/** The launch kinds this desk is staffed through (one kernel resolver, no second path). */
export function ucRoleBindings(): readonly FormalizationRoleBinding[] {
  return [
    { launchKind: 'formalization.implementation.author', protocolRole: 'author', semanticProfile: 'implementer' },
    { launchKind: 'formalization.implementation.reviewer', protocolRole: 'reviewer', semanticProfile: 'reviewer' },
  ];
}

/* ------------------------------------------------------------------ */
/* The cross-desk accepted-scenario-set fold                           */
/* ------------------------------------------------------------------ */

/**
 * The ACCEPTED output of the Cell as downstream lineage state: accepted
 * scenario ids, the terminal-branch ids per owning scenario (the level
 * distinction downstream branch citations resolve within), and one
 * content-addressed revision digest. The derive-system-requirements
 * Cell (FRF-WP05) binds against THIS set.
 */
export interface AcceptedScenarioSet {
  readonly revisionDigest: string;
  readonly scenarioIds: readonly string[];
  readonly branchIdsByScenario: Readonly<Record<string, readonly string[]>>;
  readonly coveredPrdMemberIds: readonly string[];
}

/** Fold an ACCEPTED bundle into the downstream accepted-scenario set (pure). */
export function acceptedScenarioSetOf(bundle: { readonly scenarios?: readonly unknown[] }, seals: readonly { readonly scenarioId: string; readonly digest: string }[]): { readonly ok: true; readonly set: AcceptedScenarioSet } | { readonly ok: false; readonly detail: string } {
  const scenarios = bundle.scenarios ?? [];
  if (scenarios.length === 0 || seals.length !== scenarios.length) {
    return { ok: false, detail: 'the accepted-scenario fold needs one WP03 seal per accepted scenario (never a partial fold)' };
  }
  const seen = new Set<string>();
  const scenarioIds: string[] = [];
  const branchIdsByScenario: Record<string, readonly string[]> = {};
  const covered = new Set<string>();
  for (const scenario of scenarios) {
    const record = scenario as { scenarioId?: unknown; prdIntentRefs?: unknown; terminalBranches?: unknown };
    if (typeof record.scenarioId !== 'string' || seen.has(record.scenarioId)) {
      return { ok: false, detail: 'the accepted-scenario fold refuses duplicate or unidentified scenarios' };
    }
    seen.add(record.scenarioId);
    scenarioIds.push(record.scenarioId);
    branchIdsByScenario[record.scenarioId] = (Array.isArray(record.terminalBranches)
      ? record.terminalBranches.map((branch) => (branch as { branchId?: unknown }).branchId).filter((id): id is string => typeof id === 'string')
      : []);
    for (const ref of Array.isArray(record.prdIntentRefs) ? record.prdIntentRefs : []) covered.add(String(ref));
  }
  const memberDigests = seals.map((seal) => seal.digest).sort();
  return {
    ok: true,
    set: {
      revisionDigest: sha256OfCanonical({ memberDigests }),
      scenarioIds,
      branchIdsByScenario,
      coveredPrdMemberIds: [...covered].sort(),
    },
  };
}
