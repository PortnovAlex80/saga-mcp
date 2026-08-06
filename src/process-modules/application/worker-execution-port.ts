/**
 * W3-A7 — WorkerExecutionPort: driver-neutral generalization of
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md` §10.
 * Frozen input: `a415939` (Wave 2 checkpoint).
 *
 * ── Why this port exists ───────────────────────────────────────────────────
 *
 * `ensureExecutionPlan` / `createIntent` / `ensureProjectedTask` signatures
 * bake board/task/WorkIntent vocabulary (`epicId`, `projectId`, `taskKind`,
 * `workflowStage`, `generationKey`, `authorityScope.snapshot_ref`, …) into
 * first-class fields. That vocabulary belongs to the saga3 board driver, not
 * to the runtime core.
 *
 * Wave 3 DEFINES this driver-neutral port so that Wave 5 can adopt it fully:
 * every substrate-specific identifier (board id, task id, intent id, snapshot
 * ref, skill id, …) travels inside `adapterData: Record<string, unknown>`. The
 * runtime persists and forwards `adapterData` WITHOUT interpreting its keys —
 * exactly the same pattern `DriverNeutralExecutionReceipt.adapterData` uses
 * (plan §10.14, §13.16, C061).
 *
 * migrated here (Wave 5 does that, plan §16.9: each phase leaves the previous
 * path runnable). W3-A2 produces driver-neutral receipts against the A1 v2
 * context; this file is the type those two lanes consume.
 *
 * ── Driver-neutral vocabulary ──────────────────────────────────────────────
 *
 * Three concepts survive the generalization because they are NOT board vocab:
 *   - `intent`    — a durable, idempotent "do this work" handle. Every driver
 *                   has SOME notion of a resumable work item; the board driver
 *                   calls it WorkIntent, another driver may call it a job. The
 *                   runtime needs a stable handle to CAS-open → executing →
 *                   concluded against, regardless of substrate.
 *   - `execution` — one physical attempt of that work, identified by a fence
 *                   token (`executionId`). Crash-resume (§0.6.12) depends on
 *                   the runtime being able to read back the exact execution
 *                   that produced a managed product.
 *   - `receipt`   — the driver-neutral evidence that the attempt finished
 *                   (`DriverNeutralExecutionReceipt`, Wave 1).
 *
 * Everything else (skill ids, allowed tools, snapshot refs, task kinds,
 * workflow stages, repository ids) is substrate payload and lives in
 * `adapterData`.
 *
 * ── Purity / layering ─────────────────────────────────────────────────────
 *
 * This file lives in `application/` and is allowed (Rule 4) to import the Wave
 * 1 SPI barrel (`domain/spi/index.js`) and shared primitives. It defines NO
 * runtime behavior beyond a pure plan validator — concrete adapters are wired
 * by Wave 5. It deliberately does NOT import `persistence/` adapters, modules,
 * does not extend it, to keep the dependency direction clean).
 */

import type {
  ContractRef,
  DriverNeutralExecutionReceipt,
  ValidationResult,
} from '../domain/spi/index.js';
import type { ValidationError } from '../domain/spi/index.js';

// ---------------------------------------------------------------------------
// Re-exports for downstream consumers (W3-A1/A2 import from this file).
// ---------------------------------------------------------------------------

export type {
  ContractRef,
  ValidationResult,
  ValidationError,
  DriverNeutralExecutionReceipt,
} from '../domain/spi/index.js';

// ---------------------------------------------------------------------------
// Driver-neutral data shapes.
// ---------------------------------------------------------------------------

/**
 * The durable, idempotent "do this work" handle a driver creates/ensures
 * before spawning a worker.
 *
 * `adapterData` carries every substrate-specific parameter the driver needs to
 * project its work item (board: WorkIntent kind, authority scope, output
 * schema, token budget, retry budget; another driver: whatever it needs). The
 * runtime forwards it opaquely.
 *
 * `outputContract` is the ONE field lifted out of `adapterData` because the
 * runtime MUST validate the worker's product against it at the boundary
 * (§7.4.2, §10). It is a pure `ContractRef`, never a function.
 */
