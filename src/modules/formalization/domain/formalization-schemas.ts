/** Formalization boundary schemas. */

export {
  FORMALIZATION_CASE_SCHEMA,
} from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import { FORMALIZATION_CASE_SCHEMA } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
import {
  ORDER_CONSTRAINT_REGISTER_SCHEMA_V2,
  buildOrderConstraintRegister,
  orderConstraintRegisterRef,
  verifyOrderConstraintRegister,
  type OrderConstraintClass,
  type OrderConstraintRegister,
} from '../../../shared/constraint-register.js';
/** The v2 register schema version constant (re-exported for the freeze seam). */
export { ORDER_CONSTRAINT_REGISTER_SCHEMA_V2 };
import { sha256Hex } from '../../../shared/canonical-json.js';
export const SOLUTION_CONTRACT_CERTIFICATE_SCHEMA = 'factory.solution-contract-certificate.v1';
export const FORMALIZATION_SETTLEMENT_INPUT_SCHEMA = 'factory.formalization-settlement-input.v1';
export const FORMALIZATION_PRODUCT_BUNDLE_SCHEMA = 'factory.formalization-product-bundle.v1';
export const FORMALIZATION_USE_CASE_BUNDLE_SCHEMA = 'factory.formalization-use-case-bundle.v1';
export const FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA = 'factory.formalization-acceptance-bundle.v1';
export const FORMALIZATION_RECONCILIATION_SCHEMA = 'factory.formalization-reconciliation-report.v1';
export const FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA = 'factory.formalization-architecture-bundle.v1';
export const ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA = 'factory.acceptance-baseline-snapshot.v1';
export const FORMALIZATION_SRS_SCHEMA = 'factory.srs.v1';
export const FORMALIZATION_CERTIFICATE_SCHEMA_VERSION =
  'factory.solution-contract-certificate.generic.v1';

/**
 * AC-drift remedy: the constraint register binding carried on the
 * FormalizationCase. The register itself is owned by discovery settlement
 * (digest-pinned into its certificate); this binding is the SAME register
 * resolved through the case's sealed discoveryProposalPayload — one source,
 * deterministic rebuild, never a second authority (ADR-053).
 */
export interface FormalizationConstraintRegisterBinding {
  /** Content-addressed register ref: constraint-register:<digest>. */
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly constraintRegister: OrderConstraintRegister;
}

export interface FormalizationCase {
  schemaVersion: typeof FORMALIZATION_CASE_SCHEMA;
  discoveryEpicId: number;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  discoveryOutcome: string;
  /** Accepted semantic WHAT from Discovery; certificate alone is insufficient. */
  discoveryProposalRef: string;
  discoveryProposalHash: string;
  discoveryProposalPayload: Readonly<Record<string, unknown>>;
  /** Original request retained as an independent information-conservation anchor. */
  initiativeSubject: string;
  initiatedBy: string;
  /**
   * Optional because the register is DERIVED, not handoff-authored: the
   * lifecycle mapping already carries the full discoveryProposalPayload, and
   * the strict JSON-path resolver cannot map optional source paths. Resolve
   * via resolveFormalizationCaseConstraintRegister — the identical pure
   * builder discovery settlement used.
   */
  constraintRegister?: FormalizationConstraintRegisterBinding;
}

/**
 * Deterministically resolve the constraint register binding from a
 * FormalizationCase's sealed discoveryProposalPayload. Same input → same
 * binding (positional IDs + content digest), so every consumer (the A1
 * disposition gate, the A2 coverage diffs, the A3 warrantRef) sees exactly
 * one register. Returns null when the proposal carried no constraints
 * (retro-compat: empty downstream diffs, existing gates stay green).
 */
export function resolveFormalizationCaseConstraintRegister(
  formalizationCase: FormalizationCase,
): FormalizationConstraintRegisterBinding | null {
  if (formalizationCase.constraintRegister) {
    return formalizationCase.constraintRegister;
  }
  const payload = formalizationCase.discoveryProposalPayload as {
    order_constraints?: unknown;
  };
  const register = buildOrderConstraintRegister(payload?.order_constraints);
  if (!register) return null;
  return {
    constraintRegisterRef: orderConstraintRegisterRef(register),
    constraintRegisterDigest: register.registerDigest,
    constraintRegister: register,
  };
}

/**
 * ADR-090 (CC-IC-1): the typed no-obligations attestation a NEW v2 Factory
 * Start carries when its discovery certificate counted nothing. A v2 case
 * with NEITHER a certificate binding NOR this attestation is a typed red at
 * case admission — never a silent null/rebuild.
 */
export interface FormalizationNoObligationsAttestation {
  readonly schemaVersion: string;
  readonly attestationDigest: string;
}

/** The resolved register authority of a FormalizationCase (one or the other, never both). */
export interface FormalizationCaseRegisterAuthority {
  readonly binding: FormalizationConstraintRegisterBinding | null;
  readonly attestation: FormalizationNoObligationsAttestation | null;
}

