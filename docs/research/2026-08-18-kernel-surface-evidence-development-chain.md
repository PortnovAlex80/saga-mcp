# Evidence Package: the "produce code → fan-out → git candidate → runnability" chain — generic kernel atoms or private Development machinery?

- **Date:** 2026-08-18
- **Base:** branch `saga4`, HEAD `3f7ff5d0` (the working tree contains uncommitted discovery-domain edits — they do not affect the findings; only discovery files are touched)
- **Purpose:** input package for ultra-mode (phase 2). Facts only, with code pointers; no design, no recommendations.
- **Question under test:** is the "produce code → fan-out → git candidate → check runnability" chain a set of generic kernel atoms any workshop can declare — or private Development machinery?
- **Companion documents:** the judgment drawn from this evidence is
  `2026-08-18-ees-admission-judgment.md` (same directory); its normative form is
  ADR-082 (`docs/architecture/decisions/082-kernel-admission-boundary.md`); the
  work order that promoted these files out of `ideas/` is
  `docs/handoff/STAGE-4-AGENT-BRIEF.md` (TASK 2).

---

## 1. Corrections to the original signal (measurement → fact)

> **Supersession note (2026-08-18).** The corrections in this section were
> accepted by the companion judgment and codified in ADR-082: the
> "development is asymmetric" reading of the kernel-node count is retired —
> `delivery` has the same four-kernel-node "prepare → act → observe → settle"
> shape while producing no code, and the adopted metric is **admission
> distance**, not size or kernel-node count. The measurements below are left
> exactly as taken; the record of how the wrong signal was corrected is worth
> more than a tidy document.

| Measurement (original signal) | Fact per the code |
|---|---|
| "development ~4 kernel nodes, discovery/formalization/delivery 1 each (settle)" | **Wrong.** Substantive kernel nodes in the main flows: discovery **1** (`settle`), formalization **2** (`freeze-acceptance-baseline`, `settle-formalization`), development **4** (`resolve-task-graph`, `freeze-integrated-candidate`, `bind-runnable-candidate`, `settle-development`), delivery **4** (`preflight-release`, `publish-deploy`, `observe-release`, `settle-delivery`). The extra `kind: 'kernel'` entries in each flow are terminal `complete-*` nodes on the platform-owned `process-outcome-emitter` handler (generic, registered globally by the runtime). The asymmetry exists, but it is **not development-unique**: delivery produces no code yet has the same number of kernel nodes in the same "prepare → act → observe → settle" shape. |
| "development has 6 kernel handlers" | Registered handler ids: development **9** (`DEVELOPMENT_KERNEL_HANDLER_IDS`, spanning 3 modules: main + continuation + verification-continuation), discovery **6** (`DISCOVERY_PACKAGE_HANDLER_IDS`; only `settle` is wired in the current flow — the rest are from the previous flow shape, all six still registered), formalization **2** (`freezeBaseline`, `settle`), delivery **4** + 1 human interaction (`approval`). |
| "modules-ext/external-seo — 42 files, pure SPI, zero runtime edits" | The 42 files are **all of** `modules-ext/`: external-seo **12**, human-director-approval **13**, lm-marketing **17**. "Zero runtime edits" holds, but the proof is weaker than it looks: see §5 — external-seo targets `ExternalAdapterRegistry`/`ExternalNodeExecutor`, which **exist neither in src nor in dist**; the test itself records (W7-RECHECK 2026-08-02) that only installation is proven, not dispatch. |
| "the kernel barely branches on workshop name — 10 occurrences in 2 files" | Across the kernel outside `src/modules/` and outside the packages, exactly **one** behavioral branch on a stage name was found (`sqlite-production-cell-projection-persistence.ts:509,548` — `linkType: 'implements' \| 'depends_on'` by `workflowStage === 'development'`). The remaining occurrences are a warning set, owner metadata, the legacy `epics.stage` enum, a named constant, comments. Classification in §6. |

---

## 2. Grammar inventory: what a module can declare today

### 2.1 Flow nodes (`src/process-modules/domain/process-module.ts:134`)

