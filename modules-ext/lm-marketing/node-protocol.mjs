// @ts-check
/**
 * W10-A1 — NodeProtocol for the `draft-campaign` LM node.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 * Plan: §8.2 (NodeProtocol), §8.4 / §8.5 (evidence), §7.4.3 / C065 (flow
 *       condition ratchet seed).
 *
 * This module owns the `NodeProtocolDefinition` describing the ordered actions
 * INSIDE the single `draft-campaign` LM node of `lm-marketing@1.0.0`, plus the
 * evidence the node must collect to complete. It mirrors the W8-A3
 * `use-case-node-protocol.ts` shape: pure canonical data, validated at load by
 * the SPI validator `validateNodeProtocolDefinition`.
 *
 * Pure canonical data only (plan §3.5). The file imports ONLY the public
 * process-module SPI from the compiled `dist/` runtime surface — it never
 * imports `src/index.ts`, `modules/catalog.ts`, `tracker-view/`, the
 * composition root, or any existing built-in module. That import discipline IS
 * the §0.13.10 proof.
 *
 * @typedef {import('../../dist/process-modules/domain/spi/node-protocol.js').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../dist/process-modules/domain/spi/node-protocol.js').EvidenceRequirement} EvidenceRequirement
 */

import {
  validateNodeProtocolDefinition,
} from '../../dist/process-modules/domain/spi/node-protocol.js';
import {
  LM_MARKETING_FLOW_NODE_ID,
  LM_MARKETING_OUTPUT_SCHEMA,
} from './definition.mjs';

// ---------------------------------------------------------------------------
// NodeProtocol identity.
// ---------------------------------------------------------------------------

/** Execution-profile id this protocol belongs to (matches the definition). */
export const MARKETING_AUTHOR_EXECUTION_PROFILE_ID = 'marketing-author';

/** Schema the node's LM execution must produce (matches the definition). */
export const MARKETING_OUTPUT_SCHEMA = LM_MARKETING_OUTPUT_SCHEMA;

// ---------------------------------------------------------------------------
// Evidence requirements (plan §8.4 / §8.5).
//
// The Runtime understands the CATEGORY (it knows how to record/retrieve a tool
// receipt or an artifact reference); it never understands the domain meaning
// ("a CampaignDraft was authored"). Module-specific evidence is checked by a
// versioned verifier registered by the package. Contracts use the Wave-2
// placeholder digest — the concrete codec lands behind the schema id later.
// ---------------------------------------------------------------------------

const PENDING_DIGEST = 'pending@wave-2';

/** @type {EvidenceRequirement} */
const TOOL_RECEIPT_EVIDENCE = Object.freeze({
  category: 'tool-receipt',
  contractRef: Object.freeze({
    schemaId: 'saga3-ext.evidence.tool-receipt.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  }),
  required: true,
});

/** @type {EvidenceRequirement} */
const ARTIFACT_REFERENCE_EVIDENCE = Object.freeze({
  category: 'artifact-reference',
  contractRef: Object.freeze({
    schemaId: 'saga3-ext.evidence.artifact-reference.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  }),
  required: true,
});

// ---------------------------------------------------------------------------
// NodeProtocolDefinition (plan §8.2).
//
// Ordered steps INSIDE the `draft-campaign` LM node. Steps are unconditional
// (Wave 1 / Wave 10 conservative ratchet: only `undefined` conditions are
// supported — plan §7.4.3 / C065). The `resources` arrays reference
// `logicalId`s that the manifest envelope's `resourceIndex` resolves to
// package-local files.
// ---------------------------------------------------------------------------

/**
 * The NodeProtocol for the `draft-campaign` LM node.
 *
 * @type {NodeProtocolDefinition}
 */
export const marketingDraftCampaignNodeProtocol = Object.freeze({
  id: 'lm-marketing.draft-campaign',
  version: '1.0.0',
  owningFlowNodeId: LM_MARKETING_FLOW_NODE_ID,
  entryStep: 'load-brief',
  steps: Object.freeze([
    Object.freeze({
      id: 'load-brief',
      instructions:
        'Read the exact MarketingBrief (audience, goal, channels, key message, constraints) from the durable frame. Do not reconstruct it from memory or live state.',
      resources: Object.freeze(['marketing.skill.author']),
      allowedTools: Object.freeze(['Read']),
      evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE]),
    }),
    Object.freeze({
      id: 'draft-campaign',
      instructions:
        'Author the CampaignDraft from the campaign-draft-template, addressing the audience, stating the goal, selecting channels only from the brief allowed set, and reproducing the key message verbatim. Record every field; leave no placeholder unfilled.',
      resources: Object.freeze([
        'marketing.skill.author',
        'marketing.template.draft',
        'marketing.call-template.draft',
      ]),
      allowedTools: Object.freeze(['Read', 'Write', 'Edit']),
      evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE, TOOL_RECEIPT_EVIDENCE]),
    }),
    Object.freeze({
      id: 'verify-completeness',
      instructions:
        'Tick every campaign-draft-checklist item. Confirm every channel is in the brief allowed set, the key message is verbatim, and no content was invented beyond the brief. If the brief is internally inconsistent, surface clarification-required instead of fabricating content.',
      resources: Object.freeze(['marketing.checklist.draft']),
      allowedTools: Object.freeze(['Read']),
      evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE]),
    }),
    Object.freeze({
      id: 'submit-campaign-bundle',
      instructions:
        'Record the checkpoint on the external tracker and complete the worker execution so the kernel gate may accept the exact CampaignDraft candidate.',
      resources: Object.freeze([]),
      allowedTools: Object.freeze(['worker_done']),
      evidenceRequirements: Object.freeze([TOOL_RECEIPT_EVIDENCE]),
    }),
  ]),
  transitions: Object.freeze([
    Object.freeze({ from: 'load-brief', to: 'draft-campaign', kind: 'linear' }),
    Object.freeze({ from: 'draft-campaign', to: 'verify-completeness', kind: 'linear' }),
    Object.freeze({ from: 'verify-completeness', to: 'submit-campaign-bundle', kind: 'linear' }),
  ]),
  nodeCompletionEvidence: Object.freeze([
    ARTIFACT_REFERENCE_EVIDENCE,
    TOOL_RECEIPT_EVIDENCE,
  ]),
  recoveryEntrySteps: Object.freeze(['draft-campaign']),
  retrySemantics: 'runtime-implemented-linear',
});

// ---------------------------------------------------------------------------
// Structural validation convenience. Validates the protocol at module load so
// an invalid protocol fails fast — exactly the W8-A3 pattern.
// ---------------------------------------------------------------------------

const _loadValidation = validateNodeProtocolDefinition(marketingDraftCampaignNodeProtocol);
if (!_loadValidation.ok) {
  const rendered = _loadValidation.errors
    .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
    .join('\n');
  throw new Error(`lm-marketing draft-campaign node protocol failed validation:\n${rendered}`);
}

/**
 * Re-run the SPI validator on the protocol (for conformance tests).
 * @returns {{ ok: boolean; errors: readonly { code: string; path: string; message: string }[] }}
 */
export function validateMarketingDraftCampaignNodeProtocol() {
  return validateNodeProtocolDefinition(marketingDraftCampaignNodeProtocol);
}

export { validateNodeProtocolDefinition };
