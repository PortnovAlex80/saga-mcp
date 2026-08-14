/**
 * NodeExecutor — порт исполнителя одного типа flow-узлов.
 *
 * Universal ProcessModuleRuntime диспатчит каждый узел по `node.kind` через
 * соответствующий NodeExecutor. Один NodeExecutor на kind: lm / kernel /
 * human / external / composite.
 *
 * NodeExecutor НЕ знает, какой модуль исполняется, — только тип узла.
 * Предметное содержание (schemas, policies, skills, intent-kind строки)
 * поставляется через `module` (ProcessModuleDefinition) и payload узла.
 *
 * Это и есть граница «Runtime = физика»: NodeExecutor читает descriptor, но
 * не содержит ни одной ссылки на module-specific символы. Discovery Pack
 * подключает своё содержание через KernelHandlerRegistry (для kernel-узлов)
 * и через ExecutionProfileDefinition (для lm-узлов), а не через новые ветки
 * здесь.
 */

import type {
  FlowNodeDefinition,
  FlowNodeKind,
  ProcessModuleDefinition,
} from '../domain/process-module.js';
import type { RecoveryIssue } from '../domain/recovery.js';
import type { ExactCandidateAcceptanceReceipt } from './exact-candidate-acceptance.js';
import type { ManagedNodeSubmissionRecord } from './managed-node-submission.js';
// Driver-neutral SPI types from the pure-SPI layer. Type-only import — these
// are pure data types (interfaces) defined under domain/spi/. No runtime edge;
// application→domain is allowed.
import type {
  DriverNeutralExecutionReceipt,
  ExecutionContextEnvelope,
  ModuleCompletion,
  NodeProductionEnvelope,
} from '../domain/spi/index.js';

/**
 * Контекст исполнения одного узла.
 *
 * `input` уже декодирован и провалидирован上层 (GenericFlowExecutor) против
 * `node.inputSchema` — NodeExecutor получает готовый payload.
 */
export interface NodeExecutionContext {
  projectId: number;
  epicId: number | null;
  processRunId: number;
  /** Полный descriptor модуля — для доступа к executionProfiles, policies, … */
  module: ProcessModuleDefinition;
  /** Исполняемый узел (lm/kernel/human/external/composite). */
  node: FlowNodeDefinition;
  /** Декодированный вход узла. */
  input: unknown;
  /**
   * Durable data frame reconstructed from every completed NodeRun. Consumers
   * address products by producer node id instead of relying on a mutable bag
   * copied through every intermediate node.
   */
  frame: NodeExecutionFrame;
  /** Renew the ProcessRun single-driver lease during long node execution. */
  heartbeat: () => void;
  /** Идентификатор инициатора для аудита. */
  initiatedBy: string;
  /**
   * OPTIONAL driver-neutral execution envelope. Present only when the
   * GenericFlowExecutor's v2 wiring is active (the run was started with v2
   * NodeRun columns and an ExecutionContextAssembler is configured). v2-aware
   * read `ctx.frame` (which is populated via buildExecutionFrame when
   * execution-context surface.
   */
  readonly envelope?: ExecutionContextEnvelope;
  /**
   * OPTIONAL upstream product bodies loaded by exact `ProductRef`. Present
   * alongside `envelope` when the v2 path is active; forwarded to the node's
   */
  readonly upstreamProductBodies?: readonly unknown[];
  /**
   * CGAD P18 — centralized node-scoped worker products of this node's exact
   * immediate producer, read before invoking a kernel handler. Contains the
   * latest managed artifacts, traces, and submission produced by that Workplace
   * regardless of which worker (task) produced them. Kernel handlers read this
   * instead of querying the ledger themselves, so every module inherits P18
   * automatically and no future module can reintroduce a task-scoped read.
   */
  readonly nodeProducts?: NodeProducts;
}

/**
 * Durable worker products for one workplace (node), centralized by the executor
 * (CGAD P18). Each array is scoped by process_run + module + node, never by
 * task — so a gate can never be blinded to a prior worker's product.
 */
export interface NodeProducts {
  /** Latest managed artifacts written by the LM node (formalization-style). */
  readonly artifacts: readonly ManagedArtifactWriteSummary[];
  /** Latest managed traces written by the LM node. */
  readonly traces: readonly ManagedTraceWriteSummary[];
  /** Latest typed submission written by the LM node (development/discovery-style). */
  readonly submission: ManagedNodeSubmissionRecord | null;
}

export interface ManagedArtifactWriteSummary {
  readonly ledgerId: number;
  readonly artifactId: number;
  readonly artifactType: string;
  readonly artifactStatus: string;
  readonly contentHash: string;
  readonly operation: string;
}

