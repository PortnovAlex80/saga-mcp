/**
 * workflow-kernel/workshops/formalization/cells/product-intent/gate.ts -
 * the CheckPlan, the declared deterministic check provider, and the
 * semantic gate of the define-product-intent Cell (FRF-WP04).
 *
 * Laws implemented here (mirroring the workshop gate pattern as NEW
 * parallel construction; the old flow stays until FRF-11):
 *   - The gate runs ONE declared, deterministic, content-addressed
 *     provider. The declaration digest covers the FENCE LIST, so a
 *     mutated declaration (fence removal, impostor id, kind swap) never
 *     verifies - PROVIDER_NOT_DECLARED, fail-closed.
 *   - Member semantics are NEVER re-implemented here: every member is
 *     validated by the WP03 contract through the seam
 *     (resolveProductIntentContract) with the accepted-id-set universe
 *     built from the exact Discovery handoff sets. An unwired seam is a
 *     typed refusal (CONTRACT_SEAM_UNWIRED) - the validator-bypass
 *     mutation cannot become a silent pass.
 *   - Verdict routing is the frozen table:
 *       MALFORMED_PRODUCT / MISSING_LINEAGE / STALE_LINEAGE / COVERAGE_GAP
 *         -> repair (obligation:requeueRepair)
 *       FOREIGN_LINEAGE -> upstream-repair (obligation:routeUpstreamRepair;
 *         never a silent scope widen - the UC-FOREIGN fix class)
 *       DRIFT_DETECTED -> human-wait (D5 TypedWait:human-input)
 *       SCOPE_VIOLATION -> terminal-reject
 *       ANY OTHER (indeterminate) -> human-wait via D5; never a pass.
 *   - Cell-level bundle laws the per-member WP03 contract cannot see:
 *       duplicate member ids (MALFORMED_PRODUCT) and the desk coverage
 *       law - every accepted source claim is realized by some member's
 *       sourceClaimRefs/scopeClaimRefs or carries no member at all ->
 *       COVERAGE_GAP (plan: "Every accepted Discovery scope item has an
 *       exact PRD intent member or an explicit deferred or out-of-scope
 *       disposition").
 *
 * PURITY: pure functions only. No session, no SQL, no clock.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { EvidenceFact } from '../../../../domain/types.js';
import type { ObligationKind } from '../../../../domain/universe.js';
import type { AcceptedIntentSet } from './cell.js';
import { acceptedIntentSetOf } from './cell.js';
import { PRODUCT_INTENT_CELL_ID, PRODUCT_INTENT_CELL_PRODUCT_KIND, PRODUCT_INTENT_FORBIDDEN_BUNDLE_KEYS } from './cell.js';
import type { ProductIntentAcceptedIdSetUniverse, ProductIntentContractPort, ProductIntentContractValidation } from './seam.js';
import { resolveProductIntentContract } from './seam.js';

/* ------------------------------------------------------------------ */
/* The declared deterministic check provider + CheckPlan               */
/* ------------------------------------------------------------------ */

export const PRODUCT_INTENT_CHECK_PROVIDER_ID = 'frf-cell.product-intent.members.v1';
export const PRODUCT_INTENT_CHECK_PROVIDER_VERSION = '1.0.0';

/** One declared check provider of the Cell (content-addressed incl. fences). */
export interface ProductIntentCheckProviderDeclaration {
  readonly providerId: string;
  readonly version: string;
  /** sha256 over the canonical declaration body (recomputed, never trusted). */
  readonly providerDigest: string;
  readonly nodeId: string;
  readonly productKind: string;
  /** The seam-fronted WP03 validator this provider runs (resolved fail-closed). */
  readonly validator: 'wp03:validatePrdIntentMember';
  /** The desk fence list; part of the digest (fence removal breaks the digest). */
  readonly fences: readonly string[];
  readonly repairTargetRole: 'author';
}

function declarationBody<V extends string>(providerId: string, version: string, nodeId: string, productKind: string, validator: V, fences: readonly string[]): { providerId: string; version: string; nodeId: string; productKind: string; validator: V; fences: string[] } {
  return { providerId, version, nodeId, productKind, validator, fences: [...fences].sort() };
}

/** The installed provider declaration of the Cell (deterministic). */
export function declaredProductIntentCheckProvider(): ProductIntentCheckProviderDeclaration {
  const body = declarationBody(PRODUCT_INTENT_CHECK_PROVIDER_ID, PRODUCT_INTENT_CHECK_PROVIDER_VERSION, PRODUCT_INTENT_CELL_ID, PRODUCT_INTENT_CELL_PRODUCT_KIND, 'wp03:validatePrdIntentMember', PRODUCT_INTENT_FORBIDDEN_BUNDLE_KEYS);
  return { ...body, providerDigest: sha256OfCanonical(body), repairTargetRole: 'author' };
}

