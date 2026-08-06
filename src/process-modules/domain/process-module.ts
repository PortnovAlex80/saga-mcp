export interface ProcessModuleReference {
  name: string;
  version: string;
}

// Conveyor v4 — ProductionCellDefinition is declared in the pure workplace
// domain (REG-04). Type-only import so this domain file stays pure.
import type { ProductionCellDefinition } from './workplace/production-cell-definition.js';

/**
 * Module-relative path into the package resources/ tree.
 *
 * Introduced in P-PM-1 as the canonical reference shape for everything the
 * module ships inside its folder: skills, templates, checklists, call
 * templates, schemas, error hints. The Runtime resolves a ResourceRef against
 * the installed package root and pins the resolved file's content hash into
 * `ProcessModulePackage.resourceHashes`, so editing a resource without bumping
 * the module version changes the package digest and breaks replay.
 *
 * Paths are forward-slash relative, never absolute, never escape the package
 * root (Runtime validates with the same escape check used for workspace assets).
 */
export interface ResourceRef {
  path: string;
}

export interface ProcessModuleIdentity extends ProcessModuleReference {
  kind: string;
  displayName: string;
  description: string;
}

export interface SchemaReference {
  id: string;
}

export interface OutcomeDefinition {
  code: string;
  description: string;
  terminal: boolean;
}

export interface ArtifactTypeDefinition {
  type: string;
  schema: SchemaReference;
  authority: 'worker' | 'advisor' | 'kernel' | 'human';
  description: string;
}

export interface PolicyDefinition {
  id: string;
  version: string;
  handler: string;
  description: string;
}

export interface InvariantDefinition {
  id: string;
  description: string;
  enforcement: 'static' | 'runtime' | 'policy' | 'test';
}

export interface RetryPolicyDefinition {
  maxAttempts: number;
  retryOn: readonly string[];
  backoff: 'none' | 'fixed' | 'exponential';
}

export interface RecoveryPolicyDefinition {
  resumeFromCheckpoint: boolean;
  reuseWorkIntent: boolean;
  reuseAcceptedOutput: boolean;
  onExhausted: 'fail' | 'pause' | 'escalate';
}

export interface ExecutionProfileDefinition {
  id: string;
  workIntentKind: string;
  workIntentSchema: SchemaReference;
  taskKind: string;
  /** Current composed/compatibility skill selected by the existing runner. */
  executionSkill: string;
  /**
   * Independent reviewer selected when the projected task enters review.
   * Omitted/null preserves the dispatcher's legacy generic-reviewer fallback.
   */
  reviewSkill?: string | null;
  /** Reusable physical execution protocol: tracker, hooks, MCP and recovery. */
  protocolSkill: string;
  /** Domain-specific semantic role skill for this node. */
  semanticSkill: string;
  /**
   * Who may transition artifacts produced by this profile to accepted.
   * Omitted/worker preserves legacy modules; kernel-gate keeps candidates in
   * draft/in_review until an ExactCandidateAcceptance decision commits them.
   */
  artifactAcceptanceAuthority?: 'worker' | 'kernel-gate';
  executionMode: string;
  allowedTools: readonly string[];
  trackerTemplate: string | null;
  workspaceTemplates: readonly string[];
  callTemplates: readonly string[];
  checklists: readonly string[];
  outputSchema: SchemaReference;
  retryPolicy: RetryPolicyDefinition;
  recoveryPolicy: RecoveryPolicyDefinition;
  /**
   * Optional contract version pin. When set, the runtime stamps this ref on
   * the WorkIntent authority_scope for both author and reviewer execution.
   * A reviewer checking an artifact produced under a different contract
   * version throws SRS_CONTRACT_VERSION_MISMATCH (not changes_requested).
   * Currently used by the formalization-architect profile.
   */
  contractRef?: { version: string; digest: string };
}

