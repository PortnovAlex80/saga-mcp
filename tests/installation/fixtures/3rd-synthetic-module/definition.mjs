// @ts-check
/**
 * W2-A7 — 3rd synthetic module fixture: Kernel-node "compliance" module.
 *
 * Data-only fixture describing a `ProcessModuleDefinition`-shaped object for a
 * Kernel node module that "checks compliance". This is a 5TH synthetic module,
 * DISTINCT from W0-A7's four (lm-marketing, kernel-analytics, human-director-
 * approval, external-seo). It is the §14.4.7 exit-gate proof:
 *
 *   Installing this fixture requires NO edit to `modules/catalog.ts`, NO edit
 *   to Runtime, NO edit to another module. It installs purely via the W2-A3
 *   installer + W2-A1 store + W2-A2 repo.
 *
 * Identity:
 *   - `name`:    `synthetic-compliance-check`
 *   - `version`: `0.1.0`
 *   - `kind`:    `compliance`     (Kernel-node variant)
 *   - one Kernel node, one outcome (`compliance-passed`)
 *   - 2 resource files so `resourceIndex` is non-empty (proves resource
 *     resolution by W2-A3 installer / W2-A8 conformance).
 *
 * Proof target:
 *   - Wave 2 §14.4.7 no-catalog-edit install gate.
 *   - Wave 2 W2-A7 `describeInstallation` projection (counts + flow summary).
 *   - Wave 2 W2-A8 conformance install-replay proof consumes THIS fixture.
 *
 * This file mirrors W0-A7's `lm-marketing/definition.mjs` + `kernel-analytics/
 * definition.mjs` patterns: pure data, no real handler code, no DB, no
 * filesystem side effects. The handler is a *reference string* only.
 *
 * Plan ref: §0.5.12, §14.4.7 (3rd-synthetic-module exit gate).
 *
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleIdentity} ProcessModuleIdentity
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').FlowDefinition} FlowDefinition
 */

/** @type {Readonly<{ name: string; version: string }>} */
export const COMPLIANCE_CHECK_MODULE_REF = Object.freeze({
  name: 'synthetic-compliance-check',
  version: '0.1.0',
});

/**
 * Opaque schema identifiers (mirror `SchemaReference { id: string }`). These
 * are intentionally opaque strings so this fixture does NOT bind to any
 * concrete JSON Schema document — Wave 1's `ContractSchemaRegistry` (or a
 * Wave 2+ caller) registers codecs behind these ids.
 */
export const COMPLIANCE_CHECK_INPUT_SCHEMA = 'synthetic.compliance.input.v1';
export const COMPLIANCE_CHECK_OUTPUT_SCHEMA = 'synthetic.compliance.output.v1';

/**
 * Exact versioned handler reference (plan §5.5.10 / §5.2.13). Kernel handler
 * references carry exact versions; Wave 2 binds this reference to packaged
 * bytes via the installer + dependency lock.
 */
export const COMPLIANCE_CHECK_HANDLER_REF = 'compliance-check-handler@1.0.0';

/**
 * One FlowDefinition with one Kernel node (`run-check`) referencing the handler
 * above.
 *
 * @type {FlowDefinition}
 */
const complianceCheckFlow = {
  id: 'synthetic.compliance-check.standard',
  version: '0.1.0',
  entryNodeId: 'run-check',
  nodes: [
    {
      id: 'run-check',
      label: 'Run Compliance Check',
      kind: 'kernel',
      description:
        'Deterministically evaluate a workspace against the compliance checklist.',
      handler: COMPLIANCE_CHECK_HANDLER_REF,
      inputSchema: { id: COMPLIANCE_CHECK_INPUT_SCHEMA },
      outputSchema: { id: COMPLIANCE_CHECK_OUTPUT_SCHEMA },
      emitsOutcome: 'compliance-passed',
    },
  ],
  transitions: [],
  terminalNodeIds: ['run-check'],
};

/**
 * The full data-only module fixture.
 *
 * @type {ProcessModuleDefinition}
 */
export const complianceCheckModule = {
  identity: {
    ...COMPLIANCE_CHECK_MODULE_REF,
    kind: 'compliance',
    displayName: 'Synthetic Compliance Check',
    description:
      'W2-A7 synthetic Kernel-node fixture (compliance). Data-only — no real handler. Proves the §14.4.7 no-catalog-edit install gate.',
  },
  inputContract: { id: COMPLIANCE_CHECK_INPUT_SCHEMA },
  outputContract: { id: COMPLIANCE_CHECK_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'compliance-passed',
      description:
        'The workspace satisfies every item on the compliance checklist.',
      terminal: true,
    },
  ],
  flow: complianceCheckFlow,
  artifacts: [
    {
      type: 'synthetic.compliance-result',
      schema: { id: COMPLIANCE_CHECK_OUTPUT_SCHEMA },
      authority: 'kernel',
      description:
        'Opaque compliance-result envelope produced by the Kernel node.',
    },
  ],
  policies: [],
  invariants: [
    {
      id: 'synthetic.compliance.deterministic',
      description:
        'The compliance verdict is purely deterministic for the same input bytes (synthetic contract placeholder).',
      enforcement: 'test',
    },
  ],
  executionProfiles: [],
};

/**
 * Resource index — paths are RELATIVE to THIS fixture directory (plan §5.3 —
 * module-relative resource resolution). Two resources are declared so the
 * Wave 2 installer's resourceIndex is non-empty (proves resource resolution
 * across kinds: `checklist` + `schema`). The W2-A3 installer resolves each
 * under the package root and rejects absolute / traversal paths.
 */
export const complianceCheckResourceIndex = Object.freeze([
  {
    logicalId: 'compliance-checklist',
    path: 'checklists/compliance-checklist.md',
    kind: 'checklist',
  },
  {
    logicalId: 'input-schema',
    path: 'schemas/compliance-input.schema.json',
    kind: 'schema',
  },
]);

export default complianceCheckModule;
