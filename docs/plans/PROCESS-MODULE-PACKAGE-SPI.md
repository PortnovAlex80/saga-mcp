# Process Module Unified Package — Consolidated SPI

**Date:** 2026-07-28
**Status:** design accepted (after 5 rounds of correction), ready for staged migration
**Branch:** `agent/saga3-process-modules`
**Supersedes:** sections of `docs/plans/PROCESS-MODULES-PLAN-V2.md` (P5b, P9), `docs/flow/ARCHITECTURE-DIRECTIONS.md`, `docs/saga3/process-modules/ARCHITECTURE.md` §5-7

---

## 0. Principle

> **Module owns the blueprint: flow, node protocols, skills, templates, MCP tool semantics, hook/guard configuration, kernel handlers. Runtime owns the physics: ProcessRun instances, protocol step state, tracker rendering, hook execution, call-instance lifecycle, gateway enforcement.**

The Module never touches the DB. The Runtime never branch-cases on module identity.

---

## 1. Three support mechanisms (not two, not one)

Successive corrections produced this taxonomy. Each has a distinct channel, distinct authority, distinct configurability.

| Mechanism | Channel | Action | allow/deny? | Module-configurable? |
|---|---|---|---|---|
| **A. Agent Context Assistance** | Claude Code `PostToolUse` hook → `additionalContext` | Re-focuses model on current step, resources, last error | No | Yes — `StepAssistanceConfig` |
| **B. Runtime Lifecycle** | Platform-internal event dispatch | Creates call-instances, moves program counter, seals receipts, writes DB state, regenerates tracker | No | **No** — fixed platform mechanics |
| **C. Gateway Guard** | MCP server, intercept before handler | Blocks incorrect call before MCP handler runs | Yes (authoritative) | Yes — `GuardBinding` |

**Critical:** B is NOT an SPI extension point. The Module configures A and C only. B is identical for all modules.

---

## 2. Final SPI types

### 2.1 Resource references and package

```ts
/** Module-relative path into the package resources/ tree. */
export interface ResourceRef {
  path: string;  // e.g. 'nodes/define-product-contract/resources/skill/SKILL.md'
}

/** A versioned, hash-pinned delivery unit. */
export interface ProcessModulePackage {
  readonly definition: ProcessModuleDefinition;
  /** path → content hash. Resolved at installation time. */
  readonly resourceHashes: ReadonlyMap<string, string>;
  /** kernelHandlerId / adapterId → declared version. */
  readonly handlerVersions: ReadonlyMap<string, string>;
  readonly definitionDigest: string;  // SHA-256 over canonical definition JSON
  readonly packageDigest: string;     // SHA-256 over {definitionDigest, resourceHashes, handlerVersions}
}
```

`definitionDigest` excludes `routeResolver` (non-enumerable, lifecycle-owned). `packageDigest` is what gets pinned to each ProcessRun via installation FK.

### 2.2 NodeProtocol — the missing entity

Flow nodes are coarse-grained (12 nodes in Formalization). Inside one LM node there are fine-grained model actions (read input → investigate → author document → register artifacts → register traces → complete). Those actions live in NodeProtocol, not in skill markdown.

```ts
export interface NodeProtocolDefinition {
  id: string;                          // 'formalization.define-product-contract'
  version: string;
  nodeRef: string;                     // links to a FlowNodeDefinition.id
  steps: readonly NodeProtocolStep[];
  downstreamObligations: readonly DownstreamObligation[];
  requiredEvidence: readonly EvidenceRequirement[];  // checked at before-node-complete
}

export interface NodeProtocolStep {
  id: string;                          // 'create-prd', 'register-traces'
  instruction: ResourceRef;            // skill excerpt for this step
  allowedTools: readonly string[];     // intersected with profile.allowedTools
  requiredEvidence: readonly EvidenceRequirement[];
  workspaceAssets: readonly ResourceRef[];
  assistance: StepAssistanceConfig;    // → Mechanism A (declarative include-lists)
  guards: readonly GuardBinding[];     // → Mechanism C
  // NOTE: no `hooks` field. Mechanism B is not module-configurable.
}

export interface DownstreamObligation {
  artifact: string;                    // 'PRD'
  requiresTraceTo: string;             // 'brief'
  linkType: 'derived_from' | 'covers' | 'implements' | 'verified_by';
  enforcedByNodeId: string;            // which downstream node will fail without it
}

export interface EvidenceRequirement {
  kind: 'artifact' | 'trace' | 'receipt';
  ref: string;                         // logical name, Runtime resolves to concrete id
}
```

