// @ts-check
/**
 * W0-A7 synthetic fixture: Human-node module.
 *
 * Data-only fixture describing a `ProcessModuleDefinition`-shaped object for a
 * Human node module. Human nodes pause for an external human decision through
 * an interaction contract (plan §7.2, §4.4.6). This fixture declares an
 * adapter *reference* string only — `director-console-adapter@1.0.0` — and
 * ships no real adapter code.
 *
 * Notable: this module exposes TWO outcomes (`approved`, `rejected`) so the
 * campaign scenario can route deterministically to two different terminal
 * statuses from a single Human stage (plan §6.3.5: complete route table for
 * every declared module outcome).
 *
 * Proof target:
 *   - Wave 1 SPI (ProcessModuleManifest validation, Human node
 *     `interactionContract` shape).
 *   - Wave 4 recovery conformance (human action as a recovery event).
 *   - Wave 10 Human Director Approval production package mirrors this shape.
 *
 * Plan ref: §0.3.8, §14.1.4, §15.11.
 *
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').FlowDefinition} FlowDefinition
 */

/** @type {Readonly<{ name: string; version: string }>} */
export const HUMAN_DIRECTOR_APPROVAL_MODULE_REF = Object.freeze({
  name: 'synthetic-human-director-approval',
  version: '0.1.0',
});

export const HUMAN_DIRECTOR_INPUT_SCHEMA = 'synthetic.director-approval.input.v1';
export const HUMAN_DIRECTOR_OUTPUT_SCHEMA = 'synthetic.director-approval.output.v1';
export const HUMAN_DIRECTOR_INTERACTION_CONTRACT = 'synthetic.director.signoff.v1';

/**
 * Exact versioned adapter reference (plan §5.5.10). Wave 2 / Wave 4 bind this
 * to the human-interaction registry.
 */
export const DIRECTOR_CONSOLE_ADAPTER_REF = 'director-console-adapter@1.0.0';

/**
 * One FlowDefinition with one Human node (`director-signoff`) referencing the
 * adapter above and an `interactionContract`.
 *
 * @type {FlowDefinition}
 */
const humanDirectorFlow = {
  id: 'synthetic.human-director-approval.standard',
  version: '0.1.0',
  entryNodeId: 'director-signoff',
  nodes: [
    {
      id: 'director-signoff',
      label: 'Director Sign-off',
      kind: 'human',
      description:
        'Pause for a director sign-off decision (approve / reject) on the scored campaign.',
      interactionContract: { id: HUMAN_DIRECTOR_INTERACTION_CONTRACT },
      inputSchema: { id: HUMAN_DIRECTOR_INPUT_SCHEMA },
      outputSchema: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
    },
  ],
  transitions: [],
  terminalNodeIds: ['director-signoff'],
};

/**
 * The full data-only module fixture. Two terminal outcomes so the scenario can
 * prove complete route tables for every declared outcome.
 *
 * @type {ProcessModuleDefinition}
 */
export const humanDirectorApprovalModule = {
  identity: {
    ...HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
    kind: 'human-approval',
    displayName: 'Synthetic Human Director Approval',
    description:
      'W0-A7 synthetic Human-node fixture. Data-only — no real adapter. Proves the SPI is module-kind-agnostic.',
  },
  inputContract: { id: HUMAN_DIRECTOR_INPUT_SCHEMA },
  outputContract: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'approved',
      description: 'The director approved the campaign.',
      terminal: true,
    },
    {
      code: 'rejected',
      description: 'The director rejected the campaign.',
      terminal: true,
    },
  ],
  flow: humanDirectorFlow,
  artifacts: [
    {
      type: 'synthetic.director-decision',
      schema: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
      authority: 'human',
      description: 'Opaque director decision envelope produced by the Human node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

export const humanDirectorApprovalResourceIndex = Object.freeze([
  { logicalId: 'interaction-schema', path: 'schemas/director-signoff.schema.json', kind: 'schema' },
]);

export default humanDirectorApprovalModule;