export interface WorkerIntentPlan {
  /**
   * Opaque substrate payload for intent creation. Board driver fills
   * { kind, objective, authorityScope, outputSchema, tokenBudget, retryBudget }.
   */
  readonly adapterData: Readonly<Record<string, unknown>>;
  /**
   * Contract the worker's PRODUCT must conform to (e.g. the proposal/output
   * schema). Validated at the boundary via `ContractBoundaryDecoder`.
   */
  readonly outputContract: ContractRef;
}

/**
 * The durable, idempotent projected-work handle a driver ensures against an
 * intent (one intent → one projected work item; restart must never create a
 * second).
 *
 * `adapterData` carries substrate projection parameters (board: taskKind,
 * executionSkill, reviewSkill, generationKey, workflowStage, executionMode,
 * titlePrefix, metadata lineage). `generationKey` is the idempotency key that
 * makes a restart reuse the same projected work item — it stays in
 * `adapterData` because its FORMAT is substrate-specific (the board driver
 * composes `process-run:…:node:…`).
 */
export interface WorkerProjectionPlan {
  /** Opaque substrate payload for work-item projection. */
  readonly adapterData: Readonly<Record<string, unknown>>;
}

/**
 * Input to `WorkerExecutionPort.prepareExecution`: the driver-neutral bundle a
 * driver builds before claiming/spawning a worker for one node.
 *
 * Pair of (intent plan, projection plan). Both are pure serializable records
 * (the driver constructs them; the runtime persists/hashes them). The runtime
 * does NOT interpret any key inside either `adapterData`.
 */
export interface WorkerExecutionPlan {
  readonly intent: WorkerIntentPlan;
  readonly projection: WorkerProjectionPlan;
}

/**
 * Result of `prepareExecution`: the durable ids the runtime uses to track the
 * work, plus whether this call replayed an already-concluded plan.
 *
 * `intentId` / `workItemId` are STRINGS (not numbers): a board driver emits
 * numeric ids serialized as strings; a non-board driver may emit opaque
 * handles. The runtime treats them as opaque tokens and never arithmeticizes
 * them. `replayed: true` means a prior run already created this pair and the
 * caller should treat the work as already-projected (resume path).
 */
export interface PreparedExecution {
  /** Opaque durable handle for the intent (board: WorkIntent id as string). */
  readonly intentId: string;
  /** Opaque durable handle for the projected work item (board: task id). */
  readonly workItemId: string;
  /** True iff this (intent, work item) pair already existed (idempotent replay). */
  readonly replayed: boolean;
}

/**
 * Preparation status the port returns from `readExecutionState`. Mirrors the
 * branches on `status`, the driver fills `adapterData` with whatever else it
 * needs (current execution fence, latest managed-production execution, …).
 */
export type WorkerExecutionStateStatus =
  | 'ready'
  | 'active'
  | 'blocked'
  | 'done';

/**
 * Driver-neutral read of one work item's execution state.
 *
 * `status` is the runtime-visible branch point. `intentStatus` is the opaque
 * substrate status string the driver CAS-machines against (board: the
 * `factory_work_intents.status` literal like 'open'/'executing'/'concluded').
 */
export interface WorkerExecutionState {
  readonly status: WorkerExecutionStateStatus;
  readonly intentStatus: string;
  /**
   * Opaque substrate read-outs the driver needs to build a receipt
   * (current execution fence, latest execution id, latest managed-production
   * execution id, task state, …). The runtime forwards without interpreting.
   */
  readonly adapterData: Readonly<Record<string, unknown>>;
}

/**
 * Driver-neutral CAS request: transition the intent from `expected` substrate
 * status to `next` substrate status. Returns false if the CAS failed (a
 * concurrent driver won the claim) — the runtime then treats the node as
 * paused, not failed.
 */
export interface IntentStatusTransition {
  readonly expected: string;
  readonly next: string;
}

/**
 * Driver-neutral input to `sealReceipt`: the substrate evidence the driver
 * collected during the poll loop, packaged for the runtime to persist as a
 * `DriverNeutralExecutionReceipt`.
 *
 * `runtimeEvent` / `driverKind` / `attempt` are runtime-visible (the receipt
 * base fields). `nodeRunId` is the durable NodeRun this receipt belongs to.
 * Everything else goes in `adapterData`.
 */
