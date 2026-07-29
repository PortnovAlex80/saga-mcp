// src/application/package-describe.ts
//
// W10-A7 — Describe interfaces: read-only describe commands for agents and
// operators (WAVE10-EXTENSIBILITY-SPEC.md §1 row W10-A7, §2 exit-gate item 5).
//
// WHAT THIS IS
//   A thin, PURE, read-only projection layer that turns the frozen manifest
//   aggregates (ProcessModuleManifest, LifecycleScenarioManifest) into small,
//   deterministic, canonically-serializable architecture views an agent or
//   operator can read without re-reading package bytes or walking the live
//   registries. Each `describe*` function is a pure projection: no I/O, no side
//   effects, no closures retained. The same manifest always yields the same
//   view. Every result round-trips through canonical JSON (plan §3.5).
//
//   The views are deliberately NARROW — they expose exactly the seven surfaces
//   the Wave 10 exit gate names (§2 item 5: "Describe interfaces expose
//   package/scenario architecture from manifests"):
//
//     contracts   — input/output ContractRefs + every distinct schema id
//                   referenced by the module's nodes/tools/profiles.
//     flow        — node count, distinct node kinds, entry + terminals,
//                   transition count, outcome codes (terminal vs non-terminal).
//     resources   — declared resources grouped by kind, with logicalId + path.
//     capabilities— declared capability requirements (ref/version/optional).
//     tools       — declared MCP tool contributions (logicalId, side effect,
//                   idempotency, handler + contract refs).
//     outcomes    — declared outcome codes with terminal flag + the emitting
//                   node id (when the manifest carries `emitsOutcome`).
//     recovery    — declared FlowRecovery routes (verify/repair node ids,
//                   trigger/resolved events, budget, on-exhausted policy).
//
//   For scenarios, an eighth surface is projected:
//
//     stages      — stage ids, the module contract selector each stage pins,
//                   the entry stage, declared terminal statuses, and the
//                   scenario-level outcome routes (the static table — there is
//                   deliberately NO resolver surface, plan §6.4).
//
// RELATIONSHIP TO describeInstallation (Wave 2)
//   Wave 2's `describeInstallation` (installation/domain/describe.ts) projects
//   a PERSISTED ModuleInstallationRecord into a short InstallationDescription
//   (counts + a flow summary + contract refs). It reads from the record's
//   RESOLVED arrays (post-install resourceIndex/handlerRefs).
//
//   This layer is the OPERATOR/PACKAGE-AUTHOR complement: it projects the
//   MANIFEST itself (pre-install or at authoring time), so an agent can answer
//   "what does this package declare?" WITHOUT a persisted installation record.
//   The two layers compose: `describePackage` gives the declared architecture;
//   `describeInstallation` gives the resolved-installation summary. We
//   re-export `describeInstallation` and its types from this surface so an
//   agent has a single import path for both views (spec §1 row W10-A7: "Uses
//   existing describeInstallation from Wave 2").
//
// ── Dependency direction (W0-A1 ratchet) ─────────────────────────────────────
//
// This file lives at `src/application/package-describe.ts` (top-level
// application layer), NOT under `src/process-modules/`. The ratchet's Rule 5
// (domain purity) forbids `domain/` from importing `application/`, but this is
// `application/`, so Rule 5 does not apply in the reverse direction. The file
// imports ONLY from:
//   - `../process-modules/domain/spi/index.js`   — pure SPI barrel (types +
//                                                   the frozen manifest shapes);
//   - `../process-modules/domain/process-module.js` — existing pure domain
//                                                   (FlowRecoveryDefinition,
//                                                   FlowNodeDefinition, ...);
//   - `../process-modules/installation/index.js`  — Wave 2 barrel, to re-export
//                                                   describeInstallation.
//
// It imports NO `modules/`, NO `persistence/` adapters, NO `db.ts`, NO
// `composition/`, NO `src/index.ts`, NO `tracker-view/`. That import list IS
// the §0.13.10 proof (WAVE10-EXTENSIBILITY-SPEC §4): the describe interfaces
// depend on the immutable manifest + installation contracts only, never on the
// built-in catalog or a specific module implementation.
//
// Plan ref: §0.13.10 (Wave 10 serial gate), §3.5 (canonical serialization),
//           §3.16 (purity), §12.1 (describeInstallation lineage).

// ---------------------------------------------------------------------------
// Imports — pure SPI types + the Wave 1/Wave 2 manifest + installation surface.
// ---------------------------------------------------------------------------