/**
 * ADR-090 (CC-IC-1), mutation m6b: resolve the case's ONE register authority
 * from the DISCOVERY CERTIFICATE payload — the v2 source of truth — never a
 * rebuild from proposal text/payload.
 *
 * Resolution order:
 *   1. the certificate carries a built register (v1 or v2): verify it through
 *      the repaired read-back verifier and use exactly that binding. A case
 *      whose explicit `constraintRegister` binding DIVERGES from the
 *      certificate register (e.g. a proposal-payload rebuild) is a typed red
 *      — the fallback must never be the supplying path for a v2 case;
 *   2. the certificate carries the typed no-obligations attestation: the
 *      lawful null (binding null, attestation pinned);
 *   3. neither (frozen legacy v1 certificates): the deterministic
 *      `resolveFormalizationCaseConstraintRegister` rebuild fallback —
 *      frozen-legacy-v1-only, bit-identical for v1 data.
 */
export function resolveFormalizationCaseRegisterAuthority(
  formalizationCase: FormalizationCase,
  discoveryCertificatePayload: unknown,
): FormalizationCaseRegisterAuthority {
  if (
    !discoveryCertificatePayload
    || typeof discoveryCertificatePayload !== 'object'
    || Array.isArray(discoveryCertificatePayload)
  ) {
    throw new Error(
      'FORMALIZATION_DISCOVERY_CERTIFICATE_PAYLOAD_INVALID: the discovery certificate payload must be an object',
    );
  }
  const certificate = discoveryCertificatePayload as Record<string, unknown>;
  const certificateRegister = certificate['constraintRegister'] === undefined
    || certificate['constraintRegister'] === null
    ? null
    : verifyOrderConstraintRegister(certificate['constraintRegister']);
  if (certificateRegister !== null) {
    if (
      formalizationCase.constraintRegister
      && formalizationCase.constraintRegister.constraintRegisterDigest
        !== certificateRegister.registerDigest
    ) {
      throw new Error(
        'FORMALIZATION_REGISTER_BINDING_BYPASSED: the case register binding diverges from '
        + 'the discovery certificate register — the certificate binding is the v2 source of '
        + 'truth, never a proposal-payload rebuild',
      );
    }
    return {
      binding: {
        constraintRegisterRef: orderConstraintRegisterRef(certificateRegister),
        constraintRegisterDigest: certificateRegister.registerDigest,
        constraintRegister: certificateRegister,
      },
      attestation: null,
    };
  }
  const rawAttestation = certificate['noObligationsAttestation'];
  if (rawAttestation !== undefined && rawAttestation !== null) {
    if (
      !rawAttestation
      || typeof rawAttestation !== 'object'
      || Array.isArray(rawAttestation)
      || (rawAttestation as Record<string, unknown>)['schemaVersion']
        !== 'factory.discovery-no-obligations.v1'
      || typeof (rawAttestation as Record<string, unknown>)['attestationDigest'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(
        (rawAttestation as Record<string, unknown>)['attestationDigest'] as string,
      )
    ) {
      throw new Error(
        'FORMALIZATION_NO_OBLIGATIONS_ATTESTATION_INVALID: malformed typed no-obligations attestation',
      );
    }
    return {
      binding: null,
      attestation: {
        schemaVersion: 'factory.discovery-no-obligations.v1',
        attestationDigest: (rawAttestation as Record<string, unknown>)['attestationDigest'] as string,
      },
    };
  }
  // Frozen legacy v1 certificate (no register, no attestation): the
  // deterministic rebuild fallback stays the supplier — bit-identical for
  // v1 data. A kind-carrying (v2-shaped) proposal payload is rejected by the
  // v1 builder rather than silently dropped.
  return { binding: resolveFormalizationCaseConstraintRegister(formalizationCase), attestation: null };
}

/**
 * ADR-090 (CC-IC-1), mutation m7: the case identity a verification warrant is
 * cross-bound to. Register+dispositions self-consistency alone is not
 * identity — the warrant names the exact certificate/case digests it was
 * issued against, so a silently re-targeted warrant is a typed red.
 */
export function formalizationCaseIdentityDigest(formalizationCase: FormalizationCase): string {
  return sha256Hex({
    discoveryEpicId: formalizationCase.discoveryEpicId,
    formalizationEpicId: formalizationCase.formalizationEpicId,
    discoveryCertificateRef: formalizationCase.discoveryCertificateRef,
    discoveryCertificateHash: formalizationCase.discoveryCertificateHash,
    discoveryProposalRef: formalizationCase.discoveryProposalRef,
    discoveryProposalHash: formalizationCase.discoveryProposalHash,
    initiativeSubject: formalizationCase.initiativeSubject,
  });
}

/** Structural cross-bind view of a VerificationWarrantRef (no cross-module domain import). */
export interface WarrantCrossBindView {
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly dispositionsDigest: string;
  readonly dispositions: Readonly<Record<string, unknown>>;
  readonly discoveryCertificateHash?: string;
  readonly formalizationCaseDigest?: string;
}

export interface WarrantCrossBindExpectation {
  readonly discoveryCertificateHash: string;
  readonly formalizationCaseDigest: string;
}

/**
 * ADR-090 (CC-IC-1), mutation m7: verify a warrant's certificate/case
 * cross-bind. A warrant re-targeted at a different certificate or case digest
 * than the one it was issued against is a typed red — never a silent
 * re-issue. The issuing settlement verifies at construction; consumers of the
 * warrant (the readiness manifest contract and future warrant phases) verify
 * the same fields.
 */
export function verifyWarrantCrossBind(
  warrant: WarrantCrossBindView,
  expected: WarrantCrossBindExpectation,
): void {
  if (
    warrant.discoveryCertificateHash !== expected.discoveryCertificateHash
    || warrant.formalizationCaseDigest !== expected.formalizationCaseDigest
  ) {
    throw new Error(
      'WARRANT_CROSS_BIND_MISMATCH: the warrantRef cross-bind does not match the '
      + 'certificate/case it was presented against '
      + `(warrant certificate ${String(warrant.discoveryCertificateHash)} / case `
      + `${String(warrant.formalizationCaseDigest)})`,
    );
  }
}

export interface SolutionContractBundle {
  schemaVersion: typeof SOLUTION_CONTRACT_CERTIFICATE_SCHEMA;
  formalizationEpicId: number;
  prdArtifactId: number | null;
  frArtifactIds: readonly number[];
  nfrArtifactIds: readonly number[];
  ruleArtifactIds: readonly number[];
  ucArtifactIds: readonly number[];
  acArtifactIds: readonly number[];
  acceptanceBaselineHash: string;
  srsArtifactId: number | null;
  bundleHash: string;
}

export interface AcceptanceBaselineSnapshotPayload {
  schemaVersion: typeof ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA;
  processRunId: number;
  formalizationEpicId: number;
  sourceReconciliationRef: string;
  sourceReconciliationHash: string;
  acArtifactIds: readonly number[];
  acArtifactHashes: Readonly<Record<string, string>>;
  /** Atomic criteria parsed from the accepted AC artifact containers. */
  acceptanceCriteria?: readonly {
    artifactId: number;
    code: string;
    title: string;
    contentHash: string;
  }[];
  baselineHash: string;
}

export type AcceptanceCriticality = 'blocker' | 'degradable' | 'nice_to_have';

/**
 * ADR-088 (CC-GAP-6): the frozen constraint-coverage requirement relayed to
 * Development inside the solution contract. Formalization owns the
 * classification; the planner and the task-graph gate only inherit and
 * enforce it. Carries exactly what the Development-side reverse diff and
 * entrypoint-ownership conjunction need — register ids, classes,
 * execution-class entrypoint files, and the TYPED waivers (brief
 * dispositions with disposition='waived' and a non-empty reason).
 *
 * Present if and only if the case carries a (non-empty) constraint register;
 * a registerless corpus freezes no block and stays grandfathered.
 */
export interface SolutionContractConstraintCoverage {
  /** Content-addressed register ref: constraint-register:<digest>. */
  readonly constraintRegisterRef: string;
  readonly constraintRegisterDigest: string;
  readonly entries: readonly {
    readonly id: string;
    readonly class: OrderConstraintClass;
    /** Execution-class only (see OrderConstraintEntry.entrypointFiles). */
    readonly entrypointFiles?: readonly string[];
  }[];
  /**
   * Typed waivers — the only lawful escape hatch from the reverse diff.
   * ADR-090 (CC-IC-2) + the 2026-08-23 waiver-authority decision: per
   * schema version — v1 keeps the frozen legacy reasoned-waiver rule; on
   * v2 the waiver state is TYPED UNAVAILABLE, so this is ALWAYS empty
   * (resolved/deferred never discharge coverage; nothing subtracts on v2).
   */
  readonly waivedIds: readonly string[];
}

/**
 * The A1 waiver rule shared by every consumer of the brief's constraint
 * dispositions: a waiver counts ONLY with disposition='waived' AND a
 * non-empty reason. Anything else is a reaction defect the A1 gate owns —
 * never a coverage free pass.
 *
 * LEGACY (v1) RULE ONLY: this predicate dates from ADR-088, when every
 * register was v1 and a reasoned author waiver was the accepted discharge.
 * Under ADR-090 (CC-IC-2) + the 2026-08-23 waiver-authority decision the
 * rule is FROZEN-LEGACY-V1-ONLY — use {@link waivedConstraintIdsForRegister},
 * which applies this legacy rule to v1 registers and returns the empty set
 * for v2 registers (the v2 waiver state is typed unavailable; nothing
 * subtracts on v2).
 */
export function waivedConstraintIdsFromDispositions(
  dispositions: Readonly<Record<string, unknown>> | undefined | null,
): string[] {
  if (!dispositions) return [];
  const waivedIds: string[] = [];
  for (const [id, value] of Object.entries(dispositions)) {
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).disposition === 'waived'
      && typeof (value as Record<string, unknown>).reason === 'string'
      && ((value as Record<string, unknown>).reason as string).trim().length > 0
    ) {
      waivedIds.push(id);
    }
  }
  return waivedIds;
}

