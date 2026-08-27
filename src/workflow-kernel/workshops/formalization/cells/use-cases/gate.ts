/**
 * workflow-kernel/workshops/formalization/cells/use-cases/gate.ts -
 * the CheckPlan, the declared deterministic check provider, and the
 * semantic gate of the model-use-cases Cell (FRF-WP04).
 *
 * CROSS-DESK LINEAGE (the core of this gate): the only accepted PRD
 * intent universe is the upstream define-product-intent Cell's accepted
 * output fold (AcceptedIntentSet). The gate builds the WP03 universe
 * from that exact set and validates every scenario's prdIntentRefs
 * against it: a foreign PRD reference (another run, another project, a
 * fabricated member) is refused FOREIGN_LINEAGE and routed
 * upstream-repair - the UC-FOREIGN class fix demonstrated at the Cell
 * level, with the accepted-id-set universe carried as gate input.
 *
 * Verdict routing, the declaration-digest fence kill, the seam, the D5
 * human-wait indeterminate route and the obligation routing mirror the
 * product-intent cell (see ../product-intent/gate.ts). Cell-level
 * bundle laws beyond the per-scenario WP03 contract: duplicate scenario
 * ids (MALFORMED_PRODUCT) and the UC coverage fence - every
 * scenario_required upstream member must be covered by at least one
 * scenario's prdIntentRefs (COVERAGE_GAP).
 *
 * PURITY: pure functions only. No session, no SQL, no clock.
 */

import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { EvidenceFact } from '../../../../domain/types.js';
import type { ObligationKind } from '../../../../domain/universe.js';
import type { AcceptedIntentSet } from '../product-intent/cell.js';
import type { AcceptedScenarioSet } from './cell.js';
import { acceptedScenarioSetOf } from './cell.js';
import { UC_CELL_ID, UC_CELL_PRODUCT_KIND, UC_FORBIDDEN_BUNDLE_KEYS } from './cell.js';
import type { UcScenarioAcceptedIdSetUniverse, UcScenarioContractPort, UcScenarioContractValidation } from './seam.js';
import { resolveUcScenarioContract } from './seam.js';

/* ------------------------------------------------------------------ */
/* The declared deterministic check provider + CheckPlan               */
/* ------------------------------------------------------------------ */

export const UC_CHECK_PROVIDER_ID = 'frf-cell.uc-scenarios.v1';
export const UC_CHECK_PROVIDER_VERSION = '1.0.0';

/** One declared check provider of the Cell (content-addressed incl. fences). */
export interface UcCheckProviderDeclaration {
  readonly providerId: string;
  readonly version: string;
  /** sha256 over the canonical declaration body (recomputed, never trusted). */
  readonly providerDigest: string;
  readonly nodeId: string;
  readonly productKind: string;
  /** The seam-fronted WP03 validator this provider runs (resolved fail-closed). */
  readonly validator: 'wp03:validateUcScenarioMember';
  /** The desk fence list; part of the digest (fence removal breaks the digest). */
  readonly fences: readonly string[];
  readonly repairTargetRole: 'author';
}

function declarationBody<V extends string>(providerId: string, version: string, nodeId: string, productKind: string, validator: V, fences: readonly string[]): { providerId: string; version: string; nodeId: string; productKind: string; validator: V; fences: string[] } {
  return { providerId, version, nodeId, productKind, validator, fences: [...fences].sort() };
}

/** The installed provider declaration of the Cell (deterministic). */
export function declaredUcCheckProvider(): UcCheckProviderDeclaration {
  const body = declarationBody(UC_CHECK_PROVIDER_ID, UC_CHECK_PROVIDER_VERSION, UC_CELL_ID, UC_CELL_PRODUCT_KIND, 'wp03:validateUcScenarioMember', UC_FORBIDDEN_BUNDLE_KEYS);
  return { ...body, providerDigest: sha256OfCanonical(body), repairTargetRole: 'author' };
}

/** The CheckPlan of the desk: deterministic declared providers only. */
export interface UcCheckPlan {
  readonly schemaVersion: 'frf-cell.check-plan.v1';
  readonly nodeId: typeof UC_CELL_ID;
  readonly provider: UcCheckProviderDeclaration;
  readonly deterministic: true;
  readonly indeterminateRoute: 'human-wait (D5 TypedWait:human-input)';
}

export function ucCheckPlan(): UcCheckPlan {
  return {
    schemaVersion: 'frf-cell.check-plan.v1',
    nodeId: UC_CELL_ID,
    provider: declaredUcCheckProvider(),
    deterministic: true,
    indeterminateRoute: 'human-wait (D5 TypedWait:human-input)',
  };
}

