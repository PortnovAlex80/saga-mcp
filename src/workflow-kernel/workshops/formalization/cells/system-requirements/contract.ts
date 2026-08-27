/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * contract.ts - the payload contract identity, the closed vocabularies and
 * the DERIVATION LAWS of the derive-system-requirements Production Cell
 * (FRF-WP05, plan phase FRF-5; plan §Desk contracts/derive-system-requirements).
 *
 * This is the ONE new Production Cell of the scenario-first refactoring.
 * Its output is the FR/NFR/RULE requirements bundle of contract identity
 * `frf-contracts.requirements-bundle.v1` (FRF-WP03
 * docs/refactoring/formalization-frf/contracts/schemas/
 * requirements-bundle.schema.json). The payload shape here mirrors that
 * frozen schema field-for-field; the authoritative typed validation is the
 * WP03 validator bound through the documented seam (./seam.ts + SEAM.md).
 *
 * Laws declared here (plan §Desk contracts + FRF-WP02 reverse graph edges
 * 0054-0062, the derivation-source requirements):
 *   L1 exact derivation lineage - every requirement (FR, NFR, RULE alike)
 *      binds exact PRD intent members; a scenario-derived FR additionally
 *      binds exact UC scenario AND terminal-branch identities; a
 *      scenario-local NFR/RULE MAY bind UC; a cross-cutting NFR/RULE MAY
 *      bind accepted source constraints directly and is never forced into
 *      a fictional scenario (edges 0054-0062).
 *   L2 verification-surface coverage - every requirement carries at least
 *      one verification surface resolving inside the accepted
 *      verification-surface set (a requirement without a verification
 *      surface is a coverage gap, not a style issue).
 *   L3 revision-pin match - the bundle pins the exact accepted PRD and UC
 *      revisions (no stale, superseded or unaccepted derivation).
 *
 * PURITY: types + frozen data only. No I/O, no session, no SQL, no clock.
 * Test-only reachable until the coordinator lands the package (FRF-WP11):
 * nothing outside this directory imports it.
 */

/* ------------------------------------------------------------------ */
/* Identities                                                          */
/* ------------------------------------------------------------------ */

/** The installed desk/node id this Cell serves (manifest.ts row). */
export const SYSTEM_REQUIREMENTS_DESK_ID = 'derive-system-requirements' as const;

/** The desk's installed output product kind (manifest desk descriptor). */
export const SYSTEM_REQUIREMENTS_PRODUCT_KIND = 'formalization.system-requirements.v1' as const;

/** The desk's installed declared check provider id (manifest desk descriptor). */
export const SYSTEM_REQUIREMENTS_STRUCTURE_PROVIDER_ID = 'formalization.requirements-structure.v1' as const;

/**
 * The WP03 payload contract identity of the requirements bundle. The
 * bundle's `schemaVersion` field carries exactly this value; the WP03
 * validator refuses any other (`product is not a ...`).
 */
export const REQUIREMENTS_BUNDLE_CONTRACT_KIND = 'frf-contracts.requirements-bundle.v1' as const;

/** The WP03 payload contract identities of the two upstream surfaces. */
export const UPSTREAM_PRD_CONTRACT_KIND = 'frf-contracts.prd-intent-member.v1' as const;
export const UPSTREAM_UC_CONTRACT_KIND = 'frf-contracts.uc-scenario-member.v1' as const;

/* ------------------------------------------------------------------ */
/* Closed vocabularies                                                 */
/* ------------------------------------------------------------------ */

