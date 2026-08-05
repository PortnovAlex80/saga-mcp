/**
 * Generic protocol checkpoint application service.
 *
 * This is the application-layer entry point a `protocol_step_complete`
 * MCP tool contribution dispatches to. It is the ONLY place that:
 *
 *   1. loads the active ProtocolRun + the canonical NodeProtocolDefinition,
 *   2. confirms the step is the run's current step (stale-state rejection),
 *   3. runs the before-complete evidence gate (required evidence CANNOT be
 *      skipped),
 *   4. delegates the transition decision to the pure ProtocolRuntime state
 *      machine (linear / branch / repeat),
 *   5. persists the completed step + advances the run inside one atomic port
 *      call,
 *   6. records durable evidence on the step run,
 *   7. returns a typed, canonical-serializable result the tool layer forwards
 *      to the worker.
 *
 * It owns NO module semantics (no knowledge of "SRS", "proposal", "release").
 * Module-specific evidence meaning lives in the verifier binding the package
 * registers; this service only invokes that binding by reference.
 *
 * # Isolation (structural aliases)
 *
 * The sibling protocol lanes own: the `ProtocolRunRepository` port + types
 * + sqlite adapter, the pure transition state machine, and the evidence
 * categories + verifier registry. This file declares LOCAL STRUCTURAL PORT
 * INTERFACES mirroring those contracts verbatim so the file compiles in
 * isolation. The structural aliases are marked `LOCAL_ISOLATION_ALIAS` so a
 * future mechanical migration can find them. See
 * `docs/architecture/WAVE-LOG.md` (Wave 4) for the parallel-lane context.
 *
 * # Dependency direction (ratchet)
 *
 * `application/` → `persistence/` ports allowed (rule 2 only forbids this
 * from MODULE code; application core is permitted). `application/` →
 * `domain/` and `application/` → `domain/spi/` allowed. No imports from
 * `modules/`, `composition/`, or `infrastructure/`.
 */

import type {
  EvidenceCategory,
  NodeProtocolDefinition,
  ProtocolStep,
  ProtocolStepTransition,
} from '../domain/spi/node-protocol.js';
import type {
  ModuleToolContribution,
  ToolContractRef,
} from '../domain/spi/tool-contribution.js';

// ---------------------------------------------------------------------------
// Schema id constants (the tool contribution advertises these).
// ---------------------------------------------------------------------------

/**
 * Input contract for the `protocol_step_complete` MCP tool. A worker calls it
 * once per completed protocol step with the durable evidence it produced.
 */
export const PROTOCOL_STEP_COMPLETE_INPUT_SCHEMA =
  'factory.protocol.step-complete.input.v1' as const;

/**
 * Output contract for the `protocol_step_complete` MCP tool — the canonical
 * checkpoint receipt Runtime returns after persisting the step.
 */
export const PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA =
  'factory.protocol.step-complete.output.v1' as const;

/**
 * Stable logical id for the protocol step completion tool. Namespaced under
 * `runtime.protocol.*` so a module does not own it; Runtime contributes it on
 * behalf of every managed protocol.
 */
export const PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID =
  'runtime.protocol.step_complete' as const;

export const PROTOCOL_STEP_COMPLETE_TOOL_VERSION = '1.0.0' as const;

/**
 * Handler reference the runtime binds to the contributed tool. The handler
 * dispatches into {@link applyCheckpoint}. The string is opaque to the SPI
 * validator; the runtime resolves it.
 */
export const PROTOCOL_STEP_COMPLETE_HANDLER_REF =
  'runtime:protocol-checkpoint-service:applyCheckpoint' as const;

// ---------------------------------------------------------------------------
// Step-run + protocol-run status enums (mirror the schema CHECK constraints).
// ---------------------------------------------------------------------------

export const PROTOCOL_RUN_STATUSES = [
  'active',
  'paused',
  'completed',
  'failed',
  'abandoned',
] as const;
export type ProtocolRunStatus = typeof PROTOCOL_RUN_STATUSES[number];