// ---------------------------------------------------------------------------
// ADR-090 (CC-IC-2): kind-aware closed dispositions on the existing network
// ---------------------------------------------------------------------------

/**
 * ADR-090 (CC-IC-2): the brief metadata field carrying the register digest the
 * authored `constraint_dispositions` were disposed AGAINST. Positional
 * `ord-c-NNN` ids are never reusable across register revisions: a disposition
 * set without a pin, or pinned to a different register digest, is a typed red
 * (mutation m2d) — never a silent positional re-application.
 */
export const CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD =
  'constraint_dispositions_register_digest';

/**
 * ADR-090 (CC-IC-2) + the 2026-08-23 waiver-authority decision journal
 * (docs/architecture/decision-journal/2026-08-23-cc-ic2-waiver-authority.md):
 * `waived` is TYPED UNAVAILABLE on v2 registers. V2 brief metadata is
 * authored by the WORKER, so any attribution record carried inside it —
 * including a perfectly shaped `{ kind: 'operator-waiver', operator, reason,
 * provenanceRef }` fake — is worker-authored by construction; there is no
 * operator-owned channel (command / append-only ledger) whose bytes the
 * gates could trust instead. Until such a channel lands, every v2 `waived`
 * record is a typed red (`WAIVER_UNAVAILABLE`), never enters `waivedIds`,
 * never subtracts from the coverage reverse diff, and never reaches the
 * warrant. Workers may PROPOSE waivers in prose only; proposals never
 * subtract obligations. There is accordingly NO v2 waiver record type.
 *
 * A parsed, valid v2 disposition for one register entry — the exact
 * kind/state grammar: kind `open-question` disposes `resolved` or
 * `deferred` ONLY; every other kind disposes `accepted` ONLY.
 */
