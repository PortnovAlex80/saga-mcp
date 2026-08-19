import type {
  ExecutionProfileDefinition,
  ProcessModuleDefinition,
  ProductionCellFlowNodeDefinition,
} from '../../domain/process-module.js';
import { SOURCE_CHANGE_CANDIDATE_SCHEMA } from '../../domain/source-change-candidate.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../modules/development/domain/development-kernel-ports.js';
import { developmentProcessModule } from './development-process-module.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_ID,
  DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
} from '../../../modules/development/application/development-check-providers.js';

export const DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF = {
  name: 'solution-development-managed',
  version: '1.1.0',
} as const;

/**
 * RE-PLAN CYCLE (REPLAN-CYCLE-TZ §4) — the cycle-2 variant of the managed
 * continuation. The plain continuation deliberately filters the planner out
 * (deterministic recovery, no planner inference). A run whose case carries
 * replanContext is cycle 2: it ENTERS through a planner cell
 * ('replan-task-graph') placed BEFORE 'resolve-task-graph', so the planner —
 * seeing the whole integrated cycle-1 code through replanContext — re-carves
 * the graph with maximum parallelism. Distinct module version (1.2.0): both
 * variants coexist in the registry; cycle-2 runs get fresh workplace
 * authority keyed by the new moduleRef.
 */
export const DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF = {
  name: 'solution-development-managed',
  version: '1.2.0',
} as const;

const REPLAN_PLANNER_CHECK_PLAN = buildCheckPlan(
  'development.replan-task-graph.final',
  [
    {
      providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
      version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
      providerDigest: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
    },
    {
      providerId: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_ID,
      version: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_VERSION,
      providerDigest: DEVELOPMENT_REPLAN_GRAPH_CHECK_PROVIDER_DIGEST,
    },
  ],
);

const RESOURCE_ROOT =
  'src/process-modules/modules/development/package/resources/managed-source';
const READ_TOOLS = [
  'task_get', 'task_list', 'artifact_list', 'artifact_get', 'trace_list',
  'repository_list', 'candidate_read', 'product_read', 'Read', 'Glob', 'Grep',
] as const;
const PRODUCER_TOOLS = [...READ_TOOLS, 'product_submit', 'worker_done'] as const;

/**
 * Versioned recovery package. It keeps the universal Production Cell grammar,
 * but removes mutable Git/Bash authority from the model and deterministically
 * resolves one continuation graph from certified recovery evidence.
 */
