/**
 * W8-A5 — NodeProtocolDefinition for the Formalization SRS (architecture)
 * node, plus package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 *       lanes W8-A5 (architecture + recovery node protocols + resources).
 * Plan: §0.11.6 — architecture and recovery node protocols and package-local
 *       resources.
 * Frozen input: `5bf74bf` (Wave 7 checkpoint).
 *
 * This file owns the NodeProtocolDefinition for the LM-operated
 * `define-architecture-contract` Flow node (the node that produces the SRS
 * after the acceptance baseline is frozen). The owning node id, the steps the
 * worker executes, the evidence that gates node completion, and the recovery
 * entry steps are all pure canonical data conforming to
 * `NodeProtocolDefinition` (Wave 1 SPI — `domain/spi/node-protocol.ts`).
 *
 * The package-local resources (skill fragments, templates, schemas, the
 * external-tracker checkpoint, the per-node checklist) are declared in
 * `architecture-resources.ts` and referenced here by `logicalId`. W8-A1 owns
 * the central package manifest; this lane OWNS the architecture subtree and
 * SUBMITS its entries to W8-A1 (plan §0.11.10).
 *
 * PURE: data only. No behavior, no executor, no infrastructure. Every value is
 * canonical-serializable so the protocol round-trips through canonical JSON
 * with a stable digest (plan §3.5). The dependency-direction ratchet permits
 * this module-file → domain-SPI edge (Rule 1 forbids module→module, not
 * module→SPI; Rule 5 forbids domain→application, not module→SPI).
 */

import type {
  NodeProtocolDefinition,
} from '../../../../../domain/spi/node-protocol.js';

// ---------------------------------------------------------------------------
// Logical ids of package-local resources owned by this lane. The actual
// ResourceIndexEntry declarations live in `architecture-resources.ts`; here we
// centralize the string constants so the protocol + the resource index cannot
// drift apart.
// ---------------------------------------------------------------------------

export const ARCHITECTURE_RESOURCE_IDS = {
  /** saga-architect skill fragment (semantic + execution). */
  architectSkill: 'formalization.architecture.architect-skill',
  /** saga-architecture-reviewer skill fragment (review gate). */
  reviewerSkill: 'formalization.architecture.reviewer-skill',
  /** Protocol skill fragment (saga-process-module-worker-protocol). */
  protocolSkill: 'formalization.architecture.protocol-skill',
  /** Per-node checklist (formalization package resources: formalization-node-checklist.md). */
  checklist: 'formalization.architecture.node-checklist',
  /** Stage tracker template. */
  trackerTemplate: 'formalization.architecture.stage-tracker',
  /** artifact_create call template. */
  artifactCallTemplate: 'formalization.architecture.artifact-call-template',
  /** trace_add call template. */
  traceCallTemplate: 'formalization.architecture.trace-call-template',
  /** worker_done call template. */
  doneCallTemplate: 'formalization.architecture.done-call-template',
  /** SRS schema contract reference. */
  srsSchema: 'formalization.architecture.srs-schema',
  /** Architecture bundle output schema contract reference. */
  architectureBundleSchema: 'formalization.architecture.bundle-schema',
  /** Work-intent schema contract reference for the architecture node. */
  workIntentSchema: 'formalization.architecture.work-intent-schema',
} as const;

// ---------------------------------------------------------------------------
// Evidence categories reused across the architecture protocol.
//
// The module-specific evidence category is `module-verifier-receipt`: the
// kernel gate (formalization-architecture-gate) verifies the exact accepted
// SRS candidate before the node may complete. `artifact-reference` evidence
// captures the canonical SRS write; `trace-reference` captures the
// derived_from PRD and enforced_by invariant traces.
// ---------------------------------------------------------------------------

/**
 * Work-intent schema pinned to the architecture node (mirrors the execution
 * profile `workIntentSchema` declared in formalization-process-module.ts).
 */
export const ARCHITECTURE_WORK_INTENT_SCHEMA_ID =
  'saga3.work-intent.formalization-architecture.v1';

/**
 * The architecture node protocol.
 *
 * Owning Flow node: `define-architecture-contract` (an `lm` node — the
 * architect worker runs the saga-architect skill under the
 * `formalization-architect` execution profile). The kernel-resolver twin
 * `resolve-architecture-contract` is owned by
 * `architecture-resolver-node-protocol.ts`; the recovery twin lives in
 * `architecture-recovery-node-protocol.ts`.
 *
 * Steps mirror the canonical Formalization LM-node pattern (plan §8.1, §11.4):
 *   1. `accept-work-intent`   — read the frozen work intent + acceptance
 *                               baseline; the worker MUST NOT invent scope.
 *   2. `author-architecture`  — produce SRS, modules, invariants, ports and
 *                               decomposition; write canonical artifacts.
 *   3. `record-traces`        — materialize derived_from (PRD) + enforced_by
 *                               (invariant) + implements_spec (FR/RULE) traces.
 *   4. `request-review`       — submit the SRS candidate to the
 *                               architecture-reviewer gate.
 *
 * Node-completion evidence requires (a) a module-verifier-receipt from the
 * architecture kernel gate proving exactly one accepted SRS traces to the
 * exact PRD, and (b) an artifact-reference receipt for the canonical SRS write.
 * These are durable; the kernel resolver (`resolve-architecture-contract`)
 * re-reads them from the managed-execution provenance ledger — it never trusts
 * worker-provided output metadata.
 *
 * Recovery entry steps route to `accept-work-intent` (restart-from-checkpoint)
 * and `author-architecture` (acceptance-blocked repair). The recovery twin
 * protocol lives in `architecture-recovery-node-protocol.ts`.
 */
