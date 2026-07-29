// @ts-check
/**
 * W8-A4 — Acceptance-contract (AC) node protocols + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a4.md`.
 * Plan: §0.11.5 — W8-A4 owns acceptance and reconciliation node protocols
 * and package-local resources.
 *
 * This subtree owns the `NodeProtocolDefinition`s for the two formalization
 * Flow nodes that produce and resolve the WHAT-side acceptance contract:
 *
 *   - `define-acceptance-contract` (LM node, executionProfile
 *     `formalization-acceptance`) — the analyst authors AC artifacts derived
 *     from UC/FR/NFR and emits trace edges.
 *   - `resolve-acceptance-contract` (kernel node, handler
 *     `formalization-resolve-acceptance-contract`) — the kernel re-reads the
 *     exact managed-execution provenance ledger, validates the canonical AC
 *     writes + traces, and routes to reconciliation / repair / clarification.
 *
 * Node IDs and execution-profile / handler / schema identifiers match the
 * frozen formalization Flow in
 * `src/process-modules/modules/formalization/formalization-process-module.ts`
 * verbatim — the package does not invent new node identities, it pins the
 * already-contractual ones behind package-local resources.
 *
 * Pure data only (plan §3.5): every value is canonically serializable. The
 * definitions are consumed read-only by the W8-A1 manifest (which submits
 * entries for the central resource index) and by the W8-A8 conformance tests.
 * No executor, no factories, no functions live here.
 *
 * Cross-lane contract (W8-A1 owns the central manifest):
 *   - W8-A1 imports `ACCEPTANCE_NODE_PROTOCOLS` and `ACCEPTANCE_RESOURCE_INDEX`
 *     and merges them into the formalization package manifest.
 *   - W8-A6 ports + handler adapters resolve the `handler` string against a
 *     kernel handler registered by the package (not by global lookup).
 *   - W8-A8 conformance tests validate each protocol via
 *     `validateNodeProtocolDefinition` from the W1-A4 SPI.
 */

/**
 * The two Flow node ids these protocols own. Mirrors the formalization Flow's
 * `nodes[]` entries for the acceptance contract pair (LM author + kernel
 * resolver). Exported as a frozen constant so downstream lanes and tests can
 * reference the exact strings without re-quoting them.
 *
 * @readonly
 * @enum {string}
 */
export const ACCEPTANCE_NODE_IDS = Object.freeze({
  /** LM node: author AC artifacts + traces. */
  DEFINE: 'define-acceptance-contract',
  /** Kernel node: resolve exact AC writes and route. */
  RESOLVE: 'resolve-acceptance-contract',
});

/**
 * Schema identifiers the acceptance contract pair produces / consumes. Mirrors
 * `formalization-schemas.ts` (`FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA`) and
 * the Flow node `outputSchema` declarations. Opaque strings — Wave 2/3 codecs
 * register concrete documents behind them.
 *
 * @readonly
 */
export const ACCEPTANCE_SCHEMA_IDS = Object.freeze({
  /** Output bundle of the AC author + resolver pair. */
  ACCEPTANCE_BUNDLE: 'saga3.formalization-acceptance-bundle.v1',
  /** AC artifact contract (matches `artifacts[]` AC row schema). */
  ACCEPTANCE_CONTRACT: 'saga3.acceptance-contract.v1',
  /** Work-intent schema for the `formalization.acceptance` intent kind. */
  WORK_INTENT: 'saga3.work-intent.formalization-acceptance.v1',
});

/**
 * Module-relative resource paths (relative to the formalization package root
 * `modules/formalization/package/`). Used by the resource index below and by
 * the W8-A1 manifest. Keeping them in one frozen object prevents the protocol
 * steps and the resource index from drifting apart.
 *
 * @readonly
 */