```
FlowNodeKind = 'lm' | 'kernel' | 'human' | 'composite' | 'production-cell'
```

- `'external'` was **deliberately removed** (same file, lines 116–133): it was "a backdoor that let a module self-hire workers / call external systems through an opaque adapter." Closed 2026-07-31. A module needing an external call must declare the provider as a **port** and call it from a **kernel** node handler.
- Dispatch is a `Map<kind, NodeExecutor>` in the composition root (`src/app/product-lifecycle-runtime.ts:425`): `kernel`, `human`, `production-cell`; `'lm'` is an alias for the production-cell executor (`product-lifecycle-runtime.ts:737`). There is no `'external'` executor.

### 2.2 Production Cell — the universal declarative cell (`domain/workplace/production-cell-definition.ts`)

The full grammar available to any package:

| Field | What it defines | Relevant to the chain |
|---|---|---|
| `materialization` | `workKeySelector`, `dependencySelector`, `completionPolicy: all\|any\|quorum`, `taskProvenance` | **fan-out** |
| `author` / `review.reviewer` | `skillRef` + `capabilityPreset` (both open strings; the preset is resolved by the worker-launcher port) | hiring |
| `productContracts[]` | schema + `payloadContract{contractId,version,contractDigest}` | product contracts |
| `authorGate` / `review.finalGate` | `checkPlan` (providers by id) | acceptance |
| `recovery` | `maxAttempts`, `onExhausted: fail\|pause\|requeue`, `totalAttempts`, recovery epochs with exponential backoff (ADR-075) | autonomous bounded retries |
| `postAcceptanceEffect` | opaque string — "runtime never switches on concrete effect names such as Git or SRS" (`production-cell-definition.ts:110-114`) | **the git effect** |
| `transitions` | accepted / humanRequired / failed | routing |

A "desync firewall" runs at module load: a check-plan entry with `subjectScope: 'cell-product'` must name a schema the cell actually produces, or the module fails to load (`assertCheckPlanSubjectConformance`).

### 2.3 Registries (generic; the kernel knows no workshop names)

- **KernelHandlerRegistry** (`application/kernel-handler-registry.ts`): `register(handlerId, fn)` / `require` — a module plugs its handlers under string ids from `KernelFlowNodeDefinition.handler`. File comment (translated from Russian): the registry holds zero knowledge of the word "discovery".
- **Packages are content-addressed**: `ProcessModulePackage` = `definitionDigest` + `packageDigest` (over `resourceHashes` + `handlerVersions`). Editing any resource/handler without a version bump changes the digest and breaks replay (`domain/process-module.ts:294-335`). HandlerRefs in the manifests carry **real sha256** of the installation modules (K3 done; see `modules/development/package/manifest.ts:230-263`, `modules/discovery/package/manifest.ts:325-373`). The formula: "Handlers are NOT shipped in the manifest — only stable references".
- **Universal cells hire workers** through the shared `worker_next` queue; effective tools = `profile.allowedTools ∩ runtime grants` — a pure function (`application/capability-enforcement.ts`), an intersection, never a union.

### 2.4 Lifecycle is data, not code (`src/process-modules/lifecycles/product-delivery-lifecycle.ts`)

`LifecycleDefinition` = stages `{stageId, moduleRef, inputMapping (JSON-path), outputMapping, outcomeRoutes}`. The discovery→formalization→development→delivery chain is declarative data with field mappings. A second definition exists (`product-build-lifecycle.ts`). **However**: the start gateway hard-checks `lifecycleInputSchema === PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA` (`product-lifecycle-runtime.ts:919-924`) — an arbitrary lifecycle is not accepted by the start path.

---

## 3. The development chain decomposed into atoms

