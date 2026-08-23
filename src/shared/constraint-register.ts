/**
 * [E9 RESERVE — DO NOT REMOVE] This module is also the prerequisite of the
 * deferred recycle-run design (docs/architecture/RECYCLE-RUN-DESIGN.md,
 * architect-deferred 2026-08-19): the change-request hook, the capsule
 * MISS/HIT semantics and the product version row all consume this register
 * as the baseline of the first honest re-run. See docs/architecture/E9-RESERVE.md.
 *
 * Order Constraint Register — the single typed source for the three AC-drift
 * obligation networks (docs/architecture/AC-DRIFT-REMEDY-DESIGN.md).
 *
 * The order's requirements (docker compose up, TypeScript backend, a human
 * Chrome check…) die at ONE point when nothing counts them. This register is
 * the counted form: extracted at discovery time while the constraints are
 * still visible, assigned stable positional IDs (`ord-c-NNN`), and
 * content-addressed by digest.
 *
 * One register, three projections:
 *   - network 1 (reaction): the brief must dispose every ID
 *     (accepted | waived+reason) — enforced by the product-contract gate.
 *   - network 2 (structure): AC metadata + SRS §D2 must cover every
 *     non-waived ID — enforced by findContractGap + the SRS validators.
 *   - network 3 (execution): the certifier quotes the register as a
 *     verification warrant (warrantRef — types only in this branch).
 *
 * Provenance: the discovery worker serializes the constraints it observed
 * into `DiscoveryProposalPayload.order_constraints` (an LM step OUTSIDE every
 * gate — its quality is the discovery assessor's boundary, by design). The
 * kernel-side builder below is deterministic and fail-closed: it never
 * guesses, classifies, or re-reads prose. It only assigns stable identities
 * to already-typed rows and pins their content with a digest.
 *
 * Retro-compatibility (monotonicity): a proposal that carries no
 * `order_constraints` builds NO register — every downstream diff is empty and
 * every existing gate stays green. Old artifacts never break.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';
import { parseRepositoryFilePath } from './repository-scope.js';

/** Schema version of the legacy (frozen) serialized register. */
export const ORDER_CONSTRAINT_REGISTER_SCHEMA = 'factory.order-constraint-register.v1';

/**
 * ADR-090 (CC-IC-1): the additive v2 schema version. The closed source-class
 * vocabulary is PRESERVED unchanged; v2 adds the orthogonal per-entry `kind`
 * vocabulary, typed `measurability` on kind `quality` entries only, and
 * kernel-assigned `lifecycleSynthesis` declarations on injected entries.
 * v1 registers verify unchanged under the v1 schema version; the absence of
 * `kind` on v1 data is not a defect.
 */
export const ORDER_CONSTRAINT_REGISTER_SCHEMA_V2 = 'factory.order-constraint-register.v2';

export const ORDER_CONSTRAINT_REGISTER_SCHEMA_VERSIONS = [
  ORDER_CONSTRAINT_REGISTER_SCHEMA,
  ORDER_CONSTRAINT_REGISTER_SCHEMA_V2,
] as const;

/**
 * The closed class vocabulary. WHAT the order demands, not how to test it:
 *   - execution: a runnable check the order text commands (docker compose up).
 *   - material:  a static material property (TypeScript sources, files probe).
 *   - human:     a check only a human can perform (Chrome "feels" right) —
 *                never a silent pass; it surfaces as an outstanding check.
 */
export const ORDER_CONSTRAINT_CLASSES = ['execution', 'material', 'human'] as const;
export type OrderConstraintClass = (typeof ORDER_CONSTRAINT_CLASSES)[number];

/**
 * ADR-090 (CC-IC-1): the orthogonal per-entry kind vocabulary — HOW the
 * obligation is conserved. `open-question` is a KIND, never a class; the
 * class vocabulary above is NOT overloaded.
 *   - scope:         the ordinary reading of an order clause (v2 default for
 *                    a kind-less v1-shaped draft row under a NEW v2
 *                    settlement — kernel-side assignment, no guessing).
 *   - open-question: drafted 1:1 and positionally from the proposal payload
 *                    `unknowns` by the kernel (never worker-authored here).
 *   - mechanics:     business-rule/dynamics obligation; the RULE artifact is
 *                    the spec carrier and the typed binding is established at
 *                    disposition/binding time (CC-IC-3) — an at-Discovery
 *                    `mechanicsRef` is never required.
 *   - synthesis:     whole-product-synthesis obligation (injected).
 *   - ordered-smoke: ordered smoke obligation (injected).
 *   - quality:       qualitative/experience obligation — the ONLY kind that
 *                    carries a typed measurability binding.
 */
export const ORDER_CONSTRAINT_KINDS = [
  'scope',
  'open-question',
  'mechanics',
  'synthesis',
  'ordered-smoke',
  'quality',
] as const;
export type OrderConstraintKind = (typeof ORDER_CONSTRAINT_KINDS)[number];

/**
 * ADR-090 (CC-IC-1 focused repair): the kinds a proposal/worker DRAFT may
 * author. The reserved kinds are kernel-only authorities — `open-question` is
 * created only by the deterministic 1:1/positional unknown lifting, and
 * `synthesis`/`ordered-smoke` only by the declared, digest-pinned lifecycle
 * injection table. A draft row carrying a reserved kind is a typed red at the
 * submission boundary and again at the v2 builder — never a worker-forged
 * authority (a drafted open-question could otherwise stand in for a dropped
 * proposal unknown, and a drafted synthesis/ordered-smoke row would bypass
 * the injection table entirely).
 */