export const developmentContinuationProcessModule: ProcessModuleDefinition = (() => {
  const base = structuredClone(developmentProcessModule) as ProcessModuleDefinition;
  const implementation = requireCell(base, 'implement-work-items');
  const verification = requireCell(base, 'verify-acceptance');
  const resolve = requireNode(base, 'resolve-task-graph');
  if (!implementation.cellDefinition!.review) {
    throw new Error('managed Development requires review');
  }
  const managedImplementation: ProductionCellFlowNodeDefinition = {
    ...implementation,
    description:
      'Produce one managed textual SourceChangeCandidate, review its exact Factory-materialized tree, then request Factory-owned integration.',
    cellDefinition: {
      ...implementation.cellDefinition!,
      productContracts: [{
        binding: 'sourceChangeCandidate',
        schemaRef: SOURCE_CHANGE_CANDIDATE_SCHEMA,
        mediaType: 'application/json',
        cardinality: '1',
      }],
      author: {
        skillRef: 'development-managed-source-author',
        capabilityPreset: 'managed-text-author',
      },
      review: {
        ...implementation.cellDefinition!.review,
        reviewer: {
          skillRef: 'development-managed-source-reviewer',
          capabilityPreset: 'managed-text-reviewer',
        },
      },
      // Managed author gate: the base cell's implementation-scope check is a
      // Git-diff authority check over an implementation-result product. The
      // managed product is a textual SourceChangeCandidate and its scope
      // ownership is enforced deterministically at Factory materialization
      // (managed-source-change-candidate validateEntries vs frozen
      // changeScopes), NOT by re-reading a worker Git tree the managed author
      // never had authority to create. Keep only the product-contract check
      // so the gate still proves the exact typed submission shape.
      authorGate: {
        gateId: 'development-managed-implementation-author',
        gatePhase: 'author',
        checkPlan: buildCheckPlan('development.managed-implementation.author.v1', []),
      },
    },
  };
  const managedVerification: ProductionCellFlowNodeDefinition = {
    ...verification,
    cellDefinition: {
      ...verification.cellDefinition!,
      author: {
        skillRef: 'development-managed-verifier',
        capabilityPreset: 'sandbox-verifier',
      },
    },
  };
  const managedResolve = {
    ...resolve,
    handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveContinuationTaskGraph,
    description:
      'Construct one deterministic recovery work item from the exact continuation and adoption receipts; no planner inference is used.',
  };
  const continuationNodes = base.flow.nodes
    .filter(node => node.id !== 'plan-task-graph')
    .map(node => node.id === 'resolve-task-graph'
      ? managedResolve
      : node.id === 'implement-work-items'
        ? managedImplementation
        : node.id === 'verify-acceptance'
          ? managedVerification
          : node.id === 'freeze-integrated-candidate' && node.kind === 'kernel'
            ? { ...node, handler: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeContinuationCandidate }
            : node.id === 'settle-development' && node.kind === 'kernel'
              ? { ...node, handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settleContinuation }
              : node);

  const profiles = base.executionProfiles.filter(
    profile => profile.id !== 'development-task-graph-planner',
  ).map(profile => continuationProfile(profile));
  return {
    ...base,
    identity: {
      ...DEVELOPMENT_CONTINUATION_PROCESS_MODULE_REF,
      kind: 'development',
      displayName: 'Solution Development (Managed Continuation)',
      description:
        'Continues from an exact accepted prefix with managed textual source production and Factory-owned Git effects.',
    },
    flow: {
      ...base.flow,
      id: 'factory.development.managed-continuation',
      version: '1.1.0',
      entryNodeId: 'resolve-task-graph',
      nodes: continuationNodes,
      transitions: base.flow.transitions.filter(
        transition => transition.from !== 'plan-task-graph'
          && transition.to !== 'plan-task-graph',
      ),
      // The base module's recovery policies reference nodes we removed
      // (plan-task-graph is filtered out above). Drop any policy whose
      // verify/repair nodes no longer exist — otherwise the module validator
      // rejects the continuation at registration.
      recovery: (base.flow.recovery ?? []).filter(policy =>
        continuationNodes.some(node => node.id === policy.verifyNodeId)
        && continuationNodes.some(node => node.id === policy.repairNodeId)),
    },
    executionProfiles: profiles,
    artifacts: [
      ...base.artifacts,
      {
        type: 'managed-source-change-candidate',
        schema: { id: SOURCE_CHANGE_CANDIDATE_SCHEMA },
        authority: 'worker',
        description:
          'Text-only change manifest materialized into a private commit by the Factory.',
      },
    ],
    invariants: [
      ...base.invariants,
      {
        id: 'development.managed-source-no-worker-git-authority',
        description:
          'The author can read repository content and submit text, but cannot mutate Git refs, use Bash, or write a checkout.',
        enforcement: 'runtime',
      },
    ],
  };
})();

/**
 * RE-PLAN CYCLE (REPLAN-CYCLE-TZ §4) — the cycle-2 continuation: the plain
 * continuation's deterministic graph is REPLANNED by an LM planner cell
 * inserted BEFORE 'resolve-task-graph'. The planner's gate runs the standard
 * task-graph provider PLUS the replan-graph provider (parallelism
 * anti-pattern + shared-surface extraction, REPLAN-CYCLE-TZ §2). The rest of
 * the managed grammar (textual source production, Factory-owned Git effects)
 * is inherited unchanged from the plain continuation.
 */