// Pure SPI barrel — the frozen manifest aggregates + their field shapes.
// Type-only: this layer projects the data, it never instantiates SPI types.
import type {
  ProcessModuleManifest,
  LifecycleScenarioManifest,
  ContractRef,
  ResourceIndexEntry,
  ResourceKind,
  HandlerRef,
  ModuleToolContribution,
  CapabilityRequirement,
} from '../process-modules/domain/spi/index.js';

// Existing pure domain — FlowNodeDefinition, FlowRecoveryDefinition,
// OutcomeDefinition, FlowDefinition, ScenarioStageBinding,
// ExecutionProfileDefinition.
import type {
  FlowNodeDefinition,
  FlowDefinition,
  OutcomeDefinition,
  ExecutionProfileDefinition,
} from '../process-modules/domain/process-module.js';

// Wave 2 installation barrel — re-export describeInstallation + its types so
// agents have a single describe surface. See the section header above. The
// Wave 2 barrel re-exports `InstallationDescription`; the `FlowSummary` it
// carries is internal to describe.ts and is not re-exported by the barrel, so
// we surface only the public describe types here.
export {
  describeInstallation,
  type InstallationDescription,
} from '../process-modules/installation/index.js';

// ---------------------------------------------------------------------------
// Shared view primitives.
// ---------------------------------------------------------------------------

/**
 * Read-only identity projection shared by every describe result. Mirrors the
 * identity fields an agent needs to address a package unambiguously.
 */
export interface DescribeIdentity {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: string;
}

/**
 * Read-only contract surface projected from a manifest's `inputContractRef` +
 * `outputContractRef` plus every distinct schema id the module references in
 * its nodes, profiles, and tools. Pure data.
 */
export interface ContractsView {
  readonly inputContractRef: ContractRef;
  readonly outputContractRef: ContractRef;
  /**
   * Deduplicated, sorted set of every schema id referenced anywhere in the
   * manifest (node input/output schemas, tool contract refs, profile output
   * schemas). Includes the input/output contract ref schemaIds. Sorted for
   * determinism.
   */
  readonly referencedSchemaIds: readonly string[];
}

/**
 * Read-only flow surface. `nodeKinds` is deduped + sorted; `entryNodeId` and
 * `terminalNodeIds` are forwarded verbatim from the flow definition.
 */
export interface FlowView {
  readonly flowId: string;
  readonly flowVersion: string;
  readonly entryNodeId: string;
  readonly terminalNodeIds: readonly string[];
  readonly nodeCount: number;
  readonly nodeKinds: readonly string[];
  readonly transitionCount: number;
}

/**
 * One outcome row in {@link OutcomesView}. `emittingNodeIds` is the set of flow
 * node ids that declare `emitsOutcome === code` (may be empty when no node
 * emits the outcome — a documented declaration-only outcome).
 */
export interface OutcomeRow {
  readonly code: string;
  readonly terminal: boolean;
  readonly description: string;
  readonly emittingNodeIds: readonly string[];
}

export interface OutcomesView {
  readonly outcomes: readonly OutcomeRow[];
  /** Sorted distinct terminal outcome codes. */
  readonly terminalOutcomes: readonly string[];
  /** Sorted distinct non-terminal outcome codes. */
  readonly nonTerminalOutcomes: readonly string[];
}

/**
 * Read-only resources surface. Resources are grouped by `kind`; within each
 * group entries keep their manifest order. `kinds` is the sorted distinct set
 * of resource kinds present.
 */
export interface ResourceGroup {
  readonly kind: ResourceKind;
  readonly entries: readonly ResourceIndexEntry[];
}
export interface ResourcesView {
  readonly resourceCount: number;
  readonly kinds: readonly ResourceKind[];
  readonly groups: readonly ResourceGroup[];
  /** Sorted distinct logicalId values (deterministic identity list). */
  readonly logicalIds: readonly string[];
}

/** Read-only capability-requirements surface. */
export interface CapabilitiesView {
  readonly capabilityCount: number;
  readonly requirements: readonly CapabilityRequirement[];
  /** Sorted distinct capability refs. */
  readonly refs: readonly string[];
}

/** Read-only handler-reference surface (the manifest's `handlerRefs`). */
export interface HandlersView {
  readonly handlerCount: number;
  readonly handlers: readonly HandlerRef[];
  /** Sorted distinct handler logicalId values. */
  readonly logicalIds: readonly string[];
}

