/**
 * workflow-kernel/context-envelope/receipt.ts - the ContextEnvelope layer
 * model and the immutable PromptAssemblyReceipt protocol (WP-18).
 *
 * Authority: docs/refactoring/event-kernel/specs/context-envelope-semantics.md
 * section 7 (frozen receipt grammar) and section 3.1 (what is counted), plus
 * docs/refactoring/event-kernel/specs/context-source-classification.json
 * (the closed five-class vocabulary; every layer below cites its CS id).
 *
 * Laws implemented here:
 *   - `decision` is exactly `admitted` | `refused` - NEVER `sent` (send/outcome
 *     evidence is the separate ProviderSendOutcome surface).
 *   - Layer digests are computed over the NORMALIZED layer bytes in the FIXED
 *     layer order (classification CS order), so receipts are comparable across
 *     machines and re-runs.
 *   - Receipts are append-only immutable evidence, sealed deep-frozen with a
 *     content-addressed digest. No production code may derive current counters
 *     from receipts (the CAS-fenced attempt counters are the authority).
 *   - `omissions` records only optional layers in the deterministic omission
 *     order; mandatory layers cannot appear there (their absence is a refused
 *     receipt with a typed mandatory-layer violation, enforced by the
 *     accountant).
 *   - `externalReferences` is the audit trail of the
 *     content-addressed-reference class: what traveled by reference instead of
 *     being recopied.
 *
 * PURITY: node:crypto (deterministic hashing) + the pure domain digest rule
 * (../domain/digest.js - the ONE canonical serialization of the kernel).
 */

import { canonicalJson, digestExcluding } from '../domain/digest.js';
import type { PromptAssemblyReceiptReference } from '../domain/types.js';

/* ------------------------------------------------------------------ */
/* The fixed layer order (classification CS-01..CS-13)                 */
/* ------------------------------------------------------------------ */

/**
 * The fixed envelope layer order = the classification order of
 * context-source-classification.json (CS-01..CS-13). Deterministic and
 * frozen: layer digests, token counts and omission order all follow it.
 */
export const ENVELOPE_LAYER_ORDER = [
  'initial-prompt-frame', // CS-01 mandatory-inline (static)
  'protocol-skill', // CS-02 mandatory-inline (static, digest == role-contract pin)
  'semantic-skill', // CS-03 mandatory-inline (static, digest == role-contract pin)
  'tool-schemas', // CS-04 mandatory-inline (static)
  'write-authority', // CS-05 mandatory-inline (static)
  'task-projection', // CS-06 bounded-summary (dynamic; grammar-enforced: CS-14)
  'workspace-summary', // CS-07 bounded-summary (dynamic; grammar-enforced: CS-16)
  'recovery-history', // CS-08 bounded-summary (recovery)
  'hook-context', // CS-09 bounded-summary (dynamic)
  'tool-results', // CS-10 bounded-tool-result (toolResult)
  'large-product-refs', // CS-11 content-addressed-reference
  'desk-reference', // CS-12 content-addressed-reference
  'patch-pointer', // CS-13 content-addressed-reference
] as const;

export type LayerName = (typeof ENVELOPE_LAYER_ORDER)[number];

/** The per-layer budget class (context-envelope-semantics section 3.2). */
export type LayerBudgetClass = 'static' | 'dynamic' | 'recovery' | 'toolResult' | 'reference';

/** The closed layer registry: order, class, mandatoriness, grammar enforcement. */
export interface LayerRule {
  readonly layer: LayerName;
  readonly classificationId: string;
  readonly budgetClass: LayerBudgetClass;
  /** mandatory-inline members can never be omitted (noSilentOmission). */
  readonly mandatory: boolean;
  /** Grammar-enforced bounded transport form (CS-14/CS-16 detector). */
  readonly requiresBoundedTransportForm: boolean;
}

