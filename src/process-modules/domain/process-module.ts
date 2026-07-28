export interface ProcessModuleReference {
  name: string;
  version: string;
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
  authority: 'worker' | 'advisor' | 'kernel' | 'human' | 'external';
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
}

export type FlowNodeKind = 'lm' | 'kernel' | 'human' | 'external' | 'composite';

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

export interface ExternalFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'external';
  adapter: string;
}

export interface CompositeFlowNodeDefinition extends BaseFlowNodeDefinition {
  kind: 'composite';
  moduleRef: ProcessModuleReference;
}

export type FlowNodeDefinition =
  | LmFlowNodeDefinition
  | KernelFlowNodeDefinition
  | HumanFlowNodeDefinition
  | ExternalFlowNodeDefinition
  | CompositeFlowNodeDefinition;

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
