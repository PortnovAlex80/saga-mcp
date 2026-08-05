/**
 * W8-A3 — Use-case node protocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`
 * §1 (W8-A3 owns the use-case node protocol + package-local resources).
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a3.md`.
 * Plan: §0.11 (Formalization vertical-slice pilot), §8.2 (NodeProtocol).
 *
 * This module owns the `NodeProtocolDefinition` for the
 * `model-use-cases` LM node of the Solution Formalization process module
 * (`solution-formalization@1.0.0`), plus the package-local resources that node
 * pins (Wave 8 exit gate §0.11.11: "no global skill/template lookup, no
 * fallback context"). It is the single source the node may load for use-case
 * authoring.
 *
 * Pure canonical data only (plan §3.5): every exported value is a plain,
 * serializable constant. The file imports ONLY pure domain SPI types
 * (`import type`) plus the pure validator (`validateNodeProtocolDefinition`,
 * which itself only imports `shared/canonical-json.ts`). It touches no
 * persistence adapter, no infrastructure, no db.ts — so it introduces zero
 * dependency-direction violations (Rules 1, 2, 5). Resource digests use the
 * documented Wave-2 placeholder; the Wave 2 content-addressed installer fills
 * them at install time, exactly as the manifest envelope does
 * (`PENDING_DIGEST` in `module-manifest.ts`).
 *
 * Anti-scope: this lane does NOT edit the central package manifest (W8-A1 owns
 * that), does NOT define the kernel resolver handler (W8-A6 owns ports), and
 * does NOT remove the legacy formalization path (Wave 13). It is additive.
 */

import type {
  NodeProtocolDefinition,
  EvidenceRequirement,
} from '../../../../../domain/spi/node-protocol.js';
import { validateNodeProtocolDefinition } from '../../../../../domain/spi/node-protocol.js';
import type { ResourceIndexEntry } from '../../../../../domain/spi/resource-index.js';
import type { HandlerRef } from '../../../../../domain/spi/module-manifest.js';
import { PENDING_DIGEST } from '../../../../../domain/spi/module-manifest.js';

// ---------------------------------------------------------------------------
// Node + module identity.
// ---------------------------------------------------------------------------

/** The flow node this protocol describes (matches formalization-process-module flow). */
export const USE_CASE_OWNING_FLOW_NODE_ID = 'model-use-cases';

/** Execution-profile id this protocol belongs to (matches the process module). */
export const USE_CASE_EXECUTION_PROFILE_ID = 'formalization-use-cases';

/** Schema the node's LM execution must produce (matches formalization-schemas). */
export const USE_CASE_BUNDLE_SCHEMA = 'factory.formalization-use-case-bundle.v1';

/** Work-intent schema bound to the use-case execution profile. */
export const USE_CASE_WORK_INTENT_SCHEMA = 'factory.work-intent.formalization-use-cases.v1';

/** Kernel handler that resolves this node's writes (owned by W8-A6 ports). */
export const USE_CASE_RESOLVER_HANDLER_ID = 'formalization-resolve-use-cases';

/** Module-relative POSIX root for the package-local resources declared below. */
const RESOURCE_ROOT =
  'package/nodes/use-case/resources';

// ---------------------------------------------------------------------------
// Package-local resources (WAVE8-FORMALIZATION-SPEC §0.11.11: pinned, no
// global lookup). Digests are the documented Wave-2 placeholder; the Wave 2
// content-addressed installer replaces them with real sha256 at install time.
// ---------------------------------------------------------------------------

export const USE_CASE_NODE_RESOURCES: readonly ResourceIndexEntry[] = Object.freeze([
  {
    logicalId: 'use-case-skill',
    path: `${RESOURCE_ROOT}/use-case-skill.md`,
    kind: 'instruction',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'use-case-create-call-template',
    path: `${RESOURCE_ROOT}/use-case-create-call-template.json`,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'use-case-derived-from-prd-call-template',
    path: `${RESOURCE_ROOT}/use-case-derived-from-prd-call-template.json`,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'use-case-covers-fr-call-template',
    path: `${RESOURCE_ROOT}/use-case-covers-fr-call-template.json`,
    kind: 'mcp-call-template',
    digest: PENDING_DIGEST,
  },
  {
    logicalId: 'use-case-checklist',
    path: `${RESOURCE_ROOT}/use-case-checklist.md`,
    kind: 'checklist',
    digest: PENDING_DIGEST,
  },
]);

// ---------------------------------------------------------------------------
// Handler refs — stable, content-addressed references to the kernel resolver
// this node hands off to. The implementation lives behind the formalization
// ports (W8-A6); here we carry only the identity.
// ---------------------------------------------------------------------------

export const USE_CASE_NODE_HANDLER_REFS: readonly HandlerRef[] = Object.freeze([
  {
    logicalId: USE_CASE_RESOLVER_HANDLER_ID,
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
]);

// ---------------------------------------------------------------------------
// Evidence requirements (plan §8.4 / §8.5). The Runtime understands the
// CATEGORY; the module-specific meaning ("UC covers an FR") is enforced by the
// versioned resolver. Contracts use the Wave-2 placeholder digest.
// ---------------------------------------------------------------------------

const TOOL_RECEIPT_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'tool-receipt',
  contractRef: {
    schemaId: 'factory.evidence.tool-receipt.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
  required: true,
});