export interface ManagedTraceWriteSummary {
  readonly ledgerId: number;
  readonly traceId: number;
  readonly sourceId: number;
  readonly targetType: string;
  readonly targetId: number;
  readonly linkType: string;
  readonly traceHash: string;
}

/**
 * Результат исполнения узла.
 *
 * Разделяем ФИЗИЧЕСКИЙ результат исполнения (runtime) и ПРЕДМЕТНОЕ событие
 * (domain). Это критично для authoritative settlement (см. корректировку
 * архитектора от 2026-07-26):
 *
 *   runtimeEvent — физический статус исполнения узла. Всегда присутствует.
 *                  LM executor задаёт только его ('completed'|'failed'|'paused').
 *                  Kernel handler тоже может его задать (обычно 'completed').
 *
 *   domainEvent  — предметное событие (только для kernel-узлов и terminal
 *                  outcome-emitter'ов). LM executor НЕ задаёт domainEvent —
 *                  он не знает предметной семантики. Примеры:
 *                  'accepted', 'semantic-ambiguity', 'go', 'clarify', 'reject'.
 *
 *   production   — durable типизированная ссылка на продукцию узла (см. Д3).
 *                  Никаких сырых объектов или {taskId, intentId}.
 *
 * Flow transitions явно различают префиксы:
 *   'runtime.completed' / 'runtime.failed'
 *   'domain.accepted'   / 'domain.go' / 'domain.clarify'
 *   '*' — wildcard default-edge.
 *
 * Для terminal outcome-emitter'а outcome код берётся из `node.emitsOutcome`
 * (это уже так) — domainEvent = `outcome:<code>`, runtimeEvent = 'completed'.
 */
export interface NodeExecutionResult {
  runtimeEvent: 'completed' | 'failed' | 'paused';
  domainEvent?: string;
  /**
   * Physical execution evidence. LM/external/human executors return a receipt;
   * they MUST NOT pretend that a completed task is the module's domain product.
   * A module-owned resolver kernel consumes this receipt, reads the canonical
   * module store, and emits NodeProduction.
   */
  receipt?: NodeExecutionReceipt;
  production?: NodeProduction;
  /**
   * Standard module-authored issue. Core treats reasonCode/findings as opaque
   * and only interprets the declared recovery policy.
   */
  recoveryIssue?: RecoveryIssue;
  /** Immutable common-gate decision linked to this node execution. */
  acceptanceReceipt?: ExactCandidateAcceptanceReceipt;
  /** Только для terminal-узлов (outcome-emitter). */
  outcome?: string;
  /**
   * OPTIONAL explicit terminal envelope. When a terminal node returns
   * `completion`, settlement reads `completion.outputEnvelope` /
   * `completion.outputEnvelope.certificateRef` directly instead of extracting
   * certificate fields from opaque `production.bindings.certificatePayload`.
   */
  completion?: ModuleCompletion;
  /**
   * OPTIONAL driver-neutral production envelope. When present, the
   * GenericFlowExecutor dual-writes it to the NodeRun v2
   * only `production` behave identically.
   */
  productionEnvelope?: NodeProductionEnvelope;
  /**
   * OPTIONAL driver-neutral execution receipt. When present, dual-written to
   */
  driverReceipt?: DriverNeutralExecutionReceipt;
}

/**
 * Module-agnostic evidence that one physical node execution finished.
 *
 * `inputBindings` are an opaque snapshot supplied by the preceding module
 * preparation node. Runtime persists and forwards them, but never interprets
 * domain keys such as proposalId or controlIntentId.
 */
export interface NodeExecutionReceipt {
  kind: 'task-execution';
  executorKind: FlowNodeKind;
  intentId: number;
  taskId: number;
  /** Exact worker execution fence when the substrate exposes it. */
  executionId: string | null;
  runtimeStatus: 'completed' | 'failed' | 'paused';
  replayed: boolean;
}

export interface NodeExecutionFrame {
  runInput: unknown;
  productions: Record<string, NodeProduction>;
  receipts: Record<string, NodeExecutionReceipt>;
}

/**
 * Durable типизированная ссылка на продукцию узла.
 *
 * НЕ сырой объект, НЕ внутренние runtime-ID. Это контракт между узлами: узел A
 * возвращает production, узел B (или settlement kernel) читает из неё exact
 * bindings и перечитывает каноническую строку из БД.
 *
 *   schema       — schema id продукции (например 'factory.discovery-proposal.v1').
 *   artifactRef  — opaque ссылка на продукцию (например 'proposal:141').
 *   contentHash  — SHA-256 над каноническим телом продукции (immutable).
 *   bindings     — machine-filled параметры для downstream-узлов:
 *                  { proposalId, proposalHash, workIntentId, assessmentId, ... }.
 *                  Discovery Pack знает, как их интерпретировать.
 */
