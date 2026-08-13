/**
 * Universal quality-gate contracts: CheckPlan, CheckProvider, CheckReceipt,
 * GateRun, GateDecision.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-13 (Отдел качества),
 * REG-14 (План контроля), REG-15 (Инженер ОТК), REG-16 (Проверочный стенд),
 * REG-17 (Протокол проверки), REG-18 (Акт ОТК) + Conveyor Mental Model v4
 * §«The three layers of a universal quality gate» and §«CandidateSet».
 *
 * # Why these types exist (the bug they replace)
 *
 * Earlier saga conflated "worker finished" with "product accepted": a
 * successful `worker_done` flipped an artifact to `accepted`, with the gate
 * implicit in the worker's own completion. v4 separates the two cleanly:
 *
 *   1. `execution_complete` SEALS a CandidateSet but does NOT accept it
 *      (REG-08-AC-04, REG-18-AC-01).
 *   2. A `GateRun` runs a declared `CheckPlan` over the sealed set, emitting
 *      immutable `CheckReceipt`s.
 *   3. A deterministic `GateDecisionPolicy` reduces the receipts to ONE closed
 *      verdict — `accepted | repair_required | human_required | failed`.
 *   4. Only the decision, recorded as an immutable `GateDecision`, may advance
 *      the cell (REG-18-AC-01: "worker completion / CheckReceipt alone do not
 *      move Kanban").
 *
 * The current `ExactCandidateAcceptance` (in `application/exact-candidate-
 * acceptance.ts`) is a PROTO-`GateDecision` specialised for artifact CAS: it
 * already has the idempotency key, the immutable decision with hash, the
 * review-receipt binding and the lineage. Step 3.A.3 generalises it to this
 * universal contract. This file defines the target shape; the step-3 cutover
 * migrates the artifact-CAS adapter to implement it.
 *
 * # Three layers (v4 §«The three layers of a universal quality gate»)
 *
 *   1. CORE INTEGRITY GATE — exact refs, hashes, contract/schema identity,
 *      cardinality, lineage, producer provenance. Run by the conveyor itself
 *      for every workshop.
 *   2. DECLARED CHECKPLAN — versioned refs to schema, policy, sandboxed
 *      lint/build/test and provider-observation checks. A CheckProvider CANNOT
 *      run arbitrary candidate-supplied shell; command/args are pinned by the
 *      installed plan.
 *   3. DECISION POLICY — deterministic reducer from receipts to one closed
 *      verdict; the coordinator records acceptance or recovery.
 *
 * # Pure domain
 *
 * Imports only sibling pure types (`WorkplaceRef`) and pure-SPI `ProductRef`.
 * No SQLite, MCP, db.ts, clock, or application/behavioral code. `CheckProvider`
 * is declared here as a TYPE (the plugin contract); concrete providers live in
 * capability-infrastructure and are registered with the composition root —
 * they never appear in domain code.
 */

import type { ProductRef } from '../spi/index.js';
import type { WorkplaceRef } from './workplace-ref.js';
import type { CandidateSet, CandidateSetRole } from './candidate-set.js';

// ---------------------------------------------------------------------------
// CheckPlan (REG-14) — versioned declaration of what to check.
// ---------------------------------------------------------------------------

/**
 * Outcome a CheckProvider may emit for one check over one CandidateSet.
 *
 * Mirrors CGAD's 4-valued guard verdict:
 *   - `passed` — deterministic evidence confirmed the claim.
 *   - `failed` — deterministic evidence refuted the claim.
 *   - `unknown` — inputs insufficient; treat as denial (CGAD P14 deny-by-
 *     default; REG-14-AC-03 forbids promoting to accepted without explicit
 *     safe policy).
 *   - `error` — provider or check crashed; denial AND an incident should be
 *     filed.
 */
export type CheckOutcome = 'passed' | 'failed' | 'unknown' | 'error';

/**
 * Reference to one installed CheckProvider (REG-16). Versioned + digested so a
 * receipt can name EXACTLY which provider+version ran, and re-running the
 * decision need not re-execute the (possibly nondeterministic) check
 * (REG-17-AC-04).
 */
export interface CheckRef {
  /** Provider id (e.g. 'tsc', 'eslint', 'jest', 'formalization-architecture-contract'). */
  readonly providerId: string;
  readonly version: string;
  /** Digest over the installed provider implementation. */
  readonly providerDigest: string;
}

