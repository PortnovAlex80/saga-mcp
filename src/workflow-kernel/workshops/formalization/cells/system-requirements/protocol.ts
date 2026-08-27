/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * protocol.ts - the desk PROTOCOL of the derive-system-requirements
 * Production Cell (FRF-WP05): its exact input and output surfaces.
 *
 * Protocol (plan §Desk contracts/derive-system-requirements + FRF-WP02
 * forward graph node `derive-system-requirements`):
 *   INPUT  = the accepted PRD intent members + the accepted UC scenarios
 *            (the upstream surfaces), SUPPLIED as exact accepted-id sets
 *            with their accepted revision pins; plus the accepted source
 *            constraints and the accepted verification surfaces the
 *            cross-cutting lineage and law L2 resolve against.
 *   OUTPUT = the requirements bundle (FR/NFR/RULE members with exact
 *            derivation refs, verification-surface refs and revision
 *            pins) validating via the WP03 requirements-bundle validator
 *            with typed refusals.
 *
 * Fail-closed law: the protocol NEVER scans for upstream material, never
 * guesses a set, never widens a supplied one. A missing or empty upstream
 * set is a typed MISSING_LINEAGE refusal (mirroring the WP03 validator's
 * fail-closed universe rule: "the validator is fail-closed and will not
 * guess the accepted universe"). Decoy executions and newer unrelated
 * artifacts never become authority because nothing but the supplied sets
 * is ever consulted.
 *
 * PURITY: pure functions over supplied data. No I/O, no session, no clock.
 */

import {
  SYSTEM_REQUIREMENTS_DESK_ID,
  UPSTREAM_PRD_CONTRACT_KIND,
  UPSTREAM_UC_CONTRACT_KIND,
} from './contract.js';
import type { RequirementsRefusal, RequirementsRefusalReason, RequirementsUniverse } from './contract.js';

/* ------------------------------------------------------------------ */
/* The desk protocol declaration (data)                                */
/* ------------------------------------------------------------------ */

/** One upstream surface of the desk's protocol. */
export interface ProtocolSurface {
  readonly contractKind: string;
  readonly role: 'input' | 'output';
  readonly memberIdField: string;
}

/** The declared protocol of the derive-system-requirements desk. */
export interface DeskProtocol {
  readonly deskId: typeof SYSTEM_REQUIREMENTS_DESK_ID;
  readonly surfaces: readonly ProtocolSurface[];
}

/**
 * The installed protocol declaration of the Cell. The upstream surfaces
 * are exactly the two the forward graph names under `consumes.
 * acceptedMaterial` (prd, useCases); the output is the requirements
 * bundle (produces.artifactTypes FR/NFR/RULE, memberIdField
 * requirementId, revisionPins prdRevisionRef/ucRevisionRef).
 */
export const SYSTEM_REQUIREMENTS_PROTOCOL: DeskProtocol = {
  deskId: SYSTEM_REQUIREMENTS_DESK_ID,
  surfaces: [
    { contractKind: UPSTREAM_PRD_CONTRACT_KIND, role: 'input', memberIdField: 'memberId' },
    { contractKind: UPSTREAM_UC_CONTRACT_KIND, role: 'input', memberIdField: 'scenarioId' },
  ],
};

/* ------------------------------------------------------------------ */
/* The desk input (the supplied upstream surfaces)                     */
/* ------------------------------------------------------------------ */

/**
 * What the transition hands the desk: the exact accepted PRD and UC
 * revisions with their atomic member ids, the terminal branches each
 * accepted scenario declared (the branch ids a scenario-derived FR's
 * lineage resolves within), the accepted source constraints a
 * cross-cutting NFR/RULE may bind directly, and the accepted
 * verification surfaces law L2 resolves against.
 */
export interface SystemRequirementsDeskInput {
  readonly prd: {
    readonly revisionDigest: string;
    readonly memberIds: readonly string[];
  };
  readonly useCases: {
    readonly revisionDigest: string;
    readonly scenarioIds: readonly string[];
    readonly branchIdsByScenario: Readonly<Record<string, readonly string[]>>;
  };
  readonly sourceConstraintIds: readonly string[];
  readonly verificationSurfaceIds: readonly string[];
}

function refused(reason: RequirementsRefusalReason, detail: string): RequirementsRefusal {
  return { ok: false, refused: true, reason, detail };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Derive the WP03 accepted-universe from the supplied desk input.
 * Fail-closed on every missing surface: an absent or empty accepted set,
 * or a revision pin that is not a 64-hex content digest, is a typed
 * MISSING_LINEAGE refusal - the protocol never guesses the universe and
 * never substitutes newer material.
 */
export function deriveAcceptedUniverse(input: SystemRequirementsDeskInput): { readonly ok: true; readonly universe: RequirementsUniverse } | RequirementsRefusal {
  if (input === null || typeof input !== 'object') {
    return refused('MISSING_LINEAGE', 'no desk input was supplied (requirements derive only from the exact accepted upstream surfaces carried by the transition)');
  }
  if (input.prd === undefined || input.prd === null || !Array.isArray(input.prd.memberIds) || input.prd.memberIds.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted PRD intent-member set was supplied (fail-closed: the Cell will not guess the accepted PRD universe)');
  }
  if (input.useCases === undefined || input.useCases === null || !Array.isArray(input.useCases.scenarioIds) || input.useCases.scenarioIds.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted UC scenario set was supplied (fail-closed: the Cell will not guess the accepted UC universe)');
  }
  if (typeof input.prd.revisionDigest !== 'string' || !HEX64.test(input.prd.revisionDigest)) {
    return refused('MISSING_LINEAGE', 'no accepted PRD revision digest was supplied (fail-closed: a bundle pin cannot be verified without the accepted revision)');
  }
  if (typeof input.useCases.revisionDigest !== 'string' || !HEX64.test(input.useCases.revisionDigest)) {
    return refused('MISSING_LINEAGE', 'no accepted UC revision digest was supplied (fail-closed: a bundle pin cannot be verified without the accepted revision)');
  }
  const byScenario = input.useCases.branchIdsByScenario;
  if (byScenario === undefined || byScenario === null || typeof byScenario !== 'object' || Array.isArray(byScenario)) {
    return refused('MISSING_LINEAGE', 'no accepted ucBranchIdsByScenario map was supplied (fail-closed: terminal-branch lineage cannot resolve without the owning scenarios\' frozen branch id sets)');
  }
  for (const scenarioId of input.useCases.scenarioIds) {
    const branches = byScenario[scenarioId];
    if (!Array.isArray(branches) || branches.length === 0) {
      return refused('MISSING_LINEAGE', `accepted UC ${String(scenarioId)} declares no terminal-branch id set (every UC declares material branches; a scenario-derived FR binds exact branch identities)`);
    }
  }
  if (!Array.isArray(input.sourceConstraintIds)) {
    return refused('MISSING_LINEAGE', 'no accepted source-constraint set was supplied (fail-closed: cross-cutting NFR/RULE direct lineage cannot resolve)');
  }
  if (!Array.isArray(input.verificationSurfaceIds) || input.verificationSurfaceIds.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted verification-surface set was supplied (fail-closed: law L2 verification-surface coverage cannot resolve)');
  }
  return {
    ok: true,
    universe: {
      idSets: {
        prdMemberIds: [...input.prd.memberIds],
        ucScenarioIds: [...input.useCases.scenarioIds],
        ucBranchIdsByScenario: Object.fromEntries(
          Object.entries(byScenario).map(([scenarioId, branches]) => [scenarioId, [...(branches as readonly string[])]]),
        ),
        sourceConstraintIds: [...input.sourceConstraintIds],
        verificationSurfaceIds: [...input.verificationSurfaceIds],
      },
      revisionPins: { prd: input.prd.revisionDigest, uc: input.useCases.revisionDigest },
    },
  };
}
