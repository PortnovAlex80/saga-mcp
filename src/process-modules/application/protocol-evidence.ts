/**
 * W4-A3 — Protocol evidence verification (plan §8.4 / §8.5 / §8.6, checklist
 * C026, spec `09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md` §1 lane A3).
 *
 * The Runtime owns the BEFORE-COMPLETE evidence gate (C026): a protocol step
 * may advance to `completed` (and a node may emit its completion) ONLY after
 * every required durable evidence item exists. This file implements that gate.
 *
 * ── What the Runtime understands (§8.5) ──────────────────────────────────
 *
 * The Runtime understands the CATEGORY of an evidence item but NEVER the
 * domain meaning. The six standard categories are owned by the pure SPI
 * (`domain/spi/node-protocol.ts`, W1-A4) and re-exported here as the closed
 * `STANDARD_EVIDENCE_CATEGORIES` set:
 *
 *   tool-receipt            a successful tool receipt (§8.4)
 *   artifact-reference      a produced artifact reference (§8.4)
 *   trace-reference         a traceability edge reference (§8.4)
 *   human-receipt           a human approval/decision receipt (§8.4)
 *   external-receipt        an external-side receipt (§8.4)
 *   module-verifier-receipt a typed acceptance receipt emitted by a
 *                           package-declared verifier (§8.5 / §8.13)
 *
 * For five of the six categories the Runtime performs STRUCTURAL verification
 * only: the provided evidence item carries the matching category, a contract
 * ref that matches the requirement, and the minimal structural fields the
 * receipt kind needs. The Runtime does not know what "SRS-accepted" means.
 *
 * For `module-verifier-receipt` the Runtime additionally delegates to a
 * PACKAGE-DECLARED VERIFIER (§8.5) registered through a
 * `PackageEvidenceVerifierRegistry`. The verifier is versioned and identified
 * by `ContractRef`; it is the single place where module-specific semantic
 * evidence is checked. If no verifier is registered for a required receipt,
 * the gate FAILS CLOSED (the receipt is not trusted) — this is the
 * before-complete guarantee of C026.
 *
 * ── Layering ────────────────────────────────────────────────────────────
 *
 * This is an APPLICATION service: it imports pure types from
 * `domain/spi/index.js` (ProtocolStep, EvidenceRequirement, EvidenceCategory,
 * ContractRef) and `domain/recovery.js` (ProcessModuleReference). Both are
 * application→domain edges the dependency-direction ratchet permits (Rule 5
 * forbids the reverse). No persistence, infrastructure, composition, or
 * module-implementation imports — those would trip the ratchet. The gate is
 * pure: given (step, requirements, provided evidence, optional verifier
 * registry) it returns a boolean; it performs no I/O.
 *
 * Plan refs: §0.7.5 (W4-A3 ownership), §8.4, §8.5, §8.6, §14.6.4/C026,
 * §17.2 (risk control: Runtime understands evidence shape; module verifiers
 * understand meaning).
 */

import type {
  ContractRef,
  EvidenceCategory,
  EvidenceRequirement,
  ProtocolStep,
} from '../domain/spi/index.js';
import type { ProcessModuleReference } from '../domain/process-module.js';

// ---------------------------------------------------------------------------
// Standard evidence categories (plan §8.4 / §8.5).
// ---------------------------------------------------------------------------

/**
 * Closed set of standard evidence categories the Runtime understands
 * structurally (plan §8.4 / §8.5). Mirrors `EvidenceCategory` from the pure
 * SPI (`domain/spi/node-protocol.ts`, W1-A4). Exported as a runtime value so
 * the gate can test membership without importing the union's runtime
 * representation (TypeScript erases unions).
 */
export const STANDARD_EVIDENCE_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set<
  EvidenceCategory
>([
  'tool-receipt',
  'artifact-reference',
  'trace-reference',
  'human-receipt',
  'external-receipt',
  'module-verifier-receipt',
]);

/**
 * Categories the Runtime verifies by STRUCTURE ALONE (no package verifier
 * delegation). For these, `verifyStepEvidence` checks that a provided item
 * carries the matching category + contract ref + the minimal receipt fields.
 */
export const STRUCTURAL_EVIDENCE_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set<
  EvidenceCategory
>([
  'tool-receipt',
  'artifact-reference',
  'trace-reference',
  'human-receipt',
  'external-receipt',
]);

// ---------------------------------------------------------------------------
// Provided evidence items.
// ---------------------------------------------------------------------------