export const developmentReplanContinuationProcessModule: ProcessModuleDefinition = (() => {
  const base = structuredClone(developmentContinuationProcessModule) as ProcessModuleDefinition;
  const originalPlanner = developmentProcessModule.flow.nodes.find(
    node => node.id === 'plan-task-graph',
  );
  if (!originalPlanner || originalPlanner.kind !== 'production-cell') {
    throw new Error('re-plan Development requires the base planner cell');
  }
  // The base module's planner profile was filtered out of the continuation;
  // cycle 2 restores it verbatim (Read/Glob/Grep repo visibility).
  const plannerProfile = developmentProcessModule.executionProfiles.find(
    profile => profile.id === 'development-task-graph-planner',
  );
  if (!plannerProfile) {
    throw new Error('re-plan Development requires the base planner execution profile');
  }
  const plannerNode: ProductionCellFlowNodeDefinition = {
    ...(originalPlanner as ProductionCellFlowNodeDefinition),
    id: 'replan-task-graph',
    label: 'Re-plan Task Graph',
    description:
      'Cycle-2 planner: re-carves the task graph over the WHOLE integrated cycle-1 code (replanContext) with maximum parallelism; the gate enforces coverage, the parallelism anti-pattern rule and shared-surface extraction.',
    cellDefinition: {
      ...(originalPlanner as ProductionCellFlowNodeDefinition).cellDefinition!,
      id: 'development-replan-task-graph',
      authorGate: {
        gateId: 'development-replan-task-graph-author',
        gatePhase: 'final',
        checkPlan: REPLAN_PLANNER_CHECK_PLAN,
      },
    },
  };
  const rest = base.flow.nodes
    .filter(node => node.id !== 'replan-task-graph')
    .map(node => node.id === 'resolve-task-graph' && node.kind === 'kernel'
      ? {
        ...node,
        // Cycle 2 resolves the PLANNER's accepted proposal through the
        // supersede-wrapping handler (REPLAN-CYCLE-TZ §5): remaining cycle-1
        // tasks are drained BEFORE the new graph materializes.
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveReplanTaskGraph,
        description:
          'Drain remaining cycle-1 tasks (superseded_by), then canonicalize the cycle-2 gate-accepted re-plan proposal and materialize its projected work idempotently.',
      }
      : node);
  const resolverIndex = rest.findIndex(node => node.id === 'resolve-task-graph');
  if (resolverIndex < 0) {
    throw new Error('re-plan Development requires resolve-task-graph');
  }
  // The planner sits strictly BEFORE the resolver in node order.
  const nodes = [
    ...rest.slice(0, resolverIndex),
    plannerNode,
    ...rest.slice(resolverIndex),
  ];
  return {
    ...base,
    identity: {
      ...DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF,
      kind: 'development',
      displayName: 'Solution Development (Managed Re-Plan Continuation)',
      description:
        'Cycle-2 continuation: replans the task graph over the integrated cycle-1 reality, then produces managed textual source with Factory-owned Git effects.',
    },
    flow: {
      ...base.flow,
      id: 'factory.development.managed-replan-continuation',
      version: '1.2.0',
      entryNodeId: 'replan-task-graph',
      nodes,
      transitions: [
        { from: 'replan-task-graph', to: 'resolve-task-graph', on: 'domain.accepted' },
        { from: 'replan-task-graph', to: 'complete-failed', on: 'domain.failed' },
        ...base.flow.transitions,
      ],
      recovery: (base.flow.recovery ?? []).filter(policy =>
        nodes.some(node => node.id === policy.verifyNodeId)
        && nodes.some(node => node.id === policy.repairNodeId)),
    },
    executionProfiles: [
      plannerProfile,
      ...base.executionProfiles,
    ],
  };
})();

function continuationProfile(profile: ExecutionProfileDefinition): ExecutionProfileDefinition {
  if (profile.id === 'development-implementation-worker') {
    return {
      ...profile,
      id: 'development-managed-source-author',
      executionSkill: 'saga-managed-source-author',
      semanticSkill: 'saga-managed-source-author',
      reviewSkill: null,
      executionMode: 'artifact_change',
      allowedTools: PRODUCER_TOOLS,
      trackerTemplate: `${RESOURCE_ROOT}/managed-source-tracker.md`,
      workspaceTemplates: [`${RESOURCE_ROOT}/managed-source-checklist.md`],
      checklists: [`${RESOURCE_ROOT}/managed-source-checklist.md`],
      outputSchema: { id: SOURCE_CHANGE_CANDIDATE_SCHEMA },
    };
  }
  if (profile.id === 'development-implementation-reviewer') {
    return {
      ...profile,
      id: 'development-managed-source-reviewer',
      executionSkill: 'saga-managed-source-reviewer',
      semanticSkill: 'saga-managed-source-reviewer',
      executionMode: 'tracker_only',
      allowedTools: PRODUCER_TOOLS,
      trackerTemplate: `${RESOURCE_ROOT}/managed-review-tracker.md`,
      workspaceTemplates: [`${RESOURCE_ROOT}/managed-review-checklist.md`],
      checklists: [`${RESOURCE_ROOT}/managed-review-checklist.md`],
    };
  }
  if (profile.id === 'development-verification-worker') {
    return {
      ...profile,
      id: 'development-managed-verifier',
      allowedTools: PRODUCER_TOOLS,
    };
  }
  return profile;
}

function requireCell(
  module: ProcessModuleDefinition,
  id: string,
): ProductionCellFlowNodeDefinition {
  const node = module.flow.nodes.find(candidate => candidate.id === id);
  if (!node || node.kind !== 'production-cell') {
    throw new Error(`managed Development cell '${id}' is missing`);
  }
  return node;
}

function requireNode(module: ProcessModuleDefinition, id: string) {
  const node = module.flow.nodes.find(candidate => candidate.id === id);
  if (!node || node.kind !== 'kernel') {
    throw new Error(`managed Development kernel '${id}' is missing`);
  }
  return node;
}
