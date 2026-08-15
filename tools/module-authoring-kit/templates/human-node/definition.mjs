// @ts-check
/**
 * {{MODULE_NAME}} — Human-node Process Module definition.
 *
 * Generated from the Module Authoring Kit (tools/module-authoring-kit/).
 * `ProcessModuleDefinition`-shaped plain object — the wrapped `definition` of
 * manifest.json.
 *
 * Canonical Human-node pattern (mirrors delivery `approve-release`): the Human
 * node itself is NOT terminal and does NOT `emitsOutcome`. It pauses for a
 * human decision, then routes via transitions to per-outcome terminal kernel
 * emitter nodes (`emit-approved` / `emit-rejected`). This keeps the route table
 * complete for every declared terminal outcome (plan §6.3.5) while satisfying
 * the contract that every terminal node emits exactly one outcome.
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
export const SIGNOFF_INTERACTION_SCHEMA = '{{MODULE_NAME}}.signoff.v1';

/** Versioned interaction-adapter ref. The Wave 2+ human-interaction registry resolves it. */
export const APPROVAL_ADAPTER_REF = '{{MODULE_NAME}}-adapter@1.0.0';

/**
 * @type {ProcessModuleDefinition}
 */
export const moduleDefinition = {
  identity: IDENTITY,
  inputContract: { id: INPUT_SCHEMA },
  outputContract: { id: OUTPUT_SCHEMA },
  outcomes: [
    { code: 'approved', description: 'The human approver accepted.', terminal: true },
    { code: 'rejected', description: 'The human approver rejected.', terminal: true },
  ],
  flow: {
    id: '{{MODULE_NAME}}.standard',
    version: '{{MODULE_VERSION}}',
    entryNodeId: 'approve',
    nodes: [
      {
        id: 'approve',
        label: 'Approve',
        kind: 'human',
        description: 'Pause for a human approve/reject decision.',
        interactionContract: { id: SIGNOFF_INTERACTION_SCHEMA },
        inputSchema: { id: INPUT_SCHEMA },
        outputSchema: { id: SIGNOFF_INTERACTION_SCHEMA },
      },
      {
        id: 'emit-approved',
        label: 'Emit Approved',
        kind: 'kernel',
        description: "Emit the local process outcome 'approved' after the human accepted.",
        handler: 'process-outcome-emitter',
        inputSchema: { id: SIGNOFF_INTERACTION_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'approved',
      },
      {
        id: 'emit-rejected',
        label: 'Emit Rejected',
        kind: 'kernel',
        description: "Emit the local process outcome 'rejected' after the human declined.",
        handler: 'process-outcome-emitter',
        inputSchema: { id: SIGNOFF_INTERACTION_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'rejected',
      },
    ],
    transitions: [
      { from: 'approve', to: 'emit-approved', on: 'domain.approved' },
      { from: 'approve', to: 'emit-rejected', on: 'domain.rejected' },
    ],
    terminalNodeIds: ['emit-approved', 'emit-rejected'],
  },
  artifacts: [
    {
      type: '{{MODULE_NAME}}.decision',
      schema: { id: OUTPUT_SCHEMA },
      authority: 'human',
      description: 'Opaque decision envelope produced by the Human node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

export default moduleDefinition;
