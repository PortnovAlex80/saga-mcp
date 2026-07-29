// @ts-check
/**
 * W8-A4 — Reconciliation + baseline-freeze node protocols + package-local
 * resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a4.md`.
 * Plan: §0.11.5 — W8-A4 owns acceptance AND reconciliation node protocols.
 *
 * The reconciliation trio closes the WHAT-side of formalization: after AC are
 * authored + resolved, the reconciler repairs permitted traceability gaps and
 * exposes unresolved WHAT-side contradictions; the kernel re-reads the exact
 * lineage and validates acceptance + traceability; finally the baseline
 * freezer computes and persists the immutable acceptance baseline hash. Only
 * after `domain.frozen` does the HOW-side (SRS) become reachable.
 *
 * Node IDs / handlers / schema ids mirror the frozen formalization Flow in
 * `src/process-modules/modules/formalization/formalization-process-module.ts`:
 *
 *   - `reconcile-what` (LM, executionProfile `formalization-reconciler`)
 *   - `resolve-reconciliation` (kernel, handler `formalization-resolve-reconciliation`)
 *   - `freeze-acceptance-baseline` (kernel, handler `formalization-baseline-freezer`)
 *
 * Pure data only (plan §3.5). No executor, no factories.
 */

/**
 * The three Flow node ids these protocols own.
 *
 * @readonly
 * @enum {string}
 */
export const RECONCILIATION_NODE_IDS = Object.freeze({
  /** LM node: repair permitted trace gaps, expose contradictions. */
  RECONCILE: 'reconcile-what',
  /** Kernel node: re-read WHAT lineage, validate, materialize report. */
  RESOLVE: 'resolve-reconciliation',
  /** Kernel node: compute + persist immutable AC baseline hash. */
  FREEZE_BASELINE: 'freeze-acceptance-baseline',
});

/**
 * Schema identifiers the reconciliation trio produces / consumes. Mirrors
 * `formalization-schemas.ts` (`FORMALIZATION_RECONCILIATION_SCHEMA`,
 * `ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA`).
 *
 * @readonly
 */
export const RECONCILIATION_SCHEMA_IDS = Object.freeze({
  /** Reconciliation report produced by the LM node + resolver. */
  RECONCILIATION_REPORT: 'saga3.formalization-reconciliation-report.v1',
  /** Immutable AC baseline snapshot materialized by the freezer. */
  BASELINE_SNAPSHOT: 'saga3.acceptance-baseline-snapshot.v1',
  /** Work-intent schema for the `formalization.reconcile` intent kind. */
  WORK_INTENT: 'saga3.work-intent.formalization-reconciliation.v1',
});

/**
 * Module-relative resource paths (relative to the formalization package root
 * `modules/formalization/package/`).
 *
 * @readonly
 */
export const RECONCILIATION_RESOURCE_PATHS = Object.freeze({
  /** Skill fragment: reconciler WHAT-side repair instructions. */
  RECONCILER_SKILL: 'nodes/acceptance/resources/skills/reconciler-skill.md',
  /** Skill fragment: requirements-reviewer reconciliation review. */
  RECONCILER_REVIEW_SKILL: 'nodes/acceptance/resources/skills/reconciliation-reviewer-skill.md',
  /** MCP call template: trace_add for repaired edges (no artifact_create). */
  TRACE_CALL: 'nodes/acceptance/resources/templates/reconciliation-trace-add-call-template.json',
  /** MCP call template: worker_done completion. */
  DONE_CALL: 'nodes/acceptance/resources/templates/reconciliation-worker-done-call-template.json',
  /** LM node pre-submit checklist (reconciliation-scoped). */
  CHECKLIST: 'nodes/acceptance/resources/templates/reconciliation-node-checklist.md',
  /** JSON Schema for the reconciliation-report output. */
  REPORT_SCHEMA: 'nodes/acceptance/resources/schemas/reconciliation-report.schema.json',
  /** JSON Schema for the acceptance-baseline snapshot. */
  BASELINE_SCHEMA: 'nodes/acceptance/resources/schemas/acceptance-baseline-snapshot.schema.json',
});

