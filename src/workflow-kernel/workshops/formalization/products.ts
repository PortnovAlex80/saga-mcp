/**
 * workflow-kernel/workshops/formalization/products.ts - the content-addressed
 * product schemas of the Formalization workshop (WP-11F, plan phase EK-8
 * workshop conversion; semantic reference: docs/plans/
 * FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md "Desk contracts").
 *
 * Laws implemented here (pure data + pure validators, no I/O):
 *   - Every product is CONTENT-ADDRESSED: the artifact digest is recomputed
 *     over the canonical product JSON by the caller-side builder
 *     (artifactOf); validators never trust a declared digest.
 *   - Every product carries a schemaVersion (versioned contracts).
 *   - Desk contracts are fences: a desk may produce ONLY its declared
 *     product kind (the define-product-intent Cell must not produce final
 *     FR/NFR/RULE/UC/AC/SRS artifacts; the UC Cell must not require a
 *     pre-existing FR; the AC Cell stays WHAT-side...). Violations are
 *     typed SCOPE_VIOLATION refusals, never silent passes.
 *   - Lineage is exact: every reference must resolve against the ACCEPTED
 *     upstream material revision (the Workplace production revision chain,
 *     ADR-053). Foreign, stale, missing and unbound references are typed
 *     refusals (FOREIGN_LINEAGE / STALE_LINEAGE / MISSING_LINEAGE).
 *   - Coverage is closed: every required upstream member (PRD intent
 *     member, UC scenario terminal, terminal lifecycle claim) must be
 *     covered by exactly the declared dispositions or typed COVERAGE_GAP.
 *
 * PURITY: node:crypto via the kernel digest rule only. No session, no SQL,
 * no clock, no workshop-identity conditional in any kernel path.
 */

import { sha256OfCanonical } from '../../domain/digest.js';

/* ------------------------------------------------------------------ */
/* Content-addressed artifacts                                          */
/* ------------------------------------------------------------------ */

/** One content-addressed sub-artifact: content + its recomputed digest. */
export interface ContentArtifact {
  readonly ref: string;
  readonly digest: string;
  readonly content: unknown;
}

/** Seal one artifact: digest recomputed over the canonical content. */
export function artifactOf(content: unknown): ContentArtifact {
  const digest = sha256OfCanonical(content);
  return { ref: `sha256:${digest}`, digest, content };
}

/* ------------------------------------------------------------------ */
/* Typed product refusals (closed set)                                  */
/* ------------------------------------------------------------------ */

export type ProductRefusalReason =
  | 'MALFORMED_PRODUCT'
  | 'FOREIGN_LINEAGE'
  | 'STALE_LINEAGE'
  | 'MISSING_LINEAGE'
  | 'COVERAGE_GAP'
  | 'DRIFT_DETECTED'
  | 'SCOPE_VIOLATION';

export interface ProductRefusal {
  readonly ok: false;
  readonly refused: true;
  readonly reason: ProductRefusalReason;
  readonly detail: string;
}

export type ProductValidation =
  | { readonly ok: true; readonly artifact: ContentArtifact }
  | ProductRefusal;

function refused(reason: ProductRefusalReason, detail: string): ProductRefusal {
  return { ok: false, refused: true, reason, detail };
}

/* ------------------------------------------------------------------ */
/* The accepted-material chain state (ADR-053 lineage authority)        */
/* ------------------------------------------------------------------ */

/**
 * The immutable accepted-material state a desk validates against. Every
 * entry names the ACCEPTED revision (the Workplace production revision
 * digest) and its exact atomic member ids. Folded forward only through
 * acceptedMaterialAfter() when a gate accepts a new product.
 */
export interface AcceptedMaterial {
  /** The imported Discovery handoff (capsule ingress). */
  readonly handoff?: {
    readonly digest: string;
    readonly sourceClaimIds: readonly string[];
    readonly constraintIds: readonly string[];
    readonly unknownIds: readonly string[];
    readonly terminalClaimIds: readonly string[];
  };
  readonly prd?: {
    readonly revisionDigest: string;
    readonly memberIds: readonly string[];
    /** Members dispositioned scenario_required at acceptance (the UC coverage fence). */
    readonly scenarioRequiredMemberIds: readonly string[];
  };
  readonly useCases?: { readonly revisionDigest: string; readonly scenarioIds: readonly string[] };
  readonly requirements?: { readonly revisionDigest: string; readonly requirementIds: readonly string[] };
  readonly acceptance?: { readonly revisionDigest: string; readonly criterionIds: readonly string[] };
  readonly reconciliation?: { readonly revisionDigest: string; readonly verdict: 'consistent' };
  readonly baseline?: { readonly revisionDigest: string; readonly wholeWhatDigest: string };
  readonly srs?: { readonly revisionDigest: string; readonly realizedScenarioIds: readonly string[] };
}