/** The CheckPlan evidence fact (the exact gate-guard input shape, R15 pattern). */
export function ucCheckPlanEvidence(): EvidenceFact {
  const provider = declaredUcCheckProvider();
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

/** The authored bundle as presented to the gate (scenarios are WP03 payloads). */
export interface UcScenariosBundle {
  readonly schemaVersion: string;
  readonly scenarios?: readonly unknown[];
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
  readonly acceptedSet?: AcceptedScenarioSet;
}

/** Fail-closed gate refusals (infrastructure, never product semantics). */
export interface CellGateRefusal {
  readonly refused: true;
  readonly reason: 'PROVIDER_NOT_DECLARED' | 'CONTRACT_SEAM_UNWIRED' | 'PRODUCT_KIND_MISMATCH' | 'UPSTREAM_NOT_SUPPLIED';
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
 * Evaluate the desk's semantic gate over the upstream accepted intent
 * set. Pure function of (provider declaration, bundle, upstream fold).
 * Fail-closed on every infrastructure miss; scenario semantics only
 * through the WP03 seam with the exact accepted PRD member universe.
 */
export function evaluateUcGate(
  provider: UcCheckProviderDeclaration,
  bundle: UcScenariosBundle,
  upstream: AcceptedIntentSet | undefined,
): CellGateOutcome | CellGateRefusal {
  // 1. Declared provider (fail-closed; the digest covers the fences).
  const installed = declaredUcCheckProvider();
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
      detail: `provider ${provider.providerId} is not the installed declaration of desk ${UC_CELL_ID} (declared digest ${provider.providerDigest}, recomputed ${recomputed}); an undeclared or mutated provider never gates a product`,
    };
  }
  // 2. Presented product kind (fail-closed kind match).
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { refused: true, reason: 'PRODUCT_KIND_MISMATCH', detail: `the presented product is not a ${UC_CELL_PRODUCT_KIND} bundle` };
  }
  if (bundle.schemaVersion !== UC_CELL_PRODUCT_KIND) {
    return { refused: true, reason: 'PRODUCT_KIND_MISMATCH', detail: `provider ${provider.providerId} gates ${UC_CELL_PRODUCT_KIND}; the presented schemaVersion is ${String(bundle.schemaVersion)}` };
  }
  // 3. The upstream accepted intent set (cross-desk lineage input, fail-closed).
  if (upstream === undefined || upstream === null || !Array.isArray(upstream.prdMemberIds) || upstream.prdMemberIds.length === 0) {
    return {
      refused: true,
      reason: 'UPSTREAM_NOT_SUPPLIED',
      detail: 'no accepted define-product-intent set was supplied; the UC desk models scenarios against the EXACT accepted PRD intent members only (fail-closed; the gate never guesses the accepted universe)',
    };
  }
  const universe: UcScenarioAcceptedIdSetUniverse = { idSets: { prdMemberIds: [...upstream.prdMemberIds] } };
  // 4. The contract seam (fail-closed: validator bypass is impossible).
  const seam = resolveUcScenarioContract();
  if ('refused' in seam) {
    return { refused: true, reason: 'CONTRACT_SEAM_UNWIRED', detail: seam.detail };
  }
  const port: UcScenarioContractPort = seam.port;
  // 5. Desk fence (SCOPE_VIOLATION: no pre-existing FR, no finals).
  const raw = bundle as unknown as Record<string, unknown>;
  for (const forbidden of UC_FORBIDDEN_BUNDLE_KEYS) {
    if (raw[forbidden] !== undefined) {
      return outcomeOfRefusal(provider.providerId, 'SCOPE_VIOLATION', `the UC Cell must not require a pre-existing FR and must not produce ${forbidden} content`);
    }
  }
  // 6. Bundle shape.
  if (!Array.isArray(bundle.scenarios) || bundle.scenarios.length === 0) {
    return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', 'the UC bundle must contain at least one scenario');
  }
  // 7. Every scenario through the WP03 validator (first typed refusal routes).
  const seals: { scenarioId: string; digest: string }[] = [];
  const seenScenarioIds = new Set<string>();
  for (const scenario of bundle.scenarios) {
    const validation: UcScenarioContractValidation = port.validateScenario(scenario, universe);
    if (!validation.ok) {
      return outcomeOfRefusal(provider.providerId, validation.reason, validation.detail);
    }
    const record = scenario as { scenarioId?: unknown };
    if (typeof record.scenarioId !== 'string' || seenScenarioIds.has(record.scenarioId)) {
      return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', typeof record.scenarioId === 'string'
        ? `duplicate UC scenario ${record.scenarioId} (substitution or double emission)`
        : 'every UC needs a stable scenario identity');
    }
    seenScenarioIds.add(record.scenarioId);
    seals.push({ scenarioId: record.scenarioId, digest: validation.digest });
  }
  // 8. The UC coverage fence: every scenario_required upstream member is covered.
  const covered = new Set<string>();
  for (const scenario of bundle.scenarios) {
    for (const ref of Array.isArray((scenario as { prdIntentRefs?: unknown }).prdIntentRefs) ? (scenario as { prdIntentRefs: unknown[] }).prdIntentRefs : []) {
      covered.add(String(ref));
    }
  }
  for (const memberId of upstream.scenarioRequiredMemberIds) {
    if (!covered.has(memberId)) {
      return outcomeOfRefusal(provider.providerId, 'COVERAGE_GAP', `scenario_required PRD member ${memberId} is covered by no UC scenario`);
    }
  }
  // 9. Accept: seal the bundle and fold the downstream accepted set.
  const productRef = `sha256:${sha256OfCanonical(bundle)}`;
  const fold = acceptedScenarioSetOf(bundle as { scenarios: readonly unknown[] }, seals);
  if (!fold.ok) {
    return outcomeOfRefusal(provider.providerId, 'MALFORMED_PRODUCT', fold.detail);
  }
  return { verdict: 'accepted', issues: [], providerId: provider.providerId, productRef, acceptedSet: fold.set };
}