const ARTIFACT_REFERENCE_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'artifact-reference',
  contractRef: {
    schemaId: 'factory.evidence.artifact-reference.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
  required: true,
});

const TRACE_REFERENCE_EVIDENCE: EvidenceRequirement = Object.freeze({
  category: 'trace-reference',
  contractRef: {
    schemaId: 'factory.evidence.trace-reference.v1',
    version: '1.0.0',
    digest: PENDING_DIGEST,
  },
  required: true,
});

// ---------------------------------------------------------------------------
// NodeProtocolDefinition (plan §8.2). Ordered steps INSIDE the
// `model-use-cases` LM node. Steps are unconditional (Wave 1 / Wave 8
// conservative ratchet: only `undefined` conditions are supported — plan
// §7.4.3 / C065).
// ---------------------------------------------------------------------------

export const USE_CASE_NODE_PROTOCOL: NodeProtocolDefinition = Object.freeze({
  id: 'formalization.use-case.model-use-cases',
  version: '1.0.0',
  owningFlowNodeId: USE_CASE_OWNING_FLOW_NODE_ID,
  entryStep: 'load-product-contract',
  steps: Object.freeze([
    {
      id: 'load-product-contract',
      instructions:
        'Read the exact accepted upstream product production bindings (PRD artifact id + FR artifact ids) from the durable frame. Do not reconstruct them from live state.',
      resources: Object.freeze(['use-case-skill']),
      allowedTools: Object.freeze(['task_get', 'artifact_list', 'trace_list', 'Read']),
      evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE]),
    },
    {
      id: 'author-use-cases',
      instructions:
        'Create one or more UC artifacts in draft status from the use-case-create call template. Each UC must derive from the exact PRD and cover at least one exact FR. Every accepted FR must be covered by at least one UC.',
      resources: Object.freeze(['use-case-skill', 'use-case-create-call-template']),
      allowedTools: Object.freeze(['artifact_create', 'Write', 'Edit']),
      evidenceRequirements: Object.freeze([ARTIFACT_REFERENCE_EVIDENCE, TOOL_RECEIPT_EVIDENCE]),
    },
    {
      id: 'link-contract-traces',
      instructions:
        'Connect each UC to the contract graph: a derived_from trace to the exact PRD (use-case-derived-from-prd call template) and a covers trace to at least one exact FR (use-case-covers-fr call template).',
      resources: Object.freeze([
        'use-case-derived-from-prd-call-template',
        'use-case-covers-fr-call-template',
      ]),
      allowedTools: Object.freeze(['trace_add']),
      evidenceRequirements: Object.freeze([TRACE_REFERENCE_EVIDENCE, TOOL_RECEIPT_EVIDENCE]),
    },
    {
      id: 'verify-completeness',
      instructions:
        'Confirm every accepted FR is covered by at least one UC, every UC traces to the PRD, and no UC was self-accepted. Tick every use-case-checklist item. If an FR cannot be covered, surface clarification-required instead of inventing a UC.',
      resources: Object.freeze(['use-case-checklist']),
      allowedTools: Object.freeze(['artifact_list', 'trace_list', 'Read']),
      evidenceRequirements: Object.freeze([TRACE_REFERENCE_EVIDENCE, ARTIFACT_REFERENCE_EVIDENCE]),
    },
    {
      id: 'submit-use-case-bundle',
      instructions:
        'Record the checkpoint on the external tracker and complete the worker execution so the kernel gate (resolve-use-cases) may accept the exact UC candidates.',
      resources: Object.freeze([]),
      allowedTools: Object.freeze(['worker_done']),
      evidenceRequirements: Object.freeze([TOOL_RECEIPT_EVIDENCE]),
    },
  ]),
  transitions: Object.freeze([
    { from: 'load-product-contract', to: 'author-use-cases', kind: 'linear' as const },
    { from: 'author-use-cases', to: 'link-contract-traces', kind: 'linear' as const },
    { from: 'link-contract-traces', to: 'verify-completeness', kind: 'linear' as const },
    { from: 'verify-completeness', to: 'submit-use-case-bundle', kind: 'linear' as const },
  ]),
  nodeCompletionEvidence: Object.freeze([
    ARTIFACT_REFERENCE_EVIDENCE,
    TRACE_REFERENCE_EVIDENCE,
    TOOL_RECEIPT_EVIDENCE,
  ]),
  recoveryEntrySteps: Object.freeze(['author-use-cases', 'link-contract-traces']),
  retrySemantics: 'runtime-implemented-linear',
});

// ---------------------------------------------------------------------------
// Structural validation convenience. Re-exports the pure validator from the
// owning SPI lane so a package manifest (W8-A1) / conformance test (W8-A8) can
// assert this protocol is install-ready without duplicating the rule set.
// ---------------------------------------------------------------------------

export function validateUseCaseNodeProtocol() {
  return validateNodeProtocolDefinition(USE_CASE_NODE_PROTOCOL);
}

export { validateNodeProtocolDefinition };
