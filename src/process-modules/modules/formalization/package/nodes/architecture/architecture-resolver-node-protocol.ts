/**
 * W8-A5 — NodeProtocolDefinition for the Formalization architecture-resolver
 * (kernel) node + the baseline-freezer precondition.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 *       lane W8-A5.
 * Plan: §0.11.6.
 *
 * The `resolve-architecture-contract` node is the KERNEL twin of
 * `define-architecture-contract`. It re-reads the exact managed-execution
 * provenance ledger (never worker output metadata) to resolve the canonical
 * SRS write, verifies it against the frozen acceptance baseline, and emits the
 * domain event the Flow routes on (`domain.completed`, `domain.repair-required`,
 * `domain.acceptance-blocked`, `domain.infeasible`,
 * `domain.clarification-required`, `domain.inconsistent`, `domain.failed`).
 *
 * Because it is a kernel node, its protocol is short: it has no LM authoring
 * steps. It performs an authoritative resolve + verify, then emits. The
 * node-completion evidence is the module-verifier-receipt that the resolver
 * itself produces (the resolver IS the architecture gate for the resolve
 * path). The companion `freeze-acceptance-baseline` kernel node is the
 * upstream precondition that materializes the immutable baseline the resolver
 * verifies against — its protocol is declared here too, because the
 * architecture lane owns the entire post-baseline WHAT→HOW cutover surface
 * (plan §0.11.6: "architecture and recovery node protocols").
 *
 * PURE: data only. No behavior.
 */

import type {
  NodeProtocolDefinition,
} from '../../../../../domain/spi/node-protocol.js';

import { ARCHITECTURE_RESOURCE_IDS } from './srs-node-protocol.js';

/**
 * The baseline-freezer kernel node protocol.
 *
 * Owning Flow node: `freeze-acceptance-baseline`. Computes and persists the
 * immutable baseline hash from the accepted acceptance criteria. The
 * architecture node CANNOT run until this node emits `domain.frozen`; if the
 * baseline drifts, it emits `domain.drift-detected` (a terminal inconsistency).
 */
export const ARCHITECTURE_BASELINE_FREEZER_NODE_PROTOCOL: NodeProtocolDefinition = {
  id: 'formalization.architecture.freeze-acceptance-baseline',
  version: '1.0.0',
  owningFlowNodeId: 'freeze-acceptance-baseline',
  entryStep: 'compute-baseline',
  steps: [
    {
      id: 'compute-baseline',
      instructions:
        'Read the accepted AC rows in canonical order and compute the immutable baseline hash. Persist the ' +
        'acceptance-baseline snapshot. Do not mutate accepted artifacts; the baseline is append-only.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.checklist,
      ],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: {
            schemaId: 'factory.acceptance-baseline-snapshot.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [],
  nodeCompletionEvidence: [
    {
      category: 'module-verifier-receipt',
      contractRef: {
        schemaId: 'factory.acceptance-baseline-snapshot.v1',
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['compute-baseline'],
  retrySemantics: 'runtime-implemented-linear',
};

/**
 * The architecture-resolver (kernel) node protocol.
 *
 * Owning Flow node: `resolve-architecture-contract`. Re-reads the exact
 * canonical SRS write and verifies it against the frozen acceptance baseline.
 * This node IS the architecture kernel gate on the resolve path; its
 * module-verifier-receipt node-completion evidence proves the graph holds
 * before the Flow routes to `settle-formalization`.
 *
 * The resolver may emit any of the architecture domain events; the Flow's
 * recovery twin (see `architecture-recovery-node-protocol.ts`) routes
 * `domain.repair-required` and `domain.acceptance-blocked` back to the
 * architecture authoring node.
 */
export const ARCHITECTURE_RESOLVER_NODE_PROTOCOL: NodeProtocolDefinition = {
  id: 'formalization.architecture.resolve-architecture-contract',
  version: '1.0.0',
  owningFlowNodeId: 'resolve-architecture-contract',
  entryStep: 'resolve-canonical-srs',
  steps: [
    {
      id: 'resolve-canonical-srs',
      instructions:
        'Resolve the exact canonical SRS write from the managed-execution provenance ledger. Reject any worker-provided ' +
        'output metadata that does not match the durable artifact rows. Confirm exactly one SRS was produced.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.checklist,
        ARCHITECTURE_RESOURCE_IDS.srsSchema,
      ],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: {
            schemaId: 'factory.srs.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'verify-against-baseline',
      instructions:
        'Verify the resolved SRS against the frozen acceptance baseline: the baseline has not drifted, the SRS traces ' +
        'to the exact PRD, and the required invariant registry is complete. Emit the architecture domain event ' +
        '(completed / repair-required / acceptance-blocked / infeasible / clarification-required / inconsistent / failed).',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.checklist,
      ],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'module-verifier-receipt',
          contractRef: {
            schemaId: 'factory.architecture-gate.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'resolve-canonical-srs', to: 'verify-against-baseline', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'module-verifier-receipt',
      contractRef: {
        schemaId: 'factory.architecture-gate.v1',
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['resolve-canonical-srs'],
  retrySemantics: 'runtime-implemented-linear',
};
