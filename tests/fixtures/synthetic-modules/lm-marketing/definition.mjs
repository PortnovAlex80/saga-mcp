// @ts-check
/**
 * W0-A7 synthetic fixture: LM-node module.
 *
 * Data-only fixture describing a `ProcessModuleDefinition`-shaped object for an
 * LM (Language Model) node module. It deliberately ships NO real handlers, NO
 * database, NO filesystem side effects. It declares handler/adapter *references*
 * (strings) only, so later waves can validate manifest shape, identity, digest,
 * and installation binding without depending on executable behavior.
 *
 * Proof target:
 *   - Wave 1 SPI (ProcessModuleManifest validation, canonical JSON round-trip).
 *   - Wave 10 LM Marketing production package mirrors this shape.
 *
 * Plan ref: §0.3.8, §14.1.4, §15.11.
 *
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleIdentity} ProcessModuleIdentity
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').FlowDefinition} FlowDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ExecutionProfileDefinition} ExecutionProfileDefinition
 */

/** @type {Readonly<{ name: string; version: string }>} */
export const LM_MARKETING_MODULE_REF = Object.freeze({
  name: 'synthetic-lm-marketing',
  version: '0.1.0',
});

/**
 * Opaque schema identifiers. These mirror the `SchemaReference { id: string }`
 * shape from the domain contract. They are intentionally opaque strings so the
 * fixture does not bind to any concrete JSON Schema document — Wave 1's
 * ContractSchemaRegistry will register concrete codecs behind these ids.
 */
export const LM_MARKETING_INPUT_SCHEMA = 'synthetic.marketing.input.v1';
export const LM_MARKETING_OUTPUT_SCHEMA = 'synthetic.marketing.output.v1';
export const LM_MARKETING_WORK_INTENT_SCHEMA = 'synthetic.marketing.work-intent.v1';

/**
 * Execution profile for the LM node. Mirrors `ExecutionProfileDefinition`.
 *
 * `semanticSkill` is a relative path inside this fixture directory so the
 * Wave 2 resource resolver can prove module-relative resolution without a
 * global skills/ lookup (plan §5.3, §13.17).
 *
 * @type {ExecutionProfileDefinition}
 */
export const marketingAuthorProfile = {
  id: 'marketing-author',
  workIntentKind: 'synthetic.marketing.campaign-draft',
  workIntentSchema: { id: LM_MARKETING_WORK_INTENT_SCHEMA },
  taskKind: 'marketing.draft-campaign',
  executionSkill: 'synthetic-marketing-execution-skill',
  reviewSkill: 'synthetic-marketing-review-skill',
  protocolSkill: 'synthetic-process-module-worker-protocol',
  semanticSkill: 'skills/synthetic-marketing-skill.md',
  executionMode: 'git_change',
  allowedTools: ['Read', 'Write', 'Edit'],
  trackerTemplate: 'templates/campaign-draft-tracker.md',
  workspaceTemplates: [],
  callTemplates: [],
  checklists: [],
  outputSchema: { id: LM_MARKETING_OUTPUT_SCHEMA },
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
 * One FlowDefinition with one LM node (`draft-campaign`) referencing the
 * `marketing-author` execution profile.
 *
 * @type {FlowDefinition}
 */
const lmMarketingFlow = {
  id: 'synthetic.lm-marketing.standard',
  version: '0.1.0',
  entryNodeId: 'draft-campaign',
  nodes: [
    {
      id: 'draft-campaign',
      label: 'Draft Campaign',
      kind: 'lm',
      description: 'Produce a typed CampaignDraft envelope from a brief.',
      executionProfile: 'marketing-author',
      inputSchema: { id: LM_MARKETING_INPUT_SCHEMA },
      outputSchema: { id: LM_MARKETING_OUTPUT_SCHEMA },
      emitsOutcome: 'campaign-drafted',
    },
  ],
  transitions: [],
  terminalNodeIds: ['draft-campaign'],
};

/**
 * The full data-only module fixture.
 *
 * @type {ProcessModuleDefinition}
 */
export const lmMarketingModule = {
  identity: {
    ...LM_MARKETING_MODULE_REF,
    kind: 'lm-marketing',
    displayName: 'Synthetic LM Marketing',
    description:
      'W0-A7 synthetic LM-node fixture. Data-only — no real handlers. Proves the SPI is module-kind-agnostic.',
  },
  inputContract: { id: LM_MARKETING_INPUT_SCHEMA },
  outputContract: { id: LM_MARKETING_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'campaign-drafted',
      description: 'A typed CampaignDraft envelope was produced.',
      terminal: true,
    },
  ],
  flow: lmMarketingFlow,
  artifacts: [
    {
      type: 'synthetic.campaign-draft',
      schema: { id: LM_MARKETING_OUTPUT_SCHEMA },
      authority: 'worker',
      description: 'Opaque campaign draft envelope produced by the LM node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [marketingAuthorProfile],
};

/**
 * Resource index — paths are relative to THIS fixture directory and prove
 * module-relative resource resolution (plan §5.3). The Wave 2 installer
 * resolves every declared resource under the package root and rejects
 * absolute / traversal paths.
 */
export const lmMarketingResourceIndex = Object.freeze([
  { logicalId: 'semantic-skill', path: 'skills/synthetic-marketing-skill.md', kind: 'skill' },
  { logicalId: 'campaign-template', path: 'templates/campaign-draft-template.md', kind: 'template' },
  { logicalId: 'draft-tracker', path: 'templates/campaign-draft-tracker.md', kind: 'tracker' },
]);

export default lmMarketingModule;