/** One row in {@link ToolsView}. */
export interface ToolRow {
  readonly logicalId: string;
  readonly version: string;
  readonly handlerRef: string;
  readonly idempotency: string;
  readonly sideEffect: string;
  readonly inputContractRef: ContractRef;
  readonly outputContractRef: ContractRef;
  readonly guardCount: number;
}
export interface ToolsView {
  readonly toolCount: number;
  readonly tools: readonly ToolRow[];
  /** Sorted distinct tool logicalId values. */
  readonly logicalIds: readonly string[];
}

/**
 * One row in {@link RecoveryView}. Mirrors `FlowRecoveryDefinition` (plan
 * §process-module.ts) without the closure-shaped fields.
 */
export interface RecoveryRow {
  readonly id: string;
  readonly verifyNodeId: string;
  readonly repairNodeId: string;
  readonly triggerEvents: readonly string[];
  readonly resolvedEvents: readonly string[];
  readonly maxAttempts: number;
  readonly onExhausted: string;
}
export interface RecoveryView {
  readonly routeCount: number;
  readonly routes: readonly RecoveryRow[];
  /** Sorted distinct node ids participating as verify or repair targets. */
  readonly participantNodeIds: readonly string[];
}

/**
 * Full read-only architecture view of a Process Module package, generated from
 * its manifest. Every field is a pure, deterministic, canonically-serializable
 * projection (plan §3.5). Round-trips through `canonicalJson` byte-for-byte.
 */
export interface PackageDescription {
  readonly identity: DescribeIdentity;
  readonly manifestFormatVersion: string;
  readonly runtimeCompatibilityRange: string;
  readonly contracts: ContractsView;
  readonly flow: FlowView;
  readonly outcomes: OutcomesView;
  readonly resources: ResourcesView;
  readonly handlers: HandlersView;
  readonly capabilities: CapabilitiesView;
  readonly tools: ToolsView;
  readonly recovery: RecoveryView;
}

// ---------------------------------------------------------------------------
// Scenario views.
// ---------------------------------------------------------------------------

/**
 * One stage row in {@link ScenarioStagesView}. Pins the module contract
 * selector (name + version range) the stage resolves against at install time
 * (W1-A3). Pure data — no resolver.
 */
export interface ScenarioStageRow {
  readonly id: string;
  readonly displayName: string;
  readonly moduleName: string;
  readonly moduleVersionRange: string;
  readonly moduleRefName: string;
  readonly moduleRefVersion: string;
  /** Sorted distinct outcome codes the stage declares routes for. */
  readonly routedOutcomes: readonly string[];
  readonly inputMappingKeys: readonly string[];
  readonly outputMappingKeys: readonly string[];
}

export interface ScenarioStagesView {
  readonly stageCount: number;
  readonly entryStageId: string;
  readonly terminalStatuses: readonly string[];
  readonly stages: readonly ScenarioStageRow[];
  /** Sorted distinct module names the scenario depends on (§6.10). */
  readonly requiredModuleNames: readonly string[];
  /** Scenario-level outcome routes as `{ outcome -> { type, target } }`. */
  readonly outcomeRoutes: Readonly<Record<string, { readonly type: string; readonly target: string }>>;
}

/**
 * Full read-only architecture view of a Lifecycle Scenario, generated from its
 * manifest. Pure, deterministic, canonically-serializable.
 */
export interface ScenarioDescription {
  readonly identity: DescribeIdentity;
  readonly manifestFormatVersion: string;
  readonly contracts: ContractsView;
  readonly stages: ScenarioStagesView;
}

// ---------------------------------------------------------------------------
// Helpers (module-local; not exported).
// ---------------------------------------------------------------------------

/**
 * Deduplicate + sort an array of strings into a frozen readonly tuple. Empty
 * and non-string values are dropped. Returns the canonical deterministic
 * ordering used by every `nodeKinds` / `outcomes` / schema-id projection.
 */
function dedupeSortedStrings(values: readonly (string | undefined | null)[]): readonly string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) {
      set.add(v);
    }
  }
  return Object.freeze([...set].sort());
}

/**
 * Deterministic, frozen shallow copy of a readonly string array. Keeps
 * canonical-json friendliness (plain arrays) without leaking the caller's
 * mutable alias.
 */
function frozenCopy<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

/**
 * Structural source type for {@link collectProfileSchemaIds}. Uses the real
 * `ExecutionProfileDefinition` shape so the function accepts the manifest's
 * `definition.executionProfiles` array directly without an adapter.
 */