/**
 * One durable evidence item a worker supplies when completing a protocol
 * step. `category` MUST be one of `STANDARD_EVIDENCE_CATEGORIES`; `value` is
 * the canonical-serializable receipt payload whose shape is pinned by
 * `contractRef`. The Runtime never interprets `value` beyond the structural
 * checks each category requires (see `categoryRequiresFields`).
 *
 * `moduleVerifierContractRef` is REQUIRED when `category ===
 * 'module-verifier-receipt'`: it identifies the package-declared verifier
 * (§8.5) whose `ContractRef` is registered in the verifier registry. For the
 * five structural categories it is ignored.
 */
export interface ProvidedEvidence {
  readonly category: EvidenceCategory;
  readonly contractRef: ContractRef;
  readonly value: Readonly<Record<string, unknown>>;
  /**
   * Required for `module-verifier-receipt`: the ContractRef of the
   * package-declared verifier that emitted the receipt. Must match a
   * registered verifier (see PackageEvidenceVerifierRegistry).
   */
  readonly moduleVerifierContractRef?: ContractRef;
}

// ---------------------------------------------------------------------------
// Minimal structural fields each category requires inside `value`.
// ---------------------------------------------------------------------------

/**
 * The Runtime never interprets the SEMANTIC content of an evidence value, but
 * it does require a small set of STRUCTURAL fields so the receipt is durable
 * and content-addressed (plan §8.4, §8.9: "verifier identity and digest").
 * These are the minimal keys `value` MUST carry per category.
 *
 * This is intentionally minimal: a module verifier owns any richer semantic
 * shape. The Runtime only asserts the receipt is well-formed enough to be
 * persisted and replayed.
 */
const STRUCTURAL_FIELDS_BY_CATEGORY: Readonly<
  Record<EvidenceCategory, readonly string[]>
> = Object.freeze({
  // A successful tool call: the tool's logical id + the receipt digest/hash.
  'tool-receipt': Object.freeze(['toolId', 'receiptHash']),
  // A produced artifact: artifact id/type + content hash.
  'artifact-reference': Object.freeze(['artifactRef', 'contentHash']),
  // A traceability edge: source/target artifact ids + link kind.
  'trace-reference': Object.freeze(['sourceId', 'targetId']),
  // A human approval: the approver identity + the decision digest.
  'human-receipt': Object.freeze(['approverId', 'decisionHash']),
  // An external-side receipt: the external system id + receipt digest.
  'external-receipt': Object.freeze(['externalSystemId', 'receiptHash']),
  // A typed acceptance receipt from a package-declared verifier (§8.5/§8.13):
  // the verifier identity + the acceptance digest. `moduleVerifierContractRef`
  // on ProvidedEvidence carries the verifier's ContractRef.
  'module-verifier-receipt': Object.freeze(['verifierId', 'acceptanceHash']),
});

/**
 * The minimal structural fields `value` MUST carry for a given category, or
 * `null` if the category is unknown (which makes the gate fail closed).
 */
export function categoryRequiredFields(category: string): readonly string[] | null {
  const fields = (STRUCTURAL_FIELDS_BY_CATEGORY as Record<string, readonly string[]>)[
    category
  ];
  return fields ?? null;
}

// ---------------------------------------------------------------------------
// Package verifier binding (plan §8.5).
// ---------------------------------------------------------------------------

/**
 * Result of delegating a `module-verifier-receipt` to a package-declared
 * verifier. The verifier owns the SEMANTIC decision ("this acceptance receipt
 * is valid for contractRef X"); the Runtime only records the verdict.
 */
export interface PackageVerifierResult {
  readonly accepted: boolean;
  /** Stable module-owned reason code (opaque to the Runtime). */
  readonly reasonCode?: string;
}

/**
 * A package-declared evidence verifier (plan §8.5 / §8.13). Registered by the
 * owning Process Module package against the exact `ContractRef` of the
 * evidence it knows how to validate semantically.
 *
 * The Runtime NEVER switches on module name or module vocabulary here: it
 * looks the verifier up purely by `ContractRef` equality. A verifier that is
 * not registered for a required `module-verifier-receipt` causes the
 * before-complete gate to FAIL CLOSED (C026).
 */
export type PackageEvidenceVerifier = (
  evidence: ProvidedEvidence,
  moduleRef: ProcessModuleReference,
) => PackageVerifierResult;

/**
 * Registry of package-declared evidence verifiers, keyed by the canonical
 * ContractRef string (`${schemaId}@${version}` with the digest as an
 * additional equality component — see `contractRefKey`).
 *
 * This is a minimal in-memory port implementation. Wave 4 wires it into the
 * before-complete gate; a later wave may back it by the package installation
 * registry. It carries no persistence and no module-name knowledge.
 */
