// @ts-check
/**
 * W0-A7 synthetic fixture: Kernel-node module.
 *
 * Data-only fixture describing a `ProcessModuleDefinition`-shaped object for a
 * Kernel node module. Kernel nodes run deterministic in-process handlers
 * (plan §7.2). This fixture declares a handler *reference* string only —
 * `analytics-compute-handler@1.0.0` — and ships no real handler code.
 *
 * Proof target:
 *   - Wave 1 SPI (ProcessModuleManifest validation, FlowDefinition node-kind
 *     discrimination for `kernel`).
 *   - Wave 2 kernel handler registry binding via exact versioned reference.
 *   - Wave 10 SEO/Analytics production package mirrors this shape.
 *
 * Plan ref: §0.3.8, §14.1.4, §15.11.
 *
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').FlowDefinition} FlowDefinition
 */

/** @type {Readonly<{ name: string; version: string }>} */
export const KERNEL_ANALYTICS_MODULE_REF = Object.freeze({
  name: 'synthetic-kernel-analytics',
  version: '0.1.0',
});

export const KERNEL_ANALYTICS_INPUT_SCHEMA = 'synthetic.analytics.input.v1';
export const KERNEL_ANALYTICS_OUTPUT_SCHEMA = 'synthetic.analytics.output.v1';

/**
 * Exact versioned handler reference. Plan §5.5.10 / §5.2.13: handler
 * references must carry exact versions; caller-declared version strings alone
 * do not prove executable identity. Wave 2 binds this to actual packaged code.
 */
export const ANALYTICS_COMPUTE_HANDLER_REF = 'analytics-compute-handler@1.0.0';

/**
 * One FlowDefinition with one Kernel node (`compute-metrics`) referencing the
 * handler above.
 *
 * @type {FlowDefinition}
 */
const kernelAnalyticsFlow = {
  id: 'synthetic.kernel-analytics.standard',
  version: '0.1.0',
  entryNodeId: 'compute-metrics',
  nodes: [
    {
      id: 'compute-metrics',
      label: 'Compute Metrics',
      kind: 'kernel',
      description:
        'Deterministically compute engagement metrics from a campaign draft.',
      handler: ANALYTICS_COMPUTE_HANDLER_REF,
      inputSchema: { id: KERNEL_ANALYTICS_INPUT_SCHEMA },
      outputSchema: { id: KERNEL_ANALYTICS_OUTPUT_SCHEMA },
      emitsOutcome: 'metrics-computed',
    },
  ],
  transitions: [],
  terminalNodeIds: ['compute-metrics'],
};

/**
 * The full data-only module fixture.
 *
 * @type {ProcessModuleDefinition}
 */
export const kernelAnalyticsModule = {
  identity: {
    ...KERNEL_ANALYTICS_MODULE_REF,
    kind: 'kernel-analytics',
    displayName: 'Synthetic Kernel Analytics',
    description:
      'W0-A7 synthetic Kernel-node fixture. Data-only — no real handler. Proves the SPI is module-kind-agnostic.',
  },
  inputContract: { id: KERNEL_ANALYTICS_INPUT_SCHEMA },
  outputContract: { id: KERNEL_ANALYTICS_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'metrics-computed',
      description: 'Engagement metrics were computed deterministically.',
      terminal: true,
    },
  ],
  flow: kernelAnalyticsFlow,
  artifacts: [
    {
      type: 'synthetic.metrics',
      schema: { id: KERNEL_ANALYTICS_OUTPUT_SCHEMA },
      authority: 'kernel',
      description: 'Opaque metrics envelope produced by the Kernel node.',
    },
  ],
  policies: [],
  invariants: [
    {
      id: 'synthetic.analytics.deterministic',
      description:
        'Compute is purely deterministic for the same input bytes (synthetic contract placeholder).',
      enforcement: 'test',
    },
  ],
  executionProfiles: [],
};

/**
 * Resource index — Kernel modules typically need no LM skills, but a contract
 * schema artifact is declared so the Wave 2 installer can prove resource
 * resolution is uniform across node kinds.
 */
export const kernelAnalyticsResourceIndex = Object.freeze([
  { logicalId: 'input-schema', path: 'schemas/analytics-input.schema.json', kind: 'schema' },
]);

export default kernelAnalyticsModule;