export const ACCEPTANCE_RESOURCE_PATHS = Object.freeze({
  /** Skill fragment: analyst AC authoring instructions. */
  AC_SKILL: 'nodes/acceptance/resources/skills/acceptance-author-skill.md',
  /** Skill fragment: requirements-reviewer AC review instructions. */
  AC_REVIEW_SKILL: 'nodes/acceptance/resources/skills/acceptance-reviewer-skill.md',
  /** MCP call template: artifact_create for AC. */
  ARTIFACT_CALL: 'nodes/acceptance/resources/templates/acceptance-artifact-create-call-template.json',
  /** MCP call template: trace_add for AC derivation edges. */
  TRACE_CALL: 'nodes/acceptance/resources/templates/acceptance-trace-add-call-template.json',
  /** MCP call template: worker_done completion. */
  DONE_CALL: 'nodes/acceptance/resources/templates/acceptance-worker-done-call-template.json',
  /** LM node pre-submit checklist (acceptance-scoped). */
  CHECKLIST: 'nodes/acceptance/resources/templates/acceptance-node-checklist.md',
  /** JSON Schema for the acceptance-bundle output. */
  BUNDLE_SCHEMA: 'nodes/acceptance/resources/schemas/acceptance-bundle.schema.json',
});

/**
 * The AC author LM node protocol. Mirrors plan §8.2 ProtocolStep graph:
 * each step carries instructions, package-relative resource paths, the frozen
 * `allowedTools` list (matching the `formalization-acceptance` execution
 * profile's COMMON_WRITE_TOOLS), and the evidence the kernel resolver will
 * demand before accepting the node's product.
 *
 * The step graph is intentionally linear at Wave 8: the LM author writes the
 * AC artifacts, adds the required `derived_from` traces, runs the pre-submit
 * checklist, then submits. Repair routing lives in the kernel resolver's
 * protocol (and the Flow's recovery definitions) — the LM node itself has no
 * branching conditions, satisfying the C065 ratchet seed (only `undefined`
 * conditions are supported).
 *
 * @type {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition}
 */