export const PROTOCOL_STEP_RUN_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'skipped',
  'failed',
] as const;
export type ProtocolStepRunStatus = typeof PROTOCOL_STEP_RUN_STATUSES[number];

/** Terminal run statuses: no further step transitions are accepted. */
export const TERMINAL_PROTOCOL_RUN_STATUSES: ReadonlySet<ProtocolRunStatus> = new Set([
  'completed',
  'failed',
  'abandoned',
]);

/** Terminal step statuses: the step row is immutable. */
export const TERMINAL_STEP_RUN_STATUSES: ReadonlySet<ProtocolStepRunStatus> = new Set([
  'completed',
  'skipped',
  'failed',
]);

// ---------------------------------------------------------------------------
// LOCAL_ISOLATION_ALIAS — structural aliases for sibling-lane types.
//
// These mirror the field names of the persistence records (ProtocolRunRecord,
// ProtocolStepRunRecord) and the runtime/evidence contracts. They exist ONLY
// because the sibling lanes have not landed in this worktree. The integrator
// swaps them for real imports after cherry-pick; the field shapes are
// identical so call sites are unchanged.
// ---------------------------------------------------------------------------

/**
 * LOCAL_ISOLATION_ALIAS for the persistence `ProtocolRunRecord`.
 *
 * Mirrors the `factory_protocol_runs` columns. Field names are camelCase of
 * the SQL column names.
 */