export const ORDER_CONSTRAINT_DRAFT_KINDS = [
  'scope',
  'mechanics',
  'quality',
] as const;
export type OrderConstraintDraftKind = (typeof ORDER_CONSTRAINT_DRAFT_KINDS)[number];

/** The kernel-only kinds (see ORDER_CONSTRAINT_DRAFT_KINDS). */
export const ORDER_CONSTRAINT_RESERVED_KINDS = [
  'open-question',
  'synthesis',
  'ordered-smoke',
] as const;

/** Kinds that only the declared lifecycle injection table may supply. */
export const ORDER_CONSTRAINT_INJECTED_KINDS = ['synthesis', 'ordered-smoke'] as const;

/**
 * ADR-090 (CC-IC-1): typed measurability binding — carried ONLY by
 * qualitative/experience (kind `quality`) entries. Either a measurable
 * interpretation reference, or an explicit typed deferral with a reason.
 */
export type OrderConstraintMeasurability =
  | { readonly state: 'measurable'; readonly interpretationRef: string }
  | { readonly state: 'deferred'; readonly reason: string };

/**
 * Kernel-assigned provenance on injected entries: the frozen lifecycle
 * classification that demanded the entry and the digest-pinned injection
 * table it was injected from. Never worker-declarable (a draft carrying
 * `lifecycle_synthesis` is a typed submission defect).
 */
export interface OrderConstraintLifecycleSynthesis {
  readonly classification: string;
  readonly injectionTableRef: string;
}

/**
 * ADR-090 (CC-IC-1): one injected entry payload of a declared, digest-pinned
 * lifecycle obligation injection table. Data declared beside the frozen
 * lifecycle classification (product-build-lifecycle.ts) — never engine
 * inference, never workshop-name branching, never browser/canvas specifics
 * that did not arrive through declared data.
 */
export interface OrderConstraintInjectionEntry {
  readonly class: OrderConstraintClass;
  readonly kind: (typeof ORDER_CONSTRAINT_INJECTED_KINDS)[number];
  readonly text: string;
  readonly evidence_ref: string;
}

export interface OrderConstraintInjectionTable {
  readonly schemaVersion: 'factory.lifecycle-obligation-injection.v1';
  /** The frozen lifecycle classification this table maps (e.g. runnable-local). */
  readonly classification: string;
  /** Declared table order is normative: synthesis first, then ordered-smoke. */
  readonly entries: readonly OrderConstraintInjectionEntry[];
}

/**
 * The worker-facing draft shape (snake_case — matches the proposal payload
 * convention the discovery worker already writes).
 */
export interface OrderConstraintDraft {
  readonly class: OrderConstraintClass;
  readonly text: string;
  readonly evidence_ref: string;
  /**
   * ADR-088 (CC-GAP-6): repository-relative files an EXECUTION-class
   * constraint declares as its product entrypoints (install -> start ->
   * accessible running product). Optional; execution-class only. The
   * Development planning gate requires every declared file to lie inside the
   * frozen change scopes of an item whose kernel-derived
   * `coveredConstraintIds` include this entry — a wide decoy item that merely
   * contains the file does not satisfy it. Absent on legacy registers (no
   * entrypoint obligation).
   */
  readonly entrypoint_files?: readonly string[];
  /**
   * ADR-090 (CC-IC-1): the orthogonal kind declaration. Optional: a kind-less
   * v1-shaped draft row under a NEW v2 settlement is defaulted
   * deterministically to kind `scope` (kernel-side assignment). When present
   * it MUST be one of the six closed kind values (ORDER_CONSTRAINT_KINDS) —
   * anything else is a typed error at the submission boundary and again here.
   */
  readonly kind?: OrderConstraintKind;
  /**
   * ADR-090 (CC-IC-1): typed measurability — ONLY kind `quality` entries may
   * carry it, and every kind `quality` entry MUST carry it (a measurable
   * interpretation or a typed deferral). Snake_case ingress form; the builder
   * canonicalizes to OrderConstraintMeasurability.
   */
  readonly measurability?:
    | { readonly state: 'measurable'; readonly interpretation_ref: string }
    | { readonly state: 'deferred'; readonly reason: string };
}

/** The canonical, ID-assigned register entry (kernel-assigned camelCase). */
export interface OrderConstraintEntry {
  /** Stable positional identity: ord-c-001, ord-c-002, ... */
  readonly id: string;
  readonly class: OrderConstraintClass;
  readonly text: string;
  readonly evidenceRef: string;
  /** @see OrderConstraintDraft.entrypoint_files — execution-class only. */
  readonly entrypointFiles?: readonly string[];
  /**
   * ADR-090 (CC-IC-1): the orthogonal kind. Present on every v2 register
   * entry; absent on frozen v1 data (absence on v1 is not a defect).
   */
  readonly kind?: OrderConstraintKind;
  /** @see OrderConstraintMeasurability — kind `quality` entries only. */
  readonly measurability?: OrderConstraintMeasurability;
  /** @see OrderConstraintLifecycleSynthesis — kernel-assigned on injected entries only. */
  readonly lifecycleSynthesis?: OrderConstraintLifecycleSynthesis;
}