export const LAYER_RULES: readonly LayerRule[] = [
  { layer: 'initial-prompt-frame', classificationId: 'CS-01', budgetClass: 'static', mandatory: true, requiresBoundedTransportForm: false },
  { layer: 'protocol-skill', classificationId: 'CS-02', budgetClass: 'static', mandatory: true, requiresBoundedTransportForm: false },
  { layer: 'semantic-skill', classificationId: 'CS-03', budgetClass: 'static', mandatory: true, requiresBoundedTransportForm: false },
  { layer: 'tool-schemas', classificationId: 'CS-04', budgetClass: 'static', mandatory: true, requiresBoundedTransportForm: false },
  { layer: 'write-authority', classificationId: 'CS-05', budgetClass: 'static', mandatory: true, requiresBoundedTransportForm: false },
  { layer: 'task-projection', classificationId: 'CS-06', budgetClass: 'dynamic', mandatory: false, requiresBoundedTransportForm: true },
  { layer: 'workspace-summary', classificationId: 'CS-07', budgetClass: 'dynamic', mandatory: false, requiresBoundedTransportForm: true },
  { layer: 'recovery-history', classificationId: 'CS-08', budgetClass: 'recovery', mandatory: false, requiresBoundedTransportForm: false },
  { layer: 'hook-context', classificationId: 'CS-09', budgetClass: 'dynamic', mandatory: false, requiresBoundedTransportForm: false },
  { layer: 'tool-results', classificationId: 'CS-10', budgetClass: 'toolResult', mandatory: false, requiresBoundedTransportForm: false },
  { layer: 'large-product-refs', classificationId: 'CS-11', budgetClass: 'reference', mandatory: false, requiresBoundedTransportForm: false },
  { layer: 'desk-reference', classificationId: 'CS-12', budgetClass: 'reference', mandatory: false, requiresBoundedTransportForm: false },
  { layer: 'patch-pointer', classificationId: 'CS-13', budgetClass: 'reference', mandatory: false, requiresBoundedTransportForm: false },
];

const LAYER_INDEX: ReadonlyMap<string, LayerRule> = new Map(LAYER_RULES.map((rule) => [rule.layer, rule]));

export function layerRule(layer: string): LayerRule | undefined {
  return LAYER_INDEX.get(layer);
}

/** The deterministic optional-layer omission order (grammar: fixed order). */
export function optionalLayerOmissionOrder(): readonly LayerName[] {
  return LAYER_RULES.filter((rule) => !rule.mandatory).map((rule) => rule.layer);
}

/* ------------------------------------------------------------------ */
/* Envelope value types                                                */
/* ------------------------------------------------------------------ */

/**
 * A content-addressed reference traveling instead of raw material
 * (classification CS-11..CS-13): content:// ref + digest plus the bounded
 * pointer/summary that stays inline. Raw bytes are never recopied.
 */
export interface ExternalReference {
  readonly ref: string;
  readonly digest: string;
  readonly summary: string;
}

/**
 * One envelope layer: the exact normalized inline bytes the request carries
 * for this layer, plus the content-addressed references it travels with.
 */
export interface EnvelopeLayer {
  readonly layer: LayerName;
  /** Normalized layer bytes (fixed serialization; no timestamps/paths). */
  readonly content: string;
  readonly externalReferences?: readonly ExternalReference[];
  /**
   * CS-14/CS-16 detector input: grammar-enforced layers (task-projection,
   * workspace-summary) must declare the bounded transport form. A layer
   * assembled as the raw mutable row / wholesale recopy cannot truthfully
   * declare it; admission refuses unmarked or untruthful forms.
   */
  readonly boundedTransportForm?: boolean;
}

/** The assembled context envelope at the pre-send boundary. */
export interface ContextEnvelope {
  readonly layers: readonly EnvelopeLayer[];
}

/* ------------------------------------------------------------------ */
/* Route pin + counter identity (shared pins of the receipt grammar)   */
/* ------------------------------------------------------------------ */

/** The exact (provider, model, version) triple pinned on ActivityAttempt. */
export interface ProviderRoutePin {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
}

/** The pinned token-counter contract (prompt-budget-profile $defs/TokenCounterRef). */
export interface CounterIdentityPin {
  readonly name: string;
  readonly protocolVersion: string;
  readonly implementationRef: string;
  readonly digest: string;
  readonly digestAlgorithm: 'sha256';
  readonly encoding: string;
}

/* ------------------------------------------------------------------ */
/* Receipt grammar (context-envelope-semantics section 7, frozen)      */
/* ------------------------------------------------------------------ */

export type AdmissionDecision = 'admitted' | 'refused';

