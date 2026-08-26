/**
 * workflow-kernel/workshops/formalization/manifest.ts - the INSTALLED
 * workshop manifest of Solution Formalization (WP-11F, plan phase EK-8
 * workshop conversion).
 *
 * Law: module/package identity lives in installed manifests, NEVER in
 * kernel conditionals. Everything workshop-specific is DATA here:
 *   - identity: module id, version, content digests;
 *   - the process transition graph (eleven nodes, eighteen transitions -
 *     the successor plan's normative target shape: six Production Cells,
 *     two kernel nodes, three terminal nodes; module flows are
 *     installed-manifest content, R17);
 *   - installed skills (protocol + per-desk semantic skills);
 *   - installed tools (the read/write/review tool surfaces);
 *   - installed hooks (additionalContext injections);
 *   - deterministic declared check providers (one per reviewed desk);
 *   - role bindings (launch kinds from the frozen role-contract manifest).
 *
 * The kernel (domain/application/persistence/planning) imports nothing from
 * here; this package imports kernel public surfaces only. No conditionals
 * on module identity exist anywhere in the kernel.
 *
 * PURITY: pure data + pure lookup functions (fail-closed on every miss).
 */

import { sha256OfCanonical } from '../../domain/digest.js';

/** The installed identity of the workshop (content-addressed as data). */
export const FORMALIZATION_MODULE_ID = 'workshop:solution-formalization' as const;
export const FORMALIZATION_MODULE_VERSION = '2.0.0' as const;

/* ------------------------------------------------------------------ */
/* The process transition graph (installed-manifest content, R17)       */
/* ------------------------------------------------------------------ */

export type FormalizationNodeKind = 'production-cell' | 'kernel' | 'terminal';

/** The closed node-disposition vocabulary of the module flow edges. */
export const FLOW_EDGE_EVENTS = [
  'domain.accepted',
  'domain.failed',
  'domain.frozen',
  'domain.drift-detected',
  'domain.formalized',
  'domain.inconsistent',
] as const;
export type FlowEdgeEvent = (typeof FLOW_EDGE_EVENTS)[number];

export interface FormalizationFlowNode {
  readonly id: string;
  readonly label: string;
  readonly kind: FormalizationNodeKind;
  readonly description: string;
  /** The desk descriptor (production-cell and kernel nodes only). */
  readonly desk?: {
    /** The product kind this desk's author must produce. */
    readonly outputProductKind: string;
    /** The declared check provider id gating this desk (fail-closed lookup). */
    readonly checkProviderId: string;
    /** The declared post-acceptance effect id (effects settle via workplace.settleEffect). */
    readonly effectId: string;
    /** Kernel desks are operator-staffed (manifest data; the kernel sees only author/reviewer). */
    readonly operatorStaffed: boolean;
  };
  /** Terminal nodes emit their outcome code and end the flow. */
  readonly emitsOutcome?: 'formalized' | 'inconsistent' | 'failed';
}

export interface FormalizationFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly on: FlowEdgeEvent;
}