export type ParsedConstraintDisposition =
  | { readonly disposition: 'accepted' }
  | { readonly disposition: 'resolved'; readonly evidenceRef: string }
  | {
    readonly disposition: 'deferred';
    readonly reason: string;
    readonly owner: string;
    readonly unblockCriterion: string;
  };

/** One per-ID (or set-level) disposition defect, rendered as repair guidance. */
export interface ConstraintDispositionGap {
  /**
   * The entry id the gap belongs to, or 'constraint_dispositions' for
   * set-level defects (register-digest pin, key-set equality).
   */
  readonly targetId: string;
  /** Stable machine-readable reason (typed, never prose-only). */
  readonly reason: string;
  /** Exact repair guidance for the author. */
  readonly guidance: string;
}

const DISPOSITION_REASON_PREFIX = 'FORMALIZATION_CONSTRAINT_DISPOSITION_';

function dispositionGap(
  targetId: string,
  reason: string,
  guidance: string,
): ConstraintDispositionGap {
  return { targetId, reason: DISPOSITION_REASON_PREFIX + reason, guidance };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The closed per-state field vocabularies of a v2 disposition record. The
 * `waived` state has NO entry: it is typed-unavailable on v2 (see
 * ParsedConstraintDisposition) — every waiver record, whatever its shape,
 * is the WAIVER_UNAVAILABLE red.
 */
const V2_DISPOSITION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  accepted: ['disposition'],
  resolved: ['disposition', 'evidenceRef'],
  deferred: ['disposition', 'reason', 'owner', 'unblockCriterion'],
};

/**
 * The closed per-KIND state vocabulary of a v2 disposition: kind
 * `open-question` (an obligation that must be resolved or owned-deferred)
 * allows `resolved|deferred` ONLY; every other kind (an order clause the
 * work either carries or does not) allows `accepted` ONLY. Cross-kind
 * states are the STATE_INVALID_FOR_KIND red — never reinterpreted.
 */
function v2StatesForKind(entryKind: string): readonly string[] {
  return entryKind === 'open-question'
    ? ['resolved', 'deferred']
    : ['accepted'];
}

/** snake_case ingress aliases never silently merged into a stored record. */
const DISPOSITION_SNAKE_CASE_ALIASES: readonly string[] = [
  'evidence_ref',
  'unblock_criterion',
  'operator_attribution',
  'waiver_operator',
  'waiver_reason',
  'waiver_provenance_ref',
];

/**
 * The typed reason every v2 `waived` record carries — rendered regardless of
 * record shape. The 2026-08-23 waiver-authority decision (Option A): there
 * is NO valid operator attribution inside worker-authored brief metadata,
 * so the state itself is unavailable; see ParsedConstraintDisposition.
 */
function waiverUnavailableGap(targetId: string): ConstraintDispositionGap {
  return dispositionGap(
    targetId,
    'WAIVER_UNAVAILABLE',
    'the v2 waiver state is TYPED UNAVAILABLE: brief metadata is worker-authored, '
      + 'so even a perfectly shaped operator-attribution record is a worker string, '
      + 'not an operator act — there is no operator-owned waiver channel (command/'
      + 'append-only ledger) to read trust from. Workers may PROPOSE a waiver in '
      + 'prose only; a proposal never subtracts the obligation. Dispose '
      + 'resolved+evidenceRef or deferred+reason+owner+unblockCriterion instead '
      + '(open-question), or accepted (other kinds)',
  );
}

