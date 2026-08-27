/**
 * workflow-kernel/workshops/formalization/cells/system-requirements/
 * bundle.ts - the output-bundle builder of the derive-system-requirements
 * Production Cell (FRF-WP05).
 *
 * Laws implemented here:
 *   - The authored bundle is CONTENT-ADDRESSED: the digest is recomputed
 *     over the canonical bundle JSON by sealBundle (the kernel's ONE
 *     canonical digest rule, imported from domain/digest.ts - never
 *     reimplemented); a declared digest is never trusted.
 *   - Desk contract fence: the Cell produces ONLY FR, NFR and RULE
 *     members inside ONE requirements bundle. A candidate carrying any
 *     other artifact family (UC scenarios, acceptance criteria, SRS
 *     sections) is a typed SCOPE_VIOLATION, never a silent pass.
 *   - The builder is the AUTHORING surface: it assembles the payload from
 *     authored members and applies the structural pin law (the UC revision
 *     pin is written exactly when any member cites UC material). The
 *     semantic laws (L1-L3) are enforced by the CheckPlan checks and the
 *     WP03 validator - never by trusting the builder.
 *
 * PURITY: node:crypto via the kernel digest rule only. No session, no SQL,
 * no clock.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import {
  REQUIREMENT_KINDS,
  REQUIREMENTS_BUNDLE_CONTRACT_KIND,
  SYSTEM_REQUIREMENTS_PRODUCT_KIND,
} from './contract.js';
import type {
  RequirementKind,
  RequirementMember,
  RequirementsBundle,
  RequirementsRefusal,
  RequirementsRefusalReason,
  SealedBundle,
} from './contract.js';

function refused(reason: RequirementsRefusalReason, detail: string): RequirementsRefusal {
  return { ok: false, refused: true, reason, detail };
}

/* ------------------------------------------------------------------ */
/* The desk contract fence (scope law)                                 */
/* ------------------------------------------------------------------ */

/**
 * The forbidden artifact families of this Cell's candidate: the
 * requirements desk must not emit scenario, acceptance, architecture or
 * handoff material (those belong to the upstream UC Cell, the downstream
 * acceptance Cell, the SRS Cell and settlement).
 */
const FORBIDDEN_CANDIDATE_KEYS: readonly string[] = [
  'scenarios',
  'acceptanceCriteria',
  'criteria',
  'srs',
  'scenarioRealizations',
  'solutionContract',
];

/**
 * The scope fence of the Cell: a candidate object carrying any artifact
 * family outside FR/NFR/RULE members is refused SCOPE_VIOLATION (the
 * derive-system-requirements desk produces existing FR, NFR and RULE
 * artifacts only - plan §Decision "minimum concept budget").
 */
