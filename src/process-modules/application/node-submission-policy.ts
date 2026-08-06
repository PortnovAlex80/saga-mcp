/**
 * Mandatory node submission validation policy.
 *
 * Every LM-node MUST declare a submission policy. The absence of a declaration
 * is a configuration error (`SUBMISSION_VALIDATION_POLICY_MISSING`), not a
 * silent bypass. This closes the root cause of the formalization AC
 * repair-loop: the domain invariant (every AC derives from an exact FR/NFR
 * and UC) existed only in the post-hoc resolver, never at the worker_done
 * boundary where the LM could be told it was incomplete before leaving.
 *
 * The policy model has three modes:
 *
 *   required            — a validator is registered and MUST accept before
 *                         worker_done transitions the task. Rejection leaves
 *                         the worker as the execution owner and returns
 *                         structured gaps so the LM can fix and retry without
 *                         burning a recovery epoch.
 *
 *   none                — the node legitimately has no domain-level result
 *                         contract (e.g. a pure control node). The rationale
 *                         is declared and logged; worker_done proceeds.
 *
 *   legacy-unvalidated  — the node has a real result contract that has not
 *                         been migrated to a `required` validator yet.
 *                         Allowed (with a telemetry warning) so existing
 *                         modules keep working, but forbidden for new modules
 *                         (enforced by an architecture test).
 */

// ---------------------------------------------------------------------------
// Policy declaration.
// ---------------------------------------------------------------------------

/**
 * The submission policy for one LM-node, keyed by `(moduleRef, nodeId)`.
 *
 * Registration is mandatory: a node without a registered policy is rejected
 * at worker_done time (`SUBMISSION_VALIDATION_POLICY_MISSING`). This forces
 * every module author to make an explicit decision about validation rather
 * than relying on the absence of a validator as an implicit "anything goes".
 */
export type NodeSubmissionPolicy =
  | { readonly mode: 'required'; readonly validatorId: string; readonly contractRef?: ContractRef }
  | { readonly mode: 'none'; readonly rationale: string }
  | { readonly mode: 'legacy-unvalidated'; readonly migrationTicket: string };

// ---------------------------------------------------------------------------
// Structured rejection.
// ---------------------------------------------------------------------------

/**
 * One gap in a rejected submission. The worker receives a list of these and
 * can fix all of them in one retry, rather than discovering them one at a
 * time through post-hoc resolver rounds.
 */
export interface SubmissionGap {
  readonly artifactId: number;
  readonly artifactCode: string | null;
  readonly artifactType: string;
  readonly existingTargets: ReadonlyArray<{ readonly type: string; readonly id: number }>;
  readonly missing: {
    readonly relation: string;
    readonly requiredTargetTypes: ReadonlyArray<string>;
    readonly minimum: number;
  };
}

// ---------------------------------------------------------------------------
// Receipt.
// ---------------------------------------------------------------------------

/**
 * Content-addressed contract reference. Carries the version + digest of the
 * canonical contract a validator was built against. Stamped on the validation
 * input (so the validator can detect version mismatch) and on the receipt
 * (provenance: which contract version accepted this submission).
 */
export interface ContractRef {
  readonly version: string;
  readonly digest: string;
}

/**
 * Durable proof that a validator accepted a submission. Persisted in the same
 * transaction as the task transition so a crash between validation and
 * transition cannot leave a validated-but-not-transitioned (or vice-versa)
 * state.
 *
 * The `validatedSetDigest` covers the exact artifact ids + their content
 * hashes and trace ids + trace digest the validator examined, so a later
 * mutation (artifact content changed, trace added/removed) is detectable by
 * recomputing the digest against the current state and comparing. ID-only
 * digests (the previous shape) could not detect content mutation — the IDs
 * stayed the same while the bytes changed.
 */