const everyRefWithin = (refs: readonly string[], universe: readonly string[]): boolean =>
  refs.every((ref) => universe.includes(ref));

/* ------------------------------------------------------------------ */
/* define-product-intent: PRD + atomic intent members + dispositions     */
/* ------------------------------------------------------------------ */

export const PRD_INTENT_PRODUCT_KIND = 'formalization.prd-intent.v1' as const;

/** The closed member-kind vocabulary of a PRD intent member. */
export const PRD_MEMBER_KINDS = [
  'system-boundary',
  'actor-stakeholder',
  'outcome',
  'scope-exclusion',
  'terminal-claim',
  'constraint',
  'assumption-unknown',
] as const;
export type PrdMemberKind = (typeof PRD_MEMBER_KINDS)[number];

/** The closed disposition vocabulary (successor plan "Target semantic trace grammar"). */
export const PRD_DISPOSITIONS = [
  'scenario_required',
  'direct_requirement',
  'deferred',
  'out_of_scope',
] as const;
export type PrdDisposition = (typeof PRD_DISPOSITIONS)[number];

export interface PrdIntentProduct {
  readonly schemaVersion: typeof PRD_INTENT_PRODUCT_KIND;
  readonly brief: string;
  readonly members: readonly {
    readonly memberId: string;
    readonly memberKind: PrdMemberKind;
    readonly statement: string;
    readonly sourceClaimRefs: readonly string[];
  }[];
  readonly dispositions: readonly {
    readonly memberId: string;
    readonly disposition: PrdDisposition;
    readonly owner?: string;
    readonly reason?: string;
  }[];
}