/** The closed typed violation set of the admission boundary. */
export type ContextViolation =
  | 'PROFILE_NOT_POSITIVE_FINITE'
  | 'PROFILE_FORMULA_INCOHERENT'
  | 'TOKEN_COUNTER_MISMATCH'
  | 'LIMIT_TABLE_DIGEST_MISMATCH'
  | 'PROVIDER_LIMIT_UNSUPPORTED'
  | 'PROVIDER_LIMIT_DISAGREEMENT'
  | 'UNCLASSIFIED_LAYER'
  | 'MANDATORY_LAYER_MISSING'
  | 'FORBIDDEN_DUPLICATION'
  | 'MAX_STATIC_TOKENS_EXCEEDED'
  | 'MAX_DYNAMIC_TOKENS_EXCEEDED'
  | 'MAX_RECOVERY_TOKENS_EXCEEDED'
  | 'MAX_TOOL_RESULT_TOKENS_EXCEEDED'
  | 'MAX_TOTAL_INPUT_TOKENS_EXCEEDED'
  | 'CUMULATIVE_SESSION_BUDGET_EXCEEDED'
  | 'MAX_PROVIDER_REQUESTS_EXCEEDED'
  | 'MAX_PROMPT_BYTES_EXCEEDED';

/** One per-limit check recorded in the receipt ({limit, value, pass}). */
export interface LimitCheck {
  readonly limit: string;
  readonly value: number;
  readonly pass: boolean;
}

/** One immutable per-provider-request admission receipt (grammar section 7). */
export interface PromptAssemblyReceipt {
  /** exactly `admitted` | `refused` - NEVER `sent`. */
  readonly decision: AdmissionDecision;
  readonly attemptRef: string;
  /** Assigned on admission; on refusal the ordinal the rejected envelope targeted (counters unchanged). */
  readonly requestOrdinal: number;
  /** The CAS revision the decision was made under. */
  readonly contextRevision: number;
  readonly profileRef: string;
  readonly profileDigest: string;
  /** The counter pin actually used (section 6; empty counts when it mismatched). */
  readonly counterIdentity: CounterIdentityPin;
  readonly limitTableRef: string;
  readonly limitTableDigest: string;
  readonly providerRoutePin: ProviderRoutePin;
  /** Present layer names in the fixed order (parallel to the two arrays below). */
  readonly layerNames: readonly LayerName[];
  /** NORMALIZED per-layer digests, fixed layer order. */
  readonly layerDigests: readonly string[];
  /** Per-layer counts from the pinned counter (parallel to layerNames). */
  readonly layerTokenCounts: readonly number[];
  readonly requestInputTokens: number;
  readonly serializedRequestBytes: number;
  /** Counter value after this decision (unchanged on refusal). */
  readonly cumulativeInputTokensAfter: number;
  readonly limitChecks: readonly LimitCheck[];
  /** Deterministic optional-layer omission order (admitted receipts). */
  readonly omissions: readonly LayerName[];
  /** content:// refs + digests traveling instead of raw material. */
  readonly externalReferences: readonly ExternalReference[];
  /** Refused only: the typed limit that was exceeded / failure class. */
  readonly violation?: ContextViolation;
  readonly violationDetail?: string;
  /** Refused only: digest of the rejected envelope. */
  readonly rejectedEnvelopeDigest?: string;
  readonly receiptRef: string;
  readonly digest: string;
}

/** Fields of the receipt the producer supplies; digest/ref are derived. */
export type PromptAssemblyReceiptFields = Omit<PromptAssemblyReceipt, 'receiptRef' | 'digest'>;

/* ------------------------------------------------------------------ */
/* Normalization, digests, serialization                               */
/* ------------------------------------------------------------------ */

/**
 * Normalizes envelope layers into the FIXED layer order. Fails closed on any
 * layer outside the closed registry (an unclassified source is a spec
 * violation, not a default) and on duplicate layers.
 */
export function normalizeEnvelopeLayers(
  layers: readonly EnvelopeLayer[],
): { readonly ok: true; readonly ordered: readonly EnvelopeLayer[] } | { readonly ok: false; readonly violation: 'UNCLASSIFIED_LAYER'; readonly detail: string } {
  const byName = new Map<string, EnvelopeLayer>();
  for (const layer of layers) {
    if (!LAYER_INDEX.has(layer.layer)) {
      return {
        ok: false,
        violation: 'UNCLASSIFIED_LAYER',
        detail: `layer "${layer.layer}" is not in the closed classification registry (context-source-classification.json CS-01..CS-13); an unclassified context source is a spec violation, not a default`,
      };
    }
    if (byName.has(layer.layer)) {
      return {
        ok: false,
        violation: 'UNCLASSIFIED_LAYER',
        detail: `layer "${layer.layer}" appears twice in the envelope; one layer, one slot`,
      };
    }
    byName.set(layer.layer, layer);
  }
  const ordered = LAYER_RULES.filter((rule) => byName.has(rule.layer)).map((rule) => byName.get(rule.layer) as EnvelopeLayer);
  return { ok: true, ordered };
}