export interface SubmissionValidationReceipt {
  readonly validatorId: string;
  readonly validatorVersion: string;
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly taskId: number;
  readonly inputSnapshotHash: string;
  readonly artifactIds: readonly number[];
  readonly traceIds: readonly number[];
  /**
   * Content hashes of the artifacts examined, keyed by artifact id (string).
   * Captured at validation time so a post-hoc content mutation is detectable
   * without relying on the artifact row's mutable `content_hash`.
   */
  readonly artifactHashes: Readonly<Record<string, string>>;
  /**
   * Canonical digest of the trace set examined. Empty string when the
   * validator examined no traces.
   */
  readonly traceDigest: string;
  readonly validatedSetDigest: string;
  /**
   * The contract version this validator ran under, if the validator is
   * version-pinned. Provenance for replay: a receipt stamped under contract
   * v2.2 proves the validation ran against the v2.2 canonical contract.
   */
  readonly contractRef?: ContractRef;
  readonly validatedAt: string;
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

export type NodeSubmissionValidationResult =
  | { readonly accepted: true; readonly receipt: SubmissionValidationReceipt }
  | { readonly accepted: false; readonly code: string; readonly gaps: readonly SubmissionGap[] };

// ---------------------------------------------------------------------------
// Validator port.
// ---------------------------------------------------------------------------

/**
 * A module-owned validator. Resolved by `validatorId` from the registry.
 *
 * The validator is PURE with respect to the process state: it reads artifacts,
 * traces and the contract snapshot from the database, applies domain rules,
 * and returns a structured result. It MUST NOT mutate the task, transition
 * the workplace, or call worker_done — it is a gate, not an actor.
 */
export interface NodeSubmissionValidator {
  readonly validatorId: string;
  readonly validatorVersion: string;
  validate(input: NodeSubmissionValidationInput): NodeSubmissionValidationResult;
}

export interface NodeSubmissionValidationInput {
  readonly processRunId: number;
  readonly moduleRef: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly taskId: number;
  readonly epicId: number;
  readonly projectId: number;
  /**
   * The contract version pinned on the execution profile, if any. When
   * present, a version-pinned validator compares this ref against its own
   * canonical contract ref and rejects with `*_CONTRACT_VERSION_MISMATCH`
   * if they differ — detecting the case where the author produced an
   * artifact under one contract version and the validator is checking
   * under another. When absent, the validator skips the version check
   * (backward-compatible with unpinned profiles).
   */
  readonly contractRef?: ContractRef;
}

// ---------------------------------------------------------------------------
// Registries.
// ---------------------------------------------------------------------------

/**
 * Maps `validatorId` → validator instance. Modules register their validators
 * at composition time.
 */
export interface NodeSubmissionValidatorRegistry {
  resolve(validatorId: string): NodeSubmissionValidator | null;
  register(validator: NodeSubmissionValidator): void;
}

/**
 * Maps `(moduleRef, nodeId)` → policy. Modules register policies for every
 * LM-node they own at composition time.
 */
export interface NodeSubmissionPolicyRegistry {
  resolve(moduleRef: string, nodeId: string): NodeSubmissionPolicy | null;
  register(moduleRef: string, nodeId: string, policy: NodeSubmissionPolicy): void;
}

// ---------------------------------------------------------------------------
// Concrete in-memory registry implementations.
// ---------------------------------------------------------------------------

export class InMemoryNodeSubmissionValidatorRegistry implements NodeSubmissionValidatorRegistry {
  private readonly validators = new Map<string, NodeSubmissionValidator>();
  resolve(validatorId: string): NodeSubmissionValidator | null {
    return this.validators.get(validatorId) ?? null;
  }
  register(validator: NodeSubmissionValidator): void {
    this.validators.set(validator.validatorId, validator);
  }
}

export class InMemoryNodeSubmissionPolicyRegistry implements NodeSubmissionPolicyRegistry {
  private readonly policies = new Map<string, NodeSubmissionPolicy>();
  resolve(moduleRef: string, nodeId: string): NodeSubmissionPolicy | null {
    return this.policies.get(`${moduleRef}::${nodeId}`) ?? null;
  }
  register(moduleRef: string, nodeId: string, policy: NodeSubmissionPolicy): void {
    this.policies.set(`${moduleRef}::${nodeId}`, policy);
  }
}

// ---------------------------------------------------------------------------
// Error.
// ---------------------------------------------------------------------------

/**
 * Thrown by the worker_done handler when a `required` validator rejects.
 * Carries the structured gaps so the MCP response can surface them to the
 * LM worker, which then knows exactly what to fix.
 */
export class SubmissionValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly gaps: readonly SubmissionGap[],
  ) {
    const gapSummary = gaps.map(g =>
      `${g.artifactCode ?? g.artifactId}: missing ${g.missing.minimum}× ${g.missing.relation} → ${g.missing.requiredTargetTypes.join('|')}`,
    ).join('; ');
    super(`${code}: ${gapSummary}`);
    this.name = 'SubmissionValidationError';
  }
}
