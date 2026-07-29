// @ts-check
/**
 * {{MODULE_NAME}} — LM-node Process Module definition.
 *
 * Generated from the Module Authoring Kit (tools/module-authoring-kit/).
 * This is a `ProcessModuleDefinition`-shaped plain object. It is the wrapped
 * `definition` field of the package manifest (manifest.json); the two are kept
 * in lock-step by the validator (run `node tools/module-authoring-kit/validator.mjs
 * validate ./manifest.json`).
 *
 * Replace the placeholder identity/schemas/flow with your module's real contract.
 * The shape below MUST stay `ProcessModuleDefinition`-compatible so the canonical
 * `validateProcessModuleManifest` (the same one the installer runs) accepts it.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md
 * Plan: §0.3.8, §3.5 (purity), §0.13.10 (extensibility proof).
 */

/**
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleIdentity} ProcessModuleIdentity
 */

/** Module identity — mirrors manifest.json `definition.identity`. */
export const IDENTITY = Object.freeze({
  name: '{{MODULE_NAME}}',
  version: '{{MODULE_VERSION}}',
  kind: '{{MODULE_KIND}}',
  displayName: '{{MODULE_DISPLAY_NAME}}',
  description: '{{MODULE_DESCRIPTION}}',
});

/** Opaque schema ids. Replace with real contract schema ids. */
export const INPUT_SCHEMA = '{{MODULE_NAME}}.input.v1';
export const OUTPUT_SCHEMA = '{{MODULE_NAME}}.output.v1';
export const WORK_INTENT_SCHEMA = '{{MODULE_NAME}}.work-intent.v1';

/** Execution profile for the LM author node. */
export const authorProfile = {
  id: 'author',
  workIntentKind: '{{MODULE_NAME}}.draft',
  workIntentSchema: { id: WORK_INTENT_SCHEMA },
  taskKind: '{{MODULE_NAME}}.draft',
  executionSkill: '{{MODULE_NAME}}-execution-skill',
  reviewSkill: '{{MODULE_NAME}}-review-skill',
  protocolSkill: '{{MODULE_NAME}}-worker-protocol',
  semanticSkill: 'resources/execution-skill.md',
  executionMode: 'git_change',
  allowedTools: ['Read', 'Write', 'Edit'],
  trackerTemplate: 'resources/tracker.md',
  workspaceTemplates: [],
  callTemplates: [],
  checklists: [],
  outputSchema: { id: OUTPUT_SCHEMA },
  retryPolicy: {
    maxAttempts: 2,
    retryOn: ['draft-rejected'],
    backoff: 'fixed',
  },
  recoveryPolicy: {
    resumeFromCheckpoint: true,
    reuseWorkIntent: false,
    reuseAcceptedOutput: false,
    onExhausted: 'pause',
  },
};

/**
 * The full module definition.
 * @type {ProcessModuleDefinition}
 */
export const moduleDefinition = {
  identity: IDENTITY,
  inputContract: { id: INPUT_SCHEMA },
  outputContract: { id: OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'drafted',
      description: 'A typed draft envelope was produced.',
      terminal: true,
    },
  ],
  flow: {
    id: '{{MODULE_NAME}}.standard',
    version: '{{MODULE_VERSION}}',
    entryNodeId: 'draft',
    nodes: [
      {
        id: 'draft',
        label: 'Draft',
        kind: 'lm',
        description: 'Produce a typed draft envelope from the input brief.',
        executionProfile: 'author',
        inputSchema: { id: INPUT_SCHEMA },
        outputSchema: { id: OUTPUT_SCHEMA },
        emitsOutcome: 'drafted',
      },
    ],
    transitions: [],
    terminalNodeIds: ['draft'],
  },
  artifacts: [
    {
      type: '{{MODULE_NAME}}.draft',
      schema: { id: OUTPUT_SCHEMA },
      authority: 'worker',
      description: 'Opaque draft envelope produced by the LM node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [authorProfile],
};

export default moduleDefinition;