/** The immutable, digest-pinned register. */
export interface OrderConstraintRegister {
  readonly schemaVersion: typeof ORDER_CONSTRAINT_REGISTER_SCHEMA
    | typeof ORDER_CONSTRAINT_REGISTER_SCHEMA_V2;
  readonly constraints: readonly OrderConstraintEntry[];
  /** SHA-256 over the canonical JSON of the constraint entries. */
  readonly registerDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deterministic SHA-256 over the canonical constraint entries. Deliberately
 * excludes the schemaVersion: two schema revisions over identical constraint
 * content are the same register (the ref is content-addressed, and the
 * content IS the constraints).
 */
function digestEntries(entries: readonly OrderConstraintEntry[]): string {
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function padIndex(index: number): string {
  return String(index + 1).padStart(3, '0');
}

/**
 * The closed canonical field vocabulary of a persisted register entry, per
 * schema version. The register digest pins EXACTLY this vocabulary: an extra
 * authority-bearing field on a stored row is silently DROPPED by the parse
 * (the digest is recomputed over the canonical subset), so the read-back
 * verifier must reject unknown fields instead of accepting a register whose
 * stored row carries content the digest never pinned (ADR-090 focused repair).
 */
const CANONICAL_REGISTER_ENTRY_FIELDS_V1: readonly string[] = [
  'id',
  'class',
  'text',
  'evidenceRef',
  'entrypointFiles',
];
const CANONICAL_REGISTER_ENTRY_FIELDS_V2: readonly string[] = [
  ...CANONICAL_REGISTER_ENTRY_FIELDS_V1,
  'kind',
  'measurability',
  'lifecycleSynthesis',
];

/**
 * The worker-facing snake_case ingress names that must NEVER ride a persisted
 * canonical register — the read-back boundary validates the camelCase shape
 * only, and a row carrying both spellings (or only the draft spelling beside
 * a recomputed digest) is a typed rejection, never a silently merged alias.
 */
const SNAKE_CASE_INGRESS_ENTRY_FIELDS: readonly string[] = [
  'evidence_ref',
  'entrypoint_files',
  'lifecycle_synthesis',
];

/**
 * Fail-closed unknown/alias field rejection for one stored record. A known
 * snake_case ingress alias gets the dedicated alias reason; any other field
 * outside the closed vocabulary is an unknown authority-bearing field.
 */
function rejectUnknownRecordFields(
  raw: Record<string, unknown>,
  options: {
    readonly label: string;
    readonly allowedFields: readonly string[];
    readonly aliasFields?: readonly string[];
    readonly aliasReason?: string;
  },
): void {
  const { label, allowedFields, aliasFields, aliasReason } = options;
  for (const field of Object.keys(raw)) {
    if (aliasFields?.includes(field)) {
      throw new Error(
        `${aliasReason ?? 'ORDER_CONSTRAINT_REGISTER_ALIAS_REJECTED'}: ${label} carries the `
        + `snake_case ingress field '${field}' — the read-back boundary validates the `
        + 'canonical camelCase shape only, never a silently merged alias',
      );
    }
    if (!allowedFields.includes(field)) {
      throw new Error(
        `ORDER_CONSTRAINT_REGISTER_FIELD_REJECTED: ${label} carries unknown field '${field}' — `
        + 'the register digest pins a closed entry vocabulary; extra authority-bearing '
        + 'fields are never silently dropped',
      );
    }
  }
}

/**
 * Validate one execution-class entrypoint declaration. Fail-closed: an
 * entrypoint is a repository-relative FILE path inside the product tree —
 * absolute paths, traversal and empty segments are typed errors, never
 * silently trimmed (ADR-088: the ownership conjunction must be mechanical).
 */
function parseEntrypointFiles(
  raw: unknown,
  index: number,
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `ORDER_CONSTRAINT_ENTRYPOINT_FILES_INVALID: order_constraints[${index}].entrypoint_files must be an array of file paths`,
    );
  }
  if (raw.length === 0) return undefined;
  const files = raw.map(file => {
    if (typeof file !== 'string') {
      throw new Error(
        `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files entries must be non-empty repository-relative file paths`,
      );
    }
    try {
      return parseRepositoryFilePath(file);
    } catch {
      throw new Error(
        `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files entry '${file}' is not a repository-relative file path`,
      );
    }
  });
  if (new Set(files).size !== files.length) {
    throw new Error(
      `ORDER_CONSTRAINT_ENTRYPOINT_FILE_INVALID: order_constraints[${index}].entrypoint_files declares duplicate paths`,
    );
  }
  return files;
}

function isOrderConstraintKind(value: unknown): value is OrderConstraintKind {
  return typeof value === 'string'
    && (ORDER_CONSTRAINT_KINDS as readonly string[]).includes(value);
}

/**
 * Validate one draft row's typed measurability declaration (snake_case ingress
 * form) and canonicalize it. Kind `quality` entries MUST carry one; entries of
 * any other kind MUST NOT.
 */
function parseMeasurability(
  raw: unknown,
  index: number,
  kind: OrderConstraintKind | undefined,
): OrderConstraintMeasurability | undefined {
  if (raw === undefined || raw === null) {
    if (kind === 'quality') {
      throw new Error(
        `ORDER_CONSTRAINT_MEASURABILITY_REQUIRED: order_constraints[${index}] of kind 'quality' `
        + 'must carry a measurability binding ({ measurable interpretation_ref } or { deferred reason })',
      );
    }
    return undefined;
  }
  if (kind !== 'quality') {
    throw new Error(
      `ORDER_CONSTRAINT_MEASURABILITY_KIND_INVALID: order_constraints[${index}].measurability may only be declared by kind 'quality' constraints (got kind '${kind ?? 'scope'}')`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(
      `ORDER_CONSTRAINT_MEASURABILITY_INVALID: order_constraints[${index}].measurability must be `
      + "{ state: 'measurable', interpretation_ref } or { state: 'deferred', reason }",
    );
  }
  if (raw['state'] === 'measurable') {
    const interpretationRef = raw['interpretation_ref'];
    if (typeof interpretationRef !== 'string' || interpretationRef.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_MEASURABILITY_INVALID: order_constraints[${index}].measurability of state 'measurable' requires a non-empty interpretation_ref`,
      );
    }
    return { state: 'measurable', interpretationRef };
  }
  if (raw['state'] === 'deferred') {
    const reason = raw['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_MEASURABILITY_INVALID: order_constraints[${index}].measurability of state 'deferred' requires a non-empty reason`,
      );
    }
    return { state: 'deferred', reason };
  }
  throw new Error(
    `ORDER_CONSTRAINT_MEASURABILITY_INVALID: order_constraints[${index}].measurability.state must be 'measurable' or 'deferred'`,
  );
}

