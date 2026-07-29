// @ts-check
/**
 * W10-A1 — lm-marketing Process Module DEFINITION.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 *
 * This is the pure `ProcessModuleDefinition` for the Marketing LM Process
 * Module package (`lm-marketing@1.0.0`). It is the upgrade of the W0-A7
 * `tests/fixtures/synthetic-modules/lm-marketing/` data-only fixture into a
 * real installable package: a concrete `lm` flow node, a concrete
 * `marketing-author` execution profile pinning real package-local resources,
 * one terminal outcome, and a real `marketing.campaign-draft` artifact.
 *
 * Pure canonical data only (plan §3.5): every exported value is a frozen,
 * serializable constant. The file imports ONLY the public process-module SPI
 * types via JSDoc (`import type` from the compiled `dist/` runtime surface) —
 * it never imports `src/index.ts`, `modules/catalog.ts`, `tracker-view/`, the
 * composition root, or any existing built-in module. That import discipline IS
 * the §0.13.10 proof: an arbitrary LM package installs and executes through the
 * SPI alone.
 *
 * Plan ref: §3.5 (purity), §3.6 (Runtime is module-kind-agnostic), §5.3
 * (module-relative resource resolution), §7.2, §8.2 (NodeProtocol), §0.13.10.
 *
 * @typedef {import('../../dist/process-modules/domain/process-module.js').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../dist/process-modules/domain/process-module.js').ProcessModuleIdentity} ProcessModuleIdentity
 * @typedef {import('../../dist/process-modules/domain/process-module.js').FlowDefinition} FlowDefinition
 * @typedef {import('../../dist/process-modules/domain/process-module.js').LmFlowNodeDefinition} LmFlowNodeDefinition
 * @typedef {import('../../dist/process-modules/domain/process-module.js').ExecutionProfileDefinition} ExecutionProfileDefinition
 */

// ---------------------------------------------------------------------------
// Module identity.
//
// `name` / `version` are the canonical `name@version` key the installer and
// runtime use to register and look up the package. `kind: 'lm-marketing'` is an
// OPAQUE module-kind string — the Runtime never switches on it (plan §3.6); it
// is metadata for catalog/describe views only.
// ---------------------------------------------------------------------------

/**
 * The canonical `name@version` identity of the Marketing LM module.
 * @type {Readonly<{ name: string; version: string }>}
 */
export const LM_MARKETING_MODULE_REF = Object.freeze({
  name: 'lm-marketing',
  version: '1.0.0',
});

/** Canonical `name@version` module key. */
export const LM_MARKETING_MODULE_KEY =
  `${LM_MARKETING_MODULE_REF.name}@${LM_MARKETING_MODULE_REF.version}`;

/**
 * Opaque schema identifiers. These mirror the `SchemaReference { id: string }`
 * shape from the domain contract. They are opaque strings so the definition
 * does not bind to a concrete JSON Schema document at load time — the
 * ContractSchemaRegistry (Wave 2/3) registers the concrete codecs in
 * `schemas/*.schema.json` behind these ids. The literal strings are the
 * load-bearing contract.
 */
export const LM_MARKETING_INPUT_SCHEMA = 'saga3-ext.marketing.input.v1';
export const LM_MARKETING_OUTPUT_SCHEMA = 'saga3-ext.marketing.output.v1';
export const LM_MARKETING_WORK_INTENT_SCHEMA = 'saga3-ext.marketing.work-intent.v1';

/**
 * The flow node id this module owns. Matches `flow.entryNodeId`,
 * `flow.nodes[0].id`, and the `owningFlowNodeId` on the NodeProtocol
 * (`node-protocol.mjs`).
 */
export const LM_MARKETING_FLOW_NODE_ID = 'draft-campaign';

/**
 * The execution-profile id the LM node references. Matches the
 * `marketing-author` profile declared below.
 */
export const LM_MARKETING_EXECUTION_PROFILE_ID = 'marketing-author';

/**
 * Module-relative POSIX paths to the package-local resources this definition's
 * execution profile pins. Mirrors the W8/W9 pattern: paths are relative to the
 * PACKAGE root (this directory), resolved by the installer under the package
 * root, and never via global lookup (plan §5.3, WAVE10-EXTENSIBILITY-SPEC §4).
 */
const RESOURCE_PATHS = Object.freeze({
  semanticSkill: 'skills/marketing-author-skill.md',
  draftTemplate: 'templates/campaign-draft-template.md',
  draftTracker: 'templates/campaign-draft-tracker.md',
  draftChecklist: 'templates/campaign-draft-checklist.md',
  draftCallTemplate: 'templates/campaign-draft-call-template.json',
  inputSchema: 'schemas/marketing-input.schema.json',
  outputSchema: 'schemas/marketing-output.schema.json',
  workIntentSchema: 'schemas/marketing-work-intent.schema.json',
});

/**
 * @returns {readonly { logicalId: string; path: string; kind: string }[]}
 *   The full resource index declared by the package. `digest` is filled in by
 *   the manifest envelope (Wave 2 content-addressed installer placeholder) —
 *   the definition itself carries only logicalId / path / kind so it stays
 *   pure data about WHAT the module pins, not HOW the bytes hash.
 */