type ExecutionProfileSchemaSource = Pick<
  ExecutionProfileDefinition,
  'workIntentSchema' | 'outputSchema'
>;

// ---------------------------------------------------------------------------
// describePackage — ProcessModuleManifest → PackageDescription.
// ---------------------------------------------------------------------------

/**
 * Project a {@link ProcessModuleManifest} into a full read-only
 * {@link PackageDescription}.
 *
 * Pure: no I/O, no side effects, no closures retained. Calling it twice on the
 * same manifest yields structurally-equal descriptions (determinism contract).
 * The result is canonically serializable (round-trips through `canonicalJson`,
 * plan §3.5): no functions, no Maps/Sets, no class instances.
 *
 * @param manifest the manifest to project. Must be a non-null
 *                  `ProcessModuleManifest`.
 */
export function describePackage(manifest: ProcessModuleManifest): PackageDescription {
  const definition = manifest.definition;
  const flow: FlowDefinition = definition.flow;

  // --- identity ---
  const identity: DescribeIdentity = Object.freeze({
    name: definition.identity.name,
    version: definition.identity.version,
    displayName: definition.identity.displayName,
    description: definition.identity.description,
    kind: definition.identity.kind,
  });

  // --- contracts: forward the two refs + harvest every schema id ---
  const referencedSchemaIds = dedupeSortedStrings([
    manifest.inputContractRef.schemaId,
    manifest.outputContractRef.schemaId,
    ...collectFlowSchemaIds(flow),
    ...collectToolSchemaIds(manifest.toolContributions ?? []),
    ...collectProfileSchemaIds(definition.executionProfiles),
  ]);
  const contracts: ContractsView = Object.freeze({
    inputContractRef: manifest.inputContractRef,
    outputContractRef: manifest.outputContractRef,
    referencedSchemaIds,
  });

  // --- flow ---
  const flowView: FlowView = Object.freeze({
    flowId: flow.id,
    flowVersion: flow.version,
    entryNodeId: flow.entryNodeId,
    terminalNodeIds: frozenCopy(flow.terminalNodeIds),
    nodeCount: flow.nodes.length,
    nodeKinds: dedupeSortedStrings(flow.nodes.map((n) => n.kind)),
    transitionCount: flow.transitions.length,
  });

  // --- outcomes ---
  const outcomesView = buildOutcomesView(definition.outcomes, flow.nodes);

  // --- resources ---
  const resourcesView = buildResourcesView(manifest.resourceIndex);

  // --- handlers ---
  const handlersView = buildHandlersView(manifest.handlerRefs);

  // --- capabilities ---
  const capabilitiesView = buildCapabilitiesView(manifest.capabilityRequirements ?? []);

  // --- tools ---
  const toolsView = buildToolsView(manifest.toolContributions ?? []);

  // --- recovery ---
  const recoveryView = buildRecoveryView(flow.recovery ?? []);

  return Object.freeze({
    identity,
    manifestFormatVersion: manifest.manifestFormatVersion,
    runtimeCompatibilityRange: manifest.runtimeCompatibilityRange,
    contracts,
    flow: flowView,
    outcomes: outcomesView,
    resources: resourcesView,
    handlers: handlersView,
    capabilities: capabilitiesView,
    tools: toolsView,
    recovery: recoveryView,
  });
}

/**
 * Collect every `schemaId` referenced by flow nodes' `inputSchema`/
 * `outputSchema`. The schemas themselves are `SchemaReference { id }`; we read
 * `id` defensively.
 */
function collectFlowSchemaIds(flow: FlowDefinition): string[] {
  const out: string[] = [];
  for (const node of flow.nodes) {
    const inputId = (node as FlowNodeDefinition).inputSchema?.id;
    const outputId = (node as FlowNodeDefinition).outputSchema?.id;
    if (typeof inputId === 'string') out.push(inputId);
    if (typeof outputId === 'string') out.push(outputId);
  }
  return out;
}

function collectToolSchemaIds(tools: readonly ModuleToolContribution[]): string[] {
  const out: string[] = [];
  for (const t of tools) {
    out.push(t.inputContractRef.schemaId);
    out.push(t.outputContractRef.schemaId);
  }
  return out;
}

/**
 * Collect `workIntentSchema.id` + `outputSchema.id` from each execution
 * profile. Profiles live on the wrapped `definition.executionProfiles`.
 */
