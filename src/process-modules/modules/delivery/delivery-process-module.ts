import type { ProcessModuleDefinition } from '../../domain/process-module.js';
// CONVEYOR Wave 7: the module identity ref + lifecycle-referenced schema-id
// strings are CANONICAL contracts owned by the lifecycle (Rule 3). This module
// imports them back from the contracts module — inward direction, allowed.
import { DELIVERY_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
import {
  DELIVERY_HUMAN_ADAPTER_IDS,
  DELIVERY_KERNEL_HANDLER_IDS,
} from '../../../modules/delivery/domain/delivery-kernel-ports.js';
import {
  DELIVERY_APPROVAL_SCHEMA,
  DELIVERY_CERTIFICATE_SCHEMA,
  DELIVERY_OBSERVATION_SCHEMA,
  DELIVERY_PREFLIGHT_SCHEMA,
  DELIVERY_PUBLICATION_SCHEMA,
  DELIVERY_RELEASE_CASE_SCHEMA,
  RELEASE_RECORD_SCHEMA,
} from '../../../modules/delivery/domain/delivery-schemas.js';

export { DELIVERY_PROCESS_MODULE_REF };

/**
 * Delivery is the only standard process module authorized to create
 * externally-visible release state. It consumes one verified Development
 * candidate, performs deterministic preflight, obtains the policy-required
 * human decision, applies desired-state actions and then observes every
 * required destination before settlement.
 */
export const deliveryProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DELIVERY_PROCESS_MODULE_REF,
    kind: 'delivery',
    displayName: 'Delivery and Release',
    description:
      'Approves, publishes, deploys and authoritatively observes one immutable verified candidate.',
  },
  inputContract: { id: DELIVERY_RELEASE_CASE_SCHEMA },
  outputContract: { id: RELEASE_RECORD_SCHEMA },
  outcomes: [
    {
      code: 'released',
      description:
        'Every required release action is authoritatively observed at its desired state.',
      terminal: true,
    },
    {
      code: 'approval-required',
      description:
        'A current authorized human decision is required before release effects may begin.',
      terminal: true,
    },
    {
      code: 'blocked',
      description:
        'A policy guard, denied decision, unavailable provider or inconclusive external state blocks release.',
      terminal: true,
    },
    {
      code: 'failed',
      description:
        'Delivery integrity, lineage or external-state validation failed.',
      terminal: true,
    },
  ],
  flow: {
    id: 'factory.delivery.standard',
    version: '1.0.0',
    entryNodeId: 'preflight-release',
    nodes: [
      {
        id: 'preflight-release',
        label: 'Preflight Release',
        kind: 'kernel',
        description:
          'Evaluate deterministic release guards for the exact certified candidate and immutable release policy.',
        handler: DELIVERY_KERNEL_HANDLER_IDS.preflight,
        inputSchema: { id: DELIVERY_RELEASE_CASE_SCHEMA },
        outputSchema: { id: DELIVERY_PREFLIGHT_SCHEMA },
      },
      {
        id: 'approve-release',
        label: 'Approve Release',
        kind: 'human',
        description:
          'Materialize an authorized decision bound to the exact candidate, preflight result and release policy.',
        interactionContract: { id: DELIVERY_HUMAN_ADAPTER_IDS.approval },
        inputSchema: { id: DELIVERY_PREFLIGHT_SCHEMA },
        outputSchema: { id: DELIVERY_APPROVAL_SCHEMA },
      },
      {
        id: 'publish-deploy',
        label: 'Publish and Deploy',
        kind: 'kernel',
        description:
          'Apply immutable desired-state actions through explicit providers using deterministic cross-run action keys. Deterministic external-system calls (git push, deploy), not worker hiring.',
        handler: DELIVERY_KERNEL_HANDLER_IDS.publishDeploy,
        inputSchema: { id: DELIVERY_APPROVAL_SCHEMA },
        outputSchema: { id: DELIVERY_PUBLICATION_SCHEMA },
      },
      {
        id: 'observe-release',
        label: 'Observe Release',
        kind: 'kernel',
        description:
          'Read authoritative target state after every publish/deploy response, including uncertain and failed responses. Deterministic external-system observation, not worker hiring.',
        handler: DELIVERY_KERNEL_HANDLER_IDS.observeRelease,
        inputSchema: { id: DELIVERY_PUBLICATION_SCHEMA },
        outputSchema: { id: DELIVERY_OBSERVATION_SCHEMA },
      },
      {
        id: 'settle-delivery',
        label: 'Settle Delivery',
        kind: 'kernel',
        description:
          'Validate exact durable products and candidate immutability, then issue a canonical release record and certificate.',
        handler: DELIVERY_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: DELIVERY_OBSERVATION_SCHEMA },
        outputSchema: { id: DELIVERY_CERTIFICATE_SCHEMA },
      },
      ...['released', 'approval-required', 'blocked', 'failed'].map(code => ({
        id: `complete-${code}`,
        label: `Complete: ${code}`,
        kind: 'kernel' as const,
        description: `Emit the local Delivery process outcome '${code}'.`,
        handler: 'process-outcome-emitter',
        emitsOutcome: code,
      })),
    ],
    transitions: [
      {
        from: 'preflight-release',
        to: 'approve-release',
        on: 'domain.ready',
      },
      {
        from: 'preflight-release',
        to: 'settle-delivery',
        on: 'domain.blocked',
      },
      {
        from: 'preflight-release',
        to: 'settle-delivery',
        on: 'domain.failed',
      },
      {
        from: 'approve-release',
        to: 'publish-deploy',
        on: 'domain.approved',
      },
      {
        from: 'approve-release',
        to: 'publish-deploy',
        on: 'domain.not-required',
      },
      {
        from: 'approve-release',
        to: 'settle-delivery',
        on: 'domain.approval-required',
      },
      {
        from: 'approve-release',
        to: 'settle-delivery',
        on: 'domain.denied',
      },
      {
        from: 'approve-release',
        to: 'settle-delivery',
        on: 'domain.failed',
      },
      {
        from: 'approve-release',
        to: 'settle-delivery',
        on: 'runtime.failed',
      },
      {
        from: 'publish-deploy',
        to: 'observe-release',
        on: 'domain.completed',
      },
      {
        from: 'publish-deploy',
        to: 'observe-release',
        on: 'domain.failed',
      },
      {
        from: 'observe-release',
        to: 'settle-delivery',
        on: 'domain.completed',
      },
      {
        from: 'observe-release',
        to: 'settle-delivery',
        on: 'domain.failed',
      },
      ...['released', 'approval-required', 'blocked', 'failed'].map(code => ({
        from: 'settle-delivery',
        to: `complete-${code}`,
        on: `domain.${code}`,
      })),
    ],
    terminalNodeIds: [
      'complete-released',
      'complete-approval-required',
      'complete-blocked',
      'complete-failed',
    ],
  },
  artifacts: [
    {
      type: 'delivery-release-case',
      schema: { id: DELIVERY_RELEASE_CASE_SCHEMA },
      authority: 'kernel',
      description:
        'Immutable Delivery request bound to a verified Development candidate and either a real release policy plus operator authorization or an explicit deferred profile.',
    },
    {
      type: 'delivery-preflight',
      schema: { id: DELIVERY_PREFLIGHT_SCHEMA },
      authority: 'kernel',
      description:
        'Complete deterministic release-guard evidence for the exact certified candidate.',
    },
    {
      type: 'delivery-approval',
      schema: { id: DELIVERY_APPROVAL_SCHEMA },
      authority: 'human',
      description:
        'Authorized decision bound to the candidate, preflight snapshot and release policy.',
    },
    {
      type: 'delivery-publication',
      schema: { id: DELIVERY_PUBLICATION_SCHEMA },
      authority: 'kernel',
      description:
        'Durable desired-state action receipts, including uncertain external responses. Produced by a deterministic kernel handler that calls the publication provider.',
    },
    {
      type: 'delivery-observation',
      schema: { id: DELIVERY_OBSERVATION_SCHEMA },
      authority: 'kernel',
      description:
        'Authoritative post-action state observations used to settle external effects safely. Produced by a deterministic kernel handler that calls the observation provider.',
    },
    {
      type: 'release-record',
      schema: { id: RELEASE_RECORD_SCHEMA },
      authority: 'kernel',
      description:
        'Canonical record of every observed release destination for the certified candidate.',
    },
    {
      type: 'delivery-certificate',
      schema: { id: DELIVERY_CERTIFICATE_SCHEMA },
      authority: 'kernel',
      description:
        'Immutable Delivery settlement decision and exact product-lineage hashes.',
    },
  ],
  policies: [
    {
      id: 'delivery-preflight',
      version: '1.0.0',
      handler: DELIVERY_KERNEL_HANDLER_IDS.preflight,
      description:
        'Requires complete trusted checks for the exact certified candidate before human approval.',
    },
    {
      id: 'delivery-settlement',
      version: '1.0.0',
      handler: DELIVERY_KERNEL_HANDLER_IDS.settle,
      description:
        'Admits a release only when authorized desired-state actions are authoritatively observed.',
    },
  ],
  invariants: [
    {
      id: 'delivery.explicit-operator-authorization',
      description:
        'No externally-visible release action may begin without an explicit operator grant bound to the immutable release policy and either the exact candidate or the candidate produced by the same Lifecycle.',
      enforcement: 'policy',
    },
    {
      id: 'delivery.approval-binds-exact-input',
      description:
        'Human approval binds the candidate hash, preflight hash and release-policy hash and cannot float to a later revision.',
      enforcement: 'policy',
    },
    {
      id: 'delivery.no-default-provider',
      description:
        'Every guard, decision, publication and observation provider is injected explicitly; no fallback may perform release effects.',
      enforcement: 'static',
    },
    {
      id: 'delivery.observe-before-retry',
      description:
        'Retries use the deterministic action key and authoritative target observation before any external action is repeated.',
      enforcement: 'runtime',
    },
    {
      id: 'delivery.push-is-not-release',
      description:
        'A successful command response alone never establishes release; settlement requires matching authoritative observed state.',
      enforcement: 'policy',
    },
    {
      id: 'delivery.no-force-or-bypass',
      description:
        'Release adapters must not force push, bypass branch protection, bypass registry immutability or bypass deployment policy.',
      enforcement: 'test',
    },
    {
      id: 'delivery.candidate-is-immutable',
      description:
        'Any candidate hash change after Development certification blocks Delivery and requires fresh Development verification.',
      enforcement: 'policy',
    },
    {
      id: 'delivery.module-does-not-route',
      description:
        'Delivery emits a local outcome and does not decide lifecycle routing.',
      enforcement: 'static',
    },
  ],
  executionProfiles: [],
};