interface DraftCoreOptions {
  /**
   * v2 semantics: kind defaults to `scope` when absent and the closed kind
   * vocabulary is enforced; measurability rides; drafts carrying
   * `lifecycle_synthesis` are rejected (kernel-assigned only).
   */
  readonly v2: boolean;
}

/**
 * Validate the CANONICAL (camelCase) measurability of a persisted v2 entry —
 * the read-back counterpart of parseMeasurability. A snake_case ingress form
 * arriving here is a typed rejection, never a silent reinterpretation.
 */
function parseCanonicalMeasurability(
  raw: unknown,
  index: number,
  kind: OrderConstraintKind | undefined,
): OrderConstraintMeasurability {
  if (kind !== 'quality') {
    throw new Error(
      `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} carries measurability on kind '${String(kind)}' (quality only)`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(
      `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} measurability must be { state, interpretationRef } or { state, reason }`,
    );
  }
  if (raw['state'] === 'measurable') {
    const interpretationRef = raw['interpretationRef'];
    if (typeof interpretationRef !== 'string' || interpretationRef.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} measurability of state 'measurable' requires a non-empty interpretationRef`,
      );
    }
    rejectUnknownRecordFields(raw, {
      label: `v2 register entry ord-c-${padIndex(index)} measurability`,
      allowedFields: ['state', 'interpretationRef'],
      aliasFields: ['interpretation_ref'],
      aliasReason: 'ORDER_CONSTRAINT_REGISTER_ALIAS_REJECTED',
    });
    return { state: 'measurable', interpretationRef };
  }
  if (raw['state'] === 'deferred') {
    const reason = raw['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} measurability of state 'deferred' requires a non-empty reason`,
      );
    }
    rejectUnknownRecordFields(raw, {
      label: `v2 register entry ord-c-${padIndex(index)} measurability`,
      allowedFields: ['state', 'reason'],
    });
    return { state: 'deferred', reason };
  }
  throw new Error(
    `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} measurability.state must be 'measurable' or 'deferred'`,
  );
}

/**
 * Shared fail-closed draft-row core used by BOTH schema builders. Deterministic,
 * no guessing, no prose rereading — it only assigns identities to typed rows.
 */