/**
 * The reconciler LM node protocol. The reconciler is a trace-repair role: it
 * does NOT create new WHAT artifacts, only repairs permitted missing
 * `derived_from` / `covers` edges and reports unresolved contradictions. Its
 * `allowedTools` therefore omits `artifact_create` (matching the
 * `formalization-reconciler` execution profile's workspaceTemplates which
 * carry only TRACE_CALL + DONE_CALL).
 *
 * @type {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition}
 */
export const RECONCILE_WHAT_PROTOCOL = Object.freeze({
  id: 'formalization.reconcile-what',
  version: '1.0.0',
  owningFlowNodeId: RECONCILIATION_NODE_IDS.RECONCILE,
  entryStep: 'audit-what-lineage',
  steps: [
    {
      id: 'audit-what-lineage',
      instructions:
        'Read the kernel-accepted PRD, FR, NFR, RULE, UC and AC artifacts in this ' +
        'REQ episode. Audit the required derived_from / covers / enforced_by ' +
        'edges. SRS does NOT exist yet at this stage — do not read or wait for it.',
      resources: [
        RECONCILIATION_RESOURCE_PATHS.RECONCILER_SKILL,
        RECONCILIATION_RESOURCE_PATHS.REPORT_SCHEMA,
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
          contractRef: {
            schemaId: RECONCILIATION_SCHEMA_IDS.RECONCILIATION_REPORT,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'repair-traces',
      instructions:
        'Repair only permitted missing traceability edges using the materialized ' +
        'trace_add call template. Do NOT create or edit WHAT artifacts (PRD/FR/NFR/' +
        'RULE/UC/AC) — that authority stays with the kernel gate. Query existing ' +
        'traces before creating replacements.',
      resources: [RECONCILIATION_RESOURCE_PATHS.TRACE_CALL],
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
        'Run the reconciliation-scoped pre-submit checklist. Confirm every ' +
        'accepted WHAT artifact has its required trace links and that no ' +
        'contradiction was silently repaired away.',
      resources: [RECONCILIATION_RESOURCE_PATHS.CHECKLIST],
      allowedTools: ['Read', 'Glob', 'Grep'],
      evidenceRequirements: [
        {
          category: 'human-receipt',
          contractRef: {
            schemaId: 'saga3.checklist.reconciliation.v1',
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'submit-reconciliation',
      instructions:
        'Materialize the worker_done call. Expose any unresolved WHAT-side ' +
        'contradiction in the result; the kernel resolver will route to ' +
        'domain.inconsistent if the contradiction is blocking. Do NOT freeze the ' +
        'baseline — the kernel-owned freeze-acceptance-baseline node does that.',
      resources: [RECONCILIATION_RESOURCE_PATHS.DONE_CALL],
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
    { from: 'audit-what-lineage', to: 'repair-traces', kind: 'linear' },
    { from: 'repair-traces', to: 'verify-checklist', kind: 'linear' },
    { from: 'verify-checklist', to: 'submit-reconciliation', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'artifact-reference',
      contractRef: {
        schemaId: RECONCILIATION_SCHEMA_IDS.RECONCILIATION_REPORT,
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
  recoveryEntrySteps: ['audit-what-lineage'],
  retrySemantics: 'runtime-implemented-backoff',
});

/**
 * The reconciliation kernel-resolver node protocol. Re-reads the exact WHAT
 * lineage, validates acceptance + traceability, and materializes the
 * reconciliation result. Routes to the freezer on `domain.reconciled`, back to
 * the reconciler on `domain.repair-required`, or to a terminal on
 * inconsistent / clarification / failed.
 *
 * @type {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition}
 */
export const RESOLVE_RECONCILIATION_PROTOCOL = Object.freeze({
  id: 'formalization.resolve-reconciliation',
  version: '1.0.0',
  owningFlowNodeId: RECONCILIATION_NODE_IDS.RESOLVE,
  entryStep: 'read-what-lineage',
  steps: [
    {
      id: 'read-what-lineage',
      instructions:
        'Re-read the exact WHAT-side lineage (PRD/FR/NFR/RULE/UC/AC + traces) ' +
        'from the managed-execution provenance ledger. The resolver is the ' +
        'authority on what was actually written, not the reconciler self-report.',
      resources: [RECONCILIATION_RESOURCE_PATHS.REPORT_SCHEMA],
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
      id: 'validate-reconciliation',
      instructions:
        'Validate acceptance completeness and traceability (formalization-what-' +
        'reconciliation policy). Trace gaps route back to the reconciler; ' +
        'unresolved contradictions route to domain.inconsistent.',
      resources: [
        RECONCILIATION_RESOURCE_PATHS.REPORT_SCHEMA,
        RECONCILIATION_RESOURCE_PATHS.CHECKLIST,
      ],
      allowedTools: ['artifact_list', 'trace_list', 'Read', 'Grep'],
      evidenceRequirements: [
        {
          category: 'module-verifier-receipt',
          contractRef: {
            schemaId: RECONCILIATION_SCHEMA_IDS.RECONCILIATION_REPORT,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'materialize-report',
      instructions:
        'Materialize the reconciliation result that the baseline freezer consumes ' +
        'as its input. Emit domain.reconciled on success.',
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
    { from: 'read-what-lineage', to: 'validate-reconciliation', kind: 'linear' },
    { from: 'validate-reconciliation', to: 'materialize-report', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'module-verifier-receipt',
      contractRef: {
        schemaId: RECONCILIATION_SCHEMA_IDS.RECONCILIATION_REPORT,
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['read-what-lineage'],
  retrySemantics: 'runtime-implemented-backoff',
});

/**
 * The baseline-freezer kernel node protocol. Computes the immutable acceptance
 * baseline hash from the accepted AC set and persists the
 * `acceptance-baseline-snapshot`. Routes to SRS authoring on `domain.frozen`,
 * to `domain.drift-detected` if the AC set drifted under the freezer, or to
 * failed. The freezer is kernel-authority only — no LM step, no allowed tools
 * for authoring.
 *
 * @type {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition}
 */
export const FREEZE_ACCEPTANCE_BASELINE_PROTOCOL = Object.freeze({
  id: 'formalization.freeze-acceptance-baseline',
  version: '1.0.0',
  owningFlowNodeId: RECONCILIATION_NODE_IDS.FREEZE_BASELINE,
  entryStep: 'compute-baseline',
  steps: [
    {
      id: 'compute-baseline',
      instructions:
        'Compute the acceptance baseline hash from the canonical JSON of the ' +
        'accepted AC set (sorted by artifact id, content-addressed). The input is ' +
        'the materialized reconciliation report.',
      resources: [RECONCILIATION_RESOURCE_PATHS.BASELINE_SCHEMA],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'external-receipt',
          contractRef: {
            schemaId: RECONCILIATION_SCHEMA_IDS.RECONCILIATION_REPORT,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
    {
      id: 'persist-snapshot',
      instructions:
        'Persist the immutable acceptance-baseline-snapshot. Emit domain.frozen ' +
        'on success; domain.drift-detected if the AC set changed under the freezer ' +
        '(the snapshot is rejected and the episode routes to inconsistent).',
      resources: [RECONCILIATION_RESOURCE_PATHS.BASELINE_SCHEMA],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: {
            schemaId: RECONCILIATION_SCHEMA_IDS.BASELINE_SNAPSHOT,
            version: '1.0.0',
            digest: 'pending@wave-2',
          },
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'compute-baseline', to: 'persist-snapshot', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'artifact-reference',
      contractRef: {
        schemaId: RECONCILIATION_SCHEMA_IDS.BASELINE_SNAPSHOT,
        version: '1.0.0',
        digest: 'pending@wave-2',
      },
      required: true,
    },
  ],
  recoveryEntrySteps: ['compute-baseline'],
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Convenience array of every reconciliation-trio NodeProtocolDefinition owned
 * by this subtree. W8-A1 imports this and submits each entry to the central
 * formalization manifest's protocol index.
 *
 * @readonly
 * @returns {readonly import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition[]}
 */
export const RECONCILIATION_NODE_PROTOCOLS = Object.freeze([
  RECONCILE_WHAT_PROTOCOL,
  RESOLVE_RECONCILIATION_PROTOCOL,
  FREEZE_ACCEPTANCE_BASELINE_PROTOCOL,
]);
