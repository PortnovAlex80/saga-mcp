/**
 * W4-A2 — ProtocolRuntime: pure transition state machine for one NodeProtocol.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md
 * Task: docs/refactor-management/05-subagent-tasks/W04-a2.md
 * Plan: §8.2 (NodeProtocol), §8.3 (ProtocolRun lifecycle), §0.7.11 (exit gate).
 *
 * A ProtocolRuntime advances ONE durable ProtocolRun forward through the steps
 * of a NodeProtocolDefinition (Wave 1 SPI). It owns the transition state
 * machine only:
 *
 *   startStep       — pending → in_progress for the protocol's current step.
 *   checkEvidence   — verify required evidence is present before completion
 *                     (C026/§8.4 — required evidence MUST NOT be skippable).
 *   completeStep    — in_progress → completed and advance current_step using
 *                     the protocol's declared transitions (linear/branch/
 *                     repeat). Refuses to advance when required evidence is
 *                     missing, when the step is not in_progress, or when the
 *                     protocol run is not active.
 *   retryStep       — re-enter an in_progress or failed step at attempt+1.
 *   pauseProtocol   — active → paused (crash-safe checkpoint; the run can be
 *                     resumed at the exact last incomplete step).
 *   resumeProtocol  — paused → active and re-enter the recorded current_step.
 *   handleRecovery  — apply a runtime-owned RecoveryAction (plan §8.10) to a
 *                     protocol run. The runtime owns HOW recovery affects the
 *                     step cursor; the module owns WHY (the RecoveryIssue).
 *
 * Module-agnostic: never switches on module names, never interprets evidence
 * semantics (only its required/optional flag). Validates every transition
 * against the NodeProtocolDefinition and rejects illegal moves with a typed
 * error. No side effects beyond the injected ProtocolRunRepository port.
 *
 * Ownership: W4-A2 owns this file exclusively. The ProtocolRunRepository port
 * is owned by W4-A1; until A1 lands, we declare the port locally (W4-A2 is
 * parallel to A1, spec §1 lane table). When A1 lands the local declaration is
 * removed and the import is taken from the persistence port module — the
 * runtime's imports of these symbols are identical either way.
 */

import type {
  EvidenceCategory,
  EvidenceRequirement,
  NodeProtocolDefinition,
  ProtocolStep,
  ProtocolStepTransition,
} from '../domain/spi/node-protocol.js';
import type { RecoveryAction } from '../domain/spi/recovery-definitions.js';

// ---------------------------------------------------------------------------
// Forward-declared persistence port (W4-A1 owns the canonical copy).
// ---------------------------------------------------------------------------

/**
 * Status of one durable ProtocolRun (mirrors factory_protocol_runs.status).
 *
 *   'active'     — running, may accept step transitions.
 *   'paused'     — checkpointed; resumable at the recorded current_step.
 *   'completed'  — every step reached 'completed' (terminal, write-once).
 *   'failed'     — terminal failure (e.g. exhausted retries, fatal recovery).
 *   'abandoned'  — terminal; recovery escalated beyond the run's budget.
 */
export type ProtocolRunStatus = 'active' | 'paused' | 'completed' | 'failed' | 'abandoned';

/**
 * Status of one ProtocolStepRun (mirrors factory_protocol_step_runs.status).
 */
export type ProtocolStepRunStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'failed';

/** Durable snapshot of the evidence attached to one step attempt. */
export interface ProtocolStepEvidence {
  readonly category: EvidenceCategory;
  readonly contractRef: string;
  readonly value: unknown;
}

/** Durable ProtocolRun record (read-only projection of the DB row). */
export interface ProtocolRunRecord {
  readonly id: number;
  readonly processRunId: number;
  readonly nodeRunId: number | null;
  readonly nodeProtocolId: string;
  readonly nodeProtocolVersion: string;
  readonly entryStep: string;
  readonly currentStep: string | null;
  readonly status: ProtocolRunStatus;
  /** 1-based attempt counter for the CURRENT step (resets on each new step). */
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** Durable ProtocolStepRun record. */
export interface ProtocolStepRunRecord {
  readonly id: number;
  readonly protocolRunId: number;
  readonly stepId: string;
  readonly attempt: number;
  readonly status: ProtocolStepRunStatus;
  readonly evidence: readonly ProtocolStepEvidence[];
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/**
 * Persistence port for ProtocolRun + ProtocolStepRun. Owned by W4-A1
 * (`persistence/protocol-run.ts`). Declared locally here so W4-A2 can compile
 * and ship in parallel; the integrator reconciles after both lanes land.
 */
export interface ProtocolRunRepository {
  /** Read the protocol run by id; null if absent. */
  read(runId: number): ProtocolRunRecord | null;