function buildDraftEntry(
  draft: Record<string, unknown>,
  index: number,
  options: DraftCoreOptions,
): OrderConstraintEntry {
  const constraintClass = draft['class'];
  if (
    typeof constraintClass !== 'string'
    || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(constraintClass)
  ) {
    throw new Error(
      `ORDER_CONSTRAINT_CLASS_INVALID: order_constraints[${index}].class must be one of `
      + `${ORDER_CONSTRAINT_CLASSES.join('|')}`,
    );
  }
  const text = draft['text'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(
      `ORDER_CONSTRAINT_TEXT_REQUIRED: order_constraints[${index}].text must be a non-empty string`,
    );
  }
  const evidenceRef = draft['evidence_ref'];
  if (typeof evidenceRef !== 'string' || evidenceRef.trim().length === 0) {
    throw new Error(
      `ORDER_CONSTRAINT_EVIDENCE_REF_REQUIRED: order_constraints[${index}].evidence_ref must be a non-empty string`,
    );
  }
  // ADR-088 (CC-GAP-6): entrypoint declarations are EXECUTION-class only.
  // A material/human constraint naming product files is a typed draft
  // defect at the submission boundary — never silently ignored.
  const entrypointFiles = parseEntrypointFiles(draft['entrypoint_files'], index);
  if (entrypointFiles && constraintClass !== 'execution') {
    throw new Error(
      `ORDER_CONSTRAINT_ENTRYPOINT_CLASS_INVALID: order_constraints[${index}].entrypoint_files may only be declared by execution-class constraints (got '${constraintClass}')`,
    );
  }
  const carriesKindField = draft['kind'] !== undefined && draft['kind'] !== null;
  const carriesMeasurability = draft['measurability'] !== undefined
    && draft['measurability'] !== null;
  const carriesLifecycleSynthesis = draft['lifecycle_synthesis'] !== undefined
    && draft['lifecycle_synthesis'] !== null;
  if (!options.v2) {
    // Frozen v1 semantics: v2 typed fields never ride a v1 register. A draft
    // carrying them through the v1 builder is a typed defect — silently
    // DROPPING typed conservation content is the exact loss class ADR-090
    // exists to close, so the v1 builder fails closed instead.
    if (carriesKindField) {
      throw new Error(
        `ORDER_CONSTRAINT_KIND_REQUIRES_V2: order_constraints[${index}].kind is v2 vocabulary; the v1 builder must never silently drop it`,
      );
    }
    if (carriesMeasurability) {
      throw new Error(
        `ORDER_CONSTRAINT_MEASURABILITY_REQUIRES_V2: order_constraints[${index}].measurability is v2 vocabulary; the v1 builder must never silently drop it`,
      );
    }
    if (carriesLifecycleSynthesis) {
      throw new Error(
        `ORDER_CONSTRAINT_LIFECYCLE_SYNTHESIS_KERNEL_ONLY: order_constraints[${index}].lifecycle_synthesis is kernel-assigned on injected entries only`,
      );
    }
    return {
      id: `ord-c-${padIndex(index)}`,
      class: constraintClass as OrderConstraintClass,
      text,
      evidenceRef,
      ...(entrypointFiles ? { entrypointFiles } : {}),
    };
  }
  // ADR-090 (CC-IC-1): a draft row carrying a `kind` MUST carry one of the six
  // closed values; a kind-less v1-shaped draft row under a NEW v2 settlement
  // is defaulted deterministically to kind `scope` (kernel-side assignment,
  // no guessing, no prose rereading).
  let kind: OrderConstraintKind;
  if (carriesKindField) {
    if (!isOrderConstraintKind(draft['kind'])) {
      throw new Error(
        `ORDER_CONSTRAINT_KIND_INVALID: order_constraints[${index}].kind must be one of `
        + `${ORDER_CONSTRAINT_KINDS.join('|')}`,
      );
    }
    kind = draft['kind'];
  } else {
    kind = 'scope';
  }
  // ADR-090 (CC-IC-1 focused repair): the reserved kinds are kernel-only
  // authorities. A draft may declare only scope|mechanics|quality —
  // open-question is drafted by the kernel from the payload unknowns, and
  // synthesis|ordered-smoke are injected from the declared, digest-pinned
  // lifecycle injection table. A reserved kind on a draft is a typed red,
  // never a silently accepted worker-forged authority.
  if ((ORDER_CONSTRAINT_RESERVED_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `ORDER_CONSTRAINT_KIND_RESERVED: order_constraints[${index}].kind '${kind}' is `
      + 'kernel-reserved (open-question is drafted 1:1 from the proposal unknowns; '
      + 'synthesis|ordered-smoke are injected from the declared lifecycle injection '
      + `table) — a draft may declare only ${ORDER_CONSTRAINT_DRAFT_KINDS.join('|')}`,
    );
  }
  if (carriesLifecycleSynthesis) {
    throw new Error(
      `ORDER_CONSTRAINT_LIFECYCLE_SYNTHESIS_KERNEL_ONLY: order_constraints[${index}].lifecycle_synthesis is kernel-assigned on injected entries only`,
    );
  }
  const measurability = parseMeasurability(
    carriesMeasurability ? draft['measurability'] : undefined,
    index,
    kind,
  );
  return {
    id: `ord-c-${padIndex(index)}`,
    class: constraintClass as OrderConstraintClass,
    text,
    evidenceRef,
    ...(entrypointFiles ? { entrypointFiles } : {}),
    kind,
    ...(measurability ? { measurability } : {}),
  };
}

/**
 * Build the register from typed drafts. Fail-closed on malformed input (a
 * malformed draft reaching this builder means the proposal validation
 * boundary was bypassed — never guess).
 *
 * Returns null when there are no drafts: "no register" is the honest
 * retro-compatible state, distinct from "empty register" which would pin a
 * digest over nothing.
 */
export function buildOrderConstraintRegister(drafts: unknown): OrderConstraintRegister | null {
  if (drafts === undefined || drafts === null) return null;
  if (!Array.isArray(drafts)) {
    throw new Error('ORDER_CONSTRAINT_DRAFTS_INVALID: order_constraints must be an array');
  }
  if (drafts.length === 0) return null;
  const entries: OrderConstraintEntry[] = [];
  for (const [index, draft] of drafts.entries()) {
    if (!isRecord(draft)) {
      throw new Error(`ORDER_CONSTRAINT_DRAFT_INVALID: order_constraints[${index}] must be an object`);
    }
    entries.push(buildDraftEntry(draft, index, { v2: false }));
  }
  return {
    schemaVersion: ORDER_CONSTRAINT_REGISTER_SCHEMA,
    constraints: entries,
    registerDigest: digestEntries(entries),
  };
}

/**
 * ADR-090 (CC-IC-1): build a v2 register at Discovery settlement. Additive
 * over the v1 builder:
 *
 *  - the closed kind vocabulary (a carried `kind` MUST be one of the six
 *    values; a kind-less draft is defaulted deterministically to `scope`);
 *  - typed measurability on kind `quality` entries ONLY (required there,
 *    forbidden elsewhere);
 *  - kind `open-question` entries drafted 1:1 and positionally from the
 *    proposal payload `unknowns` (kernel-side; text = the unknown string,
 *    evidenceRef = the payload field) — never worker-authored here;
 *  - declared-injection-table entries APPENDED AFTER the proposal-derived
 *    block in the declared table order (synthesis, then ordered-smoke) with
 *    kernel-assigned `lifecycleSynthesis` provenance — never interleaved
 *    among proposal-derived rows, so proposal-derived positional ids stay
 *    stable across injection-table revisions.
 *
 * Returns null only when NOTHING is counted (no drafts, no unknowns, no
 * injected entries): new v2 Factory Starts then carry the explicit typed
 * no-obligations attestation at settlement — never a silent null register.
 */