export function marketingResourcePaths() {
  return Object.freeze([
    { logicalId: 'marketing.skill.author', path: RESOURCE_PATHS.semanticSkill, kind: 'skill' },
    { logicalId: 'marketing.template.draft', path: RESOURCE_PATHS.draftTemplate, kind: 'template' },
    { logicalId: 'marketing.tracker.draft', path: RESOURCE_PATHS.draftTracker, kind: 'template' },
    { logicalId: 'marketing.checklist.draft', path: RESOURCE_PATHS.draftChecklist, kind: 'checklist' },
    { logicalId: 'marketing.call-template.draft', path: RESOURCE_PATHS.draftCallTemplate, kind: 'mcp-call-template' },
    { logicalId: 'marketing.schema.input', path: RESOURCE_PATHS.inputSchema, kind: 'schema' },
    { logicalId: 'marketing.schema.output', path: RESOURCE_PATHS.outputSchema, kind: 'schema' },
    { logicalId: 'marketing.schema.work-intent', path: RESOURCE_PATHS.workIntentSchema, kind: 'schema' },
  ]);
}

// ---------------------------------------------------------------------------
// Execution profile.
//
// Mirrors `ExecutionProfileDefinition`. The `semanticSkill` /
// `trackerTemplate` paths are module-RELATIVE so the runtime resolves them
// through the package and never through global lookup (plan §5.3, §13.17).
// `protocolSkill` would point at the shared worker-protocol skill in a built-in
// module; for this self-contained proof package the marketing-author skill
// carries the protocol inline, so the profile does not pin a separate protocol
// skill (this keeps the package free of any cross-module dependency).
// ---------------------------------------------------------------------------

/**
 * The `marketing-author` execution profile. Drives the `draft-campaign` LM node.
 *
 * @type {ExecutionProfileDefinition}
 */
export const marketingAuthorProfile = Object.freeze({
  id: LM_MARKETING_EXECUTION_PROFILE_ID,
  workIntentKind: 'marketing.campaign-draft',
  workIntentSchema: { id: LM_MARKETING_WORK_INTENT_SCHEMA },
  taskKind: 'marketing.draft-campaign',
  executionSkill: 'marketing-author-execution-skill',
  reviewSkill: 'marketing-author-review-skill',
  semanticSkill: RESOURCE_PATHS.semanticSkill,
  executionMode: 'git_change',
  allowedTools: Object.freeze(['Read', 'Write', 'Edit', 'worker_done']),
  trackerTemplate: RESOURCE_PATHS.draftTracker,
  workspaceTemplates: Object.freeze([RESOURCE_PATHS.draftTemplate]),
  callTemplates: Object.freeze([RESOURCE_PATHS.draftCallTemplate]),
  checklists: Object.freeze([RESOURCE_PATHS.draftChecklist]),
  outputSchema: { id: LM_MARKETING_OUTPUT_SCHEMA },
  retryPolicy: Object.freeze({
    maxAttempts: 2,
    retryOn: Object.freeze(['draft-rejected']),
    backoff: 'fixed',
  }),
  recoveryPolicy: Object.freeze({
    resumeFromCheckpoint: true,
    reuseWorkIntent: false,
    reuseAcceptedOutput: false,
    onExhausted: 'pause',
  }),
});

// ---------------------------------------------------------------------------
// Flow.
//
// One LM flow node (`draft-campaign`) referencing the `marketing-author`
// execution profile. The node is terminal and emits one outcome
// (`campaign-drafted`).
// ---------------------------------------------------------------------------

/**
 * The single-node marketing flow.
 *
 * @type {FlowDefinition}
 */
const lmMarketingFlow = Object.freeze({
  id: 'lm-marketing.draft-campaign',
  version: '1.0.0',
  entryNodeId: LM_MARKETING_FLOW_NODE_ID,
  nodes: Object.freeze([
    Object.freeze({
      id: LM_MARKETING_FLOW_NODE_ID,
      label: 'Draft Campaign',
      kind: 'lm',
      description:
        'Produce a typed CampaignDraft envelope from a MarketingBrief using the marketing-author execution profile.',
      executionProfile: LM_MARKETING_EXECUTION_PROFILE_ID,
      inputSchema: { id: LM_MARKETING_INPUT_SCHEMA },
      outputSchema: { id: LM_MARKETING_OUTPUT_SCHEMA },
      emitsOutcome: 'campaign-drafted',
    }),
  ]),
  transitions: Object.freeze([]),
  terminalNodeIds: Object.freeze([LM_MARKETING_FLOW_NODE_ID]),
});

// ---------------------------------------------------------------------------
// Definition.
//
// The full pure ProcessModuleDefinition. Mirrors the shape the four built-in
// modules use; the only difference is `identity.kind` is an opaque
// module-kind string and the resources are package-local.
// ---------------------------------------------------------------------------

/**
 * The full Marketing LM Process Module definition.
 *
 * @type {ProcessModuleDefinition}
 */
export const lmMarketingModule = Object.freeze({
  identity: Object.freeze({
    ...LM_MARKETING_MODULE_REF,
    kind: 'lm-marketing',
    displayName: 'LM Marketing',
    description:
      'W10-A1 arbitrary-extensibility proof: a self-contained LM-node Process Module package that installs and executes through the public SPI alone, with no Runtime, catalog, runner, or existing-module dependency.',
  }),
  inputContract: Object.freeze({ id: LM_MARKETING_INPUT_SCHEMA }),
  outputContract: Object.freeze({ id: LM_MARKETING_OUTPUT_SCHEMA }),
  outcomes: Object.freeze([
    Object.freeze({
      code: 'campaign-drafted',
      description: 'A typed CampaignDraft envelope was produced and accepted.',
      terminal: true,
    }),
  ]),
  flow: lmMarketingFlow,
  artifacts: Object.freeze([
    Object.freeze({
      type: 'marketing.campaign-draft',
      schema: { id: LM_MARKETING_OUTPUT_SCHEMA },
      authority: 'worker',
      description:
        'The typed CampaignDraft envelope produced by the draft-campaign LM node.',
    }),
  ]),
  policies: Object.freeze([]),
  invariants: Object.freeze([]),
  executionProfiles: Object.freeze([marketingAuthorProfile]),
});

export default lmMarketingModule;