export class PackageEvidenceVerifierRegistry {
  private readonly verifiers = new Map<string, PackageEvidenceVerifier>();

  /**
   * Register a verifier for the exact ContractRef. Idempotent: re-registering
   * the same key replaces the verifier (upgrade path). Returns the registry
   * for chaining.
   */
  register(contractRef: ContractRef, verifier: PackageEvidenceVerifier): this {
    if (typeof verifier !== 'function') {
      throw new TypeError('PackageEvidenceVerifier must be a function');
    }
    this.verifiers.set(contractRefKey(contractRef), verifier);
    return this;
  }

  /** Look up the verifier bound to an exact ContractRef, or `null`. */
  resolve(contractRef: ContractRef): PackageEvidenceVerifier | null {
    return this.verifiers.get(contractRefKey(contractRef)) ?? null;
  }

  /** Number of registered verifiers (diagnostic / test helper). */
  get size(): number {
    return this.verifiers.size;
  }
}

/**
 * Canonical stable key for a ContractRef. `schemaId` + `version` form the
 * logical identity; `digest` content-addresses the exact schema document so
 * two modules advertising the same schemaId cannot silently disagree. All
 * three are part of the verifier identity.
 */
export function contractRefKey(ref: ContractRef): string {
  return `${ref.schemaId}@${ref.version}#${ref.digest}`;
}

/**
 * Structural equality of two ContractRefs (all three fields). Used by the gate
 * to match a provided evidence item against a declared EvidenceRequirement.
 */
export function contractRefEquals(a: ContractRef, b: ContractRef): boolean {
  return (
    a.schemaId === b.schemaId &&
    a.version === b.version &&
    a.digest === b.digest
  );
}

// ---------------------------------------------------------------------------
// Core gate: verifyStepEvidence (plan §8.4 / C026).
// ---------------------------------------------------------------------------

/**
 * Verify that every REQUIRED `EvidenceRequirement` is satisfied by at least
 * one provided evidence item of the matching category whose `contractRef`
 * equals the requirement's `contractRef` and whose `value` carries the
 * category's minimal structural fields.
 *
 * `step` is accepted for traceability in the result diagnostics (it names
 * which step the requirements belong to); the requirements themselves are
 * passed explicitly so the same function verifies BOTH step evidence
 * (`step.evidenceRequirements`) and node completion evidence
 * (`nodeCompletionEvidence` from the owning NodeProtocolDefinition).
 *
 * `moduleRef` is forwarded to any package-declared verifier invoked for a
 * `module-verifier-receipt`. The Runtime does not interpret it.
 *
 * Semantics (§8.4 / C026):
 *   - A requirement with `required: false` is OPTIONAL: it never fails the
 *     gate. (It is still validated structurally when provided.)
 *   - A requirement with `required: true` MUST be matched by exactly one
 *     acceptable provided item; otherwise the gate returns `false`.
 *   - A `module-verifier-receipt` requirement additionally requires the
 *     package verifier registered for its ContractRef to return
 *     `{ accepted: true }`. No registered verifier ⇒ fail closed.
 *   - Unknown categories, malformed items, and contract-ref mismatches are
 *     treated as NOT satisfying the requirement (fail closed).
 *
 * Returns `true` ONLY when every required requirement is satisfied.
 */
export function verifyStepEvidence(
  step: ProtocolStep,
  evidenceRequirements: readonly EvidenceRequirement[],
  providedEvidence: readonly ProvidedEvidence[],
  options?: {
    readonly moduleRef?: ProcessModuleReference;
    readonly verifierRegistry?: PackageEvidenceVerifierRegistry;
  },
): boolean {
  return (
    diagnoseStepEvidence(step, evidenceRequirements, providedEvidence, options)
      .satisfied
  );
}

/**
 * Detailed result of the evidence gate. `satisfied` is the boolean the
 * before-complete gate switches on; `unsatisfied` lists the requirements that
 * failed and why, for diagnostics and for building a RecoveryIssue (§8.9) when
 * the gate blocks completion.
 */
export interface EvidenceVerificationResult {
  readonly satisfied: boolean;
  readonly stepId: string;
  readonly unsatisfied: readonly UnsatisfiedRequirement[];
}

export interface UnsatisfiedRequirement {
  readonly category: EvidenceCategory;
  readonly contractRef: ContractRef;
  readonly reason: string;
  readonly reasonCode: EvidenceFailureCode;
}