| Chain step | Mechanism | Where it lives | Status |
|---|---|---|---|
| Plan the work graph | `plan-task-graph` — singleton production cell (profile `development-task-graph-planner`; the gate validates lineage/coverage/DAG) | development package | generic grammar |
| **Freeze the graph + fan-out** | `resolve-task-graph` — kernel handler: canonicalizes the accepted proposal, validates against a policy, materializes the projected work ("makes work CLAIMABLE by workers through the shared worker_next queue; the module never hires them", `development-installation.ts:349-354`) | handler — `src/modules/development`; materialization — the declarative `DevelopmentTaskGraphPort` | handler private, port declarative |
| **Implementation fan-out** | `implement-work-items` — production cell with `materialization{workKeySelector:'items', dependencySelector:'dependsOnKeys', completionPolicy:'all'}`; author `sandbox-code-author`, reviewer `sandbox-code-reviewer`, `postAcceptanceEffect:'git-integration'` | development package; executed by the generic `ProductionCellNodeExecutor` (2,400 lines, no workshop branching) | **pure generic grammar** |
| **Git candidate (effect)** | `git-integration` — factory-level PostAcceptanceEffect: CAS ledger (`ExternalEffectLedger`), claim/observation protocol, outcomes succeeded/pending/repair_required/human_required; "material coordinates come ONLY from the authority" (ADR-053 B-4) | `src/infrastructure/workplace/git-integration-effect.ts` + `SqliteProductionCellIntegration` | **factory-generic**; any package can put `postAcceptanceEffect:'git-integration'` on its cell |
| **Git candidate (freeze)** | `freeze-integrated-candidate` — kernel handler: idempotent read from write-once process products → accepted cell products → the **shared** `factory_cell_effect_receipts` table (checks exactly one git-integration receipt with integratedCommit) → read-only GitPort (`rev-parse`, `merge-base --is-ancestor`, tree hash) → persists the content-addressed candidate | `src/modules/development/infrastructure/sqlite-development-settlement-state.ts:197-322` | handler private; **uses only generic stores and read-only ports**; no development-only kernel API involved |
| **Runnability (certification)** | `certify-product-readiness` — singleton production cell (profile `development-readiness-certifier`): "Declare and execute one candidate-wide run contract against the exact integrated source" | development package | generic grammar |
| **Runnability (provider)** | `LocalRunnabilityCheckProvider` — factory-level check provider, trusted via the `trusted_providers` table (`ensureLocalRunnabilityProviderTrust`) | `src/infrastructure/verification/local-runnability-check-provider.ts` | **factory-generic** |
| Runnable binding | `bind-runnable-candidate` — kernel handler: binds the accepted readiness manifest + deterministic receipt to the frozen source | `development-installation.ts:149-180` | handler private, a thin wrapper over a port |
| Acceptance verification | `verify-acceptance` — production cell with fan-out over `verificationItems` | development package | generic grammar |
| Settlement | `settle-development` — kernel handler: pure policy over `DevelopmentSettlementInput`, issues its own certificate (`certificateRepository.issue`), emits an explicit `ModuleCompletion` | `development-installation.ts:417-622` | handler private |

**Key fact:** of the entire chain, only three handlers (resolve/freeze/bind) are development-private code, and all three are built exclusively on declarative ports (`development-kernel-ports.ts`: "There are no executive ports: the module does not hire workers, does not merge and does not run tests"). Fan-out, the git effect, the runnability provider, gates, recovery — all generic surfaces.

---

## 4. Closed surfaces (adding one requires editing the kernel repo)

