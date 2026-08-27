/**
 * workflow-kernel/workshops/formalization/cells/srs-realization/parser.ts
 * - FRF-WP08: the deterministic, closed-vocabulary parser of the SRS
 * scenario-realization draft (plan phase FRF-8: "Add a strict parser and
 * validator for scenario identity, entry/trigger, modules, runtime edges,
 * interfaces, composition owner, terminal result, and evidence binding").
 *
 * Laws:
 *   - DETERMINISTIC: the same draft bytes always parse to the same sealed
 *     section (deep-frozen output, canonical digest, no clock, no I/O).
 *   - CLOSED VOCABULARY: unknown fields, open enum values, off-pattern ids
 *     and wrong shapes are typed MALFORMED_PRODUCT refusals - the parser
 *     never guesses, coerces, or silently drops content. A draft that
 *     presents only a flat file list or an AC decomposition instead of the
 *     realization section does not parse (the field set is closed).
 *   - The parser computes the canonical realizationDigest (recomputed over
 *     the parsed content); a draft never supplies its own digest.
 *   - Lineage RESOLUTION is not the parser's job: refs are shape-checked
 *     only; the validator resolves them against the accepted universe
 *     (the WP03 fail-closed seam).
 *
 * PURITY: pure functions only.
 */

import {
  ARCHITECTURE_SURFACE_KINDS,
  ID_PATTERN,
  REALIZATION_EVIDENCE_KINDS,
  SRS_REALIZATION_SECTION_KIND,
  SRS_TRACE_RULE,
  realizationDigestOf,
} from './contract.js';
import type {
  ArchitectureSurface,
  ArchitectureSurfaceKind,
  RealizationEvidenceKind,
  RealizedScenarioEntry,
  SrsRealizationSection,
} from './contract.js';
import type { ProductRefusal } from '../../products.js';

export type ParseOutcome =
  | { readonly ok: true; readonly section: SrsRealizationSection }
  | ProductRefusal;

const ENTRY_FIELDS = Object.freeze([
  'compositionOwnerSurfaceRef',
  'entrypointSurfaceRef',
  'evidenceBinding',
  'externalInterfaces',
  'implementationSurfaceRefs',
  'participatingSurfaceRefs',
  'realizationEntryId',
  'runtimeEdges',
  'scenarioRef',
  'terminalResult',
]);
const SURFACE_FIELDS = Object.freeze(['description', 'realizedScenarioRefs', 'surfaceId', 'surfaceKind']);
const EDGE_FIELDS = Object.freeze(['fromSurfaceRef', 'toSurfaceRef']);
const EVIDENCE_FIELDS = Object.freeze(['evidenceBindingRef', 'evidenceKind']);
const LINEAGE_FIELDS = Object.freeze(['baselineRef', 'traceRule']);
const TOP_FIELDS = Object.freeze(['lineage', 'realizationEntries', 'schemaVersion', 'surfaces']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Refuse with a deterministic path-qualified detail. */
function malformed(path: string, detail: string): ProductRefusal {
  return { ok: false, refused: true, reason: 'MALFORMED_PRODUCT', detail: `${path}: ${detail}` };
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], path: string): ProductRefusal | null {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unexpected.length > 0) {
    return malformed(path, `unexpected field(s) ${unexpected.join(', ')} (the draft field set is closed; a flat file list or AC decomposition is not a realization section)`);
  }
  const missing = allowed.filter((key) => !(key in value)).sort();
  if (missing.length > 0) {
    return malformed(path, `missing required field(s) ${missing.join(', ')}`);
  }
  return null;
}

function idStringOf(value: unknown, path: string): string | ProductRefusal {
  if (typeof value !== 'string' || value.length === 0) {
    return malformed(path, 'expected a non-empty string');
  }
  if (!ID_PATTERN.test(value)) {
    return malformed(path, `id "${value}" is outside the closed identity pattern ${ID_PATTERN.source}`);
  }
  return value;
}

function nonEmptyStringOf(value: unknown, path: string): string | ProductRefusal {
  if (typeof value !== 'string' || value.length === 0) {
    return malformed(path, 'expected a non-empty string');
  }
  return value;
}

function stringArrayOf(value: unknown, path: string, { idPattern }: { idPattern: boolean }): string[] | ProductRefusal {
  if (!Array.isArray(value)) {
    return malformed(path, 'expected an array');
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = idPattern ? idStringOf(value[index], `${path}[${index}]`) : nonEmptyStringOf(value[index], `${path}[${index}]`);
    if (typeof item !== 'string') return item;
    out.push(item);
  }
  return out;
}