export const DEFINE_ACCEPTANCE_CONTRACT_PROTOCOL = Object.freeze({
  id: 'formalization.define-acceptance-contract',
  version: '1.0.0',
  owningFlowNodeId: ACCEPTANCE_NODE_IDS.DEFINE,
  entryStep: 'author-acceptance',
  steps: [
    {
      id: 'author-acceptance',
      instructions:
        'Read the accepted UC, FR, NFR and RULE artifacts in this REQ episode. ' +
        'Create one AC artifact per acceptance criterion as contract data derived ' +
        'from the WHAT-side lineage (UC covers FR; AC derived_from UC). Use the ' +
        'package-local skill fragment and the materialized artifact_create call ' +
        'template. Never infer machine-filled ids, hashes or schema versions.',
      resources: [
        ACCEPTANCE_RESOURCE_PATHS.AC_SKILL,
        ACCEPTANCE_RESOURCE_PATHS.ARTIFACT_CALL,
        ACCEPTANCE_RESOURCE_PATHS.BUNDLE_SCHEMA,
      ],
      allowedTools: [
        'task_get',
        'artifact_list',
        'artifact_create',
        'trace_list',
        'Read',
        'Glob',
        'Grep',
        'Write',
        'Edit',
        'Bash',
      ],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: {
            schemaId: ACCEPTANCE_SCHEMA_IDS.ACCEPTANCE_CONTRACT,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'trace-acceptance',
      instructions:
        'For every AC authored, add the required derived_from trace edge to its ' +
        'parent UC (and covers edges to FR/NFR where the AC contract requires). ' +
        'Use the materialized trace_add call template. Query existing traces ' +
        'before creating replacements.',
      resources: [ACCEPTANCE_RESOURCE_PATHS.TRACE_CALL],
      allowedTools: ['trace_list', 'trace_add', 'Read', 'Grep'],
      evidenceRequirements: [
        {
          category: 'trace-reference',
          contractRef: {
            schemaId: 'saga3.trace.derived-from.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'verify-checklist',
      instructions:
        'Run the acceptance-scoped pre-submit checklist before any completion ' +
        'write. Confirm ownership, allowed tools, artifact quality and ' +
        'traceability. No TODO/FILL placeholders may remain.',
      resources: [ACCEPTANCE_RESOURCE_PATHS.CHECKLIST],
      allowedTools: ['Read', 'Glob', 'Grep'],
      evidenceRequirements: [
        {
          category: 'human-receipt',
          contractRef: {
            schemaId: 'saga3.checklist.acceptance.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'submit-acceptance',
      instructions:
        'Materialize the worker_done call. Do NOT request a lifecycle transition ' +
        'or start a downstream Process Module. The kernel resolver owns routing.',
      resources: [ACCEPTANCE_RESOURCE_PATHS.DONE_CALL],
      allowedTools: ['worker_done'],
      evidenceRequirements: [
        {
          category: 'tool-receipt',
          contractRef: {
            schemaId: 'saga3.tool.worker-done.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'author-acceptance', to: 'trace-acceptance', kind: 'linear' },
    { from: 'trace-acceptance', to: 'verify-checklist', kind: 'linear' },
    { from: 'verify-checklist', to: 'submit-acceptance', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'artifact-reference',
      contractRef: {
        schemaId: ACCEPTANCE_SCHEMA_IDS.ACCEPTANCE_BUNDLE,
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
    {
      category: 'trace-reference',
      contractRef: {
        schemaId: 'saga3.trace.derived-from.v1',
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['author-acceptance'],
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * The AC kernel-resolver node protocol. The resolver re-reads the exact
 * managed-execution provenance ledger (never the LM's self-reported output),
 * validates the canonical AC writes + traces, and routes to reconciliation on
 * `domain.completed`, back to the author on `domain.repair-required` /
 * `domain.acceptance-blocked`, or to the matching terminal on
 * clarification / inconsistent / failed.
 *
 * Recovery entry re-points at the author node's first step so a repair loop
 * re-runs authoring from the package-pinned resources.
 *
 * @type {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition}
 */
export const RESOLVE_ACCEPTANCE_CONTRACT_PROTOCOL = Object.freeze({
  id: 'formalization.resolve-acceptance-contract',
  version: '1.0.0',
  owningFlowNodeId: ACCEPTANCE_NODE_IDS.RESOLVE,
  entryStep: 'read-provenance',
  steps: [
    {
      id: 'read-provenance',
      instructions:
        'Re-read the exact managed-execution provenance ledger for the fenced LM ' +
        'run. The resolver decides whether a domain product exists by reading the ' +
        'ledger, never by trusting worker self-report. Even runtime.failed reaches ' +
        'here because the worker may have committed durable MCP writes before dying.',
      resources: [ACCEPTANCE_RESOURCE_PATHS.BUNDLE_SCHEMA],
      allowedTools: ['artifact_list', 'trace_list', 'Read', 'Grep'],
      evidenceRequirements: [
        {
          category: 'external-receipt',
          contractRef: {
            schemaId: 'saga3.provenance.managed-execution.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'validate-acceptance',
      instructions:
        'Validate the canonical AC writes against the acceptance-contract schema ' +
        'and the required derived_from / covers traces. Empty acceptance, schema ' +
        'rejection or trace gaps route to repair / clarification / inconsistent.',
      resources: [
        ACCEPTANCE_RESOURCE_PATHS.BUNDLE_SCHEMA,
        ACCEPTANCE_RESOURCE_PATHS.CHECKLIST,
      ],
      allowedTools: ['artifact_list', 'trace_list', 'Read', 'Grep'],
      evidenceRequirements: [
        {
          category: 'module-verifier-receipt',
          contractRef: {
            schemaId: ACCEPTANCE_SCHEMA_IDS.ACCEPTANCE_BUNDLE,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'route-acceptance',
      instructions:
        'Emit the domain event the Flow transitions on: domain.completed to ' +
        'enter reconciliation, domain.repair-required / domain.acceptance-blocked ' +
        'to return to the author, or the matching clarification / inconsistent / ' +
        'failed terminal. The module never starts Development directly.',
      resources: [],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'tool-receipt',
          contractRef: {
            schemaId: 'saga3.event.domain.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'read-provenance', to: 'validate-acceptance', kind: 'linear' },
    { from: 'validate-acceptance', to: 'route-acceptance', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'module-verifier-receipt',
      contractRef: {
        schemaId: ACCEPTANCE_SCHEMA_IDS.ACCEPTANCE_BUNDLE,
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['read-provenance'],
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Convenience array of every acceptance-pair NodeProtocolDefinition owned by
 * this subtree. W8-A1 imports this and submits each entry to the central
 * formalization manifest's protocol index.
 *
 * @readonly
 * @returns {readonly import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition[]}
 */
export const ACCEPTANCE_NODE_PROTOCOLS = Object.freeze([
  DEFINE_ACCEPTANCE_CONTRACT_PROTOCOL,
  RESOLVE_ACCEPTANCE_CONTRACT_PROTOCOL,
]);