/**
 * One entry in a CheckPlan: a check ref plus the pinned parameters/environment
 * the provider will run with. REG-14-AC-01: "the plan MUST NOT contain
 * candidate-supplied arbitrary shell." Parameters are declared by the
 * installed plan, not invented by the worker.
 */
export interface CheckPlanEntry {
  readonly check: CheckRef;
  /**
   * Opaque, provider-specific parameters pinned by the plan (e.g. tsconfig
   * path, jest config, max-rss). The runtime persists and forwards them
   * verbatim; it does NOT interpret them.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Repair the authored product when this check deterministically refutes it. */
  readonly repairTargetRoleOnFailure?: CandidateSetRole;
  /** Repair the assessment producer when this check is unknown/invalid/error. */
  readonly repairTargetRoleOnIndeterminate?: CandidateSetRole;
  /**
   * Some indeterminate checks describe missing external authority rather than
   * defective worker production. Such checks stop the line instead of
   * spending the worker retry budget on an impossible repair.
   */
  readonly indeterminateDisposition?: 'repair' | 'human-required';
  /**
   * Who owns the SUBJECT this check refutes. 'workplace' (default): the
   * subject is this workplace's own production, so a deterministic failure
   * is a local defect and the repair budget applies. 'upstream': the subject
   * is a frozen artifact produced earlier on the conveyor (e.g. the
   * integrated release candidate), so a deterministic failure is a PRODUCER
   * defect. No local retry can fix it — the verdict escalates to 'failed'
   * immediately and the conveyor's continuation machinery re-routes the
   * defect to the producing workshop instead of burning repair attempts
   * here.
   */
  readonly failureOwnership?: 'workplace' | 'upstream';
  /**
   * Install-time conformance: the product schema id this check's SUBJECT
   * must have. Paired with `subjectScope`:
   *   - 'cell-product' — the validator HARD-CHECKS this value against the
   *     cell's productContracts schemaRefs (author gate) / review verdict
   *     schema (final gate) at module-install time. A mismatch is a load
   *     error, turning the "entry format changed, exit validator didn't"
   *     desync class into a startup failure instead of a live rupture.
   *   - 'upstream' — the subject is a frozen upstream artifact (e.g. the
   *     integrated candidate); the value is declarative documentation (no
   *     local cross-check is possible).
   */
  readonly expectedSubjectSchemaRef?: string;
  readonly subjectScope?: 'cell-product' | 'upstream';
  /**
   * Optional reference to the disposable sandbox environment the check runs in.
   * Null for checks that need no external state (pure schema validation).
   */
  readonly environmentRef: string | null;
}

/**
 * A versioned quality plan — what OTK will check and how it will decide.
 *
 * REG-14. Immutable once installed; a new plan version is a new
 * `(checkPlanRef, checkPlanDigest)`. The GateDecision cites the EXACT plan it
 * ran, so a later decision audit can reproduce the verdict without rerunning
 * nondeterministic checks (REG-17-AC-04).
 */
export interface CheckPlan {
  /** Stable plan id within the module (e.g. 'formalization.author-gate'). */
  readonly checkPlanId: string;
  readonly version: string;
  /** Digest over the canonical form of the plan (id+version+entries+policy). */
  readonly checkPlanDigest: string;
  /** Ordered checks the gate runs over the subject CandidateSet. */
  readonly entries: readonly CheckPlanEntry[];
  /** Reference to the decision policy that reduces receipts to a verdict. */
  readonly decisionPolicyRef: string;
  readonly decisionPolicyDigest: string;
  /**
   * How `unknown`/`error` receipts map. Default fail-closed
   * (REG-14-AC-03); a plan may declare an explicit safe non-accepting outcome.
   */
  readonly unknownErrorPolicy: 'fail-closed' | 'fail-open-safe';
}

// ---------------------------------------------------------------------------
// CheckProvider (REG-16) — capability plugin behind CheckRunnerPort.
// ---------------------------------------------------------------------------

/**
 * Contract one installed CheckProvider implements. The runtime's
 * `CheckRunnerPort` dispatches by `check.providerId` to the registered plugin.
 *
 * A provider is READ-ONLY with respect to authoritative/external state, or
 * fully sandbox-contained (REG-16 §«Граница»). It CANNOT move the
 * Workplace/Flow (REG-16-AC-02), cannot write a GateDecision, cannot launch a
 * hidden worker or human interaction (REG-16-AC-03). Adding a new provider is
 * a separately versioned, security-reviewed capability plugin (REG-16-AC-04),
 * NOT a private engine inside a workshop.
 *
 * This TYPE lives in the domain so plans/receipts/decisions can cite provider
 * refs without importing infrastructure. The concrete implementations live in
 * capability-infrastructure and are composed at the root.
 */