/**
 * Parse one v2 disposition record fail-closed in the EXACT kind/state
 * grammar. Unknown states, kind-crossing states, the typed-unavailable
 * `waived` state (any shape — including perfectly shaped operator-attribution
 * records), missing required fields, unknown fields and snake_case aliases
 * are typed gaps — never silently dropped or reinterpreted.
 */
function parseV2DispositionRecord(
  targetId: string,
  raw: unknown,
  entryKind: string,
): { parsed?: ParsedConstraintDisposition; gap?: ConstraintDispositionGap } {
  if (!isRecord(raw)) {
    return {
      gap: dispositionGap(
        targetId,
        'RECORD_INVALID',
        `disposition must be an object — got ${Array.isArray(raw) ? 'array' : typeof raw}`,
      ),
    };
  }
  const state = raw['disposition'];
  // Option A of the 2026-08-23 waiver-authority decision: the v2 waiver
  // state is typed unavailable WHATEVER the record carries — checked before
  // any field inspection so the perfectly shaped fake operator record gets
  // the waiver-specific typed red, not a generic field red.
  if (state === 'waived') {
    return { gap: waiverUnavailableGap(targetId) };
  }
  const allowed = V2_DISPOSITION_FIELDS[String(state)] ?? null;
  if (!allowed) {
    return {
      gap: dispositionGap(
        targetId,
        'STATE_INVALID',
        `disposition '${String(state)}' is not in the closed v2 grammar for this entry `
          + `(kind '${entryKind}'); an unknown enum value is never a silent pass`,
      ),
    };
  }
  // The exact kind/state grammar: open-question disposes resolved|deferred
  // ONLY (an unresolved obligation); every other kind disposes accepted
  // ONLY (an order clause the work either carries or does not). Crossing
  // the kinds is a typed red — an accepted open-question is a rubber stamp;
  // a resolved/deferred order clause is a state the clause grammar never
  // defined.
  const statesForKind = v2StatesForKind(entryKind);
  if (!statesForKind.includes(String(state))) {
    return {
      gap: dispositionGap(
        targetId,
        'STATE_INVALID_FOR_KIND',
        `disposition '${String(state)}' is not in the closed grammar for kind `
          + `'${entryKind}' (allowed: ${statesForKind.join(' | ')}) — the kind/state `
          + `grammar is exact; a state is never reinterpreted across kinds`,
      ),
    };
  }
  for (const field of Object.keys(raw)) {
    if (DISPOSITION_SNAKE_CASE_ALIASES.includes(field)) {
      return {
        gap: dispositionGap(
          targetId,
          'ALIAS_REJECTED',
          `disposition record carries the snake_case ingress field '${field}' — `
            + `the disposition vocabulary is closed camelCase; a silently merged alias `
            + `is never accepted`,
        ),
      };
    }
    if (!allowed.includes(field)) {
      return {
        gap: dispositionGap(
          targetId,
          'FIELD_REJECTED',
          `disposition record carries unknown field '${field}' — the closed `
            + `${String(state)} vocabulary is { ${allowed.join(', ')} }; extra `
            + `authority-bearing fields are never silently dropped`,
        ),
      };
    }
  }
  if (state === 'accepted') return { parsed: { disposition: 'accepted' } };
  if (state === 'resolved') {
    const evidenceRef = raw['evidenceRef'];
    if (!nonEmptyString(evidenceRef)) {
      return {
        gap: dispositionGap(
          targetId,
          'RESOLVED_EVIDENCE_REF_REQUIRED',
          'resolved requires a non-empty evidenceRef naming the resolution evidence',
        ),
      };
    }
    return { parsed: { disposition: 'resolved', evidenceRef } };
  }
  // state === 'deferred'
  const reason = raw['reason'];
  const owner = raw['owner'];
  const unblockCriterion = raw['unblockCriterion'];
  const missing: string[] = [];
  if (!nonEmptyString(reason)) missing.push('reason');
  if (!nonEmptyString(owner)) missing.push('owner');
  if (!nonEmptyString(unblockCriterion)) missing.push('unblockCriterion');
  if (missing.length > 0) {
    return {
      gap: dispositionGap(
        targetId,
        'DEFERRED_INCOMPLETE',
        `deferred requires non-empty ${missing.join(', ')} — a deferral without an `
          + `owner or an unblock criterion is an opaque string, not an owned obligation`,
      ),
    };
  }
  return {
    parsed: {
      disposition: 'deferred',
      reason: reason as string,
      owner: owner as string,
      unblockCriterion: unblockCriterion as string,
    },
  };
}