/** The closed requirement-kind vocabulary (WP03 schema enum). */
export const REQUIREMENT_KINDS = ['FR', 'NFR', 'RULE'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/**
 * The typed refusal vocabulary of the cell. Exactly the kernel's closed
 * seven-code product refusal set (products.ts / WP03 common.mjs); the cell
 * refuses with these codes and nothing else.
 */
export const REFUSAL_REASONS = [
  'MALFORMED_PRODUCT',
  'MISSING_LINEAGE',
  'FOREIGN_LINEAGE',
  'STALE_LINEAGE',
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'SCOPE_VIOLATION',
] as const;
export type RequirementsRefusalReason = (typeof REFUSAL_REASONS)[number];

export interface RequirementsRefusal {
  readonly ok: false;
  readonly refused: true;
  readonly reason: RequirementsRefusalReason;
  readonly detail: string;
}

/* ------------------------------------------------------------------ */
/* The derivation LAWS (declared data; the checks enforce them)        */
/* ------------------------------------------------------------------ */

export interface DerivationLaw {
  readonly lawId: string;
  /** The typed refusal the law polices with. */
  readonly refusal: RequirementsRefusalReason;
  /** The law statement (plan wording; cited by the skill and CheckPlan). */
  readonly statement: string;
  /** The WP02 reverse-graph derivation edges this law instantiates. */
  readonly reverseEdges: readonly string[];
}

/**
 * The three derivation LAWS of the Cell (plan §derive-system-requirements;
 * the assignment's normative list). The CheckPlan rows
 * (./checkplan.ts) are their deterministic enforcement surface and the
 * WP03 validator (through ./seam.ts) is their typed-refusal authority.
 */
export const DERIVATION_LAWS: readonly DerivationLaw[] = [
  {
    lawId: 'exact-derivation-lineage',
    refusal: 'FOREIGN_LINEAGE',
    statement:
      'every requirement derives from exact accepted PRD/UC members: a derivation reference outside the exact accepted id sets is foreign lineage and is refused (a scenario-derived FR binds UC scenario AND terminal-branch identities; a branch resolves within exactly one cited owning scenario)',
    reverseEdges: ['edge/0054', 'edge/0055', 'edge/0056', 'edge/0057', 'edge/0058', 'edge/0059', 'edge/0060', 'edge/0061', 'edge/0062'],
  },
  {
    lawId: 'verification-surface-coverage',
    refusal: 'COVERAGE_GAP',
    statement:
      'every requirement has a verification surface: a requirement naming no accepted verification surface is a coverage gap of the verification obligation set (an unverifiable requirement must not be accepted)',
    reverseEdges: [],
  },
  {
    lawId: 'revision-pin-match',
    refusal: 'STALE_LINEAGE',
    statement:
      'the bundle revision pins must match the accepted PRD/UC revisions exactly: a pin that is not the accepted revision content address is stale lineage (no requirement may derive from a foreign, stale, superseded or unaccepted material revision)',
    reverseEdges: [],
  },
];

/* ------------------------------------------------------------------ */
/* The requirements bundle payload (WP03 schema mirror)                */
/* ------------------------------------------------------------------ */

/**
 * One FR, NFR or RULE member with exact derivation lineage and
 * verification-surface references. Field-for-field the WP03 schema
 * $defs/requirementMember (draft 2020-12):
 *   - prdIntentRefs: REQUIRED, minItems 1 (reverse edges 0054/0057/0060);
 *   - ucScenarioRefs / ucTerminalBranchRefs: the scenario lineage when
 *     scenario-derived or scenario-local (edges 0055/0056/0058/0061);
 *   - sourceConstraintRefs: the cross-cutting direct lineage
 *     (edges 0059/0062);
 *   - verificationSurfaceRefs: REQUIRED, minItems 1 (law L2).
 */
export interface RequirementMember {
  readonly requirementId: string;
  readonly requirementKind: RequirementKind;
  readonly statement: string;
  readonly derivation: {
    readonly prdIntentRefs: readonly string[];
    readonly ucScenarioRefs?: readonly string[];
    readonly ucTerminalBranchRefs?: readonly string[];
    readonly sourceConstraintRefs?: readonly string[];
  };
  readonly verificationSurfaceRefs: readonly string[];
}

/** The requirements bundle payload (WP03 schema root mirror). */
export interface RequirementsBundle {
  readonly schemaVersion: typeof REQUIREMENTS_BUNDLE_CONTRACT_KIND;
  readonly prdRevisionRef: string;
  /** Required whenever any member cites UC material (the WP03 pin law). */
  readonly ucRevisionRef?: string;
  readonly requirements: readonly RequirementMember[];
}

/** One content-addressed bundle: content + its recomputed digest. */
export interface SealedBundle {
  readonly ref: string;
  readonly digest: string;
  readonly bundle: RequirementsBundle;
}

/* ------------------------------------------------------------------ */
/* The accepted-universe (the supplied accepted-id sets)               */
/* ------------------------------------------------------------------ */

/**
 * The exact accepted-id universe the cell validates against - the WP03
 * validator's `universe` shape. The upstream surfaces (accepted PRD intent
 * members, accepted UC scenarios with their terminal branches, accepted
 * source constraints, accepted verification surfaces) are SUPPLIED by the
 * transition inputs; the cell never scans, guesses or widens them
 * (fail-closed: a missing set is a typed refusal, never an empty pass).
 */
export interface RequirementsUniverse {
  readonly idSets: {
    readonly prdMemberIds: readonly string[];
    readonly ucScenarioIds: readonly string[];
    /** Terminal-branch ids keyed by their owning scenario id. */
    readonly ucBranchIdsByScenario: Readonly<Record<string, readonly string[]>>;
    readonly sourceConstraintIds: readonly string[];
    readonly verificationSurfaceIds: readonly string[];
  };
  readonly revisionPins: {
    /** The accepted PRD revision digest (64 lowercase hex, no prefix). */
    readonly prd: string;
    /** The accepted UC revision digest (64 lowercase hex, no prefix). */
    readonly uc: string;
  };
}

/** The WP03 validator's validation result shape (see ./seam.ts). */
export type Wp03Validation =
  | { readonly ok: true; readonly digest: string; readonly kind: string; readonly ref: string }
  | { readonly ok: false; readonly refused: true; readonly reason: string; readonly detail: string };