1. **Workshop capability manifest** — hardcoded lists `WORKSHOP_PAYLOAD_CONTRACTS` and `WORKSHOP_EXECUTABLE_CAPABILITIES` in `src/process-modules/application/workshop-capability-manifest.ts`. `registerWorkshopCheckProvider` / `registerWorkshopPostAcceptanceEffect` throw `WORKSHOP_CAPABILITY_UNDECLARED` if the provider/effect is not in the list (lines 297-327). **Adding a new** check provider or effect = a kernel edit. **Using the existing ones** (git-integration, replay-capture, formalization-accept-products; local-runnability, review-verdict, product-contract…) = declarative. This is an architecture ratchet (`tests/architecture/workshop-manifest-parity.test.mjs`).
2. **Composition root** — `src/app/product-lifecycle-runtime.ts:787-796` manually calls `registerDiscovery/registerFormalization/registerDevelopment/registerDelivery`. Kernel handlers are registered by TS installation code (`src/modules/<name>/index.ts`). **A declarative package cannot ship its own kernel handler**: the manifest pins only digest references; there is no registration path from a package. modules-ext proves declarative installation for lm/human nodes, but no external package ships a kernel handler or a fan-out production cell.
3. **Lifecycle start gateway** — accepts only `PRODUCT_DELIVERY_LIFECYCLE_INPUT_SCHEMA` (`product-lifecycle-runtime.ts:919-924`). A new stage chain = a kernel edit.
4. **The `'external'` executor is gone** — the external-node adapter path does not exist (see §5).
5. **The legacy `epics.stage` enum** in `schema.ts:106-107` — a stage vocabulary baked into the schema (legacy; the target vocabulary is K15 Unified Vocabulary).

---

## 5. External modules: what is actually proven

`modules-ext/` (42 files, created 2026-07-29, Wave 10):

| Package | Files | What it declares | What is proven | What is NOT proven |
|---|---|---|---|---|
| external-seo | 12 | 1 node `kind:'external'` + adapter ref + node protocol | installation via `installModulePackages` (the same path as the four built-ins), manifest validation, resource content-addressing | **dispatch**: `ExternalAdapterRegistry` and `ExternalNodeExecutor` exist neither in src nor in dist; the test (`tests/process-modules/external-seo-package.test.mjs`, W7-RECHECK 2026-08-02) states it directly: "two modules of the W10 External-node dispatch SPI that have NOT been implemented in src/" |
| lm-marketing | 17 | lm node + executionProfile `marketing-author` + skill/templates/schemas | declarative installation; `'lm'` dispatches (alias to the cell executor) | production-cell, fan-out, effects — not exercised |
| human-director-approval | 13 | human node + interaction contract | installation | same |

"The import list IS the proof" (external-seo README): the packages import only the SPI from `dist/`, never the composition root. The `dependency-direction` ratchet scans `src/`; `modules-ext/` lies outside it — that is why "zero runtime edits" is possible at all.

---

## 6. Workshop-name branching in the kernel — classification

| File:line | What it is | Verdict |
|---|---|---|
| `application/validate-process-module.ts:20-25,200-204` | `STANDARD_MODULE_KINDS` {discovery,formalization,development,delivery}; a non-standard kind is a **warning, not an error** ("custom modules remain expressible") — a typo guard | legitimate (soft set) |
| `application/workshop-capability-manifest.ts:239-244` | `PAYLOAD_CONTRACT_OWNERS` — owner metadata for audit; no dispatch | legitimate (metadata) |
| `application/workshop-capability-manifest.ts` (whole file) | the per-workshop lists of contracts/providers themselves | closed surface, see §4.1 |
| `infrastructure/workplace/sqlite-production-cell-projection-persistence.ts:509,548` | `linkType = workflowStage === 'development' ? 'implements' : 'depends_on'`; gate `['development','verification'].includes(workflowStage)` | **the only behavioral branch found** on a stage name |
| `schema.ts:106-107` | legacy `epics.stage CHECK (...)` enum | legacy vocabulary (K15 territory) |
| `planner/fast-track.ts:198,206` | skill-name mapping + stamping `stage='development'` | legacy planner path |
| `shared/work-intent.ts:88` | the constant `DISCOVERY_INTENT_KIND = 'discovery'` | a named constant |
| `application/generic-flow-executor.ts:7` | a mention in a comment | not code |

`KernelHandlerRegistry`, `GenericFlowExecutor`, `ProductionCellNodeExecutor`, `git-integration-effect` — none branch on workshop name.

---

## 7. Asymmetry metrics (summary table)