export function buildOrderConstraintRegisterV2(source: {
  drafts?: unknown;
  unknowns?: readonly unknown[];
  injections?: readonly {
    readonly table: OrderConstraintInjectionTable;
    /** Content-addressed ref of the declared table (cited by the settlement record). */
    readonly tableRef: string;
  }[];
}): OrderConstraintRegister | null {
  const { drafts, unknowns, injections } = source;
  if (drafts !== undefined && drafts !== null && !Array.isArray(drafts)) {
    throw new Error('ORDER_CONSTRAINT_DRAFTS_INVALID: order_constraints must be an array');
  }
  const draftRows = (drafts ?? []) as readonly unknown[];
  const unknownRows = unknowns ?? [];
  const entries: OrderConstraintEntry[] = [];
  for (const [index, draft] of draftRows.entries()) {
    if (!isRecord(draft)) {
      throw new Error(`ORDER_CONSTRAINT_DRAFT_INVALID: order_constraints[${index}] must be an object`);
    }
    entries.push(buildDraftEntry(draft, index, { v2: true }));
  }
  // Deterministic open-question lifting: 1:1 and positional from the payload
  // unknowns. The class vocabulary stays closed (execution|material|human);
  // `open-question` is a KIND. The kernel assigns `material` — the
  // conservative closed-vocabulary default for a question whose demand class
  // is genuinely unknown; the disposition/coverage networks own what happens
  // next (CC-IC-2), and no guessing happens here.
  for (const [index, unknown] of unknownRows.entries()) {
    if (typeof unknown !== 'string' || unknown.trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_UNKNOWN_INVALID: unknowns[${index}] must be a non-empty string`,
      );
    }
    entries.push({
      id: `ord-c-${padIndex(entries.length)}`,
      class: 'material',
      kind: 'open-question',
      text: unknown,
      evidenceRef: 'proposal.unknowns',
    });
  }
  // The injected block is APPENDED after the whole proposal-derived block, in
  // the declared table order — never interleaved among proposal-derived rows
  // (the verifier enforces the strict suffix layout; mutation m4a).
  // A table cannot be replayed twice: a second declared table for the SAME
  // classification (or the same tableRef twice) is a typed red, never a
  // silently duplicated injection block (ADR-090 focused repair).
  const seenInjectionClassifications = new Set<string>();
  const seenInjectionTableRefs = new Set<string>();
  for (const injection of injections ?? []) {
    validateInjectionTable(injection.table);
    const classification = injection.table.classification;
    if (seenInjectionClassifications.has(classification)) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_DUPLICATE: classification '${classification}' is `
        + 'mapped by more than one declared injection table — a table cannot be replayed twice',
      );
    }
    if (seenInjectionTableRefs.has(injection.tableRef)) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_DUPLICATE: injection table ref '${injection.tableRef}' `
        + 'is declared more than once — a table cannot be replayed twice',
      );
    }
    seenInjectionClassifications.add(classification);
    seenInjectionTableRefs.add(injection.tableRef);
    for (const entry of injection.table.entries) {
      entries.push({
        id: `ord-c-${padIndex(entries.length)}`,
        class: entry.class,
        kind: entry.kind,
        text: entry.text,
        evidenceRef: entry.evidence_ref,
        lifecycleSynthesis: {
          classification: injection.table.classification,
          injectionTableRef: injection.tableRef,
        },
      });
    }
  }
  if (entries.length === 0) return null;
  return {
    schemaVersion: ORDER_CONSTRAINT_REGISTER_SCHEMA_V2,
    constraints: entries,
    registerDigest: digestEntries(entries),
  };
}

/**
 * ADR-090 (CC-IC-1), mutation m1: prove the 1:1 positional conservation of
 * the proposal unknowns inside the built register. The builder drafts the
 * rows, so equality holds by construction; this assertion makes the mutation
 * (settlement dropping an unknown from the lift) a TYPED RED instead of a
 * silent under-count.
 */
export function assertOrderConstraintUnknownsLifted(
  register: OrderConstraintRegister | null,
  unknowns: readonly unknown[],
): void {
  const lifted = register === null
    ? []
    : register.constraints
      .filter(entry => entry.kind === 'open-question')
      .map(entry => entry.text);
  for (const [index, unknown] of unknowns.entries()) {
    if (lifted[index] !== unknown) {
      throw new Error(
        `ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED: proposal unknowns[${index}] ('${String(unknown)}') `
        + 'is absent from the register open-question entries — settlement red',
      );
    }
  }
  if (lifted.length !== unknowns.length) {
    throw new Error(
      `ORDER_CONSTRAINT_UNKNOWN_NOT_LIFTED: register carries ${lifted.length} open-question `
      + `entries for ${unknowns.length} proposal unknowns — settlement red`,
    );
  }
}

/** Fail-closed validation of a declared injection table (data, not engine inference). */
function validateInjectionTable(table: unknown): void {
  if (!isRecord(table)) {
    throw new Error('ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: table must be an object');
  }
  if (table['schemaVersion'] !== 'factory.lifecycle-obligation-injection.v1') {
    throw new Error(
      `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: unsupported schemaVersion '${String(table['schemaVersion'])}'`,
    );
  }
  if (typeof table['classification'] !== 'string' || (table['classification'] as string).trim().length === 0) {
    throw new Error('ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: classification must be a non-empty string');
  }
  const entries = table['entries'];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: table for '${String(table['classification'])}' declares no entries`,
    );
  }
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: entries[${index}] must be an object`);
    }
    if (
      typeof entry['class'] !== 'string'
      || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(entry['class'])
    ) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: entries[${index}].class must be one of `
        + `${ORDER_CONSTRAINT_CLASSES.join('|')}`,
      );
    }
    if (
      typeof entry['kind'] !== 'string'
      || !(ORDER_CONSTRAINT_INJECTED_KINDS as readonly string[]).includes(entry['kind'])
    ) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: entries[${index}].kind must be one of `
        + `${ORDER_CONSTRAINT_INJECTED_KINDS.join('|')}`,
      );
    }
    if (typeof entry['text'] !== 'string' || (entry['text'] as string).trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: entries[${index}].text must be a non-empty string`,
      );
    }
    if (typeof entry['evidence_ref'] !== 'string' || (entry['evidence_ref'] as string).trim().length === 0) {
      throw new Error(
        `ORDER_CONSTRAINT_INJECTION_TABLE_INVALID: entries[${index}].evidence_ref must be a non-empty string`,
      );
    }
  }
}