export function fenceCandidateScope(candidate: unknown): RequirementsRefusal | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const raw = candidate as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_CANDIDATE_KEYS) {
    if (raw[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `the derive-system-requirements Cell must not produce ${forbidden} artifacts (it produces FR, NFR and RULE members inside one requirements bundle only)`);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The bundle builder                                                  */
/* ------------------------------------------------------------------ */

/** One authored requirement as presented to the builder. */
export interface AuthoredRequirement {
  readonly requirementId: string;
  readonly requirementKind: string;
  readonly statement: string;
  readonly prdIntentRefs: readonly string[];
  readonly ucScenarioRefs?: readonly string[];
  readonly ucTerminalBranchRefs?: readonly string[];
  readonly sourceConstraintRefs?: readonly string[];
  readonly verificationSurfaceRefs: readonly string[];
}

export interface BuildBundleInput {
  /** The exact accepted PRD revision digest (64 hex, no prefix). */
  readonly prdRevisionDigest: string;
  /** The exact accepted UC revision digest (64 hex, no prefix). */
  readonly ucRevisionDigest: string;
  readonly requirements: readonly AuthoredRequirement[];
}

export type BuildBundleOutcome =
  | { readonly ok: true; readonly sealed: SealedBundle }
  | RequirementsRefusal;

/**
 * Build and seal one requirements bundle. Structural authoring fences:
 * stable unique ids, the closed kind vocabulary, statements, at least one
 * member, non-empty PRD intent refs and verification surfaces per member,
 * and the UC pin law (the pin is written exactly when a member cites UC
 * material). Semantic lineage resolution stays with the checks/WP03
 * validator - the builder never widens a reference set.
 */
export function buildRequirementsBundle(input: BuildBundleInput): BuildBundleOutcome {
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the requirements bundle must contain at least one FR, NFR or RULE');
  }
  const seen = new Set<string>();
  let citesUc = false;
  const members: RequirementMember[] = [];
  for (const authored of input.requirements) {
    if (typeof authored.requirementId !== 'string' || authored.requirementId.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every requirement needs a stable id');
    }
    if (seen.has(authored.requirementId)) {
      return refused('MALFORMED_PRODUCT', `duplicate requirement id ${authored.requirementId}`);
    }
    seen.add(authored.requirementId);
    if (!(REQUIREMENT_KINDS as readonly string[]).includes(authored.requirementKind)) {
      return refused('MALFORMED_PRODUCT', `requirement ${authored.requirementId} has kind ${String(authored.requirementKind)} outside the closed FR/NFR/RULE vocabulary`);
    }
    if (typeof authored.statement !== 'string' || authored.statement.length === 0) {
      return refused('MALFORMED_PRODUCT', `requirement ${authored.requirementId} needs a statement`);
    }
    if (!Array.isArray(authored.prdIntentRefs) || authored.prdIntentRefs.length === 0) {
      return refused('MISSING_LINEAGE', `requirement ${authored.requirementId} binds no exact PRD intent member`);
    }
    if (!Array.isArray(authored.verificationSurfaceRefs) || authored.verificationSurfaceRefs.length === 0) {
      return refused('COVERAGE_GAP', `requirement ${authored.requirementId} names no verification surface (an unverifiable requirement must not be authored into the bundle)`);
    }
    const scenarioRefs = authored.ucScenarioRefs ?? [];
    const branchRefs = authored.ucTerminalBranchRefs ?? [];
    const constraintRefs = authored.sourceConstraintRefs ?? [];
    if (scenarioRefs.length > 0 || branchRefs.length > 0) citesUc = true;
    members.push({
      requirementId: authored.requirementId,
      requirementKind: authored.requirementKind as RequirementKind,
      statement: authored.statement,
      derivation: {
        prdIntentRefs: [...authored.prdIntentRefs],
        ...(scenarioRefs.length > 0 ? { ucScenarioRefs: [...scenarioRefs] } : {}),
        ...(branchRefs.length > 0 ? { ucTerminalBranchRefs: [...branchRefs] } : {}),
        ...(constraintRefs.length > 0 ? { sourceConstraintRefs: [...constraintRefs] } : {}),
      },
      verificationSurfaceRefs: [...authored.verificationSurfaceRefs],
    });
  }
  const bundle: RequirementsBundle = {
    schemaVersion: REQUIREMENTS_BUNDLE_CONTRACT_KIND,
    prdRevisionRef: `sha256:${input.prdRevisionDigest}`,
    ...(citesUc ? { ucRevisionRef: `sha256:${input.ucRevisionDigest}` } : {}),
    requirements: members,
  };
  return { ok: true, sealed: sealBundle(bundle) };
}

/** Seal one bundle: the content digest is recomputed, never trusted. */
export function sealBundle(bundle: RequirementsBundle): SealedBundle {
  const digest = sha256OfCanonical(bundle);
  return { ref: `sha256:${digest}`, digest, bundle };
}

/**
 * The candidate product this Cell presents to its gate: the installed desk
 * product kind plus the WP03-shaped bundle payload.
 */
export interface SystemRequirementsCandidate {
  readonly kind: typeof SYSTEM_REQUIREMENTS_PRODUCT_KIND;
  readonly product: RequirementsBundle;
}

/** Wrap one bundle payload as the desk's candidate product. */
export function candidateOf(bundle: RequirementsBundle): SystemRequirementsCandidate {
  return { kind: SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: bundle };
}
