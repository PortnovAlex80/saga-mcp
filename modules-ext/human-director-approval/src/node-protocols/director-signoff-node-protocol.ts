/**
 * W10-A3 — Director sign-off NodeProtocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *       (lane W10-A3).
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a3.md`.
 * Plan: §8.2 (NodeProtocol), §0.13.10 (Wave 10 serial gate).
 *
 * This module owns the `NodeProtocolDefinition` for the `director-signoff`
 * Human node of the Human Director Approval module
 * (`human-director-approval@1.0.0`), plus the package-local resource pins that
 * node references. It is the single source the director (or director-console
 * operator) loads to record a sign-off decision.
 *
 * This is the production upgrade of the W0-A7 fixture, which shipped NO
 * NodeProtocol (the fixture was data-only). A real installable Human module
 * declares the ordered interaction steps INSIDE the Human node so the runtime
 * can drive the pause/resume + decision-record lifecycle deterministically
 * (plan §8.1, §8.2).
 *
 * Pure canonical data only (plan §3.5): every exported value is a plain,
 * serializable constant. The file imports ONLY pure domain SPI types
 * (`import type`) plus the pure validator (`validateNodeProtocolDefinition`,
 * which itself only imports `shared/canonical-json.ts`). It touches no
 * persistence adapter, no infrastructure, no db.ts — so it introduces zero
 * dependency-direction violations.
 *
 * Import-boundary proof (WAVE10-EXTENSIBILITY-SPEC §4): imports ONLY from
 * `domain/spi/` (`node-protocol.js`, `resource-index.js`, `module-manifest.js`)
 * — the pure SPI surface. NEVER `src/index.ts`, `modules/catalog.ts`, or any
 * existing module.
 */

import type { HandlerRef } from '../../../../dist/process-modules/domain/spi/module-manifest.js';
import { PENDING_DIGEST } from '../../../../dist/process-modules/domain/spi/module-manifest.js';
import type {
  EvidenceRequirement,
  NodeProtocolDefinition,
} from '../../../../dist/process-modules/domain/spi/node-protocol.js';
import { validateNodeProtocolDefinition } from '../../../../dist/process-modules/domain/spi/node-protocol.js';
import type { ResourceIndexEntry } from '../../../../dist/process-modules/domain/spi/resource-index.js';
import {
  DIRECTOR_CONSOLE_ADAPTER_REF,
  HUMAN_DIRECTOR_INTERACTION_CONTRACT,
} from '../definition.ts';

// ---------------------------------------------------------------------------
// Node + module identity.
// ---------------------------------------------------------------------------

/** The flow node this protocol describes (matches the definition flow). */
export const DIRECTOR_SIGNOFF_OWNING_FLOW_NODE_ID = 'director-signoff';

/**
 * Stable id for this NodeProtocol. Namespaced by module + node so the runtime
 * can pin it without global lookup.
 */
export const DIRECTOR_SIGNOFF_PROTOCOL_ID =
  'human-director-approval.director-signoff';

/** Module-relative POSIX root for the package-local resources declared below. */
const RESOURCE_ROOT = 'resources';

// ---------------------------------------------------------------------------
// Package-local resources (plan §0.11.11: pinned, no global lookup). Digests
// are the documented Wave-2 placeholder; the Wave 2 content-addressed
// installer replaces them with real sha256 at install time.
// ---------------------------------------------------------------------------

export const DIRECTOR_SIGNOFF_NODE_RESOURCES: readonly ResourceIndexEntry[] =
  Object.freeze([
    {
      logicalId: 'human-director.signoff-instruction',
      path: `${RESOURCE_ROOT}/director-signoff-instruction.md`,
      kind: 'instruction',
      digest: PENDING_DIGEST,
    },
    {
      logicalId: 'human-director.signoff-checklist',
      path: `${RESOURCE_ROOT}/director-signoff-checklist.md`,
      kind: 'checklist',
      digest: PENDING_DIGEST,
    },
  ]);

// ---------------------------------------------------------------------------
// Handler / adapter refs — stable, content-addressed reference to the
// director-console adapter this node pauses on. The implementation lives behind
// the human-interaction registry (Wave 2); here we carry only the identity.
// ---------------------------------------------------------------------------

export const DIRECTOR_SIGNOFF_NODE_HANDLER_REFS: readonly HandlerRef[] =
  Object.freeze([
    {
      logicalId: HUMAN_DIRECTOR_INTERACTION_CONTRACT,
      version: DIRECTOR_CONSOLE_ADAPTER_REF.split('@')[1] ?? '1.0.0',
      digest: PENDING_DIGEST,
    },
  ]);