| | discovery | formalization | development | delivery |
|---|---|---|---|---|
| Kernel nodes in the main flow | 1 | 2 | **4** | **4** |
| Registered handler ids | 6 | 2 | **9** (3 modules: main + 2 continuations) | 4 + 1 human |
| Production-cell nodes | 2 (singleton) | 5 | 4 (of which **2 with materialization fan-out**) | 0 |
| Consumed post-acceptance effects | — | formalization-accept-products | **git-integration** | publish_deploy (external-effects contribution) |
| Check providers in the workshop manifest | 2 | N (FORMALIZATION_CHECK_REFS) | 6 (task-graph, impl-scope, verification + local-runnability, accessible-counter, authorized-observer in the development directory, but factory trust) | — (external-effects) |
| Installation TS (`src/modules/<x>`) | **10,361** | 4,442 | 8,475 | 4,726 |
| Declarative package (`src/process-modules/modules/<x>`, TS) | 2,324 | 3,405 | 2,548 | 3,352 |
| Sum (the original measurement's method) | **12,685** | 7,847 | 11,023 | 8,078 |

Fan-out via `materialization{workKeySelector}` is used today **only** by development (items, verificationItems); discovery/formalization/delivery use singleton cells.

---

## 8. Reframed questions for ultra-mode (no answers)

1. Are the three development handlers (resolve/freeze/bind) a **repeatable pattern** ("canonicalize-and-materialize / observe-and-freeze / bind-receipt") or domain logic? If a pattern — must a second code-producing workshop (a) copy the pattern into its own `src/modules/<x>` (today's path of least resistance), (b) get generic kernel atoms, or (c) neither, because delivery already walked the same shape without generic atoms?
2. Is the closed workshop-capability-manifest (§4.1) a deliberate desync firewall (single source of truth, cross-process parity, ratchet) or a brake on the EES scenario "a new domain brings its own check providers"? Both readings are supported by the code.
3. A package cannot ship a kernel handler (§4.2). For EES is that: a blocker; the correct boundary (handlers are trusted installation code, not declarative material); or future work (K14: "compile module definitions into Production Cells")?
4. The vision docs (`FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT.md` §1.2, §3) claim "all workshops are declarative packages; the kernel knows no workshop name". The facts: the grammar — yes; handler binding and the capability manifest — no. Which do we sell as the "Engineering Execution System": the cell grammar (already generic) or the full declarative package (today only lm/human nodes)?
5. The `product-delivery` lifecycle is pinned into the start gateway. "A new workshop = kernel heir + different skills" requires at minimum: a new register function in the composition root + capability-manifest entries + (if the workshop joins the main chain) a lifecycle edit. Is that "LEGO" or "LEGO with a screwdriver"? (SAGA-CORE-RENEWAL-PLAN §12 explicitly postpones new domain factories until Core 3.0 GA — does its schedule conflict with the EES sales need, or not?)

---

## Appendix: key file map

- Cell grammar: `src/process-modules/domain/workplace/production-cell-definition.ts`
- Node/module/package types: `src/process-modules/domain/process-module.ts`
- Kernel-handler registry: `src/process-modules/application/kernel-handler-registry.ts`
- The closed capability manifest: `src/process-modules/application/workshop-capability-manifest.ts`
- Composition root: `src/app/product-lifecycle-runtime.ts` (nodeExecutors 425-436, lm alias 737, module registration 787-796, lifecycle gate 919-924)
- Development installation: `src/modules/development/index.ts`; handlers: `application/development-installation.ts`; ports: `domain/development-kernel-ports.ts`; freeze implementation: `infrastructure/sqlite-development-settlement-state.ts:197-322`
- Development flow: `src/process-modules/modules/development/development-process-module.ts:150-400`
- Git effect: `src/infrastructure/workplace/git-integration-effect.ts`
- Runnability: `src/infrastructure/verification/local-runnability-check-provider.ts`
- Lifecycle data: `src/process-modules/lifecycles/product-delivery-lifecycle.ts`
- External packages: `modules-ext/{external-seo,lm-marketing,human-director-approval}/`
- Vision docs: `docs/vision/{FROM-SOFTWARE-FACTORY-TO-ENGINEERING-PLANT,GO-TO-MARKET-RU-THEN-EU,SAGA-CORE-RENEWAL-PLAN,CONTROLLED-CHANGE-PLANE-PLAN}.md`