export type EvidenceFailureCode =
  | 'NO_MATCHING_EVIDENCE'
  | 'CONTRACT_REF_MISMATCH'
  | 'VALUE_MISSING_STRUCTURAL_FIELDS'
  | 'CATEGORY_UNKNOWN'
  | 'MODULE_VERIFIER_NOT_REGISTERED'
  | 'MODULE_VERIFIER_REJECTED';

/**
 * Diagnostic variant of {@link verifyStepEvidence}: returns the boolean
 * verdict PLUS the list of unsatisfied requirements with stable reason codes.
 * The before-complete gate uses `.satisfied`; recovery (W4-A4) consumes the
 * `unsatisfied` list to build a structured RecoveryIssue (§8.9).
 */
export function diagnoseStepEvidence(
  step: ProtocolStep,
  evidenceRequirements: readonly EvidenceRequirement[],
  providedEvidence: readonly ProvidedEvidence[],
  options?: {
    readonly moduleRef?: ProcessModuleReference;
    readonly verifierRegistry?: PackageEvidenceVerifierRegistry;
  },
): EvidenceVerificationResult {
  const moduleRef = options?.moduleRef;
  const registry = options?.verifierRegistry;
  const unsatisfied: UnsatisfiedRequirement[] = [];

  for (const req of evidenceRequirements) {
    // OPTIONAL requirements never fail the gate (§8.4: completion needs only
    // REQUIRED durable evidence). We still do not validate them when absent.
    if (!req.required) continue;

    const failure = checkSingleRequirement(req, providedEvidence, moduleRef, registry);
    if (failure !== null) {
      unsatisfied.push(failure);
    }
  }

  return {
    satisfied: unsatisfied.length === 0,
    stepId: step.id,
    unsatisfied,
  };
}

function checkSingleRequirement(
  req: EvidenceRequirement,
  provided: readonly ProvidedEvidence[],
  moduleRef: ProcessModuleReference | undefined,
  registry: PackageEvidenceVerifierRegistry | undefined,
): UnsatisfiedRequirement | null {
  // Unknown category ⇒ fail closed. A valid NodeProtocolDefinition cannot
  // carry an unknown category (W1-A4 validator rejects it at install), but
  // the gate defends in depth.
  if (!STANDARD_EVIDENCE_CATEGORIES.has(req.category)) {
    return {
      category: req.category,
      contractRef: req.contractRef,
      reasonCode: 'CATEGORY_UNKNOWN',
      reason: `evidence category "${req.category}" is not a standard category`,
    };
  }

  // Find the first provided item that matches category + contract ref AND
  // passes the structural field check.
  let matched: ProvidedEvidence | null = null;
  let sawCategory = false;
  let sawStructuralFailure = false;
  for (const item of provided) {
    if (item.category !== req.category) continue;
    sawCategory = true;
    if (!contractRefEquals(item.contractRef, req.contractRef)) continue;
    if (!hasStructuralFields(item)) {
      sawStructuralFailure = true;
      continue;
    }
    matched = item;
    break;
  }

  if (matched === null) {
    // Distinguish the failure reason for recovery diagnostics.
    if (!sawCategory) {
      return {
        category: req.category,
        contractRef: req.contractRef,
        reasonCode: 'NO_MATCHING_EVIDENCE',
        reason: `no provided evidence of category "${req.category}"`,
      };
    }
    if (sawStructuralFailure) {
      return {
        category: req.category,
        contractRef: req.contractRef,
        reasonCode: 'VALUE_MISSING_STRUCTURAL_FIELDS',
        reason: `provided "${req.category}" evidence is missing required structural fields`,
      };
    }
    return {
      category: req.category,
      contractRef: req.contractRef,
      reasonCode: 'CONTRACT_REF_MISMATCH',
      reason: `provided "${req.category}" evidence contractRef does not match requirement`,
    };
  }

  // For module-verifier-receipt, additionally delegate to the package
  // verifier (§8.5). No registered verifier ⇒ fail closed (C026).
  if (req.category === 'module-verifier-receipt') {
    const verifierRef = matched.moduleVerifierContractRef ?? matched.contractRef;
    const verifier = registry?.resolve(verifierRef) ?? null;
    if (verifier === null) {
      return {
        category: req.category,
        contractRef: req.contractRef,
        reasonCode: 'MODULE_VERIFIER_NOT_REGISTERED',
        reason: `no package verifier registered for contractRef ${contractRefKey(verifierRef)}`,
      };
    }
    const result = verifier(matched, moduleRef as ProcessModuleReference);
    if (!result.accepted) {
      return {
        category: req.category,
        contractRef: req.contractRef,
        reasonCode: 'MODULE_VERIFIER_REJECTED',
        reason:
          result.reasonCode !== undefined
            ? `package verifier rejected: ${result.reasonCode}`
            : 'package verifier rejected the evidence',
      };
    }
  }

  return null;
}

