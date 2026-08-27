/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/contract.ts
 * - FRF-WP08: the SRS scenario-realization payload contract (the existing
 * SRS contract EXTENSION of plan phase FRF-8).
 *
 * OWNERSHIP: this cell owns the payload contract the frozen WHAT baseline
 * declares as its post-freeze SRS resolution surfaces (FRF-WP03,
 * docs/refactoring/formalization-frf/contracts/schemas/what-baseline.schema.json,
 * $defs.handoffSurfaceEntry.properties.resolvesAgainst.enum):
 *
 *   postFreeze.srs.realizationEntryIds  <- realization.realizationEntries[].realizationEntryId
 *   postFreeze.srs.surfaces             <- realization.surfaces[].surfaceId
 *   postFreeze.srs.revisionDigest       <- the accepted SRS revision digest pin
 *
 * THE WP03 VALIDATOR SEAM (documented, pinned by tests/seam tests): every
 * validator of this cell takes the accepted id-set UNIVERSE as input and is
 * fail-closed - a reference class whose accepted set was not supplied is a
 * typed MISSING_LINEAGE refusal; a binding that does not resolve against the
 * exact supplied set is a typed FOREIGN_LINEAGE refusal. The cell never
 * scans, guesses, or reselects accepted material.
 *
 * Laws implemented here (pure data + pure functions, no I/O, no clock):
 *   - Every frozen UC scenario survives through the SRS realized scenarios
 *     (realizedScenarioIds resolve against the frozen scenario id set; the
 *     coverage law itself is enforced by validator.ts).
 *   - Every realized scenario cites its realizing architecture surfaces; the
 *     two closed surface kinds are exactly the reverse graph's composition +
 *     infrastructure obligation families (WP02 reverse graph node kinds
 *     composition-obligation / construction-obligation; the Development
 *     obligation kinds integration-or-composition-obligation and
 *     infrastructure-obligation).
 *   - Content addressing: digests are RECOMPUTED over canonical JSON (the
 *     kernel's frozen digest rule), never trusted from the payload.
 *   - The trace grammar rule owned by this cell is
 *     srs-derived-from-frozen-what-baseline (WP03 what-baseline schema
 *     traceRecord kind enum; WP02 reverse edge/0042).
 *
 * PURITY: node:crypto via the kernel digest rule only. No session, no SQL,
 * no clock. Test-only reachable: no production module outside this cell
 * imports it (the FRF cells land wired by their own work packages).
 */

import { digestExcluding, sha256OfCanonical } from '../../../../domain/digest.js';
import type { ContentArtifact, ProductRefusal } from '../../products.js';
import { artifactOf } from '../../products.js';

/* ------------------------------------------------------------------ */
/* Versioned contract identities                                       */
/* ------------------------------------------------------------------ */

/** The mandatory scenario-realization section inside the existing SRS product. */
export const SRS_REALIZATION_SECTION_KIND = 'formalization.srs-realization.v1' as const;

/** The sealed architecture contract the define-architecture-contract desk emits. */
export const ARCHITECTURE_CONTRACT_KIND = 'formalization.architecture-contract.v1' as const;

/** The desk this cell serves (installed manifest node id, verified in desk.ts). */
export const SRS_REALIZATION_DESK_ID = 'define-architecture-contract' as const;

/** The trace-grammar rule this cell owns (WP03 what-baseline trace kind enum). */
export const SRS_TRACE_RULE = 'srs-derived-from-frozen-what-baseline' as const;

/**
 * The exact post-freeze SRS resolution surfaces the WP03 what-baseline
 * declares for downstream handoff binding kinds (scenario-realization-bindings,
 * srs-reference-and-hash, integration-and-construction-obligations) and
 * WorkItem obligation kinds (scenario-realization-obligation,
 * integration-or-composition-obligation, infrastructure-obligation).
 */
export const POST_FREEZE_SRS_SURFACES = Object.freeze([
  'postFreeze.srs.realizationEntryIds',
  'postFreeze.srs.revisionDigest',
  'postFreeze.srs.surfaces',
] as const);

/* ------------------------------------------------------------------ */
/* Closed vocabularies                                                 */
/* ------------------------------------------------------------------ */

/**
 * The closed architecture-surface kind vocabulary: exactly the reverse
 * graph's composition + infrastructure obligation families. A composition
 * surface is carried by an integration-or-composition obligation; an
 * infrastructure surface by an infrastructure obligation (construction
 * obligation defined-by-realization, WP02 reverse edges 0040/0041).
 */
export const ARCHITECTURE_SURFACE_KINDS = Object.freeze(['composition', 'infrastructure'] as const);
export type ArchitectureSurfaceKind = (typeof ARCHITECTURE_SURFACE_KINDS)[number];

/** The closed evidence-kind vocabulary (WP03; the frozen four). */
export const REALIZATION_EVIDENCE_KINDS = Object.freeze([
  'audit',
  'independent-agent-review',
  'monitoring',
  'test',
] as const);
export type RealizationEvidenceKind = (typeof REALIZATION_EVIDENCE_KINDS)[number];

/** The Development obligation kinds this contract materializes surfaces for. */
export const CONTRACT_OBLIGATION_KINDS = Object.freeze([
  'infrastructure-obligation',
  'integration-or-composition-obligation',
] as const);
export type ContractObligationKind = (typeof CONTRACT_OBLIGATION_KINDS)[number];

/** The WP03 frozen id pattern (closed identity shape, mirrored exactly). */
export const ID_PATTERN = /^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

/** The accepted id-set universe input of every validator of this cell. */
export interface SrsRealizationUniverse {
  readonly idSets: {
    /** The frozen scenario id set (containers.uc.scenarioIds of the frozen baseline). */
    readonly ucScenarioIds: readonly string[];
    /** The frozen evidence-method binding ids (baseline evidenceBindings). */
    readonly evidenceBindingIds: readonly string[];
  };
  readonly revisionPins: {
    /** The frozen whole-WHAT baseline revision digest (sha256 hex). */
    readonly whatBaselineDigest: string;
    /** The accepted SRS revision digest (sha256 hex). */
    readonly srsRevisionDigest: string;
  };
}

/* ------------------------------------------------------------------ */
/* The payload shapes                                                  */
/* ------------------------------------------------------------------ */

/** One declared architecture surface, cited with the scenarios it realizes. */
export interface ArchitectureSurface {
  readonly surfaceId: string;
  readonly surfaceKind: ArchitectureSurfaceKind;
  readonly description: string;
  /** The realized scenarios this surface takes part in (>= 1; resolved by the validator). */
  readonly realizedScenarioRefs: readonly string[];
}

/** One required producer-consumer/runtime edge over declared surfaces. */
export interface RealizationRuntimeEdge {
  readonly fromSurfaceRef: string;
  readonly toSurfaceRef: string;
}

/** The evidence binding one realization entry declares (closed kinds). */
export interface RealizationEvidenceBinding {
  readonly evidenceKind: RealizationEvidenceKind;
  /** Resolves against the frozen evidence-binding id set (FOREIGN_LINEAGE otherwise). */
  readonly evidenceBindingRef: string;
}

/** One SRS realized scenario: the mandatory realization entry shape. */
export interface RealizedScenarioEntry {
  readonly realizationEntryId: string;
  /** The frozen UC scenario this entry realizes (resolves against the frozen scenario id set). */
  readonly scenarioRef: string;
  readonly entrypointSurfaceRef: string;
  readonly participatingSurfaceRefs: readonly string[];
  readonly runtimeEdges: readonly RealizationRuntimeEdge[];
  readonly externalInterfaces: readonly string[];
  /** The required implementation/integration surfaces this realization cites (construction obligations). */
  readonly implementationSurfaceRefs: readonly string[];
  readonly compositionOwnerSurfaceRef: string;
  /** The terminal observable result (a node of the runtime graph, like the sibling SRS contract). */
  readonly terminalResult: string;
  readonly evidenceBinding: RealizationEvidenceBinding;
}

/** The mandatory scenario-realization section of the existing SRS product. */
export interface SrsRealizationSection {
  readonly schemaVersion: typeof SRS_REALIZATION_SECTION_KIND;
  readonly lineage: {
    readonly traceRule: typeof SRS_TRACE_RULE;
    /** The frozen whole-WHAT baseline pin (sha256:<hex>). */
    readonly baselineRef: string;
  };
  readonly realizationEntries: readonly RealizedScenarioEntry[];
  readonly surfaces: readonly ArchitectureSurface[];
  /** sha256 over the canonical JSON of this object minus realizationDigest. */
  readonly realizationDigest: string;
}

/** One Development obligation binding: a surface cited with the scenarios it realizes. */
export interface DevelopmentObligationBinding {
  readonly obligationKind: ContractObligationKind;
  readonly surfaceRef: string;
  readonly realizedScenarioRefs: readonly string[];
  /** The realization entries that cite this surface (defined-by-realization). */
  readonly definedByRealizationEntryRefs: readonly string[];
}

/** The sealed architecture contract (the define-architecture-contract desk output). */
export interface ArchitectureContractProduct {
  readonly schemaVersion: typeof ARCHITECTURE_CONTRACT_KIND;
  readonly deskId: typeof SRS_REALIZATION_DESK_ID;
  readonly lineage: {
    readonly traceRule: typeof SRS_TRACE_RULE;
    readonly baselineRef: string;
    readonly srsRevisionDigest: string;
  };
  readonly realization: SrsRealizationSection;
  readonly developmentObligations: {
    readonly integrationOrComposition: readonly DevelopmentObligationBinding[];
    readonly infrastructure: readonly DevelopmentObligationBinding[];
  };
  /** The exact WP03 postFreeze.srs.* resolution surfaces (verified against the section). */
  readonly postFreeze: {
    readonly realizationEntryIds: readonly string[];
    readonly surfaces: readonly string[];
    readonly revisionDigest: string;
  };
  /** sha256 over the canonical JSON of this object minus canonicalDigest. */
  readonly canonicalDigest: string;
}

/* ------------------------------------------------------------------ */
/* Refusal vocabulary (sibling parity: the workshop's closed seven)     */
/* ------------------------------------------------------------------ */

export type { ProductRefusal, ProductValidation, ContentArtifact } from '../../products.js';

/* ------------------------------------------------------------------ */
/* Digest rules (recomputed, never trusted)                            */
/* ------------------------------------------------------------------ */

/** The canonical realization digest of a section (digest field excluded by the kernel rule). */
export function realizationDigestOf(
  section: SrsRealizationSection | Omit<SrsRealizationSection, 'realizationDigest'>,
): string {
  return digestExcluding(section as unknown as Record<string, unknown>, ['realizationDigest']);
}

/** The canonical digest of an architecture contract (digest field excluded by the kernel rule). */
export function architectureContractDigestOf(
  contract: ArchitectureContractProduct | Omit<ArchitectureContractProduct, 'canonicalDigest'>,
): string {
  return digestExcluding(contract as unknown as Record<string, unknown>, ['canonicalDigest']);
}

/** The distinct realized scenario ids of a section (sorted, deduplicated view). */
export function realizedScenarioIdsOf(section: SrsRealizationSection): readonly string[] {
  return [...new Set(section.realizationEntries.map((entry) => entry.scenarioRef))].sort();
}

/** The declared surface ids of a section (in declared order). */
export function declaredSurfaceIdsOf(section: SrsRealizationSection): readonly string[] {
  return section.surfaces.map((surface) => surface.surfaceId);
}

/**
 * Derive the Development obligation bindings of a section: every COMPOSITION
 * surface becomes one integration-or-composition obligation, every
 * INFRASTRUCTURE surface one infrastructure obligation - each cited with the
 * scenarios it realizes and the realization entries that define it (reverse
 * graph edges 0040/0041: defined-by-realization).
 */
export function developmentObligationsOf(section: SrsRealizationSection): {
  readonly integrationOrComposition: readonly DevelopmentObligationBinding[];
  readonly infrastructure: readonly DevelopmentObligationBinding[];
} {
  const bindingOf = (surface: ArchitectureSurface, obligationKind: ContractObligationKind): DevelopmentObligationBinding => ({
    obligationKind,
    surfaceRef: surface.surfaceId,
    realizedScenarioRefs: [...surface.realizedScenarioRefs],
    definedByRealizationEntryRefs: section.realizationEntries
      .filter((entry) =>
        entry.entrypointSurfaceRef === surface.surfaceId ||
        entry.compositionOwnerSurfaceRef === surface.surfaceId ||
        entry.participatingSurfaceRefs.includes(surface.surfaceId) ||
        entry.implementationSurfaceRefs.includes(surface.surfaceId) ||
        entry.runtimeEdges.some((edge) => edge.fromSurfaceRef === surface.surfaceId || edge.toSurfaceRef === surface.surfaceId))
      .map((entry) => entry.realizationEntryId)
      .sort(),
  });
  return {
    integrationOrComposition: section.surfaces
      .filter((surface) => surface.surfaceKind === 'composition')
      .map((surface) => bindingOf(surface, 'integration-or-composition-obligation')),
    infrastructure: section.surfaces
      .filter((surface) => surface.surfaceKind === 'infrastructure')
      .map((surface) => bindingOf(surface, 'infrastructure-obligation')),
  };
}

/** The exact WP03 postFreeze.srs.* block of a section + revision pin. */
export function postFreezeBlockOf(
  section: SrsRealizationSection,
  srsRevisionDigest: string,
): ArchitectureContractProduct['postFreeze'] {
  return {
    realizationEntryIds: section.realizationEntries.map((entry) => entry.realizationEntryId).sort(),
    surfaces: [...declaredSurfaceIdsOf(section)].sort(),
    revisionDigest: srsRevisionDigest,
  };
}

/** Seal one content-addressed artifact over a payload (digest recomputed). */
export function sealArtifact(content: unknown): ContentArtifact {
  return artifactOf(content);
}

/** Typed refusal helper (the workshop's closed refusal shape). */
export function refused(reason: ProductRefusal['reason'], detail: string): ProductRefusal {
  return { ok: false, refused: true, reason, detail };
}

/** Deterministic digest helper exposed for fixture builders (no secrets of the kernel). */
export const deterministicDigest = sha256OfCanonical;
