/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/desk.ts
 * - FRF-WP08: the define-architecture-contract desk binding of the SRS
 * scenario-realization cell (the SIBLING PATTERN of the installed
 * Formalization workshop: protocol skill + per-desk semantic skill +
 * declared CheckPlan provider + reviewer route + role bindings, all read
 * from the INSTALLED manifest - this cell adds no new manifest rows, it
 * verifies itself against the installed ones and refuses typed on any
 * mismatch).
 *
 * Desk contract (plan "Desk contracts/define-architecture-contract"):
 *   input  = the frozen WHAT baseline (the accepted id-set universe pin)
 *             + the SRS scenario-realization draft;
 *   output = the architecture contract binding composition + infrastructure
 *             surfaces to the realizing scenarios - each surface cited with
 *             the scenarios it realizes (the reverse graph's composition +
 *             infrastructure obligation kinds: integration-or-composition
 *             obligations and infrastructure/construction obligations).
 *
 * Laws:
 *   - The desk declaration is verified against the INSTALLED manifest
 *     (node id, production-cell kind, output product kind
 *     formalization.srs.v1, declared check provider formalization.srs-
 *     structure.v1). A mismatch is a typed refusal - the cell never
 *     installs a shadow desk.
 *   - The CheckPlan evidence fact is produced by the sibling gate module
 *     (gates.checkPlanEvidenceFor) over the SAME installed provider
 *     declaration - one check surface, byte-identical.
 *   - The verdict routing is the workshop's frozen table (FOREIGN_LINEAGE
 *     routes upstream-repair; DRIFT routes human-wait; SCOPE routes
 *     terminal-reject).
 *   - Assembly is pure and fail-closed: parse (closed vocabulary) ->
 *     validate (the WP03 universe seam) -> seal (canonical digests
 *     recomputed). Nothing is adopted unvalidated.
 *
 * PURITY: pure functions only. No session, no SQL, no clock.
 */

import type { EvidenceFact } from '../../../../domain/types.js';
import { sha256OfCanonical } from '../../../../domain/digest.js';
import type { CheckProviderDeclaration } from '../../manifest.js';
import { FORMALIZATION_ROLE_BINDINGS, PROTOCOL_SKILL_ID, checkProviderOfDesk, nodeOf } from '../../manifest.js';
import { checkPlanEvidenceFor } from '../../gates.js';
import type { ProductRefusal } from '../../products.js';
import {
  ARCHITECTURE_CONTRACT_KIND,
  CONTRACT_OBLIGATION_KINDS,
  POST_FREEZE_SRS_SURFACES,
  SRS_REALIZATION_DESK_ID,
  SRS_REALIZATION_SECTION_KIND,
  SRS_TRACE_RULE,
  architectureContractDigestOf,
  developmentObligationsOf,
  postFreezeBlockOf,
} from './contract.js';
import type { ArchitectureContractProduct, SrsRealizationSection, SrsRealizationUniverse } from './contract.js';
import { parseSrsRealizationDraft } from './parser.js';
import { validateArchitectureContract, validateSrsRealization } from './validator.js';

/* ------------------------------------------------------------------ */
/* The desk declaration (verified against the installed manifest)       */
/* ------------------------------------------------------------------ */

/** The closed input contract kinds the desk consumes. */
export const DESK_INPUT_CONTRACT_KINDS = Object.freeze([
  'frf-contracts.what-baseline.v1',
  SRS_REALIZATION_SECTION_KIND,
] as const);

export interface SrsRealizationDeskDeclaration {
  readonly deskId: typeof SRS_REALIZATION_DESK_ID;
  readonly nodeKind: 'production-cell';
  readonly outputProductKind: 'formalization.srs.v1';
  readonly checkProvider: CheckProviderDeclaration;
  readonly protocolSkillId: string;
  readonly semanticSkillId: string;
  readonly inputContractKinds: readonly [string, string];
  readonly obligationKinds: readonly typeof CONTRACT_OBLIGATION_KINDS[number][];
  readonly postFreezeSurfaces: readonly typeof POST_FREEZE_SRS_SURFACES[number][];
  readonly roleBindings: readonly { readonly launchKind: string; readonly protocolRole: 'author' | 'reviewer'; readonly semanticProfile: 'implementer' | 'reviewer' }[];
}

