/**
 * workflow-kernel/workshops/formalization/contribution.ts - the PURE
 * contribution mappings of the Formalization workshop through the kernel
 * material chain (WP-11F, plan phase EK-8 workshop conversion; ADR-053).
 *
 * The accepted-material authority is the Workplace PRODUCTION REVISION:
 *   authored product (validated by the desk's declared check provider)
 *     -> ContributionMaterial (workplace.recordContribution payload digest)
 *     -> production revision manifest (workplace.sealProductionRevision)
 *     -> CandidateSet (workplace.presentCandidateSet)
 *     -> gate verdict (workplace.runAuthorGate / runFinalGate)
 *     -> on accept: the AcceptedMaterial chain folds FORWARD (the exact
 *        revision digest + atomic member ids enter the lineage state every
 *        downstream desk validates against).
 *
 * Every mapping here is a PURE function of its inputs: no session, no SQL,
 * no clock. The driver carries the outputs as evidence refs into the public
 * commands; nothing in this module writes anything.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { AcceptedMaterial, ContentArtifact } from './products.js';

/** The pure contribution payload of one authored product. */
export interface ContributionMaterial {
  readonly productKind: string;
  /** The product content address ("sha256:" + 64 hex). */
  readonly productRef: string;
  /** sha256 over {intentRef, productKind, productRef} - the contribution digest the kernel records. */
  readonly contributionDigest: string;
  /** The exact refs carried into the production revision manifest. */
  readonly materialRefs: readonly string[];
}

/** Map one authored product to its kernel contribution material (pure). */
export function contributionOf(intentRef: string, productKind: string, artifact: ContentArtifact): ContributionMaterial {
  return {
    productKind,
    productRef: artifact.ref,
    contributionDigest: sha256OfCanonical({ intentRef, productKind, productRef: artifact.ref }),
    materialRefs: [artifact.ref],
  };
}

/** The production-revision manifest of a desk's accepted material (pure). */
export function revisionManifestOf(materials: readonly ContributionMaterial[]): {
  readonly revisionDigest: string;
  readonly productRefs: readonly string[];
} {
  const productRefs = materials.map((material) => material.productRef);
  return {
    revisionDigest: sha256OfCanonical({ productRefs }),
    productRefs,
  };
}

/** The CandidateSet digest of a revision's material (pure). */
export function candidateSetOf(materials: readonly ContributionMaterial[]): { readonly candidateDigest: string; readonly productRefs: readonly string[] } {
  const manifest = revisionManifestOf(materials);
  return {
    candidateDigest: sha256OfCanonical({ revision: manifest.revisionDigest, products: manifest.productRefs }),
    productRefs: manifest.productRefs,
  };
}

/* ------------------------------------------------------------------ */
/* The accepted-material chain fold                                    */
/* ------------------------------------------------------------------ */

/**
 * Fold one ACCEPTED product into the lineage state (the material chain).
 * Called only after a gate accepted the product: the next desk validates
 * against the returned state (ADR-053: the production revision is the
 * accepted-material authority; the attempt is provenance).
 */
export function acceptedMaterialAfter(
  accepted: AcceptedMaterial,
  productKind: string,
  artifact: ContentArtifact,
  memberIds: readonly string[],
): AcceptedMaterial {
  const revisionDigest = sha256OfCanonical({ productRef: artifact.ref, members: [...memberIds].sort() });
  switch (productKind) {
    case 'formalization.prd-intent.v1':
      return {
        ...accepted,
        prd: {
          revisionDigest,
          memberIds: [...memberIds],
          scenarioRequiredMemberIds: accepted.prd?.scenarioRequiredMemberIds ?? [],
        },
      };
    case 'formalization.uc-scenarios.v1':
      return { ...accepted, useCases: { revisionDigest, scenarioIds: [...memberIds] } };
    case 'formalization.system-requirements.v1':
      return { ...accepted, requirements: { revisionDigest, requirementIds: [...memberIds] } };
    case 'formalization.acceptance-bindings.v1':
      return { ...accepted, acceptance: { revisionDigest, criterionIds: [...memberIds] } };
    case 'formalization.what-reconciliation.v1':
      return { ...accepted, reconciliation: { revisionDigest, verdict: 'consistent' } };
    case 'formalization.srs.v1':
      return { ...accepted, srs: { revisionDigest, realizedScenarioIds: [...memberIds] } };
    default:
      // The baseline fold is whole-what specific: use acceptedBaselineAfter.
      return accepted;
  }
}

/** Fold the accepted PRD's scenario_required dispositions (the UC coverage fence input). */
export function acceptedScenarioRequiredAfter(scenarioRequiredMemberIds: readonly string[], accepted: AcceptedMaterial): AcceptedMaterial {
  if (accepted.prd === undefined) return accepted;
  return {
    ...accepted,
    prd: { ...accepted.prd, scenarioRequiredMemberIds: [...scenarioRequiredMemberIds] },
  };
}

/** Fold the accepted whole-WHAT baseline into the lineage state. */
export function acceptedBaselineAfter(
  accepted: AcceptedMaterial,
  revisionDigest: string,
  wholeWhatDigest: string,
): AcceptedMaterial {
  return { ...accepted, baseline: { revisionDigest, wholeWhatDigest } };
}

/** The initial accepted-material state of an imported Discovery handoff. */
export function acceptedMaterialOfHandoff(handoff: {
  readonly digest: string;
  readonly sourceClaimIds: readonly string[];
  readonly constraintIds: readonly string[];
  readonly unknownIds: readonly string[];
  readonly terminalClaimIds: readonly string[];
}): AcceptedMaterial {
  return {
    handoff: {
      digest: handoff.digest,
      sourceClaimIds: [...handoff.sourceClaimIds],
      constraintIds: [...handoff.constraintIds],
      unknownIds: [...handoff.unknownIds],
      terminalClaimIds: [...handoff.terminalClaimIds],
    },
  };
}