/** Parse one v1 (legacy) disposition record — the frozen ADR-088 grammar. */
function parseV1DispositionRecord(
  raw: unknown,
): { valid: boolean; waived: boolean; reasonMissing: boolean } {
  if (!isRecord(raw)) return { valid: false, waived: false, reasonMissing: false };
  if (raw['disposition'] === 'accepted') return { valid: true, waived: false, reasonMissing: false };
  if (raw['disposition'] === 'waived') {
    const reason = raw['reason'];
    const reasonMissing = !(typeof reason === 'string' && reason.trim().length > 0);
    return { valid: !reasonMissing, waived: !reasonMissing, reasonMissing };
  }
  return { valid: false, waived: false, reasonMissing: false };
}

export interface CheckedConstraintDispositions {
  /** null when every entry is validly disposed; otherwise the typed gaps. */
  readonly gaps: readonly ConstraintDispositionGap[];
  /** Parsed valid records by entry id (best effort; gaps take precedence). */
  readonly parsed: Readonly<Record<string, ParsedConstraintDisposition>>;
}

/**
 * ADR-090 (CC-IC-2): check a brief's authored `constraint_dispositions`
 * against the register they dispose.
 *
 * v2 registers (strict semantics — the EXACT kind/state grammar of the
 * 2026-08-23 waiver-authority decision):
 *  - every entry must be disposed in its KIND-AWARE grammar — kind
 *    `open-question`: `resolved`+evidenceRef | `deferred`+reason+owner+
 *    unblockCriterion, NOTHING else (`accepted` is a typed red — an
 *    open question is an obligation, not an order clause); every other
 *    kind: `accepted`, NOTHING else (`resolved`/`deferred` are typed
 *    reds); `waived` is TYPED UNAVAILABLE on v2 — every waiver record,
 *    including a perfectly shaped operator-attribution fake, is the
 *    WAIVER_UNAVAILABLE red (brief metadata is worker-authored; there is
 *    no operator-owned channel to read trust from);
 *  - EXACT key-set equality with the register entry ids (missing and EXTRA
 *    keys are both red — an extra key is a disposition authored against a
 *    different register);
 *  - when `requireRegisterDigestPin` is set (the A1 gate — the m2d host) and
 *    any disposition is present, the authored-against register digest pin
 *    ({@link CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD}) is REQUIRED and
 *    MUST equal the register digest (positional ord-c dispositions are never
 *    reusable across register revisions). The freeze does not re-evaluate the
 *    pin (the kernel port carries the map only): it binds registerDigest +
 *    deterministic dispositionsDigest into the warrant instead;
 *  - unknown fields and snake_case aliases inside records fail closed.
 *
 * v1 registers: the frozen ADR-088 grammar (accepted | waived+reason), subset
 * semantics — bit-identical legacy behavior, no pin, no set equality.
 */
export function checkConstraintDispositionsForRegister(input: {
  readonly register: OrderConstraintRegister;
  readonly dispositions: Readonly<Record<string, unknown>>;
  readonly authoredRegisterDigest?: unknown;
  /** The A1 gate (m2d host) requires the authored-against pin; the freeze binds the warrant instead. */
  readonly requireRegisterDigestPin?: boolean;
}): CheckedConstraintDispositions {
  const { register, dispositions, authoredRegisterDigest, requireRegisterDigestPin } = input;
  const isV2 = register.schemaVersion === ORDER_CONSTRAINT_REGISTER_SCHEMA_V2;
  const gaps: ConstraintDispositionGap[] = [];
  const parsed: Record<string, ParsedConstraintDisposition> = {};
  const registerIds = new Set(register.constraints.map(entry => entry.id));
  if (isV2) {
    // m2d: the authored-against pin (gate-owned). Required the moment
    // anything is disposed; must equal the register digest being disposed.
    if (requireRegisterDigestPin && Object.keys(dispositions).length > 0) {
      if (authoredRegisterDigest === undefined || authoredRegisterDigest === null) {
        gaps.push(dispositionGap(
          'constraint_dispositions',
          'REGISTER_DIGEST_PIN_MISSING',
          `the brief metadata must carry '${CONSTRAINT_DISPOSITIONS_REGISTER_DIGEST_FIELD}' `
            + `(<registerDigest>) beside constraint_dispositions — positional ord-c `
            + `dispositions are never reusable across register revisions`,
        ));
      } else if (
        typeof authoredRegisterDigest !== 'string'
        || authoredRegisterDigest !== register.registerDigest
      ) {
        gaps.push(dispositionGap(
          'constraint_dispositions',
          'REGISTER_DIGEST_PIN_MISMATCH',
          `dispositions were authored against register digest `
            + `'${String(authoredRegisterDigest)}' but the case carries `
            + `'${register.registerDigest}' — a disposition set carried across a `
            + `registerDigest change (positional ord-c reuse) is red; re disposing `
            + `against the current register is required`,
        ));
      }
    }
    // Exact set equality: extra keys are dispositions for ids this register
    // never counted.
    const extraIds = Object.keys(dispositions)
      .filter(id => !registerIds.has(id))
      .sort();
    if (extraIds.length > 0) {
      gaps.push(dispositionGap(
        'constraint_dispositions',
        'ID_SET_MISMATCH',
        `disposition keys must equal the register entry ids exactly; extra ids not in `
          + `the register: [${extraIds.join(', ')}] — a disposition authored against a `
          + `different register is never silently applied`,
      ));
    }
    for (const entry of register.constraints) {
      if (!Object.hasOwn(dispositions, entry.id)) {
        const grammar = entry.kind === 'open-question'
          ? 'resolved+evidenceRef | deferred+reason+owner+unblockCriterion '
            + '(waived is typed-unavailable on v2 — propose in prose only)'
          : 'accepted (waived is typed-unavailable on v2 — propose in prose only)';
        gaps.push(dispositionGap(
          entry.id,
          'UNDISPOSED',
          `kind '${entry.kind ?? 'scope'}' entry is not disposed — react per ID with `
            + `{ "disposition": ... } from the grammar: ${grammar}`,
        ));
        continue;
      }
      const result = parseV2DispositionRecord(entry.id, dispositions[entry.id], entry.kind ?? 'scope');
      if (result.gap) gaps.push(result.gap);
      else if (result.parsed) parsed[entry.id] = result.parsed;
    }
    return { gaps, parsed };
  }
  // Frozen v1 semantics — bit-identical with the pre-CC-IC-2 gate. No v2
  // records are parsed here: the legacy grammar has no kinds, and the
  // freeze's v1 waiver arithmetic stays on the frozen legacy rule through
  // waivedConstraintIdsForRegister (v2 returns the empty set — the waiver
  // state is typed unavailable there).
  for (const entry of register.constraints) {
    const record = parseV1DispositionRecord(dispositions[entry.id]);
    if (record.valid) continue;
    const reason = record.reasonMissing
      ? ' (waived requires a non-empty reason)'
      : '';
    gaps.push(dispositionGap(
      entry.id,
      'UNDISPOSED',
      `Constraint ${entry.id} (${entry.class}) "${entry.text}" is not disposed`
        + ` in the brief artifact metadata constraint_dispositions${reason}.`
        + ` React per ID: {"${entry.id}": {"disposition": "accepted"}} or`
        + ` {"disposition": "waived", "reason": "<why>"}.`,
    ));
  }
  return { gaps, parsed };
}