export type DeskDeclarationOutcome =
  | { readonly ok: true; readonly declaration: SrsRealizationDeskDeclaration }
  | { readonly ok: false; readonly refused: true; readonly reason: 'DESK_NOT_INSTALLED' | 'PROVIDER_NOT_INSTALLED'; readonly detail: string };

/**
 * The desk declaration of this cell, verified against the INSTALLED
 * workshop manifest (fail-closed: the cell never runs as a shadow desk).
 */
export function srsRealizationDeskDeclaration(): DeskDeclarationOutcome {
  const node = nodeOf(SRS_REALIZATION_DESK_ID);
  if (!node.ok) {
    return { ok: false, refused: true, reason: 'DESK_NOT_INSTALLED', detail: `node ${SRS_REALIZATION_DESK_ID} is not in the installed module flow: ${node.detail}` };
  }
  if (node.node.kind !== 'production-cell') {
    return { ok: false, refused: true, reason: 'DESK_NOT_INSTALLED', detail: `node ${SRS_REALIZATION_DESK_ID} is a ${node.node.kind} node, the architecture desk is a production cell` };
  }
  if (node.node.desk === undefined || node.node.desk.outputProductKind !== 'formalization.srs.v1') {
    return { ok: false, refused: true, reason: 'DESK_NOT_INSTALLED', detail: `desk ${SRS_REALIZATION_DESK_ID} does not declare output product kind formalization.srs.v1 in the installed manifest` };
  }
  const provider = checkProviderOfDesk(SRS_REALIZATION_DESK_ID);
  if (!provider.ok) {
    return { ok: false, refused: true, reason: 'PROVIDER_NOT_INSTALLED', detail: provider.detail };
  }
  if (provider.provider.providerId !== 'formalization.srs-structure.v1' || provider.provider.validator !== 'validateSrs') {
    return { ok: false, refused: true, reason: 'PROVIDER_NOT_INSTALLED', detail: `desk ${SRS_REALIZATION_DESK_ID} pins provider ${provider.provider.providerId} (validator ${provider.provider.validator}); the SRS realization cell serves the installed formalization.srs-structure.v1 / validateSrs provider surface` };
  }
  return {
    ok: true,
    declaration: {
      deskId: SRS_REALIZATION_DESK_ID,
      nodeKind: 'production-cell',
      outputProductKind: 'formalization.srs.v1',
      checkProvider: provider.provider,
      protocolSkillId: PROTOCOL_SKILL_ID,
      semanticSkillId: 'formalization-desk-define-architecture-contract',
      inputContractKinds: ['frf-contracts.what-baseline.v1', SRS_REALIZATION_SECTION_KIND],
      obligationKinds: [...CONTRACT_OBLIGATION_KINDS],
      postFreezeSurfaces: [...POST_FREEZE_SRS_SURFACES],
      roleBindings: FORMALIZATION_ROLE_BINDINGS.map((binding) => ({ ...binding })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* CheckPlan evidence (the sibling gate surface, byte-identical)        */
/* ------------------------------------------------------------------ */

/**
 * The CheckPlan evidence fact of this desk's declared provider: produced by
 * the SIBLING gate module over the same installed provider declaration, so
 * the kernel gate guards and this cell consume one identical fact.
 */
export function srsRealizationCheckPlanEvidence(): EvidenceFact | { readonly refused: true; readonly detail: string } {
  const declaration = srsRealizationDeskDeclaration();
  if (!declaration.ok) return { refused: true, detail: declaration.detail };
  return checkPlanEvidenceFor(declaration.declaration.checkProvider);
}

/* ------------------------------------------------------------------ */
/* The reviewer route (the frozen verdict table of the workshop)         */
/* ------------------------------------------------------------------ */

/** The gate verdict surface (the kernel's frozen five, sibling of gates.ts). */
export type DeskVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/** The refusal-reason -> verdict routing table (mirrors gates.VERDICT_OF_REASON). */
export const DESK_VERDICT_OF_REASON: Readonly<Record<ProductRefusal['reason'], DeskVerdict>> = Object.freeze({
  MALFORMED_PRODUCT: 'repair',
  MISSING_LINEAGE: 'repair',
  STALE_LINEAGE: 'repair',
  COVERAGE_GAP: 'repair',
  FOREIGN_LINEAGE: 'upstream-repair',
  DRIFT_DETECTED: 'human-wait',
  SCOPE_VIOLATION: 'terminal-reject',
});

/** Route one typed refusal to the desk verdict (the reviewer route of the cell). */
export function deskVerdictOf(refusal: ProductRefusal): DeskVerdict {
  return DESK_VERDICT_OF_REASON[refusal.reason];
}

/* ------------------------------------------------------------------ */
/* The desk assembly (pure, fail-closed)                                */
/* ------------------------------------------------------------------ */

export type ArchitectureContractAssembly =
  | { readonly ok: true; readonly product: ArchitectureContractProduct; readonly section: SrsRealizationSection }
  | ProductRefusal;

/**
 * Author the architecture contract the desk way: parse the SRS realization
 * draft (deterministic, closed vocabulary), validate the section against
 * the accepted universe (the WP03 seam), then seal the contract binding
 * composition + infrastructure surfaces to the realizing scenarios. The
 * sealed product is validated once more end-to-end before it is returned -
 * nothing is adopted unvalidated, nothing is silently repaired.
 */
export function authorArchitectureContract(draft: unknown, universe: SrsRealizationUniverse): ArchitectureContractAssembly {
  const declaration = srsRealizationDeskDeclaration();
  if (!declaration.ok) {
    return { ok: false, refused: true, reason: 'SCOPE_VIOLATION', detail: `the desk cannot author: ${declaration.detail}` };
  }
  const parsed = parseSrsRealizationDraft(draft);
  if (!parsed.ok) return parsed;
  const sectionOutcome = validateSrsRealization(parsed.section, universe);
  if (!sectionOutcome.ok) return sectionOutcome;
  const srsRevisionDigest = universe.revisionPins?.srsRevisionDigest;
  if (typeof srsRevisionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(srsRevisionDigest)) {
    return { ok: false, refused: true, reason: 'MISSING_LINEAGE', detail: 'no accepted srsRevisionDigest pin was supplied; the desk is fail-closed and will not seal against a guessed SRS revision' };
  }
  const body = {
    schemaVersion: ARCHITECTURE_CONTRACT_KIND,
    deskId: SRS_REALIZATION_DESK_ID,
    lineage: {
      traceRule: SRS_TRACE_RULE,
      baselineRef: `sha256:${universe.revisionPins.whatBaselineDigest}`,
      srsRevisionDigest,
    },
    realization: parsed.section,
    developmentObligations: developmentObligationsOf(parsed.section),
    postFreeze: postFreezeBlockOf(parsed.section, srsRevisionDigest),
  };
  const product: ArchitectureContractProduct = { ...body, canonicalDigest: architectureContractDigestOf(body) };
  const verdict = validateArchitectureContract(product, universe);
  if (!verdict.ok) return verdict;
  return { ok: true, product, section: parsed.section };
}

/** The desk's pinned semantic-skill content digest (content-addressed data only). */
export function semanticSkillDigestOfDesk(): string {
  return sha256OfCanonical({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: SRS_REALIZATION_DESK_ID });
}