// ---------------------------------------------------------------------------
// Evidence requirements (plan §8.4 / §8.5). The Runtime understands the
// CATEGORY; the module-specific meaning ("director recorded an explicit
// approve/reject decision") is enforced by the versioned human-interaction
// adapter. Contracts use the Wave-2 placeholder digest.
// ---------------------------------------------------------------------------

/**
 * A human decision receipt: durable proof that the director-console adapter
 * recorded an explicit decision. This is the load-bearing evidence for a Human
 * node — the runtime will not advance without it.
 */
const HUMAN_DECISION_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'human-receipt',
  contractRef: {
    schemaId: 'saga3.evidence.human-receipt.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
  required: true,
});

/**
 * An artifact reference: the scored campaign bundle the director reviewed. The
 * director must not approve/reject a bundle they cannot cite.
 */
const ARTIFACT_REFERENCE_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'artifact-reference',
  contractRef: {
    schemaId: 'saga3.evidence.artifact-reference.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
  required: true,
});

// ---------------------------------------------------------------------------
// NodeProtocolDefinition (plan §8.2). Ordered steps INSIDE the
// `director-signoff` Human node. Steps are unconditional (Wave 1 / Wave 10
// conservative ratchet: only `undefined` conditions are supported — plan
// §7.4.3 / C065).
//
// The protocol is deliberately linear and short: a Human node pauses for a
// single durable decision. The steps load the bundle under review, present the
// decision prompt, record the decision, and complete. The runtime drives the
// pause/resume around `record-decision` via the director-console adapter.
// ---------------------------------------------------------------------------

export const DIRECTOR_SIGNOFF_NODE_PROTOCOL: NodeProtocolDefinition =
  Object.freeze({
    id: DIRECTOR_SIGNOFF_PROTOCOL_ID,
    version: '1.0.0',
    owningFlowNodeId: DIRECTOR_SIGNOFF_OWNING_FLOW_NODE_ID,
    entryStep: 'present-scoring',
    steps: Object.freeze([
      {
        id: 'present-scoring',
        instructions:
          'Load the exact scored campaign bundle the runtime paused on. Cite ' +
          'the bundle artifact id; do not reconstruct it from memory. Present ' +
          'the scoring summary and the approval checklist to the director.',
        resources: Object.freeze([
          'human-director.signoff-instruction',
          'human-director.signoff-checklist',
        ]),
        allowedTools: Object.freeze(['Read', 'artifact_list']),
        evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE]),
      },
      {
        id: 'record-decision',
        instructions:
          'Record the director decision (approve or reject) through the ' +
          'director-console adapter. The adapter owns the durable ' +
          'request/decision store; the runtime pauses here until a decision is ' +
          'recorded. Do not invent a decision — if the director is unavailable, ' +
          'stay paused rather than synthesizing one.',
        resources: Object.freeze([]),
        allowedTools: Object.freeze([]),
        evidenceRequirements: Object.freeze([
          HUMAN_DECISION_EVIDENCE,
          ARTIFACT_REFERENCE_EVIDENCE,
        ]),
      },
      {
        id: 'emit-decision-envelope',
        instructions:
          'Emit the director decision envelope (approve or reject) as the ' +
          'node-run production and complete the worker execution so the kernel ' +
          'may route to the matching terminal status (campaign-approved or ' +
          'campaign-rejected).',
        resources: Object.freeze([]),
        allowedTools: Object.freeze(['worker_done']),
        evidenceRequirements: Object.freeze([HUMAN_DECISION_EVIDENCE]),
      },
    ]),
    transitions: Object.freeze([
      { from: 'present-scoring', to: 'record-decision', kind: 'linear' as const },
      { from: 'record-decision', to: 'emit-decision-envelope', kind: 'linear' as const },
    ]),
    nodeCompletionEvidence: Object.freeze([
      HUMAN_DECISION_EVIDENCE,
      ARTIFACT_REFERENCE_EVIDENCE,
    ]),
    // Recovery re-enters at the decision step: a stale or contested decision
    // re-presents the bundle and asks the director to record a fresh one.
    recoveryEntrySteps: Object.freeze(['record-decision']),
    retrySemantics: 'runtime-implemented-linear',
  });

// ---------------------------------------------------------------------------
// Structural validation convenience. Re-exports the pure validator from the
// owning SPI lane so the package test can assert this protocol is
// install-ready without duplicating the rule set.
// ---------------------------------------------------------------------------

export function validateDirectorSignoffNodeProtocol() {
  return validateNodeProtocolDefinition(DIRECTOR_SIGNOFF_NODE_PROTOCOL);
}

export { validateNodeProtocolDefinition };
