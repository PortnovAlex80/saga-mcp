// @ts-check
/**
 * {{MODULE_NAME}} — External-node Process Module definition.
 *
 * Generated from the Module Authoring Kit (tools/module-authoring-kit/).
 * `ProcessModuleDefinition`-shaped plain object — the wrapped `definition` of
 * manifest.json. Keep the two in lock-step; run
 * `node tools/module-authoring-kit/validator.mjs validate ./manifest.json`.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md
 */

/**
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 */

export const IDENTITY = Object.freeze({
  name: '{{MODULE_NAME}}',
  version: '{{MODULE_VERSION}}',
  kind: '{{MODULE_KIND}}',
  displayName: '{{MODULE_DISPLAY_NAME}}',
  description: '{{MODULE_DESCRIPTION}}',
});

export const INPUT_SCHEMA = '{{MODULE_NAME}}.input.v1';
export const OUTPUT_SCHEMA = '{{MODULE_NAME}}.output.v1';

/** Versioned adapter ref. The Wave 2+ external adapter registry resolves it. */
export const EXTERNAL_ADAPTER_REF = '{{MODULE_NAME}}-adapter@1.0.0';

/**
 * @type {ProcessModuleDefinition}
 */
export const moduleDefinition = {
  identity: IDENTITY,
  inputContract: { id: INPUT_SCHEMA },
  outputContract: { id: OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'fetched',
      description: 'A typed snapshot envelope was fetched from the external source.',
      terminal: true,
    },
  ],
  flow: {
    id: '{{MODULE_NAME}}.standard',
    version: '{{MODULE_VERSION}}',
    entryNodeId: 'fetch',
    nodes: [
      {
        id: 'fetch',
        label: 'Fetch',
        kind: 'external',
        description: 'Fetch a snapshot from an external source through a registered adapter.',
        adapter: EXTERNAL_ADAPTER_REF,
        inputSchema: { id: INPUT_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'fetched',
      },
    ],
    transitions: [],
    terminalNodeIds: ['fetch'],
  },
  artifacts: [
    {
      type: '{{MODULE_NAME}}.snapshot',
      schema: { id: OUTPUT_SCHEMA },
      authority: 'external',
      description: 'Opaque snapshot envelope produced by the External node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

export default moduleDefinition;