/**
 * Content-addressed reference for the register. The digest IS the identity:
 * the same constraints always produce the same ref, a changed constraint is a
 * different register (an honest miss on replay, per the design).
 */
export function orderConstraintRegisterRef(register: OrderConstraintRegister): string {
  return `constraint-register:${register.registerDigest}`;
}

/**
 * Validate an already-built register read back from persistence. Returns the
 * register when the shape and digest hold, null when the value carries no
 * register (retro-compat), and throws on a digest mismatch (tampering —
 * fail closed, never re-derive silently).
 *
 * CC-GAP-6 (ADR-088): the canonical entry shape (camelCase
 * `OrderConstraintEntry`, optionally carrying execution-class
 * `entrypointFiles`) is validated DIRECTLY here. The previous implementation
 * round-tripped the entries through the snake_case draft builder, which
 * would have rejected any canonical register (`evidence_ref` vs
 * `evidenceRef`) — latent because the function had no callers; it becomes
 * load-bearing the moment Development consumes persisted registers.
 *
 * ADR-090 (CC-IC-1): v1 registers verify unchanged under the v1 schema
 * version (absence of `kind` on v1 data is not a defect; PRESENCE of v2
 * typed fields on a v1 register is a typed defect — v1 semantics never carry
 * them). v2 registers enforce the closed kind vocabulary, the
 * quality-only/quality-required measurability binding, the kernel-only
 * lifecycleSynthesis provenance, and the NORMATIVE BLOCK LAYOUT: injected
 * entries (those carrying `lifecycleSynthesis`) form a strict SUFFIX —
 * injected rows interleaved among proposal-derived rows are a typed red
 * (mutation m4a), never a reinterpreted layout.
 */