/** The CheckPlan of the desk: deterministic declared providers only. */
export interface ProductIntentCheckPlan {
  readonly schemaVersion: 'frf-cell.check-plan.v1';
  readonly nodeId: typeof PRODUCT_INTENT_CELL_ID;
  readonly provider: ProductIntentCheckProviderDeclaration;
  readonly deterministic: true;
  readonly indeterminateRoute: 'human-wait (D5 TypedWait:human-input)';
}

export function productIntentCheckPlan(): ProductIntentCheckPlan {
  return {
    schemaVersion: 'frf-cell.check-plan.v1',
    nodeId: PRODUCT_INTENT_CELL_ID,
    provider: declaredProductIntentCheckProvider(),
    deterministic: true,
    indeterminateRoute: 'human-wait (D5 TypedWait:human-input)',
  };
}

/** The CheckPlan evidence fact (the exact gate-guard input shape, R15 pattern). */
export function productIntentCheckPlanEvidence(): EvidenceFact {
  const provider = declaredProductIntentCheckProvider();
  return {
    kind: 'CheckPlan',
    ref: `evidence:CheckPlan#${provider.providerId}`,
    producer: 'external-input',
    payloadDigest: sha256OfCanonical({
      providerId: provider.providerId,
      version: provider.version,
      providerDigest: provider.providerDigest,
      nodeId: provider.nodeId,
      productKind: provider.productKind,
      validator: provider.validator,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Gate inputs and outcomes                                            */
/* ------------------------------------------------------------------ */

/** The authored bundle as presented to the gate (members are WP03 payloads). */
export interface ProductIntentBundle {
  readonly schemaVersion: string;
  readonly brief?: unknown;
  readonly members?: readonly unknown[];
}

/** The gate verdict surface (the kernel's frozen five). */
export type CellGateVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

export interface CellGateIssue {
  readonly source: string;
  readonly detail: string;
}

export interface CellGateOutcome {
  readonly verdict: CellGateVerdict;
  readonly issues: readonly CellGateIssue[];
  readonly providerId: string;
  readonly productRef?: string;
  /** On accept: the downstream cross-desk lineage fold. */
  readonly acceptedSet?: AcceptedIntentSet;
}

/** Fail-closed gate refusals (infrastructure, never product semantics). */
export interface CellGateRefusal {
  readonly refused: true;
  readonly reason: 'PROVIDER_NOT_DECLARED' | 'CONTRACT_SEAM_UNWIRED' | 'PRODUCT_KIND_MISMATCH';
  readonly detail: string;
}

/** The refusal-reason -> verdict routing table (frozen; indeterminate -> human-wait). */
const VERDICT_OF_REASON: Readonly<Record<string, CellGateVerdict>> = {
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'human-wait',
  SCOPE_VIOLATION: 'terminal-reject',
};

/** The D5 typed human-input wait descriptor (indeterminate dispositions wait, never pass). */
export interface D5HumanWaitDescriptor {
  readonly kind: 'TypedWait:human-input';
  readonly wakeCommands: readonly ['workplace.resolveHumanResponse'];
}

export const D5_HUMAN_WAIT: D5HumanWaitDescriptor = {
  kind: 'TypedWait:human-input',
  wakeCommands: ['workplace.resolveHumanResponse'],
};

/** The obligation routing of a verdict (the kernel obligation-consumer vocabulary). */
export interface CellObligationRouting {
  readonly verdict: CellGateVerdict;
  readonly obligationKind: ObligationKind | null;
  readonly wait: D5HumanWaitDescriptor | null;
}

export function obligationRoutingOf(verdict: CellGateVerdict): CellObligationRouting {
  switch (verdict) {
    case 'repair':
      return { verdict, obligationKind: 'obligation:requeueRepair', wait: null };
    case 'upstream-repair':
      return { verdict, obligationKind: 'obligation:routeUpstreamRepair', wait: null };
    case 'human-wait':
      return { verdict, obligationKind: 'obligation:requeueAfterHumanResolution', wait: D5_HUMAN_WAIT };
    case 'terminal-reject':
      return { verdict, obligationKind: null, wait: null };
    case 'accepted':
      return { verdict, obligationKind: null, wait: null };
  }
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

function outcomeOfRefusal(providerId: string, reason: string, detail: string): CellGateOutcome {
  const verdict = VERDICT_OF_REASON[reason] ?? 'human-wait';
  return { verdict, issues: [{ source: VERDICT_OF_REASON[reason] === undefined ? `INDETERMINATE:${reason}` : reason, detail }], providerId };
}

/**
 * Evaluate the desk's semantic gate. Pure function of (provider
 * declaration, bundle, accepted handoff universe). Fail-closed on every
 * infrastructure miss; product semantics only through the WP03 seam.
 */
export function evaluateProductIntentGate(
  provider: ProductIntentCheckProviderDeclaration,
  bundle: ProductIntentBundle,
  universe: ProductIntentAcceptedIdSetUniverse,
): CellGateOutcome | CellGateRefusal {
  // 1. Declared provider (fail-closed; the digest covers the fences).
  const installed = declaredProductIntentCheckProvider();
  const recomputed = sha256OfCanonical(declarationBody(provider.providerId, provider.version, provider.nodeId, provider.productKind, provider.validator, provider.fences));
  if (
    provider.providerId !== installed.providerId ||
    provider.providerDigest !== installed.providerDigest ||
    provider.providerDigest !== recomputed ||
    provider.productKind !== installed.productKind ||
    provider.validator !== installed.validator
  ) {
    return {
      refused: true,
      reason: 'PROVIDER_NOT_DECLARED',
      detail: `provider ${provider.providerId} is not the installed declaration of desk ${PRODUCT_INTENT_CELL_ID} (declared digest ${provider.providerDigest}, recomputed ${recomputed}); an undeclared or mutated provider never gates a product`,
    };
  }
  // 2. Presented product kind (fail-closed kind match).
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { refused: true, reason: 'PRODUCT_KIND_MISMATCH', detail: `the presented product is not a ${PRODUCT_INTENT_CELL_PRODUCT_KIND} bundle` };
  }
  if (bundle.schemaVersion !== PRODUCT_INTENT_CELL_PRODUCT_KIND) {
    return { refused: true, reason: 'PRODUCT_KIND_MISMATCH', detail: `provider ${provider.providerId} gates ${PRODUCT_INTENT_CELL_PRODUCT_KIND}; the presented schemaVersion is ${String(bundle.schemaVersion)}` };
  }
  // 3. The contract seam (fail-closed: validator bypass is impossible).
  const seam = resolveProductIntentContract();
  if ('refused' in seam) {
    return { refused: true, reason: 'CONTRACT_SEAM_UNWIRED', detail: seam.detail };
  }
  const port: ProductIntentContractPort = seam.port;
  // 4. Desk fence (SCOPE_VIOLATION: the intent desk never produces finals).
  const raw = bundle as unknown as Record<string, unknown>;
  for (const forbidden of PRODUCT_INTENT_FORBIDDEN_BUNDLE_KEYS) {
    if (raw[forbidden] !== undefined) {
      return outcomeOfRefusal(provider.providerId, 'SCOPE_VIOLATION', `the product-intent Cell must not produce final ${forbidden} content`);
    }
  }
  // 5. Bundle shape.
  if (typeof bundle.brief !== 'string' || bundle.brief.length === 0) {
    return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', 'the product-intent bundle needs a non-empty brief');
  }
  if (!Array.isArray(bundle.members) || bundle.members.length === 0) {
    return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', 'the PRD must contain stable atomic intent members');
  }
  // 6. Every member through the WP03 validator (first typed refusal routes).
  const seals: { memberId: string; digest: string }[] = [];
  const seenMemberIds = new Set<string>();
  for (const member of bundle.members) {
    const validation: ProductIntentContractValidation = port.validateMember(member, universe);
    if (!validation.ok) {
      return outcomeOfRefusal(provider.providerId, validation.reason, validation.detail);
    }
    const record = member as { memberId?: unknown };
    if (typeof record.memberId !== 'string' || seenMemberIds.has(record.memberId)) {
      return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', typeof record.memberId === 'string'
        ? `duplicate PRD intent member ${record.memberId} (substitution or double emission)`
        : 'every PRD intent member needs a stable id');
    }
    seenMemberIds.add(record.memberId);
    seals.push({ memberId: record.memberId, digest: validation.digest });
  }
  // 7. The desk coverage law (every accepted source claim is realized).
  const citedClaims = new Set<string>();
  for (const member of bundle.members) {
    const record = member as { sourceClaimRefs?: unknown; scopeClaimRefs?: unknown };
    for (const ref of Array.isArray(record.sourceClaimRefs) ? record.sourceClaimRefs : []) citedClaims.add(String(ref));
    for (const ref of Array.isArray(record.scopeClaimRefs) ? record.scopeClaimRefs : []) citedClaims.add(String(ref));
  }
  for (const claimId of universe.idSets.sourceClaimIds) {
    if (!citedClaims.has(claimId)) {
      return outcomeOfRefusal(provider.providerId, 'COVERAGE_GAP', `accepted Discovery scope item ${claimId} has no exact PRD intent member and no explicit disposition (every accepted scope item is realized or explicitly disposed)`);
    }
  }
  // 8. Accept: seal the bundle and fold the downstream accepted set.
  const productRef = `sha256:${sha256OfCanonical(bundle)}`;
  const fold = acceptedIntentSetOf(bundle as { members: readonly unknown[] }, seals);
  if (!fold.ok) {
    return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', fold.detail);
  }
  return { verdict: 'accepted', issues: [], providerId: provider.providerId, productRef, acceptedSet: fold.set };
}