export interface WorkerExecutionOutcome {
  /** Durable NodeRun id this outcome seals. */
  readonly nodeRunId: number;
  /** 1-based attempt within the node run. */
  readonly attempt: number;
  /** Physical status of the attempt. */
  readonly runtimeEvent: 'completed' | 'failed' | 'paused';
  /**
   * Which FlowNodeKind drove the execution ('lm' | 'kernel' | 'human' |
   * 'external' | 'composite'). Lifted out of adapterData because it is a
   * runtime routing concern, not substrate payload.
   */
  readonly driverKind: string;
  /** Opaque substrate payload (board: intentId/taskId/executionId/replayed). */
  readonly adapterData: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// PORT — WorkerExecutionPort.
// ---------------------------------------------------------------------------

/**
 *
 * Wave 3 DEFINES this port; Wave 5 adopts it fully (the board driver implements
 * it, the LM executor consumes it). The concrete board implementation produced
 * by Wave 5 will adapt the existing `SqliteFactory*Runtime` projection surface —
 * same SQL, same CAS semantics — behind this driver-neutral vocabulary.
 *
 *   ensureExecutionPlan(...)        → prepareExecution(plan)
 *   createIntent(...)               → (folded into prepareExecution's intent path)
 *   ensureProjectedTask(...)        → (folded into prepareExecution's projection path)
 *   setProjectedTask(...)           → (internal to prepareExecution's replay)
 *   bindProjectedTaskProcessContext → bindProcessContext (adapterData carries lineage)
 *   setIntentStatus(id, exp, next)  → transitionIntentStatus(handle, transition)
 *   prepareIntentForExecution(...)  → readExecutionState(workItemId)
 *   readTaskState(taskId)           → (folded into readExecutionState.adapterData)
 *   readCurrentExecutionId(taskId)  → (folded into readExecutionState.adapterData)
 *   readLatestExecutionId(taskId)   → (folded into readExecutionState.adapterData)
 *   readLatestManagedProduction…    → (folded into readExecutionState.adapterData)
 *   readTaskProjectRepositoryId     → (folded into bindProcessContext / adapterData)
 *
 * The idempotent "ensure pair" semantics of `ensureExecutionPlan` are preserved:
 * `prepareExecution` MUST be atomic (a restart must never create a new intent
 * and then reuse a work item bound to an older intent). The implementation is
 * the driver's responsibility; this port only declares the contract.
 */
export interface WorkerExecutionPort {
  /**
   * Atomically ensure the (intent, projected work item) pair exists for this
   * plan and return their durable handles. Idempotent: a replay of the same
   * plan returns the same pair with `replayed: true`.
   *
   * The runtime calls this BEFORE claiming/spawning a worker. A concurrent
   * driver that loses the subsequent CAS must not allocate a second work item.
   */
  prepareExecution(plan: WorkerExecutionPlan): PreparedExecution;

  /**
   * Stamp server-owned ProcessRun/node lineage onto an exact projected work
   * item. `adapterData` carries the lineage bag (board: process_run_id,
   * process_node_id, process_module_ref, process_input_hash, process_node_input,
   * process_node_input_hash, project_repository_id, recovery_*). The driver
   * rejects attempts to rebind an existing work item to another run.
   *
   * Optional on the port: a driver that has no server-owned lineage to stamp
   * (a non-board driver) may omit the implementation; the runtime feature-
   * detects via `port.bindProcessContext`.
   */
  bindProcessContext?(input: {
    readonly workItemId: string;
    readonly adapterData: Readonly<Record<string, unknown>>;
  }): void;

  /**
   * Read the execution state of one work item. The runtime branches on
   * `status`; `adapterData` carries every substrate read-out the driver needs
   * to build a receipt (current execution fence, latest execution id, latest
   * managed-production execution id, task state, project_repository_id).
   */
  readExecutionState(workItemId: string): WorkerExecutionState;