### 2.3 Assistance (Mechanism A) — declarative, not literal

```ts
export interface StepAssistanceConfig {
  instructions: {
    summary: string;                            // human goal of this step
    completionCriteria: readonly string[];
  };
  resources: {
    callFiles: readonly string[];               // logical names; Runtime resolves to paths
    checklists: readonly string[];
    documents: readonly string[];
  };
  assistanceHooks: readonly AssistanceHookBinding[];
  /** Module-recommended intensity. Runtime may override based on model strength. */
  assistanceMode: 'compact' | 'guided' | 'intensive';
}

export interface AssistanceHookBinding {
  event: 'step-enter' | 'post-tool-success' | 'post-tool-error' | 'before-submit';
  renderer: 'step-card' | 'next-action' | 'repair-card' | 'submit-gate';
  include: readonly string[];   // semantic blocks, NOT literal text:
                                // 'goal','resources','allowed-tools','completion-criteria',
                                // 'current-step','last-action','next-action',
                                // 'error','call-file','field-hints','retry-instruction'
  oncePerAttempt?: boolean;
  maxChars: number;
}
```

The Module declares **what** to show. The Runtime substitutes **concrete** values (current step, real paths, tool name, last result, error fields, recovery attempt, next action).

### 2.4 Guards (Mechanism C)

```ts
export interface GuardBinding {
  event: 'before-tool' | 'before-node-complete';
  stepId?: string;             // optional — only on this step
  handler: string;             // platform or module guard handler id
  failureMode: 'deny' | 'warn';
}
```

Each `GuardBinding` compiles to:
- **MCP gateway guard** — authoritative, cannot be bypassed.
- **Optional CLI PreToolUse guard** — early deny, saves tokens.

Both layers enforce the same rule. CLI hook is convenience, gateway is authority.

### 2.5 Module tool contributions

```ts
export interface ModuleToolContribution {
  id: string;                          // 'discovery.proposal_submit'
  version: string;
  handler: string;                     // executorRef, resolved by installation
  inputSchema: ResourceRef;
  outputSchema: ResourceRef;
  callTemplate?: ResourceRef;
  checklist?: ResourceRef;
  actionableErrors?: ResourceRef;      // module-specific hints for ActionableToolError
  guards: readonly GuardBinding[];     // tool-level guards
}

export interface CapabilityPackage {
  id: string;                          // 'saga.tasks', 'saga.artifact-graph'
  version: string;
  tools: readonly string[];
}
```

Discovery tools (`proposal_submit`, `readiness_*`, `diagnosis_*`, `normalization_*`) migrate to `modules/discovery/tools/`. Common tools (`task_get`, `artifact_create`, `trace_*`, `worker_done`) stay as `CapabilityPackage` referenced by `requiredTools`.

```ts
// In ExecutionProfileDefinition:
requiredTools: readonly string[];       // ['saga.tasks@1', 'discovery.proposal_submit@1']
```

### 2.6 Universal ActionableToolError

```ts
export interface ActionableToolError {
  code: string;                          // 'INVALID_FIELD' | 'MISSING_OBLIGATION' | ...
  message: string;
  fieldErrors: readonly {
    path: string;                        // 'metadata.process_run_id'
    expected?: unknown;
    actual?: unknown;
    source?: string;                     // 'task.metadata.process_run_id'
  }[];
  repair: {
    callInstanceRef: string | null;      // workspace-relative path to draft
    checklistRef: string | null;
    trackerRef: string;
    resumeStepId: string;                // NodeProtocolStep.id
    retryAllowed: boolean;
  };
}
```

Replaces `actionableError` in `src/tools/saga3-args.ts`. Discovery-specific helper stays as backward-compat shim during migration; the hardcoded tracker path at `saga3-args.ts:223` is removed.

---

## 3. Storage boundaries

| Data | Storage | Owner | Notes |
|---|---|---|---|
| `saga3_process_runs` | SQLite table | Runtime | gains `installation_id` FK |
| `saga3_process_module_installations` | SQLite table | Runtime | new — digests + resource_hashes + handler_versions |
| `saga3_protocol_step_runs` | SQLite table | Runtime | new — state machine for NodeProtocol steps; FK to node_run |
| `saga3_node_runs` | SQLite table | Runtime | unchanged |
| Call instances | Files in execution dir | Runtime | NOT a table — local to workspace, not needed globally |
| `agent-assistance.json` | File in execution dir | Runtime writes, hook reads | replaces tracker-reminder.mjs markdown parsing |
| `tracker.md` | File in execution dir | Runtime renders (read-only for model) | model stops editing |
| Module skills/templates/checklists | Files in module `resources/` | Module | hashed into packageDigest |