export interface CheckProvider {
  readonly providerId: string;
  readonly version: string;
  /**
   * ADR-053 C10 — the pinned implementation digest of THIS installed provider.
   * The driver verifies it matches the CheckPlan entry's pinned
   * `check.providerDigest`, so a swapped or mismatched implementation cannot
   * run checks under a plan that pinned a different implementation.
   */
  readonly providerDigest: string;
  /**
   * Conformance declaration (install-time): the product schema id this
   * provider's SUBJECT must have, or null when the provider is
   * schema-agnostic (pure contract/shape checks, review verdicts over
   * reviewer products, generic product-contract). The module conformance
   * validator cross-checks it against the cell's productContracts/review
   * verdict schema so a plan cannot pair a provider with a product it was
   * never built to check — the "entry changed, exit validator didn't"
   * desync class becomes a hard module-load error instead of a live
   * conveyor rupture.
   */
  readonly expectedSubjectSchemaRef?: string | null;
  /**
   * Run one check over an immutable CandidateSet snapshot. Returns a
   * CheckOutcome plus opaque evidence refs. The runtime wraps this into a
   * CheckReceipt with the full provider/version/digest/environment provenance.
   *
   * Pure-ish: a provider MAY touch an external sandbox, but it MUST be
   * reproducible given the same pinned parameters+environment+candidate
   * snapshot. It MUST NOT mutate Workplace/Flow state.
   */
  run(input: {
    readonly subjectCandidateSetRef: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly environmentRef: string | null;
    /** The immutable product snapshot (read-only view). */
    readonly candidateSnapshot: Readonly<Record<string, unknown>>;
  }): Promise<CheckProviderResult> | CheckProviderResult;
}

export type CheckProviderResult = CheckOutcome | {
  readonly outcome: CheckOutcome;
  /** Immutable/content-addressed evidence produced by the provider adapter. */
  readonly evidenceRefs: readonly string[];
};

// ---------------------------------------------------------------------------
// CheckReceipt (REG-17) — immutable evidence of one check run.
// ---------------------------------------------------------------------------

/**
 * Immutable receipt binding provider/version/environment to one check over one
 * CandidateSet, with a closed outcome and evidence refs.
 *
 * REG-17. Cannot be rebound to another set (REG-17-AC-01). A change of
 * provider/version/environment creates a NEW receipt (REG-17-AC-02). A
 * GateDecision cites the EXACT receipt refs it reduced (REG-17-AC-03), so
 * auditing the decision does not require rerunning the (possibly
 * nondeterministic) check (REG-17-AC-04).
 */
export interface CheckReceipt {
  readonly checkReceiptRef: string;
  /** The GateRun this receipt belongs to. */
  readonly checkRunRef: string;
  /** The CandidateSet the check ran over. */
  readonly subjectCandidateSetRef: string;
  /** Other assessment sets, when present (reviewer verdicts, etc.). */
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly check: CheckRef;
  readonly environmentRef: string | null;
  readonly outcome: CheckOutcome;
  /** Opaque evidence refs (log paths, artifact refs, observation refs). */
  readonly evidenceRefs: readonly string[];
  /** Digest over the canonical receipt body. */
  readonly receiptDigest: string;
}

// ---------------------------------------------------------------------------
// GateRun (REG-15) — one authorized inspection of one CandidateSet.
// ---------------------------------------------------------------------------

/** Which gate phase this run is for. */
export type GatePhase = 'author' | 'final';

/**
 * One authorized inspection of one exact CandidateSet by OTK.
 *
 * REG-15. One-shot: claim in `verifying` → receipts/decision → terminal. Has
 * its OWN lease and authority (REG-15-AC-01): a live worker fence is NOT
 * required at check time, because the GateRun reads immutable submit/seal
 * receipts that PROVE the worker's authority at commit time (REG-15-AC-02).
 * The gate reads a CandidateSet SNAPSHOT, never a mutable latest desk
 * (REG-15-AC-03). Retries are idempotent; a stale decision cannot clear a
 * newer revision (REG-15-AC-04, REG-18-AC-06).
 *
 * At most one mutation actor (`WorkerExecution` OR `GateRun`) may own a
 * Workplace revision at a time (REG-05-AC-02). Entering `verifying` claims the
 * GateRun; another worker cannot be leased until a terminal gate decision or
 * recovery transition wins the revision CAS.
 */