/**
 * ADR-090 (CC-IC-2) honest required-coverage arithmetic, per the 2026-08-23
 * waiver-authority decision: the set of ids a waiver subtracts from the
 * reverse diff. v1 registers keep the frozen legacy rule (waived +
 * non-empty reason). v2 registers return the EMPTY set ALWAYS — the v2
 * waiver state is typed unavailable (brief metadata is worker-authored; no
 * operator-owned channel exists), so NOTHING subtracts: `resolved` and
 * `deferred` are disposition STATES, never coverage discharges, and a
 * resolved or deferred open-question entry REMAINS in (register ⊆ covered)
 * until it is covered — a future operator-owned waiver channel is the only
 * lawful re-opening path.
 */
export function waivedConstraintIdsForRegister(
  register: OrderConstraintRegister,
  dispositions: Readonly<Record<string, unknown>> | undefined | null,
): string[] {
  if (register.schemaVersion !== ORDER_CONSTRAINT_REGISTER_SCHEMA_V2) {
    return waivedConstraintIdsFromDispositions(dispositions);
  }
  // v2: no waiver exists, so nothing can be lawfully waived — ignore the
  // authored dispositions entirely (an attempted waived record is the A1
  // gate's red; here it simply never subtracts).
  void dispositions;
  return [];
}

/**
 * Deterministic dispositions digest for the freeze/warrant: SHA-256 over the
 * canonical JSON of the disposition map (keys sorted recursively), so the
 * same disposition SET yields the same digest regardless of authoring or
 * read-back key order. Bind beside the register digest at the warrant.
 */
export function constraintDispositionsDigest(
  dispositions: Readonly<Record<string, unknown>> | undefined | null,
): string {
  return sha256Hex(dispositions ?? {});
}

/**
 * ADR-090 (CC-IC-2) frozen read-back: verify a warrant's dispositions digest
 * against the disposition set it froze. Read-back drift (the frozen map
 * edited, or the digest computed over different content) is a typed red —
 * never a silent re-issue.
 */
export function verifyWarrantDispositionsBinding(warrant: {
  readonly constraintRegisterDigest: string;
  readonly dispositionsDigest: string;
  readonly dispositions: Readonly<Record<string, unknown>>;
}): void {
  if (!/^[a-f0-9]{64}$/.test(warrant.constraintRegisterDigest)) {
    throw new Error(
      'WARRANT_DISPOSITIONS_BINDING_INVALID: the warrant carries no valid '
      + 'constraintRegisterDigest (64-hex) to pin the dispositions against',
    );
  }
  const recomputed = constraintDispositionsDigest(warrant.dispositions);
  if (recomputed !== warrant.dispositionsDigest) {
    throw new Error(
      'WARRANT_DISPOSITIONS_DIGEST_DRIFT: the warrant dispositionsDigest '
      + `'${warrant.dispositionsDigest}' does not match the deterministic digest of `
      + `the frozen dispositions ('${recomputed}') — read-back drift, never a silent re-issue`,
    );
  }
}

