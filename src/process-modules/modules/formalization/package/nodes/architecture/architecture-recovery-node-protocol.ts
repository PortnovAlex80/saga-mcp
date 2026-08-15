/**
 * W8-A5 — Recovery node protocol for the Formalization architecture lane.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 *       lane W8-A5.
 * Plan: §0.11.6 — recovery node protocols.
 * Wave 4 contract: `docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md`
 *       — RecoveryIssue → RecoveryAction → RecoveryFeedback.
 *
 * The Flow-level `recovery` binding (in formalization-process-module.ts) routes
 * `domain.repair-required` / `domain.acceptance-blocked` from
 * `resolve-architecture-contract` back to `define-architecture-contract`
 * (`repair-architecture-contract`: verifyNodeId=resolve-architecture-contract,
 * repairNodeId=define-architecture-contract, maxAttempts=2, onExhausted=escalate).
 *
 * This file declares the NodeProtocolDefinition the RecoveryEngine (Wave 4)
 * runs INSIDE that repair loop. It is the protocol for a synthetic recovery
 * node that the runtime materializes when an architecture RecoveryIssue is
 * raised against the resolver's verdict. The protocol reuses the authoring
 * steps of the LM node (re-entry at `accept-work-intent` for checkpoint
 * restart, or `author-architecture` for acceptance-blocked repair) but adds
 * the diagnostic + verify steps a recovery pass requires, and pins the
 * RecoveryIssue acceptance criteria the architecture gate enforces (mirrored
 * verbatim from formalization-installation.ts `recoverySpec('repair-architecture-contract', ...)`):
 *
 *   - Exactly one SRS is produced and traces to the exact PRD.
 *   - The frozen acceptance baseline has not drifted.
 *   - The reviewed SRS candidate is accepted+clean by the kernel gate.
 *
 * PURE: data only. The RecoveryAction union (Wave 1 SPI) and the
 * RecoveryPolicyBinding are referenced by stable id; no executor is wired here.
 */

import type {
  NodeProtocolDefinition,
} from '../../../../../domain/spi/node-protocol.js';

import { ARCHITECTURE_RESOURCE_IDS } from './srs-node-protocol.js';

/**
 * The Flow-level recovery binding id this protocol serves. Mirrors
 * formalization-process-module.ts `recovery[].id`.
 */
export const ARCHITECTURE_RECOVERY_BINDING_ID = 'repair-architecture-contract';

/**
 * The architecture lane's recovery policy binding. Mirrors the
 * `recoveryPolicy` of the `formalization-architect` execution profile
 * (resumeFromCheckpoint + reuseWorkIntent + reuseAcceptedOutput + escalate).
 */
export const ARCHITECTURE_RECOVERY_POLICY = {
  resumeFromCheckpoint: true,
  reuseWorkIntent: true,
  reuseAcceptedOutput: true,
  onExhausted: 'escalate',
} as const;

/**
 * The acceptance criteria the architecture gate enforces before a recovery
 * attempt may resolve. Verbatim from formalization-installation.ts
 * `recoverySpec('repair-architecture-contract', 'architecture contract', [...])`.
 * Duplicated here as pure data so the recovery protocol is self-describing
 * without importing the installation layer (Rule 5 of the dependency ratchet).
 */
export const ARCHITECTURE_RECOVERY_ACCEPTANCE_CRITERIA: readonly string[] = Object.freeze([
  'Exactly one SRS is produced and traces to the exact PRD.',
  'The frozen acceptance baseline has not drifted.',
  'The reviewed SRS candidate is accepted+clean by the kernel gate.',
]);

/**
 * The artifact + trace writes a recovery attempt is permitted to make. Mirrors
 * the `allowedChanges` of the architecture recoverySpec.
 */
export const ARCHITECTURE_RECOVERY_ALLOWED_CHANGES: readonly string[] = Object.freeze([
  'SRS artifact',
  'SRS derived_from traces',
]);

/**
 * The trigger events that open an architecture recovery loop. Mirrors the
 * Flow-level `triggerEvents` of the `repair-architecture-contract` binding.
 */
export const ARCHITECTURE_RECOVERY_TRIGGER_EVENTS: readonly string[] = Object.freeze([
  'domain.repair-required',
  'domain.acceptance-blocked',
]);

/**
 * The events that resolve (close) an architecture recovery loop. Mirrors the
 * Flow-level `resolvedEvents` of the `repair-architecture-contract` binding.
 */