export interface GateRun {
  readonly gateRunRef: string;
  readonly workplaceRef: WorkplaceRef;
  readonly gatePhase: GatePhase;
  /** The author set under inspection. */
  readonly subjectCandidateSetRef: string;
  /** Reviewer assessment sets, when this is a final gate. */
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly checkPlanRef: string;
  readonly checkPlanDigest: string;
  /** Workplace revision the gate read; its decision must CAS-match this. */
  readonly expectedWorkplaceRevision: number;
  readonly gateLeaseRef: string;
  readonly state: 'claimed' | 'checking' | 'decided' | 'terminal';
}

// ---------------------------------------------------------------------------
// GateDecision (REG-18) — immutable domain decision. The heart of OTK.
// ---------------------------------------------------------------------------

/**
 * The closed verdict a gate may emit.
 *
 * REG-18. Additive-only in the lifetime of the model: a new verdict requires
 * changing this union AND the registry AND the decision-policy reducers. The
 * four values cover every OTK outcome:
 *
 *   - `accepted` — the subject CandidateSet passed. Author-gate acceptance
 *     leaves `acceptedOutputBindings` empty and pins the subject for review
 *     (REG-18-AC-02); only FINAL-gate acceptance may bind downstream output
 *     and finish the cell (REG-18-AC-03).
 *   - `repair_required` — a repairable defect. MUST name `repairTargetRole`
 *     (REG-18-AC-04); the coordinator never guesses the role from prose.
 *   - `human_required` — stop the line, call a person. Produces
 *     `blocked/paused` with a durable resume target (REG-22).
 *   - `failed` — explicit terminal failure. Not retryable; the cell ends.
 */
export type GateVerdict =
  | 'accepted'
  | 'repair_required'
  | 'human_required'
  | 'failed';

/**
 * Which role a repair must target.
 *
 * Required for `repair_required` (REG-18-AC-04). `author` returns the card to
 * `in_progress/repair_wait` (the authored product has a defect); `reviewer`
 * retries the reviewer role because the reviewer ATTEMPT was invalid, not the
 * author product (E2E-04 vs E2E-05 — two distinct transitions).
 */
export type RepairTargetRole = CandidateSetRole;

/**
 * Named binding → exact ProductRefs that a FINAL-gate acceptance publishes as
 * the cell's downstream output.
 *
 * REG-18-AC-02/03. Author-gate acceptance leaves this EMPTY (it only pins the
 * subject for review). Only a cell-final accepted decision may populate these
 * bindings and finish the current WorkItem. Downstream selectors consume
 * ProductRefs through accepted bindings, never by "latest worker" heuristics.
 */
export interface AcceptedOutputBinding {
  /** The binding name the downstream Flow node/selector expects. */
  readonly binding: string;
  /** Exact ProductRefs published under this binding. */
  readonly productRefs: readonly ProductRef[];
}

/**
 * The immutable act of OTK — only this may advance or repair a cell.
 *
 * REG-18. Append-only (REG-18-AC-05: decision persistence and Workplace
 * transition converge through an idempotent outbox; a crash between them does
 * not lose the decision and does not duplicate the transition). A stale or
 * superseded decision is retained as audit but cannot advance a newer revision
 * (REG-18-AC-06).
 *
 * `decisionKey` is deterministic over (workplace, gate phase, exact
 * subject/assessment sets, plan digest, policy digest) — replays produce the
 * same key; a different payload under the same key is rejected. This mirrors
 * the existing `ExactCandidateAcceptance` idempotency contract.
 */