/** The normalized layer bytes digests over the fixed serialization. */
export function layerDigestOf(layer: EnvelopeLayer): string {
  return 'sha256:' + digestExcluding(layer, ['layer']);
}

/**
 * The deterministic serialization of the assembled request: the canonical
 * JSON of [{layer, content}] in the fixed layer order. The transport must
 * serialize exactly these bytes; the accountant counts exactly these bytes.
 */
export function serializeEnvelopeLayers(orderedLayers: readonly EnvelopeLayer[]): string {
  return canonicalJson(orderedLayers.map((layer) => ({ layer: layer.layer, content: layer.content })));
}

/**
 * The envelope digest: sha256 over the canonical layer-digest list in the
 * fixed order. Used for refused receipts (rejectedEnvelopeDigest) and to bind
 * the provider-send obligation to the exact admitted envelope.
 */
export function envelopeDigestOf(orderedLayers: readonly EnvelopeLayer[]): string {
  return 'sha256:' + digestExcluding({ digests: orderedLayers.map(layerDigestOf) }, []);
}

/** The content-addressed references of the whole envelope (audit trail). */
export function externalReferencesOf(orderedLayers: readonly EnvelopeLayer[]): readonly ExternalReference[] {
  const refs: ExternalReference[] = [];
  for (const layer of orderedLayers) {
    if (layer.externalReferences) refs.push(...layer.externalReferences);
  }
  return refs;
}

/* ------------------------------------------------------------------ */
/* Sealing (immutability + content addressing)                         */
/* ------------------------------------------------------------------ */

/** Deep-freezes a value (arrays and plain objects). */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The receipt digest rule: canonical JSON minus the self-referencing keys. */
export function receiptDigestOf(fields: PromptAssemblyReceiptFields): string {
  return digestExcluding(fields as unknown as object, ['receiptRef', 'digest']);
}

/**
 * Seals a receipt: validates the closed decision vocabulary (`sent` is
 * structurally rejected), computes the content-addressed digest and ref, and
 * returns a deeply frozen immutable value. Returned receipts are append-only
 * evidence: any mutation attempt throws (frozen in strict mode).
 */
export function sealReceipt(fields: PromptAssemblyReceiptFields): PromptAssemblyReceipt {
  if (fields.decision !== 'admitted' && fields.decision !== 'refused') {
    throw new Error(`UNIVERSE_VIOLATION: PromptAssemblyReceipt.decision must be admitted|refused, never "${String(fields.decision)}" (send/outcome evidence is the separate ProviderSendOutcome)`);
  }
  if (fields.decision === 'admitted' && (fields.violation !== undefined || fields.rejectedEnvelopeDigest !== undefined)) {
    throw new Error('UNIVERSE_VIOLATION: an admitted receipt carries no violation and no rejectedEnvelopeDigest');
  }
  if (fields.decision === 'refused' && (fields.violation === undefined || fields.rejectedEnvelopeDigest === undefined)) {
    throw new Error('UNIVERSE_VIOLATION: a refused receipt must record the typed violation and the rejected-envelope digest');
  }
  for (const omitted of fields.omissions) {
    const rule = LAYER_INDEX.get(omitted);
    if (rule === undefined || rule.mandatory) {
      throw new Error(`UNIVERSE_VIOLATION: omissions may contain only optional layers; "${omitted}" is mandatory or unknown`);
    }
  }
  const digest = receiptDigestOf(fields);
  const receipt: PromptAssemblyReceipt = {
    ...fields,
    digest,
    receiptRef: `sha256:${digest}`,
  };
  return deepFreeze(receipt);
}

/** The domain reference of a sealed receipt (what ActivityAttempt evidence carries). */
export function toReceiptReference(receipt: PromptAssemblyReceipt): PromptAssemblyReceiptReference {
  return {
    receiptRef: receipt.receiptRef,
    admission: receipt.decision,
    requestOrdinal: receipt.requestOrdinal,
    expectedContextRevision: receipt.contextRevision,
    digest: receipt.digest,
  };
}
