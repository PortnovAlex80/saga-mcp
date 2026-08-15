import type {
  ProcessModuleDefinition,
  ProductionCellFlowNodeDefinition,
} from '../../domain/process-module.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../modules/development/domain/development-kernel-ports.js';
import { INTEGRATED_CANDIDATE_SCHEMA } from '../../../modules/development/domain/development-schemas.js';
import { developmentProcessModule } from './development-process-module.js';

export const DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF = {
  name: 'solution-development-verification-continuation',
  version: '1.0.0',
} as const;

/**
 * Incident-independent suffix package for an already accepted and integrated
 * candidate.  The package contains no production or Git mutation node.  The
 * generic lifecycle continuation selects it only after an immutable baseline
 * adoption has been authorized.
 */
export const developmentVerificationContinuationProcessModule:
ProcessModuleDefinition = (() => {
  const base = structuredClone(developmentProcessModule) as ProcessModuleDefinition;
  const verification = requireCell(base, 'verify-acceptance');
  const settlement = requireNode(base, 'settle-development');
  const terminals = base.flow.nodes.filter(node => node.id.startsWith('complete-'));
  const adopt = {
    id: 'adopt-verification-baseline',
    label: 'Adopt Verification Baseline',
    kind: 'kernel' as const,
    description:
      'Present an exactly authorized task graph, implementation workset and integrated candidate as the immutable verification subject.',
    handler: DEVELOPMENT_KERNEL_HANDLER_IDS.adoptVerificationBaseline,
    outputSchema: { id: INTEGRATED_CANDIDATE_SCHEMA },
  };
  const verificationNode: ProductionCellFlowNodeDefinition = {
    ...verification,
    cellDefinition: {
      ...verification.cellDefinition!,
      inputSelectors: [
        'adopt-verification-baseline.verificationItems',
        'adopt-verification-baseline.candidate',
      ],
      materialization: {
        ...verification.cellDefinition!.materialization!,
        sourceBinding: 'adopt-verification-baseline',
        workKeySelector: 'verificationItems',
      },
      // The author gate is INHERITED from the base verification cell on
      // purpose: the base VERIFICATION_FINAL_PLAN carries the real conveyor
      // contract (verification-product-contract + local-runnability with
      // failureOwnership:'upstream'). The previous hand-rebuilt plan used the
      // accessible-counter demo checks, which are product-coupled to the demo
      // fixture AND drop local-runnability entirely — settlement then blocks
      // forever on local-readiness-missing because no check can produce the
      // receipt it requires.
    },
  };
  return {
    ...base,
    identity: {
      ...DEVELOPMENT_VERIFICATION_CONTINUATION_PROCESS_MODULE_REF,
      kind: 'development',
      displayName: 'Solution Development (Verification Continuation)',
      description:
        'Verifies and settles an exactly adopted integrated candidate without repeating its production.',
    },
    flow: {
      ...base.flow,
      id: 'factory.development.verification-continuation',
      version: '1.0.0',
      entryNodeId: adopt.id,
      nodes: [
        adopt,
        verificationNode,
        { ...settlement, handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settleVerificationContinuation },
        ...terminals,
      ],
      transitions: [
        { from: adopt.id, to: verificationNode.id, on: 'domain.valid' },
        { from: adopt.id, to: 'complete-failed', on: 'domain.failed' },
        { from: verificationNode.id, to: settlement.id, on: 'domain.accepted' },
        { from: verificationNode.id, to: 'complete-blocked', on: 'domain.human-required' },
        // Upstream-defect escalation mirrors the base flow fix: a failed
        // verification verdict routes through settlement for an explicit
        // completion and a continuation-acceptable terminal outcome.
        { from: verificationNode.id, to: settlement.id, on: 'domain.failed' },
        ...['verified', 'rework-required', 'clarification-required', 'blocked', 'failed']
          .map(code => ({
            from: settlement.id,
            to: `complete-${code}`,
            on: `domain.${code}`,
          })),
      ],
      terminalNodeIds: terminals.map(node => node.id),
      // The base module's recovery policies reference nodes we don't have
      // (plan-task-graph, resolve-task-graph). Drop them — otherwise the
      // module validator rejects the continuation at registration.
      recovery: [],
    },
    executionProfiles: base.executionProfiles.filter(
      profile => profile.id === 'development-verification-worker',
    ),
    invariants: [
      ...base.invariants,
      {
        id: 'development.verification-continuation-no-production',
        description:
          'The suffix may observe an adopted candidate but cannot plan, author, review, freeze or integrate source production.',
        enforcement: 'runtime',
      },
    ],
  };
})();

function requireCell(
  module: ProcessModuleDefinition,
  id: string,
): ProductionCellFlowNodeDefinition {
  const node = module.flow.nodes.find(candidate => candidate.id === id);
  if (!node || node.kind !== 'production-cell') {
    throw new Error(`verification continuation cell '${id}' is missing`);
  }
  return node;
}

function requireNode(module: ProcessModuleDefinition, id: string) {
  const node = module.flow.nodes.find(candidate => candidate.id === id);
  if (!node || node.kind !== 'kernel') {
    throw new Error(`verification continuation kernel '${id}' is missing`);
  }
  return node;
}