function collectProfileSchemaIds(
  profiles: readonly ExecutionProfileSchemaSource[],
): string[] {
  const out: string[] = [];
  for (const p of profiles) {
    const wi = p.workIntentSchema?.id;
    const oo = p.outputSchema?.id;
    if (typeof wi === 'string') out.push(wi);
    if (typeof oo === 'string') out.push(oo);
  }
  return out;
}

function buildOutcomesView(
  outcomes: readonly OutcomeDefinition[],
  nodes: readonly FlowNodeDefinition[],
): OutcomesView {
  // Map each outcome code -> list of node ids that emit it.
  const emitters = new Map<string, string[]>();
  for (const node of nodes) {
    const code = node.emitsOutcome;
    if (typeof code === 'string' && code.length > 0) {
      const list = emitters.get(code);
      if (list) {
        list.push(node.id);
      } else {
        emitters.set(code, [node.id]);
      }
    }
  }

  const rows: OutcomeRow[] = outcomes.map((o) =>
    Object.freeze({
      code: o.code,
      terminal: o.terminal,
      description: o.description,
      emittingNodeIds: Object.freeze([...(emitters.get(o.code) ?? [])].sort()),
    }),
  );

  const terminalOutcomes = dedupeSortedStrings(
    outcomes.filter((o) => o.terminal).map((o) => o.code),
  );
  const nonTerminalOutcomes = dedupeSortedStrings(
    outcomes.filter((o) => !o.terminal).map((o) => o.code),
  );

  return Object.freeze({
    outcomes: Object.freeze(rows),
    terminalOutcomes,
    nonTerminalOutcomes,
  });
}

function buildResourcesView(
  resourceIndex: readonly ResourceIndexEntry[],
): ResourcesView {
  // Group by kind preserving manifest order; collect kinds sorted.
  const byKind = new Map<ResourceKind, ResourceIndexEntry[]>();
  for (const r of resourceIndex) {
    const list = byKind.get(r.kind);
    if (list) {
      list.push(r);
    } else {
      byKind.set(r.kind, [r]);
    }
  }
  const kinds = [...byKind.keys()].sort() as ResourceKind[];
  const groups: ResourceGroup[] = kinds.map((kind) =>
    Object.freeze({
      kind,
      entries: Object.freeze([...(byKind.get(kind) ?? [])]),
    }),
  );

  return Object.freeze({
    resourceCount: resourceIndex.length,
    kinds: Object.freeze(kinds),
    groups: Object.freeze(groups),
    logicalIds: dedupeSortedStrings(resourceIndex.map((r) => r.logicalId)),
  });
}

function buildHandlersView(handlerRefs: readonly HandlerRef[]): HandlersView {
  return Object.freeze({
    handlerCount: handlerRefs.length,
    handlers: Object.freeze([...handlerRefs]),
    logicalIds: dedupeSortedStrings(handlerRefs.map((h) => h.logicalId)),
  });
}

function buildCapabilitiesView(
  requirements: readonly CapabilityRequirement[],
): CapabilitiesView {
  return Object.freeze({
    capabilityCount: requirements.length,
    requirements: Object.freeze([...requirements]),
    refs: dedupeSortedStrings(requirements.map((c) => c.ref)),
  });
}

function buildToolsView(tools: readonly ModuleToolContribution[]): ToolsView {
  const rows: ToolRow[] = tools.map((t) =>
    Object.freeze({
      logicalId: t.logicalId,
      version: t.version,
      handlerRef: t.handlerRef,
      idempotency: t.idempotency,
      sideEffect: t.sideEffect,
      inputContractRef: t.inputContractRef,
      outputContractRef: t.outputContractRef,
      guardCount: t.guardBindings.length,
    }),
  );
  return Object.freeze({
    toolCount: tools.length,
    tools: Object.freeze(rows),
    logicalIds: dedupeSortedStrings(tools.map((t) => t.logicalId)),
  });
}

