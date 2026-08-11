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
 * The policy model has two modes:
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
  | {
      readonly mode: 'required';
      readonly validatorId: string;
      readonly contractRef?: ContractRef;
      /**
       * Require this exact WorkerExecution to publish at least one managed
       * artifact/trace contribution before worker_done. Prior executions on
       * the same Workplace are context, never current author testimony.
       */
      readonly requireManagedProduction?: boolean;
    }
  | { readonly mode: 'none'; readonly rationale: string };

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
  /** Human-actionable detail. Generic relation fields remain machine-readable. */
  readonly message?: string;
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
  | {
      readonly accepted: false;
      readonly code: string;
      readonly gaps: readonly SubmissionGap[];
      /** Validator-owned immutable context forwarded to durable recovery. */
      readonly details?: Readonly<Record<string, unknown>>;
    };

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
    public readonly details: Readonly<Record<string, unknown>> = {},
    public readonly validationContext: Readonly<Record<string, unknown>> = {},
  ) {
    const gapSummary = gaps.map(g =>
      g.message
        ?? `${g.artifactCode ?? g.artifactId}: missing ${g.missing.minimum}× ${g.missing.relation} → ${g.missing.requiredTargetTypes.join('|')}`,
    ).join('; ');
    const repairContext = renderRepairContext(details);
    super(`${code}: ${gapSummary}${repairContext}`);
    this.name = 'SubmissionValidationError';
  }
}

/**
 * MCP tool transports commonly reduce thrown errors to `Error.message`. Keep
 * the full structured details on the error/ledger, but mirror the small set of
 * author-critical contract keys into the message so a live worker can repair
 * in the same fenced execution instead of losing the schema at the adapter
 * boundary.
 */
function renderRepairContext(details: Readonly<Record<string, unknown>>): string {
  const lines: string[] = [];
  if (typeof details.decisionLogRepresentation === 'string' && details.decisionLogRepresentation.length > 0) {
    lines.push(`Decision Log representation: ${details.decisionLogRepresentation}`);
  }
  const decisionColumns = stringArray(details.requiredDecisionLogColumns);
  if (decisionColumns.length > 0) {
    lines.push(`Decision Log columns: ${decisionColumns.join(', ')}`);
  }
  if (typeof details.canonicalDecisionLogExample === 'string' && details.canonicalDecisionLogExample.length > 0) {
    lines.push(`Decision Log example:\n${details.canonicalDecisionLogExample.slice(0, 2_000)}`);
  }
  if (typeof details.representation === 'string' && details.representation.length > 0) {
    lines.push(`Required representation: ${details.representation}`);
  }
  const fields = stringArray(details.requiredD2Fields);
  if (fields.length > 0) lines.push(`Required fields: ${fields.join(', ')}`);
  const codes = stringArray(details.expectedAcCodes);
  if (codes.length > 0) lines.push(`Exact accepted codes: ${codes.join(', ')}`);
  if (typeof details.canonicalExample === 'string' && details.canonicalExample.length > 0) {
    lines.push(`Canonical example:\n${details.canonicalExample.slice(0, 4_000)}`);
  }
  return lines.length > 0 ? `\nValidator repair context:\n${lines.join('\n')}` : '';
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value
    : [];
}
