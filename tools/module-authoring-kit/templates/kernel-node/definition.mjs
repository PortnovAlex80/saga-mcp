// @ts-check
/**
 * {{MODULE_NAME}} — Kernel-node Process Module definition.
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

/** Versioned handler ref. The Wave 2+ handler registry resolves it by logicalId. */
export const COMPUTE_HANDLER_REF = '{{MODULE_NAME}}-compute-handler@1.0.0';

/**
 * @type {ProcessModuleDefinition}
 */
export const moduleDefinition = {
  identity: IDENTITY,
  inputContract: { id: INPUT_SCHEMA },
  outputContract: { id: OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'computed',
      description: 'A typed result envelope was produced deterministically.',
      terminal: true,
    },
  ],
  flow: {
    id: '{{MODULE_NAME}}.standard',
    version: '{{MODULE_VERSION}}',
    entryNodeId: 'compute',
    nodes: [
      {
        id: 'compute',
        label: 'Compute',
        kind: 'kernel',
        description: 'Deterministically compute the result envelope from the input.',
        handler: COMPUTE_HANDLER_REF,
        inputSchema: { id: INPUT_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'computed',
      },
    ],
    transitions: [],
    terminalNodeIds: ['compute'],
  },
  artifacts: [
    {
      type: '{{MODULE_NAME}}.result',
      schema: { id: OUTPUT_SCHEMA },
      authority: 'kernel',
      description: 'Opaque result envelope produced by the Kernel node.',
    },
  ],
  policies: [],
  invariants: [
    {
      id: '{{MODULE_NAME}}.deterministic',
      description: 'Compute is purely deterministic for the same input bytes.',
      enforcement: 'test',
    },
  ],
  executionProfiles: [],
};

export default moduleDefinition;