  /**
   * Atomically transition the run's status and current step cursor.
   * Throws on illegal transitions, missing rows, or stale-state writes
   * (e.g. write to a terminal run). Mirrors ProcessRunRepository.update.
   */
  transition(
    runId: number,
    input: {
      status?: ProtocolRunStatus;
      currentStep?: string | null;
      attempt?: number;
      completedAt?: string | null;
    },
  ): ProtocolRunRecord;

  /** Insert or update one step run (UNIQUE on (protocolRunId, stepId, attempt)). */
  upsertStep(
    runId: number,
    stepId: string,
    attempt: number,
    input: {
      status: ProtocolStepRunStatus;
      evidence?: readonly ProtocolStepEvidence[];
      completedAt?: string | null;
    },
  ): ProtocolStepRunRecord;

  /** Read the step run for one (run, step, attempt); null if absent. */
  readStep(runId: number, stepId: string, attempt: number): ProtocolStepRunRecord | null;

  /** Read all step runs for one (run, step), ordered by attempt ASC. */
  listStepAttempts(runId: number, stepId: string): readonly ProtocolStepRunRecord[];

  /** Read every step run for the run, ordered by creation ASC. */
  listSteps(runId: number): readonly ProtocolStepRunRecord[];
}

// ---------------------------------------------------------------------------
// Result and error types.
// ---------------------------------------------------------------------------

/** A positive outcome from a runtime operation. */
export interface ProtocolRuntimeOk<T extends ProtocolRunRecord | ProtocolStepRunRecord> {
  readonly ok: true;
  readonly run: ProtocolRunRecord;
  readonly step?: ProtocolStepRunRecord;
  readonly detail?: T;
}

/** Evidence check verdict: which requirements are unsatisfied, and why. */
export interface EvidenceCheckResult {
  readonly satisfied: boolean;
  readonly missing: readonly EvidenceRequirement[];
}

export type ProtocolRuntimeErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_ACTIVE'
  | 'RUN_PAUSED'
  | 'RUN_NOT_PAUSED'
  | 'RUN_TERMINAL'
  | 'STEP_NOT_FOUND'
  | 'STEP_NOT_IN_PROGRESS'
  | 'STEP_ALREADY_COMPLETED'
  | 'EVIDENCE_REQUIRED_MISSING'
  | 'NO_OUTGOING_TRANSITION'
  | 'ILLEGAL_TRANSITION'
  | 'ILLEGAL_RECOVERY_ACTION'
  | 'RECOVERY_ENTRY_UNKNOWN'
  | 'ATTEMPT_EXHAUSTED';

/**
 * Typed error thrown by the runtime. The `code` field makes failures
 * programmatic (the executor can switch on it without parsing the message).
 */
export class ProtocolRuntimeError extends Error {
  readonly code: ProtocolRuntimeErrorCode;
  constructor(code: ProtocolRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolRuntimeError';
    this.code = code;
  }
}

function fail(code: ProtocolRuntimeErrorCode, message: string): never {
  throw new ProtocolRuntimeError(code, message);
}

// ---------------------------------------------------------------------------
// Pure helpers over the protocol definition.
// ---------------------------------------------------------------------------

function assertRunActive(run: ProtocolRunRecord): void {
  if (run.status === 'paused') {
    fail('RUN_PAUSED', `ProtocolRun ${run.id} is paused; call resumeProtocol first.`);
  }
  if (run.status !== 'active') {
    fail(
      'RUN_TERMINAL',
      `ProtocolRun ${run.id} is in terminal status '${run.status}'; no further transitions allowed.`,
    );
  }
}

function findStep(def: NodeProtocolDefinition, stepId: string): ProtocolStep {
  const step = def.steps.find((s) => s.id === stepId);
  if (!step) {
    fail('STEP_NOT_FOUND', `Protocol "${def.id}" has no step "${stepId}".`);
  }
  return step;
}

/**
 * Resolve the outgoing transition from `from` whose `kind` is accepted and
 * whose `condition` is supported by the current flow-condition ratchet
 * (Wave 1: only `undefined` — i.e. unconditional — is supported; any opaque
 * condition string is rejected at install time, so at runtime every
 * transition we see is unconditional and deterministic).
 *
 *   linear  — exactly one unconditional `to`.
 *   branch  — multiple unconditional transitions from the same step are a
 *             structural defect (Wave 1 ratchet forbids conditions, so a
 *             branch with two unconditional targets is non-deterministic).
 *             Wave 7 widens this when declarative predicates land.
 *   repeat  — the step loops back to itself; completion does not advance
 *             current_step (the LM must call retryStep or end the loop some
 *             other way). For now, repeat from A→A is treated as "stay".
 *
 * Returns null when there is no outgoing transition (terminal step within
 * the protocol — completing it ends the run).
 */
function resolveOutgoing(
  def: NodeProtocolDefinition,
  from: string,
): ProtocolStepTransition | null {
  const outgoing = def.transitions.filter((t) => t.from === from);
  if (outgoing.length === 0) return null;
  if (outgoing.length === 1) return outgoing[0];
  // Multiple unconditional transitions from one step is a non-deterministic
  // branch — invalid under the Wave 1 ratchet. ValidateNodeProtocolDefinition
  // catches this at install; we still defend at runtime.
  fail(
    'ILLEGAL_TRANSITION',
    `Step "${from}" in protocol "${def.id}" has ${outgoing.length} outgoing ` +
      `transitions; the Wave 1 ratchet forbids conditions, so a branch with ` +
      `more than one unconditional target is non-deterministic.`,
  );
}

/**
 * Check the evidence attached to one step attempt against the step's declared
 * requirements. Returns the list of UNSATISFIED requirements (required only —
 * optional requirements never block completion).
 */
export function checkStepEvidence(
  step: ProtocolStep,
  evidence: readonly ProtocolStepEvidence[],
): EvidenceCheckResult {
  const have = new Set(evidence.map((e) => `${e.category}|${e.contractRef}`));
  const missing = step.evidenceRequirements.filter(
    (req) => req.required && !have.has(`${req.category}|${req.contractRef}`),
  );
  return { satisfied: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// ProtocolRuntime — the state machine.
// ---------------------------------------------------------------------------

export interface ProtocolRuntimeDeps {
  readonly repository: ProtocolRunRepository;
  /**
   * Injected clock so tests are deterministic. Defaults to ISO-now. The
   * repository stores whatever this returns in `updated_at` / `completed_at`.
   */
  readonly now?: () => string;
}

export class ProtocolRuntime {
  private readonly repository: ProtocolRunRepository;
  private readonly now: () => string;

  constructor(deps: ProtocolRuntimeDeps) {
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // startStep — pending → in_progress for the run's current step.
  // -------------------------------------------------------------------------

  /**
   * Begin work on the run's `currentStep` (or the entryStep if currentStep is
   * null). Inserts/opens a ProtocolStepRun at the run's current attempt.
   * Idempotent: if a step run is already in_progress for this attempt it is
   * returned unchanged.
   */
  startStep(
    def: NodeProtocolDefinition,
    runId: number,
  ): ProtocolRuntimeOk<ProtocolStepRunRecord> {
    const run = this.requireRun(runId);
    assertRunActive(run);
    const stepId = run.currentStep ?? run.entryStep;
    if (run.currentStep === null) {
      // First start of the run: pin the cursor to the entry step.
      const pinned = this.repository.transition(runId, { currentStep: stepId });
      return this.openStep(def, pinned, stepId);
    }
    return this.openStep(def, run, stepId);
  }

  private openStep(
    def: NodeProtocolDefinition,
    run: ProtocolRunRecord,
    stepId: string,
  ): ProtocolRuntimeOk<ProtocolStepRunRecord> {
    // Validate the step exists in the protocol (defense in depth; the cursor
    // is set by us so this should always pass).
    findStep(def, stepId);
    const attempt = run.attempt;
    const existing = this.repository.readStep(run.id, stepId, attempt);
    if (existing && existing.status === 'in_progress') {
      return { ok: true, run, step: existing, detail: existing };
    }
    if (existing && existing.status === 'completed') {
      fail(
        'STEP_ALREADY_COMPLETED',
        `Step "${stepId}" attempt ${attempt} of run ${run.id} is already completed.`,
      );
    }
    const step = this.repository.upsertStep(run.id, stepId, attempt, {
      status: 'in_progress',
    });
    return { ok: true, run, step, detail: step };
  }

  // -------------------------------------------------------------------------
  // checkEvidence — gate completion on required evidence (§8.4 / C026).
  // -------------------------------------------------------------------------

  /**
   * Check the evidence attached to the current step attempt. Pure read; does
   * not mutate state. Returns the unsatisfied required requirements.
   */
  checkEvidence(
    def: NodeProtocolDefinition,
    runId: number,
  ): EvidenceCheckResult {
    const run = this.requireRun(runId);
    const stepId = run.currentStep ?? run.entryStep;
    const stepRun = this.repository.readStep(run.id, stepId, run.attempt);
    if (!stepRun) {
      return {
        satisfied: false,
        missing: findStep(def, stepId).evidenceRequirements.filter((r) => r.required),
      };
    }
    return checkStepEvidence(findStep(def, stepId), stepRun.evidence);
  }

  // -------------------------------------------------------------------------
  // completeStep — in_progress → completed + advance current_step.
  // -------------------------------------------------------------------------

  /**
   * Mark the run's current step attempt completed and advance the cursor to
   * the next step (or 'completed' if there is no outgoing transition).
   *
   * Refuses when:
   *   - the run is not active,
   *   - the current step is not in_progress,
   *   - required evidence is missing (C026 — required evidence CANNOT be
   *     skipped; call retryStep or pauseProtocol instead).
   */
  completeStep(
    def: NodeProtocolDefinition,
    runId: number,
    evidence?: readonly ProtocolStepEvidence[],
  ): ProtocolRuntimeOk<ProtocolRunRecord> {
    const run = this.requireRun(runId);
    assertRunActive(run);
    const stepId = run.currentStep ?? run.entryStep;
    const step = findStep(def, stepId);
    const stepRun = this.repository.readStep(run.id, stepId, run.attempt);
    if (!stepRun || stepRun.status !== 'in_progress') {
      fail(
        'STEP_NOT_IN_PROGRESS',
        `Step "${stepId}" attempt ${run.attempt} of run ${run.id} is not in_progress ` +
          `(call startStep first; got status ${stepRun?.status ?? 'absent'}).`,
      );
    }

    // C026: required evidence MUST NOT be skippable. We check the union of
    // already-attached evidence and any new evidence passed to this call so a
    // caller can attach-and-complete in one operation.
    const mergedEvidence = evidence ? mergeEvidence(stepRun.evidence, evidence) : stepRun.evidence;
    const check = checkStepEvidence(step, mergedEvidence);
    if (!check.satisfied) {
      fail(
        'EVIDENCE_REQUIRED_MISSING',
        `Step "${stepId}" of run ${run.id} cannot complete: required evidence missing ` +
          `(${check.missing.map((m) => m.category).join(', ')}).`,
      );
    }

    // Commit step completion + merged evidence.
    const completedStep = this.repository.upsertStep(run.id, stepId, run.attempt, {
      status: 'completed',
      evidence: mergedEvidence,
      completedAt: this.now(),
    });

    // Resolve next step.
    const transition = resolveOutgoing(def, stepId);
    if (transition === null) {
      // Terminal step within the protocol → run completes.
      const completedRun = this.repository.transition(run.id, {
        status: 'completed',
        completedAt: this.now(),
      });
      return { ok: true, run: completedRun, step: completedStep, detail: completedRun };
    }

    // repeat: step loops to itself; do NOT advance cursor, but bump attempt
    // counter is left to retryStep. A repeat transition with kind='repeat'
    // whose target is the same step means "this step is iterative; the LM
    // decides when to stop". We treat completion of a repeat step as a no-op
    // advance: the cursor stays, attempt stays. The next startStep will open
    // the SAME step run (already completed) → caller MUST call retryStep to
    // bump attempt before starting again.
    if (transition.kind === 'repeat' && transition.to === stepId) {
      return { ok: true, run, step: completedStep, detail: run };
    }

    // linear/branch (Wave 1: only unconditional linear is reachable): advance.
    const advancedRun = this.repository.transition(run.id, {
      currentStep: transition.to,
      attempt: 1,
    });
    return { ok: true, run: advancedRun, step: completedStep, detail: advancedRun };
  }

  // -------------------------------------------------------------------------
  // retryStep — re-enter the current step at attempt+1.
  // -------------------------------------------------------------------------

  /**
   * Bump the attempt counter and open a fresh in_progress step run for the
   * current step. Used when the LM produced a RecoveryIssue and the runtime
   * chose 'retry-current-node' (handleRecovery) or when the LM explicitly
   * wants to retry without going through recovery.
   *
   * Refuses when:
   *   - the run is not active,
   *   - an attempt budget is supplied and would be exceeded.
   */
  retryStep(
    def: NodeProtocolDefinition,
    runId: number,
    options?: { maxAttempts?: number },
  ): ProtocolRuntimeOk<ProtocolStepRunRecord> {
    const run = this.requireRun(runId);
    assertRunActive(run);
    const stepId = run.currentStep ?? run.entryStep;
    findStep(def, stepId);
    const nextAttempt = run.attempt + 1;
    const max = options?.maxAttempts;
    if (max !== undefined && nextAttempt > max) {
      fail(
        'ATTEMPT_EXHAUSTED',
        `Step "${stepId}" of run ${run.id} would exceed maxAttempts ${max} ` +
          `(next attempt ${nextAttempt}).`,
      );
    }
    const bumped = this.repository.transition(run.id, { attempt: nextAttempt });
    const step = this.repository.upsertStep(run.id, stepId, nextAttempt, {
      status: 'in_progress',
    });
    return { ok: true, run: bumped, step, detail: step };
  }

  // -------------------------------------------------------------------------
  // pauseProtocol / resumeProtocol — crash-safe checkpoint.
  // -------------------------------------------------------------------------

  /**
   * Checkpoint the run. The current_step and attempt are preserved so a
   * resume re-enters the exact last incomplete step. Idempotent: pausing an
   * already-paused run returns it unchanged.
   */
  pauseProtocol(_def: NodeProtocolDefinition, runId: number): ProtocolRuntimeOk<ProtocolRunRecord> {
    const run = this.requireRun(runId);
    if (run.status === 'paused') {
      return { ok: true, run, detail: run };
    }
    if (run.status !== 'active') {
      fail(
        'RUN_TERMINAL',
        `ProtocolRun ${run.id} is in status '${run.status}'; only active runs can pause.`,
      );
    }
    const paused = this.repository.transition(run.id, { status: 'paused' });
    return { ok: true, run: paused, detail: paused };
  }

  /**
   * Resume a paused run. Returns the run to 'active' and re-opens the
   * recorded current_step at the recorded attempt (idempotent on the step
   * run: if one is already in_progress it is reused).
   */
  resumeProtocol(
    def: NodeProtocolDefinition,
    runId: number,
  ): ProtocolRuntimeOk<ProtocolStepRunRecord> {
    const run = this.requireRun(runId);
    if (run.status !== 'paused') {
      fail(
        'RUN_NOT_PAUSED',
        `ProtocolRun ${run.id} is in status '${run.status}'; only paused runs can resume.`,
      );
    }
    const resumed = this.repository.transition(run.id, { status: 'active' });
    return this.openStep(def, resumed, resumed.currentStep ?? resumed.entryStep);
  }

  // -------------------------------------------------------------------------
  // handleRecovery — apply a runtime-owned RecoveryAction (§8.10).
  // -------------------------------------------------------------------------

  /**
   * Apply one of the seven runtime-owned RecoveryActions to a protocol run.
   * The runtime owns HOW the action moves the cursor; the module owns WHY
   * (the RecoveryIssue that triggered this call).
   *
   *   'retry-current-node'  → retryStep (bump attempt, reopen current step).
   *   'return-to-producer'  → not step-level; recorded as a paused run for
   *                            the orchestrator to route feedback upstream.
   *                            (The runtime cannot decide which producer;
   *                            that requires flow-graph context owned by the
   *                            executor — Wave 5 wires this.)
   *   'enter-recovery-node' → jump the cursor to a declared recovery entry
   *                            step (def.recoveryEntrySteps) and reopen it.
   *   'request-human'       → pause the run (park for a human decision).
   *   'pause-external'      → pause the run (mirror external pause).
   *   'escalate'            → abandon the run (escalated beyond budget).
   *   'terminate'           → fail the run.
   *
   * The optional `recoveryStep` argument names the target step for
   * 'enter-recovery-node'; it MUST be one of def.recoveryEntrySteps.
   */
  handleRecovery(
    def: NodeProtocolDefinition,
    runId: number,
    action: RecoveryAction,
    options?: { recoveryStep?: string; maxAttempts?: number },
  ): ProtocolRuntimeOk<ProtocolRunRecord | ProtocolStepRunRecord> {
    const run = this.requireRun(runId);
    // All recovery actions require a non-terminal run. paused is acceptable
    // for the route actions (we resume-then-act).
    if (run.status !== 'active' && run.status !== 'paused') {
      fail(
        'RUN_TERMINAL',
        `ProtocolRun ${run.id} is in status '${run.status}'; recovery cannot act on a terminal run.`,
      );
    }

    switch (action) {
      case 'retry-current-node': {
        // Resume if paused, then bump attempt + reopen current step.
        const active = run.status === 'paused' ? this.resume(def, run) : run;
        return this.retryStep(def, active.id, { maxAttempts: options?.maxAttempts });
      }

      case 'return-to-producer': {
        // The runtime cannot route to a producer without flow-graph context.
        // Pause so the executor (Wave 5 wiring) can route the feedback
        // upstream and re-enter the producer node. This is the only action
        // that defers routing — the others are fully step-level.
        if (run.status === 'active') {
          const paused = this.repository.transition(run.id, { status: 'paused' });
          return { ok: true, run: paused, detail: paused };
        }
        return { ok: true, run, detail: run };
      }

      case 'enter-recovery-node': {
        const target = options?.recoveryStep;
        if (target === undefined) {
          // Pick the first declared recovery entry step if none was named.
          if (def.recoveryEntrySteps.length === 0) {
            fail(
              'RECOVERY_ENTRY_UNKNOWN',
              `Protocol "${def.id}" declares no recoveryEntrySteps; cannot enter-recovery-node.`,
            );
          }
          return this.jumpToRecoveryStep(def, run, def.recoveryEntrySteps[0]);
        }
        if (!def.recoveryEntrySteps.includes(target)) {
          fail(
            'RECOVERY_ENTRY_UNKNOWN',
            `Step "${target}" is not in protocol "${def.id}" recoveryEntrySteps ` +
              `[${def.recoveryEntrySteps.join(', ')}].`,
          );
        }
        return this.jumpToRecoveryStep(def, run, target);
      }

      case 'request-human':
      case 'pause-external': {
        if (run.status === 'paused') {
          return { ok: true, run, detail: run };
        }
        const paused = this.repository.transition(run.id, { status: 'paused' });
        return { ok: true, run: paused, detail: paused };
      }

      case 'escalate': {
        const abandoned = this.repository.transition(run.id, {
          status: 'abandoned',
          completedAt: this.now(),
        });
        return { ok: true, run: abandoned, detail: abandoned };
      }

      case 'terminate': {
        const failed = this.repository.transition(run.id, {
          status: 'failed',
          completedAt: this.now(),
        });
        return { ok: true, run: failed, detail: failed };
      }

      default: {
        // Exhaustiveness check: if RecoveryAction gains a member and we
        // forget to handle it, this fires at compile time AND runtime.
        const exhaustive: never = action;
        fail(
          'ILLEGAL_RECOVERY_ACTION',
          `Unhandled RecoveryAction "${String(exhaustive)}" for run ${run.id}.`,
        );
      }
    }
  }

  private resume(def: NodeProtocolDefinition, run: ProtocolRunRecord): ProtocolRunRecord {
    const result = this.resumeProtocol(def, run.id);
    return result.run;
  }

  private jumpToRecoveryStep(
    def: NodeProtocolDefinition,
    run: ProtocolRunRecord,
    targetStep: string,
  ): ProtocolRuntimeOk<ProtocolStepRunRecord> {
    findStep(def, targetStep);
    // Ensure active first (recovery may fire while paused).
    const active = run.status === 'paused' ? this.resume(def, run) : run;
    const jumped = this.repository.transition(active.id, {
      currentStep: targetStep,
      attempt: 1,
    });
    const step = this.repository.upsertStep(jumped.id, targetStep, 1, {
      status: 'in_progress',
    });
    return { ok: true, run: jumped, step, detail: step };
  }

  // -------------------------------------------------------------------------
  // Shared lookup.
  // -------------------------------------------------------------------------

  private requireRun(runId: number): ProtocolRunRecord {
    const run = this.repository.read(runId);
    if (!run) {
      fail('RUN_NOT_FOUND', `ProtocolRun ${runId} not found.`);
    }
    return run;
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Merge two evidence lists, de-duplicating on (category, contractRef). Later
 * entries win (last-write-wins on the value).
 */
function mergeEvidence(
  base: readonly ProtocolStepEvidence[],
  additions: readonly ProtocolStepEvidence[],
): readonly ProtocolStepEvidence[] {
  const map = new Map<string, ProtocolStepEvidence>();
  for (const e of base) map.set(`${e.category}|${e.contractRef}`, e);
  for (const e of additions) map.set(`${e.category}|${e.contractRef}`, e);
  return [...map.values()];
}