/**
 * The physical kind of a flow node.
 *
 * 'external' is DELIBERATELY ABSENT. It was a backdoor that let a module
 * self-hire workers / call external systems through an opaque adapter,
 * bypassing the kernel-authorizes and worker_next-hires discipline. Closed
 * 2026-07-31. Modules now use only:
 *   - 'lm'        — an LM worker hired by the infrastructure LmNodeExecutor
 *                   through the shared worker_next queue;
 *   - 'kernel'    — a deterministic kernel handler (may call injected ports:
 *                   DB reads/writes, deterministic external providers via
 *                   declared ports, never worker hiring);
 *   - 'human'     — a durable human interaction (delivery approval, etc.);
 *   - 'composite' — a sub-module reference.
 *
 * A module that needs to call an external system (git push, deploy, observe)
 * declares the provider as a PORT on its InstallationDeps and calls it from a
 * KERNEL node handler. There is no node kind that hides hiring or external
 * effects behind a string id.
 */
export type FlowNodeKind = 'lm' | 'kernel' | 'human' | 'composite' | 'production-cell';

interface BaseFlowNodeDefinition {
  id: string;
  label: string;
  kind: FlowNodeKind;
  description: string;
  inputSchema?: SchemaReference;
  outputSchema?: SchemaReference;
  emitsOutcome?: string;
}

export interface LmFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'lm';
  executionProfile: string;
}

export interface KernelFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'kernel';
  handler: string;
}

export interface HumanFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'human';
  interactionContract: SchemaReference;
}

export interface CompositeFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'composite';
  moduleRef: ProcessModuleReference;
}

/**
 * A Production Cell — the universal unit of LM production (Conveyor v4).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-04 (Производственная
 * ячейка) + Conveyor Mental Model v4 §«The reusable Production Cell» and
 * §«Production Cell versus Flow node».
 *
 * A Production Cell is a first-class FlowNode with `kind = 'production-cell'`.
 * It contains the WHOLE bounded control loop: fenced author execution →
 * immutable CandidateSet → author GateRun + typed GateDecision → (optional)
 * reviewer → repair/human/fail. Author/reviewer WorkerExecutions, CheckRuns
 * and GateRuns are INTERNAL runs of the cell, not separate Flow nodes. The
 * Flow cursor stays on the cell across repair and review and leaves it only
 * after a final typed outcome (REG-04-AC-01).
 *
 * The full declarative shape (inputSelectors, materialization, author profile,
 * product contracts, author/final gates, optional review, recovery, transitions)
 * lives in `domain/workplace/production-cell-definition.ts`. This node
 * definition CARRIES that cell definition by reference + inline data so a
 * module's Flow can embed it without a separate registry lookup at walk time.
 *
 * `cellDefinition` is the inline ProductionCellDefinition. A module MAY also
 * reference it by `cellDefinitionRef` from a registry; the runtime resolves
 * one or the other before walking. This keeps the Flow self-contained for
 * tests while allowing a shared registry for production modules.
 */
export interface ProductionCellFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'production-cell';
  /**
   * The inline cell definition. When present, the runtime uses it directly.
   * Mutually exclusive with `cellDefinitionRef` (exactly one must be set).
   */
  cellDefinition?: ProductionCellDefinition;
  /**
   * Registry reference to a cell definition. When `cellDefinition` is absent,
   * the runtime resolves this ref against the module's cell-definition
   * registry before walking.
   */
  cellDefinitionRef?: string;
}

export type FlowNodeDefinition =
  | LmFlowNodeDefinition
  | KernelFlowNodeDefinition
  | HumanFlowNodeDefinition
  | CompositeFlowNodeDefinition
  | ProductionCellFlowNodeDefinition;

export interface FlowTransitionDefinition {
  from: string;
  to: string;
  on: string;
  condition?: string;
}

/**
 * Declarative local repair route.
 *
 * The runtime understands only node identities, events and attempt limits.
 * Module-owned reason codes and findings travel inside a RecoveryIssue and
 * remain opaque to the runtime.
 *
 * CGAD P18 — Node-Durable Identity Invariant. The "workplace" (a node in a
 * ProcessRun) is the primary durable entity of the conveyor; the "worker" (a
 * task / LM execution) is a one-shot guest on it. The card (projected task) and
 * the desk (execution workspace) belong to the WORKPLACE, not the worker, and
 * survive a worker change. A repair round therefore brings a NEW worker to the
 * SAME workplace: the worker reuses the workplace's existing card (so its prior
 * work is visible to the verifying gate) and continues on the same desk (so its
 * prior drafts survive). This mirrors the proven physical-resume path
 * (generic-flow-executor restoreFrame), not a forked "fresh task per attempt"
 * path. Each repair attempt still records its OWN NodeRun (keyed on
 * process_run + node + attempt), so per-attempt audit/lineage is preserved
 * orthogonally to task identity. Recovery feedback is the LOOP input and is not
 * part of the workplace's stable node-input hash.
 */
