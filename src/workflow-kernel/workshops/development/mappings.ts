/**
 * workflow-kernel/workshops/development/mappings.ts - the PURE CONTRIBUTION
 * MAPPINGS of the converted workshop (WP-11V, plan EK-8): ordinary actor
 * outputs and durable kernel facts map onto the workshop's input/output
 * products. Every mapping is a total pure function - no I/O, no session,
 * no clock, no reclassification of a role contract.
 *
 * The mappings are the workshop's contribution semantics:
 *   - an author actor run (tool calls + text + product) maps onto ONE
 *     IntegratedCandidate (input of review);
 *   - a reviewer actor run maps onto a gate input payload (its ordinary
 *     verdict is translated by the DECLARED gate rules, never trusted raw);
 *   - the freeze-boundary durable facts map onto ONE ReadinessManifest;
 *   - the terminal durable facts map onto ONE VerifiedBundle.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { ActorRunResult } from '../../development/actors.js';
import type {
  IntegratedCandidate,
  MachineObservation,
  ReadinessManifest,
  VerifiedBundle,
} from './products.js';

/* ------------------------------------------------------------------ */
/* Author contribution mapping                                         */
/* ------------------------------------------------------------------ */

export type MappingRefusal =
  | { readonly refused: true; readonly code: 'ACTOR_PRODUCED_NO_PRODUCT'; readonly detail: string }
  | { readonly refused: true; readonly code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT'; readonly detail: string };

export type ContributionMapping<T> = { readonly mapped: true; readonly value: T; readonly digest: string } | MappingRefusal;

/** Map one author actor run onto its IntegratedCandidate (input of review). */
export function toIntegratedCandidate(
  actorResult: ActorRunResult,
  input: { readonly capsuleRef: string; readonly scopeRefs: readonly string[] },
): ContributionMapping<IntegratedCandidate> {
  const product = actorResult.products[0];
  if (product === undefined) {
    return { refused: true, code: 'ACTOR_PRODUCED_NO_PRODUCT', detail: 'the author actor run produced no product; an empty contribution is not a candidate (EMPTY_WORK_IS_NOT_A_PROOF discipline)' };
  }
  if (input.scopeRefs.length === 0) {
    return { refused: true, code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT', detail: 'an integrated candidate covers a non-empty capsule scope' };
  }
  const toolCallDigest = sha256OfCanonical(actorResult.toolCalls);
  const candidate: IntegratedCandidate = {
    schemaId: 'workshop.development.integrated-candidate.v1',
    capsuleRef: input.capsuleRef,
    productDigest: product.digest,
    scopeRefs: [...input.scopeRefs],
    toolCallDigest,
    summary: `${product.description} :: ${actorResult.text.join(' ')}`.trim(),
  };
  return { mapped: true, value: candidate, digest: sha256OfCanonical(candidate) };
}

/* ------------------------------------------------------------------ */
/* Reviewer contribution mapping (gate input payload)                  */
/* ------------------------------------------------------------------ */

/** The reviewer's ordinary outputs mapped onto a gate input (verdict decided by the declared rules elsewhere). */
export interface ReviewerGateInput {
  readonly capsuleRef: string;
  readonly reviewerProductDigest: string | undefined;
  readonly surfacedVerdict: string | undefined;
  readonly toolCallDigest: string;
  readonly text: readonly string[];
}

export function toReviewerGateInput(
  actorResult: ActorRunResult,
  input: { readonly capsuleRef: string },
): ContributionMapping<ReviewerGateInput> {
  const payload: ReviewerGateInput = {
    capsuleRef: input.capsuleRef,
    reviewerProductDigest: actorResult.products[0]?.digest,
    surfacedVerdict: actorResult.verdict,
    toolCallDigest: sha256OfCanonical(actorResult.toolCalls),
    text: [...actorResult.text],
  };
  return { mapped: true, value: payload, digest: sha256OfCanonical(payload) };
}

/* ------------------------------------------------------------------ */
/* Freeze-boundary mapping (durable facts -> ReadinessManifest)        */
/* ------------------------------------------------------------------ */

/** The durable freeze-boundary facts the mapping consumes (a narrow read of the committed world). */
export interface FreezeBoundaryFacts {
  readonly capsuleRef: string;
  readonly workplaceInstanceId: string;
  readonly machineObservation: MachineObservation;
  readonly verificationDigest: string;
  /** Evidence kinds already committed for the frozen product (e.g. EffectReceipt:human-wait). */
  readonly settledEvidenceKinds: readonly string[];
}

/**
 * Map the freeze-boundary facts onto the ReadinessManifest. The mapping is
 * total and honest: the manifest always declares the readiness disposition
 * as operator-only (the machine observation is carried, the readiness
 * itself is named unobservable - the Elite-2 class).
 */
export function toReadinessManifest(facts: FreezeBoundaryFacts): ContributionMapping<ReadinessManifest> {
  if (facts.settledEvidenceKinds.length === 0) {
    return { refused: true, code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT', detail: 'a readiness manifest carries the settled evidence kinds of the frozen product' };
  }
  const manifest: ReadinessManifest = {
    schemaId: 'workshop.development.readiness-manifest.v1',
    capsuleRef: facts.capsuleRef,
    workplaceInstanceId: facts.workplaceInstanceId,
    machineObservation: facts.machineObservation,
    verificationDigest: facts.verificationDigest,
    settledEvidenceKinds: [...facts.settledEvidenceKinds],
    unobservable: 'readiness-for-certification',
    requiredDisposition: {
      kind: 'TypedWait:human-input',
      wakeCommand: 'workplace.resolveHumanResponse',
      operatorDispositionRequired: true,
    },
  };
  return { mapped: true, value: manifest, digest: sha256OfCanonical(manifest) };
}

/* ------------------------------------------------------------------ */
/* Terminal mapping (durable proofs -> VerifiedBundle)                 */
/* ------------------------------------------------------------------ */

/** The durable terminal facts the mapping consumes. */
export interface TerminalFacts {
  readonly capsuleRef: string;
  readonly workplaceInstanceId: string;
  readonly acceptanceDigest: string;
  readonly terminalProofs: readonly string[];
  readonly claimCoverageRefs: readonly string[];
  /** The run terminal proof outcome actually committed (the mapping refuses anything but success). */
  readonly runTerminalOutcome: string;
}

/** Map the terminal proofs onto the workshop output bundle. */
export function toVerifiedBundle(facts: TerminalFacts): ContributionMapping<VerifiedBundle> {
  if (facts.terminalProofs.length === 0) {
    return { refused: true, code: 'EMPTY_SCOPE_IS_NOT_A_PRODUCT', detail: 'a verified bundle carries non-empty terminal proofs (empty work is not a proof)' };
  }
  if (facts.runTerminalOutcome !== 'success') {
    return { refused: true, code: 'ACTOR_PRODUCED_NO_PRODUCT', detail: `a verified bundle requires the run success proof (got ${String(facts.runTerminalOutcome)})` };
  }
  const bundle: VerifiedBundle = {
    schemaId: 'workshop.development.verified-bundle.v1',
    capsuleRef: facts.capsuleRef,
    workplaceInstanceId: facts.workplaceInstanceId,
    acceptanceDigest: facts.acceptanceDigest,
    terminalProofs: [...facts.terminalProofs],
    claimCoverageRefs: [...facts.claimCoverageRefs],
    runTerminalOutcome: 'success',
  };
  return { mapped: true, value: bundle, digest: sha256OfCanonical(bundle) };
}