function hasStructuralFields(item: ProvidedEvidence): boolean {
  const required = categoryRequiredFields(item.category);
  if (required === null) return false;
  const value = item.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  for (const field of required) {
    const fv = v[field];
    // Each structural field must be a present, non-empty string. (Hashes/ids
    // are strings; numbers would be a structural defect at this layer.)
    if (typeof fv !== 'string' || fv.length === 0) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Before-complete gate (C026): step advance + node completion.
// ---------------------------------------------------------------------------

/**
 * Before-complete gate input for a single step. `stepEvidence` is the
 * ProtocolStep whose evidence requirements are being gated;
 * `completionEvidenceRequirements` is the owning NodeProtocolDefinition's
 * `nodeCompletionEvidence` (plan §8.2.9), verified when the FINAL step of a
 * node completes. When `isNodeCompletion` is false, only step evidence is
 * verified; when true, BOTH step evidence and node completion evidence are
 * verified atomically (a node cannot complete with unverified evidence).
 */
export interface BeforeCompleteGateInput {
  readonly step: ProtocolStep;
  readonly providedEvidence: readonly ProvidedEvidence[];
  readonly isNodeCompletion: boolean;
  readonly completionEvidenceRequirements: readonly EvidenceRequirement[];
  readonly moduleRef?: ProcessModuleReference;
  readonly verifierRegistry?: PackageEvidenceVerifierRegistry;
}

/**
 * Result of the before-complete gate (C026).
 */
export interface BeforeCompleteGateResult extends EvidenceVerificationResult {
  /**
   * True when this gate also verified node completion evidence. False when
   * only per-step evidence was verified (intermediate step completion).
   */
  readonly verifiedNodeCompletion: boolean;
  /**
   * Result of the node-completion evidence sub-check, when `isNodeCompletion`
   * was true. Absent otherwise.
   */
  readonly completionResult?: EvidenceVerificationResult;
}

/**
 * BEFORE-COMPLETE EVIDENCE GATE (plan §8.4 / §14.6.4 / C026).
 *
 * A protocol step may advance to `completed` ONLY when this returns
 * `satisfied: true`. When `isNodeCompletion` is true, the gate ADDITIONALLY
 * verifies the owning node's `nodeCompletionEvidence` (§8.2.9) — the node
 * cannot emit its completion until BOTH the step evidence and the node
 * completion evidence are verified.
 *
 * This is the single enforcement point for C026 ("Verify evidence before
 * advancing a protocol step"). W4-A2 (protocol-runtime) MUST call it before
 * any step→completed transition; W4-A5 (checkpoint service) MUST call it
 * before recording a node completion.
 *
 * The gate is PURE and performs no I/O. Verifier delegation (§8.5) is the
 * only side-effecting surface, and it is synchronous and contained.
 */
export function verifyBeforeCompleteGate(
  input: BeforeCompleteGateInput,
): BeforeCompleteGateResult {
  const stepResult = diagnoseStepEvidence(
    input.step,
    input.step.evidenceRequirements,
    input.providedEvidence,
    { moduleRef: input.moduleRef, verifierRegistry: input.verifierRegistry },
  );

  if (!input.isNodeCompletion) {
    return {
      ...stepResult,
      verifiedNodeCompletion: false,
    };
  }

  // Node completion: verify BOTH step evidence and node completion evidence.
  // Step evidence failing short-circuits (no point checking completion
  // evidence for a step that cannot complete), but completion evidence
  // failing also blocks the node.
  if (!stepResult.satisfied) {
    return {
      ...stepResult,
      verifiedNodeCompletion: false,
    };
  }

  const completionResult = diagnoseStepEvidence(
    // Node completion evidence is not tied to a step id; reuse the current
    // step id for traceability in diagnostics.
    input.step,
    input.completionEvidenceRequirements,
    input.providedEvidence,
    { moduleRef: input.moduleRef, verifierRegistry: input.verifierRegistry },
  );

  return {
    satisfied: completionResult.satisfied,
    stepId: stepResult.stepId,
    unsatisfied: completionResult.unsatisfied,
    verifiedNodeCompletion: true,
    completionResult,
  };
}

/**
 * Convenience: does the before-complete gate allow step completion? Returns
 * `true` iff {@link verifyBeforeCompleteGate} returns `satisfied: true` for
 * the same input. Use this when you do not need the diagnostics.
 */
export function canCompleteStep(input: BeforeCompleteGateInput): boolean {
  return verifyBeforeCompleteGate(input).satisfied;
}