export interface FlowRecoveryDefinition {
  id: string;
  /** Node that verifies the result and may emit a RecoveryIssue. */
  verifyNodeId: string;
  /** Node that receives the standard recovery feedback production. */
  repairNodeId: string;
  /** Events for which the issue is repairable instead of terminal. */
  triggerEvents: readonly string[];
  /** Events proving that the repeated verifier resolved the active case. */
  resolvedEvents: readonly string[];
  /** Number of semantic repair rounds, excluding physical pause/resume. */
  maxAttempts: number;
  /** What the generic runtime does after the semantic budget is exhausted. */
  onExhausted: 'fail' | 'pause' | 'escalate';
}

export interface FlowDefinition {
  id: string;
  version: string;
  entryNodeId: string;
  nodes: readonly FlowNodeDefinition[];
  transitions: readonly FlowTransitionDefinition[];
  terminalNodeIds: readonly string[];
  /** Optional module-authored routes interpreted by the generic runtime. */
  recovery?: readonly FlowRecoveryDefinition[];
}

export interface ProcessModuleDefinition {
  identity: ProcessModuleIdentity;
  inputContract: SchemaReference;
  outputContract: SchemaReference;
  outcomes: readonly OutcomeDefinition[];
  flow: FlowDefinition;
  artifacts: readonly ArtifactTypeDefinition[];
  policies: readonly PolicyDefinition[];
  invariants: readonly InvariantDefinition[];
  executionProfiles: readonly ExecutionProfileDefinition[];
}

export function processModuleKey(reference: ProcessModuleReference): string {
  return `${reference.name}@${reference.version}`;
}

/**
 * A versioned, hash-pinned delivery unit. Introduced in P-PM-1.
 *
 * A `ProcessModuleDefinition` alone is structural — it knows the module's
 * contracts, flow, policies, but it does NOT know which concrete skill text,
 * template bytes, or kernel handler versions it shipped with. That binding is
 * established at installation time and captured here.
 *
 * Two digests:
 *
 *   `definitionDigest` — SHA-256 over the canonical JSON of the definition.
 *     Deterministic across rebuilds; excludes the non-enumerable `routeResolver`
 *     (lifecycle-owned, see domain/lifecycle.ts). Registered in the catalog and
 *     persisted in `factory_process_module_installations.definition_digest`.
 *
 *   `packageDigest` — SHA-256 over the canonical JSON of
 *     `{definitionDigest, resourceHashes, handlerVersions}`. This is what a
 *     ProcessRun pins via `installation_id` FK. Editing any shipped resource
 *     (skill, template, checklist) WITHOUT bumping the module version changes
 *     the package digest, which makes the replay observable and prevents silent
 *     skill drift (the root cause of 4 of the 10 bugs catalogued on
 *     2026-07-28).
 *
 * Resource hashes are resolved at installation time by the Runtime reading each
 * `ResourceRef` referenced anywhere in the definition (skills, templates,
 * checklists, call templates, module tool contributions). The Runtime trusts
 * the filesystem, not the caller — this closes the "skill edited, version
 * unchanged" replay attack.
 */
export interface ProcessModulePackage {
  readonly definition: ProcessModuleDefinition;
  /** ResourceRef.path → SHA-256 of the resolved file content. Resolved at installation time. */
  readonly resourceHashes: ReadonlyMap<string, string>;
  /** kernelHandlerId / adapterId / toolContribution.id → declared version. */
  readonly handlerVersions: ReadonlyMap<string, string>;
  readonly definitionDigest: string;
  readonly packageDigest: string;
}

/**
 * Input shape for digest computation. The Runtime assembles this after
 * resolving all ResourceRefs against the installed package root. Resource hashes
 * and handler versions are NOT part of the definition itself (the definition
 * declares names; the Runtime resolves concrete contents), so digest
 * computation takes them as a separate input.
 */
export interface ProcessModuleDigestInput {
  readonly definition: ProcessModuleDefinition;
  readonly resourceHashes: ReadonlyMap<string, string>;
  readonly handlerVersions: ReadonlyMap<string, string>;
}