function buildRecoveryView(
  routes: readonly {
    readonly id: string;
    readonly verifyNodeId: string;
    readonly repairNodeId: string;
    readonly triggerEvents: readonly string[];
    readonly resolvedEvents: readonly string[];
    readonly maxAttempts: number;
    readonly onExhausted: string;
  }[],
): RecoveryView {
  const rows: RecoveryRow[] = routes.map((r) =>
    Object.freeze({
      id: r.id,
      verifyNodeId: r.verifyNodeId,
      repairNodeId: r.repairNodeId,
      triggerEvents: frozenCopy(r.triggerEvents),
      resolvedEvents: frozenCopy(r.resolvedEvents),
      maxAttempts: r.maxAttempts,
      onExhausted: r.onExhausted,
    }),
  );
  const participantNodeIds = dedupeSortedStrings(
    routes.flatMap((r) => [r.verifyNodeId, r.repairNodeId]),
  );
  return Object.freeze({
    routeCount: routes.length,
    routes: Object.freeze(rows),
    participantNodeIds,
  });
}

// ---------------------------------------------------------------------------
// describeScenario — LifecycleScenarioManifest → ScenarioDescription.
// ---------------------------------------------------------------------------

/**
 * Project a {@link LifecycleScenarioManifest} into a full read-only
 * {@link ScenarioDescription}.
 *
 * Pure: no I/O, no side effects, no closures retained. Deterministic: the same
 * manifest yields a structurally-equal description. Canonically serializable
 * (plan §3.5).
 *
 * The scenario view surfaces the static `outcomeRoutes` table only — there is
 * deliberately NO resolver surface anywhere (plan §6.4: a scenario manifest
 * must be structurally incapable of carrying a route resolver).
 *
 * @param manifest the scenario manifest to project.
 */
export function describeScenario(manifest: LifecycleScenarioManifest): ScenarioDescription {
  const identity: DescribeIdentity = Object.freeze({
    name: manifest.identity.name,
    version: manifest.identity.version,
    displayName: manifest.identity.displayName,
    description: manifest.identity.description,
    // Scenarios carry no `kind`; surface an explicit empty marker so the
    // DescribeIdentity shape stays uniform across package + scenario views.
    kind: '',
  });

  const referencedSchemaIds = dedupeSortedStrings([
    manifest.inputContractRef.schemaId,
    manifest.outputContractRef.schemaId,
  ]);
  const contracts: ContractsView = Object.freeze({
    inputContractRef: manifest.inputContractRef,
    outputContractRef: manifest.outputContractRef,
    referencedSchemaIds,
  });

  const stages: ScenarioStageRow[] = manifest.stageBindings.map((s) =>
    Object.freeze({
      id: s.id,
      displayName: s.displayName,
      moduleName: s.moduleSelector.name,
      moduleVersionRange: s.moduleSelector.versionRange,
      moduleRefName: s.moduleRef.name,
      moduleRefVersion: s.moduleRef.version,
      routedOutcomes: dedupeSortedStrings(Object.keys(s.outcomeRoutes)),
      inputMappingKeys: dedupeSortedStrings(Object.keys(s.inputMapping)),
      outputMappingKeys: dedupeSortedStrings(
        s.outputMapping ? Object.keys(s.outputMapping) : [],
      ),
    }),
  );

  const requiredModuleNames = dedupeSortedStrings(
    manifest.requiredModuleSelectors.map((m) => m.name),
  );

  const outcomeRoutes: Record<string, { readonly type: string; readonly target: string }> =
    {};
  for (const [outcome, target] of Object.entries(manifest.outcomeRoutes)) {
    outcomeRoutes[outcome] = Object.freeze({
      type: target.type,
      target: target.type === 'stage' ? target.stageId : target.status,
    });
  }

  const stagesView: ScenarioStagesView = Object.freeze({
    stageCount: manifest.stageBindings.length,
    entryStageId: manifest.entryStageId,
    terminalStatuses: frozenCopy(manifest.terminalStatuses),
    stages: Object.freeze(stages),
    requiredModuleNames,
    outcomeRoutes: Object.freeze(outcomeRoutes),
  });

  return Object.freeze({
    identity,
    manifestFormatVersion: manifest.manifestFormatVersion,
    contracts,
    stages: stagesView,
  });
}

// ---------------------------------------------------------------------------
// describePackageArchitecture — convenience roll-up an agent/operator calls
// once to get every view for a package manifest. Returns the same
// PackageDescription describePackage produces; surfaced under a distinct name
// because agents will address it as the "describe the architecture" command.
// ---------------------------------------------------------------------------

/**
 * Read-only roll-up of every architecture view for a Process Module package.
 * Alias of {@link describePackage}; provided so an operator's
 * "describe-package-architecture" command maps 1:1 to a named function.
 */
export function describePackageArchitecture(
  manifest: ProcessModuleManifest,
): PackageDescription {
  return describePackage(manifest);
}