/** The eleven target nodes (six Production Cells + two kernel + three terminal). */
export const FORMALIZATION_FLOW_NODES: readonly FormalizationFlowNode[] = [
  {
    id: 'define-product-intent',
    label: 'Define Product Intent',
    kind: 'production-cell',
    description: 'Produce the brief and PRD with stable atomic intent members and required dispositions.',
    desk: { outputProductKind: 'formalization.prd-intent.v1', checkProviderId: 'formalization.prd-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'model-use-cases',
    label: 'Model Use Cases',
    kind: 'production-cell',
    description: 'Produce interaction/operational scenarios with a declared actor of the closed vocabulary.',
    desk: { outputProductKind: 'formalization.uc-scenarios.v1', checkProviderId: 'formalization.uc-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'derive-system-requirements',
    label: 'Derive System Requirements',
    kind: 'production-cell',
    description: 'Produce FR/NFR/RULE artifacts from exact accepted PRD and UC material.',
    desk: { outputProductKind: 'formalization.system-requirements.v1', checkProviderId: 'formalization.requirements-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'define-acceptance-contract',
    label: 'Define Acceptance Contract',
    kind: 'production-cell',
    description: 'Produce acceptance criteria bound to exact FR/NFR material and UC terminal branches.',
    desk: { outputProductKind: 'formalization.acceptance-bindings.v1', checkProviderId: 'formalization.acceptance-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'reconcile-what',
    label: 'Reconcile WHAT Contract',
    kind: 'production-cell',
    description: 'Validate and report the closed WHAT chain; repairs only as new immutable upstream revisions.',
    desk: { outputProductKind: 'formalization.what-reconciliation.v1', checkProviderId: 'formalization.reconciliation-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'freeze-what-baseline',
    label: 'Freeze WHAT Baseline',
    kind: 'kernel',
    description: 'Freeze the content-addressed whole-WHAT baseline over the exact accepted material.',
    desk: { outputProductKind: 'formalization.what-baseline.v1', checkProviderId: 'formalization.baseline-freeze.v1', effectId: 'formalization.freeze-what-baseline', operatorStaffed: true },
  },
  {
    id: 'define-architecture-contract',
    label: 'Define Architecture Contract',
    kind: 'production-cell',
    description: 'Produce the SRS against the frozen WHAT baseline with the mandatory scenario-realization section.',
    desk: { outputProductKind: 'formalization.srs.v1', checkProviderId: 'formalization.srs-structure.v1', effectId: 'formalization.accept-products', operatorStaffed: false },
  },
  {
    id: 'settle-formalization',
    label: 'Settle Formalization',
    kind: 'kernel',
    description: 'Emit the content-addressed Solution Contract over the baseline and the accepted SRS revision.',
    desk: { outputProductKind: 'formalization.solution-contract.v1', checkProviderId: 'formalization.settlement-structure.v1', effectId: 'formalization.settle-solution-contract', operatorStaffed: true },
  },
  { id: 'complete-formalized', label: 'Complete: formalized', kind: 'terminal', description: 'A complete frozen solution contract is ready for downstream work.', emitsOutcome: 'formalized' },
  { id: 'complete-inconsistent', label: 'Complete: inconsistent', kind: 'terminal', description: 'The contract graph contains unresolved contradictions or traceability gaps.', emitsOutcome: 'inconsistent' },
  { id: 'complete-failed', label: 'Complete: failed', kind: 'terminal', description: 'Formalization infrastructure could not produce an authoritative result.', emitsOutcome: 'failed' },
];

/** The eighteen target transitions. */
export const FORMALIZATION_FLOW_EDGES: readonly FormalizationFlowEdge[] = [
  { from: 'define-product-intent', to: 'model-use-cases', on: 'domain.accepted' },
  { from: 'define-product-intent', to: 'complete-failed', on: 'domain.failed' },
  { from: 'model-use-cases', to: 'derive-system-requirements', on: 'domain.accepted' },
  { from: 'model-use-cases', to: 'complete-failed', on: 'domain.failed' },
  { from: 'derive-system-requirements', to: 'define-acceptance-contract', on: 'domain.accepted' },
  { from: 'derive-system-requirements', to: 'complete-failed', on: 'domain.failed' },
  { from: 'define-acceptance-contract', to: 'reconcile-what', on: 'domain.accepted' },
  { from: 'define-acceptance-contract', to: 'complete-failed', on: 'domain.failed' },
  { from: 'reconcile-what', to: 'freeze-what-baseline', on: 'domain.accepted' },
  { from: 'reconcile-what', to: 'complete-failed', on: 'domain.failed' },
  { from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' },
  { from: 'freeze-what-baseline', to: 'complete-inconsistent', on: 'domain.drift-detected' },
  { from: 'freeze-what-baseline', to: 'complete-failed', on: 'domain.failed' },
  { from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' },
  { from: 'define-architecture-contract', to: 'complete-failed', on: 'domain.failed' },
  { from: 'settle-formalization', to: 'complete-formalized', on: 'domain.formalized' },
  { from: 'settle-formalization', to: 'complete-inconsistent', on: 'domain.inconsistent' },
  { from: 'settle-formalization', to: 'complete-failed', on: 'domain.failed' },
];

/** The entry node id of the module flow. */
export function entryNodeId(): string {
  return 'define-product-intent';
}

/** Terminal node ids of the module flow. */
export function terminalNodeIds(): readonly string[] {
  return FORMALIZATION_FLOW_NODES.filter((node) => node.kind === 'terminal').map((node) => node.id);
}

/** The nonterminal desks of the flow in authored order (cells + kernel nodes). */
export function deskNodeIds(): readonly string[] {
  return FORMALIZATION_FLOW_NODES.filter((node) => node.desk !== undefined).map((node) => node.id);
}

/** Fail-closed node lookup (an unknown node id is a typed refusal, never a guess). */
export function nodeOf(nodeId: string): { readonly ok: true; readonly node: FormalizationFlowNode } | { readonly ok: false; readonly detail: string } {
  const node = FORMALIZATION_FLOW_NODES.find((entry) => entry.id === nodeId);
  return node === undefined
    ? { ok: false, detail: `node ${nodeId} is not in the installed module flow` }
    : { ok: true, node };
}

/** The successor of one edge (fail-closed: an undeclared edge is refused). */
export function edgeTarget(from: string, on: FlowEdgeEvent): { readonly ok: true; readonly to: string } | { readonly ok: false; readonly detail: string } {
  const edge = FORMALIZATION_FLOW_EDGES.find((entry) => entry.from === from && entry.on === on);
  return edge === undefined
    ? { ok: false, detail: `edge ${from} --${on}--> is not declared in the installed module flow` }
    : { ok: true, to: edge.to };
}

/* ------------------------------------------------------------------ */
/* Installed skills, tools and hooks (manifest data only)              */
/* ------------------------------------------------------------------ */

/** One installed skill artifact (protocol or per-desk semantic). */
export interface InstalledSkillDeclaration {
  readonly skillId: string;
  readonly kind: 'protocol' | 'semantic';
  /** The desks this skill serves (empty = the whole module). */
  readonly servesDesks: readonly string[];
  readonly digest: string;
}

/** One installed tool surface (the closed read/write/review sets). */
export interface InstalledToolDeclaration {
  readonly toolId: string;
  readonly access: 'read' | 'write' | 'review';
  readonly digest: string;
}

/** One installed hook (additionalContext injection at a lifecycle event). */
export interface InstalledHookDeclaration {
  readonly hookId: string;
  readonly event: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse';
  readonly additionalContextRef: string;
  readonly digest: string;
}

/** The installed protocol skill every desk worker runs (legacy-preserved). */
export const PROTOCOL_SKILL_ID = 'saga-process-module-worker-protocol' as const;

const COMMON_READ_TOOLS: readonly string[] = [
  'task_get', 'artifact_list', 'artifact_get', 'trace_list', 'note_list',
  'repository_checkout_list', 'Read', 'Glob', 'Grep',
];
const COMMON_WRITE_TOOLS: readonly string[] = [
  'artifact_create', 'artifact_update', 'trace_add', 'trace_delete',
  // Managed documents, not executable repository changes: file mutation
  // stays on the structured Write/Edit surface.
  'worker_done', 'Write', 'Edit',
];
const REVIEW_TOOLS: readonly string[] = [
  'candidate_read', 'product_read', 'product_submit', 'worker_done',
];

function install(): {
  readonly skills: readonly InstalledSkillDeclaration[];
  readonly tools: readonly InstalledToolDeclaration[];
  readonly hooks: readonly InstalledHookDeclaration[];
} {
  const skills: InstalledSkillDeclaration[] = [
    { skillId: PROTOCOL_SKILL_ID, kind: 'protocol', servesDesks: [], digest: sha256OfCanonical({ skillId: PROTOCOL_SKILL_ID, kind: 'protocol' }) },
    ...deskNodeIds().map((desk) => ({
      skillId: `formalization-desk-${desk}`,
      kind: 'semantic' as const,
      servesDesks: [desk],
      digest: sha256OfCanonical({ skillId: `formalization-desk-${desk}`, kind: 'semantic', desk }),
    })),
  ];
  const tools: InstalledToolDeclaration[] = [
    ...COMMON_READ_TOOLS.map((toolId) => ({ toolId, access: 'read' as const, digest: sha256OfCanonical({ toolId, access: 'read' }) })),
    ...COMMON_WRITE_TOOLS.map((toolId) => ({ toolId, access: 'write' as const, digest: sha256OfCanonical({ toolId, access: 'write' }) })),
    ...REVIEW_TOOLS.map((toolId) => ({ toolId, access: 'review' as const, digest: sha256OfCanonical({ toolId, access: 'review' }) })),
  ];
  const hooks: InstalledHookDeclaration[] = [
    {
      hookId: 'formalization-session-start-desk-context',
      event: 'SessionStart',
      additionalContextRef: `content://hooks/formalization/desk-context#${sha256OfCanonical({ hook: 'desk-context' })}`,
      digest: sha256OfCanonical({ hookId: 'formalization-session-start-desk-context', event: 'SessionStart' }),
    },
    {
      hookId: 'formalization-post-tool-trace-reminder',
      event: 'PostToolUse',
      additionalContextRef: `content://hooks/formalization/trace-reminder#${sha256OfCanonical({ hook: 'trace-reminder' })}`,
      digest: sha256OfCanonical({ hookId: 'formalization-post-tool-trace-reminder', event: 'PostToolUse' }),
    },
  ];
  return { skills, tools, hooks };
}

/* ------------------------------------------------------------------ */
/* Deterministic declared check providers                               */
/* ------------------------------------------------------------------ */

/** One declared semantic gate provider (deterministic; content-addressed). */
export interface CheckProviderDeclaration {
  readonly providerId: string;
  readonly version: string;
  /** sha256 over the canonical provider declaration (recomputed, never trusted). */
  readonly providerDigest: string;
  readonly nodeId: string;
  readonly productKind: string;
  /** The pure validator this provider runs (resolved by id in gates.ts, fail-closed). */
  readonly validator: string;
  /** The repair target when the verdict is repair (desk role re-staffed, same Workplace). */
  readonly repairTargetRole: 'author';
}

function checkProviders(): readonly CheckProviderDeclaration[] {
  const table: readonly { readonly providerId: string; readonly nodeId: string; readonly productKind: string; readonly validator: string }[] = [
    { providerId: 'formalization.prd-structure.v1', nodeId: 'define-product-intent', productKind: 'formalization.prd-intent.v1', validator: 'validatePrdIntent' },
    { providerId: 'formalization.uc-structure.v1', nodeId: 'model-use-cases', productKind: 'formalization.uc-scenarios.v1', validator: 'validateUseCaseScenarios' },
    { providerId: 'formalization.requirements-structure.v1', nodeId: 'derive-system-requirements', productKind: 'formalization.system-requirements.v1', validator: 'validateSystemRequirements' },
    { providerId: 'formalization.acceptance-structure.v1', nodeId: 'define-acceptance-contract', productKind: 'formalization.acceptance-bindings.v1', validator: 'validateAcceptanceContract' },
    { providerId: 'formalization.reconciliation-structure.v1', nodeId: 'reconcile-what', productKind: 'formalization.what-reconciliation.v1', validator: 'validateWhatReconciliation' },
    { providerId: 'formalization.baseline-freeze.v1', nodeId: 'freeze-what-baseline', productKind: 'formalization.what-baseline.v1', validator: 'validateWhatBaseline' },
    { providerId: 'formalization.srs-structure.v1', nodeId: 'define-architecture-contract', productKind: 'formalization.srs.v1', validator: 'validateSrs' },
    { providerId: 'formalization.settlement-structure.v1', nodeId: 'settle-formalization', productKind: 'formalization.solution-contract.v1', validator: 'validateSolutionContract' },
  ];
  return table.map((entry) => ({
    providerId: entry.providerId,
    version: '1.0.0',
    providerDigest: sha256OfCanonical({ providerId: entry.providerId, version: '1.0.0', nodeId: entry.nodeId, productKind: entry.productKind, validator: entry.validator }),
    nodeId: entry.nodeId,
    productKind: entry.productKind,
    validator: entry.validator,
    repairTargetRole: 'author' as const,
  }));
}

/**
 * The installed check providers of the workshop. The declared provider ids
 * are the stable gate surface (the desk descriptors pin them).
 */
export const FORMALIZATION_CHECK_PROVIDERS: readonly CheckProviderDeclaration[] = checkProviders();

/**
 * Resolve the desk's declared check provider (fail-closed: a desk without a
 * declared provider never runs its gate).
 */
export function checkProviderOfDesk(nodeId: string): { readonly ok: true; readonly provider: CheckProviderDeclaration } | { readonly ok: false; readonly detail: string } {
  const node = nodeOf(nodeId);
  if (!node.ok) return { ok: false, detail: node.detail };
  if (node.node.desk === undefined) return { ok: false, detail: `node ${nodeId} has no desk (terminal nodes emit outcomes; they do not run gates)` };
  const provider = FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.providerId === node.node.desk?.checkProviderId);
  return provider === undefined
    ? { ok: false, detail: `desk ${nodeId} pins check provider ${node.node.desk.checkProviderId}, which is not installed (fail-closed; never an undeclared provider)` }
    : { ok: true, provider };
}

/* ------------------------------------------------------------------ */
/* Role bindings (launch kinds of the frozen role-contract manifest)    */
/* ------------------------------------------------------------------ */

/** The workshop's launch-kind bindings (identity lives in the frozen manifest). */
export interface FormalizationRoleBinding {
  readonly launchKind: string;
  readonly protocolRole: 'author' | 'reviewer';
  readonly semanticProfile: 'implementer' | 'reviewer';
}

export const FORMALIZATION_ROLE_BINDINGS: readonly FormalizationRoleBinding[] = [
  { launchKind: 'formalization.implementation.author', protocolRole: 'author', semanticProfile: 'implementer' },
  { launchKind: 'formalization.implementation.reviewer', protocolRole: 'reviewer', semanticProfile: 'reviewer' },
];

/* ------------------------------------------------------------------ */
/* The sealed manifest                                                 */
/* ------------------------------------------------------------------ */

/** The complete installed workshop manifest (pure data). */
export interface InstalledWorkshopManifest {
  readonly schemaVersion: 'ek.installed-workshop-manifest.ek8-wp11f.v1';
  readonly moduleId: typeof FORMALIZATION_MODULE_ID;
  readonly moduleVersion: typeof FORMALIZATION_MODULE_VERSION;
  readonly flow: {
    readonly nodes: readonly FormalizationFlowNode[];
    readonly edges: readonly FormalizationFlowEdge[];
    readonly entryNodeId: string;
    readonly terminalNodeIds: readonly string[];
  };
  readonly skills: readonly InstalledSkillDeclaration[];
  readonly tools: readonly InstalledToolDeclaration[];
  readonly hooks: readonly InstalledHookDeclaration[];
  readonly checkProviders: readonly CheckProviderDeclaration[];
  readonly roleBindings: readonly FormalizationRoleBinding[];
  readonly manifestDigest: string;
}

const INSTALLED = install();

/** The installed manifest value (deterministic; memoized content). */
export function installedWorkshopManifest(): InstalledWorkshopManifest {
  const body = {
    schemaVersion: 'ek.installed-workshop-manifest.ek8-wp11f.v1' as const,
    moduleId: FORMALIZATION_MODULE_ID,
    moduleVersion: FORMALIZATION_MODULE_VERSION,
    flow: {
      nodes: FORMALIZATION_FLOW_NODES,
      edges: FORMALIZATION_FLOW_EDGES,
      entryNodeId: entryNodeId(),
      terminalNodeIds: terminalNodeIds(),
    },
    skills: INSTALLED.skills,
    tools: INSTALLED.tools,
    hooks: INSTALLED.hooks,
    checkProviders: FORMALIZATION_CHECK_PROVIDERS,
    roleBindings: FORMALIZATION_ROLE_BINDINGS,
  };
  return { ...body, manifestDigest: sha256OfCanonical(body) };
}