function enumOf<T extends string>(value: unknown, vocabulary: readonly T[], path: string): T | ProductRefusal {
  if (typeof value !== 'string' || !vocabulary.includes(value as T)) {
    return malformed(path, `value ${JSON.stringify(value)} outside the closed vocabulary [${vocabulary.join(', ')}]`);
  }
  return value as T;
}

function parseSurface(raw: unknown, path: string): ArchitectureSurface | ProductRefusal {
  if (!isRecord(raw)) return malformed(path, 'expected a surface object');
  const fields = exactFields(raw, SURFACE_FIELDS, path);
  if (fields !== null) return fields;
  const surfaceId = idStringOf(raw.surfaceId, `${path}.surfaceId`);
  if (typeof surfaceId !== 'string') return surfaceId;
  const surfaceKind = enumOf<ArchitectureSurfaceKind>(raw.surfaceKind, ARCHITECTURE_SURFACE_KINDS, `${path}.surfaceKind`);
  if (typeof surfaceKind !== 'string') return surfaceKind;
  const description = nonEmptyStringOf(raw.description, `${path}.description`);
  if (typeof description !== 'string') return description;
  const realizedScenarioRefs = stringArrayOf(raw.realizedScenarioRefs, `${path}.realizedScenarioRefs`, { idPattern: true });
  if (!Array.isArray(realizedScenarioRefs)) return realizedScenarioRefs;
  return Object.freeze({
    surfaceId,
    surfaceKind,
    description,
    realizedScenarioRefs: Object.freeze(realizedScenarioRefs),
  });
}

function parseEntry(raw: unknown, path: string): RealizedScenarioEntry | ProductRefusal {
  if (!isRecord(raw)) return malformed(path, 'expected a realization entry object');
  const fields = exactFields(raw, ENTRY_FIELDS, path);
  if (fields !== null) return fields;
  const realizationEntryId = idStringOf(raw.realizationEntryId, `${path}.realizationEntryId`);
  if (typeof realizationEntryId !== 'string') return realizationEntryId;
  const scenarioRef = idStringOf(raw.scenarioRef, `${path}.scenarioRef`);
  if (typeof scenarioRef !== 'string') return scenarioRef;
  const entrypointSurfaceRef = idStringOf(raw.entrypointSurfaceRef, `${path}.entrypointSurfaceRef`);
  if (typeof entrypointSurfaceRef !== 'string') return entrypointSurfaceRef;
  const participatingSurfaceRefs = stringArrayOf(raw.participatingSurfaceRefs, `${path}.participatingSurfaceRefs`, { idPattern: true });
  if (!Array.isArray(participatingSurfaceRefs)) return participatingSurfaceRefs;
  if (participatingSurfaceRefs.length === 0) {
    return malformed(`${path}.participatingSurfaceRefs`, 'a realized scenario cites at least one participating surface');
  }
  if (!Array.isArray(raw.runtimeEdges) || raw.runtimeEdges.length === 0) {
    return malformed(`${path}.runtimeEdges`, 'a realized scenario declares at least one producer-consumer/runtime edge (a flat list of files is not proof of runtime connectivity)');
  }
  const runtimeEdges = [];
  for (let index = 0; index < raw.runtimeEdges.length; index += 1) {
    const edgePath = `${path}.runtimeEdges[${index}]`;
    const edge = raw.runtimeEdges[index];
    if (!isRecord(edge)) return malformed(edgePath, 'expected a runtime edge object');
    const edgeFields = exactFields(edge, EDGE_FIELDS, edgePath);
    if (edgeFields !== null) return edgeFields;
    const fromSurfaceRef = idStringOf(edge.fromSurfaceRef, `${edgePath}.fromSurfaceRef`);
    if (typeof fromSurfaceRef !== 'string') return fromSurfaceRef;
    const toSurfaceRef = idStringOf(edge.toSurfaceRef, `${edgePath}.toSurfaceRef`);
    if (typeof toSurfaceRef !== 'string') return toSurfaceRef;
    if (fromSurfaceRef === toSurfaceRef) {
      return malformed(edgePath, 'a producer-consumer edge needs two distinct surfaces');
    }
    runtimeEdges.push(Object.freeze({ fromSurfaceRef, toSurfaceRef }));
  }
  const externalInterfaces = stringArrayOf(raw.externalInterfaces, `${path}.externalInterfaces`, { idPattern: false });
  if (!Array.isArray(externalInterfaces)) return externalInterfaces;
  const implementationSurfaceRefs = stringArrayOf(raw.implementationSurfaceRefs, `${path}.implementationSurfaceRefs`, { idPattern: true });
  if (!Array.isArray(implementationSurfaceRefs)) return implementationSurfaceRefs;
  if (implementationSurfaceRefs.length === 0) {
    return malformed(`${path}.implementationSurfaceRefs`, 'a realized scenario cites at least one required implementation/integration surface');
  }
  const compositionOwnerSurfaceRef = idStringOf(raw.compositionOwnerSurfaceRef, `${path}.compositionOwnerSurfaceRef`);
  if (typeof compositionOwnerSurfaceRef !== 'string') return compositionOwnerSurfaceRef;
  const terminalResult = nonEmptyStringOf(raw.terminalResult, `${path}.terminalResult`);
  if (typeof terminalResult !== 'string') return terminalResult;
  const evidencePath = `${path}.evidenceBinding`;
  const evidence = raw.evidenceBinding;
  if (!isRecord(evidence)) return malformed(evidencePath, 'expected an evidence binding object');
  const evidenceFields = exactFields(evidence, EVIDENCE_FIELDS, evidencePath);
  if (evidenceFields !== null) return evidenceFields;
  const evidenceKind = enumOf<RealizationEvidenceKind>(evidence.evidenceKind, REALIZATION_EVIDENCE_KINDS, `${evidencePath}.evidenceKind`);
  if (typeof evidenceKind !== 'string') return evidenceKind;
  const evidenceBindingRef = idStringOf(evidence.evidenceBindingRef, `${evidencePath}.evidenceBindingRef`);
  if (typeof evidenceBindingRef !== 'string') return evidenceBindingRef;
  return Object.freeze({
    realizationEntryId,
    scenarioRef,
    entrypointSurfaceRef,
    participatingSurfaceRefs: Object.freeze(participatingSurfaceRefs),
    runtimeEdges: Object.freeze(runtimeEdges),
    externalInterfaces: Object.freeze(externalInterfaces),
    implementationSurfaceRefs: Object.freeze(implementationSurfaceRefs),
    compositionOwnerSurfaceRef,
    terminalResult,
    evidenceBinding: Object.freeze({ evidenceKind, evidenceBindingRef }),
  });
}