export const ARCHITECTURE_NODE_PROTOCOL: NodeProtocolDefinition = {
  id: 'formalization.architecture.define-architecture-contract',
  version: '1.0.0',
  owningFlowNodeId: 'define-architecture-contract',
  entryStep: 'accept-work-intent',
  steps: [
    {
      id: 'accept-work-intent',
      instructions:
        'Read the frozen work intent bound to the architecture node and the immutable acceptance baseline snapshot. ' +
        'Do not invent, widen, or narrow scope. Confirm the discovery certificate, the formalization case, and the ' +
        'frozen AC baseline hash are present before authoring.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.architectSkill,
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.checklist,
        ARCHITECTURE_RESOURCE_IDS.trackerTemplate,
        ARCHITECTURE_RESOURCE_IDS.workIntentSchema,
      ],
      allowedTools: [
        'task_get',
        'artifact_list',
        'trace_list',
        'note_list',
        'Read',
        'Glob',
        'Grep',
      ],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          // Pinned to the acceptance-baseline snapshot the architecture node
          // consumes (frozen by the upstream baseline-freezer node).
          contractRef: {
            schemaId: 'saga3.acceptance-baseline-snapshot.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'author-architecture',
      instructions:
        'Author the SRS plus modules, ports, invariants and decomposition from the frozen baseline. Create exactly ' +
        'one canonical SRS artifact that traces to the exact PRD. Materialize the artifact write via the pinned ' +
        'artifact_create call template.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.architectSkill,
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.artifactCallTemplate,
        ARCHITECTURE_RESOURCE_IDS.srsSchema,
        ARCHITECTURE_RESOURCE_IDS.architectureBundleSchema,
      ],
      allowedTools: [
        'artifact_create',
        'artifact_update',
        'Read',
        'Write',
        'Edit',
        'Bash',
      ],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: {
            schemaId: 'saga3.srs.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
        {
          // The architecture bundle output schema pins the node output contract
          // (formalization-architecture-bundle.v1).
          category: 'artifact-reference',
          contractRef: {
            schemaId: 'saga3.formalization-architecture-bundle.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'record-traces',
      instructions:
        'Materialize the required trace edges: SRS derived_from the exact PRD, each declared invariant enforced_by ' +
        'the SRS, and each FR/RULE implements_spec the SRS decomposition. Use the pinned trace_add call template. ' +
        'Traces are durable; the settlement policy re-checks the full WHAT/HOW graph before certification.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.architectSkill,
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.traceCallTemplate,
      ],
      allowedTools: ['trace_add', 'Read'],
      evidenceRequirements: [
        {
          category: 'trace-reference',
          contractRef: {
            schemaId: 'saga3.trace-edge.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'request-review',
      instructions:
        'Submit the SRS candidate for the architecture-reviewer gate. The reviewer verifies the invariant registry, ' +
        'FR/NFR completeness, and the derived_from PRD edge. On approval the kernel gate accepts the exact candidate; ' +
        'the worker then completes via worker_done.',
      resources: [
        ARCHITECTURE_RESOURCE_IDS.reviewerSkill,
        ARCHITECTURE_RESOURCE_IDS.protocolSkill,
        ARCHITECTURE_RESOURCE_IDS.doneCallTemplate,
        ARCHITECTURE_RESOURCE_IDS.checklist,
      ],
      allowedTools: ['worker_done', 'Read'],
      evidenceRequirements: [
        {
          // The reviewer skill produces a human-receipt; the kernel gate
          // upgrades it to a module-verifier-receipt at node completion.
          category: 'human-receipt',
          contractRef: {
            schemaId: 'saga3.architecture-review.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'accept-work-intent', to: 'author-architecture', kind: 'linear' },
    { from: 'author-architecture', to: 'record-traces', kind: 'linear' },
    { from: 'record-traces', to: 'request-review', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      // The architecture kernel gate (formalization-architecture-gate@1) is the
      // module verifier. It proves exactly one accepted SRS traces to the exact
      // PRD and that the baseline has not drifted.
      category: 'module-verifier-receipt',
      contractRef: {
        schemaId: 'saga3.architecture-gate.v1',
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
    {
      category: 'artifact-reference',
      contractRef: {
        schemaId: 'saga3.srs.v1',
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['accept-work-intent', 'author-architecture'],
  retrySemantics: 'runtime-implemented-linear',
};