---

## 4. The 8 lines of defense (final stack)

```
1. Startup prompt + inline skill          — role, task
2. Tracker.md (Runtime-rendered)          — route, state, current step
3. Materialized call templates + checklists — no inventing MCP calls
4. Agent Context Assistance (Claude hook) — refocus on current action
5. MCP ActionableToolError                — explain error + repair path
6. Tool allowlist + Gateway Guard         — physically block overreach
7. Kernel verification                    — check final product
8. Recovery                               — return domain findings
```

Tiered message intensity per Mechanism A:

| Event | compact | guided | intensive |
|---|---|---|---|
| step-enter | detailed card | detailed card | detailed card |
| post-tool-success | silent | 3-5 line next-action | always next-action |
| post-tool-error | repair-card | repair-card | repair-card + criteria |
| before-submit | call-file+checklist | + criteria | + criteria + last-error |

Module sets `assistanceMode` recommendation. Runtime may override based on model strength (strong → compact, weak → intensive).

---

## 5. Hook engine lifecycle (Mechanism B — fixed platform mechanics)

| Event | Runtime does (unconditional) | Module may add |
|---|---|---|
| `on-node-start` | create ProtocolRun, render tracker, materialize call-files, bind skill, fix allowlist | — |
| `before-step` | set program counter, restrict tools to step, create call-instances | — |
| `after-tool-success` | save receipt, seal call-instance, update registers, check evidence, advance PC, create next instance, regen tracker | — |
| `after-tool-error` | bind error to call-instance, preserve file, record field errors, do NOT advance PC, regen tracker | — |
| `on-recovery` / `on-resume` | find last confirmed step, reuse receipts, preserve unfinished file, add kernel findings, new attempt, jump to repair step | — |

Guards (Mechanism C) are called at `before-tool` and `before-node-complete` and may `deny`. Module may add domain guards; platform guards (allowlist, FILL_ check, binding-match) always run.

---

## 6. Migration map

Each stage is **additive**: tsc + tests green after each. Existing flow does not break until P-PM-8.

| Stage | Mechanism | Adds |
|---|---|---|
| **P-PM-1** | — | `ResourceRef`, `ProcessModulePackage`, `definitionDigest`, `packageDigest`, `saga3_process_module_installations`, `installation_id` FK in `saga3_process_runs` |
| **P-PM-instruments** | — | `ModuleToolContribution`, `CapabilityPackage`, migrate Discovery tools to `modules/discovery/tools/`, `requiredTools` in profile |
| **P-PM-2** | structure | `NodeProtocolDefinition`, `NodeProtocolStep` (with `assistance` + `guards`, NO `hooks` field), link from `LmFlowNodeDefinition.nodeProtocol`, `saga3_protocol_step_runs` table |
| **P-PM-3** | B | `TrackerRenderer` (Runtime reads protocol + DB, renders `tracker.md`); model stops editing |
| **P-PM-4a** | B | Runtime lifecycle engine (PC, call-instance create/seal, DB state updates, tracker regen) |
| **P-PM-4b** | A | Agent Context Assistance upgrade — `StepAssistanceConfig` → universal Claude Code hook → `agent-assistance.json` → tiered `additionalContext` (replaces `tracker-reminder.mjs`) |
| **P-PM-4c** | C | Gateway guard engine — per-step `GuardBinding`, compiles to MCP gateway (authoritative) + optional CLI PreToolUse |
| **P-PM-5a** | — | Universal `ActionableToolError`, remove hardcoded tracker path from `saga3-args.ts:223` |
| **P-PM-5b** | B | `CallInstance` lifecycle (template → draft → sealed receipt), per-instance numbering, sealing |
| **P-PM-6** | — | Migrate Formalization — skills/templates/checklists/tools into `nodes/<n>/resources/`, fill real `NodeProtocolDefinition`, update skill resolver |
| **P-PM-7** | — | Migrate Discovery, Development, Delivery |
| **P-PM-8** | — | Remove legacy: `ensureDiscoveryWorkspace`, global skill lookup, manual tracker template, Discovery-specific `actionableError`, `tracker-reminder.mjs` |

The chain `NodeProtocol → StepAssistance → CallInstance → ActionableToolError → Recovery` closes after **P-PM-5a**.

---

## 7. Outstanding (parallel queue, not blocking migration)

- **Bug 11:** SRS `content_hash` null despite server-side fallback. P-PM-5a (universal ActionableToolError) will aid debugging by removing the hardcoded tracker path and giving structured field-level diagnostics.