export interface NodeProduction {
  schema: string;
  artifactRef: string;
  contentHash: string;
  /**
   * Cross-run-stable semantic digest of this production (CONVEYOR v4.3 §5-6).
   *
   * Authored by the producer from KNOWN semantic material (cell/contract
   * identity, stable item identity, canonical ProductRefs as
   * `{ schemaId, digest }`). It MUST exclude run-specific provenance
   * (WorkplaceRef, processRunId, CandidateSetRef, presenterExecutionRef,
   * task/intent row ids, timestamps, transient paths). `contentHash` above
   * remains the current-run audit hash and may carry provenance; this field
   * is the cross-run replay identity.
   *
   * Downstream fan-out WorkKey derivation and ReplayKey semanticInputDigest
   * use this (falling back to contentHash only when a producer has not yet
   * authored one). Optional so non-cell producers are not broken, but a
   * Production Cell manifest always sets it.
   */
  semanticDigest?: string;
  /**
   * Machine-filled параметры для downstream-узлов. Значения — примитивы
   * (string/number/boolean) ИЛИ вложенные объекты (например certificatePayload
   * — полный envelope, который settlement kernel сформировал и Runtime должен
   * атомарно сохранить без реконструкции). Это не arbitrary JSON — модуль
   * обязан класть сюда только то, что downstream kernel/Runtime умеет читать.
   */
  bindings: Record<string, unknown>;
}

/**
 * Свести (runtimeEvent, domainEvent) в одну строку для Flow transition matching.
 * Приоритет: domainEvent (если есть) > runtimeEvent. Префиксы 'domain.'/'runtime.'
 * добавляются, чтобы descriptor мог различать физический статус и предметное
 * решение. '*' остаётся wildcard.
 */
export function nodeEventForTransition(result: NodeExecutionResult): string {
  // Pause is a physical scheduler state, never a domain transition. Persisting
  // a domain hint here makes crash/resume advance the Flow instead of
  // re-running the waiting node.
  if (result.runtimeEvent === 'paused') return 'runtime.paused';
  if (result.domainEvent) return `domain.${result.domainEvent}`;
  return `runtime.${result.runtimeEvent}`;
}

/**
 * SPI. Реализация выбирается по `kind`. GenericFlowExecutor держит
 * `Map<FlowNodeKind, NodeExecutor>` и диспатчит по `ctx.node.kind`.
 */
export interface NodeExecutor {
  /** Дискриминатор — соответствует FlowNodeKind, который обрабатывает. */
  readonly kind: FlowNodeKind;
  execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult>;
}

// v2 driver-neutral executor SPI. The v2 types ADD the pure-SPI
// `NodeExecutionResult`. They are ADDITIVE: nothing is removed from the
// NodeExecutor when v2 wiring is present (an `envelope` field is set on the
// working because buildExecutionFrame computes the protocol
// `NodeExecutionFrame` from the envelope's `upstreamProducts`.

/**
 * v2 node-execution context.
 *
 * {@link NodeExecutionContext} with an immutable, driver-neutral
 * {@link ExecutionContextEnvelope} assembled from durable state by
 * `assembleExecutionContext`. The envelope carries the exact declared
 * predecessor `ProductRef`s (loaded by content-address, NOT by mutable-bag
 * reconstruction), the frozen authority snapshot, and the pinned package/node
 * identity.
 *
 * `initiatedBy`) are carried over unchanged for backward compatibility. They
 * stay as base fields here so existing node executors compile and behave
 * identically whether the v2 path is active or not.
 *
 * needs the frame view can use `buildExecutionFrame` on
 */
export interface NodeExecutionContextV2 {
  /** Driver-neutral execution envelope. */
  readonly envelope: ExecutionContextEnvelope;
  /** Upstream product bodies loaded by exact ProductRef. Forwarded to the
   *  node's input contract decoder; the envelope carries only the refs. */
  readonly upstreamProductBodies: readonly unknown[];
  readonly projectId: number;
  readonly epicId: number | null;
  readonly processRunId: number;
  readonly module: ProcessModuleDefinition;
  readonly node: FlowNodeDefinition;
  readonly input: unknown;
  readonly heartbeat: () => void;
  readonly initiatedBy: string;
}

/**
 * Базовая ошибка для NodeExecutor-ов.
 */
export class NodeExecutionError extends Error {
  constructor(
    readonly nodeKind: FlowNodeKind,
    readonly nodeId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`node '${nodeId}' (kind=${nodeKind}) execution failed: ${message}`);
    this.name = 'NodeExecutionError';
  }
}

export class NodeExecutionLeaseLostError extends Error {
  constructor(readonly processRunId: number) {
    super(`ProcessRun ${processRunId} execution lease was lost`);
    this.name = 'NodeExecutionLeaseLostError';
  }
}