export const ARCHITECTURE_RECOVERY_RESOLVED_EVENTS: readonly string[] = Object.freeze([
  'domain.completed',
]);

/**
 * The architecture recovery node protocol.
 *
 * Owning Flow node: synthetic — materialized by the Wave 4 RecoveryEngine when
 * an architecture RecoveryIssue is raised. Its `owningFlowNodeId` is the
 * repair binding id so the runtime can correlate the protocol run to the
 * Flow-level recovery binding.
 *
 * Steps:
 *   1. `diagnose-architecture-issue` — read the RecoveryIssue reason codes +
 *      the resolver's findings; classify the failure (schema-rejected /
 *      trace-gap / invariant-gap / drift). No authoring here.
 *   2. `repair-architecture`          — re-enter authoring with the diagnosis.
 *      The runtime reuses the accepted work intent + accepted output where the
 *      recovery policy permits; the worker rewrites only the broken SRS /
 *      traces.
 *   3. `re-verify-architecture`       — re-run the architecture gate. On
 *      success emit `domain.completed`; on failure emit
 *      `domain.repair-required` again (the Flow's maxAttempts=2 caps the loop,
 *      onExhausted=escalate surfaces a human RecoveryCase).
 *
 * Recovery entry steps route to `diagnose-architecture-issue` and
 * `repair-architecture` so a crash mid-repair resumes at the exact last
 * incomplete step (Wave 4 §0.7.11 crash-resume).
 */
export const ARCHITECTURE_RECOVERY_NODE_PROTOCOL: NodeProtocolDefinition = {
  id: 'formalization.architecture.repair-architecture-contract',
  version: '1.0.0',
  owningFlowNodeId: ARCHITECTURE_RECOVERY_BINDING_ID,
  entryStep: 'diagnose-architecture-issue',
  steps: [
    {
      id: 'diagnose-architecture-issue',
      instructions:
        'Read the RecoveryIssue reason codes and the architecture resolver findings. Classify the failure: ' +
        'schema-rejected (SRS shape), trace-gap (missing derived_from/enforced_by/implements_spec), ' +
        'invariant-gap (invariant registry incomplete), or drift (baseline changed). Do not author; diagnose only.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.checklist,
        ARCHITECTURE_RESOURCE_IDS.srsSchema,
      ],
      allowedTools: [
        'task_get',
        'artifact_list',
        'trace_list',
        'Read',
        'Grep',
      ],
      evidenceRequirements: [
        {
          // The RecoveryIssue itself is the durable entry evidence.
          category: 'module-verifier-receipt',
          contractRef: {
            schemaId: 'factory.recovery-issue.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'repair-architecture',
      instructions:
        'Re-enter architecture authoring with the diagnosis. Reuse the accepted work intent and accepted output where ' +
        'the recovery policy permits; rewrite only the broken SRS artifact and/or its derived_from traces. ' +
        'Materialize every write via the pinned call templates so the resolver can re-read exact provenance.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.architectSkill,
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.artifactCallTemplate,
        ARCHITECTURE_RESOURCE_IDS.traceCallTemplate,
        ARCHITECTURE_RESOURCE_IDS.srsSchema,
        ARCHITECTURE_RESOURCE_IDS.architectureBundleSchema,
      ],
      allowedTools: [
        'artifact_create',
        'artifact_update',
        'trace_add',
        'Read',
        'Write',
        'Edit',
      ],
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
      id: 're-verify-architecture',
      instructions:
        'Re-run the architecture kernel gate: exactly one accepted SRS traces to the exact PRD; the baseline has not ' +
        'drifted; the reviewed candidate is accepted+clean. Emit domain.completed on success, or ' +
        'domain.repair-required to continue the loop (the Flow caps attempts and escalates on exhaustion).',
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
    { from: 'diagnose-architecture-issue', to: 'repair-architecture', kind: 'linear' },
    { from: 'repair-architecture', to: 're-verify-architecture', kind: 'linear' },
    // Self-loop on re-verify is governed by the Flow-level maxAttempts cap,
    // not by an unconditional protocol transition (the runtime emits the
    // domain event; the Flow routes it).
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
  recoveryEntrySteps: ['diagnose-architecture-issue', 'repair-architecture'],
  retrySemantics: 'runtime-implemented-linear',
};