/** Validate the PRD intent product against the accepted Discovery handoff. */
export function validatePrdIntent(product: PrdIntentProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== PRD_INTENT_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${PRD_INTENT_PRODUCT_KIND}`);
  }
  const raw = product as unknown as Record<string, unknown>;
  for (const forbidden of ['requirements', 'useCases', 'acceptanceCriteria', 'srs', 'scenarios']) {
    if (raw[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `the product-intent Cell must not produce final ${forbidden} artifacts`);
    }
  }
  if (!Array.isArray(product.members) || product.members.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the PRD must contain stable atomic intent members');
  }
  const handoff = accepted.handoff;
  if (handoff === undefined) {
    return refused('MISSING_LINEAGE', 'no accepted Discovery handoff is in the material chain');
  }
  const memberIds = new Set<string>();
  for (const member of product.members) {
    if (typeof member.memberId !== 'string' || member.memberId.length === 0 || typeof member.statement !== 'string' || member.statement.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every PRD intent member needs a stable id and a statement');
    }
    if (memberIds.has(member.memberId)) {
      return refused('MALFORMED_PRODUCT', `duplicate PRD intent member ${member.memberId}`);
    }
    memberIds.add(member.memberId);
    if (!(PRD_MEMBER_KINDS as readonly string[]).includes(member.memberKind)) {
      return refused('MALFORMED_PRODUCT', `PRD member ${member.memberId} has unknown member kind ${String(member.memberKind)}`);
    }
    if (!Array.isArray(member.sourceClaimRefs) || member.sourceClaimRefs.length === 0) {
      return refused('MISSING_LINEAGE', `PRD member ${member.memberId} derives from no Discovery source claim`);
    }
    if (!everyRefWithin(member.sourceClaimRefs, handoff.sourceClaimIds)) {
      return refused('FOREIGN_LINEAGE', `PRD member ${member.memberId} derives from a source claim outside the accepted handoff`);
    }
  }
  const byDisposition = new Map(product.dispositions.map((entry) => [entry.memberId, entry]));
  for (const member of product.members) {
    const disposition = byDisposition.get(member.memberId);
    if (disposition === undefined) {
      return refused('COVERAGE_GAP', `PRD intent member ${member.memberId} has no required disposition`);
    }
    if (!(PRD_DISPOSITIONS as readonly string[]).includes(disposition.disposition)) {
      return refused('MALFORMED_PRODUCT', `PRD member ${member.memberId} has unknown disposition ${String(disposition.disposition)}`);
    }
    if ((disposition.disposition === 'deferred' || disposition.disposition === 'out_of_scope') && (disposition.owner === undefined || disposition.reason === undefined)) {
      return refused('MALFORMED_PRODUCT', `${disposition.disposition} of ${member.memberId} requires an owner and a reason`);
    }
    if (disposition.disposition === 'direct_requirement' && disposition.reason === undefined) {
      return refused('MALFORMED_PRODUCT', `direct requirement route of ${member.memberId} requires a reason (why no meaningful interaction or operational scenario exists)`);
    }
  }
  for (const entry of product.dispositions) {
    if (!memberIds.has(entry.memberId)) {
      return refused('FOREIGN_LINEAGE', `disposition names unknown PRD member ${entry.memberId}`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* model-use-cases: scenario-first UC bundle                            */
/* ------------------------------------------------------------------ */

export const UC_SCENARIOS_PRODUCT_KIND = 'formalization.uc-scenarios.v1' as const;

/** The closed actor-kind vocabulary (successor plan "model-use-cases"). */
export const UC_ACTOR_KINDS = [
  'human',
  'operator',
  'external_system',
  'scheduler_or_clock',
  'sensor_or_environment',
] as const;
export type UcActorKind = (typeof UC_ACTOR_KINDS)[number];

export interface UseCaseScenariosProduct {
  readonly schemaVersion: typeof UC_SCENARIOS_PRODUCT_KIND;
  readonly scenarios: readonly {
    readonly scenarioId: string;
    readonly actorKind: UcActorKind;
    readonly actorIdentity: string;
    readonly goal: string;
    readonly trigger: string;
    readonly preconditions: readonly string[];
    readonly mainFlow: readonly string[];
    readonly alternateFlows: readonly string[];
    readonly errorFlows: readonly string[];
    readonly postcondition: string;
    readonly prdIntentRefs: readonly string[];
  }[];
}

/** Validate the UC scenario bundle against the accepted PRD revision. */
export function validateUseCaseScenarios(product: UseCaseScenariosProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== UC_SCENARIOS_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${UC_SCENARIOS_PRODUCT_KIND}`);
  }
  const raw = product as unknown as Record<string, unknown>;
  if (raw.requirementRefs !== undefined || raw.requirements !== undefined) {
    return refused('SCOPE_VIOLATION', 'the UC Cell must not require a pre-existing FR and must not create requirement artifacts');
  }
  const prd = accepted.prd;
  if (prd === undefined) {
    return refused('MISSING_LINEAGE', 'no accepted PRD revision is in the material chain');
  }
  if (!Array.isArray(product.scenarios) || product.scenarios.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the UC bundle must contain at least one scenario');
  }
  const seen = new Set<string>();
  for (const scenario of product.scenarios) {
    if (typeof scenario.scenarioId !== 'string' || scenario.scenarioId.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every UC needs a stable scenario identity');
    }
    if (seen.has(scenario.scenarioId)) {
      return refused('MALFORMED_PRODUCT', `duplicate UC scenario ${scenario.scenarioId}`);
    }
    seen.add(scenario.scenarioId);
    if (!(UC_ACTOR_KINDS as readonly string[]).includes(scenario.actorKind)) {
      return refused('MALFORMED_PRODUCT', `UC ${scenario.scenarioId} has actor kind ${String(scenario.actorKind)} outside the closed vocabulary (an actorless scenario is refused)`);
    }
    if (typeof scenario.actorIdentity !== 'string' || scenario.actorIdentity.length === 0) {
      return refused('MALFORMED_PRODUCT', `UC ${scenario.scenarioId} must declare its actor identity`);
    }
    if (!Array.isArray(scenario.mainFlow) || scenario.mainFlow.length === 0 || typeof scenario.postcondition !== 'string' || scenario.postcondition.length === 0) {
      return refused('MALFORMED_PRODUCT', `UC ${scenario.scenarioId} needs a main flow and an observable postcondition`);
    }
    if (!Array.isArray(scenario.prdIntentRefs) || scenario.prdIntentRefs.length === 0) {
      return refused('MISSING_LINEAGE', `UC ${scenario.scenarioId} binds no exact PRD intent member`);
    }
    if (!everyRefWithin(scenario.prdIntentRefs, prd.memberIds)) {
      return refused('FOREIGN_LINEAGE', `UC ${scenario.scenarioId} derives from a PRD member outside the accepted revision`);
    }
  }
  // Coverage: every scenario_required PRD disposition must be referenced by
  // at least one UC scenario (direct_requirement/deferred/out_of_scope
  // members are covered by their recorded dispositions instead).
  const coveredMembers = new Set(product.scenarios.flatMap((scenario) => scenario.prdIntentRefs));
  for (const memberId of prd.scenarioRequiredMemberIds) {
    if (!coveredMembers.has(memberId)) {
      return refused('COVERAGE_GAP', `scenario_required PRD member ${memberId} is covered by no UC scenario`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* derive-system-requirements: FR/NFR/RULE with exact lineage           */
/* ------------------------------------------------------------------ */

export const SYSTEM_REQUIREMENTS_PRODUCT_KIND = 'formalization.system-requirements.v1' as const;

export const REQUIREMENT_KINDS = ['FR', 'NFR', 'RULE'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export interface SystemRequirementsProduct {
  readonly schemaVersion: typeof SYSTEM_REQUIREMENTS_PRODUCT_KIND;
  readonly prdRevisionRef: string;
  readonly ucRevisionRef?: string;
  readonly requirements: readonly {
    readonly requirementId: string;
    readonly requirementKind: RequirementKind;
    readonly statement: string;
    readonly prdIntentRefs: readonly string[];
    readonly ucScenarioRefs: readonly string[];
  }[];
}

/** Validate FR/NFR/RULE derivation against the accepted PRD and UC revisions. */
export function validateSystemRequirements(product: SystemRequirementsProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== SYSTEM_REQUIREMENTS_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${SYSTEM_REQUIREMENTS_PRODUCT_KIND}`);
  }
  const prd = accepted.prd;
  const useCases = accepted.useCases;
  if (prd === undefined || useCases === undefined) {
    return refused('MISSING_LINEAGE', 'requirements derive only from accepted PRD and UC material');
  }
  if (product.prdRevisionRef !== `sha256:${prd.revisionDigest}`) {
    return refused('STALE_LINEAGE', `the pinned PRD revision ${product.prdRevisionRef} is not the accepted revision sha256:${prd.revisionDigest} (a requirement may not derive from a stale revision)`);
  }
  if (product.ucRevisionRef !== undefined && product.ucRevisionRef !== `sha256:${useCases.revisionDigest}`) {
    return refused('STALE_LINEAGE', `the pinned UC revision ${product.ucRevisionRef} is not the accepted revision (a scenario-derived requirement may not derive from a stale revision)`);
  }
  if (!Array.isArray(product.requirements) || product.requirements.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the requirements product must contain at least one FR, NFR or RULE');
  }
  const covered = new Set<string>();
  for (const requirement of product.requirements) {
    if (typeof requirement.requirementId !== 'string' || requirement.requirementId.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every requirement needs a stable id');
    }
    if (!(REQUIREMENT_KINDS as readonly string[]).includes(requirement.requirementKind)) {
      return refused('MALFORMED_PRODUCT', `requirement ${requirement.requirementId} has unknown kind ${String(requirement.requirementKind)}`);
    }
    if (!Array.isArray(requirement.prdIntentRefs) || requirement.prdIntentRefs.length === 0) {
      return refused('MISSING_LINEAGE', `requirement ${requirement.requirementId} binds no exact PRD intent`);
    }
    if (!everyRefWithin(requirement.prdIntentRefs, prd.memberIds)) {
      return refused('FOREIGN_LINEAGE', `requirement ${requirement.requirementId} derives from a PRD member outside the accepted revision`);
    }
    if (requirement.ucScenarioRefs.length > 0) {
      if (!everyRefWithin(requirement.ucScenarioRefs, useCases.scenarioIds)) {
        return refused('FOREIGN_LINEAGE', `requirement ${requirement.requirementId} derives from a UC scenario outside the accepted revision`);
      }
      for (const ref of requirement.ucScenarioRefs) covered.add(ref);
    }
  }
  // Every accepted UC scenario must yield at least one observable behavior obligation.
  for (const scenarioId of useCases.scenarioIds) {
    if (!covered.has(scenarioId)) {
      return refused('COVERAGE_GAP', `accepted UC ${scenarioId} produces no FR, RULE or scenario-local NFR obligation`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* define-acceptance-contract: AC bound to FR/NFR and UC terminals      */
/* ------------------------------------------------------------------ */

export const ACCEPTANCE_BINDINGS_PRODUCT_KIND = 'formalization.acceptance-bindings.v1' as const;

export interface AcceptanceContractProduct {
  readonly schemaVersion: typeof ACCEPTANCE_BINDINGS_PRODUCT_KIND;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly given: string;
    readonly when: string;
    readonly then: string;
    readonly requirementRefs: readonly string[];
    readonly ucTerminalBranchRefs: readonly string[];
    readonly evidenceMethod: 'test' | 'monitoring' | 'audit' | 'independent-agent-review';
  }[];
}

/** Validate the AC contract against the accepted requirements and UC revisions. */
export function validateAcceptanceContract(product: AcceptanceContractProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== ACCEPTANCE_BINDINGS_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${ACCEPTANCE_BINDINGS_PRODUCT_KIND}`);
  }
  const raw = product as unknown as Record<string, unknown>;
  for (const forbidden of ['participatingModules', 'moduleAllocation', 'files']) {
    if (raw[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `AC remains WHAT-side verification and must not contain architecture or ${forbidden} allocation decisions`);
    }
  }
  const requirements = accepted.requirements;
  const useCases = accepted.useCases;
  if (requirements === undefined || useCases === undefined) {
    return refused('MISSING_LINEAGE', 'acceptance criteria derive only from accepted requirements and UC material');
  }
  if (!Array.isArray(product.criteria) || product.criteria.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the acceptance contract must contain at least one criterion');
  }
  const coveredTerminals = new Set<string>();
  for (const criterion of product.criteria) {
    if (typeof criterion.criterionId !== 'string' || criterion.criterionId.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every AC needs a stable atomic identity');
    }
    if (typeof criterion.given !== 'string' || typeof criterion.when !== 'string' || typeof criterion.then !== 'string') {
      return refused('MALFORMED_PRODUCT', `AC ${criterion.criterionId} needs given/when/then`);
    }
    if (!Array.isArray(criterion.requirementRefs) || criterion.requirementRefs.length === 0) {
      return refused('MISSING_LINEAGE', `AC ${criterion.criterionId} binds no exact FR or NFR material`);
    }
    if (!everyRefWithin(criterion.requirementRefs, requirements.requirementIds)) {
      return refused('FOREIGN_LINEAGE', `AC ${criterion.criterionId} binds a requirement outside the accepted revision`);
    }
    if (criterion.ucTerminalBranchRefs.length > 0) {
      if (!everyRefWithin(criterion.ucTerminalBranchRefs, useCases.scenarioIds)) {
        return refused('FOREIGN_LINEAGE', `scenario-facing AC ${criterion.criterionId} binds a UC terminal branch outside the accepted revision`);
      }
      for (const ref of criterion.ucTerminalBranchRefs) coveredTerminals.add(ref);
    }
  }
  for (const scenarioId of useCases.scenarioIds) {
    if (!coveredTerminals.has(scenarioId)) {
      return refused('COVERAGE_GAP', `required UC terminal result ${scenarioId} has no end-to-end AC or accepted evidence binding`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* reconcile-what: the closed-chain reconciliation report               */
/* ------------------------------------------------------------------ */

export const WHAT_RECONCILIATION_PRODUCT_KIND = 'formalization.what-reconciliation.v1' as const;

export interface WhatReconciliationProduct {
  readonly schemaVersion: typeof WHAT_RECONCILIATION_PRODUCT_KIND;
  readonly verdict: 'consistent' | 'gaps';
  readonly gaps: readonly { readonly direction: 'forward' | 'reverse'; readonly detail: string }[];
  readonly rows: readonly {
    readonly sourceClaimRef: string;
    readonly memberRef: string;
    readonly scenarioRef: string;
    readonly requirementRefs: readonly string[];
    readonly criterionRefs: readonly string[];
  }[];
}

/** Validate the WHAT reconciliation report over the accepted closed chain. */
export function validateWhatReconciliation(product: WhatReconciliationProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== WHAT_RECONCILIATION_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${WHAT_RECONCILIATION_PRODUCT_KIND}`);
  }
  const handoff = accepted.handoff;
  const prd = accepted.prd;
  const useCases = accepted.useCases;
  const requirements = accepted.requirements;
  const acceptance = accepted.acceptance;
  if (!handoff || !prd || !useCases || !requirements || !acceptance) {
    return refused('MISSING_LINEAGE', 'the reconciler validates the complete accepted chain (claim -> intent -> scenario -> requirement -> criterion)');
  }
  if (product.verdict === 'gaps') {
    if (product.gaps.length === 0) {
      return refused('MALFORMED_PRODUCT', 'a gaps verdict must enumerate its typed gaps');
    }
    return { ok: true, artifact: artifactOf(product) };
  }
  if (product.gaps.length > 0) {
    return refused('MALFORMED_PRODUCT', 'a consistent verdict must not carry gaps');
  }
  const claimsCovered = new Set<string>();
  for (const row of product.rows) {
    if (!handoff.sourceClaimIds.includes(row.sourceClaimRef)) {
      return refused('FOREIGN_LINEAGE', `row names source claim ${row.sourceClaimRef} outside the accepted handoff`);
    }
    if (!prd.memberIds.includes(row.memberRef)) {
      return refused('FOREIGN_LINEAGE', `row names PRD member ${row.memberRef} outside the accepted revision`);
    }
    if (row.scenarioRef !== 'direct' && !useCases.scenarioIds.includes(row.scenarioRef)) {
      return refused('FOREIGN_LINEAGE', `row names UC scenario ${row.scenarioRef} outside the accepted revision`);
    }
    if (!everyRefWithin(row.requirementRefs, requirements.requirementIds)) {
      return refused('FOREIGN_LINEAGE', `row names a requirement outside the accepted revision`);
    }
    if (!everyRefWithin(row.criterionRefs, acceptance.criterionIds)) {
      return refused('FOREIGN_LINEAGE', `row names a criterion outside the accepted revision`);
    }
    claimsCovered.add(row.sourceClaimRef);
  }
  for (const claimId of handoff.sourceClaimIds) {
    if (!claimsCovered.has(claimId)) {
      return refused('COVERAGE_GAP', `source claim ${claimId} has no chain row (claim -> disposition -> scenario -> requirement -> criterion)`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* freeze-what-baseline: the content-addressed whole-WHAT baseline      */
/* ------------------------------------------------------------------ */

export const WHAT_BASELINE_PRODUCT_KIND = 'formalization.what-baseline.v1' as const;

export interface WhatBaselineProduct {
  readonly schemaVersion: typeof WHAT_BASELINE_PRODUCT_KIND;
  readonly inputs: {
    readonly handoffDigest: string;
    readonly prdRevisionDigest: string;
    readonly ucRevisionDigest: string;
    readonly requirementsRevisionDigest: string;
    readonly acceptanceRevisionDigest: string;
    readonly reconciliationRevisionDigest: string;
  };
  readonly memberDigests: readonly string[];
  readonly acceptedTraceDigest: string;
  readonly wholeWhatDigest: string;
}

/** The exact accepted-digest set the freezer must freeze (no scanning). */
export interface BaselineFreezeInputs {
  readonly handoffDigest: string;
  readonly prdRevisionDigest: string;
  readonly ucRevisionDigest: string;
  readonly requirementsRevisionDigest: string;
  readonly acceptanceRevisionDigest: string;
  readonly reconciliationRevisionDigest: string;
  readonly memberDigests: readonly string[];
  readonly acceptedTraceDigest: string;
}

/** Freeze the whole-WHAT baseline: exact set equality, never a rescan. */
export function freezeWhatBaseline(inputs: BaselineFreezeInputs): { readonly ok: true; readonly product: WhatBaselineProduct; readonly artifact: ContentArtifact } | ProductRefusal {
  const sortedMembers = [...inputs.memberDigests].sort();
  if (new Set(sortedMembers).size !== sortedMembers.length) {
    return refused('DRIFT_DETECTED', 'the member digest set contains duplicates (an artifact was substituted or emitted twice)');
  }
  const wholeWhatDigest = sha256OfCanonical({
    inputs: {
      handoffDigest: inputs.handoffDigest,
      prdRevisionDigest: inputs.prdRevisionDigest,
      ucRevisionDigest: inputs.ucRevisionDigest,
      requirementsRevisionDigest: inputs.requirementsRevisionDigest,
      acceptanceRevisionDigest: inputs.acceptanceRevisionDigest,
      reconciliationRevisionDigest: inputs.reconciliationRevisionDigest,
    },
    memberDigests: sortedMembers,
    acceptedTraceDigest: inputs.acceptedTraceDigest,
  });
  const product: WhatBaselineProduct = {
    schemaVersion: WHAT_BASELINE_PRODUCT_KIND,
    inputs: {
      handoffDigest: inputs.handoffDigest,
      prdRevisionDigest: inputs.prdRevisionDigest,
      ucRevisionDigest: inputs.ucRevisionDigest,
      requirementsRevisionDigest: inputs.requirementsRevisionDigest,
      acceptanceRevisionDigest: inputs.acceptanceRevisionDigest,
      reconciliationRevisionDigest: inputs.reconciliationRevisionDigest,
    },
    memberDigests: sortedMembers,
    acceptedTraceDigest: inputs.acceptedTraceDigest,
    wholeWhatDigest,
  };
  return { ok: true, product, artifact: artifactOf(product) };
}

/** Validate a frozen baseline against the exact accepted material (drift fence). */
export function validateWhatBaseline(product: WhatBaselineProduct, expected: BaselineFreezeInputs): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== WHAT_BASELINE_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${WHAT_BASELINE_PRODUCT_KIND}`);
  }
  const pairs: readonly (readonly [keyof WhatBaselineProduct['inputs'], string])[] = [
    ['handoffDigest', expected.handoffDigest],
    ['prdRevisionDigest', expected.prdRevisionDigest],
    ['ucRevisionDigest', expected.ucRevisionDigest],
    ['requirementsRevisionDigest', expected.requirementsRevisionDigest],
    ['acceptanceRevisionDigest', expected.acceptanceRevisionDigest],
    ['reconciliationRevisionDigest', expected.reconciliationRevisionDigest],
  ];
  for (const [key, expectedDigest] of pairs) {
    if (product.inputs[key] !== expectedDigest) {
      return refused('DRIFT_DETECTED', `baseline input ${key} is ${product.inputs[key]}, the accepted material says ${expectedDigest} (missing, extra, substituted, stale or drifted material is refused)`);
    }
  }
  const expectedMembers = [...expected.memberDigests].sort();
  const actualMembers = [...product.memberDigests].sort();
  if (actualMembers.join(',') !== expectedMembers.join(',')) {
    return refused('DRIFT_DETECTED', 'the baseline member digest set does not equal the accepted member set (exact set equality; the freezer never rescans)');
  }
  if (product.acceptedTraceDigest !== expected.acceptedTraceDigest) {
    return refused('DRIFT_DETECTED', 'the accepted trace/member-binding digest drifted from the accepted binding set');
  }
  const refrozen = freezeWhatBaseline(expected);
  if ('refused' in refrozen || refrozen.product.wholeWhatDigest !== product.wholeWhatDigest) {
    return refused('DRIFT_DETECTED', 'the canonical whole-WHAT digest does not verify against the exact accepted inputs');
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* define-architecture-contract: SRS with scenario realization          */
/* ------------------------------------------------------------------ */

export const SRS_PRODUCT_KIND = 'formalization.srs.v1' as const;

export interface SrsScenarioRealization {
  readonly scenarioId: string;
  readonly entrypoint: string;
  readonly participatingModules: readonly string[];
  readonly runtimeEdges: readonly { readonly from: string; readonly to: string }[];
  readonly externalInterfaces: readonly string[];
  readonly compositionOwner: string;
  readonly implementationSurfaces: readonly string[];
  readonly terminalResult: string;
  readonly evidenceBinding: string;
}

export interface SrsProduct {
  readonly schemaVersion: typeof SRS_PRODUCT_KIND;
  readonly baselineRef: string;
  readonly scenarioRealizations: readonly SrsScenarioRealization[];
  readonly decomposition: readonly { readonly criterionRef: string; readonly moduleRef: string }[];
}

/** Validate the SRS realization graph against the accepted UC set and baseline. */
export function validateSrs(product: SrsProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== SRS_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${SRS_PRODUCT_KIND}`);
  }
  const useCases = accepted.useCases;
  const baseline = accepted.baseline;
  if (useCases === undefined || baseline === undefined) {
    return refused('MISSING_LINEAGE', 'the SRS realizes the frozen whole-WHAT baseline and the accepted UC set');
  }
  if (product.baselineRef !== `sha256:${baseline.revisionDigest}`) {
    return refused('STALE_LINEAGE', `the pinned WHAT baseline ${product.baselineRef} is not the frozen baseline (the SRS derives from the frozen whole-WHAT baseline only)`);
  }
  const realized = new Map<string, SrsScenarioRealization>();
  for (const realization of product.scenarioRealizations) {
    if (realized.has(realization.scenarioId)) {
      return refused('MALFORMED_PRODUCT', `scenario ${realization.scenarioId} is realized more than once`);
    }
    if (!useCases.scenarioIds.includes(realization.scenarioId)) {
      return refused('FOREIGN_LINEAGE', `realization names UC scenario ${realization.scenarioId} outside the accepted revision`);
    }
    if (
      typeof realization.entrypoint !== 'string' || realization.entrypoint.length === 0 ||
      !Array.isArray(realization.participatingModules) || realization.participatingModules.length === 0 ||
      !Array.isArray(realization.runtimeEdges) || realization.runtimeEdges.length === 0 ||
      typeof realization.compositionOwner !== 'string' || realization.compositionOwner.length === 0 ||
      typeof realization.terminalResult !== 'string' || realization.terminalResult.length === 0 ||
      typeof realization.evidenceBinding !== 'string' || realization.evidenceBinding.length === 0
    ) {
      return refused('MALFORMED_PRODUCT', `realization of ${realization.scenarioId} needs an entrypoint, modules, runtime edges, a composition owner, a terminal result and an evidence binding`);
    }
    // Runtime connectivity: every module reachable from the entrypoint, and
    // the terminal result reachable over the declared edges (the terminal
    // observable result is a graph node even when it is not a module).
    const nodes = new Set([...realization.participatingModules, realization.terminalResult]);
    if (!nodes.has(realization.entrypoint)) {
      return refused('COVERAGE_GAP', `realization of ${realization.scenarioId}: the entrypoint is not a participating module (disconnected runtime graph)`);
    }
    const edges = realization.runtimeEdges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
    const reachable = new Set<string>([realization.entrypoint]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of edges) {
        if (reachable.has(edge.from) && !reachable.has(edge.to)) {
          reachable.add(edge.to);
          grew = true;
        }
      }
    }
    for (const module of nodes) {
      if (!reachable.has(module)) {
        return refused('COVERAGE_GAP', `realization of ${realization.scenarioId}: node ${module} is unreachable from the entrypoint (a flat list of files is not proof of runtime connectivity)`);
      }
    }
    realized.set(realization.scenarioId, realization);
  }
  for (const scenarioId of useCases.scenarioIds) {
    if (!realized.has(scenarioId)) {
      return refused('COVERAGE_GAP', `required UC ${scenarioId} has no scenario-realization section`);
    }
  }
  return { ok: true, artifact: artifactOf(product) };
}

/* ------------------------------------------------------------------ */
/* settle-formalization: the content-addressed solution contract        */
/* ------------------------------------------------------------------ */

export const SOLUTION_CONTRACT_PRODUCT_KIND = 'formalization.solution-contract.v1' as const;

/** The typed, required Development handoff values (successor plan). */
export interface DevelopmentHandoff {
  readonly certificateRef: string;
  readonly baselineRef: string;
  readonly baselineDigest: string;
  readonly srsRef: string;
  readonly srsDigest: string;
  readonly prdIntentBindings: readonly string[];
  readonly scenarioBindings: readonly string[];
  readonly requirementBindings: readonly string[];
  readonly acceptanceBindings: readonly string[];
  readonly scenarioRealizationBindings: readonly string[];
  readonly terminalClaimBindings: readonly string[];
  readonly integrationObligations: readonly string[];
  readonly repositoryPolicyBindings: readonly string[];
}

export interface SolutionContractProduct {
  readonly schemaVersion: typeof SOLUTION_CONTRACT_PRODUCT_KIND;
  readonly whatBaselineRef: string;
  readonly srsRef: string;
  readonly developmentHandoff: DevelopmentHandoff;
  readonly canonicalDigest: string;
}

/**
 * Settle the solution contract: exact references to BOTH authorities (the
 * frozen whole-WHAT baseline and the accepted SRS revision) and their
 * atomic manifests. Never rediscovers accepted artifacts.
 */
export function settleSolutionContract(
  baseline: { readonly revisionDigest: string; readonly wholeWhatDigest: string },
  srs: { readonly revisionDigest: string; readonly realizedScenarioIds: readonly string[] },
  handoff: Omit<DevelopmentHandoff, 'baselineRef' | 'baselineDigest' | 'srsRef' | 'srsDigest'>,
): { readonly ok: true; readonly product: SolutionContractProduct; readonly artifact: ContentArtifact } | ProductRefusal {
  const missing = (Object.keys(handoff) as (keyof typeof handoff)[]).filter((key) => {
    const value = handoff[key];
    if (value === undefined || value === null || value === '') return true;
    return Array.isArray(value) && value.length === 0;
  });
  if (missing.length > 0) {
    return refused('MALFORMED_PRODUCT', `the Development handoff requires typed non-empty values for: ${missing.join(', ')}`);
  }
  const product: SolutionContractProduct = {
    schemaVersion: SOLUTION_CONTRACT_PRODUCT_KIND,
    whatBaselineRef: `sha256:${baseline.revisionDigest}`,
    srsRef: `sha256:${srs.revisionDigest}`,
    developmentHandoff: {
      ...handoff,
      baselineRef: `sha256:${baseline.revisionDigest}`,
      baselineDigest: baseline.wholeWhatDigest,
      srsRef: `sha256:${srs.revisionDigest}`,
      srsDigest: srs.revisionDigest,
    },
    canonicalDigest: '',
  };
  const canonicalDigest = sha256OfCanonical({ ...product, canonicalDigest: '' });
  const sealed: SolutionContractProduct = { ...product, canonicalDigest };
  return { ok: true, product: sealed, artifact: artifactOf(sealed) };
}

/** Validate a settled solution contract against both accepted authorities. */
export function validateSolutionContract(product: SolutionContractProduct, accepted: AcceptedMaterial): ProductValidation {
  if (product === null || typeof product !== 'object' || product.schemaVersion !== SOLUTION_CONTRACT_PRODUCT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${SOLUTION_CONTRACT_PRODUCT_KIND}`);
  }
  const baseline = accepted.baseline;
  const srs = accepted.srs;
  if (baseline === undefined || srs === undefined) {
    return refused('MISSING_LINEAGE', 'settlement consumes the frozen whole-WHAT baseline and the accepted SRS revision');
  }
  if (product.whatBaselineRef !== `sha256:${baseline.revisionDigest}`) {
    return refused('STALE_LINEAGE', `the contract pins WHAT baseline ${product.whatBaselineRef}, the frozen baseline is sha256:${baseline.revisionDigest}`);
  }
  if (product.srsRef !== `sha256:${srs.revisionDigest}`) {
    return refused('STALE_LINEAGE', `the contract pins SRS revision ${product.srsRef}, the accepted revision is sha256:${srs.revisionDigest}`);
  }
  if (product.developmentHandoff.baselineDigest !== baseline.wholeWhatDigest) {
    return refused('STALE_LINEAGE', 'the handoff whole-WHAT digest drifted from the frozen baseline');
  }
  const recomputed = sha256OfCanonical({ ...product, canonicalDigest: '' });
  if (recomputed !== product.canonicalDigest) {
    return refused('DRIFT_DETECTED', 'the canonical solution-contract digest does not verify');
  }
  return { ok: true, artifact: artifactOf(product) };
}