export interface GateDecision {
  readonly workplaceRef: WorkplaceRef;
  readonly gateRef: string;
  readonly gateRunRef: string;
  readonly gatePhase: GatePhase;
  /** Opaque transition identifier (for the outbox event). */
  readonly transitionRef: string;
  /** The authored CandidateSet being accepted or rejected. */
  readonly subjectCandidateSetRef: string;
  /** Reviewer verdict sets, when present. */
  readonly assessmentCandidateSetRefs: readonly string[];
  readonly verdict: GateVerdict;
  /** REQUIRED when verdict=repair_required; MUST be null otherwise. */
  readonly repairTargetRole: RepairTargetRole | null;
  readonly checkPlanRef: string;
  readonly checkPlanDigest: string;
  readonly decisionPolicyRef: string;
  readonly decisionPolicyDigest: string;
  /** Exact receipt refs the policy reduced. */
  readonly checkReceiptRefs: readonly string[];
  /** Digest of the installed module package at decision time. */
  readonly installationDigest: string;
  /** Deterministic key over (workplace, phase, sets, plan, policy). */
  readonly decisionKey: string;
  /**
   * Downstream output bindings. EMPTY unless this is a cell-final `accepted`
   * decision (REG-18-AC-02/03).
   */
  readonly acceptedOutputBindings: readonly AcceptedOutputBinding[];
  /** Reference to a RecoveryIssue, when verdict=repair_required. */
  readonly recoveryIssueRef: string | null;
  /** Digest over the canonical decision body (excludes decisionKey itself). */
  readonly decisionDigest: string;
}

/**
 * Validate a GateDecision's cross-field rules (REG-18).
 *
 * Pure. Throws on any violation. Rules:
 *   - REG-18-AC-04: `verdict=repair_required` REQUIRES a non-null
 *     `repairTargetRole`; any other verdict REQUIRES it null.
 *   - REG-18-AC-02: `acceptedOutputBindings` is non-empty ONLY for
 *     `verdict=accepted`. (Author-gate acceptance leaves it empty; only
 *     final-gate accepted populates it — REG-18-AC-03. The phase distinction
 *     is the coordinator's job; here we only enforce that a non-accepted
 *     verdict never carries bindings.)
 *   - `recoveryIssueRef` is non-null ONLY for `verdict=repair_required`.
 *   - `decisionDigest` is a 64-char lowercase hex SHA-256.
 *
 * The phase-vs-bindings rule (author-gate accepted ≠ final-gate accepted) is
 * NOT checked here in full — it needs the GateRun's phase, which the
 * coordinator holds. The coordinator asserts it at apply time.
 */
export function assertValidGateDecision(decision: GateDecision): void {
  requireNonEmpty(decision.gateRef, 'gateRef');
  requireNonEmpty(decision.gateRunRef, 'gateRunRef');
  requireNonEmpty(decision.transitionRef, 'transitionRef');
  requireNonEmpty(decision.subjectCandidateSetRef, 'subjectCandidateSetRef');
  requireNonEmpty(decision.checkPlanRef, 'checkPlanRef');
  requireNonEmpty(decision.checkPlanDigest, 'checkPlanDigest');
  requireNonEmpty(decision.decisionPolicyRef, 'decisionPolicyRef');
  requireNonEmpty(decision.decisionPolicyDigest, 'decisionPolicyDigest');
  requireNonEmpty(decision.installationDigest, 'installationDigest');
  requireNonEmpty(decision.decisionKey, 'decisionKey');
  // REG-18-AC-04.
  if (decision.verdict === 'repair_required') {
    if (decision.repairTargetRole === null) {
      throw new Error(
        'REG-18-AC-04 violation: verdict=repair_required requires a non-null '
          + 'repairTargetRole (author | reviewer) — the coordinator never '
          + 'guesses the role from prose',
      );
    }
    if (decision.recoveryIssueRef === null) {
      throw new Error(
        'verdict=repair_required requires a recoveryIssueRef — the rejected '
          + 'decision must cite the structured RecoveryIssue the repair worker '
          + 'will read',
      );
    }
  } else {
    if (decision.repairTargetRole !== null) {
      throw new Error(
        `repairTargetRole must be null when verdict='${decision.verdict}' `
          + '(it is only meaningful for repair_required)',
      );
    }
    if (decision.recoveryIssueRef !== null) {
      throw new Error(
        `recoveryIssueRef must be null when verdict='${decision.verdict}'`,
      );
    }
  }
  // Bindings only on accepted (REG-18-AC-02/03 — phase distinction is the
  // coordinator's, but a non-accepted verdict never carries bindings).
  if (decision.verdict !== 'accepted' && decision.acceptedOutputBindings.length > 0) {
    throw new Error(
      `acceptedOutputBindings must be empty when verdict='${decision.verdict}' `
        + '(only accepted may publish downstream output)',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(decision.decisionDigest)) {
    throw new Error(
      'GateDecision.decisionDigest must be a 64-char lowercase hex SHA-256',
    );
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`GateDecision.${label} must be a non-empty string`);
  }
}

// Re-export CandidateSetRole for callers that import everything from this
// module's barrel — keeps `RepairTargetRole` resolvable without a second import.
export type { CandidateSet };
