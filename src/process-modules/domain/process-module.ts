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
  executionSkill: string;
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

export interface FlowDefinition {
  id: string;
  version: string;
  entryNodeId: string;
  nodes: readonly FlowNodeDefinition[];
  transitions: readonly FlowTransitionDefinition[];
  terminalNodeIds: readonly string[];
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