export function verifyOrderConstraintRegister(value: unknown): OrderConstraintRegister | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register must be an object');
  }
  const schemaVersion = value.schemaVersion;
  if (
    typeof schemaVersion !== 'string'
    || !(ORDER_CONSTRAINT_REGISTER_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)
  ) {
    throw new Error(
      `ORDER_CONSTRAINT_REGISTER_INVALID: schemaVersion '${String(schemaVersion)}' is not one of `
      + `${ORDER_CONSTRAINT_REGISTER_SCHEMA_VERSIONS.join('|')}`,
    );
  }
  const isV2 = schemaVersion === ORDER_CONSTRAINT_REGISTER_SCHEMA_V2;
  // The stored register object itself carries a closed vocabulary: a forged
  // register with extra top-level fields is a typed red, never a partially
  // parsed authority (the digest covers only the constraints array).
  rejectUnknownRecordFields(value, {
    label: 'register',
    allowedFields: ['schemaVersion', 'constraints', 'registerDigest'],
  });
  const stored = value.constraints;
  if (!Array.isArray(stored) || stored.length === 0) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register carries no constraints');
  }
  const entries: OrderConstraintEntry[] = [];
  let injectedBlockStarted = false;
  stored.forEach((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entries must be objects');
    }
    const constraintClass = raw['class'];
    if (
      typeof constraintClass !== 'string'
      || !(ORDER_CONSTRAINT_CLASSES as readonly string[]).includes(constraintClass)
    ) {
      throw new Error(
        'ORDER_CONSTRAINT_REGISTER_INVALID: register entry class must be one of '
        + `${ORDER_CONSTRAINT_CLASSES.join('|')}`,
      );
    }
    if (typeof raw['text'] !== 'string' || raw['text'].trim().length === 0) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entry text must be a non-empty string');
    }
    if (typeof raw['evidenceRef'] !== 'string' || raw['evidenceRef'].trim().length === 0) {
      throw new Error('ORDER_CONSTRAINT_REGISTER_INVALID: register entry evidenceRef must be a non-empty string');
    }
    const entrypointFiles = parseEntrypointFiles(raw['entrypointFiles'], index);
    if (entrypointFiles && constraintClass !== 'execution') {
      throw new Error(
        'ORDER_CONSTRAINT_ENTRYPOINT_CLASS_INVALID: register entry entrypointFiles may only be declared by execution-class constraints',
      );
    }
    let kind: OrderConstraintKind | undefined;
    let measurability: OrderConstraintMeasurability | undefined;
    let lifecycleSynthesis: OrderConstraintLifecycleSynthesis | undefined;
    const carriesKind = raw['kind'] !== undefined && raw['kind'] !== null;
    const carriesMeasurability = raw['measurability'] !== undefined
      && raw['measurability'] !== null;
    const carriesLifecycleSynthesis = raw['lifecycleSynthesis'] !== undefined
      && raw['lifecycleSynthesis'] !== null;
    if (!isV2) {
      if (carriesKind || carriesMeasurability || carriesLifecycleSynthesis) {
        throw new Error(
          'ORDER_CONSTRAINT_REGISTER_INVALID: v1 register entries carry no v2 typed fields '
          + '(kind/measurability/lifecycleSynthesis)',
        );
      }
    } else {
      if (!isOrderConstraintKind(raw['kind'])) {
        throw new Error(
          'ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry kind must be one of '
          + `${ORDER_CONSTRAINT_KINDS.join('|')}`,
        );
      }
      kind = raw['kind'];
      if (carriesMeasurability) {
        measurability = parseCanonicalMeasurability(raw['measurability'], index, kind);
      } else if (kind === 'quality') {
        throw new Error(
          `ORDER_CONSTRAINT_MEASURABILITY_REQUIRED: v2 register entry ord-c-${padIndex(index)} of kind 'quality' must carry a measurability binding`,
        );
      }
      if (carriesLifecycleSynthesis) {
        const rawSynthesis = raw['lifecycleSynthesis'];
        if (
          !isRecord(rawSynthesis)
          || typeof rawSynthesis['classification'] !== 'string'
          || rawSynthesis['classification'].trim().length === 0
          || typeof rawSynthesis['injectionTableRef'] !== 'string'
          || rawSynthesis['injectionTableRef'].trim().length === 0
        ) {
          throw new Error(
            'ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry lifecycleSynthesis requires classification and injectionTableRef',
          );
        }
        rejectUnknownRecordFields(rawSynthesis, {
          label: `v2 register entry ord-c-${padIndex(index)} lifecycleSynthesis`,
          allowedFields: ['classification', 'injectionTableRef'],
          aliasFields: ['injection_table_ref'],
          aliasReason: 'ORDER_CONSTRAINT_REGISTER_ALIAS_REJECTED',
        });
        lifecycleSynthesis = {
          classification: rawSynthesis['classification'],
          injectionTableRef: rawSynthesis['injectionTableRef'],
        };
        injectedBlockStarted = true;
      } else if (injectedBlockStarted) {
        // Normative interleave order (ADR-090): proposal-derived entries
        // occupy ord-c-001..NNN and injected entries are APPENDED after them
        // — an injected row followed by a proposal-derived row is a typed
        // block-layout violation (mutation m4a), never a silent reorder.
        throw new Error(
          'ORDER_CONSTRAINT_REGISTER_BLOCK_LAYOUT_INVALID: injected entries must form a strict suffix after the proposal-derived block',
        );
      }
      // Provenance conjunction (ADR-090 focused repair): the injected kinds
      // exist ONLY through the declared, digest-pinned injection table, so a
      // v2 entry of kind synthesis|ordered-smoke MUST carry its
      // lifecycleSynthesis provenance, and lifecycleSynthesis may ride ONLY
      // injected-kind entries — a forged injected entry without table
      // provenance is a typed red at read-back, never a silently accepted
      // worker/manufactured obligation.
      const isInjectedKind = (ORDER_CONSTRAINT_INJECTED_KINDS as readonly string[])
        .includes(kind);
      if (isInjectedKind && !carriesLifecycleSynthesis) {
        throw new Error(
          `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} of kind `
          + `'${kind}' carries no lifecycleSynthesis provenance — injected kinds exist only `
          + 'through the declared, digest-pinned lifecycle injection table',
        );
      }
      if (!isInjectedKind && carriesLifecycleSynthesis) {
        throw new Error(
          `ORDER_CONSTRAINT_REGISTER_INVALID: v2 register entry ord-c-${padIndex(index)} of kind '${kind}' `
          + 'carries lifecycleSynthesis — the provenance rides injected synthesis|ordered-smoke entries only',
        );
      }
    }
    // Closed canonical entry vocabulary + snake_case ingress alias rejection
    // (ADR-090 focused repair), AFTER the required-field and version-branch
    // checks so the more specific typed reasons keep precedence: mixed
    // canonical/draft spellings and unknown authority-bearing fields are
    // typed reds — the parse must never silently drop stored content the
    // digest did not pin.
    rejectUnknownRecordFields(raw, {
      label: `register entry ord-c-${padIndex(index)}`,
      allowedFields: isV2
        ? CANONICAL_REGISTER_ENTRY_FIELDS_V2
        : CANONICAL_REGISTER_ENTRY_FIELDS_V1,
      aliasFields: SNAKE_CASE_INGRESS_ENTRY_FIELDS,
      aliasReason: 'ORDER_CONSTRAINT_REGISTER_ALIAS_REJECTED',
    });
    entries.push({
      id: `ord-c-${padIndex(index)}`,
      class: constraintClass as OrderConstraintClass,
      text: raw['text'],
      evidenceRef: raw['evidenceRef'],
      ...(entrypointFiles ? { entrypointFiles } : {}),
      ...(kind ? { kind } : {}),
      ...(measurability ? { measurability } : {}),
      ...(lifecycleSynthesis ? { lifecycleSynthesis } : {}),
    });
  });
  // IDs are positional content identities; the stored rows must round-trip them.
  if (stored.some((raw, index) =>
    !isRecord(raw) || raw['id'] !== entries[index]!.id)) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_ID_MISMATCH');
  }
  const register: OrderConstraintRegister = {
    schemaVersion: schemaVersion as OrderConstraintRegister['schemaVersion'],
    constraints: entries,
    registerDigest: digestEntries(entries),
  };
  const storedDigest = value.registerDigest;
  if (typeof storedDigest !== 'string' || storedDigest !== register.registerDigest) {
    throw new Error('ORDER_CONSTRAINT_REGISTER_DIGEST_MISMATCH');
  }
  return register;
}