/**
 * Parse one SRS scenario-realization draft into the sealed section (the
 * canonical realizationDigest is computed here and never taken from input).
 */
export function parseSrsRealizationDraft(document: unknown): ParseOutcome {
  if (!isRecord(document)) {
    return malformed('draft', 'the realization draft is not an object');
  }
  const fields = exactFields(document, TOP_FIELDS, 'draft');
  if (fields !== null) return fields;
  if (document.schemaVersion !== SRS_REALIZATION_SECTION_KIND) {
    return malformed('draft.schemaVersion', `expected exactly ${SRS_REALIZATION_SECTION_KIND} (a draft without the mandatory realization section does not parse)`);
  }
  const lineage = document.lineage;
  if (!isRecord(lineage)) {
    return malformed('draft.lineage', 'expected a lineage object');
  }
  const lineageFields = exactFields(lineage, LINEAGE_FIELDS, 'draft.lineage');
  if (lineageFields !== null) return lineageFields;
  if (lineage.traceRule !== SRS_TRACE_RULE) {
    return malformed('draft.lineage.traceRule', `expected exactly ${SRS_TRACE_RULE} (the one trace rule of the SRS extension)`);
  }
  if (typeof lineage.baselineRef !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(lineage.baselineRef)) {
    return malformed('draft.lineage.baselineRef', 'expected the frozen WHAT baseline pin sha256:<64 hex>');
  }
  if (!Array.isArray(document.realizationEntries) || document.realizationEntries.length === 0) {
    return malformed('draft.realizationEntries', 'the section realizes at least one scenario');
  }
  const realizationEntries = [];
  for (let index = 0; index < document.realizationEntries.length; index += 1) {
    const entry = parseEntry(document.realizationEntries[index], `draft.realizationEntries[${index}]`);
    if ('refused' in entry) return entry;
    realizationEntries.push(entry);
  }
  if (!Array.isArray(document.surfaces) || document.surfaces.length === 0) {
    return malformed('draft.surfaces', 'the section declares at least one architecture surface');
  }
  const surfaces = [];
  for (let index = 0; index < document.surfaces.length; index += 1) {
    const surface = parseSurface(document.surfaces[index], `draft.surfaces[${index}]`);
    if ('refused' in surface) return surface;
    surfaces.push(surface);
  }
  const body = {
    schemaVersion: SRS_REALIZATION_SECTION_KIND,
    lineage: Object.freeze({ traceRule: SRS_TRACE_RULE, baselineRef: lineage.baselineRef }),
    realizationEntries: Object.freeze(realizationEntries),
    surfaces: Object.freeze(surfaces),
  };
  const section: SrsRealizationSection = Object.freeze({ ...body, realizationDigest: realizationDigestOf(body) });
  return { ok: true, section };
}