/**
 * Build the frozen coverage block for the solution contract from the case's
 * constraint-register binding and the accepted brief's dispositions (both
 * already resolved by the settlement kernel — no new authority, no re-read
 * of the order prose).
 */
export function buildSolutionContractConstraintCoverage(
  binding: FormalizationConstraintRegisterBinding,
  briefDispositions: Readonly<Record<string, unknown>> | undefined | null,
): SolutionContractConstraintCoverage {
  return {
    constraintRegisterRef: binding.constraintRegisterRef,
    constraintRegisterDigest: binding.constraintRegisterDigest,
    entries: binding.constraintRegister.constraints.map(entry => ({
      id: entry.id,
      class: entry.class,
      ...(entry.entrypointFiles && entry.entrypointFiles.length > 0
        ? { entrypointFiles: [...entry.entrypointFiles] }
        : {}),
    })),
    // ADR-090 (CC-IC-2) honest waiver arithmetic per schema version — v1
    // keeps the frozen legacy reasoned-waiver rule; v2 ALWAYS freezes an
    // empty set (the v2 waiver state is typed unavailable — resolved and
    // deferred are disposition states, never coverage discharges, and no
    // worker-authored record can ever subtract on v2).
    waivedIds: waivedConstraintIdsForRegister(
      binding.constraintRegister,
      briefDispositions,
    ),
  };
}

export interface FormalizationSolutionContractPayload {
  schemaVersion: typeof SOLUTION_CONTRACT_CERTIFICATE_SCHEMA;
  processRunId: number;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundle: SolutionContractBundle;
  artifactHashes: Readonly<Record<string, string>>;
  traceIds: readonly number[];
  traceDigest: string;
  baselineSnapshotRef: string;
  baselineSnapshotHash: string;
  /**
   * ADR-090 (CC-IC-1 focused repair, m7 consumer boundary): the FormalizationCase
   * identity digest the settlement-issued warrantRef is cross-bound to
   * (formalizationCaseIdentityDigest of the case this contract froze). Frozen
   * here — beside the discoveryCertificateHash already carried — so the
   * Development warrant consumer has BOTH authoritative expected identities on
   * the case it inherits. Optional: payloads frozen before this repair carry
   * none, and a warrant-bearing manifest against such a case fails closed at
   * the consumer (never a silent unverifiable accept).
   */
  formalizationCaseDigest?: string;
  srs: {
    schema: typeof FORMALIZATION_SRS_SCHEMA;
    ref: string;
    hash: string;
  };
  /**
   * ADR-088 (CC-GAP-6): the frozen constraint-coverage requirement
   * Development inherits and enforces (reverse diff + entrypoint
   * ownership). Absent when the corpus carries no constraint register —
   * the sole grandfather condition. @see SolutionContractConstraintCoverage.
   */
  constraintRegisterCoverage?: SolutionContractConstraintCoverage;
  /** Exact immutable hand-off to Development. */
  acceptanceCriteria: readonly {
    /** Stable atomic criterion identity; distinct from its document container. */
    criterionId: number;
    artifactId: number;
    code: string | null;
    /** Accepted hash of the provenance artifact/document container. */
    acceptedHash: string;
    /** Content hash of this atomic criterion section within the container. */
    criterionHash?: string;
    implementationRequired: boolean;
    criticality: AcceptanceCriticality;
    /**
     * AC-drift relay: the constraint-register IDs this criterion covers,
     * carried from the SRS §D2 stanza (covered_constraint_ids). Absent when
     * no register exists — Development then relays nothing (retro-compat).
     */
    coveredConstraintIds?: readonly string[];
  }[];
}

export interface FormalizationSettlementInput {
  schemaVersion: typeof FORMALIZATION_SETTLEMENT_INPUT_SCHEMA;
  formalizationEpicId: number;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundle: SolutionContractBundle;
}

/**
 * The closed decision union IS the mechanical unreachability proof: a value
 * absent from this union cannot occur. 'clarification-required' and
 * 'infeasible' were deleted with their routes (declared but never produced —
 * see docs/testing/W9-04-UNREACHABLE-EDGE-EVIDENCE.md).
 */
export type FormalizationDecision =
  | 'formalized'
  | 'inconsistent'
  | 'failed';

export type FormalizationReasonCode =
  | 'baseline-missing'
  | 'traceability-gap'
  | 'srs-missing'
  | 'prd-missing'
  | 'acceptance-empty'
  | 'tasks-not-ready'
  | 'invariant-violation'
  | 'infrastructure-error';

export interface FormalizationCertificatePayload {
  schemaVersion: typeof FORMALIZATION_CERTIFICATE_SCHEMA_VERSION;
  decision: FormalizationDecision;
  reasonCodes: readonly FormalizationReasonCode[];
  rationale: string;
  inputHash: string;
  discoveryCertificateRef: string;
  discoveryCertificateHash: string;
  bundleHash: string;
  acceptanceBaselineHash: string;
}

export { FORMALIZATION_PROCESS_MODULE_REF } from '../../../process-modules/lifecycles/product-delivery-module-contracts.js';