export interface ProtocolRunRecord {
  readonly id: number;
  readonly processRunId: number;
  readonly nodeRunId: number | null;
  readonly nodeProtocolId: string;
  readonly nodeProtocolVersion: string;
  readonly entryStep: string;
  readonly currentStep: string | null;
  readonly status: ProtocolRunStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/**
 * LOCAL_ISOLATION_ALIAS for the persistence `ProtocolStepRunRecord`.
 *
 * Mirrors the `factory_protocol_step_runs` columns.
 */
export interface ProtocolStepRunRecord {
  readonly id: number;
  readonly protocolRunId: number;
  readonly stepId: string;
  readonly attempt: number;
  readonly status: ProtocolStepRunStatus;
  readonly evidenceJson: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/**
 * One piece of durable evidence a worker submits with a step-complete call.
 *
 * `category` is the standard Runtime category; Runtime understands the
 * category but never the domain meaning. `value` is the canonical evidence
 * payload (a tool receipt id, an artifact reference, a trace id, …) — its
 * shape is governed by the matching `EvidenceRequirement.contractRef` for
 * the step.
 */
export interface StepEvidenceItem {
  readonly category: EvidenceCategory;
  /** ContractRef this evidence claims to satisfy. */
  readonly contractRef: ToolContractRef;
  /**
   * Canonical-serializable evidence value. The verifier binding inspects it;
   * Runtime persists the canonical-JSON form verbatim and never interprets
   * the keys.
   */
  readonly value: unknown;
}

/**
 * Result of one before-complete evidence verification.
 *
 * LOCAL_ISOLATION_ALIAS — the real type lives in
 * `application/protocol-evidence.ts`. Field names match.
 */
export interface EvidenceVerificationResult {
  readonly ok: boolean;
  readonly missingCategories: readonly EvidenceCategory[];
  readonly failures: readonly EvidenceVerificationFailure[];
}

export interface EvidenceVerificationFailure {
  readonly category: EvidenceCategory;
  readonly contractRef: ToolContractRef;
  readonly reason: string;
}

/**
 * The next transition the ProtocolRuntime state machine selected for the run
 * after a step completes. LOCAL_ISOLATION_ALIAS.
 *
 *   `nextStep === null`     — the protocol has no further step; the run is
 *                             ready to be marked completed (caller decides).
 *   `nextStep === '<id>'`   — advance `currentStep` to this id.
 *   `transition`            — the matching ProtocolStepTransition (linear /
 *                             branch / repeat) the runtime selected. Null only
 *                             when the completed step was the terminal step
 *                             AND no outgoing transition exists.
 */
export interface ProtocolTransitionDecision {
  readonly nextStep: string | null;
  readonly transition: ProtocolStepTransition | null;
  readonly terminal: boolean;
}

/**
 * Verifier binding the package registers for a step.
 *
 * LOCAL_ISOLATION_ALIAS. The binding receives the canonical protocol step
 * definition and the worker-submitted evidence, and returns whether the step's
 * `evidenceRequirements` are satisfied. Runtime calls it by reference; it never
 * switches on `stepId` or category semantics itself.
 */
export type StepEvidenceVerifier = (
  step: ProtocolStep,
  evidence: readonly StepEvidenceItem[],
) => EvidenceVerificationResult;

// ---------------------------------------------------------------------------
// LOCAL_ISOLATION_ALIAS — the ProtocolRunRepository port.
//
// Mirror of the port surface owned by the persistence lane. Methods this
// service actually calls are spelled out; the rest are omitted (the real
// port has more methods — `startProtocol`, `pauseProtocol`, `resumeProtocol`,
// `readByExactStep`, `listSteps`, … — that this service does not invoke).
// The real port is a strict superset of this structural alias.
// ---------------------------------------------------------------------------

/**
 * Command shape for {@link ProtocolRunRepository.completeStep} — atomically
 * mark one step completed, persist its evidence, and advance the run's
 * `currentStep` to the runtime-selected next step (or mark the run completed
 * if the decision was terminal).
 */
export interface CompleteStepCommand {
  readonly protocolRunId: number;
  readonly stepId: string;
  readonly attempt: number;
  readonly evidence: readonly StepEvidenceItem[];
  readonly nextStep: string | null;
  readonly terminal: boolean;
}

export interface CompleteStepResult {
  readonly run: ProtocolRunRecord;
  readonly completedStep: ProtocolStepRunRecord;
}

/**
 * LOCAL_ISOLATION_ALIAS for the `ProtocolRunRepository` port. Only the
 * methods this service consumes are declared.
 */
export interface ProtocolRunRepository {
  readActiveProtocol(protocolRunId: number): ProtocolRunRecord | null;
  readStep(
    protocolRunId: number,
    stepId: string,
    attempt: number,
  ): ProtocolStepRunRecord | null;
  completeStep(command: CompleteStepCommand): CompleteStepResult;
}

/**
 * LOCAL_ISOLATION_ALIAS for the `NodeProtocolDefinition` resolver. The
 * runtime resolves `nodeProtocolId` + `nodeProtocolVersion` to the canonical
 * installed definition. In production this is backed by the package registry;
 * for tests it is a plain map.
 */
export interface NodeProtocolResolver {
  resolve(
    nodeProtocolId: string,
    nodeProtocolVersion: string,
  ): NodeProtocolDefinition | null;
}

/**
 * LOCAL_ISOLATION_ALIAS for the ProtocolRuntime transition resolver.
 *
 * Given the protocol definition and the just-completed step id, returns the
 * next step (or `terminal: true`). The pure state machine owns transition
 * validity (linear/branch/repeat, `isSupportedFlowCondition`); this service
 * only invokes it.
 */
export interface ProtocolTransitionResolver {
  decideNextStep(
    protocol: NodeProtocolDefinition,
    completedStepId: string,
  ): ProtocolTransitionDecision;
}

/**
 * LOCAL_ISOLATION_ALIAS for the evidence verifier registry. Looks up the
 * verifier binding registered for `(nodeProtocolId, stepId)`. Returns null when
 * no module verifier is registered — in that case Runtime falls back to the
 * standard category+contractRef shape check (see {@link defaultEvidenceVerifier}).
 */
export interface StepEvidenceVerifierRegistry {
  resolve(
    nodeProtocolId: string,
    stepId: string,
  ): StepEvidenceVerifier | null;
}

// ---------------------------------------------------------------------------
// Checkpoint result (the tool output contract body).
// ---------------------------------------------------------------------------

/**
 * Result of {@link applyCheckpoint}. This is the body of the
 * {@link PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA} receipt the tool layer returns
 * to the worker. Pure data; canonical-serializable.
 */
export interface CheckpointResult {
  readonly schemaVersion: typeof PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA;
  readonly protocolRunId: number;
  readonly processRunId: number;
  readonly nodeProtocolId: string;
  readonly nodeProtocolVersion: string;
  /** The step that was just checkpointed. */
  readonly completedStepId: string;
  readonly completedStepAttempt: number;
  readonly completedAt: string;
  /** True when this checkpoint was a no-op replay of an already-completed step. */
  readonly replayed: boolean;
  /** True when the run transitioned to `completed` as a result of this checkpoint. */
  readonly protocolCompleted: boolean;
  /**
   * The run's new current step, or null when the protocol is now complete.
   * The worker reads this to know what to do next (a fresh worker resumes
   * from durable Runtime rows).
   */
  readonly nextStep: string | null;
  readonly runStatus: ProtocolRunStatus;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Base class for all checkpoint failures. Carries a stable `code` the tool
 * layer maps to an MCP error. Subclasses are exposed for callers that want to
 * branch on the specific failure mode (tests, recovery routing).
 */
export abstract class CheckpointError extends Error {
  public abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The named ProtocolRun does not exist or is not in an active status. */
export class UnknownProtocolRunError extends CheckpointError {
  public readonly code = 'PROTOCOL_RUN_UNKNOWN';
  constructor(protocolRunId: number) {
    super(
      `PROTOCOL_RUN_UNKNOWN: no active protocol run with id ${protocolRunId}`,
    );
  }
}

/** The named step is not a member of the protocol definition. */
export class UnknownProtocolStepError extends CheckpointError {
  public readonly code = 'PROTOCOL_STEP_UNKNOWN';
  constructor(stepId: string, protocolId: string) {
    super(
      `PROTOCOL_STEP_UNKNOWN: step '${stepId}' is not declared by protocol '${protocolId}'`,
    );
  }
}

/**
 * The submitted step is not the run's `currentStep`. A stale worker (crashed,
 * resumed from an old envelope, or racing a second worker) tried to checkpoint
 * a step the run has already moved past. Rejected.
 */
export class StaleStepError extends CheckpointError {
  public readonly code = 'PROTOCOL_STEP_STALE';
  constructor(stepId: string, currentStep: string | null, runId: number) {
    super(
      `PROTOCOL_STEP_STALE: step '${stepId}' is not the current step of run ${runId}` +
        (currentStep ? ` (current='${currentStep}')` : ' (run has no current step)'),
    );
  }
}

/** The protocol run is terminal; no further checkpoints are accepted. */
export class TerminalProtocolRunError extends CheckpointError {
  public readonly code = 'PROTOCOL_RUN_TERMINAL';
  constructor(runId: number, status: ProtocolRunStatus) {
    super(
      `PROTOCOL_RUN_TERMINAL: run ${runId} is in terminal status '${status}' — checkpoint rejected`,
    );
  }
}

/** The target step row is already terminal (completed/skipped/failed). */
export class TerminalStepRunError extends CheckpointError {
  public readonly code = 'PROTOCOL_STEP_RUN_TERMINAL';
  constructor(stepId: string, attempt: number, status: ProtocolStepRunStatus) {
    super(
      `PROTOCOL_STEP_RUN_TERMINAL: step '${stepId}' attempt ${attempt} is already '${status}'`,
    );
  }
}

/** The step's required evidence was not satisfied. */
export class EvidenceGateError extends CheckpointError {
  public readonly code = 'PROTOCOL_EVIDENCE_GATE_FAILED';
  public readonly missingCategories: readonly EvidenceCategory[];
  public readonly failures: readonly EvidenceVerificationFailure[];
  constructor(result: EvidenceVerificationResult) {
    const missing = result.missingCategories.join(', ') || '<none>';
    const failureDetail = result.failures
      .map((f) => `${f.category}(${f.reason})`)
      .join('; ');
    super(
      `PROTOCOL_EVIDENCE_GATE_FAILED: missing required evidence categories [${missing}]` +
        (failureDetail ? `; failures: ${failureDetail}` : ''),
    );
    this.missingCategories = result.missingCategories;
    this.failures = result.failures;
  }
}

/** The installed protocol definition could not be resolved. */
export class UnknownProtocolDefinitionError extends CheckpointError {
  public readonly code = 'PROTOCOL_DEFINITION_UNKNOWN';
  constructor(nodeProtocolId: string, nodeProtocolVersion: string) {
    super(
      `PROTOCOL_DEFINITION_UNKNOWN: no installed definition for '${nodeProtocolId}@${nodeProtocolVersion}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default evidence verifier (standard category+contractRef shape check).
// ---------------------------------------------------------------------------

function contractRefsEqual(
  a: ToolContractRef,
  b: ToolContractRef,
): boolean {
  return (
    a.schemaId === b.schemaId &&
    a.version === b.version &&
    a.digest === b.digest
  );
}

/**
 * Default Runtime evidence verifier. Used when no module-specific verifier is
 * registered for `(nodeProtocolId, stepId)`.
 *
 * For each REQUIRED `EvidenceRequirement` on the step, the verifier requires at
 * least one submitted evidence item with the same category and a matching
 * contractRef. Optional requirements are NOT enforced (the worker MAY submit
 * them, but their absence is not a failure). Runtime understands the standard
 * category+contract shape; the module verifier (when registered) is the only
 * thing that can give that shape domain meaning.
 *
 * A module verifier that needs stricter semantics replaces this verifier via
 * the {@link StepEvidenceVerifierRegistry}.
 */
export function defaultEvidenceVerifier(
  step: ProtocolStep,
  evidence: readonly StepEvidenceItem[],
): EvidenceVerificationResult {
  const missingCategories: EvidenceCategory[] = [];
  const failures: EvidenceVerificationFailure[] = [];

  const required = step.evidenceRequirements.filter((r) => r.required);
  for (const req of required) {
    const matched = evidence.some(
      (item) =>
        item.category === req.category &&
        contractRefsEqual(item.contractRef, req.contractRef),
    );
    if (!matched) {
      missingCategories.push(req.category);
      failures.push({
        category: req.category,
        contractRef: req.contractRef,
        reason: 'no submitted evidence item matches this required category+contractRef',
      });
    }
  }

  return {
    ok: missingCategories.length === 0,
    missingCategories,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `PROTOCOL_CHECKPOINT_BAD_INPUT: ${name} must be a positive integer (got ${value})`,
    );
  }
}

function assertNonEmptyTrimmedString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(
      `PROTOCOL_CHECKPOINT_BAD_INPUT: ${name} must be a non-empty trimmed string`,
    );
  }
}

function findStep(
  protocol: NodeProtocolDefinition,
  stepId: string,
): ProtocolStep | null {
  for (const s of protocol.steps) {
    if (s.id === stepId) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// applyCheckpoint — the application-layer entry point.
// ---------------------------------------------------------------------------

/**
 * Arguments to {@link applyCheckpoint}. The `protocol_step_complete` MCP tool
 * contribution deserializes its input envelope into this shape and dispatches
 * here.
 */
export interface ApplyCheckpointArgs {
  readonly protocolRunId: number;
  readonly stepId: string;
  /** Attempt number the worker believes it is completing. Defaults to 1. */
  readonly attempt?: number;
  /** Durable evidence the worker produced for this step. May be empty. */
  readonly evidence?: readonly StepEvidenceItem[];
}

/**
 * Dependencies {@link applyCheckpoint} consumes. In production these are the
 * real sibling-lane services; in tests they are fakes/mocks.
 *
 * `now` is injectable so tests are deterministic. Defaults to ISO-now.
 */
export interface ApplyCheckpointDeps {
  readonly runs: ProtocolRunRepository;
  readonly protocols: NodeProtocolResolver;
  readonly transitions: ProtocolTransitionResolver;
  readonly verifiers: StepEvidenceVerifierRegistry;
  /** Injectable clock; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/**
 * Apply one protocol step completion checkpoint.
 *
 * Steps (each failure mode throws a typed {@link CheckpointError}):
 *
 *   1. Validate inputs.
 *   2. Load the active ProtocolRun; reject if missing or terminal.
 *   3. Resolve the canonical NodeProtocolDefinition; reject if missing.
 *   4. Confirm the submitted step exists in the protocol definition.
 *   5. Load the step run row; if it is already terminal, return an idempotent
 *      replay receipt (a resumed worker re-submitting the same checkpoint must
 *      not error, even if the run has since advanced past it). This check runs
 *      BEFORE the stale-step check so a lost receipt never blocks crash-resume.
 *   6. Confirm the submitted step IS the run's current step
 *      (stale-state rejection).
 *   7. Run the before-complete evidence gate. Reject if required evidence is
 *      missing (required evidence CANNOT be skipped).
 *   8. Ask the ProtocolRuntime for the next transition.
 *   9. Atomically persist: mark the step completed + its evidence + advance the
 *      run's currentStep (or mark the run completed if terminal).
 *  10. Return the canonical {@link CheckpointResult} receipt.
 *
 * Pure orchestration: no module semantics, no switching on stepId, no
 * interpretation of evidence `value` keys. Side effects are confined to the
 * {@link ProtocolRunRepository.completeStep} port call.
 */
export function applyCheckpoint(
  args: ApplyCheckpointArgs,
  deps: ApplyCheckpointDeps,
): CheckpointResult {
  // (1) Input validation.
  assertPositiveInteger(args.protocolRunId, 'protocolRunId');
  assertNonEmptyTrimmedString(args.stepId, 'stepId');
  const attempt = args.attempt ?? 1;
  assertPositiveInteger(attempt, 'attempt');
  const evidence = args.evidence ?? [];

  // (2) Load active run.
  const run = deps.runs.readActiveProtocol(args.protocolRunId);
  if (!run) {
    throw new UnknownProtocolRunError(args.protocolRunId);
  }
  if (TERMINAL_PROTOCOL_RUN_STATUSES.has(run.status)) {
    throw new TerminalProtocolRunError(run.id, run.status);
  }

  // (3) Resolve the canonical protocol definition.
  const protocol = deps.protocols.resolve(
    run.nodeProtocolId,
    run.nodeProtocolVersion,
  );
  if (!protocol) {
    throw new UnknownProtocolDefinitionError(
      run.nodeProtocolId,
      run.nodeProtocolVersion,
    );
  }

  // (4) Confirm the step is declared by the protocol.
  const step = findStep(protocol, args.stepId);
  if (!step) {
    throw new UnknownProtocolStepError(args.stepId, protocol.id);
  }

  // (5) Idempotent replay: a terminal step row means a resumed worker is
  // re-submitting a checkpoint that already succeeded. Return a replay receipt
  // rather than erroring — the protocol survives worker death. This check runs
  // BEFORE the stale-step check so a crash between persist and worker-receipt
  // never blocks the resume — the run may have already advanced past this
  // step, and the lost receipt must not be treated as a fresh (stale)
  // checkpoint.
  const existingStep = deps.runs.readStep(run.id, args.stepId, attempt);
  if (existingStep && TERMINAL_STEP_RUN_STATUSES.has(existingStep.status)) {
    // The run may have already advanced past this step. If so, the run's
    // currentStep reflects the post-checkpoint state; we report that.
    return {
      schemaVersion: PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA,
      protocolRunId: run.id,
      processRunId: run.processRunId,
      nodeProtocolId: run.nodeProtocolId,
      nodeProtocolVersion: run.nodeProtocolVersion,
      completedStepId: existingStep.stepId,
      completedStepAttempt: existingStep.attempt,
      completedAt: existingStep.completedAt ?? existingStep.createdAt,
      replayed: true,
      protocolCompleted: run.status === 'completed',
      nextStep: run.status === 'completed' ? null : run.currentStep,
      runStatus: run.status,
    };
  }

  // (6) Stale-state rejection: the submitted step must be the run's current.
  // (Only reached for non-terminal step rows; replays already returned above.)
  if (run.currentStep !== args.stepId) {
    throw new StaleStepError(args.stepId, run.currentStep, run.id);
  }

  // (7) Before-complete evidence gate.
  const verifier =
    deps.verifiers.resolve(protocol.id, args.stepId) ?? defaultEvidenceVerifier;
  const verdict = verifier(step, evidence);
  if (!verdict.ok) {
    throw new EvidenceGateError(verdict);
  }

  // (8) Ask the ProtocolRuntime for the next transition.
  const decision = deps.transitions.decideNextStep(protocol, args.stepId);

  // (9) Atomically persist step completion + run advance.
  const { run: updatedRun, completedStep } = deps.runs.completeStep({
    protocolRunId: run.id,
    stepId: args.stepId,
    attempt,
    evidence,
    nextStep: decision.nextStep,
    terminal: decision.terminal,
  });

  // (10) Build the canonical receipt.
  return {
    schemaVersion: PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA,
    protocolRunId: updatedRun.id,
    processRunId: updatedRun.processRunId,
    nodeProtocolId: updatedRun.nodeProtocolId,
    nodeProtocolVersion: updatedRun.nodeProtocolVersion,
    completedStepId: completedStep.stepId,
    completedStepAttempt: completedStep.attempt,
    completedAt: completedStep.completedAt ?? completedStep.createdAt,
    replayed: false,
    protocolCompleted: updatedRun.status === 'completed',
    nextStep: updatedRun.status === 'completed' ? null : updatedRun.currentStep,
    runStatus: updatedRun.status,
  };
}

// ---------------------------------------------------------------------------
// Tool contribution — the `protocol_step_complete` MCP tool Runtime registers.
// ---------------------------------------------------------------------------

/**
 * Stable zero-digest used for the tool contribution contract refs at
 * registration time. The real digests are computed by the
 * ContractSchemaRegistry when the schemas are pinned; until then the runtime
 * treats the contract refs as opaque. Using a fixed digest makes the
 * contribution canonical-serializable (a real digest is a 64-char hex string;
 * `'0'.repeat(64)` matches that shape).
 */
const PROVISIONAL_CONTRACT_DIGEST = '0'.repeat(64);

function provisionalContractRef(schemaId: string): ToolContractRef {
  return Object.freeze({
    schemaId,
    version: PROTOCOL_STEP_COMPLETE_TOOL_VERSION,
    digest: PROVISIONAL_CONTRACT_DIGEST,
  });
}

/**
 * The `protocol_step_complete` MCP tool contribution Runtime registers on
 * behalf of every managed NodeProtocol.
 *
 * A worker invokes this tool once per completed step. The runtime dispatches
 * the call into {@link applyCheckpoint} with the resolved
 * {@link ApplyCheckpointDeps}. The contribution itself is pure data; it does
 * not encode handler behavior — `handlerRef` names the dispatch target.
 *
 *   - `logicalId` is namespaced under `runtime.protocol.*` (Runtime-owned, not
 *     module-owned).
 *   - `idempotency` is `'idempotent'` because a resumed worker re-submitting
 *     the same (run, step, attempt) checkpoint returns a replay receipt, not
 *     an error.
 *   - `sideEffect` is `'write'` because the call persists step + evidence rows.
 *   - `guardBindings` is empty; the per-step authority guard attaches to the
 *     `'call'` scope when wired.
 */
export function buildProtocolStepCompleteToolContribution(): ModuleToolContribution {
  return {
    logicalId: PROTOCOL_STEP_COMPLETE_TOOL_LOGICAL_ID,
    version: PROTOCOL_STEP_COMPLETE_TOOL_VERSION,
    inputContractRef: provisionalContractRef(
      PROTOCOL_STEP_COMPLETE_INPUT_SCHEMA,
    ),
    outputContractRef: provisionalContractRef(
      PROTOCOL_STEP_COMPLETE_OUTPUT_SCHEMA,
    ),
    handlerRef: PROTOCOL_STEP_COMPLETE_HANDLER_REF,
    guardBindings: [],
    idempotency: 'idempotent',
    sideEffect: 'write',
  };
}