  /**
   * CAS the intent status from `expected` to `next`. Returns false on CAS
   * failure (concurrent driver won) — the runtime then treats the node as
   * paused, not failed. `intentId` is the opaque handle from
   * `prepareExecution`.
   */
  transitionIntentStatus(
    intentId: string,
    transition: IntentStatusTransition,
  ): boolean;
}

// ---------------------------------------------------------------------------
// Receipt sealing (separate concern: persists a DriverNeutralExecutionReceipt).
// ---------------------------------------------------------------------------

/**
 * Result of sealing a receipt: the persisted receipt and its canonical content
 * hash (so crash-resume §0.6.12 can byte-compare the resumed receipt against
 * the pre-crash one).
 */
export interface SealedReceipt {
  readonly receipt: DriverNeutralExecutionReceipt;
  /** SHA-256 over the canonical JSON of `receipt`. */
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// Pure plan validator.
// ---------------------------------------------------------------------------

/**
 * Validate a `WorkerExecutionPlan` structurally (driver-neutral). This is the
 * ONLY behavior this file owns — concrete adapters are Wave 5's job.
 *
 * Checks:
 *   - `intent` and `projection` are plain objects.
 *   - each `adapterData` is a plain object (the runtime persists/hashes it;
 *     a non-plain value would mis-hash and break crash-resume byte-equality).
 *   - `intent.outputContract`, when present, is a structurally valid
 *     `ContractRef` (three non-empty strings). Deep schema validation against
 *     the registered codec is `ContractBoundaryDecoder`'s job, not this one.
 *
 * Returns a Wave 1 `ValidationResult` so callers reuse the same error shape.
 * This function is synchronous and pure — it does not touch the registry.
 */
export function validateWorkerExecutionPlan(
  value: unknown,
): ValidationResult {
  const errors: ValidationError[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: [
        {
          code: 'NOT_OBJECT',
          path: '$',
          message: 'WorkerExecutionPlan must be a plain object',
        },
      ],
    };
  }

  const plan = value as Record<string, unknown>;
  const intent = plan.intent;
  const projection = plan.projection;

  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
    errors.push({
      code: 'BAD_INTENT',
      path: 'intent',
      message: 'intent must be a plain object',
    });
  } else {
    const i = intent as Record<string, unknown>;
    if (
      typeof i.adapterData !== 'object' ||
      i.adapterData === null ||
      Array.isArray(i.adapterData)
    ) {
      errors.push({
        code: 'BAD_ADAPTER_DATA',
        path: 'intent.adapterData',
        message: 'intent.adapterData must be a plain object',
      });
    }
    if (i.outputContract === null || i.outputContract === undefined) {
      errors.push({
        code: 'OUTPUT_CONTRACT_REQUIRED',
        path: 'intent.outputContract',
        message: 'intent.outputContract is required',
      });
    } else {
      const refRes = validateContractRefShape(i.outputContract);
      if (!refRes.ok) {
        for (const e of refRes.errors) {
          errors.push({
            code: e.code,
            path: `intent.outputContract.${e.path}`,
            message: e.message,
          });
        }
      }
    }
  }

  if (
    typeof projection !== 'object' ||
    projection === null ||
    Array.isArray(projection)
  ) {
    errors.push({
      code: 'BAD_PROJECTION',
      path: 'projection',
      message: 'projection must be a plain object',
    });
  } else {
    const p = projection as Record<string, unknown>;
    if (
      typeof p.adapterData !== 'object' ||
      p.adapterData === null ||
      Array.isArray(p.adapterData)
    ) {
      errors.push({
        code: 'BAD_ADAPTER_DATA',
        path: 'projection.adapterData',
        message: 'projection.adapterData must be a plain object',
      });
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Validate the SHAPE of a `ContractRef` (three non-empty strings). Does NOT
 * consult a registry — deep schema validation is `ContractBoundaryDecoder`'s
 * job. Pure and synchronous.
 */
export function validateContractRefShape(value: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: [
        {
          code: 'NOT_OBJECT',
          path: '$',
          message: 'ContractRef must be a plain object',
        },
      ],
    };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.schemaId !== 'string' || v.schemaId.length === 0) {
    errors.push({
      code: 'BAD_SCHEMA_ID',
      path: 'schemaId',
      message: 'schemaId must be a non-empty string',
    });
  }
  if (typeof v.version !== 'string' || v.version.length === 0) {
    errors.push({
      code: 'BAD_VERSION',
      path: 'version',
      message: 'version must be a non-empty string',
    });
  }
  if (typeof v.digest !== 'string' || v.digest.length === 0) {
    errors.push({
      code: 'BAD_DIGEST',
      path: 'digest',
      message: 'digest must be a non-empty string',
    });
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
